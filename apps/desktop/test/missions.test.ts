import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MISSION_COUNCIL, MISSION_LIMITS, specialistRef, type ContextBinding, type MissionContent } from "@nivra/domain";
import { seedMission, seedMissionReview } from "../e2e/seed-workspace.ts";
import { changeText, compositionOf, missionContextForTask, packetTaskOf, validateBinding } from "../src/main/mission-context.ts";
import {
  addMissionTask,
  getMission,
  insertMission,
  insertMissionVersion,
  latestMissionVersion,
  listMissions,
  missionOfConversation,
  missionOfTask,
  missionRefOf,
  missionTaskIds,
  missionVersions,
  removeMissionTask,
} from "../src/main/mission-store.ts";
import { briefFrom } from "../src/main/tasks.ts";
import {
  deleteConversation,
  deleteTask,
  getArtifact,
  getConversation,
  getTask,
  insertArtifact,
  insertConversation,
  insertTask,
  insertTurn,
  listConversations,
  reviewsOf,
  updateTask,
  versionsOf,
} from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";

/**
 * Missions in the workspace (NIV-52): versions, backlogs, the conversation each owns, and the context check both
 * planning tracks share. Through the workspace's own functions, on a real file.
 */

const dirs: string[] = [];
const dbs: WorkspaceDb[] = [];
after(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const AT = "2026-10-28T01:00:00.000Z";
const MISSION: MissionContent = { name: "Runner's log", intendedUsers: "Club runners.", outcome: "A runner sees this week's distance against their plan.", successCriteria: ["Shows within a second."], constraints: [], nonGoals: ["Social features."] };
const FIELDS = { goal: "Store each run on the phone.", acceptanceCriteria: ["A saved run is there after a restart."], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "nivra missions ü%# "));
  dirs.push(dir);
  return dir;
}

function workspace(path = join(folder(), "workspace.db")): WorkspaceDb {
  const opening = openWorkspace(path);
  if (opening.state !== "ready") throw new Error(opening.reason);
  dbs.push(opening.db);
  return opening.db;
}

function mission(db: WorkspaceDb, content: MissionContent = MISSION) {
  const id = randomUUID();
  const conversationId = randomUUID();
  const first = insertMission(db, { id, conversationId, createdAt: AT }, { id: randomUUID(), content });
  return { id, conversationId, first };
}

function task(db: WorkspaceDb, title: string, projectId: string | null = null) {
  const id = randomUUID();
  insertTask(db, { id, title, projectId, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: briefFrom(FIELDS), derivedFrom: null });
  return id;
}

/** A brief's next version, as the editor saves one. */
const reviseBrief = (db: WorkspaceDb, taskId: string, goal: string) => {
  const latest = versionsOf(db, taskId).at(-1)!;
  return insertArtifact(db, { id: randomUUID(), kind: "brief", lineageId: taskId, content: { ...(latest.content as object), goal }, conversationId: null, taskId, messageId: null, runLinkId: null, derivedFrom: latest.id, createdAt: AT }, latest.version);
};

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

/** A binding of one task to its mission, as either track would make one when it sends them. */
function bindingFor(db: WorkspaceDb, missionId: string, taskIds: string[]): ContextBinding {
  return {
    mission: missionRefOf(latestMissionVersion(db, missionId)!),
    tasks: taskIds.map((taskId) => {
      const brief = versionsOf(db, taskId).at(-1)!;
      return { taskId, briefId: brief.id, briefVersion: brief.version, briefSha256: brief.sha256, title: getTask(db, taskId)!.title };
    }),
    findings: [],
    specialists: [specialistRef("task-readiness-coach")],
  };
}

