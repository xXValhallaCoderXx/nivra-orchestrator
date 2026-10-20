import { NOT_ONE_VISIBLE_LINE } from "../repo/paths.ts";

/**
 * The path rules for what goes into a sandbox and what comes back from one (NIV-42, D34).
 * - **A commit's own paths** must be safe to write anywhere Nivra writes them: no control or invisible character (a
 *   newline would break the sandbox's listing), no `.`, `..` or empty component, and no `.git`, whatever its case or
 *   short name. Crafted trees can hold any of these.
 * - **A path a change adds or changes** must also hold on every target a checkout may live on. It may not have a
 *   backslash, a character Windows forbids, a trailing dot or space, a name Windows reserves, or the shape of a
 *   Windows short name. A path the commit already holds is never refused for these, so a repository's own `aux.c`
 *   doesn't refuse every run.
 */

export const MAX_PATH_BYTES = 1_024;
const MAX_COMPONENT_BYTES = 255;
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");
/** `.git`, with the trailing dots and spaces NTFS ignores, or its NTFS short names. */
const GIT_NAME = /^(\.git[. ]*|git~\d+)$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*\\]/;

/** Why a commit's own path can't go into a sandbox, or null when it can. */
export function snapshotPathProblem(path: string): string | null {
  if (path === "") return "it is empty";
  if (NOT_ONE_VISIBLE_LINE.test(path)) return "it holds a control or invisible character";
  if (bytesOf(path) > MAX_PATH_BYTES) return `it is over ${MAX_PATH_BYTES} bytes`;
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return part === ".." ? "it has a .. component" : "it has an empty or . component";
    if (bytesOf(part) > MAX_COMPONENT_BYTES) return `a part of it is over ${MAX_COMPONENT_BYTES} bytes`;
    if (GIT_NAME.test(part)) return "it has a .git component";
  }
  return null;
}

/** Why a path a change adds or changes can't be proposed, or null when it can. */
export function proposedPathProblem(path: string): string | null {
  const basic = snapshotPathProblem(path);
  if (basic) return basic;
  for (const part of path.split("/")) {
    if (WINDOWS_FORBIDDEN.test(part)) return `"${part}" holds a character Windows forbids in a name`;
    if (/[. ]$/.test(part)) return `"${part}" ends with a dot or a space, which Windows drops`;
    if (WINDOWS_RESERVED.test(part)) return `"${part}" is a name Windows reserves`;
    if (/~\d+$/.test(part.split(".")[0] ?? "")) return `"${part}" has the shape of a Windows short name`;
  }
  return null;
}

/** Git's own files: a change to one would change how the repository is read, so a proposal may not touch them. */
export function isGitControlFile(path: string): boolean {
  return /(^|\/)\.(gitmodules|gitattributes|lfsconfig)$/i.test(path);
}

/** The key two paths share when a filesystem that ignores case, or normalises Unicode, would make them one. */
export const caseKey = (path: string) => path.normalize("NFC").toLowerCase();

/** A path's UTF-8 bytes, for sorting as `LC_ALL=C sort` and git do. */
export const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
