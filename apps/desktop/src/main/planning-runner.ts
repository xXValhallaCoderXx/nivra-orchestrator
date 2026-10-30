import { referenceText, type FrozenReferenceContext } from "@nivra/domain";
import { isTerminal, PLANNING_LIMITS, PlanningContext, type BudgetGrant, type PlanningEvidence, type PlanningResult, type PreferenceSnapshot } from "@nivra/domain";
import { resolveCompanionScope } from "./companion-context.ts";
import type { ProjectRecord } from "./host-store.ts";
import { getMission, latestMissionVersion } from "./mission-store.ts";
import { PlanningFailure, type PlanningGeneration } from "./planning-host.ts";
import { planningContextFor } from "./planning-context.ts";
import { refuseCredentials, type KnownSecrets } from "./protect.ts";
import type { EngineSupervisor } from "./supervisor.ts";
import { getTask, listTasks, versionsOf } from "./workspace.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

type Connection = Pick<EngineSupervisor, "call" | "state">;
interface Options {
  references?(taskId: string): FrozenReferenceContext;
  workspace(): WorkspaceDb;
  projects(): readonly ProjectRecord[];
  sharingEpoch(id: string): number;
  preferences(projectId: string | null): PreferenceSnapshot;
  secrets(): Promise<KnownSecrets>;
  connect(targetId: string): Promise<Connection>;
  grant(requestId: string, targetId: string, homeId: string, projectId: string | null, taskId: string | null, maxRequests: number): BudgetGrant;
  reconcile(): Promise<unknown>;
}
const delay = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new PlanningFailure("Planning was cancelled. Your saved brief remains available.")); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
  const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new PlanningFailure("Planning was cancelled. Your saved brief remains available.")); };
  const timer = setTimeout(done, 100);
  signal.addEventListener("abort", abort, { once: true });
});