describe("missions and their versions (NIV-52)", () => {
  it("makes a mission with its own general conversation, which isn't listed, and keeps each version as saved", () => {
    const db = workspace();
    const { id, conversationId, first } = mission(db);
    assert.deepEqual([first.version, first.missionId, first.content], [1, id, MISSION]);
    assert.deepEqual(
      (({ kind, projectId, targetId }) => ({ kind, projectId, targetId }))(getConversation(db, conversationId)!),
      { kind: "general", projectId: null, targetId: "local" },
    );
    assert.equal(missionOfConversation(db, conversationId)?.id, id);
    assert.deepEqual(listConversations(db), [], "a mission's conversation isn't one of the person's");
    const second = insertMissionVersion(db, id, { id: randomUUID(), content: { ...MISSION, outcome: "A runner sees the week's distance." }, createdAt: AT }, 1);
    assert.equal(second?.version, 2);
    assert.equal(insertMissionVersion(db, id, { id: randomUUID(), content: MISSION, createdAt: AT }, 1), null, "an edit made from v1 never lands on v2");
    assert.equal(insertMissionVersion(db, randomUUID(), { id: randomUUID(), content: MISSION, createdAt: AT }, 1), null, "nor on a mission that isn't there");
    assert.deepEqual(missionVersions(db, id).map((version) => version.version), [1, 2]);
    assert.equal(latestMissionVersion(db, id)?.id, second?.id);
    assert.deepEqual(listMissions(db).map((entry) => [entry.mission.id, entry.latest.version]), [[id, 2]]);
    assert.match(refusal(() => db.db.prepare("UPDATE mission_versions SET content_json = '{}' WHERE id = ?").run(first.id)), /mission versions are immutable/);
    assert.match(refusal(() => db.db.prepare("UPDATE missions SET conversation_id = ? WHERE id = ?").run(randomUUID(), id)), /a mission keeps its conversation/);
  });

  it("refuses a mission on a conversation of a project, or on one with messages", () => {
    const db = workspace();
    const turn = { id: randomUUID(), conversationId: "", sessionId: "s", targetId: "local", preferences: [], history: null, createdAt: AT };
    const projectConversation = randomUUID();
    insertConversation(db, { id: projectConversation, kind: "project", projectId: randomUUID(), projectLabel: "shop", targetId: "local", title: "t", createdAt: AT, updatedAt: AT });
    assert.match(refusal(() => db.db.prepare("INSERT INTO missions (id, conversation_id, created_at) VALUES (?, ?, ?)").run(randomUUID(), projectConversation, AT)), /a mission owns a general conversation of its own/);
    const chat = randomUUID();
    insertConversation(db, { id: chat, kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "t", createdAt: AT, updatedAt: AT });
    insertTurn(db, { ...turn, id: randomUUID(), conversationId: chat }, { id: randomUUID(), text: "hello" });
    assert.match(refusal(() => db.db.prepare("INSERT INTO missions (id, conversation_id, created_at) VALUES (?, ?, ?)").run(randomUUID(), chat, AT)), /with no messages/);
  });

  it("holds a task in one backlog at most, within its limit, and leaves the task as it was when it leaves", () => {
    const db = workspace();
    const a = mission(db);
    const b = mission(db);
    const first = task(db, "Store runs");
    assert.equal(addMissionTask(db, a.id, first, AT), "added");
    assert.equal(addMissionTask(db, a.id, first, AT), "already-here");
    assert.equal(addMissionTask(db, b.id, first, AT), "in-another-mission");
    assert.equal(addMissionTask(db, a.id, randomUUID(), AT), "gone");
    assert.equal(addMissionTask(db, randomUUID(), first, AT), "gone");
    assert.equal(missionOfTask(db, first), a.id);
    const before = getTask(db, first);
    assert.equal(removeMissionTask(db, b.id, first), false, "only from its own backlog");
    assert.equal(removeMissionTask(db, a.id, first), true);
    assert.deepEqual([missionOfTask(db, first), getTask(db, first)], [null, before]);
    for (let n = 0; n < MISSION_LIMITS.tasks; n++) addMissionTask(db, b.id, task(db, `t${n}`), AT);
    assert.equal(addMissionTask(db, b.id, first, AT), "backlog-full");
    assert.equal(missionTaskIds(db, b.id).length, MISSION_LIMITS.tasks);
  });

  it("goes with its conversation: its versions, backlog, review plans and reviews, while its tasks stay", () => {
    const path = join(folder(), "workspace.db");
    const seeded = seedMission(path, { mission: MISSION, tasks: [{ title: "Store runs", goal: "g", acceptanceCriteria: ["c"] }, { title: "Weekly total", goal: "g", acceptanceCriteria: ["c"] }] });
    const { reviewId, planId } = seedMissionReview(path, { missionId: seeded.missionId, taskIds: seeded.taskIds, findings: [] });
    const db = workspace(path);
    assert.equal(reviewsOf(db, seeded.conversationId).map((review) => review.id).join(), reviewId);
    assert.ok(deleteConversation(db, seeded.conversationId));
    assert.deepEqual([getMission(db, seeded.missionId), missionVersions(db, seeded.missionId), missionTaskIds(db, seeded.missionId), getArtifact(db, planId), reviewsOf(db, seeded.conversationId)], [null, [], [], null, []]);
    assert.deepEqual(
      seeded.taskIds.map((id) => [getTask(db, id)?.title, missionOfTask(db, id)]),
      [
        ["Store runs", null],
        ["Weekly total", null],
      ],
    );
  });

  it("forgets a deleted task's place in a backlog", () => {
    const db = workspace();
    const { id } = mission(db);
    const gone = task(db, "Gone soon");
    addMissionTask(db, id, gone, AT);
    assert.ok(deleteTask(db, gone));
    assert.deepEqual(missionTaskIds(db, id), []);
  });
});

