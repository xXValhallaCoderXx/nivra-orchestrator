import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Check every existing ancestor, including dangling links. A missing leaf is permitted; no link is followed. */
export function missionEvidencePath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  for (;;) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (current !== absolute && stat && !stat.isDirectory())) throw new Error("A mission acceptance directory or output path is linked or not an ordinary folder. Choose fresh ordinary paths; historical evidence is kept as it is.");
    const parent = dirname(current);
    if (parent === current) return absolute;
    current = parent;
  }
}
