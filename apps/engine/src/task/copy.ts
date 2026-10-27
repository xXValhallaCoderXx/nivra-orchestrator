import { createHash } from "node:crypto";
import { WorkspaceRefusal } from "../exec/git-tool.ts";
import { findChanges, isGenerated, type Collected, type CollectedEntry } from "../exec/patch.ts";
import type { Snapshot } from "../exec/snapshot.ts";
import { byBytes, snapshotPathProblem } from "../exec/workspace-rules.ts";

/**
 * The engine's own copy of a task's workspace (NIV-7, D39): the snapshot, plus every write the worker made that the
 * sandbox was seen to keep. The worker's reads are served from it, on this computer, costing no operation. Only the
 * engine's write tool changes the sandbox's workspace, so after collect the sandbox must hold exactly this copy: any
 * other difference means something changed that Nivra didn't write, and nothing is proposed.
 */

type Node = { kind: "file"; bytes: Uint8Array; executable: boolean; sha256: string } | { kind: "link"; target: string };

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const quoted = (path: string) => JSON.stringify(path.length > 120 ? `${path.slice(0, 117)}...` : path);

/** A search stops counting here, so one over a large workspace stays cheap; `capped` says it stopped. */
export const SEARCH_COUNT_MAX = 10_000;

/** One search result: a path, or a line of one with its number. */
export interface SearchMatch {
  path: string;
  line?: number;
  text?: string;
}

/** A line as a search shows it: whole when it fits, or `max` characters around the match, marked where it was cut. */
function excerpt(line: string, at: number, length: number, max: number): string {
  const clean = line.replace(/\r$/, "");
  if (clean.length <= max) return clean;
  const start = Math.max(0, Math.min(at - Math.floor((max - length) / 2), clean.length - max));
  return `${start > 0 ? "..." : ""}${clean.slice(start, start + max)}${start + max < clean.length ? "..." : ""}`;
}

export class WorkspaceCopy {
  readonly snapshot: Snapshot;
  readonly #nodes = new Map<string, Node>();
  /** Paths the worker wrote, in the order it first wrote them. */
  readonly written: string[] = [];

