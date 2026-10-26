import { createHash } from "node:crypto";
import { PATCH_SHOWN_BYTES, StoredTaskInput, type Mask, type RunRoute, type TaskBrief, type TaskPreview, type TaskProposal, type TaskReport, type TaskStopCode } from "@nivra/domain";
import { previewOf, safeUnresolved, stepOf } from "../exec/check.ts";
import type { PrescribedResult } from "../exec/prescribed.ts";
import type { Proposal } from "../exec/proposal.ts";
import type { Snapshot } from "../exec/snapshot.ts";
import { programsOf } from "./harness.ts";
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
  toolchain:
    "The sandbox image doesn't have a program the brief's cases or checks need, so the run stopped before the worker started: your commit was uploaded to Nebius, and Token Factory got nothing. Nothing was installed, and nothing ran on your computer. The checks below say which program is missing.",
  time: "The run's time ran out before a sandbox could be opened, so nothing was sent. Run the task again.",
  "model-sharing": "This project doesn't allow sending its content to Token Factory, and the worker reads its files there, so nothing was sent. Allow sharing for it, then run the task again.",
  brief: "This run's brief isn't the version it was started for, so nothing was sent. Run the task again.",
  model: "Token Factory couldn't be reached, or offered no model Nivra can use, so the run stopped before anything from your repository was sent. Check the key in Settings, then run the task again.",
  "native-windows": "Running tasks on Windows itself isn't available yet, so nothing was sent. Add the repository from a WSL distribution, then run the task there.",
};

/** Where a run stops before anything is uploaded: its own checks, the model's choice, the snapshot, and a session refused before sending. */
const BEFORE_UPLOAD = new Set(["check", "prepare", "run", "snapshot", "open"]);

/** Words for a stop once the commit was uploaded, for codes whose own words say nothing was sent. */
const AFTER_UPLOAD: Partial<Record<TaskStopCode, string>> = {
  git: "Git failed while Nivra checked what came back from the sandbox, so nothing was proposed. Your commit was uploaded, and what Nebius keeps is listed with the run. Run the task again; if it keeps happening, report it with the engine log.",
  limit: "What came back from the sandbox is larger than Nivra proposes at once, so nothing was proposed. Your commit was uploaded, and what Nebius keeps is listed with the run.",
};
const AFTER_UPLOAD_ANY = "The run stopped after your commit was uploaded, so nothing was proposed. What Nebius keeps is listed with the run.";

/** A stop's words, by its code and where it happened: only a stop before the upload says nothing was sent. */
export function taskStopWords(code: TaskStopCode, step: string | null): string {
  const words = TASK_STOP_MESSAGES[code];
  if (step === null || BEFORE_UPLOAD.has(step) || !words.includes("nothing was sent")) return words;
  return AFTER_UPLOAD[code] ?? AFTER_UPLOAD_ANY;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const clip = (text: string, max: number) => (text.length > max ? text.slice(-max) : text);

/** What a run is bound to, as its report repeats it. */
export type TaskBound = TaskReport["task"];

/**
 * A run's report from what the worker and the prescribed path gave. The stop's words are chosen by its code and where
 * it happened. A change is verified only when there is one and every acceptance case passed in the final checks.
 */
export function taskReport(input: { result: PrescribedResult; core: TaskReportCore | null; task: TaskBound; request: TaskReport["request"]; route: RunRoute | null; now: Date }): TaskReport {
  const { result, core } = input;
  const { cleanup } = result;
  return {
    outcome: result.outcome,
    stopped: result.stopped ? { code: result.stopped.code, step: result.stopped.step === null ? null : result.stopped.step.slice(0, 64), message: taskStopWords(result.stopped.code, result.stopped.step) } : null,
    task: input.task,
    snapshot: result.snapshot,
    toolchain: core?.toolchain ?? [],
    worker: core
      ? {
          ...core.worker,
          summary: core.worker.summary === null ? null : core.worker.summary.slice(0, 2_000),
          failure: (core.worker.failure as NonNullable<TaskReport["worker"]>["failure"]) ?? null,
          written: core.worker.written.slice(0, 32),
        }
      : null,
    checks: (core?.checks ?? []).map((check) => ({ ...check, name: check.name.slice(0, 1_000), reason: check.reason === null ? null : check.reason.slice(0, 600), stdoutTail: clip(check.stdoutTail, 4_000), stderrTail: clip(check.stderrTail, 4_000), changedFiles: check.changedFiles.slice(0, 20) })),
    verified: result.outcome === "proposed" && core?.verified === true,
    steps: result.steps.slice(0, 24).map(stepOf),
    proposal: result.proposal ? { hash: result.proposal.hash, patchSha256: sha256(result.proposal.patch), patchBytes: result.proposal.patch.byteLength, files: result.proposal.binding.paths.length } : null,
    reportSha256: result.report ? sha256(result.report) : null,
    cleanup: cleanup ? { stopped: cleanup.stopped.length, alreadyEnded: cleanup.alreadyEnded.length, unresolved: cleanup.unresolved.slice(0, 50).map(safeUnresolved), retained: cleanup.retained } : null,
    route: input.route,
    request: input.request,
    updatedAt: input.now.toISOString(),
    finishedAt: input.now.toISOString(),
  };
}

/** A report for a run that stopped before the prescribed path ran, or one still going, in the same shape. */
export function earlyTaskReport(input: { outcome: TaskReport["outcome"]; code: TaskStopCode | null; step: string | null; task: TaskBound; request: TaskReport["request"]; route: RunRoute | null; now: Date; finished: boolean }): TaskReport {
  return {
    outcome: input.outcome,
    stopped: input.code ? { code: input.code, step: input.step, message: taskStopWords(input.code, input.step) } : null,
    task: input.task,
    snapshot: null,
    toolchain: [],
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

/** What a run of this brief on this snapshot would send to Nebius, and the bounds it runs under. Its fingerprint is the snapshot's. */
export function taskPreviewOf(snapshot: Snapshot, brief: Pick<TaskBrief, "acceptanceCases" | "checks">): TaskPreview {
  const { status: _ready, ...shown } = previewOf(snapshot) as Extract<ReturnType<typeof previewOf>, { status: "ready" }>;
  const commands = [...brief.acceptanceCases.map((given) => given.command), ...brief.checks];
  return { status: "ready", snapshot: shown, programs: programsOf(commands), unprobed: commands.filter((command) => firstWord(command) === null).length, limits: runLimitsFor(commands.length) };
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
