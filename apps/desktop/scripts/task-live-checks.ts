// What task-live.ts checks before it trusts a frozen build or presses Start (NIV-35), apart from its command line so
// tests can run them: the folders a run may write, the build's files hashed again (never taken from its manifest), a
// run's preview compared field by field with what the recipe approved, and a preparation's ending against the stop a
// recipe expects (NIV-55).
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TASK_MODEL, type EnvironmentStopCode, type PreparedEnvironmentV2 } from "@nivra/domain";
import { ENVIRONMENT_STOP_MESSAGES } from "../../engine/src/environment/report.ts";
import type { EnvironmentView, TaskRunPreview } from "../src/shared/ipc.ts";
import { environmentRefOf } from "../src/main/host.ts";
import { taskRunFingerprint } from "../src/main/tasks.ts";
import { filesIn, hashRuntime } from "./runtime-files.ts";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A frozen build's identity, every part read from its files. */
export interface BuildHashes {
  nivraSha256: string;
  appAsarSha256: string;
  /** The runtime's files, hashed as staging names them (`hashRuntime`), and its manifest's own bytes. */
  runtimeContentHash: string;
  runtimeSha256: string;
  runtimeManifestSha256: string;
  /** Every file of the unpacked build, by path and content, and how many. */
  treeSha256: string;
  treeFiles: number;
}

/**
 * The unpacked Linux build's hashes. The runtime's are worked out from its files, and a manifest that names other
 * files than the ones there is refused: a manifest can be right while a file isn't.
 */
export function buildHashes(folder: string): BuildHashes {
  const runtime = join(folder, "resources", "runtime", "linux-x64");
  const manifestPath = join(runtime, "engine", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256?: unknown; files?: unknown };
  const contents = hashRuntime(runtime);
  if (contents.sha256 !== manifest.sha256 || contents.files !== manifest.files) throw new Error(`The build's runtime files hash to ${contents.contentHash} (${contents.files} files), not what its manifest names.`);
  const tree = createHash("sha256");
  const paths = filesIn(folder).map((path) => path.slice(folder.length + 1)).sort();
  for (const path of paths) {
    const bytes = readFileSync(join(folder, path));
    tree.update(`${path}\0${bytes.length}\0`);
    tree.update(bytes);
  }
  return {
    nivraSha256: sha256(join(folder, "nivra")),
    appAsarSha256: sha256(join(folder, "resources", "app.asar")),
    runtimeContentHash: contents.contentHash,
    runtimeSha256: contents.sha256,
    runtimeManifestSha256: sha256(manifestPath),
    treeSha256: tree.digest("hex"),
    treeFiles: paths.length,
  };
}

const BUILD_KEYS: ReadonlyArray<keyof BuildHashes> = ["nivraSha256", "appAsarSha256", "runtimeContentHash", "runtimeSha256", "runtimeManifestSha256", "treeSha256", "treeFiles"];

/** The parts of a frozen build that changed since it was frozen, by name; none when it is as it was. */
export function buildChanges(frozen: BuildHashes, now: BuildHashes): string[] {
  return BUILD_KEYS.filter((key) => frozen[key] !== now[key]);
}

/** What a recipe approved that a run's preview must show. */
export interface ApprovedRun {
  work?: { workingRequests: number };
  baseline: string;
  snapshotFingerprint: string;
  briefDigest: string;
  frozen: Array<{ path: string; sha256: string }>;
  /** The environment's setup files, as the recipe bound them by their digest (NIV-55); null for a run with no environment. */
  configuration: string | null;
}

/**
 * Why a run's preview isn't the approved one; none when it is. The window's preview (`shownExpected`, what Start sends)
 * and the app's structured preview must both carry the fingerprint worked out here from the approved brief digest and
 * snapshot, with the task, the project and the environment just prepared, which the host checks again at Start. The
 * structured preview must show the approved commit, snapshot, frozen files with their hashes, and environment, and
 * name the one model the recipe allows: a build from before that rule names none, and its run would take whichever
 * model the listing offered.
 */
