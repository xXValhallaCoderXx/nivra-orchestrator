// NIV-35's live run of a real task through the packaged Linux app (D41): a project's environment prepared in Nebius, a
// real repository task worked by Nemotron through Token Factory, its checks run in Nebius Sandboxes, its change approved
// and accepted by the person. Never part of `pnpm verify`. Run from WSL, in apps/desktop:
//
//   node scripts/task-live.ts --freeze               the release candidate's unpacked Linux build, copied to a folder of
//                                                    its own with its hashes; the checkout and its brief checked
//   node scripts/task-live.ts --plan                 prints the recipe and its digest, for approval; no network
//   node scripts/task-live.ts --rehearse             the journey on the frozen build with fake keys, to each preview
//   node scripts/task-live.ts --live --approved D    the approved run: one preparation and one task run, then the
//                                                    person's decisions; its log is printed
//   node scripts/task-live.ts --cleanup              opens the last live profile, removes its keys, checks it
//
// The task is the brief file's (default ~/nivra-work/she65/task-live.json, outside the repository): the repository and
// its baseline, the environment's filters, and the brief with its cases, baseline selections and frozen files. Nothing
// here names a repository. The keys are pasted into Settings by the person: this script never reads or prints them.
// Nothing is sent before the approval is claimed, and then only by pressing Prepare and Start, once each.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ENVIRONMENT_BASE, TaskBrief, taskBriefDigest, type EnvironmentSpec, type PreparedEnvironment } from "@nivra/domain";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { claimApproval, claimOn, isDigest } from "../../engine/scripts/research-check/claim.ts";
import { environmentPreviewOf, ENVIRONMENT_NETWORK, PREPARE_LIMITS } from "../../engine/src/environment/preview.ts";
import { createLocalBackend } from "../../engine/src/exec/local.ts";
import { RETENTION } from "../../engine/src/exec/nebius/sandbox.ts";
import { compressSnapshot } from "../../engine/src/exec/nebius/session.ts";
import { findGit } from "../../engine/src/exec/find-executable.ts";
import { takeSnapshot } from "../../engine/src/exec/snapshot.ts";
import { runLimitsFor } from "../../engine/src/task/limits.ts";
import type { BriefFields, ProjectView, SettingsView, TaskRunPreview } from "../src/shared/ipc.ts";
import { addProject, attemptOf, createTask, environmentOf, followRun, keysSaved, prepareOnce, previewEnvironment, previewRun, startOnce, taskOf } from "./task-journey.ts";
import { buildChanges, buildHashes, previewProblems, type BuildHashes } from "./task-live-checks.ts";
import { RELEASE_HOME_STATE, releaseHomeChange } from "./test-homes.ts";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(desktop, "..", "..");
const STATE = join(homedir(), "nivra-acceptance", "task-live");
const CLAIMS = join(homedir(), "nivra-acceptance", "claims", "task-live");
const MODEL = "nvidia/nemotron-3-super-120b-a12b";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (exe: string, args: string[], cwd: string): string => {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const git = (cwd: string, ...args: string[]) => run("git", args, cwd);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// ---- the task, from its file ------------------------------------------------------------------------------------

export interface LiveTask {
  repository: string;
  baseline: string;
  environment: EnvironmentSpec;
  task: { title: string };
  brief: TaskBrief;
}

function readTask(path: string): LiveTask {
  const given = JSON.parse(readFileSync(path, "utf8")) as LiveTask;
  const brief = TaskBrief.safeParse(given.brief);
  if (!brief.success) throw new Error(`The brief in ${path} isn't one Nivra takes: ${brief.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (!/^[0-9a-f]{40}$/.test(given.baseline)) throw new Error(`${path} names no baseline commit.`);
  return { ...given, brief: brief.data };
}

/** The checkout at its baseline, clean, outside this repository. */
function checkCheckout(task: LiveTask): void {
  const real = resolve(task.repository);
  if (!real.startsWith("/") || real.startsWith(repository)) throw new Error("The task's repository must be a checkout of its own, outside Nivra's.");
  if (git(real, "rev-parse", "HEAD") !== task.baseline) throw new Error(`${real} isn't at the baseline ${task.baseline}. Check it out there, then try again.`);
  if (git(real, "status", "--porcelain", "--untracked-files=all") !== "") throw new Error(`${real} has uncommitted changes. Clean it, then try again.`);
}

// ---- the frozen build ---------------------------------------------------------------------------------------------

export interface Frozen extends BuildHashes {
  stamp: string;
  revision: string;
  version: string;
  /** The unpacked Linux build, copied here from the release candidate. */
  folder: string;
  debName: string;
  debSha256: string;
  buildInfoSha256: string;
}

const frozenPath = join(STATE, "freeze.json");
function readFrozen(): Frozen {
  if (!existsSync(frozenPath)) throw new Error("Nothing is frozen yet: run this script with --freeze.");
  return JSON.parse(readFileSync(frozenPath, "utf8")) as Frozen;
}

/** The frozen build, every file hashed again (`buildHashes`), as it was frozen. */
function checkBuild(frozen: Frozen): void {
  const changed = buildChanges(frozen, buildHashes(frozen.folder));
  if (changed.length) throw new Error(`The frozen build changed since it was frozen (${changed.join(", ")}). Freeze it again, and ask for a new approval.`);
}

/**
 * Copies the release candidate's unpacked Linux build, made from this clean tree by `pnpm release:candidate`, to a
 * folder of its own, and records its hashes. The candidate's files are the ones a release publishes unchanged.
 */
function freeze(): void {
  if (git(repository, "status", "--porcelain")) throw new Error("The working tree has changes: the live run uses a build of a clean, committed revision.");
  const revision = git(repository, "rev-parse", "HEAD");
  const release = join(desktop, "release");
  const info = JSON.parse(readFileSync(join(release, "build-info.json"), "utf8")) as { commit: string; version: string; artefacts: Array<{ name: string; sha256: string }> };
  if (info.commit !== revision) throw new Error(`release/build-info.json is for ${info.commit.slice(0, 12)}, not this tree's ${revision.slice(0, 12)}. Run pnpm release:candidate here first.`);
  const deb = info.artefacts.find((artefact) => artefact.name.endsWith(".deb"));
  if (!deb || sha256(join(release, deb.name)) !== deb.sha256) throw new Error("The candidate's deb isn't the one its build-info.json names.");
  const at = stamp();
  const folder = join(STATE, `frozen-${at}`, "linux-unpacked");
  mkdirSync(dirname(folder), { recursive: true, mode: 0o700 });
  cpSync(join(release, "linux-unpacked"), folder, { recursive: true, verbatimSymlinks: true });
  const hashes = buildHashes(folder);
  const original = buildHashes(join(release, "linux-unpacked"));
  if (JSON.stringify(hashes) !== JSON.stringify(original)) throw new Error("The copy differs from the build it was copied from.");
  const frozen: Frozen = { stamp: at, revision, version: info.version, folder, ...hashes, debName: deb.name, debSha256: deb.sha256, buildInfoSha256: sha256(join(release, "build-info.json")) };
  writeFileSync(frozenPath, `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 });
  console.log(`Frozen ${info.version} at ${revision.slice(0, 7)} in ${folder}: nivra ${hashes.nivraSha256.slice(0, 12)}, app.asar ${hashes.appAsarSha256.slice(0, 12)}, runtime ${hashes.runtimeContentHash}.`);
}

// ---- the recipe ---------------------------------------------------------------------------------------------------

/** What preparing and running would send, worked out here from the checkout with no network, as the app's engine does. */
async function bound(task: LiveTask) {
  const git = findGit({ env: process.env });
  if (!git) throw new Error("git isn't installed here.");
  const local = await createLocalBackend({ baseEnv: process.env }).open({ workspace: task.repository });
  try {
    const snapshot = await takeSnapshot({ folder: task.repository, session: local, git, baseline: task.baseline });
    const environment = environmentPreviewOf(snapshot, task.environment);
    const frozen = (task.brief.frozen ?? []).map((path) => {
      const file = snapshot.files.find((entry) => entry.path === path);
      if (!file) throw new Error(`The brief freezes ${path}, which the baseline doesn't hold.`);
      return { path, sha256: file.sha256 };
    });
    return {
      snapshot: { fingerprint: snapshot.fingerprint, files: snapshot.files.length, sentBytes: compressSnapshot(snapshot.archive.archive).byteLength, leftOut: snapshot.leftOut.secret.sample },
      environment: { fingerprint: environment.fingerprint, inputsDigest: environment.inputsDigest, inputs: environment.inputs.length, sentBytes: environment.sentBytes, installArgs: environment.installArgs, packageManager: environment.packageManager, leftOut: environment.leftOut },
      frozen,
    };
  } finally {
    await local.close();
  }
}

