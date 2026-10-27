import { createHash } from "node:crypto";
import { join } from "node:path";
import { Anchors, parentOf } from "./anchors.ts";
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

/**
 * An apply's two roots, held open: the picked folder, and the repository's git folder with the recovery folder in it.
 * Every call names its file through them (`anchors.ts`), never by its path from the root.
 */
interface Held {
  tree: Anchors;
  git: Anchors;
  /** The recovery folder, under the git folder. */
  recovery: string;
}
const heldFor = (io: ApplyIo, roots: Pick<ApplyIntent, "folder" | "gitDir" | "applyId">): Held => ({ tree: new Anchors(io, roots.folder), git: new Anchors(io, roots.gitDir), recovery: `nivra-apply/${roots.applyId}` });
const letGo = (held: Held) => {
  held.tree.close();
  held.git.close();
};
const inRecovery = (held: Held, name: string) => held.git.at(`${held.recovery}/${name}`);

/** A path's state through the folders held open: absent when a folder above it is missing, never read through a link. */
function stateIn(io: ApplyIo, anchors: Anchors, path: string): PathState {
  let name: string;
  try {
    name = anchors.at(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return ABSENT;
    throw error;
  }
  return stateOf(io, name);
}

/** What is in the recovery folder for one path: its original and every version taken back. */
function keptFor(io: ApplyIo, held: Held, index: number, one: IntendedPath): string[] {
  let names: string[] = [];
  try {
    names = io.readdir(held.git.dir(held.recovery));
  } catch {
    return [];
  }
  return names.filter((name) => name === one.aside || name.startsWith(`back-${index}-`)).sort();
}

/**
 * Where every path is against the intent, writing nothing: what reconciling at engine start reports, and what an
 * apply that stopped part way leaves. A path whose folder can't be reached without following a link is other.
 */
export function reconcile(intent: ApplyIntent, io: ApplyIo = nodeIo, created: readonly string[] = []): ApplyResult {
  const held = heldFor(io, intent);
  try {
    const paths = intent.paths.map((_, index) => outcomeOf(io, held, intent, index));
    // Only the folders the apply recorded making: one that was there already, or made just before a crash and never
    // recorded, isn't called Nivra's.
    const folders = created.filter((folder) => {
      try {
        return io.lstat(held.tree.at(folder))?.isDirectory() === true;
      } catch {
        return false;
      }
    });
    return { state: overall(paths), paths, folders, failure: null };
  } finally {
    letGo(held);
  }
}

/** A name in the recovery folder nothing has: a rename onto a name that exists would replace it. */
function freeName(io: ApplyIo, held: Held, base: string): string {
  for (let n = 0; ; n++) if (!io.lstat(inRecovery(held, `${base}-${n}`))) return `${base}-${n}`;
}

/**
 * Takes every path back to how it was, last first, never overwriting anything unexpected:
 * - a path as the change left it is moved into the recovery folder and checked again; if it is still Nivra's, the
 *   original is linked back (a changed file) or nothing is (an added one); if another program saved it meanwhile,
 *   that version is linked back, the original is kept, and the path is left as it is;
 * - a path moved aside with nothing in its place gets its original linked back;
 * - anything else is left as it is, and everything in the recovery folder is kept.
 * Then the folders Nivra created are removed, deepest first, only when empty. It is the same whether an apply stopped
 * part way (through the folders it held open: `held`) or the person asks to restore the originals after a crash, when
 * a path whose folder can't be reached without following a link is left as it is.
 */
export async function restore(intent: ApplyIntent, options: { io?: ApplyIo; created?: readonly string[]; before?: ApplyHook; theirs?: ReadonlyMap<number, boolean>; held?: Held } = {}): Promise<ApplyResult> {
  const io = options.io ?? nodeIo;
  const before = options.before ?? (() => undefined);
  const held = options.held ?? heldFor(io, intent);
  // Paths known to hold another program's version, and whether it was saved after Nivra wrote them.
  const theirs = new Map(options.theirs);
  let failure: ApplyResult["failure"] = null;
  const paths: PathOutcome[] = [];
  try {
    for (let index = intent.paths.length - 1; index >= 0; index--) {
      const one = intent.paths[index]!;
      try {
        const original = one.aside ? inRecovery(held, one.aside) : null;
        const found = stateIn(io, held.tree, one.path);
        // Named only when something is done there: a path whose folder is gone is absent, with nothing to take back.
        const target = () => held.tree.at(one.path);
        if (isPost(found, one)) {
          const back = inRecovery(held, freeName(io, held, `back-${index}`));
          await before(`take back ${index}`);
          io.rename(target(), back);
          if (!isPost(stateOf(io, back), one)) {
            // Saved by another program after Nivra's write: that version goes back where it was.
            theirs.set(index, true);
            await before(`put back ${index}`);
            io.link(back, target());
          } else if (original) {
            await before(`restore ${index}`);
            io.link(original, target());
          }
        } else if (found.kind === "absent" && original && isPre(stateOf(io, original), one)) {
          await before(`restore ${index}`);
          io.link(original, target());
        }
      } catch (error) {
        failure ??= { step: `restore ${index}`, code: codeOf(error) };
      }
      paths.unshift(outcomeOf(io, held, intent, index, theirs.get(index)));
    }
    const left: string[] = [];
    for (const folder of [...(options.created ?? [])].reverse()) {
      try {
        await before(`remove folder ${folder}`);
        io.rmdir(held.tree.at(folder));
        held.tree.forget(folder);
      } catch (error) {
        // Not empty, or not Nivra's to remove after all: it stays.
        if (codeOf(error) !== "ENOTEMPTY" && codeOf(error) !== "EEXIST") failure ??= { step: `remove folder ${folder}`, code: codeOf(error) };
        try {
          if (io.lstat(held.tree.at(folder))) left.push(folder);
        } catch {
          left.push(folder);
        }
      }
    }
    // What restore changed is made durable before its result is recorded: the folders it touched, and the recovery folder.
    for (const sync of [...new Set(intent.paths.map((one) => parentOf(one.path)))].map((rel) => () => held.tree.dir(rel)).concat(() => held.git.dir(held.recovery))) {
      try {
        io.syncDir(sync());
      } catch {
        // Best effort: a folder that can't be synced still holds what it holds.
      }
    }
    // A folder moved or replaced meanwhile: what was done is in the folders held open, which may now be somewhere else,
    // so every path is reported as it is found from the picked folder by name, never through a link.
    let away = true;
    try {
      away = held.tree.moved();
    } catch {
      // Can't tell: reported by name.
    }
    if (away) {
      const seen = reconcile(intent, io, options.created ?? []);
      return { ...seen, failure: seen.state === "not-applied" ? null : (failure ?? { step: "check folders", code: "moved" }) };
    }
    const state = overall(paths);
    return { state, paths, folders: left.reverse(), failure: state === "not-applied" ? null : failure };
  } finally {
    if (!options.held) letGo(held);
  }
}

/**
 * Where one path is now. `theirs` says the version in place is known to be another program's (saved after Nivra wrote
 * the path, when true); only a live apply knows that, so it applies only to a version that is neither Nivra's nor the
 * original.
 */
function outcomeOf(io: ApplyIo, held: Held, intent: ApplyIntent, index: number, theirs?: boolean, seen?: PathState): PathOutcome {
  const one = intent.paths[index]!;
  const kept = keptFor(io, held, index, one);
  let found: PathState;
  try {
    found = seen ?? stateIn(io, held.tree, one.path);
  } catch {
    // It couldn't be read, or only through a link: not known, so other.
    return { path: one.path, place: "other", found: { kind: "other", mode: null, size: null, sha256: null }, kept, changedSince: false };
  }
  if (isPre(found, one)) return { path: one.path, place: "pre", found, kept, changedSince: false };
  if (isPost(found, one)) return { path: one.path, place: "post", found, kept, changedSince: false };
  if (found.kind === "absent" && one.aside) {
    try {
      if (isPre(stateOf(io, inRecovery(held, one.aside)), one)) return { path: one.path, place: "aside", found, kept, changedSince: false };
    } catch {
      // Its copy can't be read: it isn't known to be intact.
    }
  }
  if (theirs !== undefined && found.kind !== "absent") return { path: one.path, place: "theirs", found, kept, changedSince: theirs };
  return { path: one.path, place: "other", found, kept, changedSince: false };
}

/**
 * Lets an apply go once the person has decided. A name in its recovery folder is removed only while it is a second
 * name for the file now at its path, so removing it loses nothing. Every other copy is kept, the originals among them:
 * a program that had a file open saves into the copy, and nothing can tell that none does. Then the recovery folder,
 * if that left it empty, and the lock, when it is this apply's.
 */
export function release(intent: ApplyIntent, options: { engineId: string; io?: ApplyIo }): void {
  const io = options.io ?? nodeIo;
  const held = heldFor(io, intent);
  try {
    let names: string[] = [];
    try {
      names = io.readdir(held.git.dir(held.recovery));
    } catch {
      // No recovery folder to read: nothing in it is removed.
    }
    for (const [index, one] of intent.paths.entries()) {
      let here;
      try {
        here = io.lstat(held.tree.at(one.path));
      } catch {
        // Not reachable without following a link: nothing is a second name for it.
      }
      if (!here?.isFile()) continue;
      for (const name of names.filter((name) => name === one.temp || name === one.aside || name.startsWith(`back-${index}-`))) {
        try {
          const copy = io.lstat(inRecovery(held, name));
          if (copy?.isFile() && copy.dev === here.dev && copy.ino === here.ino && copy.nlink >= 2) io.unlink(inRecovery(held, name));
        } catch {
          // Kept: it can be removed by hand.
        }
      }
    }
    try {
      if (io.readdir(held.git.dir(held.recovery)).length === 0) {
        io.rmdir(held.git.at(held.recovery));
        held.git.forget(held.recovery);
      }
    } catch {
      // Kept.
    }
    // The lock, when it is this apply's: a partial or unknown apply kept it until now.
    try {
      const holder = JSON.parse(new TextDecoder().decode(io.read(held.git.at("nivra-apply/lock")))) as { engine?: unknown; applyId?: unknown };
      if (holder.engine === options.engineId && holder.applyId === intent.applyId) io.unlink(held.git.at("nivra-apply/lock"));
    } catch {
      // None, or another apply's.
    }
  } finally {
    letGo(held);
  }
}

/** Stops the write: a planned step found something it won't overwrite or take for the original. */
class Stop extends Error {
  readonly step: string;
  readonly code: string;
  constructor(step: string, code = "changed") {
    super(step);
    this.name = "Stop";
    this.step = step;
    this.code = code;
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

/** The folders above a path, outermost first, the picked folder ("") included: `a/b/c` gives "", `a`, `a/b`. */
function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, depth) => parts.slice(0, depth + 1).join("/"))];
}

