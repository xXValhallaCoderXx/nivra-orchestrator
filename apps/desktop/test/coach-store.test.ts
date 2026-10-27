import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { COACH_MIGRATION, coachingsOf, getCoaching, getCoachLink, insertCoaching, markCoachingApplied, openCoachings, settleCoaching, type CoachingRecord } from "../src/main/coach-store.ts";
import { deleteTask, insertArtifact, insertAttempt, insertTask, recordRun, versionsOf, type ArtifactRecord } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb, type WorkspaceOpening } from "../src/main/workspace-db.ts";
import { BRIEFS } from "./fixtures/briefs.ts";

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => {
  for (const db of open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A workspace at the current schema with the coach's table, which joins the migrations at integration (NIV-53). */
function workspace(): WorkspaceDb {
  const dir = mkdtempSync(join(tmpdir(), "nivra coach ü "));
  dirs.push(dir);
  const opening = openWorkspace(join(dir, "workspace.db"));
  assert.equal(opening.state, "ready", opening.state === "unavailable" ? opening.reason : "");
  const ready = opening as Extract<WorkspaceOpening, { state: "ready" }>;
  open.push(ready.db);
  ready.db.db.exec(COACH_MIGRATION);
  return ready.db;
}

const AT = "2026-10-28T01:00:00.000Z";
const LATER = "2026-10-28T01:05:00.000Z";
const LINK = { sessionId: "s", targetId: "local", preferences: [{ id: randomUUID(), revision: 2 }] };
const DIGEST = "d".repeat(64);

/** A task with its first brief, and that brief's record. */
function task(db: WorkspaceDb, projectId: string | null = null): { taskId: string; brief: ArtifactRecord } {
  const taskId = randomUUID();
  insertTask(db, { id: taskId, title: "Personal records use one unit", projectId, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: BRIEFS.vague, derivedFrom: null });
  return { taskId, brief: versionsOf(db, taskId).at(-1)! };
}

/** The next version of a task's brief, made from `from`. */
const nextBrief = (db: WorkspaceDb, taskId: string, from: ArtifactRecord, derivedFrom: string | null = from.id) =>
  insertArtifact(db, { id: randomUUID(), kind: "brief", lineageId: taskId, content: { ...BRIEFS.vague, goal: "Records compare finish times in one unit" }, conversationId: null, taskId, messageId: null, runLinkId: null, derivedFrom, createdAt: LATER }, from.version)!;

const coachingFor = (taskId: string, brief: ArtifactRecord, projectId: string | null = null, id: string = randomUUID()): Omit<CoachingRecord, "report" | "reportedAt" | "applied" | "link"> => ({
  id,
  taskId,
  briefId: brief.id,
  briefVersion: brief.version,
  briefSha256: brief.sha256,
  title: "Personal records use one unit",
  projectId,
  binding: { tasks: [{ taskId, briefId: brief.id, briefVersion: brief.version, briefSha256: brief.sha256, title: "Personal records use one unit" }], mission: null, findings: [], specialists: [{ id: "task-readiness-coach", version: 1 }] },
  bindingDigest: DIGEST,
  packetDigest: DIGEST,
  preferencesDigest: DIGEST,
  profile: { id: "task-readiness-coach", version: 1 },
  mission: null,
  findings: 0,
  preferences: 1,
  createdAt: AT,
});
const REPORT = { outcome: "complete", summary: "The goal is clear." };
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

describe("coachings of tasks in the workspace (NIV-53)", () => {
  it("binds a coaching to a coach run of its own task and to a version of that task's brief, before anything is sent", () => {
    const db = workspace();
    const { taskId, brief } = task(db);
    const other = task(db);
    const coaching = coachingFor(taskId, brief);
    assert.equal(insertCoaching(db, coaching, LINK), true);
    const kept = getCoaching(db, coaching.id)!;
    assert.deepEqual([kept.link.status, kept.link.homeId, kept.link.runId, kept.link.targetId, kept.briefVersion], ["submitting", null, null, "local", 1]);
    assert.deepEqual(kept.link.preferences, LINK.preferences, "preferences by id and revision, never their text");
    assert.deepEqual([kept.report, kept.applied, kept.mission], [null, null, null]);
    // The row itself refuses another task's run, another workflow's run, and a brief that isn't the version named.
    const bound = /a coaching is bound to a coach run of its own task and to a version of that task's brief/;
    const raw = (values: { id: string; taskId: string; briefId: string; version: number; sha: string }) =>
      refusal(() =>
        db.db
          .prepare(
            "INSERT INTO coachings (id, task_id, brief_id, brief_version, brief_sha256, title, project_id, binding_json, binding_digest, packet_digest, preferences_digest, profile_id, profile_version, mission_json, findings, preferences, created_at) VALUES (?, ?, ?, ?, ?, 't', NULL, '{}', ?, ?, ?, 'task-readiness-coach', 1, NULL, 0, 0, ?)",
          )
          .run(values.id, values.taskId, values.briefId, values.version, values.sha, DIGEST, DIGEST, DIGEST, AT),
      );
    const attempt = randomUUID();
    assert.equal(insertAttempt(db, { id: attempt, taskId, briefId: brief.id, sessionId: "s", targetId: "wsl:Ubuntu", status: "answered", createdAt: AT }), true);
    assert.match(raw({ id: attempt, taskId, briefId: brief.id, version: 1, sha: brief.sha256 }), bound, "a task run isn't a coaching");
    assert.match(raw({ id: coaching.id, taskId: other.taskId, briefId: other.brief.id, version: 1, sha: other.brief.sha256 }), /UNIQUE|PRIMARY|bound/);
    const second = randomUUID();
    db.db.prepare("INSERT INTO run_links (id, task_id, brief_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, ?, 's', 'coach', 'local', 'answered', '[]', ?)").run(second, taskId, brief.id, AT);
    assert.match(raw({ id: second, taskId, briefId: brief.id, version: 1, sha: "e".repeat(64) }), bound, "the brief's digest must be the version's");
    assert.match(raw({ id: second, taskId, briefId: brief.id, version: 2, sha: brief.sha256 }), bound, "and its version");
    assert.match(raw({ id: second, taskId: other.taskId, briefId: other.brief.id, version: 1, sha: other.brief.sha256 }), bound, "a run of another task");
  });

  it("holds one open coaching per task, which neither another task's nor a task run blocks", () => {
    const db = workspace();
    const { taskId, brief } = task(db);
    const other = task(db);
    const first = coachingFor(taskId, brief);
    assert.equal(insertCoaching(db, first, LINK), true);
    assert.equal(insertCoaching(db, coachingFor(taskId, brief), LINK), false, "one at a time for a task");
    assert.equal(insertCoaching(db, coachingFor(other.taskId, other.brief), LINK), true, "another task's isn't blocked");
    assert.equal(insertAttempt(db, { id: randomUUID(), taskId, briefId: brief.id, sessionId: "s", targetId: "wsl:Ubuntu", createdAt: AT }), true, "a task run isn't blocked by a coaching");
    assert.equal(settleCoaching(db, first.id, { status: "answered" }, REPORT, LATER), true);
    assert.equal(insertCoaching(db, coachingFor(taskId, brief), LINK), true, "once it ended, another can start");
    assert.deepEqual(
      openCoachings(db, { taskId }).map((one) => one.taskId),
      [taskId],
    );
  });

  it("keeps its first outcome and report, and never changes what it was bound to", () => {
    const db = workspace();
    const { taskId, brief } = task(db);
    const coaching = coachingFor(taskId, brief);
    insertCoaching(db, coaching, LINK);
    assert.equal(recordRun(db, coaching.id, randomUUID()), true);
    assert.equal(settleCoaching(db, coaching.id, { status: "answered" }, REPORT, LATER), true);
    assert.equal(settleCoaching(db, coaching.id, { status: "failed", errorMessage: "late" }, { outcome: "failed" }, LATER), false, "a coaching that ended keeps its first outcome");
    const kept = getCoaching(db, coaching.id)!;
    assert.deepEqual([kept.link.status, kept.report, kept.reportedAt], ["answered", REPORT, LATER]);
    const frozen = /a coaching never changes what it was bound to, keeps its first report, and records its saved changes once, after its report/;
    assert.match(refusal(() => db.db.prepare("UPDATE coachings SET report_json = '{}' WHERE id = ?").run(coaching.id)), frozen);
    for (const column of ["title", "binding_digest", "packet_digest", "preferences_digest", "brief_sha256"]) {
      assert.match(refusal(() => db.db.prepare(`UPDATE coachings SET ${column} = 'x' WHERE id = ?`).run(coaching.id)), frozen, column);
    }
    assert.match(refusal(() => db.db.prepare("UPDATE coachings SET profile_version = 2 WHERE id = ?").run(coaching.id)), frozen);
  });

  it("records the changes saved from its report once, after the report, as the next version made from the one it read", () => {
    const db = workspace();
    const { taskId, brief } = task(db);
    const other = task(db);
    const coaching = coachingFor(taskId, brief);
    insertCoaching(db, coaching, LINK);
    const v2 = nextBrief(db, taskId, brief);
    assert.equal(markCoachingApplied(db, coaching.id, v2.id, ["goal"], LATER), false, "no report, nothing to save from");
    settleCoaching(db, coaching.id, { status: "answered" }, REPORT, LATER);
    const frozen = /a coaching never changes what it was bound to, keeps its first report, and records its saved changes once, after its report/;
    assert.match(refusal(() => markCoachingApplied(db, coaching.id, other.brief.id, ["goal"], LATER)), frozen, "another task's brief");
    assert.match(refusal(() => markCoachingApplied(db, coaching.id, brief.id, ["goal"], LATER)), frozen, "the version it read is no change");
    const v3 = nextBrief(db, taskId, v2);
    assert.match(refusal(() => markCoachingApplied(db, coaching.id, v3.id, ["goal"], LATER)), frozen, "a version made from a later one");
    assert.equal(markCoachingApplied(db, coaching.id, v2.id, ["goal", "context"], LATER), true);
    assert.equal(markCoachingApplied(db, coaching.id, v2.id, ["goal"], LATER), false, "once");
    assert.deepEqual(getCoaching(db, coaching.id)!.applied, { briefId: v2.id, fields: ["goal", "context"], at: LATER });
    assert.match(refusal(() => db.db.prepare("UPDATE coachings SET applied_fields_json = '[]' WHERE id = ?").run(coaching.id)), frozen);
  });

  it("keeps neither the new version nor the record of it when anything fails between them", () => {
    const db = workspace();
    const { taskId, brief } = task(db);
    const coaching = coachingFor(taskId, brief);
    insertCoaching(db, coaching, LINK);
    settleCoaching(db, coaching.id, { status: "answered" }, REPORT, LATER);
    // A fault after the version is saved, and before it is recorded: the transaction keeps neither.
    assert.throws(() =>
      db.tx(() => {
        nextBrief(db, taskId, brief);
        throw new Error("fault between the save and its record");
      }),
    );
    assert.deepEqual([versionsOf(db, taskId).length, getCoaching(db, coaching.id)!.applied], [1, null]);
    // A fault after both: neither is kept either.
    assert.throws(() =>
      db.tx(() => {
        const v2 = nextBrief(db, taskId, brief);
        assert.equal(markCoachingApplied(db, coaching.id, v2.id, ["goal"], LATER), true);
        throw new Error("fault after both");
      }),
    );
    assert.deepEqual([versionsOf(db, taskId).length, getCoaching(db, coaching.id)!.applied], [1, null]);
    db.tx(() => {
      const v2 = nextBrief(db, taskId, brief);
      assert.equal(markCoachingApplied(db, coaching.id, v2.id, ["goal"], LATER), true);
    });
    assert.deepEqual([versionsOf(db, taskId).length, getCoaching(db, coaching.id)!.applied?.fields], [2, ["goal"]]);
  });

  it("lists a task's coachings newest first, finds open ones by task, project or all, and goes with its task", () => {
    const db = workspace();
    const projectId = randomUUID();
    const { taskId, brief } = task(db, projectId);
    const other = task(db);
    const first = coachingFor(taskId, brief, projectId);
    insertCoaching(db, first, LINK);
    settleCoaching(db, first.id, { status: "cancelled" }, null, LATER);
    const second = { ...coachingFor(taskId, brief, projectId), createdAt: LATER };
    insertCoaching(db, second, LINK);
    const elsewhere = coachingFor(other.taskId, other.brief);
    insertCoaching(db, elsewhere, LINK);
    assert.deepEqual(
      coachingsOf(db, taskId).map((one) => one.id),
      [second.id, first.id],
    );
    assert.deepEqual(
      openCoachings(db, { projectId }).map((one) => one.id),
      [second.id],
    );
    assert.deepEqual(
      openCoachings(db).map((one) => one.id),
      [second.id, elsewhere.id],
    );
    assert.equal(getCoachLink(db, first.id)?.status, "cancelled");
    assert.equal(deleteTask(db, taskId), true);
    assert.deepEqual([getCoaching(db, first.id), getCoaching(db, second.id), getCoachLink(db, second.id)], [null, null, null]);
    assert.equal(getCoaching(db, elsewhere.id)?.taskId, other.taskId, "another task's coaching stays");
  });

  it("deletes a task whose coaching saved changes, with that coaching and the version it made", () => {
    const db = workspace();
    const { taskId, brief } = task(db);
    const coaching = coachingFor(taskId, brief);
    insertCoaching(db, coaching, LINK);
    settleCoaching(db, coaching.id, { status: "answered" }, REPORT, LATER);
    db.tx(() => {
      const v2 = nextBrief(db, taskId, brief);
      markCoachingApplied(db, coaching.id, v2.id, ["goal"], LATER);
    });
    assert.equal(deleteTask(db, taskId), true);
    assert.deepEqual([getCoaching(db, coaching.id), versionsOf(db, taskId).length], [null, 0]);
  });
});
