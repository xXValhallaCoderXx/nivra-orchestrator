import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { COACH_PROFILE, COACH_RUN_LIMITS, COACH_TOOL, coachPacketDigest, combinedMask, CoachReport, preferencesDigest, type CoachContext, type CoachPacket, type PreferenceSnapshot } from "@nivra/domain";
import { estimateCoachRequest, runCoach, type CoachRunOptions } from "../src/coach/run.ts";
import { coachMessage } from "../src/coach/prompt.ts";
import { asEnded, readCoachTask, type CoachTask } from "../src/coach/task.ts";
import { createModelClient, ModelFailure } from "../src/providers/model.ts";
import { ANSWER_TOKENS, APP_TOKEN_CAP, DEFAULT_POLICY, policyFor, requestBudget } from "../src/providers/policy.ts";
import { FETCH_HEADERS_MS } from "../src/providers/transport.ts";
import { createCoachWorkflow, type CoachDeps } from "../src/workflows/coach.ts";

/** The task readiness coach's run, in process on Mastra's mock model (NIV-53): one request at most, never repeated. */
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const mask = combinedMask((text) => text.replaceAll("SECRETVALUE", "[secret:NEBIUS_API_KEY]"));
/** Private words that match no secret pattern: they must appear in no record the engine keeps or shows. */
const CANARY = "orchid lantern quietly 4471";
const PACKET: CoachPacket = {
  scope: { kind: "general" },
  task: {
    title: "Personal records use one unit",
    briefVersion: 3,
    goal: "Fix finish-time records that compare miles with kilometres",
    acceptanceCriteria: ["It works"],
    scope: "",
    exclusions: "",
    context: `Runners told us: ${CANARY}.`,
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
const NO_PREFERENCES: PreferenceSnapshot = { revision: 0, records: [] };
const GOOD = {
  summary: "The goal is clear. The criterion doesn't say what someone would see.",
  questions: [{ text: "Which unit should records use?", why: "The criterion needs it.", field: "acceptanceCriteria" }],
  changes: [{ field: "acceptanceCriteria", reword: [{ item: 1, text: "A 5 km run logged in miles shows its record in kilometres" }], add: [], reason: "Checkable.", refs: ["G1", "C1"] }],
  suggestedChecks: [],
  unknowns: [],
};

type Generated = { content: unknown[]; finishReason: string; usage: Record<string, number>; warnings: unknown[] };
const handIn = (input: unknown, tokens: [number, number] = [1_200, 150]): Generated => ({
  content: [{ type: "tool-call", toolCallId: "call-coach", toolName: COACH_TOOL, input: JSON.stringify(input) }],
  finishReason: "tool-calls",
  usage: { inputTokens: tokens[0], outputTokens: tokens[1], totalTokens: tokens[0] + tokens[1] },
  warnings: [],
});
const say = (text: string, finishReason = "stop"): Generated => ({ content: [{ type: "text", text }], finishReason, usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 }, warnings: [] });
const apiError = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { name: "AI_APICallError", statusCode, isRetryable: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function taskFor(packet: CoachPacket, preferences: PreferenceSnapshot = NO_PREFERENCES, overrides: Partial<CoachTask> = {}): Promise<CoachTask> {
  return {
    taskId: randomUUID(),
    briefId: randomUUID(),
    briefVersion: packet.task.briefVersion,
    bindingDigest: "b".repeat(64),
    packetDigest: await coachPacketDigest(packet),
    preferencesDigest: await preferencesDigest(preferences.records),
    profile: { id: COACH_PROFILE.id, version: COACH_PROFILE.version },
    ...overrides,
  };
}

async function inProcess(doGenerate: (options: unknown) => Promise<Generated>, overrides: Partial<CoachRunOptions> = {}) {
  const model = new MastraLanguageModelV2Mock({ doGenerate: doGenerate as never });
  const client = createModelClient({ apiKey: "test-key-0123456789", model: () => model });
  const saved: CoachReport[] = [];
  const options: CoachRunOptions = {
    runId: randomUUID(),
    clientRequestId: randomUUID(),
    task: await taskFor(PACKET),
    context: { preferences: NO_PREFERENCES, sharing: { modelContext: false }, packet: PACKET },
    client,
    model: MODEL,
    contextLength: 131_072,
    route: { provider: "nebius", endpoint: "loopback-test", model: MODEL },
    policy: policyFor(MODEL),
    mask,
    save: (report) => saved.push(CoachReport.parse(report)),
    progress: () => undefined,
    modelCall: () => undefined,
    ...overrides,
  };
  return { model, options, saved };
}

/** Runs a coaching that must end without a complete report: the failure it throws, and its last saved report. */
async function failing(options: CoachRunOptions, saved: CoachReport[]): Promise<{ error: ModelFailure; report: CoachReport | undefined }> {
  const error = await runCoach(options).then(
    () => assert.fail("the coaching completed"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ModelFailure, String(error));
  return { error, report: saved.at(-1) };
}

describe("a coaching, in process (NIV-53)", () => {
  it("makes one forced request, saves its report before the request may go out and at the end, and keeps the normalised answer", async () => {
    const { model, options, saved } = await inProcess(async () => handIn(GOOD));
    const report = await runCoach(options);
    assert.deepEqual([report.outcome, report.stage.status, report.stage.requests, model.doGenerateCalls.length], ["complete", "answered", 1, 1]);
    assert.deepEqual(saved.map((entry) => [entry.outcome, entry.stage.status, entry.budget.used.requests]), [
      ["in-progress", "pending", 0],
      ["in-progress", "running", 1],
      ["complete", "answered", 1],
    ]);
    assert.deepEqual([report.questions[0]?.id, report.changes[0]?.field, report.sampling.toolChoice, report.profile, report.briefVersion], ["Q1", "acceptanceCriteria", "forced", { id: "task-readiness-coach", version: 2 }, 3]);
    const call = model.doGenerateCalls[0] as { toolChoice?: unknown; maxOutputTokens?: number; prompt?: unknown };
    assert.deepEqual([call.toolChoice, call.maxOutputTokens], [{ type: "tool", toolName: COACH_TOOL }, 8_000]);
    assert.match(JSON.stringify(call.prompt), /Nivra coach role: task-readiness-coach/);
    assert.ok(report.usage.inputTokens === 1_200 && report.budget.used.reportedInputTokens === 1_200);
  });

  it("reserves the coach's full completion at the exact context boundary, while other workflows keep their default", async () => {
    const estimated = estimateCoachRequest(coachMessage(PACKET, NO_PREFERENCES, mask));
    const boundary = estimated + COACH_RUN_LIMITS.outputTokensPerRequest;
    const short = await inProcess(async () => handIn(GOOD), { contextLength: boundary - 1 });
    const refused = await failing(short.options, short.saved);
    assert.equal(refused.error.kind, "context-too-small");
    assert.match(refused.error.message, /8,000 are held back/);
    assert.equal(short.model.doGenerateCalls.length, 0);
    const exact = await inProcess(async () => handIn(GOOD), { contextLength: boundary });
    assert.equal((await runCoach(exact.options)).outcome, "complete");
    assert.equal(exact.model.doGenerateCalls.length, 1);
    assert.equal(requestBudget(null, COACH_RUN_LIMITS.outputTokensPerRequest), 56_000);
    assert.equal(COACH_RUN_LIMITS.estimatedInputTokens + COACH_RUN_LIMITS.outputTokensPerRequest, APP_TOKEN_CAP);
    assert.equal(ANSWER_TOKENS, 4_000);
    assert.equal(requestBudget(null), 60_000);
    assert.equal(COACH_RUN_LIMITS.listMs + COACH_RUN_LIMITS.requestMs, COACH_RUN_LIMITS.totalMs);
    assert.ok(FETCH_HEADERS_MS > COACH_RUN_LIMITS.totalMs);
  });

  it("is complete with a summary that proposes nothing, under the coach's uncertainty", async () => {
    const { model, options } = await inProcess(async () => handIn({ summary: "I can't tell which unit older runs use, so I'm not proposing changes.", unknowns: ["The unit older runs store"] }));
    const report = await runCoach(options);
    assert.deepEqual([report.outcome, report.changes.length, report.questions.length, report.unknowns, model.doGenerateCalls.length], ["complete", 0, 0, ["The unit older runs store"], 1]);
  });

  it("fails an answer in plain text, one cut off, one the form refuses, an empty one and one whose every part was set aside, each after exactly one request", async () => {
    const cases: Array<[string, Generated, string, RegExp]> = [
      ["text", say("Looks fine to me."), "failed", /answered in plain text, not through the coach's form/],
      ["cut off", say("{\"summary\": \"The goal", "length"), "failed", /cut off at the output limit/],
      ["refused", handIn({ summary: "s", questions: 7 }), "failed", /didn't match the coach's form/],
      ["empty", handIn({}), "empty", /empty answer/],
      ["all set aside", handIn({ summary: "My changes.", changes: [{ field: "baseline", add: ["x"] }, { field: "goal", append: "y" }] }), "unusable", /set aside all 2 parts it handed in, and kept none/],
    ];
    for (const [name, reply, outcome, why] of cases) {
      const { model, options, saved } = await inProcess(async () => reply);
      const { error, report } = await failing(options, saved);
      assert.deepEqual([name, error.kind, report?.outcome, report?.stage.status, report?.stage.kind, model.doGenerateCalls.length], [name, "malformed", outcome, "failed", "malformed", 1], "no repair, no retry");
      assert.match(report?.stage.message ?? "", why);
      assert.match(error.message, /Nothing was proposed, and your brief is unchanged\./);
      if (name === "refused") assert.ok((report?.stage.problems.length ?? 0) > 0);
      if (name === "all set aside") assert.deepEqual(report?.dropped.changes, 2);
    }
  });

  it("sends one request on a 429, a 500 or a timeout, and never again", async () => {
    for (const [status, kind] of [[429, "rate-limit"], [500, "provider"]] as const) {
      const { model, options, saved } = await inProcess(async () => {
        throw apiError(status);
      });
      const { error, report } = await failing(options, saved);
      assert.deepEqual([status, error.kind, report?.outcome, report?.stage.status, model.doGenerateCalls.length], [status, kind, "failed", "failed", 1]);
    }
    const { model, options, saved } = await inProcess(async () => {
      await sleep(1_000);
      return handIn(GOOD);
    }, { limits: { requestMs: 300 } });
    const { error, report } = await failing(options, saved);
    assert.deepEqual([error.kind, report?.stage.reason, model.doGenerateCalls.length], ["timeout", "deadline", 1]);
    await sleep(800);
    assert.equal(model.doGenerateCalls.length, 1, "nothing is sent after the deadline");
  });

  it("stops at a cancel while its request is out, saying so", async () => {
    const stop = new AbortController();
    const { model, options, saved } = await inProcess(
      async () => {
        await sleep(2_000);
        return handIn(GOOD);
      },
      { signal: stop.signal },
    );
    setTimeout(() => stop.abort(), 150);
    const { error, report } = await failing(options, saved);
    assert.deepEqual([error.kind, report?.outcome, report?.stage.reason, report?.stage.message, model.doGenerateCalls.length], ["cancelled", "cancelled", "cancelled", "Cancelled while its request was out.", 1]);
  });

  it("gives its request only the time left of one deadline counted from the run's start, the listing included", async () => {
    // The run started 1.7 s ago (its checks and listing took that), with 2 s in all: the request gets what is left.
    let admittedFor = 0;
    const { model, options, saved } = await inProcess(
      async () => {
        await sleep(1_000);
        return handIn(GOOD);
      },
      { startedAt: performance.now() - 1_700, limits: { totalMs: 2_000, requestMs: 150_000 }, progress: (_message, data) => void (admittedFor = Number(data["ms"] ?? admittedFor)) },
    );
    const started = performance.now();
    const { error, report } = await failing(options, saved);
    assert.ok(admittedFor > 0 && admittedFor <= 300, `admitted for ${admittedFor} ms`);
    assert.ok(performance.now() - started < 900, "ended at the run's deadline, not the request's own limit");
    assert.deepEqual([error.kind, report?.stage.reason, model.doGenerateCalls.length], ["timeout", "deadline", 1]);
  });

  it("refuses, before any request, a model whose answer can't be forced, a model the run doesn't name, an estimate over budget and a context too small", async () => {
    const cases: Array<[string, Partial<CoachRunOptions>, string, string]> = [
      ["not forced", { model: "nvidia/unchecked-model", policy: DEFAULT_POLICY }, "model-unavailable", "model-not-allowed"],
      ["not named", { task: { ...(await taskFor(PACKET)), model: "nvidia/Nemotron-3-Ultra-550b-a55b" } }, "model-unavailable", "model-not-allowed"],
      ["over budget", { limits: { estimatedInputTokens: 100 } }, "budget-exhausted", "budget"],
      ["too small", { contextLength: 4_500 }, "context-too-small", "budget"],
    ];
    for (const [name, overrides, kind, reason] of cases) {
      const { model, options, saved } = await inProcess(async () => handIn(GOOD), overrides);
      const { error, report } = await failing(options, saved);
      assert.deepEqual([name, error.kind, report?.outcome, report?.stage.status, report?.stage.reason, report?.stage.requests, model.doGenerateCalls.length], [name, kind, "failed", "skipped", reason, 0, 0]);
      assert.match(error.message, /nothing was sent/);
    }
  });

  it("reads a report saved mid-run as interrupted once its run has ended, and leaves an ended one as it was", async () => {
    const { options, saved } = await inProcess(async () => handIn(GOOD));
    await runCoach(options);
    const [pending, running, complete] = saved;
    assert.deepEqual([asEnded(pending!).outcome, asEnded(pending!).stage.status, asEnded(pending!).stage.reason], ["interrupted", "skipped", "interrupted"]);
    assert.deepEqual([asEnded(running!).outcome, asEnded(running!).stage.status, asEnded(running!).stage.message], ["interrupted", "failed", "The engine stopped while this request was out: it may have been sent."]);
    assert.equal(asEnded(complete!), complete);
  });
});

describe("the coach's workflow, in process (NIV-53)", () => {
  async function workflow(options: { packet?: CoachPacket; preferences?: PreferenceSnapshot; sharing?: boolean; key?: string | null; models?: string[]; task?: Partial<CoachTask> | null; reply?: Generated } = {}) {
    const packet = options.packet ?? PACKET;
    const preferences = options.preferences ?? NO_PREFERENCES;
    const task = options.task === null ? null : await taskFor(packet, preferences, options.task ?? {});
    const context: CoachContext = { preferences, sharing: { modelContext: options.sharing ?? false }, packet };
    const model = new MastraLanguageModelV2Mock({ doGenerate: (async () => options.reply ?? handIn(GOOD)) as never });
    let listings = 0;
    const listing = (async () => {
      listings++;
      return new Response(JSON.stringify({ object: "list", data: (options.models ?? [MODEL]).map((id) => ({ id })) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const records: unknown[] = [];
    const reports: CoachReport[] = [];
    const meta: unknown[] = [];
    const deps: CoachDeps = {
      recorder: { output: (...args) => records.push(args), event: (...args) => records.push(args) },
      context: () => context,
      task: () => task,
      requestId: () => randomUUID(),
      apiKey: () => (options.key === undefined ? "test-key-0123456789" : options.key),
      endpoint: { url: "http://127.0.0.1:9/v1", kind: "loopback-test" },
      mask,
      setMeta: (_runId, value) => meta.push(value),
      saveResult: (_runId, report) => reports.push(CoachReport.parse(report)),
      modelClient: (key, endpoint) => createModelClient({ apiKey: key, endpoint, model: () => model, fetch: listing }),
    };
    const run = await createCoachWorkflow(deps).createRun({ runId: randomUUID() });
    const result = (await run.start({ inputData: {} })) as { status: string; error?: { message?: string } };
    return { result, reports, records, meta, task, requests: () => model.doGenerateCalls.length, listings: () => listings };
  }

  it("checks, lists, coaches once, and keeps the packet's words out of every record it writes", async () => {
    const done = await workflow();
    assert.equal(done.result.status, "success", done.result.error?.message);
    assert.deepEqual([done.listings(), done.requests(), done.reports.at(-1)?.outcome], [1, 1, "complete"]);
    for (const [where, value] of [["records", done.records], ["meta", done.meta], ["stored input", done.task]] as const) {
      assert.equal(JSON.stringify(value).includes(CANARY), false, `the packet's words aren't in ${where}`);
    }
    assert.ok(done.records.some((record) => JSON.stringify(record).includes('"packetDigest"')), "the context step records the fingerprint");
  });

  it("refuses, before listing or any request, a packet or preferences other than the ones fingerprinted, another profile, and unreadable input", async () => {
    const cases: Array<[string, Parameters<typeof workflow>[0], RegExp]> = [
      ["packet", { task: { packetDigest: "0".repeat(64) } }, /internal|Nivra/],
      ["preferences", { task: { preferencesDigest: "0".repeat(64) } }, /internal|Nivra/],
      ["profile", { task: { profile: { id: "task-readiness-coach", version: 1 } } }, /internal|Nivra/],
      ["unreadable", { task: null }, /couldn't read this coaching's task and fingerprints back/],
      [
        "project preference for a general task",
        { preferences: { revision: 1, records: [{ id: randomUUID(), statement: "Use pnpm", scope: "project", intent: "default", revision: 1 }] } },
        /internal|Nivra/,
      ],
    ];
    for (const [name, options, why] of cases) {
      const done = await workflow(options);
      assert.deepEqual([name, done.result.status, done.listings(), done.requests(), done.reports.length], [name, "failed", 0, 0, 0]);
      assert.match(done.result.error?.message ?? "", why, name);
    }
  });

  it("refuses a project's task without its sharing, and a coaching without a key, before listing", async () => {
    const project: CoachPacket = { ...PACKET, scope: { kind: "project" } };
    const unshared = await workflow({ packet: project, sharing: false });
    assert.deepEqual([unshared.result.status, unshared.listings(), unshared.requests()], ["failed", 0, 0]);
    assert.match(unshared.result.error?.message ?? "", /doesn't allow sending its content to Token Factory/);
    const shared = await workflow({ packet: project, sharing: true });
    assert.equal(shared.result.status, "success", shared.result.error?.message);
    const keyless = await workflow({ key: null });
    assert.deepEqual([keyless.result.status, keyless.listings(), keyless.requests()], ["failed", 0, 0]);
    assert.match(keyless.result.error?.message ?? "", /No Nebius key is set/);
  });

  it("refuses a listed model it hasn't seen force an answer, and one other than the model a run names, after listing and before any request", async () => {
    const unchecked = await workflow({ models: ["nvidia/unchecked-model"] });
    assert.deepEqual([unchecked.result.status, unchecked.listings(), unchecked.requests(), unchecked.reports.at(-1)?.stage.reason], ["failed", 1, 0, "model-not-allowed"]);
    assert.match(unchecked.result.error?.message ?? "", /The coach can't use nvidia\/unchecked-model/);
    const other = await workflow({ task: { model: "nvidia/Nemotron-3-Ultra-550b-a55b" } });
    assert.deepEqual([other.result.status, other.listings(), other.requests()], ["failed", 1, 0]);
    assert.match(other.result.error?.message ?? "", /may use nvidia\/Nemotron-3-Ultra-550b-a55b only/);
    const named = await workflow({ task: { model: MODEL } });
    assert.deepEqual([named.result.status, named.requests()], ["success", 1]);
  });

  it("reads back what the run store keeps, and nothing else", () => {
    const task = { taskId: randomUUID(), briefId: randomUUID(), briefVersion: 2, bindingDigest: "x", packetDigest: "y", preferencesDigest: "z", profile: { id: "task-readiness-coach", version: 1 } };
    assert.deepEqual(readCoachTask(task), task);
    assert.equal(readCoachTask({ ...task, briefVersion: 0 }), null);
    assert.equal(readCoachTask(null), null);
  });
});

describe("the coach's reach (NIV-53)", () => {
  it("imports nothing that runs commands, reads a repository, uploads or searches the web", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = [...readdirSync(join(src, "coach")).map((name) => join(src, "coach", name)), join(src, "workflows", "coach.ts")];
    const imports = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1]!));
    assert.ok(imports.length > 10);
    assert.deepEqual(imports.filter((path) => /\/(exec|repo|apply|environment|research|task|sandbox)\/|tavily|nebius|node:child_process|node:fs/.test(path)), []);
  });
});
