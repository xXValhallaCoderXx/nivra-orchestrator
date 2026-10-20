import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { hiddenReason, OUTPUT_DIRS } from "../repo/deny.ts";
import { ExecRefusedError, type ExecRequest, type ExecutionSession } from "./backend.ts";
import { runGitBytes, WorkspaceCancelled, WorkspaceRefusal, type GitTool } from "./git-tool.ts";
import { credentialKinds, isLfsPointer, type Counted, type Snapshot, type SnapshotFile } from "./snapshot.ts";
import { readTar, TarRefusal, type TarLimits } from "./tar.ts";
import { byBytes, caseKey, isGitControlFile, proposedPathProblem } from "./workspace-rules.ts";

/**
 * What comes back from a sandbox, as a patch the engine has checked (NIV-42, D34, D15). Nothing here writes the
 * person's checkout: applying a patch is NIV-8's.
 *
 * - **Collecting.** A fixed, persisted command writes, outside the workspace, one archive of the workspace (dependency
 *   and build output left out) and an independent listing of the same files. The archive must match the listing
 *   exactly, so a file the archiver skipped can never be taken for a deletion. Both are read back with their digests.
 * - **What changed** is worked out against the snapshot's manifest. Deletions are only of manifest paths. New files of
 *   generated output are left out and listed.
 * - **Validation**, of added and changed paths only, so a repository's own `aux.c` or `README`/`readme` pair never
 *   refuses a run. Each problem is a refusal in plain words:
 *   - a new path no target could hold (`proposedPathProblem`), or one at or under a submodule or an excluded folder;
 *   - git's own files (`.gitmodules`, `.gitattributes`, `.lfsconfig`), added, changed or deleted;
 *   - links: never added, retargeted or retyped (a link may be deleted); hard links, devices and pipes never;
 *   - secrets: the shared deny rules on every added or changed path, so a new `.env` is refused whatever it holds, and
 *     credential shapes or the vault's values in new content, named by kind;
 *   - Git LFS pointers: never edited, deleted or added;
 *   - names that a filesystem ignoring case or Unicode form would make one, when either is new;
 *   - line endings, as the repository's `.gitattributes` says: with `text` (or `eol`), no CRLF; with `text=auto`, no
 *     CRLF in a text file, unless the commit's copy had them; with nothing said, an edit keeps the commit's style and a
 *     new file uses one style. Bytes are never converted;
 *   - over the limits.
 * - **The patch** is built and checked in an engine-made bare object store that holds nothing of the repository and
 *   reads none of anyone's configuration, the person's or the system's. The repository is only read, with `cat-file`.
 *   - One `git fast-import` stream makes two trees: B, the snapshot's files at their paths in the repository with the
 *     `.gitattributes` files above the picked folder, and R, B with the change, with explicit modes and deletions.
 *     The patch touches only changed paths, so it is the patch against the baseline commit itself.
 *   - `diff-tree --binary --full-index` gives the patch between B and R, as bytes.
 *   - B is read into a temporary index, the patch is applied there (`apply --cached`), and the written tree must be R.
 *
 *   No untrusted name touches disk, and no repository code runs.
 */

export const RESULT_ARCHIVE = "/nivra/result.tar";
export const RESULT_LISTING = "/nivra/result-listing";

/** Dependency and build output: never collected, as a snapshot never holds it. */
const PRUNE = OUTPUT_DIRS.map((name) => `-type d -name ${name} -prune -o`).join(" ");

/**
 * The collect step: a fixed script, given everything as positional arguments. $1 the workspace, $2 the archive, $3
 * what runs the tools (busybox), $4 the listing. It lists every file, link and anything else under the workspace,
 * output folders left out, sorted by bytes; archives exactly that list; and prints the listing's line count, the
 * listing's digest and the archive's digest.
 */
