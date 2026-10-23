// R3's live run of research through the Windows app and its WSL engine (D37, NIV-45), and the steps around it. Never
// part of `pnpm verify`. Run from WSL, in apps/desktop, with no Nivra open on Windows:
//
//   node scripts/research-live.ts --freeze              copies the build `pnpm dev:win --no-launch` made to a folder
//                                                       of its own, records its hashes, and makes the demo repository
//   node scripts/research-live.ts --plan                prints the recipe and its digest, for approval; no network
//   node scripts/research-live.ts --rehearse            the journey on the frozen build with fake keys, to the preview
//   node scripts/research-live.ts --live --approved D   the approved run: one Start, then the window is the person's
//
// The journey is research-journey.ts's, which the offline e2e runs too. Nothing is sent before Start, and Start is
// pressed only in --live, once, after the approval is claimed and the preview's fingerprint is the approved one. After
// Start the script never closes the app on an error of its own: it stops driving and waits. It waits for files in the
// evidence folder: `go-close` (go ahead and close, relaunch and check) and `stop` (end here). The keys are pasted into
// Settings by the person; this script never reads or prints them, and never screenshots Settings.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RESEARCH_LIMITS } from "@nivra/domain";
import { _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { claimApproval, claimOn, isDigest } from "../../engine/scripts/research-check/claim.ts";
import type { ResearchView } from "../src/shared/research.ts";
import { sleep, Ui, waitFor } from "./live-ui.ts";
import { DEMO_PROJECT, DEMO_SEED, demoFingerprint, demoPacket } from "./research-demo.ts";
import { amendedVersion, checkKept, followToEnd, hostPreview, openDemo, pickDemo, plansOf, previewAllowing, previewShown, researchOf, startOnce } from "./research-journey.ts";
import { RELEASE_HOME_STATE, releaseHomeChange } from "./test-homes.ts";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(desktop, "..", "..");
const STATE = join(homedir(), "nivra-acceptance", "research-r3");
const CLAIMS = join(homedir(), "nivra-acceptance", "claims", "research-r3");
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const CREDITS = DEMO_SEED.assumptions.length * 2;


// ---- processes ----------------------------------------------------------------------------------------------------

function run(exe: string, args: string[], cwd = "/mnt/c"): string {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
}
const cmd = (line: string) => run("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", line]);
const wslpath = (flag: "-u" | "-w", path: string) => run("/usr/bin/wslpath", [flag, path]);
const sh = (script: string, ...args: string[]) => run("/bin/sh", ["-c", script, "sh", ...args], homedir());
const git = (...args: string[]) => run("git", args, repository);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

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
  const lines = Object.keys(before).map((home) => releaseHomeChange(before[home]!, after[home]!) ?? `${home} unchanged`);
  return { unchanged: lines.every((line) => line.endsWith(" unchanged")), lines };
}

// ---- the frozen build -----------------------------------------------------------------------------------------------

export interface Frozen {
  stamp: string;
  revision: string;
  /** The frozen folder as Windows names it, under %LOCALAPPDATA%\nivra-dev. */
  folderWin: string;
  appAsarSha256: string;
  runtimeContentHash: string;
  distro: string;
  repo: { path: string; commit: string };
}

const frozenPath = join(STATE, "freeze.json");
function readFrozen(): Frozen {
  if (!existsSync(frozenPath)) throw new Error("Nothing is frozen yet: run pnpm dev:win --no-launch, then this script with --freeze.");
  return JSON.parse(readFileSync(frozenPath, "utf8")) as Frozen;
}
const folderOf = (frozen: Frozen) => wslpath("-u", frozen.folderWin);

/** The frozen build's identity: app.asar's hash and the WSL runtime's content hash, read again. */
function buildHashes(folder: string): { appAsarSha256: string; runtimeContentHash: string } {
  const resources = join(folder, "app", "resources");
  const runtime = JSON.parse(readFileSync(join(resources, "runtime", "runtime-linux-x64.json"), "utf8")) as { contentHash: string };
  return { appAsarSha256: sha256(join(resources, "app.asar")), runtimeContentHash: runtime.contentHash };
}
function checkBuild(frozen: Frozen): void {
  const now = buildHashes(folderOf(frozen));
  if (now.appAsarSha256 !== frozen.appAsarSha256 || now.runtimeContentHash !== frozen.runtimeContentHash) {
    throw new Error("The frozen build changed since it was frozen. Freeze it again, and ask for a new approval.");
  }
}

