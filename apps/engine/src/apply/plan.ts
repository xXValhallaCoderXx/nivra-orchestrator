import type { ExecutionSession } from "../exec/backend.ts";
import type { PhaseDeadline } from "../exec/git-tool.ts";
import type { Proposal, TaskBinding } from "../exec/proposal.ts";

/**
 * Applying a task's proposal (NIV-8, D40) happens in two parts:
 * - revalidation (`revalidate.ts`) checks, writing nothing, that the proposal is still the approved one and that the
 *   checkout is still the baseline it was made from;
 * - the writer (`writer.ts`) then writes from the plan it gives. Each changed file is moved aside into a recovery folder
 *   and checked, then the new file is linked into place, which never replaces anything.
 *
 * Paths are POSIX, relative to the picked folder (the proposal's own paths), never absolute: one may leave the engine
 * in a refusal, and an absolute one never does (D29).
 */

/** A path's state on disk, as lstat and its bytes show it. A link is never followed. */
export interface PathState {
  kind: "absent" | "file" | "link" | "folder" | "other";
  /** A file's mode as git records it; null for anything but a file. */
  mode: "100644" | "100755" | null;
  size: number | null;
  sha256: string | null;
}

export const ABSENT: PathState = Object.freeze({ kind: "absent", mode: null, size: null, sha256: null });

/** One path the change writes. */
export interface PlannedPath {
  /** Relative to the picked folder, as the proposal binds it. */
  path: string;
  change: "added" | "changed";
  /** What revalidation found there: the baseline's own file for a changed path, nothing for an added one. */
  pre: PathState;
  /** What applying leaves there. */
  post: { mode: "100644" | "100755"; size: number; sha256: string };
  /** The new bytes, from the proposal's post-image, checked against `post`. */
  bytes: Uint8Array;
}

/** What revalidation hands the writer. */
export interface RevalidatedPlan {
  /** The picked folder, as a real path: every planned path is inside it. */
  folder: string;
  /** The repository's top level and its git folder, as real paths. The recovery folder goes in the git folder. */
  topLevel: string;
  gitDir: string;
  /** Folders to create, relative to the picked folder, parents before children. */
  folders: string[];
  /** Sorted by their path's bytes. */
  paths: PlannedPath[];
}

/** What revalidation is given: the proposal the engine keeps, what the person approved, and where it must go. */
export interface RevalidationInput {
  proposal: Proposal;
  approvedHash: string;
  /** The project's folder, as the host has it: the folder the run was started on. */
  repoPath: string;
  project: string;
  target: string;
  /** The attempt, the engine's home and the brief the proposal must have been made for. */
  task: TaskBinding;
  /** git, found by the engine (never in a repository), and run through the engine's own local session. */
  git: { session: ExecutionSession; git: string; signal?: AbortSignal; deadline?: PhaseDeadline };
}

/** Why an apply was refused. Its words are chosen by its code (D29); the path, when there is one, is the proposal's. */
export type ApplyRefusalCode =
  /** Not intact, not the approved hash, or not for this project, target, folder, attempt, engine or brief. */
  | "proposal"
  /** Its trustworthy report didn't establish all required verification conditions. */
  | "unverified"
  /** HEAD isn't the commit the proposal was made from. */
  | "baseline-moved"
  /** Tracked changes in the worktree or the index, files git is told not to look at, or a split index. */
  | "uncommitted"
  /** A merge, cherry-pick, revert, rebase or bisect is under way. */
  | "operation"
  /** A changed path isn't the baseline's file any more: its bytes, its mode or its kind. */
  | "changed-since"
  /** An added path is taken, a parent isn't a folder, or a name there differs from it only by case or Unicode form. */
  | "collision"
  /** Git rewrites a touched path on checkout: a filter, ident, working-tree-encoding, or a conversion to CRLF. */
  | "attributes"
  /** A path Nivra doesn't apply: outside the folder, through a link, a deletion, a link or a mode change. */
  | "path"
  /** git failed, or gave something Nivra can't read. */
  | "git"
  /** The recovery folder can't be on the same filesystem as the change, or hard links don't work there. */
  | "recovery"
  /** The folder or a file the change touches couldn't be read, or the git folder written, before anything of the person's was. */
  | "filesystem"
  /** Another apply is open for this folder. */
  | "busy"
  /** The repository's apply lock is held by another engine, or can't be read. */
  | "locked"
  /** This proposal has already been applied. */
  | "duplicate"
  /** The engine stopped after the apply was claimed and before it wrote anything. */
  | "interrupted";

