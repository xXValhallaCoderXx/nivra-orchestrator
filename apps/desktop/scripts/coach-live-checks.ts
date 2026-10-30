import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !rel.split(sep)[0]!.startsWith("completion-")) throw new Error(`Use a new completion-* folder inside ${root}; historical evidence is kept as it is.`);
  ordinaryPath(state);
  return state;
}

const evidenceError = () => new Error("Coach evidence needs ordinary, unlinked folders and files. Use a new completion-* folder; historical evidence is kept as it is.");

/** Check existing ancestors too, including dangling links, before reading or writing evidence. */
function ordinaryPath(path: string, output = false): void {
  const parent = dirname(path);
  if (parent !== path) ordinaryPath(parent);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || (output ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()))) throw evidenceError();
}

export function coachOutput(state: string, name: string): string {
  const path = resolve(state, name);
  const rel = relative(state, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw evidenceError();
  ordinaryPath(path, true);
  return path;
}

/** Never truncate an existing output until its opened descriptor proves it is an unlinked ordinary file. */
export function writeCoachOutput(state: string, name: string, value: string | Uint8Array): void {
  const descriptor = openSync(coachOutput(state, name), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw evidenceError();
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, value);
  } finally { closeSync(descriptor); }
}
