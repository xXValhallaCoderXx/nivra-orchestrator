import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { EngineOfflineError, EngineStartError, EngineSupervisor, type EngineState, type SupervisorOptions } from "../src/main/supervisor.ts";
import { LocalTarget } from "../src/main/targets/local.ts";

/**
 * The supervisor against the real engine, run from source on this machine's Node (the Local target's POSIX path), and
 * against two stand-ins: one that never answers and one that will not stop.
 */
const ENGINE = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const dirs: string[] = [];
const supervisors: EngineSupervisor[] = [];
after(async () => {
  await Promise.all(supervisors.map((s) => s.stop().catch(() => undefined)));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function supervisor(options: { entry?: string; home?: string; node?: string; overrides?: Partial<SupervisorOptions> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nivra supervisor ü%# "));
  dirs.push(root);
  const home = options.home ?? join(root, "engine home");
  const target = new LocalTarget({ platform: process.platform as "linux", runtime: { node: options.node ?? process.execPath, entry: options.entry ?? ENGINE, runtimeHash: null }, home });
  const states: EngineState["status"][] = [];
  const instance = new EngineSupervisor({
    target,
    logsDir: join(root, "logs"),
    client: { name: "supervisor-test", version: "0" },
    credentials: async () => ({}),
    heartbeatMs: 30_000,
    ...options.overrides,
  });
  instance.onChange((state) => states.push(state.status));
  supervisors.push(instance);
  return { instance, home, root, states };
}

describe("EngineSupervisor", () => {
  it("starts the engine, relays calls, and stops it in the quit order", async () => {
    const { instance, home, states } = supervisor();
    const info = await instance.start();
    assert.equal(info.home, home);
    assert.equal(instance.state.status, "online");
    const report = await instance.call("doctor", {});
    assert.ok(report.checks.some((check) => check.id === "git"));
    await instance.stop();
    assert.equal(instance.state.status, "stopped");
    assert.equal(isAlive(info.pid), false);
    assert.deepEqual([...new Set(states)], ["starting", "online", "stopped"]);
    await assert.rejects(instance.call("ping", {}), EngineOfflineError);
  });

  it("starts again after a stop, as a new engine instance", async () => {
    const { instance } = supervisor();
    const first = await instance.start();
    const second = await instance.restart();
    assert.notEqual(first.instanceId, second.instanceId);
    assert.equal(isAlive(first.pid), false);
  });

  it("hands the engine its keys in initialize, and only there (D8)", async () => {
    const { instance } = supervisor({ overrides: { credentials: async () => ({ NEBIUS_API_KEY: "test-key-0123456789" }) } });
    await instance.start();
    const report = await instance.call("doctor", {});
    assert.match(report.checks.find((check) => check.id === "boundaries")!.detail, /credentials set/);
  });

  it("reports a second engine on the same home as locked, by code", async () => {
    const first = supervisor();
    await first.instance.start();
    const second = supervisor({ home: first.home });
    await assert.rejects(second.instance.start(), (error: unknown) => error instanceof EngineStartError && error.code === "locked");
    assert.equal(second.instance.state.status === "failed" ? second.instance.state.code : null, "locked");
  });

  it("notices an engine that died, without starting it again", async () => {
    const { instance } = supervisor();
    const info = await instance.start();
    process.kill(info.pid, "SIGKILL");
    const deadline = performance.now() + 5_000;
    while (instance.state.status === "online" && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(instance.state.status, "failed");
    assert.match(instance.state.status === "failed" ? instance.state.reason : "", /stopped unexpectedly/);
  });

  it("refuses to start without the runtime, saying so", async () => {
    const { instance } = supervisor({ node: "/no/such/node" });
    await assert.rejects(instance.start(), (error: unknown) => error instanceof EngineStartError && error.code === "runtime-missing");
  });

  it("gives up on an engine that never answers, and stops it", async () => {
    const { instance } = supervisor({ entry: fixture("silent-engine.mjs"), overrides: { startTimeoutMs: 500 } });
    await assert.rejects(instance.start(), (error: unknown) => error instanceof EngineStartError && error.code === "no-answer");
    assert.equal(instance.state.status, "failed");
  });

  it("forces down an engine that ignores shutdown and the end of its input", async () => {
    const { instance } = supervisor({ entry: fixture("stubborn-engine.mjs"), overrides: { shutdownGraceMs: 300, eofGraceMs: 300 } });
    const info = await instance.start();
    const started = performance.now();
    await instance.stop();
    assert.equal(isAlive(info.pid), false);
    assert.ok(performance.now() - started < 5_000);
  });
});