export const COLLECT_SCRIPT = [
  "set -e",
  'bb="$3"',
  'cd "$1"',
  `$bb find . ${PRUNE} ! -type d -print > "$4.paths"`,
  'LC_ALL=C $bb sort "$4.paths" > "$4.sorted"',
  ': > "$4"',
  "while IFS= read -r p; do",
  '  if [ -L "$p" ]; then',
  '    printf \'l %s %s\\n\' "$($bb readlink "$p")" "$p" >> "$4"',
  '  elif [ -f "$p" ]; then',
  '    printf \'f %s %s\\n\' "$($bb sha256sum < "$p" | $bb cut -d \' \' -f 1)" "$p" >> "$4"',
  "  else",
  '    printf \'o %s\\n\' "$p" >> "$4"',
  "  fi",
  'done < "$4.sorted"',
  'if [ -s "$4.sorted" ]; then $bb tar -c -f "$2" -T "$4.sorted"; else $bb dd if=/dev/zero of="$2" bs=512 count=2 2>/dev/null; fi',
  '$bb rm -f "$4.paths" "$4.sorted"',
  'echo "entries $($bb wc -l < "$4")"',
  'echo "listing $($bb sha256sum < "$4" | $bb cut -d \' \' -f 1)"',
  'echo "archive $($bb sha256sum < "$2" | $bb cut -d \' \' -f 1)"',
].join("\n");

export interface CollectLimits extends TarLimits {
  /** The listing, read back. The archive is read back up to `maxBytes`. */
  maxListingBytes: number;
}

export const COLLECT_LIMITS: Readonly<CollectLimits> = Object.freeze({ maxEntries: 10_000, maxBytes: 16 * 1024 * 1024, maxEntryBytes: 4 * 1024 * 1024, maxPathBytes: 1_024, maxListingBytes: 4 * 1024 * 1024 });

export type CollectedEntry = { path: string; kind: "file"; executable: boolean; bytes: Uint8Array; sha256: string } | { path: string; kind: "link"; target: string };

export interface Collected {
  /** Every file and link in the workspace, output folders left out, sorted by `./<path>`'s bytes. */
  entries: CollectedEntry[];
  archiveSha256: string;
  listingSha256: string;
}