describe("the shared context check (NIV-52, NIV-53)", () => {
  it("finds nothing changed in a binding made from the records as they are", () => {
    const db = workspace();
    const { id } = mission(db);
    const first = task(db, "Store runs");
    addMissionTask(db, id, first, AT);
    assert.deepEqual(validateBinding(db, bindingFor(db, id, [first])), []);
  });

  it("names a mission change while the brief stays as it was", () => {
    const db = workspace();
    const { id } = mission(db);
    const first = task(db, "Store runs");
    addMissionTask(db, id, first, AT);
    const binding = bindingFor(db, id, [first]);
    insertMissionVersion(db, id, { id: randomUUID(), content: { ...MISSION, nonGoals: [] }, createdAt: AT }, 1);
    const changes = validateBinding(db, binding);
    assert.deepEqual(changes, [{ kind: "mission-changed", missionId: id, from: 1, to: 2 }]);
    assert.equal(changeText(changes[0]!), "The mission is now at v2; v1 was sent.");
  });

  it("names a task's removal from the mission's backlog while its brief stays as it was", () => {
    const db = workspace();
    const { id } = mission(db);
    const first = task(db, "Store runs");
    addMissionTask(db, id, first, AT);
    const binding = bindingFor(db, id, [first]);
    removeMissionTask(db, id, first);
    assert.deepEqual(validateBinding(db, binding), [{ kind: "membership-removed", taskId: first, title: "Store runs", missionId: id }]);
    const other = mission(db);
    addMissionTask(db, other.id, first, AT);
    assert.deepEqual(validateBinding(db, binding).map((change) => change.kind), ["membership-removed"], "moving it to another mission counts too");
  });

  it("names a rename, which makes no brief version, and a brief's next version", () => {
    const db = workspace();
    const { id } = mission(db);
    const first = task(db, "Store runs");
    addMissionTask(db, id, first, AT);
    const binding = bindingFor(db, id, [first]);
    assert.ok(updateTask(db, first, 1, { title: "Store runs on the phone" }, AT));
    assert.equal(versionsOf(db, first).length, 1, "a rename made no brief version");
    assert.deepEqual(validateBinding(db, binding), [{ kind: "title-changed", taskId: first, from: "Store runs", to: "Store runs on the phone" }]);
    reviseBrief(db, first, "Store each run on the phone, offline.");
    assert.deepEqual(
      validateBinding(db, binding).map((change) => [change.kind, changeText(change)]),
      [
        ["brief-changed", `"Store runs on the phone" is now at brief v2; v1 was sent.`],
        ["title-changed", `"Store runs" is now called "Store runs on the phone".`],
      ],
    );
  });

  it("names a deleted task and a deleted mission, without a membership change on top", () => {
    const db = workspace();
    const { id, conversationId } = mission(db);
    const first = task(db, "Store runs");
    const second = task(db, "Weekly total");
    addMissionTask(db, id, first, AT);
    addMissionTask(db, id, second, AT);
    const binding = bindingFor(db, id, [first, second]);
    deleteTask(db, second);
    deleteConversation(db, conversationId);
    assert.deepEqual(validateBinding(db, binding), [
      { kind: "mission-deleted", missionId: id },
      { kind: "task-deleted", taskId: second, title: "Weekly total" },
    ]);
  });

  it("names a finding that isn't in its review any more, and a binding whose brief digest isn't the stored one", () => {
    const path = join(folder(), "workspace.db");
    const seeded = seedMission(path, { mission: MISSION, tasks: [{ title: "Store runs", goal: "g", acceptanceCriteria: ["c"] }] });
    const { reviewId } = seedMissionReview(path, {
      missionId: seeded.missionId,
      taskIds: seeded.taskIds,
      findings: [{ role: "risks", title: "No offline test", detail: "d", recommendation: "r", refs: ["T1"] }],
    });
    const db = workspace(path);
    const base = bindingFor(db, seeded.missionId, seeded.taskIds);
    assert.deepEqual(validateBinding(db, { ...base, findings: [{ reviewId, findingId: "risk-1" }] }), []);
    assert.deepEqual(validateBinding(db, { ...base, findings: [{ reviewId, findingId: "risk-2" }] }), [{ kind: "finding-gone", reviewId, findingId: "risk-2" }]);
    assert.deepEqual(validateBinding(db, { ...base, findings: [{ reviewId: randomUUID(), findingId: "arch-1" }] }).map((change) => change.kind), ["finding-gone"]);
    const forged = { ...base, tasks: [{ ...base.tasks[0]!, briefSha256: "f".repeat(64) }] };
    assert.deepEqual(validateBinding(db, forged).map((change) => change.kind), ["brief-changed"]);
  });

  it("runs inside the transaction that would save a suggestion: a stale one saves nothing, while ordinary editing goes on", () => {
    const db = workspace();
    const { id } = mission(db);
    const first = task(db, "Store runs");
    addMissionTask(db, id, first, AT);
    const binding = bindingFor(db, id, [first]);
    // What the coach's save does (NIV-53): check the context and the brief version, then add the next version, at once.
    const acceptSuggestion = (goal: string) =>
      db.tx(() => {
        const changes = validateBinding(db, binding);
        if (changes.length) throw new Error(`Not saved: ${changes.map(changeText).join(" ")}`);
        const saved = reviseBrief(db, first, goal);
        if (!saved) throw new Error("Not saved: the brief changed.");
        return saved.version;
      });
    insertMissionVersion(db, id, { id: randomUUID(), content: { ...MISSION, constraints: ["Works offline."] }, createdAt: AT }, 1);
    assert.equal(refusal(() => acceptSuggestion("A suggested goal.")), "Not saved: The mission is now at v2; v1 was sent.");
    assert.equal(versionsOf(db, first).length, 1, "nothing was saved");
    assert.equal(reviseBrief(db, first, "The person's own edit.")?.version, 2, "editing by hand never depends on the check");
  });
});

