import { createHash, randomUUID } from "node:crypto";
import type { PlanningEvidence, PlanningOperationView, PlanningProposal, PlanningRequest, PlanningSavedItem, PlanningView } from "@nivra/domain";
import { addMissionTask } from "./mission-store.ts";
import { briefFrom } from "./tasks.ts";
import { insertTask } from "./workspace.ts";
import { num, str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";

export const planningDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface PlanningRecord extends PlanningView { references: unknown }
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
function recordOf(workspace: WorkspaceDb, row: Row): PlanningRecord {
  const id = str(row["planning_id"]);
  return { id, revision: num(row["revision"]), request: decode<PlanningRequest>(row["request_json"]), proposal: row["proposal_json"] === null ? null : decode<PlanningProposal>(row["proposal_json"]), evidence: row["evidence_json"] === null ? null : decode<PlanningEvidence>(row["evidence_json"]), binding: str(row["binding"]), references: decode(row["references_json"]), stale: null, saved: savedPlanningItems(workspace, id), createdAt: str(row["started_at"]), updatedAt: str(row["created_at"]) };
}
export function getPlanning(workspace: WorkspaceDb, id: string): PlanningRecord | null {
  const row = workspace.db.prepare("SELECT v.*, r.created_at AS started_at FROM planning_versions v JOIN planning_requests r ON r.id=v.planning_id WHERE planning_id=? ORDER BY revision DESC LIMIT 1").get(id);
  return row ? recordOf(workspace, row) : null;
}
export function listPlanning(workspace: WorkspaceDb): PlanningRecord[] {
  return workspace.db.prepare("SELECT id FROM planning_requests ORDER BY created_at DESC, id").all().map((row) => getPlanning(workspace, str(row["id"]))!);
}
export function insertPlanning(workspace: WorkspaceDb, request: PlanningRequest, binding: string, references: unknown, at: string): PlanningRecord {
  const id = randomUUID();
  workspace.tx((db) => {
    db.prepare("INSERT INTO planning_requests (id,created_at) VALUES (?,?)").run(id, at);
    db.prepare("INSERT INTO planning_versions (planning_id,revision,request_json,proposal_json,evidence_json,binding,references_json,created_at) VALUES (?,1,?,NULL,NULL,?,?,?)").run(id, JSON.stringify(request), binding, JSON.stringify(references), at);
  });
  return getPlanning(workspace, id)!;
}
export function revisePlanning(workspace: WorkspaceDb, id: string, after: number, input: { request: PlanningRequest; proposal: PlanningProposal | null; evidence: PlanningEvidence | null; binding: string; references: unknown }, at: string): PlanningRecord {
  return workspace.tx((db) => {
    const current = getPlanning(workspace, id);
    if (!current || current.revision !== after) throw new Error("This planning draft changed. Open its latest version, then review it again.");
    db.prepare("INSERT INTO planning_versions (planning_id,revision,request_json,proposal_json,evidence_json,binding,references_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, after + 1, JSON.stringify(input.request), input.proposal ? JSON.stringify(input.proposal) : null, input.evidence ? JSON.stringify(input.evidence) : null, input.binding, JSON.stringify(input.references), at);
    return getPlanning(workspace, id)!;
  });
}
export function savedPlanningItems(workspace: WorkspaceDb, id: string): PlanningSavedItem[] {
  return workspace.db.prepare("SELECT * FROM planning_task_sources WHERE planning_id=? ORDER BY rowid").all(id).map((row) => ({ itemId: str(row["item_id"]), taskId: str(row["task_id"]), briefId: str(row["brief_id"]), missingPrerequisites: decode<{ missingPrerequisites: string[] }>(row["metadata_json"]).missingPrerequisites }));
}
export function planningSourcesOf(workspace: WorkspaceDb, taskId: string): Array<{ planningId: string; revision: number; itemId: string; questions: string[]; missingPrerequisites: string[] }> {
  return workspace.db.prepare("SELECT * FROM planning_task_sources WHERE task_id=?").all(taskId).map((row) => ({ planningId: str(row["planning_id"]), revision: num(row["revision"]), itemId: str(row["item_id"]), ...decode<{ questions: string[]; missingPrerequisites: string[] }>(row["metadata_json"]) }));
}
/** Check a receipt before any freshness checks: a lost save reply can be read after its sources change. */
export function planningSaveReceipt(workspace: WorkspaceDb, key: string, fingerprint: string): PlanningSavedItem[] | null {
  const row = workspace.db.prepare("SELECT fingerprint,result_json FROM planning_saves WHERE save_key=?").get(key);
  if (!row) return null;
  if (str(row["fingerprint"]) !== fingerprint) throw new Error("This save key was already used for different work. Review the latest proposal, then save with a new key.");
  return decode<PlanningSavedItem[]>(row["result_json"]);
}
/** All caller checks and writes share one outer synchronous transaction. Never loop async public task creation. */
export function savePlanningTasks(workspace: WorkspaceDb, input: { id: string; revision: number; key: string; itemIds: string[]; fingerprint: string }, validate: (record: PlanningRecord) => void, at: string): PlanningSavedItem[] {
  return workspace.tx((db) => {
    const receipt = planningSaveReceipt(workspace, input.key, input.fingerprint);
    if (receipt) return receipt;
    const record = getPlanning(workspace, input.id);
    if (!record || record.revision !== input.revision) throw new Error("This proposal changed. Open its latest version, then select the tasks again.");
    if (db.prepare("SELECT 1 FROM planning_saves WHERE planning_id=? AND revision=?").get(input.id, input.revision)) throw new Error("This proposal version was already saved. Open its saved tasks; make a new reviewed version to save other items.");
    validate(record);
    if (!record.proposal) throw new Error("This planning draft has no proposal. Add tasks before saving them.");
    const selected = new Set(input.itemIds);
    if (!selected.size || selected.size !== input.itemIds.length || selected.size > 5 || input.itemIds.some((id) => !record.proposal!.items.some((item) => item.id === id))) throw new Error("Select one to five different tasks from this proposal, then save again.");
    if (record.saved.some((item) => selected.has(item.itemId))) throw new Error("One of these proposal items already has a saved task. Open that task instead of creating it again.");
    const result: PlanningSavedItem[] = [];
    for (const item of record.proposal.items.filter((item) => selected.has(item.id))) {
      const taskId = randomUUID();
      const briefId = randomUUID();
      const missingPrerequisites = item.prerequisites.filter((id) => !selected.has(id) && !record.saved.some((saved) => saved.itemId === id));
      const questions = [...new Set([...record.request.brief.questions, ...record.proposal.questions, ...item.questions])];
      const context = [record.proposal.summary, questions.length ? `Needs a decision:\n${questions.map((question) => `- ${question}`).join("\n")}` : "", missingPrerequisites.length ? `Advisory prerequisites not selected: ${missingPrerequisites.join(", ")}.` : ""].filter(Boolean).join("\n\n");
      const assumptions = [...record.proposal.uncertainties, ...record.request.brief.uncertainties].slice(0, 20);
      insertTask(workspace, { id: taskId, title: item.title, projectId: record.request.projectId, createdAt: at, updatedAt: at }, { id: briefId, content: briefFrom({ goal: item.goal, acceptanceCriteria: item.acceptanceCriteria, scope: item.scope, exclusions: item.exclusions, context, assumptions, checks: [], acceptanceCases: [], baseline: [], frozen: [] }), derivedFrom: null });
      if (record.request.missionId && addMissionTask(workspace, record.request.missionId, taskId, at) !== "added") throw new Error("The mission couldn't hold this whole breakdown. Review its backlog, then save again; no tasks were created.");
      const metadata = { questions, missingPrerequisites, impactIds: item.impactIds };
      db.prepare("INSERT INTO planning_task_sources (planning_id,item_id,revision,task_id,brief_id,metadata_json) VALUES (?,?,?,?,?,?)").run(input.id, item.id, input.revision, taskId, briefId, JSON.stringify(metadata));
      result.push({ itemId: item.id, taskId, briefId, missingPrerequisites });
    }
    db.prepare("INSERT INTO planning_saves (save_key,planning_id,revision,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)").run(input.key, input.id, input.revision, input.fingerprint, JSON.stringify(result), at);
    return result;
  });
}
const operationOf = (row: Row): PlanningOperationView => ({ id: str(row["id"]), planningId: str(row["planning_id"]), status: str(row["status"]) as PlanningOperationView["status"], message: strOrNull(row["message"]), maxRequests: num(row["max_requests"]), runId: strOrNull(row["run_id"]) });
export function getPlanningOperation(workspace: WorkspaceDb, id: string): (PlanningOperationView & { revision: number; fingerprint: string }) | null {
  const row = workspace.db.prepare("SELECT * FROM planning_operations WHERE id=?").get(id);
  return row ? { ...operationOf(row), revision: num(row["revision"]), fingerprint: str(row["fingerprint"]) } : null;
}
export function insertPlanningOperation(workspace: WorkspaceDb, input: { id: string; planningId: string; revision: number; fingerprint: string; maxRequests: number }, at: string): void {
  workspace.db.prepare("INSERT INTO planning_operations (id,planning_id,revision,fingerprint,status,max_requests,created_at) VALUES (?,?,?,?,'submitting',?,?)").run(input.id, input.planningId, input.revision, input.fingerprint, input.maxRequests, at);
}
export function updatePlanningOperation(workspace: WorkspaceDb, id: string, status: PlanningOperationView["status"], message: string | null = null, started?: { runId: string; maxRequests: number }): void {
  workspace.db.prepare("UPDATE planning_operations SET status=?,message=?,run_id=COALESCE(?,run_id),max_requests=COALESCE(?,max_requests) WHERE id=? AND status IN ('submitting','running')").run(status, message, started?.runId ?? null, started?.maxRequests ?? null, id);
}
export function interruptPlanningOperations(workspace: WorkspaceDb): void {
  workspace.db.prepare("UPDATE planning_operations SET status='interrupted',message='Planning stopped when Nivra closed. Review the saved brief; request a new pass explicitly if needed.' WHERE status IN ('submitting','running')").run();
}