/** The collect step, persisted, so its archive and listing can be read from the image it leaves. */
export function collectRequest(workspace: string, options: { applets?: string; timeoutMs?: number } = {}): ExecRequest {
  return {
    argv: ["/bin/sh", "-c", COLLECT_SCRIPT, "nivra-collect", workspace, RESULT_ARCHIVE, options.applets ?? "/bin/busybox", RESULT_LISTING],
    cwd: workspace,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputBytes: 4_096,
    persist: true,
    label: "collect",
  };
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const ordered = (a: { path: string }, b: { path: string }) => byBytes(`./${a.path}`, `./${b.path}`);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const listingLine = (entry: CollectedEntry) => (entry.kind === "link" ? `l ${entry.target} ./${entry.path}\n` : `f ${entry.sha256} ./${entry.path}\n`);

/**
 * The collect step's output and its two files, checked against each other: the digests it printed, then every line of
 * the listing against the archive. Anything other than files, folders and links is refused, by its path.
 */
export function checkCollected(stdout: string, archive: { bytes: Uint8Array; sha256: string }, listing: { bytes: Uint8Array; sha256: string }, limits: TarLimits = COLLECT_LIMITS): Collected {
  // One line each; `wc` may pad its count.
  const said = [/^entries\s+(\d+)$/m, /^listing ([0-9a-f]{64})$/m, /^archive ([0-9a-f]{64})$/m].map((line) => line.exec(stdout)?.[1]);
  if (said.some((value) => value === undefined)) throw new WorkspaceRefusal("The sandbox's collect step didn't print what it should have, so no change was proposed.");
  if (sha256(archive.bytes) !== archive.sha256 || sha256(listing.bytes) !== listing.sha256 || archive.sha256 !== said[2] || listing.sha256 !== said[1]) {
    throw new WorkspaceRefusal("What was read back from the sandbox isn't what its collect step wrote (a digest differs), so no change was proposed.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(listing.bytes);
  } catch {
    throw new WorkspaceRefusal("The workspace holds a name that isn't valid UTF-8, so no change was proposed.");
  }
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  if (text !== "" && !text.endsWith("\n")) throw new WorkspaceRefusal("The sandbox's listing was cut short, so no change was proposed.");
  if (lines.length !== Number(said[0])) throw new WorkspaceRefusal("The sandbox's listing doesn't hold the number of lines its collect step counted, so no change was proposed.");
  const other = lines.filter((line) => line.startsWith("o ./")).map((line) => line.slice("o ./".length));
  if (other.length) throw new WorkspaceRefusal(`The workspace holds ${JSON.stringify(other[0]).slice(0, 120)}${other.length > 1 ? ` and ${plural(other.length - 1, "more")}` : ""}, which is neither a file, a folder nor a link (a device, a pipe or a socket), so no change was proposed.`);
  let read;
  try {
    read = readTar(archive.bytes, limits);
  } catch (error) {
    if (error instanceof TarRefusal) throw new WorkspaceRefusal(`The sandbox's result can't be taken: ${error.message.replace(/\.$/, "")}, so no change was proposed.`);
    throw error;
  }
  const entries: CollectedEntry[] = read
    .flatMap((entry): CollectedEntry[] => (entry.kind === "dir" ? [] : entry.kind === "link" ? [{ path: entry.path, kind: "link", target: entry.target }] : [{ path: entry.path, kind: "file", executable: entry.executable, bytes: entry.bytes, sha256: sha256(entry.bytes) }]))
    .sort(ordered);
  const expected = entries.map(listingLine).join("");
  if (expected !== text) {
    const archived = new Set(entries.map(listingLine));
    const listed = new Set(lines.map((line) => `${line}\n`));
    const first = [...listed].find((line) => !archived.has(line)) ?? [...archived].find((line) => !listed.has(line)) ?? "";
    const path = first.slice(first.indexOf(" ./") + 3, -1);
    throw new WorkspaceRefusal(`The sandbox's archive doesn't match its listing (${JSON.stringify(path).slice(0, 120)} differs), so a file it skipped can't be taken for a deletion. No change was proposed.`);
  }
  return { entries, archiveSha256: archive.sha256, listingSha256: listing.sha256 };
}

/** Runs the collect step in `session` and reads its archive and listing back, checked against each other. */
export async function collectResult(session: ExecutionSession, options: { workspace: string; applets?: string; timeoutMs?: number; limits?: Partial<CollectLimits>; signal?: AbortSignal }): Promise<Collected> {
  const limits: CollectLimits = { ...COLLECT_LIMITS, ...options.limits };
  if (!session.download) throw new WorkspaceRefusal("This execution session can't hand files back, so the result can't be collected.");
  const ran = await session.exec({ ...collectRequest(options.workspace, options), ...(options.signal ? { signal: options.signal } : {}) });
  if (ran.cancelled) throw new WorkspaceCancelled();
  if (ran.timedOut || ran.exitCode !== 0 || !ran.persisted) {
    const why = ran.timedOut ? "it ran out of time" : ran.exitCode !== 0 ? `it exited ${String(ran.exitCode)}${ran.stderr.trim() ? `: ${ran.stderr.trim().split("\n").at(-1)!.slice(0, 200)}` : ""}` : "its files weren't kept";
    throw new WorkspaceRefusal(`The sandbox couldn't collect its result (${why}), so no change was proposed.`);
  }
  try {
    const archive = await session.download(RESULT_ARCHIVE, limits.maxBytes);
    const listing = await session.download(RESULT_LISTING, limits.maxListingBytes);
    return checkCollected(ran.stdout, archive, listing, limits);
  } catch (error) {
    if (error instanceof ExecRefusedError) throw new WorkspaceRefusal(`The sandbox's result couldn't be read back (${error.message.replace(/\.$/, "")}), so no change was proposed.`);
    throw error;
  }
}

export interface PatchPolicy {
  /** Bound into every proposal: a change to these rules is a new version. */
  version: number;
  maxChangedFiles: number;
  maxFileBytes: number;
  maxPatchBytes: number;
}

export const PATCH_POLICY: Readonly<PatchPolicy> = Object.freeze({ version: 1, maxChangedFiles: 500, maxFileBytes: 2 * 1024 * 1024, maxPatchBytes: 8 * 1024 * 1024 });

/** New generated output, besides dependency and build output: left out of a change and listed. */
const GENERATED_DIRS = new Set(["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const GENERATED_NAMES = /^(\.ds_store|thumbs\.db|.*\.pyc|.*\.pyo|.*\.tsbuildinfo)$/;

/** Whether a new file is generated output: under a dependency or build folder, or a cache or a compiled file. */
export function isGenerated(rel: string, full: string): boolean {
  if (hiddenReason(rel) === "output" || hiddenReason(full) === "output") return true;
  const segments = rel.toLowerCase().split("/");
  return segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment)) || GENERATED_NAMES.test(segments.at(-1) ?? "");
}

export interface Change {
  /** Relative to the picked folder. */
  path: string;
  kind: "added" | "changed";
  mode: "100644" | "100755";
  bytes: Uint8Array;
  sha256: string;
  /** The commit's copy, for a change. */
  before?: SnapshotFile;
}

export interface ChangeSet {
  /** Manifest paths the result no longer holds, sorted: a report lists them first. */
  deleted: string[];
  added: Change[];
  /** Content, mode or both. */
  changed: Change[];
  modeChanges: Array<{ path: string; from: string; to: string }>;
  /** New generated output, left out. */
  generated: Counted;
}

/** Up to five problems, as one refusal. */
function refuseFor(problems: readonly string[]): void {
  if (!problems.length) return;
  const more = problems.length > 5 ? ` (and ${plural(problems.length - 5, "more problem")})` : "";
  throw new WorkspaceRefusal(`Nivra won't propose this change: ${problems.slice(0, 5).join("; ")}${more}.`);
}

const quoted = (path: string) => JSON.stringify(path.length > 120 ? `${path.slice(0, 117)}...` : path);
const isUnder = (path: string, folder: string) => caseKey(path) === caseKey(folder) || caseKey(path).startsWith(`${caseKey(folder)}/`);
const ancestorsOf = (path: string) => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));