/** What one approval covers, as data: its digest binds every field. `run` numbers the approvals of one recipe. */
export async function recipeOf(frozen: Frozen, task: LiveTask, run = 1) {
  const shown = await bound(task);
  const { brief } = task;
  return {
    kind: "nivra.task-live.v1",
    run,
    route: "the frozen Linux build, unpacked, with a profile and an engine home of its own",
    revision: frozen.revision,
    build: { version: frozen.version, nivraSha256: frozen.nivraSha256, appAsarSha256: frozen.appAsarSha256, runtimeContentHash: frozen.runtimeContentHash, runtimeSha256: frozen.runtimeSha256, treeSha256: frozen.treeSha256, treeFiles: frozen.treeFiles, debSha256: frozen.debSha256 },
    repository: { path: task.repository, baseline: task.baseline, ...shown.snapshot },
    environment: { spec: task.environment, base: ENVIRONMENT_BASE, ...shown.environment, network: ENVIRONMENT_NETWORK, limits: { importSeconds: PREPARE_LIMITS.importSeconds, prepareSeconds: PREPARE_LIMITS.prepareSeconds } },
    task: { title: task.task.title, briefDigest: await taskBriefDigest(brief), cases: brief.acceptanceCases.map((given) => given.name), checks: brief.checks, baseline: (brief.baseline ?? []).map((given) => given.name), frozen: shown.frozen },
    limits: runLimitsFor(brief.acceptanceCases.length + brief.checks.length, brief.baseline?.length ?? 0),
    model: { expected: MODEL, rule: "The app uses the model its listing picks; a different one is recorded, never refused." },
    steps: [
      "the script launches the frozen build with a profile and an engine home of its own; Nate pastes the Nebius key and project id into Settings, and the script waits until both are saved",
      "the script adds the repository as a project, and allows its model sharing and its uploads, each through its own dialog",
      "the script previews the environment and checks its fingerprint is the one above, claims the approval, and presses Prepare once",
      "once it is prepared, the script creates the task with the brief above, marks it ready, and previews the run. It checks the preview is bound to this brief's digest, this commit's snapshot and the environment just prepared (the fingerprint Start sends, which the app checks again), and shows the frozen files above with their hashes, then presses Start once",
      "Nate reads the proposal and its checks, and decides: Approve and then Accept, Reject, or a revision (which this approval doesn't run)",
      "on Nate's go-ahead, the app is closed and relaunched, the keys are removed, and ~/.nivra is checked unchanged",
    ],
    requests: [
      `Nebius: the image listing; an import of ${ENVIRONMENT_BASE.tag} if the project has none; one upload of the environment's inputs (${shown.environment.sentBytes} bytes); one preparation with networking on`,
      `Nebius: one upload of the commit (${shown.snapshot.sentBytes} bytes compressed); at most ${runLimitsFor(brief.acceptanceCases.length + brief.checks.length, brief.baseline?.length ?? 0).operations} operations with networking off, and cleanup's cancels`,
      "Token Factory: one model listing; at most the run's model requests, each with the brief, the files the worker reads and the output of what it runs",
    ],
    keeps: { nebius: `${RETENTION} Nebius keeps each operation's arguments in its records, so what the worker writes stays there too.`, tokenFactory: "Token Factory keeps what it receives, under its own terms. What was sent can't be withdrawn." },
    never: ["a second Prepare or Start", "a retry or a retake", "a push, a PR or a ticket closed", "any command run on this machine against the repository"],
    failure: "Whatever the run gives is recorded as it is. No retake under this approval; another run needs another approval.",
  };
}
export const digestOf = (recipe: object) => createHash("sha256").update(JSON.stringify(recipe)).digest("hex");

