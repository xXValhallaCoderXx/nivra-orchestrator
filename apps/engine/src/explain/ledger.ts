import type { Delivered } from "../repo/files.ts";

/**
 * Everything a run delivered to the model (D22): the map's sources, search hits and reads, each with the step it was
 * delivered in and the hash of the bytes it came from. Never content. Citations are checked against it, and it is
 * what the result shows as the context used.
 */

export type LedgerKind = "map" | "search" | "read";

export interface LedgerEntry {
  step: number;
  kind: LedgerKind;
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
}

export interface ContextUsed {
  map: Array<{ path: string; sha256: string }>;
  reads: Array<{ path: string; ranges: Array<[number, number]>; sha256: string[] }>;
  /** The lines search results showed, by file, whether or not the file was read or cited. */
  hits: Array<{ path: string; ranges: Array<[number, number]>; sha256: string[] }>;
  searches: number;
  searchHits: number;
  /** Characters delivered, after masking: the map and every tool result. */
  chars: number;
  /** Characters of the map alone, as sent (D23). */
  mapChars: number;
  /** Files seen with more than one hash: they changed while the run read them. */
  changedFiles: string[];
}

export class Ledger {
  readonly entries: LedgerEntry[] = [];
  #searches = 0;
  #chars = 0;
  #mapChars = 0;

  record(step: number, kind: LedgerKind, delivered: readonly Delivered[], chars: number): void {
    for (const item of delivered) this.entries.push({ step, kind, path: item.path, startLine: item.startLine, endLine: item.endLine, sha256: item.sha256 });
    if (kind === "search") this.#searches++;
    if (kind === "map") this.#mapChars += chars;
    this.#chars += chars;
  }

  /** Counts a tool result that delivered no lines (a listing, a refusal), so the totals stay right. */
  count(chars: number): void {
    this.#chars += chars;
  }

  changedFiles(): string[] {
    const hashes = new Map<string, Set<string>>();
    for (const entry of this.entries) {
      const set = hashes.get(entry.path) ?? new Set<string>();
      set.add(entry.sha256);
      hashes.set(entry.path, set);
    }
    return [...hashes.entries()].filter(([, set]) => set.size > 1).map(([path]) => path).sort();
  }

  context(): ContextUsed {
    return {
      map: this.entries.filter((e) => e.kind === "map").map((e) => ({ path: e.path, sha256: e.sha256 })),
      reads: this.#byFile("read"),
      hits: this.#byFile("search"),
      searches: this.#searches,
      searchHits: this.entries.filter((e) => e.kind === "search").length,
      chars: this.#chars,
      mapChars: this.#mapChars,
      changedFiles: this.changedFiles(),
    };
  }

  /** What one kind of tool delivered, by file: the lines, joined into ranges, and every hash they came from. */
  #byFile(kind: LedgerKind): Array<{ path: string; ranges: Array<[number, number]>; sha256: string[] }> {
    const files = new Map<string, { ranges: Array<[number, number]>; sha256: Set<string> }>();
    for (const entry of this.entries.filter((e) => e.kind === kind)) {
      const file = files.get(entry.path) ?? { ranges: [], sha256: new Set<string>() };
      file.ranges.push([entry.startLine, entry.endLine]);
      file.sha256.add(entry.sha256);
      files.set(entry.path, file);
    }
    return [...files.entries()].map(([path, file]) => ({ path, ranges: mergeRanges(file.ranges), sha256: [...file.sha256] }));
  }
}

/** Overlapping or touching ranges joined, in order. */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...ranges].map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
