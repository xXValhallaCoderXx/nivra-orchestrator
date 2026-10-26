import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { type ApplyIo, nodeIo } from "./io.ts";
import { ABSENT, ApplyRefusal, type PathState, type PlannedPath, type RevalidatedPlan } from "./plan.ts";

/**
 * The apply writer (NIV-8, D40). It never uses git apply in the working tree, and it never destroys a version of a
 * file it hasn't verified:
 * - every new file is written first into a recovery folder in the repository's git folder, with its exact mode,
 *   made durable, and read back;
 * - each file the change replaces is moved aside into that folder, whatever is there at that instant, and checked
 *   against what revalidation found; anything else is put back and the apply rolls back;
 * - each new file is then linked into place, which fails rather than replace anything that appeared meanwhile.
 *
 * The intent (every path's state before and after, and every name in the recovery folder) is recorded before
 * anything of the person's is touched, so a crash at any point reconciles as applied, not applied, partial or
 * unknown, and nothing is ever replayed. Changes are left unstaged: git isn't run here at all.
 */

/** One path as the intent records it: its state before and after, and its names in the recovery folder. */
export interface IntendedPath {
  path: string;
  change: "added" | "changed";
  pre: PathState;
  post: PlannedPath["post"];
  /** The permission bits written: the original's for a changed file, 0644 or 0755 for an added one. */
  perm: number;
  /** The new bytes, in the recovery folder. */
  temp: string;
  /** Where a changed path's original is moved aside to. */
  aside: string | null;
}

/** What an apply will do, recorded before it touches anything of the person's. */
export interface ApplyIntent {
  version: 1;
  applyId: string;
  /** The picked folder, the git folder and the recovery folder, as real paths. They never leave the engine. */
  folder: string;
  gitDir: string;
  recovery: string;
  /** Folders to create, relative to the picked folder, parents first. */
  folders: string[];
  paths: IntendedPath[];
}

/**
 * Where a path is against its intent:
 * - `pre`, as it was; `post`, as the change leaves it;
 * - `aside`, moved aside with nothing in its place, its original intact in the recovery folder;
 * - `theirs`, a version another program saved, which Nivra left in place: before Nivra wrote the path (Nivra's
 *   change never reached it) or after (`changedSince`);
 * - `other`, anything else: only a live apply knows a version is another program's, so after a crash it is this.
 */
export type PathPlace = "pre" | "post" | "aside" | "theirs" | "other";

export interface PathOutcome {
  path: string;
  place: PathPlace;
  /** What is there now. */
  found: PathState;
  /** The names in the recovery folder of the copies kept for this path: its original, and any version taken back. */
  kept: string[];
  /** For `theirs`: saved after Nivra wrote the path, so it may hold some of the change. Reported, never overwritten. */
  changedSince: boolean;
}

/** All as the change leaves them; all as they were; each one or the other; anything else. */
export type ApplyState = "applied" | "not-applied" | "partial" | "unknown";

export interface ApplyResult {
  state: ApplyState;
  paths: PathOutcome[];
  /** Folders Nivra created that are still there, relative to the picked folder. */
  folders: string[];
  /** What stopped the write, for the engine's own record: the step and the error's code, never its words. */
  failure: { step: string; code: string | null } | null;
}

/** What the writer records, as it goes. */
export interface ApplyJournalPort {
  /** Whether an apply is over and left nothing to settle: one holding a stale lock can then be taken over. */
  settled(applyId: string): boolean;
  /** Durably, before anything of the person's is touched. */
  intend(applyId: string, intent: ApplyIntent): void;
  /** A folder the apply created, so a later rollback removes only those. */
  created(applyId: string, folder: string): void;
  settle(applyId: string, result: ApplyResult): void;
}

/** Called before each step that changes something, with its name: a test edits a file there, or stops. */
export type ApplyHook = (step: string) => void | Promise<void>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Git's own reading of a mode: executable when the owner may run it. */
const gitMode = (mode: number): "100644" | "100755" => ((mode & 0o100) !== 0 ? "100755" : "100644");
const codeOf = (error: unknown): string | null => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : null;
};

