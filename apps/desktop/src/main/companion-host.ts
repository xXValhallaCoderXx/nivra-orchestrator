import { randomUUID } from "node:crypto";
import { COMPANION_LIMITS, CompanionContext, CompanionResult, type BudgetGrant, type KnowledgeRecord, type KnowledgeScope, type PreferenceSnapshot, type RunSummary } from "@nivra/domain";
import type { BriefFields, CompanionAction, CompanionContextView, CompanionHint, CompanionScope, CompanionSettingsView, CompanionTurnView, KnowledgeView, MissionView, ProjectInspectionView, TaskView } from "../shared/ipc.ts";
import { knowledgeSnapshotFor, resolveCompanionScope, validateKnowledgeForScope, type ResolvedCompanionScope } from "./companion-context.ts";
import { companionSaveFingerprint } from "./companion-saves.ts";
import type { ProjectRecord } from "./host-store.ts";
import { editKnowledge, forgetKnowledge, knowledgeEpoch, listKnowledge, saveKnowledge, validateKnowledgeQuote } from "./knowledge-store.ts";
import { refuseCredentials, type KnownSecrets } from "./protect.ts";
import type { NewPreference } from "./preferences.ts";
import type { EngineSupervisor } from "./supervisor.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

/** Enabled only once the mocked-provider privacy and guarded-budget checks pass. */
export const COMPANION_AI_ENABLED = true;
type Connection = Pick<EngineSupervisor, "call" | "state">;
type Draft = { title: string; outcome?: string; goal?: string; scope?: string; acceptance?: string[] };
export interface CompanionDraftSave { sessionId: string; requestId: string; actionId: string; fingerprint: string; draft: Draft }
export interface CompanionHostOptions {
  workspace(): WorkspaceDb;
  projects(): readonly ProjectRecord[];
  preferences(projectId: string | null): PreferenceSnapshot;
  preferenceRevision(): number;
  sharingEpoch(projectId: string): number;
  secrets(): Promise<KnownSecrets>;
  connect(targetId: string): Promise<Connection>;
  grant(requestId: string, targetId: string, homeId: string, projectId: string | null, taskId: string | null): BudgetGrant;
  reconcileBudget(): Promise<unknown>;
  budgetStatus(): Promise<{ blocked: string | null }>;
  settings(): CompanionSettingsView;
  setSettings(value: Partial<CompanionSettingsView>): CompanionSettingsView;
  createMission(content: { name: string; outcome: string; intendedUsers: string; successCriteria: string[]; constraints: string[]; nonGoals: string[] }, actionId: string, validate: () => void): Promise<MissionView>;
  createMissionTask(missionId: string, title: string, fields: BriefFields, actionId: string, validate: () => void): Promise<MissionView>;
  task(taskId: string): TaskView;
  addPreference(input: NewPreference): unknown;
  enabled?: boolean;
  platform?: NodeJS.Platform;
  engineState?(targetId: string): { status: string; reason?: string };
}
interface Session { id: string; hint: CompanionHint; scopeKey: string; epoch: string; history: Array<{ role: "user" | "assistant"; text: string }>; turns: Map<string, Turn>; ended: boolean; pending: { id: string; digest: string; promise: Promise<{ runId: string; requestId: string }> } | null }
interface Turn { id: string; requestDigest: string; sessionId: string; hint: CompanionHint; message: string; epoch: string; fingerprint: string; targetId: string; homeId: string | null; runId: string | null; view: CompanionTurnView; result: CompanionResult | null; cancelled: boolean; processing: Promise<void> | null; actions: Map<string, { action: CompanionResult["actions"][number]; fingerprint: string }> }

export function companionKnowledgeView(record: KnowledgeRecord): KnowledgeView {
  const source = record.source;
  return { id: record.id, revision: record.revision, statement: record.statement, status: record.state, kind: record.kind, origin: record.origin, sourceLabel: source.kind === "user" ? "Your explicit statement" : source.kind === "record" ? `${source.entity} revision ${source.revision}` : `${source.path} at ${source.revision}` };
}
export function companionScopeOf(scope: KnowledgeScope | null): CompanionScope {
  return !scope ? { kind: "general" } : scope.kind === "project" ? { kind: "project", projectId: scope.id } : scope.kind === "task" ? { kind: "task", taskId: scope.id } : { kind: "mission", missionId: scope.id };
}
export function companionHintOf(scope: CompanionScope): CompanionHint {
  return scope.kind === "general" ? {} : scope.kind === "project" ? { projectId: scope.projectId } : scope.kind === "task" ? { taskId: scope.taskId } : { missionId: scope.missionId };
}
function scopeHint(hint: CompanionHint) {
  return hint.taskId ? { kind: "task" as const, id: hint.taskId } : hint.missionId ? { kind: "mission" as const, id: hint.missionId } : hint.projectId ? { kind: "project" as const, id: hint.projectId } : { kind: "general" as const };
}
const compact = (text: unknown, limit: number): string => typeof text === "string" ? text.slice(0, limit) : "";
const noContentFailure = "The companion couldn't finish this turn. Your saved work is unchanged. Try a new turn when its setup is available.";

