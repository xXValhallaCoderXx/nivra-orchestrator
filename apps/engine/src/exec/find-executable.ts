import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, posix, win32 } from "node:path";

const isExecutable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** Folders searched before PATH's. */
  extraDirs?: readonly string[];
  /** Skips a candidate (e.g. a stub that only offers to install the real program). */
  reject?: (candidate: string) => boolean;
}

/**
 * Where a program is, as an absolute path, looked up in PATH's absolute folders only, so it is never found in a
 * repository's own folder (Windows tries the current folder first). On Windows only `<name>.exe` matches: batch
 * shims are not started (D9). Null when there is none. Generalised from Hird's `findGit` (provenance.md).
 */
export function findOnPath(name: string, options: FindOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? isExecutable;
  const pathDelimiter = platform === "win32" ? ";" : platform === process.platform ? delimiter : ":";
  const raw = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const absolute = (dir: string) => (platform === "win32" ? win32.isAbsolute(dir) : dir.startsWith("/"));
  const dirs = [...(options.extraDirs ?? []), ...raw.split(pathDelimiter).filter((dir) => dir && absolute(dir))];
  const file = platform === "win32" ? `${name}.exe` : name;
  const join = platform === "win32" ? win32.join : posix.join;
  for (const dir of dirs) {
    const candidate = join(dir, file);
    if (!exists(candidate)) continue;
    if (options.reject?.(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Git as an absolute path (from Hird's `findGit`). On macOS Homebrew's folders are searched too (an app opened from
 * Finder gets a minimal PATH), and `/usr/bin/git` is skipped when it is only Apple's installer stub.
 */
export function findGit(options: FindOptions & { hasCommandLineTools?: () => boolean } = {}): string | null {
  const platform = options.platform ?? process.platform;
  const commandLineTools = options.hasCommandLineTools ?? (() => spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }).status === 0);
  return findOnPath("git", {
    ...options,
    extraDirs: platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [],
    reject: (candidate) => platform === "darwin" && candidate === "/usr/bin/git" && !commandLineTools(),
  });
}
