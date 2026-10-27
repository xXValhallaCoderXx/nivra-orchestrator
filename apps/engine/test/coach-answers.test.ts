import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  COACH_FIXED_CHARS,
  COACH_PACKET_LIMITS,
  COACH_PROFILE,
  COACH_REPORT_LIMITS,
  coachEstimatedInputTokens,
  combinedMask,
  MAX_PREFERENCES,
  renderCoachPacket,
  type CoachPacket,
  type PreferenceSnapshot,
} from "@nivra/domain";
import { CoachAnswer, normaliseCoaching } from "../src/coach/answers.ts";
import { COACH_INSTRUCTIONS, COACH_INSTRUCTIONS_SHA256, coachMessage } from "../src/coach/prompt.ts";
import { coachFixedChars, estimateCoachRequest } from "../src/coach/run.ts";

/** What the engine keeps of the coach's answer, and what it tells the coach (NIV-53): no model is called here. */
const mask = combinedMask((text) => text.replaceAll("SECRETVALUE", "[secret:NEBIUS_API_KEY]"));
export const PACKET: CoachPacket = {
  scope: { kind: "general" },
  task: {
    title: "Personal records use one unit",
    briefVersion: 3,
    goal: "Fix finish-time records that compare miles with kilometres",
    acceptanceCriteria: ["It works", "Records show in kilometres"],
    scope: "",
    exclusions: "",
    context: "",
    assumptions: ["Every run stores its unit"],
    checks: ["pnpm test"],
    caseNames: [],
    baselineChecks: 0,
    frozenFiles: 0,
  },
  gaps: [
    { code: "criterion-vague", tier: "could-help", field: "acceptanceCriteria", item: 1, missing: 'Criterion 1 may be hard to check: "It works"' },
    { code: "current-behaviour", tier: "could-help", field: "context", item: null, missing: "The brief doesn't say what happens now." },
  ],
  mission: null,
  findings: [],
};
const keep = (value: unknown, packet: CoachPacket = PACKET) => normaliseCoaching(CoachAnswer.parse(value), packet, mask);

