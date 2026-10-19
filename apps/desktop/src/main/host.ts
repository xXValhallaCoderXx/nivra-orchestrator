import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  CHAT_LIMITS,
  ErrorCode,
  isTerminal,
  RpcCallError,
  type ChatContext,
  type ChatInput,
  type DoctorReport,
  type ExplainResult,
  type PreferenceIntent,
  type ProviderCheck,
  type RunEventsPage,
  type RunStatus,
  type RunSummary,
  type SecretName,
} from "@nivra/domain";
import type {
  AddProjectResult,
  ConversationScope,
  ConversationsView,
  ConversationSummary,
  ConversationView,
  EngineView,
  ImportEntryView,
  ImportSourceView,
  PreferencesView,
  PreferenceView,
  ProjectView,
  TurnView,
  WorkspaceView,
  WslView,
} from "../shared/ipc.ts";
import { selectHistory } from "./history.ts";
import { migrateHostData, NO_SHARING, type HostStore, type PreferenceRecord, type ProjectRecord } from "./host-store.ts";
import { classifyPicked, folderLabel, sameFolder } from "./paths.ts";
import {
  addPreference,
  applyImport,
  buildExport,
  cleanChoices,
  deletePreference,
  editPreference,
  keepSuggestion,
  parseImport,
  previewImport,
  removeProjectPreferences,
  snapshotFor,
  supersedePreference,
  type ExportScopes,
  type ImportChoice,
  type NewPreference,
  type PreferenceChange,
  type PreferenceExport,
} from "./preferences.ts";
import { maskForStorage, maskValue, refuseCredentials, type KnownSecrets } from "./protect.ts";
import { EngineOfflineError, EngineSupervisor, type SupervisorOptions } from "./supervisor.ts";
import type { TargetFactory, WslTargets } from "./targets/registry.ts";
import { labelFor, type ExecutionTarget } from "./targets/types.ts";
import { isHiddenDistro, wslGuidance } from "./targets/wsl-discovery.ts";
import {
  deleteConversation,
  getConversation,
  getTurn,
  insertConversation,
  insertTurn,
  listConversations,
  messagesOf,
  openTurns,
  projectAnswer,
  recordRun,
  requestCancel,
  setTurnHome,
  settleTurn,
  turnByRun,
  turnsOf,
  withdrawCancel,
  type CancelReason,
  type ConversationRecord,
  type TurnRecord,
} from "./workspace.ts";
import { openWorkspace, type WorkspaceDb, type WorkspaceOpening } from "./workspace-db.ts";

export interface HostOptions {
  targets: TargetFactory;
  store: HostStore;
  /** The workspace database (D26), beside `nivra.json`; opened by `init`. */
  workspacePath: string;
  logsDir: string;
  client: { name: string; version: string };
  credentials: () => Promise<Partial<Record<SecretName, string>>>;
  /** The host's own OS, which decides how a picked folder is read. */
  platform: NodeJS.Platform;
  /** The Linux app running inside a WSL distribution (WSLg), where `/mnt/<drive>` folders are slow. */
  insideWsl?: boolean;
  /** Resolves a picked drive folder to its real path (mapped and SUBST drives, short names); tests replace it. */
  realpath?: (path: string) => string;
  /** Supervisor timings; tests shorten them. */
  supervisor?: Pick<SupervisorOptions, "heartbeatMs" | "shutdownGraceMs" | "eofGraceMs" | "startTimeoutMs">;
  log: (line: string) => void;
  /** Tests only: called between fetching a turn's reply and writing it, so a deletion can land there. */
  testHooks?: { beforeProjection?(turnId: string): Promise<void> };
}

/** Why a conversation can't continue once its project is gone. */
const CLOSED = "This conversation's project was removed, so it can't continue. Its history stays here until you delete it.";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isRunNotFound = (error: unknown) => error instanceof RpcCallError && error.code === ErrorCode.RunNotFound;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

interface Engine {
  readonly target: ExecutionTarget;
  readonly supervisor: EngineSupervisor;
  warnings: string[];
}

type WslLookup = { target: ExecutionTarget } | { notReady: string } | { notFound: true };

/**
 * The host's core, without Electron (D12): the project registry, one engine per target, and the calls the window
 * makes. Each project's folder decides which engine it uses (D17), so there is no target to choose and nothing ever
 * stops a healthy engine mid-session: a run keeps its engine, and every call about it goes there. Electron's main
 * process is a thin shell over this class, adding the window, dialogs and IPC.
 */
export class Host {
  readonly #options: HostOptions;
  /** One engine per target, started on first use and kept for the session (D17). */
  readonly #engines = new Map<string, Engine>();
  /** Why a target a project needs can't run an engine, until it can. */
  readonly #unavailable = new Map<string, string>();
  readonly #opening = new Set<string>();
  /** The engine of every run started this session, so a run's calls never reach another engine. */
  readonly #runs = new Map<string, string>();
  readonly #notices = new Map<string, string>();
  /** Raised on every change to a project's sharing, so a run started under old consent can be caught (D22). */
  readonly #sharingEpochs = new Map<string, number>();
  /** Each project's explain runs this session, so turning sharing off can cancel them. */
  readonly #explainRuns = new Map<string, Set<string>>();
  /** Each project's conversation runs this session, for the same reason (D26). */
  readonly #conversationRuns = new Map<string, Set<string>>();
  /** This host session, recorded with each turn: only this session's own submissions can still be in flight. */
  readonly #sessionId = randomUUID();
  /** Turns whose `runs.start` this session hasn't finished with, and who asked them to stop meanwhile. */
  readonly #submissions = new Map<string, { cancel: CancelReason | null }>();
  /** Turns being followed to their end. */
  readonly #following = new Set<string>();
  /** Projects being removed: no explanation may start for them, and a late answer to one that did is not accepted. */
  readonly #removing = new Set<string>();
  /** Export files the person chose to import, read and checked, until they are imported; this session only. */
  readonly #imports = new Map<string, PreferenceExport>();
  /** The workspace (D26): open, or why it isn't. Nothing else depends on it. */
  #workspace: WorkspaceOpening = { state: "unavailable", reason: "Nivra's history hasn't been opened yet." };
  #wsl: WslTargets | null = null;
  #wslChecked = false;
  #discovering: Promise<WslTargets | null> | null = null;
  #closing: Promise<void> | null = null;

  constructor(options: HostOptions) {
    this.#options = options;
  }

