import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGitBytes, WorkspaceRefusal, type GitTool } from "../exec/git-tool.ts";
import { verifyProposal, type BoundPath } from "../exec/proposal.ts";
import { checkUncommitted } from "../exec/snapshot.ts";
import { readTar, TarRefusal } from "../exec/tar.ts";
import { byBytes, caseKey, isGitControlFile, MAX_PATH_BYTES, proposedPathProblem, snapshotPathProblem } from "../exec/workspace-rules.ts";
import { ABSENT, ApplyRefusal, type PathState, type PlannedPath, type RevalidatedPlan, type RevalidationInput } from "./plan.ts";

/**
 * Revalidation before an apply (NIV-8, D40): the checks the approved plan sets out, done again on the checkout as it
 * is now, writing nothing. The writer still checks each file as it moves it aside, so a change made after this
 * returns is caught there too.
 *
 * In order:
 * 1. a merge, cherry-pick, revert, rebase or bisect under way, which explains a moved HEAD or a dirty checkout, so it
 *    is named first;
 * 2. HEAD is the proposal's baseline, and the proposal is intact, the approved one, and for this project, target,
 *    folder, attempt, engine and brief (`verifyProposal`);
 * 3. the proposal's own shape: paths Nivra applies, and a post-image holding exactly the bound files;
 * 4. the picked folder clean, by the snapshot's own check (tracked changes, staged or not, and files git is told not to
 *    look at); untracked files matter only where they collide;
 * 5. each changed path the baseline's own file, through real folders;
 * 6. each added path free, its parents real folders or absent, and no name beside it that differs only by case or
 *    Unicode form;
 * 7. no touched path with an attribute that rewrites it on checkout.
 */

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** What git, or the filesystem, threw: a refusal of `code`, or the cancel itself. */
function refusalOf(error: unknown, code: "git" = "git"): unknown {
  if (error instanceof WorkspaceRefusal) return new ApplyRefusal(code, null, error.detail ?? error.message);
  return error;
}

/** A file or folder Nivra couldn't read, with what the filesystem said kept to its detail. */
const unreadable = (error: unknown, what: string): ApplyRefusal => new ApplyRefusal("git", null, `${(error as NodeJS.ErrnoException).code ?? "an error"} reading ${what}`);

/** A path's state on disk, never following a link. */
function stateOf(path: string): PathState {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { kind: "link", mode: null, size: null, sha256: null };
    if (info.isDirectory()) return { kind: "folder", mode: null, size: null, sha256: null };
    if (!info.isFile()) return { kind: "other", mode: null, size: null, sha256: null };
    // git records a file as executable when its owner may run it.
    return { kind: "file", mode: (info.mode & 0o100) !== 0 ? "100755" : "100644", size: info.size, sha256: sha256(readFileSync(path)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return ABSENT;
    throw unreadable(error, "a path the change touches");
  }
}

/** The folders above a path, outermost first: `a/b/c` gives `a` and `a/b`. */
const parentsOf = (path: string): string[] => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
};

/** A folder's names, as they are on disk. */
function namesIn(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch (error) {
    throw unreadable(error, "a folder the change writes in");
  }
}

