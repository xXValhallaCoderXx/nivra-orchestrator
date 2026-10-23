// R3's live run of research through the Windows app and its WSL engine (D37, NIV-45), and the steps around it. Never
// part of `pnpm verify`. Run from WSL, in apps/desktop, with no Nivra open on Windows:
//
//   node scripts/research-live.ts --freeze              builds the Windows app from this clean tree, copies it to
//                                                       a folder of its own, records its hashes, makes the demo repo
//   node scripts/research-live.ts --plan                prints the recipe and its digest, for approval; no network
//   node scripts/research-live.ts --rehearse            the journey on the frozen build with fake keys, to the preview
//   node scripts/research-live.ts --live --approved D   the approved run, detached so it outlives this terminal: one
//                                                       Start, then the window is the person's; its log is printed
//   node scripts/research-live.ts --cleanup             opens the last live profile, removes its keys, scans it
//
// The journey is research-journey.ts's, which the offline e2e runs whole, everything after Start included. Nothing is
// sent before Start, and Start is pressed only in --live, once, after the approval is claimed and the preview's
// fingerprint is the approved one. A failure before Start removes the keys and sends nothing. After Start nothing can
// throw out of the run (runApproved): the app is closed only once the person creates go-close (or stop) in the
// evidence folder. The keys are pasted into Settings by the person; this script never reads or prints them, and never
// screenshots Settings.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RESEARCH_LIMITS } from "@nivra/domain";
import { _electron as electron, type Locator } from "@playwright/test";
import { build } from "esbuild";
import { claimApproval, claimOn, isDigest } from "../../engine/scripts/research-check/claim.ts";
import { Ui, waitFor } from "./live-ui.ts";
import { DEMO_PROJECT, DEMO_SEED, demoFingerprint, demoPacket } from "./research-demo.ts";
import { hostPreview, openDemo, pickDemo, previewAllowing, previewShown, removeKeys, researchOf, runApproved } from "./research-journey.ts";
import { RELEASE_HOME_STATE, releaseHomeChange } from "./test-homes.ts";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(desktop, "..", "..");
const STATE = join(homedir(), "nivra-acceptance", "research-r3");
const CLAIMS = join(homedir(), "nivra-acceptance", "claims", "research-r3");
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const CREDITS = DEMO_SEED.assumptions.length * 2;
/** Said wherever the credential scan's result is: what it can and can't see. */
const SCAN_NOTE =
  "The scan looks for credential shapes with the domain's patterns: a Tavily key's among them. A Token Factory key has no shape of its own, so the scan can't see one; the engine's offline tests check that no key value reaches its stores.";

// ---- processes ----------------------------------------------------------------------------------------------------

function run(exe: string, args: string[], cwd = "/mnt/c"): string {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
}
const cmd = (line: string) => run("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", line]);
const wslpath = (flag: "-u" | "-w", path: string) => run("/usr/bin/wslpath", [flag, path]);
const sh = (script: string, ...args: string[]) => run("/bin/sh", ["-c", script, "sh", ...args], homedir());
const git = (...args: string[]) => run("git", args, repository);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function cleanRevision(): string {
  const dirty = git("status", "--porcelain");
  if (dirty) throw new Error("The working tree has changes: R3 runs only from a clean, committed revision. Commit or set them aside, then run this again.");
  return git("rev-parse", "HEAD");
}

/** What a run could change in a release or shared development home: database files and runtime folders. */
function homeStates(): Record<string, string> {
  return { "~/.nivra": sh(RELEASE_HOME_STATE), "~/.nivra-dev": sh(RELEASE_HOME_STATE.replace('"$HOME/.nivra"', '"$HOME/.nivra-dev"')) };
}
/** Each home, unchanged or what changed in it, in words. */
function homesAfter(before: Record<string, string>): { unchanged: boolean; lines: string[] } {
  const after = homeStates();
  const lines = Object.keys(before).map((home) => releaseHomeChange(before[home]!, after[home]!)?.replace("~/.nivra changed", `${home} changed`) ?? `${home} unchanged`);
  return { unchanged: lines.every((line) => line.endsWith(" unchanged")), lines };
}

// ---- the frozen build -----------------------------------------------------------------------------------------------

