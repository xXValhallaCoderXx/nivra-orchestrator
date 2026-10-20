import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import {
  combinedMask,
  MAX_PREFERENCES,
  packetDigest,
  preferencesDigest,
  REVIEW_PACKET_LIMITS,
  REVIEW_REPORT_LIMITS,
  REVIEW_TOOLS,
  ReviewReport,
  type ChairSynthesis,
  type PreferenceSnapshot,
  type ReviewPacket,
} from "@nivra/domain";
import { createModelClient, ModelFailure } from "../src/providers/model.ts";
import { policyFor, requestBudget } from "../src/providers/policy.ts";
import { largestReport, normaliseReview, normaliseSynthesis, ReviewAnswer, SynthesisAnswer } from "../src/review/answers.ts";
import { CHAIR_INSTRUCTIONS, renderChairMessage, renderPacket, reviewerInstructions } from "../src/review/prompt.ts";
import { estimateRequest, REVIEW_LIMITS, runReview, type ReviewRunOptions } from "../src/review/run.ts";
import { asEnded } from "../src/review/task.ts";

/** The review's parts, in process (NIV-38, D30): what the engine keeps of an answer, what it sends, and the run itself on Mastra's mock model. */
const mask = combinedMask((text) => text.replaceAll("SECRETVALUE", "[secret:NEBIUS_API_KEY]"));
const PREF = { id: "11111111-1111-4111-8111-111111111111", statement: "Use pnpm", scope: "personal" as const, intent: "default" as const, revision: 1 };
const OVERRIDE = { id: "33333333-3333-4333-8333-333333333333", statement: "Replace Jest with Vitest", scope: "project" as const, intent: "override" as const, revision: 2 };
const DEFAULT = { id: "44444444-4444-4444-8444-444444444444", statement: "Build with Vite", scope: "project" as const, intent: "default" as const, revision: 1 };
const PREFERENCES: PreferenceSnapshot = { revision: 4, records: [PREF, OVERRIDE, DEFAULT] };
const PACKET: ReviewPacket = {
  scope: { kind: "project", headAtStart: "29c3a40a1b2c" },
  text: "Rename a column in place during a rolling deploy.",
  assumptions: ["Servers update within ten minutes.", "Nothing else reads the column."],
  references: [{ path: "src/db.ts", startLine: 1, endLine: 9 }],
};
const answer = (value: unknown) => ReviewAnswer.parse(value);