  /**
   * Brings older records in line (D17), opens the workspace (D26) and starts looking for WSL in the background. Starts
   * no engine. A workspace that can't be opened is kept as state, never thrown: everything else still works.
   */
  init(): void {
    const migrated = migrateHostData(this.#options.store.data, this.#options.platform);
    if (migrated.changed) this.#options.store.update(() => migrated.data);
    for (const [id, notice] of migrated.notices) this.#notices.set(id, notice);
    this.#workspace = openWorkspace(this.#options.workspacePath);
    if (this.#workspace.state === "unavailable") this.#options.log(`Workspace unavailable: ${this.#workspace.reason}`);
    else if (this.#workspace.notice) this.#options.log(`Workspace: ${this.#workspace.notice}`);
    void this.#discover();
  }

  /** The workspace's state and every conversation, the most recently active first. Starts nothing. */
  conversations(): ConversationsView {
    const workspace = this.#workspace;
    return { workspace: this.#workspaceView(), conversations: workspace.state === "ready" ? listConversations(workspace.db).map((record) => this.#conversationView(record)) : [] };
  }

  /**
   * Starts a conversation (D26). A general one runs on this computer's own engine and no repository reaches it; one
   * about a project keeps that project, its engine and its label for good, whatever project is chosen later. Creating
   * one starts no engine.
   */
  createConversation(scope: ConversationScope): ConversationSummary {
    const workspace = this.#workspaceDb();
    const now = new Date().toISOString();
    let record: ConversationRecord;
    if (scope.kind === "general") {
      record = { id: randomUUID(), kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "New conversation", createdAt: now, updatedAt: now };
    } else {
      const project = this.#project(scope.projectId);
      if (this.#removing.has(project.id)) throw new Error("This project is being removed, so a conversation can't start about it.");
      record = { id: randomUUID(), kind: "project", projectId: project.id, projectLabel: project.label, targetId: project.targetId, title: "New conversation", createdAt: now, updatedAt: now };
    }
    insertConversation(workspace, record);
    return this.#conversationView(getConversation(workspace, record.id)!);
  }

  /** One conversation as it is now, read from the workspace. Asks no engine and starts nothing. */
  conversation(conversationId: string): ConversationView {
    const workspace = this.#workspaceDb();
    const record = getConversation(workspace, conversationId);
    if (!record) throw new Error("That conversation is no longer in the list.");
    const summary = this.#conversationView(record);
    const engine = this.#engineView(record.targetId);
    return {
      summary,
      messages: messagesOf(workspace, conversationId).map(({ conversationId: _of, ...message }) => message),
      turns: turnsOf(workspace, conversationId).map((turn) => this.#turnView(turn, engine)),
      engine,
      closed: summary.projectPresent === false ? CLOSED : null,
    };
  }

  /**
   * Opens a conversation (D26). Turns left open, by an earlier session or a lost answer, are followed on their own
   * engine, which starts when needed: an answer is projected, an interruption reported, and a send whose answer was lost
   * is found by its request id. Nothing is ever resent. A target already known to be unavailable isn't retried.
   */
  async openConversation(conversationId: string): Promise<ConversationView> {
    const workspace = this.#workspaceDb();
    const record = getConversation(workspace, conversationId);
    if (!record) throw new Error("That conversation is no longer in the list.");
    const open = openTurns(workspace, { conversationId }).filter((turn) => !this.#submissions.has(turn.id));
    if (open.length) {
      if (!this.#unavailable.has(record.targetId)) await this.#ensure(record.targetId).catch(() => undefined);
      for (const turn of open) this.#follow(turn.id);
    }
    return this.conversation(conversationId);
  }

  /**
   * Sends the person's message as a new turn (D26). Refused at once, with nothing stored, when it can't go: a credential
   * in it, a turn still open, or a repository conversation whose project is gone or doesn't allow sharing. Otherwise the
   * message and its turn are stored first, then sent in the background: the engine's start is awaited, consent checked
   * again, the engine's store recorded, and only then is the request written. The history goes with it, chosen here.
   */
  async sendMessage(conversationId: string, text: string): Promise<ConversationView> {
    const workspace = this.#workspaceDb();
    const message = text.trim();
    if (!message) throw new Error("Type a message first.");
    if (message.length > CHAT_LIMITS.messageChars) throw new Error(`That message is ${message.length} characters long, and a turn can carry ${CHAT_LIMITS.messageChars}. Shorten it, then send it again.`);
    refuseCredentials("Your message", message, await this.#knownSecrets(), "send");
    const conversation = getConversation(workspace, conversationId);
    if (!conversation) throw new Error("That conversation is no longer in the list.");
    const busy = "This conversation is still waiting for an answer. Wait for it, or cancel it, then send again.";
    if (openTurns(workspace, { conversationId }).length) throw new Error(busy);
    let input: ChatInput = { message, scope: { kind: "general" } };
    let epoch = 0;
    if (conversation.projectId !== null) {
      const project = this.#options.store.data.projects.find((p) => p.id === conversation.projectId);
      if (!project) throw new Error(CLOSED);
      if (this.#removing.has(project.id)) throw new Error("This conversation's project is being removed, so it can't continue.");
      if (!project.sharing.modelContext) throw new Error("This project doesn't allow sending its content to Token Factory. Allow sharing for it, then send again.");
      epoch = this.#epochOf(project.id);
      input = { message, scope: { kind: "repository", repoPath: project.nativePath } };
    }
    // The snapshot is taken now (D21): with no project, the personal preferences only.
    const preferences = snapshotFor(this.#options.store.data, conversation.projectId);
    const { history, record } = await selectHistory(turnsOf(workspace, conversationId), messagesOf(workspace, conversationId), preferences);
    const turnId = randomUUID();
    const turn = { id: turnId, conversationId, sessionId: this.#sessionId, targetId: conversation.targetId, preferences: preferences.records.map(({ id, revision }) => ({ id, revision })), history: record, createdAt: new Date().toISOString() };
    if (!getConversation(workspace, conversationId)) throw new Error("That conversation is no longer in the list.");
    if (!insertTurn(workspace, turn, { id: randomUUID(), text: message })) throw new Error(busy);
    this.#submissions.set(turnId, { cancel: null });
    const context: ChatContext = { preferences, sharing: { modelContext: conversation.projectId !== null }, history };
    void this.#submit(turnId, conversation, input, context, epoch).catch((error: unknown) => this.#options.log(`A turn couldn't be sent: ${errorText(error)}`));
    return this.conversation(conversationId);
  }

  /**
   * Stops a turn the person no longer wants. One being sent stops before its request is written, or is cancelled as soon
   * as its engine answers; a running one is cancelled on its engine. Its end is recorded as cancelled by the person.
   */
  async cancelTurn(conversationId: string, turnId: string): Promise<ConversationView> {
    const workspace = this.#workspaceDb();
    const turn = getTurn(workspace, turnId);
    if (!turn || turn.conversationId !== conversationId) throw new Error("That message is no longer in this conversation.");
    if (turn.status === "submitting" || turn.status === "running") {
      requestCancel(workspace, turnId, "person");
      const pending = this.#submissions.get(turnId);
      if (pending) pending.cancel ??= "person";
      if (turn.runId) await this.cancelRun(turn.runId);
      else if (!pending) this.#follow(turnId);
    }
    return this.conversation(conversationId);
  }

  /**
   * Deletes a conversation with its turns, messages and plans (D26). Its turn still going is stopped first; when it
   * can't be, the conversation stays, and the person is told why. Text copied into a task's brief stays with the task,
   * and each engine keeps its own record of the runs.
   */
  async deleteConversation(conversationId: string): Promise<void> {
    const workspace = this.#workspaceDb();
    const record = getConversation(workspace, conversationId);
    if (!record) throw new Error("That conversation is no longer in the list.");
    const open = openTurns(workspace, { conversationId });
    for (const turn of open) {
      requestCancel(workspace, turn.id, "deletion");
      const pending = this.#submissions.get(turn.id);
      if (pending) pending.cancel ??= "deletion";
    }
    // A run whose engine isn't online isn't running any more: its engine fails it as interrupted when it starts (D4).
    const running = open.filter((turn) => turn.runId && this.#engines.get(turn.targetId)?.supervisor.state.status === "online");
    const failed = (await Promise.allSettled(running.map((turn) => this.cancelRun(turn.runId!)))).filter((result) => result.status === "rejected");
    if (failed.length) {
      throw new Error(`Nivra couldn't stop this conversation's answer on ${this.#labelOf(record.targetId)} (${errorText(failed[0]!.reason)}), so the conversation is still here. Restart that engine, then delete it again.`);
    }
    deleteConversation(workspace, conversationId);
  }

  /** What WSL offers on a Windows host, and what to do when it offers nothing; null elsewhere. */
  wsl(): WslView | null {
    if (this.#options.platform !== "win32") return null;
    if (!this.#wslChecked || !this.#wsl) return { status: "checking", message: null, code: null, distros: [] };
    return wslGuidance(this.#wsl.discovery);
  }

  async checkWsl(): Promise<WslView | null> {
    await this.#discover(true);
    return this.wsl();
  }

  projects(): ProjectView[] {
    return this.#options.store.data.projects.map((record) => this.#view(record));
  }

  /** Every engine a project uses or that is running. Asking starts nothing. */
  engines(): EngineView[] {
    const ids = new Set([...this.#engines.keys(), ...this.#options.store.data.projects.map((p) => p.targetId)]);
    return [...ids].map((id) => this.#engineView(id));
  }

  /** Starts the engine of the project's folder if it isn't running yet. A target that can't run one says why (D17). */
  async open(projectId: string): Promise<EngineView> {
    const project = this.#project(projectId);
    await this.#ensure(project.targetId).catch(() => undefined);
    return this.#engineView(project.targetId);
  }

  /** Restarts the project's engine; a failure shows in the engine's state rather than here. */
  async restart(projectId: string): Promise<void> {
    const { targetId } = this.#project(projectId);
    const engine = this.#engines.get(targetId);
    if (engine && targetId === "local") {
      await engine.supervisor.restart().catch(() => undefined);
      await this.#refreshWarnings(engine);
      return;
    }
    // A distribution can change while Nivra runs (installed, converted to WSL 2, removed): look again, start afresh.
    if (targetId.startsWith("wsl:")) await this.#discover(true);
    if (engine) {
      await engine.supervisor.close();
      if (this.#engines.get(targetId) === engine) this.#engines.delete(targetId);
    }
    this.#unavailable.delete(targetId);
    await this.#ensure(targetId).catch(() => undefined);
  }

  doctor(projectId: string): Promise<DoctorReport> {
    return this.#onProjectEngine(projectId, (engine) => engine.supervisor.call("doctor", {}));
  }

  checkTokenFactory(projectId: string): Promise<ProviderCheck> {
    return this.#onProjectEngine(projectId, (engine) => engine.supervisor.call("providers.check", {}, { timeoutMs: 180_000 }));
  }

  async startHello(projectId: string, holdMs: number): Promise<RunSummary> {
    const project = this.#project(projectId);
    const engine = await this.#ensure(project.targetId);
    // Main mints the request id, so a retry never starts a second run (from Hird). The snapshot is taken now, from the
    // canonical store, so the run gets the preferences as they are when it is asked for (D21).
    const context = { preferences: snapshotFor(this.#options.store.data, project.id), sharing: { modelContext: project.sharing.modelContext } };
    const run = await engine.supervisor.call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: project.nativePath, holdMs }, context });
    this.#runs.set(run.id, project.targetId);
    return run;
  }

  /**
   * Explains the project's repository with evidence (NIV-6, NIV-9) on its own engine. Refused while the project
   * doesn't allow sharing (D20). An engine can take a while to start, so this waits for a start in progress, then
   * checks consent again immediately before submitting; a run submitted while sharing was being turned off is
   * cancelled at once (D22). The task's choices go with this run only, never into the store (D23).
   */
  async startExplain(projectId: string, question: string, choices: readonly string[]): Promise<RunSummary> {
    const cleaned = cleanChoices(choices);
    const project = this.#project(projectId);
    if (this.#removing.has(projectId)) throw new Error("This project is being removed, so it can't be explained.");
    if (!project.sharing.modelContext) throw new Error("This project doesn't allow sending its content to Token Factory. Allow sharing for it, then explain again.");
    const epoch = this.#epochOf(projectId);
    const engine = await this.#ensure(project.targetId);
    if (engine.supervisor.state.status === "starting") await engine.supervisor.start();
    const current = this.#project(projectId);
    if (this.#removing.has(projectId)) throw new Error("This project is being removed, so it can't be explained.");
    if (!current.sharing.modelContext || this.#epochOf(projectId) !== epoch) throw new Error("Sharing for this project was turned off, so the run wasn't started.");
    const context = { preferences: snapshotFor(this.#options.store.data, current.id), sharing: { modelContext: true } };
    const run = await engine.supervisor.call("runs.start", { clientRequestId: randomUUID(), workflowId: "explain", input: { repoPath: current.nativePath, question, choices: cleaned }, context });
    this.#runs.set(run.id, current.targetId);
    // A late answer is accepted only while nothing about the project's consent has changed since it was checked.
    const now = this.#options.store.data.projects.find((p) => p.id === projectId);
    if (now?.sharing.modelContext && !this.#removing.has(projectId) && this.#epochOf(projectId) === epoch) {
      const runs = this.#explainRuns.get(projectId) ?? new Set<string>();
      runs.add(run.id);
      this.#explainRuns.set(projectId, runs);
      return run;
    }
    // Sharing was turned off, or the project removed, while the request was out: the run was submitted under consent
    // that has since been withdrawn, so it stops now.
    const removed = !now || this.#removing.has(projectId);
    const what = removed ? "The project was removed" : "Sharing for this project was turned off";
    await this.cancelRun(run.id).catch((error: unknown) => {
      throw new Error(`${what} while the run was starting, and Nivra couldn't stop it (${error instanceof Error ? error.message : String(error)}). Restart the project's engine to stop it.`);
    });
    if (removed) throw new Error("The project was removed while its explanation was starting, so the run was stopped.");
    return run;
  }

  /** An explain run's summary (model, time, tokens) and its stored result, from the engine that ran it. */
  async runResult(runId: string): Promise<{ summary: RunSummary; result: ExplainResult | null }> {
    const engine = this.#runEngine(runId);
    const [summary, result] = await Promise.all([engine.supervisor.call("runs.get", { runId }), engine.supervisor.call("runs.result", { runId })]);
    return { summary, result };
  }

  /**
   * Turns sharing for a project on or off (D20). Turning it off raises the project's epoch, which an explain start in
   * progress checks, and cancels its queued and running explain runs: a model call in progress is aborted, and no
   * further request is made. A run that couldn't be stopped is reported, never passed over.
   */
  async setSharing(projectId: string, modelContext: boolean): Promise<ProjectView> {
    this.#project(projectId);
    this.#options.store.update((data) => ({ ...data, projects: data.projects.map((p) => (p.id === projectId ? { ...p, sharing: { ...p.sharing, modelContext } } : p)) }));
    if (!modelContext) {
      this.#sharingEpochs.set(projectId, this.#epochOf(projectId) + 1);
      const withdraw = this.#markProjectTurns(projectId, "sharing");
      await this.#stopExplainRuns(projectId, (runs, why, them) => `Sharing for this project is off, but Nivra couldn't stop ${runs} (${why}). Restart the project's engine to stop ${them}.`).catch((error: unknown) => {
        withdraw();
        throw error;
      });
    }
    return this.#view(this.#project(projectId));
  }

  async runEvents(runId: string, after: number): Promise<RunEventsPage> {
    return this.#runEngine(runId).supervisor.call("runs.events", { runId, after, limit: 500 });
  }

  async cancelRun(runId: string): Promise<{ status: RunStatus; wasTerminal: boolean }> {
    return this.#runEngine(runId).supervisor.call("runs.cancel", { runId });
  }

  /** Records a folder picked in the native dialog for the engine that owns it, converting its path once, here (D17). */
  async addPicked(picked: string): Promise<AddProjectResult> {
    const { platform } = this.#options;
    const path = platform === "win32" && /^[A-Za-z]:[\\/]/.test(picked) ? this.#realpath(picked) : picked;
    const folder = classifyPicked(path, { platform, insideWsl: this.#options.insideWsl ?? false });
    if (folder.kind === "refused") return { status: "refused", reason: folder.reason };
    let targetId = "local";
    let warning: string | null = null;
    if (folder.kind === "local") {
      warning = folder.notice;
    } else {
      const checked = await this.#checkWslFolder(folder.distro);
      if ("refused" in checked) return { status: "refused", reason: checked.refused };
      targetId = checked.target.descriptor.id;
      warning = checked.warning;
    }
    // Read the records again: checking a distribution can take a while.
    const windowsFolder = targetId === "local" && platform === "win32";
    const existing = this.#options.store.data.projects.find((p) => p.targetId === targetId && sameFolder(p.nativePath, folder.nativePath, windowsFolder));
    if (existing) return { status: "added", project: this.#view(existing), warning };
    const record: ProjectRecord = { id: randomUUID(), targetId, nativePath: folder.nativePath, label: folderLabel(folder.nativePath), addedAt: new Date().toISOString(), sharing: NO_SHARING };
    this.#options.store.update((data) => ({ ...data, projects: [...data.projects, record] }));
    return { status: "added", project: this.#view(record), warning };
  }

  /**
   * Removes a folder from the list, with its own preferences (personal ones stay), and says how many went. Removing a
   * project withdraws its consent first: its epoch moves (and stays moved), so an explanation being submitted stops
   * itself, and its queued and running explanations are cancelled. When one can't be stopped, the project stays.
   */
  async removeProject(projectId: string): Promise<{ preferencesRemoved: number }> {
    this.#project(projectId);
    if (this.#removing.has(projectId)) throw new Error("This project is already being removed.");
    // Marked before the first wait, so no explanation can start while its runs are being stopped.
    this.#removing.add(projectId);
    this.#sharingEpochs.set(projectId, this.#epochOf(projectId) + 1);
    const withdraw = this.#markProjectTurns(projectId, "removal");
    try {
      await this.#stopExplainRuns(projectId, (runs, why) => `Nivra couldn't stop ${runs} (${why}), so the project is still in the list. Restart its engine, then remove it again.`);
    } catch (error) {
      withdraw();
      this.#removing.delete(projectId);
      throw error;
    }
    this.#notices.delete(projectId);
    this.#explainRuns.delete(projectId);
    this.#conversationRuns.delete(projectId);
    let preferencesRemoved = 0;
    this.#options.store.update((data) => {
      const { data: next, removed } = removeProjectPreferences(data, projectId);
      preferencesRemoved = removed;
      return { ...next, projects: next.projects.filter((p) => p.id !== projectId) };
    });
    this.#removing.delete(projectId);
    return { preferencesRemoved };
  }

  /** Every preference in the canonical store, with the revision the next snapshot will carry (D21). */
  preferences(): PreferencesView {
    const { preferences, preferencesRevision } = this.#options.store.data;
    return { revision: preferencesRevision, records: preferences.map((record) => this.#preferenceView(record)) };
  }

  addPreference(input: NewPreference): PreferenceView {
    let saved: PreferenceRecord | undefined;
    this.#options.store.update((data) => {
      const result = addPreference(data, input, new Date());
      saved = result.record;
      return result.data;
    });
    return this.#preferenceView(saved!);
  }

  editPreference(id: string, change: PreferenceChange): PreferenceView {
    let saved: PreferenceRecord | undefined;
    this.#options.store.update((data) => {
      const result = editPreference(data, id, change, new Date());
      saved = result.record;
      return result.data;
    });
    return this.#preferenceView(saved!);
  }

  deletePreference(id: string): void {
    this.#options.store.update((data) => deletePreference(data, id));
  }

  /**
   * The text of an export of the scopes the person chose (D23), for main to write where they say. It needs the saved
   * keys, because a statement holding one is refused rather than written to a file that leaves the app.
   */
  async exportPreferences(scopes: ExportScopes): Promise<{ text: string; count: number }> {
    const secrets = Object.values(await this.#options.credentials()).filter((value): value is string => typeof value === "string" && value.length > 0);
    return buildExport(this.#options.store.data, scopes, secrets, new Date());
  }

  /**
   * Reads the text of a file the person chose to import, and says what importing it would do: its personal preferences,
   * and each of its source projects with the local projects whose label matches. The file is kept until it is imported
   * or another is previewed; nothing is saved yet.
   */
  previewImport(text: string): { previewId: string; personal: ImportEntryView[]; projects: ImportSourceView[] } {
    const file = parseImport(text);
    const previewId = randomUUID();
    this.#imports.clear();
    this.#imports.set(previewId, file);
    const label = (id: string) => this.#options.store.data.projects.find((p) => p.id === id)?.label ?? id;
    const preview = previewImport(this.#options.store.data, file);
    return { previewId, personal: preview.personal, projects: preview.projects.map((source) => ({ ...source, matches: source.matches.map((id) => ({ id, label: label(id) })) })) };
  }

  /**
   * Imports a previewed file as the person chose (D23): with or without its personal preferences, and each source project
   * to the local project they picked, or left out.
   */
  importPreferences(previewId: string, choice: ImportChoice): { added: number; alreadyHere: number; leftOut: number } {
    const file = this.#imports.get(previewId);
    if (!file) throw new Error("That import is no longer waiting. Choose the file again.");
    let outcome = { added: 0, alreadyHere: 0, leftOut: 0 };
    this.#options.store.update((data) => {
      const result = applyImport(data, file, choice, new Date());
      outcome = { added: result.added, alreadyHere: result.alreadyHere, leftOut: result.leftOut };
      return result.data;
    });
    this.#imports.delete(previewId);
    return outcome;
  }

  /** Replaces a preference with a new decision; the old one is kept as history, and no run gets it again (D23). */
  supersedePreference(id: string, change: { statement: string; intent: PreferenceIntent }): PreferenceView {
    let saved: PreferenceRecord | undefined;
    this.#options.store.update((data) => {
      const result = supersedePreference(data, id, change, new Date());
      saved = result.record;
      return result.data;
    });
    return this.#preferenceView(saved!);
  }

  /**
   * Keeps a run's suggestion as the project's own default, in the wording the person confirmed (D23). The run must be one
   * of this project's explanations this session, never found by its path: a project added again is another project.
   * The result comes from the engine that ran it, and everything is checked again after that wait, so a project
   * removed meanwhile gets nothing. The evidence is the result's, with only the lines the model was shown. The save and
   * its check for a suggestion already kept happen in one store update, so a double click saves once.
   */
  async keepSuggestion(projectId: string, runId: string, index: number, statement: string): Promise<PreferenceView> {
    this.#project(projectId);
    if (this.#removing.has(projectId)) throw new Error("This project is being removed, so nothing can be kept for it.");
    const ofProject = () => this.#explainRuns.get(projectId)?.has(runId) ?? false;
    if (!ofProject()) throw new Error("That suggestion comes from a run Nivra has no record of for this project in this session. Explain the project again, then keep it from the new result.");
    const { result } = await this.runResult(runId);
    if (!this.#options.store.data.projects.some((p) => p.id === projectId) || this.#removing.has(projectId) || !ofProject()) {
      throw new Error("The project was removed while the suggestion was being kept, so nothing was saved.");
    }
    const suggestion = result?.suggestions[index];
    if (!result || !suggestion) throw new Error("That suggestion isn't in the run's result. Explain the project again, then keep it from the new result.");
    const evidence = {
      runId,
      suggestion: index,
      headAtStart: result.headAtStart,
      ranAt: result.finishedAt,
      citations: suggestion.citations.filter((citation) => citation.checked).map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
    };
    let saved: PreferenceRecord | undefined;
    this.#options.store.update((data) => {
      const outcome = keepSuggestion(data, { projectId, statement, evidence }, new Date());
      saved = outcome.record;
      return outcome.data;
    });
    return this.#preferenceView(saved!);
  }

  /** Hands every engine the keys as they are now (D8), including one that was still starting when they changed. */
  async secretsChanged(): Promise<void> {
    const secrets = await this.#options.credentials();
    const remove = (["NEBIUS_API_KEY"] as const).filter((name) => !secrets[name]);
    const results = await Promise.allSettled(
      [...this.#engines.values()].map(async (engine) => {
        if (engine.supervisor.state.status === "starting") await engine.supervisor.start().catch(() => undefined);
        if (engine.supervisor.state.status !== "online") return;
        await engine.supervisor.call("secrets.update", { set: secrets, remove: [...remove] });
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") this.#options.log(`Could not hand an engine the new key: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }

  resumed(): void {
    for (const engine of this.#engines.values()) engine.supervisor.resumed();
  }

  /** Stops every engine in parallel, each in the D4 order, then closes the workspace; none can start afterwards. */
  shutdown(): Promise<void> {
    this.#closing ??= Promise.allSettled([...this.#engines.values()].map((engine) => engine.supervisor.close())).then(() => {
      if (this.#workspace.state === "ready") this.#workspace.db.close();
      this.#workspace = { state: "unavailable", reason: "Nivra is quitting." };
    });
    return this.#closing;
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  #epochOf(projectId: string): number {
    return this.#sharingEpochs.get(projectId) ?? 0;
  }

  /** Cancels the project's queued and running explain and conversation runs; when one can't be stopped, says so through `refusal`. */
  async #stopExplainRuns(projectId: string, refusal: (runs: string, why: string, them: "it" | "them") => string): Promise<void> {
    // A run whose engine isn't online isn't running any more.
    const all = [...(this.#explainRuns.get(projectId) ?? []), ...(this.#conversationRuns.get(projectId) ?? [])];
    const runs = all.filter((runId) => this.#engines.get(this.#runs.get(runId) ?? "")?.supervisor.state.status === "online");
    const failed = (await Promise.allSettled(runs.map((runId) => this.cancelRun(runId)))).filter((result) => result.status === "rejected");
    if (failed.length === 0) return;
    const why = failed[0]!.reason instanceof Error ? failed[0]!.reason.message : String(failed[0]!.reason);
    throw new Error(refusal(failed.length === 1 ? "an explain run" : `${failed.length} explain runs`, why, failed.length === 1 ? "it" : "them"));
  }

  /**
   * Records why the project's open conversation turns stop, so each ends as cancelled by that, not by the person.
   * Returns a function that takes the reason back, for when they couldn't be stopped. A turn still being sent stops
   * through its epoch check either way.
   */
  #markProjectTurns(projectId: string, reason: CancelReason): () => void {
    if (this.#workspace.state !== "ready") return () => undefined;
    const workspace = this.#workspace.db;
    const marked = openTurns(workspace, { projectId }).filter((turn) => requestCancel(workspace, turn.id, reason) && turn.cancelReason === null);
    for (const turn of marked) {
      const pending = this.#submissions.get(turn.id);
      if (pending) pending.cancel ??= reason;
    }
    return () => {
      if (this.#workspace.state === "ready") for (const turn of marked) withdrawCancel(this.#workspace.db, turn.id, reason);
    };
  }

  /** The keys the host holds, for the protection policy (D8, D26). */
  async #knownSecrets(): Promise<KnownSecrets> {
    return Object.entries(await this.#options.credentials()).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  }

  /** Why a turn must not be sent now (a cancel, or its project's consent gone since it was asked for); null when it may. */
  #stopReason(turnId: string, conversation: ConversationRecord, epoch: number): CancelReason | null {
    const asked = this.#submissions.get(turnId)?.cancel ?? null;
    if (asked) return asked;
    if (conversation.projectId === null) return null;
    const project = this.#options.store.data.projects.find((p) => p.id === conversation.projectId);
    if (!project || this.#removing.has(project.id)) return "removal";
    if (!project.sharing.modelContext || this.#epochOf(project.id) !== epoch) return "sharing";
    return null;
  }

  /** Ends an open turn without an answer; a turn that has already ended keeps its first outcome. */
  #settle(turnId: string, outcome: Parameters<typeof settleTurn>[2]): void {
    if (this.#workspace.state !== "ready") return;
    settleTurn(this.#workspace.db, turnId, outcome, new Date().toISOString());
  }

  /**
   * Sends a stored turn (D26). The request is written only after the engine's store is recorded with the turn, so a turn
   * with none was never sent. A failure known to come before writing is "not sent"; anything after it (no answer, a
   * closed connection, an error answer: the engine may have started the run first) leaves the turn to be found by its
   * request id.
   */
  async #submit(turnId: string, conversation: ConversationRecord, input: ChatInput, context: ChatContext, epoch: number): Promise<void> {
    const workspace = this.#workspaceDb();
    const label = this.#labelOf(conversation.targetId);
    const notSent = (why: string) => {
      this.#submissions.delete(turnId);
      this.#settle(turnId, { status: "not-sent", errorMessage: why });
    };
    let engine: Engine;
    try {
      engine = await this.#ensure(conversation.targetId);
      if (engine.supervisor.state.status === "starting") await engine.supervisor.start();
    } catch (error) {
      notSent(`The engine on ${label} couldn't start (${errorText(error)}), so this message wasn't sent and nothing reached the model.`);
      return;
    }
    const state = engine.supervisor.state;
    if (state.status !== "online") {
      notSent(`The engine on ${label} isn't running${state.status === "failed" ? ` (${state.reason})` : ""}, so this message wasn't sent and nothing reached the model.`);
      return;
    }
    const before = this.#stopReason(turnId, conversation, epoch);
    if (before) {
      this.#submissions.delete(turnId);
      requestCancel(workspace, turnId, before);
      this.#settle(turnId, { status: "cancelled", errorMessage: "It was stopped before it was sent, so nothing reached the model." });
      return;
    }
    // Deleted or ended meanwhile: nothing to send.
    if (!setTurnHome(workspace, turnId, state.info.homeId)) {
      this.#submissions.delete(turnId);
      return;
    }
    let run: RunSummary;
    try {
      run = await engine.supervisor.call("runs.start", { clientRequestId: turnId, workflowId: "chat", input, context });
    } catch (error) {
      // Nothing was written: the engine wasn't online, or the parameters were refused before sending.
      if (error instanceof EngineOfflineError || error instanceof TypeError) {
        notSent(`The engine on ${label} didn't take this message (${errorText(error)}), so nothing reached the model.`);
        return;
      }
      this.#options.log(`A turn's request got no usable answer (${error instanceof Error ? error.name : "unknown"}); it is found by its request id, never sent again.`);
      this.#submissions.delete(turnId);
      this.#follow(turnId);
      return;
    }
    this.#runs.set(run.id, conversation.targetId);
    recordRun(workspace, turnId, run.id);
    if (conversation.projectId !== null) {
      const runs = this.#conversationRuns.get(conversation.projectId) ?? new Set<string>();
      runs.add(run.id);
      this.#conversationRuns.set(conversation.projectId, runs);
    }
    // Stopped while the request was out (a cancel, a deletion, consent withdrawn): the run stops now.
    const late = this.#stopReason(turnId, conversation, epoch);
    this.#submissions.delete(turnId);
    const gone = getTurn(workspace, turnId) === null;
    if (late || gone) {
      if (!gone && late) requestCancel(workspace, turnId, late);
      await engine.supervisor.call("runs.cancel", { runId: run.id }).catch((error: unknown) => this.#options.log(`A turn stopped while it was being sent couldn't be cancelled: ${errorText(error)}`));
      if (gone) return;
    }
    this.#follow(turnId);
  }

  /**
   * Follows an open turn to its end on its own engine (D26), however it was left: just sent, sent by an earlier session,
   * or sent with its answer lost. Checks again until the turn ends or Nivra quits, waiting while its engine is away.
   * - No store recorded: it was never sent (`not-sent`).
   * - Another store on that target: `unknown`, never resent.
   * - No run id: found by its request id; absent from the same store means it never arrived (`not-sent`).
   * - A run: followed until it ends, then its answer projected or its end recorded.
   */
  #follow(turnId: string): void {
    if (this.#following.has(turnId) || this.#submissions.has(turnId)) return;
    this.#following.add(turnId);
    void (async () => {
      let delay = 400;
      let cancelSent = false;
      try {
        while (!this.#closing && this.#workspace.state === "ready") {
          const workspace = this.#workspace.db;
          const turn = getTurn(workspace, turnId);
          if (!turn || (turn.status !== "submitting" && turn.status !== "running")) return;
          if (turn.homeId === null) {
            this.#settle(turnId, { status: "not-sent", errorMessage: "Nivra stopped before sending this message, so nothing reached the model." });
            return;
          }
          const engine = this.#engines.get(turn.targetId);
          const state = engine?.supervisor.state;
          if (engine && state?.status === "online") {
            if (state.info.homeId !== turn.homeId) {
              this.#settle(turnId, { status: "unknown", errorMessage: `it went to an engine whose records aren't here (another engine home on ${this.#labelOf(turn.targetId)})` });
              return;
            }
            try {
              let summary: RunSummary | null;
              if (turn.runId) {
                summary = await engine.supervisor.call("runs.get", { runId: turn.runId });
              } else {
                summary = await engine.supervisor.call("runs.find", { clientRequestId: turnId });
                if (!summary) {
                  this.#settle(turnId, { status: "not-sent", errorMessage: "Its engine has no record of this message, so it never ran and nothing reached the model." });
                  return;
                }
                this.#runs.set(summary.id, turn.targetId);
                recordRun(workspace, turnId, summary.id);
              }
              if (isTerminal(summary.status)) {
                await this.#finish(turnId, engine, summary);
                return;
              }
              if (turn.cancelRequested && !cancelSent) {
                cancelSent = true;
                await engine.supervisor.call("runs.cancel", { runId: summary.id }).catch(() => undefined);
              }
              delay = 400;
            } catch (error) {
              if (isRunNotFound(error)) {
                this.#settle(turnId, { status: "unknown", errorMessage: `the engine on ${this.#labelOf(turn.targetId)} has no record of its run any more` });
                return;
              }
              delay = Math.min(delay * 2, 5_000);
            }
          } else {
            delay = Math.min(delay * 2, 5_000);
          }
          await pause(delay);
        }
      } catch (error) {
        this.#options.log(`Following a turn stopped: ${errorText(error)}`);
      } finally {
        this.#following.delete(turnId);
      }
    })();
  }

  /**
   * Records how a turn's run ended (D26). A reply is masked again and projected once. A cancel Nivra asked for keeps
   * its reason; any other cancel, or a `run.interrupted` event, means Nivra or its engine stopped first: interrupted.
   */
  async #finish(turnId: string, engine: Engine, summary: RunSummary): Promise<void> {
    const workspace = this.#workspaceDb();
    const known = await this.#knownSecrets();
    if (summary.status === "succeeded") {
      const reply = await engine.supervisor.call("runs.reply", { runId: summary.id });
      if (!reply) {
        this.#settle(turnId, { status: "unknown", errorMessage: "its run finished, but its engine has no reply stored for it" });
        return;
      }
      const masked = maskValue(reply, known);
      await this.#options.testHooks?.beforeProjection?.(turnId);
      if (this.#workspace.state !== "ready") return;
      projectAnswer(this.#workspace.db, turnId, { id: randomUUID(), text: masked.kind === "general" ? masked.text : masked.answer, reply: masked, createdAt: new Date().toISOString() });
      return;
    }
    const turn = getTurn(workspace, turnId);
    if (summary.status === "cancelled") {
      if (turn?.cancelReason) this.#settle(turnId, { status: "cancelled" });
      else this.#settle(turnId, { status: "interrupted" });
      return;
    }
    let interrupted = false;
    let kind: string | null = null;
    for (let after = 0; ; ) {
      const page = await engine.supervisor.call("runs.events", { runId: summary.id, after, limit: 500 });
      for (const event of page.events) {
        if (event.type === "run.interrupted") interrupted = true;
        if (event.type === "run.failed" && typeof event.data?.["kind"] === "string") kind = event.data["kind"];
      }
      if (page.events.length < 500) break;
      after = page.next;
    }
    if (interrupted) this.#settle(turnId, { status: "interrupted" });
    else this.#settle(turnId, { status: "failed", errorKind: kind, errorMessage: maskForStorage(summary.error ?? "The run failed.", known) });
  }

  #turnView(turn: TurnRecord, engine: EngineView): TurnView {
    const open = turn.status === "submitting" || turn.status === "running";
    const away = open && !this.#submissions.has(turn.id) && engine.state.status !== "online";
    return {
      id: turn.id,
      status: turn.status,
      note: noteFor(turn),
      unresolved: away ? (engine.state.status === "failed" ? engine.state.reason : `The engine on ${engine.label} isn't running, so Nivra can't check this message yet. It checks again when you open the conversation.`) : null,
      runId: turn.runId,
      cancelRequested: turn.cancelRequested,
      given: { preferences: turn.preferences.length, history: turn.history },
      createdAt: turn.createdAt,
      settledAt: turn.settledAt,
    };
  }

  /** The open workspace, or the reason it isn't, in the person's terms. */
  #workspaceDb(): WorkspaceDb {
    if (this.#workspace.state !== "ready") throw new Error(this.#workspace.reason);
    return this.#workspace.db;
  }

  #workspaceView(): WorkspaceView {
    const workspace = this.#workspace;
    return workspace.state === "ready" ? { state: "ready", schemaVersion: workspace.schemaVersion, sqlite: workspace.sqlite, notice: workspace.notice } : { state: "unavailable", reason: workspace.reason };
  }

  #conversationView(record: ConversationRecord): ConversationSummary {
    return {
      ...record,
      projectPresent: record.projectId === null ? null : this.#options.store.data.projects.some((p) => p.id === record.projectId),
    };
  }

  #project(projectId: string): ProjectRecord {
    const project = this.#options.store.data.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("That project is no longer in the list.");
    return project;
  }

  async #onProjectEngine<T>(projectId: string, body: (engine: Engine) => Promise<T>): Promise<T> {
    const project = this.#project(projectId);
    return body(await this.#ensure(project.targetId));
  }

  #runEngine(runId: string): Engine {
    // A conversation's run is routed from the workspace too, so it is reachable after a restart (D26).
    const targetId = this.#runs.get(runId) ?? (this.#workspace.state === "ready" ? turnByRun(this.#workspace.db, runId)?.targetId : undefined);
    if (!targetId) throw new Error("Nivra has no record of that run in this session. Start it again.");
    const engine = this.#engines.get(targetId);
    if (!engine) throw new Error(`The engine on ${this.#labelOf(targetId)} isn't running.`);
    return engine;
  }

  /** The engine for a target, created and started on first use. Never another target's instead (D17). */
  async #ensure(targetId: string): Promise<Engine> {
    const existing = this.#engines.get(targetId);
    if (existing) return existing;
    if (this.#closing) throw new Error("Nivra is quitting.");
    this.#opening.add(targetId);
    try {
      const target = await this.#resolve(targetId);
      // Another call may have created it while this one waited.
      const raced = this.#engines.get(targetId);
      if (raced) return raced;
      if (this.#closing) throw new Error("Nivra is quitting.");
      const engine: Engine = {
        target,
        warnings: [],
        supervisor: new EngineSupervisor({
          target,
          logsDir: this.#options.logsDir,
          client: this.#options.client,
          credentials: this.#options.credentials,
          log: this.#options.log,
          ...this.#options.supervisor,
        }),
      };
      this.#engines.set(targetId, engine);
      this.#unavailable.delete(targetId);
      void this.#startEngine(engine);
      return engine;
    } catch (error) {
      this.#unavailable.set(targetId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.#opening.delete(targetId);
    }
  }

  async #startEngine(engine: Engine): Promise<void> {
    try {
      await engine.supervisor.start();
    } catch (error) {
      this.#options.log(`[${engine.target.descriptor.id}] did not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.#refreshWarnings(engine);
  }

  async #refreshWarnings(engine: Engine): Promise<void> {
    try {
      const probe = await engine.target.probe();
      engine.warnings = probe.problems.filter((p) => p.severity === "warning").map((p) => p.message);
    } catch {
      // A probe that fails shows in the engine's own state.
    }
  }

  async #resolve(targetId: string): Promise<ExecutionTarget> {
    if (targetId === "local") return this.#options.targets.local;
    if (!targetId.startsWith("wsl:")) throw new Error(`Nivra doesn't know where "${targetId}" runs. Remove this folder from the list and add it again.`);
    const name = targetId.slice(4);
    if (this.#options.platform !== "win32") throw new Error(`This folder is inside WSL (${name}), which only Nivra on Windows can reach. Remove it from the list.`);
    const found = await this.#findWsl(name);
    if ("target" in found) return found.target;
    if ("notReady" in found) throw new Error(found.notReady);
    throw new Error(`${name} isn't a WSL distribution on this computer any more. Run \`wsl --list\` in a terminal to check, reinstall it, or remove this folder from the list.`);
  }

  /** A distribution by name (as WSL spells it), looking again once when it isn't in what Nivra found before. */
  async #findWsl(name: string): Promise<WslLookup> {
    const lookup = (found: WslTargets | null): WslLookup => {
      if (!found) return { notReady: "WSL isn't available on this computer." };
      if (found.discovery.status !== "ready") return { notReady: found.discovery.message };
      const target = found.targets.find((t) => t.descriptor.distro?.toLowerCase() === name.toLowerCase());
      return target ? { target } : { notFound: true };
    };
    const first = lookup(await this.#discover());
    return "notFound" in first ? lookup(await this.#discover(true)) : first;
  }

  async #checkWslFolder(distro: string): Promise<{ target: ExecutionTarget; warning: string | null } | { refused: string }> {
    if (isHiddenDistro(distro)) {
      return { refused: `${distro} is Docker Desktop's own distribution, not one for your work. Keep the repository in Ubuntu or another distribution, then add it from there.` };
    }
    const found = await this.#findWsl(distro);
    if ("notReady" in found) return { refused: found.notReady };
    if ("notFound" in found) return { refused: `Nivra can't find a WSL distribution named ${distro}. Run \`wsl --list\` in a terminal to see yours, then add the folder again.` };
    const probe = await found.target.probe();
    const blocking = probe.problems.filter((p) => p.severity === "blocking");
    if (blocking.length) return { refused: blocking.map((p) => p.message).join(" ") };
    const warnings = probe.problems.filter((p) => p.severity === "warning").map((p) => p.message);
    return { target: found.target, warning: warnings.length ? warnings.join(" ") : null };
  }

  #discover(force = false): Promise<WslTargets | null> {
    if (this.#options.platform !== "win32") return Promise.resolve(null);
    if (this.#discovering) return this.#discovering;
    if (this.#wslChecked && !force) return Promise.resolve(this.#wsl);
    const started = performance.now();
    this.#discovering = this.#options.targets
      .discoverWsl()
      .then((found) => {
        this.#wsl = found;
        this.#wslChecked = true;
        this.#options.log(`WSL discovery: ${found?.discovery.status ?? "not on this host"} in ${Math.round(performance.now() - started)} ms`);
        return found;
      })
      .finally(() => (this.#discovering = null));
    return this.#discovering;
  }

  #realpath(path: string): string {
    try {
      return (this.#options.realpath ?? realpathSync.native)(path);
    } catch {
      return path;
    }
  }

  #labelOf(targetId: string): string {
    return this.#engines.get(targetId)?.target.descriptor.label ?? labelFor(targetId, this.#options.platform);
  }

  #view(record: ProjectRecord): ProjectView {
    return {
      id: record.id,
      targetId: record.targetId,
      targetLabel: this.#labelOf(record.targetId),
      label: record.label,
      displayPath: record.nativePath,
      notice: this.#notices.get(record.id) ?? null,
      sharing: { modelContext: record.sharing.modelContext },
    };
  }

  #preferenceView(record: PreferenceRecord): PreferenceView {
    const project = record.projectId ? this.#options.store.data.projects.find((p) => p.id === record.projectId) : undefined;
    return {
      id: record.id,
      statement: record.statement,
      scope: record.scope,
      projectId: record.projectId,
      projectLabel: project?.label ?? null,
      intent: record.intent,
      status: record.status,
      origin: record.origin,
      revision: record.revision,
      updatedAt: record.updatedAt,
      confirmedAt: record.confirmedAt,
      supersedes: record.supersedes,
      supersededBy: record.supersededBy,
      supersededAt: record.supersededAt,
      evidence: record.evidence,
    };
  }

  #engineView(targetId: string): EngineView {
    const label = this.#labelOf(targetId);
    const engine = this.#engines.get(targetId);
    if (engine) return { targetId, label, state: engine.supervisor.state, warnings: engine.warnings };
    if (this.#opening.has(targetId)) return { targetId, label, state: { status: "starting", detail: targetId === "local" ? "Starting the engine…" : "Looking for WSL distributions…" }, warnings: [] };
    const reason = this.#unavailable.get(targetId);
    if (reason) return { targetId, label, state: { status: "failed", reason, code: "target-unavailable", logPath: null }, warnings: [] };
    return { targetId, label, state: { status: "stopped" }, warnings: [] };
  }
}

/** What happened to a turn that ended without an answer, in the person's terms; null while it goes or once answered. */
function noteFor(turn: TurnRecord): string | null {
  switch (turn.status) {
    case "failed":
      return `${turn.errorMessage ?? "The run failed."} Nothing was resent.`;
    case "cancelled":
      return turn.cancelReason === "sharing"
        ? "Stopped: sharing for this project was turned off. Nothing was resent."
        : turn.cancelReason === "removal"
          ? "Stopped: the project was removed. Nothing was resent."
          : turn.errorMessage
            ? `Cancelled. ${turn.errorMessage}`
            : "Cancelled. Nothing was resent.";
    case "interrupted":
      return "Interrupted: Nivra or its engine stopped before the answer arrived. Nothing was resent.";
    case "not-sent":
      return turn.errorMessage ?? "Not sent: nothing reached the model.";
    case "unknown":
      return `Nivra can't tell whether this message reached the model: ${turn.errorMessage ?? "its engine can't say"}. Nothing was resent.`;
    default:
      return null;
  }
}