describe("what the engine keeps of the coach's answer (NIV-53)", () => {
  it("keeps questions with the field each names, one change per field with its own operation, unverified checks and unknowns", () => {
    const kept = keep({
      summary: "The goal is clear. The first criterion doesn't say what someone would see.",
      questions: [{ text: "Which unit should records use?", why: "The criterion needs it.", field: "acceptance criteria" }],
      changes: [
        { field: "acceptanceCriteria", reword: [{ item: "C1", text: "A 5 km run logged in miles shows its record in kilometres" }], add: "A run with no unit is left out\nAn invalid unit is refused", reason: "Checkable.", refs: "G1, C1" },
        { field: "context", append: "Today, a run logged in miles is compared as if it were in kilometres.", refs: ["G2"] },
        { field: "goal", text: "Records compare finish times in one unit" },
      ],
      suggestedChecks: [{ name: "Records", command: "pnpm --filter @sheetless/data test", expectedOutput: "", expectedExitCode: "0", reason: "Runs the suite." }],
      unknowns: "Whether older runs store a unit",
    });
    assert.equal(kept.outcome, "complete");
    assert.deepEqual(kept.questions, [{ id: "Q1", text: "Which unit should records use?", why: "The criterion needs it.", field: "acceptanceCriteria" }]);
    assert.deepEqual(kept.changes.map((change) => change.field), ["acceptanceCriteria", "context", "goal"]);
    assert.deepEqual(kept.changes[0], {
      field: "acceptanceCriteria",
      add: ["A run with no unit is left out", "An invalid unit is refused"],
      reword: [{ item: 1, text: "A 5 km run logged in miles shows its record in kilometres" }],
      reason: "Checkable.",
      refs: ["G1", "C1"],
      usable: true,
    });
    assert.deepEqual([kept.suggestedChecks[0]?.expectedExitCode, kept.unknowns, kept.dropped], [0, ["Whether older runs store a unit"], { questions: 0, changes: 0, items: 0, refs: 0, checks: 0, unknowns: 0 }]);
  });

  it("sets aside, and counts, what a model gets wrong: a field's words for its id, another key, a field it can't change, the wrong operation, an item that isn't there, a reference to nothing", () => {
    const kept = keep({
      summary: "s",
      questions: [
        { text: "q1", field: "the scope field" },
        { text: "q2", field: "" },
        { text: "q3", field: "goal" },
        { text: "q4", field: "scope" },
        { text: "q5", field: "context" },
        { text: "q6", field: "checks" },
      ],
      changes: [
        { field: "goal", newText: "Records use one unit" },
        { field: "acceptanceCases", add: ["sh check.sh"] },
        { field: "baseline", add: ["x"] },
        { field: "scope", append: "the records page" },
        { field: "context", text: "a whole new context" },
        { field: "acceptanceCriteria", reword: [{ item: 9, text: "x" }, { item: 2, text: "Records show in km" }, { item: 2, text: "again" }] },
        { field: "assumptions", reword: [{ item: 5, text: "x" }] },
        { field: "exclusions", text: "Older runs", refs: ["E1", "G9", "C2", "M", "F1", "c2"] },
        { field: "exclusions", text: "A second try" },
      ],
    });
    assert.deepEqual(kept.questions.map((question) => [question.id, question.text, question.field]), [["Q1", "q3", "goal"], ["Q2", "q4", "scope"], ["Q3", "q5", "context"]]);
    assert.deepEqual(kept.changes.map((change) => change.field), ["acceptanceCriteria", "exclusions"]);
    assert.deepEqual(kept.changes[0]?.field === "acceptanceCriteria" ? kept.changes[0].reword : null, [{ item: 2, text: "Records show in km" }]);
    assert.deepEqual(kept.changes[1]?.refs, ["C2"]);
    assert.deepEqual(kept.dropped, { questions: 3, changes: 7, items: 3, refs: 5, checks: 0, unknowns: 0 });
    assert.ok(kept.problems.length > 0 && kept.problems.length <= COACH_REPORT_LIMITS.problems);
    // Paths and rules only, never what the model wrote.
    assert.equal(kept.problems.some((problem) => /Records use one unit|sh check\.sh|whole new context|the scope field/.test(problem)), false);
  });

  it("sets aside a proposal over its limit rather than clip it, and clips only what is read, saying so", () => {
    const long = "x".repeat(COACH_REPORT_LIMITS.textChars + 1);
    const kept = keep({
      summary: "s".repeat(COACH_REPORT_LIMITS.summaryChars + 50),
      changes: [
        { field: "goal", text: long },
        { field: "assumptions", add: ["a".repeat(COACH_REPORT_LIMITS.itemChars + 1), "Short enough"] },
        { field: "context", append: "c".repeat(COACH_REPORT_LIMITS.appendChars + 1) },
      ],
      suggestedChecks: [{ name: "n", command: "c".repeat(COACH_REPORT_LIMITS.commandChars + 1) }, { name: "", command: "sh x.sh" }],
    });
    assert.deepEqual(kept.changes.map((change) => [change.field, change.field === "assumptions" ? change.add : null]), [["assumptions", ["Short enough"]]]);
    assert.deepEqual([kept.dropped.changes, kept.dropped.items, kept.dropped.checks], [2, 1, 2]);
    assert.ok(kept.summary.length === COACH_REPORT_LIMITS.summaryChars && kept.summary.endsWith("…"));
    assert.ok(kept.problems.some((problem) => problem === "summary: longer than 600 characters, shortened"));
  });

  it("masks every word, strips control characters, and won't let a masked proposal be ticked", () => {
    const kept = keep({ summary: "SECRETVALUE\u0007 noted", changes: [{ field: "goal", text: "Use SECRETVALUE to sign" }, { field: "scope", text: "The records page" }] });
    assert.equal(kept.summary, "[secret:NEBIUS_API_KEY] noted");
    assert.deepEqual(kept.changes.map((change) => [change.field, change.usable]), [["goal", false], ["scope", true]]);
    assert.equal(JSON.stringify(kept).includes("SECRETVALUE"), false);
  });

  it("keeps a summary that proposes nothing as complete, tells rejected output from a clean answer, and an empty one from both", () => {
    const unsure = keep({ summary: "I can't tell which unit older runs use, so I'm not proposing changes yet.", unknowns: ["The unit older runs store"] });
    assert.deepEqual([unsure.outcome, unsure.changes.length, unsure.unknowns.length], ["complete", 0, 1]);
    const rejected = keep({ summary: "Here are my changes.", changes: [{ field: "baseline", add: ["x"] }, { field: "goal", append: "y" }] });
    assert.deepEqual([rejected.outcome, rejected.dropped.changes], ["unusable", 2], "a summary doesn't make all-rejected output clean");
    assert.equal(keep({}).outcome, "empty");
    assert.equal(keep({ questions: [{}], changes: [{}] }).outcome, "empty", "blank entries hold nothing to set aside");
  });

  it("checks references against what this packet holds: the mission only when it was sent, each finding sent", () => {
    const withContext: CoachPacket = { ...PACKET, mission: { name: "Trustworthy records", version: 2, parts: [{ label: "Outcome", text: "Runners trust their records." }] }, findings: [{ title: "Units", detail: "", recommendation: "", reviewedBriefVersion: 2 }] };
    const answer = { changes: [{ field: "scope", text: "The records page", refs: ["M", "F1", "F2", "A1", "A2"] }] };
    assert.deepEqual(keep(answer, withContext).changes[0]?.refs, ["M", "F1", "A1"]);
    assert.deepEqual(keep(answer).changes[0]?.refs, ["A1"]);
  });
});

