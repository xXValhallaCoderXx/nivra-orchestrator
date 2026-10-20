import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ErrorCode, type WorkflowId } from "@nivra/domain";
import { BOUNDARY_UNAVAILABLE_MESSAGE, errorFacts, EXEC_REFUSED_MESSAGE, formatDiagnostic, internalMessage, publicFailure, Refusal, safeClass, type Diagnostic } from "../src/diagnostics.ts";
import { Database } from "../src/db/database.ts";
import { crashReport } from "../src/engine.ts";
import { BoundaryUnavailableError, ExecRefusedError } from "../src/exec/backend.ts";
import { failure, ModelFailure, toModelFailure } from "../src/providers/model.ts";
import { RepoError } from "../src/repo/paths.ts";
import { ProtocolOutput } from "../src/rpc/output.ts";
import { RpcFailure, RpcServer, type Handlers } from "../src/rpc/server.ts";
import { RunScheduler, settleOutcome, type RunHandle, type WorkflowEntry, type WorkflowSource } from "../src/runs/scheduler.ts";
import { RunStore } from "../src/runs/store.ts";
import { publicError } from "../src/workflows/guard.ts";
import { removeDir, tempDir, waitFor } from "./helpers.ts";

/**
 * Safe diagnostics (NIV-27, D29): what the engine logs, stores and answers about a failure is Nivra's own, never what
 * the error said. PRIVATE is the kind of text that worries: no key pattern and no known secret, so masking keeps it,
 * and it isn't shaped like a code, a stage or an id either.
 */
const PRIVATE = `Private repository text ${randomUUID()}`;
const holds = (value: unknown) => JSON.stringify(value).includes(PRIVATE);

describe("errorFacts and safeClass (NIV-27)", () => {
  it("names an error by its allowlisted classes, a known code, how deep its causes go and its message's length, never its words", () => {
    const inner = Object.assign(new Error(`inner ${PRIVATE}`), { code: "ECONNRESET" });
    const middle = new TypeError(`middle ${PRIVATE}`, { cause: inner });
    const outer = new Error(`outer ${PRIVATE}`, { cause: middle });
    outer.name = `Custom ${PRIVATE}`;
    const facts = errorFacts(outer);
    assert.deepEqual(facts, { classes: ["unknown", "TypeError", "Error"], errno: "ECONNRESET", causes: 2, messageChars: `outer ${PRIVATE}`.length });
    assert.equal(holds(facts), false);
    assert.deepEqual([safeClass(outer), safeClass(middle), safeClass(PRIVATE)], [null, "TypeError", null]);
  });

  it("survives a cycle, a throwing getter, a proxy, a 5 MB message, AggregateError and values that aren't errors", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    assert.deepEqual([errorFacts(b).classes, errorFacts(b).causes], [["Error", "Error"], 1], "a cycle is followed once");
    const getter = Object.defineProperty({}, "name", {
      get() {
        throw new Error(PRIVATE);
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error(PRIVATE);
        },
      },
    );
    assert.deepEqual([errorFacts(getter).classes, errorFacts(proxy)], [["unknown"], { classes: ["unknown"], errno: null, causes: 0, messageChars: null }]);
    assert.equal(errorFacts(new Error(`${"x".repeat(5_000_000)}${PRIVATE}`)).messageChars, 5_000_000 + PRIVATE.length);
    assert.deepEqual(errorFacts(new AggregateError([new Error(PRIVATE)], PRIVATE)).classes, ["AggregateError"]);
    assert.deepEqual([PRIVATE, undefined, null, 42].map((value) => errorFacts(value).classes), [["(string)"], ["(undefined)"], ["(null)"], ["(number)"]]);
    assert.equal(errorFacts(Object.assign(new Error("x"), { code: PRIVATE })).errno, null, "only a known code is kept");
    const deep = Array.from({ length: 20 }).reduce<unknown>((cause) => new Error("x", { cause }), new Error("root"));
    assert.deepEqual([errorFacts(deep).classes.length, errorFacts(deep).causes], [4, 8], "at most four classes and eight causes");
  });
});

describe("formatDiagnostic (NIV-27)", () => {
  it("writes one bounded line, and drops a field that isn't safe rather than writing it", () => {
    const request = randomUUID();
    const line = formatDiagnostic({
      code: "unexpected-error",
      stage: "models.list",
      reason: PRIVATE,
      kind: PRIVATE,
      run: PRIVATE,
      request,
      workflow: "explain",
      step: PRIVATE,
      rpc: PRIVATE,
      method: PRIVATE,
      counts: { elapsedMs: 12.4, [PRIVATE]: 1, negative: -1 },
      error: { classes: [PRIVATE, "TypeError"], errno: PRIVATE, causes: 99, messageChars: 7 },
    });
    assert.ok(line.startsWith("diagnostic {") && line.length <= 1_000, line);
    assert.equal(line.includes(PRIVATE), false);
    assert.deepEqual(JSON.parse(line.slice("diagnostic ".length)), {
      code: "unexpected-error",
      stage: "models.list",
      error: { classes: ["unknown", "TypeError"], errno: null, causes: 8, messageChars: 7 },
      request,
      workflow: "explain",
      counts: { elapsedMs: 12 },
    });
    const invalid = JSON.parse(formatDiagnostic({ code: PRIVATE, stage: PRIVATE } as unknown as Diagnostic).slice("diagnostic ".length));
    assert.deepEqual(invalid, { code: "unexpected-error", stage: "unknown" });
  });
});

