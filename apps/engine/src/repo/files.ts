import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import type { Mask } from "@nivra/domain";
import type { ExecutionSession } from "../exec/backend.ts";
import { HIDDEN_WHY, hiddenReason, outputRoot, type HiddenReason } from "./deny.ts";
import { runGit, type GitCall } from "./git.ts";
import { checkRelativePath, isInside, RepoError } from "./paths.ts";

/**
 * Read-only access to one repository for one run (NIV-9, D22), ported from Hird's `projects/repo.ts` @ 45c0057 and
 * adapted:
 * - the root is the folder the person picked, so a project inside a larger repository reads only its own files;
 * - only tracked files are reachable (the list is taken when the run starts), never untracked ones, and never what
 *   the deny rules hide; git runs through the run's execution session;
 * - every file is read as it is on disk at that moment, hashed, and masked whole (line breaks kept) before any line is
 *   picked, so edits during a run are seen and can be reported;
 * - each result says exactly which lines it delivered, so a citation is checked against what the model was shown;
 * - files over 200 KB are never read, and are kept out of searches, so one huge line can't crowd out every other hit.
 */

export const LIMITS = {
  listFiles: 300,
  hiddenFiles: 50,
  searchResults: 50,
  searchPerFile: 5,
  filesWithMore: 20,
  unreadableFiles: 20,
  /** Room for each of a result's side lists, so none can crowd out the main one. */
  sideChars: 2_000,
  readBytes: 200_000,
  readLines: 400,
  lineChars: 400,
  resultChars: 16_000,
  queryChars: 200,
  /** The most tracked files whose size is checked when a run starts. */
  statFiles: 20_000,
} as const;

/**
 * The most characters of exclude pathspecs one search passes to git: a command line is limited (32,767 characters on
 * Windows), and a search that left an exclude out would read a hidden file.
 */
const EXCLUDE_CHARS = process.platform === "win32" ? 24_000 : 100_000;

/** What a result put in front of the model: a file's lines, by number, from bytes with this SHA-256. */
export interface Delivered {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
}

export interface ListFilesResult {
  total: number;
  truncated: boolean;
  hiddenTotal: number;
  hidden: string[];
  files: string[];
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  query: string;
  regex: boolean;
  ignoreCase: boolean;
  truncated: boolean;
  perFileLimit: number;
  filesWithMore: string[];
  unreadable: string[];
  matches: SearchMatch[];
}

export interface ReadFileResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextStartLine: number | null;
  note?: string;
  content: string;
}

interface Loaded {
  path: string;
  lines: string[];
  sha256: string;
}

/** How many characters a string takes inside JSON, escapes included and quotes left out. */
const jsonChars = (text: string): number => JSON.stringify(text).length - 2;

/** The most leading items that fit `budget` characters as the contents of a JSON array. */
function fitItems<T>(items: readonly T[], budget: number): T[] {
  let used = 0;
  let count = 0;
  for (const item of items) {
    used += JSON.stringify(item).length + (count ? 1 : 0);
    if (used > budget) break;
    count++;
  }
  return items.slice(0, count);
}

function checkGlob(glob: string | undefined): string | undefined {
  if (glob === undefined || glob === "") return undefined;
  if (glob.length > 200 || glob.includes("\0") || glob.startsWith("/")) throw new RepoError("That glob isn't valid: use a relative pattern such as src/**/*.ts.");
  return glob;
}

const pageNote = (start: number, end: number, total: number, next: number): string =>
  `Lines ${start}-${end} of ${total} are shown. Call read_file with startLine ${next} for the next page.`;

const kb = (bytes: number) => `${Math.round(bytes / 1000)} KB`;

export interface RepoReaderOptions {
  /** The folder the person picked. */
  root: string;
  session: ExecutionSession;
  git: string;
  mask: Mask;
  signal?: AbortSignal | undefined;
}

export class RepoReader {
  /** The picked folder's real path. */
  readonly root: string;
  readonly readable: ReadonlySet<string>;
  readonly hidden: ReadonlyMap<string, HiddenReason>;
  readonly oversized: ReadonlySet<string>;
  readonly #git: GitCall;
  readonly #mask: Mask;
  readonly #signal: AbortSignal | undefined;
  #excludes: string[] | null = null;