export async function revalidate(input: RevalidationInput): Promise<RevalidatedPlan> {
  const { proposal } = input;
  const { binding } = proposal;
  let folder: string;
  try {
    folder = realpathSync.native(input.repoPath);
  } catch (error) {
    throw unreadable(error, "the picked folder");
  }
  const tool: GitTool = { session: input.git.session, git: input.git.git, cwd: folder, signal: input.git.signal, deadline: input.git.deadline };
  const run = async (args: readonly string[], options: { okCodes?: readonly number[] } = {}) => {
    try {
      return await runGitBytes(tool, args, options);
    } catch (error) {
      throw refusalOf(error);
    }
  };
  /** git's one line of output, its last newline taken off: a folder's name may hold a newline itself. */
  const oneLine = (bytes: Uint8Array): string => {
    try {
      return strictUtf8.decode(bytes).replace(/\n$/, "");
    } catch {
      throw new ApplyRefusal("git", null, "git gave a name that isn't valid UTF-8");
    }
  };
  const real = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch (error) {
      throw unreadable(error, "a folder git named");
    }
  };
  const topLevel = real(oneLine((await run(["rev-parse", "--show-toplevel"])).bytes));
  const prefix = oneLine((await run(["rev-parse", "--show-prefix"])).bytes).replace(/\/$/, "");
  const gitDir = real(oneLine((await run(["rev-parse", "--absolute-git-dir"])).bytes));

  // 1. Something under way in the checkout: a moved HEAD or a dirty tree follows from it, so it is named first.
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    const path = resolve(folder, oneLine((await run(["rev-parse", "--git-path", name])).bytes));
    if (stateOf(path).kind !== "absent") throw new ApplyRefusal("operation", null, name);
  }

  // 2. The commit, then the proposal itself.
  const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { okCodes: [1] });
  const baseline = head.text.trim();
  if (head.exitCode !== 0 || baseline !== binding.baseline) throw new ApplyRefusal("baseline-moved", null, `HEAD is ${baseline.slice(0, 12) || "missing"}`);
  try {
    verifyProposal(proposal, { project: input.project, target: input.target, destination: { root: topLevel, prefix }, head: baseline, approvedHash: input.approvedHash, task: input.task });
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw new ApplyRefusal("proposal", null, error.message);
    throw error;
  }

  // 3. What the proposal holds: paths Nivra applies, each one's new bytes in the post-image, and nothing else.
  const bound = new Map<string, BoundPath>();
  for (const one of binding.paths) {
    // A path that breaks the rules may hold anything, so it isn't named. As for the patch, only a new path must hold on
    // every target: one the commit already holds is never refused for Windows's rules.
    const problem = one.change === "added" ? proposedPathProblem(one.path) : snapshotPathProblem(one.path);
    if (problem !== null) throw new ApplyRefusal("path", null, problem);
    if (bound.has(one.path)) throw new ApplyRefusal("proposal", one.path, "a path bound twice");
    if (isGitControlFile(one.path)) throw new ApplyRefusal("path", one.path, "a git control file");
    if (one.change === "deleted") throw new ApplyRefusal("path", one.path, "a deletion");
    if (!one.after || (one.after.mode !== "100644" && one.after.mode !== "100755")) throw new ApplyRefusal("path", one.path, `mode ${one.after?.mode ?? "none"}`);
    if (one.change === "changed" && one.before?.mode !== one.after.mode) throw new ApplyRefusal("path", one.path, `a mode change from ${one.before?.mode ?? "none"}`);
    if (one.change === "added" && one.before !== null) throw new ApplyRefusal("proposal", one.path, "an added path with a state before");
    bound.set(one.path, one);
  }
  const parents = new Set([...bound.keys()].flatMap(parentsOf));
  let entries;
  try {
    entries = readTar(proposal.postImage, { maxEntries: bound.size + parents.size, maxBytes: proposal.postImage.byteLength, maxEntryBytes: proposal.postImage.byteLength, maxPathBytes: MAX_PATH_BYTES });
  } catch (error) {
    if (error instanceof TarRefusal) throw new ApplyRefusal("proposal", null, error.message);
    throw error;
  }
  const bytesOf = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.kind === "dir" && parents.has(entry.path)) continue;
    const one = bound.get(entry.path);
    if (entry.kind !== "file" || !one || bytesOf.has(entry.path)) throw new ApplyRefusal("proposal", null, `the post-image holds a ${entry.kind} that isn't bound`);
    if (entry.executable !== (one.after!.mode === "100755") || sha256(entry.bytes) !== one.after!.sha256) throw new ApplyRefusal("proposal", one.path, "the post-image's file isn't the bound one");
    bytesOf.set(entry.path, entry.bytes);
  }
  const missing = [...bound.keys()].find((path) => !bytesOf.has(path));
  if (missing !== undefined) throw new ApplyRefusal("proposal", missing, "the post-image doesn't hold it");

  // 4. The picked folder clean, as the snapshot that made the proposal saw it.
  try {
    await checkUncommitted(tool, prefix, baseline.length === 64 ? 32 : 20);
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw new ApplyRefusal(error.code === "uncommitted" || error.code === "repository" ? "uncommitted" : "git", null, error.detail ?? error.message);
    throw error;
  }

  const paths: PlannedPath[] = [];
  const folders = new Set<string>();
  // Two names one filesystem would take for one: the proposal's own paths and the folders it creates.
  const keys = new Map<string, { path: string; kind: "file" | "folder" }>();
  const claim = (path: string, kind: "file" | "folder", owner: string) => {
    const key = caseKey(path);
    const held = keys.get(key);
    if (held !== undefined && (held.path !== path || held.kind !== kind)) throw new ApplyRefusal("collision", owner, "two of the proposal's names differ only by case or Unicode form, or name a file and a folder");
    keys.set(key, { path, kind });
  };
  for (const [path, one] of [...bound].sort(([a], [b]) => byBytes(a, b))) {
    claim(path, "file", path);
    // 5–6. Its folders: real ones all the way down, never through a link; for an added path, the missing ones are made.
    let absentFrom: string | null = null;
    for (const parent of parentsOf(path)) {
      const kind = stateOf(join(folder, parent)).kind;
      if (kind === "folder") continue;
      if (kind !== "absent" || one.change === "changed") throw new ApplyRefusal(one.change === "changed" ? "changed-since" : "collision", path, `${parent} is a ${kind}`);
      absentFrom = parent;
      break;
    }
    if (one.change === "changed") {
      const pre = stateOf(join(folder, path));
      if (pre.kind !== "file" || pre.mode !== one.before!.mode || pre.sha256 !== one.before!.sha256) throw new ApplyRefusal("changed-since", path, `it is a ${pre.kind}${pre.kind === "file" ? ` of mode ${pre.mode}` : ""}`);
      paths.push({ path, change: "changed", pre, post: { mode: one.after!.mode as "100644" | "100755", size: bytesOf.get(path)!.byteLength, sha256: one.after!.sha256 }, bytes: bytesOf.get(path)! });
      continue;
    }
    // The first name that doesn't exist yet, in the deepest folder that does: nothing beside it may fold to it.
    const firstMissing = absentFrom ?? path;
    const existingParent = parentsOf(firstMissing).at(-1) ?? "";
    if (absentFrom === null && stateOf(join(folder, path)).kind !== "absent") throw new ApplyRefusal("collision", path, "something is there already");
    const name = firstMissing.split("/").at(-1)!;
    if (namesIn(join(folder, existingParent)).some((there) => there !== name && caseKey(there) === caseKey(name))) throw new ApplyRefusal("collision", path, "a name there differs only by case or Unicode form");
    if (absentFrom !== null) {
      for (const parent of parentsOf(path).filter((parent) => parent === absentFrom || parent.startsWith(`${absentFrom}/`))) {
        claim(parent, "folder", path);
        folders.add(parent);
      }
    }
    paths.push({ path, change: "added", pre: ABSENT, post: { mode: one.after!.mode as "100644" | "100755", size: bytesOf.get(path)!.byteLength, sha256: one.after!.sha256 }, bytes: bytesOf.get(path)! });
  }

  // 7. Attributes that would make what git checks out differ from what Nivra writes.
  const listed = (await run(["check-attr", "-z", "filter", "ident", "working-tree-encoding", "eol", "crlf", "text", "--", ...paths.map((one) => one.path)])).bytes;
  const fields = oneLine(listed).split("\0");
  const autocrlf = (await run(["config", "--get", "core.autocrlf"], { okCodes: [1] })).text.trim().toLowerCase();
  const eol = (await run(["config", "--get", "core.eol"], { okCodes: [1] })).text.trim().toLowerCase();
  const converts = /^(true|yes|on|1)$/.test(autocrlf) || eol === "crlf";
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const [path, attribute, value] = [fields[at]!, fields[at + 1]!, fields[at + 2]!];
    const rewrites =
      ((attribute === "filter" || attribute === "working-tree-encoding" || attribute === "eol" || attribute === "crlf") && value !== "unspecified") ||
      (attribute === "ident" && value === "set") ||
      (attribute === "text" && (value === "set" || value === "auto") && converts);
    if (rewrites) throw new ApplyRefusal("attributes", bound.has(path) ? path : null, `${attribute}: ${value}`);
  }

  return { folder, topLevel, gitDir, folders: [...folders].sort(byBytes), paths };
}
