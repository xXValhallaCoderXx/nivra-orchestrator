// NIV-35's live run of a real task through the packaged Linux app (D41, NIV-55): a project's environment prepared in
// Nebius from its own recipe, a
// real repository task worked by Nemotron through Token Factory, its checks run in Nebius Sandboxes, its change approved
// and accepted by the person. Never part of `pnpm verify`. Run from WSL, in apps/desktop:
//
//   node scripts/task-live.ts --check                   what a plan binds but the build, from the task file and
//                                                       its checkout; no network, nothing written, no --state
//   node scripts/task-live.ts --state S --freeze        the release candidate's unpacked Linux build, copied to a
//                                                       folder of its own with its hashes; the checkout and its
//                                                       brief checked
//   node scripts/task-live.ts --state S --plan          prints the recipe and its digest, for approval; no network
//   node scripts/task-live.ts --state S --rehearse      the journey on the frozen build with fake keys, to each
//                                                       preview
//   node scripts/task-live.ts --state S --live --approved D
//                                                       the approved run: one preparation and one task run, then
//                                                       the person's decisions; its log is printed
//   node scripts/task-live.ts --state S --cleanup       opens the last live profile, removes its keys, checks it
//
// --state is required by every mode that writes, which is every mode but --check: the frozen build, the recipes, the
// rehearsals and the runs go there (NIV-55). It can't be candidate 3's frozen take, ~/nivra-acceptance/task-live, or
// inside it. Approvals are claimed in one folder for every state folder, ~/nivra-acceptance/claims/task-live, so one
// approval is one run wherever it runs.
//
// The task is the brief file's (default ~/nivra-work/she65/task-live.json, outside the repository): the repository and
// its baseline, the person's choices for its environment (none: {}), and the brief with its cases, baseline selections
// and frozen files. A file may instead expect its preparation to stop (`expect.preparation`, a stop's code and step,
// such as an install that fails), with no brief: the recipe names the stop, the run passes only on exactly that stop,
// and no task is created. Nothing here names a repository. The keys are pasted into Settings by the person: this
// script never reads or prints them. Nothing is sent before the approval is claimed, and then only by pressing Prepare
// and Start, once each.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EnvironmentChoices, EnvironmentStopCode, TASK_MODEL, TaskBrief, taskBriefDigest, type PreparedEnvironmentV2 } from "@nivra/domain";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { claimApproval, claimOn, isDigest } from "../../engine/scripts/research-check/claim.ts";
import { environmentResolutionOf } from "../../engine/src/environment/preview.ts";
import { ENVIRONMENT_STOP_MESSAGES } from "../../engine/src/environment/report.ts";
import { createLocalBackend } from "../../engine/src/exec/local.ts";
import { RETENTION } from "../../engine/src/exec/nebius/sandbox.ts";
import { compressSnapshot } from "../../engine/src/exec/nebius/session.ts";
import { findGit } from "../../engine/src/exec/find-executable.ts";
import { takeSnapshot } from "../../engine/src/exec/snapshot.ts";
import { runLimitsFor } from "../../engine/src/task/limits.ts";
import type { BriefFields, ProjectView, SettingsView, TaskRunPreview } from "../src/shared/ipc.ts";
import { addProject, attemptOf, createTask, environmentOf, followRun, keysSaved, prepareOnce, previewEnvironment, previewRun, startOnce, taskOf } from "./task-journey.ts";
import { buildChanges, buildHashes, liveFolders, previewProblems, stopProblems, type BuildHashes, type ExpectedStop } from "./task-live-checks.ts";
import { RELEASE_HOME_STATE, releaseHomeChange } from "./test-homes.ts";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(desktop, "..", "..");

