import { createHash } from "node:crypto";
import { PREVIEW_SAMPLE, StoredSandboxInput, type SandboxPreview, type SandboxReport, type SandboxStep, type SandboxStopCode } from "@nivra/domain";
import { RETENTION } from "./nebius/sandbox.ts";
import type { PrescribedResult, PrescribedStep, PrescribedStopCode } from "./prescribed.ts";
import type { Counted, Snapshot } from "./snapshot.ts";

/**
 * The sandbox check (NIV-44, D36): the prescribed path (D35) on a project's own commit, with one recipe the engine
 * owns. The snapshot is uploaded and prepared, and its digest matched. One read-only probe runs, its changes thrown
 * away. The workspace is collected, and the bound report made. Nothing runs that the renderer chose, no model is
 * involved, and nothing comes back to the checkout: the probe keeps nothing, so a check proposes nothing.
 *
 * What a person reads about a stopped check is chosen by its code (D29): Nivra's own words, never a path, git's words
 * or the service's. A preview, which is shown to the person and never stored, can name the file a refusal is about.
 */

/** A check's input as the engine reads it back from its store, masked, so only its shape is checked; null when it can't be read. */
export function readSandboxTask(input: unknown): StoredSandboxInput | null {
  const parsed = StoredSandboxInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** The public image every check starts from: the one D28's runs and B3's check used. */
export const CHECK_IMAGE = { tag: "alpine:3.20", uuid: "befe20f2-5c2c-3027-9961-314b5f218ea4" } as const;

/** A check's bounds: the session's work, closing's own time, and the probe's command. */
export const CHECK_LIMITS = { budgetMs: 10 * 60_000, closeBudgetMs: 7 * 60_000, stepTimeoutMs: 60_000, maxOperations: 8 } as const;

/**
 * The probe: what the workspace holds and which busybox runs it, for the person to see that the sandbox has the
 * commit. $1 is the workspace, $2 what runs the tools (busybox; empty for this machine's own). It writes nothing.
 */
export const PROBE_SCRIPT = [
  'bb="$2"',
  'cd "$1" || exit 1',
  'echo "busybox: $($bb 2>&1 | $bb head -n 1)"',
  'echo "files: $($bb find . -type f | $bb wc -l)"',
  'echo "links: $($bb find . -type l | $bb wc -l)"',
].join("\n");

/** The check's one step. A check keeps nothing, so its changes are thrown away. */
export function checkRecipe(workspace = "/workspace", applets = "/bin/busybox"): PrescribedStep[] {
  return [{ label: "probe", argv: ["/bin/sh", "-c", PROBE_SCRIPT, "nivra-probe", workspace, applets], timeoutMs: CHECK_LIMITS.stepTimeoutMs, maxOutputBytes: 4_096, keeps: false }];
}

const sampled = (counted: Counted) => ({ count: counted.count, sample: counted.sample.slice(0, PREVIEW_SAMPLE) });

/** What a check of this snapshot would send, for the person to see first. Its fingerprint is the snapshot's. */
export function previewOf(snapshot: Snapshot): SandboxPreview {
  return {
    status: "ready",
    baseline: snapshot.baseline,
    prefix: snapshot.prefix,
    files: snapshot.files.length,
    bytes: snapshot.archive.archive.byteLength,
    leftOut: {
      secret: sampled(snapshot.leftOut.secret),
      output: sampled(snapshot.leftOut.output),
      submodule: sampled(snapshot.leftOut.submodule),
      excluded: sampled(snapshot.leftOut.excluded),
    },
    untracked: sampled(snapshot.untracked),
    lfsPointers: snapshot.lfsPointers.count,
    fingerprint: snapshot.fingerprint,
    retention: RETENTION,
  };
}

/** Each stop's words, in Nivra's own terms and with what to do: never anything the stop's error said. */
export const STOP_MESSAGES: Readonly<Record<SandboxStopCode, string>> = {
  git: "Git couldn't be run on this checkout, so nothing was sent. Make sure git is installed there, and run `git status` to see what's wrong, then check again.",
  "git-version": "The git on this target is too old for a sandbox check, so nothing was sent. Install git 2.18 or later, then check again.",
  repository: "Nivra can't read this repository safely, so nothing was sent. Preview the check to see why, then check again.",
  "no-commits": "This repository has no commits yet, so there is nothing to send. Commit your work, then check again.",
  "baseline-moved": "The checkout moved to another commit while the check was starting, so nothing was sent. Check again.",
  uncommitted: "The checkout has uncommitted changes, and a check works from a commit, so nothing was sent. Commit or stash them, then check again.",
  "engine-home": "This folder is inside Nivra's own data, so nothing was sent. Add the repository itself as the project.",
  path: "A path in this commit can't be sent or written safely, so nothing was sent. Preview the check to see which, rename it, then check again.",
  content:
    "A file in this commit holds what looks like a credential, so Nivra didn't upload it. Preview the check to see which, remove it from the commit (and replace the credential if it's real), then check again.",
  "nothing-to-send": "Every committed file in this folder is left out, so there is nothing to send. Preview the check to see what's left out.",
  limit: "This commit is larger than Nivra sends to a sandbox, so nothing was sent. Preview the check to see its size.",
  collect: "The sandbox's result couldn't be collected, so the check stopped. Check again; if it keeps happening, report it with the engine log.",
  result: "What came back from the sandbox isn't what it held, so it was refused. Check again; if it keeps happening, report it with the engine log.",
  change: "What came back held a change Nivra won't take, so it was refused and nothing was proposed.",
  patch: "The change that came back couldn't be checked, so nothing was proposed.",
  proposal: "What came back couldn't be bound to this project, so nothing was proposed.",
  boundary: "Nebius Sandboxes can't give this check what it needs, files kept apart and networking off, so nothing was sent.",
  "sandbox-refused": "Nebius Sandboxes wouldn't run the check, so it stopped. Check the key and project id in Settings, then check again.",
  "sandbox-failed": "Nebius Sandboxes couldn't run part of the check, so it stopped. Check again later; what Nebius keeps is listed with the check.",
  uncertain: "It isn't known whether part of the check started, so it was never sent again. Anything still open is listed with the check, for you to follow up.",
  cancelled: "Cancelled.",
  "edit-failed": "A step of the check failed, so it stopped.",
  fault: "Something inside Nivra failed during the check. Try again; if it keeps happening, report it with the engine log.",
  consent: "This project doesn't allow uploading its commit to Nebius Sandboxes, so nothing was sent. Allow uploads for it, then check again.",
  credentials: "Nebius Sandboxes needs your key and project id, and they aren't both set, so nothing was sent. Add them in Settings, then check again.",
  preview: "What would be sent changed since you previewed it, so nothing was sent. Preview the check again.",
};

/** Where a check stops before anything is uploaded: its own checks, the snapshot, and a session refused before sending. */
const BEFORE_UPLOAD = new Set(["check", "run", "snapshot", "open"]);

/**
 * Words for a stop once the commit was uploaded, for codes whose own words say nothing was sent: git and the size limit
 * check what comes back too. Any other such code gets the general words.
 */
const AFTER_UPLOAD: Partial<Record<SandboxStopCode, string>> = {
  git: "Git failed while Nivra checked what came back from the sandbox, so nothing was proposed. Your commit was uploaded, and what Nebius keeps is listed with the check. Check again; if it keeps happening, report it with the engine log.",
  limit: "What came back from the sandbox is larger than Nivra proposes at once, so nothing was proposed. Your commit was uploaded, and what Nebius keeps is listed with the check.",
};
const AFTER_UPLOAD_ANY = "The check stopped after your commit was uploaded, so nothing was proposed. What Nebius keeps is listed with the check.";

/** A stop's words, by its code and where it happened: only a stop before the upload says nothing was sent. */
export function stopWords(code: SandboxStopCode, step: string | null): string {
  const words = STOP_MESSAGES[code];
  if (step === null || BEFORE_UPLOAD.has(step) || !words.includes("nothing was sent")) return words;
  return AFTER_UPLOAD[code] ?? AFTER_UPLOAD_ANY;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** The words cleanup and recovery use for what stays open: their own templates, filled with labels and ids only. */
const UNRESOLVED_WORDS = [
  /^It isn't known whether "[a-z][a-z -]{0,63}" started \(correlation [0-9a-f-]{36}\); it may still be running\.$/,
  /^Operation [A-Za-z0-9._:-]{1,128} wasn't seen to end; it may still be running\.$/,
  /^Not looked at in this pass: it (ran out of time|was stopped)\. It stays for the next\.$/,
  /^It isn't known whether an image import started, and Nivra can't look for one: any image it made is in your Nebius project\.$/,
];

/**
 * An item cleanup or recovery couldn't settle, as it may leave the engine (D29): one of their own templates, or fixed
 * words for anything else, which can carry an error's own text or a journal's path.
 */
export function safeUnresolved(item: string): string {
  return UNRESOLVED_WORDS.some((words) => words.test(item)) ? item : "Something Nivra started in a sandbox couldn't be settled, and may still be running. It stays journaled, for the next recovery pass.";
}

/** A stop's code as a check reports it: a code only a task's run gives can't happen here, and reads as a fault. */
export const sandboxCode = (code: PrescribedStopCode): SandboxStopCode => (code === "toolchain" || code === "time" || code === "baseline" || code === "environment" || code === "frozen" || code === "environment-missing" ? "fault" : code);

/** A step's record as a report gives it: what it did, its provider's status and usage, and the end of its output. */
export function stepOf(step: PrescribedResult["steps"][number]): SandboxStep {
  return {
    label: clip(step.label, 64),
    exitCode: step.exitCode,
    signal: step.signal === null ? null : clip(step.signal, 32),
    timedOut: step.timedOut,
    cancelled: step.cancelled,
    truncated: step.truncated,
    persisted: step.persisted,
    durationMs: step.durationMs,
    status: step.status === null ? null : clip(step.status, 32),
    usage: step.usage ?? null,
    stdoutTail: clip(step.stdoutTail, 2_000),
    stderrTail: clip(step.stderrTail, 2_000),
  };
}

/**
 * A check's report from what the prescribed path gave. The stop's words are chosen by its code and where it happened;
 * cleanup's record says what was stopped, what stays open, and what Nebius keeps.
 */
export function checkReport(input: { result: PrescribedResult; request: SandboxReport["request"]; now: Date }): SandboxReport {
  const { result } = input;
  const { cleanup } = result;
  return {
    outcome: result.outcome,
    stopped: result.stopped ? { code: sandboxCode(result.stopped.code), step: result.stopped.step === null ? null : clip(result.stopped.step, 64), message: stopWords(sandboxCode(result.stopped.code), result.stopped.step) } : null,
    snapshot: result.snapshot,
    steps: result.steps.slice(0, 16).map(stepOf),
    reportSha256: result.report ? sha256(result.report) : null,
    proposal: result.proposal ? { hash: result.proposal.hash, patchSha256: sha256(result.proposal.patch), patchBytes: result.proposal.patch.byteLength } : null,
    cleanup: cleanup
      ? {
          stopped: cleanup.stopped.length,
          alreadyEnded: cleanup.alreadyEnded.length,
          unresolved: cleanup.unresolved.slice(0, 50).map(safeUnresolved),
          retained: cleanup.retained,
        }
      : null,
    request: input.request,
    updatedAt: input.now.toISOString(),
    finishedAt: input.now.toISOString(),
  };
}

/** A report for a check that stopped before the prescribed path ran, or one still going, in the same shape. */
export function earlyReport(input: { outcome: SandboxReport["outcome"]; code: SandboxStopCode | null; step: string | null; request: SandboxReport["request"]; now: Date; finished: boolean }): SandboxReport {
  return {
    outcome: input.outcome,
    stopped: input.code ? { code: input.code, step: input.step, message: STOP_MESSAGES[input.code] } : null,
    snapshot: null,
    steps: [],
    reportSha256: null,
    proposal: null,
    cleanup: null,
    request: input.request,
    updatedAt: input.now.toISOString(),
    finishedAt: input.finished ? input.now.toISOString() : null,
  };
}