/** Temporary sessions only. The dependencies expose native records and named operations, never generic IPC tools. */
export class CompanionHost {
  readonly #options: CompanionHostOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #inspections = new Map<string, ProjectInspectionView>();
  readonly #repositoryRevisions = new Map<string, string>();
  constructor(options: CompanionHostOptions) { this.#options = options; }
  clear(): void {
    for (const session of this.#sessions.values()) { session.ended = true; session.history = []; session.turns.clear(); }
    this.#sessions.clear();
    this.#inspections.clear();
    this.#repositoryRevisions.clear();
  }

  #current(hint: CompanionHint) {
    const workspace = this.#options.workspace();
    const projects = this.#options.projects();
    const resolved = resolveCompanionScope(workspace, projects, scopeHint(hint));
    if (hint.taskId && hint.missionId && resolved.mission?.record.id !== hint.missionId) throw new Error("That task is no longer in this mission. Open the task again before asking the companion.");
    const knowledge = knowledgeSnapshotFor(workspace, projects, resolved, { forModel: true, repositoryRevisions: this.#repositoryRevisions });
    const preferences = this.#options.preferences(resolved.project?.id ?? null);
    const epoch = companionSaveFingerprint([companionScopeOf(resolved.scope), resolved.projectId, this.#options.preferenceRevision(), knowledge.epoch, resolved.projectId ? this.#options.sharingEpoch(resolved.projectId) : 0]);
    const inspection = resolved.project ? this.#inspections.get(resolved.project.id) : null;
    return { resolved, knowledge, preferences, epoch, fingerprint: companionSaveFingerprint([resolved.binding, epoch, knowledge.digest, inspection ?? null]) };
  }

  async context(hint: CompanionHint): Promise<CompanionContextView> {
    const current = this.#current(hint);
    const { resolved } = current;
    const known = await this.#options.secrets();
    let budgetBlocked: string | null = null;
    try { budgetBlocked = (await this.#options.budgetStatus()).blocked; } catch { budgetBlocked = "The companion allowance couldn't be checked. Open Settings to review its budget; manual planning remains available."; }
    const now = this.#current(hint);
    if (current.fingerprint !== now.fingerprint) return this.context(hint);
    const blockers: CompanionContextView["blockers"] = [];
    if (resolved.missingProject) blockers.push({ id: "removed-project", title: "Repository removed", detail: "Planning remains saved. Choose a repository on the task before running it.", action: null });
    if (resolved.task) {
      const blocked = this.#options.task(resolved.task.id).runBlocked;
      if (blocked) blockers.push({ id: "task-run", title: "Before running this task", detail: blocked, action: null });
    } else if (resolved.project?.targetId === "local" && this.#options.platform === "win32") blockers.push({ id: "windows-execution", title: "Execution needs a supported target", detail: "Native Windows projects support planning and reading. Coding execution needs a supported Linux or WSL project target; Nivra won't move this project automatically.", action: null });
    if (resolved.project) {
      const engine = this.#options.engineState?.(resolved.project.targetId);
      if (engine && engine.status !== "online") blockers.push({ id: "engine", title: engine.status === "failed" ? "The project's engine is unavailable" : engine.status === "starting" ? "The project's engine is starting" : "The project's engine hasn't been checked", detail: engine.reason ?? "Recheck this project's owning target. Manual planning remains available while its engine is offline.", action: "recheck" });
      const check = this.#inspections.get(resolved.project.id);
      if (!check) blockers.push({ id: "unchecked", title: "Project setup hasn't been checked", detail: "Recheck Git and the committed baseline on this project's target. Planning is available now.", action: "recheck" });
      else if (check.git.status !== "available") blockers.push({ id: "git", title: "Git needs attention", detail: check.git.message, action: "recheck" });
      else if (check.repository.status !== "ready") blockers.push({ id: "baseline", title: "A committed baseline is needed to execute", detail: check.repository.message, action: "recheck" });
      if (!resolved.environment?.prepared) blockers.push({ id: "environment", title: "Check the task's environment needs", detail: "Open Environment to inspect the declared runtime and package manager. Dependency-free tasks may not need preparation.", action: "environment" });
      else if (resolved.environment.prepared.verified.builds.state !== "complete" && (!resolved.environment.builds || resolved.environment.builds.verified !== resolved.environment.prepared.verifiedDigest || !resolved.environment.prepared.verified.builds.missing.every((name) => resolved.environment!.builds!.missing.includes(name)))) blockers.push({ id: "environment-builds", title: "Review skipped dependency builds", detail: "Preparation left missing or unknown dependency builds. Review their recorded state in Environment before using it for a run.", action: "environment" });
      if (!resolved.project.sharing.modelContext) blockers.push({ id: "sharing", title: "AI sharing is off for this project", detail: "Allow sharing when you choose an AI action. Manual planning remains available.", action: "settings" });
    }
    const hasKey = known.some(([name, value]) => name === "NEBIUS_API_KEY" && value.length > 0);
    if (!hasKey) blockers.push({ id: "key", title: "AI assistance needs a provider key", detail: "Add a Token Factory key in Settings to ask AI. A saved key does not prove provider access; manual guidance works now.", action: "settings" });
    const enabled = this.#options.enabled ?? COMPANION_AI_ENABLED;
    const askBlocked = !enabled ? "Companion AI is awaiting its privacy and budget verification. Manual guidance and saving work are available." : !hasKey ? "Add a Token Factory key in Settings to ask AI, or continue manually." : resolved.missingProject ? "This task's repository was removed. Choose a repository or none before asking AI." : resolved.project && !resolved.project.sharing.modelContext ? "Allow model sharing for this project before asking AI." : budgetBlocked;
    const sources: CompanionContextView["sources"] = [];
    if (resolved.project) sources.push({ kind: "project", id: resolved.project.id, label: resolved.project.label, revision: resolved.project.addedAt });
    if (resolved.task && resolved.brief) sources.push({ kind: "task", id: resolved.task.id, label: `${resolved.task.title} · brief v${resolved.brief.version}`, revision: resolved.task.revision });
    if (resolved.mission) sources.push({ kind: "mission", id: resolved.mission.record.id, label: `${resolved.mission.version.content.name} · v${resolved.mission.version.version}`, revision: resolved.mission.version.version });
    if (resolved.latestAttempt) sources.push({ kind: "run", id: resolved.latestAttempt.id, label: `Latest attempt · ${resolved.latestAttempt.status}${resolved.latestAttempt.pendingDecision ? ` · ${resolved.latestAttempt.pendingDecision.replaceAll("-", " ")}` : ""}`, revision: `${resolved.latestAttempt.status}:${resolved.latestAttempt.decision ?? "undecided"}:${resolved.latestAttempt.accepted}` });
    if (resolved.environment && resolved.project) sources.push({ kind: "environment", id: resolved.project.id, label: resolved.environment.prepared ? "Last prepared environment" : "Saved environment choices", revision: resolved.environment.updatedAt });
    const scopes = [resolved.scope, ...(resolved.task && resolved.project ? [{ kind: "project" as const, id: resolved.project.id }] : [])].filter((scope): scope is KnowledgeScope => scope !== null);
    const knowledge = scopes.flatMap((scope) => listKnowledge(this.#options.workspace(), scope)).filter((record) => record.projectId === null || record.projectId === resolved.projectId).map(companionKnowledgeView);
    return { scope: companionScopeOf(resolved.scope), fingerprint: current.fingerprint, dialogueEpoch: current.epoch, label: resolved.task?.title ?? resolved.mission?.version.content.name ?? resolved.project?.label ?? "General planning", sources, blockers, knowledge, canAsk: askBlocked === null, askBlocked, sharingRequired: resolved.project !== null && !resolved.project.sharing.modelContext, projectId: resolved.projectId };
  }

  async inspect(projectId: string): Promise<ProjectInspectionView> {
    const project = this.#options.projects().find((one) => one.id === projectId);
    if (!project) throw new Error("That project was removed. Return to Home, then choose a project.");
    const connection = await this.#options.connect(project.targetId);
    if (!this.#options.projects().some((one) => one.id === projectId && one.targetId === project.targetId && one.nativePath === project.nativePath)) throw new Error("The project changed during its check. Open it again, then recheck.");
    const facts = await connection.call("repository.inspect", { repoPath: project.nativePath });
    if (!this.#options.projects().some((one) => one.id === projectId && one.targetId === project.targetId && one.nativePath === project.nativePath)) throw new Error("The project was removed during its check. Return to Home.");
    const view: ProjectInspectionView = { projectId, checkedAt: facts.checkedAt,
      git: { status: facts.git.available ? "available" : "missing", version: facts.git.version, message: facts.git.available ? `${facts.git.version?.replace(/^git /, "Git ") ?? "Git is available"} on this project's target.` : "Git isn't available on this project's target. Install Git there using your preferred tool, then press Recheck. A Git GUI is optional." },
      repository: { status: facts.folder !== "available" || facts.repository === "unknown" ? "unavailable" : facts.repository === "not-repository" ? "not-repository" : facts.baseline ? "ready" : "no-commits", head: facts.baseline,
        message: facts.folder !== "available" ? "The project's folder can't be reached. Check its target and folder, then press Recheck." : facts.repository === "not-repository" ? "This folder isn't a Git repository. Initialise it using your preferred Git tool, or choose another folder. Planning remains available." : !facts.baseline ? "This repository has no usable commit. Make its first commit using your preferred Git tool, then press Recheck." : facts.changes ? "Tracked changes prevent execution snapshots. Commit them or set them aside using your preferred Git tool, then recheck. Untracked files are excluded from execution." : "A committed baseline is available. The run preview checks it again before execution." } };
    this.#inspections.set(projectId, view);
    if (facts.baseline) this.#repositoryRevisions.set(projectId, facts.baseline); else this.#repositoryRevisions.delete(projectId);
    return view;
  }

  #session(id: string, hint: CompanionHint): Session {
    const current = this.#current(hint);
    const scopeKey = JSON.stringify(companionScopeOf(current.resolved.scope));
    let session = this.#sessions.get(id);
    if (session?.ended) throw new Error("This companion conversation ended. Open a new conversation to continue.");
    if (session && session.scopeKey !== scopeKey) throw new Error("This companion conversation belongs to other work. Start a new conversation for this scope.");
    if (!session) {
      if (this.#sessions.size >= 8) throw new Error("Eight temporary companion conversations are open. End one before starting another.");
      session = { id, hint, scopeKey, epoch: current.epoch, history: [], turns: new Map(), ended: false, pending: null };
      this.#sessions.set(id, session);
    }
    if (session.epoch !== current.epoch) {
      session.history = [];
      session.epoch = current.epoch;
      for (const turn of session.turns.values()) {
        turn.cancelled = true;
        turn.message = "";
        turn.result = null;
        turn.actions.clear();
        turn.view = { status: "interrupted", message: "The saved work or knowledge changed. The temporary context was cleared; ask again using the current records." };
      }
    }
    return session;
  }

  #snapshot(resolved: ResolvedCompanionScope): string {
    const content = resolved.brief?.content as Record<string, unknown> | undefined;
    return JSON.stringify({ scope: companionScopeOf(resolved.scope),
      project: resolved.project ? { id: resolved.project.id, label: resolved.project.label, targetId: resolved.project.targetId, sharing: resolved.project.sharing } : null,
      task: resolved.task ? { id: resolved.task.id, title: resolved.task.title, state: resolved.task.state, revision: resolved.task.revision, briefVersion: resolved.brief?.version, goal: compact(content?.["goal"], 4_000), scope: compact(content?.["scope"], 2_000), exclusions: compact(content?.["exclusions"], 2_000), criteria: Array.isArray(content?.["acceptanceCriteria"]) ? content["acceptanceCriteria"].slice(0, 12).map((one) => compact(one, 500)) : [] } : null,
      latestAttempt: resolved.latestAttempt,
      executionBlocker: resolved.task ? this.#options.task(resolved.task.id).runBlocked : null,
      mission: resolved.mission ? { id: resolved.mission.record.id, version: resolved.mission.version.version, name: resolved.mission.version.content.name, outcome: compact(resolved.mission.version.content.outcome, 4_000), constraints: resolved.mission.version.content.constraints.slice(0, 8).map((one) => compact(one, 500)) } : null,
      environment: resolved.environment ? { prepared: resolved.environment.prepared !== null, legacy: resolved.environment.legacy, updatedAt: resolved.environment.updatedAt,
        verifiedTools: resolved.environment.prepared?.verified.tools ?? [], recipeDigest: resolved.environment.prepared?.recipeDigest ?? null,
        builds: resolved.environment.prepared?.verified.builds.state ?? null, buildAcceptanceMatches: Boolean(resolved.environment.builds && resolved.environment.prepared && resolved.environment.builds.verified === resolved.environment.prepared.verifiedDigest),
        scope: resolved.environment.prepared?.recipe.scope ?? null } : null,
      setup: resolved.project ? this.#inspections.get(resolved.project.id) ?? "Not checked" : null,
      limits: "Relevant saved fields only; long fields may be shortened. No repository files or unsent forms are included." });
  }

  async send(input: { sessionId: string; clientRequestId: string; hint: CompanionHint; message: string }): Promise<{ runId: string; requestId: string }> {
    const session = this.#session(input.sessionId, input.hint);
    const requestDigest = companionSaveFingerprint([session.scopeKey, input.message.trim()]);
    if (session.pending) {
      if (session.pending.id !== input.clientRequestId) throw new Error("A companion turn is already being prepared. Wait for it before sending another.");
      if (session.pending.digest !== requestDigest) throw new Error("This request id was already used for another message. Start a new turn for the changed message.");
      return session.pending.promise;
    }
    const existing = session.turns.get(input.clientRequestId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error("This request id was already used for another message. Start a new turn for the changed message.");
      return { runId: existing.runId ?? existing.id, requestId: existing.id };
    }
    if ([...session.turns.values()].some((turn) => turn.view.status === "running" || turn.view.status === "unknown")) throw new Error("The companion is still answering or reconciling this conversation. Wait for it or end it before sending another turn.");
    const promise = this.#send(session, input, requestDigest).finally(() => { if (session.pending?.id === input.clientRequestId) session.pending = null; });
    session.pending = { id: input.clientRequestId, digest: requestDigest, promise };
    return promise;
  }

  async #send(session: Session, input: { sessionId: string; clientRequestId: string; hint: CompanionHint; message: string }, requestDigest: string): Promise<{ runId: string; requestId: string }> {
    const preview = await this.context(input.hint);
    if (!preview.canAsk) throw new Error(preview.askBlocked ?? noContentFailure);
    const current = this.#current(input.hint);
    const known = await this.#options.secrets();
    const message = input.message.trim();
    if (!message || message.length > COMPANION_LIMITS.messageChars) throw new Error("Type a message of at most 8,000 characters, then send it.");
    refuseCredentials("Your companion message", message, known, "send");
    const snapshot = this.#snapshot(current.resolved);
    const context = CompanionContext.parse({ preferences: current.preferences, sharing: { modelContext: current.resolved.project?.sharing.modelContext ?? false }, message, history: session.history, snapshot, knowledge: current.knowledge });
    refuseCredentials("The companion context", JSON.stringify(context), known, "send");
    const connection = await this.#options.connect(current.resolved.targetId);
    const state = connection.state;
    if (state.status !== "online") throw new Error("The project's engine isn't available. Recheck its target, then ask again.");
    if (this.#current(input.hint).fingerprint !== current.fingerprint || session.epoch !== current.epoch || session.ended) throw new Error("The current work changed before sending. Refresh the companion, then ask again.");
    const budget = this.#options.grant(input.clientRequestId, current.resolved.targetId, state.info.homeId, current.resolved.projectId, current.resolved.task?.id ?? null);
    const turn: Turn = { id: input.clientRequestId, requestDigest, sessionId: input.sessionId, hint: input.hint, message, epoch: current.epoch, fingerprint: current.fingerprint, targetId: current.resolved.targetId, homeId: state.info.homeId, runId: null, view: { status: "running" }, result: null, cancelled: false, processing: null, actions: new Map() };
    session.turns.set(turn.id, turn);
    while (session.turns.size > 24) {
      const oldest = session.turns.keys().next().value;
      if (!oldest || oldest === turn.id) break;
      session.turns.delete(oldest);
    }
    try {
      const run = await connection.call("runs.start", { clientRequestId: turn.id, workflowId: "companion", input: { sessionId: session.id, bindingDigest: current.fingerprint }, context, budget });
      turn.runId = run.id;
      if (session.ended || turn.cancelled || this.#current(turn.hint).epoch !== turn.epoch) await connection.call("runs.cancel", { runId: run.id });
    } catch {
      // An uncertain send is looked up; the original inference request is never retried.
      turn.view = { status: "unknown", message: "The engine's acknowledgement was lost. Nivra will look up this request and will not send it again." };
    }
    return { runId: turn.runId ?? turn.id, requestId: turn.id };
  }

  async turn(sessionId: string, requestId: string): Promise<CompanionTurnView> {
    const session = this.#sessions.get(sessionId);
    if (!session || session.ended) return { status: "interrupted", message: "The temporary conversation is gone. Start a new one; nothing was replayed." };
    const turn = session.turns.get(requestId);
    if (!turn) return { status: "interrupted", message: "That temporary turn is no longer here. Start a new turn." };
    this.#session(sessionId, turn.hint);
    if (!["running", "unknown"].includes(turn.view.status)) return turn.view;
    turn.processing ??= this.#readTurn(session, turn).finally(() => { turn.processing = null; });
    await turn.processing;
    return turn.view;
  }

  async #readTurn(session: Session, turn: Turn): Promise<void> {
    try {
      const connection = await this.#options.connect(turn.targetId);
      const state = connection.state;
      if (state.status !== "online" || state.info.homeId !== turn.homeId) { turn.view = { status: "interrupted", message: "The engine changed. This temporary turn cannot be restored and wasn't replayed." }; return; }
      const run: RunSummary | null = turn.runId ? await connection.call("runs.get", { runId: turn.runId }) : await connection.call("runs.find", { clientRequestId: turn.id });
      if (!run) { turn.view = { status: "unknown", message: "The engine has no confirmed result for this request. It will not be resent automatically." }; return; }
      turn.runId = run.id;
      if (turn.cancelled || session.ended || this.#current(turn.hint).epoch !== turn.epoch) {
        await connection.call("runs.cancel", { runId: run.id });
        turn.view = { status: "cancelled", message: "This turn was stopped because its context ended or changed." };
        return;
      }
      if (run.status === "queued" || run.status === "running") { turn.view = { status: "running" }; return; }
      if (run.status !== "succeeded") { turn.message = ""; turn.view = { status: run.status === "cancelled" ? "cancelled" : "failed", message: noContentFailure }; await this.#options.reconcileBudget(); return; }
      const result = await connection.call("companion.result", { runId: run.id, sessionId: session.id });
      if (!result) { turn.view = { status: "interrupted", message: "The temporary answer is no longer available. Ask a new turn; nothing was replayed." }; await this.#options.reconcileBudget(); return; }
      if (turn.cancelled || session.ended || this.#current(turn.hint).epoch !== turn.epoch) { turn.view = { status: "interrupted", message: "The saved work changed while the answer arrived. Ask again using its current version." }; return; }
      const known = await this.#options.secrets();
      if (turn.cancelled || session.ended || this.#current(turn.hint).epoch !== turn.epoch) { turn.view = { status: "interrupted", message: "The saved work changed before this answer could be used. Ask again with the current records." }; return; }
      const materialChanged = this.#current(turn.hint).fingerprint !== turn.fingerprint;
      // Model text remains temporary; credential-bearing structured saves are refused separately.
      turn.result = CompanionResult.parse(result);
      const retained: KnowledgeView[] = [];
      const proposals: string[] = [];
      for (let index = 0; !materialChanged && index < result.captures.length; index++) {
        const capture = result.captures[index]!;
        try {
          const text = validateKnowledgeQuote(turn.message, { start: capture.start, end: capture.end, text: capture.quote }, known);
          const clear = /(?:^use\b|\b(?:must|shall|will|we(?:'ve| have)? decided|do not|don't|never|always|remember|i prefer|keep my)\b)/i.test(text) && !/\b(?:maybe|perhaps|might|could|unless|if|guess|think|suggest|consider|should we|not sure|instead|replace|override|ignore|rather than)\b/i.test(text);
          const current = this.#current(turn.hint);
          const isPreference = /\b(?:i prefer|my preference|keep my|for all my projects|in every project)\b/i.test(text);
          const personal = isPreference && /\b(?:for all my projects|in every project|always for me|my default)\b/i.test(text);
          const brief = current.resolved.brief?.content as Record<string, unknown> | undefined;
          const briefText = [brief?.["goal"], brief?.["scope"], brief?.["exclusions"], brief?.["context"], ...(Array.isArray(brief?.["assumptions"]) ? brief["assumptions"] : [])].filter((value): value is string => typeof value === "string");
          const authoritative = [...current.knowledge.records.map((record) => record.statement ?? ""), ...current.preferences.records.map((record) => record.statement), ...briefText, ...(current.resolved.mission?.version.content.constraints ?? [])];
          if (!clear || capture.statement.trim() !== text || (!current.resolved.scope && !personal) || companionCaptureConflicts(text, authoritative)) { proposals.push(text); continue; }
          if (isPreference) {
            if (!personal && !current.resolved.project) { proposals.push(text); continue; }
            this.#options.addPreference({ statement: text, scope: personal ? "personal" : "project", projectId: personal ? null : current.resolved.projectId, intent: "default" });
            proposals.push(`Saved as a confirmed ${personal ? "personal" : "project"} preference. View, edit or forget it in Preferences.`);
          } else {
            if (!current.resolved.scope) { proposals.push(text); continue; }
            const input = { scope: current.resolved.scope, projectId: current.resolved.projectId, kind: capture.kind, statement: text, origin: "user-stated" as const, source: { kind: "user" as const, sessionId: session.id, requestId: turn.id } };
            validateKnowledgeForScope(input, current.resolved);
            retained.push(companionKnowledgeView(saveKnowledge(this.#options.workspace(), input, { operationId: captureId(turn.id, index), expectedEpoch: knowledgeEpoch(this.#options.workspace()), known })));
          }
        } catch { proposals.push("A proposed note needs review before it can be retained. No note was saved for that proposal."); }
      }
      // Own selected saves are reflected in the new binding; unrelated intervening changes still invalidate actions.
      const now = this.#current(turn.hint);
      if (!materialChanged) {
        session.epoch = now.epoch;
        turn.epoch = now.epoch;
        turn.fingerprint = now.fingerprint;
      }
      const actions: CompanionAction[] = [];
      for (const action of materialChanged ? [] : result.actions) {
        const id = randomUUID();
        const fingerprint = companionSaveFingerprint([turn.id, id, now.fingerprint, action]);
        turn.actions.set(id, { action, fingerprint });
        if (action.kind === "navigate") {
          if (action.destination === "settings") actions.push({ id, kind: "settings", label: "Open Settings" });
          if (action.destination === "environment" && now.resolved.project) actions.push({ id, kind: "environment", entityId: now.resolved.project.id, label: "Open Environment" });
          if (action.destination === "explain" && now.resolved.project) actions.push({ id, kind: "explain", entityId: now.resolved.project.id, label: "Explain this repository" });
          if (action.destination === "task" && now.resolved.task) actions.push({ id, kind: "open-task", entityId: now.resolved.task.id, label: "Open task" });
          if (action.destination === "mission" && now.resolved.mission) actions.push({ id, kind: "open-mission", entityId: now.resolved.mission.record.id, label: "Open mission" });
        } else {
          const draft: Draft = action.kind === "draft-mission" ? { title: action.title, outcome: action.outcome } : { title: action.title, goal: action.goal, scope: action.scope, acceptance: action.acceptance };
          actions.push({ id, kind: action.kind, label: action.kind === "draft-mission" ? "Review project brief" : "Review draft task", fingerprint, draft } as CompanionAction);
        }
      }
      session.history.push({ role: "user", text: turn.message }, { role: "assistant", text: result.reply.slice(0, 8_000) });
      while (session.history.length > COMPANION_LIMITS.historyMessages || session.history.reduce((total, one) => total + one.text.length, 0) > COMPANION_LIMITS.historyChars) session.history.shift();
      turn.view = { status: "answered", reply: result.reply, actions, ...(materialChanged ? { message: "The saved work changed during this turn. This advice uses the earlier version; ask again before saving its proposals." } : {}), ...(retained.length ? { retained } : {}), ...(proposals.length ? { proposals } : {}), dialogueEpoch: turn.epoch, fingerprint: turn.fingerprint };
      turn.message = "";
      await connection.call("companion.ack", { runId: run.id, sessionId: session.id });
      await this.#options.reconcileBudget();
    } catch { if (turn.view.status !== "answered") turn.view = { status: "unknown", message: "The temporary result couldn't be read. Check again; the model request will not be resent." }; }
  }

  async cancel(sessionId: string, requestId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    const turn = session?.turns.get(requestId);
    if (!turn) return;
    turn.cancelled = true;
    turn.message = "";
    turn.result = null;
    turn.actions.clear();
    session!.history = [];
    if (turn.runId) await (await this.#options.connect(turn.targetId)).call("runs.cancel", { runId: turn.runId });
    turn.view = { status: "cancelled", message: "The companion turn was stopped. Saved work remains available." };
  }

  async end(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.ended = true;
    session.history = [];
    const targets = new Set([...session.turns.values()].map((turn) => turn.targetId));
    const stopped = await Promise.allSettled([...session.turns.values()].map((turn) => this.cancel(sessionId, turn.id)));
    const ended = await Promise.allSettled([...targets].map(async (targetId) => (await this.#options.connect(targetId)).call("companion.end", { sessionId })));
    session.turns.clear();
    this.#sessions.delete(sessionId);
    if ([...stopped, ...ended].some((result) => result.status === "rejected")) throw new Error("The local dialogue was cleared, but an engine couldn't confirm that its temporary turn ended. Restart that engine to stop it.");
  }

  async invalidateProject(projectId: string): Promise<void> {
    this.#inspections.delete(projectId);
    this.#repositoryRevisions.delete(projectId);
    const affected = [...this.#sessions.values()].filter((session) => {
      try { return this.#current(session.hint).resolved.projectId === projectId; } catch { return true; }
    });
    const stopped = await Promise.allSettled(affected.map((session) => this.end(session.id)));
    if (stopped.some((result) => result.status === "rejected")) throw new Error("The companion dialogue was cleared, but its engine couldn't confirm cancellation. Restart the project's engine to stop it.");
  }

  settings(): CompanionSettingsView { return this.#options.settings(); }
  setSettings(value: Partial<CompanionSettingsView>): CompanionSettingsView { return this.#options.setSettings(value); }
  async knowledge(scope: CompanionScope): Promise<KnowledgeView[]> {
    const { resolved } = this.#current(companionHintOf(scope));
    return resolved.scope ? listKnowledge(this.#options.workspace(), resolved.scope).map(companionKnowledgeView) : [];
  }
  async capture(input: { scope: CompanionScope; statement: string; kind: "decision" | "constraint"; sessionId: string }): Promise<KnowledgeView> {
    const hint = companionHintOf(input.scope);
    const before = this.#current(hint);
    const known = await this.#options.secrets();
    const current = this.#current(hint);
    if (!current.resolved.scope || current.epoch !== before.epoch) throw new Error("Choose a current project, task or mission before retaining this note.");
    const operationId = captureId(companionSaveFingerprint([input.sessionId, input.scope, input.kind, input.statement.trim()]), 0);
    const note = { scope: current.resolved.scope, projectId: current.resolved.projectId, kind: input.kind, statement: input.statement, origin: "user-stated" as const, source: { kind: "user" as const, sessionId: input.sessionId, requestId: operationId } };
    validateKnowledgeForScope(note, current.resolved);
    const saved = saveKnowledge(this.#options.workspace(), note, { operationId, expectedEpoch: current.knowledge.epoch, known });
    if (saved.state === "forgotten") throw new Error("This note was forgotten, so the old save action wasn't replayed. Start a new companion conversation if you want to record it again.");
    return companionKnowledgeView(saved);
  }
  async edit(id: string, revision: number, statement: string): Promise<KnowledgeView> {
    const before = knowledgeEpoch(this.#options.workspace());
    const known = await this.#options.secrets();
    return companionKnowledgeView(editKnowledge(this.#options.workspace(), id, revision, statement, { operationId: randomUUID(), expectedEpoch: before, known }));
  }
  async forget(id: string, revision: number): Promise<void> {
    forgetKnowledge(this.#options.workspace(), id, revision, { operationId: randomUUID(), expectedEpoch: knowledgeEpoch(this.#options.workspace()), known: [] });
  }

  async saveDraft(input: CompanionDraftSave): Promise<{ mission?: MissionView; task?: TaskView }> {
    const session = this.#sessions.get(input.sessionId);
    const turn = session?.turns.get(input.requestId);
    const saved = turn?.actions.get(input.actionId);
    if (!session || session.ended || !turn || !saved || saved.fingerprint !== input.fingerprint) throw new Error("That proposed draft is no longer available. Ask the companion again using the current work.");
    const current = this.#current(turn.hint);
    if (current.epoch !== turn.epoch || current.fingerprint !== turn.fingerprint) throw new Error("The work changed after this proposal. Refresh the companion before saving a draft.");
    if (saved.action.kind === "draft-mission") {
      const mission = await this.#options.createMission({ name: input.draft.title, outcome: input.draft.outcome ?? "", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] }, input.actionId, () => this.#validateDraft(turn, session));
      return { mission };
    }
    if (saved.action.kind !== "draft-task" || !current.resolved.mission) throw new Error("Save or choose a mission before creating this first task.");
    const mission = await this.#options.createMissionTask(current.resolved.mission.record.id, input.draft.title, { goal: input.draft.goal ?? "", scope: input.draft.scope ?? "", acceptanceCriteria: input.draft.acceptance ?? [], exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] }, input.actionId, () => this.#validateDraft(turn, session));
    const savedId = this.#options.workspace().db.prepare("SELECT result_id FROM companion_saves WHERE id = ?").get(input.actionId)?.["result_id"];
    return typeof savedId === "string" ? { mission, task: this.#options.task(savedId) } : { mission };
  }

  #validateDraft(turn: Turn, session: Session): void {
    const current = this.#current(turn.hint);
    if (session.ended || turn.cancelled || current.epoch !== turn.epoch || current.fingerprint !== turn.fingerprint) throw new Error("The work changed while this draft was being saved. Refresh the companion, then review the draft again.");
  }
}

/** Stable UUID for one capture, without retaining its wording in an operation record. */
function captureId(requestId: string, index: number): string {
  const hash = companionSaveFingerprint([requestId, "knowledge", index]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Conservative checks for explicit setup choices and opposite wording. Unresolved choices remain proposals. */
export function companionCaptureConflicts(candidate: string, authoritative: readonly string[]): boolean {
  const choices = [/(?:\b)(pnpm|npm|yarn|bun)(?:\b)/gi, /(?:\b)(postgres(?:ql)?|sqlite|mysql|mongodb)(?:\b)/gi, /(?:\b)(offline|online)(?:\b)/gi];
  for (const pattern of choices) {
    const chosen = [...candidate.matchAll(pattern)].map((match) => match[1]!.toLowerCase().replace("postgresql", "postgres"));
    if (new Set(chosen).size > 1) return true;
    if (!chosen.length) continue;
    for (const source of authoritative) {
      const existing = [...source.matchAll(pattern)].map((match) => match[1]!.toLowerCase().replace("postgresql", "postgres"));
      if (existing.some((value) => value !== chosen[0])) return true;
    }
  }
  const normalise = (text: string) => text.toLowerCase().replace(/\b(?:must|shall|will|do|does|not|don't|doesn't|never|always)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const negative = (text: string) => /\b(?:not|don't|doesn't|never)\b/i.test(text);
  return authoritative.some((source) => normalise(source) === normalise(candidate) && negative(source) !== negative(candidate));
}
