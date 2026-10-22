import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getResearch, insertResearch, recordAmendedPlan, researchOf, settleResearch, stopResearch, withdrawStop, type ResearchRecord } from "../src/main/research-store.ts";
import { deleteConversation, getTurn, insertArtifact, insertConversation, insertTurn, openTurns, turnsOf, type ConversationRecord } from "../src/main/workspace.ts";
import { openWorkspace, WORKSPACE_MIGRATIONS, type WorkspaceDb, type WorkspaceOpening } from "../src/main/workspace-db.ts";

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => {
  for (const db of open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A workspace at the current schema, research's table among it (D37). */
function workspace(): WorkspaceDb {
  const dir = mkdtempSync(join(tmpdir(), "nivra research ü "));
  dirs.push(dir);
  const opening = openWorkspace(join(dir, "workspace.db"));
  assert.equal(opening.state, "ready", opening.state === "unavailable" ? opening.reason : "");
  const ready = opening as Extract<WorkspaceOpening, { state: "ready" }>;
  open.push(ready.db);
  assert.equal(ready.schemaVersion, WORKSPACE_MIGRATIONS.length);
  return ready.db;
}

const AT = "2026-10-22T10:00:00.000Z";
const LATER = "2026-10-22T10:05:00.000Z";
const LINK = { sessionId: "s", targetId: "wsl:Ubuntu" };
const project = (): ConversationRecord => ({ id: randomUUID(), kind: "project", projectId: randomUUID(), projectLabel: "shop", targetId: "wsl:Ubuntu", title: "New conversation", createdAt: AT, updatedAt: AT });
const general = (): ConversationRecord => ({ id: randomUUID(), kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "New conversation", createdAt: AT, updatedAt: AT });
const planIn = (db: WorkspaceDb, conversationId: string, text: string, lineageId: string = randomUUID(), derivedFrom: string | null = null, after?: number) =>
  insertArtifact(db, { id: randomUUID(), kind: "plan", lineageId, content: { text }, conversationId, taskId: null, messageId: null, runLinkId: null, derivedFrom, createdAt: AT }, after)!;
const QUERIES: ResearchRecord["queries"] = [{ assumption: "A1", text: "distutils is still in Python 3.12's standard library", query: "Python 3.12 distutils removed standard library" }];
const researchFor = (conversation: ConversationRecord, plan: { id: string; lineageId: string; version: number; sha256: string }, id: string = randomUUID()) => ({
  id,
  conversationId: conversation.id,
  planId: plan.id,
  planLineage: plan.lineageId,
  planVersion: plan.version,
  planSha256: plan.sha256,
  packetDigest: "a".repeat(64),
  queries: QUERIES,
  sites: { mode: "prefer" as const, hosts: ["docs.python.org", "peps.python.org"] },
  scope: conversation.projectId ? { kind: "project" as const, projectId: conversation.projectId, projectLabel: conversation.projectLabel, headAtStart: "c".repeat(40) } : { kind: "general" as const },
  createdAt: AT,
});
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

describe("research of plan versions (NIV-45)", () => {
  it("binds research to a research run and a plan version of its own conversation, one open run at a time", () => {
    const db = workspace();
    const conversation = project();
    const other = general();
    insertConversation(db, conversation);
    insertConversation(db, other);
    const v1 = planIn(db, conversation.id, "Move the build image to Python 3.12.");
    const v2 = planIn(db, conversation.id, "Move it, and replace distutils.", v1.lineageId, v1.id, 1);
    const elsewhere = planIn(db, other.id, "Another conversation's plan.");
    const research = researchFor(conversation, v1);
    assert.equal(insertResearch(db, research, LINK), true);
    assert.equal(insertResearch(db, researchFor(conversation, v2), LINK), false, "one open run per conversation");
    assert.equal(insertTurn(db, { id: randomUUID(), conversationId: conversation.id, sessionId: "s", targetId: "wsl:Ubuntu", preferences: [], history: null, createdAt: AT }, { id: randomUUID(), text: "Meanwhile?" }), false, "research holds the conversation as a turn does");
    // Every stop path sees it; the conversation's turns, and so its history, don't.
    assert.deepEqual([openTurns(db, { conversationId: conversation.id }).map((turn) => [turn.id, turn.workflowId]), turnsOf(db, conversation.id).length], [[[research.id, "research"]], 0]);
    assert.deepEqual(openTurns(db, { projectId: conversation.projectId! }).map((turn) => turn.id), [research.id]);
    const stored = getResearch(db, research.id);
    assert.deepEqual(
      [stored?.planVersion, stored?.planSha256, stored?.queries, stored?.sites, stored?.scope, stored?.stop, stored?.amendedPlanId, stored?.report, stored?.link.status, stored?.link.preferences],
      [1, v1.sha256, QUERIES, research.sites, { kind: "project", projectId: conversation.projectId, projectLabel: "shop", headAtStart: "c".repeat(40) }, null, null, null, "submitting", []],
    );

    // A turn open first holds the conversation too.
    const chat = general();
    insertConversation(db, chat);
    assert.equal(insertTurn(db, { id: randomUUID(), conversationId: chat.id, sessionId: "s", targetId: "local", preferences: [], history: null, createdAt: AT }, { id: randomUUID(), text: "First?" }), true);
    assert.equal(insertResearch(db, researchFor(chat, planIn(db, chat.id, "A plan.")), LINK), false);

    // What the triggers refuse, written past the functions.
    const sqlite = db.db;
    const link = (id: string, workflow: string, conversationId = conversation.id) =>
      sqlite.prepare("INSERT INTO run_links (id, conversation_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, 's', ?, 'local', 'failed', '[]', ?)").run(id, conversationId, workflow, AT);
    const row = (values: ReturnType<typeof researchFor>, extra: Record<string, string> = {}) =>
      sqlite
        .prepare(
          `INSERT INTO research (id, conversation_id, plan_id, plan_lineage, plan_version, plan_sha256, packet_digest, queries_json, scope_kind, project_id, created_at${Object.keys(extra).map((column) => `, ${column}`).join("")}) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?${", ?".repeat(Object.keys(extra).length)})`,
        )
        .run(
          values.id,
          values.conversationId,
          values.planId,
          values.planLineage,
          values.planVersion,
          values.planSha256,
          values.packetDigest,
          values.scope.kind,
          values.scope.kind === "project" ? values.scope.projectId : null,
          values.createdAt,
          ...Object.values(extra),
        );
    const BOUND = /research is bound to a research run and to a plan version of its own conversation/;
    const review = randomUUID();
    link(review, "review");
    assert.match(refusal(() => row(researchFor(conversation, v1, review))), BOUND, "a review's run");
    const otherLink = randomUUID();
    link(otherLink, "research", other.id);
    assert.match(refusal(() => row(researchFor(conversation, v1, otherLink))), BOUND, "another conversation's run");
    const free = () => {
      const id = randomUUID();
      link(id, "research");
      return id;
    };
    assert.match(refusal(() => row({ ...researchFor(conversation, v1, free()), planId: elsewhere.id, planLineage: elsewhere.lineageId, planSha256: elsewhere.sha256 })), BOUND, "another conversation's plan");
    assert.match(refusal(() => row({ ...researchFor(conversation, v1, free()), planVersion: 2 })), BOUND, "a version that isn't the plan's");
    assert.match(refusal(() => row({ ...researchFor(conversation, v1, free()), planSha256: "f".repeat(64) })), BOUND, "a fingerprint that isn't the plan's");
    // A new row has no stop, amended plan or report, each written whole so the trigger, not a CHECK, refuses it.
    const extras: Array<Record<string, string>> = [{ stop_cause: "person", stop_token: "T0" }, { amended_plan_id: v2.id }, { report_json: "{}", reported_at: AT }];
    for (const extra of extras)
      assert.match(refusal(() => row(researchFor(conversation, v1, free()), extra)), BOUND, Object.keys(extra).join(", "));
    assert.equal(refusal(() => row(researchFor(conversation, v1, free()))), "not refused", "the same row, bound as it should be");

    // What it was bound to never changes.
    const FROZEN = /research never changes what it was bound to/;
    for (const [column, value] of [
      ["id", randomUUID()],
      ["conversation_id", other.id],
      ["plan_id", v2.id],
      ["plan_lineage", randomUUID()],
      ["plan_version", 2],
      ["plan_sha256", v2.sha256],
      ["packet_digest", "b".repeat(64)],
      ["queries_json", "[]"],
      ["sites_json", null],
      ["scope_kind", "general"],
      ["project_id", randomUUID()],
      ["project_label", "renamed"],
      ["head_at_start", "d".repeat(40)],
      ["created_at", LATER],
    ] as const)
      assert.match(refusal(() => sqlite.prepare(`UPDATE research SET ${column} = ? WHERE id = ?`).run(value, research.id)), FROZEN, column);
    assert.deepEqual(getResearch(db, research.id)?.queries, QUERIES);
  });

  it("records the newest stop with its token, and withdraws a failed stop only while its token is still the one on record", () => {
    const db = workspace();
    const conversation = project();
    insertConversation(db, conversation);
    const plan = planIn(db, conversation.id, "Move the build image to Python 3.12.");
    const research = researchFor(conversation, plan);
    insertResearch(db, research, LINK);
    const state = () => {
      const stored = getResearch(db, research.id)!;
      return [stored.stop, stored.link.cancelRequested, stored.link.cancelReason];
    };

    const first = stopResearch(db, research.id, "person");
    assert.ok(first);
    assert.deepEqual(state(), [{ cause: "person", token: first }, true, "person"]);
    // A later stop replaces the cause and the token: the newest is the one on record and the one the card names.
    const second = stopResearch(db, research.id, "web-research");
    assert.ok(second && second !== first, "each stop gets a token of its own");
    assert.deepEqual(state(), [{ cause: "web-research", token: second }, true, "sharing"]);
    // The first stop failed: its withdrawal no longer matches, and the newer stop stays whole.
    assert.equal(withdrawStop(db, research.id, first), false);
    assert.deepEqual(state(), [{ cause: "web-research", token: second }, true, "sharing"]);
    // The newer one failed too: withdrawn, every field together.
    assert.equal(withdrawStop(db, research.id, second), true);
    assert.deepEqual(state(), [null, false, null]);
    assert.equal(withdrawStop(db, research.id, second), false, "withdrawn once");

    // A cause without its token, or one the table doesn't know, is refused.
    assert.notEqual(refusal(() => db.db.prepare("UPDATE research SET stop_cause = 'person' WHERE id = ?").run(research.id)), "not refused");
    assert.notEqual(refusal(() => db.db.prepare("UPDATE research SET stop_cause = 'sharing', stop_token = 'T9' WHERE id = ?").run(research.id)), "not refused");

    // Once the run has ended, a stop changes nothing, and the stop that ended it stays on record, even written directly.
    const third = stopResearch(db, research.id, "model-sharing");
    assert.equal(settleResearch(db, research.id, { status: "cancelled" }, undefined, LATER), true, "a settle with no report given");
    assert.equal(stopResearch(db, research.id, "person"), null);
    assert.equal(withdrawStop(db, research.id, third!), false);
    assert.deepEqual(state(), [{ cause: "model-sharing", token: third }, true, "sharing"]);
    assert.match(refusal(() => db.db.prepare("UPDATE research SET stop_cause = NULL, stop_token = NULL WHERE id = ?").run(research.id)), /changes its stop only while it runs/);
    assert.equal(getResearch(db, research.id)?.link.status, "cancelled");

    // A conversation's turn is never stopped or withdrawn through research.
    const chat = general();
    insertConversation(db, chat);
    const turn = randomUUID();
    insertTurn(db, { id: turn, conversationId: chat.id, sessionId: "s", targetId: "local", preferences: [], history: null, createdAt: AT }, { id: randomUUID(), text: "Still there?" });
    assert.equal(stopResearch(db, turn, "person"), null);
    assert.deepEqual([getTurn(db, turn)?.cancelRequested, getTurn(db, turn)?.cancelReason], [false, null]);
  });

  it("keeps the first outcome and report, and records one amended plan derived from the researched version", () => {
    const db = workspace();
    const conversation = general();
    insertConversation(db, conversation);
    const v1 = planIn(db, conversation.id, "Move the build image to Python 3.12.");
    const research = researchFor(conversation, v1);
    insertResearch(db, research, LINK);
    const v2 = planIn(db, conversation.id, "Move it, and replace distutils.", v1.lineageId, v1.id, 1);
    assert.equal(recordAmendedPlan(db, research.id, v2.id), false, "no report yet");
    // Written past the function, an amended plan still needs a report, and a version derived from the researched one.
    const AMENDED = /keeps its first report and its amended plan/;
    assert.match(refusal(() => db.db.prepare("UPDATE research SET amended_plan_id = ? WHERE id = ?").run(v2.id, research.id)), AMENDED);

    const report = { outcome: "complete", planVersion: 1, assessments: [{ assumption: "A1", shown: "contradicted" }] };
    assert.equal(settleResearch(db, research.id, { status: "answered" }, report, LATER), true);
    assert.equal(settleResearch(db, research.id, { status: "failed", errorKind: "internal" }, { outcome: "failed" }, LATER), false, "settled once");
    const settled = getResearch(db, research.id)!;
    assert.deepEqual([settled.link.status, settled.link.settledAt, settled.report, settled.reportedAt], ["answered", LATER, report, LATER]);
    assert.match(refusal(() => db.db.prepare("UPDATE research SET report_json = '{}' WHERE id = ?").run(research.id)), /keeps its first report/);
    assert.match(refusal(() => db.db.prepare("UPDATE research SET amended_plan_id = 'not-a-plan' WHERE id = ?").run(research.id)), AMENDED);

    // Only a version of the same lineage, in the same conversation, derived from the researched one.
    const unrelated = planIn(db, conversation.id, "A plan of its own lineage.", randomUUID(), v1.id);
    const v3 = planIn(db, conversation.id, "Then pin setuptools.", v1.lineageId, v2.id, 2);
    for (const planId of [v1.id, unrelated.id, v3.id, randomUUID()]) assert.equal(recordAmendedPlan(db, research.id, planId), false, planId);
    assert.equal(recordAmendedPlan(db, research.id, v2.id), true);
    assert.equal(recordAmendedPlan(db, research.id, v2.id), false, "recorded once");
    assert.match(refusal(() => db.db.prepare("UPDATE research SET amended_plan_id = ? WHERE id = ?").run(v3.id, research.id)), /keeps its first report and its amended plan/);
    assert.deepEqual([getResearch(db, research.id)?.amendedPlanId, getResearch(db, research.id)?.report], [v2.id, report]);
  });

  it("lists a conversation's research oldest first, and goes with its conversation", () => {
    const db = workspace();
    const conversation = general();
    const other = general();
    insertConversation(db, conversation);
    insertConversation(db, other);
    const plan = planIn(db, conversation.id, "Move the build image to Python 3.12.");
    const first = researchFor(conversation, plan);
    insertResearch(db, first, LINK);
    settleResearch(db, first.id, { status: "failed", errorKind: "research-nothing-read" }, null, LATER);
    const second = researchFor(conversation, plan);
    insertResearch(db, second, LINK);
    const elsewhere = researchFor(other, planIn(db, other.id, "Another plan."));
    insertResearch(db, elsewhere, LINK);
    assert.deepEqual(researchOf(db, conversation.id).map((research) => [research.id, research.link.status, research.report]), [[first.id, "failed", null], [second.id, "submitting", null]]);

    assert.equal(deleteConversation(db, conversation.id), true);
    assert.deepEqual([researchOf(db, conversation.id).length, getResearch(db, second.id), getTurn(db, second.id)], [0, null, null]);
    assert.deepEqual(researchOf(db, other.id).map((research) => research.id), [elsewhere.id]);
  });
});