describe("what the coach is told (NIV-53)", () => {
  it("names the coach on its first line, and pins its instructions to the profile's version", () => {
    assert.equal(COACH_INSTRUCTIONS.split("\n")[0], "Nivra coach role: task-readiness-coach");
    assert.equal(COACH_PROFILE.version, 1);
    assert.equal(COACH_INSTRUCTIONS_SHA256, createHash("sha256").update(COACH_INSTRUCTIONS).digest("hex"));
    // Changing the instructions means a new profile version: update this pin together with the version in the catalogue.
    assert.equal(COACH_INSTRUCTIONS_SHA256, "860d1b125b865327f8ab0f479712905242f7cf27b91448f3d4a63270476c682e");
  });

  it("describes every field the coach fills, in the schema and in the instructions", () => {
    const shape = CoachAnswer.shape;
    const fields: string[] = [];
    const walk = (schema: unknown, path: string) => {
      const described = (schema as { description?: string }).description;
      assert.ok(described && described.length > 10, `${path} has a description`);
      let inner = schema as { def?: { innerType?: unknown; element?: unknown; options?: unknown[] }; shape?: Record<string, unknown> };
      while (inner.def?.innerType) inner = inner.def.innerType as typeof inner;
      const element = inner.def?.element as typeof inner | undefined;
      const object = element?.shape ? element : inner.shape ? inner : null;
      if (object?.shape) for (const [key, child] of Object.entries(object.shape)) walk(child, `${path}.${key}`);
    };
    for (const [key, schema] of Object.entries(shape)) {
      fields.push(key);
      walk(schema, key);
    }
    const named = ["summary", "questions", "text", "why", "field", "changes", "append", "add", "reword", "item", "reason", "refs", "suggestedChecks", "name", "command", "expectedOutput", "expectedExitCode", "unknowns"];
    for (const name of named) assert.ok(new RegExp(`\\b${name}\\b`).test(COACH_INSTRUCTIONS), `the instructions say what goes in ${name}`);
    assert.deepEqual(fields, ["summary", "questions", "changes", "suggestedChecks", "unknowns"]);
  });

  it("sends the packet exactly as the preview renders it, then the preferences for what they are, all masked", () => {
    const preferences: PreferenceSnapshot = {
      revision: 2,
      records: [
        { id: randomUUID(), statement: "Prefer small PRs", scope: "personal", intent: "default", revision: 1 },
        { id: randomUUID(), statement: "Use SECRETVALUE nowhere", scope: "project", intent: "override", revision: 1 },
      ],
    };
    const message = coachMessage(PACKET, preferences, mask);
    assert.ok(message.startsWith(renderCoachPacket(PACKET)));
    assert.ok(message.includes("- (personal default) Prefer small PRs"));
    assert.ok(message.includes("- (project override: the project's explicit decision, which outranks its existing conventions) Use [secret:NEBIUS_API_KEY] nowhere"));
    assert.ok(coachMessage(PACKET, { revision: 0, records: [] }, mask).includes("each with what it is:\n(none)"));
  });

  it("keeps its own text within the allowance the preview counts, so the preview's estimate is never below the engine's", () => {
    const L = COACH_PACKET_LIMITS;
    const fill = (n: number) => "w".repeat(n);
    const largest: CoachPacket = {
      scope: { kind: "project" },
      task: {
        title: fill(L.titleChars),
        briefVersion: 99,
        goal: fill(L.goalChars),
        acceptanceCriteria: Array.from({ length: L.items }, () => fill(L.itemChars)),
        scope: fill(L.scopeChars),
        exclusions: fill(L.scopeChars),
        context: fill(L.contextChars),
        assumptions: Array.from({ length: L.items }, () => fill(L.itemChars)),
        checks: Array.from({ length: L.items }, () => fill(L.itemChars)),
        caseNames: Array.from({ length: L.cases }, () => fill(L.caseNameChars)),
        baselineChecks: L.baseline,
        frozenFiles: L.frozen,
      },
      gaps: Array.from({ length: L.gaps }, () => ({ code: "criterion-vague", tier: "could-help" as const, field: "acceptanceCriteria" as const, item: 20, missing: fill(L.gapChars) })),
      mission: { name: fill(L.missionNameChars), version: 9, parts: Array.from({ length: L.missionParts }, () => ({ label: fill(L.missionLabelChars), text: fill(L.missionTextChars) })) },
      findings: Array.from({ length: L.findings }, () => ({ title: fill(L.findingTitleChars), detail: fill(L.findingDetailChars), recommendation: fill(L.findingRecommendationChars), reviewedBriefVersion: 98 })),
    };
    const overrides: PreferenceSnapshot = { revision: 1, records: Array.from({ length: MAX_PREFERENCES }, (_, index) => ({ id: randomUUID(), statement: "p".repeat(200), scope: "project" as const, intent: "override" as const, revision: index + 1 })) };
    const cases: Array<[CoachPacket, PreferenceSnapshot]> = [
      [PACKET, { revision: 0, records: [] }],
      [PACKET, overrides],
      [largest, overrides],
    ];
    for (const [packet, preferences] of cases) {
      const message = coachMessage(packet, preferences, mask);
      const statements = preferences.records.map((record) => record.statement);
      const packetChars = renderCoachPacket(packet).length;
      const framing = message.length - packetChars - statements.reduce((sum, statement) => sum + statement.length, 0);
      assert.ok(coachFixedChars() + framing - preferences.records.length * 120 <= COACH_FIXED_CHARS, `fixed ${coachFixedChars()}, framing ${framing}`);
      assert.ok(estimateCoachRequest(message) <= coachEstimatedInputTokens(packetChars, statements), `engine ${estimateCoachRequest(message)}, preview ${coachEstimatedInputTokens(packetChars, statements)}`);
    }
  });
});
