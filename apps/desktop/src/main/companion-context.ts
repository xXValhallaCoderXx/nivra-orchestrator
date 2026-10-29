import { createHash } from "node:crypto";
import { KNOWLEDGE_LIMITS, KnowledgeSnapshot, knowledgeCanonical, type KnowledgeRecord, type KnowledgeScope } from "@nivra/domain";
import { environmentOf, type EnvironmentRecord } from "./environment-store.ts";
import type { ProjectRecord } from "./host-store.ts";
import { getKnowledge, invalidateKnowledgeSources, knowledgeEpoch, listKnowledge, type NewKnowledge } from "./knowledge-store.ts";
import { getMission, latestMissionVersion, missionOfTask, type MissionRecord, type MissionVersionRecord } from "./mission-store.ts";
import { attemptRecord, attemptsOf, getAttempt, getTask, versionsOf, type ArtifactRecord, type TaskRecord } from "./workspace.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

export type CompanionScopeHint = KnowledgeScope | { kind: "general" } | { kind: "run"; id: string };

export interface ResolvedCompanionScope {
  scope: KnowledgeScope | null;
  project: ProjectRecord | null;
  projectId: string | null;
  missingProject: boolean;
  targetId: string;
  task: TaskRecord | null;
  brief: ArtifactRecord | null;
  mission: { record: MissionRecord; version: MissionVersionRecord } | null;
  environment: EnvironmentRecord | null;
  latestAttempt: { id: string; runId: string | null; briefId: string; targetId: string; status: string; outcome: string | null; verified: boolean | null; decision: string | null; pendingDecision: "run-going" | "proposal-review" | "apply-settling" | null; accepted: boolean } | null;
  /** Non-content fingerprint for pending advice/action validation. */
  binding: string;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Resolve a route hint against the host's records. Shell selection is never a project authority. */
export function resolveCompanionScope(workspace: WorkspaceDb, projects: readonly ProjectRecord[], hint: CompanionScopeHint): ResolvedCompanionScope {
  let scope: KnowledgeScope | null = hint.kind === "general" ? null : hint.kind === "run" ? null : hint;
  if (hint.kind === "run") {
    const attempt = getAttempt(workspace, hint.id);
    if (!attempt) throw new Error("That task run is no longer here. Return to Home, then open the task you want help with.");
    scope = { kind: "task", id: attempt.taskId };
  }
  const task = scope?.kind === "task" ? getTask(workspace, scope.id) : null;
  if (scope?.kind === "task" && !task) throw new Error("That task is no longer here. Return to Home, then choose another task.");
  const brief = task ? versionsOf(workspace, task.id).at(-1) ?? null : null;
  const missionId = scope?.kind === "mission" ? scope.id : task ? missionOfTask(workspace, task.id) : null;
  const missionRecord = missionId ? getMission(workspace, missionId) : null;
  const missionVersion = missionRecord ? latestMissionVersion(workspace, missionRecord.id) : null;
  if (scope?.kind === "mission" && (!missionRecord || !missionVersion)) throw new Error("That mission is no longer here. Return to Home, then choose another mission.");
  const mission = missionRecord && missionVersion ? { record: missionRecord, version: missionVersion } : null;
  const projectId = task ? task.projectId : scope?.kind === "project" ? scope.id : null;
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  if (scope?.kind === "project" && !project) throw new Error("That project was removed. Return to Home, then choose a project.");
  const environment = project ? environmentOf(workspace, project.id) : null;
  const attempt = task ? attemptsOf(workspace, task.id).at(-1) : undefined;
  const decision = attempt ? attemptRecord(workspace, attempt.id) : null;
  const latestAttempt: ResolvedCompanionScope["latestAttempt"] = attempt && decision ? {
    id: attempt.id, runId: attempt.runId, briefId: attempt.briefId, targetId: attempt.targetId, status: attempt.status,
    outcome: decision.outcome?.outcome ?? null, verified: decision.outcome?.verified ?? null, decision: decision.decision,
    pendingDecision: attempt.status === "submitting" || attempt.status === "running" ? "run-going" : decision.apply && !decision.acceptedAt && (decision.apply.view?.resolution ?? null) === null ? "apply-settling" : decision.outcome?.proposalHash && decision.decision === null ? "proposal-review" : null,
    accepted: decision.acceptedAt !== null,
  } : null;
  const binding = digest(["nivra.companion-scope.v1", scope, projectId, project ? [project.targetId, project.sharing] : null,
    task ? [task.id, task.revision, task.projectId, task.state] : null, brief ? [brief.id, brief.version, brief.sha256] : null,
    mission ? [mission.record.id, mission.version.id, mission.version.sha256] : null,
    environment ? [environment.updatedAt, environment.preparedBy] : null, latestAttempt]);
  return { scope, project, projectId, missingProject: projectId !== null && project === null, targetId: project?.targetId ?? "local", task, brief, mission, environment, latestAttempt, binding };
}

/** A checked source remains current only on its original entity and repository binding. */
export function knowledgeSourceCurrent(workspace: WorkspaceDb, projects: readonly ProjectRecord[], record: KnowledgeRecord, repositoryRevisions: ReadonlyMap<string, string> = new Map()): boolean {
  if (record.projectId !== null && !projects.some((project) => project.id === record.projectId)) return false;
  if (record.scope.kind === "task") {
    const task = getTask(workspace, record.scope.id);
    if (!task || (record.projectId !== null && task.projectId !== record.projectId)) return false;
  } else if (record.scope.kind === "mission" && !getMission(workspace, record.scope.id)) return false;
  const source = record.source;
  if (source.kind === "user") return true;
  if (source.kind === "record") return source.entity === "task" ? getTask(workspace, source.id)?.revision === source.revision : latestMissionVersion(workspace, source.id)?.version === source.revision;
  const revision = repositoryRevisions.get(source.projectId);
  // An unchecked repository is not evidence of change. Retrieval below withholds its observation until checked.
  return revision === undefined || revision === source.revision;
}

export interface KnowledgeRetrievalOptions {
  forModel?: boolean;
  includeMission?: boolean;
  repositoryRevisions?: ReadonlyMap<string, string>;
}

/** Exact permitted scopes, bounded before the model. A mission never imports its tasks or their projects. */
export function knowledgeSnapshotFor(workspace: WorkspaceDb, projects: readonly ProjectRecord[], resolved: ResolvedCompanionScope, options: KnowledgeRetrievalOptions = {}): KnowledgeSnapshot {
  invalidateKnowledgeSources(workspace, (record) => knowledgeSourceCurrent(workspace, projects, record, options.repositoryRevisions));
  const scopes: KnowledgeScope[] = resolved.scope ? [resolved.scope] : [];
  if (resolved.task && resolved.project) scopes.push({ kind: "project", id: resolved.project.id });
  if (resolved.task && resolved.mission && options.includeMission) scopes.push({ kind: "mission", id: resolved.mission.record.id });
  const seen = new Set<string>();
  const records = scopes.flatMap((scope) => listKnowledge(workspace, scope, { activeOnly: true })).filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    if (record.projectId !== null && record.projectId !== resolved.projectId) return false;
    if (options.forModel !== false && record.projectId !== null && !resolved.project?.sharing.modelContext) return false;
    if (record.source.kind === "repository" && options.repositoryRevisions?.get(record.source.projectId) !== record.source.revision) return false;
    return true;
  }).slice(0, KNOWLEDGE_LIMITS.snapshotRecords);
  const epoch = knowledgeEpoch(workspace);
  return KnowledgeSnapshot.parse({ epoch, records, digest: digest(knowledgeCanonical(records)) });
}

