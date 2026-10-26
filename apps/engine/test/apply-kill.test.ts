import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ApplyJournal } from "../src/apply/journal.ts";
import type { RevalidatedPlan } from "../src/apply/plan.ts";
import { type IntendedPath, reconcile, restore } from "../src/apply/writer.ts";
import { Database } from "../src/db/database.ts";
import { copies, planFor, sha256 } from "./apply-fixtures.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { changedSince, cleanUp, folderState, git } from "./workspace-fixtures.ts";

/**
 * An apply killed at every step (NIV-8, D40): a child process runs the writer on a disposable repository and is
 * killed with SIGKILL before one filesystem call, every call in turn, and again at every call of a rollback. After
 * each kill, reconciling writes nothing and says where every path is; every original is in place or in the recovery
 * folder; restoring the originals brings the checkout back to its commit; and nothing is ever replayed.
 */
const CHILD = fileURLToPath(new URL("./apply-kill-child.ts", import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});

interface Run {
  root: string;
  plan: RevalidatedPlan;
  database: string;
  applyId: string;
  /** The working tree before the child ran, `.git` left out, without times. */
  tree: Map<string, string>;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  calls: string[] | null;
}

/** Every name in the working tree, `.git` left out, with its kind, mode and a digest of its bytes: no times. */
function treeOf(root: string): Map<string, string> {
  const tree = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === "" && name === ".git") continue;
      const path = join(dir, name);
      const info = lstatSync(path);
      const rel = prefix ? `${prefix}/${name}` : name;
      tree.set(rel, `${info.isDirectory() ? "folder" : info.isFile() ? "file" : "other"} ${info.mode & 0o7777} ${info.isFile() ? sha256(readFileSync(path)) : ""}`);
      if (info.isDirectory()) walk(path, rel);
    }
  };
  walk(root, "");
  return tree;
}

/** One child: a fresh copy of the repository, its plan, a journal of its own, and the kill or failure asked for. */
async function child(fresh: () => string, options: { killAt?: number; failAt?: number; count?: boolean } = {}): Promise<Run> {
  const root = fresh();
  const plan = planFor(root);
  const work = tempDir();
  dirs.push(work);
  const planFile = join(work, "plan.json");
  writeFileSync(planFile, JSON.stringify({ ...plan, paths: plan.paths.map((one) => ({ ...one, bytes: Buffer.from(one.bytes).toString("base64") })) }));
  const database = join(work, "nivra.db");
  const callsFile = options.count ? join(work, "calls.json") : null;
  const applyId = randomUUID();
  const jobFile = join(work, "job.json");
  writeFileSync(jobFile, JSON.stringify({ database, plan: planFile, applyId, requestId: randomUUID(), runId: randomUUID(), killAt: options.killAt ?? null, failAt: options.failAt ?? null, calls: callsFile }));
  const tree = treeOf(root);
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    const spawned = spawn(process.execPath, [CHILD, jobFile], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    spawned.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    spawned.on("error", reject);
    spawned.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  const calls = callsFile && existsSync(callsFile) ? (JSON.parse(readFileSync(callsFile, "utf8")) as { calls: string[] }).calls : null;
  return { root, plan, database, applyId, tree, ...ended, calls };
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const gitMode = (mode: number) => ((mode & 0o100) !== 0 ? "100755" : "100644");

/** Where a path is, judged here from the disk alone: what reconciling must say. */
function onDisk(root: string, recovery: string, one: IntendedPath): "pre" | "post" | "aside" | "other" {
  const target = join(root, ...one.path.split("/"));
  const info = lstatOrNull(target);
  const file = info?.isFile() ? { mode: gitMode(info.mode), sha256: sha256(readFileSync(target)) } : null;
  if (one.change === "added" ? info === null : file !== null && file.sha256 === one.pre.sha256 && file.mode === one.pre.mode) return "pre";
  if (file !== null && file.sha256 === one.post.sha256 && file.mode === one.post.mode) return "post";
  if (info === null && one.aside) {
    const copy = join(recovery, one.aside);
    const kept = lstatOrNull(copy);
    if (kept?.isFile() && gitMode(kept.mode) === one.pre.mode && sha256(readFileSync(copy)) === one.pre.sha256) return "aside";
  }
  return "other";
}

const digestsIn = (folder: string) => new Set(existsSync(folder) ? readdirSync(folder).filter((name) => lstatSync(join(folder, name)).isFile()).map((name) => sha256(readFileSync(join(folder, name)))) : []);
const rowsIn = (database: string) => {
  const opened = new Database(database);
  try {
    return opened.open().prepare("SELECT id, state FROM applies ORDER BY id").all().map((row) => `${String(row["id"])} ${String(row["state"])}`);
  } finally {
    opened.close();
  }
};

/**
 * What must hold however the child stopped:
 * - no intent kept: nothing of the person's changed;
 * - an intent kept: reconciling writes nothing, says what is on disk and never `theirs`, and every path is as it was,
 *   as the change leaves it, or moved aside intact; every original is in place or in the recovery folder;
 * - restoring the originals brings the working tree back to its commit, every name, mode and byte, with Nivra's new
 *   bytes nowhere in it; reconciling then says not applied; and no apply was started again.
 */
async function holds(run: Run, what: string): Promise<string> {
  const opened = new Database(run.database);
  let record;
  try {
    record = new ApplyJournal(opened).get(run.applyId);
  } finally {
    opened.close();
  }
  assert.ok(record, `${what}: the apply wasn't claimed`);
  if (!record.intent) {
    assert.equal(record.state === "claimed" || record.state === "refused", true, `${what}: ${record.state} with no intent`);
    assert.deepEqual([...treeOf(run.root)], [...run.tree], `${what}: no intent was kept, yet the working tree changed`);
    return "no intent";
  }
  const intent = record.intent;
  const rows = rowsIn(run.database);
  const before = folderState(run.root);
  const seen = reconcile(intent);
  assert.deepEqual(changedSince(before, run.root), [], `${what}: reconciling wrote something`);
  const kept = digestsIn(intent.recovery);
  for (const [index, one] of intent.paths.entries()) {
    const place = seen.paths[index]!.place;
    assert.equal(place, onDisk(run.root, intent.recovery, one), `${what}: reconciling says ${one.path} is ${place}`);
    assert.notEqual(place, "other", `${what}: ${one.path} is neither as it was, nor as the change leaves it, nor kept aside`);
    if (one.change === "changed") {
      const target = join(run.root, ...one.path.split("/"));
      const here = lstatOrNull(target)?.isFile() ? sha256(readFileSync(target)) : null;
      assert.ok(here === one.pre.sha256 || kept.has(one.pre.sha256!), `${what}: ${one.path}'s original is neither in place nor kept`);
    }
  }

  const restored = await restore(intent, { created: record.created });
  assert.equal(restored.state, "not-applied", `${what}: restoring left ${restored.paths.map((one) => `${one.path} ${one.place}`).join(", ")}`);
  assert.deepEqual([...treeOf(run.root)], [...run.tree], `${what}: restoring didn't bring the working tree back to its commit`);
  assert.equal(git(run.root, ["status", "--porcelain"]), "", `${what}: git sees changes after restoring`);
  const posts = new Set(intent.paths.map((one) => one.post.sha256));
  assert.deepEqual([...treeOf(run.root).values()].filter((entry) => posts.has(entry.split(" ")[2] ?? "")), [], `${what}: Nivra's new bytes are in the working tree after restoring`);
  assert.equal(reconcile(intent).state, "not-applied", `${what}: reconciling after restoring isn't not-applied`);
  // Every original still kept, or back in place: nothing lost by restoring.
  for (const one of intent.paths) if (one.change === "changed") assert.equal(onDisk(run.root, intent.recovery, one), "pre", `${what}: ${one.path} isn't its original after restoring`);
  assert.deepEqual(rowsIn(run.database), rows, `${what}: reconciling or restoring started or changed an apply`);
  return seen.state;
}

/** Runs `work` over `items`, a few at a time: each child has its own copy, journal and folders. */
async function inTurn<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, at) => from + at);