/** The first run of the recipe whose approval isn't claimed yet. */
async function nextRecipe(frozen: Frozen, task: LiveTask) {
  for (let run = 1; ; run++) {
    const recipe = await recipeOf(frozen, task, run);
    const digest = digestOf(recipe);
    if (!claimOn(CLAIMS, digest).claimed) return { recipe, digest };
  }
}

function recipeText(recipe: Awaited<ReturnType<typeof recipeOf>>, digest: string): string {
  return [
    `NIV-35's live run on Linux, run ${recipe.run} of this recipe.`,
    "",
    `Revision ${recipe.revision}; Nivra ${recipe.build.version}: nivra ${recipe.build.nivraSha256}, app.asar ${recipe.build.appAsarSha256}, runtime ${recipe.build.runtimeContentHash} (files ${recipe.build.runtimeSha256}), every file of the build ${recipe.build.treeSha256} (${recipe.build.treeFiles}), deb ${recipe.build.debSha256}`,
    `Route: ${recipe.route}`,
    `Repository: ${recipe.repository.path} at ${recipe.repository.baseline}; ${recipe.repository.files} files, ${recipe.repository.sentBytes} bytes compressed; left out: ${recipe.repository.leftOut.join(", ") || "none"}; snapshot ${recipe.repository.fingerprint}`,
    `Environment: ${recipe.environment.base.tag}, ${recipe.environment.packageManager}, pnpm install ${recipe.environment.installArgs.join(" ")}; ${recipe.environment.inputs} inputs, ${recipe.environment.sentBytes} bytes; preview ${recipe.environment.fingerprint}`,
    `  ${recipe.environment.network}`,
    `Task "${recipe.task.title}", brief ${recipe.task.briefDigest}:`,
    ...recipe.task.cases.map((name, index) => `  case ${index + 1}: ${name}`),
    ...recipe.task.checks.map((check, index) => `  check ${index + 1}: ${check}`),
    ...recipe.task.baseline.map((name, index) => `  baseline ${index + 1}: ${name}`),
    ...recipe.task.frozen.map((file) => `  frozen: ${file.sha256}  ${file.path}`),
    `Limits: ${JSON.stringify(recipe.limits)}; preparation ${recipe.environment.limits.importSeconds} s to import, ${recipe.environment.limits.prepareSeconds} s to install`,
    `Model: ${recipe.model.expected} expected. ${recipe.model.rule}`,
    "Steps:",
    ...recipe.steps.map((step) => `  - ${step}`),
    "Every request the run can make:",
    ...recipe.requests.map((request) => `  - ${request}`),
    `Nebius keeps: ${recipe.keeps.nebius}`,
    `Token Factory keeps: ${recipe.keeps.tokenFactory}`,
    `Never: ${recipe.never.join("; ")}.`,
    recipe.failure,
    "",
    `Digest: ${digest}`,
  ].join("\n");
}