// ---- the command line ---------------------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    freeze: { type: "boolean", default: false },
    plan: { type: "boolean", default: false },
    rehearse: { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    approved: { type: "string" },
    state: { type: "string" },
    task: { type: "string", default: join(homedir(), "nivra-work", "she65", "task-live.json") },
  },
  allowPositionals: false,
});
const modes = (["check", "freeze", "plan", "rehearse", "live", "cleanup"] as const).filter((mode) => values[mode]);
if (modes.length !== 1) {
  console.error("Choose one of --check, or with --state <folder> one of --freeze, --plan, --rehearse, --live --approved <digest> or --cleanup.");
  process.exit(2);
}
// --check reads the task and its checkout and writes nothing, so it takes no state folder; every other mode writes there.
let folders: ReturnType<typeof liveFolders> | null = null;
if (!values.check) {
  try {
    folders = liveFolders(values.state, homedir(), repository);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
} else if (values.state !== undefined) {
  console.error("--check reads the task and its checkout and writes nothing, so it takes no --state.");
  process.exit(2);
}
const STATE = folders?.state ?? "";
const CLAIMS = folders?.claims ?? "";

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
  /** The person's choices for the project's own recipe (NIV-55): none is {}, the project's declarations as they are. */
  environment: EnvironmentChoices;
  task: { title: string };
  /** The brief of the task the run works; none for a run whose preparation is expected to stop. */
  brief?: TaskBrief;
  /** What the person checks in the proposal before deciding, beyond what the tests can show; in the recipe. */
  review?: string[];
  /** The stop the preparation is expected to end with (NIV-55), such as an install that fails; then no task is created. */
  expect?: { preparation: ExpectedStop };
}

/** A task file's task run: its brief, which a run that expects its preparation to stop doesn't have. */
const briefOf = (task: LiveTask): TaskBrief => {
  if (!task.brief) throw new Error("This run expects its preparation to stop, so it has no task to brief.");
  return task.brief;
};

function readTask(path: string): LiveTask {
  const given = JSON.parse(readFileSync(path, "utf8")) as LiveTask;
  if (given.expect !== undefined) {
    const stop = given.expect?.preparation;
    if (!stop || !EnvironmentStopCode.safeParse(stop.code).success || typeof stop.step !== "string" || stop.step.length === 0 || stop.step.length > 64) throw new Error(`${path}'s expect names the stop its preparation should end with, such as { "preparation": { "code": "install", "step": "install" } }.`);
    if (given.brief !== undefined || given.review !== undefined) throw new Error(`${path} expects its preparation to stop, so no task is created: it takes no brief and no review points.`);
  }
  const brief = given.expect ? null : TaskBrief.safeParse(given.brief);
  if (brief && !brief.success) throw new Error(`The brief in ${path} isn't one Nivra takes: ${brief.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (!/^[0-9a-f]{40}$/.test(given.baseline)) throw new Error(`${path} names no baseline commit.`);
  if (given.review !== undefined && !(Array.isArray(given.review) && given.review.length <= 10 && given.review.every((point) => typeof point === "string" && point.length > 0 && point.length <= 600))) throw new Error(`${path}'s review is a list of at most 10 points, each a line of text.`);
  const choices = EnvironmentChoices.safeParse(given.environment ?? {});
  if (!choices.success) throw new Error(`${path}'s environment is the person's choices for the project's own recipe, such as {} or { "runtime": "24.21.0" }; packages chosen as D41's filters are no longer taken.`);
  return { ...given, environment: choices.data, ...(brief ? { brief: brief.data } : {}) };
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

const frozenPath = () => join(STATE, "freeze.json");
function readFrozen(): Frozen {
  if (!existsSync(frozenPath())) throw new Error(`Nothing is frozen in ${STATE} yet: run this script with --freeze and this --state.`);
  return JSON.parse(readFileSync(frozenPath(), "utf8")) as Frozen;
}

/** The frozen build, every file hashed again (`buildHashes`), as it was frozen. */
function checkBuild(frozen: Frozen): void {
  const changed = buildChanges(frozen, buildHashes(frozen.folder));
  if (changed.length) throw new Error(`The frozen build changed since it was frozen (${changed.join(", ")}). Freeze it again, and ask for a new approval.`);
}

/**
 * This script, from the revision its build was frozen from, with no changes: what the recipe says of the build, the
 * model's rule among it, is this source's, so it has to be the build's too.
 */
function checkSource(frozen: Frozen): void {
  const head = git(repository, "rev-parse", "HEAD");
  const changed = git(repository, "status", "--porcelain") !== "";
  if (head !== frozen.revision || changed) throw new Error(`This script runs from the revision its build was frozen from, ${frozen.revision.slice(0, 12)}, with no changes; this checkout is at ${head.slice(0, 12)}${changed ? ", with changes" : ""}. Check that revision out here, or freeze again, then try again.`);
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
  writeFileSync(frozenPath(), `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 });
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
    // As the app's engine resolves it for a project with no environment yet: the choices, and nothing kept from before.
    const environment = await environmentResolutionOf(snapshot, task.environment, null);
    if (environment.status === "refused") throw new Error(`The project's environment can't be prepared (${environment.code}): ${environment.message}`);
    if (environment.status === "needs-choice") throw new Error(`The project's environment needs a choice in the task's file: ${environment.choices.map((choice) => choice.message).join(" ")}`);
    const { recipe } = environment;
    const frozen = (task.brief?.frozen ?? []).map((path) => {
      const file = snapshot.files.find((entry) => entry.path === path);
      if (!file) throw new Error(`The brief freezes ${path}, which the baseline doesn't hold.`);
      return { path, sha256: file.sha256 };
    });
    return {
      snapshot: { fingerprint: snapshot.fingerprint, files: snapshot.files.length, sentBytes: compressSnapshot(snapshot.archive.archive).byteLength, leftOut: snapshot.leftOut.secret.sample },
      environment: {
        fingerprint: environment.fingerprint,
        recipeDigest: environment.recipeDigest,
        configuration: recipe.configuration.digest,
        files: recipe.configuration.files.length,
        sentBytes: environment.sentBytes,
        image: recipe.image.tag,
        bootstrap: recipe.bootstrap.map((step) => `${step.tool} ${step.version} (${step.via})`),
        install: [recipe.install.tool, ...recipe.install.args].join(" "),
        options: recipe.install.options,
        builds: recipe.builds.runs,
        hosts: recipe.network.hosts,
        leftOut: environment.leftOut,
        limits: recipe.limits,
        warnings: environment.warnings.map((warning) => `${warning.code}: ${warning.message}`),
      },
      frozen,
    };
  } finally {
    await local.close();
  }
}