export interface Frozen {
  stamp: string;
  revision: string;
  /** The frozen folder as Windows names it, under %LOCALAPPDATA%\nivra-dev. */
  folderWin: string;
  /** Nivra.exe, which carries the Electron fuses. */
  exeSha256: string;
  appAsarSha256: string;
  /** The WSL engine's runtime as shipped, and the content hash its folder is named by. */
  runtimeTarballSha256: string;
  runtimeContentHash: string;
  distro: string;
  repo: { path: string; commit: string };
}

const frozenPath = join(STATE, "freeze.json");
function readFrozen(): Frozen {
  if (!existsSync(frozenPath)) throw new Error("Nothing is frozen yet: run this script with --freeze.");
  return JSON.parse(readFileSync(frozenPath, "utf8")) as Frozen;
}
const folderOf = (frozen: Frozen) => wslpath("-u", frozen.folderWin);

type BuildHashes = Pick<Frozen, "exeSha256" | "appAsarSha256" | "runtimeTarballSha256" | "runtimeContentHash">;
/** The build's identity: Nivra.exe, app.asar and the WSL runtime's tarball, each hashed again, and its content hash. */
function buildHashes(folder: string): BuildHashes {
  const resources = join(folder, "app", "resources");
  const runtime = JSON.parse(readFileSync(join(resources, "runtime", "runtime-linux-x64.json"), "utf8")) as { contentHash: string };
  return {
    exeSha256: sha256(join(folder, "app", "Nivra.exe")),
    appAsarSha256: sha256(join(resources, "app.asar")),
    runtimeTarballSha256: sha256(join(resources, "runtime", "runtime-linux-x64.tar.gz")),
    runtimeContentHash: runtime.contentHash,
  };
}
function checkBuild(frozen: Frozen): void {
  const now = buildHashes(folderOf(frozen));
  const same = (Object.keys(now) as Array<keyof BuildHashes>).every((key) => now[key] === frozen[key]);
  if (!same) throw new Error("The frozen build changed since it was frozen. Freeze it again, and ask for a new approval.");
}

