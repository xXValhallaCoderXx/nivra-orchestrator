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
  /** Creates a file that mustn't exist (O_EXCL), with exactly `mode`, whatever the umask, and makes it durable. */
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
}

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

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
    } finally {
      fs.closeSync(fd);
    }
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
  syncDir: (path) => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
};
