import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { PlanningBrief, PlanningProposal, PlanningRequest, PlanningResult } from "@nivra/domain";
import { PlanningHost, type PlanningHostOptions } from "../src/main/planning-host.ts";
import type { ProjectRecord } from "../src/main/host-store.ts";
import { editKnowledge, forgetKnowledge, knowledgeEpoch, saveKnowledge } from "../src/main/knowledge-store.ts";
import { addMissionTask, insertMission, missionTaskIds } from "../src/main/mission-store.ts";
import { decide, deleteTask, getTask, insertAttempt, insertTask, listTasks, recordOutcome, settleAttempt, updateTask, versionsOf } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";
import { BRIEFS } from "./fixtures/briefs.ts";
import { TaskReferences } from "../src/main/task-references.ts";

const AT = "2026-10-29T14:00:00.000Z";
const roots: string[] = [];
const opened: WorkspaceDb[] = [];
after(() => { for (const db of opened) db.close(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function workspace(): WorkspaceDb {
  const root = mkdtempSync(join(tmpdir(), "nivra-planning-"));
  roots.push(root);
  const result = openWorkspace(join(root, "workspace.db"));
  assert.equal(result.state, "ready");
  if (result.state !== "ready") throw new Error("The fixture workspace couldn't open.");
  opened.push(result.db);
  return result.db;
}
const brief = (): PlanningBrief => ({ title: "An offline workout logger", outcome: "Record a workout and reopen it", intendedUsers: "One lifter", scope: "One local flow", exclusions: "Cloud sync", constraints: ["Works offline"], decisions: [], uncertainties: [], questions: [] });
const request = (): PlanningRequest => ({ brief: brief(), source: { kind: "manual" }, projectId: null, missionId: null });
const proposal = (): PlanningProposal => ({ summary: "A first record/reopen increment", challenges: [], decisions: ["Local storage first"], uncertainties: ["The storage API needs choosing"], questions: [], deferred: ["Sync"], inspection: "greenfield", inspectionScope: "Proposed design only", gaps: [], impacts: [{ id: "storage", area: "Workout history", effect: "Keeps recorded workouts across restart", relationship: "direct", evidence: "inferred", citations: [], validation: ["Record and reopen a workout"] }], items: [
  { id: "first", title: "Persist one workout", goal: "Save one recorded workout", scope: "One store", exclusions: "Sync", acceptanceCriteria: ["A saved workout can be reopened"], impactIds: ["storage"], prerequisites: [], overlapTaskIds: [], questions: ["Which local storage API fits this platform?"] },
  { id: "second", title: "Show the saved workout", goal: "Reopen the latest workout", scope: "One screen", exclusions: "Charts", acceptanceCriteria: ["Reopening the app shows the recorded workout"], impactIds: ["storage"], prerequisites: ["first"], overlapTaskIds: [], questions: [] },
] });
const result = (): PlanningResult => ({ proposal: proposal(), evidence: { baseline: null, files: [], searches: [], inventory: [] }, exploration: "Design only; no repository was inspected." });
const project = (): ProjectRecord => ({ id: randomUUID(), targetId: "local", nativePath: "/synthetic", label: "Synthetic", addedAt: AT, sharing: { modelContext: true, cloudExecution: false } });
function host(db: WorkspaceDb, options: Partial<PlanningHostOptions> = {}): PlanningHost {
  return new PlanningHost({ workspace: () => db, projects: () => [], sharingEpoch: () => 0, secrets: async () => [], ...options });
}
const task = (db: WorkspaceDb, projectId: string | null = null): string => {
  const id = randomUUID();
  insertTask(db, { id, title: "Existing task", projectId, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: BRIEFS.vague, derivedFrom: null });
  return id;
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function completed(service: PlanningHost, id: string, operationId: string) {
  for (let index = 0; index < 30; index++) {
    const operation = service.operation(id, operationId);
    if (operation.status !== "submitting" && operation.status !== "running") return operation;
    await tick();
  }
  throw new Error("The controlled fixture operation didn't finish.");
}

describe("reviewed native planning", () => {
  it("retains accepted frozen reference context and the resulting advice when discussion or files change", async () => {
    for (const change of ["none", "comment", "remove", "selection", "damage"] as const) {
      const db = workspace(), p = project(), sourceId = task(db, p.id), root = dirname(db.path);
      const references = new TaskReferences(db, join(root, "assets")); references.addComment(sourceId, "Original discussion", []);
      const path = join(root, "note.md"); writeFileSync(path, "Original file"); const asset = await references.importFile(sourceId, path, []);
      references.select(sourceId, { excludedCommentIds: [], attachmentIds: [asset.id] }); const frozen = references.freeze(sourceId, []);
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let stops = 0, acknowledgements = 0;
      const service = host(db, { projects: () => [p], references: (id) => references.freeze(id, []), generate: async ({ dispatched, started, assertCurrent }) => {
        dispatched(); started({ runId: randomUUID(), maxRequests: 3 }); await gate; assertCurrent(); return { ...result(), sourceManifest: frozen.manifest };
      }, cancelGeneration: async () => { stops++; }, acknowledge: async () => { acknowledgements++; } });
      const plan = await service.create({ ...request(), projectId: p.id, source: { kind: "task", id: sourceId, version: 1 } });
      const operation = await service.generate(plan.id, plan.revision, { inspectRepository: true, operationId: randomUUID() });
      assert.equal(service.operation(plan.id, operation.id).status, "running");
      if (change === "comment") references.addComment(sourceId, "Added while the accepted request is running", []);
      if (change === "remove") references.remove(sourceId, asset.id);
      if (change === "selection") references.select(sourceId, { excludedCommentIds: [], attachmentIds: [] });
      if (change === "damage") writeFileSync(join(references.root, p.id, sourceId, asset.id, "prepared.txt"), "Damaged after acceptance");
      release(); assert.equal((await completed(service, plan.id, operation.id)).status, "succeeded", change);
      const retained = service.get(plan.id); assert.equal(retained.proposal?.summary, result().proposal.summary);
      assert.deepEqual(retained.sourceManifest, frozen.manifest); assert.equal(stops, 0); assert.equal(acknowledgements, 1);
      assert.equal(frozen.attachments[0]!.text, "Original file");
      if (change === "none") assert.equal(retained.stale, null);
      else {
        assert.notEqual(retained.stale, null, change);
        await assert.rejects(service.save({ id: plan.id, revision: retained.revision, key: randomUUID(), itemIds: ["first"] }), /changed|damaged/);
      }
    }
  });
  it("still refuses changed reference context before dispatch and cancels accepted work on revoked sharing or explicit cancellation", async () => {
    for (const cause of ["before-dispatch", "sharing", "cancel"] as const) {
      const db = workspace(); let p = project(), epoch = 0; const sourceId = task(db, p.id), references = new TaskReferences(db, join(dirname(db.path), "assets"));
      references.addComment(sourceId, "Original discussion", []);
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let sends = 0;
      const service = host(db, { projects: () => [p], sharingEpoch: () => epoch, references: (id) => references.freeze(id, []), generate: async ({ dispatched, started, assertCurrent }) => {
        if (cause === "before-dispatch") await gate;
        dispatched(); sends++; started({ runId: randomUUID(), maxRequests: 1 });
        if (cause !== "before-dispatch") await gate;
        assertCurrent(); return result();
      }, cancelGeneration: async () => undefined });
      const plan = await service.create({ ...request(), projectId: p.id, source: { kind: "task", id: sourceId, version: 1 } });
      const operation = await service.generate(plan.id, plan.revision, { inspectRepository: false, operationId: randomUUID() });
      references.addComment(sourceId, "New supporting context", []);
      if (cause === "sharing") { p = { ...p, sharing: { ...p.sharing, modelContext: false } }; epoch++; await service.invalidateProject(p.id); }
      if (cause === "cancel") await service.cancel(plan.id, operation.id);
      release(); assert.equal((await completed(service, plan.id, operation.id)).status, cause === "before-dispatch" ? "failed" : "cancelled");
      assert.equal(sends, cause === "before-dispatch" ? 0 : 1); assert.equal(service.get(plan.id).proposal, null);
    }
  });
  it("binds both selected mission and project knowledge and rejects pending results after either note is edited or forgotten", async () => {
    for (const scope of ["mission", "project"] as const) for (const change of ["edit", "forget"] as const) {
      const db = workspace(); const p = project(); const missionId = randomUUID();
      insertMission(db, { id: missionId, conversationId: randomUUID(), createdAt: AT }, { id: randomUUID(), content: { name: "Offline logger", outcome: "Record and reopen", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] } });
      const notes = ["mission", "project"].map((kind) => saveKnowledge(db, { scope: { kind: kind as "mission" | "project", id: kind === "mission" ? missionId : p.id }, projectId: kind === "mission" ? null : p.id, kind: "constraint", statement: kind === "mission" ? "The mission works offline." : "The project keeps local records.", origin: "user-stated", source: { kind: "user", sessionId: "fixture", requestId: randomUUID() } }, { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(db), known: [], at: AT }));
      const note = notes[scope === "mission" ? 0 : 1]!;
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      const service = host(db, { projects: () => [p], generate: async ({ assertCurrent }) => { await gate; assertCurrent(); return result(); } });
      const plan = await service.create({ ...request(), projectId: p.id, missionId, source: { kind: "mission", id: missionId, version: 1 } });
      const operation = await service.generate(plan.id, plan.revision, { inspectRepository: true, operationId: randomUUID() });
      const options = { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(db), known: [], at: AT };
      if (change === "edit") editKnowledge(db, note.id, note.revision, "The retained constraint changed.", options);
      else forgetKnowledge(db, note.id, note.revision, options);
      const stale = service.get(plan.id).stale; release();
      assert.equal((await completed(service, plan.id, operation.id)).status, "failed", `${scope} ${change} must reject a late proposal`);
      assert.match(stale ?? "", /changed/);
      assert.equal(service.get(plan.id).revision, plan.revision);
    }
  });
  it("accepts citations across consecutive reads but rejects gaps and changed source identities", async () => {
    for (const observation of ["consecutive", "overlapping", "gap", "hash", "revision"] as const) {
      const db = workspace(); const p = project(); const generated = result();
      const first = { path: "src/store.ts", startLine: 1, endLine: 2, sha256: "a".repeat(64), revision: "b".repeat(40) };
      const second = { ...first, startLine: observation === "overlapping" ? 2 : observation === "gap" ? 4 : 3, endLine: 4, ...(observation === "hash" ? { sha256: "c".repeat(64) } : {}), ...(observation === "revision" ? { revision: "d".repeat(40) } : {}) };
      generated.evidence = { baseline: first.revision, files: [first, second], searches: [], inventory: [] };
      generated.proposal.inspection = "assessed";
      generated.proposal.impacts[0]!.evidence = "repository";
      generated.proposal.impacts[0]!.citations = [{ ...first, startLine: 2, endLine: 3 }];
      const service = host(db, { projects: () => [p], generate: async () => generated, checkEvidence: async () => undefined });
      const plan = await service.create({ ...request(), projectId: p.id });
      const op = await service.generate(plan.id, plan.revision, { inspectRepository: true, operationId: randomUUID() });
      const succeeded = observation === "consecutive" || observation === "overlapping";
      assert.equal((await completed(service, plan.id, op.id)).status, succeeded ? "succeeded" : "failed", observation);
      if (succeeded) {
        const reviewed = service.get(plan.id);
        const saved = await service.save({ id: plan.id, revision: reviewed.revision, key: randomUUID(), itemIds: ["first"] });
        assert.equal(saved.length, 1);
      } else assert.equal(listTasks(db).length, 0);
    }
  });
  it("saves a reduced answer-only proposal without reconnecting an engine when no repository evidence was observed", async () => {
    const db = workspace(); const p = project(); let evidenceChecks = 0;
    const service = host(db, { projects: () => [p], generate: async () => { const answer = result(); answer.proposal.inspection = "not-assessed"; return answer; }, checkEvidence: async () => { evidenceChecks++; throw new Error("The target is offline"); } });
    const plan = await service.create({ ...request(), projectId: p.id });
    const operation = await service.generate(plan.id, plan.revision, { inspectRepository: true, operationId: randomUUID() });
    assert.equal((await completed(service, plan.id, operation.id)).status, "succeeded");
    const reviewed = service.get(plan.id);
    const saved = await service.save({ id: plan.id, revision: reviewed.revision, key: randomUUID(), itemIds: ["first"] });
    assert.equal(saved.length, 1); assert.equal(evidenceChecks, 0);
  });
  it("saves only the edited selection as drafts, retaining unresolved choices, provenance and missing prerequisites", async () => {
    const db = workspace(); const service = host(db);
    const original = await service.create(request());
    const edited = proposal(); edited.items[1]!.title = "Reopen a recorded workout";
    const reviewed = await service.revise(original.id, original.revision, { brief: original.request.brief, proposal: edited });
    const input = { id: reviewed.id, revision: reviewed.revision, key: randomUUID(), itemIds: ["second"] };
    const saved = await service.save(input);
    assert.equal(saved.length, 1);
    assert.equal(getTask(db, saved[0]!.taskId)?.title, "Reopen a recorded workout");
    assert.equal(getTask(db, saved[0]!.taskId)?.state, "draft");
    assert.deepEqual(saved[0]!.missingPrerequisites, ["first"]);
    const content = versionsOf(db, saved[0]!.taskId)[0]!.content as { checks: unknown[]; acceptanceCases: unknown[]; acceptanceCriteria: string[] };
    assert.equal(content.checks.length, 0); assert.equal(content.acceptanceCases.length, 0);
    assert.equal(content.acceptanceCriteria[0], edited.items[1]!.acceptanceCriteria[0]);
    assert.equal(service.sourcesOf(saved[0]!.taskId)[0]?.planningId, reviewed.id);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.["n"], 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM run_links").get()?.["n"], 0);
  });
  it("deduplicates concurrent saves, rejects changed payload keys and never recreates deleted results", async () => {
    const db = workspace(); const service = host(db);
    const initial = await service.create(request());
    const plan = await service.revise(initial.id, 1, { brief: brief(), proposal: proposal() });
    const input = { id: plan.id, revision: plan.revision, key: randomUUID(), itemIds: ["first"] };
    const both = await Promise.all([service.save(input), service.save(input)]);
    assert.equal(listTasks(db).length, 1);
    assert.equal(both[0][0]!.taskId, both[1][0]!.taskId);
    await assert.rejects(service.save({ ...input, itemIds: ["second"] }), /different work/);
    await assert.rejects(service.save({ ...input, key: randomUUID() }), /already saved/);
    deleteTask(db, both[0][0]!.taskId);
    assert.equal((await service.save(input))[0]!.taskId, both[0][0]!.taskId);
    assert.equal(listTasks(db).length, 0);
    const next = await service.revise(plan.id, plan.revision, { brief: brief(), proposal: proposal() });
    await assert.rejects(service.save({ ...input, revision: next.revision, key: randomUUID() }), /already has a saved task/);
  });
  it("rolls back the complete batch when the second task or mission membership fails", async () => {
    const db = workspace(); const service = host(db);
    const missionId = randomUUID();
    insertMission(db, { id: missionId, conversationId: randomUUID(), createdAt: AT }, { id: randomUUID(), content: { name: "Workout logger", outcome: "Record and reopen", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] } });
    const initial = await service.create({ ...request(), missionId });
    const plan = await service.revise(initial.id, 1, { brief: brief(), proposal: proposal() });
    db.db.exec("CREATE TRIGGER injected_planning_failure BEFORE INSERT ON tasks WHEN NEW.title='Show the saved workout' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    await assert.rejects(service.save({ id: plan.id, revision: plan.revision, key: randomUUID(), itemIds: ["first", "second"] }), /injected failure/);
    assert.equal(listTasks(db).length, 0); assert.equal(missionTaskIds(db, missionId).length, 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()?.["n"], 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM planning_saves").get()?.["n"], 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM planning_task_sources").get()?.["n"], 0);
  });
  it("rejects stale task sources and overlaps, invalid projects and empty selections without creating tasks", async () => {
    const db = workspace(); const p = project(); const service = host(db, { projects: () => [p] });
    const sourceId = task(db, p.id);
    const initial = await service.create({ ...request(), projectId: p.id, source: { kind: "task", id: sourceId, version: 1 } });
    const plan = await service.revise(initial.id, 1, { brief: brief(), proposal: proposal() });
    await assert.rejects(service.save({ id: plan.id, revision: plan.revision, key: randomUUID(), itemIds: [] }), /Select one/);
    updateTask(db, sourceId, 1, { title: "Changed source" }, AT);
    assert.match(service.get(plan.id).stale ?? "", /changed/);
    await assert.rejects(service.save({ id: plan.id, revision: plan.revision, key: randomUUID(), itemIds: ["first"] }), /changed/);
    await assert.rejects(service.create({ ...request(), projectId: randomUUID() }), /removed/);
    assert.equal(listTasks(db).length, 1);
    const refreshed = await service.revise(plan.id, plan.revision, { brief: brief(), proposal: proposal(), refresh: true });
    assert.equal(refreshed.stale, null); assert.equal(refreshed.proposal?.inspection, "provisional");
  });
  it("preserves structured reviews and save receipts across restart without inventing a conversation", async () => {
    const db = workspace(); const service = host(db);
    const initial = await service.create(request());
    const plan = await service.revise(initial.id, 1, { brief: brief(), proposal: proposal() });
    const input = { id: plan.id, revision: plan.revision, key: randomUUID(), itemIds: ["first"] };
    const saved = await service.save(input);
    const path = db.path; db.close();
    const reopened = openWorkspace(path); assert.equal(reopened.state, "ready");
    if (reopened.state !== "ready") throw new Error("The fixture couldn't reopen.");
    opened.push(reopened.db);
    const resumed = host(reopened.db);
    assert.equal(resumed.get(plan.id).proposal?.items.length, 2);
    assert.equal((await resumed.save(input))[0]!.taskId, saved[0]!.taskId);
    assert.equal(reopened.db.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.["n"], 0);
  });
  it("requires current sharing after async startup, cancels revocation and rejects late results", async () => {
    const db = workspace(); let p = project(); let epoch = 0;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    const service = host(db, { projects: () => [p], sharingEpoch: () => epoch, generate: async ({ assertCurrent, started }) => {
      await gate; assertCurrent(); requests++; started({ runId: randomUUID(), maxRequests: 1 }); return result();
    } });
    const plan = await service.create({ ...request(), projectId: p.id });
    const operation = await service.generate(plan.id, 1, { inspectRepository: true, operationId: randomUUID() });
    p = { ...p, sharing: { ...p.sharing, modelContext: false } }; epoch++;
    await service.invalidateProject(p.id); release();
    assert.equal((await completed(service, plan.id, operation.id)).status, "cancelled");
    assert.equal(requests, 0); assert.equal(service.get(plan.id).revision, 1);
    await assert.rejects(service.generate(plan.id, 1, { inspectRepository: false, operationId: randomUUID() }), /sharing/);
    assert.equal((await service.revise(plan.id, 1, { brief: brief(), proposal: proposal() })).revision, 2);
  });
  it("rejects a late result after project removal while repository-free generation remains available", async () => {
    const db = workspace(); let projects = [project()];
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = host(db, { projects: () => projects, generate: async ({ started }) => { started({ runId: randomUUID(), maxRequests: 1 }); await gate; return result(); } });
    const plan = await service.create({ ...request(), projectId: projects[0]!.id });
    const op = await service.generate(plan.id, 1, { inspectRepository: false, operationId: randomUUID() });
    projects = []; release();
    assert.equal((await completed(service, plan.id, op.id)).status, "failed");
    assert.equal(service.get(plan.id).revision, 1);
    const free = await service.create(request());
    const freeOp = await service.generate(free.id, 1, { inspectRepository: false, operationId: randomUUID() });
    assert.equal((await completed(service, free.id, freeOp.id)).status, "succeeded");
  });
  it("deduplicates generation and refuses credentials and fabricated repository claims", async () => {
    const db = workspace(); let sends = 0;
    const service = host(db, { secrets: async () => [["NEBIUS_API_KEY", "saved-secret-for-fixture"]], generate: async () => { sends++; return result(); } });
    await assert.rejects(service.create({ ...request(), brief: { ...brief(), outcome: "saved-secret-for-fixture" } }), /saved Token Factory key/);
    const plan = await service.create(request()); const operationId = randomUUID();
    await Promise.all([service.generate(plan.id, 1, { inspectRepository: false, operationId }), service.generate(plan.id, 1, { inspectRepository: false, operationId })]);
    await completed(service, plan.id, operationId); assert.equal(sends, 1);
    const current = service.get(plan.id);
    const fake = proposal(); fake.impacts[0]!.evidence = "repository";
    fake.impacts[0]!.citations = [{ path: "src/fake.ts", startLine: 1, endLine: 2, sha256: "a".repeat(64), revision: "b".repeat(40) }];
    await assert.rejects(service.revise(plan.id, current.revision, { brief: brief(), proposal: fake }), /no checked source/);
  });
  it("rechecks sharing after asynchronous credential lookup for a received result and acknowledges only durable success", async () => {
    const db = workspace(); const p = project(); let epoch = 0; let secretCalls = 0; let acknowledgements = 0;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = host(db, { projects: () => [p], sharingEpoch: () => epoch, secrets: async () => { secretCalls++; if (secretCalls === 3) await gate; return []; }, generate: async ({ started }) => { started({ runId: randomUUID(), maxRequests: 1 }); return result(); }, acknowledge: async () => { acknowledgements++; } });
    const plan = await service.create({ ...request(), projectId: p.id });
    const op = await service.generate(plan.id, 1, { inspectRepository: false, operationId: randomUUID() });
    await tick(); epoch++; release();
    assert.equal((await completed(service, plan.id, op.id)).status, "failed");
    assert.equal(service.get(plan.id).revision, 1); assert.equal(acknowledgements, 0);
    const free = await service.create(request());
    const success = await service.generate(free.id, 1, { inspectRepository: false, operationId: randomUUID() });
    assert.equal((await completed(service, free.id, success.id)).status, "succeeded");
    assert.equal(acknowledgements, 1); assert.equal(service.get(free.id).revision, 2);
  });
  it("waits for confirmed cancellation and surfaces cancellation failure without accepting late output", async () => {
    const db = workspace(); const p = project(); let stopped = false; let stopCalls = 0;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = host(db, { projects: () => [p], generate: async ({ started }) => { started({ runId: randomUUID(), maxRequests: 1 }); await gate; return result(); }, cancelGeneration: async () => { stopCalls++; if (!stopped) throw new Error("transport unavailable"); } });
    const plan = await service.create({ ...request(), projectId: p.id });
    const op = await service.generate(plan.id, 1, { inspectRepository: true, operationId: randomUUID() });
    await assert.rejects(service.invalidateProject(p.id), /couldn't confirm/);
    assert.equal(stopCalls, 1);
    stopped = true; await service.invalidateProject(p.id); release();
    await completed(service, plan.id, op.id); await tick();
    assert.equal(service.get(plan.id).revision, 1); assert.ok(stopCalls >= 2);
  });
  it("binds bounded existing task records and rechecks repository evidence before save", async () => {
    const db = workspace(); const p = project(); let evidenceCurrent = true; let checks = 0;
    const read = { path: "src/storage.ts", startLine: 1, endLine: 8, sha256: "a".repeat(64), revision: "b".repeat(40) };
    const generated = result(); generated.proposal.inspection = "assessed"; generated.proposal.impacts[0]!.evidence = "repository"; generated.proposal.impacts[0]!.citations = [read]; generated.evidence = { baseline: read.revision, files: [read], searches: [], inventory: [] };
    const existing = task(db, p.id);
    const service = host(db, { projects: () => [p], generate: async () => generated, checkEvidence: async () => { checks++; if (!evidenceCurrent) throw new Error("The checked working-tree bytes changed; refresh the assessment."); } });
    const plan = await service.create({ ...request(), projectId: p.id });
    const op = await service.generate(plan.id, 1, { inspectRepository: true, operationId: randomUUID() });
    await completed(service, plan.id, op.id);
    const reviewed = service.get(plan.id);
    evidenceCurrent = false;
    await assert.rejects(service.save({ id: plan.id, revision: reviewed.revision, key: randomUUID(), itemIds: ["first"] }), /working-tree bytes changed/);
    assert.equal(checks, 1); assert.equal(listTasks(db).length, 1);
    updateTask(db, existing, 1, { state: "completed" }, AT);
    assert.match(service.get(plan.id).stale ?? "", /changed/);
  });
  it("interrupts content-free pending operations on restart without resending", async () => {
    const db = workspace(); let sends = 0;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = host(db, { generate: async () => { sends++; await gate; return result(); } });
    const plan = await service.create(request());
    const op = await service.generate(plan.id, 1, { inspectRepository: false, operationId: randomUUID() });
    assert.equal(service.get(plan.id).operation?.id, op.id);
    service.clear();
    const restarted = host(db, { generate: async () => { sends++; return result(); } });
    assert.equal(restarted.operation(plan.id, op.id).status, "interrupted");
    assert.equal(restarted.get(plan.id).operation?.status, "interrupted");
    assert.equal((await restarted.generate(plan.id, 1, { inspectRepository: false, operationId: op.id })).status, "interrupted");
    release(); await tick(); assert.equal(sends, 1); assert.equal(restarted.get(plan.id).revision, 1);
    const row = db.db.prepare("SELECT * FROM planning_operations WHERE id=?").get(op.id)!;
    assert.equal(Object.keys(row).some((key) => /brief|proposal|context|history/.test(key)), false);
  });
  it("invalidates assessed advice when reviewed decisions or uncertainties change independently of the brief", async () => {
    const db = workspace(); const p = project();
    const source = { path: "src/store.ts", startLine: 1, endLine: 5, sha256: "a".repeat(64), revision: "b".repeat(40) };
    const generated = result(); generated.proposal.inspection = "assessed"; generated.proposal.impacts[0]!.evidence = "repository"; generated.proposal.impacts[0]!.citations = [source]; generated.evidence.files = [source]; generated.evidence.baseline = source.revision;
    const service = host(db, { projects: () => [p], generate: async () => generated });
    const initial = await service.create({ ...request(), projectId: p.id });
    const op = await service.generate(initial.id, 1, { inspectRepository: true, operationId: randomUUID() }); await completed(service, initial.id, op.id);
    const before = service.get(initial.id); assert.equal(before.proposal?.inspection, "assessed");
    const edited = structuredClone(before.proposal!); edited.decisions = ["Use a different persistence architecture"]; edited.uncertainties = ["The migration cost is accepted"];
    const reviewed = await service.revise(before.id, before.revision, { brief: before.request.brief, proposal: edited });
    assert.equal(reviewed.evidence, null); assert.equal(reviewed.proposal?.inspection, "provisional");
    assert.equal(reviewed.proposal?.impacts[0]?.evidence, "inferred"); assert.equal(reviewed.proposal?.impacts[0]?.citations.length, 0);
  });
  it("binds pending attempts and saved-task context when regenerating without staling a plan from its own save", async () => {
    const db = workspace(); const sourceId = task(db);
    const service = host(db);
    const initial = await service.create({ ...request(), source: { kind: "task", id: sourceId, version: 1 } });
    const reviewed = await service.revise(initial.id, 1, { brief: brief(), proposal: proposal() });
    const attemptId = randomUUID();
    insertAttempt(db, { id: attemptId, taskId: sourceId, briefId: versionsOf(db, sourceId).at(-1)!.id, sessionId: randomUUID(), targetId: "local", createdAt: AT });
    assert.match(service.get(reviewed.id).stale ?? "", /changed/);
    const refreshed = await service.revise(reviewed.id, reviewed.revision, { brief: brief(), proposal: proposal(), refresh: true });
    settleAttempt(db, attemptId, { status: "answered" }, AT);
    recordOutcome(db, attemptId, { outcome: "proposed", verified: true, proposalHash: "a".repeat(64), baseline: "b".repeat(40) }, AT);
    assert.match(service.get(refreshed.id).stale ?? "", /changed/);
    const pendingReview = await service.revise(refreshed.id, refreshed.revision, { brief: brief(), proposal: proposal(), refresh: true });
    decide(db, attemptId, { kind: "rejected" }, AT);
    assert.match(service.get(pendingReview.id).stale ?? "", /changed/);

    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let sentBinding: string | null = null;
    const regeneration = host(db, { generate: async ({ assertCurrent, view }) => { sentBinding = view.binding; await gate; assertCurrent(); return result(); } });
    const newPlan = await regeneration.create(request());
    const prepared = await regeneration.revise(newPlan.id, 1, { brief: brief(), proposal: proposal() });
    const saved = await regeneration.save({ id: prepared.id, revision: prepared.revision, key: randomUUID(), itemIds: ["first"] });
    assert.equal(regeneration.get(newPlan.id).stale, null);
    const op = await regeneration.generate(newPlan.id, prepared.revision, { inspectRepository: false, operationId: randomUUID() });
    assert.notEqual(sentBinding, null); assert.notEqual(sentBinding, prepared.binding, "newly saved result mappings bind the next generation's context");
    updateTask(db, saved[0]!.taskId, 1, { title: "The saved work changed" }, AT); release();
    assert.equal((await completed(regeneration, newPlan.id, op.id)).status, "failed");
    assert.equal(regeneration.get(newPlan.id).revision, prepared.revision);
  });
  it("binds the exact implicit mission knowledge sent for a source task, without binding unrelated project notes", async () => {
    for (const change of ["edit", "forget"] as const) {
      const db = workspace(); const p = project(); const unrelated = project(); const sourceId = task(db, p.id);
      const missionId = randomUUID();
      insertMission(db, { id: missionId, conversationId: randomUUID(), createdAt: AT }, { id: randomUUID(), content: { name: "Offline logger", outcome: "Record and reopen", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] } });
      assert.equal(addMissionTask(db, missionId, sourceId, AT), "added");
      const note = saveKnowledge(db, { scope: { kind: "mission", id: missionId }, projectId: null, kind: "constraint", statement: "The logger must work offline.", origin: "user-stated", source: { kind: "user", sessionId: "fixture", requestId: randomUUID() } }, { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(db), known: [], at: AT });
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      const service = host(db, { projects: () => [p, unrelated], generate: async ({ assertCurrent }) => { await gate; assertCurrent(); return result(); } });
      const plan = await service.create({ ...request(), projectId: p.id, source: { kind: "task", id: sourceId, version: 1 }, missionId: null });
      const operation = await service.generate(plan.id, plan.revision, { inspectRepository: false, operationId: randomUUID() });
      saveKnowledge(db, { scope: { kind: "project", id: unrelated.id }, projectId: unrelated.id, kind: "constraint", statement: "An unrelated app uses a separate database.", origin: "user-stated", source: { kind: "user", sessionId: "fixture", requestId: randomUUID() } }, { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(db), known: [], at: AT });
      assert.equal(service.get(plan.id).stale, null, "an unrelated scope's knowledge epoch is not a planning dependency");
      const options = { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(db), known: [], at: AT };
      if (change === "edit") editKnowledge(db, note.id, note.revision, "The logger must work without any network connection.", options);
      else forgetKnowledge(db, note.id, note.revision, options);
      assert.match(service.get(plan.id).stale ?? "", /changed/, "implicit mission notes are relevant even with projectId null and no explicit mission binding");
      release();
      assert.equal((await completed(service, plan.id, operation.id)).status, "failed");
      assert.equal(service.get(plan.id).revision, plan.revision);
    }
  });
});
