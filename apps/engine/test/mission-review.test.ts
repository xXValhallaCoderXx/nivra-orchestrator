import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import {
  combinedMask,
  isTerminal,
  MAX_PREFERENCES,
  MISSION_COUNCIL,
  MISSION_REVIEW_LIMITS,
  missionPacketDigest,
  preferencesDigest,
  renderMissionPacket,
  REVIEW_TOOLS,
  RpcCallError,
  SPECIALISTS,
  specialistRef,
  MissionReviewPacket,
  type PreferenceSnapshot,
  type ReviewReport,
  type RunEventsPage,
} from "@nivra/domain";
import { createModelClient } from "../src/providers/model.ts";
import { policyFor, requestBudget } from "../src/providers/policy.ts";
import { largestReport, ReviewAnswer } from "../src/review/answers.ts";
import { missionRefChecker, normaliseMissionReview, rejectedReason } from "../src/review/mission-answers.ts";
import { MISSION_CHAIR_INSTRUCTIONS, MISSION_INSTRUCTIONS, MISSION_PROFILE, missionReviewerInstructions, renderMissionChairMessage, renderMissionMessage } from "../src/review/mission-prompt.ts";
import { estimateRequest, REVIEW_LIMITS, runReview, type ReviewRunOptions } from "../src/review/run.ts";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { httpError, startStub, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * A mission review (NIV-52): the council reading a mission and up to five of its tasks. In process for what the engine
 * keeps and what it sends; over stdio, against a loopback stub of Token Factory, for the run and its refusals. Nothing
 * here calls a real model.
 */

const mask = combinedMask((text) => text.replaceAll("SECRETVALUE", "[secret:NEBIUS_API_KEY]"));
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const PERSONAL = { id: "11111111-1111-4111-8111-111111111111", statement: "Prefer small, reversible changes", scope: "personal" as const, intent: "default" as const, revision: 1 };
const PREFERENCES: PreferenceSnapshot = { revision: 2, records: [PERSONAL] };

const task = (title: string, overrides: Partial<MissionReviewPacket["tasks"][number]> = {}): MissionReviewPacket["tasks"][number] => ({
  title,
  goal: `Do ${title}.`,
  acceptanceCriteria: ["It works."],
  scope: "",
  exclusions: "",
  assumptions: [],
  checks: [],
  context: "",
  acceptanceCaseNames: [],
  ...overrides,
});

const PACKET: MissionReviewPacket = {
  kind: "mission",
  scope: { kind: "general" },
  specialists: MISSION_COUNCIL.map(specialistRef),
  model: null,
  mission: {
    name: "Runner's log",
    intendedUsers: "Club runners who log three runs a week.",
    outcome: "A runner sees this week's distance against their plan.",
    successCriteria: ["Weekly distance shows within a second of opening."],
    constraints: ["Works offline."],
    nonGoals: ["Social features."],
  },
  tasks: [task("Store runs locally", { checks: ["pnpm test"] }), task("Weekly total"), task("Sync to the club's server")],
  othersInBacklog: 2,
};

const answer = (value: unknown) => ReviewAnswer.parse(value);

describe("what the engine keeps of a mission reviewer's answer (NIV-52)", () => {
  it("names only the selected tasks, the mission, the backlog and preferences, normalised, and drops everything else", () => {
    const check = missionRefChecker(PACKET, PREFERENCES);
    assert.deepEqual(
      ["t1", "[T3]", "T4", "T9", "T0", "Mission", "backlog", "plan", "A1", "E1", PERSONAL.id.toUpperCase(), "unknown"].map((ref) => check(ref)?.ref ?? null),
      ["T1", "T3", null, null, null, "mission", "backlog", null, null, null, PERSONAL.id, null],
    );
  });

  it("links each finding to what it names, drops foreign references, and sets aside a finding that names nothing in the selection", () => {
    const findings = [
      { title: "Sync before storage", detail: "d", recommendation: "r", severity: "high", basis: "plan", refs: "T3, T1, T9, plan, A1" },
      { title: "No offline test", detail: "d", severity: "minor", basis: "assumption", refs: ["backlog"] },
      { title: "Unselected task", detail: "d", refs: ["T7"] },
      { title: "Only a preference", detail: "d", refs: [PERSONAL.id] },
      { title: "The mission's criterion", detail: "d", basis: "evidence", refs: ["mission"] },
    ];
    const kept = normaliseMissionReview("risks", answer({ summary: "Summary.", findings }), PACKET, PREFERENCES, mask);
    assert.equal(kept.kind, "kept");
    if (kept.kind !== "kept") return;
    assert.deepEqual(
      kept.report.findings.map((finding) => [finding.id, finding.refs, finding.basis, finding.relabelled, finding.severity]),
      [
        ["risk-1", ["T3", "T1"], "plan", false, "high"],
        ["risk-2", ["backlog"], "assumption", false, "low"],
        ["risk-3", ["mission"], "plan", true, null],
      ],
    );
    assert.deepEqual(kept.report.adjusted, { dropped: 0, refsDropped: 4, relabelled: 1, shortened: 0, unanchored: 2 }, "T9, plan, A1 and T7 dropped; two findings set aside");
  });

  it("tells a sound selection from an empty answer, and from one whose every finding named nothing in the selection", () => {
    const sound = normaliseMissionReview("architecture", answer({ summary: "The tasks serve the mission in a workable order.", findings: [] }), PACKET, PREFERENCES, mask);
    assert.deepEqual([sound.kind, sound.kind === "kept" ? sound.report.findings.length : null, sound.kind === "kept" ? sound.report.adjusted.unanchored : null], ["kept", 0, 0]);
    assert.deepEqual(normaliseMissionReview("architecture", answer({}), PACKET, PREFERENCES, mask), { kind: "empty" });
    const rejected = normaliseMissionReview(
      "architecture",
      answer({ summary: "Problems everywhere.", findings: [{ title: "a", detail: "d", refs: ["T6"] }, { title: "b", detail: "d", refs: "T7 plan" }, { title: "c", detail: "d" }] }),
      PACKET,
      PREFERENCES,
      mask,
    );
    assert.deepEqual(rejected, { kind: "rejected", setAside: 3 }, "a summary doesn't make findings that named nothing a clean review");
    assert.equal(rejectedReason(3), "its 3 findings named nothing in the selection, so none could be kept");
    assert.equal(rejectedReason(1), "its one finding named nothing in the selection, so it couldn't be kept");
  });
});

describe("what a mission review sends (NIV-52)", () => {
  it("names each role on its first line, plays the catalogue's profiles, and gives both reviewers the preview's text with the preferences", () => {
    assert.deepEqual(
      [missionReviewerInstructions("architecture"), missionReviewerInstructions("risks"), MISSION_CHAIR_INSTRUCTIONS].map((text) => text.split("\n")[0]),
      ["Nivra review role: architecture", "Nivra review role: risks", "Nivra review role: chair"],
    );
    assert.match(missionReviewerInstructions("architecture"), /You are the product architect: pragmatic, outcome-focused and direct\./);
    assert.match(missionReviewerInstructions("risks"), /You are the risk and testability reviewer: constructively sceptical, concrete and evidence-led\./);
    assert.match(MISSION_CHAIR_INSTRUCTIONS, /You are the council chair: balanced, concise and open about what isn't known\./);
    assert.deepEqual(MISSION_PROFILE, { architecture: "product-architect", risks: "risk-testability", chair: "council-chair" });
    const message = renderMissionMessage({ ...PACKET, mission: { ...PACKET.mission, outcome: `${PACKET.mission.outcome} SECRETVALUE` } }, PREFERENCES, mask);
    assert.ok(message.includes("[secret:NEBIUS_API_KEY]") && !message.includes("SECRETVALUE"));
    assert.ok(renderMissionMessage(PACKET, PREFERENCES, mask).startsWith(renderMissionPacket(PACKET)), "the reviewers read the preview's text first");
    assert.ok(message.includes(`${PERSONAL.id} (personal default): ${PERSONAL.statement}`));
    assert.equal(message.includes("repository has no convention"), false, "a mission review has no repository");
  });

  it("pins each profile's instructions to its version, so the text can't change without a new version", () => {
    const pinned: Record<string, [number, string]> = {
      "product-architect": [1, "7545522c3beac76548849e3c737c21684c46f4447bbba1cc3be8104a65898da0"],
      "risk-testability": [1, "7989415e9d6b860db0ec0d7c483cafada227b891a9dd9eae6e741c0d656208ef"],
      "council-chair": [1, "a3c269c6b2756e7fb920671858bd287f69748d46ef416b3ff0621ba4d5597a03"],
    };
    const actual = Object.fromEntries(Object.entries(MISSION_INSTRUCTIONS).map(([id, text]) => [id, [SPECIALISTS[id as keyof typeof MISSION_INSTRUCTIONS].version, createHash("sha256").update(text).digest("hex")]]));
    assert.deepEqual(actual, pinned);
  });

  it("fits the largest mission packet, with the most preferences, in a request's window and the council's budget", () => {
    const preferences: PreferenceSnapshot = {
      revision: 1,
      records: Array.from({ length: MAX_PREFERENCES }, (_, index) => ({ id: randomUUID(), statement: "p".repeat(500), scope: "personal" as const, intent: "default" as const, revision: index + 1 })),
    };
    // Five tasks whose rendered text reaches the limit exactly: their contexts fill what is left.
    const base = { ...PACKET, tasks: Array.from({ length: MISSION_REVIEW_LIMITS.tasks }, (_, index) => task(`Task ${index + 1}`, { context: "c" })) };
    const room = MISSION_REVIEW_LIMITS.textChars - renderMissionPacket(base).length;
    const share = Math.floor(room / MISSION_REVIEW_LIMITS.tasks);
    const largest: MissionReviewPacket = { ...base, tasks: base.tasks.map((entry, index) => ({ ...entry, context: entry.context + "c".repeat(share + (index === 0 ? room - share * MISSION_REVIEW_LIMITS.tasks : 0)) })) };
    assert.equal(renderMissionPacket(largest).length, MISSION_REVIEW_LIMITS.textChars);
    assert.equal(MissionReviewPacket.safeParse(largest).success, true);
    const message = renderMissionMessage(largest, preferences, mask);
    const reviewer = Math.max(...(["architecture", "risks"] as const).map((role) => estimateRequest(missionReviewerInstructions(role), message, "reviewer")));
    const chair = estimateRequest(MISSION_CHAIR_INSTRUCTIONS, renderMissionChairMessage(message, [largestReport("architecture"), largestReport("risks")], (text) => text), "chair");
    const window = requestBudget(131_072);
    assert.ok(reviewer <= window && chair <= window, `reviewer ${reviewer}, chair ${chair}, window ${window}`);
    assert.ok(2 * reviewer + chair <= REVIEW_LIMITS.council.estimatedInputTokens, `council ${2 * reviewer + chair}`);
  });
});

type Generated = { content: unknown[]; finishReason: string; usage: Record<string, number>; warnings: unknown[] };
const handIn = (tool: string, input: unknown, tokens: [number, number] = [1_000, 100]): Generated => ({
  content: [{ type: "tool-call", toolCallId: `call-${tool}`, toolName: tool, input: JSON.stringify(input) }],
  finishReason: "tool-calls",
  usage: { inputTokens: tokens[0], outputTokens: tokens[1], totalTokens: tokens[0] + tokens[1] },
  warnings: [],
});
const roleOf = (options: unknown) => /Nivra review role: (\w+)/.exec(JSON.stringify((options as { prompt?: unknown }).prompt ?? ""))?.[1] ?? "unknown";

async function inProcess(doGenerate: (options: unknown) => Promise<Generated>, overrides: Partial<ReviewRunOptions> = {}) {
  const model = new MastraLanguageModelV2Mock({ doGenerate: doGenerate as never });
  const client = createModelClient({ apiKey: "test-key-0123456789", model: () => model });
  const saved: ReviewReport[] = [];
  const options: ReviewRunOptions = {
    runId: randomUUID(),
    clientRequestId: randomUUID(),
    task: { panel: "council", planId: randomUUID(), planVersion: 1, packetDigest: await missionPacketDigest(PACKET), preferencesDigest: await preferencesDigest(PREFERENCES.records) },
    context: { preferences: PREFERENCES, sharing: { modelContext: false }, packet: PACKET },
    client,
    model: MODEL,
    contextLength: 131_072,
    route: { provider: "nebius", endpoint: "loopback-test", model: MODEL },
    policy: policyFor(MODEL),
    mask,
    save: (report) => saved.push(report),
    progress: () => undefined,
    modelCall: () => undefined,
    ...overrides,
  };
  return { model, options, saved };
}

describe("a mission review run, in process (NIV-52)", () => {
  it("completes a sound selection with no findings, counting what it read, and names its stages by profile", async () => {
    const lines: string[] = [];
    const { model, options } = await inProcess(async (call) => (roleOf(call) === "chair" ? handIn(REVIEW_TOOLS.chair, { summary: "Neither reviewer raised anything material." }) : handIn(REVIEW_TOOLS.reviewer, { summary: "Sound: each task serves the outcome, in a workable order." })), {
      progress: (message) => lines.push(message),
    });
    const report = await runReview(options);
    assert.deepEqual([report.outcome, model.doGenerateCalls.length, report.reviewers.map((reviewer) => [reviewer.findings.length, reviewer.adjusted.unanchored])], [
      "complete",
      3,
      [
        [0, 0],
        [0, 0],
      ],
    ]);
    assert.deepEqual(report.packet, { textChars: renderMissionPacket(PACKET).length, assumptions: 0, references: 0 });
    assert.deepEqual(report.scope, { kind: "general" });
    assert.ok(lines.includes("Two reviewers are reading the mission and 3 selected tasks") && lines.includes("Product architect: 0 findings"), lines.join(" | "));
  });

  it("fails a reviewer whose every finding named nothing in the selection, with counts, and never reads it as a clean review", async () => {
    const { model, options } = await inProcess(async (call) =>
      roleOf(call) === "architecture"
        ? handIn(REVIEW_TOOLS.reviewer, { summary: "Looks risky.", findings: [{ title: "a", detail: "d", refs: ["T8"] }, { title: "b", detail: "d", refs: ["plan"] }] })
        : handIn(REVIEW_TOOLS.reviewer, { summary: "r", findings: [{ title: "Untested sync", detail: "d", refs: ["T3"] }, { title: "c", detail: "d", refs: ["T9"] }] }),
    );
    const report = await runReview(options);
    assert.equal(report.outcome, "incomplete");
    assert.deepEqual(
      report.stages.map((stage) => [stage.role, stage.status, stage.kind, stage.reason]),
      [
        ["architecture", "failed", "malformed", null],
        ["risks", "answered", null, null],
        ["chair", "skipped", null, "reviewer-missing"],
      ],
    );
    assert.equal(report.stages[0]?.message, "The product architect's review couldn't be used: its 2 findings named nothing in the selection, so none could be kept.");
    assert.deepEqual(report.stages[0]?.problems, ["findings: 2 named no selected task, the mission or the backlog"]);
    assert.ok(!JSON.stringify(report.stages[0]).includes("T8"), "the model's references never reach Nivra's words");
    assert.deepEqual(report.reviewers.map((reviewer) => [reviewer.role, reviewer.findings.map((finding) => finding.refs), reviewer.adjusted.unanchored]), [["risks", [["T3"]], 1]]);
    assert.equal(model.doGenerateCalls.length, 2, "the chair was never asked");
  });

  it("keeps the other reviewer's report when one fails, and stops at a cancel", async () => {
    const failing = await inProcess(async (call) => {
      if (roleOf(call) === "risks") throw Object.assign(new Error("boom"), { statusCode: 500 });
      return handIn(REVIEW_TOOLS.reviewer, { summary: "a", findings: [{ title: "Order", detail: "d", refs: ["T2", "T1"] }] });
    });
    const failed = await runReview(failing.options);
    assert.deepEqual([failed.outcome, failed.stages.map((stage) => stage.status), failed.reviewers.map((reviewer) => reviewer.role)], ["incomplete", ["answered", "failed", "skipped"], ["architecture"]]);
    assert.match(failed.stages[1]?.message ?? "", /^The risk and testability review failed: /);

    const controller = new AbortController();
    const cancelled = await inProcess(
      async (call) => {
        if (roleOf(call) === "risks") {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return handIn(REVIEW_TOOLS.reviewer, { summary: "s" });
      },
      { signal: controller.signal },
    );
    const report = await runReview(cancelled.options);
    assert.equal(report.outcome, "cancelled");
    assert.equal(report.stages[2]?.status, "skipped");
  });

  it("names findings to the chair under the profiles that raised them, and keeps the chair to their ids", async () => {
    let chairMessage = "";
    const { options } = await inProcess(async (call) => {
      const role = roleOf(call);
      if (role === "chair") {
        chairMessage = JSON.stringify((call as { prompt?: unknown }).prompt);
        return handIn(REVIEW_TOOLS.chair, { summary: "s", priorities: "risk-1 arch-9 T1", agreements: [{ statement: "Both", findingIds: ["arch-1", "risk-1"] }] });
      }
      return handIn(REVIEW_TOOLS.reviewer, { summary: role, findings: [{ title: `${role} finding`, detail: "d", refs: ["T1"] }] });
    });
    const report = await runReview(options);
    assert.ok(chairMessage.includes("The product architect's report.") && chairMessage.includes("The risk and testability reviewer's report."));
    assert.deepEqual([report.outcome, report.synthesis?.priorities, report.synthesis?.agreements[0]?.roles, report.synthesis?.unaddressed], ["complete", ["risk-1"], ["architecture", "risks"], []]);
  });
});

/** Over stdio, against the stub: the run, and everything it refuses before any request. */
const KEY = "test-key-0123456789abcdef";
const engines: EngineProcess[] = [];
const stubs: Stub[] = [];
const dirs: string[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});

const stubRole = (request: StubRequest): string | null => /Nivra review role: (architecture|risks|single|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1] ?? null;
const userMessage = (request: StubRequest | undefined) => JSON.stringify(((request?.body?.messages ?? []) as Array<{ role: string; content: unknown }>).find((message) => message.role === "user")?.content ?? null);
type Script = Partial<Record<"architecture" | "risks" | "chair", Reply>>;
const scripted = (script: Script) => (request: StubRequest): Reply => script[stubRole(request) as keyof Script] ?? httpError(500, "no script");
const COUNCIL: Script = {
  architecture: toolCall(REVIEW_TOOLS.reviewer, {
    summary: "Sync comes before anything is stored to sync.",
    findings: [
      { title: "Sync before storage", detail: "T3 needs T1's records.", recommendation: "Do T1 first.", severity: "high", basis: "plan", refs: ["T3", "T1"] },
      { title: "An unselected task", detail: "d", refs: ["T7"] },
    ],
  }),
  risks: toolCall(REVIEW_TOOLS.reviewer, {
    summary: "Nothing tests the offline constraint.",
    findings: [{ title: "No offline check", detail: "No task proves the app works offline.", recommendation: "Add a task with an offline check.", severity: "medium", refs: ["backlog", "mission"] }],
  }),
  chair: toolCall(REVIEW_TOOLS.chair, { summary: "Order the work, and test offline.", priorities: ["arch-1", "risk-1"], agreements: [], dissent: [] }),
};

async function setup(chat: (request: StubRequest) => Reply, models: Array<{ id: string; context_length?: number }> = [{ id: MODEL, context_length: 131_072 }]) {
  const stub = await startStub({ models, chat });
  stubs.push(stub);
  const root = tempDir();
  dirs.push(root);
  const home = join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", stub.url] });
  engines.push(engine);
  await engine.initialize({ NEBIUS_API_KEY: KEY });
  return { stub, engine };
}

async function start(engine: EngineProcess, options: { packet?: MissionReviewPacket; preferences?: PreferenceSnapshot; panel?: "council" | "single"; packetDigest?: string } = {}) {
  const packet = options.packet ?? PACKET;
  const preferences = options.preferences ?? PREFERENCES;
  const input = {
    panel: options.panel ?? "council",
    planId: randomUUID(),
    planVersion: 4,
    packetDigest: options.packetDigest ?? (await missionPacketDigest(packet)),
    preferencesDigest: await preferencesDigest(preferences.records),
  };
  const clientRequestId = randomUUID();
  const run = await engine.client.call("runs.start", { clientRequestId, workflowId: "review", input, context: { preferences, sharing: { modelContext: false }, packet } });
  return { run, input, clientRequestId };
}
const finished = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
const failedEvent = (page: RunEventsPage) => page.events.find((event) => event.type === "run.failed");
const reportOf = async (engine: EngineProcess, runId: string) => (await engine.client.call("runs.review", { runId })) as ReviewReport | null;

describe("a mission review over stdio (NIV-52)", () => {
  it("sends both reviewers the mission and its tasks, then the chair, and keeps a report bound to what was sent", async () => {
    const { stub, engine } = await setup(scripted(COUNCIL));
    const { run, input, clientRequestId } = await start(engine);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((event) => event.message).join(" | "));
    const report = await reportOf(engine, run.id);
    assert.ok(report);
    assert.deepEqual([report.panel, report.planId, report.planVersion, report.packetDigest, report.preferencesDigest, report.request], ["council", input.planId, 4, input.packetDigest, input.preferencesDigest, { runId: run.id, clientRequestId }]);
    assert.equal(report.outcome, "complete");
    const chats = stub.chats();
    assert.deepEqual(chats.map(stubRole).sort(), ["architecture", "chair", "risks"]);
    const [architecture, risks, chair] = (["architecture", "risks", "chair"] as const).map((role) => chats.find((chat) => stubRole(chat) === role));
    assert.equal(userMessage(architecture), userMessage(risks), "both reviewers read the same message, byte for byte");
    assert.ok(userMessage(architecture).includes("T3. Sync to the club's server") && userMessage(architecture).includes("The backlog holds 2 other tasks, which weren't sent."));
    assert.ok(userMessage(chair).includes("The product architect's report.") && userMessage(chair).includes("The risk and testability reviewer's report."));
    assert.deepEqual(
      report.reviewers.map((reviewer) => [reviewer.role, reviewer.findings.map((finding) => [finding.id, finding.refs]), reviewer.adjusted.unanchored]),
      [
        ["architecture", [["arch-1", ["T3", "T1"]]], 1],
        ["risks", [["risk-1", ["backlog", "mission"]]], 0],
      ],
    );
    assert.deepEqual([report.synthesis?.priorities, report.route?.model, report.packet.textChars], [["arch-1", "risk-1"], MODEL, renderMissionPacket(PACKET).length]);
    assert.equal(chats.length, 3);
  });

  it("refuses before any request a model it wasn't allowed, and uses exactly the one it was", async () => {
    const other = "nvidia/Nemotron-3_5-Lightning";
    const absent = await setup(scripted(COUNCIL), [{ id: other, context_length: 131_072 }]);
    const { run: refusedRun } = await start(absent.engine, { packet: { ...PACKET, model: MODEL } });
    const refused = await finished(absent.engine, refusedRun.id);
    assert.deepEqual([refused.status, failedEvent(refused)?.data?.["kind"], absent.stub.chats().length, await reportOf(absent.engine, refusedRun.id)], ["failed", "model-unavailable", 0, null]);
    assert.match(failedEvent(refused)?.message ?? "", /may use only nvidia\/nemotron-3-super-120b-a12b, and this key's listing doesn't include it, so nothing was sent/);

    // Both listed: the listing would pick the Super, but the review may use only the Lightning it names.
    const both = await setup(scripted({ ...COUNCIL, architecture: toolCall(REVIEW_TOOLS.reviewer, { summary: "Sound." }) }), [
      { id: MODEL, context_length: 131_072 },
      { id: other, context_length: 131_072 },
    ]);
    const named = await start(both.engine, { packet: { ...PACKET, model: other } });
    await finished(both.engine, named.run.id);
    assert.deepEqual([(await reportOf(both.engine, named.run.id))?.route?.model, both.stub.chats().map((chat) => chat.body?.model)], [other, [other, other, other]]);

    const unlisted = await setup(scripted(COUNCIL));
    const notNvidia = await finished(unlisted.engine, (await start(unlisted.engine, { packet: { ...PACKET, model: "Qwen/Qwen3-30B" } })).run.id);
    assert.deepEqual([failedEvent(notNvidia)?.data?.["kind"], unlisted.stub.chats().length], ["model-unavailable", 0], "a named model must be an NVIDIA one");
  });

  it("refuses before any request: other profile versions, a single reviewer, a packet it wasn't asked for, a project preference", async () => {
    const { stub, engine } = await setup(scripted(COUNCIL));
    const versions = { ...PACKET, specialists: PACKET.specialists.map((ref, index) => (index === 1 ? { ...ref, version: ref.version + 1 } : ref)) };
    const PROJECT_PREFERENCE = { id: randomUUID(), statement: "Use the club's API client", scope: "project" as const, intent: "default" as const, revision: 1 };
    const pages = [
      await finished(engine, (await start(engine, { packet: versions })).run.id),
      await finished(engine, (await start(engine, { panel: "single" })).run.id),
      await finished(engine, (await start(engine, { packetDigest: "b".repeat(64) })).run.id),
      await finished(engine, (await start(engine, { preferences: { revision: 3, records: [PERSONAL, PROJECT_PREFERENCE] } })).run.id),
    ];
    assert.deepEqual(
      pages.map((page) => [page.status, failedEvent(page)?.data?.["kind"]]),
      pages.map(() => ["failed", "internal"]),
    );
    assert.equal(stub.chats().length, 0);
    assert.equal(stub.requests.filter((request) => request.path.endsWith("/models")).length, 0, "each was refused with what it was sent, before even the listing");

    // The profiles out of order aren't a mission packet at all: refused before a run exists.
    const reordered = { ...PACKET, specialists: [...PACKET.specialists].reverse() };
    const refused = await start(engine, { packet: reordered }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refused instanceof TypeError || refused instanceof RpcCallError, String(refused));
    assert.equal(stub.chats().length, 0);
  });

  it("stops at a cancel with no further request", async () => {
    const { stub, engine } = await setup(scripted({ ...COUNCIL, risks: { ...toolCall(REVIEW_TOOLS.reviewer, { summary: "r" }), delayMs: 3_000 } }));
    const { run } = await start(engine);
    await waitFor(async () => ((await reportOf(engine, run.id))?.stages[0]?.status === "answered" ? true : null), { what: "the product architect's review", timeoutMs: 10_000 });
    await engine.client.call("runs.cancel", { runId: run.id });
    const page = await finished(engine, run.id);
    assert.equal(page.status, "cancelled");
    assert.equal((await reportOf(engine, run.id))?.outcome, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal(stub.chats().length, 2, "the chair was never asked");
  });
});
