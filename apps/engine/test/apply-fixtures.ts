import { createHash } from "node:crypto";
import { cpSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { nodeIo } from "../src/apply/io.ts";
import type { PlannedPath, RevalidatedPlan } from "../src/apply/plan.ts";
import { stateOf } from "../src/apply/writer.ts";
import { byBytes } from "../src/exec/workspace-rules.ts";
import { tempDir } from "./helpers.ts";
import { repoWith } from "./workspace-fixtures.ts";

/**
 * A disposable repository and a change to apply to it (NIV-8, D40), for the apply tests that need many fresh copies:
 * one changed executable, one changed plain file, and one file added two new folders deep.
 */
export const APPLY_FILES = { "greet.sh": { executable: "greet() {\n  printf 'Hello, %s\\n' \"$1\"\n}\n" }, "README.md": "# Greet\n", "docs/old.md": "old\n" };
export const APPLY_CHANGE: Record<string, { text: string; executable?: boolean }> = {
  "greet.sh": { text: "greet() {\n  printf 'Hello, %s\\n' \"${1:-world}\"\n}\n" },
  "README.md": { text: "# Greet\n\nSays hello.\n" },
  "notes/2026/today.md": { text: "Fixed the default name.\n" },
};

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A plan as revalidation gives it, worked out from the checkout: each path's state now, its new bytes, the folders. */
export function planFor(root: string, changes: Record<string, { text: string; executable?: boolean }> = APPLY_CHANGE): RevalidatedPlan {
  const folder = realpathSync.native(root);
  const paths = Object.entries(changes)
    .map(([path, change]): PlannedPath => {
      const pre = stateOf(nodeIo, join(folder, path));
      const bytes = new TextEncoder().encode(change.text);
      const mode = change.executable ? "100755" : pre.kind === "file" ? pre.mode! : "100644";
      return { path, change: pre.kind === "absent" ? "added" : "changed", pre, post: { mode, size: bytes.byteLength, sha256: sha256(bytes) }, bytes };
    })
    .sort((a, b) => byBytes(a.path, b.path));
  const folders = new Set<string>();
  for (const one of paths) {
    const parts = one.path.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) {
      const name = parts.slice(0, depth).join("/");
      if (!existsSync(join(folder, name))) folders.add(name);
    }
  }
  return { folder, topLevel: folder, gitDir: realpathSync.native(join(folder, ".git")), folders: [...folders].sort(byBytes), paths };
}

/** Fresh copies of one fixture repository, quicker than making each with git; each one's parent goes in `dirs`. */
export function copies(dirs: string[]): () => string {
  const template = repoWith(APPLY_FILES);
  return () => {
    const parent = tempDir();
    dirs.push(parent);
    const root = join(parent, "repo ü%#");
    cpSync(template, root, { recursive: true, preserveTimestamps: true });
    return root;
  };
}