  constructor(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const file of snapshot.files) {
      this.#nodes.set(file.path, file.kind === "link" ? { kind: "link", target: new TextDecoder().decode(file.bytes) } : { kind: "file", bytes: file.bytes, executable: file.mode === "100755", sha256: sha256(file.bytes) });
    }
  }

  /** Every path, sorted by its bytes, optionally under one folder. */
  paths(folder = ""): string[] {
    const prefix = folder.replace(/\/+$/, "");
    return [...this.#nodes.keys()].filter((path) => prefix === "" || path.startsWith(`${prefix}/`)).sort(byBytes);
  }

  has(path: string): boolean {
    return this.#nodes.has(path);
  }

  /** A file's text, or why it can't be read: not there, a link, or not text. */
  text(path: string): { text: string } | { refused: string } {
    const node = this.#nodes.get(path);
    if (!node) return { refused: `There's no file at ${quoted(path)}. list_files shows the paths there are.` };
    if (node.kind === "link") return { refused: `${quoted(path)} is a link, which this task can't read or write.` };
    if (node.bytes.includes(0)) return { refused: `${quoted(path)} isn't text, so it isn't shown.` };
    try {
      return { text: strictUtf8.decode(node.bytes) };
    } catch {
      return { refused: `${quoted(path)} isn't UTF-8 text, so it isn't shown.` };
    }
  }

  /**
   * The paths that hold `text`, or the lines that do, compared without regard to case, under `folder` when it is given:
   * the snapshot and the worker's own writes, nothing else (NIV-35). Lines are looked for only in UTF-8 text files;
   * links and other files are counted as skipped. At most `max` matches come back, each line cut to `lineChars`
   * characters around the match; `total` counts every match, up to `SEARCH_COUNT_MAX`.
   */
  search(text: string, where: "names" | "content", folder: string, max: number, lineChars: number): { matches: SearchMatch[]; total: number; capped: boolean; skipped: number } {
    const wanted = text.toLowerCase();
    const matches: SearchMatch[] = [];
    let total = 0;
    let skipped = 0;
    const found = (match: SearchMatch) => {
      total++;
      if (matches.length < max) matches.push(match);
    };
    for (const path of this.paths(folder)) {
      if (total >= SEARCH_COUNT_MAX) break;
      if (where === "names") {
        if (path.toLowerCase().includes(wanted)) found({ path });
        continue;
      }
      const read = this.text(path);
      if ("refused" in read) {
        skipped++;
        continue;
      }
      const lines = read.text.split("\n");
      for (let index = 0; index < lines.length && total < SEARCH_COUNT_MAX; index++) {
        const at = lines[index]!.toLowerCase().indexOf(wanted);
        if (at >= 0) found({ path, line: index + 1, text: excerpt(lines[index]!, at, wanted.length, lineChars) });
      }
    }
    return { matches, total, capped: total >= SEARCH_COUNT_MAX, skipped };
  }

  /**
   * Why a write of `bytes` to `path` can't be made, or null when it can: the path must be a plain one the commit could
   * hold, through no link and at no folder, and the change, as it would stand with this write, must pass every rule a
   * proposal is held to (D34), so a write that could never be proposed is never sent.
   */
  writeProblem(path: string, bytes: Uint8Array, knownValues: readonly string[] = []): string | null {
    const basic = snapshotPathProblem(path);
    if (basic) return `${quoted(path)} can't be written: ${basic}`;
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const above = this.#nodes.get(parts.slice(0, depth).join("/"));
      if (above?.kind === "link") return `${quoted(path)} is under a link, which this task can't write through`;
      if (above) return `${quoted(path)} is under ${quoted(parts.slice(0, depth).join("/"))}, which is a file`;
    }
    const node = this.#nodes.get(path);
    if (node?.kind === "link") return `${quoted(path)} is a link, which this task can't write`;
    if (!node && this.paths(path).length) return `${quoted(path)} is a folder`;
    // Collect leaves output folders out, and a patch leaves new generated files out: such a write would never be proposed.
    if (!node && isGenerated(path, this.snapshot.prefix ? `${this.snapshot.prefix}/${path}` : path)) return `${quoted(path)} is dependency, build or generated output, which a change leaves out`;
    try {
      findChanges(this.snapshot, this.#collected(path, bytes), { knownValues });
    } catch (error) {
      if (error instanceof WorkspaceRefusal) return error.message.replace(/^Nivra won't propose this change: /, "").replace(/\.$/, "");
      throw error;
    }
    return null;
  }

  /** Records a write the sandbox was seen to keep, byte for byte. */
  record(path: string, bytes: Uint8Array): void {
    const node = this.#nodes.get(path);
    this.#nodes.set(path, { kind: "file", bytes, executable: node?.kind === "file" ? node.executable : false, sha256: sha256(bytes) });
    if (!this.written.includes(path)) this.written.push(path);
  }

  /** The workspace as collect should find it: every file and link, as `checkCollected` gives them. */
  entries(): CollectedEntry[] {
    return this.paths().map((path): CollectedEntry => {
      const node = this.#nodes.get(path)!;
      return node.kind === "link" ? { path, kind: "link", target: node.target } : { path, kind: "file", executable: node.executable, bytes: node.bytes, sha256: node.sha256 };
    });
  }

  /**
   * Refuses a collected result that isn't exactly this copy: a file added, removed or changed that the engine didn't
   * write, or a mode it didn't set. The first difference is named.
   */
  checkIntegrity(collected: Collected): void {
    const line = (entry: CollectedEntry) => (entry.kind === "link" ? `l ${entry.target} ${entry.path}` : `f ${entry.executable ? "x" : "-"} ${entry.sha256} ${entry.path}`);
    const expected = new Map(this.entries().map((entry) => [entry.path, line(entry)]));
    const got = new Map(collected.entries.map((entry) => [entry.path, line(entry)]));
    const differs = [...new Set([...expected.keys(), ...got.keys()])].sort(byBytes).find((path) => expected.get(path) !== got.get(path));
    if (differs !== undefined) {
      const how = !got.has(differs) ? "is missing from it" : !expected.has(differs) ? "is in it, and Nivra didn't write it" : "differs from what Nivra wrote";
      throw new WorkspaceRefusal(`The sandbox's result isn't the commit plus the worker's checked writes: ${quoted(differs)} ${how}. No change was proposed.`, "result");
    }
  }

  /** The workspace as a collected result, with `path` written: what findChanges would see if collect ran after the write. */
  #collected(path: string, bytes: Uint8Array): Collected {
    const node = this.#nodes.get(path);
    const entries = this.entries().filter((entry) => entry.path !== path);
    entries.push({ path, kind: "file", executable: node?.kind === "file" ? node.executable : false, bytes, sha256: sha256(bytes) });
    entries.sort((a, b) => byBytes(`./${a.path}`, `./${b.path}`));
    return { entries, archiveSha256: "", listingSha256: "" };
  }
}
