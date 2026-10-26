import { z } from "zod";

/**
 * Applying a task's proposal to the person's checkout (NIV-8, D40), on the engine that owns the checkout's filesystem.
 * Approval is the apply request itself, bound to the proposal's exact hash and to the attempt, engine and brief it was
 * made for, and idempotent by its request id: a repeated request gets the apply it started, and nothing is sent again.
 *
 * Every changed file is moved aside into a recovery folder in the repository's git folder and checked, and each new
 * file is linked into place without replacing anything. Changes are left unstaged. Paths here are the proposal's own,
 * relative to the picked folder; the recovery folder is named inside the git folder, never by an absolute path (D29).
 */

const count = z.number().int().nonnegative();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const RelativePath = z.string().min(1).max(1_024);

/** Why an apply was refused before anything of the person's was written. The words are chosen by the code. */
export const ApplyRefusalCode = z.enum(["proposal", "baseline-moved", "uncommitted", "operation", "changed-since", "collision", "attributes", "path", "git", "recovery", "filesystem", "busy", "duplicate", "interrupted"]);
export type ApplyRefusalCode = z.infer<typeof ApplyRefusalCode>;

/**
 * Where a path is: as it was (`pre`), as the change leaves it (`post`), moved aside with its original intact in the
 * recovery folder (`aside`), another program's version that Nivra left in place (`theirs`), or anything else.
 */
export const ApplyPlace = z.enum(["pre", "post", "aside", "theirs", "other"]);
export type ApplyPlace = z.infer<typeof ApplyPlace>;

/**
 * Where an apply is: claimed while it is checked again, refused, writing, then applied, not applied, partial (each
 * path as it was or as the change leaves it) or unknown (anything else, shown file by file).
 */
export const ApplyStatus = z.enum(["claimed", "refused", "writing", "applied", "not-applied", "partial", "unknown"]);
export type ApplyStatus = z.infer<typeof ApplyStatus>;

/** How the person settled an apply: accepted an applied change, dismissed one that wasn't applied, or kept a partial one as is. */
export const ApplyResolution = z.enum(["accepted", "dismissed", "kept"]);
export type ApplyResolution = z.infer<typeof ApplyResolution>;

export const ApplyPath = z.strictObject({
  path: RelativePath,
  change: z.enum(["added", "changed"]),
  place: ApplyPlace,
  /** What is there now. */
  found: z.strictObject({ kind: z.enum(["absent", "file", "link", "folder", "other"]), mode: z.enum(["100644", "100755"]).nullable(), size: count.nullable() }),
  /** The copies kept for it in the recovery folder, by name: its original, and any version taken back. */
  kept: z.array(z.string().max(64)).max(32),
  /** For `theirs`: saved after Nivra wrote the path. */
  changedSince: z.boolean(),
});
export type ApplyPath = z.infer<typeof ApplyPath>;

export const ApplyView = z.strictObject({
  applyId: z.uuid(),
  requestId: z.uuid(),
  runId: z.uuid(),
  proposalHash: Sha256Hex,
  status: ApplyStatus,
  /** For a refused apply: its code, Nivra's words, and the proposal's path it names. */
  refusal: z.strictObject({ code: ApplyRefusalCode, message: z.string().max(600), path: RelativePath.nullable() }).nullable(),
  paths: z.array(ApplyPath).max(500),
  /** Folders Nivra created that are still there. */
  folders: z.array(RelativePath).max(500),
  /** The recovery folder, inside the repository's git folder (`nivra-apply/<applyId>`); null before one was made. */
  recovery: z.string().max(80).nullable(),
  /** What stopped the write, by its step and the error's code, never its words. */
  failure: z.strictObject({ step: z.string().max(80), code: z.string().max(32).nullable() }).nullable(),
  resolution: ApplyResolution.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ApplyView = z.infer<typeof ApplyView>;

/** What a task's proposal must have been made for: the attempt, the engine's home that keeps it, and the brief. */
export const ApplyTaskBinding = z.strictObject({
  attempt: z.strictObject({ taskId: z.string().min(1).max(200), attemptId: z.uuid(), runId: z.uuid() }),
  engine: z.strictObject({ homeId: z.uuid() }),
  brief: z.strictObject({ version: z.number().int().positive(), sha256: Sha256Hex }),
});
export type ApplyTaskBinding = z.infer<typeof ApplyTaskBinding>;

export const ApplyParams = z.strictObject({
  /** The host's id for this approval, saved before it is sent: a repeat gets the same apply. */
  requestId: z.uuid(),
  runId: z.uuid(),
  /** The hash the person approved. */
  approvedHash: Sha256Hex,
  /** The project's folder, its id and its target, as the host has them. */
  repoPath: z.string().min(1).max(4_096),
  project: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  task: ApplyTaskBinding,
});
export type ApplyParams = z.infer<typeof ApplyParams>;
