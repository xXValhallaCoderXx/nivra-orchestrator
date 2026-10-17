import { isAbsolute, posix, relative, sep, win32 } from "node:path";

/** A request the repository tools refuse; the message goes back to the model and says why. */
export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}

/**
 * Whether `path` lies inside `root` (both resolved), built on `relative()` (AGENTS.md); false for the root itself.
 * Ported from Hird's `projects/repo.ts` @ 45c0057.
 */
export function isInside(root: string, path: string, paths: { relative: typeof relative; isAbsolute: typeof isAbsolute; sep: string } = { relative, isAbsolute, sep }): boolean {
  const rel = paths.relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
}

export const isInsideWin32 = (root: string, path: string): boolean => isInside(root, path, win32);

/** A model-given path as a repository-relative POSIX path, or a refusal. Absolute, drive and `..` paths never pass. */
export function checkRelativePath(input: string): string {
  if (!input || input.length > 500 || input.includes("\0") || /^[\\/]/.test(input) || isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw new RepoError("That isn't a path inside the repository. Use a path relative to it, as list_files shows.");
  }
  const normalised = posix.normalize(input.replaceAll("\\", "/"));
  if (normalised === ".." || normalised.startsWith("../") || normalised.split("/").includes("..")) throw new RepoError("Paths must stay inside the repository.");
  return normalised.replace(/^\.\//, "");
}

/** What a repository's file name may not hold where Nivra writes it out for a model: control or invisible characters. */
export const NOT_ONE_VISIBLE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