/**
 * What the collected result changes against the snapshot, validated: every rule above except line endings, which
 * need the repository's attributes. Throws one refusal listing the problems found.
 */
export function findChanges(snapshot: Snapshot, collected: Collected, options: { knownValues?: readonly string[]; policy?: Partial<PatchPolicy> } = {}): ChangeSet {
  const policy: PatchPolicy = { ...PATCH_POLICY, ...options.policy };
  const full = (rel: string) => (snapshot.prefix ? `${snapshot.prefix}/${rel}` : rel);
  const manifest = new Map(snapshot.files.map((file) => [file.path, file]));
  const result = new Map(collected.entries.map((entry) => [entry.path, entry]));
  const problems: string[] = [];
  const generated: Counted = { count: 0, sample: [] };
  const added: Change[] = [];
  const changed: Change[] = [];
  const modeChanges: ChangeSet["modeChanges"] = [];
  const deleted = snapshot.files.filter((file) => !result.has(file.path)).map((file) => file.path);

  for (const entry of collected.entries) {
    const before = manifest.get(entry.path);
    if (!before && isGenerated(entry.path, full(entry.path)) && hiddenReason(entry.path) !== "secret" && hiddenReason(full(entry.path)) !== "secret") {
      generated.count++;
      if (generated.sample.length < 10) generated.sample.push(entry.path);
      continue;
    }
    if (entry.kind === "link") {
      if (!before) problems.push(`${quoted(entry.path)} is a new link, and a change may not add links`);
      else if (before.kind !== "link") problems.push(`${quoted(entry.path)} was a file and is now a link`);
      else if (new TextDecoder().decode(before.bytes) !== entry.target) problems.push(`${quoted(entry.path)} is a link whose target changed, and a change may not retarget links`);
      continue;
    }
    if (before?.kind === "link") {
      problems.push(`${quoted(entry.path)} was a link and is now a file`);
      continue;
    }
    const mode = entry.executable ? "100755" : "100644";
    if (before && before.sha256 === entry.sha256 && before.mode === mode) continue;
    const change: Change = { path: entry.path, kind: before ? "changed" : "added", mode, bytes: entry.bytes, sha256: entry.sha256, ...(before ? { before } : {}) };
    (before ? changed : added).push(change);
    if (before && before.mode !== mode) modeChanges.push({ path: entry.path, from: before.mode, to: mode });
  }

  for (const change of added) {
    const problem = proposedPathProblem(change.path);
    if (problem) problems.push(`the new path ${quoted(change.path)} can't be written on every computer (${problem})`);
    const inside = [...snapshot.submodules, ...snapshot.excludedFolders].find((folder) => isUnder(change.path, folder));
    if (inside !== undefined) problems.push(`${quoted(change.path)} is at or under ${quoted(inside)}, which was left out of the snapshot (a submodule or Nivra's own data)`);
  }
  for (const path of [...added.map((change) => change.path), ...changed.map((change) => change.path), ...deleted]) {
    if (isGitControlFile(path)) problems.push(`${quoted(path)} is one of git's own files, which change how the repository is read, so a change may not touch it`);
  }
  for (const change of [...added, ...changed]) {
    if (hiddenReason(change.path) === "secret" || hiddenReason(full(change.path)) === "secret") problems.push(`${quoted(change.path)} has a name that suggests it holds credentials, so a change may not write it`);
    const kinds = credentialKinds(change.bytes, options.knownValues);
    if (kinds.length) problems.push(`${quoted(change.path)} holds what looks like ${kinds.join(" and ")}`);
    if (change.bytes.byteLength > policy.maxFileBytes) problems.push(`${quoted(change.path)} is ${change.bytes.byteLength} bytes, over the ${policy.maxFileBytes} a change may hold for one file`);
    if (isLfsPointer(change.bytes)) problems.push(`${quoted(change.path)} would be a Git LFS pointer, which Nivra can't add or edit`);
  }
  for (const path of [...changed.map((change) => change.path), ...deleted]) {
    const before = manifest.get(path)!;
    if (before.kind === "file" && isLfsPointer(before.bytes)) problems.push(`${quoted(path)} is a Git LFS pointer, which a change may not edit or delete`);
  }
  const count = added.length + changed.length + deleted.length;
  if (count > policy.maxChangedFiles) problems.push(`it changes ${count} files, over the ${policy.maxChangedFiles} a change may hold`);

  // Names a filesystem ignoring case or Unicode form would make one, folders included, when either name is new.
  const existed = new Set([...snapshot.files.map((file) => file.path), ...snapshot.leftOutPaths].flatMap(ancestorsOf));
  const removed = new Set(deleted);
  const names = new Map<string, Set<string>>();
  for (const path of [...snapshot.files.map((file) => file.path).filter((path) => !removed.has(path)), ...snapshot.leftOutPaths, ...added.map((change) => change.path)]) {
    for (const name of ancestorsOf(path)) {
      const key = caseKey(name);
      if (!names.has(key)) names.set(key, new Set());
      names.get(key)!.add(name);
    }
  }
  for (const group of names.values()) {
    if (group.size > 1 && [...group].some((name) => !existed.has(name))) {
      const [a, b] = [...group].sort(byBytes);
      problems.push(`${quoted(a!)} and ${quoted(b!)} differ only in case or Unicode form, which a filesystem that ignores either would make one`);
    }
  }

  refuseFor(problems);
  return { deleted: deleted.sort(byBytes), added: added.sort(ordered), changed: changed.sort(ordered), modeChanges, generated };
}

