import { createHash } from "node:crypto";
import { PATCH_SHOWN_BYTES, StoredTaskInput, TASK_MODEL, type Mask, type RunRoute, type TaskBrief, type TaskCheck, type TaskEnvironment, type TaskPreview, type TaskProposal, type TaskReport, type TaskRunLimits, type TaskWork, type TaskStopCode } from "@nivra/domain";
import { previewOf, safeUnresolved, stepOf } from "../exec/check.ts";
import type { PrescribedResult } from "../exec/prescribed.ts";
import type { Proposal } from "../exec/proposal.ts";
import type { Snapshot } from "../exec/snapshot.ts";
import { commandFiles, programsOf } from "./harness.ts";
import { runLimitsFor } from "./limits.ts";
import { firstWord } from "./scripts.ts";
import type { TaskReportCore } from "./worker.ts";

/**
 * A task run's report and its stops (NIV-7, D39). What a person reads about a stopped run is chosen by its code and by
 * where it stopped (D29): Nivra's own words, never a path, git's words, the service's or the model's. Only a stop before
 * the upload may say nothing was sent. What the worker said is kept apart from what Nivra checked.
 */

/** A run's input as the engine reads it back from its store, masked, so only its shape is checked; null when it can't be read. */
export function readTaskInput(input: unknown): StoredTaskInput | null {
  const parsed = StoredTaskInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Each stop's words, in Nivra's terms and with what to do: never anything the stop's error said. */
export const TASK_STOP_MESSAGES: Readonly<Record<TaskStopCode, string>> = {
  git: "Git couldn't be run on this checkout, so nothing was sent. Make sure git is installed there, and run `git status` to see what's wrong, then run the task again.",
  "git-version": "The git on this target is too old for a task run, so nothing was sent. Install git 2.18 or later, then run the task again.",
  repository: "Nivra can't read this repository safely, so nothing was sent. Preview the run to see why, then run the task again.",
  "no-commits": "This repository has no commits yet, so there is nothing to work on. Commit your work, then run the task again.",
  "baseline-moved": "The checkout moved to another commit while the run was starting, so nothing was sent. Run the task again.",
  uncommitted: "The checkout has uncommitted changes, and a task works from a commit, so nothing was sent. Commit or stash them, then run the task again.",
  "engine-home": "This folder is inside Nivra's own data, so nothing was sent. Add the repository itself as the project.",
  path: "A path in this commit can't be sent or written safely, so nothing was sent. Preview the run to see which, rename it, then run the task again.",
  content:
    "A file in this commit holds what looks like a credential, so Nivra didn't upload it. Preview the run to see which, remove it from the commit (and replace the credential if it's real), then run the task again.",
  "nothing-to-send": "Every committed file in this folder is left out, so there is nothing to work on. Preview the run to see what's left out.",
  limit: "This commit is larger than Nivra sends to a sandbox, so nothing was sent. Preview the run to see its size.",
  collect: "The sandbox's result couldn't be collected, so the run stopped and nothing was proposed. Run the task again; if it keeps happening, report it with the engine log.",
  result: "What came back from the sandbox isn't the commit plus the writes Nivra checked, so it was refused and nothing was proposed.",
  change: "The change that came back is one Nivra won't propose, so nothing was proposed.",
  patch: "The change that came back couldn't be checked, so nothing was proposed.",
  proposal: "The change couldn't be bound to this project, so nothing was proposed.",
  boundary: "Nebius Sandboxes can't give this run what it needs, files kept apart and networking off, so nothing was sent.",
  "sandbox-refused": "Nebius Sandboxes wouldn't run part of the task, so the run stopped and nothing was proposed. Check the key and project id in Settings, then run the task again.",
  "sandbox-failed": "Nebius Sandboxes couldn't run part of the task, so the run stopped and nothing was proposed. Run the task again later; what Nebius keeps is listed with the run.",
  uncertain: "It isn't known whether part of the run started in the sandbox, so it was never sent again, and nothing was proposed. Anything still open is listed with the run, for you to follow up.",
  cancelled: "Cancelled.",
  "edit-failed": "The sandbox didn't keep a write the worker made, so the run stopped: nothing more ran on a workspace whose state wasn't known, and nothing was proposed.",
  fault: "Something inside Nivra failed during the run, so nothing was proposed. Try again; if it keeps happening, report it with the engine log.",
  consent: "This project doesn't allow uploading its commit to Nebius Sandboxes, so nothing was sent. Allow uploads for it, then run the task again.",
  credentials: "A task run needs your Nebius key and project id, and they aren't both set, so nothing was sent. Add them in Settings, then run the task again.",
  preview: "What would be sent changed since you previewed the run, so nothing was sent. Preview it again.",
  "context-mismatch": "The run's preferences or choices do not match its approved context, so nothing was sent. Preview it again, then start a new run.",
  "context-credentials": "A preference or choice holds a credential, so nothing was sent. Remove it, preview the run again, then start.",
  toolchain:
    "The sandbox image doesn't have a program the brief's cases or checks need, so the run stopped before the worker started: your commit was uploaded to Nebius, and nothing from your repository went to Token Factory. Nothing was installed, and nothing ran on your computer. The checks below say which program is missing.",
  time: "The run's time ran out before a sandbox could be opened, so nothing was sent. Run the task again.",
  "model-sharing": "This project doesn't allow sending its content to Token Factory, and the worker reads its files there, so nothing was sent. Allow sharing for it, then run the task again.",
  brief: "This run's brief isn't the version it was started for, so nothing was sent. Run the task again.",
  model: `Token Factory couldn't be reached, or doesn't offer this key ${TASK_MODEL}, the only model task runs use, so the run stopped before anything from your repository was sent. Check the key in Settings, then run the task again.`,
  "native-windows": "Running tasks on Windows itself isn't available yet, so nothing was sent. Add the repository from a WSL distribution, then run the task there.",
  baseline:
    "The brief's baseline selections didn't give what it expects on the commit as it is, so the run stopped before the worker started: your commit was uploaded to Nebius, and nothing from your repository went to Token Factory. The baseline below says which selection differed, and how.",
  environment:
    "This project's environment doesn't fit this run, so nothing was sent: it was prepared from other setup files, in another Nebius project or for another target, or the commit tracks files in a folder the environment leaves out. Preview the run to see which, then prepare the environment again and run the task.",
  frozen: "The brief freezes a file this commit doesn't have, so nothing was sent. Preview the run to see which, correct the brief, then run the task again.",
  "environment-missing":
    "The project's prepared environment is no longer in your Nebius project, so the run stopped and nothing was proposed. Your commit was uploaded, and what Nebius keeps is listed with the run. Prepare the environment again, then run the task again.",
};

/**
 * Where a run stops before anything is uploaded: its own checks, the model's choice, its start before the prescribed
 * path, the snapshot, and a session refused before sending. The worker's own runs of a case or check (`run`) come
 * after the upload.
 */
const BEFORE_UPLOAD = new Set(["check", "prepare", "start", "snapshot", "open"]);

/** Words for a stop once the commit was uploaded, for codes whose own words say nothing was sent. */
const AFTER_UPLOAD: Partial<Record<TaskStopCode, string>> = {
  git: "Git failed while Nivra checked what came back from the sandbox, so nothing was proposed. Your commit was uploaded, and what Nebius keeps is listed with the run. Run the task again; if it keeps happening, report it with the engine log.",
  limit: "What came back from the sandbox is larger than Nivra proposes at once, so nothing was proposed. Your commit was uploaded, and what Nebius keeps is listed with the run.",
};
const AFTER_UPLOAD_ANY = "The run stopped after your commit was uploaded, so nothing was proposed. What Nebius keeps is listed with the run.";

/** A stop's words, by its code and where it happened: only a stop before the upload says nothing was sent. */
export function taskStopWords(code: TaskStopCode, step: string | null): string {
  if (code === "time" && step === "before check") return "There wasn't time left for every before-change repository check, so the worker didn't start and nothing was proposed. Run the task again. Your commit was uploaded; what Nebius keeps is listed with the run.";
  const words = TASK_STOP_MESSAGES[code];
  if (step === null || BEFORE_UPLOAD.has(step) || !words.includes("nothing was sent")) return words;
  return AFTER_UPLOAD[code] ?? AFTER_UPLOAD_ANY;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * What a report may take of the store's 256,000 bytes (`MAX_ARTIFACT_BYTES`), with room to spare: a report that
 * couldn't be stored would leave a run that proposed a change reading as if it had failed.
 */
export const REPORT_BYTES = 200_000;

/**
 * Text as a report keeps it: masked first, as the store masks it, so storing it changes nothing; control characters
 * other than tabs and line breaks, and lone surrogates, made U+FFFD, so none costs six bytes as JSON; then cut to
 * `max` characters, keeping the start, or the end for a tail.
 */
export function kept(text: string, max: number, mask: Mask, end: "start" | "end" = "start"): string {
  const clean = mask(text)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "\uFFFD");
  return clean.length <= max ? clean : whole(end === "end" ? clean.slice(-max) : clean.slice(0, max));
}

/** Text cut between the halves of a character outside the BMP: the half left at either end is dropped. */
const whole = (text: string): string => text.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");

/** What a run is bound to, as its report repeats it. */
export type TaskBound = TaskReport["task"];

/**
 * A run's report from what the worker and the prescribed path gave. The stop's words are chosen by its code and where
 * it happened. Verification needs a change, complete passing final cases and required checks, and integrity evidence.
 * Every text is masked, then cut to the protocol's bounds, and the whole is fitted under `REPORT_BYTES`.
 */
export function taskReport(input: { result: PrescribedResult; core: TaskReportCore | null; task: TaskBound; request: TaskReport["request"]; route: RunRoute | null; limits?: TaskRunLimits | null; now: Date; mask: Mask }): TaskReport {
  const { result, core, mask } = input;
  const { cleanup } = result;
  const shownCheck = (check: TaskCheck): TaskCheck => ({
    ...check,
    name: kept(check.name, 1_000, mask),
    reason: check.reason === null ? null : kept(check.reason, 600, mask),
    stdoutTail: kept(check.stdoutTail, 4_000, mask, "end"),
    stderrTail: kept(check.stderrTail, 4_000, mask, "end"),
    difference: check.difference && { line: check.difference.line, expected: kept(check.difference.expected, 200, mask), got: kept(check.difference.got, 200, mask) },
    changedFiles: check.changedFiles.slice(0, 20).map((path) => kept(path, 1_024, mask)),
  });
  const report: TaskReport = {
    ...(core ? { version: 4, manifest: core.manifest, beforeChecks: core.beforeChecks.map(shownCheck) } : {}),
    outcome: result.outcome,
    stopped: result.stopped ? { code: result.stopped.code, step: result.stopped.step === null ? null : kept(result.stopped.step, 64, mask), message: taskStopWords(result.stopped.code, result.stopped.step) } : null,
    task: input.task,
    snapshot: result.snapshot,
    toolchain: (core?.toolchain ?? []).map((tool) => ({ program: kept(tool.program, 128, mask), finding: tool.finding })),
    environment: core?.environment ?? null,
    environmentRef: core?.environmentRef ?? null,
    setup: core?.setup ? { unchanged: core.setup.unchanged, changed: core.setup.changed.slice(0, 20).map((path) => kept(path, 1_024, mask)) } : null,
    limits: input.limits ?? null,
    baseline: (core?.baselineChecks ?? []).map((check) => ({ ...check, name: kept(check.name, 200, mask), reason: check.reason === null ? null : kept(check.reason, 600, mask), stdoutTail: kept(check.stdoutTail, 4_000, mask, "end"), stderrTail: kept(check.stderrTail, 4_000, mask, "end") })),
    frozen: (core?.frozen ?? []).map((file) => ({ path: kept(file.path, 1_024, mask), unchanged: file.unchanged })),
    worker: core
      ? {
          ...core.worker,
          stopDetail: core.worker.stopDetail ? kept(core.worker.stopDetail, 600, mask) : null,
          summary: core.worker.summary === null ? null : kept(core.worker.summary, 2_000, mask),
          failure: (core.worker.failure as NonNullable<TaskReport["worker"]>["failure"]) ?? null,
          model: kept(core.worker.model, 200, mask),
          written: core.worker.written.slice(0, 32).map((path) => kept(path, 1_024, mask)),
        }
      : null,
    checks: (core?.checks ?? []).map(shownCheck),
    verified: result.outcome === "proposed" && core?.verified === true,
    steps: result.steps.slice(0, 24).map((step) => {
      const shown = stepOf(step);
      return { ...shown, label: kept(shown.label, 64, mask), signal: shown.signal === null ? null : kept(shown.signal, 32, mask), status: shown.status === null ? null : kept(shown.status, 32, mask), stdoutTail: kept(shown.stdoutTail, 1_000, mask, "end"), stderrTail: kept(shown.stderrTail, 1_000, mask, "end") };
    }),
    proposal: result.proposal ? { hash: result.proposal.hash, patchSha256: sha256(result.proposal.patch), patchBytes: result.proposal.patch.byteLength, files: result.proposal.binding.paths.length } : null,
    reportSha256: result.report ? sha256(result.report) : null,
    cleanup: cleanup ? { stopped: cleanup.stopped.length, alreadyEnded: cleanup.alreadyEnded.length, unresolved: cleanup.unresolved.slice(0, 50).map((item) => kept(safeUnresolved(item), 400, mask)), retained: cleanup.retained && { ...cleanup.retained, note: kept(cleanup.retained.note, 1_000, mask) } } : null,
    route: input.route,
    request: input.request,
    updatedAt: input.now.toISOString(),
    finishedAt: input.now.toISOString(),
  };
  return fitted(report);
}

/** The report with its output tails cut shorter, halving them, until it fits in `REPORT_BYTES`. */
export function fitted(report: TaskReport): TaskReport {
  const size = (value: TaskReport) => Buffer.byteLength(JSON.stringify(value));
  let current = report;
  for (let room = 2_000; size(current) > REPORT_BYTES && room >= 32; room = Math.floor(room / 2)) {
    const cut = (text: string, max: number) => (text.length > max ? whole(text.slice(-max)) : text);
    current = {
      ...current,
      ...(current.beforeChecks ? { beforeChecks: current.beforeChecks.map((check) => ({ ...check, stdoutTail: cut(check.stdoutTail, room), stderrTail: cut(check.stderrTail, room) })) } : {}),
      checks: current.checks.map((check) => ({ ...check, stdoutTail: cut(check.stdoutTail, room), stderrTail: cut(check.stderrTail, room) })),
      baseline: current.baseline.map((check) => ({ ...check, stdoutTail: cut(check.stdoutTail, room), stderrTail: cut(check.stderrTail, room) })),
      steps: current.steps.map((step) => ({ ...step, stdoutTail: cut(step.stdoutTail, room / 4), stderrTail: cut(step.stderrTail, room / 4) })),
    };
  }
  return current;
}

/** A report for a run that stopped before the prescribed path ran, or one still going, in the same shape. */
export function earlyTaskReport(input: { outcome: TaskReport["outcome"]; code: TaskStopCode | null; step: string | null; task: TaskBound; request: TaskReport["request"]; route: RunRoute | null; limits?: TaskRunLimits | null; now: Date; finished: boolean }): TaskReport {
  return {
    outcome: input.outcome,
    stopped: input.code ? { code: input.code, step: input.step, message: taskStopWords(input.code, input.step) } : null,
    task: input.task,
    snapshot: null,
    toolchain: [],
    environment: null,
    limits: input.limits ?? null,
    baseline: [],
    frozen: [],
    worker: null,
    checks: [],
    verified: false,
    steps: [],
    proposal: null,
    reportSha256: null,
    cleanup: null,
    route: input.route,
    request: input.request,
    updatedAt: input.now.toISOString(),
    finishedAt: input.finished ? input.now.toISOString() : null,
  };
}

/**
 * A brief's frozen files as this commit holds them (D41); null, with the first one it doesn't hold, when the commit
 * lacks one: such a run is refused before anything is sent.
 */
export function frozenIn(snapshot: Pick<Snapshot, "files">, paths: readonly string[]): { files: Array<{ path: string; sha256: string }> } | { missing: string } {
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const files: Array<{ path: string; sha256: string }> = [];
  for (const path of paths) {
    const file = byPath.get(path);
    if (!file || file.kind !== "file") return { missing: path };
    files.push({ path, sha256: file.sha256 });
  }
  return { files };
}

/**
 * What a run of this brief on this snapshot would send to Nebius, and the bounds it runs under. Its fingerprint is the
 * snapshot's. With an environment (D41), the caller has checked it against the commit's manifests.
 */
export function taskPreviewOf(snapshot: Snapshot, brief: Pick<TaskBrief, "acceptanceCases" | "checks" | "baseline" | "frozen">, environment: (TaskEnvironment & { preparedAt: string }) | null = null, work?: TaskWork): TaskPreview {
  const { status: _ready, ...shown } = previewOf(snapshot) as Extract<ReturnType<typeof previewOf>, { status: "ready" }>;
  const commands = [...brief.acceptanceCases.map((given) => given.command), ...brief.checks];
  const paths = new Set(snapshot.files.map((file) => file.path));
  // A name past the protocol's bound is shortened, never left out: the warning is what matters.
  const named = (path: string) => (path.length > 1_024 ? `${path.slice(0, 1_023)}\u2026` : path);
  // Each case that names a file of the commit, or whose command Nivra can't read for sure.
  const caseFiles = brief.acceptanceCases
    .map((given, index) => {
      const said = commandFiles(given.command, paths);
      return { number: index + 1, files: said.files.slice(0, 20).map(named), unclear: said.unclear };
    })
    .filter((one) => one.files.length > 0 || one.unclear);
  const frozen = frozenIn(snapshot, brief.frozen ?? []);
  if ("missing" in frozen) return { status: "refused", code: "frozen", message: `The brief freezes ${frozen.missing.length > 300 ? `${frozen.missing.slice(0, 299)}\u2026` : frozen.missing}, which this commit doesn't hold as a file. Correct the brief, or commit the file, then preview the run again.` };
  return { status: "ready", snapshot: shown, programs: programsOf(commands), unprobed: commands.filter((command) => firstWord(command) === null).length, caseFiles, environment, frozen: frozen.files, limits: runLimitsFor(commands.length, brief.baseline?.length ?? 0, brief.checks.length, work) };
}

/**
 * A proposal as the person reads it: its hash, what it applies to, every path it changes, and the patch as text, cut
 * at `PATCH_SHOWN_BYTES` and masked. The stored bytes stay exact.
 */
export function proposalView(proposal: Proposal, mask: Mask): TaskProposal {
  const { binding } = proposal;
  const truncated = proposal.patch.byteLength > PATCH_SHOWN_BYTES;
  const text = new TextDecoder().decode(truncated ? proposal.patch.subarray(0, PATCH_SHOWN_BYTES) : proposal.patch);
  return {
    hash: proposal.hash,
    baseline: binding.baseline,
    prefix: binding.destination.prefix,
    paths: binding.paths.slice(0, 500).map((bound) => ({ path: bound.path, change: bound.change, before: bound.before, after: bound.after })),
    patch: mask(text),
    patchBytes: proposal.patch.byteLength,
    truncated,
  };
}

/** Whether any of a proposal's bytes, or its binding, holds one of `values`: such a proposal is never kept (D39). */
export function holdsValue(proposal: Proposal, values: readonly string[]): boolean {
  const parts = [proposal.patch, proposal.report, proposal.postImage, new TextEncoder().encode(JSON.stringify(proposal.binding))].map((bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return values.filter((value) => value.length > 0).some((value) => parts.some((part) => part.includes(Buffer.from(value, "utf8"))));
}