describe("what the engine keeps of a review (D30)", () => {
  it("gives findings their ids, keeps the first eight, checks every reference, and reads each basis from them", () => {
    const findings = [
      { title: "On the plan", detail: "d", recommendation: "r", severity: "Critical", basis: "plan", refs: "plan, A1, A9, E1, E5, junk" },
      { title: "Only an address", detail: "d", severity: "minor", basis: "evidence", refs: ["E1"] },
      { title: "Said so", detail: "d", basis: "assumption", refs: ["plan"] },
      { title: "A preference", detail: "d", refs: [OVERRIDE.id] },
      { title: "", detail: "" },
      ...Array.from({ length: 6 }, (_, index) => ({ title: `More ${index}`, detail: "d" })),
    ];
    const kept = normaliseReview("risks", answer({ summary: "  Summary.  ", findings }), PACKET, PREFERENCES, mask);
    assert.ok(kept);
    assert.deepEqual(kept.findings.map((finding) => finding.id), ["risk-1", "risk-2", "risk-3", "risk-4", "risk-5", "risk-6", "risk-7", "risk-8"]);
    assert.deepEqual(kept.findings.slice(0, 4).map((finding) => [finding.refs, finding.basis, finding.relabelled, finding.severity]), [
      [["plan", "A1", "E1"], "plan", false, "high"],
      [["E1"], "assumption", true, "low"],
      [["plan"], "assumption", false, null],
      [[OVERRIDE.id], "assumption", false, null],
    ]);
    assert.deepEqual([kept.summary, kept.adjusted], ["Summary.", { dropped: 3, refsDropped: 3, relabelled: 1, shortened: 0 }], "the blank finding and the two past eight dropped; A9, E5 and junk dropped");
  });

  it("clips, strips control characters, masks, and tells a valid 'no material issues' review from an empty one", () => {
    const long = normaliseReview("architecture", answer({ summary: `SECRETVALUE\u0007 ${"x".repeat(2_000)}`, findings: [] }), PACKET, PREFERENCES, mask);
    assert.ok(long);
    assert.equal(long.summary.length, REVIEW_REPORT_LIMITS.summaryChars);
    assert.ok(long.summary.startsWith("[secret:NEBIUS_API_KEY] ") && long.summary.endsWith("…") && !long.summary.includes("\u0007"));
    assert.equal(long.adjusted.shortened, 1);
    assert.equal(normaliseReview("architecture", answer({ summary: "Sound: additive and reversible.", findings: [] }), PACKET, PREFERENCES, mask)?.findings.length, 0);
    assert.equal(normaliseReview("architecture", answer({}), PACKET, PREFERENCES, mask), null);
    assert.equal(normaliseReview("architecture", answer({ summary: "   ", findings: [{ title: " ", detail: "" }] }), PACKET, PREFERENCES, mask), null);
  });

  it("keeps the chair's synthesis to the reports' ids, derives who backs each part, and lists what it named nowhere", () => {
    const reports = [
      normaliseReview("architecture", answer({ summary: "a", findings: [{ title: "A1", detail: "d" }, { title: "A2", detail: "d" }] }), PACKET, PREFERENCES, mask)!,
      normaliseReview("risks", answer({ summary: "r", findings: [{ title: "R1", detail: "d" }] }), PACKET, PREFERENCES, mask)!,
    ];
    const synthesis = normaliseSynthesis(
      SynthesisAnswer.parse({
        summary: "s",
        priorities: "arch-1 risk-1 risk-9",
        agreements: [{ statement: "One-sided agreement", findingIds: ["arch-1"] }, { statement: "", findingIds: [] }],
        dissent: [{ topic: "t", positions: [{ position: "p", findingIds: ["risk-1"] }] }],
      }),
      reports,
      mask,
    ) as ChairSynthesis;
    assert.deepEqual([synthesis.priorities, synthesis.agreements.map((a) => a.roles), synthesis.dissent[0]?.positions[0]?.roles, synthesis.unaddressed], [
      ["arch-1", "risk-1"],
      [["architecture"]],
      ["risks"],
      ["arch-2"],
    ]);
    assert.deepEqual([synthesis.adjusted.refsDropped, synthesis.adjusted.dropped], [1, 1]);
    assert.equal(normaliseSynthesis(SynthesisAnswer.parse({}), reports, mask), null);
  });

  it("lists as unaddressed a finding named only in a part dropped for the limits", () => {
    // The review's case: a finding named only in the ninth agreement was in neither the kept synthesis nor unaddressed.
    const findings = (n: number, title: string) => Array.from({ length: n }, (_, index) => ({ title: `${title}${index + 1}`, detail: "d" }));
    const reports = [
      normaliseReview("architecture", answer({ summary: "a", findings: findings(8, "A") }), PACKET, PREFERENCES, mask)!,
      normaliseReview("risks", answer({ summary: "r", findings: findings(4, "R") }), PACKET, PREFERENCES, mask)!,
    ];
    const position = (findingId: string) => ({ position: "p", findingIds: [findingId] });
    const synthesis = normaliseSynthesis(
      SynthesisAnswer.parse({
        summary: "s",
        agreements: [...Array.from({ length: 8 }, (_, index) => ({ statement: `Agreed ${index + 1}`, findingIds: [`arch-${index + 1}`] })), { statement: "The ninth", findingIds: ["risk-1"] }],
        dissent: [
          { topic: "Four positions", positions: [position("arch-1"), position("arch-2"), position("arch-3"), position("risk-4")] },
          ...Array.from({ length: 5 }, (_, index) => ({ topic: `Topic ${index + 2}`, positions: [position("arch-1")] })),
          { topic: "The seventh", positions: [position("risk-3")] },
        ],
      }),
      reports,
      mask,
    ) as ChairSynthesis;
    assert.deepEqual([synthesis.agreements.length, synthesis.dissent.length, synthesis.dissent[0]?.positions.length], [8, 6, 3]);
    assert.deepEqual(synthesis.unaddressed, ["risk-1", "risk-2", "risk-3", "risk-4"], "named only past the limits, or nowhere");
  });
});

