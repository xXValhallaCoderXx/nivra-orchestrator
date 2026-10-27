import * as fs from "node:fs";

/**
 * Every filesystem call the apply writer makes (D40), synchronous and one at a time, so a test can fail any one of
 * them (EACCES, ENOSPC, EBUSY, EXDEV, EIO), change a file between two of them, or kill the process at one. The
 * writer never follows a link: `lstat` is the only way it looks at a path it writes.
 */
export interface ApplyIo {
  /** Null when nothing is there. */
  lstat(path: string): fs.Stats | null;
  /** Follows links: only for the device a folder is on. */
  stat(path: string): fs.Stats;
  /** Fails if anything is there. */
  mkdir(path: string): void;
  rmdir(path: string): void;
  /**
   * Creates a file that mustn't exist (O_EXCL), with exactly `mode`, whatever the umask, and makes it durable; one that
   * can't be written whole is removed again.
   */
  create(path: string, bytes: Uint8Array, mode: number): void;
  read(path: string): Uint8Array;
  /** Within one folder tree on one filesystem: the source is gone, and what was at the target is replaced. */
  rename(from: string, to: string): void;
  /** A hard link, which fails rather than replace anything at `created`. */
  link(existing: string, created: string): void;
  unlink(path: string): void;
  readdir(path: string): string[];
  /** Makes a folder's entries durable. */
  syncDir(path: string): void;
  /**
   * Opens a folder, failing when the last name is a link or isn't a folder: the anchors a change writes through. Only to
   * name files through, so it needs no permission to read the folder (O_PATH), only to pass through it.
   */
  openDir(path: string): number;
  closeDir(fd: number): void;
  /** What a descriptor holds open, by device and inode. */
  statFd(fd: number): fs.Stats;
}

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
/** Linux's own value: Node doesn't name it, and an apply runs only where `/proc` is (`anchors.ts`). */
const O_PATH = 0o10000000;

export const nodeIo: ApplyIo = {
  lstat: (path) => {
    try {
      return fs.lstatSync(path);
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  },
  stat: (path) => fs.statSync(path),
  mkdir: (path) => fs.mkdirSync(path, { mode: 0o755 }),
  rmdir: (path) => fs.rmdirSync(path),
  create: (path, bytes, mode) => {
    const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
    try {
      fs.fchmodSync(fd, mode);
      for (let at = 0; at < bytes.byteLength; ) at += fs.writeSync(fd, bytes, at, bytes.byteLength - at);
      fs.fsyncSync(fd);
    } catch (error) {
      // A file that wasn't written whole isn't left behind: it was made here, and holds nothing anyone else wrote.
      fs.closeSync(fd);
      try {
        fs.unlinkSync(path);
      } catch {
        // Already gone.
      }
      throw error;
    }
    fs.closeSync(fd);
  },
  read: (path) => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  link: (existing, created) => fs.linkSync(existing, created),
  unlink: (path) => fs.unlinkSync(path),
  readdir: (path) => fs.readdirSync(path),
  openDir: (path) => fs.openSync(path, O_PATH | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)),
  closeDir: (fd) => fs.closeSync(fd),
  statFd: (fd) => fs.fstatSync(fd),
  syncDir: (path) => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
};
