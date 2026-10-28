/**
 * A proposal's patch, file by file, for the Changes list (NIV-56, G3: P1i). The engine writes it with git diff-tree,
 * `--no-renames` and `--binary`, so each file section starts with its `diff --git` line. Paths are matched against the
 * proposal's own list first; a section only the patch names keeps the name its header gives. Nothing is guessed: a binary
 * section says so, and a section the cut at PATCH_SHOWN_BYTES ends in is marked cut, its counts only for the part shown.
 */

export interface DiffLine {
  kind: "added" | "removed" | "context" | "hunk" | "note";
  text: string;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Git wrote a binary patch for it, which isn't shown. */
  binary: boolean;
  /** The patch shown ends inside this file's section: what's here is only its start. */
  cut: boolean;
}

/** Undoes git's C-style quoting of a path ("a/\303\251.txt"), byte escapes decoded as UTF-8. */
function unquote(quoted: string): string {
  if (!quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let at = 0; at < body.length; at++) {
    const char = body[at]!;
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = body[at + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(at + 1, at + 4), 8));
      at += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      at += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path a `---` or `+++` line names, without its prefix; null for /dev/null. */
function sidePath(line: string, prefix: "a/" | "b/"): string | null {
  const named = unquote(line.slice(4).replace(/\t$/, ""));
  if (named === "/dev/null") return null;
  return named.startsWith(prefix) ? named.slice(prefix.length) : named;
}

/** The files of a patch, in its order, each with its lines and counts. */
export function diffFilesOf(patch: string, known: readonly string[], truncated: boolean): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let inHunks = false;
  const lines = patch.split("\n");
  // A patch ends with a newline: the empty string after it isn't a line.
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const header = line.slice("diff --git ".length);
      const path = known.find((one) => header === `a/${one} b/${one}`) ?? header;
      file = { path, lines: [], added: 0, removed: 0, binary: false, cut: false };
      files.push(file);
      inHunks = false;
      continue;
    }
    if (file === null) continue;
    if (!inHunks) {
      if (line.startsWith("@@")) {
        inHunks = true;
        file.lines.push({ kind: "hunk", text: line });
      } else if (line.startsWith("GIT binary patch") || (line.startsWith("Binary files ") && line.endsWith(" differ"))) {
        file.binary = true;
      } else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
        // The header couldn't be matched to a known path: the side lines name it.
        if (!known.includes(file.path)) file.path = sidePath(line, line.startsWith("+++ ") ? "b/" : "a/") ?? file.path;
      }
      continue;
    }
    if (line.startsWith("@@")) file.lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) {
      file.lines.push({ kind: "added", text: line.slice(1) });
      file.added += 1;
    } else if (line.startsWith("-")) {
      file.lines.push({ kind: "removed", text: line.slice(1) });
      file.removed += 1;
    } else if (line.startsWith("\\")) file.lines.push({ kind: "note", text: line.slice(1).trim() });
    else file.lines.push({ kind: "context", text: line.slice(1) });
  }
  if (truncated && files.length) files.at(-1)!.cut = true;
  return files;
}