describe("publicFailure (NIV-27)", () => {
  it("keeps the message only of a failure Nivra wrote, wherever Mastra put it, and checks its kind", () => {
    const limited = failure("rate-limit", "20 s", 429, 20);
    const found = publicFailure(limited);
    assert.deepEqual([found?.message, found?.kind, found?.retryAfterSeconds, found?.code], [limited.message, "rate-limit", 20, "model-failure"]);
    // As Mastra stores a step's error: a plain object, wrapped.
    const stored = { name: "MastraError", message: PRIVATE, cause: JSON.parse(JSON.stringify({ ...limited, name: limited.name, message: limited.message })) as unknown };
    assert.equal(publicFailure(stored)?.message, limited.message);
    assert.equal(publicFailure({ name: "ModelFailure", message: "Nivra's words.", kind: PRIVATE })?.kind, "internal", "a kind that isn't one is internal");
    assert.deepEqual([publicFailure(new Error(PRIVATE)), publicFailure(Object.assign(new TypeError(PRIVATE), { kind: "auth" }))], [null, null]);
  });

  it("gives an execution boundary's errors fixed words: their own can quote a spawn error or a path", () => {
    const refused = publicFailure(new ExecRefusedError(`Could not start /opt/${PRIVATE}/git: spawn ENOENT`));
    const boundary = publicFailure(new BoundaryUnavailableError(`No sandbox for ${PRIVATE}`));
    assert.deepEqual([refused?.message, refused?.code, boundary?.message, boundary?.code], [EXEC_REFUSED_MESSAGE, "exec-refused", BOUNDARY_UNAVAILABLE_MESSAGE, "exec-refused"]);
    const repo = publicFailure(new RepoError("git-failed", "git ls-files failed (exit 128)."));
    assert.deepEqual([repo?.code, repo?.reason, publicFailure(new Refusal("folder-missing", "Gone."))?.code], ["git-failed", "git-failed", "refused"]);
  });
});