describe("a task's mission context, for the coach (NIV-53)", () => {
  it("gives no mission and no findings for a task outside every backlog", () => {
    const db = workspace();
    assert.deepEqual(missionContextForTask(db, task(db, "Alone")), { mission: null, findings: [] });
  });

  it("gives the task's mission at its latest version, and only the findings that name the task, with what changed since", () => {
    const path = join(folder(), "workspace.db");
    const seeded = seedMission(path, {
      mission: MISSION,
      tasks: [
        { title: "Store runs", goal: "g", acceptanceCriteria: ["c"] },
        { title: "Weekly total", goal: "g", acceptanceCriteria: ["c"] },
      ],
    });
    const [store, total] = seeded.taskIds as [string, string];
    const { reviewId, planId } = seedMissionReview(path, {
      missionId: seeded.missionId,
      taskIds: [total, store],
      findings: [
        { role: "architecture", title: "Totals need stored runs first", detail: "d", recommendation: "r", refs: ["T1", "T2"] },
        { role: "risks", title: "No test for a lost run", detail: "d", recommendation: "r", refs: ["T2"] },
        { role: "risks", title: "No backlog item for sync", detail: "d", recommendation: "r", refs: ["backlog"] },
      ],
    });
    const db = workspace(path);
    const composition = compositionOf(getArtifact(db, planId)!);
    assert.deepEqual(composition?.binding.tasks.map((t) => t.title), ["Weekly total", "Store runs"]);
    assert.deepEqual(composition?.packet.specialists, MISSION_COUNCIL.map(specialistRef));
    const context = missionContextForTask(db, store);
    assert.deepEqual([context.mission?.ref.missionId, context.mission?.ref.version, context.mission?.content], [seeded.missionId, 1, MISSION]);
    assert.deepEqual(
      context.findings.map((finding) => [finding.ref.reviewId, finding.ref.findingId, finding.taskRef, finding.finding.title, finding.changes]),
      [
        [reviewId, "arch-1", "T2", "Totals need stored runs first", []],
        [reviewId, "risk-1", "T2", "No test for a lost run", []],
      ],
    );
    assert.deepEqual(missionContextForTask(db, total).findings.map((finding) => finding.ref.findingId), ["arch-1"]);
    reviseBrief(db, store, "Store each run, offline.");
    assert.deepEqual(missionContextForTask(db, store).findings[0]?.changes.map((change) => change.kind), ["brief-changed"]);
    removeMissionTask(db, seeded.missionId, store);
    assert.deepEqual(missionContextForTask(db, store), { mission: null, findings: [] });
  });
});

describe("what a mission review sends of a task (NIV-52)", () => {
  it("is the title and the brief's words, with acceptance cases by name only", () => {
    const brief = briefFrom({ ...FIELDS, checks: ["pnpm test"], acceptanceCases: [{ name: "saves a run", command: "node check.mjs", expectedOutput: "ok\n", expectedExitCode: 0 }] });
    assert.deepEqual(packetTaskOf("Store runs", brief), {
      title: "Store runs",
      goal: FIELDS.goal,
      acceptanceCriteria: FIELDS.acceptanceCriteria,
      scope: "",
      exclusions: "",
      assumptions: [],
      checks: ["pnpm test"],
      context: "",
      acceptanceCaseNames: ["saves a run"],
    });
    assert.doesNotMatch(JSON.stringify(packetTaskOf("Store runs", brief)), /node check\.mjs|"ok\\n"/);
  });
});