async function freeze(distro: string | undefined): Promise<void> {
  const revision = cleanRevision();
  const at = stamp();
  const devWin = `${cmd("echo %LOCALAPPDATA%")}\\nivra-dev`;
  const builtWin = `${devWin}\\app`;
  if (!existsSync(join(wslpath("-u", builtWin), "Nivra.exe"))) throw new Error("No Windows build to freeze: run pnpm dev:win --no-launch first.");
  const folderWin = `${devWin}\\r3-${at}`;
  // robocopy's exit codes below 8 all mean success.
  const copied = spawnSync("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", `robocopy "${builtWin}" "${folderWin}\\app" /E /NFL /NDL /NJH /NJS /NP`], { cwd: "/mnt/c", encoding: "utf8" });
  if (copied.status === null || copied.status >= 8) throw new Error(`Copying the build failed: ${copied.stdout || copied.stderr}`);
  const folder = wslpath("-u", folderWin);
  const hashes = buildHashes(folder);
  if (JSON.stringify(hashes) !== JSON.stringify(buildHashes(wslpath("-u", devWin)))) throw new Error("The copy differs from the build it was copied from.");
  copyFileSync(join(desktop, "build", "stage", "win-x64", "node", "node.exe"), join(folder, "node.exe"));
  for (const [entry, out] of [
    ["seed-workspace-cli.ts", "seed.mjs"],
    ["shape-scan-cli.ts", "shape-scan.mjs"],
  ] as const) {
    const from = entry.startsWith("seed") ? join(desktop, "e2e", entry) : join(desktop, "scripts", entry);
    await build({ entryPoints: [from], outfile: join(folder, out), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning" });
  }
  // The demonstration repository in WSL: setup.py importing distutils.core, one commit with fixed dates.
  const repo = join(homedir(), "nivra-r3", DEMO_PROJECT);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "setup.py"), `from distutils.core import setup\n\nsetup(name="${DEMO_PROJECT}", version="1.0")\n`);
  writeFileSync(join(repo, "README.md"), `# ${DEMO_PROJECT}\n\nThe build image for R3's research demonstration.\n`);
  const fixed = { ...process.env, GIT_AUTHOR_DATE: "2026-10-23T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-23T00:00:00Z" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=Nivra R3", "-c", "user.email=r3@nivra.invalid", "commit", "-q", "-m", "The build image"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: fixed });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  const frozen: Frozen = { stamp: at, revision, folderWin, ...hashes, distro: distro ?? process.env["WSL_DISTRO_NAME"] ?? "Ubuntu", repo: { path: repo, commit: run("git", ["rev-parse", "HEAD"], repo) } };
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  writeFileSync(frozenPath, `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 });
  console.log(`Frozen at ${revision.slice(0, 7)} in ${folderWin}: app.asar ${hashes.appAsarSha256.slice(0, 16)}, runtime ${hashes.runtimeContentHash.slice(0, 16)}. Repository ${frozen.repo.commit.slice(0, 7)} at ${repo}.`);
}

// ---- the recipe ---------------------------------------------------------------------------------------------------

/** What one approval covers, as data: its digest binds every field. */
export async function recipeOf(frozen: Frozen) {
  const { packetDigest, fingerprint } = await demoFingerprint();
  const packet = demoPacket();
  return {
    kind: "nivra.research-r3.v1",
    run: 1,
    revision: frozen.revision,
    build: { appAsarSha256: frozen.appAsarSha256, runtimeContentHash: frozen.runtimeContentHash },
    route: { app: "the frozen Windows development build", engine: `wsl:${frozen.distro}` },
    project: { label: DEMO_PROJECT, path: frozen.repo.path, commit: frozen.repo.commit },
    plan: { id: DEMO_SEED.ids.planId, version: 1, text: packet.planText },
    assumptions: packet.assumptions.map((assumption) => ({ id: assumption.id, text: assumption.text, query: assumption.query })),
    sites: packet.sites,
    packetDigest,
    fingerprint,
    model: { expected: MODEL, rule: "The app uses the model its listing picks; a different one is recorded, never refused." },
    limits: RESEARCH_LIMITS,
    credits: CREDITS,
    requests: [
      "Token Factory: one model listing (GET /v1/models), in the run's prepare step",
      "Token Factory: one chat completion, with the plan, the assumptions and the passages read",
      `Tavily: at most ${packet.assumptions.length} searches (POST /search), one for each query`,
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
    "R3 of NIV-45: one research run of the demonstration plan through the Windows app and its WSL engine.",
    "",
    `Revision: ${recipe.revision} (clean tree)`,
    `Build: app.asar ${recipe.build.appAsarSha256}, WSL runtime ${recipe.build.runtimeContentHash}`,
    `Route: ${recipe.route.app}, then ${recipe.route.engine}, on the project ${recipe.project.label} (${recipe.project.path}, commit ${recipe.project.commit.slice(0, 12)})`,
    `Plan ${recipe.plan.id}, v${recipe.plan.version}, seeded (no model call made it):`,
    ...recipe.plan.text.split("\n").map((line) => `  ${line}`),
    "Assumptions, each query its own words:",
    ...recipe.assumptions.map((assumption) => `  ${assumption.id}: ${assumption.query}`),
    `Sites: ${recipe.sites?.mode} ${recipe.sites?.hosts.join(", ")}`,
    `Packet digest ${recipe.packetDigest}; preview fingerprint ${recipe.fingerprint}`,
    `Model: ${recipe.model.expected} expected. ${recipe.model.rule}`,
    "Every request the journey can make:",
    ...recipe.requests.map((request) => `  - ${request}`),
    `At most ${recipe.credits} Tavily credits. Limits: ${recipe.limits.runMs / 1000} s in all, retrieval stops at ${recipe.limits.retrievalCutoffMs / 1000} s, the model gets at most ${recipe.limits.modelMs / 1000} s; nothing is retried.`,
    `Never: ${recipe.never.join("; ")}.`,
    recipe.failure,
    "",
    `Digest: ${digest}`,
  ].join("\n");
}

async function plan(): Promise<void> {
  const frozen = readFrozen();
  const revision = cleanRevision();
  if (revision !== frozen.revision) throw new Error(`HEAD is ${revision.slice(0, 7)}, but the build was frozen at ${frozen.revision.slice(0, 7)}. Freeze again.`);
  checkBuild(frozen);
  const recipe = await recipeOf(frozen);
  const digest = digestOf(recipe);
  const text = recipeText(recipe, digest);
  writeFileSync(join(STATE, `recipe-${digest.slice(0, 12)}.txt`), `${text}\n`, { mode: 0o600 });
  console.log(text);
  const claim = claimOn(CLAIMS, digest);
  if (claim.claimed) console.log("\nThis recipe's approval is already claimed: its run happened. Another run needs a new recipe.");
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

/** No engine of this profile is left in the distribution, and the app has gone. */
async function stopped(session: Session): Promise<void> {
  await waitFor(() => !spawnSync("pgrep", ["-f", session.wslHome]).stdout.toString().trim(), 60_000, "the WSL engine to stop");
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
  const session = { ui, profileWin, wslHome };
  await stopped(session);
  const folder = folderOf(frozen);
  writeFileSync(join(folder, `seed-${kind}-${at}.json`), JSON.stringify(DEMO_SEED));
  const seeded = JSON.parse(run(join(folder, "node.exe"), [`${frozen.folderWin}\\seed.mjs`, "--project", `${profileWin}\\user data`, `${frozen.folderWin}\\seed-${kind}-${at}.json`])) as { targetId: string };
  if (seeded.targetId !== target) throw new Error(`The plan was seeded on ${seeded.targetId}, not ${target}.`);
  ui = await launch(frozen, profileWin, wslHome);
  const info = await ui.online(target);
  const engines = await ui.engines();
  const conversation = (await ui.call<{ conversations: Array<{ id: string; targetId: string }> }>("window.nivra.listConversations()")).conversations.find((c) => c.id === DEMO_SEED.ids.conversationId);
  const local = engines.find((engine) => engine.targetId === "local");
  if (conversation?.targetId !== target) throw new Error(`The demonstration's conversation runs on ${conversation?.targetId ?? "nothing"}, not ${target}.`);
  if (!info.home.endsWith(`/${wslHome}`) || info.platform !== "linux") throw new Error(`The WSL engine reports ${info.home} on ${info.platform}.`);
  if (local?.state.status === "online") throw new Error("The native Windows engine is running: R3 claims nothing for it.");
  const route = [`the conversation runs on ${target}`, `its engine reports home ${info.home} on ${info.platform}, engine ${info.engineVersion}`, `the native Windows engine isn't running (${local?.state.status ?? "never started"})`];
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
  return { log, save };
}
/** Waits for a file the person (or Claude, on their word) creates in the evidence folder. */
async function sentinel(folder: string, name: string): Promise<void> {
  while (!existsSync(join(folder, name))) await sleep(1_000);
}

/**
 * Credential shapes in every file of the evidence, the WSL engine's stores and the profile's files: which shapes, never
 * the text. The engine's stores are read once no engine of this profile runs, and the profile's on Windows (D7).
 */
function scans(frozen: Frozen, session: Session, evidence: string): Array<{ file: string; shapes: string[] | null }> {
  const home = join(homedir(), session.wslHome);
  const local = [...["nivra.db", "nivra.db-wal", "mastra.db", "mastra.db-wal"].map((file) => join(home, file)), ...readdirSync(evidence).map((file) => join(evidence, file))];
  const scan = (node: string, script: string, files: string[]) => JSON.parse(run(node, [script, ...files], node === process.execPath ? homedir() : "/mnt/c")) as Array<{ file: string; shapes: string[] | null }>;
  const folder = folderOf(frozen);
  const windowsFiles = ["workspace.db", "workspace.db-wal", "nivra.json", "secrets.json"].map((file) => `${session.profileWin}\\user data\\${file}`);
  return [...scan(process.execPath, join(folder, "shape-scan.mjs"), local), ...scan(join(folder, "node.exe"), `${frozen.folderWin}\\shape-scan.mjs`, windowsFiles)];
}

// ---- rehearse -------------------------------------------------------------------------------------------------------

async function rehearse(): Promise<void> {
  const frozen = readFrozen();
  const revision = cleanRevision();
  if (revision !== frozen.revision) throw new Error(`HEAD is ${revision.slice(0, 7)}, but the build was frozen at ${frozen.revision.slice(0, 7)}. Freeze again.`);
  const recipe = await recipeOf(frozen);
  const evidence = evidenceFolder("rehearsal", revision);
  const { log, save } = writer(evidence);
  const homes = homeStates();
  log(`Rehearsing recipe ${digestOf(recipe).slice(0, 12)} on the frozen build, with fake keys: nothing is started.`);
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
    await ui.page.getByTestId("research-preview").screenshot({ path: join(evidence, "preview.png") });
    await ui.page.getByTestId("research-dialog-cancel").click();
    await ui.call("window.nivra.setNebiusKey(null)");
    await ui.call("window.nivra.setTavilyKey(null)");
    const settings = await ui.settings();
    if (settings.nebiusKey !== "none" || settings.tavilyKey !== "none") throw new Error("The fake keys weren't removed.");
    if ((await researchOf(ui.page)).length !== 0) throw new Error("The rehearsal recorded research.");
    const plans = await plansOf(ui.page);
    await ui.app.close();
    await stopped(session);
    ui = await launch(frozen, session.profileWin, session.wslHome);
    const again = { plans: await plansOf(ui.page), research: await researchOf(ui.page) };
    if (JSON.stringify(again.plans) !== JSON.stringify(plans) || again.research.length !== 0) throw new Error("The relaunch didn't show the plan as it was, with no research.");
    log("Relaunched: the plan is as it was, with no research and no keys.");
  } finally {
    await ui.app.close().catch(() => undefined);
  }
  await stopped(session);
  const after = homesAfter(homes);
  for (const line of after.lines) log(line);
  const found = scans(frozen, session, evidence).filter((scan) => scan.shapes && scan.shapes.length > 0);
  log(found.length ? `Credential shapes found in: ${found.map((scan) => scan.file).join("; ")}.` : "No credential shape in the evidence, the engine's stores or the profile.");
  save("rehearsal.json", { revision, recipe: digestOf(recipe), route: session.route, homes: after.lines, shapes: found, profile: session.profileWin, wslHome: session.wslHome });
  if (!after.unchanged || found.length) throw new Error("The rehearsal changed a home it must not touch, or left a credential shape: see above.");
  log(`Rehearsal passed. Evidence: ${evidence}.`);
}

