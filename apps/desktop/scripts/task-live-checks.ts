// What task-live.ts checks before it trusts a frozen build or presses Start (NIV-35), apart from its command line so
// tests can run them: the build's files hashed again, never taken from its manifest, and a run's preview compared field
// by field with what the recipe approved.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedEnvironment } from "@nivra/domain";
import type { TaskRunPreview } from "../src/shared/ipc.ts";
import { taskRunFingerprint } from "../src/main/tasks.ts";
import { filesIn, hashRuntime } from "./runtime-files.ts";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A frozen build's identity, every part read from its files. */
export interface BuildHashes {
  nivraSha256: string;
  appAsarSha256: string;
  /** The runtime's files, hashed as staging names them (`hashRuntime`), and its manifest's own bytes. */
  runtimeContentHash: string;
  runtimeSha256: string;
  runtimeManifestSha256: string;
  /** Every file of the unpacked build, by path and content, and how many. */
  treeSha256: string;
  treeFiles: number;
}

/**
 * The unpacked Linux build's hashes. The runtime's are worked out from its files, and a manifest that names other
 * files than the ones there is refused: a manifest can be right while a file isn't.
 */
export function buildHashes(folder: string): BuildHashes {
  const runtime = join(folder, "resources", "runtime", "linux-x64");
  const manifestPath = join(runtime, "engine", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256?: unknown; files?: unknown };
  const contents = hashRuntime(runtime);
  if (contents.sha256 !== manifest.sha256 || contents.files !== manifest.files) throw new Error(`The build's runtime files hash to ${contents.contentHash} (${contents.files} files), not what its manifest names.`);
  const tree = createHash("sha256");
  const paths = filesIn(folder).map((path) => path.slice(folder.length + 1)).sort();
  for (const path of paths) {
    const bytes = readFileSync(join(folder, path));
    tree.update(`${path}\0${bytes.length}\0`);
    tree.update(bytes);
  }
  return {
    nivraSha256: sha256(join(folder, "nivra")),
    appAsarSha256: sha256(join(folder, "resources", "app.asar")),
    runtimeContentHash: contents.contentHash,
    runtimeSha256: contents.sha256,
    runtimeManifestSha256: sha256(manifestPath),
    treeSha256: tree.digest("hex"),
    treeFiles: paths.length,
  };
}

const BUILD_KEYS: ReadonlyArray<keyof BuildHashes> = ["nivraSha256", "appAsarSha256", "runtimeContentHash", "runtimeSha256", "runtimeManifestSha256", "treeSha256", "treeFiles"];

/** The parts of a frozen build that changed since it was frozen, by name; none when it is as it was. */
export function buildChanges(frozen: BuildHashes, now: BuildHashes): string[] {
  return BUILD_KEYS.filter((key) => frozen[key] !== now[key]);
}

/** What a recipe approved that a run's preview must show. */
export interface ApprovedRun {
  baseline: string;
  snapshotFingerprint: string;
  briefDigest: string;
  frozen: Array<{ path: string; sha256: string }>;
  /** The environment's inputs, as the recipe bound them; null for a run with no environment. */
  inputsDigest: string | null;
}

/**
 * Why a run's preview isn't the approved one; none when it is. The window's preview (`shownExpected`, what Start sends)
 * and the app's structured preview must both carry the fingerprint worked out here from the approved brief digest and
 * snapshot, with the task, the project and the environment just prepared, which the host checks again at Start. The
 * structured preview must show the approved commit, snapshot, frozen files with their hashes, and environment.
 */
export function previewProblems(input: {
  approved: ApprovedRun;
  ids: { taskId: string; briefId: string; briefVersion: number; projectId: string; targetId: string };
  prepared: Pick<PreparedEnvironment, "image" | "inputsDigest" | "projectFingerprint"> | null;
  shownExpected: string;
  structured: Pick<TaskRunPreview, "expected" | "snapshotFingerprint" | "snapshot" | "frozen" | "environment">;
}): string[] {
  const { approved, ids, prepared, structured } = input;
  const expected = taskRunFingerprint({ ...ids, briefDigest: approved.briefDigest, sharing: { modelContext: true, cloudExecution: true }, snapshot: approved.snapshotFingerprint, environment: prepared });
  const problems: string[] = [];
  if (input.shownExpected !== expected) problems.push("the window's preview isn't bound to the approved brief, commit and environment");
  if (structured.expected !== expected) problems.push("the app's preview isn't bound to the approved brief, commit and environment");
  if (structured.snapshotFingerprint !== approved.snapshotFingerprint) problems.push(`the snapshot is ${String(structured.snapshotFingerprint)}, not the approved ${approved.snapshotFingerprint}`);
  if (structured.snapshot?.baseline !== approved.baseline) problems.push(`the commit is ${String(structured.snapshot?.baseline)}, not the approved ${approved.baseline}`);
  const frozen = structured.frozen.map((file) => `${file.sha256}  ${file.path}`).join("\n");
  if (frozen !== approved.frozen.map((file) => `${file.sha256}  ${file.path}`).join("\n")) problems.push("the frozen files or their hashes aren't the approved ones");
  if (prepared === null ? structured.environment !== null : structured.environment?.image !== prepared.image) problems.push("the run doesn't start from the environment just prepared");
  if (structured.environment && structured.environment.inputsDigest !== approved.inputsDigest) problems.push("the environment's inputs aren't the approved ones");
  return problems;
}
