import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { bindingDigest, COACH_PROFILE, COACH_RUN_LIMITS, coachPacketDigest, preferencesDigest, renderCoachPacket, type CoachChange, type CoachReport, type ContextChange, type PreferenceSnapshot } from "@nivra/domain";
import {
  applySelected,
  COACH_NOT_SENT,
  COACH_SENDS,
  coachBindingFor,
  coachChangeViews,
  coachFindingOf,
  coachMissionOf,
  coachPacketFor,
  coachPreviewFingerprint,
  coachReportMatches,
  coachRequest,
  sizeBlocked,
  staleLines,
  type CoachState,
  type CoachSubject,
} from "../src/main/coach.ts";
import { packetTaskOf, type TaskFinding } from "../src/main/mission-context.ts";
import { TOKEN_FACTORY_KEEPS } from "../src/main/tasks.ts";
import type { BriefContent } from "../src/shared/ipc.ts";
import { taskGuidance } from "../src/shared/task-guidance.ts";
import { BRIEFS, CASE } from "./fixtures/briefs.ts";

const TOKEN = `ghp_${"q".repeat(36)}`;
const SAVED = "nebius-saved-key-0123456789";
const KNOWN = [["NEBIUS_API_KEY", SAVED]] as const;
const DIGEST = "d".repeat(64);
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};
const refusalOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

/** A brief with something in every part, and what a run needs that the coach is only told the number of. */
const FULL: BriefContent = {
  ...BRIEFS.clearWithCase,
  scope: "The export button and its file",
  exclusions: "Other formats",
  context: "The list already loads every task.",
  assumptions: ["Lists stay under a thousand tasks"],
  checks: ["pnpm test"],
  baseline: [{ name: "Export fails today", command: "sh export.sh", expectedExitCode: 1, expectedOutput: "" }],
  frozen: ["tests/export.test.ts", "tests/fixtures.ts"],
};
const MISSION_REF = { missionId: randomUUID(), versionId: randomUUID(), version: 2, sha256: "a".repeat(64) };
const MISSION = { name: "Trustworthy exports", intendedUsers: "Coaches", outcome: "Coaches trust what they export.", successCriteria: ["Exports open in a spreadsheet"], constraints: [], nonGoals: ["PDF"] };
const FINDING: Pick<TaskFinding, "finding" | "reviewed"> = {
  reviewed: { taskId: randomUUID(), briefId: randomUUID(), briefVersion: 1, briefSha256: "b".repeat(64), title: "Add a CSV export" },
  finding: { id: "risk-1", title: "No failure case", detail: "Nothing says what an empty list exports.", recommendation: "Add a criterion for an empty list.", severity: "medium", basis: "plan", refs: ["T1"], relabelled: false },
};

const subject = (overrides: Partial<CoachSubject> = {}): CoachSubject => ({
  taskId: randomUUID(),
  title: "Add a CSV export",
  brief: { id: randomUUID(), version: 3, sha256: "c".repeat(64), content: FULL },
  project: { kind: "none" },
  ...overrides,
});
const PREFERENCES: PreferenceSnapshot = { revision: 4, records: [{ id: randomUUID(), statement: "Prefer small changes", scope: "personal", intent: "default", revision: 1 }] };
const PROFILE = { id: COACH_PROFILE.id, version: COACH_PROFILE.version, name: "Task readiness coach" };
const state = (task: CoachSubject, overrides: Partial<CoachState> = {}): CoachState => ({
  known: KNOWN,
  preferences: PREFERENCES,
  binding: coachBindingFor(task, null, [], PROFILE),
  busy: null,
  options: { mission: null, findings: [] },
  selection: { mission: false, findings: [] },
  mission: null,
  findings: [],
  profile: PROFILE,
  ...overrides,
});