// ---- live ---------------------------------------------------------------------------------------------------------

async function live(approved: string): Promise<void> {
  if (!isDigest(approved)) throw new Error("--approved takes the digest --plan printed: 64 lowercase hexadecimal characters.");
  const frozen = readFrozen();
  const revision = cleanRevision();
  if (revision !== frozen.revision) throw new Error(`HEAD is ${revision.slice(0, 7)}, but the build was frozen at ${frozen.revision.slice(0, 7)}.`);
  const recipe = await recipeOf(frozen);
  const digest = digestOf(recipe);
  if (digest !== approved) throw new Error(`The recipe now digests to ${digest}, not the approved ${approved}. Nothing was started.`);
  if (claimOn(CLAIMS, digest).claimed) throw new Error("This approval is claimed already: its run happened. Another run needs another approval.");
  const evidence = evidenceFolder("live", revision);
  const { log, save } = writer(evidence);
  save("recipe.txt", `${recipeText(recipe, digest)}\n`);
  const homes = homeStates();
  const session = await prepared(frozen, "live", log);
  let { ui } = session;

  log("Over to you: open Projects & settings, paste the Token Factory key and the Tavily key, and save each. Don't press Check Token Factory.");
  await waitFor(
    async () => {
      const settings = await ui.settings();
      if (settings.nebiusProjectId !== "none") throw new Error("A Nebius project id is saved in this profile. The recipe saves none: remove it, then run this again.");
      return settings.nebiusKey !== "none" && settings.tavilyKey === "set" ? settings : null;
    },
    30 * 60_000,
    "both keys to be saved in Settings",
  );
  log("Both keys are saved. Driving the journey to the preview.");
  await openDemo(ui.page);
  await pickDemo(ui.page);
  await previewAllowing(ui.page, log);
  const shown = await previewShown(ui.page);
  const preview = await hostPreview(ui.page);
  if (preview.blocked !== null || preview.expected !== recipe.fingerprint) {
    throw new Error(`The preview's fingerprint is ${preview.expected} (blocked: ${preview.blocked}), not the approved ${recipe.fingerprint}. Nothing was started, and the approval isn't claimed.`);
  }
  await ui.page.getByTestId("research-preview").screenshot({ path: join(evidence, "preview.png") });
  log(`The preview shows ${shown.queries.join(" | ")}; ${shown.sites}. Its fingerprint is the approved one.`);
  const claimed = claimApproval(CLAIMS, { digest, run: 1, revision, out: evidence, pid: process.pid, claimedAt: new Date().toISOString() });
  if (!claimed.ok) throw new Error("This approval was claimed by another run first. Nothing was started.");
  log("Approval claimed. Pressing Start research, once.");

  // From here on, the window is never closed on this script's own error.
  let research: ResearchView | null = null;
  try {
    const started = await startOnce(ui.page);
    research = await followToEnd(ui.page, started.id, 300_000, log);
    save("research.json", research);
    save("report.json", research.report);
    if (research.runId) save("events.json", await ui.events(research.runId));
    await ui.page.locator(`[data-testid="research"][data-research-id="${research.id}"]`).screenshot({ path: join(evidence, "card.png") });
    const report = research.report;
    log(`Research ended: ${research.status}, report ${report?.outcome ?? "none"}. Model ${report?.route?.model ?? "unknown"}; credits ${report?.usage.credits ?? "not reported"}; tokens ${report?.usage.model.inputTokens ?? "?"} in, ${report?.usage.model.outputTokens ?? "?"} out; ${report?.elapsedMs ?? "?"} ms.`);
    save("plans-before.json", await plansOf(ui.page));
  } catch (error) {
    log(`The script stopped driving after Start: ${error instanceof Error ? error.message : String(error)} The window is yours: nothing more is pressed. Create the file stop in ${evidence} to end.`);
    await sentinel(evidence, "stop");
    await ui.app.close().catch(() => undefined);
    return;
  }

  log(`Over to you: read the card, open an address to check its page, then press Amend, edit the amended version and save it. I only watch for v2. To end without saving, create the file stop in ${evidence}.`);
  const amended = await Promise.race([amendedVersion(ui.page, 3 * 60 * 60_000), sentinel(evidence, "stop").then(() => null)]);
  if (amended) {
    save("plans-after.json", amended);
    await ui.page.getByTestId("plan-version").first().screenshot({ path: join(evidence, "plan-v2.png") });
    log(`v2 saved: ${amended.find((plan) => plan.version === 2)!.id}. v1 is unchanged: ${amended.find((plan) => plan.version === 1)!.text === demoPacket().planText ? "yes" : "no"}.`);
  } else log("Ended without an amended version.");

  log(`Waiting for the go-ahead to close the app: create the file go-close in ${evidence}.`);
  await Promise.race([sentinel(evidence, "go-close"), sentinel(evidence, "stop")]);
  const before = { plans: await plansOf(ui.page), research: await researchOf(ui.page) };
  await ui.app.close();
  await stopped(session);
  ui = await launch(frozen, session.profileWin, session.wslHome);
  const kept = amended ? await checkKept(ui.page, before) : [];
  for (const line of kept) log(`After the relaunch: ${line}.`);
  if (amended) await ui.page.getByTestId("plan-version").first().screenshot({ path: join(evidence, "relaunched.png") });
  await ui.call("window.nivra.setNebiusKey(null)");
  await ui.call("window.nivra.setTavilyKey(null)");
  const settings = await ui.settings();
  if (settings.nebiusKey !== "none" || settings.tavilyKey !== "none") throw new Error("The keys weren't removed from the profile: remove them in Settings.");
  log("Both keys are removed from the profile.");
  await ui.app.close();
  await stopped(session);

  const report = research.report;
  const check = {
    revision,
    digest,
    build: recipe.build,
    profile: session.profileWin,
    wslHome: session.wslHome,
    route: session.route,
    status: research.status,
    outcome: report?.outcome ?? null,
    stop: report?.stop ?? null,
    model: report?.route?.model ?? null,
    elapsedMs: report?.elapsedMs ?? null,
    requests: report?.requests.map(({ id, state, failure, status, requestId, credits, pages, returned, elapsedMs }) => ({ id, state, failure, status, requestId, credits, pages, returned, elapsedMs })) ?? [],
    credits: report?.usage.credits ?? null,
    tokens: report?.usage.model ?? null,
    budget: report?.budget?.used ?? null,
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
    amended: amended ? amended.find((plan) => plan.version === 2)!.id : null,
    relaunch: kept,
    homes: homesAfter(homes).lines,
    scans: [] as Array<{ file: string; shapes: string[] | null }>,
  };
  save("check.json", check);
  check.scans = scans(frozen, session, evidence);
  save("check.json", check);
  const found = check.scans.filter((scan) => scan.shapes && scan.shapes.length > 0);
  for (const line of check.homes) log(line);
  log(found.length ? `Credential shapes found in: ${found.map((scan) => `${scan.file} (${scan.shapes!.join(", ")})`).join("; ")}.` : `No credential shape in ${check.scans.filter((scan) => scan.shapes).length} files scanned.`);
  chmodSync(evidence, 0o700);
  log(`Done. Evidence: ${evidence}.`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { freeze: { type: "boolean" }, plan: { type: "boolean" }, rehearse: { type: "boolean" }, live: { type: "boolean" }, approved: { type: "string" }, distro: { type: "string" } },
  });
  const modes = (["freeze", "plan", "rehearse", "live"] as const).filter((mode) => values[mode]);
  if (modes.length !== 1) throw new Error("Choose one of --freeze, --plan, --rehearse or --live --approved <digest>.");
  if (values.freeze) await freeze(values.distro);
  else if (values.plan) await plan();
  else if (values.rehearse) await rehearse();
  else await live(values.approved ?? "");
}
