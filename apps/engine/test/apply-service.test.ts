import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ApplyView, type TaskAdmissionParams } from "@nivra/domain";
import type { Proposal } from "../src/exec/proposal.ts";
import type { ExecutionBackend } from "../src/exec/backend.ts";
import { ApplyJournal } from "../src/apply/journal.ts";
import { ApplyService } from "../src/apply/service.ts";
import { writeChange } from "../src/apply/writer.ts";
import { type ApplyIo, nodeIo } from "../src/apply/io.ts";
import { Database } from "../src/db/database.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { APPLY_CHANGE, APPLY_FILES, copies, planFor } from "./apply-fixtures.ts";
import { attempt } from "./task-fixtures.ts";
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
const admitted = async (_params: TaskAdmissionParams, proposal: Proposal) => ({ eligible: true, reason: null, proposalHash: proposal.hash, reportSha256: proposal.binding.reportSha256, legacy: false });

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

const nodeIoForTests = () => ({ ...nodeIo });
const serviceOn = (database: string) => new ApplyService({ database: new Database(database), proposal: () => null, admission: admitted, homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "linux" });

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
    // Asked again (its answer lost on the way back): the same apply, and nothing written.
    const unchanged = folderState(run.root);
    assert.equal((await service.restore(view.applyId)).status, "not-applied");
    assert.deepEqual(changedSince(unchanged, run.root), []);
    // Dismissed: the folder is free, and every copy stays for the person to delete, README.md's original among them.
    const settled = await service.dismiss(view.applyId, "dismissed");
    assert.deepEqual([settled.resolution, readdirSync(run.recovery).sort(), existsSync(join(run.plan.gitDir, "nivra-apply", "lock"))], ["dismissed", ["back-0-0", "new-0", "new-1", "new-2", "orig-0"], false]);
  });

  it("never keeps a partial apply as it is while a file is moved aside, nor removes that file's original, and restores it instead", async () => {
    const fresh = copies(dirs);
    const counted = await cut(fresh, null);
    // Killed just after README.md was moved aside: nothing in its place, its original kept.
    const run = await cut(fresh, counted.calls.indexOf("rename") + 1);
    const service = serviceOn(run.job.database);
    const view = service.status(run.job.requestId)!;
    assert.deepEqual([view.status, view.paths[0]?.place], ["partial", "aside"]);
    await assert.rejects(service.dismiss(view.applyId, "kept"), /Restore the originals instead/);
    assert.ok(existsSync(join(run.recovery, "orig-0")), "the missing file's original went");
    const restored = await service.restore(view.applyId);
    assert.deepEqual([restored.status, String(readFileSync(join(run.root, "README.md")))], ["not-applied", APPLY_FILES["README.md"]]);
    // Unknown (another file changed by hand too) and dismissed: the missing file's original still stays.
    const other = await cut(fresh, counted.calls.indexOf("rename") + 1);
    writeFileSync(join(other.root, "greet.sh"), "edited by hand\n");
    const unknown = serviceOn(other.job.database).status(other.job.requestId)!;
    assert.deepEqual([unknown.status, unknown.paths.map((one) => one.place)], ["unknown", ["aside", "other", "pre"]]);
    await serviceOn(other.job.database).dismiss(unknown.applyId, "dismissed");
    assert.equal(String(readFileSync(join(other.recovery, "orig-0"))), APPLY_FILES["README.md"]);
  });

  it("keeps what the apply knew of another program's save when it restores: still partial, never unknown", async () => {
    const root = copies(dirs)();
    const work = tempDir();
    dirs.push(work);
    const database = new Database(join(work, "nivra.db"));
    const journal = new ApplyJournal(database);
    const applyId = randomUUID();
    const requestId = randomUUID();
    const plan = planFor(root);
    journal.claim({ applyId, requestId, runId: randomUUID(), proposalHash: "a".repeat(64), destination: plan.topLevel });
    // The added file's link fails after both changed files were written, and README.md was saved over meanwhile.
    let edited = false;
    const failing = { ...nodeIoForTests(), link: (existing: string, created: string) => {
      if (created.endsWith("today.md")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      linkSync(existing, created);
    } };
    const result = await writeChange({ applyId, plan, journal, engineId: ENGINE, io: failing, before: (step) => {
      if (step === "link 2" && !edited) {
        edited = true;
        writeFileSync(join(root, "README.md"), "edited after Nivra wrote it\n");
      }
    } });
    assert.deepEqual([result.state, result.paths[0]?.place, result.paths[0]?.changedSince], ["partial", "theirs", true]);
    const service = new ApplyService({ database, proposal: () => null, admission: admitted, homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "linux" });
    const restored = await service.restore(applyId);
    assert.deepEqual([restored.status, restored.paths[0]?.place, restored.paths[0]?.changedSince], ["partial", "theirs", true]);
  });

  it("settles an apply again the same way as the same answer, its first answer lost; another way is refused", async () => {
    const fresh = copies(dirs);
    const run = await cut(fresh, null);
    const service = serviceOn(run.job.database);
    const applyId = service.status(run.job.requestId)!.applyId;
    const accepted = await service.dismiss(applyId, "accepted");
    assert.deepEqual((await service.dismiss(applyId, "accepted")).resolution, accepted.resolution);
    await assert.rejects(service.dismiss(applyId, "dismissed"), /can't be settled that way now/);
  });

  it("refuses a change its run didn't verify, whoever asks, writing nothing", async () => {
    const run = await attempt();
    const proposal = run.result.proposal!;
    const work = tempDir();
    dirs.push(work);
    const service = new ApplyService({ database: new Database(join(work, "nivra.db")), proposal: () => proposal, admission: async (_params, proposal) => ({ ...await admitted(_params, proposal), eligible: false, reason: "A required check failed." }), homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "linux" });
    const before = folderState(run.root);
    const refused = await service.apply({ requestId: randomUUID(), runId: proposal.binding.task!.attempt.runId, approvedHash: proposal.hash, repoPath: run.root, project: proposal.binding.project, target: proposal.binding.target, task: proposal.binding.task! });
    assert.deepEqual([refused.status, refused.refusal?.code, changedSince(before, run.root)], ["refused", "unverified", []]);
  });

  it("keeps every original when a change is accepted: a program that had a file open saves through it afterwards, and nothing is lost", async () => {
    const root = copies(dirs)();
    const work = tempDir();
    dirs.push(work);
    const database = new Database(join(work, "nivra.db"));
    const journal = new ApplyJournal(database);
    const applyId = randomUUID();
    const plan = planFor(root);
    journal.claim({ applyId, requestId: randomUUID(), runId: randomUUID(), proposalHash: "a".repeat(64), destination: plan.topLevel });
    // An editor opened README.md before the apply, and keeps it open.
    const editor = openSync(join(root, "README.md"), "r+");
    try {
      assert.equal((await writeChange({ applyId, plan, journal, engineId: ENGINE })).state, "applied");
      const service = new ApplyService({ database, proposal: () => null, admission: admitted, homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "linux" });
      const accepted = await service.dismiss(applyId, "accepted");
      // Every copy stays, both originals among them, whatever their bytes.
      const recovery = join(plan.gitDir, "nivra-apply", applyId);
      assert.deepEqual([accepted.resolution, readdirSync(recovery).sort()], ["accepted", ["new-0", "new-1", "new-2", "orig-0", "orig-1"]]);
      // It saves after the acceptance, through the file it had open: the save lands in the original kept aside.
      const saved = Buffer.from("saved through the open file\n");
      writeSync(editor, saved, 0, saved.byteLength, 0);
      ftruncateSync(editor, saved.byteLength);
      fsyncSync(editor);
      assert.deepEqual([fstatSync(editor).nlink, readFileSync(join(recovery, "orig-0"), "utf8"), readFileSync(join(root, "README.md"), "utf8")], [1, "saved through the open file\n", APPLY_CHANGE["README.md"]!.text]);
    } finally {
      closeSync(editor);
    }
  });

  it("keeps every copy when a change rolled back is dismissed as an editor replaces the file: a later save through the original's descriptor is never lost", async () => {
    const root = copies(dirs)();
    const work = tempDir();
    dirs.push(work);
    const database = new Database(join(work, "nivra.db"));
    const journal = new ApplyJournal(database);
    const applyId = randomUUID();
    const plan = planFor(root);
    journal.claim({ applyId, requestId: randomUUID(), runId: randomUUID(), proposalHash: "a".repeat(64), destination: plan.topLevel });
    // A program opened README.md before the apply, and keeps it open.
    const held = openSync(join(root, "README.md"), "r+");
    try {
      // The first new file's link fails, so the apply rolls back: README.md's original is linked back in place, and its
      // copy in the recovery folder is a second name for it.
      const result = await writeChange({ applyId, plan, journal, engineId: ENGINE, before: (step) => {
        if (step === "link 0") throw Object.assign(new Error("injected"), { code: "EIO" });
      } });
      assert.equal(result.state, "not-applied");
      // An editor saves README.md as editors do, writing a new file and renaming it over the old one: the moment
      // dismissing looks at the original's copy, or else right after.
      let replaced = false;
      const replace = () => {
        if (replaced) return;
        replaced = true;
        writeFileSync(join(root, "README.md.tmp"), "atomic editor save\n");
        renameSync(join(root, "README.md.tmp"), join(root, "README.md"));
      };
      const io: ApplyIo = {
        ...nodeIo,
        lstat: (path) => {
          const stats = nodeIo.lstat(path);
          if (path.endsWith("/orig-0")) replace();
          return stats;
        },
      };
      const service = new ApplyService({ database, proposal: () => null, admission: admitted, homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "linux", io });
      const dismissed = await service.dismiss(applyId, "dismissed");
      replace();
      // The program then saves through what it had open: the original, still named in the recovery folder.
      const late = Buffer.from("saved later through the open file\n");
      ftruncateSync(held, 0);
      writeSync(held, late, 0, late.byteLength, 0);
      fsyncSync(held);
      const recovery = join(plan.gitDir, "nivra-apply", applyId);
      assert.deepEqual([dismissed.resolution, replaced, fstatSync(held).nlink, existsSync(join(recovery, "orig-0"))], ["dismissed", true, 1, true]);
      assert.deepEqual([readFileSync(join(recovery, "orig-0"), "utf8"), readFileSync(join(root, "README.md"), "utf8")], ["saved later through the open file\n", "atomic editor save\n"]);
    } finally {
      closeSync(held);
    }
  });

  it("claims an apply the moment it arrives: one waiting behind another reads as claimed, never as one the engine never got", async () => {
    // Two task runs' proposals, in two repositories, applied on one engine while the first one's git is held up.
    const runs = [await attempt(), await attempt()];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const local = createLocalBackend({ baseEnv: process.env });
    const slow: ExecutionBackend = {
      ...local,
      open: async (spec) => {
        const session = await local.open(spec);
        return { ...session, exec: async (request) => (await held, session.exec(request)), close: (options) => session.close(options) };
      },
    };
    const work = tempDir();
    dirs.push(work);
    const proposals = new Map(runs.map((run) => [run.result.proposal!.binding.task!.attempt.runId, run.result.proposal!]));
    const service = new ApplyService({ database: new Database(join(work, "nivra.db")), proposal: (runId) => proposals.get(runId) ?? null, admission: admitted, homeId: ENGINE, backend: slow, findGit: () => GIT, platform: "linux" });
    const params = runs.map((run) => {
      const proposal = run.result.proposal!;
      return { requestId: randomUUID(), runId: proposal.binding.task!.attempt.runId, approvedHash: proposal.hash, repoPath: run.root, project: proposal.binding.project, target: proposal.binding.target, task: proposal.binding.task! };
    });
    const first = service.apply(params[0]!);
    const second = service.apply(params[1]!);
    assert.deepEqual([service.status(params[0]!.requestId)?.status, service.status(params[1]!.requestId)?.status], ["claimed", "claimed"]);
    release();
    assert.deepEqual([(await first).status, (await second).status], ["applied", "applied"]);
  });

  it("gives a view the protocol can always carry: none of a writing apply's paths made up, and no more folders than it bounds", async () => {
    const work = tempDir();
    dirs.push(work);
    const database = new Database(join(work, "nivra.db"));
    const journal = new ApplyJournal(database);
    const service = new ApplyService({ database, proposal: () => null, admission: admitted, homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "linux" });
    const applyId = randomUUID();
    journal.claim({ applyId, requestId: randomUUID(), runId: randomUUID(), proposalHash: "a".repeat(64), destination: "/repo" });
    const intent = { version: 1 as const, applyId, folder: "/repo", gitDir: "/repo/.git", recovery: `/repo/.git/nivra-apply/${applyId}`, folders: [], paths: [{ path: "a.txt", change: "added" as const, pre: { kind: "absent" as const, mode: null, size: null, sha256: null }, post: { mode: "100644" as const, size: 1, sha256: "b".repeat(64) }, perm: 0o644, temp: "new-0", aside: null }] };
    journal.intend(applyId, intent);
    assert.deepEqual(service.view(journal.get(applyId)!).paths, []);
    // A change can make hundreds of folders (a path a thousand characters deep): the view keeps to the protocol's bound.
    const folders = Array.from({ length: 600 }, (_, at) => `d/${"x/".repeat(at % 3)}${at}`);
    journal.settle(applyId, { state: "applied", paths: [], folders, failure: null });
    const view = service.view(journal.get(applyId)!);
    assert.deepEqual([ApplyView.safeParse(view).success, view.folders.length], [true, 500]);
  });

  it("refuses to apply on Windows itself, before claiming anything", async () => {
    const work = tempDir();
    dirs.push(work);
    const service = new ApplyService({ database: new Database(join(work, "nivra.db")), proposal: () => null, admission: admitted, homeId: ENGINE, backend: createLocalBackend({ baseEnv: process.env }), findGit: () => GIT, platform: "win32" });
    const task = { attempt: { taskId: "task", attemptId: randomUUID(), runId: randomUUID() }, engine: { homeId: randomUUID() }, brief: { version: 1, sha256: "b".repeat(64) } };
    const requestId = randomUUID();
    await assert.rejects(service.apply({ requestId, runId: task.attempt.runId, approvedHash: "a".repeat(64), repoPath: work, project: "project", target: "local", task }), /^ApplyRequestRefusal: Applying changes on Windows itself isn't available yet/);
    assert.equal(service.status(requestId), null);
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
