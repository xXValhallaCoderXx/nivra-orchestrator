import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  COACH_FIXED_CHARS,
  COACH_PACKET_LIMITS,
  COACH_RUN_LIMITS,
  coachEstimatedInputTokens,
  COACH_PROFILE,
  COACH_REPORT_LIMITS,
  CoachInput,
  CoachPacket,
  coachPacketDigest,
  CoachReport,
  coachRoleMarker,
  renderCoachPacket,
  type CoachPacket as Packet,
} from "../src/coach.ts";
import * as domain from "../src/index.ts";
import { Methods, StartRunParams } from "../src/methods.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { WorkflowId } from "../src/runs.ts";

/** The task readiness coach's contract (NIV-53): what it reads, how that is fingerprinted, and what its report can hold. */
const PACKET: Packet = {
  scope: { kind: "general" },
  task: {
    title: "Personal records use one unit",
    briefVersion: 3,
    goal: "Fix finish-time records that compare miles with kilometres",
    acceptanceCriteria: ["It works"],
    scope: "",
    exclusions: "",
    context: "",
    assumptions: ["Every run stores its unit"],
    checks: ["pnpm test"],
    caseNames: ["Records compare in one unit"],
    baselineChecks: 1,
    frozenFiles: 2,
  },
  gaps: [{ code: "criterion-vague", tier: "could-help", field: "acceptanceCriteria", item: 1, missing: 'Criterion 1 may be hard to check: "It works"' }],
  mission: null,
  findings: [],
};
const DIGEST = "a".repeat(64);
const input = (overrides: Record<string, unknown> = {}) => ({
  taskId: randomUUID(),
  briefId: randomUUID(),
  briefVersion: 3,
  bindingDigest: DIGEST,
  packetDigest: DIGEST,
  preferencesDigest: DIGEST,
  profile: { id: "task-readiness-coach", version: 1 },
  ...overrides,
});

