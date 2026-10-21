import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  CHAT_LIMITS,
  ErrorCode,
  isTerminal,
  packetDigest,
  preferencesDigest,
  RpcCallError,
  type ChatContext,
  type ChatInput,
  type DoctorReport,
  type ExplainResult,
  type PreferenceIntent,
  type ProviderCheck,
  type ReviewContext,
  type ReviewInput,
  type ReviewPanel,
  type ReviewReport,
  type RunEventsPage,
  type RunStatus,
  type RunSummary,
  type SandboxPreview,
  type SandboxStatus,
  type SecretName,
} from "@nivra/domain";
import type {
  AddProjectResult,
  ConversationScope,
  ConversationsView,
  ConversationSummary,
  ConversationView,
  EngineView,
  BriefContent,
  BriefFields,
  ImportEntryView,
  ImportSourceView,
  PlanView,
  PreferencesView,
  PreferenceView,
  ProjectView,
  ReviewPreview,
  ReviewView,
  SandboxCheckView,
  TasksView,
  TaskState,
  TaskSummary,
  TaskView,
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
import { historicalReferences, packetFor, previewFingerprint, reportMatches, REVIEW_REQUESTS, reviewNoteFor } from "./reviews.ts";
import { BriefContentSchema, BriefFieldsSchema, briefForRepository, briefFrom, briefIsReady, nextState, planFromAnswer, RUN_UNAVAILABLE, sourceFrom, TASK_LIMITS, type PlanContent } from "./tasks.ts";
import { EngineOfflineError, EngineSupervisor, type SupervisorOptions } from "./supervisor.ts";
import type { TargetFactory, WslTargets } from "./targets/registry.ts";
import { labelFor, type ExecutionTarget } from "./targets/types.ts";
import { isHiddenDistro, wslGuidance } from "./targets/wsl-discovery.ts";
import {
  attemptsOf,
  deleteConversation,
  deleteTask,
  getArtifact,
  getConversation,
  getReview,
  getTask,
  getTurn,
  insertArtifact,
  insertConversation,
  insertReview,
  insertTask,
  insertTurn,
  listConversations,
  listTasks,
  messagesOf,
  openTurns,
  projectAnswer,
  recordRun,
  requestCancel,
  reviewsOf,
  setTurnHome,
  settleReview,
  settleTurn,
  turnByRun,
  turnsOf,
  updateTask,
  versionsOf,
  withdrawCancel,
  type ArtifactRecord,
  type CancelReason,
  type ConversationRecord,
  type ReviewRecord,
  type TaskRecord,
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
/** Why a plan can't be reviewed once its project is gone. */
const REVIEW_CLOSED = "This plan's project was removed, so it can't be reviewed. Its history stays here until you delete it.";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isRunNotFound = (error: unknown) => error instanceof RpcCallError && error.code === ErrorCode.RunNotFound;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/** Why a sandbox check can't start, and what stopped one (D36), in the person's terms. */
const UPLOADS_OFF = "This project doesn't allow uploading its commit to Nebius Sandboxes. Allow uploads for it, then check again.";
const UPLOADS_STOPPED =
  "Uploads for this project were turned off, so its sandbox check is being stopped. Anything it uploaded stays with Nebius: images are kept for 180 days, and no API deletes uploads, operation records or logs.";
const UPLOADS_STOPPED_STARTING = "Uploads for this project were turned off while its sandbox check was starting, so the check is being stopped.";
/** A preview snapshots the whole commit on the project's engine, which takes a while for a large repository. */
const SANDBOX_PREVIEW_MS = 180_000;

/**
 * A project's sandbox check this session (D36): the request id it was sent with, its run once known, and the engine
 * store it went to, where its absence means it never arrived (D26).
 */
interface SandboxCheck {
  requestId: string;
  runId: string | null;
  targetId: string;
  homeId: string;
  /** Sent with its answer lost, and not found yet. */
  looking: boolean;
  /** Its engine has no record of it: nothing was sent. */
  notSent: boolean;
  /** Not found in time: if it started, it ends at its own limit, or when its engine restarts. */
  lost: boolean;
  /** The person, or a withdrawn consent, asked it to stop before its run was known. */
  cancelRequested: boolean;
  note: string | null;
  /** Its last stop failed, and its note says so; `failedNotice` when the project's notice says so too. */
  stopFailed: boolean;
  failedNotice: boolean;
}

interface Engine {
  readonly target: ExecutionTarget;
  readonly supervisor: EngineSupervisor;
  warnings: string[];
}

type WslLookup = { target: ExecutionTarget } | { notReady: string } | { notFound: true };

/** What a conversation's run link sends: a turn, or a review of a plan version (D31). */
type LinkRequest = { workflowId: "chat"; input: ChatInput; context: ChatContext } | { workflowId: "review"; input: ReviewInput; context: ReviewContext };

/** A plan version to review, its conversation, and the project that conversation is about (null for a general one). */
interface ReviewSubject {
  plan: ArtifactRecord;
  conversation: ConversationRecord;
  project: ProjectRecord | null;
}

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
  /** Raised when a project's uploads are turned off, so a sandbox check started under old consent can be caught (D36). */
  readonly #cloudEpochs = new Map<string, number>();
  /** Each project's sandbox check this session (D36). */
  readonly #sandboxChecks = new Map<string, SandboxCheck>();
  /** Projects whose check is being started: one at a time, from before its first wait. */
  readonly #sandboxStarting = new Set<string>();
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
      openReview: openTurns(workspace, { conversationId }).find((link) => link.workflowId === "review")?.id ?? null,
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
    const busy = () => this.#busyReason(conversationId, "send again") ?? "This conversation is still waiting for an answer. Wait for it, or cancel it, then send again.";
    if (openTurns(workspace, { conversationId }).length) throw new Error(busy());
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
    if (!insertTurn(workspace, turn, { id: randomUUID(), text: message })) throw new Error(busy());
    this.#submissions.set(turnId, { cancel: null });
    const context: ChatContext = { preferences, sharing: { modelContext: conversation.projectId !== null }, history };
    void this.#submit(turnId, conversation, { workflowId: "chat", input, context }, epoch).catch((error: unknown) => this.#options.log(`A turn couldn't be sent: ${errorText(error)}`));
    return this.conversation(conversationId);
  }

  /**
   * Stops a turn the person no longer wants. One being sent stops before its request is written, or is cancelled as soon
   * as its engine answers; a running one is cancelled on its engine. Its end is recorded as cancelled by the person.
   */
  async cancelTurn(conversationId: string, turnId: string): Promise<ConversationView> {
    const turn = getTurn(this.#workspaceDb(), turnId);
    if (!turn || turn.conversationId !== conversationId || turn.workflowId !== "chat") throw new Error("That message is no longer in this conversation.");
    await this.#cancelLink(turn);
    return this.conversation(conversationId);
  }

  /**
   * Deletes a conversation with its turns, messages and plans (D26). Its turn still going is stopped first; when it
   * can't be, the conversation stays, and the person is told why. A turn whose run isn't known yet (still being sent,
   * or its answer lost) is stopped once its run is: this session keeps its request id until then. Text copied into a
   * task's brief stays with the task, and each engine keeps its own record of the runs.
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
    // Sent by this session to an engine still online, with no run known: its answer was lost. One still being sent is
    // stopped by its submission, when its engine answers.
    const lost = open.flatMap((turn) => {
      const engine = this.#engines.get(turn.targetId);
      const state = engine?.supervisor.state;
      return engine && state?.status === "online" && !turn.runId && turn.homeId === state.info.homeId && turn.sessionId === this.#sessionId && !this.#submissions.has(turn.id) ? [{ engine, turn }] : [];
    });
    deleteConversation(workspace, conversationId);
    for (const { engine, turn } of lost) this.#stopDeleted(engine, turn.id, turn.homeId!, null);
  }

  /**
   * Saves an answer as a plan (D26): version 1 of a new lineage, with where it came from. The person's edit of its text,
   * if any, is checked like anything they type.
   */
  async savePlan(conversationId: string, messageId: string, text?: string): Promise<PlanView> {
    const workspace = this.#workspaceDb();
    const conversation = getConversation(workspace, conversationId);
    if (!conversation) throw new Error("That conversation is no longer in the list.");
    const answer = messagesOf(workspace, conversationId).find((m) => m.id === messageId && m.role === "assistant");
    if (!answer?.reply) throw new Error("That answer is no longer in this conversation.");
    const runId = answer.turnId ? (getTurn(workspace, answer.turnId)?.runId ?? null) : null;
    const content = planFromAnswer(answer.reply, { conversationId, messageId, runId, projectId: conversation.projectId });
    if (text !== undefined) {
      const edited = this.#planText(text);
      refuseCredentials("The plan", edited, await this.#knownSecrets());
      content.text = edited;
    }
    const plan = insertArtifact(workspace, { id: randomUUID(), kind: "plan", lineageId: randomUUID(), content, conversationId, taskId: null, messageId, runLinkId: answer.turnId, derivedFrom: null, createdAt: new Date().toISOString() });
    return this.#planView(plan!);
  }

  /** Saves an edit of a plan as its next version; the versions before it, and briefs made from them, stay as they are. */
  async revisePlan(planId: string, text: string): Promise<PlanView> {
    const workspace = this.#workspaceDb();
    const plan = getArtifact(workspace, planId);
    if (!plan || plan.kind !== "plan") throw new Error("That plan is no longer here.");
    const edited = this.#planText(text);
    refuseCredentials("The plan", edited, await this.#knownSecrets());
    const latest = versionsOf(workspace, plan.lineageId).at(-1)!;
    const next = insertArtifact(
      workspace,
      { id: randomUUID(), kind: "plan", lineageId: plan.lineageId, content: { ...(latest.content as PlanContent), text: edited }, conversationId: latest.conversationId, taskId: null, messageId: latest.messageId, runLinkId: latest.runLinkId, derivedFrom: latest.id, createdAt: new Date().toISOString() },
      latest.version,
    );
    if (!next) throw new Error("This plan changed since you opened it. Open it again, then make your edit.");
    return this.#planView(next);
  }

  /** A conversation's plans: every version, oldest first. */
  plans(conversationId: string): PlanView[] {
    const workspace = this.#workspaceDb();
    const plans = workspace.db.prepare("SELECT id FROM artifacts WHERE kind = 'plan' AND conversation_id = ? ORDER BY created_at, version").all(conversationId);
    return plans.map((row) => this.#planView(getArtifact(workspace, String(row["id"]))!));
  }

  /**
   * What a review of one saved plan version would send (D31), and the fingerprint that binds it: the version's text,
   * assumptions and historical references, and the preferences that apply to its conversation. Reads only: nothing is
   * stored or sent, and no engine starts. A plan whose project was removed can't be reviewed; one whose project doesn't
   * allow sharing is previewed, and says so.
   */
  async prepareReview(planId: string, panel: ReviewPanel): Promise<ReviewPreview> {
    return (await this.#reviewRequest(this.#reviewSubject(planId), panel)).preview;
  }

  /**
   * Starts the review the person previewed (D31). Everything is worked out again from the records as they are now and
   * refused when its fingerprint isn't the one previewed, so a review sends exactly what was shown. Consent is checked
   * as for a turn: now, again after that wait against the consent epoch, and once more when its request is out. The
   * review is stored first, then sent in the background on its conversation's engine; its report is kept when it ends.
   * A review writes no plan, task, brief or preference.
   */
  async startReview(planId: string, panel: ReviewPanel, expected: string): Promise<ReviewView> {
    const workspace = this.#workspaceDb();
    const subject = this.#reviewSubject(planId);
    const epoch = subject.project ? this.#epochOf(subject.project.id) : 0;
    const request = await this.#reviewRequest(subject, panel);
    if (request.preview.blocked) throw new Error(request.preview.blocked);
    if (request.preview.expected !== expected) throw new Error("What this review would send has changed since you opened it. Check the new preview, then start again.");
    const { plan, conversation, project } = subject;
    if (project) {
      const now = this.#options.store.data.projects.find((p) => p.id === project.id);
      if (!now || this.#removing.has(project.id)) throw new Error(REVIEW_CLOSED);
      if (!now.sharing.modelContext || this.#epochOf(project.id) !== epoch) throw new Error("Sharing for this project was turned off, so the review wasn't started.");
    }
    if (!getConversation(workspace, conversation.id) || !getArtifact(workspace, plan.id)) throw new Error("That plan is no longer here.");
    const id = randomUUID();
    const review = {
      id,
      conversationId: conversation.id,
      planId: plan.id,
      planLineage: plan.lineageId,
      planVersion: plan.version,
      planSha256: plan.sha256,
      panel,
      packetDigest: request.input.packetDigest,
      preferencesDigest: request.input.preferencesDigest,
      scope: project ? { kind: "project" as const, projectId: project.id, projectLabel: project.label, headAtStart: request.preview.scope.kind === "project" ? request.preview.scope.headAtStart : null } : { kind: "general" as const },
      createdAt: new Date().toISOString(),
    };
    const given = request.context.preferences.records.map(({ id: preferenceId, revision }) => ({ id: preferenceId, revision }));
    if (!insertReview(workspace, review, { sessionId: this.#sessionId, targetId: conversation.targetId, preferences: given })) {
      throw new Error(this.#busyReason(conversation.id, "start the review") ?? "This conversation is busy. Wait for it, then start the review.");
    }
    this.#submissions.set(id, { cancel: null });
    void this.#submit(id, conversation, { workflowId: "review", input: request.input, context: request.context }, epoch).catch((error: unknown) => this.#options.log(`A review couldn't be sent: ${errorText(error)}`));
    return this.#reviewView(getReview(workspace, id)!, this.#engineView(conversation.targetId));
  }

  /** A conversation's reviews, oldest first, read from the workspace. Asks no engine and starts nothing. */
  reviews(conversationId: string): ReviewView[] {
    const workspace = this.#workspaceDb();
    const record = getConversation(workspace, conversationId);
    if (!record) throw new Error("That conversation is no longer in the list.");
    const engine = this.#engineView(record.targetId);
    return reviewsOf(workspace, conversationId).map((review) => this.#reviewView(review, engine));
  }

  /** Stops a review the person no longer wants, as a turn is stopped; its end is recorded as cancelled by the person. */
  async cancelReview(conversationId: string, reviewId: string): Promise<ReviewView[]> {
    const review = getReview(this.#workspaceDb(), reviewId);
    if (!review || review.conversationId !== conversationId) throw new Error("That review is no longer in this conversation.");
    await this.#cancelLink(review.link);
    return this.reviews(conversationId);
  }

  /** The workspace's state and every task, the most recently changed first. */
  tasks(): TasksView {
    const workspace = this.#workspace;
    return { workspace: this.#workspaceView(), tasks: workspace.state === "ready" ? listTasks(workspace.db).map((task) => this.#taskSummary(task)) : [] };
  }

  task(taskId: string): TaskView {
    const workspace = this.#workspaceDb();
    const task = getTask(workspace, taskId);
    if (!task) throw new Error("That task is no longer in the list.");
    const versions = versionsOf(workspace, taskId);
    const brief = versions.at(-1)!;
    const content = BriefContentSchema.parse(brief.content);
    const byId = new Map(versions.map((version) => [version.id, version.version]));
    return {
      summary: this.#taskSummary(task),
      revision: task.revision,
      brief: { id: brief.id, version: brief.version, sha256: brief.sha256, content, createdAt: brief.createdAt },
      versions: versions.map(({ id, version, createdAt }) => ({ id, version, createdAt })),
      sourcePlans: content.sources.map((source) => {
        const latest = versionsOf(workspace, source.planLineage).at(-1);
        return { planLineage: source.planLineage, usedVersion: source.planVersion, latestVersion: latest?.version ?? null, latestPlanId: latest?.id ?? null, conversationId: source.conversationId };
      }),
      attempts: attemptsOf(workspace, taskId).map((attempt) => ({ id: attempt.id, briefVersion: byId.get(attempt.briefId) ?? getArtifact(workspace, attempt.briefId)?.version ?? 0, status: attempt.status, createdAt: attempt.createdAt })),
      runUnavailable: RUN_UNAVAILABLE,
    };
  }

  /**
   * Creates a native task with its first brief (D26, NIV-32): written directly, or from a plan version, which then
   * gives the brief its source. Either way the brief has the same shape. Needs no tracker and no repository yet. A plan
   * from another project's conversation follows the rule for moving a task: what the brief would take from that project
   * is cleared and marked to be written again.
   */
  async createTask(input: { title: string; fields: BriefFields; projectId: string | null; planId: string | null }): Promise<TaskView> {
    const workspace = this.#workspaceDb();
    const title = this.#taskTitle(input.title);
    const fields = this.#briefFields(input.fields);
    this.#refuseInBrief(title, fields, await this.#knownSecrets());
    if (input.projectId !== null) this.#project(input.projectId);
    let sources: BriefContent["sources"] = [];
    if (input.planId !== null) {
      const plan = getArtifact(workspace, input.planId);
      if (!plan || plan.kind !== "plan") throw new Error("That plan is no longer here.");
      sources = [sourceFrom({ id: plan.id, lineageId: plan.lineageId, version: plan.version, content: plan.content as PlanContent })];
    }
    const drafted = briefFrom(fields, sources);
    const content = briefForRepository(drafted, input.projectId) ?? drafted;
    const now = new Date().toISOString();
    const id = randomUUID();
    insertTask(workspace, { id, title, projectId: input.projectId, createdAt: now, updatedAt: now }, { id: randomUUID(), content, derivedFrom: content.sources[0]?.planId ?? null });
    return this.task(id);
  }

  /**
   * Saves an edit of a task's brief as its next version, from the task's revision as it was read. A ready task whose
   * brief no longer has a goal and a criterion goes back to draft. A completed task is reopened first.
   */
  async reviseBrief(taskId: string, revision: number, input: BriefFields): Promise<TaskView> {
    const workspace = this.#workspaceDb();
    const task = this.#taskAt(taskId, revision);
    if (task.state === "completed") throw new Error("This task is completed. Reopen it to change its brief.");
    const fields = this.#briefFields(input);
    this.#refuseInBrief(task.title, fields, await this.#knownSecrets());
    const latest = versionsOf(workspace, taskId).at(-1)!;
    const before = BriefContentSchema.parse(latest.content);
    // A part marked to be written again for a new repository stays marked until something is written there.
    const revalidate = before.revalidate.filter((part) => (part === "context" ? fields.context === "" : fields.assumptions.length === 0));
    const content: BriefContent = { ...before, ...fields, revalidate };
    this.#commitBrief(task, latest, content, { state: task.state === "ready" && !briefIsReady(content) ? "draft" : task.state });
    return this.task(taskId);
  }

  /** Takes a newer version of a plan the brief came from into its next version: the plan's text, assumptions and source. */
  refreshBriefFromPlan(taskId: string, revision: number, planId: string): TaskView {
    const workspace = this.#workspaceDb();
    const task = this.#taskAt(taskId, revision);
    if (task.state === "completed") throw new Error("This task is completed. Reopen it to change its brief.");
    const plan = getArtifact(workspace, planId);
    if (!plan || plan.kind !== "plan") throw new Error("That plan is no longer here.");
    const latest = versionsOf(workspace, taskId).at(-1)!;
    const before = BriefContentSchema.parse(latest.content);
    if (!before.sources.some((source) => source.planLineage === plan.lineageId)) throw new Error("This task's brief didn't come from that plan.");
    const content = plan.content as PlanContent;
    const source = sourceFrom({ id: plan.id, lineageId: plan.lineageId, version: plan.version, content });
    const next: BriefContent = { ...before, context: content.text.slice(0, TASK_LIMITS.contextChars), assumptions: content.assumptions.slice(0, TASK_LIMITS.items), sources: before.sources.map((s) => (s.planLineage === plan.lineageId ? source : s)), revalidate: [] };
    this.#commitBrief(task, latest, next, {});
    return this.task(taskId);
  }

  /**
   * Sets the repository a task will run on, or none. What its brief took from another project's conversation is
   * cleared in a new version and marked to be written again (D26), so a project's material never moves with a task.
   */
  setTaskProject(taskId: string, revision: number, projectId: string | null): TaskView {
    const workspace = this.#workspaceDb();
    const task = this.#taskAt(taskId, revision);
    if (projectId !== null) this.#project(projectId);
    const latest = versionsOf(workspace, taskId).at(-1)!;
    const cleared = briefForRepository(BriefContentSchema.parse(latest.content), projectId);
    if (cleared) this.#commitBrief(task, latest, cleared, { projectId, state: task.state === "ready" && !briefIsReady(cleared) ? "draft" : task.state });
    else if (!updateTask(workspace, taskId, revision, { projectId }, new Date().toISOString())) throw new Error("This task changed since you opened it. Open it again, then try again.");
    return this.task(taskId);
  }

  /** Moves a task to the state the person asked for, when its brief allows it (D26). */
  setTaskState(taskId: string, revision: number, state: TaskState): TaskView {
    const workspace = this.#workspaceDb();
    const task = this.#taskAt(taskId, revision);
    const brief = BriefContentSchema.parse(versionsOf(workspace, taskId).at(-1)!.content);
    const next = nextState(task.state, state, brief);
    if (next !== task.state && !updateTask(workspace, taskId, revision, { state: next }, new Date().toISOString())) throw new Error("This task changed since you opened it. Open it again, then try again.");
    return this.task(taskId);
  }

  async renameTask(taskId: string, revision: number, title: string): Promise<TaskView> {
    const workspace = this.#workspaceDb();
    this.#taskAt(taskId, revision);
    const next = this.#taskTitle(title);
    refuseCredentials("The title", next, await this.#knownSecrets());
    if (!updateTask(workspace, taskId, revision, { title: next }, new Date().toISOString())) throw new Error("This task changed since you opened it. Open it again, then try again.");
    return this.task(taskId);
  }

  /** Deletes a task with its brief versions. */
  deleteTask(taskId: string): void {
    if (!deleteTask(this.#workspaceDb(), taskId)) throw new Error("That task is no longer in the list.");
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
    await this.#restartTarget(this.#project(projectId).targetId);
  }

  /**
   * Restarts the engine a conversation's turns run on, then follows its open turns there (D26). A general conversation
   * has no project to restart it from, so this is its way back after its engine stops.
   */
  async restartConversationEngine(conversationId: string): Promise<ConversationView> {
    const record = getConversation(this.#workspaceDb(), conversationId);
    if (!record) throw new Error("That conversation is no longer in the list.");
    await this.#restartTarget(record.targetId);
    return this.openConversation(conversationId);
  }

  async #restartTarget(targetId: string): Promise<void> {
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

  /**
   * Allows or stops uploading the project's commit to Nebius Sandboxes (D36), independent of model-context consent.
   * Stopping raises the project's upload epoch, which a check being started checks, and cancels its check under way;
   * what that check uploaded stays with Nebius, and the project's notice says so once the stop is accepted. A check
   * that couldn't be stopped is reported, in the notice too, never passed over.
   */
  async setCloudExecution(projectId: string, cloudExecution: boolean): Promise<ProjectView> {
    this.#project(projectId);
    this.#options.store.update((data) => ({ ...data, projects: data.projects.map((p) => (p.id === projectId ? { ...p, sharing: { ...p.sharing, cloudExecution } } : p)) }));
    if (!cloudExecution) {
      this.#cloudEpochs.set(projectId, this.#cloudEpochOf(projectId) + 1);
      const check = this.#sandboxChecks.get(projectId);
      // A check whose state can't be read is treated as going: stopping one that had ended does no harm.
      if (check && !(await this.#sandboxEnded(check).catch(() => false))) {
        await this.#stopForUploads(projectId, check, UPLOADS_STOPPED);
        this.#notices.set(projectId, UPLOADS_STOPPED);
      }
    }
    return this.#view(this.#project(projectId));
  }

  /**
   * What a sandbox check of the project would send, worked out on the project's own engine with no network, for the
   * person to see before anything is uploaded (D36). It needs no consent: nothing leaves the machine.
   */
  async previewSandboxCheck(projectId: string): Promise<SandboxPreview> {
    const project = this.#project(projectId);
    if (this.#removing.has(projectId)) throw new Error("This project is being removed, so it can't be checked.");
    const engine = await this.#started(project.targetId);
    return engine.supervisor.call("sandbox.preview", { repoPath: project.nativePath }, { timeoutMs: SANDBOX_PREVIEW_MS });
  }

  /**
   * Starts a sandbox check of the project's commit (D36), bound to the preview the person saw by its fingerprint: the
   * engine refuses a commit that changed since. Refused while the project doesn't allow uploads. Consent and its epoch
   * are checked immediately before sending, and again on the answer: a check started while uploads were being turned
   * off is cancelled at once. A start whose answer was lost is found by its request id, never sent again.
   */
  async startSandboxCheck(projectId: string, expected: string): Promise<SandboxCheckView> {
    const project = this.#project(projectId);
    if (this.#removing.has(projectId)) throw new Error("This project is being removed, so it can't be checked.");
    if (!project.sharing.cloudExecution) throw new Error(UPLOADS_OFF);
    // One check of a project at a time: claimed before the first wait, so a second start can't slip in behind it.
    if (this.#sandboxStarting.has(projectId)) throw new Error("A sandbox check of this project is already being started.");
    this.#sandboxStarting.add(projectId);
    try {
      return await this.#startSandbox(projectId, project, expected);
    } finally {
      this.#sandboxStarting.delete(projectId);
    }
  }

  async #startSandbox(projectId: string, project: ProjectRecord, expected: string): Promise<SandboxCheckView> {
    const going = this.#sandboxChecks.get(projectId);
    if (going) {
      // A check whose state can't be read is never taken to have ended.
      const ended = await this.#sandboxEnded(going).catch((error: unknown) => {
        throw new Error(`Nivra can't read this project's last sandbox check from its engine now (${errorText(error)}), so it didn't start another. Try again in a moment.`);
      });
      if (!ended) throw new Error("A sandbox check of this project is still going. Wait for it to end, or cancel it, then check again.");
    }
    const epoch = this.#cloudEpochOf(projectId);
    const label = this.#labelOf(project.targetId);
    const engine = await this.#started(project.targetId);
    const state = engine.supervisor.state;
    if (state.status !== "online") throw new Error(`The engine on ${label} isn't running, so nothing was sent.`);
    // Checked again immediately before sending: uploads can be turned off, and the project removed, while the engine starts.
    if (!this.#uploadsAllowed(projectId, epoch)) throw new Error("Uploads for this project were turned off, so the check wasn't started.");
    const current = this.#project(projectId);
    const check: SandboxCheck = { requestId: randomUUID(), runId: null, targetId: current.targetId, homeId: state.info.homeId, looking: false, notSent: false, lost: false, cancelRequested: false, note: null, stopFailed: false, failedNotice: false };
    this.#sandboxChecks.set(projectId, check);
    let run: RunSummary;
    try {
      run = await engine.supervisor.call("runs.start", {
        clientRequestId: check.requestId,
        workflowId: "sandbox",
        input: { repoPath: current.nativePath, project: current.id, target: current.targetId, preview: expected },
        context: { sharing: { cloudExecution: true } },
      });
    } catch (error) {
      // Nothing was written: the engine wasn't online, or the request was refused before it was sent.
      if (error instanceof EngineOfflineError || error instanceof TypeError) {
        check.notSent = true;
        check.note = `The engine on ${label} didn't take the check (${errorText(error)}), so nothing was sent.`;
        return this.#sandboxView(projectId);
      }
      // The engine may have started it first: it is found by its request id, and never sent again.
      this.#options.log(`A sandbox check's start got no usable answer (${error instanceof Error ? error.name : "unknown"}); it is found by its request id, never sent again.`);
      check.looking = true;
      check.note = "Nivra didn't hear back whether the check started, so it is looking for it by its request id. Nothing is sent again.";
      // An error answer is the engine's own words: shown if the search then finds the check was never recorded.
      void this.#findSandboxRun(projectId, check, engine, epoch, error instanceof RpcCallError ? errorText(error) : null);
      return this.#sandboxView(projectId);
    }
    check.runId = run.id;
    this.#runs.set(run.id, current.targetId);
    // A late answer is accepted only while uploads stay allowed: otherwise the check stops now.
    if (check.cancelRequested || !this.#uploadsAllowed(projectId, epoch)) await this.#stopStarted(projectId, check, epoch);
    return this.#sandboxView(projectId);
  }

  /** Stops the project's sandbox check, or marks one being found so that it stops once it is; what it uploaded stays. */
  async cancelSandboxCheck(projectId: string): Promise<SandboxCheckView> {
    this.#project(projectId);
    const check = this.#sandboxChecks.get(projectId);
    if (!check) throw new Error("No sandbox check of this project was started this session.");
    await this.#cancelSandboxRun(projectId, check, null);
    return this.#sandboxView(projectId);
  }

  /** The project's sandbox check this session, as it is now; null when none was started. */
  async sandboxCheck(projectId: string): Promise<SandboxCheckView | null> {
    this.#project(projectId);
    return this.#sandboxChecks.has(projectId) ? this.#sandboxView(projectId) : null;
  }

  /** What the project's engine has left open in Nebius from earlier sessions, and its recovery pass (D33, D36). */
  async sandboxStatus(projectId: string): Promise<SandboxStatus> {
    const engine = await this.#started(this.#project(projectId).targetId);
    return engine.supervisor.call("sandbox.status", {});
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
   * project withdraws its consent first: its epochs move (and stay moved), so an explanation or a sandbox check being
   * submitted stops itself, and its queued and running explanations and its check are cancelled. When one can't be
   * stopped, the project stays.
   */
  async removeProject(projectId: string): Promise<{ preferencesRemoved: number }> {
    this.#project(projectId);
    if (this.#removing.has(projectId)) throw new Error("This project is already being removed.");
    // Marked before the first wait, so no explanation can start while its runs are being stopped.
    this.#removing.add(projectId);
    this.#sharingEpochs.set(projectId, this.#epochOf(projectId) + 1);
    this.#cloudEpochs.set(projectId, this.#cloudEpochOf(projectId) + 1);
    const withdraw = this.#markProjectTurns(projectId, "removal");
    try {
      await this.#stopExplainRuns(projectId, (runs, why) => `Nivra couldn't stop ${runs} (${why}), so the project is still in the list. Restart its engine, then remove it again.`);
      const check = this.#sandboxChecks.get(projectId);
      if (check && !(await this.#sandboxEnded(check).catch(() => false))) {
        await this.#cancelSandboxRun(projectId, check, null, (why) => `Nivra couldn't stop the project's sandbox check (${why}), so the project is still in the list. Restart its engine, then remove it again.`);
      }
    } catch (error) {
      withdraw();
      this.#removing.delete(projectId);
      throw error;
    }
    this.#notices.delete(projectId);
    this.#explainRuns.delete(projectId);
    this.#conversationRuns.delete(projectId);
    this.#sandboxChecks.delete(projectId);
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
    const remove = (["NEBIUS_API_KEY", "NEBIUS_PROJECT_ID"] as const).filter((name) => !secrets[name]);
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

  #cloudEpochOf(projectId: string): number {
    return this.#cloudEpochs.get(projectId) ?? 0;
  }

  /** Whether the project still allows uploads as it did at `epoch`: still listed, not being removed, never turned off since. */
  #uploadsAllowed(projectId: string, epoch: number): boolean {
    const project = this.#options.store.data.projects.find((p) => p.id === projectId);
    return Boolean(project?.sharing.cloudExecution) && !this.#removing.has(projectId) && this.#cloudEpochOf(projectId) === epoch;
  }

  /**
   * Whether a check has ended: its run seen to reach a terminal status, or it never reached the engine, or it was
   * given up on. A run whose engine isn't online isn't running any more (D4).
   */
  async #sandboxEnded(check: SandboxCheck): Promise<boolean> {
    if (check.notSent || check.lost) return true;
    if (check.runId === null) return false;
    const engine = this.#engines.get(check.targetId);
    if (!engine || engine.supervisor.state.status !== "online") return true;
    try {
      return isTerminal((await engine.supervisor.call("runs.get", { runId: check.runId })).status);
    } catch (error) {
      if (isRunNotFound(error)) return true;
      throw error;
    }
  }

  /**
   * Cancels a check's run, and gives it `note` once the stop is accepted. One whose run isn't known yet is marked, and
   * its search cancels it once it is found. An engine that isn't online isn't running it any more. One that couldn't be
   * stopped says so in its note instead, and is reported through `refusal`; a stop accepted later takes that back.
   */
  async #cancelSandboxRun(projectId: string, check: SandboxCheck, note: string | null, refusal = (why: string) => `Nivra couldn't stop the sandbox check (${why}). Restart the project's engine to stop it.`): Promise<void> {
    check.cancelRequested = true;
    const engine = check.runId === null ? undefined : this.#engines.get(check.targetId);
    if (check.runId !== null && engine && engine.supervisor.state.status === "online") {
      try {
        await engine.supervisor.call("runs.cancel", { runId: check.runId });
      } catch (error) {
        if (!isRunNotFound(error)) {
          check.stopFailed = true;
          check.note = `Nivra couldn't stop the sandbox check (${errorText(error)}). Restart the project's engine to stop it.`;
          throw new Error(refusal(errorText(error)));
        }
      }
    }
    if (!check.stopFailed) {
      if (note) check.note = note;
      return;
    }
    // Stopped after a stop that failed: nothing says any more that it couldn't be.
    check.stopFailed = false;
    check.note = note;
    if (check.failedNotice) {
      check.failedNotice = false;
      const project = this.#options.store.data.projects.find((p) => p.id === projectId);
      if (project?.sharing.cloudExecution) this.#notices.delete(projectId);
      else if (project) this.#notices.set(projectId, UPLOADS_STOPPED);
    }
  }

  /** Stops a check because uploads were turned off. A stop that fails says so in the project's notice too. */
  async #stopForUploads(projectId: string, check: SandboxCheck, note: string | null): Promise<void> {
    try {
      await this.#cancelSandboxRun(projectId, check, note);
    } catch (error) {
      check.failedNotice = true;
      this.#notices.set(projectId, `Uploads for this project were turned off. ${errorText(error)}`);
      throw error;
    }
  }

  /** Stops a check whose run became known after it was asked to stop, or after uploads were turned off. */
  async #stopStarted(projectId: string, check: SandboxCheck, epoch: number): Promise<void> {
    const note = check.cancelRequested ? null : UPLOADS_STOPPED_STARTING;
    if (this.#uploadsAllowed(projectId, epoch)) await this.#cancelSandboxRun(projectId, check, note);
    else await this.#stopForUploads(projectId, check, note);
  }

  /**
   * Looks for a check whose start got no usable answer, by its request id, on the engine store it was sent to (D26).
   * Found, it becomes the project's check, and stops at once if it was asked to or uploads were turned off meanwhile.
   * Absent from that same store, nothing was sent; an error answer's own words say why. Never sent again either way.
   */
  async #findSandboxRun(projectId: string, check: SandboxCheck, engine: Engine, epoch: number, answered: string | null): Promise<void> {
    let delay = 400;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (this.#closing || this.#engines.get(check.targetId) !== engine) break;
      const state = engine.supervisor.state;
      if (state.status === "online" && state.info.homeId === check.homeId) {
        let found: RunSummary | null;
        try {
          found = await engine.supervisor.call("runs.find", { clientRequestId: check.requestId });
        } catch (error) {
          this.#options.log(`A sandbox check's start couldn't be looked up yet (${errorText(error)}); Nivra tries again.`);
          await pause(delay);
          delay = Math.min(delay * 2, 5_000);
          continue;
        }
        check.looking = false;
        if (!found) {
          check.notSent = true;
          check.note = answered ? `The engine didn't start the check, so nothing was sent. ${answered}` : "The engine has no record of the check, so nothing was sent.";
          return;
        }
        check.runId = found.id;
        this.#runs.set(found.id, check.targetId);
        check.note = null;
        // Found, it is known: a stop that fails now says so in its note (and the notice, if uploads were turned off),
        // never taken for not knowing whether it started.
        if (check.cancelRequested || !this.#uploadsAllowed(projectId, epoch)) await this.#stopStarted(projectId, check, epoch).catch(() => undefined);
        return;
      }
      await pause(delay);
      delay = Math.min(delay * 2, 5_000);
    }
    check.looking = false;
    check.lost = true;
    check.note = "Nivra couldn't find out whether the check started, and sent nothing again. If it did start, it ends at its own time limit, or when its engine restarts.";
  }

  /** A check as the window shows it: its run's status and the engine's report, or where its start stands. */
  async #sandboxView(projectId: string): Promise<SandboxCheckView> {
    const check = this.#sandboxChecks.get(projectId);
    if (!check) throw new Error("No sandbox check of this project was started this session.");
    if (check.runId === null) return { runId: null, status: check.notSent ? "not-sent" : check.lost ? "unknown" : check.looking ? "looking" : "sending", report: null, note: check.note };
    const engine = this.#engines.get(check.targetId);
    if (!engine || engine.supervisor.state.status !== "online") {
      return { runId: check.runId, status: "unknown", report: null, note: check.note ?? `The engine on ${this.#labelOf(check.targetId)} isn't running, so the check can't be read now.` };
    }
    try {
      const [summary, report] = await Promise.all([engine.supervisor.call("runs.get", { runId: check.runId }), engine.supervisor.call("runs.sandbox", { runId: check.runId })]);
      return { runId: check.runId, status: summary.status, report, note: check.note };
    } catch (error) {
      // A check that can't be read now is a state to show, never an error: it may well have started.
      return { runId: check.runId, status: "unknown", report: null, note: check.note ?? `Nivra can't read the check from its engine now (${errorText(error)}).` };
    }
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

  /** Why a conversation can't take another run now (D31): a turn or a review still going, in the person's terms; null when it can. */
  #busyReason(conversationId: string, then: string): string | null {
    const open = openTurns(this.#workspaceDb(), { conversationId });
    if (!open.length) return null;
    return open.some((link) => link.workflowId === "review")
      ? `A review of a plan is running in this conversation. Wait for it, or cancel it, then ${then}.`
      : `This conversation is still waiting for an answer. Wait for it, or cancel it, then ${then}.`;
  }

  /**
   * Stops a run link the person no longer wants. One being sent stops before its request is written, or is cancelled as
   * soon as its engine answers; a running one is cancelled on its engine.
   */
  async #cancelLink(link: TurnRecord): Promise<void> {
    if (link.status !== "submitting" && link.status !== "running") return;
    requestCancel(this.#workspaceDb(), link.id, "person");
    const pending = this.#submissions.get(link.id);
    if (pending) pending.cancel ??= "person";
    if (link.runId) await this.cancelRun(link.runId);
    else if (!pending) this.#follow(link.id);
  }

  /** A plan version to review, with its conversation and project; refused in plain words when it can't be reviewed. */
  #reviewSubject(planId: string): ReviewSubject {
    const workspace = this.#workspaceDb();
    const plan = getArtifact(workspace, planId);
    const conversation = plan?.kind === "plan" && plan.conversationId ? getConversation(workspace, plan.conversationId) : null;
    if (!plan || !conversation) throw new Error("That plan is no longer here.");
    if (conversation.projectId === null) return { plan, conversation, project: null };
    const project = this.#options.store.data.projects.find((p) => p.id === conversation.projectId);
    if (!project) throw new Error(REVIEW_CLOSED);
    if (this.#removing.has(project.id)) throw new Error("This plan's project is being removed, so it can't be reviewed.");
    return { plan, conversation, project };
  }

  /**
   * Everything a review of `subject` would send, worked out from the records as they are now (D31): the packet, the
   * preference snapshot (D21: a general plan's gets the personal preferences only), their fingerprints, and the preview
   * that shows them, with the fingerprint that binds it.
   */
  async #reviewRequest({ plan, conversation, project }: ReviewSubject, panel: ReviewPanel): Promise<{ preview: ReviewPreview; input: ReviewInput; context: ReviewContext }> {
    const preferences = snapshotFor(this.#options.store.data, conversation.projectId);
    const sharing = project ? project.sharing.modelContext : null;
    const packet = packetFor(plan, conversation, await this.#knownSecrets());
    const [packetFingerprint, preferencesFingerprint] = await Promise.all([packetDigest(packet), preferencesDigest(preferences.records)]);
    const blocked =
      this.#busyReason(conversation.id, "start the review") ??
      (project && !sharing ? "This project doesn't allow sending its content to Token Factory. Allow sharing for it, then start the review." : null);
    const preview: ReviewPreview = {
      planId: plan.id,
      planLineage: plan.lineageId,
      planVersion: plan.version,
      latestVersion: versionsOf(this.#workspaceDb(), plan.lineageId).at(-1)?.version ?? plan.version,
      panel,
      scope: project
        ? { kind: "project", projectLabel: project.label, targetLabel: this.#labelOf(project.targetId), headAtStart: packet.scope.kind === "project" ? packet.scope.headAtStart : null, sharing: sharing === true }
        : { kind: "general" },
      sends: {
        textChars: packet.text.length,
        assumptions: packet.assumptions.length,
        references: packet.references.length,
        preferences: preferences.records.map(({ statement, scope, intent }) => ({ statement, scope, intent })),
      },
      requests: REVIEW_REQUESTS[panel],
      blocked,
      expected: previewFingerprint({ planId: plan.id, planVersion: plan.version, packetDigest: packetFingerprint, preferencesDigest: preferencesFingerprint, sharing, panel }),
    };
    return {
      preview,
      input: { panel, planId: plan.id, planVersion: plan.version, packetDigest: packetFingerprint, preferencesDigest: preferencesFingerprint },
      context: { preferences, sharing: { modelContext: project !== null }, packet },
    };
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
   * Sends a stored turn or review (D26, D31). The request is written only after the engine's store is recorded with it,
   * so one with none was never sent. A failure known to come before writing is "not sent"; anything after it (no answer,
   * a closed connection, an error answer: the engine may have started the run first) leaves it to be found by its
   * request id.
   */
  async #submit(turnId: string, conversation: ConversationRecord, request: LinkRequest, epoch: number): Promise<void> {
    const workspace = this.#workspaceDb();
    const label = this.#labelOf(conversation.targetId);
    const what = request.workflowId === "review" ? "this review" : "this message";
    const notSent = (why: string) => {
      this.#submissions.delete(turnId);
      this.#settle(turnId, { status: "not-sent", errorMessage: why });
    };
    let engine: Engine;
    try {
      engine = await this.#ensure(conversation.targetId);
      if (engine.supervisor.state.status === "starting") await engine.supervisor.start();
    } catch (error) {
      notSent(`The engine on ${label} couldn't start (${errorText(error)}), so ${what} wasn't sent and nothing reached the model.`);
      return;
    }
    const state = engine.supervisor.state;
    if (state.status !== "online") {
      notSent(`The engine on ${label} isn't running${state.status === "failed" ? ` (${state.reason})` : ""}, so ${what} wasn't sent and nothing reached the model.`);
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
      run = await engine.supervisor.call("runs.start", { clientRequestId: turnId, ...request });
    } catch (error) {
      // Nothing was written: the engine wasn't online, or the parameters were refused before sending.
      if (error instanceof EngineOfflineError || error instanceof TypeError) {
        notSent(`The engine on ${label} didn't take ${what} (${errorText(error)}), so nothing reached the model.`);
        return;
      }
      this.#options.log(`A turn's request got no usable answer (${error instanceof Error ? error.name : "unknown"}); it is found by its request id, never sent again.`);
      this.#submissions.delete(turnId);
      // Its conversation was deleted while the request was out: the run the engine may have made is still looked for.
      if (this.#workspace.state === "ready" && getTurn(this.#workspace.db, turnId) === null) this.#stopDeleted(engine, turnId, state.info.homeId, null);
      else this.#follow(turnId);
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
    if (getTurn(workspace, turnId) === null) {
      this.#stopDeleted(engine, turnId, state.info.homeId, run.id);
      return;
    }
    if (late) {
      requestCancel(workspace, turnId, late);
      await engine.supervisor.call("runs.cancel", { runId: run.id }).catch((error: unknown) => this.#options.log(`A turn stopped while it was being sent couldn't be cancelled: ${errorText(error)}`));
    }
    this.#follow(turnId);
  }

  /**
   * Stops the run of a turn whose conversation was deleted before that run was known to have stopped (D26). The turn's
   * record is gone, so this session keeps what it needs: the run's id, or the request id to find it by. Only this
   * session's engine, while it stays online on the same store, can be running it: an engine that stops takes its runs
   * with it, and one that starts fails them as interrupted (D4).
   */
  #stopDeleted(engine: Engine, turnId: string, homeId: string, runId: string | null): void {
    void (async () => {
      let known = runId;
      let delay = 400;
      for (let attempt = 0; attempt < 12; attempt++) {
        const state = engine.supervisor.state;
        if (this.#closing || this.#engines.get(engine.target.descriptor.id) !== engine || state.status !== "online" || state.info.homeId !== homeId) return;
        try {
          if (!known) {
            const found = await engine.supervisor.call("runs.find", { clientRequestId: turnId });
            if (!found || isTerminal(found.status)) return;
            known = found.id;
          }
          await engine.supervisor.call("runs.cancel", { runId: known });
          return;
        } catch (error) {
          if (isRunNotFound(error)) return;
          this.#options.log(`A deleted conversation's run couldn't be stopped yet (${errorText(error)}); Nivra tries again.`);
        }
        await pause(delay);
        delay = Math.min(delay * 2, 5_000);
      }
      this.#options.log(`A deleted conversation's run on ${this.#labelOf(engine.target.descriptor.id)} couldn't be stopped. It ends at its own time limit, or when that engine restarts.`);
    })();
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
    const link = getTurn(workspace, turnId);
    if (link?.workflowId === "review") return this.#finishReview(link, engine, summary);
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
    const { interrupted, kind } = await this.#failureOf(engine, summary.id);
    if (interrupted) this.#settle(turnId, { status: "interrupted" });
    else this.#settle(turnId, { status: "failed", errorKind: kind, errorMessage: maskForStorage(summary.error ?? "The run failed.", known) });
  }

  /**
   * Records how a review's run ended (D31), with the report its engine saved, masked again. A report that isn't the one
   * this review asked for (another plan version, fingerprint, panel, request or run) is kept nowhere, and the review's
   * end is unknown. A partial report is kept with how it ended: cancelled, interrupted, or failed with its kind.
   */
  async #finishReview(link: TurnRecord, engine: Engine, summary: RunSummary): Promise<void> {
    const review = getReview(this.#workspaceDb(), link.id);
    if (!review) return;
    const known = await this.#knownSecrets();
    const report = await engine.supervisor.call("runs.review", { runId: summary.id });
    if (report && !reportMatches(report, review, summary.id)) {
      this.#settle(link.id, { status: "unknown", errorMessage: "its engine's report is about something other than what this review sent, so none of it was kept" });
      return;
    }
    const kept = report ? maskValue(report, known) : null;
    const end = (outcome: Parameters<typeof settleReview>[2], with_: ReviewReport | null) => {
      if (this.#workspace.state === "ready") settleReview(this.#workspace.db, link.id, outcome, with_, new Date().toISOString());
    };
    if (summary.status === "succeeded") {
      if (kept?.outcome === "complete") end({ status: "answered" }, kept);
      else this.#settle(link.id, { status: "unknown", errorMessage: "its run finished, but its engine has no complete report stored for it" });
      return;
    }
    if (summary.status === "cancelled") {
      end({ status: getTurn(this.#workspaceDb(), link.id)?.cancelReason ? "cancelled" : "interrupted" }, kept);
      return;
    }
    const { interrupted, kind } = await this.#failureOf(engine, summary.id);
    end(interrupted ? { status: "interrupted" } : { status: "failed", errorKind: kind, errorMessage: maskForStorage(summary.error ?? "The review failed.", known) }, kept);
  }

  /** How a failed run ended, from its events: interrupted by its engine stopping, or failed, with the kind it gave. */
  async #failureOf(engine: Engine, runId: string): Promise<{ interrupted: boolean; kind: string | null }> {
    let interrupted = false;
    let kind: string | null = null;
    for (let after = 0; ; ) {
      const page = await engine.supervisor.call("runs.events", { runId, after, limit: 500 });
      for (const event of page.events) {
        if (event.type === "run.interrupted") interrupted = true;
        if (event.type === "run.failed" && typeof event.data?.["kind"] === "string") kind = event.data["kind"];
      }
      if (page.events.length < 500) break;
      after = page.next;
    }
    return { interrupted, kind };
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

  #reviewView(review: ReviewRecord, engine: EngineView): ReviewView {
    const { link } = review;
    const workspace = this.#workspaceDb();
    const open = link.status === "submitting" || link.status === "running";
    const away = open && !this.#submissions.has(link.id) && engine.state.status !== "online";
    const plan = getArtifact(workspace, review.planId);
    return {
      id: review.id,
      conversationId: review.conversationId,
      planId: review.planId,
      planLineage: review.planLineage,
      planVersion: review.planVersion,
      latestVersion: versionsOf(workspace, review.planLineage).at(-1)?.version ?? review.planVersion,
      panel: review.panel,
      status: link.status,
      note: reviewNoteFor(link),
      unresolved: away ? (engine.state.status === "failed" ? engine.state.reason : `The engine on ${engine.label} isn't running, so Nivra can't check this review yet. It checks again when you open the conversation.`) : null,
      runId: link.runId,
      cancelRequested: link.cancelRequested,
      scope: review.scope.kind === "project" ? { kind: "project", projectLabel: review.scope.projectLabel, headAtStart: review.scope.headAtStart } : { kind: "general" },
      packetDigest: review.packetDigest,
      preferencesDigest: review.preferencesDigest,
      given: { preferences: link.preferences.length },
      references: review.scope.kind === "project" && plan ? historicalReferences(plan.content as PlanContent) : [],
      report: review.report,
      createdAt: review.createdAt,
      settledAt: link.settledAt,
    };
  }

  #planText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("A plan needs some text.");
    if (trimmed.length > TASK_LIMITS.planChars) throw new Error(`That plan is ${trimmed.length} characters long, and a plan can hold ${TASK_LIMITS.planChars}. Shorten it, then save it again.`);
    return trimmed;
  }

  #taskTitle(title: string): string {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("A task needs a title.");
    if (trimmed.length > TASK_LIMITS.titleChars) throw new Error(`That title is ${trimmed.length} characters long, and a title can hold ${TASK_LIMITS.titleChars}. Shorten it, then save it again.`);
    return trimmed;
  }

  /**
   * What the person wrote in a brief, trimmed, with empty list rows dropped, and checked for size in words they can act
   * on before the schema sees it (the schema's own errors are JSON).
   */
  #briefFields(input: BriefFields): BriefFields {
    const text = (label: string, value: string, max: number) => {
      const trimmed = value.trim();
      if (trimmed.length > max) throw new Error(`${label} is ${trimmed.length} characters long, and it can hold ${max}. Shorten it, then save it again.`);
      return trimmed;
    };
    // A row is numbered as the person wrote the list, empty rows included.
    const rows = (one: string, many: string, values: string[]) => {
      values.forEach((value, index) => {
        const length = value.trim().length;
        if (length > TASK_LIMITS.itemChars) throw new Error(`${one} ${index + 1} is ${length} characters long, and each can hold ${TASK_LIMITS.itemChars}. Shorten it, then save it again.`);
      });
      const kept = values.map((value) => value.trim()).filter(Boolean);
      if (kept.length > TASK_LIMITS.items) throw new Error(`There are ${kept.length} ${many}, and a brief can hold ${TASK_LIMITS.items}. Remove some, then save it again.`);
      return kept;
    };
    return BriefFieldsSchema.parse({
      goal: text("The goal", input.goal, TASK_LIMITS.textChars),
      acceptanceCriteria: rows("Acceptance criterion", "acceptance criteria", input.acceptanceCriteria),
      scope: text("The scope", input.scope, TASK_LIMITS.textChars),
      exclusions: text("The exclusions", input.exclusions, TASK_LIMITS.textChars),
      context: text("The context", input.context, TASK_LIMITS.contextChars),
      assumptions: rows("Assumption", "assumptions", input.assumptions),
      checks: rows("Check", "checks", input.checks),
    });
  }

  /** Every field of a brief the person wrote, through the protection policy (D26). */
  #refuseInBrief(title: string, fields: BriefFields, known: KnownSecrets): void {
    refuseCredentials("The title", title, known);
    refuseCredentials("The goal", fields.goal, known);
    refuseCredentials("The scope", fields.scope, known);
    refuseCredentials("The exclusions", fields.exclusions, known);
    refuseCredentials("The context", fields.context, known);
    for (const criterion of fields.acceptanceCriteria) refuseCredentials("An acceptance criterion", criterion, known);
    for (const assumption of fields.assumptions) refuseCredentials("An assumption", assumption, known);
    for (const check of fields.checks) refuseCredentials("A check", check, known);
  }

  /** The task, refused when it changed since the person read it (its revision moved) or is gone. */
  #taskAt(taskId: string, revision: number): TaskRecord {
    const task = getTask(this.#workspaceDb(), taskId);
    if (!task) throw new Error("That task is no longer in the list.");
    if (task.revision !== revision) throw new Error("This task changed since you opened it. Open it again, then try again.");
    return task;
  }

  /** A new brief version and the task's change, in one transaction, from the versions the person saw. */
  #commitBrief(task: TaskRecord, latest: ArtifactRecord, content: BriefContent, change: Partial<Pick<TaskRecord, "projectId" | "state">>): void {
    const workspace = this.#workspaceDb();
    const now = new Date().toISOString();
    workspace.tx(() => {
      const brief = insertArtifact(workspace, { id: randomUUID(), kind: "brief", lineageId: task.id, content: BriefContentSchema.parse(content), conversationId: null, taskId: task.id, messageId: null, runLinkId: null, derivedFrom: latest.id, createdAt: now }, latest.version);
      if (!brief || !updateTask(workspace, task.id, task.revision, change, now)) throw new Error("This task changed since you opened it. Open it again, then try again.");
    });
  }

  #planView(plan: ArtifactRecord): PlanView {
    const content = plan.content as PlanContent;
    return {
      id: plan.id,
      lineageId: plan.lineageId,
      version: plan.version,
      text: content.text,
      conversationId: content.conversationId,
      messageId: content.messageId,
      projectId: content.projectId,
      assumptions: content.assumptions,
      latest: versionsOf(this.#workspaceDb(), plan.lineageId).at(-1)?.version ?? plan.version,
      createdAt: plan.createdAt,
    };
  }

  #taskSummary(task: TaskRecord): TaskSummary {
    const project = task.projectId ? this.#options.store.data.projects.find((p) => p.id === task.projectId) : undefined;
    return {
      id: task.id,
      title: task.title,
      state: task.state,
      projectId: task.projectId,
      projectLabel: project?.label ?? null,
      projectPresent: task.projectId === null ? null : project !== undefined,
      briefVersion: versionsOf(this.#workspaceDb(), task.id).at(-1)?.version ?? 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
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

  /** The target's engine, once a start in progress has ended: online, or failed with its reason. */
  async #started(targetId: string): Promise<Engine> {
    const engine = await this.#ensure(targetId);
    if (engine.supervisor.state.status === "starting") await engine.supervisor.start();
    return engine;
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
      sharing: { modelContext: record.sharing.modelContext, cloudExecution: record.sharing.cloudExecution },
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
