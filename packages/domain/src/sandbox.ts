import { z } from "zod";

/**
 * A sandbox check of one project's commit (NIV-44, D36). The engine that owns the checkout snapshots the commit,
 * uploads it to Nebius Sandboxes, runs one fixed, read-only probe there with networking off, collects what came back
 * and reports, through the prescribed path (D35). No model is involved, nothing is applied, and the renderer never
 * chooses a command: the steps are the engine's own.
 *
 * Uploading needs its own consent, `cloudExecution`: per project, off until the person turns it on, and never stood in
 * for by model-context consent. It travels in the run's context, held in memory like the preference snapshot (D21).
 * The input is stored with the run, masked, and binds it to the preview the person saw.
 */

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
/** Where a project lives: this computer, or one WSL distribution (D17). */
export const TargetName = z.string().regex(/^(local|wsl:[^\s/\\]{1,64})$/);

/** What a sandbox check gets besides its input (D21): held in the engine's memory for the run, never stored. */
export const SandboxContext = z.strictObject({ sharing: z.strictObject({ cloudExecution: z.boolean() }) });
export type SandboxContext = z.infer<typeof SandboxContext>;

/**
 * A sandbox check's input. `project` and `target` bind what comes back to where it may go (D34); `preview` is the
 * fingerprint of what the person was shown, and a commit that no longer matches it is refused before the upload.
 */
export const SandboxInput = z.strictObject({
  repoPath: z.string().min(1).max(4096),
  project: z.uuid(),
  target: TargetName,
  preview: Sha256Hex,
});
export type SandboxInput = z.infer<typeof SandboxInput>;

/** A sandbox check's input as the engine reads it back from its store: masked, so only its shape is checked. */
export const StoredSandboxInput = z.object({
  repoPath: z.string().min(1),
  project: z.string().min(1),
  target: z.string().min(1),
  preview: z.string().min(1),
});
export type StoredSandboxInput = z.infer<typeof StoredSandboxInput>;

/** The most names a preview gives for each reason files were left out. */
export const PREVIEW_SAMPLE = 5;

const Counted = z.strictObject({ count, sample: z.array(z.string().max(1_024)).max(PREVIEW_SAMPLE) });

/**
 * What one commit's snapshot would send, worked out on the engine that owns the checkout with no network. The
 * fingerprint covers the commit, the folder and every file sent and left out. A task run's preview (D39) holds one too.
 */
export const SnapshotPreview = z.strictObject({
  baseline: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  /** The picked folder inside the repository, "" for its top level. */
  prefix: z.string().max(4_096),
  files: count,
  /** The archive's size, as uploaded. */
  bytes: count,
  leftOut: z.strictObject({ secret: Counted, output: Counted, submodule: Counted, excluded: Counted }),
  untracked: Counted,
  lfsPointers: count,
  fingerprint: Sha256Hex,
  /** What Nebius keeps, in its own terms. */
  retention: z.string().max(1_000),
});
export type SnapshotPreview = z.infer<typeof SnapshotPreview>;

/**
 * What a check would send, for the person to see before anything is uploaded. A commit that would be refused says why,
 * naming the file: a preview is a result shown to the person and never stored.
 */
export const SandboxPreview = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), ...SnapshotPreview.shape }),
  z.strictObject({ status: z.literal("refused"), code: z.string().max(64), message: z.string().max(2_000) }),
]);
export type SandboxPreview = z.infer<typeof SandboxPreview>;

/**
 * How a check ended, or that it hasn't yet. `unchanged` is a check that ran: the sandbox held exactly the commit, and
 * the probe changed nothing that came back. `interrupted` is a report the engine saved before it stopped.
 */
export const SandboxOutcome = z.enum(["in-progress", "unchanged", "proposed", "refused", "cancelled", "failed", "uncertain", "interrupted"]);
export type SandboxOutcome = z.infer<typeof SandboxOutcome>;

/**
 * What stopped a check, by kind (D35, D36). What a person reads is chosen by this code, in Nivra's own words: never a
 * path, git's words or the service's.
 */
