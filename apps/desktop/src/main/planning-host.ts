import { PlanningBrief, PlanningProposal, PlanningRequest, PlanningResult, type PlanningEvidence, type PlanningOperationView, type PlanningSave, type PlanningSavedItem, type PlanningView, type PreferenceSnapshot } from "@nivra/domain";
import { z } from "zod";
import { knowledgeSnapshotFor, resolveCompanionScope } from "./companion-context.ts";
import type { ProjectRecord } from "./host-store.ts";
import { getMission, latestMissionVersion, missionTaskIds } from "./mission-store.ts";
import { getPlanning, getPlanningOperation, insertPlanning, insertPlanningOperation, interruptPlanningOperations, listPlanning, planningDigest, planningSaveReceipt, planningSourcesOf, revisePlanning, savePlanningTasks, updatePlanningOperation, type PlanningRecord } from "./planning-store.ts";
import { refuseCredentials, type KnownSecrets } from "./protect.ts";
import { getArtifact, getTask, listTasks, versionsOf } from "./workspace.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

export interface PlanningGeneration {
  view: PlanningView;
  operationId: string;
  inspectRepository: boolean;
  assertCurrent(): void;
  started(info: { runId: string; maxRequests: number }): void;
  signal: AbortSignal;
}
export interface PlanningHostOptions {
  workspace(): WorkspaceDb;
  projects(): readonly ProjectRecord[];
  sharingEpoch(projectId: string): number;
  secrets(): Promise<KnownSecrets>;
  preferences?(projectId: string | null): PreferenceSnapshot;
  checkEvidence?(project: ProjectRecord, evidence: PlanningEvidence): Promise<void>;
  generate?(input: PlanningGeneration): Promise<PlanningResult>;
  acknowledge?(operationId: string): Promise<void>;
  cancelGeneration?(operationId: string): Promise<void>;
}
/** Nivra-authored actionable failures only. Never construct this from provider/repository error text. */
export class PlanningFailure extends Error {}
const now = () => new Date().toISOString();
const open = (status: PlanningOperationView["status"]) => status === "submitting" || status === "running";
const staleMessage = "The source or supporting records for this proposal changed. Refresh its brief and impact assessment, then review the new version before saving.";
const sharingMessage = "This project's model-context sharing changed or the project was removed. Nothing further will be sent. Review sharing on the project before requesting a new planning pass; manual planning remains available.";
function provisional(proposal: PlanningProposal, repository: boolean): PlanningProposal {
  return { ...proposal, inspection: !repository && proposal.inspection === "greenfield" ? "greenfield" : "provisional", gaps: [...new Set([...proposal.gaps, "The brief or source changed. Repository impact must be reassessed before relying on earlier observations."])].slice(0, 20), impacts: proposal.impacts.map((impact) => impact.evidence === "repository" ? { ...impact, evidence: "inferred", citations: [] } : impact) };
}

