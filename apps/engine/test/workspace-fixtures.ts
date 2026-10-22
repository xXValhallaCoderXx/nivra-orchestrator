import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { findGit } from "../src/exec/find-executable.ts";
import { WorkspaceRefusal, type RefusalCode } from "../src/exec/git-tool.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { PREPARE_SCRIPT } from "../src/exec/nebius/session.ts";
import { checkCollected, COLLECT_SCRIPT, type Collected } from "../src/exec/patch.ts";
import { takeSnapshot, type Snapshot, type SnapshotOptions } from "../src/exec/snapshot.ts";
import { removeDir, tempDir } from "./helpers.ts";

/**
 * Repositories, snapshots and a guest simulated on this machine, for the snapshot and patch tests (NIV-42). The guest
 * runs the real prepare and collect scripts with this machine's tools; the live run (B3) runs them with busybox.
 */
const dirs: string[] = [];
export const cleanUp = () => {
  for (const dir of dirs.splice(0)) removeDir(dir);
};
/** `dir`, removed once the file's tests end. */
export const track = (dir: string) => {
  dirs.push(dir);
  return dir;
};
export const scratch = (label: string) => track(mkdtempSync(join(tmpdir(), `nivra ${label} `)));

export const GIT = findGit({ env: process.env })!;
export function git(cwd: string, args: string[], input?: string | Uint8Array): string {
  const result = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...args], { cwd, input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

export type Content = string | Uint8Array | { link: string } | { executable: string };
export function put(root: string, path: string, content: Content): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  if (typeof content === "object" && "link" in content) symlinkSync(content.link, full);
  else if (typeof content === "object" && "executable" in content) {
    writeFileSync(full, content.executable);
    chmodSync(full, 0o755);
  } else writeFileSync(full, content);
}

/** A repository whose one commit holds `files`, in a folder whose name holds awkward characters. */
export function repoWith(files: Record<string, Content>, options: { objectFormat?: "sha256" } = {}): string {
  const parent = tempDir();
  dirs.push(parent);
  const root = join(parent, "repo ü%#");
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main", ...(options.objectFormat ? [`--object-format=${options.objectFormat}`] : [])]);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  git(root, ["add", "-A", "-f"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

/** Every name under a folder, `.git` included, with its kind, mode, size, time and a digest of its bytes. */
export function folderState(root: string): Map<string, string> {
  const state = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path, { bigint: true });
      const bytes = info.isDirectory() ? "" : sha(info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
      state.set(relative(root, path), `${info.mode} ${info.size} ${info.mtimeNs} ${bytes}`);
      if (info.isDirectory()) walk(path);
    }
  };
  state.set(".", String(lstatSync(root, { bigint: true }).mtimeNs));
  walk(root);
  return state;
}

/** The names whose state differs between two `folderState`s: empty when nothing changed. */
export function changedSince(before: Map<string, string>, root: string): string[] {
  const after = folderState(root);
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
}

export const localSession = (folder: string) => createLocalBackend({ baseEnv: process.env }).open({ workspace: folder });

export async function snap(folder: string, extra: Partial<SnapshotOptions> = {}): Promise<Snapshot> {
  const session = await localSession(folder);
  try {
    return await takeSnapshot({ folder, session, git: GIT, ...extra });
  } finally {
    await session.close();
  }
}

/** A refusal whose words match `pattern`, of the kind `code` when one is given. */
export const refusal = (pattern: RegExp, code?: RefusalCode) => (error: unknown) => {
  assert.ok(error instanceof WorkspaceRefusal, `expected a refusal, got ${String(error)}`);
  if (code !== undefined) assert.equal(error.code, code, error.message);
  assert.match(error.message, pattern);
  return true;
};

export const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export interface GuestFiles {
  stdout: string;
  archive: { bytes: Uint8Array; sha256: string };
  listing: { bytes: Uint8Array; sha256: string };
  workspace: string;
}

/** The guest, simulated: the prepare step extracts the snapshot, `edit` changes the workspace, the collect step runs. */
export function guestRun(snapshot: Snapshot, edit: (workspace: string) => void = () => {}): GuestFiles {
  const guest = scratch("guest");
  const workspace = join(guest, "workspace");
  writeFileSync(join(guest, "snapshot.tar"), snapshot.archive.archive);
  const prepared = spawnSync("/bin/sh", ["-c", PREPARE_SCRIPT, "nivra-prepare", workspace, join(guest, "snapshot.tar"), "", join(guest, "listing")], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.stdout.split("\n")[1], `digest ${snapshot.archive.listingDigest}`);
  edit(workspace);
  const archive = join(guest, "result.tar");
  const listing = join(guest, "result-listing");
  const collected = spawnSync("/bin/sh", ["-c", COLLECT_SCRIPT, "nivra-collect", workspace, archive, "", listing], { encoding: "utf8" });
  assert.equal(collected.status, 0, collected.stderr);
  const read = (path: string) => {
    const bytes = new Uint8Array(readFileSync(path));
    return { bytes, sha256: sha(bytes) };
  };
  return { stdout: collected.stdout, archive: read(archive), listing: read(listing), workspace };
}

export const collect = (files: GuestFiles): Collected => checkCollected(files.stdout, files.archive, files.listing);
