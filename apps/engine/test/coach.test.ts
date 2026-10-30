import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  COACH_PROFILE,
  COACH_TOOL,
  coachPacketDigest,
  coachRoleMarker,
  ErrorCode,
  isTerminal,
  preferencesDigest,
  RpcCallError,
  type CoachPacket,
  type CoachReport,
  type PreferenceSnapshot,
  type RunEventsPage,
} from "@nivra/domain";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * A coaching of one task's brief over stdio (NIV-53), against a loopback stub of Token Factory: one listing and one
 * forced request, a report bound to what was sent, the same request id refused with any other input, an engine killed
 * mid-request read back as interrupted with nothing sent again, and refusals that send nothing. No real model is called.
 */
const KEY = "test-key-0123456789abcdef";
const engines: EngineProcess[] = [];
const stubs: Stub[] = [];
const dirs: string[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});

const CANARY = `nivra-coach-canary-${randomUUID()}`;
const PACKET: CoachPacket = {
  scope: { kind: "general" },
  task: {
    title: "Personal records use one unit",
    briefVersion: 3,
    goal: "Fix finish-time records that compare miles with kilometres",
    acceptanceCriteria: ["It works"],
    scope: "",
    exclusions: "",
    context: `Older runs have no unit. ${CANARY}`,
    assumptions: ["Every run stores its unit"],
    checks: [],
    caseNames: [],
    baselineChecks: 0,
    frozenFiles: 0,
  },
  gaps: [{ code: "criterion-vague", tier: "could-help", field: "acceptanceCriteria", item: 1, missing: 'Criterion 1 may be hard to check: "It works"' }],
  mission: null,
  findings: [],
};
const PERSONAL = { id: randomUUID(), statement: "Prefer small, reversible changes", scope: "personal" as const, intent: "default" as const, revision: 1 };
const ANSWER = {
  summary: "The goal is clear. The criterion doesn't say what someone would see.",
  questions: [{ text: "Which unit should records use?", why: "The criterion needs one to check.", field: "acceptanceCriteria" }],
  changes: [
    { field: "acceptanceCriteria", reword: [{ item: 1, text: "A 5 km run logged in miles shows its record in kilometres" }], add: ["A run with no unit is left out"], reason: "Says what someone would see.", refs: ["G1", "C1"] },
    { field: "context", append: "Today, a run logged in miles is compared as if it were in kilometres.", reason: "Says what happens now.", refs: [] },
  ],
  suggestedChecks: [{ name: "Units", command: "pnpm --filter @sheetless/data test", expectedOutput: "", expectedExitCode: 0, reason: "Runs the suite." }],
  unknowns: ["Whether older runs store a unit."],
};
const isCoach = (request: StubRequest) => JSON.stringify(request.body?.messages ?? []).includes(coachRoleMarker());
const listings = (stub: Stub) => stub.requests.filter((request) => request.path.endsWith("/models")).length;

async function engineAt(url: string, options: { home?: string; key?: boolean } = {}) {
  const root = tempDir();
  dirs.push(root);
  const home = options.home ?? join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", url] });
  engines.push(engine);
  await engine.initialize(options.key === false ? {} : { NEBIUS_API_KEY: KEY });
  return { engine, home };
}