describe("the coach's packet (NIV-53)", () => {
  it("renders one text, labelled as the answer refers to it, with what isn't sent counted, never shown", () => {
    const text = renderCoachPacket(PACKET);
    assert.match(text, /^Task: Personal records use one unit\n\nBrief version: v3\. The task isn't linked to a repository\./);
    assert.match(text, /Acceptance criteria:\nC1\. It works/);
    assert.match(text, /Assumptions:\nA1\. Every run stores its unit/);
    assert.match(text, /Scope:\n\(empty\)/);
    assert.match(text, /names only: their commands and expected output aren't included\):\n- Records compare in one unit/);
    assert.match(text, /Baseline checks: 1\. Frozen files: 2\. \(Counts only\.\)/);
    assert.match(text, /G1 \(could help; acceptance criteria, C1\): Criterion 1 may be hard to check: "It works"/);
    assert.equal(/Mission|Findings/.test(text), false, "no mission or finding unless the person ticked one");
    const withContext = renderCoachPacket({
      ...PACKET,
      scope: { kind: "project" },
      mission: { name: "Trustworthy records", version: 2, parts: [{ label: "Outcome", text: "Runners trust their records." }] },
      findings: [{ title: "Units aren't stored", detail: "Older runs have no unit.", recommendation: "Say what happens to them.", reviewedBriefVersion: 2 }],
    });
    assert.match(withContext, /The task is linked to a repository, whose files aren't included\./);
    assert.match(withContext, /Mission \(M\), v2: Trustworthy records\nOutcome: Runners trust their records\./);
    assert.match(withContext, /F1 \(its review read brief v2\): Units aren't stored\nOlder runs have no unit\.\nRecommendation: Say what happens to them\./);
  });

  it("refuses a path or a project id, unknown parts, more than three findings and anything over a saved brief's limits", () => {
    const refused = [
      { ...PACKET, scope: { kind: "project", repoPath: "/repo" } },
      { ...PACKET, scope: { kind: "project", projectId: randomUUID() } },
      { ...PACKET, task: { ...PACKET.task, title: "" } },
      { ...PACKET, task: { ...PACKET.task, context: "x".repeat(COACH_PACKET_LIMITS.contextChars + 1) } },
      { ...PACKET, task: { ...PACKET.task, acceptanceCriteria: Array.from({ length: COACH_PACKET_LIMITS.items + 1 }, () => "a") } },
      { ...PACKET, task: { ...PACKET.task, caseCommands: ["sh x.sh"] } },
      { ...PACKET, findings: Array.from({ length: COACH_PACKET_LIMITS.findings + 1 }, () => ({ title: "t", detail: "", recommendation: "", reviewedBriefVersion: null })) },
      { ...PACKET, mission: { name: "m", version: 1, parts: [] } },
      { ...PACKET, gaps: [{ ...PACKET.gaps[0], code: "Not A Code" }] },
    ];
    assert.deepEqual(
      refused.map((packet) => CoachPacket.safeParse(packet).success),
      refused.map(() => false),
    );
    assert.equal(CoachPacket.safeParse(PACKET).success, true);
  });
});

describe("coachPacketDigest (NIV-53)", () => {
  it("is pinned to its canonical form, which anyone can work out", async () => {
    const digest = await coachPacketDigest(PACKET);
    const { task } = PACKET;
    const independent = createHash("sha256")
      .update(
        JSON.stringify([
          "nivra.coach-packet.v1",
          "general",
          task.title,
          3,
          task.goal,
          task.acceptanceCriteria,
          "",
          "",
          "",
          task.assumptions,
          task.checks,
          task.caseNames,
          1,
          2,
          [["criterion-vague", "could-help", "acceptanceCriteria", 1, PACKET.gaps[0]!.missing]],
          null,
          [],
        ]),
      )
      .digest("hex");
    assert.equal(digest, independent);
    assert.equal(digest, "8390d190572c8e22bf935a3209b6bbc2e07a3d2f8b9c76c0b37f78e359c422f3");
  });

  it("changes with any part of the packet, and with their order", async () => {
    const variants: Packet[] = [
      { ...PACKET, scope: { kind: "project" } },
      { ...PACKET, task: { ...PACKET.task, title: `${PACKET.task.title} ` } },
      { ...PACKET, task: { ...PACKET.task, briefVersion: 4 } },
      { ...PACKET, task: { ...PACKET.task, acceptanceCriteria: ["It works", "Another"] } },
      { ...PACKET, task: { ...PACKET.task, assumptions: [] } },
      { ...PACKET, task: { ...PACKET.task, caseNames: [] } },
      { ...PACKET, task: { ...PACKET.task, frozenFiles: 3 } },
      { ...PACKET, gaps: [] },
      { ...PACKET, mission: { name: "Trustworthy records", version: 1, parts: [{ label: "Outcome", text: "" }] } },
      { ...PACKET, findings: [{ title: "Units", detail: "", recommendation: "", reviewedBriefVersion: null }] },
    ];
    const digests = await Promise.all([PACKET, ...variants].map((packet) => coachPacketDigest(packet)));
    assert.equal(new Set(digests).size, digests.length);
    assert.equal(await coachPacketDigest(structuredClone(PACKET)), digests[0], "the same content gives the same fingerprint");
  });
});

describe("a coach run's input and report (NIV-53)", () => {
  it("takes ids, a brief version, three fingerprints and the coach's profile, and an allowed model only when named", () => {
    assert.equal(CoachInput.safeParse(input()).success, true);
    assert.equal(CoachInput.safeParse(input({ model: "nvidia/nemotron-3-super-120b-a12b" })).success, true);
    const refused = [
      input({ taskId: "not-a-uuid" }),
      input({ packetDigest: "not a digest" }),
      input({ profile: { id: "product-architect", version: 1 } }),
      input({ profile: { id: "task-readiness-coach", version: 0 } }),
      input({ repoPath: "/repo" }),
      input({ packet: PACKET }),
      input({ model: "" }),
    ];
    assert.deepEqual(
      refused.map((value) => CoachInput.safeParse(value).success),
      refused.map(() => false),
    );
    assert.deepEqual([COACH_PROFILE.id, COACH_PROFILE.version, coachRoleMarker()], ["task-readiness-coach", 2, "Nivra coach role: task-readiness-coach"]);
  });

  const report = (overrides: Record<string, unknown> = {}) => ({
    profile: { id: "task-readiness-coach", version: 1 },
    instructionsSha256: DIGEST,
    taskId: randomUUID(),
    briefVersion: 3,
    bindingDigest: DIGEST,
    packetDigest: DIGEST,
    preferencesDigest: DIGEST,
    outcome: "complete",
    scope: "general",
    packet: { chars: 900, criteria: 1, assumptions: 1, gaps: 1, mission: false, findings: 0 },
    summary: "The goal is clear, but the criterion doesn't say what someone would see.",
    questions: [{ id: "Q1", text: "Which unit should records use?", why: "The criterion needs a unit to check.", field: "acceptanceCriteria" }],
    changes: [
      { field: "acceptanceCriteria", add: ["Given a 5 km run logged in miles, its record shows in kilometres"], reword: [{ item: 1, text: "Records compare finish times in one unit" }], reason: "Says what someone would see.", refs: ["G1", "C1"], usable: true },
      { field: "context", append: "Today, a run logged in miles is compared as if it were in kilometres.", reason: "Says what happens now.", refs: [], usable: true },
    ],
    suggestedChecks: [{ name: "Units", command: "pnpm --filter @sheetless/data test", expectedOutput: "", expectedExitCode: null, reason: "Runs the suite." }],
    unknowns: ["Whether older runs store a unit."],
    dropped: { questions: 0, changes: 0, items: 0, refs: 0, checks: 0, unknowns: 0 },
    stage: { status: "answered", reason: null, kind: null, message: null, problems: [], requests: 1, estimatedInputTokens: 900, inputTokens: 1_000, outputTokens: 300, elapsedMs: 4_000, finishReason: "tool-calls", servedModel: "nvidia/nemotron-3-super-120b-a12b" },
    request: { runId: randomUUID(), clientRequestId: randomUUID() },
    route: { provider: "nebius", endpoint: "loopback-test", model: "nvidia/nemotron-3-super-120b-a12b" },
    sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" },
    preferences: { revision: 0, digest: DIGEST, records: [] },
    usage: { inputTokens: 1_000, outputTokens: 300, calls: 1, reportedCalls: 1 },
    budget: {
      limits: { requests: 1, totalMs: 180_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 60_000 },
      used: { requests: 1, elapsedMs: 4_000, inputTokens: 1_000, reportedInputTokens: 1_000, reportedOutputTokens: 300, unreportedRequests: 0, overrunTokens: 100 },
      stopped: null,
    },
    elapsedMs: 4_500,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  });

  it("holds questions, field changes, unverified checks and unknowns, and no verdict on the brief", () => {
    const parsed = CoachReport.safeParse(report());
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
    assert.equal(Object.keys(CoachReport.shape).some((key) => /ready|approved|verdict|score/i.test(key)), false);
  });

  it("refuses a fourth question, a change to a field the coach can't change, a second shape for one field, an unknown ref and an auto tool choice", () => {
    const question = { id: "Q1", text: "q", why: "", field: "goal" };
    const refused = [
      report({ questions: [question, { ...question, id: "Q2" }, { ...question, id: "Q3" }, { ...question, id: "Q4" }] }),
      report({ questions: [{ ...question, field: "baseline" }] }),
      report({ changes: [{ field: "acceptanceCases", add: ["x"], reword: [], reason: "", refs: [], usable: true }] }),
      report({ changes: [{ field: "context", text: "a whole new context", reason: "", refs: [], usable: true }] }),
      report({ changes: [{ field: "goal", text: "x", reason: "", refs: ["E1"], usable: true }] }),
      report({ changes: [{ field: "goal", text: "x".repeat(COACH_REPORT_LIMITS.textChars + 1), reason: "", refs: [], usable: true }] }),
      report({ suggestedChecks: [{ name: "n", command: "", expectedOutput: "", expectedExitCode: 0, reason: "" }] }),
      report({ sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "auto" } }),
    ];
    assert.deepEqual(
      refused.map((value) => CoachReport.safeParse(value).success),
      refused.map(() => false),
    );
  });

  it("estimates a request's input as characters over three, with the coach's fixed part, and lets a maximal brief through", () => {
    assert.equal(coachEstimatedInputTokens(3_000, []), Math.ceil((3_000 + COACH_FIXED_CHARS) / 3) + 64);
    assert.equal(coachEstimatedInputTokens(0, ["Prefer small PRs"]), Math.ceil((16 + 120 + COACH_FIXED_CHARS) / 3) + 64);
    // A saved brief at every limit, with a mission and three findings, fits the run's budget, labels included.
    const L = COACH_PACKET_LIMITS;
    const brief = L.titleChars + L.goalChars + 2 * L.scopeChars + L.contextChars + 3 * L.items * L.itemChars + L.cases * L.caseNameChars + L.gaps * L.gapChars;
    const context = L.missionParts * L.missionTextChars + L.findings * (L.findingTitleChars + L.findingDetailChars + L.findingRecommendationChars);
    assert.ok(coachEstimatedInputTokens(brief + context + 4_000, ["Prefer small PRs"]) <= COACH_RUN_LIMITS.estimatedInputTokens);
    // Past the budget the estimate says so, and the preview refuses it, naming what to shorten.
    assert.ok(coachEstimatedInputTokens(3 * COACH_RUN_LIMITS.estimatedInputTokens, []) > COACH_RUN_LIMITS.estimatedInputTokens);
  });

  it("starts as a run of its own, with its packet in the context and only ids and fingerprints in its input (since protocol 13)", () => {
    const params = { clientRequestId: randomUUID(), workflowId: "coach", input: input(), context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false }, packet: PACKET } };
    const parsed = StartRunParams.parse(params);
    assert.deepEqual([parsed.workflowId, WorkflowId.parse("coach"), PROTOCOL_VERSION], ["coach", "coach", 19]);
    const refused = [
      { ...params, input: { ...params.input, packet: PACKET } },
      { ...params, context: { ...params.context, packet: { ...PACKET, task: { ...PACKET.task, repoPath: "/repo" } } } },
      { ...params, context: { ...params.context, sharing: { modelContext: true, cloudExecution: true } } },
      { ...params, workflowId: "review" },
    ];
    assert.deepEqual(
      refused.map((value) => StartRunParams.safeParse(value).success),
      refused.map(() => false),
    );
    assert.equal(Methods["runs.coach"].result.safeParse(null).success, true);
  });

  it("is exported from the domain", () => {
    assert.equal(typeof domain.renderCoachPacket, "function");
    assert.equal(domain.COACH_TOOL, "submit_coaching");
  });
});
