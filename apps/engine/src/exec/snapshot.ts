import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { KEY_HEADER, secretShapes } from "@nivra/domain";
import { hiddenReason } from "../repo/deny.ts";
import { isInside } from "../repo/paths.ts";
import type { ExecutionSession, SessionSnapshot } from "./backend.ts";
import { runGitBytes, WorkspaceRefusal, type GitTool, type PhaseDeadline } from "./git-tool.ts";
import { listingDigest, type ListingEntry } from "./nebius/session.ts";
import { writeTar, type TarEntry } from "./tar.ts";
import { byBytes, caseKey, snapshotPathProblem } from "./workspace-rules.ts";

/**
 * A snapshot of one commit, to send into a sandbox (NIV-42, D34). It is made by the engine that owns the checkout's
 * filesystem, from the commit's own objects, never from the working tree, and it never writes the checkout.
 *
 * - **The baseline** is HEAD, as a full id. A baseline given by the caller must equal it.
 * - **Uncommitted work** in the picked folder:
 *   - tracked changes, staged or not, refuse the snapshot with guidance, and so do files git is told not to look at
 *     (assume-unchanged, skip-worktree);
 *   - untracked files are left out, counted and named (bounded);
 *   - nothing is staged, stashed, discarded or silently included.
 *
 *   The check is one `git status`, with every filter driver the configuration names switched off. D34 supersedes
 *   D22's "no git status" line for this check only. A split index is refused first: git refreshes its shared file's
 *   time whenever it reads the index.
 * - **Reading the commit safely:**
 *   - `ls-tree` lists the picked folder's subtree, and `cat-file --batch` gives exact blob bytes, with no filters and no
 *     line-ending conversion. Paths are read as bytes: one that isn't UTF-8 refuses the snapshot;
 *   - a partial clone is refused, since a missing object would be fetched;
 *   - remotes, lazy fetches and replace refs are switched off (`GIT_SAFE_ENV`).
 * - **Before anything is sent:**
 *   - the included paths are checked, and the picked folder's own path;
 *   - left out, and counted by reason: secret-named paths and dependency or build output (by the shared deny rules,
 *     against the path in the folder and in the repository), submodules, and folders the caller excludes (the engine
 *     home, if it sits inside the repository);
 *   - every included file's content is scanned, text or binary, for credential shapes, private keys and the vault's
 *     own values, in UTF-16 and inside base64 too (a vault value by its encodings, however the encoding was broken up).
 *     An unsafe snapshot is refused, never redacted. The refusal names the path and the kind of credential, never the
 *     value;
 *   - over the limits, a snapshot is refused, never truncated.
 * - **What it gives:**
 *   - one tar of the files and links (`tar.ts`), its sha256, and the digest of the listing the sandbox's prepare step
 *     prints (`listingDigest`);
 *   - a manifest of every file;
 *   - a fingerprint over all of it and the baseline.
 */

export interface SnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  /** All the included files' content. */
  maxBytes: number;
  /** The archive, headers included: no more than the sandbox session takes. */
  maxArchiveBytes: number;
}

export const SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({ maxFiles: 4_000, maxFileBytes: 2 * 1024 * 1024, maxBytes: 6 * 1024 * 1024, maxArchiveBytes: 8 * 1024 * 1024 });

/** The oldest git with every command and flag snapshots and patches use (`status --no-renames` came last, in 2.18). */
export const MIN_GIT: readonly [number, number] = [2, 18];
/** How many paths a count names, at most. */
const SAMPLE = 10;

