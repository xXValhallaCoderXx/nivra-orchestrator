import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { PlanningEvidence } from "@nivra/domain";
import { childEnv } from "../src/exec/child-env.ts";
import { findGit } from "../src/exec/find-executable.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { evidenceDigest, openPlanningReader, planningInventoryDigest, validatePlanningEvidence } from "../src/planning/evidence.ts";
import { makeRepo, removeDir, tempDir } from "./helpers.ts";

const dirs: string[] = [];
after(() => { for (const dir of dirs) removeDir(dir); });
const env = childEnv(process.env);
const backend = createLocalBackend({ baseEnv: env });
const git = () => findGit({ env });
const mask = (value: string) => value;
function fixture() {
  const root = tempDir("planning evidence"); dirs.push(root);
  const repo = makeRepo(root); mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/flow.ts"), "export const record = 1;\n");
  assert.equal(spawnSync("git", ["add", "src/flow.ts"], { cwd: repo }).status, 0);
  return repo;
}

describe("bounded planning evidence freshness", () => {
  it("rechecks a negative scoped search even when the commit and tracked inventory stay unchanged", async () => {
    const repo = fixture();
    const opened = await openPlanningReader(repo, backend, git, mask);
    const query = { query: "saveRecord", glob: "src/**/*.ts" };
    const found = await opened.reader.search(query);
    assert.equal(found.result.matches.length, 0);
    const evidence: PlanningEvidence = { baseline: await opened.reader.head(), files: [], searches: [{ ...query, digest: evidenceDigest(found) }], inventory: [] };
    await opened.session.close();
    assert.equal((await validatePlanningEvidence(repo, evidence, backend, git, mask)).current, true);
    writeFileSync(join(repo, "src/flow.ts"), "export function saveRecord() {}\n");
    assert.equal((await validatePlanningEvidence(repo, evidence, backend, git, mask)).current, false);
  });

  it("binds only the inspected inventory scope and notices newly tracked callers in it", async () => {
    const repo = fixture();
    const opened = await openPlanningReader(repo, backend, git, mask);
    const evidence: PlanningEvidence = { baseline: await opened.reader.head(), files: [], searches: [], inventory: [{ glob: "src/**/*.ts", digest: planningInventoryDigest(opened.reader, { glob: "src/**/*.ts" }) }] };
    await opened.session.close();
    writeFileSync(join(repo, "README.md"), "An unrelated note\n");
    assert.equal(spawnSync("git", ["add", "README.md"], { cwd: repo }).status, 0);
    assert.equal((await validatePlanningEvidence(repo, evidence, backend, git, mask)).current, true);
    writeFileSync(join(repo, "src/caller.ts"), "import { record } from './flow';\n");
    assert.equal(spawnSync("git", ["add", "src/caller.ts"], { cwd: repo }).status, 0);
    assert.equal((await validatePlanningEvidence(repo, evidence, backend, git, mask)).current, false);
  });

  it("does not turn unavailable inspection into unchanged evidence, while an explicitly unassessed plan has no source claim to recheck", async () => {
    const repo = fixture();
    const opened = await openPlanningReader(repo, backend, git, mask);
    const evidence: PlanningEvidence = { baseline: await opened.reader.head(), files: [], searches: [], inventory: [{ digest: planningInventoryDigest(opened.reader, {}) }] };
    await opened.session.close();
    assert.equal((await validatePlanningEvidence(join(repo, "missing"), evidence, backend, git, mask)).current, false);
    assert.equal((await validatePlanningEvidence(join(repo, "missing"), { baseline: null, files: [], searches: [], inventory: [] }, backend, git, mask)).current, true);
  });
});