// ---- the app ------------------------------------------------------------------------------------------------------

const sh = (script: string) => run("/bin/sh", ["-c", script], homedir());
/** The release home and the shared development home: neither may change during a run. */
const homeStates = () => ({ "~/.nivra": sh(RELEASE_HOME_STATE), "~/.nivra-dev": sh(RELEASE_HOME_STATE.replace('"$HOME/.nivra"', '"$HOME/.nivra-dev"')) });
function homesAfter(before: Record<string, string>): { unchanged: boolean; lines: string[] } {
  const after = homeStates();
  const lines = Object.keys(before).map((home) => releaseHomeChange(before[home]!, after[home as keyof typeof after]!)?.replace("~/.nivra changed", `${home} changed`) ?? `${home} unchanged`);
  return { unchanged: lines.every((line) => line.endsWith(" unchanged")), lines };
}

/** The frozen build, started with a profile and an engine home of its own, inside `folder`. */
async function openApp(frozen: Frozen, folder: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: join(frozen.folder, "nivra"), args: [`--user-data-dir=${join(folder, "profile")}`, `--nivra-engine-home=${join(folder, "engine home")}`], chromiumSandbox: true });
  return { app, page: await app.firstWindow() };
}

const call = <T>(page: Page, expression: string) => page.evaluate(expression) as Promise<T>;
/** Removes the Nebius key and project id, through the calls Settings' own buttons make, and checks they are gone. */
async function removeKeys(page: Page): Promise<void> {
  await call(page, "window.nivra.setNebiusKey(null)");
  await call(page, "window.nivra.setNebiusProjectId(null)");
  const settings = await call<SettingsView>(page, "window.nivra.getSettings()");
  if (settings.nebiusKey !== "none" || settings.nebiusProjectId !== "none") throw new Error("A key is still saved in the profile: remove it in Settings.");
}