export interface SnapshotFile {
  /** Relative to the picked folder, POSIX. */
  path: string;
  kind: "file" | "link";
  mode: "100644" | "100755" | "120000";
  blob: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface Counted {
  count: number;
  /** Relative to the picked folder. */
  sample: string[];
}

export interface Snapshot {
  /** The picked folder, as it really is. */
  folder: string;
  /** The repository's top level, as it really is, and the picked folder's path inside it ("" at the top). */
  topLevel: string;
  prefix: string;
  baseline: string;
  objectFormat: "sha1" | "sha256";
  /** Every included file and link, sorted by its path's bytes. */
  files: SnapshotFile[];
  leftOut: { secret: Counted; output: Counted; submodule: Counted; excluded: Counted };
  /** Every path left out, whatever the reason, sorted by its bytes: a change may not collide with one. */
  leftOutPaths: string[];
  /** The submodules and the excluded folders inside the picked folder: a change may add nothing at or under one. */
  submodules: string[];
  excludedFolders: string[];
  untracked: Counted;
  /** Files that are Git LFS pointers: they go as pointers, and a change may not edit them. */
  lfsPointers: Counted;
  /** What the sandbox session takes. */
  archive: SessionSnapshot;
  fingerprint: string;
}

export interface SnapshotOptions {
  /** The picked folder, in the owning engine's own path form. */
  folder: string;
  /** A session on the target, for the engine's own git (Local). */
  session: ExecutionSession;
  git: string;
  /** When given, it must equal HEAD. */
  baseline?: string;
  /** Folders whose files are never included (the engine home), wherever they are. */
  exclude?: readonly string[];
  /** The vault's own values: a file holding one refuses the snapshot. */
  knownValues?: readonly string[];
  limits?: Partial<SnapshotLimits>;
  signal?: AbortSignal;
  /** One deadline for all of the snapshot's git commands. */
  deadline?: PhaseDeadline;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const short = (id: string) => id.slice(0, 12);
const counted = (): Counted => ({ count: 0, sample: [] });
const add = (counter: Counted, path: string) => {
  counter.count++;
  if (counter.sample.length < SAMPLE) counter.sample.push(path);
};
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";
// A leading byte-order mark is part of a name, so it is kept.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** UTF-8 that must be exact, or null. */
function exactly(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** git's one line of output, its last newline taken off: the line itself may hold others. */
const oneLine = (bytes: Uint8Array, what: string): string => {
  const text = exactly(bytes);
  if (text === null) throw new WorkspaceRefusal(`${what} isn't valid UTF-8, so Nivra won't send from it. Rename it, then try again.`, "path");
  return text.replace(/\n$/, "");
};

/** Whether a file is a Git LFS pointer: its first line names the LFS spec. */
export const isLfsPointer = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, LFS_POINTER.length)).toString("latin1") === LFS_POINTER;

/** Credential shapes in words a person reads. */
const SHAPE_WORDS: Readonly<Record<string, string>> = {
  "private-key": "a private key",
  "aws-access-key": "an AWS access key",
  "github-token": "a GitHub token",
  "github-fine-grained-token": "a GitHub token",
  "api-key": "an API key",
  "slack-token": "a Slack token",
  "linear-token": "a Linear token",
  "tavily-key": "a Tavily API key",
};
/** A private key's first line is enough before an upload: a key cut short, or its last line missing, still counts. */
const KEY_START = new RegExp(KEY_HEADER);
const PGP_KEY = /-----BEGIN PGP PRIVATE KEY BLOCK-----/;
/** Long runs of base64, as Kubernetes secrets and the like wrap keys and tokens. */
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
/** Whether a character is whitespace as a regular expression's `\s` has it, by a table for the first 256. */
const SPACES = Uint8Array.from({ length: 256 }, (_, code) => (/\s/.test(String.fromCharCode(code)) ? 1 : 0));
const isSpace = (code: number) => (code < 256 ? SPACES[code] === 1 : /\s/.test(String.fromCharCode(code)));

/**
 * `text` without what can break an encoding up without being part of it: spaces and line breaks, escaped line breaks
 * (`\n` in JSON or a notebook's output), a shell's line continuation, string literals joined by `+` or `,`, and the
 * backslash of JSON's escaped `/`. Base64 holds none of them, so taking them out joins a broken encoding up and splits
 * none.
 *
 * It takes out what `/\\\r?\n|\\[nrt]|\\(?=\/)|["']\s*[+,]?\s*["']|\s+/g` matches, in one pass. That expression
 * backtracked over every split of a long run of spaces after a quote, so a file of 128 KB took seconds, and the scan
 * blocks the engine (the review of PR 8). The quotes' join can match only one way: the most spaces, at most one `+` or
 * `,`, the most spaces, then a quote. So it is found by reading forward once, in time linear in the text.
 */
export function withoutBreaks(text: string): string {
  const length = text.length;
  const spacesFrom = (from: number) => {
    let at = from;
    while (at < length && isSpace(text.charCodeAt(at))) at++;
    return at;
  };
  const parts: string[] = [];
  let copied = 0;
  let at = 0;
  while (at < length) {
    const code = text.charCodeAt(at);
    // Where the break starting here ends, or -1 when none does.
    let end = -1;
    if (code === 0x5c) {
      // A backslash: a line continuation, an escaped n, r or t, or the backslash alone before a `/`.
      const next = text.charCodeAt(at + 1);
      if (next === 0x0a) end = at + 2;
      else if (next === 0x0d && text.charCodeAt(at + 2) === 0x0a) end = at + 3;
      else if (next === 0x6e || next === 0x72 || next === 0x74) end = at + 2;
      else if (next === 0x2f) end = at + 1;
    } else if (code === 0x22 || code === 0x27) {
      // A quote, then spaces, at most one `+` or `,` with spaces after it, and a quote.
      let close = spacesFrom(at + 1);
      if (text.charCodeAt(close) === 0x2b || text.charCodeAt(close) === 0x2c) close = spacesFrom(close + 1);
      const last = text.charCodeAt(close);
      if (last === 0x22 || last === 0x27) end = close + 1;
    } else if (isSpace(code)) {
      end = spacesFrom(at);
    }
    if (end < 0) {
      at++;
      continue;
    }
    parts.push(text.slice(copied, at));
    copied = end;
    at = end;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}
/** A vault value shorter than this isn't looked for inside base64: what its encoding holds of it could match by chance. */
const MIN_ENCODED_VALUE_BYTES = 12;

/**
 * The parts of a value's base64 encodings that don't depend on the bytes around it. Every 4 characters encode 3 bytes,
 * so for each of the 3 places the value can start in a group, the groups holding a byte before it or after it are left
 * out. Each comes in UTF-8 and UTF-16LE (as PowerShell encodes a command), in base64 and its URL-safe form.
 */
function encodedCores(value: string): string[] {
  if (Buffer.byteLength(value, "utf8") < MIN_ENCODED_VALUE_BYTES) return [];
  const cores: string[] = [];
  for (const bytes of [Buffer.from(value, "utf8"), Buffer.from(value, "utf16le")]) {
    for (let offset = 0; offset < 3; offset++) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
      const core = encoded.slice(offset === 0 ? 0 : 4, 4 * Math.floor((offset + bytes.length) / 3));
      cores.push(core, core.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return cores;
}

/** Every long run of base64 in `text`, decoded, one character a byte. */
const decodedRuns = (text: string): string[] => [...text.matchAll(BASE64_RUN)].map((run) => Buffer.from(run[0], "base64").toString("latin1"));

function shapesIn(text: string): string[] {
  const kinds = secretShapes(text).map((shape) => SHAPE_WORDS[shape] ?? "a credential");
  if (KEY_START.test(text) || PGP_KEY.test(text)) kinds.push("a private key");
  return kinds;
}

/** The text of a UTF-16 file, one that starts with its byte-order mark or has a zero in every other byte, or null. */
function utf16Text(buffer: Buffer): string | null {
  const little = (bytes: Buffer) => bytes.subarray(0, bytes.length - (bytes.length % 2)).toString("utf16le");
  const big = (bytes: Buffer) => little(Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2))).swap16());
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return little(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return big(buffer.subarray(2));
  const pairs = Math.min(256, Math.floor(buffer.length / 2));
  if (pairs < 2) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let pair = 0; pair < pairs; pair++) {
    if (buffer[2 * pair] === 0) evenZeros++;
    if (buffer[2 * pair + 1] === 0) oddZeros++;
  }
  if (oddZeros >= pairs * 0.9 && evenZeros <= pairs * 0.1) return little(buffer);
  if (evenZeros >= pairs * 0.9 && oddZeros <= pairs * 0.1) return big(buffer);
  return null;
}

/**
 * The credential kinds `bytes` looks like it holds, in words, with the vault's own values; empty when none. Detection
 * is by pattern, so it can't recognise every secret (D22). It reads the bytes as they are (latin1 gives one character a
 * byte, so text and binary alike), as UTF-16 when they look like it, and inside every long run of base64: each line's,
 * and the file's joined up where an encoding was broken across lines or strings.
 *
 * The vault's values are known exactly, so they are also looked for by their encodings: wherever one sits in what was
 * encoded, however short the run, however the encoding was broken up, and inside one more layer of base64.
 */
export function credentialKinds(bytes: Uint8Array, knownValues: readonly string[] = []): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wide = utf16Text(buffer);
  const texts = [buffer.toString("latin1"), ...(wide === null ? [] : [wide])];
  const joined = texts.map(withoutBreaks);
  const decoded = [...new Set([...texts, ...joined].flatMap(decodedRuns))];
  // Not in the joined text itself: joining words up can make a shape, as "ASIA" and an uppercase word do.
  const kinds = [...texts, ...decoded].flatMap(shapesIn);
  const known = knownValues.filter((value) => value.length > 0);
  if (known.length > 0) {
    // One layer down too: a registry's auth is base64 inside a dockerconfigjson secret's base64.
    const searched = [...joined, ...decoded.map(withoutBreaks)];
    const holds = (value: string) => {
      const raw = Buffer.from(value, "utf8");
      const latin = raw.toString("latin1");
      return buffer.includes(raw) || (wide !== null && wide.includes(value)) || decoded.some((text) => text.includes(latin)) || encodedCores(value).some((core) => searched.some((text) => text.includes(core)));
    };
    if (known.some(holds)) kinds.push("a value Nivra keeps as a secret");
  }
  return [...new Set(kinds)];
}

