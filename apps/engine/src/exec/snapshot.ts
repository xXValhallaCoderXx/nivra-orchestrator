import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { secretShapes } from "@nivra/domain";
import { hiddenReason } from "../repo/deny.ts";
import { isInside } from "../repo/paths.ts";
import type { ExecutionSession, SessionSnapshot } from "./backend.ts";
import { runGitBytes, WorkspaceRefusal, type GitTool } from "./git-tool.ts";
import { listingDigest, type ListingEntry } from "./nebius/session.ts";
import { writeTar, type TarEntry } from "./tar.ts";
import { byBytes, caseKey, snapshotPathProblem } from "./workspace-rules.ts";

/**
 * A snapshot of one commit, to send into a sandbox (NIV-42, D34). It is made by the engine that owns the checkout's
 * filesystem, from the commit's own objects, never from the working tree, and it never writes the checkout.
 *
 * - **The baseline** is HEAD, as a full id. A baseline given by the caller must equal it.
 * - **Uncommitted work** in the picked folder:
 *   - tracked changes, staged or not, refuse the snapshot with guidance;
 *   - untracked files are left out, counted and named (bounded);
 *   - nothing is staged, stashed, discarded or silently included.
 *
 *   The check is one `git status`, with every filter driver the configuration names switched off. D34 supersedes
 *   D22's "no git status" line for this check only.
 * - **Reading the commit safely:**
 *   - `ls-tree` lists the picked folder's subtree, and `cat-file --batch` gives exact blob bytes, with no filters and no
 *     line-ending conversion;
 *   - a partial clone is refused, since a missing object would be fetched;
 *   - remotes, lazy fetches and replace refs are switched off (`GIT_SAFE_ENV`).
 * - **Before anything is sent:**
 *   - the included paths are checked;
 *   - left out, and counted by reason: secret-named paths and dependency or build output (by the shared deny rules,
 *     against the path in the folder and in the repository), submodules, and folders the caller excludes (the engine
 *     home, if it sits inside the repository);
 *   - every included file's content is scanned, text or binary, for credential shapes, private keys and the vault's
 *     own values. An unsafe snapshot is refused, never redacted. The refusal names the path and the kind of
 *     credential, never the value;
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

/** Credential shapes in words a person reads. */
const SHAPE_WORDS: Readonly<Record<string, string>> = {
  "private-key": "a private key",
  "aws-access-key": "an AWS access key",
  "github-token": "a GitHub token",
  "github-fine-grained-token": "a GitHub token",
  "api-key": "an API key",
  "slack-token": "a Slack token",
  "linear-token": "a Linear token",
};

/** The credential kinds `bytes` looks like it holds, in words, with the vault's own values; empty when none. */
export function credentialKinds(bytes: Uint8Array, knownValues: readonly string[] = []): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // latin1 gives one character per byte, so the ASCII shapes are found in text and binary alike.
  const kinds = secretShapes(buffer.toString("latin1")).map((shape) => SHAPE_WORDS[shape] ?? "a credential");
  if (knownValues.some((value) => value.length > 0 && buffer.includes(Buffer.from(value, "utf8")))) kinds.push("a value Nivra keeps as a secret");
  return [...new Set(kinds)];
}

/** The git on this target, or a refusal naming the version it needs. */
async function checkGitVersion(tool: GitTool): Promise<void> {
  const said = (await runGitBytes(tool, ["--version"])).text.trim();
  const version = /(\d+)\.(\d+)/.exec(said);
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) throw new WorkspaceRefusal(`Snapshots need git ${MIN_GIT.join(".")} or newer, and this target has ${said || "an unknown version"}. Update git, then try again.`);
}

/**
 * Refuses a picked folder with tracked changes, and gives what is untracked in it, relative to it. `git status` runs
 * with every filter driver the configuration names switched off (no command, and none required), and with fsmonitor
 * and optional locks off (`GIT_PINS`, `GIT_ENV`), so it runs nothing the repository configures and writes nothing.
 */
