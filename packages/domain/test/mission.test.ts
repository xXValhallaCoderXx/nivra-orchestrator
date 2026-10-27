import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  bindingDigest,
  ContextBinding,
  MISSION_LIMITS,
  MISSION_REVIEW_LIMITS,
  MissionContent,
  MissionReviewComposition,
  MissionReviewPacket,
  missionPacketDigest,
  renderMissionPacket,
  taskRef,
  type ContextBinding as Binding,
  type MissionReviewPacket as Packet,
} from "../src/mission.ts";
import { StartRunParams } from "../src/methods.ts";
import { REVIEW_PACKET_LIMITS, ReviewerReport } from "../src/review.ts";
import { MISSION_COUNCIL, SPECIALISTS, SpecialistId, specialistRef } from "../src/specialists.ts";

/** The mission contract (NIV-52): what a mission holds, how context is bound, and what a mission review sends. */

const ids = {
  mission: "6f1c2a8e-3b4d-4c5e-8f60-718293a4b5c6",
  version: "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
  task1: "11111111-2222-4333-8444-555555555555",
  brief1: "21111111-2222-4333-8444-555555555555",
  task2: "31111111-2222-4333-8444-555555555555",
  brief2: "41111111-2222-4333-8444-555555555555",
  review: "51111111-2222-4333-8444-555555555555",
};
const SHA = "a".repeat(64);

const MISSION: MissionContent = {
  name: "Runner's log",
  intendedUsers: "Club runners who log three runs a week.",
  outcome: "A runner can see this week's distance against their plan.",
  successCriteria: ["Weekly distance shows within a second of opening."],
  constraints: ["Works offline."],
  nonGoals: ["Social features."],
};

const BINDING: Binding = {
  mission: { missionId: ids.mission, versionId: ids.version, version: 3, sha256: SHA },
  tasks: [
    { taskId: ids.task1, briefId: ids.brief1, briefVersion: 2, briefSha256: SHA, title: "Store runs locally" },
    { taskId: ids.task2, briefId: ids.brief2, briefVersion: 1, briefSha256: "b".repeat(64), title: "Weekly total" },
  ],
  findings: [{ reviewId: ids.review, findingId: "risk-2" }],
  specialists: [specialistRef("product-architect"), specialistRef("risk-testability"), specialistRef("council-chair")],
};

