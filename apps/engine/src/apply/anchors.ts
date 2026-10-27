import type * as fs from "node:fs";
import type { ApplyIo } from "./io.ts";

/**
 * The folders an apply writes in, held open (D40). Every write, move and read in the person's tree, and in the
 * recovery folder, names its file through `/proc/self/fd/<descriptor>/<name>`: it lands in the folder that was opened,
 * whatever is renamed above it or swapped in for it as a link afterwards. Each folder is opened one name at a time,
 * from the root down, never through a link. Node has no other way to act relative to a folder; an apply runs only on
 * Linux and WSL, where `/proc` gives this.
 */
export class Anchors {
  readonly #io: ApplyIo;
  readonly #root: string;
  readonly #fds = new Map<string, number>();

  /** `root` is a real path: the picked folder, or the repository's git folder. */
  constructor(io: ApplyIo, root: string) {
    this.#io = io;
    this.#root = root;
  }

  /** Whether this system can name a file through a held folder at all. */
  static available(io: ApplyIo): boolean {
    try {
      return io.lstat("/proc/self/fd")?.isDirectory() === true;
    } catch {
      return false;
    }
  }

  /** The folder `rel` (POSIX, relative to the root; "" for the root itself), opened the first time it is asked for. */
  #fd(rel: string): number {
    const held = this.#fds.get(rel);
    if (held !== undefined) return held;
    const fd = rel === "" ? this.#io.openDir(this.#root) : this.#io.openDir(`${this.dir(parentOf(rel))}/${baseOf(rel)}`);
    this.#fds.set(rel, fd);
    return fd;
  }

  /** A folder of the change, through its descriptor. */
  dir(rel: string): string {
    return `/proc/self/fd/${this.#fd(rel)}`;
  }

  /** A name in a folder of the change, through that folder's descriptor: what each call is given. */
  at(path: string): string {
    return `${this.dir(parentOf(path))}/${baseOf(path)}`;
  }

  /**
   * Whether any folder held open was moved or replaced since it was opened: the root no longer at its path, or a folder
   * no longer the one at its name in the folder above. What was done through it is then somewhere else.
   */
  moved(): boolean {
    const root = this.#fds.get("");
    if (root !== undefined && !same(this.#io.lstat(this.#root), this.#io.statFd(root))) return true;
    for (const [rel, fd] of this.#fds) {
      if (rel !== "" && !same(this.#io.lstat(`${this.dir(parentOf(rel))}/${baseOf(rel)}`), this.#io.statFd(fd))) return true;
    }
    return false;
  }

  /** A folder removed: its descriptor is let go. */
  forget(rel: string): void {
    for (const [name, fd] of [...this.#fds]) {
      if (name !== rel && !name.startsWith(`${rel}/`)) continue;
      this.#fds.delete(name);
      try {
        this.#io.closeDir(fd);
      } catch {
        // Already closed.
      }
    }
  }

  close(): void {
    for (const fd of this.#fds.values()) {
      try {
        this.#io.closeDir(fd);
      } catch {
        // Already closed.
      }
    }
    this.#fds.clear();
  }
}

/** A folder at a name, and one held open, are the same folder. */
const same = (there: fs.Stats | null, opened: fs.Stats) => there?.isDirectory() === true && there.dev === opened.dev && there.ino === opened.ino;

export const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