const fieldsOf = (task: LiveTask): BriefFields => ({ ...task.brief, assumptions: [] });

/** Why the run the window would start isn't the recipe's (`previewProblems`), read from the app as it stands. */
async function runPreviewProblems(page: Page, recipe: Awaited<ReturnType<typeof recipeOf>>, ids: { taskId: string; projectId: string }, prepared: PreparedEnvironment | null, shownExpected: string): Promise<string[]> {
  const view = await taskOf(page, ids.taskId);
  const project = (await call<ProjectView[]>(page, "window.nivra.listProjects()")).find((one) => one.id === ids.projectId);
  if (!project) return ["the project isn't in the app"];
  const structured = await call<TaskRunPreview>(page, `window.nivra.previewTaskRun(${JSON.stringify(ids.taskId)})`);
  return previewProblems({
    approved: { baseline: recipe.repository.baseline, snapshotFingerprint: recipe.repository.fingerprint, briefDigest: recipe.task.briefDigest, frozen: recipe.task.frozen, inputsDigest: recipe.environment.inputsDigest },
    ids: { taskId: ids.taskId, briefId: view.brief.id, briefVersion: view.brief.version, projectId: project.id, targetId: project.targetId },
    prepared,
    shownExpected,
    structured,
  });
}

/**
 * The journey on the frozen build with fake keys, to each preview and no further: the environment's preview (no
 * Prepare) and the task's (no Start). Nothing is sent: a preview reaches no service, and the keys are fake.
 */
async function rehearse(frozen: Frozen, task: LiveTask): Promise<number> {
  const { recipe, digest } = await nextRecipe(frozen, task);
  const folder = join(STATE, `rehearsal-${stamp()}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const homes = homeStates();
  const { app, page } = await openApp(frozen, folder);
  try {
    log(`Rehearsing recipe ${digest.slice(0, 12)} on the frozen build, with fake keys: nothing is prepared or started.`);
    await call(page, `window.nivra.setNebiusKey(${JSON.stringify("rehearsal-key-not-real-0123456789")}).then(() => window.nivra.setNebiusProjectId("project-rehearsal"))`);
    const projectId = await addProject(app, page, task.repository);
    const shown = await previewEnvironment(page, projectId, task.environment);
    if (shown.fingerprint !== recipe.environment.fingerprint) throw new Error(`The environment's preview is ${shown.fingerprint}, not the recipe's ${recipe.environment.fingerprint}.`);
    log(`Environment preview: ${shown.inputs.length} inputs, ${shown.sentBytes} bytes, pnpm install ${shown.installArgs.join(" ")}; the recipe's fingerprint.`);
    const taskId = await createTask(page, { title: task.task.title, fields: fieldsOf(task), projectId, planId: null });
    const run = await previewRun(page);
    log(`Run preview: ${run.baseline}; frozen ${run.frozen.length}; ${run.limits.slice(0, 160)}`);
    // The live run's check, with no environment prepared: the fingerprints worked out here must be the app's.
    const problems = await runPreviewProblems(page, recipe, { taskId, projectId }, null, run.expected);
    if (problems.length) throw new Error(`The rehearsal's run preview isn't the recipe's: ${problems.join("; ")}.`);
    log("Run preview: bound to the recipe's brief digest and snapshot, with its frozen files and their hashes.");
    const brief = (await taskOf(page, taskId)).brief;
    writeFileSync(join(folder, "rehearsal.json"), `${JSON.stringify({ recipe: digest, environment: shown, run, briefVersion: brief.version }, null, 2)}\n`, { mode: 0o600 });
    await removeKeys(page);
  } finally {
    await app.close();
  }
  const after = homesAfter(homes);
  for (const line of after.lines) log(line);
  return after.unchanged ? 0 : 1;
}

