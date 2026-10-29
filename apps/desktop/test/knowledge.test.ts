import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KnowledgeScope } from "@nivra/domain";
import { knowledgeReferencesCurrent, knowledgeSnapshotFor, resolveCompanionScope, validateKnowledgeForScope } from "../src/main/companion-context.ts";
import type { ProjectRecord } from "../src/main/host-store.ts";
import { editKnowledge, forgetKnowledge, getKnowledge, invalidateKnowledgeSources, knowledgeEpoch, listKnowledge, saveKnowledge, validateKnowledgeQuote, type KnowledgeWrite, type NewKnowledge } from "../src/main/knowledge-store.ts";
import { addMissionTask, insertMission } from "../src/main/mission-store.ts";
import { decide, deleteTask, insertAttempt, insertTask, recordOutcome, updateTask, versionsOf } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";
import { BRIEFS } from "./fixtures/briefs.ts";

const AT = "2026-10-29T10:00:00.000Z";
const roots: string[] = [];
const opened: WorkspaceDb[] = [];
after(() => {
  for (const db of opened) db.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function workspace(): WorkspaceDb {
  const root = mkdtempSync(join(tmpdir(), "nivra-knowledge-"));
  roots.push(root);
  const result = openWorkspace(join(root, "workspace.db"));
  assert.equal(result.state, "ready");
  if (result.state !== "ready") throw new Error("The fixture workspace couldn't be opened.");
  opened.push(result.db);
  return result.db;
}
const project = (id = randomUUID(), sharing = true): ProjectRecord => ({ id, targetId: "local", nativePath: "/synthetic", label: "Synthetic", addedAt: AT, sharing: { modelContext: sharing, cloudExecution: false } });
const options = (db: WorkspaceDb, operationId = randomUUID()): KnowledgeWrite => ({ operationId, expectedEpoch: knowledgeEpoch(db), known: [], at: AT });
const note = (scope: KnowledgeScope, projectId: string | null = scope.kind === "project" ? scope.id : null): NewKnowledge => ({ scope, projectId, kind: "constraint", statement: "This app must work offline.", origin: "user-stated", source: { kind: "user", sessionId: "session", requestId: randomUUID() } });
function task(db: WorkspaceDb, projectId: string | null = null): string {
  const id = randomUUID();
  insertTask(db, { id, title: "A draft task", projectId, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: BRIEFS.vague, derivedFrom: null });
  return id;
}
function mission(db: WorkspaceDb): string {
  const id = randomUUID();
  insertMission(db, { id, conversationId: randomUUID(), createdAt: AT }, { id: randomUUID(), content: { name: "A saved idea", outcome: "An offline app", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] } });
  return id;
}

describe("structured companion knowledge", () => {
  it("keeps only selected scoped outcomes after restart, with idempotent saves", () => {
    const db = workspace();
    const scope: KnowledgeScope = { kind: "mission", id: mission(db) };
    const input = note(scope);
    const write = options(db);
    const saved = saveKnowledge(db, input, write);
    const again = saveKnowledge(db, input, write);
    assert.equal(again.id, saved.id);
    assert.equal(listKnowledge(db, scope).length, 1);
    db.checkpoint();
    const path = db.path;
    db.close();
    const result = openWorkspace(path);
    assert.equal(result.state, "ready");
    if (result.state !== "ready") throw new Error("The fixture workspace couldn't be reopened.");
    opened.push(result.db);
    assert.equal(getKnowledge(result.db, saved.id)?.statement, input.statement);
    assert.equal(result.db.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.["n"], 0);
    assert.equal(result.db.db.prepare("SELECT COUNT(*) AS n FROM run_links").get()?.["n"], 0);
  });

  it("edits with revisions, forgets statement content, and stale replay never resurrects it", () => {
    const db = workspace();
    const input = note({ kind: "task", id: task(db) });
    const original = options(db);
    const saved = saveKnowledge(db, input, original);
    const before = knowledgeEpoch(db);
    const edited = editKnowledge(db, saved.id, saved.revision, "This app must work offline on phones.", options(db));
    assert.equal(edited.revision, 2);
    assert.equal(knowledgeEpoch(db), before + 1);
    assert.equal(knowledgeReferencesCurrent(db, [saved]), false);
    assert.throws(() => editKnowledge(db, saved.id, saved.revision, "Stale", options(db)), /changed/);
    const forgotten = forgetKnowledge(db, saved.id, edited.revision, options(db));
    assert.equal(forgotten.statement, null);
    assert.equal(listKnowledge(db, input.scope).length, 0);
    assert.equal(saveKnowledge(db, input, original).state, "forgotten");
    assert.equal(listKnowledge(db, input.scope).length, 0);
    db.checkpoint();
    const bytes = readFileSync(db.path);
    assert.equal(bytes.includes(Buffer.from("This app must work offline")), false, "old wording is removed from the checkpointed database");
  });

  it("refuses stale epochs, credential-shaped or saved-key text, fake observations and changed idempotency requests", () => {
    const db = workspace();
    const input = note({ kind: "mission", id: mission(db) });
    const write = options(db);
    saveKnowledge(db, input, write);
    assert.throws(() => saveKnowledge(db, { ...input, statement: "A different decision" }, write), /already used/);
    assert.throws(() => saveKnowledge(db, input, { ...write, operationId: randomUUID() }), /changed/);
    assert.throws(() => saveKnowledge(db, { ...input, statement: "Keep secret-value-0123456789" }, { ...options(db), known: [["NEBIUS_API_KEY", "secret-value-0123456789"]] }), /saved Token Factory key/);
    assert.throws(() => saveKnowledge(db, { ...input, statement: `Use ghp_${"x".repeat(36)}` }, options(db)), /GitHub token/);
    assert.throws(() => saveKnowledge(db, { ...input, kind: "observation", origin: "validated-observation" }, options(db)), /checked source evidence/);
  });

  it("requires exact complete user wording, preserving negation", () => {
    const message = "Do not use a network. This app must work offline.";
    assert.equal(validateKnowledgeQuote(message, { start: 0, end: 21, text: "Do not use a network." }, []), "Do not use a network.");
    const start = message.indexOf("This");
    assert.equal(validateKnowledgeQuote(message, { start, end: message.length, text: message.slice(start) }, []), "This app must work offline.");
    assert.throws(() => validateKnowledgeQuote(message, { start: 7, end: 21, text: "use a network." }, []), /part of a statement/);
    assert.throws(() => validateKnowledgeQuote(message, { start: 0, end: message.length, text: "The app is offline." }, []), /exactly/);
  });
});

describe("companion current context and retrieval", () => {
  it("binds the latest attempt and pending decision using metadata, without copying result or revision-note content", () => {
    const db = workspace();
    const taskId = task(db);
    const initial = resolveCompanionScope(db, [], { kind: "task", id: taskId });
    const id = randomUUID();
    insertAttempt(db, { id, taskId, briefId: versionsOf(db, taskId).at(-1)!.id, sessionId: "session", targetId: "local", status: "answered", createdAt: AT });
    recordOutcome(db, id, { outcome: "verified", verified: true, proposalHash: "a".repeat(64), baseline: "b".repeat(40) }, AT);
    const waiting = resolveCompanionScope(db, [], { kind: "task", id: taskId });
    assert.equal(waiting.latestAttempt?.pendingDecision, "proposal-review");
    assert.notEqual(waiting.binding, initial.binding);
    const marker = `private-revision-note-${randomUUID()}`;
    decide(db, id, { kind: "revision", note: marker }, AT);
    const revised = resolveCompanionScope(db, [], { kind: "task", id: taskId });
    assert.equal(revised.latestAttempt?.decision, "revision");
    assert.equal(JSON.stringify(revised.latestAttempt).includes(marker), false);
    assert.notEqual(revised.binding, waiting.binding);
  });
  it("uses the task's project, limits exact scope and never imports sibling mission projects", () => {
    const db = workspace();
    const a = project();
    const b = project();
    const taskA = task(db, a.id);
    const taskB = task(db, b.id);
    const missionId = mission(db);
    addMissionTask(db, missionId, taskA, AT);
    addMissionTask(db, missionId, taskB, AT);
    const aNote = saveKnowledge(db, note({ kind: "project", id: a.id }), options(db));
    saveKnowledge(db, { ...note({ kind: "project", id: b.id }), statement: "Only project B may see this." }, options(db));
    const taskNote = saveKnowledge(db, note({ kind: "task", id: taskA }, a.id), options(db));
    const missionNote = saveKnowledge(db, note({ kind: "mission", id: missionId }), options(db));
    const resolved = resolveCompanionScope(db, [a, b], { kind: "task", id: taskA });
    assert.equal(resolved.projectId, a.id);
    const packet = knowledgeSnapshotFor(db, [a, b], resolved, { includeMission: true });
    assert.deepEqual(packet.records.map((one) => one.id).sort(), [aNote.id, taskNote.id, missionNote.id].sort());
    const general = resolveCompanionScope(db, [a, b], { kind: "general" });
    assert.equal(knowledgeSnapshotFor(db, [a, b], general).records.length, 0);
    const missionOnly = resolveCompanionScope(db, [a, b], { kind: "mission", id: missionId });
    assert.deepEqual(knowledgeSnapshotFor(db, [a, b], missionOnly).records.map((one) => one.id), [missionNote.id]);
    assert.throws(() => validateKnowledgeForScope(note({ kind: "project", id: b.id }), resolved), /scope/);
  });

  it("withholds project records when sharing is off and invalidates records when a task moves or source changes", () => {
    const db = workspace();
    const a = project();
    const b = project();
    const taskId = task(db, a.id);
    const saved = saveKnowledge(db, note({ kind: "task", id: taskId }, a.id), options(db));
    const off = { ...a, sharing: { ...a.sharing, modelContext: false } };
    const resolved = resolveCompanionScope(db, [off, b], { kind: "task", id: taskId });
    assert.equal(knowledgeSnapshotFor(db, [off, b], resolved).records.length, 0);
    assert.equal(knowledgeSnapshotFor(db, [off, b], resolved, { forModel: false }).records.length, 1);
    updateTask(db, taskId, 1, { projectId: b.id }, AT);
    const moved = resolveCompanionScope(db, [a, b], { kind: "task", id: taskId });
    assert.equal(knowledgeSnapshotFor(db, [a, b], moved).records.length, 0);
    assert.equal(getKnowledge(db, saved.id)?.state, "stale");
    const observed = saveKnowledge(db, { ...note({ kind: "project", id: b.id }), kind: "observation", origin: "validated-observation", statement: "The manifest declares pnpm.", source: { kind: "repository", projectId: b.id, path: "package.json", revision: "commit-one" } }, options(db));
    const bContext = resolveCompanionScope(db, [a, b], { kind: "project", id: b.id });
    assert.equal(knowledgeSnapshotFor(db, [a, b], bContext).records.length, 0, "unchecked evidence is withheld");
    assert.equal(knowledgeSnapshotFor(db, [a, b], bContext, { repositoryRevisions: new Map([[b.id, "commit-one"]]) }).records.length, 1);
    knowledgeSnapshotFor(db, [a, b], bContext, { repositoryRevisions: new Map([[b.id, "commit-two"]]) });
    assert.equal(getKnowledge(db, observed.id)?.state, "stale");
    deleteTask(db, taskId);
    assert.throws(() => resolveCompanionScope(db, [a, b], { kind: "task", id: taskId }), /no longer here/);
    assert.throws(() => resolveCompanionScope(db, [b], { kind: "project", id: a.id }), /removed/);
  });

  it("bounds shared retrieval and invalidation advances the epoch once", () => {
    const db = workspace();
    const a = project();
    const scope: KnowledgeScope = { kind: "project", id: a.id };
    for (let i = 0; i < 15; i++) saveKnowledge(db, { ...note(scope), statement: `Decision ${i}` }, options(db));
    const resolved = resolveCompanionScope(db, [a], scope);
    assert.equal(knowledgeSnapshotFor(db, [a], resolved).records.length, 12);
    const before = knowledgeEpoch(db);
    assert.equal(invalidateKnowledgeSources(db, () => false, AT), 15);
    assert.equal(knowledgeEpoch(db), before + 1);
    assert.equal(knowledgeSnapshotFor(db, [a], resolved).records.length, 0);
  });
});