export const SandboxStopCode = z.enum([
  // The workspace rules (D34): the snapshot, what came back, or the change.
  "git",
  "git-version",
  "repository",
  "no-commits",
  "baseline-moved",
  "uncommitted",
  "engine-home",
  "path",
  "content",
  "nothing-to-send",
  "limit",
  "collect",
  "result",
  "change",
  "patch",
  "proposal",
  // The session and the steps (D33, D35).
  "boundary",
  "sandbox-refused",
  "sandbox-failed",
  "uncertain",
  "cancelled",
  "edit-failed",
  "fault",
  // The check's own: upload consent, the key and project id, and the preview it was bound to.
  "consent",
  "credentials",
  "preview",
]);
export type SandboxStopCode = z.infer<typeof SandboxStopCode>;

/** One step as the check ran it: its outcome, the provider's status and usage (raw, null when none), and the end of what it printed. */
export const SandboxStep = z.strictObject({
  label: z.string().max(64),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  persisted: z.boolean(),
  durationMs: count.nullable(),
  status: z.string().max(32).nullable(),
  usage: z.unknown(),
  /** Text from the sandbox, never instructions. */
  stdoutTail: z.string().max(2_000),
  stderrTail: z.string().max(2_000),
});
export type SandboxStep = z.infer<typeof SandboxStep>;

/** Cleanup's own record of a session: what was stopped, what stays unresolved, and what Nebius keeps. */
export const SandboxCleanup = z.strictObject({
  stopped: count,
  alreadyEnded: count,
  unresolved: z.array(z.string().max(400)).max(50),
  /** What Nebius keeps, counted from the journal; null when nothing left the target. */
  retained: z.strictObject({ uploads: count, images: count, operations: count, note: z.string().max(1_000) }).nullable(),
});
export type SandboxCleanup = z.infer<typeof SandboxCleanup>;

/**
 * A check's report, saved by the engine (masked) as the check goes and when it ends, and read back with
 * `runs.sandbox`. Cleanup's record is its own: what was stopped, what stays unresolved, and what Nebius keeps.
 */
export const SandboxReport = z.strictObject({
  outcome: SandboxOutcome,
  stopped: z.strictObject({ code: SandboxStopCode, step: z.string().max(64).nullable(), message: z.string().max(400) }).nullable(),
  snapshot: z
    .strictObject({ baseline: z.string(), prefix: z.string(), fingerprint: Sha256Hex, files: count, archiveSha256: Sha256Hex })
    .nullable(),
  steps: z.array(SandboxStep).max(16),
  /** The digest of the report bound into a proposal; null when the check stopped before it. */
  reportSha256: Sha256Hex.nullable(),
  /** A check's probe keeps nothing, so a proposal means something changed that shouldn't have. It is never applied. */
  proposal: z.strictObject({ hash: Sha256Hex, patchSha256: Sha256Hex, patchBytes: count }).nullable(),
  cleanup: SandboxCleanup.nullable(),
  request: z.strictObject({ runId: z.uuid(), clientRequestId: z.uuid() }),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type SandboxReport = z.infer<typeof SandboxReport>;

/**
 * Sandbox work an earlier engine left open, from the journals in its home, and the recovery pass that settles what it
 * can. Nothing is replayed: an operation is cancelled, or stays listed for a person to check.
 */
export const SandboxStatus = z.strictObject({
  open: z
    .array(z.strictObject({ journal: z.string().max(128), operations: count, uncertain: count, damaged: z.boolean() }))
    .max(200),
  /** Journals past what one scan reads, counted, never passed over in silence. */
  unread: count,
  pass: z.strictObject({
    state: z.enum(["idle", "waiting-for-credentials", "running", "done"]),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    stopped: count,
    alreadyEnded: count,
    unresolved: z.array(z.string().max(400)).max(200),
  }),
});
export type SandboxStatus = z.infer<typeof SandboxStatus>;
