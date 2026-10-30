import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const coachHash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const coachDigest = (value: unknown): string => coachHash(JSON.stringify(value));

/** Sorted relative names and bytes bind additions and removals as well as edits. No linked folder is followed. */
export function coachFiles(root: string, names?: string[]): { count: number; sha256: string } {
  const files = names ?? readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
  const rows = [...new Set(files)].sort().map((name) => {
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || lstatSync(path).isSymbolicLink()) throw new Error("A frozen file must be an ordinary file inside its source folder.");
    return [rel, coachHash(readFileSync(path))];
  });
  return { count: rows.length, sha256: coachDigest(rows) };
}

/** Acceptance state is separate from old NIV-53 evidence and every repository/worktree. */
export function coachState(path: string, home: string): string {
  const state = resolve(path);
  const root = join(home, "nivra-acceptance", "niv53");
  const rel = relative(root, state);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || !rel.split(sep)[0]!.startsWith("completion-")) throw new Error(`Use a new completion-* folder inside ${root}; historical evidence is kept as it is.`);
  return state;
}