const task = (title: string, overrides: Partial<Packet["tasks"][number]> = {}): Packet["tasks"][number] => ({
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

const PACKET: Packet = {
  kind: "mission",
  scope: { kind: "general" },
  specialists: MISSION_COUNCIL.map(specialistRef),
  model: null,
  mission: MISSION,
  tasks: [task("Store runs locally", { checks: ["pnpm test"], acceptanceCaseNames: ["saves a run"] }), task("Weekly total")],
  othersInBacklog: 4,
};

describe("a mission's content (NIV-52)", () => {
  it("needs a name and an outcome, and nothing else", () => {
    assert.equal(MissionContent.safeParse({ ...MISSION, intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] }).success, true);
    const refused = [{ ...MISSION, name: "  " }, { ...MISSION, outcome: "\n" }, { ...MISSION, name: "" }];
    assert.deepEqual(
      refused.map((content) => MissionContent.safeParse(content).success),
      [false, false, false],
    );
  });

  it("refuses parts over their limits, blank items and anything it doesn't hold", () => {
    const refused = [
      { ...MISSION, name: "n".repeat(MISSION_LIMITS.nameChars + 1) },
      { ...MISSION, intendedUsers: "u".repeat(MISSION_LIMITS.intendedUsersChars + 1) },
      { ...MISSION, outcome: "o".repeat(MISSION_LIMITS.outcomeChars + 1) },
      { ...MISSION, successCriteria: Array.from({ length: MISSION_LIMITS.items + 1 }, () => "c") },
      { ...MISSION, constraints: ["c".repeat(MISSION_LIMITS.itemChars + 1)] },
      { ...MISSION, nonGoals: [" "] },
      { ...MISSION, repoPath: "/repo" },
    ];
    assert.deepEqual(
      refused.map((content) => MissionContent.safeParse(content).success),
      refused.map(() => false),
    );
  });
});

describe("a context binding (NIV-52, NIV-53)", () => {
  it("takes a mission or none, one to five tasks with their titles, findings and profiles", () => {
    assert.equal(ContextBinding.safeParse(BINDING).success, true);
    assert.equal(ContextBinding.safeParse({ ...BINDING, mission: null, findings: [], specialists: [specialistRef("task-readiness-coach")] }).success, true);
  });

  it("refuses duplicates, too many tasks, malformed or foreign references, and a task without its title", () => {
    const [first, second] = BINDING.tasks;
    const refused = [
      { ...BINDING, tasks: [first, { ...second!, taskId: first!.taskId }] },
      { ...BINDING, tasks: Array.from({ length: MISSION_REVIEW_LIMITS.tasks + 1 }, () => first) },
      { ...BINDING, tasks: [] },
      { ...BINDING, tasks: [{ ...first!, title: "" }] },
      { ...BINDING, tasks: [(({ title: _title, ...rest }) => rest)(first!)] },
      { ...BINDING, tasks: [{ ...first!, briefVersion: 0 }] },
      { ...BINDING, tasks: [{ ...first!, briefSha256: "not a digest" }] },
      { ...BINDING, tasks: [{ ...first!, taskId: "not-a-uuid" }] },
      { ...BINDING, tasks: [{ ...first!, projectId: ids.task2 }] },
      { ...BINDING, findings: [BINDING.findings[0], BINDING.findings[0]] },
      { ...BINDING, findings: [{ reviewId: ids.review, findingId: "T1" }] },
      { ...BINDING, specialists: [specialistRef("council-chair"), specialistRef("council-chair")] },
      { ...BINDING, specialists: [{ id: "custom-agent", version: 1 }] },
      { ...BINDING, mission: { ...BINDING.mission!, version: -1 } },
    ];
    assert.deepEqual(
      refused.map((binding) => ContextBinding.safeParse(binding).success),
      refused.map(() => false),
    );
  });
});

describe("bindingDigest (NIV-52)", () => {
  it("is pinned to its canonical form, which anyone can work out", async () => {
    const digest = await bindingDigest(BINDING);
    const independent = createHash("sha256")
      .update(
        JSON.stringify([
          "nivra.context-binding.v1",
          [ids.mission, ids.version, 3, SHA],
          [
            [ids.task1, ids.brief1, 2, SHA, "Store runs locally"],
            [ids.task2, ids.brief2, 1, "b".repeat(64), "Weekly total"],
          ],
          [[ids.review, "risk-2"]],
          [
            ["product-architect", 1],
            ["risk-testability", 1],
            ["council-chair", 1],
          ],
        ]),
      )
      .digest("hex");
    assert.equal(digest, "31f0373883f474686f51e90c4e83e0b75c44f02850c8b47aa861cf8acd287a4d");
    assert.equal(digest, independent);
  });

  it("changes with a title, a version, the order of the tasks or the mission", async () => {
    const base = await bindingDigest(BINDING);
    const [first, second] = BINDING.tasks;
    const variants = [
      { ...BINDING, tasks: [{ ...first!, title: "Store runs on the phone" }, second!] },
      { ...BINDING, tasks: [{ ...first!, briefVersion: 3 }, second!] },
      { ...BINDING, tasks: [second!, first!] },
      { ...BINDING, mission: { ...BINDING.mission!, version: 4 } },
      { ...BINDING, mission: null },
      { ...BINDING, findings: [] },
      { ...BINDING, specialists: BINDING.specialists.slice(0, 2) },
    ];
    const digests = await Promise.all(variants.map(bindingDigest));
    assert.equal(new Set([base, ...digests]).size, variants.length + 1);
  });
});

describe("a mission review's packet (NIV-52)", () => {
  it("names each selected task T1, T2, ... and says what wasn't sent or was left empty", () => {
    const text = renderMissionPacket(PACKET);
    assert.equal(taskRef(0), "T1");
    assert.match(text, /^The mission \(mission\):\nName: Runner's log\n/);
    assert.match(text, /The selected tasks: T1 to T2\. The backlog holds 4 other tasks, which weren't sent\./);
    assert.match(text, /\n\nT1\. Store runs locally\nGoal: Do Store runs locally\.\n/);
    assert.match(text, /Checks:\n- pnpm test\nAcceptance cases, by name: saves a run\n/);
    assert.match(text, /\n\nT2\. Weekly total\n[\s\S]*Scope: \(none written\)\n[\s\S]*Acceptance cases, by name: \(none written\)\nContext: \(none written\)$/);
    assert.match(renderMissionPacket({ ...PACKET, tasks: [PACKET.tasks[0]!], othersInBacklog: 1 }), /The selected tasks: T1\. The backlog holds 1 other task, which wasn't sent\./);
    assert.match(renderMissionPacket({ ...PACKET, othersInBacklog: 0 }), /The backlog holds no other tasks\./);
  });

  it("keeps D30's text limit, refusing a packet over it rather than shortening it", () => {
    assert.equal(MISSION_REVIEW_LIMITS.textChars, REVIEW_PACKET_LIMITS.textChars);
    const long = (title: string) => task(title, { context: "c".repeat(MISSION_REVIEW_LIMITS.contextChars) });
    const over = { ...PACKET, tasks: [long("A"), long("B")] };
    const parsed = MissionReviewPacket.safeParse(over);
    assert.equal(parsed.success, false);
    assert.match(JSON.stringify(parsed.error?.issues), /at most 20,000 characters/);
    assert.equal(MissionReviewPacket.safeParse(PACKET).success, true);
  });

  it("refuses another panel's profiles, a repository scope, too many tasks, unsent parts and defaults", () => {
    const refused = [
      { ...PACKET, specialists: [specialistRef("risk-testability"), specialistRef("product-architect"), specialistRef("council-chair")] },
      { ...PACKET, specialists: [specialistRef("product-architect"), specialistRef("risk-testability")] },
      { ...PACKET, scope: { kind: "project", headAtStart: null } },
      { ...PACKET, tasks: [] },
      { ...PACKET, tasks: Array.from({ length: MISSION_REVIEW_LIMITS.tasks + 1 }, (_, index) => task(`t${index}`)) },
      { ...PACKET, tasks: [{ ...PACKET.tasks[0]!, acceptanceCases: [{ name: "x", command: "true", expectedOutput: "", expectedExitCode: 0 }] }] },
      { ...PACKET, tasks: [{ ...PACKET.tasks[0]!, state: "ready" }] },
      { ...PACKET, othersInBacklog: -1 },
      { ...PACKET, model: "" },
      (({ model: _model, ...rest }) => rest)(PACKET),
    ];
    assert.deepEqual(
      refused.map((packet) => MissionReviewPacket.safeParse(packet).success),
      refused.map(() => false),
    );
  });

  it("missionPacketDigest is pinned to its canonical form, and binds the model", async () => {
    const digest = await missionPacketDigest(PACKET);
    const independent = createHash("sha256")
      .update(
        JSON.stringify([
          "nivra.mission-review-packet.v1",
          "general",
          [
            ["product-architect", 1],
            ["risk-testability", 1],
            ["council-chair", 1],
          ],
          null,
          [MISSION.name, MISSION.intendedUsers, MISSION.outcome, MISSION.successCriteria, MISSION.constraints, MISSION.nonGoals],
          PACKET.tasks.map((t) => [t.title, t.goal, t.acceptanceCriteria, t.scope, t.exclusions, t.assumptions, t.checks, t.context, t.acceptanceCaseNames]),
          4,
        ]),
      )
      .digest("hex");
    assert.equal(digest, "c76de27bb41f84cddc1300139a59d1d54d06a91029f13e6b6c4a9170fa64b4bd");
    assert.equal(digest, independent);
    assert.notEqual(await missionPacketDigest({ ...PACKET, model: "nvidia/nemotron-3-super-120b-a12b" }), digest);
    assert.notEqual(await missionPacketDigest({ ...PACKET, tasks: [PACKET.tasks[1]!, PACKET.tasks[0]!] }), digest);
  });

  it("is kept as a composition that names its tasks in the order sent, with their titles as sent", () => {
    const binding = { ...BINDING, findings: [], specialists: PACKET.specialists };
    const composition = { binding, packet: PACKET, text: renderMissionPacket(PACKET) };
    assert.equal(MissionReviewComposition.safeParse(composition).success, true);
    const refused = [
      { ...composition, binding: { ...binding, mission: null } },
      { ...composition, binding: { ...binding, tasks: [binding.tasks[1]!, binding.tasks[0]!] } },
      { ...composition, binding: { ...binding, tasks: [binding.tasks[0]!] } },
      { ...composition, text: "" },
    ];
    assert.deepEqual(
      refused.map((value) => MissionReviewComposition.safeParse(value).success),
      refused.map(() => false),
    );
  });
});

describe("the specialist catalogue (NIV-52)", () => {
  it("has each profile once, versioned, granting nothing and making one call per action", () => {
    for (const id of SpecialistId.options) {
      const profile = SPECIALISTS[id];
      assert.equal(profile.id, id);
      assert.ok(Number.isInteger(profile.version) && profile.version >= 1, id);
      assert.deepEqual(profile.capabilities, [], id);
      assert.equal(profile.callsPerAction, 1, id);
      assert.ok(profile.name.length > 0 && profile.personality.length > 0 && profile.purpose.length > 0, id);
    }
    assert.deepEqual(MISSION_COUNCIL, ["product-architect", "risk-testability", "council-chair"]);
    assert.deepEqual(specialistRef("council-chair"), { id: "council-chair", version: SPECIALISTS["council-chair"].version });
  });
});

describe("a mission review as a review run (NIV-52)", () => {
  const request = (packet: unknown) => ({
    clientRequestId: randomUUID(),
    workflowId: "review",
    input: { panel: "council", planId: randomUUID(), planVersion: 1, packetDigest: SHA, preferencesDigest: SHA },
    context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false }, packet },
  });

  it("takes a mission packet in a review's context, and a plan packet exactly as before", () => {
    const mission = StartRunParams.parse(request(PACKET));
    assert.deepEqual(mission.workflowId === "review" ? mission.context.packet : null, PACKET);
    const plan = { scope: { kind: "general" }, text: "A plan", assumptions: [], references: [] };
    const parsed = StartRunParams.parse(request(plan));
    assert.deepEqual(parsed.workflowId === "review" ? parsed.context.packet : null, plan);
    assert.equal(StartRunParams.safeParse(request({ ...plan, kind: "mission" })).success, false, "a plan packet with a kind is neither");
    assert.equal(StartRunParams.safeParse(request({ ...PACKET, text: "A plan" })).success, false, "a mission packet with a plan's text is neither");
  });

  it("counts a reviewer's findings set aside for naming nothing in the selection, and reads a report without that count as before", () => {
    const report = { role: "risks", summary: "s", findings: [], assumptions: [], gaps: [], adjusted: { dropped: 0, refsDropped: 2, relabelled: 0, shortened: 0 } };
    assert.equal(ReviewerReport.safeParse(report).success, true);
    assert.equal(ReviewerReport.safeParse({ ...report, adjusted: { ...report.adjusted, unanchored: 3 } }).success, true);
    assert.equal(ReviewerReport.safeParse({ ...report, adjusted: { ...report.adjusted, unanchored: -1 } }).success, false);
  });
});