export type LineStyle = "lf" | "crlf" | "mixed" | "none";

/** How a file's lines end. */
export function lineStyle(bytes: Uint8Array): LineStyle {
  let lf = 0;
  let crlf = 0;
  for (let index = bytes.indexOf(0x0a); index >= 0; index = bytes.indexOf(0x0a, index + 1)) {
    if (index > 0 && bytes[index - 1] === 0x0d) crlf++;
    else lf++;
  }
  return crlf && lf ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none";
}

export interface LineAttributes {
  text: string;
  eol: string;
}

/**
 * Why a change's line endings break the repository's `.gitattributes`, or null. Bytes are never converted. Only new
 * bytes are held to the rules: a mode change never refuses, and a file the commit already held with CRLF, whatever its
 * attributes say, keeps the commit's style.
 */
export function lineEndingProblem(change: Change, attributes: LineAttributes): string | null {
  if (change.before?.sha256 === change.sha256) return null;
  const style = lineStyle(change.bytes);
  const before = change.before && change.before.kind === "file" ? lineStyle(change.before.bytes) : null;
  // `eol` on its own sets `text`; `-text` (or `binary`) means git leaves the bytes alone.
  const text = attributes.text === "unspecified" && attributes.eol !== "unspecified" ? "set" : attributes.text;
  const binary = change.bytes.includes(0);
  const hasCrlf = style === "crlf" || style === "mixed";
  const hadCrlf = before === "crlf" || before === "mixed";
  if (text === "unset" || text === "false") return null;
  const normalised = text === "set" || text === "true" || (text === "auto" && !binary);
  if (normalised && !hadCrlf) return hasCrlf ? `${quoted(change.path)} has CRLF line endings, which this repository's .gitattributes keeps out of its ${text === "auto" ? "text files" : "commits"}` : null;
  if (binary && !normalised) return null;
  // Nothing said, or CRLF the commit already held: an edit keeps the commit's style, and a new file uses one.
  if (before === "lf" && hasCrlf) return `${quoted(change.path)} now has CRLF line endings where the commit's copy had LF`;
  if (before === "crlf" && (style === "lf" || style === "mixed")) return `${quoted(change.path)} now has LF line endings where the commit's copy had CRLF`;
  if ((before === null || before === "none") && style === "mixed") return `${quoted(change.path)} mixes LF and CRLF line endings`;
  return null;
}