export function previewProblems(input: {
  approved: ApprovedRun;
  ids: { taskId: string; briefId: string; briefVersion: number; projectId: string; targetId: string };
  /** The recipe's environment just prepared, as the app's view holds it; null for a run with none. */
  prepared: PreparedEnvironmentV2 | null;
  shownExpected: string;
  structured: Pick<TaskRunPreview, "expected" | "snapshotFingerprint" | "snapshot" | "frozen" | "environment" | "sends"> & Partial<Pick<TaskRunPreview, "preferencesDigest" | "choicesDigest" | "referencesDigest" | "references" | "work" | "cases" | "checks" | "baseline">>;
}): string[] {
  const { approved, ids, prepared, structured } = input;
  // What the host binds a run from it to (fingerprint v3): its own ref for this target, worked out here again.
  const environment = prepared ? environmentRefOf(prepared, null, ids.targetId) : null;
  const context = structured.preferencesDigest && structured.choicesDigest ? { preferencesDigest: structured.preferencesDigest, choicesDigest: structured.choicesDigest } : {};
  const requiredChecks = structured.cases && structured.checks && structured.baseline ? { finalChecks: structured.cases.length + structured.checks.length, baselineChecks: structured.baseline.length, comparisonChecks: structured.checks.length } : undefined;
  const expected = taskRunFingerprint({ ...ids, ...context, work: approved.work, policyVersion: null, referencesDigest: structured.referencesDigest, requiredChecks, briefDigest: approved.briefDigest, sharing: { modelContext: true, cloudExecution: true }, snapshot: approved.snapshotFingerprint, environment });
  const problems: string[] = [];
  if (approved.work && structured.work?.workingRequests !== approved.work.workingRequests) problems.push("the working request maximum differs from the approved allowance");
  if (structured.references && (structured.references.comments.length || structured.references.attachments.length || structured.references.summaries.length)) problems.push("the run includes task context absent from the approved recipe");
  if (input.shownExpected !== expected) problems.push("the window's preview isn't bound to the approved brief, commit and environment");
  if (structured.expected !== expected) problems.push("the app's preview isn't bound to the approved brief, commit and environment");
  if (structured.snapshotFingerprint !== approved.snapshotFingerprint) problems.push(`the snapshot is ${String(structured.snapshotFingerprint)}, not the approved ${approved.snapshotFingerprint}`);
  if (structured.snapshot?.baseline !== approved.baseline) problems.push(`the commit is ${String(structured.snapshot?.baseline)}, not the approved ${approved.baseline}`);
  const frozen = structured.frozen.map((file) => `${file.sha256}  ${file.path}`).join("\n");
  if (frozen !== approved.frozen.map((file) => `${file.sha256}  ${file.path}`).join("\n")) problems.push("the frozen files or their hashes aren't the approved ones");
  if (prepared === null ? structured.environment !== null : structured.environment?.image !== prepared.verified.images.prepared || structured.environment.verified !== prepared.verifiedDigest) problems.push("the run doesn't start from the environment just prepared");
  if (structured.environment && structured.environment.configuration !== approved.configuration) problems.push("the environment's setup files aren't the approved ones");
  if (!structured.sends.tokenFactory.some((line) => line.includes(TASK_MODEL))) problems.push(`the app's preview doesn't name ${TASK_MODEL}, the one model the recipe allows`);
  return problems;
}

// ---- the folders a run writes (NIV-55) ----------------------------------------------------------------------------