/**
 * The approved run. Nothing is sent before the approval is claimed, and then only by pressing Prepare and Start,
 * once each. The decisions after the run are the person's, in the window; the app is closed only once the person
 * creates `go-close` in the evidence folder.
 */
async function live(frozen: Frozen, task: LiveTask, approved: string): Promise<number> {
  const { recipe, digest } = await nextRecipe(frozen, task);
  if (digest !== approved) throw new Error(`The next unclaimed run of this recipe digests to ${digest}, not the approved ${approved}: it is claimed already, or something changed. Nothing was started.`);
  const folder = join(STATE, `live-${stamp()}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const log = (line: string) => {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    lines.push(stamped);
    console.log(stamped);
    writeFileSync(join(folder, "log.txt"), `${lines.join("\n")}\n`, { mode: 0o600 });
  };
  const save = (name: string, value: unknown) => writeFileSync(join(folder, name), `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  save("recipe.txt", recipeText(recipe, digest));
  const homes = homeStates();
  const { app, page } = await openApp(frozen, folder);
  let claimed = false;
  try {
    log("Paste the Nebius key and project id into Settings. This script waits until both are saved, and never reads them.");
    await keysSaved(page, 30 * 60_000);
    const projectId = await addProject(app, page, task.repository);
    const shown = await previewEnvironment(page, projectId, task.environment);
    if (shown.fingerprint !== recipe.environment.fingerprint) throw new Error(`The environment's preview is ${shown.fingerprint}, not the approved ${recipe.environment.fingerprint}. Nothing was sent.`);
    const claim = claimApproval(CLAIMS, { digest, run: recipe.run, revision: frozen.revision, out: folder, pid: process.pid, claimedAt: new Date().toISOString() });
    if (!claim.ok) throw new Error("This approval was claimed by another run first. Nothing was sent.");
    claimed = true;
    log(`Approval ${digest.slice(0, 12)} claimed. Pressing Prepare, once.`);
    const environment = await prepareOnce(page, projectId, 30 * 60_000, log);
    save("environment.json", environment);
    if (!environment.prepared || environment.preparation?.status !== "answered") {
      log(`The preparation ended ${environment.preparation?.status ?? "unknown"}: ${environment.preparation?.report?.stopped?.message ?? environment.preparation?.note ?? ""}. No task run is started under this approval.`);
      return finish(1);
    }
    log(`Prepared: Node ${environment.prepared.node}, pnpm ${environment.prepared.pnpm}, ${environment.prepared.arch}, image ${environment.prepared.image}.`);
    const taskId = await createTask(page, { title: task.task.title, fields: fieldsOf(task), projectId, planId: null });
    const run = await previewRun(page);
    save("run-preview.json", run);
    const problems = await runPreviewProblems(page, recipe, { taskId, projectId }, environment.prepared, run.expected);
    if (problems.length) throw new Error(`The run's preview isn't the approved one: ${problems.join("; ")}. Start wasn't pressed.`);
    log("The run's preview is the approved one: this brief, this commit's snapshot, the environment just prepared and the frozen files. Pressing Start, once.");
    const attemptId = await startOnce(page, taskId);
    const ended = await followRun(page, taskId, attemptId, 45 * 60_000, log);
    save("attempt.json", ended);
    log(`The run ended ${ended.status}${ended.report ? `: ${ended.report.outcome}${ended.report.verified ? ", verified" : ""}` : ""}. The decisions are yours, in the window: Approve and then Accept, Reject, or a revision. Create ${join(folder, "go-close")} when you're done.`);
    for (;;) {
      if (existsSync(join(folder, "go-close"))) break;
      await page.waitForTimeout(5_000);
    }
    save("task.json", await taskOf(page, taskId));
    save("attempt-final.json", await attemptOf(page, taskId, attemptId));
    save("environment-final.json", await environmentOf(page, projectId));
    save("diff.txt", run_("git", ["diff"], task.repository));
    save("status.txt", run_("git", ["status", "--porcelain"], task.repository));
    return finish(0);
  } catch (error) {
    log(`Stopped: ${error instanceof Error ? error.message : String(error)}${claimed ? "" : " Nothing was sent."}`);
    return finish(1);
  }

  async function finish(code: number): Promise<number> {
    await removeKeys(page).catch((error: unknown) => log(`Removing the keys failed: ${error instanceof Error ? error.message : String(error)}. Remove them in Settings.`));
    await app.close().catch(() => undefined);
    const after = homesAfter(homes);
    for (const line of after.lines) log(line);
    log(`Evidence: ${folder}`);
    return after.unchanged ? code : 1;
  }
}

/** A command's output, or its failure's words, for the evidence. */
function run_(exe: string, args: string[], cwd: string): string {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : `${exe} ${args.join(" ")} failed: ${result.stderr}`;
}

/** Opens the last live profile, removes its keys, and closes it. */
async function cleanup(frozen: Frozen): Promise<number> {
  const last = readdirSync(STATE).filter((name) => name.startsWith("live-")).sort().at(-1);
  if (!last) throw new Error("There is no live run to clean up.");
  const { app, page } = await openApp(frozen, join(STATE, last));
  try {
    await removeKeys(page);
  } finally {
    await app.close();
  }
  console.log(`The keys are removed from ${join(STATE, last, "profile")}.`);
  return 0;
}

// ---- the command line ---------------------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    freeze: { type: "boolean", default: false },
    plan: { type: "boolean", default: false },
    rehearse: { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
    approved: { type: "string" },
    task: { type: "string", default: join(homedir(), "nivra-work", "she65", "task-live.json") },
  },
  allowPositionals: false,
});
const modes = (["freeze", "plan", "rehearse", "live", "cleanup"] as const).filter((mode) => values[mode]);
if (modes.length !== 1) {
  console.error("Choose one of --freeze, --plan, --rehearse, --live --approved <digest> or --cleanup.");
  process.exit(2);
}
mkdirSync(STATE, { recursive: true, mode: 0o700 });
if (values.cleanup) {
  // Apart from the task's checkout, which an approved apply leaves changed: removing the keys never waits on it. The
  // build that opens the profile must still be the one frozen.
  const frozen = readFrozen();
  checkBuild(frozen);
  process.exit(await cleanup(frozen));
}
const task = readTask(values.task!);
checkCheckout(task);
if (values.freeze) {
  freeze();
} else {
  const frozen = readFrozen();
  checkBuild(frozen);
  if (values.plan) {
    const { recipe, digest } = await nextRecipe(frozen, task);
    const text = recipeText(recipe, digest);
    writeFileSync(join(STATE, `recipe-${digest.slice(0, 12)}.txt`), `${text}\n`, { mode: 0o600 });
    console.log(text);
  } else if (values.rehearse) {
    process.exit(await rehearse(frozen, task));
  } else if (values.live) {
    if (!isDigest(values.approved ?? "")) {
      console.error("--live takes --approved <digest>: the 64 lowercase hexadecimal characters --plan printed.");
      process.exit(2);
    }
    process.exit(await live(frozen, task, values.approved!));
  }
}