/** The git on this target, or a refusal naming the version it needs. */
async function checkGitVersion(tool: GitTool): Promise<void> {
  const said = (await runGitBytes(tool, ["--version"])).text.trim();
  const version = /(\d+)\.(\d+)/.exec(said);
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) throw new WorkspaceRefusal(`Snapshots need git ${MIN_GIT.join(".")} or newer, and this target has ${said.slice(0, 60) || "an unknown version"}. Update git, then try again.`, "git-version");
}

/**
 * Whether an index file is split (it has a `link` extension), read from its bytes, never by git: git refreshes a split
 * index's shared file whenever it reads the index, so reading one would change `.git`.
 */
export function indexIsSplit(bytes: Uint8Array, hashBytes: number): boolean {
  const unreadable = () => new WorkspaceRefusal("Nivra can't read this checkout's index, so it can't tell what changed. Run `git status` there to see what's wrong, then try again.", "repository");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - hashBytes;
  if (end < 12 || Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "DIRC") throw unreadable();
  const version = view.getUint32(4);
  if (version < 2 || version > 4) throw unreadable();
  const fixed = 40 + hashBytes + 2;
  let offset = 12;
  for (let left = view.getUint32(8); left > 0; left--) {
    const start = offset;
    if (offset + fixed > end) throw unreadable();
    const extended = version >= 3 && (view.getUint16(offset + 40 + hashBytes) & 0x4000) !== 0;
    offset += fixed + (extended ? 2 : 0);
    // Version 4 names begin with a varint: how much of the name before to keep.
    if (version === 4) {
      while (offset < end && (bytes[offset]! & 0x80) !== 0) offset++;
      offset++;
    }
    const nul = bytes.indexOf(0, offset);
    if (nul < 0 || nul >= end) throw unreadable();
    // Up to version 3, an entry's NULs pad it to a multiple of eight bytes.
    offset = version === 4 ? nul + 1 : start + ((nul - start + 8) & ~7);
  }
  for (; offset + 8 <= end; offset += 8 + view.getUint32(offset + 4)) {
    if (Buffer.from(bytes.subarray(offset, offset + 4)).toString("latin1") === "link") return true;
  }
  return false;
}