async function freeze(distro: string | undefined): Promise<void> {
  const revision = cleanRevision();
  const at = stamp();
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  // The build is made here, from this clean tree, so the recipe's revision is the build's.
  console.log("Building the Windows app from this tree (pnpm dev:win --no-launch)…");
  const built = spawnSync("pnpm", ["dev:win", "--no-launch"], { cwd: repository, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(STATE, `dev-win-${at}.log`), `${built.stdout}\n${built.stderr}`, { mode: 0o600 });
  if (built.status !== 0) throw new Error(`pnpm dev:win --no-launch failed; its output is in ${join(STATE, `dev-win-${at}.log`)}.`);
  if (cleanRevision() !== revision) throw new Error("The tree changed while the app was being built. Freeze again.");
  const devWin = `${cmd("echo %LOCALAPPDATA%")}\\nivra-dev`;
  const builtWin = `${devWin}\\app`;
  const folderWin = `${devWin}\\r3-${at}`;
  // Robocopy, given each path as its own argument (through cmd.exe, interop would mangle the quotes); its exit codes
  // below 8 all mean success.
  const copied = spawnSync("/mnt/c/Windows/System32/Robocopy.exe", [builtWin, `${folderWin}\\app`, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { cwd: "/mnt/c", encoding: "utf8" });
  if (copied.status === null || copied.status >= 8) throw new Error(`Copying the build failed: ${copied.stdout || copied.stderr}`);
  const folder = wslpath("-u", folderWin);
  const hashes = buildHashes(folder);
  if (JSON.stringify(hashes) !== JSON.stringify(buildHashes(wslpath("-u", devWin)))) throw new Error("The copy differs from the build it was copied from.");
  copyFileSync(join(desktop, "build", "stage", "win-x64", "node", "node.exe"), join(folder, "node.exe"));
  for (const [from, out] of [
    [join(desktop, "e2e", "seed-workspace-cli.ts"), "seed.mjs"],
    [join(desktop, "scripts", "shape-scan-cli.ts"), "shape-scan.mjs"],
  ] as const) {
    await build({ entryPoints: [from], outfile: join(folder, out), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning" });
  }
  // The demonstration repository in WSL: setup.py importing distutils.core, one commit with fixed dates, whatever the
  // global git configuration says.
  const repo = join(homedir(), "nivra-r3", DEMO_PROJECT);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "setup.py"), `from distutils.core import setup\n\nsetup(name="${DEMO_PROJECT}", version="1.0")\n`);
  writeFileSync(join(repo, "README.md"), `# ${DEMO_PROJECT}\n\nThe build image for R3's research demonstration.\n`);
  const fixed = { ...process.env, GIT_AUTHOR_DATE: "2026-10-23T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-23T00:00:00Z" };
  const identity = ["-c", "user.name=Nivra R3", "-c", "user.email=r3@nivra.invalid", "-c", "commit.gpgsign=false"];
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], [...identity, "commit", "-q", "-m", "The build image"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: fixed });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  const frozen: Frozen = { stamp: at, revision, folderWin, ...hashes, distro: distro ?? process.env["WSL_DISTRO_NAME"] ?? "Ubuntu", repo: { path: repo, commit: run("git", ["rev-parse", "HEAD"], repo) } };
  writeFileSync(frozenPath, `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `Frozen at ${revision.slice(0, 7)} in ${folderWin}: Nivra.exe ${hashes.exeSha256.slice(0, 12)}, app.asar ${hashes.appAsarSha256.slice(0, 12)}, runtime ${hashes.runtimeTarballSha256.slice(0, 12)} (${hashes.runtimeContentHash}). Repository ${frozen.repo.commit.slice(0, 7)} at ${repo}.`,
  );
}

// ---- the recipe ---------------------------------------------------------------------------------------------------

/** What one approval covers, as data: its digest binds every field. `run` numbers the approvals of one recipe. */
export async function recipeOf(frozen: Frozen, run = 1) {
  const { packetDigest, fingerprint } = await demoFingerprint();
  const packet = demoPacket();
  return {
    kind: "nivra.research-r3.v2",
    run,
    revision: frozen.revision,
    build: { exeSha256: frozen.exeSha256, appAsarSha256: frozen.appAsarSha256, runtimeTarballSha256: frozen.runtimeTarballSha256, runtimeContentHash: frozen.runtimeContentHash },
    route: { app: "the frozen Windows development build, with a profile of its own", engine: `wsl:${frozen.distro}, in a home of its own` },
    project: { label: DEMO_PROJECT, path: frozen.repo.path, commit: frozen.repo.commit },
    plan: { id: DEMO_SEED.ids.planId, version: 1, text: packet.planText },
    assumptions: packet.assumptions.map((assumption) => ({ id: assumption.id, text: assumption.text, query: assumption.query })),
    sites: packet.sites,
    packetDigest,
    fingerprint,
    model: { expected: MODEL, rule: "The app uses the model its listing picks; a different one is recorded, never refused." },
    limits: RESEARCH_LIMITS,
    credits: CREDITS,
    steps: [
      "Nate pastes the Token Factory and Tavily keys into Settings; the script waits until both are saved, encrypted",
      `the script turns on research's permission, and allows ${DEMO_PROJECT}'s sharing with Token Factory, each through its own dialog`,
      "it previews, and claims the approval only when the preview's fingerprint is the one above; then it presses Start research once",
      "Nate reads the report, checks a source, amends the plan and saves v2 himself; the script only watches",
      "on Nate's go-ahead, the app is closed and relaunched, both versions and the report are checked, and the keys are removed",
    ],
    requests: [
      "Token Factory: one model listing (GET /v1/models), in the run's prepare step",
      "Token Factory: one chat completion, with the plan, the assumptions, and the passages read, each with its page's title, host and address and the assumption it was found for",
      `Tavily: at most ${packet.assumptions.length} searches (POST /search), one for each query, with the sites`,
      `Tavily: at most ${packet.assumptions.length} extracts (POST /extract), over at most ${RESEARCH_LIMITS.pageExtractions} pages its searches returned`,
    ],
    never: ["Check Token Factory", "a chat message", "a Nebius project id in the profile", "a second Start", "a retry or a retake"],
    failure: "Whatever the run gives is recorded as it is. No retake under this approval; another run needs another approval.",
  };
}
export const digestOf = (recipe: object) => createHash("sha256").update(JSON.stringify(recipe)).digest("hex");

/** The recipe in words, as it is posted for approval. */
export function recipeText(recipe: Awaited<ReturnType<typeof recipeOf>>, digest: string): string {
  return [
    `R3 of NIV-45: research of the demonstration plan through the Windows app and its WSL engine (run ${recipe.run} of this recipe).`,
    "",
    `Revision: ${recipe.revision} (clean tree; the build was made from it)`,
    `Build: Nivra.exe ${recipe.build.exeSha256}, app.asar ${recipe.build.appAsarSha256}, WSL runtime ${recipe.build.runtimeTarballSha256} (${recipe.build.runtimeContentHash})`,
    `Route: ${recipe.route.app}, then ${recipe.route.engine}, on the project ${recipe.project.label} (${recipe.project.path}, commit ${recipe.project.commit.slice(0, 12)})`,
    `Plan ${recipe.plan.id}, v${recipe.plan.version}, seeded (no model call made it):`,
    ...recipe.plan.text.split("\n").map((line) => `  ${line}`),
    "Assumptions, each query its own words (A1 and A2 here are R1's A1 and A3; A2 now names Python 3.12):",
    ...recipe.assumptions.map((assumption) => `  ${assumption.id}: ${assumption.query}`),
    `Sites: ${recipe.sites?.mode} ${recipe.sites?.hosts.join(", ")}`,
    `Packet digest ${recipe.packetDigest}; preview fingerprint ${recipe.fingerprint}`,
    `Model: ${recipe.model.expected} expected. ${recipe.model.rule}`,
    "Steps:",
    ...recipe.steps.map((step) => `  - ${step}`),
    "Every request the run can make:",
    ...recipe.requests.map((request) => `  - ${request}`),
    `At most ${recipe.credits} Tavily credits. Limits: ${recipe.limits.runMs / 1000} s in all, retrieval stops at ${recipe.limits.retrievalCutoffMs / 1000} s, the model gets at most ${recipe.limits.modelMs / 1000} s; nothing is retried.`,
    `Never: ${recipe.never.join("; ")}.`,
    recipe.failure,
    "",
    `Digest: ${digest}`,
  ].join("\n");
}

/** The first run of the frozen recipe whose approval isn't claimed yet, with its recipe and digest. */
async function nextRecipe(frozen: Frozen) {
  for (let run = 1; ; run++) {
    const recipe = await recipeOf(frozen, run);
    const digest = digestOf(recipe);
    if (!claimOn(CLAIMS, digest).claimed) return { recipe, digest };
  }
}

function checkedFrozen(): Frozen {
  const frozen = readFrozen();
  const revision = cleanRevision();
  if (revision !== frozen.revision) throw new Error(`HEAD is ${revision.slice(0, 7)}, but the build was frozen at ${frozen.revision.slice(0, 7)}. Freeze again.`);
  checkBuild(frozen);
  return frozen;
}

async function plan(): Promise<void> {
  const { recipe, digest } = await nextRecipe(checkedFrozen());
  const text = recipeText(recipe, digest);
  writeFileSync(join(STATE, `recipe-${digest.slice(0, 12)}.txt`), `${text}\n`, { mode: 0o600 });
  console.log(text);
}

// ---- the app ------------------------------------------------------------------------------------------------------

interface Session {
  ui: Ui;
  profileWin: string;
  wslHome: string;
}

async function launch(frozen: Frozen, profileWin: string, wslHome: string): Promise<Ui> {
  checkBuild(frozen);
  const exe = wslpath("-u", `${frozen.folderWin}\\app\\Nivra.exe`);
  // chromiumSandbox: otherwise Playwright adds --no-sandbox, and the app (app.enableSandbox) refuses to start.
  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${profileWin}\\user data`, `--nivra-engine-home=${profileWin}\\engine`, `--nivra-wsl-home=${wslHome}`],
    chromiumSandbox: true,
    timeout: 120_000,
  });
  return new Ui(app, await app.firstWindow());
}