/** A path's state on disk, never following a link. */
export function stateOf(io: ApplyIo, path: string): PathState {
  const stats = io.lstat(path);
  if (!stats) return ABSENT;
  if (stats.isSymbolicLink()) return { kind: "link", mode: null, size: null, sha256: null };
  if (stats.isDirectory()) return { kind: "folder", mode: null, size: null, sha256: null };
  if (!stats.isFile()) return { kind: "other", mode: null, size: null, sha256: null };
  const bytes = io.read(path);
  return { kind: "file", mode: gitMode(stats.mode), size: bytes.byteLength, sha256: sha256(bytes) };
}

const isPre = (found: PathState, one: IntendedPath) => (one.change === "added" ? found.kind === "absent" : sameFile(found, one.pre));
const isPost = (found: PathState, one: IntendedPath) => sameFile(found, { kind: "file", mode: one.post.mode, size: one.post.size, sha256: one.post.sha256 });
function sameFile(found: PathState, wanted: PathState): boolean {
  return found.kind === "file" && wanted.kind === "file" && found.mode === wanted.mode && found.size === wanted.size && found.sha256 === wanted.sha256;
}

/**
 * The whole apply from its paths: applied when every path is as the change leaves it (or saved since by another
 * program); not applied when none holds any of the change; partial when each is one or the other, or moved aside
 * intact; unknown otherwise.
 */
export function overall(paths: ReadonlyArray<Pick<PathOutcome, "place" | "changedSince">>): ApplyState {
  if (paths.every((one) => one.place === "post" || (one.place === "theirs" && one.changedSince))) return "applied";
  if (paths.every((one) => one.place === "pre" || (one.place === "theirs" && !one.changedSince))) return "not-applied";
  return paths.every((one) => one.place !== "other") ? "partial" : "unknown";
}

const absPath = (folder: string, path: string) => join(folder, ...path.split("/"));

/** The nearest folder that exists, from a path's parent up to the picked folder, never through a link. */
function nearestFolder(io: ApplyIo, folder: string, path: string): string {
  const parts = path.split("/").slice(0, -1);
  for (let depth = parts.length; depth > 0; depth--) {
    const candidate = absPath(folder, parts.slice(0, depth).join("/"));
    const stats = io.lstat(candidate);
    if (stats?.isDirectory()) return candidate;
  }
  return folder;
}

/** What is in the recovery folder for one path: its original and every version taken back. */
function keptFor(io: ApplyIo, intent: ApplyIntent, index: number, one: IntendedPath): string[] {
  let names: string[] = [];
  try {
    names = io.readdir(intent.recovery);
  } catch {
    return [];
  }
  return names.filter((name) => name === one.aside || name.startsWith(`back-${index}-`)).sort();
}

/**
 * Where every path is against the intent, writing nothing: what reconciling at engine start reports, and what an
 * apply that stopped part way leaves.
 */
export function reconcile(intent: ApplyIntent, io: ApplyIo = nodeIo): ApplyResult {
  const paths = intent.paths.map((_, index) => outcomeOf(io, intent, index));
  const folders = intent.folders.filter((folder) => io.lstat(absPath(intent.folder, folder))?.isDirectory() === true);
  return { state: overall(paths), paths, folders, failure: null };
}

/** A name in the recovery folder nothing has: a rename onto a name that exists would replace it. */
function freeName(io: ApplyIo, recovery: string, base: string): string {
  for (let n = 0; ; n++) if (!io.lstat(join(recovery, `${base}-${n}`))) return `${base}-${n}`;
}

/**
 * Takes every path back to how it was, last first, never overwriting anything unexpected:
 * - a path as the change left it is moved into the recovery folder and checked again; if it is still Nivra's, the
 *   original is linked back (a changed file) or nothing is (an added one); if another program saved it meanwhile,
 *   that version is linked back, the original is kept, and the path is left as it is;
 * - a path moved aside with nothing in its place gets its original linked back;
 * - anything else is left as it is, and everything in the recovery folder is kept.
 * Then the folders Nivra created are removed, deepest first, only when empty. It is the same whether an apply stopped
 * part way or the person asks to restore the originals after a crash.
 */