const APPLY_REFUSALS: Readonly<Record<ApplyRefusalCode, string>> = {
  proposal: "This proposal isn't the one you approved, isn't intact, or wasn't made for this folder, run or engine, so nothing was written. Run the task again.",
  unverified: "This run's trustworthy evidence doesn't establish every acceptance case and required repository check passed with its protected files unchanged, so nothing was applied. Reject it, request a revision, or start a new authorised task run.",
  "baseline-moved": "Your checkout has moved to another commit since the proposal was made, so nothing was written. Run the task again from the commit it is on now.",
  uncommitted: "Your checkout has uncommitted changes, or git can't show whether it has (files it is told not to look at, or a split index), so nothing was written. Commit or stash the changes, or clear those settings, then apply again.",
  operation: "A merge, rebase, cherry-pick, revert or bisect is under way in this checkout, so nothing was written. Finish or abort it, then apply again.",
  "changed-since": "A file the change replaces is no longer as it was in the commit, so nothing was written. Restore it, or run the task again.",
  collision: "Something is already where the change adds a file, or has a name that differs from it only by case or Unicode form, so nothing was written. Move it aside, or run the task again.",
  attributes: "Git rewrites a file the change touches when it checks it out (a filter, ident, an encoding, or a conversion to CRLF line endings from its attributes or core.autocrlf), so nothing was written: what Nivra wrote wouldn't be what you approved.",
  path: "The change holds a path Nivra doesn't apply (outside the folder, through a link, a deletion, a link or a mode change), so nothing was written.",
  git: "Git failed while Nivra checked your checkout, so nothing was written. Try again; if it keeps happening, report it with the engine log.",
  recovery: "Nivra keeps a copy of every file it replaces in the repository's git folder, and that folder isn't on the same disk as the change, or doesn't take hard links, so nothing was written.",
  filesystem: "Nivra couldn't read the project's folder or a file the change touches, or write in the repository's git folder, so nothing was written. Check that the folder is there, its permissions and its free space, then apply again.",
  busy: "Another change is being applied to this folder, or one applied in part is waiting for you to settle it, so nothing was written. Settle it, then apply again.",
  locked: "Another Nivra engine holds this repository's apply lock (nivra-apply/lock in its git folder), so nothing was written. If no other Nivra is applying a change here, remove that file, then apply again.",
  duplicate: "This proposal has already been applied, so it wasn't applied again.",
  interrupted: "Nivra stopped before it wrote anything, so nothing was written. Apply again.",
};

/** An apply refused before anything was written. */
export class ApplyRefusal extends Error {
  readonly code: ApplyRefusalCode;
  /** The proposal's own path the refusal is about, relative to the picked folder; never a path the proposal doesn't name. */
  readonly path: string | null;
  /** What git or the filesystem said, for the engine's own tests and checks. It never leaves the engine. */
  readonly detail: string | null;
  constructor(code: ApplyRefusalCode, path: string | null = null, detail: string | null = null) {
    super(path === null ? APPLY_REFUSALS[code] : `${APPLY_REFUSALS[code]} (${path})`);
    this.name = "ApplyRefusal";
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

/** A refusal's words, by its code: what leaves the engine. */
export const applyRefusalWords = (code: ApplyRefusalCode): string => APPLY_REFUSALS[code];