/** No engine of this profile is left in the distribution. */
async function stopped(session: Pick<Session, "wslHome">): Promise<void> {
  await waitFor(() => !spawnSync("pgrep", ["-f", session.wslHome]).stdout.toString().trim(), 60_000, "the WSL engine to stop");
}

/** What is wrong with the route now: the native Windows engine running, which R3 claims nothing for. */
async function routeProblem(ui: Ui): Promise<string | null> {
  const local = (await ui.engines()).find((engine) => engine.targetId === "local");
  return local?.state.status === "online" ? "The native Windows engine is running: R3 claims nothing for it." : null;
}

/**
 * A fresh profile and WSL home: the project added through the window as the person would, the app closed, the plan
 * seeded on Windows (D7), and the app open again on the demonstration. Returns the route as shown.
 */
async function prepared(frozen: Frozen, kind: "rehearse" | "live", log: (line: string) => void): Promise<Session & { route: string[] }> {
  const at = stamp();
  const profileWin = `${frozen.folderWin}\\${kind}-${at}`;
  const wslHome = `.nivra-dev-track-a/r3-${frozen.stamp}-${kind}-${at}`;
  const target = `wsl:${frozen.distro}`;
  let ui = await launch(frozen, profileWin, wslHome);
  const project = await ui.pick(`\\\\wsl.localhost\\${frozen.distro}${frozen.repo.path.replace(/\//g, "\\")}`, target);
  log(`Added ${project.label} on ${project.targetId}.`);
  await ui.app.close();
  await stopped({ wslHome });
  const folder = folderOf(frozen);
  writeFileSync(join(folder, `seed-${kind}-${at}.json`), JSON.stringify(DEMO_SEED));
  const seeded = JSON.parse(run(join(folder, "node.exe"), [`${frozen.folderWin}\\seed.mjs`, "--project", `${profileWin}\\user data`, `${frozen.folderWin}\\seed-${kind}-${at}.json`])) as { targetId: string };
  if (seeded.targetId !== target) throw new Error(`The plan was seeded on ${seeded.targetId}, not ${target}.`);
  ui = await launch(frozen, profileWin, wslHome);
  const info = await ui.online(target);
  const conversation = (await ui.call<{ conversations: Array<{ id: string; targetId: string }> }>("window.nivra.listConversations()")).conversations.find((c) => c.id === DEMO_SEED.ids.conversationId);
  if (conversation?.targetId !== target) throw new Error(`The demonstration's conversation runs on ${conversation?.targetId ?? "nothing"}, not ${target}.`);
  if (!info.home.endsWith(`/${wslHome}`) || info.platform !== "linux") throw new Error(`The WSL engine reports ${info.home} on ${info.platform}.`);
  const problem = await routeProblem(ui);
  if (problem) throw new Error(problem);
  const route = [`the conversation runs on ${target}`, `its engine reports home ${info.home} on ${info.platform}, engine ${info.engineVersion}`, "the native Windows engine isn't running"];
  for (const line of route) log(`Route: ${line}.`);
  return { ui, profileWin, wslHome, route };
}