export interface PatchResult {
  /** Empty when nothing changed. */
  bytes: Uint8Array;
  sha256: string;
  /**
   * The tree the snapshot makes (its files at their paths in the repository, with the `.gitattributes` files above the
   * picked folder), and that tree with the change: the patch applied to the first gives the second. When nothing of a
   * whole repository was left out, the first is the baseline commit's own tree.
   */
  baseTree: string;
  resultTree: string;
  changes: ChangeSet;
}

export interface PatchOptions {
  snapshot: Snapshot;
  collected: Collected;
  /** A session on the target that owns the checkout, for the engine's own git (Local). */
  session: ExecutionSession;
  git: string;
  knownValues?: readonly string[];
  policy?: Partial<PatchPolicy>;
  /** Where the temporary object store goes: never inside a repository. */
  scratch?: string;
  signal?: AbortSignal;
}

/** A file for the store, at its path in the repository. */
interface StoreFile {
  path: string;
  mode: string;
  bytes: Uint8Array;
}

/** A path as fast-import reads one: quoted, with `\` and `"` escaped. Control characters were refused before. */
const fastImportPath = (path: string) => `"${path.replace(/[\\"]/g, (character) => `\\${character}`)}"`;

/**
 * The fast-import stream for the two trees: B, every file the snapshot holds (with the `.gitattributes` files above the
 * picked folder) at its path in the repository, and R, B with the change, deletions first.
 */