/** The transport owns no durable content; reviewed results are acknowledged only after the host saves them. */
export class PlanningRunner {
  readonly #options: Options;
  readonly #results = new Map<string, { connection: Connection; runId: string; dispose(): void }>();
  readonly #active = new Map<string, { connection: Connection; homeId: string }>();
  constructor(options: Options) { this.#options = options; }
  async cancel(operationId: string): Promise<void> {
    const active = this.#active.get(operationId);
    const connection = active?.connection;
    if (!active || !connection) return;
    if (connection.state.status !== "online" || connection.state.info.homeId !== active.homeId) throw new PlanningFailure("The original planning engine is unavailable, so its cancellation couldn't be confirmed. Reconnect that engine or restart it before removing this project.");
    await connection.call("planning.end", { operationId });
    this.#results.get(operationId)?.dispose();
    this.#results.delete(operationId);
    this.#active.delete(operationId);
  }
  async acknowledge(operationId: string): Promise<void> {
    const result = this.#results.get(operationId);
    if (!result) return;
    await result.connection.call("planning.ack", { runId: result.runId, operationId });
    result.dispose(); this.#results.delete(operationId); this.#active.delete(operationId);
  }
  async checkEvidence(project: ProjectRecord, evidence: PlanningEvidence): Promise<void> {
    const epoch = this.#options.sharingEpoch(project.id);
    const connection = await this.#options.connect(project.targetId);
    const current = this.#options.projects().find((candidate) => candidate.id === project.id);
    if (!current || current.targetId !== project.targetId || this.#options.sharingEpoch(project.id) !== epoch) throw new PlanningFailure("This project changed while its evidence was checked. Review the current project before saving.");
    const checked = await connection.call("planning.validateEvidence", { repoPath: current.nativePath, evidence });
    if (!checked.current) throw new PlanningFailure(checked.reason ?? "Repository evidence changed. Refresh the assessment and review a new version.");
  }
  async generate(input: PlanningGeneration): Promise<PlanningResult> {
    if (this.#active.size >= 32) throw new PlanningFailure("Too many planning operations are awaiting completion or cleanup. Finish or stop existing planning work before requesting another pass.");
    const { view, operationId, signal, assertCurrent } = input;
    const project = view.request.projectId ? this.#options.projects().find((candidate) => candidate.id === view.request.projectId) : null;
    const epoch = project ? this.#options.sharingEpoch(project.id) : null;
    const known = await this.#options.secrets();
    if (!known.some(([name, value]) => name === "NEBIUS_API_KEY" && value.length > 0)) throw new PlanningFailure("Add a Token Factory key in Settings to use Planning AI. Manual planning and draft saves remain available.");
    assertCurrent();
    await this.#options.reconcile();
    assertCurrent();
    const connection = await this.#options.connect(project?.targetId ?? "local");
    assertCurrent(); // startup is asynchronous: the original sharing epoch must still authorise this work.
    const state = connection.state;
    if (state.status !== "online") throw new PlanningFailure("The planning engine isn't available. Recheck its target; manual planning remains available.");
    const homeId = state.info.homeId;
    const current = () => {
      assertCurrent();
      if (connection.state.status !== "online" || connection.state.info.homeId !== homeId) throw new PlanningFailure("The planning engine changed. Its request will not be replayed; review the saved brief before requesting another pass.");
    };
    const workspace = this.#options.workspace();
    const { resolved, knowledge } = planningContextFor(workspace, this.#options.projects(), view.request);
    const mission = view.request.missionId ? getMission(workspace, view.request.missionId) : null;
    const missionVersion = mission ? latestMissionVersion(workspace, mission.id) : null;
    const tasks = listTasks(workspace).filter((task) => task.projectId === view.request.projectId && !view.saved.some((saved) => saved.taskId === task.id)).slice(0, 20).map((task) => {
      const brief = versionsOf(workspace, task.id).at(-1);
      const content = brief?.content as { goal?: string } | undefined;
      const own = resolveCompanionScope(workspace, this.#options.projects(), { kind: "task", id: task.id });
      const state = own.latestAttempt?.pendingDecision === "run-going" ? "active" : own.latestAttempt?.pendingDecision ? "review" : task.state;
      return { id: task.id, title: task.title, revision: task.revision, state, attempt: own.latestAttempt, briefVersion: brief?.version, goal: content?.goal?.slice(0, 500) ?? "" };
    });
    const sourceContent = resolved.brief?.content as { goal?: string; scope?: string; exclusions?: string; acceptanceCriteria?: string[] } | undefined;
    const savedItems = view.saved.slice(-20).map((item) => {
      const task = getTask(workspace, item.taskId);
      const brief = task ? versionsOf(workspace, task.id).at(-1) : null;
      const content = brief?.content as { goal?: string } | undefined;
      const own = task && task.projectId === view.request.projectId ? resolveCompanionScope(workspace, this.#options.projects(), { kind: "task", id: task.id }) : null;
      return { itemId: item.itemId, taskId: item.taskId, briefId: item.briefId, title: own ? task?.title : null, goal: own ? content?.goal?.slice(0, 300) ?? "" : null, revision: own ? task?.revision : null, attempt: own?.latestAttempt ?? null, availability: !task ? "deleted; never recreate this item" : !own ? "moved to another project; content withheld" : "already saved; link rather than duplicate" };
    });
    const native = { source: view.request.source, sourceTask: resolved.task ? { id: resolved.task.id, title: resolved.task.title, briefVersion: resolved.brief?.version, goal: sourceContent?.goal?.slice(0, 2_000), scope: sourceContent?.scope?.slice(0, 1_000), exclusions: sourceContent?.exclusions?.slice(0, 500), acceptanceCriteria: sourceContent?.acceptanceCriteria?.slice(0, 8).map((criterion) => criterion.slice(0, 500)), latestAttempt: resolved.latestAttempt } : null, savedItems, savedItemScope: `Showing ${savedItems.length} of ${view.saved.length} saved mappings. Preserve their item IDs and link existing tasks; do not duplicate, reset or rewrite saved work.`, mission: missionVersion ? { id: mission!.id, version: missionVersion.version, outcome: missionVersion.content.outcome.slice(0, 2_000), constraints: missionVersion.content.constraints.slice(0, 6).map((constraint) => constraint.slice(0, 300)) } : null, tasks, taskScope: "At most twenty native tasks in this planning request's project scope; other projects are not inspected. Brief fields are bounded summaries; pending attempts and decisions take precedence over raw task state.", previousProposal: view.proposal ? { summary: view.proposal.summary.slice(0, 2_000), decisions: view.proposal.decisions.slice(0, 10), questions: view.proposal.questions } : null };
    let snapshot = JSON.stringify(native);
    if (snapshot.length > 32_000) snapshot = JSON.stringify({ ...native, tasks: tasks.slice(0, 5), previousProposal: null, gaps: ["Only the first five native task summaries and the bounded saved-item mappings fit this planning context; the earlier proposal is omitted."] });
    refuseCredentials("The planning context", snapshot, known, "send");
    const references = view.request.source.kind === "task" ? this.#options.references?.(view.request.source.id) : undefined;
    const template = PlanningContext.parse({ ...(references ? { references } : {}), brief: view.request.brief, snapshot, projectId: project?.id ?? null, sharingEpoch: epoch ?? 0, preferences: this.#options.preferences(project?.id ?? null), knowledge, repository: input.inspectRepository && project ? { repoPath: project.nativePath, projectId: project.id, sharingEpoch: epoch } : null, maxRequests: input.inspectRepository ? PLANNING_LIMITS.requests : 1 });
    refuseCredentials("The planning context", JSON.stringify({ ...template, references: undefined }) + referenceText(template.references), known, "send");
    current();
    if (references) workspace.db.prepare("INSERT OR IGNORE INTO task_context_receipts (request_id,task_id,digest,manifest_json) VALUES (?,?,?,?)").run(operationId, references.manifest.taskId, references.digest, JSON.stringify(references.manifest));
    let grant: BudgetGrant;
    try { grant = this.#options.grant(operationId, project?.targetId ?? "local", homeId, project?.id ?? null, view.request.source.kind === "task" ? view.request.source.id : null, input.inspectRepository ? PLANNING_LIMITS.requests : 1); }
    catch (error) { throw new PlanningFailure(error instanceof Error ? error.message : "The shared request allowance couldn't be checked. Review it in Settings; manual planning remains available."); }
    const maxRequests = grant.productive.requests + grant.finalisation.requests;
    const context = { ...template, maxRequests };
    const stop = () => { void connection.call("planning.end", { operationId }).catch(() => undefined); };
    this.#active.set(operationId, { connection, homeId });
    signal.addEventListener("abort", stop, { once: true });
    const dispose = () => signal.removeEventListener("abort", stop);
    const startedAt = performance.now();
    try {
      current();
      let run;
      try { run = await connection.call("runs.start", { clientRequestId: operationId, workflowId: "planning", input: { planningId: view.id, operationId, revision: view.revision, bindingDigest: view.binding }, context, budget: grant }); }
      catch { current(); run = await connection.call("runs.find", { clientRequestId: operationId }); }
      current();
      if (!run) throw new PlanningFailure("The planning request's acknowledgement was lost. It will not be resent; check usage before requesting another pass.");
      input.started({ runId: run.id, maxRequests });
      while (performance.now() - startedAt < PLANNING_LIMITS.totalMs + 10_000) {
        current();
        const pending = await connection.call("planning.pending", { runId: run.id, operationId });
        current();
        if (pending.request !== null) await connection.call("planning.authorize", { runId: run.id, operationId, request: pending.request, sharingEpoch: epoch ?? 0 });
        const status = await connection.call("runs.get", { runId: run.id });
        current();
        if (isTerminal(status.status)) {
          if (status.status !== "succeeded") throw new PlanningFailure("Planning stopped without a valid proposal. Its requests remain accounted for; review the brief before requesting another pass.");
          const result = await connection.call("planning.result", { runId: run.id, operationId });
          current();
          if (!result) throw new PlanningFailure("The temporary planning result is unavailable. Your saved brief remains available and the request will not be replayed.");
          this.#results.set(operationId, { connection, runId: run.id, dispose });
          return result;
        }
        await delay(signal);
      }
      throw new PlanningFailure("Planning reached its time limit. Your saved brief remains available; no request will be replayed.");
    } catch (error) {
      try { await this.cancel(operationId); } catch { /* Keep the original target/home so explicit cancellation can be retried. */ }
      dispose(); throw error;
    }
    finally { void this.#options.reconcile().catch(() => undefined); }
  }
}
