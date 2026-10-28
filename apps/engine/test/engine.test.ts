import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ErrorCode, isTerminal, preferencesDigest, PROTOCOL_VERSION, RpcCallError, type RunContext, type RunEvent } from "@nivra/domain";
import { MAX_CONCURRENT_RUNS } from "../src/runs/scheduler.ts";
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

const NO_PREFERENCES: RunContext = { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } };

const startHello = (engine: EngineProcess, repoPath: string, holdMs = 0, context: RunContext = NO_PREFERENCES) =>
  engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath, holdMs }, context });

const holdPid = (events: readonly RunEvent[]): number | null => {
  const started = events.find((event) => event.type === "command.started");
  const pid = started?.data?.["pid"];
  return typeof pid === "number" ? pid : null;
};

describe("engine over stdio", () => {
  it("answers initialize with where it runs, and keeps stdout to JSON-RPC alone", async () => {
    const { home, engine } = setup();
    const info = await engine.initialize();
    assert.equal(info.protocolVersion, 14);
    assert.equal(info.protocolVersion, PROTOCOL_VERSION);
    assert.equal(info.home, home);
    assert.match(info.homeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(info.platform, process.platform);
    assert.equal(info.runtimeHash, null);
    // The engine logs its readiness with console.log on purpose: it must arrive on stderr, never stdout.
    await waitFor(() => engine.stderr().includes("Nivra engine"), { what: "the ready line on stderr" });
    assert.deepEqual(impureLines(engine.lines), []);
    assert.deepEqual(engine.protocolErrors, []);
  });

  it("refuses work before initialize, unknown methods and invalid parameters, by code, and tells an unknown run apart (D26)", async () => {
    const { engine } = setup();
    assert.equal(await codeOf(engine.client.call("runs.list", {})), ErrorCode.NotInitialized);
    await engine.initialize();
    assert.equal(await codeOf(engine.client.call("runs.get", { runId: randomUUID() })), ErrorCode.RunNotFound);
    assert.equal(await engine.client.call("runs.find", { clientRequestId: randomUUID() }), null);
    // Parameters that fail their schema keep their own code, sent raw because the client checks them first.
    engine.child.stdin.write('{"jsonrpc":"2.0","id":98,"method":"runs.get","params":{"runId":"not-a-uuid"}}\n');
    await waitFor(() => engine.lines.some((line) => line.includes('"id":98') && line.includes(`"code":${ErrorCode.InvalidParams}`)), { what: "invalid parameters" });
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
    assert.deepEqual(steps, ["engine-info", "context", "repository", "git-version", "git-status", "hold"]);
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

  it("fails a run still queued when its engine died, without starting it: its context died with that engine (D21)", async () => {
    const { root, home, engine } = setup();
    const repo = makeRepo(root);
    await engine.initialize();
    // Held runs fill every slot, so the next one waits in the queue.
    for (let slot = 0; slot < MAX_CONCURRENT_RUNS; slot++) {
      const run = await startHello(engine, repo, 60_000);
      holdPids.push(holdPid((await engine.waitForRun(run.id, (p) => holdPid(p.events) !== null)).events)!);
    }
    const queued = await startHello(engine, repo);
    assert.equal(queued.status, "queued");
    engine.kill();
    await engine.exited;

    const next = startEngine(home);
    engines.push(next);
    await next.initialize();
    const summary = await next.client.call("runs.get", { runId: queued.id });
    assert.equal(summary.status, "failed");
    assert.equal(summary.error, "Interrupted by an engine restart before it started");
    const page = await next.client.call("runs.events", { runId: queued.id, after: 0, limit: 500 });
    assert.deepEqual(page.events.map((e) => e.type), ["run.queued", "run.interrupted"]);
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

  it("hands a run the preferences sent with it, and records their ids and fingerprint but never their text (D21)", async () => {
    const { root, home, engine } = setup();
    const marker = `nivra-input-marker-${randomUUID()}`;
    const repo = makeRepo(root, `repo ${marker}`);
    const canary = `nivra-preference-canary-${randomUUID()}`;
    const records = [
      { id: randomUUID(), statement: `Prefer named exports ${canary}`, scope: "personal" as const, intent: "default" as const, revision: 3 },
      { id: randomUUID(), statement: "Tests sit next to the code they test, ü%#", scope: "project" as const, intent: "override" as const, revision: 1 },
    ];
    await engine.initialize();
    const run = await startHello(engine, repo, 0, { preferences: { revision: 7, records }, sharing: { modelContext: false } });
    const page = await engine.waitForRun(run.id, (p) => isTerminal(p.status));
    assert.equal(page.status, "succeeded");
    const received = page.events.find((e) => e.type === "step.output" && e.stepId === "context");
    assert.match(received?.message ?? "", /^2 confirmed preferences from the app \(revision 7\), fingerprint [0-9a-f]{12}$/);
    assert.deepEqual(received?.data?.["records"], records.map(({ id, scope, intent, revision }) => ({ id, scope, intent, revision })));
    // Worked out here from what was sent, independently of the engine's code: equal only if every value arrived.
    const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [r.id, r.scope, r.intent, r.revision, r.statement]);
    assert.equal(received?.data?.["digest"], createHash("sha256").update(JSON.stringify(sorted)).digest("hex"));
    assert.equal(received?.data?.["digest"], await preferencesDigest(records));

    await engine.client.call("shutdown", {});
    await engine.exited;
    const files = readdirSync(home);
    // The scan can see what Mastra keeps: the run's input is in its step records.
    assert.ok(files.some((file) => file.startsWith("mastra.db") && readFileSync(join(home, file)).includes(marker)), "Mastra's records hold the run's input");
    const leaks = files.filter((file) => readFileSync(join(home, file)).includes(canary)).concat(engine.stderr().includes(canary) ? ["stderr"] : []);
    assert.deepEqual(leaks, [], "no preference text in nivra.db, mastra.db or the log");
  });

  it("refuses a run without its context, or with a snapshot outside the protocol, and records nothing", async () => {
    const { root, engine } = setup();
    const repo = makeRepo(root);
    await engine.initialize();
    // Written as raw lines: the client would refuse these parameters before sending them.
    const send = (id: number, context: unknown) =>
      engine.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "runs.start", params: { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: repo }, ...(context === undefined ? {} : { context }) } })}\n`);
    const answer = (id: number) =>
      waitFor(() => engine.lines.map((line) => JSON.parse(line) as { id?: number; error?: { code: number; message: string } }).find((m) => m.id === id), { what: `the answer to request ${id}` });
    const record = () => ({ id: randomUUID(), statement: "Use pnpm", scope: "personal", intent: "default", revision: 1 });
    const twice = record();
    send(901, undefined);
    send(902, { preferences: { revision: 1, records: [twice, twice] } });
    send(903, { preferences: { revision: 1, records: Array.from({ length: 51 }, record) } });
    send(904, { preferences: { revision: 1, records: [{ ...record(), statement: "" }] } });
    // Only a project's own preference can be a decision to change its conventions (D23).
    send(905, { preferences: { revision: 1, records: [{ ...record(), intent: "override" }] }, sharing: { modelContext: false } });
    for (const id of [901, 902, 903, 904, 905]) assert.equal((await answer(id)).error?.code, ErrorCode.InvalidParams, `request ${id}`);
    assert.match((await answer(901)).error?.message ?? "", /context/);
    assert.match((await answer(902)).error?.message ?? "", /Each preference appears once/);
    assert.match((await answer(905)).error?.message ?? "", /Only a project's own preference can override/);
    assert.equal((await engine.client.call("runs.list", {})).runs.length, 0);
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