describe("the coach's packet (NIV-53)", () => {
  it("sends the brief's parts as a mission review sends a task, its cases by name only, and counts what it doesn't send", () => {
    const packet = coachPacketFor({ title: "Add a CSV export", brief: { version: 3, content: FULL }, scope: "general", mission: null, findings: [] }, KNOWN);
    const sent = packetTaskOf("Add a CSV export", FULL);
    assert.deepEqual(packet.task, {
      title: sent.title,
      briefVersion: 3,
      goal: sent.goal,
      acceptanceCriteria: sent.acceptanceCriteria,
      scope: sent.scope,
      exclusions: sent.exclusions,
      context: sent.context,
      assumptions: sent.assumptions,
      checks: sent.checks,
      caseNames: [CASE.name],
      baselineChecks: 1,
      frozenFiles: 2,
    });
    const json = JSON.stringify(packet);
    for (const hidden of [CASE.command, CASE.expectedOutput, "tests/export.test.ts", "Export fails today", "executionPolicy", "sources"]) assert.equal(json.includes(hidden), false, hidden);
    assert.deepEqual([packet.scope, packet.mission, packet.findings], [{ kind: "general" }, null, []]);
    const vague = coachPacketFor({ title: "Records", brief: { version: 1, content: BRIEFS.vague }, scope: "project", mission: null, findings: [] }, KNOWN);
    assert.deepEqual(
      vague.gaps.map((gap) => gap.code),
      taskGuidance(BRIEFS.vague).items.map((item) => item.code),
    );
    assert.deepEqual(vague.scope, { kind: "project" });
  });

  it("takes the mission and the findings the person ticked, from Track B's records", () => {
    const mission = coachMissionOf(MISSION_REF, MISSION);
    assert.deepEqual(mission, {
      name: "Trustworthy exports",
      version: 2,
      parts: [
        { label: "Intended users", text: "Coaches" },
        { label: "Outcome", text: "Coaches trust what they export." },
        { label: "Success criteria", text: "Exports open in a spreadsheet" },
        { label: "Constraints", text: "" },
        { label: "Non-goals", text: "PDF" },
      ],
    });
    const finding = coachFindingOf(FINDING);
    assert.deepEqual(finding, { title: "No failure case", detail: "Nothing says what an empty list exports.", recommendation: "Add a criterion for an empty list.", reviewedBriefVersion: 1 });
    const packet = coachPacketFor({ title: "Add a CSV export", brief: { version: 3, content: FULL }, scope: "general", mission, findings: [finding] }, KNOWN);
    assert.deepEqual([packet.mission, packet.findings], [mission, [finding]]);
    assert.match(renderCoachPacket(packet), /Mission \(M\), v2: Trustworthy exports\nIntended users: Coaches/);
  });

  it("refuses a credential anywhere in what goes, naming the part and never the value", () => {
    const base = { title: "Add a CSV export", brief: { version: 3, content: FULL }, scope: "general" as const, mission: null, findings: [] };
    const cases: Array<[string, Parameters<typeof coachPacketFor>[0]]> = [
      ["The title", { ...base, title: `Export ${TOKEN}` }],
      ["The goal", { ...base, brief: { version: 3, content: { ...FULL, goal: `Use ${TOKEN}` } } }],
      ["Acceptance criterion 1", { ...base, brief: { version: 3, content: { ...FULL, acceptanceCriteria: [`Token ${TOKEN} works`] } } }],
      ["The scope", { ...base, brief: { version: 3, content: { ...FULL, scope: TOKEN } } }],
      ["The exclusions", { ...base, brief: { version: 3, content: { ...FULL, exclusions: TOKEN } } }],
      ["The context", { ...base, brief: { version: 3, content: { ...FULL, context: `key: ${TOKEN}` } } }],
      ["Assumption 1", { ...base, brief: { version: 3, content: { ...FULL, assumptions: [TOKEN] } } }],
      ["Check 1", { ...base, brief: { version: 3, content: { ...FULL, checks: [`curl -H ${TOKEN}`] } } }],
      ["Acceptance case 1's name", { ...base, brief: { version: 3, content: { ...FULL, acceptanceCases: [{ ...CASE, name: TOKEN }] } } }],
      ["The mission's name", { ...base, mission: { ...coachMissionOf(MISSION_REF, MISSION), name: TOKEN } }],
      ["The mission's outcome", { ...base, mission: coachMissionOf(MISSION_REF, { ...MISSION, outcome: TOKEN }) }],
      ["Finding 1's title", { ...base, findings: [{ ...coachFindingOf(FINDING), title: TOKEN }] }],
      ["Finding 1's detail", { ...base, findings: [{ ...coachFindingOf(FINDING), detail: TOKEN }] }],
      ["Finding 1's recommendation", { ...base, findings: [{ ...coachFindingOf(FINDING), recommendation: TOKEN }] }],
    ];
    for (const [part, input] of cases) {
      const message = refusal(() => coachPacketFor(input, KNOWN));
      assert.ok(message.startsWith(`${part} looks like it holds a GitHub token, so nothing was sent.`), `${part}: ${message}`);
      assert.equal(message.includes(TOKEN), false);
    }
    assert.match(refusal(() => coachPacketFor({ ...base, brief: { version: 3, content: { ...FULL, goal: `Use ${SAVED}` } } }, KNOWN)), /^The goal holds your saved Token Factory key, so nothing was sent\./);
  });

  it("refuses a mission or findings over the coach's limits, in words that say which and what to do", () => {
    const base = { title: "Add a CSV export", brief: { version: 3, content: FULL }, scope: "general" as const, mission: null, findings: [] };
    const tooMany = { ...coachMissionOf(MISSION_REF, MISSION), parts: Array.from({ length: 9 }, (_, index) => ({ label: `Part ${index + 1}`, text: "x" })) };
    assert.equal(refusal(() => coachPacketFor({ ...base, mission: tooMany }, KNOWN)), "The mission can't be sent to the coach as it is, so nothing was sent. Shorten it, or untick it, then ask the coach again.");
    const findings = Array.from({ length: 4 }, () => coachFindingOf(FINDING));
    assert.equal(refusal(() => coachPacketFor({ ...base, findings }, KNOWN)), "The findings you ticked can't be sent to the coach as they are, so nothing was sent. Untick some, then ask the coach again.");
  });
});

