import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ErrorCode, isTerminal, RpcCallError, type RunEvent } from "@nivra/domain";
import { impureLines, isAlive, makeRepo, removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";

const engines: EngineProcess[] = [];
const dirs: string[] = [];
const holdPids: number[] = [];
after(() => {
  for (const engine of engines) engine.kill();
  for (const pid of holdPids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const dir of dirs) removeDir(dir);
});

function setup(options: { heartbeatMs?: number } = {}) {
  const root = tempDir();
  dirs.push(root);
  const home = join(root, "engine home");
  const engine = startEngine(home, options);
  engines.push(engine);
  return { root, home, engine };
}

const codeOf = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
    return 0;
  } catch (error) {
    return error instanceof RpcCallError ? error.code : -1;
  }
};

const startHello = (engine: EngineProcess, repoPath: string, holdMs = 0) =>
  engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath, holdMs } });

const holdPid = (events: readonly RunEvent[]): number | null => {
  const started = events.find((event) => event.type === "command.started");
  const pid = started?.data?.["pid"];
  return typeof pid === "number" ? pid : null;
};

describe("engine over stdio", () => {
  it("answers initialize with where it runs, and keeps stdout to JSON-RPC alone", async () => {
    const { home, engine } = setup();
    const info = await engine.initialize();
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.home, home);
    assert.equal(info.platform, process.platform);
    assert.equal(info.runtimeHash, null);
    // The engine logs its readiness with console.log on purpose: it must arrive on stderr, never stdout.
    await waitFor(() => engine.stderr().includes("Nivra engine"), { what: "the ready line on stderr" });
    assert.deepEqual(impureLines(engine.lines), []);
    assert.deepEqual(engine.protocolErrors, []);
  });

  it("refuses work before initialize, unknown methods and invalid parameters, by code", async () => {
    const { engine } = setup();
    assert.equal(await codeOf(engine.client.call("runs.list", {})), ErrorCode.NotInitialized);
    await engine.initialize();
    assert.equal(await codeOf(engine.client.call("runs.get", { runId: randomUUID() })), ErrorCode.InvalidParams);
    engine.child.stdin.write('{"jsonrpc":"2.0","id":99,"method":"no.such.method"}\n');
    engine.child.stdin.write("this is not json\n");
    await waitFor(() => engine.lines.some((line) => line.includes(`"code":${ErrorCode.MethodNotFound}`)), { what: "method-not-found" });
    await waitFor(() => engine.lines.some((line) => line.includes(`"code":${ErrorCode.ParseError}`)), { what: "parse error" });
  });

  it("runs hello on a repository whose path has a space, a non-ASCII letter, % and #", async () => {
    const { root, engine } = setup();
    const repo = makeRepo(root);
    await engine.initialize();
    const run = await startHello(engine, repo);
    const page = await engine.waitForRun(run.id, (p) => isTerminal(p.status));
    assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));
    const steps = page.events.filter((e) => e.type === "step.succeeded").map((e) => e.stepId);
    assert.deepEqual(steps, ["engine-info", "repository", "git-version", "git-status", "hold"]);
    const status = page.events.find((e) => e.type === "step.output" && e.stepId === "git-status");
    assert.equal(status?.data?.["branch"], "main");
    assert.deepEqual(impureLines(engine.lines), []);
  });

  it("fails hello on a folder that is not a repository, saying so", async () => {
    const { root, engine } = setup();
    await engine.initialize();
    const run = await startHello(engine, root);
    const page = await engine.waitForRun(run.id, (p) => isTerminal(p.status));
    assert.equal(page.status, "failed");
    const summary = await engine.client.call("runs.get", { runId: run.id });
    assert.match(summary.error ?? "", /is not inside a git repository/);
  });

  it("cancels a running hello and stops the process it started", async () => {
    const { root, engine } = setup();
    const repo = makeRepo(root);
    await engine.initialize();
    const run = await startHello(engine, repo, 60_000);
    const holding = await engine.waitForRun(run.id, (p) => holdPid(p.events) !== null);
    const pid = holdPid(holding.events)!;
    holdPids.push(pid);
    assert.equal(isAlive(pid), true);
    await engine.client.call("runs.cancel", { runId: run.id });
    const page = await engine.waitForRun(run.id, (p) => isTerminal(p.status), 10_000);
    assert.equal(page.status, "cancelled");
    await waitFor(() => !isAlive(pid), { timeoutMs: 5_000, what: `process ${pid} to stop` });
  });

  it("exits when its input closes", async () => {
    const { engine } = setup();
    await engine.initialize();
    const started = performance.now();
    engine.child.stdin.end();
    const { code } = await engine.exited;
    assert.equal(code, 0);
    assert.ok(performance.now() - started < 3_000, "exited within 3 s of EOF");
  });

  it("stops after three silent watchdog ticks, and not while the host keeps talking", async () => {
    const { engine } = setup({ heartbeatMs: 600 });
    await engine.initialize();
    const talking = setInterval(() => void engine.client.call("ping", {}).catch(() => undefined), 50);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    clearInterval(talking);
    assert.equal(engine.child.exitCode, null, "still running while pinged");
    const { code } = await engine.exited;
    assert.equal(code, 0);
    assert.match(engine.stderr(), /stopped answering/);
  });

  it("marks a run that was going when the engine died as interrupted, and never replays it", async () => {
    const { root, home, engine } = setup();
    const repo = makeRepo(root);
    await engine.initialize();
    const run = await startHello(engine, repo, 60_000);
    const holding = await engine.waitForRun(run.id, (p) => holdPid(p.events) !== null);
    holdPids.push(holdPid(holding.events)!);
    engine.kill();
    await engine.exited;

    const next = startEngine(home);
    engines.push(next);
    await next.initialize();
    const summary = await next.client.call("runs.get", { runId: run.id });
    assert.equal(summary.status, "failed");
    assert.equal(summary.error, "Interrupted by an engine restart");
    const page = await next.client.call("runs.events", { runId: run.id, after: 0, limit: 500 });
    assert.equal(page.events.at(-1)?.type, "run.interrupted");
    assert.equal(page.events.filter((e) => e.type === "run.started").length, 1, "started once, never again");
  });

  it("refuses a second engine on the same home, by an engine.fatal code", async () => {
    const { home, engine } = setup();
    await engine.initialize();
    const second = startEngine(home);
    engines.push(second);
    const { code } = await second.exited;
    assert.equal(code, 3);
    assert.deepEqual(second.notifications.map((n) => [n.method, (n.params as { code?: string }).code]), [["engine.fatal", "locked"]]);
    const pong = await engine.client.call("ping", {});
    assert.equal(pong.instanceId.length, 36, "the first engine still answers");
  });

  it("reports bad arguments by an engine.fatal code", async () => {
    const root = tempDir();
    dirs.push(root);
    const engine = startEngine(root, { args: ["--stdio", "--home", "relative/home"] });
    engines.push(engine);
    const { code } = await engine.exited;
    assert.equal(code, 4);
    assert.equal((engine.notifications[0]?.params as { code?: string } | undefined)?.code, "bad-arguments");
  });

  it("refuses providers.check without a key, by code, before any network call", async () => {
    const { engine } = setup();
    await engine.initialize();
    await assert.rejects(engine.client.call("providers.check", {}), (error: unknown) => {
      assert.ok(error instanceof RpcCallError);
      assert.equal(error.code, ErrorCode.InvalidParams);
      assert.match(error.message, /No Nebius key is set/);
      return true;
    });
  });

  it("never writes a secret to its databases or logs", async () => {
    const { root, home, engine } = setup();
    const repo = makeRepo(root);
    const canary = `nivra-canary-${randomUUID()}`;
    const replaced = `nivra-canary-${randomUUID()}`;
    await engine.initialize({ NEBIUS_API_KEY: canary });
    const run = await startHello(engine, repo);
    await engine.waitForRun(run.id, (p) => isTerminal(p.status));
    await engine.client.call("doctor", {});
    await engine.client.call("secrets.update", { set: { NEBIUS_API_KEY: replaced }, remove: [] });
    await engine.client.call("shutdown", {});
    await engine.exited;
    const leaks = readdirSync(home)
      .filter((file) => {
        const bytes = readFileSync(join(home, file));
        return bytes.includes(canary) || bytes.includes(replaced);
      })
      .concat(engine.stderr().includes(canary) || engine.stderr().includes(replaced) ? ["stderr"] : []);
    assert.deepEqual(leaks, []);
  });
});