/** Host-owned structured planning. The renderer supplies IDs; asynchronous generation never establishes authority. */
export class PlanningHost {
  readonly #options: PlanningHostOptions;
  readonly #active = new Map<string, { planningId: string; projectId: string | null; controller: AbortController }>();
  #cleared = false;
  constructor(options: PlanningHostOptions) {
    this.#options = options;
    interruptPlanningOperations(options.workspace());
  }
  #record(id: string): PlanningRecord {
    const record = getPlanning(this.#options.workspace(), z.uuid().parse(id));
    if (!record) throw new Error("That planning draft is no longer here. Return to Tasks, then choose another draft.");
    return record;
  }
  #project(id: string): ProjectRecord {
    const project = this.#options.projects().find((candidate) => candidate.id === id);
    if (!project) throw new Error("This planning draft's project was removed. Its saved content remains available; start a new repository-free draft or choose an existing project.");
    return project;
  }
  #references(request: PlanningRequest, proposal: PlanningProposal | null, planningId?: string, knownSavedItemIds?: readonly string[]): unknown {
    const workspace = this.#options.workspace();
    const project = request.projectId ? this.#project(request.projectId) : null;
    const mission = request.missionId ? latestMissionVersion(workspace, request.missionId) : null;
    if (request.missionId && !getMission(workspace, request.missionId)) throw new Error("This mission was removed. Open another mission or start a new planning draft.");
    const taskIds = new Set<string>();
    let source: unknown = null;
    if (request.source.kind === "task") {
      const task = getTask(workspace, request.source.id);
      if (!task || task.revision !== request.source.version) throw new Error(staleMessage);
      if (task.projectId !== request.projectId) throw new Error("This source task belongs to a different repository. Open planning from that task's own project.");
      taskIds.add(task.id);
      const resolved = resolveCompanionScope(workspace, this.#options.projects(), { kind: "task", id: task.id });
      source = ["task", task.id, task.revision, resolved.brief ? [resolved.brief.id, resolved.brief.version, resolved.brief.sha256] : null, resolved.latestAttempt];
    } else if (request.source.kind === "mission") {
      const version = latestMissionVersion(workspace, request.source.id);
      if (!version || version.version !== request.source.version || request.missionId !== request.source.id) throw new Error(staleMessage);
      source = ["mission", version.id, version.version, version.sha256];
    } else if (request.source.kind === "plan") {
      const plan = getArtifact(workspace, request.source.id);
      if (!plan || plan.kind !== "plan" || plan.version !== request.source.version || versionsOf(workspace, plan.lineageId).at(-1)?.id !== plan.id) throw new Error(staleMessage);
      const content = plan.content as { projectId?: string | null };
      if ((content.projectId ?? null) !== request.projectId) throw new Error("This saved plan belongs to a different repository. Open it in its own project before planning tasks.");
      source = ["plan", plan.id, plan.version, plan.sha256];
    }
    const savedRows = planningId ? workspace.db.prepare("SELECT item_id,task_id,brief_id,revision FROM planning_task_sources WHERE planning_id=? ORDER BY item_id").all(planningId) : [];
    const ownSaved = new Set(savedRows.map((row) => String(row["task_id"])));
    for (const task of listTasks(workspace).filter((task) => task.projectId === request.projectId && !ownSaved.has(task.id)).slice(0, 20)) taskIds.add(task.id);
    if (request.missionId) for (const id of missionTaskIds(workspace, request.missionId)) {
      const task = getTask(workspace, id);
      if (task && task.projectId === request.projectId && !ownSaved.has(id)) taskIds.add(id);
    }
    for (const item of proposal?.items ?? []) for (const id of item.overlapTaskIds) {
      const task = getTask(workspace, id);
      if (!task || task.projectId !== request.projectId) throw new Error("An overlapping task is missing or belongs to another project. Review the proposal's task links before saving.");
      taskIds.add(id);
    }
    const tasks = [...taskIds].sort().map((id) => {
      const task = getTask(workspace, id)!;
      const brief = versionsOf(workspace, id).at(-1);
      const resolved = resolveCompanionScope(workspace, this.#options.projects(), { kind: "task", id });
      return [id, task.revision, task.state, task.projectId, brief?.id, brief?.sha256, resolved.latestAttempt];
    });
    const saved = savedRows.filter((row) => knownSavedItemIds === undefined || knownSavedItemIds.includes(String(row["item_id"]))).map((row) => {
      const task = getTask(workspace, String(row["task_id"]));
      const inScope = task?.projectId === request.projectId;
      const brief = inScope ? versionsOf(workspace, task.id).at(-1) : null;
      const latestAttempt = inScope ? resolveCompanionScope(workspace, this.#options.projects(), { kind: "task", id: task.id }).latestAttempt : null;
      return [String(row["item_id"]), String(row["task_id"]), String(row["brief_id"]), Number(row["revision"]), task ? [task.revision, task.state, task.projectId, brief?.id ?? null, brief?.sha256 ?? null, latestAttempt] : null];
    });
    const hint = request.source.kind === "task" ? { kind: "task" as const, id: request.source.id } : project ? { kind: "project" as const, id: project.id } : request.missionId ? { kind: "mission" as const, id: request.missionId } : { kind: "general" as const };
    const resolved = resolveCompanionScope(workspace, this.#options.projects(), hint);
    const knowledge = knowledgeSnapshotFor(workspace, this.#options.projects(), resolved, { forModel: true, includeMission: true }).records.map((record) => [record.id, record.revision]);
    const preferences = this.#options.preferences?.(request.projectId).records.map((record) => [record.id, record.revision]) ?? [];
    return ["nivra.planning-binding.v2", project ? [project.id, project.targetId] : null, source, mission ? [mission.id, mission.version, mission.sha256] : null, tasks, knowledge, preferences, saved];
  }
  #binding(request: PlanningRequest, proposal: PlanningProposal | null, planningId?: string, knownSavedItemIds?: readonly string[]): { references: unknown; binding: string } {
    const references = this.#references(request, proposal, planningId, knownSavedItemIds);
    return { references, binding: planningDigest(references) };
  }
  #current(record: PlanningRecord): void {
    // A save adds its own result mappings. They become advice inputs only in the next reviewed/generated version.
    const references = record.references as unknown[];
    const saved = Array.isArray(references[7]) ? references[7] as unknown[][] : [];
    const knownSavedItemIds = saved.map((item) => String(item[0]));
    if (record.binding !== this.#binding(record.request, record.proposal, record.id, knownSavedItemIds).binding) throw new Error(staleMessage);
  }
  #view(record: PlanningRecord): PlanningView {
    const { references: _references, ...view } = record;
    const latest = this.#options.workspace().db.prepare("SELECT id FROM planning_operations WHERE planning_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(record.id);
    view.operation = latest ? getPlanningOperation(this.#options.workspace(), String(latest["id"])) : null;
    try { this.#current(record); } catch (error) { view.stale = error instanceof Error ? error.message : staleMessage; }
    return view;
  }
  get(id: string): PlanningView { return this.#view(this.#record(id)); }
  list(projectId?: string | null): PlanningView[] {
    return listPlanning(this.#options.workspace()).filter((record) => projectId === undefined || record.request.projectId === projectId).map((record) => this.#view(record));
  }
  sourcesOf(taskId: string) { return planningSourcesOf(this.#options.workspace(), taskId); }
  async create(input: PlanningRequest): Promise<PlanningView> {
    const request = PlanningRequest.parse(input);
    const known = await this.#options.secrets();
    refuseCredentials("The planning brief", JSON.stringify(request), known);
    const binding = this.#binding(request, null);
    return this.#view(insertPlanning(this.#options.workspace(), request, binding.binding, binding.references, now()));
  }
  async revise(id: string, revision: number, input: { brief: PlanningBrief; proposal: PlanningProposal | null; refresh?: boolean }): Promise<PlanningView> {
    const brief = PlanningBrief.parse(input.brief);
    let proposal = input.proposal === null ? null : PlanningProposal.parse(input.proposal);
    const known = await this.#options.secrets();
    refuseCredentials("The reviewed plan", JSON.stringify({ brief, proposal }), known);
    return this.#options.workspace().tx(() => {
      const record = this.#record(id);
      if (record.revision !== revision) throw new Error("This planning draft changed. Open its latest version before editing.");
      const request = { ...record.request, brief };
      if (input.refresh) {
        const source = request.source;
        if (source.kind === "task") request.source = { ...source, version: getTask(this.#options.workspace(), source.id)?.revision ?? source.version };
        if (source.kind === "mission") request.source = { ...source, version: latestMissionVersion(this.#options.workspace(), source.id)?.version ?? source.version };
        if (source.kind === "plan") {
          const old = getArtifact(this.#options.workspace(), source.id);
          const latest = old ? versionsOf(this.#options.workspace(), old.lineageId).at(-1) : null;
          if (latest) request.source = { ...source, id: latest.id, version: latest.version };
        }
      } else this.#current(record);
      const decisionsChanged = record.proposal !== null && planningDigest([proposal?.decisions ?? [], proposal?.uncertainties ?? [], proposal?.questions ?? []]) !== planningDigest([record.proposal.decisions, record.proposal.uncertainties, record.proposal.questions]);
      const changed = input.refresh || decisionsChanged || planningDigest(brief) !== planningDigest(record.request.brief);
      if (changed && proposal) proposal = provisional(proposal, request.projectId !== null);
      const evidence = changed ? null : record.evidence;
      this.#checkProposalEvidence(proposal, evidence);
      const bound = this.#binding(request, proposal, id);
      return this.#view(revisePlanning(this.#options.workspace(), id, revision, { request, proposal, evidence, ...bound }, now()));
    });
  }
  #checkProposalEvidence(proposal: PlanningProposal | null, evidence: PlanningEvidence | null): void {
    for (const impact of proposal?.impacts ?? []) if (impact.evidence === "repository") for (const citation of impact.citations) {
      if (!evidence?.files.some((file) => file.path === citation.path && file.sha256 === citation.sha256 && file.revision === citation.revision && file.startLine <= citation.startLine && file.endLine >= citation.endLine)) throw new Error("An observed impact has no checked source evidence. Refresh repository inspection, or label it as a provisional inference before saving.");
    }
  }
  async save(input: PlanningSave): Promise<PlanningSavedItem[]> {
    z.uuid().parse(input.id);
    z.uuid().parse(input.key);
    const fingerprint = planningDigest([input.id, input.revision, [...input.itemIds].sort()]);
    const workspace = this.#options.workspace();
    const receipt = planningSaveReceipt(workspace, input.key, fingerprint);
    if (receipt) return receipt;
    const record = this.#record(input.id);
    const known = await this.#options.secrets();
    refuseCredentials("The reviewed plan", JSON.stringify(record.proposal), known);
    this.#current(record);
    this.#checkProposalEvidence(record.proposal, record.evidence);
    if (record.evidence && (record.evidence.files.length || record.evidence.searches.length || record.evidence.inventory.length) && record.request.projectId) {
      if (!this.#options.checkEvidence) throw new Error("Repository evidence couldn't be checked. Refresh the impact assessment, or save a new provisional version manually.");
      await this.#options.checkEvidence(this.#project(record.request.projectId), record.evidence);
    }
    return savePlanningTasks(workspace, { ...input, fingerprint }, (current) => this.#current(current), now());
  }
  async generate(id: string, revision: number, input: { inspectRepository: boolean; operationId: string }): Promise<PlanningOperationView> {
    z.uuid().parse(input.operationId);
    const fingerprint = planningDigest([id, revision, input.inspectRepository]);
    const workspace = this.#options.workspace();
    const existing = getPlanningOperation(workspace, input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.planningId !== id) throw new Error("This planning operation ID was already used for different work. Request a new pass explicitly.");
      return existing;
    }
    const record = this.#record(id);
    if (record.revision !== revision) throw new Error("This planning draft changed. Review its latest version before generating.");
    if (this.#active.size >= 32) throw new PlanningFailure("Too many planning passes are pending. Finish or cancel existing passes before requesting another one; manual planning remains available.");
    this.#current(record);
    if (!this.#options.generate) throw new Error("Planning AI isn't available yet. Edit the brief and proposal manually, or try again after its setup is available.");
    const project = record.request.projectId ? this.#project(record.request.projectId) : null;
    if (input.inspectRepository && !project) throw new Error("Choose a project before inspecting repository impact. Repository-free planning remains available.");
    const epoch = project ? this.#options.sharingEpoch(project.id) : null;
    const generationBinding = this.#binding(record.request, record.proposal, record.id).binding;
    const repositoryBound = project !== null;
    if (repositoryBound && !project?.sharing.modelContext) throw new Error(sharingMessage);
    const controller = new AbortController();
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error("This planning pass was cancelled. Request a new pass explicitly if needed.");
      const current = this.#record(id);
      if (current.revision !== revision || current.binding !== record.binding) throw new Error(staleMessage);
      this.#current(current);
      if (this.#binding(current.request, current.proposal, current.id).binding !== generationBinding) throw new Error(staleMessage);
      if (repositoryBound && project) {
        const latest = this.#options.projects().find((candidate) => candidate.id === project.id);
        if (!latest?.sharing.modelContext || this.#options.sharingEpoch(project.id) !== epoch) throw new Error(sharingMessage);
      }
    };
    const known = await this.#options.secrets();
    refuseCredentials("The planning brief", JSON.stringify(record.request), known, "send");
    assertCurrent();
    if (this.#active.size >= 32) throw new PlanningFailure("Too many planning passes are pending. Finish or cancel existing passes before requesting another one; manual planning remains available.");
    const duplicate = getPlanningOperation(workspace, input.operationId);
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new Error("This planning operation ID was already used for different work.");
      return duplicate;
    }
    if (workspace.db.prepare("SELECT 1 FROM planning_operations WHERE planning_id=? AND status IN ('submitting','running')").get(id)) throw new Error("A planning pass is already running for this draft. Wait for it or cancel it first.");
    insertPlanningOperation(workspace, { id: input.operationId, planningId: id, revision, fingerprint, maxRequests: input.inspectRepository ? 8 : 1 }, now());
    this.#active.set(input.operationId, { planningId: id, projectId: project?.id ?? null, controller });
    void this.#finish(record, input.operationId, input.inspectRepository, generationBinding, assertCurrent, controller);
    return this.operation(id, input.operationId);
  }
  async #finish(record: PlanningRecord, operationId: string, inspectRepository: boolean, generationBinding: string, assertCurrent: () => void, controller: AbortController): Promise<void> {
    const workspace = this.#options.workspace();
    let keepForStop = false;
    try {
      const result = PlanningResult.parse(await this.#options.generate!({ view: { ...this.#view(record), binding: generationBinding }, operationId, inspectRepository, assertCurrent, signal: controller.signal, started: (info) => { assertCurrent(); updatePlanningOperation(workspace, operationId, "running", null, info); } }));
      const known = await this.#options.secrets();
      refuseCredentials("The planning result", JSON.stringify(result), known);
      assertCurrent();
      this.#checkProposalEvidence(result.proposal, result.evidence);
      workspace.tx(() => {
        assertCurrent();
        const bound = this.#binding(record.request, result.proposal, record.id);
        revisePlanning(workspace, record.id, record.revision, { request: record.request, proposal: result.proposal, evidence: inspectRepository ? result.evidence : null, ...bound }, now());
        updatePlanningOperation(workspace, operationId, "succeeded", result.exploration || null);
      });
      if (this.#options.acknowledge) {
        try { await this.#options.acknowledge(operationId); }
        catch { workspace.db.prepare("UPDATE planning_operations SET message=? WHERE id=? AND status='succeeded'").run("The plan was saved. Temporary result cleanup couldn't be confirmed; the request will not be sent again.", operationId); }
      }
    } catch (error) {
      if (this.#cleared) return;
      let stopFailed = false;
      try { await this.#options.cancelGeneration?.(operationId); } catch { stopFailed = true; }
      keepForStop = stopFailed;
      if (this.#cleared) return;
      updatePlanningOperation(workspace, operationId, stopFailed ? "unknown" : controller.signal.aborted ? "cancelled" : "failed", stopFailed ? "No result was retained, but Nivra couldn't confirm the engine stopped. Review engine status before requesting another pass; uncertain requests remain counted." : controller.signal.aborted ? "Planning was cancelled. Its saved brief is unchanged; no late result was retained." : error instanceof PlanningFailure ? error.message : "Planning couldn't finish or its context changed. Review the saved brief and sharing settings before explicitly requesting another pass.");
    } finally { if (!keepForStop) this.#active.delete(operationId); }
  }
  operation(id: string, operationId: string): PlanningOperationView {
    this.#record(id);
    const operation = getPlanningOperation(this.#options.workspace(), z.uuid().parse(operationId));
    if (!operation || operation.planningId !== id) throw new Error("That planning operation belongs to another draft or is no longer available.");
    return operation;
  }
  async cancel(id: string, operationId: string): Promise<void> {
    const operation = this.operation(id, operationId);
    if (!open(operation.status) && !this.#active.has(operationId)) return;
    this.#active.get(operationId)?.controller.abort();
    updatePlanningOperation(this.#options.workspace(), operationId, "cancelled", "Planning was cancelled. No late result will be retained.");
    try { await this.#options.cancelGeneration?.(operationId); }
    catch { throw new PlanningFailure("Planning's result was discarded, but Nivra couldn't confirm its engine stopped. Reconnect the project's engine, then cancel again before removing it."); }
  }
  async invalidateProject(projectId: string): Promise<void> {
    const stops: Array<Promise<void>> = [];
    for (const [operationId, active] of this.#active) if (active.projectId === projectId) {
      active.controller.abort();
      updatePlanningOperation(this.#options.workspace(), operationId, "cancelled", sharingMessage);
      if (this.#options.cancelGeneration) stops.push(this.#options.cancelGeneration(operationId));
    }
    const results = await Promise.allSettled(stops);
    if (results.some((result) => result.status === "rejected")) throw new PlanningFailure("Planning's late results were discarded, but Nivra couldn't confirm every engine stopped. Reconnect the project's engine and retry before removing it.");
  }
  clear(): void {
    this.#cleared = true;
    for (const active of this.#active.values()) active.controller.abort();
    this.#active.clear();
    interruptPlanningOperations(this.#options.workspace());
  }
}
