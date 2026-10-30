import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { BudgetGrant, PlanningResult, PlanningView } from "@nivra/domain";
import type { ProjectRecord } from "../src/main/host-store.ts";
import { PlanningFailure, type PlanningGeneration } from "../src/main/planning-host.ts";
import { PlanningRunner } from "../src/main/planning-runner.ts";
import type { EngineSupervisor } from "../src/main/supervisor.ts";
import { knowledgeEpoch, saveKnowledge } from "../src/main/knowledge-store.ts";
import { addMissionTask, insertMission } from "../src/main/mission-store.ts";
import { insertTask } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";
import { BRIEFS } from "./fixtures/briefs.ts";

const opened: WorkspaceDb[] = []; const roots: string[] = [];
after(() => { for (const db of opened) db.close(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const result = (): PlanningResult => ({ proposal: { summary: "One useful increment", challenges: [], decisions: [], uncertainties: [], questions: [], deferred: [], inspection: "not-assessed", inspectionScope: "No source inspected", gaps: [], impacts: [], items: [{ id: "one", title: "A useful task", goal: "A small outcome", scope: "One flow", exclusions: "", acceptanceCriteria: ["One visible result"], impactIds: [], prerequisites: [], overlapTaskIds: [], questions: [] }] }, evidence: { baseline: null, files: [], searches: [], inventory: [] }, exploration: "Only the final answer fits this allowance; repository exploration was reduced." });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nivra-planning-runner-")); roots.push(root);
  const opening = openWorkspace(join(root, "workspace.db")); assert.equal(opening.state, "ready");
  if (opening.state !== "ready") throw new Error("The fixture couldn't open.");
  opened.push(opening.db);
  const project: ProjectRecord = { id: randomUUID(), targetId: "local", nativePath: "/synthetic", label: "Synthetic", addedAt: "2026-10-29T10:00:00.000Z", sharing: { modelContext: true, cloudExecution: false } };
  const projects = [project]; let epoch = 0; let cap = 1; let grants = 0; let dispatches = 0;
  const operationId = randomUUID(); const runId = randomUUID(); const homeId = randomUUID();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const hooks: Record<string, ((params: Record<string, unknown>) => unknown | Promise<unknown>) | undefined> = {};
  const state = { status: "online", info: { homeId } };
  const connection = { state, call: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (hooks[method]) return hooks[method](params);
    if (method === "runs.start" || method === "runs.find" || method === "runs.get") return { id: runId, status: "succeeded" };
    if (method === "planning.pending") return { request: 1 };
    if (method === "planning.result") return result();
    if (method === "planning.validateEvidence") return { current: true, reason: null };
    return { ok: true };
  } } as unknown as Pick<EngineSupervisor, "call" | "state">;
  const options: ConstructorParameters<typeof PlanningRunner>[0] = { workspace: () => opening.db, projects: () => projects, sharingEpoch: () => epoch, preferences: () => ({ revision: 0, records: [] }), secrets: async () => [["NEBIUS_API_KEY", "fixture-provider-key-1234567890"]], connect: async () => connection, reconcile: async () => undefined, grant: (requestId, _target, _home, _project, _task, _maximum) => { grants++; return { id: randomUUID(), requestId, catalogueVersion: "fixture", rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: Math.max(0, cap - 1), outputTokens: 8000 }, finalisation: { requests: 1, outputTokens: 8000 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } } as BudgetGrant; } };
  const view: PlanningView = { id: randomUUID(), revision: 1, request: { brief: { title: "A change", outcome: "One visible result", intendedUsers: "Engineers", scope: "One flow", exclusions: "", constraints: [], decisions: [], uncertainties: [], questions: [] }, source: { kind: "manual" }, projectId: project.id, missionId: null }, proposal: null, evidence: null, binding: "a".repeat(64), stale: null, saved: [], createdAt: project.addedAt, updatedAt: project.addedAt };
  const starts: Array<{ runId: string; maxRequests: number }> = [];
  const controller = new AbortController();
  const input: PlanningGeneration = { view, operationId, inspectRepository: true, signal: controller.signal, dispatched: () => { input.assertCurrent(); dispatches++; }, assertCurrent: () => { if (controller.signal.aborted || !projects.includes(project) || !project.sharing.modelContext || epoch !== 0) throw new PlanningFailure("The project's sharing epoch changed."); }, started: (info) => starts.push(info) };
  return { options, connection, state, project, projects, view, input, hooks, calls, starts, dispatches: () => dispatches, grants: () => grants, epoch: (value: number) => { epoch = value; }, cap: (value: number) => { cap = value; }, controller };
}