async function untrackedWork(tool: GitTool, prefix: string): Promise<Counted> {
  const names = await runGitBytes(tool, ["config", "-z", "--name-only", "--get-regexp", "^filter\\."], { okCodes: [1] });
  const drivers = new Set<string>();
  for (const name of names.text.split("\0").filter(Boolean)) {
    const rest = name.slice("filter.".length);
    const dot = rest.lastIndexOf(".");
    // `filter.<key>` alone names no driver.
    if (dot < 0) continue;
    const driver = rest.slice(0, dot);
    if (driver === "" || driver.includes("=")) throw new WorkspaceRefusal(`A filter driver in this repository's git configuration has a name Nivra can't switch off safely (${JSON.stringify(driver).slice(0, 80)}), so it won't check the checkout. Rename it, then try again.`);
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
  if (tracked > 0) throw new WorkspaceRefusal(`Your checkout has uncommitted changes in ${plural(tracked, "file")}. Nivra works from a commit. Commit or stash them, then try again.`);
  return untracked;
}

interface TreeEntry {
  mode: string;
  type: string;
  blob: string;
  size: number;
  /** Relative to the top level. */
  path: string;
}

/** `ls-tree -r -z -l` records: mode, type, id, size (`-` for a submodule), and the path after a tab. */
function parseTree(text: string): TreeEntry[] {
  return text
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) (\S+) ([0-9a-f]+) +(\S+)\t([\s\S]*)$/.exec(record);
      if (!match) throw new WorkspaceRefusal("git ls-tree gave a line Nivra can't read, so no snapshot was made.");
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
    const header = new TextDecoder().decode(bytes.subarray(offset, end < 0 ? undefined : end));
    if (end < 0 || header.endsWith(" missing")) throw new WorkspaceRefusal(`The commit's files aren't all in this repository (${entry.rel} is missing). Fetch the whole history, then try again.`);
    const [blob, type, size] = header.split(" ");
    if (blob !== entry.blob || type !== "blob" || Number(size) !== entry.size) throw new WorkspaceRefusal(`git cat-file gave something other than ${entry.rel}'s content, so no snapshot was made.`);
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
  const tool: GitTool = { session: options.session, git: options.git, cwd: folder, signal: options.signal };
  await checkGitVersion(tool);
  const [topLevelLine = "", prefixLine = ""] = (await runGitBytes(tool, ["rev-parse", "--show-toplevel", "--show-prefix"])).text.split("\n");
  const topLevel = realpathSync.native(topLevelLine);
  const prefix = prefixLine.replace(/\/$/, "");
  const partial = await runGitBytes(tool, ["config", "--get", "extensions.partialClone"], { okCodes: [1] });
  const promisors = await runGitBytes(tool, ["config", "--bool", "--get-regexp", "^remote\\..*\\.promisor$"], { okCodes: [1] });
  if (partial.exitCode === 0 || promisors.text.split("\n").some((line) => line.endsWith(" true"))) {
    throw new WorkspaceRefusal("This repository is a partial clone: some of its files are fetched only when they are read, which would reach the network. Clone it in full, then try again.");
  }
  const head = await runGitBytes(tool, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { okCodes: [1] });
  const baseline = head.text.trim();
  if (head.exitCode !== 0 || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(baseline)) throw new WorkspaceRefusal("This repository has no commits yet, so there is nothing to work from. Commit your files, then try again.");
  const objectFormat = baseline.length === 64 ? "sha256" : "sha1";
  if (options.baseline !== undefined && options.baseline !== baseline) throw new WorkspaceRefusal(`Your checkout has moved to another commit (HEAD is ${short(baseline)}, not ${short(options.baseline)}). Start again from the commit it is on now.`);
  const excluded = (options.exclude ?? []).map((path) => placeOf(topLevel, path)).filter((place): place is string => place !== null);
  const isUnder = (path: string, folderPath: string) => caseKey(path) === caseKey(folderPath) || caseKey(path).startsWith(`${caseKey(folderPath)}/`);
  if (excluded.some((place) => place === "all" || (prefix !== "" && isUnder(prefix, place)))) throw new WorkspaceRefusal("The folder you picked is inside Nivra's own data folder, so Nivra won't send it. Pick a folder outside it.");
  const untracked = await untrackedWork(tool, prefix);

  const listed = await runGitBytes(tool, ["ls-tree", "-r", "-z", "-l", "--full-tree", baseline, ...(prefix ? ["--", `${prefix}/`] : [])], { maxBytes: 64 * 1024 * 1024 });
  const leftOut = { secret: counted(), output: counted(), submodule: counted(), excluded: counted() };
  const leftOutPaths: string[] = [];
  const leave = (counter: Counted, rel: string) => {
    add(counter, rel);
    leftOutPaths.push(rel);
  };
  const wanted: Array<TreeEntry & { rel: string }> = [];
  const tree = parseTree(listed.text);
  for (const entry of tree) {
    const rel = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
    if (entry.mode === "160000") {
      leave(leftOut.submodule, rel);
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
    if (problem) throw new WorkspaceRefusal(`The commit holds a path Nivra won't send (${JSON.stringify(rel).slice(0, 120)}: ${problem}). Rename it in a new commit, then try again.`);
    if (!(entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755" || entry.mode === "100664" || entry.mode === "120000"))) throw new WorkspaceRefusal(`The commit holds ${rel} as a ${entry.type} of mode ${entry.mode}, which Nivra doesn't send.`);
    wanted.push({ ...entry, rel });
  }
  if (!wanted.length) {
    const why = tree.length ? `every committed file in it is left out (${plural(tree.length, "file")})` : "it has no committed files";
    throw new WorkspaceRefusal(`There is nothing in this folder to send: ${why}. Commit the files to work on, then try again.`);
  }
  if (wanted.length > limits.maxFiles) throw new WorkspaceRefusal(`The folder's commit holds ${wanted.length} files to send, over the ${limits.maxFiles} a sandbox run takes. Pick a smaller folder, then try again.`);
  const big = wanted.find((entry) => entry.size > limits.maxFileBytes);
  if (big) throw new WorkspaceRefusal(`${big.rel} is ${big.size} bytes, over the ${limits.maxFileBytes} Nivra sends for one file. Leave it out of the folder, then try again.`);
  const total = wanted.reduce((sum, entry) => sum + entry.size, 0);
  if (total > limits.maxBytes) throw new WorkspaceRefusal(`The folder's files come to ${total} bytes, over the ${limits.maxBytes} a sandbox run takes. Pick a smaller folder, then try again.`);
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
    if (file.kind === "file" && Buffer.from(file.bytes.subarray(0, LFS_POINTER.length)).toString("latin1") === LFS_POINTER) add(lfsPointers, file.path);
  }
  if (unsafe.length) {
    const more = unsafe.length > 3 ? ` (and ${plural(unsafe.length - 3, "more file")})` : "";
    throw new WorkspaceRefusal(`${unsafe.slice(0, 3).join("; ")}${more}, so Nivra won't upload it. Remove it from the commit (and replace the key if it's real), then try again.`);
  }

  const listing: ListingEntry[] = [];
  const entries: TarEntry[] = [];
  for (const file of files) {
    if (file.kind === "link") {
      let target: string;
      try {
        target = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch {
        throw new WorkspaceRefusal(`${file.path} is a link whose target isn't valid UTF-8, so Nivra won't send it.`);
      }
      if (target === "" || /\p{Cc}/u.test(target)) throw new WorkspaceRefusal(`${file.path} is a link whose target is empty or holds a control character, so Nivra won't send it.`);
      listing.push({ path: file.path, kind: "link", target });
      entries.push({ path: file.path, kind: "link", target });
    } else {
      listing.push({ path: file.path, kind: "file", executable: file.mode === "100755", sha256: file.sha256 });
      entries.push({ path: file.path, kind: "file", executable: file.mode === "100755", bytes: file.bytes });
    }
  }
  const archive = writeTar(entries);
  if (archive.byteLength > limits.maxArchiveBytes) throw new WorkspaceRefusal(`The folder's snapshot comes to ${archive.byteLength} bytes, over the ${limits.maxArchiveBytes} a sandbox run takes. Pick a smaller folder, then try again.`);
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
    untracked,
    lfsPointers,
    archive: { archive, sha256: sha256(archive), listingDigest: listingDigest(listing).digest },
    fingerprint,
  };
}