/** The host checks this again before retaining a turn's proposal; sources cannot assert another project's authority. */
export function validateKnowledgeForScope(input: NewKnowledge, resolved: ResolvedCompanionScope): void {
  const exact = resolved.scope?.kind === input.scope.kind && resolved.scope.id === input.scope.id;
  const project = input.scope.kind === "project" && input.scope.id === resolved.project?.id;
  const mission = input.scope.kind === "mission" && input.scope.id === resolved.mission?.record.id;
  if ((!exact && !project && !mission) || input.projectId !== resolved.projectId) throw new Error("The scope for this note changed. Choose its project, task or mission again before retaining it.");
  if (input.source.kind === "record") {
    const current = input.source.entity === "task" ? resolved.task?.id === input.source.id && resolved.task.revision === input.source.revision : resolved.mission?.record.id === input.source.id && resolved.mission.version.version === input.source.revision;
    if (!current) throw new Error("The source for this note changed. Refresh it before retaining the observation.");
  }
  if (input.source.kind === "repository" && input.source.projectId !== resolved.project?.id) throw new Error("This observation belongs to another project, so it wasn't retained. Open its project, then check it there.");
}

/** Current IDs/revisions only; useful inside an action's synchronous save transaction. */
export function knowledgeReferencesCurrent(workspace: WorkspaceDb, records: readonly Pick<KnowledgeRecord, "id" | "revision">[]): boolean {
  return records.every((record) => {
    const now = getKnowledge(workspace, record.id);
    return now?.state === "active" && now.revision === record.revision;
  });
}