describe("planning engine transport consent and lifecycle", () => {
  it("fixes accepted reference authority at dispatch even when the acknowledgement is lost", async () => {
    const f = fixture(); let changed = false;
    const authority = f.input.assertCurrent;
    f.input.assertCurrent = () => { authority(); if (changed && f.dispatches() === 0) throw new Error("References changed before dispatch"); };
    f.hooks["runs.start"] = () => { assert.equal(f.dispatches(), 1); changed = true; throw new Error("Lost acknowledgement"); };
    const runner = new PlanningRunner(f.options), retained = await runner.generate(f.input);
    assert.equal(retained.proposal.summary, result().proposal.summary);
    assert.equal(f.calls.filter((call) => call.method === "runs.start").length, 1);
    assert.equal(f.calls.filter((call) => call.method === "runs.find").length, 1);
    assert.equal(f.starts.length, 1); assert.equal(f.dispatches(), 1);
    await runner.acknowledge(f.input.operationId);
  });
  it("sends the selected mission and project knowledge together, including mission planning from a task in another mission", async () => {
    for (const taskSource of [false, true]) {
      const f = fixture(); const db = f.options.workspace(); const missionId = randomUUID(); const oldMissionId = randomUUID(); const at = f.project.addedAt;
      for (const id of [missionId, oldMissionId]) insertMission(db, { id, conversationId: randomUUID(), createdAt: at }, { id: randomUUID(), content: { name: "An increment", outcome: "One result", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] } });
      const note = (scope: { kind: "project" | "mission"; id: string }, projectId: string | null, statement: string) => saveKnowledge(db, { scope, projectId, kind: "constraint", statement, origin: "user-stated", source: { kind: "user", sessionId: "fixture", requestId: randomUUID() } }, { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(db), known: [], at });
      const selectedMission = note({ kind: "mission", id: missionId }, null, "The selected mission works offline.");
      const selectedProject = note({ kind: "project", id: f.project.id }, f.project.id, "The project stores data locally.");
      note({ kind: "mission", id: oldMissionId }, null, "Another mission uses cloud sync.");
      const foreignProjectId = randomUUID();
      f.projects.push({ ...f.project, id: foreignProjectId });
      note({ kind: "mission", id: missionId }, foreignProjectId, "A different repository uses remote data.");
      f.view.request.missionId = missionId;
      if (taskSource) {
        const id = randomUUID(); insertTask(db, { id, title: "Existing task", projectId: f.project.id, createdAt: at, updatedAt: at }, { id: randomUUID(), content: BRIEFS.vague, derivedFrom: null });
        addMissionTask(db, oldMissionId, id, at);
        f.view.request.source = { kind: "task", id, version: 1 };
      } else f.view.request.source = { kind: "mission", id: missionId, version: 1 };
      const runner = new PlanningRunner(f.options); await runner.generate(f.input);
      const context = f.calls.find((call) => call.method === "runs.start")!.params["context"] as { knowledge: { records: Array<{ id: string }> } };
      assert.equal(context.knowledge.records.length, 2);
      assert.deepEqual(new Set(context.knowledge.records.map((record) => record.id)), new Set([selectedMission.id, selectedProject.id]));
      await runner.acknowledge(f.input.operationId);
    }
  });
  it("protects mission knowledge when project notes fill the bounded context", async () => {
    const f = fixture(); const db = f.options.workspace(); const missionId = randomUUID(); const at = f.project.addedAt;
    insertMission(db, { id: missionId, conversationId: randomUUID(), createdAt: at }, { id: randomUUID(), content: { name: "An increment", outcome: "One result", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] } });
    const note = (scope: { kind: "project" | "mission"; id: string }, projectId: string | null, statement: string) => saveKnowledge(db, { scope, projectId, kind: "constraint", statement, origin: "user-stated", source: { kind: "user", sessionId: "fixture", requestId: randomUUID() } }, { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(db), known: [], at });
    const missionNote = note({ kind: "mission", id: missionId }, null, "The mission must work offline.");
    for (let index = 0; index < 13; index++) note({ kind: "project", id: f.project.id }, f.project.id, `Project constraint ${index}`);
    f.view.request.missionId = missionId;
    const runner = new PlanningRunner(f.options); await runner.generate(f.input);
    const context = f.calls.find((call) => call.method === "runs.start")!.params["context"] as { knowledge: { records: Array<{ id: string }> } };
    assert.equal(context.knowledge.records.length, 12);
    assert.equal(context.knowledge.records.filter((record) => record.id === missionNote.id).length, 1);
    await runner.acknowledge(f.input.operationId);
  });
  it("rechecks sharing after asynchronous engine startup, before granting or sending", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.options.connect = async () => { await gate; return f.connection; };
    const runner = new PlanningRunner(f.options);
    const pending = runner.generate(f.input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.epoch(1); release();
    await assert.rejects(pending, /sharing epoch/);
    assert.equal(f.grants(), 0); assert.equal(f.calls.filter((call) => call.method === "runs.start").length, 0);
  });
  it("rejects a pending inference request after epoch revocation without authorizing it", async () => {
    const f = fixture();
    f.hooks["planning.pending"] = () => { f.epoch(1); return { request: 1 }; };
    const runner = new PlanningRunner(f.options);
    await assert.rejects(runner.generate(f.input), /sharing epoch/);
    assert.equal(f.calls.filter((call) => call.method === "planning.authorize").length, 0);
    assert.ok(f.calls.some((call) => call.method === "planning.end"));
    await runner.cancel(f.input.operationId);
  });
  it("rejects a late result when sharing changes during its asynchronous delivery", async () => {
    const f = fixture();
    f.hooks["planning.result"] = () => { f.epoch(1); return result(); };
    const runner = new PlanningRunner(f.options);
    await assert.rejects(runner.generate(f.input), /sharing epoch/);
    assert.equal(f.calls.filter((call) => call.method === "planning.ack").length, 0);
    await runner.cancel(f.input.operationId);
  });
  it("forwards a reduced one-request grant and preserves final-answer capacity", async () => {
    const f = fixture(); f.cap(1);
    const runner = new PlanningRunner(f.options);
    const proposal = await runner.generate(f.input);
    const start = f.calls.find((call) => call.method === "runs.start")!;
    const context = start.params["context"] as { maxRequests: number; repository: { sharingEpoch: number } };
    const grant = start.params["budget"] as BudgetGrant;
    assert.equal(context.maxRequests, 1); assert.equal(context.repository.sharingEpoch, 0);
    assert.equal(grant.productive.requests, 0); assert.equal(grant.finalisation.requests, 1);
    assert.equal(f.starts[0]?.maxRequests, 1); assert.match(proposal.exploration, /exploration was reduced/);
    assert.equal(f.calls.filter((call) => call.method === "planning.ack").length, 0);
    await runner.acknowledge(f.input.operationId);
    assert.equal(f.calls.filter((call) => call.method === "planning.ack").length, 1);
  });
  it("refuses an exhausted allowance before sending and never replays a lost acknowledgement", async () => {
    const exhausted = fixture(); exhausted.options.grant = () => { throw new Error("The monthly AI request limit is exhausted. Continue manually."); };
    await assert.rejects(new PlanningRunner(exhausted.options).generate(exhausted.input), /exhausted/);
    assert.equal(exhausted.calls.filter((call) => call.method === "runs.start").length, 0);
    const lost = fixture(); lost.hooks["runs.start"] = () => { throw new Error("lost transport acknowledgement"); }; lost.hooks["runs.find"] = () => null;
    const runner = new PlanningRunner(lost.options);
    await assert.rejects(runner.generate(lost.input), /will not be resent/);
    assert.equal(lost.calls.filter((call) => call.method === "runs.start").length, 1);
    await runner.cancel(lost.input.operationId);
  });
  it("refuses cancellation against a different engine home instead of claiming the original stopped", async () => {
    const f = fixture(); const runner = new PlanningRunner(f.options);
    await runner.generate(f.input);
    f.state.info.homeId = randomUUID();
    await assert.rejects(runner.cancel(f.input.operationId), /engine|home|reconnect/i);
    assert.equal(f.calls.filter((call) => call.method === "planning.end").length, 0);
  });
});
