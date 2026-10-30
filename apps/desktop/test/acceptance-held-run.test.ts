import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { captureHeldChild, copyRunStore, readRuns, Refused, stopHeldChild, type HeldChild } from "../scripts/acceptance-state.ts";
import { isAlive, makeRepo, startEngine, waitFor, type EngineProcess } from "../../engine/test/helpers.ts";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
const uid = process.getuid!();

function root() {
  const dir = mkdtempSync(join(tmpdir(), "nivra held rehearsal "));
  dirs.push(dir);
  return dir;
}

function fixture(options: { parent?: number; group?: number; started?: string; state?: string; marker?: boolean } = {}, proc = join(root(), "proc")) {
  const pid = 4242;
  const fields = [options.state ?? "S", String(options.parent ?? 4241), String(options.group ?? pid), ...Array<string>(17).fill("0")];
  fields[19] = options.started ?? "123456";
  mkdirSync(join(proc, String(pid)), { recursive: true });
  writeFileSync(join(proc, String(pid), "stat"), `${pid} (node with spaces) ${fields.join(" ")}\n`);
  writeFileSync(join(proc, String(pid), "cmdline"), ["node", "-e", "setTimeout(() => {}, 60000)", ...(options.marker === false ? [] : ["--nivra-hold"])].join("\0") + "\0");
  return { pid, proc };
}

describe("held hello rehearsal cleanup (NIV-25)", () => {
  it("captures only its engine's own held child and its process group, owned by this user", () => {
    const { pid, proc } = fixture();
    assert.deepEqual(captureHeldChild(pid, 4241, uid, proc), { pid, uid, started: "123456" });
    for (const options of [{ parent: 99 }, { group: 99 }, { marker: false }, { state: "Z" }]) {
      fixture(options, proc);
      assert.throws(() => captureHeldChild(pid, 4241, uid, proc), Refused);
    }
    fixture({}, proc);
    assert.throws(() => captureHeldChild(pid, 4241, uid + 1, proc), Refused);
    assert.throws(() => captureHeldChild(9999, 4241, uid, proc), Refused);
  });

  it("stops the captured process group after its engine dies and it is reparented", async () => {
    const { pid, proc } = fixture();
    const child = captureHeldChild(pid, 4241, uid, proc);
    fixture({ parent: 1 }, proc);
    const killed: Array<[number, NodeJS.Signals]> = [];
    await stopHeldChild(child, { proc, kill: (group, signal) => {
      killed.push([group, signal]);
      rmSync(join(proc, String(pid)), { recursive: true });
    } });
    assert.deepEqual(killed, [[-pid, "SIGKILL"]]);
    assert.equal(existsSync(join(proc, String(pid))), false);
  });

  it("never kills a reused pid, another group or user, or a process that no longer names the fixture", async () => {
    for (const options of [{ started: "654321" }, { group: 99 }, { marker: false }]) {
      const { pid, proc } = fixture();
      const child = captureHeldChild(pid, 4241, uid, proc);
      fixture(options, proc);
      const killed: number[] = [];
      await assert.rejects(stopHeldChild(child, { proc, kill: (pid) => { killed.push(pid); } }), Refused);
      assert.equal(killed.length, 0);
    }
    const { pid, proc } = fixture();
    const child = captureHeldChild(pid, 4241, uid, proc);
    await assert.rejects(stopHeldChild({ ...child, uid: uid + 1 }, { proc, kill: () => assert.fail("must not kill") }), Refused);
  });

  it("accepts an already exited child without signalling anything and reports an unsuccessful stop", async () => {
    const { pid, proc } = fixture();
    const child = captureHeldChild(pid, 4241, uid, proc);
    fixture({ state: "Z" }, proc);
    await stopHeldChild(child, { proc, kill: () => assert.fail("must not kill a zombie") });
    rmSync(join(proc, String(pid)), { recursive: true });
    await stopHeldChild(child, { proc, kill: () => assert.fail("must not kill a missing process") });
    fixture({}, proc);
    await assert.rejects(stopHeldChild(child, { proc, timeoutMs: 0, kill: () => undefined }), /didn't stop/);
  });

  it("cleans the killed rehearsal's real child, then another held run shuts down cancelled without replay", async () => {
    const dir = root();
    const repo = makeRepo(dir);
    const home = join(dir, "engine home");
    const engines: EngineProcess[] = [];
    const children: HeldChild[] = [];
    const launch = async () => {
      const engine = startEngine(home);
      engines.push(engine);
      const info = await engine.initialize();
      return { engine, info };
    };
    const hold = async (engine: EngineProcess, pid: number) => {
      const run = await engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: repo, holdMs: 60_000 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } });
      const held = await engine.waitForRun(run.id, (page) => page.events.some((event) => event.type === "command.started" && event.stepId === "hold"));
      const childPid = held.events.find((event) => event.type === "command.started" && event.stepId === "hold")?.data?.["pid"];
      assert.equal(typeof childPid, "number");
      const child = captureHeldChild(childPid as number, pid, uid);
      children.push(child);
      return { id: run.id, child };
    };
    try {
      const first = await launch();
      const killed = await hold(first.engine, first.info.pid);
      first.engine.kill();
      await first.engine.exited;
      assert.equal(isAlive(killed.child.pid), true, "SIGKILL bypassed the engine's fixture cleanup");
      await stopHeldChild(killed.child);
      await waitFor(() => !isAlive(killed.child.pid), { timeoutMs: 5_000, what: "the orphaned fixture to exit" });

      const second = await launch();
      const interrupted = await second.engine.client.call("runs.events", { runId: killed.id, after: 0, limit: 500 });
      assert.equal(interrupted.status, "failed");
      assert.equal(interrupted.events.at(-1)?.type, "run.interrupted");
      assert.equal(interrupted.events.filter((event) => event.type === "run.started").length, 1);
      const closed = await hold(second.engine, second.info.pid);
      const at = performance.now();
      await second.engine.client.call("shutdown", {});
      await second.engine.exited;
      assert.ok(performance.now() - at <= 7_000, "shutdown stayed within D4's graces");
      assert.equal(isAlive(closed.child.pid), false);
      copyRunStore(home, join(dir, "copy"));
      const row = readRuns(join(dir, "copy")).find((row) => row.id === closed.id);
      assert.equal(row?.status, "cancelled");
      assert.equal(row.lastEvent?.message, "Cancelled: the app asked it to stop");

      const third = await launch();
      const after = await third.engine.client.call("runs.events", { runId: closed.id, after: 0, limit: 500 });
      assert.equal(after.status, "cancelled");
      assert.equal(after.events.filter((event) => event.type === "run.started").length, 1);
      await third.engine.client.call("shutdown", {});
      await third.engine.exited;
    } finally {
      for (const child of children) await stopHeldChild(child);
      for (const engine of engines) engine.kill();
      await Promise.all(engines.map((engine) => engine.exited));
    }
  });
});