export async function restore(intent: ApplyIntent, options: { io?: ApplyIo; created?: readonly string[]; before?: ApplyHook; theirs?: ReadonlyMap<number, boolean> } = {}): Promise<ApplyResult> {
  const io = options.io ?? nodeIo;
  const before = options.before ?? (() => undefined);
  // Paths known to hold another program's version, and whether it was saved after Nivra wrote them.
  const theirs = new Map(options.theirs);
  let failure: ApplyResult["failure"] = null;
  const paths: PathOutcome[] = [];
  for (let index = intent.paths.length - 1; index >= 0; index--) {
    const one = intent.paths[index]!;
    const target = absPath(intent.folder, one.path);
    const original = one.aside ? join(intent.recovery, one.aside) : null;
    try {
      const found = stateOf(io, target);
      if (isPost(found, one)) {
        const back = join(intent.recovery, freeName(io, intent.recovery, `back-${index}`));
        await before(`take back ${index}`);
        io.rename(target, back);
        if (!isPost(stateOf(io, back), one)) {
          // Saved by another program after Nivra's write: that version goes back where it was.
          theirs.set(index, true);
          await before(`put back ${index}`);
          io.link(back, target);
        } else if (original) {
          await before(`restore ${index}`);
          io.link(original, target);
        }
      } else if (found.kind === "absent" && original && isPre(stateOf(io, original), one)) {
        await before(`restore ${index}`);
        io.link(original, target);
      }
    } catch (error) {
      failure ??= { step: `restore ${index}`, code: codeOf(error) };
    }
    paths.unshift(outcomeOf(io, intent, index, theirs.get(index)));
  }
  const left: string[] = [];
  for (const folder of [...(options.created ?? [])].reverse()) {
    try {
      await before(`remove folder ${folder}`);
      io.rmdir(absPath(intent.folder, folder));
    } catch (error) {
      // Not empty, or not Nivra's to remove after all: it stays.
      if (codeOf(error) !== "ENOTEMPTY" && codeOf(error) !== "EEXIST") failure ??= { step: `remove folder ${folder}`, code: codeOf(error) };
      if (io.lstat(absPath(intent.folder, folder))) left.push(folder);
    }
  }
  const state = overall(paths);
  return { state, paths, folders: left.reverse(), failure: state === "not-applied" ? null : failure };
}

/**
 * Where one path is now. `theirs` says the version in place is known to be another program's (saved after Nivra wrote
 * the path, when true); only a live apply knows that, so it applies only to a version that is neither Nivra's nor the
 * original.
 */
function outcomeOf(io: ApplyIo, intent: ApplyIntent, index: number, theirs?: boolean, seen?: PathState): PathOutcome {
  const one = intent.paths[index]!;
  const kept = keptFor(io, intent, index, one);
  let found: PathState;
  try {
    found = seen ?? stateOf(io, absPath(intent.folder, one.path));
  } catch {
    // It couldn't be read: not known, so other.
    return { path: one.path, place: "other", found: { kind: "other", mode: null, size: null, sha256: null }, kept, changedSince: false };
  }
  if (isPre(found, one)) return { path: one.path, place: "pre", found, kept, changedSince: false };
  if (isPost(found, one)) return { path: one.path, place: "post", found, kept, changedSince: false };
  if (found.kind === "absent" && one.aside) {
    try {
      if (isPre(stateOf(io, join(intent.recovery, one.aside)), one)) return { path: one.path, place: "aside", found, kept, changedSince: false };
    } catch {
      // Its copy can't be read: it isn't known to be intact.
    }
  }
  if (theirs !== undefined && found.kind !== "absent") return { path: one.path, place: "theirs", found, kept, changedSince: theirs };
  return { path: one.path, place: "other", found, kept, changedSince: false };
}

/** Stops the write: a planned step found something it won't overwrite or take for the original. */
class Stop extends Error {
  readonly step: string;
  constructor(step: string) {
    super(step);
    this.name = "Stop";
    this.step = step;
  }
}

export interface WriteInput {
  applyId: string;
  plan: RevalidatedPlan;
  journal: ApplyJournalPort;
  /** This engine's home, so a lock it left can be told from another engine's. */
  engineId: string;
  io?: ApplyIo;
  before?: ApplyHook;
}

/**
 * Applies a revalidated plan. A refusal before the intent is recorded throws `ApplyRefusal`, having written nothing of
 * the person's (and taken back what it made in the git folder). From the intent on, nothing throws: the result says
 * where every path is, and the recovery folder and the journal keep the rest.
 */