  private constructor(root: string, readable: Set<string>, hidden: Map<string, HiddenReason>, oversized: Set<string>, git: GitCall, mask: Mask, signal: AbortSignal | undefined) {
    this.root = root;
    this.readable = readable;
    this.hidden = hidden;
    this.oversized = oversized;
    this.#git = git;
    this.#mask = mask;
    this.#signal = signal;
  }

  /** Lists the tracked files under the picked folder once, for the run, and notes which are too large to read. */
  static async open(options: RepoReaderOptions): Promise<RepoReader> {
    let root: string;
    try {
      root = await realpath(options.root);
    } catch {
      throw new RepoError(`${options.root} doesn't exist on this target.`);
    }
    const git: GitCall = { session: options.session, git: options.git, cwd: root, signal: options.signal };
    const { stdout, truncated } = await runGit(git, ["ls-files", "-z", "--cached", "--", "."], { maxBytes: 50_000_000, timeoutMs: 30_000 });
    // A cut-off list would also be a cut-off list of hidden files: refuse rather than search with it.
    if (truncated) throw new RepoError("This repository has more tracked files than Nivra can list. Add a smaller folder of it as the project.");
    const readable = new Set<string>();
    const hidden = new Map<string, HiddenReason>();
    for (const path of stdout.split("\0")) {
      if (!path) continue;
      const reason = hiddenReason(path);
      if (reason) hidden.set(path, reason);
      else readable.add(path);
    }
    const oversized = new Set<string>();
    let checked = 0;
    for (const path of readable) {
      if (checked++ >= LIMITS.statFiles) break;
      options.signal?.throwIfAborted();
      try {
        const info = await stat(join(root, path));
        if (info.isFile() && info.size > LIMITS.readBytes) oversized.add(path);
      } catch {
        // Deleted from the working tree: reading it is refused on its own.
      }
    }
    return new RepoReader(root, readable, hidden, oversized, git, options.mask, options.signal);
  }

  /** Builds a result from `count` whole items, dropping one at a time from the end until its masked JSON fits `cap`. */
  #fit<T>(count: number, min: number, build: (count: number) => T, cap: number): T {
    let result = build(count);
    while (count > min && this.#mask(JSON.stringify(result)).length > cap) result = build(--count);
    return result;
  }

  list(input: { glob?: string | undefined; limit?: number | undefined }, cap: number = LIMITS.resultChars): ListFilesResult {
    const glob = checkGlob(input.glob);
    const limit = Math.min(Math.max(input.limit ?? LIMITS.listFiles, 1), LIMITS.listFiles);
    const matches = (paths: Iterable<string>) => [...paths].filter((path) => !glob || posix.matchesGlob(path, glob)).sort();
    const matching = matches(this.readable);
    const matchingHidden = matches(this.hidden.keys());
    const head = { total: matching.length, truncated: false, hiddenTotal: matchingHidden.length, hidden: fitItems(matchingHidden.slice(0, LIMITS.hiddenFiles), LIMITS.sideChars) };
    const fitted = fitItems(matching.slice(0, limit), cap - JSON.stringify({ ...head, files: [] }).length);
    return this.#fit(fitted.length, 0, (count) => ({ ...head, truncated: count < matching.length, files: fitted.slice(0, count) }), cap);
  }

  /**
   * The pathspecs that keep a search away from hidden and oversized files: one literal exclude per secret or oversized
   * file, and one per output folder (`apps/web/dist`), all from `hiddenReason`'s own answers.
   */
  #searchExcludes(): string[] {
    if (this.#excludes) return this.#excludes;
    const specs = new Set<string>();
    for (const [path, reason] of this.hidden) specs.add(`:(exclude,literal)${reason === "output" ? (outputRoot(path) ?? path) : path}`);
    for (const path of this.oversized) specs.add(`:(exclude,literal)${path}`);
    const chars = [...specs].reduce((sum, spec) => sum + spec.length + 1, 0);
    if (chars > EXCLUDE_CHARS) throw new RepoError(`This repository has too many hidden or oversized files (${specs.size}) to search safely. Use list_files and read_file instead.`);
    this.#excludes = [...specs];
    return this.#excludes;
  }

