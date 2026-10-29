import { lstat, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RepositoryInspection } from "@nivra/domain";
import type { ExecutionBackend } from "../exec/backend.ts";
import { GIT_ENV, GIT_PINS } from "./git.ts";

/** Absence of a Git marker is evidence of no worktree; a Git refusal alone is not. */
async function hasGitMarker(path: string): Promise<boolean | null> {
  let folder = resolve(path);
  for (let depth = 0; depth < 100; depth++) {
    try { await lstat(join(folder, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
    const parent = dirname(folder);
    if (parent === folder) return false;
    folder = parent;
  }
  return null;
}

/** A small, bounded local check. No dependency install, repository script, snapshot or network. */
export async function inspectRepository(repoPath: string, backend: ExecutionBackend, findGit: () => string | null): Promise<RepositoryInspection> {
  const result: RepositoryInspection = { folder: "unavailable", git: { available: false, version: null }, repository: "unknown", baseline: null, changes: null, checkedAt: new Date().toISOString() };
  try {
    result.folder = (await stat(repoPath)).isDirectory() ? "available" : "missing";
  } catch (error) {
    result.folder = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
  }
  const git = findGit();
  result.git.available = git !== null;
  if (!git || result.folder !== "available") return result;
  const session = await backend.open({ workspace: repoPath });
  const started = performance.now();
  try {
    const call = async (args: string[]) => {
      const timeoutMs = Math.max(1, Math.min(5_000, 15_000 - (performance.now() - started)));
      const run = await session.exec({ argv: [git, ...GIT_PINS, ...args], cwd: repoPath, env: GIT_ENV, timeoutMs, maxOutputBytes: 16_384 });
      return run.timedOut || run.cancelled || run.truncated ? null : run;
    };
    const version = await call(["--version"]);
    if (version?.exitCode !== 0) return result;
    result.git = { available: true, version: /^git version [0-9][\w. -]{0,160}$/.test(version.stdout.trim()) ? version.stdout.trim() : null };
    const inside = await call(["rev-parse", "--is-inside-work-tree"]);
    if (!inside) return result;
    if (inside.stdout.trim() === "false") { result.repository = "not-repository"; return result; }
    if (inside.exitCode === 128) {
      if (await hasGitMarker(repoPath) === false) result.repository = "not-repository";
      return result;
    }
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return result;
    result.repository = "repository";
    const head = await call(["rev-parse", "--verify", "HEAD"]);
    if (head?.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(head.stdout.trim())) result.baseline = head.stdout.trim();
    const status = await call(["status", "--porcelain=v1", "--untracked-files=no"]);
    if (status?.exitCode === 0) result.changes = status.stdout.split("\n").filter(Boolean).length;
    return result;
  } finally {
    await session.close();
  }
}
