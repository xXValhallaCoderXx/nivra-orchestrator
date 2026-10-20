import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  isTerminal,
  packetDigest,
  preferencesDigest,
  REVIEW_TOOLS,
  reviewRoleMarker,
  RpcCallError,
  type PreferenceSnapshot,
  type ReviewPacket,
  type ReviewReport,
  type RunEventsPage,
} from "@nivra/domain";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { httpError, startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * A review of a saved plan version over stdio (NIV-38, D30), against a loopback stub of Token Factory. The stub plays
 * each reviewer and the chair, told apart by the role on the first line of their instructions: the requests of the two
 * reviewers arrive together, so their order can't. Nothing here calls a real model.
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

const PERSONAL = { id: randomUUID(), statement: `Prefer small, reversible changes ${randomUUID()}`, scope: "personal" as const, intent: "default" as const, revision: 1 };
const OVERRIDE = { id: randomUUID(), statement: "Replace Jest with Vitest", scope: "project" as const, intent: "override" as const, revision: 2 };
const PLAN_CANARY = `nivra-plan-canary-${randomUUID()}`;
const GENERAL: ReviewPacket = {
  scope: { kind: "general" },
  text: `Rename users.fullname to display_name in place during a rolling deploy, then roll back by redeploying release 40. ${PLAN_CANARY}`,
  assumptions: ["Every server is updated within ten minutes.", "Nothing outside the app reads the column."],
  references: [],
};
const PROJECT: ReviewPacket = {
  scope: { kind: "project", headAtStart: "29c3a40a1b2c3d4e" },
  text: "Wrap the payment webhook in five immediate retries, and log every body in full.",
  assumptions: ["The provider times out after 10 s."],
  references: [
    { path: "src/webhook.ts", startLine: 10, endLine: 42 },
    { path: "src/payments.ts", startLine: 1, endLine: 30 },
  ],
};

const roleOf = (request: StubRequest): string | null => {
  const raw = JSON.stringify(request.body?.messages ?? []);
  return /Nivra review role: (architecture|risks|single|chair)/.exec(raw)?.[1] ?? null;
};
const messages = (request: StubRequest | undefined) => (request?.body?.messages ?? []) as Array<{ role: string; content: unknown }>;
const userMessage = (request: StubRequest | undefined) => JSON.stringify(messages(request).find((message) => message.role === "user")?.content ?? null);
const review = (role: string, extra: Record<string, unknown> = {}) => ({
  summary: `The ${role} reviewer's summary.`,
  findings: [
    { title: `${role}: old servers break mid-rollout`, detail: "Servers still on the old release query the old column.", recommendation: "Expand, then contract.", severity: "high", basis: "plan", refs: ["plan", "A1"] },
    { title: `${role}: rollback is unclear`, detail: "Release 40 can't read the renamed column.", recommendation: "Keep both columns until the rollback window closes.", severity: "critical", basis: "evidence", refs: "E9, nothing" },
  ],
  assumptions: ["Deploys are rolling."],
  gaps: [],
  ...extra,
});
const SYNTHESIS = {
  summary: "Both reviewers say the in-place rename breaks a rolling deploy.",
  priorities: ["arch-1", "risk-1", "made-up-9"],
  agreements: [{ statement: "The rename breaks servers mid-rollout.", findingIds: ["arch-1", "risk-1"] }],
  dissent: [{ topic: "Rollback", positions: [{ position: "Keep both columns.", findingIds: ["arch-2"] }, { position: "Accept a short outage.", findingIds: ["risk-2"] }], note: "" }],
  gaps: ["How long the rollout takes."],
};
type Script = Partial<Record<"architecture" | "risks" | "single" | "chair", Reply | (() => Reply)>>;
const scripted = (script: Script) => (request: StubRequest): Reply => {
  const role = roleOf(request) as keyof Script | null;
  const reply = role ? script[role] : undefined;
  if (!reply) return httpError(500, `no script for ${role}`);
  return typeof reply === "function" ? reply() : reply;
};
const COUNCIL: Script = {
  architecture: toolCall(REVIEW_TOOLS.reviewer, review("architecture")),
  risks: toolCall(REVIEW_TOOLS.reviewer, review("risks")),
  single: toolCall(REVIEW_TOOLS.reviewer, review("single")),
  chair: toolCall(REVIEW_TOOLS.chair, SYNTHESIS),
};

async function engineAt(url: string, home?: string) {
  const root = tempDir();
  dirs.push(root);
  const at = home ?? join(root, "home");
  const engine = startEngine(at, { args: ["--stdio", "--home", at, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", url] });
  engines.push(engine);
  await engine.initialize({ NEBIUS_API_KEY: KEY });
  return { engine, home: at };
}

async function setup(chat: (request: StubRequest) => Reply | Promise<Reply>, options: { contextLength?: number; models?: Array<{ id: string; context_length?: number }> } = {}) {
  const stub = await startStub({ models: options.models ?? [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: options.contextLength ?? 131_072 }], chat });
  stubs.push(stub);
  return { stub, ...(await engineAt(stub.url)) };
}

interface Start {
  packet?: ReviewPacket;
  preferences?: PreferenceSnapshot;
  modelContext?: boolean;
  panel?: "council" | "single";
  planId?: string;
  planVersion?: number;
  clientRequestId?: string;
  packetDigest?: string;
}
async function startReview(engine: EngineProcess, options: Start = {}) {
  const packet = options.packet ?? GENERAL;
  const preferences = options.preferences ?? { revision: 3, records: [PERSONAL] };
  const input = {
    panel: options.panel ?? "council",
    planId: options.planId ?? randomUUID(),
    planVersion: options.planVersion ?? 2,
    packetDigest: options.packetDigest ?? (await packetDigest(packet)),
    preferencesDigest: await preferencesDigest(preferences.records),
  };
  const clientRequestId = options.clientRequestId ?? randomUUID();
  const run = await engine.client.call("runs.start", { clientRequestId, workflowId: "review", input, context: { preferences, sharing: { modelContext: options.modelContext ?? packet.scope.kind === "project" }, packet } });
  return { run, input, clientRequestId };
}
const finished = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
const failed = (page: RunEventsPage) => page.events.find((event) => event.type === "run.failed");
const reportOf = async (engine: EngineProcess, runId: string) => (await engine.client.call("runs.review", { runId })) as ReviewReport | null;

describe("a council review over stdio (NIV-38, D30)", () => {
  it("sends both reviewers the same packet on their own, then the chair both reports, and keeps a report bound to the plan version", async () => {
    const { stub, engine } = await setup(scripted(COUNCIL));
    const { run, input, clientRequestId } = await startReview(engine);
    assert.equal(run.title, "Council review · plan v2");
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));

    const chats = stub.chats();
    assert.deepEqual(chats.map(roleOf).sort(), ["architecture", "chair", "risks"]);
    const [architecture, risks, chair] = (["architecture", "risks", "chair"] as const).map((role) => chats.find((chat) => roleOf(chat) === role));
    assert.equal(userMessage(architecture), userMessage(risks), "both reviewers read the same message, byte for byte");
    assert.equal(userMessage(architecture).includes("risks reviewer"), false);
    assert.equal(userMessage(risks).includes("architecture reviewer"), false, "neither sees the other's report");
    assert.ok(userMessage(chair).includes("The architecture reviewer's report") && userMessage(chair).includes("The risks reviewer's report"));
    for (const chat of [architecture, risks]) {
      assert.deepEqual(((chat?.body?.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name), [REVIEW_TOOLS.reviewer]);
      assert.deepEqual(chat?.body?.tool_choice, { type: "function", function: { name: REVIEW_TOOLS.reviewer } });
      assert.equal(chat?.body?.["temperature"], undefined, "Nivra sets no sampling of its own");
    }
    assert.ok(userMessage(architecture).includes(`${PERSONAL.id} (personal default)`), "a preference says what it is");

    const report = await reportOf(engine, run.id);
    assert.ok(report);
    assert.deepEqual(
      [report.outcome, report.panel, report.planId, report.planVersion, report.packetDigest, report.preferencesDigest, report.request],
      ["complete", "council", input.planId, 2, input.packetDigest, input.preferencesDigest, { runId: run.id, clientRequestId }],
    );
    assert.deepEqual(report.stages.map((stage) => [stage.role, stage.status, stage.requests]), [["architecture", "answered", 1], ["risks", "answered", 1], ["chair", "answered", 1]]);
    const [arch] = report.reviewers;
    assert.deepEqual(
      arch?.findings.map((finding) => [finding.id, finding.severity, finding.basis, finding.refs, finding.relabelled]),
      [
        ["arch-1", "high", "plan", ["plan", "A1"], false],
        ["arch-2", "high", "assumption", [], true],
      ],
      "an unknown reference is dropped, and a finding resting on no plan text is an assumption, relabelled",
    );
    assert.deepEqual(arch?.adjusted, { dropped: 0, refsDropped: 2, relabelled: 1, shortened: 0 });
    assert.deepEqual(report.synthesis?.priorities, ["arch-1", "risk-1"], "an id the reports don't have is dropped");
    assert.deepEqual(report.synthesis?.agreements[0]?.roles, ["architecture", "risks"]);
    assert.deepEqual(report.synthesis?.dissent[0]?.positions.map((position) => position.roles), [["architecture"], ["risks"]]);
    assert.deepEqual(report.synthesis?.unaddressed, [], "every finding was named somewhere");
    assert.deepEqual([report.usage.calls, report.usage.reportedCalls, report.route?.model, report.sampling], [3, 3, "nvidia/nemotron-3-super-120b-a12b", { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" }]);
    assert.deepEqual([report.budget.limits, report.budget.used.requests, report.budget.stopped], [{ requests: 3, totalMs: 330_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 120_000 }, 3, null]);
    assert.equal(chats.length, 3, "no request after the chair");
  });
});

describe("a review's outcomes, stops and bindings over stdio (NIV-38, D30)", () => {
  it("runs the single reviewer on the same message as the council's, with no chair", async () => {
    const { stub, engine } = await setup(scripted(COUNCIL));
    const council = await startReview(engine);
    await finished(engine, council.run.id);
    const single = await startReview(engine, { panel: "single" });
    assert.equal(single.run.title, "Single review · plan v2");
    const page = await finished(engine, single.run.id);
    assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));
    const singleChat = stub.chats().find((chat) => roleOf(chat) === "single");
    assert.equal(userMessage(singleChat), userMessage(stub.chats().find((chat) => roleOf(chat) === "architecture")), "the same packet, byte for byte");
    const report = await reportOf(engine, single.run.id);
    assert.deepEqual(report?.stages.map((stage) => [stage.role, stage.status, stage.reason]), [["single", "answered", null], ["chair", "skipped", "single-panel"]]);
    assert.deepEqual([report?.outcome, report?.reviewers[0]?.findings[0]?.id, report?.budget.limits.requests, stub.chats().length], ["complete", "single-1", 1, 4]);
  });

  it("accepts a review that finds no material issues, but never an empty one, a reply in text, or one the form refuses", async () => {
    const sound = await setup(scripted({ ...COUNCIL, risks: toolCall(REVIEW_TOOLS.reviewer, { summary: "Sound: the change is additive and reversible.", findings: [] }) }));
    const soundRun = await startReview(sound.engine);
    assert.equal((await finished(sound.engine, soundRun.run.id)).status, "succeeded");
    assert.deepEqual((await reportOf(sound.engine, soundRun.run.id))?.reviewers.map((report) => report.findings.length), [2, 0]);

    const cases: Array<[string, Reply, RegExp]> = [
      ["text", text("Looks fine to me."), /answered in plain text/],
      ["empty", toolCall(REVIEW_TOOLS.reviewer, {}), /empty review/],
      ["refused", toolCall(REVIEW_TOOLS.reviewer, { summary: "x", findings: 42 }), /didn't match the review form/],
    ];
    for (const [name, reply, why] of cases) {
      const { stub, engine } = await setup(scripted({ ...COUNCIL, risks: reply }));
      const { run } = await startReview(engine);
      const page = await finished(engine, run.id);
      const report = await reportOf(engine, run.id);
      assert.deepEqual([name, page.status, failed(page)?.data?.["kind"], failed(page)?.data?.["stage"], stub.chats().length], [name, "failed", "malformed", "risks", 2], "no chair, no repair, no retry");
      assert.deepEqual([report?.outcome, report?.stages.map((stage) => stage.status)], ["incomplete", ["answered", "failed", "skipped"]]);
      assert.match(report?.stages[1]?.message ?? "", why);
      assert.equal(report?.stages[2]?.reason, "reviewer-missing");
      assert.equal(report?.reviewers[0]?.role, "architecture", "what the other reviewer found is kept");
      if (name === "refused") assert.ok((report?.stages[1]?.problems.length ?? 0) > 0);
    }
  });

  it("keeps both reports when the chair fails, and lists what a synthesis left out", async () => {
    const { engine } = await setup(scripted({ ...COUNCIL, chair: httpError(500, "upstream broke") }));
    const { run } = await startReview(engine);
    const page = await finished(engine, run.id);
    const report = await reportOf(engine, run.id);
    assert.deepEqual([failed(page)?.data?.["kind"], failed(page)?.data?.["stage"], report?.outcome, report?.reviewers.length], ["provider", "chair", "incomplete", 2]);
    assert.match(failed(page)?.message ?? "", /^This review is incomplete\. The chair's synthesis failed: Token Factory had a problem answering \(HTTP 500\)\..* What the reviewers found is kept\. Start a new review to try again\.$/);

    const narrow = await setup(scripted({ ...COUNCIL, chair: toolCall(REVIEW_TOOLS.chair, { summary: "Only one thing matters.", priorities: ["arch-1"] }) }));
    const narrowRun = await startReview(narrow.engine);
    await finished(narrow.engine, narrowRun.run.id);
    assert.deepEqual((await reportOf(narrow.engine, narrowRun.run.id))?.synthesis?.unaddressed, ["arch-2", "risk-1", "risk-2"]);
  });

  it("waits for a slow reviewer when the other fails at once, keeps its report, and never asks the chair", async () => {
    const { stub, engine } = await setup(scripted({ ...COUNCIL, architecture: httpError(500, "upstream broke"), risks: { ...toolCall(REVIEW_TOOLS.reviewer, review("risks")), delayMs: 1_500 } }));
    const { run } = await startReview(engine);
    const page = await finished(engine, run.id);
    const report = await reportOf(engine, run.id);
    assert.deepEqual(
      [page.status, failed(page)?.data?.["kind"], failed(page)?.data?.["stage"], report?.outcome, report?.stages.map((stage) => [stage.status, stage.kind, stage.reason])],
      ["failed", "provider", "architecture", "incomplete", [["failed", "provider", null], ["answered", null, null], ["skipped", null, "reviewer-missing"]]],
    );
    assert.deepEqual([report?.reviewers.map((reviewer) => reviewer.role), stub.chats().length], [["risks"], 2]);
  });

  it("stops at a cancel with no further request, keeping the review that finished", async () => {
    const { stub, engine } = await setup(scripted({ ...COUNCIL, risks: { ...toolCall(REVIEW_TOOLS.reviewer, review("risks")), delayMs: 3_000 } }));
    const { run } = await startReview(engine);
    await waitFor(async () => ((await reportOf(engine, run.id))?.stages[0]?.status === "answered" ? true : null), { what: "the architecture review", timeoutMs: 10_000 });
    await engine.client.call("runs.cancel", { runId: run.id });
    const page = await finished(engine, run.id);
    assert.equal(page.status, "cancelled");
    // Read once, as the host does when the run ends: the last save lands before the run is terminal.
    const report = await reportOf(engine, run.id);
    assert.equal(report?.outcome, "cancelled");
    assert.deepEqual(report?.stages.map((stage) => [stage.status, stage.reason]), [["answered", null], ["failed", "cancelled"], ["skipped", "cancelled"]]);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal(stub.chats().length, 2, "the late answer changed nothing, and the chair was never asked");
  });

  it("keeps what finished when its engine is killed mid-review, reads as interrupted after a restart, and sends nothing again", async () => {
    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: scripted({ ...COUNCIL, risks: { ...toolCall(REVIEW_TOOLS.reviewer, review("risks")), delayMs: 30_000 } }) });
    stubs.push(stub);
    const first = await engineAt(stub.url);
    const { run } = await startReview(first.engine);
    await waitFor(async () => ((await reportOf(first.engine, run.id))?.stages[0]?.status === "answered" ? true : null), { what: "the architecture review", timeoutMs: 10_000 });
    first.engine.kill();
    await first.engine.exited;
    const sent = stub.chats().length;
    const second = await engineAt(stub.url, first.home);
    const page = await finished(second.engine, run.id);
    const report = await reportOf(second.engine, run.id);
    assert.deepEqual([page.status, page.events.some((event) => event.type === "run.interrupted")], ["failed", true]);
    assert.deepEqual([report?.outcome, report?.stages.map((stage) => [stage.status, stage.reason])], ["interrupted", [["answered", null], ["failed", "interrupted"], ["skipped", "interrupted"]]]);
    assert.match(report?.stages[1]?.message ?? "", /may have been sent/);
    assert.equal(report?.reviewers[0]?.findings.length, 2, "the finished review is kept");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual([sent, stub.chats().length], [2, 2], "nothing was sent again");
  });

  it("keeps usage unknown when a request didn't report it, and the estimate apart", async () => {
    const { engine } = await setup(scripted({ ...COUNCIL, architecture: toolCall(REVIEW_TOOLS.reviewer, review("architecture"), { tokens: null }) }));
    const { run } = await startReview(engine);
    await finished(engine, run.id);
    const report = await reportOf(engine, run.id);
    assert.deepEqual(
      [report?.usage.inputTokens, report?.usage.calls, report?.usage.reportedCalls, report?.budget.used.reportedInputTokens, report?.budget.used.unreportedRequests],
      [null, 3, 2, null, 1],
    );
    assert.ok((report?.budget.used.inputTokens ?? 0) > 0 && (report?.stages[0]?.estimatedInputTokens ?? 0) > 0, "the estimate stands in for what wasn't reported");
  });

  it("refuses before any request: a window too small for the chair at its largest, a packet over its limits, no key, no consent, no model", async () => {
    const small = await setup(scripted(COUNCIL), { contextLength: 8_000 });
    const tooSmall = await startReview(small.engine);
    const smallPage = await finished(small.engine, tooSmall.run.id);
    assert.deepEqual([failed(smallPage)?.data?.["kind"], small.stub.chats().length, await reportOf(small.engine, tooSmall.run.id)], ["context-too-small", 0, null]);
    assert.match(failed(smallPage)?.message ?? "", /the chair's request, with both reports/);

    const over = await startReview(small.engine, { packet: { ...GENERAL, text: "x".repeat(20_001) } }).then(
      () => null,
      (error: unknown) => error,
    );
    // The protocol's own check: the client refuses it before sending, and the engine checks the same schema.
    assert.ok(over instanceof TypeError && /do not match the protocol/.test(over.message), "a packet over its limits is refused before anything is sent");

    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b" }], chat: scripted(COUNCIL) });
    stubs.push(stub);
    const root = tempDir();
    dirs.push(root);
    const keyless = startEngine(join(root, "home"), { args: ["--stdio", "--home", join(root, "home"), "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", stub.url] });
    engines.push(keyless);
    await keyless.initialize({});
    const noKey = await finished(keyless, (await startReview(keyless)).run.id);
    const consent = await setup(scripted(COUNCIL));
    const noConsent = await finished(consent.engine, (await startReview(consent.engine, { packet: PROJECT, modelContext: false })).run.id);
    const nameless = await setup(scripted(COUNCIL), { models: [{ id: "Qwen/Qwen3-30B" }] });
    const noModel = await finished(nameless.engine, (await startReview(nameless.engine)).run.id);
    assert.deepEqual(
      [failed(noKey)?.data?.["kind"], failed(noConsent)?.data?.["kind"], failed(noModel)?.data?.["kind"], stub.chats().length, consent.stub.chats().length, nameless.stub.chats().length],
      ["no-key", "sharing-refused", "model-unavailable", 0, 0, 0],
    );
    assert.match(failed(noKey)?.message ?? "", /^No Nebius key is set, so nothing was sent\./);
  });

  it("refuses a packet that isn't the one it was asked for, and a request id reused for another version, but answers a repeat with the same run", async () => {
    const { stub, engine } = await setup(scripted(COUNCIL));
    const wrong = await startReview(engine, { packetDigest: "b".repeat(64) });
    const wrongPage = await finished(engine, wrong.run.id);
    assert.deepEqual([failed(wrongPage)?.data?.["kind"], stub.chats().length], ["internal", 0]);

    const planId = randomUUID();
    const clientRequestId = randomUUID();
    const original = await startReview(engine, { planId, planVersion: 2, clientRequestId });
    await finished(engine, original.run.id);
    const sent = stub.chats().length;
    const repeat = await startReview(engine, { planId, planVersion: 2, clientRequestId });
    assert.equal(repeat.run.id, original.run.id, "the same request is the same run");
    const other = await startReview(engine, { planId, planVersion: 3, clientRequestId }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(other instanceof RpcCallError && other.code === -32602 && /already started another run/.test(other.message));
    assert.equal(stub.chats().length, sent, "neither sent anything");
  });

  it("gives a general plan's review no project preference, keeps project preferences what they are, and masks a key wherever it appears", async () => {
    const { stub, engine, home } = await setup(scripted({ ...COUNCIL, architecture: toolCall(REVIEW_TOOLS.reviewer, review("architecture", { summary: `It echoes ${KEY}.` })) }));
    const mixed = await startReview(engine, { preferences: { revision: 3, records: [PERSONAL, OVERRIDE] } });
    assert.deepEqual([failed(await finished(engine, mixed.run.id))?.data?.["kind"], stub.chats().length], ["internal", 0], "a general plan's review takes personal preferences only");

    const project = await startReview(engine, { packet: { ...PROJECT, text: `${PROJECT.text} ${KEY}` }, preferences: { revision: 3, records: [PERSONAL, OVERRIDE] } });
    assert.equal((await finished(engine, project.run.id)).status, "succeeded");
    const sent = userMessage(stub.chats().find((chat) => roleOf(chat) === "architecture"));
    assert.ok(sent.includes(`${OVERRIDE.id} (project override: the project's explicit decision, which outranks its existing conventions)`));
    assert.ok(sent.includes("E2. src/payments.ts lines 1-30") && sent.includes("support no claim about the code"));
    assert.equal(stub.requests.some((request) => request.raw.includes(KEY)), false, "the key never leaves");
    const report = await reportOf(engine, project.run.id);
    assert.ok(report?.reviewers[0]?.summary.includes("[secret:NEBIUS_API_KEY]") && !JSON.stringify(report).includes(KEY));

    const general = await startReview(engine);
    await finished(engine, general.run.id);
    await engine.client.call("shutdown", {});
    await engine.exited;
    const mastra = readdirSync(home).filter((file) => file.startsWith("mastra.db"));
    assert.deepEqual(mastra.filter((file) => readFileSync(join(home, file)).includes(PLAN_CANARY)), [], "Mastra's records never hold the plan");
    assert.equal(engine.stderr().includes(PLAN_CANARY) || engine.stderr().includes(KEY), false);
  });

  it("reaches no repository and no execution backend: the review's code imports neither", () => {
    const sources = ["src/review/run.ts", "src/review/answers.ts", "src/review/prompt.ts", "src/review/task.ts", "src/workflows/review.ts"];
    const root = join(import.meta.dirname, "..");
    for (const source of sources) assert.equal(/from "\.\.\/(repo|exec)\//.test(readFileSync(join(root, source), "utf8")), false, source);
    assert.equal(reviewRoleMarker("risks"), "Nivra review role: risks");
  });
});