/**
 * Applies a revalidated plan. A refusal before the intent is recorded throws `ApplyRefusal`, having written nothing of
 * the person's (and taken back what it made in the git folder). From the intent on, nothing throws: the result says
 * where every path is, and the recovery folder and the journal keep the rest. Every call names its file through the
 * folders held open (`anchors.ts`), so nothing is written through a folder swapped for a link after it was checked.
 */
export async function writeChange(input: WriteInput): Promise<ApplyResult> {
  const io = input.io ?? nodeIo;
  const before = input.before ?? (() => undefined);
  const { plan, applyId } = input;
  const recovery = join(plan.gitDir, "nivra-apply", applyId);

  // Names through held folders need `/proc`, and the recovery folder must be on the same filesystem as every path the
  // change touches: a rename across two is a copy, which isn't atomic. Read only.
  if (!Anchors.available(io)) throw new ApplyRefusal("filesystem", null, "no /proc/self/fd");
  try {
    const device = io.stat(plan.gitDir).dev;
    for (const one of plan.paths) {
      if (io.stat(nearestFolder(io, plan.folder, one.path)).dev !== device) throw new ApplyRefusal("recovery", one.path, "another device");
    }
  } catch (error) {
    if (error instanceof ApplyRefusal) throw error;
    throw new ApplyRefusal("filesystem", null, codeOf(error));
  }

  const held = heldFor(io, { folder: plan.folder, gitDir: plan.gitDir, applyId });
  const area = "nivra-apply";
  const lock = `${area}/lock`;
  const lockTemp = `${area}/lock-${applyId}`;
  // The lock, the recovery folder, and a hard link in it; anything made here is taken back on a refusal. The lock is
  // written whole under a name of this apply's own, then linked into place, which fails rather than replace another:
  // whatever stops the write, a lock is never left empty.
  let madeArea = false;
  let madeLock = false;
  const quietly = (work: () => void) => {
    try {
      work();
    } catch {
      // Not made, already gone, or left in the git folder, where it holds nothing of the person's.
    }
  };
  const takeBack = () => {
    // This apply's own names first, whether or not their call said it made them: one can fail after doing its work.
    quietly(() => io.unlink(inRecovery(held, "probe-link")));
    quietly(() => io.unlink(inRecovery(held, "probe")));
    quietly(() => io.unlink(held.git.at(lockTemp)));
    quietly(() => {
      io.rmdir(held.git.at(held.recovery));
      held.git.forget(held.recovery);
    });
    // The lock, when it is this apply's own: made, or linked by a call that then reported failure.
    quietly(() => {
      const holder = JSON.parse(new TextDecoder().decode(io.read(held.git.at(lock)))) as { engine?: unknown; applyId?: unknown };
      if (madeLock || (holder.engine === input.engineId && holder.applyId === applyId)) io.unlink(held.git.at(lock));
    });
    quietly(() => {
      if (!madeArea) return;
      io.rmdir(held.git.at(area));
      held.git.forget(area);
    });
    letGo(held);
  };
  /** A lock that is there: another engine's (or one that can't be read) refuses; this engine's own, over, is taken over. */
  const judgeLock = () => {
    let holder: { engine?: unknown; applyId?: unknown } = {};
    try {
      holder = JSON.parse(new TextDecoder().decode(io.read(held.git.at(lock)))) as typeof holder;
    } catch {
      // Unreadable or empty: not this engine's, as far as it can tell.
    }
    if (holder.engine !== input.engineId || typeof holder.applyId !== "string") throw new ApplyRefusal("locked");
    if (!input.journal.settled(holder.applyId)) throw new ApplyRefusal("busy");
    io.unlink(held.git.at(lock));
  };
  try {
    // A lock already there is judged before anything is written.
    const there = io.lstat(held.git.at(area));
    if (there && !there.isDirectory()) throw new ApplyRefusal("filesystem", null, "nivra-apply isn't a folder");
    if (there && io.lstat(held.git.at(lock))) judgeLock();
    if (!there) {
      io.mkdir(held.git.at(area));
      madeArea = true;
    }
    io.create(held.git.at(lockTemp), new TextEncoder().encode(`${JSON.stringify({ engine: input.engineId, applyId })}\n`), 0o600);
    try {
      io.link(held.git.at(lockTemp), held.git.at(lock));
    } catch (error) {
      // The lock is a hard link too: one refused for another reason means links don't work in the git folder.
      if (codeOf(error) !== "EEXIST") throw new ApplyRefusal("recovery", null, codeOf(error));
      // One that appeared since it was looked at.
      judgeLock();
      io.link(held.git.at(lockTemp), held.git.at(lock));
    }
    madeLock = true;
    io.unlink(held.git.at(lockTemp));
    io.mkdir(held.git.at(held.recovery));
    io.syncDir(held.git.dir(area));
    io.create(inRecovery(held, "probe"), new Uint8Array(0), 0o600);
    try {
      io.link(inRecovery(held, "probe"), inRecovery(held, "probe-link"));
    } catch (error) {
      throw new ApplyRefusal("recovery", null, codeOf(error));
    }
    io.unlink(inRecovery(held, "probe-link"));
    io.unlink(inRecovery(held, "probe"));
  } catch (error) {
    takeBack();
    if (error instanceof ApplyRefusal) throw error;
    throw new ApplyRefusal("filesystem", null, codeOf(error));
  }

  // Every folder already there that the change writes in is held open now, one name at a time from the picked folder,
  // never through a link: everything from here on lands in these very folders. Then the intent, with each changed
  // file's own permission bits, so the new file keeps them.
  const paths: IntendedPath[] = [];
  for (const [index, one] of plan.paths.entries()) {
    let perm = one.post.mode === "100755" ? 0o755 : 0o644;
    let stats;
    try {
      for (const rel of foldersOf(one.path)) if (!plan.folders.includes(rel)) held.tree.dir(rel);
      if (one.change === "changed") stats = io.lstat(held.tree.at(one.path));
    } catch (error) {
      takeBack();
      // A folder on its path that is gone, isn't a folder, or is a link now was changed since it was checked.
      throw ["ENOENT", "ENOTDIR", "ELOOP"].includes(codeOf(error) ?? "") ? new ApplyRefusal("changed-since", one.path) : new ApplyRefusal("filesystem", one.path, codeOf(error));
    }
    if (one.change === "changed") {
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
      const temp = inRecovery(held, one.temp);
      io.create(temp, plan.paths[index]!.bytes, one.perm);
      const stats = io.lstat(temp);
      const bytes = io.read(temp);
      if (!stats?.isFile() || (stats.mode & 0o7777) !== one.perm || sha256(bytes) !== one.post.sha256) throw new Stop(step);
    }
    step = "sync recovery";
    io.syncDir(held.git.dir(held.recovery));

    // Missing folders, parents first, each held open once made. One that appeared meanwhile must be a real folder, and
    // is never removed.
    for (const folder of plan.folders) {
      step = `folder ${folder}`;
      await before(step);
      const target = held.tree.at(folder);
      try {
        io.mkdir(target);
        created.push(folder);
        input.journal.created(applyId, folder);
      } catch (error) {
        if (codeOf(error) !== "EEXIST" || !io.lstat(target)?.isDirectory()) throw error;
      }
      held.tree.dir(folder);
      io.syncDir(held.tree.dir(parentOf(folder)));
    }

    // Each changed file: moved aside, whatever is there at that instant, checked, then the new one linked in its place.
    for (const [index, one] of paths.entries()) {
      if (one.change !== "changed") continue;
      const target = held.tree.at(one.path);
      const aside = inRecovery(held, one.aside!);
      step = `aside ${index}`;
      await before(step);
      // Only a file is moved aside: anything else there now (a folder, a link) is left where it is.
      if (!io.lstat(target)?.isFile()) {
        theirs.set(index, false);
        throw new Stop(`changed ${index}`);
      }
      io.rename(target, aside);
      if (!isPre(stateOf(io, aside), one)) {
        // Not the original after all (saved since it was checked): it goes back, and the apply rolls back. A folder
        // swapped in at the last instant can't be linked, so it is renamed back, only into an empty place.
        theirs.set(index, false);
        step = `put back ${index}`;
        await before(step);
        if (io.lstat(aside)?.isDirectory()) {
          if (!io.lstat(target)) io.rename(aside, target);
        } else {
          io.link(aside, target);
          io.unlink(aside);
        }
        throw new Stop(`changed ${index}`);
      }
      step = `link ${index}`;
      await before(step);
      try {
        io.link(inRecovery(held, one.temp), target);
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
        io.link(inRecovery(held, one.temp), held.tree.at(one.path));
      } catch (error) {
        if (codeOf(error) === "EEXIST") theirs.set(index, false);
        throw error;
      }
      written.add(index);
    }

    // Durable, then read back. A file another program changed after Nivra wrote it is reported, never overwritten.
    step = "sync";
    for (const rel of new Set(paths.map((one) => parentOf(one.path)))) io.syncDir(held.tree.dir(rel));
    // The originals moved into the recovery folder, too.
    io.syncDir(held.git.dir(held.recovery));
    step = "read back";
    await before(step);
    for (const [index, one] of paths.entries()) {
      found[index] = stateOf(io, held.tree.at(one.path));
      if (!isPost(found[index], one)) theirs.set(index, true);
    }
    // Last, every folder written in must still be the one at its name: one moved or replaced meanwhile means what Nivra
    // wrote isn't where the person looks for it, and the apply rolls back.
    step = "check folders";
    await before(step);
    if (held.tree.moved()) throw new Stop(step, "moved");
  } catch (error) {
    // A path Nivra wrote that holds neither its bytes nor the original was saved by another program since.
    for (const index of written) if (!theirs.has(index)) theirs.set(index, true);
    const result = await restore(intent, { io, created, before, theirs, held });
    return settle(io, input, intent, { ...result, failure: { step, code: error instanceof Stop ? error.code : codeOf(error) } }, held, lock);
  }
  // Every new file was linked into place. A path another program saved since is reported as such; one removed since
  // makes the apply partial.
  const outcomes = paths.map((_, index) => outcomeOf(io, held, intent, index, theirs.get(index), found[index]));
  return settle(io, input, intent, { state: overall(outcomes), paths: outcomes, folders: created, failure: null }, held, lock);
}

/** Records the result; an apply that is over lets go of its lock, and one partial or unknown keeps it. */
function settle(io: ApplyIo, input: WriteInput, intent: ApplyIntent, result: ApplyResult, held: Held, lock: string): ApplyResult {
  try {
    try {
      input.journal.settle(intent.applyId, result);
    } catch {
      // The intent stays as the record: reconciling reads where every path is.
      return result;
    }
    if (result.state === "applied" || result.state === "not-applied") {
      try {
        io.unlink(held.git.at(lock));
      } catch {
        // A lock left by an apply that is over is taken over by this engine's next apply.
      }
    }
    return result;
  } finally {
    letGo(held);
  }
}