/**
 * Refuses a picked folder with tracked changes, and gives what is untracked in it, relative to it:
 * - a split index is refused before git reads it;
 * - so are files git is told not to look at, since their changes don't show;
 * - `git status` runs with every filter driver the configuration names switched off (no command, and none
 *   required), and with fsmonitor and optional locks off (`GIT_PINS`, `GIT_ENV`), so it runs nothing the repository
 *   configures and writes nothing.
 */
async function checkUncommitted(tool: GitTool, prefix: string, hashBytes: number): Promise<Counted> {
  const index = resolve(tool.cwd, oneLine((await runGitBytes(tool, ["rev-parse", "--git-path", "index"])).bytes, "The repository's git folder"));
  let names: string[] = [];
  try {
    names = readdirSync(dirname(index));
  } catch {
    // No git folder to look in means no index to read.
  }
  if (names.some((name) => name.startsWith("sharedindex."))) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = readFileSync(index);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (bytes && indexIsSplit(bytes, hashBytes)) throw new WorkspaceRefusal("This checkout uses a split index, and git changes a file in .git whenever it reads one, so Nivra won't check it. Run `git update-index --no-split-index` there, then try again.", "repository");
  }

  const tagged = await runGitBytes(tool, ["ls-files", "-v", "-z", "--", "."], { maxBytes: 64 * 1024 * 1024 });
  // `h` and the other lower-case tags mark assume-unchanged files, and `S` skip-worktree ones.
  const skipped = tagged.text.split("\0").filter((record) => record.length > 1 && (record[0] === "S" || (record[0] !== record[0]!.toUpperCase() && record[1] === " "))).length;
  if (skipped) {
    throw new WorkspaceRefusal(`${plural(skipped, "file")} in this folder ${skipped === 1 ? "is" : "are"} marked for git not to look at (assume-unchanged or skip-worktree, as a sparse checkout does), so Nivra can't tell whether ${skipped === 1 ? "it" : "they"} changed. Clear the marks with \`git update-index --no-assume-unchanged\` or \`--no-skip-worktree\`, then try again.`, "uncommitted");
  }

  const listed = await runGitBytes(tool, ["config", "-z", "--name-only", "--get-regexp", "^filter\\."], { okCodes: [1] });
  const drivers = new Set<string>();
  for (const record of splitRecords(listed.bytes)) {
    const name = exactly(record);
    if (name === null) throw new WorkspaceRefusal("A filter driver in this repository's git configuration has a name that isn't valid UTF-8, so Nivra can't switch it off safely and won't check the checkout. Rename it, then try again.", "repository");
    const rest = name.slice("filter.".length);
    const dot = rest.lastIndexOf(".");
    // `filter.<key>` alone names no driver.
    if (dot < 0) continue;
    const driver = rest.slice(0, dot);
    if (driver === "" || driver.includes("=")) throw new WorkspaceRefusal(`A filter driver in this repository's git configuration has a name Nivra can't switch off safely (${JSON.stringify(driver).slice(0, 80)}), so it won't check the checkout. Rename it, then try again.`, "repository");
    drivers.add(driver);
  }
  const config = [...drivers].flatMap((driver) => ["-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.smudge=`, "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.required=false`]);
  const status = await runGitBytes({ ...tool, config }, ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=all", "--no-renames", "--", "."], { maxBytes: 16 * 1024 * 1024 });
  const untracked = counted();
  let tracked = 0;
  for (const record of status.text.split("\0").filter(Boolean)) {
    // Porcelain paths are relative to the top level, whatever the folder.
    if (record.startsWith("? ")) add(untracked, prefix ? record.slice(2 + prefix.length + 1) : record.slice(2));
    else if (/^[12u] /.test(record)) tracked++;
  }
  if (tracked > 0) throw new WorkspaceRefusal(`Your checkout has uncommitted changes in ${plural(tracked, "file")}. Nivra works from a commit. Commit or stash them, then try again.`, "uncommitted");
  return untracked;
}

/** NUL-terminated records, as bytes. */
function splitRecords(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  for (let start = 0; start < bytes.byteLength; ) {
    const nul = bytes.indexOf(0, start);
    const end = nul < 0 ? bytes.byteLength : nul;
    if (end > start) records.push(bytes.subarray(start, end));
    start = end + 1;
  }
  return records;
}

interface TreeEntry {
  mode: string;
  type: string;
  blob: string;
  size: number;
  /** Relative to the top level. */
  path: string;
}

/**
 * `ls-tree -r -z -l` records: mode, type, id, size (`-` for a submodule), and the path after a tab. Each is read as
 * bytes, and a path that isn't UTF-8 refuses the snapshot: read any other way, it would be renamed.
 */
function parseTree(bytes: Uint8Array): TreeEntry[] {
  return splitRecords(bytes).map((bytes) => {
    const record = exactly(bytes);
    if (record === null) {
      const path = lossyUtf8.decode(bytes).split("\t").slice(1).join("\t");
      throw new WorkspaceRefusal(`The commit holds a path that isn't valid UTF-8 (${JSON.stringify(path).slice(0, 120)}), so Nivra won't send this folder. Rename it in a new commit, then try again.`, "path");
    }
    const match = /^(\d{6}) (\S+) ([0-9a-f]+) +(\S+)\t([\s\S]*)$/.exec(record);
    if (!match) throw new WorkspaceRefusal("git ls-tree gave a line Nivra can't read, so no snapshot was made.", "git");
    return { mode: match[1]!, type: match[2]!, blob: match[3]!, size: match[4] === "-" ? 0 : Number(match[4]), path: match[5]! };
  });
}

/** The commit's blobs, in order, from one `cat-file --batch`: exact bytes, no filters. A missing one is a refusal. */
async function readBlobs(tool: GitTool, wanted: ReadonlyArray<TreeEntry & { rel: string }>, totalBytes: number): Promise<Uint8Array[]> {
  const stdin = new TextEncoder().encode(`${wanted.map((entry) => entry.blob).join("\n")}\n`);
  const { bytes } = await runGitBytes(tool, ["cat-file", "--batch"], { stdin, maxBytes: totalBytes + wanted.length * 160 + 4_096, timeoutMs: 120_000 });
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const entry of wanted) {
    const end = bytes.indexOf(0x0a, offset);
    const header = lossyUtf8.decode(bytes.subarray(offset, end < 0 ? undefined : end));
    if (end < 0 || header.endsWith(" missing")) throw new WorkspaceRefusal(`The commit's files aren't all in this repository (${entry.rel} is missing). Fetch the whole history, then try again.`, "repository");
    const [blob, type, size] = header.split(" ");
    if (blob !== entry.blob || type !== "blob" || Number(size) !== entry.size) throw new WorkspaceRefusal(`git cat-file gave something other than ${entry.rel}'s content, so no snapshot was made.`, "git");
    blobs.push(bytes.slice(end + 1, end + 1 + entry.size));
    offset = end + 1 + entry.size + 1;
  }
  return blobs;
}