  /**
   * Searches tracked files for a literal string, or a POSIX extended regular expression when `regex` is set (never
   * `-P`). The query goes after `-e`, so it can never be an option. Git only says where the matches are; each hit's text
   * comes from its file as `read_file` would show it, masked, and its file's hash is recorded.
   */
  async search(
    input: { query: string; glob?: string | undefined; limit?: number | undefined; regex?: boolean | undefined; ignoreCase?: boolean | undefined },
    cap: number = LIMITS.resultChars,
  ): Promise<{ result: SearchResult; delivered: Delivered[] }> {
    const query = input.query;
    if (!query || query.length > LIMITS.queryChars || /[\0\n\r]/.test(query)) throw new RepoError(`The query must be one line of 1-${LIMITS.queryChars} characters.`);
    const glob = checkGlob(input.glob);
    const limit = Math.min(Math.max(input.limit ?? LIMITS.searchResults, 1), LIMITS.searchResults);
    const regex = input.regex === true;
    const ignoreCase = input.ignoreCase === true;
    const { stdout, truncated: capped } = await runGit(
      this.#git,
      ["grep", "-n", "-I", "-z", "--no-color", regex ? "-E" : "-F", ...(ignoreCase ? ["-i"] : []), "-e", query, "--", ".", ...this.#searchExcludes()],
      { maxBytes: 1_000_000, okCodes: [1], timeoutMs: 30_000 },
    );
    const records = stdout.split("\n");
    // Output cut at the cap may end mid-record: the last one is dropped rather than misread.
    if (capped) records.pop();
    const matches: SearchMatch[] = [];
    const sources = new Map<string, Loaded | null>();
    const listed = new Map<string, number>();
    const more = new Set<string>();
    const unreadable = new Set<string>();
    let truncated = capped;
    for (const record of records) {
      if (!record) continue;
      const [path, lineNo] = record.split("\0");
      if (!path || !lineNo || !this.readable.has(path) || this.oversized.has(path) || (glob && !posix.matchesGlob(path, glob))) continue;
      this.#signal?.throwIfAborted();
      if (!sources.has(path)) sources.set(path, await this.#load(path).catch((error: unknown) => (error instanceof RepoError ? null : Promise.reject(error))));
      const loaded = sources.get(path);
      if (!loaded) {
        unreadable.add(path);
        continue;
      }
      const masked = loaded.lines[Number(lineNo) - 1];
      if (masked === undefined) continue;
      const count = listed.get(path) ?? 0;
      if (count >= LIMITS.searchPerFile) {
        more.add(path);
        continue;
      }
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      const text = masked.replace(/\r$/, "").trim();
      matches.push({ path, line: Number(lineNo), text: text.length > 200 ? `${text.slice(0, 200)}…` : text });
      listed.set(path, count + 1);
    }
    const head = {
      query,
      regex,
      ignoreCase,
      truncated: false,
      perFileLimit: LIMITS.searchPerFile,
      filesWithMore: fitItems([...more].slice(0, LIMITS.filesWithMore), LIMITS.sideChars),
      unreadable: fitItems([...unreadable].slice(0, LIMITS.unreadableFiles), LIMITS.sideChars),
    };
    const fitted = fitItems(matches, cap - JSON.stringify({ ...head, matches: [] }).length);
    const result = this.#fit(fitted.length, 0, (count) => ({ ...head, truncated: truncated || count < matches.length, matches: fitted.slice(0, count) }), cap);
    const delivered = result.matches.map((match) => ({ path: match.path, startLine: match.line, endLine: match.line, sha256: sources.get(match.path)!.sha256 }));
    return { result, delivered };
  }

  /**
   * Reads whole numbered lines from `startLine`: as many as fit `cap` as JSON, at most `LIMITS.readLines`, never past
   * `endLine`. `delivered` names exactly the lines in the result.
   */
  async read(input: { path: string; startLine?: number | undefined; endLine?: number | undefined }, cap: number = LIMITS.resultChars): Promise<{ result: ReadFileResult; delivered: Delivered }> {
    const { path, lines, sha256 } = await this.#load(input.path);
    const total = Math.max(lines.length, 1);
    const startLine = Math.min(Math.max(input.startLine ?? 1, 1), total);
    const lastAsked = Math.max(startLine, Math.min(input.endLine ?? total, startLine + LIMITS.readLines - 1, total));
    const wanted = Math.min(input.endLine ?? total, total);
    // The room left for content: the cap less the largest envelope this file can have.
    const envelope = JSON.stringify({ path, startLine: total, endLine: total, totalLines: total, nextStartLine: total, note: pageNote(total, total, total, total), content: "" }).length + 4;
    const budget = cap - envelope;
    const page: string[] = [];
    let used = 0;
    for (let n = startLine; n <= lastAsked; n++) {
      const line = (lines[n - 1] ?? "").replace(/\r$/, "");
      const numbered = `${String(n).padStart(5)}| ${line.length > LIMITS.lineChars ? `${line.slice(0, LIMITS.lineChars)}…` : line}`;
      const size = jsonChars(numbered) + (page.length ? 2 : 0);
      // The first line always goes in: a page with no lines could never be continued.
      if (page.length && used + size > budget) break;
      page.push(numbered);
      used += size;
    }
    const build = (count: number): ReadFileResult => {
      const endLine = startLine + count - 1;
      const nextStartLine = endLine < total ? endLine + 1 : null;
      return {
        path,
        startLine,
        endLine,
        totalLines: total,
        nextStartLine,
        ...(nextStartLine !== null && endLine < wanted ? { note: pageNote(startLine, endLine, total, nextStartLine) } : {}),
        content: page.slice(0, count).join("\n"),
      };
    };
    const result = this.#fit(page.length, 1, build, cap);
    return { result, delivered: { path, startLine: result.startLine, endLine: result.endLine, sha256 } };
  }

  /** A whole tracked file, masked, after the same checks as `read` (for the map's manifests), with its hash. */
  async text(path: string): Promise<{ path: string; text: string; lines: number; sha256: string }> {
    const loaded = await this.#load(path);
    return { path: loaded.path, text: loaded.lines.join("\n"), lines: loaded.lines.length, sha256: loaded.sha256 };
  }

  /** The commit checked out now, or null in a repository with no commits yet. Never `git status` (D22). */
  async head(): Promise<string | null> {
    const { stdout } = await runGit(this.#git, ["rev-parse", "--verify", "-q", "HEAD"], { okCodes: [1], maxBytes: 4_096 });
    const head = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  }

  /** A tracked file's size on disk, or null when it can't be read. */
  async size(path: string): Promise<number | null> {
    try {
      return (await stat(join(this.root, checkRelativePath(path)))).size;
    } catch {
      return null;
    }
  }

  /**
   * A tracked file's lines as a model may see them, after every check, and the hash of the bytes they came from.
   * Masking comes before any line is picked: a secret can span lines, and a page that split one would show it.
   */
  async #load(path: string): Promise<Loaded> {
    const requested = checkRelativePath(path);
    const reason = this.hidden.get(requested) ?? hiddenReason(requested);
    if (reason) throw new RepoError(`${requested} ${HIDDEN_WHY[reason]}.`);
    if (!this.readable.has(requested)) throw new RepoError(`${requested} isn't a tracked file here. Untracked files are never read; list_files shows the tracked ones.`);
    let real: string;
    try {
      real = await realpath(join(this.root, requested));
    } catch {
      throw new RepoError(`${requested} isn't in the working tree (it may have been deleted).`);
    }
    if (!isInside(this.root, real)) throw new RepoError(`${requested} points outside the repository, so it isn't read.`);
    const resolved = relative(this.root, real).split(sep).join("/");
    // A link is only as readable as its target: it never exposes a hidden file behind it.
    const resolvedReason = this.hidden.get(resolved) ?? hiddenReason(resolved);
    if (resolvedReason) throw new RepoError(`${requested} points to ${resolved}, which ${HIDDEN_WHY[resolvedReason]}.`);
    if (!this.readable.has(resolved)) throw new RepoError(`${requested} points to a file that isn't tracked, so it isn't read.`);
    const handle = await open(real, "r");
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new RepoError(`${requested} isn't a file.`);
      if (info.size > LIMITS.readBytes) throw new RepoError(`${requested} is ${kb(info.size)}, larger than the ${kb(LIMITS.readBytes)} Nivra reads.`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.includes(0)) throw new RepoError(`${requested} is a binary file.`);
    const text = bytes.toString("utf8");
    const masked = this.#mask(text, { keepLines: true });
    const lines = masked.split("\n");
    // A mask that changed the line count would shift every line after it, and every citation with it.
    if (lines.length !== text.split("\n").length) throw new RepoError(`${requested} couldn't be masked line by line, so it isn't read.`);
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    return { path: requested, lines, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}