/** What one approval covers, as data: its digest binds every field. `run` numbers the approvals of one recipe. */
export async function recipeOf(frozen: Frozen, task: LiveTask, run = 1) {
  const shown = await bound(task);
  const expected = task.expect?.preparation ?? null;
  return {
    kind: "nivra.task-live.v3",
    run,
    route: "the frozen Linux build, unpacked, with a profile and an engine home of its own",
    revision: frozen.revision,
    build: { version: frozen.version, nivraSha256: frozen.nivraSha256, appAsarSha256: frozen.appAsarSha256, runtimeContentHash: frozen.runtimeContentHash, runtimeSha256: frozen.runtimeSha256, treeSha256: frozen.treeSha256, treeFiles: frozen.treeFiles, debSha256: frozen.debSha256 },
    repository: { path: task.repository, baseline: task.baseline, ...shown.snapshot },
    environment: { choices: task.environment, ...shown.environment },
    ...(expected ? expectedStopRecipe(expected) : await taskRecipe(task, shown)),
  };
}

/** A preparation expected to stop (NIV-55): the stop, by code and step, and only the preparation's own steps and requests. */
function expectedStopRecipe(expected: ExpectedStop) {
  return {
    expect: { preparation: { code: expected.code, step: expected.step, words: ENVIRONMENT_STOP_MESSAGES[expected.code] } },
    task: null,
    limits: null,
    model: null,
    steps: [
      "the script launches the frozen build with a profile and an engine home of its own; Nate pastes the Nebius key and project id into Settings, and the script waits until both are saved",
      "the script adds the repository as a project, and allows its uploads through their own dialog",
      `the script previews the environment, the project's own recipe, and checks its fingerprint is the one above, claims the approval, and presses Prepare once; the run passes only if the preparation stops at ${expected.code} (step ${expected.step}), in Nivra's words for that stop${expected.code === "install" ? ", with the end of the install's log and Nivra's guidance kept" : ""}, and keeps no environment. Any other ending, a success included, is a failure`,
      "no task is created or started",
      "the script removes the keys through Settings' own calls and checks they are gone, closes the app, and checks that ~/.nivra and ~/.nivra-dev are unchanged",
    ],
    requests: ["Nebius: the image listing; an import of the image if the project has none; one inspect of it with networking off; one upload of the setup files; one preparation with networking on, and a readiness check with networking off only if the install got that far"],
    keeps: { nebius: `${RETENTION} Nebius keeps each operation's arguments in its records.`, tokenFactory: "Nothing is sent to Token Factory." },
    review: [] as string[],
    never: ["a second Prepare", "a task created or started", "a retry or a retake", "a push, a PR or a ticket closed", "any command run on this machine against the repository"],
    failure: "Whatever the preparation gives is recorded as it is; only the expected stop passes. No retake under this approval; another run needs another approval.",
  };
}

