import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createLocalBackend } from "../src/exec/local.ts";
import { childEnv } from "../src/exec/child-env.ts";
import { findGit } from "../src/exec/find-executable.ts";
import { inspectRepository } from "../src/repo/inspection.ts";
import { makeRepo } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nivra setup inspection ")); dirs.push(dir);
  return dir;
}
const env = childEnv(process.env);
const git = () => findGit({ env, platform: process.platform });
const backend = () => createLocalBackend({ baseEnv: env });

describe("bounded repository setup inspection", () => {
  it("distinguishes a missing folder and missing Git without installing anything", async () => {
    const root = fixture();
    const absent = await inspectRepository(join(root, "absent"), backend(), git);
    assert.deepEqual([absent.folder, absent.repository, absent.baseline], ["missing", "unknown", null]);
    const noGit = await inspectRepository(root, backend(), () => null);
    assert.deepEqual([noGit.folder, noGit.git.available, noGit.repository], ["available", false, "unknown"]);
  });

  it("distinguishes a plain folder from an unborn repository", async () => {
    const root = fixture();
    const ordinary = await inspectRepository(root, backend(), git);
    assert.equal(ordinary.repository, "not-repository");
    assert.equal(ordinary.git.available, true);
    const empty = join(root, "new project"); mkdirSync(empty);
    assert.equal(spawnSync(git()!, ["init", "-q", "-b", "main"], { cwd: empty }).status, 0);
    const unborn = await inspectRepository(empty, backend(), git);
    assert.deepEqual([unborn.repository, unborn.baseline, unborn.changes], ["repository", null, 0]);
  });

  it("reads the committed baseline without inspecting untracked source or running scripts", async () => {
    const root = fixture();
    const repo = makeRepo(root);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "exit 99" } }));
    const before = await inspectRepository(repo, backend(), git);
    assert.equal(before.repository, "repository");
    assert.match(before.baseline ?? "", /^[a-f0-9]{40,64}$/);
    assert.equal(before.changes, 0, "only tracked work contributes to this bounded baseline check");
    writeFileSync(join(repo, ".git", "config"), "[invalid\n");
    const refused = await inspectRepository(repo, backend(), git);
    assert.equal(refused.repository, "unknown", "a Git refusal with a Git marker is not relabelled as a plain folder");
  });
});