describe("what a review sends (D30)", () => {
  it("names each role on its first line, and gives every reviewer the same message, preferences said for what they are", () => {
    assert.deepEqual(
      (["architecture", "risks", "single"] as const).map((role) => reviewerInstructions(role).split("\n")[0]),
      ["Nivra review role: architecture", "Nivra review role: risks", "Nivra review role: single"],
    );
    assert.equal(CHAIR_INSTRUCTIONS.split("\n")[0], "Nivra review role: chair");
    const message = renderPacket({ ...PACKET, text: `${PACKET.text} SECRETVALUE` }, PREFERENCES, mask);
    assert.ok(message.includes("[secret:NEBIUS_API_KEY]") && !message.includes("SECRETVALUE"));
    assert.ok(message.includes(`${PREF.id} (personal default): Use pnpm`));
    assert.ok(message.includes(`${DEFAULT.id} (project default): Build with Vite`));
    assert.ok(message.includes(`${OVERRIDE.id} (project override: the project's explicit decision, which outranks its existing conventions)`));
    assert.ok(message.includes("A2. Nothing else reads the column.") && message.includes("E1. src/db.ts lines 1-9") && message.includes("at commit 29c3a40a1b2c"));
    assert.ok(renderPacket({ scope: { kind: "general" }, text: "t", assumptions: [], references: [] }, { revision: 0, records: [] }, mask).includes("about no repository"));
  });

  it("estimates a whole request, instructions and tool definitions included, never the message alone", () => {
    const message = renderPacket(PACKET, PREFERENCES, mask);
    const whole = estimateRequest(reviewerInstructions("risks"), message, "reviewer");
    assert.ok(whole > Math.ceil((reviewerInstructions("risks").length + message.length) / 3) + 200, `${whole} tokens counts the tool definitions too`);
  });

  it("fits a realistic largest packet in a model's request window and the council's budget, and refuses absurd paths before any request", async () => {
    const preferences: PreferenceSnapshot = {
      revision: 1,
      records: Array.from({ length: MAX_PREFERENCES }, (_, index) => ({ id: randomUUID(), statement: "p".repeat(500), scope: "personal" as const, intent: "default" as const, revision: index + 1 })),
    };
    const largest: ReviewPacket = {
      scope: { kind: "project", headAtStart: "a".repeat(40) },
      text: "t".repeat(REVIEW_PACKET_LIMITS.textChars),
      assumptions: Array.from({ length: REVIEW_PACKET_LIMITS.assumptions }, () => "a".repeat(REVIEW_PACKET_LIMITS.assumptionChars)),
      references: Array.from({ length: REVIEW_PACKET_LIMITS.references }, (_, index) => ({ path: `src/${"d".repeat(70)}/${index}.ts`, startLine: 1, endLine: 999 })),
    };
    const message = renderPacket(largest, preferences, mask);
    const reviewer = estimateRequest(reviewerInstructions("architecture"), message, "reviewer");
    const chair = estimateRequest(CHAIR_INSTRUCTIONS, renderChairMessage(message, [largestReport("architecture"), largestReport("risks")], (text) => text), "chair");
    const window = requestBudget(131_072);
    assert.ok(reviewer <= window && chair <= window, `reviewer ${reviewer}, chair ${chair}, window ${window}`);
    assert.ok(2 * reviewer + chair <= REVIEW_LIMITS.council.estimatedInputTokens, `council ${2 * reviewer + chair}`);

    const absurd = { ...largest, references: largest.references.map((reference) => ({ ...reference, path: "p".repeat(REVIEW_PACKET_LIMITS.pathChars) })) };
    const { options, model } = inProcess(async () => {
      throw new Error("never");
    });
    await assert.rejects(runReview({ ...options, context: { preferences, sharing: { modelContext: true }, packet: absurd }, task: { ...options.task, packetDigest: await packetDigest(absurd) } }), (error: unknown) => error instanceof ModelFailure && error.kind === "context-too-small");
    assert.equal(model.doGenerateCalls.length, 0);
  });

  it("keeps a worst-case report well under what the store holds, in characters that take three bytes each", () => {
    const wide = (n: number) => "€".repeat(n);
    const L = REVIEW_REPORT_LIMITS;
    const report = (role: "architecture" | "risks") => {
      const base = largestReport(role);
      return { ...base, summary: wide(L.summaryChars), findings: base.findings.map((finding) => ({ ...finding, title: wide(L.titleChars), detail: wide(L.detailChars), recommendation: wide(L.recommendationChars), refs: finding.refs.map(() => wide(L.refChars)) })), assumptions: base.assumptions.map(() => wide(L.noteChars)), gaps: base.gaps.map(() => wide(L.noteChars)) };
    };
    const ids = Array.from({ length: L.ids }, (_, index) => `arch-${(index % 8) + 1}`);
    const stage = { problems: Array.from({ length: L.problems }, () => wide(L.problemChars)), message: wide(L.messageChars) };
    const worst = {
      panel: "council",
      planId: randomUUID(),
      planVersion: 99,
      packetDigest: "a".repeat(64),
      preferencesDigest: "a".repeat(64),
      outcome: "complete",
      scope: { kind: "project", headAtStart: "a".repeat(64) },
      packet: { textChars: 20_000, assumptions: 20, references: 240 },
      request: { runId: randomUUID(), clientRequestId: randomUUID() },
      route: { provider: "nebius", endpoint: "token-factory", model: "m".repeat(200) },
      sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" },
      preferences: { revision: 1, digest: "a".repeat(64), records: Array.from({ length: MAX_PREFERENCES }, () => ({ id: randomUUID(), scope: "project", intent: "override", revision: 1 })) },
      reviewers: [report("architecture"), report("risks")],
      synthesis: {
        summary: wide(L.synthesisChars),
        priorities: ids,
        agreements: Array.from({ length: L.agreements }, () => ({ statement: wide(L.statementChars), findingIds: ids, roles: ["architecture", "risks"] })),
        dissent: Array.from({ length: L.dissent }, () => ({ topic: wide(L.topicChars), positions: Array.from({ length: L.positions }, () => ({ position: wide(L.statementChars), findingIds: ids, roles: ["architecture", "risks"] })), note: wide(L.statementChars) })),
        gaps: Array.from({ length: L.notes }, () => wide(L.noteChars)),
        unaddressed: ids,
        adjusted: { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 },
      },
      stages: (["architecture", "risks", "chair"] as const).map((role) => ({ stage: role === "chair" ? "chair" : "reviewer", role, status: "failed", reason: null, kind: "malformed", requests: 1, estimatedInputTokens: 1, inputTokens: 1, outputTokens: 1, elapsedMs: 1, finishReason: "f".repeat(40), servedModel: "s".repeat(200), ...stage })),
      usage: { inputTokens: 1, outputTokens: 1, calls: 3, reportedCalls: 3 },
      budget: { limits: REVIEW_LIMITS.council, used: { requests: 3, elapsedMs: 1, inputTokens: 1, reportedInputTokens: 1, reportedOutputTokens: 1, unreportedRequests: 0, overrunTokens: 0 }, stopped: null },
      elapsedMs: 1,
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const parsed = ReviewReport.parse(worst);
    const bytes = Buffer.byteLength(JSON.stringify(parsed));
    assert.ok(bytes < 256_000, `${bytes} bytes`);
  });

  it("reads a report saved mid-review as interrupted once its run has ended, and leaves an ended one as it was", () => {
    const stages = [
      { stage: "reviewer", role: "architecture", status: "answered" },
      { stage: "reviewer", role: "risks", status: "running" },
      { stage: "chair", role: "chair", status: "pending" },
    ].map((entry) => ({ reason: null, kind: null, message: null, problems: [], requests: 0, estimatedInputTokens: null, inputTokens: null, outputTokens: null, elapsedMs: null, finishReason: null, servedModel: null, ...entry }));
    const saved = { outcome: "in-progress", stages } as unknown as ReviewReport;
    const ended = asEnded(saved);
    assert.deepEqual([ended.outcome, ended.stages.map((stage) => [stage.status, stage.reason])], ["interrupted", [["answered", null], ["failed", "interrupted"], ["skipped", "interrupted"]]]);
    assert.equal(asEnded({ ...saved, outcome: "complete" }).outcome, "complete");
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

function inProcess(doGenerate: (options: unknown) => Promise<Generated>, overrides: Partial<ReviewRunOptions> = {}) {
  const model = new MastraLanguageModelV2Mock({ doGenerate: doGenerate as never });
  const client = createModelClient({ apiKey: "test-key-0123456789", model: () => model });
  const saved: ReviewReport[] = [];
  const options: ReviewRunOptions = {
    runId: randomUUID(),
    clientRequestId: randomUUID(),
    task: { panel: "council", planId: randomUUID(), planVersion: 1, packetDigest: "a".repeat(64), preferencesDigest: "a".repeat(64) },
    context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: true }, packet: PACKET },
    client,
    model: "nvidia/nemotron-3-super-120b-a12b",
    contextLength: 131_072,
    route: { provider: "nebius", endpoint: "loopback-test", model: "nvidia/nemotron-3-super-120b-a12b" },
    policy: policyFor("nvidia/nemotron-3-super-120b-a12b"),
    mask,
    save: (report) => saved.push(report),
    progress: () => undefined,
    modelCall: () => undefined,
    ...overrides,
  };
  return { model, options, saved };
}

describe("a review run, in process (D30)", () => {
  it("has both reviewers' requests in flight at once, then sends the chair", async () => {
    let started = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => (release = resolve));
    const { model, options } = inProcess(async (call) => {
      const role = roleOf(call);
      if (role === "chair") return handIn(REVIEW_TOOLS.chair, { summary: "s" });
      if (++started === 2) release();
      await together;
      return handIn(REVIEW_TOOLS.reviewer, { summary: `${role} s` });
    });
    const report = await runReview({ ...options, requestMs: 5_000 });
    assert.deepEqual([report.outcome, model.doGenerateCalls.length, started], ["complete", 3, 2]);
  });

  it("still sends the chair, in its reserved room, when the reviewers report far more than estimated", async () => {
    const { model, options } = inProcess(async (call) => {
      const role = roleOf(call);
      return role === "chair" ? handIn(REVIEW_TOOLS.chair, { summary: "s" }, [2_000, 100]) : handIn(REVIEW_TOOLS.reviewer, { summary: "s" }, [55_000, 100]);
    });
    const report = await runReview(options);
    assert.deepEqual([report.outcome, model.doGenerateCalls.length, report.budget.used.requests], ["complete", 3, 3]);
    assert.ok(report.budget.used.overrunTokens > 0 && report.budget.used.inputTokens > report.budget.limits.estimatedInputTokens - 20_000, JSON.stringify(report.budget.used));
  });

  it("gives a reviewer that answers too late its deadline, uses nothing it says after, and never asks the chair", async () => {
    const { model, options } = inProcess(async (call) => {
      const role = roleOf(call);
      if (role === "risks") await new Promise((resolve) => setTimeout(resolve, 1_500));
      return handIn(REVIEW_TOOLS.reviewer, { summary: `${role} s` });
    });
    const report = await runReview({ ...options, requestMs: 400 });
    assert.deepEqual([report.outcome, report.stages.map((stage) => [stage.status, stage.kind, stage.reason])], ["incomplete", [["answered", null, null], ["failed", "timeout", null], ["skipped", null, "reviewer-missing"]]]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(model.doGenerateCalls.length, 2);
  });

  it("sends nothing when the budget can't hold every request at once", async () => {
    const { model, options, saved } = inProcess(async () => handIn(REVIEW_TOOLS.reviewer, { summary: "s" }));
    await assert.rejects(runReview({ ...options, limits: { ...REVIEW_LIMITS.council, estimatedInputTokens: 1_000 } }), (error: unknown) => error instanceof ModelFailure && error.kind === "budget-exhausted");
    assert.deepEqual([model.doGenerateCalls.length, saved.length], [0, 0], "refused before any request, so no report either");
  });

  it("checks its own fingerprints: the digest helpers agree with what a host works out", async () => {
    assert.equal(await packetDigest(PACKET), await packetDigest(structuredClone(PACKET)));
    assert.equal(await preferencesDigest(PREFERENCES.records), await preferencesDigest([...PREFERENCES.records].reverse()), "preferences by id, in any order");
  });
});