function fastImportStream(base: readonly StoreFile[], prefix: string, changes: ChangeSet): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode("feature done\n")];
  let mark = 0;
  const blob = (bytes: Uint8Array) => {
    mark++;
    parts.push(encoder.encode(`blob\nmark :${mark}\ndata ${bytes.byteLength}\n`), bytes, encoder.encode("\n"));
    return `:${mark}`;
  };
  const full = (rel: string) => fastImportPath(prefix ? `${prefix}/${rel}` : rel);
  const baseLines = base.map((file) => `M ${file.mode} ${blob(file.bytes)} ${fastImportPath(file.path)}\n`);
  const resultLines = [...changes.deleted.map((path) => `D ${full(path)}\n`), ...[...changes.added, ...changes.changed].map((change) => `M ${change.mode} ${blob(change.bytes)} ${full(change.path)}\n`)];
  const baseCommit = ++mark;
  const committer = "committer Nivra <nivra@nivra.invalid> 0 +0000\ndata 0\n";
  parts.push(encoder.encode(`commit refs/nivra/base\nmark :${baseCommit}\n${committer}${baseLines.join("")}`));
  parts.push(encoder.encode(`commit refs/nivra/result\n${committer}from :${baseCommit}\n${resultLines.join("")}done\n`));
  return Buffer.concat(parts);
}

/** The `.gitattributes` files of the folders above the picked one, from the baseline commit: they hold for its files. */
async function attributesAbove(repository: GitTool, snapshot: Snapshot): Promise<StoreFile[]> {
  if (!snapshot.prefix) return [];
  const folders = snapshot.prefix.split("/");
  const paths = folders.map((_, depth) => [...folders.slice(0, depth), ".gitattributes"].join("/"));
  const { bytes } = await runGitBytes(repository, ["cat-file", "--batch"], { stdin: new TextEncoder().encode(paths.map((path) => `${snapshot.baseline}:${path}\n`).join("")), maxBytes: 4 * 1024 * 1024 });
  const found: StoreFile[] = [];
  let offset = 0;
  for (const path of paths) {
    const end = bytes.indexOf(0x0a, offset);
    const header = new TextDecoder().decode(bytes.subarray(offset, end < 0 ? undefined : end));
    if (end < 0) throw new WorkspaceRefusal("git cat-file stopped before giving the attributes above the folder, so no patch was made.");
    offset = end + 1;
    if (header.endsWith(" missing")) continue;
    const [, type, size] = header.split(" ");
    const length = Number(size);
    if (type === "blob") found.push({ path, mode: "100644", bytes: bytes.slice(offset, offset + length) });
    offset += length + 1;
  }
  return found;
}

/**
 * An engine-made bare object store, of the repository's object format. It reads none of anyone's configuration, and
 * nothing of the repository: an alternate would have git refresh the times of the repository's own objects.
 */