function evidenceFolder(kind: string, revision: string): string {
  const folder = join(homedir(), "nivra-acceptance", `research-r3-${kind}-${stamp()}-${revision.slice(0, 7)}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}
function writer(folder: string) {
  const lines: string[] = [];
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    lines.push(stamped);
    console.log(stamped);
    writeFileSync(join(folder, "log.txt"), `${lines.join("\n")}\n`, { mode: 0o600 });
  };
  const save = (name: string, value: unknown) => writeFileSync(join(folder, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  /** A screenshot of part of the window, kept as private as the rest of the evidence. */
  const shot = async (locator: Locator, name: string) => {
    await locator.screenshot({ path: join(folder, name) });
    chmodSync(join(folder, name), 0o600);
  };
  return { log, save, shot };
}

/** The files a scan must have read: a clean result from a scan that read none of them would prove nothing. */
const REQUIRED = ["nivra.db", "mastra.db", "workspace.db", "nivra.json"];

/**
 * Credential shapes in every file of the evidence, the WSL engine's home (its shipped runtime aside) and the profile:
 * which shapes, never the text. The engine's home is read once no engine of this profile runs, and the profile on
 * Windows (D7). Says how many files were read, which were absent and which are images, and refuses a scan that missed a
 * required file.
 */
function scans(frozen: Frozen, session: Pick<Session, "profileWin" | "wslHome">, evidence: string) {
  type Found = { file: string; image: boolean; shapes: string[] | null };
  const folder = folderOf(frozen);
  const local = JSON.parse(run(process.execPath, [join(folder, "shape-scan.mjs"), "--skip", "runtime", "--tree", join(homedir(), session.wslHome), "--tree", evidence], homedir())) as Found[];
  const windows = JSON.parse(run(join(folder, "node.exe"), [`${frozen.folderWin}\\shape-scan.mjs`, "--tree", `${session.profileWin}\\user data`])) as Found[];
  const results = [...local, ...windows];
  const images = results.filter((result) => result.image).map((result) => result.file);
  const read = results.filter((result) => !result.image && result.shapes !== null);
  const unread = REQUIRED.filter((name) => !read.some((result) => result.file.endsWith(`/${name}`) || result.file.endsWith(`\\${name}`)));
  if (unread.length) throw new Error(`The credential scan didn't read ${unread.join(", ")}, so it proves nothing: check the profile and the WSL home.`);
  const found = read.filter((result) => result.shapes!.length > 0);
  return { found, summary: `${read.length} files read, ${images.length} images not readable as text, ${found.length} with a credential shape`, note: SCAN_NOTE };
}

// ---- rehearse -------------------------------------------------------------------------------------------------------

async function rehearse(): Promise<void> {
  const frozen = checkedFrozen();
  const { recipe, digest } = await nextRecipe(frozen);
  const evidence = evidenceFolder("rehearsal", frozen.revision);
  const { log, save, shot } = writer(evidence);
  const homes = homeStates();
  log(`Rehearsing recipe ${digest.slice(0, 12)} on the frozen build, with fake keys: nothing is started.`);
  const session = await prepared(frozen, "rehearse", log);
  let { ui } = session;
  try {
    // Fake keys, so the preview reaches the project's sharing as it will live; neither is used, since nothing starts.
    await ui.call(`window.nivra.setNebiusKey("nivra-acceptance-invalid-r3-rehearsal")`);
    await ui.call(`window.nivra.setTavilyKey("nivra-acceptance-invalid-r3-rehearsal")`);
    await openDemo(ui.page);
    await pickDemo(ui.page);
    await previewAllowing(ui.page, log);
    const shown = await previewShown(ui.page);
    const preview = await hostPreview(ui.page);
    if (preview.blocked !== null || preview.expected !== recipe.fingerprint) throw new Error(`The preview's fingerprint is ${preview.expected} (blocked: ${preview.blocked}), not the recipe's ${recipe.fingerprint}.`);
    log(`The preview shows ${shown.queries.join(" | ")}; ${shown.sites}. Its fingerprint is the recipe's.`);
    await shot(ui.page.getByTestId("research-preview"), "preview.png");
    await ui.page.getByTestId("research-dialog-cancel").click();
    await removeKeys(ui.page);
    if ((await researchOf(ui.page)).length !== 0) throw new Error("The rehearsal recorded research.");
    const plans = await ui.call<unknown>(`window.nivra.listPlans(${JSON.stringify(DEMO_SEED.ids.conversationId)})`);
    await ui.app.close();
    await stopped(session);
    ui = await launch(frozen, session.profileWin, session.wslHome);
    const again = await ui.call<unknown>(`window.nivra.listPlans(${JSON.stringify(DEMO_SEED.ids.conversationId)})`);
    if (JSON.stringify(again) !== JSON.stringify(plans) || (await researchOf(ui.page)).length !== 0) throw new Error("The relaunch didn't show the plan as it was, with no research.");
    log("Relaunched: the plan is as it was, with no research and no keys.");
  } finally {
    await ui.app.close().catch(() => undefined);
  }
  await stopped(session);
  const after = homesAfter(homes);
  for (const line of after.lines) log(line);
  const scanned = scans(frozen, session, evidence);
  log(`Credential scan: ${scanned.summary}.${scanned.found.length ? ` In: ${scanned.found.map((scan) => scan.file).join("; ")}.` : ""}`);
  save("rehearsal.json", { revision: frozen.revision, recipe: digest, route: session.route, homes: after.lines, scan: scanned, profile: session.profileWin, wslHome: session.wslHome });
  if (!after.unchanged || scanned.found.length) throw new Error("The rehearsal changed a home it must not touch, or left a credential shape: see above.");
  log(`Rehearsal passed. Evidence: ${evidence}.`);
}

// ---- live ---------------------------------------------------------------------------------------------------------

const sessionPath = join(STATE, "live-session.json");

async function live(approved: string): Promise<number> {
  if (!isDigest(approved)) throw new Error("--approved takes the digest --plan printed: 64 lowercase hexadecimal characters.");
  const frozen = checkedFrozen();
  const { recipe, digest } = await nextRecipe(frozen);
  if (digest !== approved) throw new Error(`The next unclaimed run of this recipe digests to ${digest}, not the approved ${approved}: it is claimed already, or something changed. Nothing was started.`);
  const evidence = evidenceFolder("live", frozen.revision);
  const { log, save, shot } = writer(evidence);
  save("recipe.txt", `${recipeText(recipe, digest)}\n`);
  log(`Evidence: ${evidence}. This run is detached from the terminal that started it.`);
  const homes = homeStates();
  const session = await prepared(frozen, "live", log);
  writeFileSync(sessionPath, `${JSON.stringify({ profileWin: session.profileWin, wslHome: session.wslHome, evidence }, null, 2)}\n`, { mode: 0o600 });
  let { ui } = session;

  // Before Start: any failure removes the keys, closes the app, and sends nothing.
  try {
    log("Over to you: open Projects & settings, paste the Token Factory key and the Tavily key, and save each. Don't press Check Token Factory.");
    await waitFor(
      async () => {
        const settings = await ui.settings();
        if (settings.nebiusProjectId !== "none") throw new Error("A Nebius project id is saved in this profile, which the recipe doesn't allow.");
        return settings.nebiusKey === "encrypted" && settings.tavilyKey === "set" ? settings : null;
      },
      30 * 60_000,
      "both keys to be saved in Settings, the Token Factory key encrypted",
    );
    log("Both keys are saved. Driving the journey to the preview.");
    await openDemo(ui.page);
    await pickDemo(ui.page);
    await previewAllowing(ui.page, log);
    const shown = await previewShown(ui.page);
    const preview = await hostPreview(ui.page);
    if (preview.blocked !== null || preview.expected !== recipe.fingerprint) throw new Error(`The preview's fingerprint is ${preview.expected} (blocked: ${preview.blocked}), not the approved ${recipe.fingerprint}.`);
    const problem = await routeProblem(ui);
    if (problem) throw new Error(problem);
    await shot(ui.page.getByTestId("research-preview"), "preview.png");
    log(`The preview shows ${shown.queries.join(" | ")}; ${shown.sites}. Its fingerprint is the approved one.`);
    const claimed = claimApproval(CLAIMS, { digest, run: recipe.run, revision: frozen.revision, out: evidence, pid: process.pid, claimedAt: new Date().toISOString() });
    if (!claimed.ok) throw new Error("This approval was claimed by another run first.");
  } catch (error) {
    log(`Nothing was started: ${message(error)} The approval isn't spent; removing the keys and closing the app.`);
    await removeKeys(ui.page).then(
      () => log("Both keys are removed from the profile."),
      (failure: unknown) => log(`The keys couldn't be removed (${message(failure)}): run this script with --cleanup.`),
    );
    await ui.app.close().catch(() => undefined);
    return 1;
  }
  log("Approval claimed. Pressing Start research, once.");

  // After Start: nothing throws out of runApproved, and the app closes only on the person's go-ahead.
  const outcome = await runApproved({
    page: () => ui.page,
    evidence,
    log,
    save,
    shot,
    close: async () => {
      await ui.app.close();
      await stopped(session);
    },
    relaunch: async () => {
      ui = await launch(frozen, session.profileWin, session.wslHome);
      await ui.online(`wsl:${frozen.distro}`);
      return ui.page;
    },
    routeProblem: () => routeProblem(ui),
    packetDigest: recipe.packetDigest,
  });
  const failures = [...outcome.failures];
  const homesResult = homesAfter(homes);
  if (!homesResult.unchanged) failures.push(...homesResult.lines.filter((line) => !line.endsWith(" unchanged")));
  let scan: ReturnType<typeof scans> | null = null;
  try {
    scan = scans(frozen, session, evidence);
    if (scan.found.length) failures.push(`Credential shapes in: ${scan.found.map((found) => found.file).join("; ")}.`);
  } catch (error) {
    failures.push(`The credential scan: ${message(error)}`);
  }
  const report = outcome.research?.report ?? null;
  save("check.json", {
    revision: frozen.revision,
    digest,
    run: recipe.run,
    build: recipe.build,
    profile: session.profileWin,
    wslHome: session.wslHome,
    route: session.route,
    status: outcome.research?.status ?? null,
    outcome: report?.outcome ?? null,
    stop: report?.stop ?? null,
    model: report?.route?.model ?? null,
    packetDigest: outcome.research?.packetDigest ?? null,
    elapsedMs: report?.elapsedMs ?? null,
    requests: report?.requests.map(({ id, state, failure, status, requestId, credits, pages, returned, elapsedMs }) => ({ id, state, failure, status, requestId, credits, pages, returned, elapsedMs })) ?? [],
    credits: report?.usage.credits ?? null,
    tokens: report?.usage.model ?? null,
    budget: report?.budget ?? null,
    assessments:
      report?.assessments.map((assessment) => ({
        assumption: assessment.assumption,
        model: assessment.model,
        shown: assessment.shown,
        rule: assessment.rule,
        citations: assessment.citations.length,
        valid: assessment.citations.filter((citation) => citation.valid).length,
      })) ?? [],
    checks: report?.checks ?? null,
    attribution: report?.attribution ? { handedIn: report.attribution.handedIn, matched: report.attribution.matched, usable: report.attribution.usable, rejected: report.attribution.rejected } : null,
    amended: outcome.amended?.find((plan) => plan.version === 2)?.id ?? null,
    relaunch: outcome.kept,
    keysRemoved: outcome.keysRemoved,
    homes: homesResult.lines,
    scan,
    failures,
  });
  for (const line of homesResult.lines) log(line);
  if (scan) log(`Credential scan: ${scan.summary}. ${SCAN_NOTE}`);
  if (!outcome.keysRemoved) log("The keys may still be in the profile: run this script with --cleanup.");
  log(failures.length ? `Done, with ${failures.length} failure(s): ${failures.join(" | ")}` : "Done, with no failure.");
  chmodSync(evidence, 0o700);
  return failures.length ? 1 : 0;
}

/** Opens the last live profile, removes its keys, closes it, and scans it again. */
async function cleanup(): Promise<void> {
  const frozen = readFrozen();
  if (!existsSync(sessionPath)) throw new Error("No live run has been prepared, so there is nothing to clean up.");
  const session = JSON.parse(readFileSync(sessionPath, "utf8")) as { profileWin: string; wslHome: string; evidence: string };
  const ui = await launch(frozen, session.profileWin, session.wslHome);
  try {
    await removeKeys(ui.page);
    console.log("Both keys are removed from the profile.");
  } finally {
    await ui.app.close().catch(() => undefined);
  }
  await stopped(session);
  const scan = scans(frozen, session, session.evidence);
  console.log(`Credential scan: ${scan.summary}. ${SCAN_NOTE}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      freeze: { type: "boolean" },
      plan: { type: "boolean" },
      rehearse: { type: "boolean" },
      live: { type: "boolean" },
      cleanup: { type: "boolean" },
      approved: { type: "string" },
      distro: { type: "string" },
      foreground: { type: "boolean" },
    },
  });
  const modes = (["freeze", "plan", "rehearse", "live", "cleanup"] as const).filter((mode) => values[mode]);
  if (modes.length !== 1) throw new Error("Choose one of --freeze, --plan, --rehearse, --live --approved <digest> or --cleanup.");
  if (values.freeze) await freeze(values.distro);
  else if (values.plan) await plan();
  else if (values.rehearse) await rehearse();
  else if (values.cleanup) await cleanup();
  else if (!values.foreground) {
    // The app lives as long as this process (Playwright closes it on exit), and a live run can wait hours for the
    // person: it runs detached, in a session of its own, so closing the terminal or ending a session can't cut it
    // short.
    mkdirSync(STATE, { recursive: true, mode: 0o700 });
    const out = join(STATE, `live-${stamp()}.log`);
    const fd = openSync(out, "a", 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--foreground"], { cwd: desktop, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    console.log(`The live run is detached (pid ${child.pid}), so it outlives this terminal. Follow it with: tail -f ${out}`);
  } else process.exit(await live(values.approved ?? ""));
}