async function setup(chat: (request: StubRequest) => Reply | Promise<Reply>, options: { models?: Array<{ id: string; context_length?: number }>; key?: boolean } = {}) {
  const stub = await startStub({ models: options.models ?? [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat });
  stubs.push(stub);
  return { stub, ...(await engineAt(stub.url, { key: options.key })) };
}

interface Start {
  packet?: CoachPacket;
  preferences?: PreferenceSnapshot;
  modelContext?: boolean;
  clientRequestId?: string;
  input?: Record<string, unknown>;
}
async function startCoaching(engine: EngineProcess, options: Start = {}) {
  const packet = options.packet ?? PACKET;
  const preferences = options.preferences ?? { revision: 2, records: [PERSONAL] };
  const input = {
    taskId: randomUUID(),
    briefId: randomUUID(),
    briefVersion: packet.task.briefVersion,
    bindingDigest: "b".repeat(64),
    packetDigest: await coachPacketDigest(packet),
    preferencesDigest: await preferencesDigest(preferences.records),
    profile: { id: COACH_PROFILE.id, version: COACH_PROFILE.version },
    ...options.input,
  };
  const clientRequestId = options.clientRequestId ?? randomUUID();
  const run = await engine.client.call("runs.start", { clientRequestId, workflowId: "coach", input: input as never, context: { preferences, sharing: { modelContext: options.modelContext ?? false }, packet } });
  return { run, input, clientRequestId };
}
const finished = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
const reportOf = async (engine: EngineProcess, runId: string) => (await engine.client.call("runs.coach", { runId })) as CoachReport | null;
const failure = (page: RunEventsPage) => page.events.find((event) => event.type === "run.failed");

describe("a coaching over stdio (NIV-53)", () => {
  it("coaches on Nemotron 3.5 Super VL, preferred over Super, with one forced request now that a check has seen it force an answer (D50)", async () => {
    const models = [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 262_144 }, { id: "nvidia/Nemotron-3.5-Super-VL", context_length: 1_048_576 }];
    const { stub, engine } = await setup(() => toolCall(COACH_TOOL, ANSWER), { models });
    const { run } = await startCoaching(engine);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((event) => event.message).join(" | "));
    const [chat] = stub.chats();
    assert.deepEqual(
      [stub.chats().length, chat?.body?.model, chat?.body?.tool_choice, typeof chat?.body?.max_completion_tokens, chat?.body ? Object.hasOwn(chat.body, "max_tokens") : null],
      [1, "nvidia/Nemotron-3.5-Super-VL", { type: "function", function: { name: COACH_TOOL } }, "number", false],
    );
  });

  it("lists the models once, sends one forced request, and keeps a report bound to what was sent, under a title with no task words", async () => {
    const { stub, engine, home } = await setup(() => toolCall(COACH_TOOL, ANSWER));
    const { run, input, clientRequestId } = await startCoaching(engine);
    assert.equal(run.title, "Coach · brief v3");
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((event) => event.message).join(" | "));
    const [chat] = stub.chats();
    assert.deepEqual([listings(stub), stub.chats().length, isCoach(chat!)], [1, 1, true]);
    assert.deepEqual(chat?.body?.tool_choice, { type: "function", function: { name: COACH_TOOL } });
    assert.deepEqual(((chat?.body?.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name), [COACH_TOOL]);
    const report = await reportOf(engine, run.id);
    assert.ok(report);
    assert.deepEqual(
      [report.outcome, report.taskId, report.briefVersion, report.bindingDigest, report.packetDigest, report.preferencesDigest, report.profile, report.request],
      ["complete", input.taskId, 3, input.bindingDigest, input.packetDigest, input.preferencesDigest, { id: COACH_PROFILE.id, version: COACH_PROFILE.version }, { runId: run.id, clientRequestId }],
    );
    assert.deepEqual([report.questions.length, report.changes.map((change) => change.field), report.suggestedChecks.length, report.stage.requests], [1, ["acceptanceCriteria", "context"], 1, 1]);
    // The packet stays in memory: not in the run's stored input, its events, Mastra's records or the engine's log.
    const summary = await engine.client.call("runs.get", { runId: run.id });
    assert.equal(JSON.stringify(summary).includes(CANARY), false);
    assert.equal(JSON.stringify(page.events).includes(CANARY), false);
    assert.equal(stub.requests.some((request) => request.raw.includes(KEY)), false, "the key never leaves");
    await engine.client.call("shutdown", {});
    await engine.exited;
    const mastra = readdirSync(home).filter((file) => file.startsWith("mastra.db"));
    assert.deepEqual(mastra.filter((file) => readFileSync(join(home, file)).includes(CANARY)), [], "Mastra's records never hold the brief");
    assert.equal(engine.stderr().includes(CANARY) || engine.stderr().includes(KEY), false);
  });

  it("answers a repeated request with its own run, and refuses the same id with any other part of what it is bound to", async () => {
    const { stub, engine } = await setup(() => toolCall(COACH_TOOL, ANSWER));
    const first = await startCoaching(engine);
    await finished(engine, first.run.id);
    const again = await engine.client.call("runs.start", { clientRequestId: first.clientRequestId, workflowId: "coach", input: first.input as never, context: { preferences: { revision: 2, records: [PERSONAL] }, sharing: { modelContext: false }, packet: PACKET } });
    assert.equal(again.id, first.run.id, "the same request is the same run");
    const changed = [
      { briefVersion: 4 },
      { bindingDigest: "c".repeat(64) },
      { packetDigest: "c".repeat(64) },
      { preferencesDigest: "c".repeat(64) },
      { profile: { id: COACH_PROFILE.id, version: COACH_PROFILE.version + 1 } },
      { model: "nvidia/nemotron-3-super-120b-a12b" },
    ];
    for (const part of changed) {
      await assert.rejects(
        engine.client.call("runs.start", { clientRequestId: first.clientRequestId, workflowId: "coach", input: { ...first.input, ...part } as never, context: { preferences: { revision: 2, records: [PERSONAL] }, sharing: { modelContext: false }, packet: PACKET } }),
        (error: unknown) => error instanceof RpcCallError && error.code === ErrorCode.InvalidParams && /already started another run, with other input/.test(error.message),
        JSON.stringify(part),
      );
    }
    assert.equal(stub.chats().length, 1, "nothing was sent for any of them");
  });

  it("keeps what it saved when its engine is killed mid-request, reads as interrupted after a restart, and sends nothing again", async () => {
    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: () => ({ ...toolCall(COACH_TOOL, ANSWER), delayMs: 30_000 }) });
    stubs.push(stub);
    const first = await engineAt(stub.url);
    const { run } = await startCoaching(first.engine);
    await waitFor(async () => (stub.chats().length === 1 ? true : null), { what: "the coach's request", timeoutMs: 10_000 });
    first.engine.kill();
    await first.engine.exited;
    const second = await engineAt(stub.url, { home: first.home });
    const page = await finished(second.engine, run.id);
    const report = await reportOf(second.engine, run.id);
    assert.deepEqual([page.status, page.events.some((event) => event.type === "run.interrupted")], ["failed", true]);
    assert.deepEqual([report?.outcome, report?.stage.status, report?.stage.reason], ["interrupted", "failed", "interrupted"]);
    assert.match(report?.stage.message ?? "", /may have been sent/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(stub.chats().length, 1, "nothing was sent again");
  });

  it("keeps a malformed answer's diagnostics and no proposal, with exactly one request", async () => {
    const { stub, engine } = await setup(() => text("Sure, here are my thoughts on the brief."));
    const { run } = await startCoaching(engine);
    const page = await finished(engine, run.id);
    const report = await reportOf(engine, run.id);
    assert.deepEqual([page.status, report?.outcome, report?.stage.kind, report?.changes.length, stub.chats().length], ["failed", "failed", "malformed", 0, 1]);
    assert.equal(JSON.stringify(report).includes("here are my thoughts"), false, "the model's own words aren't kept as a diagnostic");
  });

  it("records reported reasoning as part of an 8,000-token truncated completion, retaining unknown usage and sending nothing again", async () => {
    for (const reasoning of [1_200, 0, undefined, 8_001]) {
      const { stub, engine } = await setup(() => ({ body: {
        id: "coach-output-limit", model: "nvidia/Nemotron-3.5-Super-VL",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 2_410, completion_tokens: 8_000, total_tokens: 10_410, ...(reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }) },
      } }), { models: [{ id: "nvidia/Nemotron-3.5-Super-VL", context_length: 131_072 }] });
      const { run } = await startCoaching(engine);
      const page = await finished(engine, run.id);
      const report = await reportOf(engine, run.id);
      assert.equal(page.status, "failed");
      assert.equal(report?.stage.finishReason, "length");
      assert.equal(report?.stage.outputTokens, 8_000);
      assert.equal(report?.usage.outputTokens, 8_000, "reasoning must not be added to completion usage");
      assert.equal(report?.changes.length, 0);
      const call = page.events.find((event) => event.type === "model.call");
      assert.equal(call?.data?.["reasoningTokens"], reasoning !== undefined && reasoning <= 8_000 ? reasoning : null);
      assert.equal(stub.chats()[0]?.body?.["max_completion_tokens"], 8_000);
      assert.equal(stub.chats().length, 1);
      assert.equal(listings(stub), 1);
    }
  });

  it("accepts a concise validated form after more than 4,000 completion tokens, counting reasoning once", async () => {
    const { stub, engine } = await setup(() => {
      const reply = toolCall(COACH_TOOL, ANSWER, { tokens: [2_410, 6_100] });
      const body = reply.body as { usage: Record<string, unknown> };
      body.usage["completion_tokens_details"] = { reasoning_tokens: 5_900 };
      return reply;
    });
    const { run } = await startCoaching(engine);
    const page = await finished(engine, run.id);
    const report = await reportOf(engine, run.id);
    assert.equal(page.status, "succeeded");
    assert.equal(report?.outcome, "complete");
    assert.equal(report?.usage.outputTokens, 6_100);
    assert.equal(report?.budget.used.reportedOutputTokens, 6_100);
    assert.equal(page.events.find((event) => event.type === "model.call")?.data?.["reasoningTokens"], 5_900);
    assert.equal(report?.changes.length, 2);
    assert.equal(stub.chats()[0]?.body?.["max_completion_tokens"], 8_000);
    assert.equal(stub.chats().length, 1);
  });

  it("refuses before any inference: no key, a project's packet without its consent, a model it can't force, and a model other than the one named", async () => {
    const noKey = await setup(() => toolCall(COACH_TOOL, ANSWER), { key: false });
    const a = await startCoaching(noKey.engine);
    assert.match(failure(await finished(noKey.engine, a.run.id))?.message ?? "", /key/i);

    const consent = await setup(() => toolCall(COACH_TOOL, ANSWER));
    const b = await startCoaching(consent.engine, { packet: { ...PACKET, scope: { kind: "project" } }, modelContext: false });
    assert.equal((await finished(consent.engine, b.run.id)).status, "failed");

    const unforced = await setup(() => toolCall(COACH_TOOL, ANSWER), { models: [{ id: "nvidia/llama-3.3-nemotron-super-49b-v1", context_length: 131_072 }] });
    const c = await startCoaching(unforced.engine);
    assert.equal((await finished(unforced.engine, c.run.id)).status, "failed");

    const named = await setup(() => toolCall(COACH_TOOL, ANSWER));
    const d = await startCoaching(named.engine, { input: { model: "nvidia/some-other-model" } });
    assert.equal((await finished(named.engine, d.run.id)).status, "failed");

    assert.deepEqual([noKey.stub.chats().length, consent.stub.chats().length, unforced.stub.chats().length, named.stub.chats().length], [0, 0, 0, 0], "no inference request was made");
    assert.equal(consent.stub.requests.length, 0, "a refused consent doesn't even list the models");
  });
});