describe("a coaching's preview and what it is bound to (NIV-53)", () => {
  it("previews exactly the text the coach reads, bound by the binding, the packet, the preferences, the sharing and the profile", async () => {
    const task = subject();
    const given = state(task);
    const { preview, input, context, packet } = await coachRequest(task, given);
    assert.equal(preview.text, renderCoachPacket(packet));
    const [binding, packetDigest, prefs] = await Promise.all([bindingDigest(given.binding), coachPacketDigest(packet), preferencesDigest(PREFERENCES.records)]);
    assert.deepEqual(input, { taskId: task.taskId, briefId: task.brief.id, briefVersion: 3, bindingDigest: binding, packetDigest, preferencesDigest: prefs, profile: { id: COACH_PROFILE.id, version: COACH_PROFILE.version } });
    assert.deepEqual(context, { preferences: PREFERENCES, sharing: { modelContext: false }, packet });
    assert.equal(preview.expected, coachPreviewFingerprint({ bindingDigest: binding, packetDigest, preferencesDigest: prefs, sharing: null, profileId: COACH_PROFILE.id, profileVersion: COACH_PROFILE.version, model: null }));
    assert.deepEqual(preview.limits, { requests: 1, totalSeconds: 180, requestSeconds: 150, outputTokens: 4_000, estimatedInputTokens: preview.limits.estimatedInputTokens, budgetTokens: COACH_RUN_LIMITS.estimatedInputTokens });
    assert.ok(preview.limits.estimatedInputTokens > 0 && preview.limits.estimatedInputTokens < COACH_RUN_LIMITS.estimatedInputTokens);
    assert.deepEqual([preview.sends, preview.notSent, preview.keeps, preview.blocked], [[...COACH_SENDS], [...COACH_NOT_SENT], TOKEN_FACTORY_KEEPS, null]);
    assert.deepEqual(preview.preferences, [{ statement: "Prefer small changes", scope: "personal", intent: "default" }]);
    // A live recipe's model is in the input and the fingerprint, and nowhere else.
    const named = await coachRequest(task, state(task, { model: "nvidia/nemotron-3-super-120b-a12b" }));
    assert.equal(named.input.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.notEqual(named.preview.expected, preview.expected);
  });

  it("blocks a busy task, a project that doesn't allow sharing and a packet too long for one request, naming the longest part", async () => {
    const task = subject();
    assert.equal((await coachRequest(task, state(task, { busy: "The coach is still reading this task." }))).preview.blocked, "The coach is still reading this task.");
    const shared = subject({ project: { kind: "project", label: "shop", targetLabel: "Ubuntu", modelSharing: false } });
    const blocked = await coachRequest(shared, state(shared));
    assert.equal(blocked.preview.blocked, "This task's project doesn't allow sending its content to Token Factory. Allow sharing for it, then ask the coach.");
    assert.deepEqual([blocked.context.sharing.modelContext, blocked.preview.scope], [false, { kind: "project", projectLabel: "shop", targetLabel: "Ubuntu", sharing: false }]);
    const allowed = subject({ project: { kind: "project", label: "shop", targetLabel: "Ubuntu", modelSharing: true } });
    assert.equal((await coachRequest(allowed, state(allowed))).context.sharing.modelContext, true);
    // Every part at its limit, with fifty long preferences: over the estimated budget, the preferences the longest part.
    const huge: BriefContent = {
      ...FULL,
      goal: "g".repeat(4_000),
      scope: "s".repeat(4_000),
      exclusions: "e".repeat(4_000),
      context: "c".repeat(20_000),
      acceptanceCriteria: Array.from({ length: 20 }, () => "a".repeat(1_000)),
      assumptions: Array.from({ length: 20 }, () => "b".repeat(1_000)),
      checks: Array.from({ length: 20 }, () => "k".repeat(1_000)),
    };
    const large = subject({ brief: { id: randomUUID(), version: 1, sha256: "c".repeat(64), content: huge } });
    const many: PreferenceSnapshot = { revision: 1, records: Array.from({ length: 50 }, () => ({ id: randomUUID(), statement: "p".repeat(500), scope: "personal" as const, intent: "default" as const, revision: 1 })) };
    const findings = Array.from({ length: 3 }, () => ({ title: "t".repeat(160), detail: "d".repeat(1_000), recommendation: "r".repeat(500), reviewedBriefVersion: 1 }));
    const mission = { name: "m".repeat(120), version: MISSION_REF.version, parts: Array.from({ length: 8 }, (_, index) => ({ label: `Part ${index}`, text: "x".repeat(4_000) })) };
    const max = await coachRequest(large, state(large, { preferences: many, mission, findings, binding: coachBindingFor(large, MISSION_REF, findings.map(() => ({ reviewId: randomUUID(), findingId: "risk-1" })), PROFILE) }));
    // Even then the estimate is within the run's budget, so the size block is a backstop: shown here with a smaller one.
    assert.ok(max.preview.limits.estimatedInputTokens <= COACH_RUN_LIMITS.estimatedInputTokens, String(max.preview.limits.estimatedInputTokens));
    assert.equal(max.preview.blocked, null);
    assert.equal(
      sizeBlocked(max.packet, many, 70_000, COACH_RUN_LIMITS.estimatedInputTokens),
      "What the coach would read is too long for one request: an estimated 70,000 tokens, and it takes 60,000. Shorten the mission, the longest part, then ask the coach again.",
    );
    assert.match(sizeBlocked(max.packet, many, 70_000, 60_000) ?? "", /Shorten the mission/);
    assert.match(sizeBlocked({ ...max.packet, mission: null, findings: [] }, many, 70_000, 60_000) ?? "", /Shorten your preferences, the longest part/);
    assert.equal(sizeBlocked(max.packet, many, 60_000, 60_000), null, "the budget itself is within it");
  });

  it("refuses a task whose repository was removed, project preferences for a task with none, and a binding that isn't this task as sent", async () => {
    const removed = subject({ project: { kind: "removed" } });
    assert.match(await refusalOf(() => coachRequest(removed, state(removed))), /^This task's repository was removed, so the coach can't read the task as it is\./);
    const general = subject();
    const projectPreference: PreferenceSnapshot = { revision: 1, records: [{ id: randomUUID(), statement: "Use pnpm", scope: "project", intent: "override", revision: 1 }] };
    assert.match(await refusalOf(() => coachRequest(general, state(general, { preferences: projectPreference }))), /^A task with no repository is sent your personal preferences only/);
    assert.match(
      await refusalOf(() => coachRequest(general, state(general, { preferences: { revision: 1, records: [{ ...PREFERENCES.records[0]!, statement: `Use ${TOKEN}` }] } }))),
      /^A preference looks like it holds a GitHub token, so nothing was sent\./,
    );
    const stale = "What this coaching would be bound to isn't this task as it is now, so nothing was sent. Open the task again, then ask the coach again.";
    const bindings = [
      coachBindingFor({ ...general, title: "Renamed" }, null, [], PROFILE),
      coachBindingFor({ ...general, brief: { ...general.brief, version: 2 } }, null, [], PROFILE),
      coachBindingFor(general, MISSION_REF, [], PROFILE),
      coachBindingFor(general, null, [{ reviewId: randomUUID(), findingId: "arch-1" }], PROFILE),
      { ...coachBindingFor(general, null, [], PROFILE), specialists: [{ id: "product-architect" as const, version: 1 }] },
    ];
    for (const binding of bindings) assert.equal(await refusalOf(() => coachRequest(general, state(general, { binding }))), stale);
    assert.match(await refusalOf(() => coachRequest(general, state(general, { profile: { ...PROFILE, version: PROFILE.version + 1 } }))), /^That isn't this version of the task readiness coach/);
  });

  it("pins the preview's fingerprint to its canonical form, and changes it with every part", () => {
    const parts = { bindingDigest: "1".repeat(64), packetDigest: "2".repeat(64), preferencesDigest: "3".repeat(64), sharing: true as boolean | null, profileId: "task-readiness-coach", profileVersion: 1, model: null as string | null };
    const fingerprint = coachPreviewFingerprint(parts);
    assert.equal(fingerprint, createHash("sha256").update(JSON.stringify(["nivra.coach-preview.v1", "1".repeat(64), "2".repeat(64), "3".repeat(64), true, "task-readiness-coach", 1, null])).digest("hex"));
    assert.equal(fingerprint, "03935fd738b137fc35165cb652e3ceb083c9bafa48eb5778047aa3b3f8b1a7e9");
    const variants = [
      { ...parts, bindingDigest: "4".repeat(64) },
      { ...parts, packetDigest: "4".repeat(64) },
      { ...parts, preferencesDigest: "4".repeat(64) },
      { ...parts, sharing: false },
      { ...parts, sharing: null },
      { ...parts, profileId: "council-chair" },
      { ...parts, profileVersion: 2 },
      { ...parts, model: "nvidia/nemotron-3-super-120b-a12b" },
    ];
    const all = [fingerprint, ...variants.map((variant) => coachPreviewFingerprint(variant))];
    assert.equal(new Set(all).size, all.length);
  });
});

const about = { reason: "Says what someone would see.", refs: [] as string[], usable: true };
const GOAL: CoachChange = { field: "goal", text: "Exports a CSV a spreadsheet opens", ...about };
const CRITERIA: CoachChange = { field: "acceptanceCriteria", add: ["An empty list exports only the header row"], reword: [{ item: 1, text: "Exporting 2 tasks gives a header row and 2 rows" }], ...about };
const CONTEXT: CoachChange = { field: "context", append: "Today, nothing can be exported.", ...about };
const report = (changes: CoachChange[] = [GOAL, CRITERIA, CONTEXT], overrides: Partial<CoachReport> = {}): CoachReport => ({
  profile: { id: COACH_PROFILE.id, version: COACH_PROFILE.version },
  instructionsSha256: DIGEST,
  taskId: "task",
  briefVersion: 3,
  bindingDigest: DIGEST,
  packetDigest: DIGEST,
  preferencesDigest: DIGEST,
  outcome: "complete",
  scope: "general",
  packet: { chars: 900, criteria: 1, assumptions: 1, gaps: 0, mission: false, findings: 0 },
  summary: "The goal is clear.",
  questions: [],
  changes,
  suggestedChecks: [],
  unknowns: [],
  dropped: { questions: 0, changes: 0, items: 0, refs: 0, checks: 0, unknowns: 0 },
  stage: { status: "answered", reason: null, kind: null, message: null, problems: [], requests: 1, estimatedInputTokens: 900, inputTokens: 1_000, outputTokens: 300, elapsedMs: 4_000, finishReason: "tool-calls", servedModel: "nvidia/nemotron-3-super-120b-a12b" },
  request: { runId: "run", clientRequestId: "request" },
  route: null,
  sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" },
  preferences: { revision: 0, digest: DIGEST, records: [] },
  usage: { inputTokens: 1_000, outputTokens: 300, calls: 1, reportedCalls: 1 },
  budget: {
    limits: { requests: 1, totalMs: 180_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 60_000 },
    used: { requests: 1, elapsedMs: 4_000, inputTokens: 1_000, reportedInputTokens: 1_000, reportedOutputTokens: 300, unreportedRequests: 0, overrunTokens: 100 },
    stopped: null,
  },
  elapsedMs: 4_500,
  updatedAt: "2026-10-28T01:00:00.000Z",
  finishedAt: "2026-10-28T01:00:05.000Z",
  ...overrides,
});

describe("a coaching's report, its changes and what saving them makes (NIV-53)", () => {
  it("keeps a report only when it is the one the coaching asked for", () => {
    const coaching = { taskId: "task", briefVersion: 3, bindingDigest: DIGEST, packetDigest: DIGEST, preferencesDigest: DIGEST, profile: { id: COACH_PROFILE.id, version: COACH_PROFILE.version } };
    assert.equal(coachReportMatches(report(), coaching, "run", "request"), true);
    const others = [
      report([], { taskId: "another" }),
      report([], { briefVersion: 2 }),
      report([], { bindingDigest: "e".repeat(64) }),
      report([], { packetDigest: "e".repeat(64) }),
      report([], { preferencesDigest: "e".repeat(64) }),
      report([], { profile: { id: COACH_PROFILE.id, version: COACH_PROFILE.version + 1 } }),
    ];
    assert.deepEqual(
      others.map((other) => coachReportMatches(other, coaching, "run", "request")),
      others.map(() => false),
    );
    assert.deepEqual([coachReportMatches(report(), coaching, "another run", "request"), coachReportMatches(report(), coaching, "run", "another request")], [false, false]);
  });

  it("shows each change's field before and after it, and why one can't be ticked", () => {
    const masked: CoachChange = { field: "scope", text: "The export, with [masked]", ...about, usable: false };
    const outOfRange: CoachChange = { field: "assumptions", add: [], reword: [{ item: 3, text: "x" }], ...about };
    const views = coachChangeViews(BRIEFS.clearSmall, report([GOAL, CRITERIA, masked, outOfRange]), null);
    assert.deepEqual(
      views.map((view) => [view.field, view.blocked]),
      [
        ["goal", null],
        ["acceptanceCriteria", null],
        ["scope", "Some of its words looked like a credential and were masked, so it can't be saved. Write the change yourself if you need it."],
        ["assumptions", "It rewords an item this brief doesn't have, so it can't be saved."],
      ],
    );
    assert.deepEqual([views[0]!.before, views[0]!.after], [BRIEFS.clearSmall.goal, GOAL.field === "goal" ? GOAL.text : ""]);
    assert.deepEqual(views[1]!.after, ["Exporting 2 tasks gives a header row and 2 rows", "An empty list exports only the header row"]);
    const stale = coachChangeViews(BRIEFS.clearSmall, report([GOAL, masked]), "Your brief changed since the coach read it.");
    assert.deepEqual(
      stale.map((view) => view.blocked),
      ["Your brief changed since the coach read it.", "Some of its words looked like a credential and were masked, so it can't be saved. Write the change yourself if you need it."],
    );
  });

  it("makes exactly the ticked changes, all or nothing, leaving what a run needs as it was", () => {
    const fields = applySelected(FULL, report(), ["acceptanceCriteria", "goal"]);
    assert.deepEqual(
      [fields.goal, fields.acceptanceCriteria, fields.context, fields.scope],
      ["Exports a CSV a spreadsheet opens", ["Exporting 2 tasks gives a header row and 2 rows", "An empty list exports only the header row"], FULL.context, FULL.scope],
    );
    assert.deepEqual([fields.checks, fields.acceptanceCases, fields.baseline, fields.frozen, fields.assumptions, fields.exclusions], [FULL.checks, FULL.acceptanceCases, FULL.baseline, FULL.frozen, FULL.assumptions, FULL.exclusions]);
    assert.deepEqual(FULL.acceptanceCriteria, BRIEFS.clearWithCase.acceptanceCriteria, "the base is unchanged");
    assert.equal(applySelected(FULL, report(), ["context"]).context, `${FULL.context}\n\nToday, nothing can be exported.`);
    const refused = [
      [[], "Tick at least one change, then save."],
      [["goal", "goal"], "Each change can be ticked once. Tick each one once, then save."],
      [["scope"], "The coach proposed no change to the scope, so nothing was saved."],
    ] as const;
    for (const [ticked, words] of refused) assert.equal(refusal(() => applySelected(FULL, report(), ticked)), words);
    const masked = report([{ ...GOAL, usable: false }]);
    assert.match(refusal(() => applySelected(FULL, masked, ["goal"])), /^The coach's change to the goal had words masked as a possible credential, so nothing was saved\./);
    const full: BriefContent = { ...FULL, acceptanceCriteria: Array.from({ length: 19 }, (_, index) => `Criterion ${index + 1}`) };
    const adding = report([{ field: "acceptanceCriteria", add: ["One more", "And another"], reword: [], ...about }]);
    assert.equal(
      refusal(() => applySelected(full, adding, ["acceptanceCriteria"])),
      "With these changes the brief would have 21 acceptance criteria, and it can hold 20, so nothing was saved. Untick the change, or remove some acceptance criteria from the brief first.",
    );
    const long: BriefContent = { ...FULL, context: "c".repeat(19_000) };
    assert.match(refusal(() => applySelected(long, report([{ field: "context", append: "a".repeat(1_500), ...about }]), ["context"])), /^With these changes the context would be 20,502 characters long, and it can hold 20,000/);
    assert.match(refusal(() => applySelected(FULL, report([{ field: "assumptions", add: [], reword: [{ item: 2, text: "x" }], ...about }]), ["assumptions"])), /^The coach's change rewords item 2, and this brief has 1\.$/);
  });

  it("says why a save can't happen, in Track B's words for what changed, led by which brief version the coach read", () => {
    const briefChanged: ContextChange = { kind: "brief-changed", taskId: "t", title: "Add a CSV export", from: 3, to: 4 };
    assert.deepEqual(staleLines([briefChanged], []), [
      "Your brief changed since the coach read it: it read v3, and the brief is now at v4. Nothing was changed. Ask the coach again for suggestions on this version.",
      '"Add a CSV export" is now at brief v4; v3 was sent.',
    ]);
    const renamed: ContextChange = { kind: "title-changed", taskId: "t", from: "Add a CSV export", to: "CSV export" };
    const gone: ContextChange = { kind: "finding-gone", reviewId: "r", findingId: "risk-1" };
    assert.deepEqual(staleLines([renamed, gone], ["applied"]), [
      "What the coach read has changed since, so nothing was changed. Ask the coach again for suggestions on the task as it is now.",
      '"Add a CSV export" is now called "CSV export".',
      "Finding risk-1 is no longer in its review.",
      "Changes from this answer were saved already. Ask the coach again for more suggestions.",
    ]);
    const own = staleLines([], ["project-changed", "profile-changed", "not-complete", "not-complete"]);
    assert.equal(own.length, 3, "each line once");
    assert.ok(own.every((line) => line.length > 0 && !/NIV-\d/.test(line)));
    assert.deepEqual(staleLines([], []), []);
  });
});