describe("an apply killed at every step, then reconciled (NIV-8, D40)", () => {
  it("keeps every original, reconciles writing nothing, and restores the commit, wherever the apply is killed", async () => {
    const fresh = copies(dirs);
    const clean = await child(fresh, { count: true });
    assert.deepEqual([clean.code, clean.signal], [0, null], clean.stderr);
    const calls = clean.calls!;
    assert.ok(calls.length > 30, `only ${calls.length} calls`);
    assert.equal(await holds(clean, "the apply that ran to its end"), "applied");
    const found = new Map<string, number>();
    await inTurn(range(0, calls.length), 6, async (at) => {
      const run = await child(fresh, { killAt: at });
      assert.equal(run.signal, "SIGKILL", `call ${at}: the child wasn't killed (exit ${run.code}): ${run.stderr}`);
      const left = await holds(run, `killed at call ${at} (${calls[at]})`);
      found.set(left, (found.get(left) ?? 0) + 1);
    });
    // The kills landed before the intent, before anything of the person's was touched, part way, and after the last link.
    assert.deepEqual([...found.keys()].sort(), ["applied", "no intent", "not-applied", "partial"], JSON.stringify([...found]));
  });

  it("does the same when the kill lands in rollback, after a link into place failed", async () => {
    const fresh = copies(dirs);
    const clean = await child(fresh, { count: true });
    const calls = clean.calls!;
    const firstAside = calls.indexOf("rename");
    const links = calls.flatMap((name, at) => (name === "link" && at > firstAside ? [at] : []));
    assert.equal(links.length, 3, "a link for each path");
    for (const failAt of [links[0]!, links.at(-1)!]) {
      const failed = await child(fresh, { failAt, count: true });
      assert.deepEqual([failed.code, failed.signal], [0, null], failed.stderr);
      assert.equal(await holds(failed, `EIO at call ${failAt}, rolled back`), "not-applied");
      const rollback = failed.calls!;
      assert.ok(rollback.length > failAt + 3, `only ${rollback.length - failAt - 1} calls after the failure`);
      const found = new Set<string>();
      await inTurn(range(failAt + 1, rollback.length), 6, async (at) => {
        const run = await child(fresh, { failAt, killAt: at });
        assert.equal(run.signal, "SIGKILL", `EIO at ${failAt}, call ${at}: the child wasn't killed (exit ${run.code}): ${run.stderr}`);
        found.add(await holds(run, `EIO at ${failAt}, then killed at call ${at} (${rollback[at]})`));
      });
      // Killed part way through the rollback, and once it was done.
      assert.deepEqual([...found].sort(), ["not-applied", "partial"], `EIO at ${failAt}: ${[...found].join(", ")}`);
    }
  });
});