async function openStore(options: PatchOptions): Promise<{ dir: string; tool: GitTool }> {
  const dir = mkdtempSync(join(options.scratch ?? tmpdir(), "nivra-patch-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const gitDir = join(dir, "store.git");
    const isolated = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, HOME: home, XDG_CONFIG_HOME: home, GIT_ATTR_NOSYSTEM: "1" };
    const config = ["-c", "core.attributesFile=", "-c", `core.hooksPath=${home}`, "-c", "core.protectNTFS=true", "-c", "core.protectHFS=true", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
    const init: GitTool = { session: options.session, git: options.git, cwd: dir, env: isolated, config, signal: options.signal };
    await runGitBytes(init, ["init", "-q", "--bare", "--template=", ...(options.snapshot.objectFormat === "sha256" ? ["--object-format=sha256"] : []), gitDir]);
    return { dir, tool: { ...init, env: { ...isolated, GIT_DIR: gitDir, GIT_INDEX_FILE: join(dir, "index") } } };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Each path's `text` and `eol` attributes, from the `.gitattributes` files in the index. */
async function attributesOf(tool: GitTool, paths: readonly string[]): Promise<Map<string, LineAttributes>> {
  const attributes = new Map<string, LineAttributes>();
  if (!paths.length) return attributes;
  const said = await runGitBytes(tool, ["check-attr", "--cached", "-z", "--stdin", "text", "eol"], { stdin: new TextEncoder().encode(`${paths.join("\0")}\0`), maxBytes: 16 * 1024 * 1024 });
  const fields = said.text.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path, name, value] = [fields[index]!, fields[index + 1]!, fields[index + 2]!];
    const entry = attributes.get(path) ?? { text: "unspecified", eol: "unspecified" };
    if (name === "text" || name === "eol") entry[name] = value;
    attributes.set(path, entry);
  }
  return attributes;
}

/** The change, validated, as a patch checked against the snapshot's files. The person's repository is only read. */
export async function buildPatch(options: PatchOptions): Promise<PatchResult> {
  const policy: PatchPolicy = { ...PATCH_POLICY, ...options.policy };
  const { snapshot } = options;
  const changes = findChanges(snapshot, options.collected, { ...(options.knownValues ? { knownValues: options.knownValues } : {}), policy });
  const repository: GitTool = { session: options.session, git: options.git, cwd: snapshot.folder, signal: options.signal };
  const present = await runGitBytes(repository, ["cat-file", "-e", `${snapshot.baseline}^{commit}`], { okCodes: [1, 128] });
  if (present.exitCode !== 0) throw new WorkspaceRefusal(`The commit this run started from (${snapshot.baseline.slice(0, 12)}) is no longer in the repository, so no patch was made.`);
  const full = (rel: string) => (snapshot.prefix ? `${snapshot.prefix}/${rel}` : rel);
  const base = [...(await attributesAbove(repository, snapshot)), ...snapshot.files.map((file) => ({ path: full(file.path), mode: file.mode, bytes: file.bytes }))];
  const store = await openStore(options);
  try {
    const { tool } = store;
    await runGitBytes(tool, ["fast-import", "--quiet"], { stdin: fastImportStream(base, snapshot.prefix, changes), timeoutMs: 120_000 });
    const baseTree = (await runGitBytes(tool, ["rev-parse", "--verify", "refs/nivra/base^{tree}"])).text.trim();
    const resultTree = (await runGitBytes(tool, ["rev-parse", "--verify", "refs/nivra/result^{tree}"])).text.trim();
    const touched = [...changes.added, ...changes.changed];
    if (!touched.length && !changes.deleted.length) return { bytes: new Uint8Array(0), sha256: sha256(""), baseTree, resultTree: baseTree, changes };

    await runGitBytes(tool, ["read-tree", baseTree]);
    const attributes = await attributesOf(tool, touched.map((change) => full(change.path)));
    refuseFor(touched.map((change) => lineEndingProblem(change, attributes.get(full(change.path)) ?? { text: "unspecified", eol: "unspecified" })).filter((problem): problem is string => problem !== null));
    const tooBig = `The change's patch is over the ${policy.maxPatchBytes} bytes Nivra proposes at once. Make a smaller change, then try again.`;
    const patch = await runGitBytes(tool, ["diff-tree", "-r", "-p", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", baseTree, resultTree], { maxBytes: policy.maxPatchBytes, tooBig, timeoutMs: 120_000 });
    if (!patch.bytes.byteLength) throw new WorkspaceRefusal("The change gave an empty patch, so it wasn't proposed.");
    await runGitBytes(tool, ["apply", "--cached", "--whitespace=nowarn", "-"], { stdin: patch.bytes, timeoutMs: 120_000 });
    const written = (await runGitBytes(tool, ["write-tree"])).text.trim();
    if (written !== resultTree) throw new WorkspaceRefusal("The patch, applied to the snapshot's files, didn't give the result it was made from, so it wasn't proposed.");
    return { bytes: patch.bytes, sha256: sha256(patch.bytes), baseTree, resultTree, changes };
  } finally {
    rmSync(store.dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