describe("what a step may throw (NIV-27)", () => {
  const mask = (text: string) => text.replaceAll("SECRETVALUE", "[masked]");

  it("keeps Nivra's own failures, masked; turns an exec error into fixed words, and anything else into internal with its facts", () => {
    const unknown = publicError(Object.assign(new TypeError(PRIVATE), { code: "ENOENT" }), "explain.prepare", mask);
    assert.ok(unknown instanceof ModelFailure);
    assert.deepEqual([unknown.kind, unknown.message, unknown.facts?.code, unknown.facts?.stage, unknown.facts?.error?.classes, unknown.facts?.error?.errno], [
      "internal",
      internalMessage("TypeError"),
      "unexpected-error",
      "explain.prepare",
      ["TypeError"],
      "ENOENT",
    ]);
    const exec = publicError(new ExecRefusedError(`Could not start /bin/${PRIVATE}`), "explain.prepare", mask);
    assert.deepEqual([exec instanceof Refusal, exec.message], [true, EXEC_REFUSED_MESSAGE]);
    const repo = publicError(new RepoError("bad-glob", "SECRETVALUE isn't a glob."), "explain.explain", mask);
    assert.equal(repo.message, "[masked] isn't a glob.");
    for (const error of [unknown, exec, repo]) assert.equal(holds({ ...error, message: error.message }), false);
  });

  it("names an unexpected error by an allowlisted class at most, keeping where it happened", () => {
    const odd = Object.assign(new Error(PRIVATE), { name: `Odd ${PRIVATE}` });
    const named = toModelFailure(odd, "models.list");
    assert.deepEqual([named.kind, named.message, named.facts?.stage, named.facts?.error?.classes], ["internal", internalMessage(), "models.list", ["unknown"]]);
    assert.equal(holds({ ...named, message: named.message }), false);
  });

  it("reports a crash as one diagnostic line and fixed words", () => {
    const report = crashReport(new RangeError(PRIVATE));
    assert.match(report.line, /^diagnostic \{"code":"crashed","stage":"process"/);
    assert.equal(holds(report), false);
  });
});

describe("settling a run and answering a request (NIV-27)", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) removeDir(dir);
  });

  it("stores a failure in Nivra's words: never the error's own text, and an unknown error as internal", () => {
    const failed = settleOutcome({ status: "failed", error: { name: "Error", message: PRIVATE, cause: { message: PRIVATE } } }, false);
    assert.deepEqual([failed.status, failed.error, failed.event.data, failed.diagnostic?.code], ["failed", internalMessage(), { kind: "internal" }, "unexpected-error"]);
    const guarded = settleOutcome({ status: "tripwire", tripwire: { reason: PRIVATE } }, false);
    const refused = settleOutcome({ status: "failed", error: { name: "Refusal", message: "The project's folder doesn't exist on this target.", code: "folder-missing" } }, false);
    assert.deepEqual([refused.error, refused.event.data, refused.diagnostic?.reason], ["The project's folder doesn't exist on this target.", undefined, "folder-missing"]);
    assert.equal(holds([failed, guarded, refused]), false);
  });

  it("answers a handler's unknown error in Nivra's words with one diagnostic, and a refusal's cause only in its diagnostic", async () => {
    const sent: string[] = [];
    const logged: string[] = [];
    const diagnostics: Diagnostic[] = [];
    const output = new ProtocolOutput((chunk, callback) => {
      sent.push(chunk);
      callback();
      return true;
    });
    let calls = 0;
    const handlers = {
      ping: () => {
        calls++;
        if (calls === 1) throw Object.assign(new TypeError(PRIVATE), { code: "ECONNRESET" });
        throw new RpcFailure(ErrorCode.InternalError, "Nivra's own words.", { kind: "internal" }, { cause: failure("internal", "TypeError").because("unexpected-error", "models.list", new TypeError(PRIVATE)) });
      },
    } as unknown as Handlers;
    const server = new RpcServer({ output, handlers, initialized: () => true, stopping: () => false, mask: (text) => text, log: (line) => logged.push(line), diagnose: (d) => diagnostics.push(d) });
    server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping", params: {} }));
    await server.idle();
    server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping", params: {} }));
    await server.idle();
    const replies = sent.map((line) => JSON.parse(line) as { id: number; error: { code: number; message: string; data: unknown } });
    assert.deepEqual(
      replies.map((reply) => [reply.id, reply.error.code, reply.error.message, reply.error.data]),
      [
        [7, ErrorCode.InternalError, internalMessage(), { kind: "internal" }],
        [8, ErrorCode.InternalError, "Nivra's own words.", { kind: "internal" }],
      ],
    );
    assert.deepEqual(
      diagnostics.map((d) => [d.code, d.stage, d.rpc, d.method, d.error?.classes, d.error?.errno]),
      [
        ["unexpected-error", "ping", 7, "ping", ["TypeError"], "ECONNRESET"],
        ["unexpected-error", "models.list", 8, "ping", ["TypeError"], null],
      ],
    );
    assert.equal(holds([sent, logged, diagnostics.map(formatDiagnostic)]), false);
  });

  it("stores a run's unknown failure in Nivra's words, keeps the step event free of it, and writes one diagnostic with the run's ids", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const database = new Database(join(dir, "nivra.db"));
    database.open();
    const store = new RunStore({ database });
    const diagnostics: Diagnostic[] = [];
    const workflows = new Map<WorkflowId, WorkflowEntry>([["hello", { id: "hello", title: () => "Hello" }]]);
    const scheduler = new RunScheduler({ store, workflows, instanceId: randomUUID(), log: { info: () => undefined, warn: () => undefined, error: () => undefined }, diagnose: (d) => diagnostics.push(d) });
    const handle: RunHandle = {
      start: async () => ({ status: "failed", error: { name: "Error", message: PRIVATE, cause: { name: "TypeError", message: PRIVATE } } }),
      cancel: async () => undefined,
      watch: (callback) => {
        callback({ type: "workflow-step-result", payload: { id: "repository", status: "failed", error: { name: "Error", message: PRIVATE } } });
        return () => undefined;
      },
    };
    const source: WorkflowSource = { getWorkflow: () => ({ createRun: async () => handle }) };
    scheduler.attach(source);
    scheduler.recover();
    const clientRequestId = randomUUID();
    const runId = scheduler.submit({ clientRequestId, workflowId: "hello", input: { repoPath: "/repo", holdMs: 0 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } });
    await waitFor(() => (store.status(runId) === "failed" ? true : null), { what: "the run to fail" });
    const summary = store.summary(runId);
    const events = store.events(runId, 0, 100);
    assert.deepEqual([summary?.error, events?.events.find((e) => e.type === "step.failed")?.message], [internalMessage(), `repository failed: ${internalMessage()}`]);
    await waitFor(() => (diagnostics.length ? true : null), { what: "the diagnostic" });
    assert.deepEqual(
      diagnostics.map((d) => [d.code, d.stage, d.kind, d.run, d.request, d.workflow, d.step, d.error?.classes]),
      [["unexpected-error", "repository", "internal", runId, clientRequestId, "hello", "repository", ["Error", "TypeError"]]],
    );
    assert.equal(holds([summary, events, diagnostics.map(formatDiagnostic)]), false);
    database.close();
  });
});