/** An excluded folder against the top level: "all" when it holds the repository, its POSIX path inside, or null. */
function placeOf(topLevel: string, path: string): string | null {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  if (real === topLevel || isInside(real, topLevel)) return "all";
  return isInside(topLevel, real) ? relative(topLevel, real).split(sep).join("/") : null;
}

export async function takeSnapshot(options: SnapshotOptions): Promise<Snapshot> {
  const limits: SnapshotLimits = { ...SNAPSHOT_LIMITS, ...options.limits };
  const folder = realpathSync.native(options.folder);
  const tool: GitTool = { session: options.session, git: options.git, cwd: folder, signal: options.signal, deadline: options.deadline };
  await checkGitVersion(tool);
  // One line each, its last newline taken off: a folder's name may hold a newline itself.
  const topLevel = realpathSync.native(oneLine((await runGitBytes(tool, ["rev-parse", "--show-toplevel"])).bytes, "The repository's folder name"));
  const prefix = oneLine((await runGitBytes(tool, ["rev-parse", "--show-prefix"])).bytes, "The picked folder's name").replace(/\/$/, "");
  const prefixProblem = prefix ? snapshotPathProblem(prefix) : null;
  if (prefixProblem) throw new WorkspaceRefusal(`The picked folder's path in the repository can't be sent (${prefixProblem}). Rename it, or pick a folder whose path is plain, then try again.`, "path");
  const partial = await runGitBytes(tool, ["config", "--get", "extensions.partialClone"], { okCodes: [1] });
  const promisors = await runGitBytes(tool, ["config", "--bool", "--get-regexp", "^remote\\..*\\.promisor$"], { okCodes: [1] });
  if (partial.exitCode === 0 || promisors.text.split("\n").some((line) => line.endsWith(" true"))) {
    throw new WorkspaceRefusal("This repository is a partial clone: some of its files are fetched only when they are read, which would reach the network. Clone it in full, then try again.", "repository");
  }
  const head = await runGitBytes(tool, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { okCodes: [1] });
  const baseline = head.text.trim();
  if (head.exitCode !== 0 || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(baseline)) throw new WorkspaceRefusal("This repository has no commits yet, so there is nothing to work from. Commit your files, then try again.", "no-commits");
  const objectFormat = baseline.length === 64 ? "sha256" : "sha1";
  if (options.baseline !== undefined && options.baseline !== baseline) throw new WorkspaceRefusal(`Your checkout has moved to another commit (HEAD is ${short(baseline)}, not ${short(options.baseline)}). Start again from the commit it is on now.`, "baseline-moved");
  const excluded = (options.exclude ?? []).map((path) => placeOf(topLevel, path)).filter((place): place is string => place !== null);
  const isUnder = (path: string, folderPath: string) => caseKey(path) === caseKey(folderPath) || caseKey(path).startsWith(`${caseKey(folderPath)}/`);
  if (excluded.some((place) => place === "all" || (prefix !== "" && isUnder(prefix, place)))) throw new WorkspaceRefusal("The folder you picked is inside Nivra's own data folder, so Nivra won't send it. Pick a folder outside it.", "engine-home");
  const untracked = await checkUncommitted(tool, prefix, objectFormat === "sha256" ? 32 : 20);

  const listed = await runGitBytes(tool, ["ls-tree", "-r", "-z", "-l", "--full-tree", baseline, ...(prefix ? ["--", `${prefix}/`] : [])], { maxBytes: 64 * 1024 * 1024 });
  const leftOut = { secret: counted(), output: counted(), submodule: counted(), excluded: counted() };
  const leftOutPaths: string[] = [];
  const leave = (counter: Counted, rel: string) => {
    add(counter, rel);
    leftOutPaths.push(rel);
  };
  const submodules: string[] = [];
  const excludedFolders = excluded.filter((place) => prefix === "" || isUnder(place, prefix)).map((place) => (prefix ? place.slice(prefix.length + 1) : place));
  const wanted: Array<TreeEntry & { rel: string }> = [];
  const tree = parseTree(listed.bytes);
  for (const entry of tree) {
    const rel = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
    if (entry.mode === "160000") {
      leave(leftOut.submodule, rel);
      submodules.push(rel);
      continue;
    }
    if (excluded.some((place) => isUnder(entry.path, place))) {
      leave(leftOut.excluded, rel);
      continue;
    }
    // Both ways: `.ssh/config` is a secret even when `.ssh` is the picked folder.
    const hidden = [hiddenReason(rel), hiddenReason(entry.path)];
    const reason = hidden.includes("secret") ? "secret" : hidden.includes("output") ? "output" : null;
    if (reason) {
      leave(leftOut[reason], rel);
      continue;
    }
    const problem = snapshotPathProblem(rel);
    if (problem) throw new WorkspaceRefusal(`The commit holds a path Nivra won't send (${JSON.stringify(rel).slice(0, 120)}: ${problem}). Rename it in a new commit, then try again.`, "path");
    if (!(entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755" || entry.mode === "100664" || entry.mode === "120000"))) throw new WorkspaceRefusal(`The commit holds ${rel} as a ${entry.type} of mode ${entry.mode}, which Nivra doesn't send.`, "path");
    wanted.push({ ...entry, rel });
  }
  if (!wanted.length) {
    const why = tree.length ? `every committed file in it is left out (${plural(tree.length, "file")})` : "it has no committed files";
    throw new WorkspaceRefusal(`There is nothing in this folder to send: ${why}. Commit the files to work on, then try again.`, "nothing-to-send");
  }
  if (wanted.length > limits.maxFiles) throw new WorkspaceRefusal(`The folder's commit holds ${wanted.length} files to send, over the ${limits.maxFiles} a sandbox run takes. Pick a smaller folder, then try again.`, "limit");
  const big = wanted.find((entry) => entry.size > limits.maxFileBytes);
  if (big) throw new WorkspaceRefusal(`${big.rel} is ${big.size} bytes, over the ${limits.maxFileBytes} Nivra sends for one file. Leave it out of the folder, then try again.`, "limit");
  const total = wanted.reduce((sum, entry) => sum + entry.size, 0);
  if (total > limits.maxBytes) throw new WorkspaceRefusal(`The folder's files come to ${total} bytes, over the ${limits.maxBytes} a sandbox run takes. Pick a smaller folder, then try again.`, "limit");
  const blobs = await readBlobs(tool, wanted, total);

  const files: SnapshotFile[] = wanted.map((entry, index) => {
    const bytes = blobs[index]!;
    return { path: entry.rel, kind: entry.mode === "120000" ? "link" : "file", mode: entry.mode === "100755" ? "100755" : entry.mode === "120000" ? "120000" : "100644", blob: entry.blob, size: entry.size, sha256: sha256(bytes), bytes };
  });
  files.sort((a, b) => byBytes(a.path, b.path));

  // Nothing unsafe leaves this machine: credential shapes and the vault's own values, in any file, text or binary.
  const unsafe: string[] = [];
  const lfsPointers = counted();
  for (const file of files) {
    const kinds = credentialKinds(file.bytes, options.knownValues);
    if (kinds.length) unsafe.push(`${file.path} in this commit holds what looks like ${kinds.join(" and ")}`);
    if (file.kind === "file" && isLfsPointer(file.bytes)) add(lfsPointers, file.path);
  }
  if (unsafe.length) {
    const more = unsafe.length > 3 ? ` (and ${plural(unsafe.length - 3, "more file")})` : "";
    throw new WorkspaceRefusal(`${unsafe.slice(0, 3).join("; ")}${more}, so Nivra won't upload it. Remove it from the commit (and replace the key if it's real), then try again.`, "content");
  }

  const listing: ListingEntry[] = [];
  const entries: TarEntry[] = [];
  for (const file of files) {
    if (file.kind === "link") {
      const target = exactly(file.bytes);
      if (target === null) throw new WorkspaceRefusal(`${file.path} is a link whose target isn't valid UTF-8, so Nivra won't send it.`, "path");
      if (target === "" || /\p{Cc}/u.test(target)) throw new WorkspaceRefusal(`${file.path} is a link whose target is empty or holds a control character, so Nivra won't send it.`, "path");
      listing.push({ path: file.path, kind: "link", target });
      entries.push({ path: file.path, kind: "link", target });
    } else {
      listing.push({ path: file.path, kind: "file", executable: file.mode === "100755", sha256: file.sha256 });
      entries.push({ path: file.path, kind: "file", executable: file.mode === "100755", bytes: file.bytes });
    }
  }
  const archive = writeTar(entries);
  if (archive.byteLength > limits.maxArchiveBytes) throw new WorkspaceRefusal(`The folder's snapshot comes to ${archive.byteLength} bytes, over the ${limits.maxArchiveBytes} a sandbox run takes. Pick a smaller folder, then try again.`, "limit");
  const fingerprint = sha256(
    JSON.stringify({
      version: 1,
      baseline,
      objectFormat,
      prefix,
      files: files.map((file) => [file.path, file.mode, file.size, file.sha256]),
      leftOut: { secret: leftOut.secret.count, output: leftOut.output.count, submodule: leftOut.submodule.count, excluded: leftOut.excluded.count },
      leftOutDigest: sha256(leftOutPaths.sort(byBytes).join("\n")),
    }),
  );
  return {
    folder,
    topLevel,
    prefix,
    baseline,
    objectFormat,
    files,
    leftOut,
    leftOutPaths,
    submodules,
    excludedFolders,
    untracked,
    lfsPointers,
    archive: { archive, sha256: sha256(archive), listingDigest: listingDigest(listing).digest },
    fingerprint,
  };
}
