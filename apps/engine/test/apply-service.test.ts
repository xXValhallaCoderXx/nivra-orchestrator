import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ApplyService } from "../src/apply/service.ts";
import { Database } from "../src/db/database.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { APPLY_FILES, copies, planFor } from "./apply-fixtures.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { changedSince, cleanUp, folderState, git, GIT } from "./workspace-fixtures.ts";

/**
 * The apply service at start (NIV-8, D40): an apply its engine stopped part way, or before it wrote anything, is
 * reconciled from the disk before any apply call is answered, writing nothing of the person's; one part way can then be
 * restored, and either settled. The engine is stopped for real: `apply-kill-child.ts` kills itself mid-apply.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});
const CHILD = fileURLToPath(new URL("./apply-kill-child.ts", import.meta.url));
const ENGINE = "engine-home-a";

/** An apply in a child process, killed before call `killAt`, or counted when `killAt` is null. */
async function cut(fresh: () => string, killAt: number | null) {
  const root = fresh();
  const plan = planFor(root);
  const work = tempDir();
  dirs.push(work);
  const files = { plan: join(work, "plan.json"), database: join(work, "nivra.db"), calls: join(work, "calls.json"), job: join(work, "job.json") };
  writeFileSync(files.plan, JSON.stringify({ ...plan, paths: plan.paths.map((one) => ({ ...one, bytes: Buffer.from(one.bytes).toString("base64") })) }));
  const job = { database: files.database, plan: files.plan, applyId: randomUUID(), requestId: randomUUID(), runId: randomUUID(), killAt, failAt: null, calls: killAt === null ? files.calls : null };
  writeFileSync(files.job, JSON.stringify(job));
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    const spawned = spawn(process.execPath, [CHILD, files.job], { stdio: "ignore", windowsHide: true });
    spawned.on("error", reject);
    spawned.on("close", (_code, signal) => resolve(signal));
  });
  const calls = killAt === null ? (JSON.parse(readFileSync(files.calls, "utf8")) as { calls: string[] }).calls : [];
  return { root, plan, job, signal, calls, recovery: join(plan.gitDir, "nivra-apply", job.applyId) };
}

const serviceOn = (database: string) => new ApplyService({ database: new Database(database), proposal: () => null, homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "linux" });

describe("the apply service at start (NIV-8, D40)", () => {
  it("reconciles an apply its engine stopped part way as partial, from the disk and writing nothing; restores it on request; then settles it", async () => {
    const fresh = copies(dirs);
    const counted = await cut(fresh, null);
    // Killed just after the first new file was linked into place: one path as the change leaves it, the rest as they were.
    const linked = counted.calls.indexOf("link", counted.calls.indexOf("rename"));
    const run = await cut(fresh, linked + 1);
    assert.equal(run.signal, "SIGKILL");
    const before = folderState(run.root);
    const service = serviceOn(run.job.database);
    assert.deepEqual(changedSince(before, run.root), [], "reconciling wrote something");
    const view = service.status(run.job.requestId)!;
    assert.deepEqual([view.status, view.paths.map((one) => `${one.path} ${one.place}`), view.failure, view.recovery], ["partial", ["README.md post", "greet.sh pre", "notes/2026/today.md pre"], { step: "interrupted", code: null }, `nivra-apply/${run.job.applyId}`]);
    // A second engine start finds it settled, and changes nothing.
    assert.equal(serviceOn(run.job.database).status(run.job.requestId)?.status, "partial");
    const restored = await service.restore(view.applyId);
    assert.deepEqual([restored.status, git(run.root, ["status", "--porcelain"]), String(readFileSync(join(run.root, "README.md")))], ["not-applied", "", APPLY_FILES["README.md"]]);
    await assert.rejects(service.restore(view.applyId), /Only a change that was applied in part can be restored/);
    const settled = await service.dismiss(view.applyId, "dismissed");
    assert.deepEqual([settled.resolution, existsSync(run.recovery), existsSync(join(run.plan.gitDir, "nivra-apply", "lock"))], ["dismissed", false, false]);
  });

  it("keeps a copy that changed since when the change is accepted, and removes the ones still the original's or Nivra's", async () => {
    const fresh = copies(dirs);
    const run = await cut(fresh, null);
    const service = serviceOn(run.job.database);
    assert.equal(service.status(run.job.requestId)?.status, "applied");
    // A program that had README.md open before the apply writes through it into the original kept aside.
    writeFileSync(join(run.recovery, "orig-0"), "written through an open file\n");
    const accepted = await service.dismiss(service.status(run.job.requestId)!.applyId, "accepted");
    assert.deepEqual([accepted.resolution, readdirSync(run.recovery).sort()], ["accepted", ["orig-0"]]);
    assert.equal(String(readFileSync(join(run.recovery, "orig-0"))), "written through an open file\n");
  });

  it("reads a claim its engine stopped before it wrote anything as interrupted, the checkout as it was", async () => {
    const fresh = copies(dirs);
    const run = await cut(fresh, 0);
    assert.equal(run.signal, "SIGKILL");
    const before = folderState(run.root);
    const view = serviceOn(run.job.database).status(run.job.requestId)!;
    assert.deepEqual([view.status, view.refusal?.code, view.paths, changedSince(before, run.root)], ["refused", "interrupted", [], []]);
    assert.match(view.refusal!.message, /^Nivra stopped before it wrote anything, so nothing was written/);
  });
});
