import { createHash } from "node:crypto";
import { KNOWLEDGE_LIMITS, KnowledgeSnapshot, knowledgeCanonical, type KnowledgeRecord, type KnowledgeScope, type PlanningRequest } from "@nivra/domain";
import { knowledgeSnapshotFor, resolveCompanionScope } from "./companion-context.ts";
import type { ProjectRecord } from "./host-store.ts";
import { knowledgeEpoch } from "./knowledge-store.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

/** The emitted notes and the host's binding must use exactly the same bounded selection. */
export function planningContextFor(workspace: WorkspaceDb, projects: readonly ProjectRecord[], request: PlanningRequest) {
  const hint = request.source.kind === "task" ? { kind: "task" as const, id: request.source.id } : request.projectId ? { kind: "project" as const, id: request.projectId } : request.missionId ? { kind: "mission" as const, id: request.missionId } : { kind: "general" as const };
  const resolved = resolveCompanionScope(workspace, projects, hint);
  const scopes: KnowledgeScope[] = [];
  if (resolved.task) scopes.push({ kind: "task", id: resolved.task.id });
  // An explicitly selected mission replaces the task's inherited mission for this planning request.
  const missionId = request.missionId ?? resolved.mission?.record.id;
  if (missionId) scopes.push({ kind: "mission", id: missionId });
  if (resolved.project) scopes.push({ kind: "project", id: resolved.project.id });
  const snapshots = scopes.map((scope) => knowledgeSnapshotFor(workspace, projects, { ...resolved, scope, task: null, mission: null }, { forModel: true }));
  if (!snapshots.length) return { resolved, knowledge: knowledgeSnapshotFor(workspace, projects, resolved, { forModel: true }) };
  const records: KnowledgeRecord[] = [];
  const seen = new Set<string>();
  // Share the twelve-note bound between relevant scopes; a busy project must not crowd out its mission.
  for (let index = 0; index < KNOWLEDGE_LIMITS.snapshotRecords && records.length < KNOWLEDGE_LIMITS.snapshotRecords; index++) for (const snapshot of snapshots) {
    const record = snapshot.records[index];
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id); records.push(record);
    if (records.length === KNOWLEDGE_LIMITS.snapshotRecords) break;
  }
  const digest = createHash("sha256").update(JSON.stringify(knowledgeCanonical(records))).digest("hex");
  return { resolved, knowledge: KnowledgeSnapshot.parse({ epoch: knowledgeEpoch(workspace), records, digest }) };
}