/** A preparation, then one task run worked by the model, as NIV-35's live run is. */
async function taskRecipe(task: LiveTask, shown: Awaited<ReturnType<typeof bound>>) {
  const brief = briefOf(task);
  return {
    expect: null,
    task: { title: task.task.title, briefDigest: await taskBriefDigest(brief), cases: brief.acceptanceCases.map((given) => given.name), checks: brief.checks, baseline: (brief.baseline ?? []).map((given) => given.name), frozen: shown.frozen },
    limits: runLimitsFor(brief.acceptanceCases.length + brief.checks.length, brief.baseline?.length ?? 0),
    model: {
      required: TASK_MODEL,
      rule: "The run uses this model and no other: the engine takes it from Token Factory's listing, or stops the run at its model step, before any request to a model and before the commit is uploaded. The preparation comes first, so it has run by then.",
    },
    steps: [
      "the script launches the frozen build with a profile and an engine home of its own; Nate pastes the Nebius key and project id into Settings, and the script waits until both are saved",
      "the script adds the repository as a project, and allows its model sharing and its uploads, each through its own dialog",
      "the script previews the environment, the project's own recipe, and checks its fingerprint is the one above, claims the approval, and presses Prepare once; the environment must end prepared with every dependency build run, or nothing more is started under this approval",
      "once it is prepared, the script creates the task with the brief above, marks it ready, and previews the run. It checks the preview is bound to this brief's digest, this commit's snapshot and the environment just prepared (the fingerprint Start sends, which the app checks again), shows the frozen files above with their hashes, and names the model above in the app's own words, then presses Start once",
      "Nate reads the proposal and its checks, with the review points below, and decides: Approve and then Accept, Reject, or a revision (which this approval doesn't run)",
      "on Nate's go-ahead, the script removes the keys through Settings' own calls and checks they are gone, closes the app, and checks that ~/.nivra and ~/.nivra-dev are unchanged",
    ],
    requests: [
      `Nebius: the image listing; an import of ${shown.environment.image} if the project has none; one inspect of it with networking off; one upload of the setup files (${shown.environment.sentBytes} bytes); one preparation with networking on; one readiness check with networking off`,
      `Nebius: one upload of the commit (${shown.snapshot.sentBytes} bytes compressed); at most ${runLimitsFor(brief.acceptanceCases.length + brief.checks.length, brief.baseline?.length ?? 0).operations} operations with networking off, and cleanup's cancels`,
      "Token Factory: one model listing; at most the run's model requests, each with the brief, the files the worker reads, the lines its searches find and the output of what it runs",
    ],
    keeps: { nebius: `${RETENTION} Nebius keeps each operation's arguments in its records, so what the worker writes stays there too.`, tokenFactory: "Token Factory keeps what it receives, under its own terms. What was sent can't be withdrawn." },
    review: task.review ?? [],
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
    `${recipe.expect ? "A live preparation expected to stop" : "A live task run"} on Linux, run ${recipe.run} of this recipe.`,
    "",
    `Revision ${recipe.revision}; Nivra ${recipe.build.version}: nivra ${recipe.build.nivraSha256}, app.asar ${recipe.build.appAsarSha256}, runtime ${recipe.build.runtimeContentHash} (files ${recipe.build.runtimeSha256}), every file of the build ${recipe.build.treeSha256} (${recipe.build.treeFiles}), deb ${recipe.build.debSha256}`,
    `Route: ${recipe.route}`,
    `Repository: ${recipe.repository.path} at ${recipe.repository.baseline}; ${recipe.repository.files} files, ${recipe.repository.sentBytes} bytes compressed; left out: ${recipe.repository.leftOut.join(", ") || "none"}; snapshot ${recipe.repository.fingerprint}`,
    `Environment: the project's own recipe ${recipe.environment.recipeDigest}, with ${JSON.stringify(recipe.environment.choices)}: ${recipe.environment.image}; ${recipe.environment.bootstrap.join(", ") || "nothing to bootstrap"}; ${recipe.environment.install}${Object.keys(recipe.environment.options).length ? ` with ${JSON.stringify(recipe.environment.options)}` : ""}; builds: ${recipe.environment.builds}; ${recipe.environment.files} setup files (${recipe.environment.configuration}), ${recipe.environment.sentBytes} bytes; never sent: ${recipe.environment.leftOut.join(", ") || "nothing"}; preview ${recipe.environment.fingerprint}`,
    `  Networking on for the preparation only, to ${recipe.environment.hosts.join(", ")}; every check and task run offline.`,
    ...(recipe.environment.warnings.length ? ["  The resolution's warnings:", ...recipe.environment.warnings.map((warning) => `    ${warning}`)] : ["  The resolution gave no warnings."]),
    ...(recipe.expect
      ? [
          `Expected: the preparation stops at ${recipe.expect.preparation.code} (step ${recipe.expect.preparation.step}), in Nivra's words "${recipe.expect.preparation.words}"${recipe.expect.preparation.code === "install" ? ", with the end of the install's log and Nivra's guidance kept" : ""}, and keeps no environment. No task is created. Any other ending, a success included, fails this run.`,
          `Limits: preparation ${recipe.environment.limits.importSeconds} s to import, ${recipe.environment.limits.prepareSeconds} s to install, ${recipe.environment.limits.probeSeconds} s for each check before and after`,
          "Model: none; no task is run.",
        ]
      : [
          `Task "${recipe.task.title}", brief ${recipe.task.briefDigest}:`,
          ...recipe.task.cases.map((name, index) => `  case ${index + 1}: ${name}`),
          ...recipe.task.checks.map((check, index) => `  check ${index + 1}: ${check}`),
          ...recipe.task.baseline.map((name, index) => `  baseline ${index + 1}: ${name}`),
          ...recipe.task.frozen.map((file) => `  frozen: ${file.sha256}  ${file.path}`),
          `Limits: ${JSON.stringify(recipe.limits)}; preparation ${recipe.environment.limits.importSeconds} s to import, ${recipe.environment.limits.prepareSeconds} s to install, ${recipe.environment.limits.probeSeconds} s for each check before and after`,
          `Model: ${recipe.model.required} only. ${recipe.model.rule}`,
        ]),
    "Steps:",
    ...recipe.steps.map((step) => `  - ${step}`),
    ...(recipe.review.length ? ["Before deciding, check in the proposal (what its tests can't show):", ...recipe.review.map((point) => `  - ${point}`)] : []),
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

/**
 * What --check prints (NIV-55): everything a plan binds that isn't the build, worked out from the task file and its
 * checkout with no network, so the task and its environment can be read before a build is frozen. Nothing is written.
 */
async function checkText(task: LiveTask): Promise<string> {
  const shown = await bound(task);
  const brief = task.brief ?? null;
  return [
    `Checked offline, with no build bound: ${task.repository} at ${task.baseline}; ${shown.snapshot.files} files, ${shown.snapshot.sentBytes} bytes compressed; left out: ${shown.snapshot.leftOut.join(", ") || "none"}; snapshot ${shown.snapshot.fingerprint}`,
    `Environment: the project's own recipe ${shown.environment.recipeDigest}, with ${JSON.stringify(task.environment)}: ${shown.environment.image}; ${shown.environment.bootstrap.join(", ") || "nothing to bootstrap"}; ${shown.environment.install}; builds: ${shown.environment.builds}; ${shown.environment.files} setup files (${shown.environment.configuration}), ${shown.environment.sentBytes} bytes; preview ${shown.environment.fingerprint}; hosts ${shown.environment.hosts.join(", ")}`,
    ...(shown.environment.warnings.length ? ["  The resolution's warnings:", ...shown.environment.warnings.map((warning) => `    ${warning}`)] : ["  The resolution gave no warnings."]),
    ...(task.expect
      ? [`Expected: the preparation stops at ${task.expect.preparation.code} (step ${task.expect.preparation.step}), in Nivra's words "${ENVIRONMENT_STOP_MESSAGES[task.expect.preparation.code]}"; no task is created.`]
      : brief
        ? [
            `Task "${task.task.title}", brief ${await taskBriefDigest(brief)}:`,
            ...brief.acceptanceCases.map((given, index) => `  case ${index + 1}: ${given.name}: ${given.command}`),
            ...brief.checks.map((check, index) => `  check ${index + 1}: ${check}`),
            ...(brief.baseline ?? []).map((given, index) => `  baseline ${index + 1}: ${given.name}: ${given.command}`),
            ...shown.frozen.map((file) => `  frozen: ${file.sha256}  ${file.path}`),
            ...(task.review ?? []).map((point) => `  review: ${point}`),
          ]
        : []),
    "No build is bound yet: --plan, after --freeze, adds the frozen build and prints the digest to approve. Nothing was written or sent.",
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

/**
 * The window as it stands, kept as privately as the rest of the evidence. One that fails is logged and the run goes on:
 * a picture is never a reason to stop a run whose approval is claimed. Settings never shows a saved key or project id,
 * so no picture can hold one.
 */
async function shot(page: Page, folder: string, name: string, log: (line: string) => void): Promise<void> {
  try {
    await page.screenshot({ path: join(folder, name), timeout: 15_000 });
    chmodSync(join(folder, name), 0o600);
  } catch (error) {
    log(`The screenshot ${name} wasn't kept: ${error instanceof Error ? error.message : String(error)}`);
  }
}
/** Removes the Nebius key and project id, through the calls Settings' own buttons make, and checks they are gone. */
async function removeKeys(page: Page): Promise<void> {
  await call(page, "window.nivra.setNebiusKey(null)");
  await call(page, "window.nivra.setNebiusProjectId(null)");
  const settings = await call<SettingsView>(page, "window.nivra.getSettings()");
  if (settings.nebiusKey !== "none" || settings.nebiusProjectId !== "none") throw new Error("A key is still saved in the profile: remove it in Settings.");
}

const fieldsOf = (task: LiveTask): BriefFields => ({ ...briefOf(task), assumptions: [] });

/** Why the run the window would start isn't the recipe's (`previewProblems`), read from the app as it stands. */
async function runPreviewProblems(page: Page, recipe: Awaited<ReturnType<typeof recipeOf>>, ids: { taskId: string; projectId: string }, prepared: PreparedEnvironmentV2 | null, shownExpected: string): Promise<string[]> {
  if (recipe.expect) return ["the recipe expects its preparation to stop, so it has no task run"];
  const view = await taskOf(page, ids.taskId);
  const project = (await call<ProjectView[]>(page, "window.nivra.listProjects()")).find((one) => one.id === ids.projectId);
  if (!project) return ["the project isn't in the app"];
  const structured = await call<TaskRunPreview>(page, `window.nivra.previewTaskRun(${JSON.stringify(ids.taskId)})`);
  return previewProblems({
    approved: { baseline: recipe.repository.baseline, snapshotFingerprint: recipe.repository.fingerprint, briefDigest: recipe.task.briefDigest, frozen: recipe.task.frozen, configuration: recipe.environment.configuration },
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
    log(`Environment preview: ${shown.recipe.configuration.files.length} setup files, ${shown.sentBytes} bytes, ${[shown.recipe.install.tool, ...shown.recipe.install.args].join(" ")} on ${shown.recipe.image.tag}; the recipe's fingerprint.`);
    await shot(page, folder, "1-environment-preview.png", log);
    if (task.expect) {
      log(`The recipe expects the preparation to stop at ${task.expect.preparation.code}: no task is created, so the rehearsal ends here.`);
      writeFileSync(join(folder, "rehearsal.json"), `${JSON.stringify({ recipe: digest, environment: shown }, null, 2)}\n`, { mode: 0o600 });
      await removeKeys(page);
      return finishRehearsal();
    }
    const taskId = await createTask(page, { title: task.task.title, fields: fieldsOf(task), projectId, planId: null });
    const run = await previewRun(page);
    log(`Run preview: ${run.baseline}; frozen ${run.frozen.length}; ${run.limits.slice(0, 160)}`);
    // The live run's check, with no environment prepared: the fingerprints worked out here must be the app's.
    const problems = await runPreviewProblems(page, recipe, { taskId, projectId }, null, run.expected);
    if (problems.length) throw new Error(`The rehearsal's run preview isn't the recipe's: ${problems.join("; ")}.`);
    log("Run preview: bound to the recipe's brief digest and snapshot, with its frozen files and their hashes.");
    await shot(page, folder, "2-run-preview.png", log);
    const brief = (await taskOf(page, taskId)).brief;
    writeFileSync(join(folder, "rehearsal.json"), `${JSON.stringify({ recipe: digest, environment: shown, run, briefVersion: brief.version }, null, 2)}\n`, { mode: 0o600 });
    await removeKeys(page);
  } finally {
    await app.close();
  }
  return finishRehearsal();

  function finishRehearsal(): number {
    const after = homesAfter(homes);
    for (const line of after.lines) log(line);
    return after.unchanged ? 0 : 1;
  }
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
    if (task.expect) {
      const problems = stopProblems(task.expect.preparation, environment);
      const stopped = environment.preparation?.report?.stopped ?? null;
      log(`The preparation ended ${environment.preparation?.status ?? "unknown"}${stopped ? `, stopped at ${stopped.code} (step ${stopped.step ?? "none"}): ${stopped.message}${stopped.detail ? ` ${stopped.detail}` : ""}` : ""}.`);
      save("expected-stop.json", { expected: task.expect.preparation, problems, stopped, install: environment.preparation?.report?.install ?? null });
      log(problems.length ? `It isn't the expected stop: ${problems.join("; ")}.` : `It is the expected stop, ${task.expect.preparation.code} at ${task.expect.preparation.step}: Nivra's words, the install's log and its guidance kept, and no environment kept. No task is created.`);
      await shot(page, folder, "1-environment-stopped.png", log);
      return finish(problems.length ? 1 : 0);
    }
    if (recipe.expect) throw new Error("The recipe expects its preparation to stop, but its task file doesn't. Nothing more is started.");
    if (!environment.prepared || environment.preparation?.status !== "answered") {
      log(`The preparation ended ${environment.preparation?.status ?? "unknown"}: ${environment.preparation?.report?.stopped?.message ?? environment.preparation?.note ?? ""}. No task run is started under this approval.`);
      return finish(1);
    }
    if (!environment.ready) {
      const builds = environment.prepared.verified.builds;
      log(`The environment was prepared, but ${builds.state === "missing" ? `these dependency builds didn't run: ${builds.missing.join(", ")}` : "Nivra couldn't tell which dependency builds ran"}. Accepting it without them isn't part of this approval, so no task run is started under it.`);
      return finish(1);
    }
    log(`Prepared: ${environment.prepared.verified.tools.map((tool) => `${tool.name} ${tool.version}`).join(", ")}, ${environment.prepared.verified.platform.release}, image ${environment.prepared.verified.images.prepared}; builds ${environment.prepared.verified.builds.state}.`);
    await shot(page, folder, "1-environment-prepared.png", log);
    const taskId = await createTask(page, { title: task.task.title, fields: fieldsOf(task), projectId, planId: null });
    const run = await previewRun(page);
    save("run-preview.json", run);
    const problems = await runPreviewProblems(page, recipe, { taskId, projectId }, environment.prepared, run.expected);
    if (problems.length) throw new Error(`The run's preview isn't the approved one: ${problems.join("; ")}. Start wasn't pressed.`);
    log("The run's preview is the approved one: this brief, this commit's snapshot, the environment just prepared and the frozen files. Pressing Start, once.");
    await shot(page, folder, "2-run-preview.png", log);
    const attemptId = await startOnce(page, taskId);
    // Followed past the run's own deadline, so only the engine's limits end it, never this wait.
    const ended = await followRun(page, taskId, attemptId, (recipe.limits.runMinutes + 10) * 60_000, log);
    save("attempt.json", ended);
    await shot(page, folder, "3-run-ended.png", log);
    const used = ended.report?.route?.model ?? null;
    log(used === null ? "The report names no model." : `The report names the model ${used}${used.toLowerCase() === TASK_MODEL.toLowerCase() ? ", the approved one" : `, not the approved ${TASK_MODEL}`}.`);
    log(`The run ended ${ended.status}${ended.report ? `: ${ended.report.outcome}${ended.report.verified ? ", verified" : ""}` : ""}. The decisions are yours, in the window: Approve and then Accept, Reject, or a revision. Create ${join(folder, "go-close")} when you're done.`);
    for (;;) {
      if (existsSync(join(folder, "go-close"))) break;
      await page.waitForTimeout(5_000);
    }
    await shot(page, folder, "4-final.png", log);
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

// ---- the run ------------------------------------------------------------------------------------------------------

if (values.check) {
  const task = readTask(values.task!);
  checkCheckout(task);
  console.log(await checkText(task));
  process.exit(0);
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
  checkSource(frozen);
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