/** A path with its links followed as far as it exists, so a link can't lead into a folder it mustn't. */
const real = (path: string) => {
  let existing = path;
  while (!existsSync(existing) && resolve(existing, "..") !== existing) existing = resolve(existing, "..");
  return join(realpathSync.native(existing), relative(existing, path));
};
const within = (path: string, root: string) => {
  const rel = relative(real(root), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Where a live run keeps its state (its frozen build, recipes, rehearsals and runs), given with --state and required
 * for every mode that writes; and where its approvals are claimed, one folder for every state folder, so an approval
 * claimed under one can't run again under another. The state folder may neither be nor hold candidate 3's frozen take,
 * ~/nivra-acceptance/task-live, the claims, or any of Nivra's checkouts (`checkouts`: this one and every worktree of
 * its repository, candidate 3's among them).
 */
export function liveFolders(given: string | undefined, home: string, checkouts: readonly string[]): { state: string; claims: string } {
  const claims = join(home, "nivra-acceptance", "claims", "task-live");
  const instead = join(home, "nivra-acceptance", "niv55-live");
  if (!given) throw new Error(`--state <folder> is required: the folder this run's frozen build, recipes and evidence go to, such as ${instead}.`);
  const state = resolve(given);
  const take = join(home, "nivra-acceptance", "task-live");
  if (within(state, take) || within(take, state)) throw new Error(`${state} would write into candidate 3's frozen take, ${take}, which nothing may change. Give a state folder of its own, such as ${instead}.`);
  if (within(state, join(home, "nivra-acceptance", "claims")) || within(claims, state)) throw new Error(`${state} would hold or sit in the approvals' claims, ${claims}, which only claiming writes. Give a state folder of its own, such as ${instead}.`);
  const checkout = checkouts.find((root) => within(state, root) || within(root, state));
  if (checkout !== undefined) throw new Error(`${state} would put a run's evidence in one of Nivra's checkouts, ${checkout}. Give a state folder outside every checkout, such as ${instead}.`);
  return { state, claims };
}

// ---- a preparation expected to stop (NIV-55) ---------------------------------------------------------------------

/**
 * The stop a recipe expects a preparation to end with: its code and step, and Nivra's guidance for that failure exactly
 * (an install's diagnosis, such as the lockfile not matching package.json), or null when the stop gives none. Named in
 * the recipe, so its digest covers them.
 */
export interface ExpectedStop {
  code: EnvironmentStopCode;
  step: string;
  detail: string | null;
}

/**
 * Why a preparation's ending isn't exactly the stop the recipe expected; none when it is. Only that stop passes: its
 * code and step, Nivra's words for the code, the expected guidance word for word, and no environment kept; an
 * install's stop also keeps the end of its log. Any other ending, a success or another failure of the same step
 * included, is a failure.
 */
export function stopProblems(expected: ExpectedStop, view: Pick<EnvironmentView, "prepared" | "preparation">): string[] {
  const report = view.preparation?.report ?? null;
  const problems: string[] = [];
  if (view.prepared !== null || report?.environment || report?.prepared) problems.push("an environment was kept");
  if (report === null) return [...problems, `the preparation ended ${view.preparation?.status ?? "without starting"}, with no report`];
  if (report.outcome === "prepared") problems.push("the preparation succeeded");
  const stopped = report.stopped;
  if (!stopped) return [...problems, `the preparation ended ${report.outcome} without a stop`];
  if (stopped.code !== expected.code || stopped.step !== expected.step) problems.push(`it stopped at ${stopped.code} (step ${stopped.step ?? "none"}), not the expected ${expected.code} (step ${expected.step})`);
  if (stopped.message !== ENVIRONMENT_STOP_MESSAGES[expected.code]) problems.push(`its words aren't Nivra's for the ${expected.code} stop`);
  if ((stopped.detail ?? null) !== expected.detail) problems.push(`its guidance is ${JSON.stringify(stopped.detail ?? null)}, not the expected ${JSON.stringify(expected.detail)}`);
  if (expected.code === "install" && !report.install?.logTail) problems.push("the end of the install's log wasn't kept");
  return problems;
}

// ---- the app, closed before the homes are read ----------------------------------------------------------------

/**
 * Runs `body` with an app already started, closes the app whatever `body` does, and only then runs `after`: what
 * `after` reads (the protected homes) is read with the app and its engine shut down, however `body` ended.
 */
export async function closedThen<A, T>(app: A, close: (app: A) => Promise<void>, body: (app: A) => Promise<void>, after: () => T): Promise<T> {
  try {
    await body(app);
  } finally {
    await close(app);
  }
  return after();
}

/** A private file can supply Settings' existing named calls; its values never enter a recipe or a log. */
export function readLiveCredentials(path: string, repository: string): { key: string; project: string } {
  const file = realpathSync.native(path);
  const location = relative(realpathSync.native(repository), file);
  if (location === "" || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`))) throw new Error("Keep live credentials outside the repository.");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Use a regular credential file owned by you with mode 0600, at most 16 KiB.");
    const values = new Map<string, string>();
    for (const line of readFileSync(descriptor, "utf8").split(/\r?\n/)) {
      const match = /^(?:export\s+)?(NEBIUS_API_KEY|NEBIUS_PROJECT_ID)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const raw = match[2]!.trim();
      values.set(match[1]!, /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw);
    }
    const key = values.get("NEBIUS_API_KEY"), project = values.get("NEBIUS_PROJECT_ID");
    if (!key || !project || key.includes("\0") || project.includes("\0")) throw new Error("The private file needs NEBIUS_API_KEY and NEBIUS_PROJECT_ID. No values were printed.");
    return { key, project };
  } finally { closeSync(descriptor); }
}