export async function writeChange(input: WriteInput): Promise<ApplyResult> {
  const io = input.io ?? nodeIo;
  const before = input.before ?? (() => undefined);
  const { plan, applyId } = input;
  const area = join(plan.gitDir, "nivra-apply");
  const recovery = join(area, applyId);
  const lock = join(area, "lock");

  // The recovery folder must be on the same filesystem as every path the change touches: a rename across two is a
  // copy, which isn't atomic. Read only.
  try {
    const device = io.stat(plan.gitDir).dev;
    for (const one of plan.paths) {
      if (io.stat(nearestFolder(io, plan.folder, one.path)).dev !== device) throw new ApplyRefusal("recovery", one.path, "another device");
    }
  } catch (error) {
    if (error instanceof ApplyRefusal) throw error;
    throw new ApplyRefusal("filesystem", null, codeOf(error));
  }

  // The lock, the recovery folder, and a hard link in it; anything made here is taken back on a refusal.
  let madeArea = false;
  let madeLock = false;
  let madeRecovery = false;
  const takeBack = () => {
    for (const name of madeRecovery ? ["probe-link", "probe"] : []) {
      try {
        io.unlink(join(recovery, name));
      } catch {
        // Not made, or already gone.
      }
    }
    for (const [made, undo] of [[madeRecovery, () => io.rmdir(recovery)], [madeLock, () => io.unlink(lock)], [madeArea, () => io.rmdir(area)]] as const) {
      try {
        if (made) undo();
      } catch {
        // Left in the git folder: it holds nothing of the person's.
      }
    }
  };
  try {
    if (!io.lstat(area)) {
      io.mkdir(area);
      madeArea = true;
    }
    const holder = new TextEncoder().encode(`${JSON.stringify({ engine: input.engineId, applyId })}\n`);
    try {
      io.create(lock, holder, 0o600);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      let held: { engine?: unknown; applyId?: unknown } = {};
      try {
        held = JSON.parse(new TextDecoder().decode(io.read(lock))) as typeof held;
      } catch {
        // Unreadable: another engine's, as far as this one can tell.
      }
      if (held.engine !== input.engineId || typeof held.applyId !== "string" || !input.journal.settled(held.applyId)) throw new ApplyRefusal("busy");
      // This engine's own, left by an apply that is over: taken over.
      io.unlink(lock);
      io.create(lock, holder, 0o600);
    }
    madeLock = true;
    io.mkdir(recovery);
    madeRecovery = true;
    io.syncDir(area);
    io.create(join(recovery, "probe"), new Uint8Array(0), 0o600);
    try {
      io.link(join(recovery, "probe"), join(recovery, "probe-link"));
    } catch (error) {
      throw new ApplyRefusal("recovery", null, codeOf(error));
    }
    io.unlink(join(recovery, "probe-link"));
    io.unlink(join(recovery, "probe"));
  } catch (error) {
    takeBack();
    if (error instanceof ApplyRefusal) throw error;
    throw new ApplyRefusal("filesystem", null, codeOf(error));
  }

  // The intent, with each changed file's own permission bits, so the new file keeps them.
  const paths: IntendedPath[] = [];
  for (const [index, one] of plan.paths.entries()) {
    let perm = one.post.mode === "100755" ? 0o755 : 0o644;
    if (one.change === "changed") {
      let stats;
      try {
        stats = io.lstat(absPath(plan.folder, one.path));
      } catch (error) {
        takeBack();
        throw new ApplyRefusal("filesystem", one.path, codeOf(error));
      }
      if (!stats?.isFile() || gitMode(stats.mode) !== one.pre.mode) {
        takeBack();
        throw new ApplyRefusal("changed-since", one.path);
      }
      perm = stats.mode & 0o7777;
    }
    paths.push({ path: one.path, change: one.change, pre: one.pre, post: one.post, perm, temp: `new-${index}`, aside: one.change === "changed" ? `orig-${index}` : null });
  }
  const intent: ApplyIntent = { version: 1, applyId, folder: plan.folder, gitDir: plan.gitDir, recovery, folders: plan.folders, paths };
  try {
    input.journal.intend(applyId, intent);
  } catch (error) {
    takeBack();
    throw error;
  }

  const created: string[] = [];
  // Paths Nivra linked its new file into; and paths left holding another program's version, saved before Nivra wrote
  // them (false) or after (true). What the read back found is what the result says.
  const written = new Set<number>();
  const found: PathState[] = [];
  const theirs = new Map<number, boolean>();
  let step = "";
  try {
    // The new files, in the recovery folder: exactly their bytes and mode, durable, and read back.
    for (const [index, one] of paths.entries()) {
      step = `temp ${index}`;
      await before(step);
      const temp = join(recovery, one.temp);
      io.create(temp, plan.paths[index]!.bytes, one.perm);
      const stats = io.lstat(temp);
      const bytes = io.read(temp);
      if (!stats?.isFile() || (stats.mode & 0o7777) !== one.perm || sha256(bytes) !== one.post.sha256) throw new Stop(step);
    }
    step = "sync recovery";
    io.syncDir(recovery);

    // Missing folders, parents first. One that appeared meanwhile must be a real folder, and is never removed.
    for (const folder of plan.folders) {
      step = `folder ${folder}`;
      await before(step);
      const target = absPath(plan.folder, folder);
      try {
        io.mkdir(target);
        created.push(folder);
        input.journal.created(applyId, folder);
      } catch (error) {
        if (codeOf(error) !== "EEXIST" || !io.lstat(target)?.isDirectory()) throw error;
      }
      io.syncDir(dirname(target));
    }

    // Each changed file: moved aside, whatever is there at that instant, checked, then the new one linked in its place.
    for (const [index, one] of paths.entries()) {
      if (one.change !== "changed") continue;
      const target = absPath(plan.folder, one.path);
      const aside = join(recovery, one.aside!);
      step = `aside ${index}`;
      await before(step);
      io.rename(target, aside);
      if (!isPre(stateOf(io, aside), one)) {
        // Not the original after all (saved since it was checked): it goes back, and the apply rolls back.
        theirs.set(index, false);
        step = `put back ${index}`;
        await before(step);
        io.link(aside, target);
        io.unlink(aside);
        throw new Stop(`changed ${index}`);
      }
      step = `link ${index}`;
      await before(step);
      try {
        io.link(join(recovery, one.temp), target);
      } catch (error) {
        // Saved after the original was moved aside: that save stays, and the original is kept.
        if (codeOf(error) === "EEXIST") theirs.set(index, false);
        throw error;
      }
      written.add(index);
    }
    // Each added file: linked into place, which fails rather than replace anything there.
    for (const [index, one] of paths.entries()) {
      if (one.change !== "added") continue;
      step = `link ${index}`;
      await before(step);
      try {
        io.link(join(recovery, one.temp), absPath(plan.folder, one.path));
      } catch (error) {
        if (codeOf(error) === "EEXIST") theirs.set(index, false);
        throw error;
      }
      written.add(index);
    }

    // Durable, then read back. A file another program changed after Nivra wrote it is reported, never overwritten.
    step = "sync";
    for (const folder of new Set(paths.map((one) => dirname(absPath(plan.folder, one.path))))) io.syncDir(folder);
    step = "read back";
    await before(step);
    for (const [index, one] of paths.entries()) {
      found[index] = stateOf(io, absPath(plan.folder, one.path));
      if (!isPost(found[index], one)) theirs.set(index, true);
    }
  } catch (error) {
    // A path Nivra wrote that holds neither its bytes nor the original was saved by another program since.
    for (const index of written) if (!theirs.has(index)) theirs.set(index, true);
    const result = await restore(intent, { io, created, before, theirs });
    const stopped: ApplyResult = { ...result, failure: { step, code: error instanceof Stop ? "changed" : codeOf(error) } };
    return settle(io, input, intent, stopped, lock);
  }
  // Every new file was linked into place. A path another program saved since is reported as such; one removed since
  // makes the apply partial.
  const outcomes = paths.map((_, index) => outcomeOf(io, intent, index, theirs.get(index), found[index]));
  return settle(io, input, intent, { state: overall(outcomes), paths: outcomes, folders: created, failure: null }, lock);
}

/** Records the result; an apply that is over lets go of its lock, and one partial or unknown keeps it. */
function settle(io: ApplyIo, input: WriteInput, intent: ApplyIntent, result: ApplyResult, lock: string): ApplyResult {
  try {
    input.journal.settle(intent.applyId, result);
  } catch {
    // The intent stays as the record: reconciling reads where every path is.
    return result;
  }
  if (result.state === "applied" || result.state === "not-applied") {
    try {
      io.unlink(lock);
    } catch {
      // A lock left by an apply that is over is taken over by this engine's next apply.
    }
  }
  return result;
}
