import * as fs from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

const SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const same = (left: fs.Stats, right: fs.Stats) => left.dev === right.dev && left.ino === right.ino;

/** Small filesystem seam for testing repair failures and name changes, without changing a real home. */
export type PrivacyIo = Pick<typeof fs, "openSync" | "closeSync" | "mkdirSync" | "lstatSync" | "fstatSync" | "fchmodSync">;

export class DatabasePrivacyError extends Error {
  constructor(reason: string) {
    super(`${reason} Use an engine home you own, without writable shared folders or linked database files; restore unsafe entries from a trusted backup, then start Nivra again.`);
    this.name = "DatabasePrivacyError";
  }
}

/**
 * Only the named SQLite families are inspected. Existing files are never replaced, truncated or removed. On Linux,
 * held directories anchor every repair through /proc, as the apply writer does; drivers still receive native paths.
 * Trusted directories keep another user from changing those paths before a driver opens them. This is not isolation
 * from another process running as the same user. Windows retains its inherited ACLs and has no POSIX-mode claim.
 */
export class DatabaseFiles {
  readonly #home: string;
  readonly #io: PrivacyIo;
  readonly #directories: Array<{ path: string; fd: number }> = [];

  constructor(home: string, io: PrivacyIo = fs) {
    this.#home = resolve(home);
    this.#io = io;
    try {
      if (process.platform === "win32") {
        io.mkdirSync(this.#home, { recursive: true });
      } else {
        const root = parse(this.#home).root;
        this.#directory(root, false);
        let path = root;
        const names = this.#home.slice(root.length).split("/").filter(Boolean);
        for (let at = 0; at < names.length; at++) {
          path = join(path, names[at]!);
          this.#directory(path, at === names.length - 1);
        }
        if (names.length === 0) throw new DatabasePrivacyError("The filesystem root cannot be an engine home.");
      }
    } catch (error) {
      this.close();
      throw this.#failure(error);
    }
  }

  #failure(error: unknown): DatabasePrivacyError {
    if (error instanceof DatabasePrivacyError) return error;
    const code = (error as NodeJS.ErrnoException).code;
    return new DatabasePrivacyError(`The engine home's privacy could not be established${code ? ` (${code})` : ""}.`);
  }

  #directory(path: string, home: boolean): void {
    const io = this.#io;
    const parent = this.#directories.at(-1);
    const anchored = process.platform === "linux" && parent ? `/proc/self/fd/${parent.fd}/${path.slice(path.lastIndexOf("/") + 1)}` : path;
    try {
      io.lstatSync(anchored);
    } catch (error) {
      if (!absent(error)) throw error;
      io.mkdirSync(anchored, { mode: 0o700 });
    }
    const fd = io.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    this.#directories.push({ path, fd });
    const info = io.fstatSync(fd);
    const uid = process.getuid!();
    const trustedOwner = info.uid === uid || (!home && info.uid === 0);
    // /tmp is useful for disposable homes; its root-owned sticky directory prevents other users replacing our child.
    const stickyTemp = !home && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || !trustedOwner || ((info.mode & 0o022) !== 0 && !stickyTemp)) {
      throw new DatabasePrivacyError(home ? "The engine home is not an owner-controlled directory." : "An engine-home ancestor is writable by another user or has an untrusted owner.");
    }
    this.#unchanged();
  }

  #unchanged(): void {
    for (const { path, fd } of this.#directories) {
      const named = this.#io.lstatSync(path);
      if (!named.isDirectory() || !same(named, this.#io.fstatSync(fd))) throw new DatabasePrivacyError("An engine-home directory changed while it was being checked.");
    }
  }

  #path(name: string): string {
    if (isAbsolute(name) || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new DatabasePrivacyError("A database name is not a single filename.");
    this.#unchanged();
    const held = this.#directories.at(-1);
    return process.platform === "linux" && held ? `/proc/self/fd/${held.fd}/${name}` : join(this.#home, name);
  }

  #regular(info: fs.Stats): void {
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" && info.uid !== process.getuid!())) {
      throw new DatabasePrivacyError("A database entry is not a single-link regular file owned by this user.");
    }
  }

  #file(name: string, repair: boolean, create: boolean): boolean {
    let fd: number | null = null;
    try {
      const path = this.#path(name);
      let before: fs.Stats | null = null;
      try {
        before = this.#io.lstatSync(path);
        // Reject FIFOs before opening them. O_NONBLOCK also covers a regular file swapped for a FIFO after lstat.
        this.#regular(before);
      } catch (error) {
        if (!absent(error)) throw error;
        if (!create) return false;
      }
      const noFollow = fs.constants.O_NOFOLLOW ?? 0;
      const nonblock = fs.constants.O_NONBLOCK ?? 0;
      fd = this.#io.openSync(path, before ? fs.constants.O_RDONLY | noFollow | nonblock : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow | nonblock, 0o600);
      const opened = this.#io.fstatSync(fd);
      this.#regular(opened);
      if (before && !same(before, opened)) throw new DatabasePrivacyError("A database file changed while it was being opened.");
      const verify = () => {
        const current = this.#io.fstatSync(fd!);
        const named = this.#io.lstatSync(path);
        this.#regular(current);
        this.#regular(named);
        if (!same(current, named)) throw new DatabasePrivacyError("A database file changed while its privacy was being checked.");
        this.#unchanged();
        return current;
      };
      const current = verify();
      if (repair && process.platform !== "win32") {
        if ((current.mode & 0o7777) !== 0o600) this.#io.fchmodSync(fd, 0o600);
        if ((verify().mode & 0o7777) !== 0o600) throw new DatabasePrivacyError("The filesystem did not make the database file private.");
      }
      return true;
    } catch (error) {
      throw this.#failure(error);
    } finally {
      if (fd !== null) this.#io.closeSync(fd);
    }
  }

  validateFamily(name: string): void {
    const main = this.#file(name, false, false);
    for (const suffix of SUFFIXES.slice(1)) {
      if (this.#file(`${name}${suffix}`, false, false) && !main) throw new DatabasePrivacyError("A database is missing while its recovery files remain.");
    }
  }

  prepareMain(name: string): void {
    this.#file(name, true, true);
  }

  /** Call before a driver opens the family. Closing a second fd to a live SQLite main file releases POSIX locks. */
  prepareFamily(name: string): void {
    this.prepareMain(name);
    this.repairSidecars(name);
  }

  repairSidecars(name: string): void {
    for (const suffix of SUFFIXES.slice(1)) this.#file(`${name}${suffix}`, true, false);
  }

  close(): void {
    for (const { fd } of this.#directories.splice(0).reverse()) this.#io.closeSync(fd);
  }
}
