import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  CHAT_LIMITS,
  ErrorCode,
  TASK_BRIEF_LIMITS,
  isTerminal,
  packetDigest,
  preferencesDigest,
  RpcCallError,
  taskBriefDigest,
  type ApplyParams,
  type ApplyResolution,
  type ApplyView,
  type ChatContext,
  type ChatInput,
  type DoctorReport,
  type ExplainResult,
  type PreferenceIntent,
  type ProviderCheck,
  type ResearchContext,
  type ResearchInput,
  type ResearchReport,
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
  type TaskBrief,
  type TaskContext,
  type TaskInput,
  type TaskReport,
} from "@nivra/domain";
import type {
  AddProjectResult,
  AttemptAction,
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
  TaskApplyView,
  TaskAttemptView,
  TaskRunPreview,
  TasksView,
  TaskState,
  TaskSummary,
  TaskView,
  TurnView,
  WorkspaceView,
  WslView,
} from "../shared/ipc.ts";
import type { ResearchPreview, ResearchSelection, ResearchView, StopCause } from "../shared/research.ts";
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
import { amendedContent, amendedPlanFields, researchNoteFor, researchReportMatches, researchRequest, researchStopFailedText, type ResearchSubject } from "./research.ts";
import { getResearch, insertResearch, openResearch, recordAmendedPlan, researchOf, settleResearch, stopResearch, withdrawStop, type ResearchRecord } from "./research-store.ts";
import { historicalReferences, packetFor, previewFingerprint, reportMatches, REVIEW_REQUESTS, reviewNoteFor } from "./reviews.ts";
import {
  BriefContentSchema,
  BriefFieldsSchema,
  briefForRepository,
  briefFrom,
  briefIsReady,
  nebiusKeeps,
  nextState,
  planFromAnswer,
  sourceFrom,
  TASK_LIMITS,
  TASK_SENDS,
  taskBriefOf,
  taskRunFingerprint,
  TOKEN_FACTORY_KEEPS,
  type PlanContent,
} from "./tasks.ts";
import { EngineOfflineError, EngineSupervisor, type SupervisorOptions } from "./supervisor.ts";
import type { TargetFactory, WslTargets } from "./targets/registry.ts";
import { labelFor, type ExecutionTarget } from "./targets/types.ts";
import { isHiddenDistro, wslGuidance } from "./targets/wsl-discovery.ts";
import {
  acceptChange,
  approvedApplies,
  attemptRecord,
  attemptsOf,
  clearSettle,
  decide,
  deleteConversation,
  getAttempt,
  deleteTask,
  getArtifact,
  getConversation,
  getReview,
  getTask,
  getTurn,
  insertArtifact,
  insertAttempt,
  insertConversation,
  insertReview,
  insertTask,
  insertTurn,
  listConversations,
  listTasks,
  messagesOf,
  noteApply,
  openAttempts,
  openTurns,
  projectAnswer,
  recordApply,
  recordOutcome,
  recordRun,
  requestCancel,
  requestSettle,
  reviewsOf,
  setTurnHome,
  settleAttempt,
  settleReview,
  settleTurn,
  turnByRun,
  turnsOf,
  updateTask,
  versionsOf,
  withdrawCancel,
  withdrawDecision,
  type AttemptDecisionRecord,
  type AttemptRecord,
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
/** Why a plan's assumptions can't be checked once its project is gone. */
const RESEARCH_CLOSED = "This plan's project was removed, so its assumptions can't be checked. Its history stays here until you delete it.";
/** Why research leads to one amended version at most (D37). */
const AMENDED_ALREADY = "A version amended from this research was saved already, so nothing new was saved. Open the plan to see it.";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/**
 * What a run link is in the person's words, and what nothing sent means for it: research reaches two services (D37).
 */
const sendWords = (workflowId: string) => ({
  what: workflowId === "review" ? "this review" : workflowId === "research" ? "this research" : "this message",
  nothing: workflowId === "research" ? "nothing reached Tavily or Token Factory" : "nothing reached the model",
});
const isRunNotFound = (error: unknown) => error instanceof RpcCallError && error.code === ErrorCode.RunNotFound;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/** Why a sandbox check can't start, and what stopped one (D36), in the person's terms. */
const UPLOADS_OFF = "This project doesn't allow uploading its commit to Nebius Sandboxes. Allow uploads for it, then check again.";
const UPLOADS_STOPPED =
  "Uploads for this project were turned off, so its sandbox check is being stopped. Anything it uploaded stays with Nebius: images are kept for 180 days, and no API deletes uploads, operation records or logs.";
const UPLOADS_STOPPED_STARTING = "Uploads for this project were turned off while its sandbox check was starting, so the check is being stopped.";
/** A preview snapshots the whole commit on the project's engine, which takes a while for a large repository. */
const SANDBOX_PREVIEW_MS = 180_000;

/** Why a task can't run, and what stopped one (D39), in the person's terms. */
const NATIVE_WINDOWS = "Running tasks on Windows itself isn't available yet. Add the repository from a WSL distribution, then run the task there.";
const TASK_RUNNING = "A task is already running. Wait for it to end, or cancel it, then run this one.";
const RUN_SHARING_OFF = "This project doesn't allow sending its content to Token Factory, where the worker reads its files, so the run can't start. Allow it for this project, then preview the run again.";
const RUN_UPLOADS_OFF = "This project doesn't allow uploading its commit to Nebius Sandboxes, where the worker runs, so the run can't start. Allow uploads for this project, then preview the run again.";
const RUN_KEYS_MISSING = "A task run needs your Nebius key and project id, and they aren't both set. Add them in Settings, then preview the run again.";
/** What nothing sent means for a task run: neither service got anything. */
const RUN_NOTHING = "nothing was uploaded and nothing reached the model";

/** A decision on a task's change, and its apply (D40), in the person's terms. An apply can take a while on a big checkout. */
const APPLY_MS = 120_000;
const REVISION_NOTE_CHARS = 2_000;
const DECIDED = "A decision on this change is already recorded.";
const DECIDE_FIRST = "Decide on the last run's change first: approve it, reject it, or ask for a revision.";
const APPLY_GOING = "The last run's change is being applied or settled. Wait for it to finish, then try again.";
const SETTLE_FIRST = "Settle the last run's change first: accept it, keep or restore what was applied, or dismiss it.";
const APPLY_OPEN = "This task's change is being applied, or what was applied needs settling. Settle it first, then try again.";
const APPLY_NEVER_SENT = "The approval never reached the engine, so nothing was written. Approve the change again when you're ready.";
const SETTLE_LOST = "Nivra didn't hear back from the engine about settling this change, so it is asking how that went.";
const SETTLE_ASKING = "Nivra is still asking the engine how settling this change went. Wait for it, then try again.";
const BRIEF_MOVED = "The task isn't completed: its brief changed after this run. Run it on the new brief, or complete the task yourself.";
const REPOSITORY_MOVED = "The task isn't completed: it now runs on another repository than the one this run changed. Run it there, or complete the task yourself.";
const KEEP_ASIDE = "A file the change replaces is missing from your checkout, its original kept aside, so this can't be kept as it is. Restore the originals instead.";
const SETTLE_BEFORE_DELETE = "Settle this task's change first: accept it, keep or restore what was applied, or dismiss it. Then delete the task.";
const DECIDING = "A decision on this run is being sent. Wait for it, then try again.";

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

/**
 * What a conversation's run link sends: a turn, a review of a plan version (D31), or research of its assumptions (D37).
 */
type LinkRequest =
  | { workflowId: "chat"; input: ChatInput; context: ChatContext }
  | { workflowId: "review"; input: ReviewInput; context: ReviewContext }
  | { workflowId: "research"; input: ResearchInput; context: ResearchContext };

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
  /** Raised each time research is turned off, so a start or a send in progress can be caught (D37). */
  #webResearchEpoch = 0;
  /** Each project's sandbox check this session (D36). */
  readonly #sandboxChecks = new Map<string, SandboxCheck>();
  /** Projects whose check is being started: one at a time, from before its first wait. */
  readonly #sandboxStarting = new Set<string>();
  /** Each task run started this session, by its attempt: its project and the consent epochs it started under (D39). */
  readonly #taskRuns = new Map<string, { projectId: string; sharingEpoch: number; cloudEpoch: number }>();
  /** A task run being started: one at a time, claimed before its first wait (D39). */
  #taskStarting = false;
  /** Task runs being followed to their end. */
  readonly #followingAttempts = new Set<string>();
  /** The engine's own words for a run start it answered with an error, shown if its search then finds no run. */
  readonly #attemptAnswers = new Map<string, string>();
  /** Attempts with a decision, or a call about their apply, out: they offer nothing until it is back (D40). */
  readonly #applyCalls = new Set<string>();
  /** Applies being followed by their request ids, never sent again (D40). */
  readonly #followingApplies = new Set<string>();
  /** The engine's own words for an apply it answered with an error, shown if it then has no record of it. */
  readonly #applyAnswers = new Map<string, string>();
  /** Applies being read once more because their engine came online (D40). */
  readonly #rereading = new Set<string>();
  /** This host session, recorded with each turn: only this session's own submissions can still be in flight. */
  readonly #sessionId = randomUUID();
  /** Turns whose `runs.start` this session hasn't finished with, and who asked them to stop meanwhile. */
  readonly #submissions = new Map<string, { cancel: CancelReason | null }>();
  /** Turns being followed to their end. */
  readonly #following = new Set<string>();
  /** The last hand-off of changed keys to the engines, which the next one waits for. */
  #secretsHandOff: Promise<void> = Promise.resolve();
  /**
   * Research whose stop, recorded before its run was known, couldn't be carried out once the run was found: why, in the
   * person's words, until a newer stop is asked for or the research ends (D37).
   */
  readonly #researchStopFailures = new Map<string, string>();
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
    const open = openTurns(workspace, { conversationId });
    return {
      summary,
      messages: messagesOf(workspace, conversationId).map(({ conversationId: _of, ...message }) => message),
      turns: turnsOf(workspace, conversationId).map((turn) => this.#turnView(turn, engine)),
      engine,
      closed: summary.projectPresent === false ? CLOSED : null,
      openReview: open.find((link) => link.workflowId === "review")?.id ?? null,
      openResearch: open.find((link) => link.workflowId === "research")?.id ?? null,
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
    // Research is stopped with a stop of its own (D37), which alone is taken back if the conversation stays.
    const researchStops: Array<{ id: string; token: string }> = [];
    for (const turn of open) {
      if (turn.workflowId === "research") {
        const token = this.#stopResearch(workspace, turn.id, "deletion");
        if (token) researchStops.push({ id: turn.id, token });
        continue;
      }
      requestCancel(workspace, turn.id, "deletion");
      const pending = this.#submissions.get(turn.id);
      if (pending) pending.cancel ??= "deletion";
    }
    // A run whose engine isn't online isn't running any more: its engine fails it as interrupted when it starts (D4).
    const running = open.filter((turn) => turn.runId && this.#engines.get(turn.targetId)?.supervisor.state.status === "online");
    const results = await Promise.allSettled(running.map((turn) => this.cancelRun(turn.runId!)));
    const failedAt = results.findIndex((result) => result.status === "rejected");
    if (failedAt >= 0) {
      if (this.#workspace.state === "ready") for (const { id, token } of researchStops) withdrawStop(this.#workspace.db, id, token);
      const what = running[failedAt]!.workflowId === "research" ? "research" : "answer";
      const why = errorText((results[failedAt] as PromiseRejectedResult).reason);
      throw new Error(`Nivra couldn't stop this conversation's ${what} on ${this.#labelOf(record.targetId)} (${why}), so the conversation is still here. Restart that engine, then delete it again.`);
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

  /**
   * What research of one saved plan version's assumptions would send (D37), and the fingerprint that binds it: each
   * query for Tavily exactly as the person wrote it, the sites, and what goes to the model. Reads only: nothing is
   * stored or sent, and no engine starts. It is shown whatever keeps research from starting, and says what that is.
   */
  async prepareResearch(planId: string, selection: ResearchSelection): Promise<ResearchPreview> {
    return (await this.#researchRequest(this.#researchSubject(planId), selection)).preview;
  }

  /**
   * Starts the research the person previewed (D37). Everything is worked out again from the records as they are now,
   * and refused when its fingerprint isn't the one previewed, so research sends exactly the queries that were shown.
   * Both permissions are checked now, again after that wait against their epochs, and once more when its request is
   * out. It is stored first, then sent in the background on its conversation's engine; its report is kept when it ends.
   * Research writes no plan, task or preference: an amended version is saved only when the person saves it.
   */
  async startResearch(planId: string, selection: ResearchSelection, expected: string): Promise<ResearchView> {
    const workspace = this.#workspaceDb();
    const subject = this.#researchSubject(planId);
    const { plan, conversation } = subject;
    const epoch = conversation.projectId !== null ? this.#epochOf(conversation.projectId) : 0;
    const researchEpoch = this.#webResearchEpoch;
    const request = await this.#researchRequest(subject, selection);
    if (request.preview.blocked) throw new Error(request.preview.blocked);
    if (request.preview.expected !== expected) throw new Error("What this research would send has changed since you previewed it. Check the new preview, then start again.");
    if (!this.webResearch() || this.#webResearchEpoch !== researchEpoch) throw new Error("Research queries to Tavily were turned off, so the research wasn't started.");
    if (conversation.projectId !== null) {
      const now = this.#options.store.data.projects.find((p) => p.id === conversation.projectId);
      if (!now || this.#removing.has(now.id)) throw new Error(RESEARCH_CLOSED);
      if (!now.sharing.modelContext || this.#epochOf(now.id) !== epoch) throw new Error("Sharing for this project was turned off, so the research wasn't started.");
    }
    if (!getConversation(workspace, conversation.id) || !getArtifact(workspace, plan.id)) throw new Error("That plan is no longer here.");
    const id = randomUUID();
    const { packet } = request.context;
    const research = {
      id,
      conversationId: conversation.id,
      planId: plan.id,
      planLineage: plan.lineageId,
      planVersion: plan.version,
      planSha256: plan.sha256,
      packetDigest: request.input.packetDigest,
      queries: request.queries,
      sites: packet.sites,
      scope:
        conversation.projectId !== null
          ? { kind: "project" as const, projectId: conversation.projectId, projectLabel: subject.project?.label ?? null, headAtStart: packet.scope.kind === "project" ? packet.scope.headAtStart : null }
          : { kind: "general" as const },
      createdAt: new Date().toISOString(),
    };
    if (!insertResearch(workspace, research, { sessionId: this.#sessionId, targetId: conversation.targetId })) {
      throw new Error(this.#busyReason(conversation.id, "start research") ?? "This conversation is busy. Wait for it, then start research.");
    }
    this.#submissions.set(id, { cancel: null });
    void this.#submit(id, conversation, { workflowId: "research", input: request.input, context: request.context }, epoch, researchEpoch).catch((error: unknown) =>
      this.#options.log(`Research couldn't be sent: ${errorText(error)}`),
    );
    return this.#researchView(getResearch(workspace, id)!, this.#engineView(conversation.targetId));
  }

  /** A conversation's research, oldest first, read from the workspace. Asks no engine and starts nothing. */
  research(conversationId: string): ResearchView[] {
    const workspace = this.#workspaceDb();
    const record = getConversation(workspace, conversationId);
    if (!record) throw new Error("That conversation is no longer in the list.");
    const engine = this.#engineView(record.targetId);
    return researchOf(workspace, conversationId).map((research) => this.#researchView(research, engine));
  }

  /** Stops research the person no longer wants (D37); its end is recorded as cancelled by the person. */
  async cancelResearch(conversationId: string, researchId: string): Promise<ResearchView[]> {
    const research = getResearch(this.#workspaceDb(), researchId);
    if (!research || research.conversationId !== conversationId) throw new Error("That research is no longer in this conversation.");
    await this.#cancelLink(research.link);
    return this.research(conversationId);
  }

  /**
   * Saves the version the person amended from research (D37): their text and assumptions, checked as any plan's are,
   * as the next version of the researched plan, derived from it. One transaction checks that the researched version is
   * still the latest, adds the next version, and records it on the research: when any part fails, nothing is saved, so
   * research leads to one amended version at most.
   */
  async saveAmendedPlan(researchId: string, text: string, assumptions: readonly string[]): Promise<PlanView> {
    const workspace = this.#workspaceDb();
    const research = getResearch(workspace, researchId);
    if (!research) throw new Error("That research is no longer here.");
    if (research.amendedPlanId) throw new Error(AMENDED_ALREADY);
    if (research.report === null) throw new Error("This research has no report, so no version can be amended from it.");
    const researched = getArtifact(workspace, research.planId);
    if (!researched) throw new Error("That plan is no longer here.");
    const fields = amendedPlanFields(text, assumptions, await this.#knownSecrets());
    const moved = `This plan moved on since it was researched: v${research.planVersion} isn't its latest version any more, so nothing was saved. Research the latest version, then save an amended one from that.`;
    const saved = workspace.tx(() => {
      // Read again inside the transaction: another save may have landed while the fields were checked.
      if (getResearch(workspace, researchId)?.amendedPlanId) throw new Error(AMENDED_ALREADY);
      const plan = insertArtifact(
        workspace,
        {
          id: randomUUID(),
          kind: "plan",
          lineageId: research.planLineage,
          content: amendedContent(researched.content as PlanContent, fields),
          conversationId: research.conversationId,
          taskId: null,
          messageId: researched.messageId,
          runLinkId: researched.runLinkId,
          derivedFrom: researched.id,
          createdAt: new Date().toISOString(),
        },
        research.planVersion,
      );
      if (!plan) throw new Error(moved);
      // Recorded in the same transaction, so a version that couldn't be recorded is rolled back with it.
      if (!recordAmendedPlan(workspace, researchId, plan.id)) throw new Error(AMENDED_ALREADY);
      return plan;
    });
    return this.#planView(saved);
  }

  /** Whether research may send a plan version's approved queries to Tavily (D37): off until the person turns it on. */
  webResearch(): boolean {
    return this.#options.store.data.webResearch === true;
  }

  /**
   * Turns research's queries to Tavily on or off (D37). Turning it off raises research's epoch, which a start or a send
   * in progress checks, and stops every research run under way with a stop of its own: a run is cancelled on its
   * engine, and a stop its engine couldn't carry out is withdrawn and reported, never passed over.
   */
  async setWebResearch(on: boolean): Promise<void> {
    this.#options.store.update((data) => ({ ...data, webResearch: on }));
    if (on) return;
    this.#webResearchEpoch++;
    if (this.#workspace.state !== "ready") return;
    const failed = await this.#stopResearchRuns(openResearch(this.#workspace.db), "web-research");
    if (failed.length) {
      const one = failed.length === 1;
      throw new Error(
        `Research queries to Tavily are off, but Nivra couldn't stop ${one ? "a research run" : `${failed.length} research runs`} (${failed[0]}). Restart ${one ? "its engine" : "their engines"} to stop ${one ? "it" : "them"}.`,
      );
    }
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
      attempts: attemptsOf(workspace, taskId).map((attempt) => {
        const record = attemptRecord(workspace, attempt.id);
        return {
          id: attempt.id,
          briefVersion: byId.get(attempt.briefId) ?? getArtifact(workspace, attempt.briefId)?.version ?? 0,
          status: attempt.status,
          note: attemptNote(attempt),
          outcome: (record.outcome?.outcome ?? null) as TaskReport["outcome"] | null,
          verified: record.outcome?.verified ?? false,
          decision: record.decision,
          apply: record.apply ? { status: record.apply.view?.status ?? null, resolution: record.apply.view?.resolution ?? null } : null,
          acceptedAt: record.acceptedAt,
          createdAt: attempt.createdAt,
          settledAt: attempt.settledAt,
        };
      }),
      runBlocked: this.#runBlocked(task, content),
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
    this.#holdForSettling(taskId, "its brief can't change");
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
    this.#holdForSettling(taskId, "its brief can't change");
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
    this.#holdForSettling(taskId, "it can't move to another repository");
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
    // A run, or its change, going or waiting on the person sets the state until it is decided and settled (D40).
    const shown = this.#taskStateOf(task);
    if (shown === "active") throw new Error("This task's run, or its change, is still going. Wait for it to end first.");
    if (shown === "review" && state !== "review") throw new Error("This task's last run is waiting on you: decide on its change, or settle it, first.");
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

  /** Deletes a task with its brief versions and runs; refused while a run of it is being sent or going (D39). */
  deleteTask(taskId: string): void {
    const workspace = this.#workspaceDb();
    if (attemptsOf(workspace, taskId).some((attempt) => attempt.status === "submitting" || attempt.status === "running")) {
      throw new Error("This task's run is still going. Cancel it, and wait for it to end, then delete the task.");
    }
    if (this.#applyOpen(taskId)) throw new Error(APPLY_OPEN);
    // An apply its engine reported and the person hasn't settled still has an engine record and kept copies.
    if (attemptsOf(workspace, taskId).some((attempt) => this.#applyUnresolved(attemptRecord(workspace, attempt.id)))) throw new Error(SETTLE_BEFORE_DELETE);
    if (!deleteTask(workspace, taskId)) throw new Error("That task is no longer in the list.");
  }

  /**
   * What a run of the task would send, and where (D39), from its latest brief and its repository's commit as they are
   * now: the commit's snapshot comes from the project's own engine, with no network. Nothing is sent or stored. A run
   * that can't start now is still previewed as far as it can be, and says why.
   */
  async previewTaskRun(taskId: string): Promise<TaskRunPreview> {
    const workspace = this.#workspaceDb();
    const task = getTask(workspace, taskId);
    if (!task) throw new Error("That task is no longer in the list.");
    const brief = versionsOf(workspace, taskId).at(-1)!;
    const content = BriefContentSchema.parse(brief.content);
    const project = task.projectId ? (this.#options.store.data.projects.find((p) => p.id === task.projectId) ?? null) : null;
    const consents = { modelContext: project?.sharing.modelContext ?? false, cloudExecution: project?.sharing.cloudExecution ?? false };
    const base = {
      taskId,
      briefVersion: brief.version,
      project: project ? { label: project.label, targetLabel: this.#labelOf(project.targetId) } : { label: "No repository yet", targetLabel: "" },
      sends: { tokenFactory: [...TASK_SENDS.tokenFactory], nebius: [...TASK_SENDS.nebius] },
      cases: content.acceptanceCases.map((given, index) => ({ number: index + 1, ...given })),
      checks: content.checks.map((command, index) => ({ number: index + 1, command })),
      consents,
    };
    const stopped = (blocked: string): TaskRunPreview => ({ ...base, keeps: { tokenFactory: TOKEN_FACTORY_KEEPS, nebius: null }, snapshot: null, programs: [], unprobed: 0, caseFiles: [], limits: null, blocked, expected: "", snapshotFingerprint: null });
    const early = this.#runBlocked(task, content);
    if (early || !project) return stopped(early ?? "Choose the repository this task runs on first.");
    const packet = (taskBriefOf(content) as { brief: TaskBrief }).brief;
    const engine = await this.#started(project.targetId);
    const shown = await engine.supervisor.call("task.preview", { repoPath: project.nativePath, brief: packet }, { timeoutMs: SANDBOX_PREVIEW_MS });
    if (shown.status === "refused") return stopped(shown.message);
    const keys = await this.#options.credentials();
    const blocked = !consents.modelContext ? RUN_SHARING_OFF : !consents.cloudExecution ? RUN_UPLOADS_OFF : !(keys.NEBIUS_API_KEY && keys.NEBIUS_PROJECT_ID) ? RUN_KEYS_MISSING : null;
    const expected = taskRunFingerprint({ taskId, briefId: brief.id, briefVersion: brief.version, briefDigest: await taskBriefDigest(packet), projectId: project.id, targetId: project.targetId, sharing: consents, snapshot: shown.snapshot.fingerprint });
    return {
      ...base,
      keeps: { tokenFactory: TOKEN_FACTORY_KEEPS, nebius: nebiusKeeps(shown.snapshot.retention) },
      snapshot: shown.snapshot,
      programs: shown.programs,
      unprobed: shown.unprobed,
      caseFiles: shown.caseFiles,
      limits: shown.limits,
      blocked,
      expected,
      snapshotFingerprint: shown.snapshot.fingerprint,
    };
  }

  /**
   * Starts the run previewed (D39). Its fingerprint is worked out again from the records as they are now and the
   * snapshot's, and refused when it isn't the one previewed; the engine checks the snapshot itself before uploading.
   * Both consents are checked now, again before sending against their epochs, and once more when the request is out:
   * a run started while either was being turned off is cancelled at once. One task runs at a time. The attempt is
   * stored first, then sent in the background on its project's engine, and found by its request id if the answer is lost.
   */
  async startTaskRun(taskId: string, expected: string, snapshot: string): Promise<TaskAttemptView> {
    if (this.#taskStarting) throw new Error("A task run is already being started. Wait for it, then try again.");
    this.#taskStarting = true;
    try {
      return await this.#startTask(taskId, expected, snapshot);
    } finally {
      this.#taskStarting = false;
    }
  }

  /** Stops a run being sent or going; its end is recorded as cancelled by the person. */
  async cancelTaskRun(taskId: string, attemptId: string): Promise<TaskAttemptView> {
    const attempt = getAttempt(this.#workspaceDb(), attemptId);
    if (!attempt || attempt.taskId !== taskId) throw new Error("That run is no longer here.");
    await this.#cancelAttempt(attempt, "person");
    return this.taskAttempt(taskId, attemptId);
  }

  /**
   * One run of a task as it is now (D39): read from its engine when that is online and holds the same store, which a
   * run left open is followed on, starting it if needed. Nothing is resent.
   */
  async taskAttempt(taskId: string, attemptId: string): Promise<TaskAttemptView> {
    const attempt = getAttempt(this.#workspaceDb(), attemptId);
    if (!attempt || attempt.taskId !== taskId) throw new Error("That run is no longer here.");
    if ((attempt.status === "submitting" || attempt.status === "running") && !this.#submissions.has(attemptId)) {
      void this.#ensure(attempt.targetId).catch(() => undefined);
      this.#followAttempt(attemptId);
    }
    // An apply whose engine hasn't said how it went (an answer lost, or Nivra restarted), or a settling of it saved and
    // not answered: asked by its request id.
    const record = attemptRecord(this.#workspaceDb(), attemptId);
    if ((applyUnsettled(record) || record.settle) && !this.#applyCalls.has(attemptId)) {
      void this.#ensure(attempt.targetId).catch(() => undefined);
      this.#followApply(attemptId);
    }
    return this.#attemptView(attempt);
  }

  /**
   * Approves an attempt's proposal by the hash the person saw, and applies it on the attempt's own engine (D40): only
   * when every acceptance case passed. The decision and the apply's request id are saved before task.apply is sent; an
   * answer that doesn't come back is asked for by that id, and the apply is never sent again.
   */
  async approveTaskChange(taskId: string, attemptId: string, approvedHash: string): Promise<TaskAttemptView> {
    await this.#deciding(attemptId, async () => {
      const workspace = this.#workspaceDb();
      const { attempt, project } = this.#decidable(taskId, attemptId);
      if (this.#options.platform === "win32" && project.targetId === "local") throw new Error("Applying changes on Windows itself isn't available yet, so nothing was written.");
      if (attemptRecord(workspace, attemptId).decision !== null) throw new Error(DECIDED);
      const engine = await this.#attemptEngine(attempt);
      const report = await this.#reportOf(engine, attempt);
      if (!report.proposal) throw new Error("This run proposed no change, so there is nothing to approve.");
      if (!report.verified) throw new Error("Not every acceptance case was shown to pass, so this change can't be approved. Reject it, or ask for a revision.");
      if (report.proposal.hash !== approvedHash) throw new Error("This isn't the change you were shown: the run's proposal is another one. Open the run again, then decide.");
      const brief = getArtifact(workspace, attempt.briefId);
      const packet = brief ? taskBriefOf(BriefContentSchema.parse(brief.content)) : null;
      if (!brief || !packet || "blocked" in packet) throw new Error("The brief this run ran can't be read as it was, so its change can't be approved. Run the task again.");
      const requestId = randomUUID();
      // Saved before anything is sent: after this, the apply is only ever asked about by its request id.
      if (!decide(workspace, attempt.id, { kind: "approved", requestId, projectId: project.id }, new Date().toISOString())) throw new Error(DECIDED);
      const params: ApplyParams = {
        requestId,
        runId: attempt.runId!,
        approvedHash,
        repoPath: project.nativePath,
        project: project.id,
        target: project.targetId,
        task: { attempt: { taskId, attemptId: attempt.id, runId: attempt.runId! }, engine: { homeId: attempt.homeId! }, brief: { version: brief.version, sha256: await taskBriefDigest(packet.brief) } },
      };
      try {
        const view = await engine.supervisor.call("task.apply", params, { timeoutMs: APPLY_MS });
        recordApply(workspace, attempt.id, requestId, maskValue(view, await this.#knownSecrets()), new Date().toISOString());
      } catch (error) {
        this.#options.log(`An apply's request got no usable answer (${error instanceof Error ? error.name : "unknown"}); it is asked for by its request id, never sent again.`);
        // An error answer is the engine's own words: shown if it then has no record of the apply.
        if (error instanceof RpcCallError) this.#applyAnswers.set(attempt.id, errorText(error));
        this.#followApply(attempt.id);
      }
    });
    return this.taskAttempt(taskId, attemptId);
  }

  /** Rejects an attempt's proposal (D40): nothing is sent, and the checkout is untouched. */
  async rejectTaskChange(taskId: string, attemptId: string): Promise<TaskAttemptView> {
    await this.#deciding(attemptId, async () => {
      const attempt = await this.#withProposal(taskId, attemptId);
      if (!decide(this.#workspaceDb(), attempt.id, { kind: "rejected" }, new Date().toISOString())) throw new Error(DECIDED);
    });
    return this.taskAttempt(taskId, attemptId);
  }

  /**
   * Asks for a revision of an attempt's proposal (D40): the note is recorded, and its task's brief gets a new version
   * whose context ends with it, so the next run, which the person starts, works from it. Nothing is sent now.
   */
  async requestTaskRevision(taskId: string, attemptId: string, note: string): Promise<TaskAttemptView> {
    const text = note.trim();
    if (!text) throw new Error("Write what the next run should do differently, then ask for the revision.");
    if (text.length > REVISION_NOTE_CHARS) throw new Error(`That note is ${text.length} characters long, and it can hold ${REVISION_NOTE_CHARS}. Shorten it, then ask again.`);
    // The note goes into the brief, which a run sends to Token Factory.
    refuseCredentials("The note", text, await this.#knownSecrets());
    await this.#deciding(attemptId, async () => {
      const attempt = await this.#withProposal(taskId, attemptId);
      const workspace = this.#workspaceDb();
      const task = getTask(workspace, taskId);
      if (!task) throw new Error("That task is no longer in the list.");
      if (task.state === "completed") throw new Error("This task is completed. Reopen it to ask for a revision.");
      this.#holdForSettling(taskId, "its brief can't change", attempt.id);
      const latest = versionsOf(workspace, taskId).at(-1)!;
      const before = BriefContentSchema.parse(latest.content);
      const context = before.context ? `${before.context}\n${text}` : text;
      if (context.length > TASK_LIMITS.contextChars) throw new Error(`With that note, the brief's context would be ${context.length} characters long, and it can hold ${TASK_LIMITS.contextChars}. Shorten the note, or the context, then ask again.`);
      const content: BriefContent = { ...before, context, revalidate: before.revalidate.filter((part) => part !== "context") };
      workspace.tx(() => {
        if (!decide(workspace, attempt.id, { kind: "revision", note: text }, new Date().toISOString())) throw new Error(DECIDED);
        this.#commitBrief(task, latest, content, {});
      });
    });
    return this.taskAttempt(taskId, attemptId);
  }

  /**
   * Settles an attempt's apply as the person decides (D40): accepts an applied change, which completes the task unless
   * it has moved on since the run; dismisses one that wasn't applied, so its change can be decided on again; or keeps a
   * partial one as it is. Its engine keeps every copy it made, for the person to delete. Which way is saved before it
   * is sent, so an answer that doesn't come back is read back, after a restart too, never resent.
   */
  async settleTaskChange(taskId: string, attemptId: string, as: ApplyResolution): Promise<TaskAttemptView> {
    await this.#deciding(attemptId, async () => {
      const { attempt, apply, view } = this.#settleable(taskId, attemptId);
      const allowed: Record<ApplyResolution, readonly string[]> = { accepted: ["applied"], dismissed: ["not-applied", "refused", "unknown"], kept: ["partial"] };
      if (!allowed[as].includes(view.status)) {
        throw new Error(as === "accepted" ? "Only a change that was applied can be accepted." : as === "kept" ? "Only a change that was applied in part can be kept as it is." : "Only a change that wasn't applied can be dismissed.");
      }
      if (as === "kept" && view.paths.some((one) => one.place === "aside")) throw new Error(KEEP_ASIDE);
      const engine = await this.#attemptEngine(attempt);
      if (!requestSettle(this.#workspaceDb(), attempt.id, apply.requestId, as, new Date().toISOString())) throw new Error(SETTLE_ASKING);
      let settled: ApplyView;
      try {
        settled = await engine.supervisor.call("task.dismiss", { applyId: view.applyId, as }, { timeoutMs: APPLY_MS });
      } catch (error) {
        this.#settleLost(attempt.id, error);
        return;
      }
      await this.#recordSettled(attempt, apply.requestId, settled);
    });
    return this.taskAttempt(taskId, attemptId);
  }

  /**
   * Takes a partial apply back to the originals (D40), never overwriting a version another program saved since. Saved
   * before it is sent, as a settle is.
   */
  async restoreTaskChange(taskId: string, attemptId: string): Promise<TaskAttemptView> {
    await this.#deciding(attemptId, async () => {
      const { attempt, apply, view } = this.#settleable(taskId, attemptId);
      if (view.status !== "partial") throw new Error("Only a change that was applied in part can be restored this way.");
      const engine = await this.#attemptEngine(attempt);
      if (!requestSettle(this.#workspaceDb(), attempt.id, apply.requestId, "restore", new Date().toISOString())) throw new Error(SETTLE_ASKING);
      let restored: ApplyView;
      try {
        restored = await engine.supervisor.call("task.restore", { applyId: view.applyId }, { timeoutMs: APPLY_MS });
      } catch (error) {
        this.#settleLost(attempt.id, error);
        return;
      }
      await this.#recordSettled(attempt, apply.requestId, restored);
    });
    return this.taskAttempt(taskId, attemptId);
  }

  /**
   * A settle or restore that went to the engine with no usable answer back (an error answer, a timeout, the engine
   * gone): the engine may have done it, and a repeat may be refused. Which way was saved before it was sent, so the
   * apply is read again by its request id, now or after a restart, before anything more is offered. Nothing is sent
   * again meanwhile.
   */
  #settleLost(attemptId: string, error: unknown): void {
    this.#options.log(`A settle of an apply got no usable answer (${error instanceof Error ? error.name : "unknown"}); its apply is read again by its request id.`);
    this.#followApply(attemptId);
  }

  /**
   * Records what an apply's engine says after a settle or a restore, and what follows from it, in one write: the
   * settling saved before it was sent is answered; a dismissed result takes the approval back, so the change can be
   * decided on again; an accepted change completes its task, which only the person's acceptance does, unless the task
   * has moved on since the run (its brief has a newer version, or it runs on another repository): then the acceptance
   * keeps why the task isn't completed.
   */
  async #recordSettled(attempt: AttemptRecord, requestId: string, view: ApplyView): Promise<void> {
    this.#keepSettled(attempt, requestId, maskValue(view, await this.#knownSecrets()));
  }

  #keepSettled(attempt: AttemptRecord, requestId: string, view: ApplyView): void {
    const workspace = this.#workspaceDb();
    const at = new Date().toISOString();
    workspace.tx(() => {
      if (!recordApply(workspace, attempt.id, requestId, view, at)) return;
      clearSettle(workspace, attempt.id, requestId);
      if (view.resolution === "dismissed") withdrawDecision(workspace, attempt.id, requestId, null);
      if (view.resolution !== "accepted") return;
      const task = getTask(workspace, attempt.taskId);
      const sentFor = attemptRecord(workspace, attempt.id).apply?.projectId;
      const movedOn = !task ? null : versionsOf(workspace, task.id).at(-1)?.id !== attempt.briefId ? BRIEF_MOVED : task.projectId !== sentFor ? REPOSITORY_MOVED : null;
      if (!acceptChange(workspace, attempt.id, requestId, at, movedOn)) return;
      if (task && !movedOn && task.state !== "completed") updateTask(workspace, attempt.taskId, task.revision, { state: "completed" }, at);
    });
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
      // Every stop is tried, whatever another's fate, and then any that failed is reported (D39).
      const [runs, attempts] = await Promise.allSettled([
        this.#stopProjectRuns(projectId, "model-sharing", (runs, why, them) => `Sharing for this project is off, but Nivra couldn't stop ${runs} (${why}). Restart the project's engine to stop ${them}.`),
        this.#stopProjectAttempts(projectId, "sharing", (why) => `Sharing for this project is off, but Nivra couldn't stop its task run (${why}). Restart the project's engine to stop it.`),
      ]);
      if (runs.status === "rejected") withdraw();
      const failed = [runs, attempts].flatMap((stop) => (stop.status === "rejected" ? [errorText(stop.reason)] : []));
      if (failed.length) throw new Error(failed.join(" "));
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
      const stopCheck = async () => {
        const check = this.#sandboxChecks.get(projectId);
        // A check whose state can't be read is treated as going: stopping one that had ended does no harm.
        if (check && !(await this.#sandboxEnded(check).catch(() => false))) {
          await this.#stopForUploads(projectId, check, UPLOADS_STOPPED);
          this.#notices.set(projectId, UPLOADS_STOPPED);
        }
      };
      // Every stop is tried, whatever another's fate, and then any that failed is reported (D39).
      const stops = await Promise.allSettled([
        stopCheck(),
        this.#stopProjectAttempts(projectId, "sharing", (why) => `Uploads for this project are off, but Nivra couldn't stop its task run (${why}). Restart the project's engine to stop it.`),
      ]);
      const failed = stops.flatMap((stop) => (stop.status === "rejected" ? [errorText(stop.reason)] : []));
      if (failed.length) throw new Error(failed.join(" "));
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
      const stopCheck = async () => {
        const check = this.#sandboxChecks.get(projectId);
        if (check && !(await this.#sandboxEnded(check).catch(() => false))) {
          await this.#cancelSandboxRun(projectId, check, null, (why) => `Nivra couldn't stop the project's sandbox check (${why}), so the project is still in the list. Restart its engine, then remove it again.`);
        }
      };
      // Every stop is tried, whatever another's fate; any that failed keeps the project in the list, and says why.
      const stops = await Promise.allSettled([
        this.#stopProjectRuns(projectId, "removal", (runs, why) => `Nivra couldn't stop ${runs} (${why}), so the project is still in the list. Restart its engine, then remove it again.`),
        stopCheck(),
        this.#stopProjectAttempts(projectId, "removal", (why) => `Nivra couldn't stop the project's task run (${why}), so the project is still in the list. Restart its engine, then remove it again.`),
      ]);
      const failed = stops.flatMap((stop) => (stop.status === "rejected" ? [errorText(stop.reason)] : []));
      if (failed.length) throw new Error(failed.join(" "));
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

  /**
   * Hands every engine the keys as they are now (D8), including one that was still starting when they changed. Each
   * call starts once the one before it has ended, and reads the keys afresh, so the last set an engine is given is the
   * latest.
   */
  secretsChanged(): Promise<void> {
    const done = this.#secretsHandOff.then(() => this.#handSecrets());
    this.#secretsHandOff = done.catch(() => undefined);
    return done;
  }

  async #handSecrets(): Promise<void> {
    const secrets = await this.#options.credentials();
    const remove = (["NEBIUS_API_KEY", "NEBIUS_PROJECT_ID", "TAVILY_API_KEY"] as const).filter((name) => !secrets[name]);
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

  /**
   * Why a task can't run now, in plain words, or null (D39): its state, its repository and where that lives, its
   * brief's acceptance cases, and another run still going. Consents and keys are the preview's to say.
   */
  #runBlocked(task: TaskRecord, content: BriefContent): string | null {
    if (task.state === "completed") return "This task is completed. Reopen it to run it again.";
    if (task.state !== "ready") return "Mark the task ready first: a run needs a goal and at least one acceptance criterion.";
    if (task.projectId === null) return "Choose the repository this task runs on first.";
    const project = this.#options.store.data.projects.find((p) => p.id === task.projectId);
    if (!project || this.#removing.has(project.id)) return "This task's repository is no longer in the list. Choose another, then run it.";
    if (this.#options.platform === "win32" && project.targetId === "local") return NATIVE_WINDOWS;
    const brief = taskBriefOf(content);
    if ("blocked" in brief) return brief.blocked;
    if (this.#workspace.state === "ready" && openAttempts(this.#workspace.db).length) return TASK_RUNNING;
    // Its last run's change waits on the person, or is being applied (D40).
    const waiting = this.#waitingOn(task.id);
    if (waiting) return waiting === "decision" ? DECIDE_FIRST : waiting === "applying" ? APPLY_GOING : SETTLE_FIRST;
    return null;
  }

  async #startTask(taskId: string, expected: string, snapshot: string): Promise<TaskAttemptView> {
    const workspace = this.#workspaceDb();
    const task = getTask(workspace, taskId);
    if (!task) throw new Error("That task is no longer in the list.");
    const brief = versionsOf(workspace, taskId).at(-1)!;
    const content = BriefContentSchema.parse(brief.content);
    const blocked = this.#runBlocked(task, content);
    if (blocked) throw new Error(blocked);
    const project = this.#project(task.projectId!);
    const epochs = { sharingEpoch: this.#epochOf(project.id), cloudEpoch: this.#cloudEpochOf(project.id) };
    if (!project.sharing.modelContext) throw new Error(RUN_SHARING_OFF);
    if (!project.sharing.cloudExecution) throw new Error(RUN_UPLOADS_OFF);
    const known = await this.#knownSecrets();
    if (!known.some(([name]) => name === "NEBIUS_API_KEY") || !known.some(([name]) => name === "NEBIUS_PROJECT_ID")) throw new Error(RUN_KEYS_MISSING);
    const packet = (taskBriefOf(content) as { brief: TaskBrief }).brief;
    // The brief goes to Token Factory: a key saved since it was written is refused here, and nothing is sent.
    for (const [field, text] of briefTexts(packet)) refuseCredentials(field, text, known, "send");
    const briefDigest = await taskBriefDigest(packet);
    const current = taskRunFingerprint({ taskId, briefId: brief.id, briefVersion: brief.version, briefDigest, projectId: project.id, targetId: project.targetId, sharing: { modelContext: true, cloudExecution: true }, snapshot });
    if (current !== expected) throw new Error("What this run would send has changed since you previewed it. Preview it again, then start.");
    // Checked again after the waits: consent, and the project itself, can change while the keys are read.
    const now = this.#options.store.data.projects.find((p) => p.id === project.id);
    if (!now || this.#removing.has(project.id) || !now.sharing.modelContext || !now.sharing.cloudExecution || this.#epochOf(project.id) !== epochs.sharingEpoch || this.#cloudEpochOf(project.id) !== epochs.cloudEpoch) {
      throw new Error("This project's sharing or uploads changed while the run was starting, so it wasn't started. Preview it again.");
    }
    const id = randomUUID();
    if (!insertAttempt(workspace, { id, taskId, briefId: brief.id, sessionId: this.#sessionId, targetId: project.targetId, createdAt: new Date().toISOString() })) throw new Error(TASK_RUNNING);
    this.#taskRuns.set(id, { projectId: project.id, ...epochs });
    this.#submissions.set(id, { cancel: null });
    const input: TaskInput = { repoPath: project.nativePath, project: project.id, target: project.targetId, preview: snapshot, taskId, briefVersion: brief.version, briefDigest };
    const context: TaskContext = { sharing: { modelContext: true, cloudExecution: true }, brief: packet };
    void this.#submitAttempt(id, project, input, context).catch((error: unknown) => this.#options.log(`A task run couldn't be sent: ${errorText(error)}`));
    return this.#attemptView(getAttempt(workspace, id)!);
  }

  /** Why a task run should stop: asked for meanwhile, or its project removed, or a consent withdrawn since it started. */
  #attemptStopReason(attemptId: string): CancelReason | null {
    const asked = this.#submissions.get(attemptId)?.cancel ?? null;
    if (asked) return asked;
    const run = this.#taskRuns.get(attemptId);
    if (!run) return null;
    const project = this.#options.store.data.projects.find((p) => p.id === run.projectId);
    if (!project || this.#removing.has(project.id)) return "removal";
    if (!project.sharing.modelContext || !project.sharing.cloudExecution || this.#epochOf(project.id) !== run.sharingEpoch || this.#cloudEpochOf(project.id) !== run.cloudEpoch) return "sharing";
    return null;
  }

  /**
   * Sends a stored task run (D39), as a turn is sent: the request is written only after the engine's store is recorded
   * with it, so one with none was never sent. A failure known to come before writing is "not sent"; anything after it
   * leaves the run to be found by its request id, never sent again.
   */
  async #submitAttempt(attemptId: string, project: ProjectRecord, input: TaskInput, context: TaskContext): Promise<void> {
    const workspace = this.#workspaceDb();
    const label = this.#labelOf(project.targetId);
    const settle = (outcome: Parameters<typeof settleAttempt>[2]) => {
      if (this.#workspace.state === "ready") settleAttempt(this.#workspace.db, attemptId, outcome, new Date().toISOString());
    };
    const stopped = (): boolean => {
      const reason = this.#attemptStopReason(attemptId);
      if (reason) requestCancel(workspace, attemptId, reason);
      return reason !== null;
    };
    const notSent = (why: string) => {
      this.#submissions.delete(attemptId);
      settle({ status: "not-sent", errorMessage: why });
    };
    let engine: Engine;
    try {
      engine = await this.#ensure(project.targetId);
      if (engine.supervisor.state.status === "starting") await engine.supervisor.start();
    } catch (error) {
      notSent(`The engine on ${label} couldn't start (${errorText(error)}), so the run wasn't sent: ${RUN_NOTHING}.`);
      return;
    }
    const state = engine.supervisor.state;
    if (state.status !== "online") {
      notSent(`The engine on ${label} isn't running${state.status === "failed" ? ` (${state.reason})` : ""}, so the run wasn't sent: ${RUN_NOTHING}.`);
      return;
    }
    if (stopped()) {
      this.#submissions.delete(attemptId);
      settle({ status: "cancelled", errorMessage: `It was stopped before it was sent, so ${RUN_NOTHING}.` });
      return;
    }
    // Deleted or ended meanwhile: nothing to send.
    if (!setTurnHome(workspace, attemptId, state.info.homeId)) {
      this.#submissions.delete(attemptId);
      return;
    }
    let run: RunSummary;
    try {
      run = await engine.supervisor.call("runs.start", { clientRequestId: attemptId, workflowId: "task", input, context });
    } catch (error) {
      // Nothing was written: the engine wasn't online, or the parameters were refused before sending.
      if (error instanceof EngineOfflineError || error instanceof TypeError) {
        notSent(`The engine on ${label} didn't take the run (${errorText(error)}), so ${RUN_NOTHING}.`);
        return;
      }
      this.#options.log(`A task run's request got no usable answer (${error instanceof Error ? error.name : "unknown"}); it is found by its request id, never sent again.`);
      // An error answer is the engine's own words: shown if the search then finds no run.
      if (error instanceof RpcCallError) this.#attemptAnswers.set(attemptId, errorText(error));
      this.#submissions.delete(attemptId);
      this.#followAttempt(attemptId);
      return;
    }
    this.#runs.set(run.id, project.targetId);
    recordRun(workspace, attemptId, run.id);
    // Stopped while the request was out (a cancel, consent withdrawn, the project removed): the run stops now.
    const late = stopped();
    this.#submissions.delete(attemptId);
    if (late) await engine.supervisor.call("runs.cancel", { runId: run.id }).catch((error: unknown) => this.#options.log(`A task run stopped while it was being sent couldn't be cancelled: ${errorText(error)}`));
    this.#followAttempt(attemptId);
  }

  /**
   * Follows an open task run to its end on its own engine (D39), as a turn is followed, however it was left. No store
   * recorded: never sent. Another store: unknown. No run id: found by its request id, and absent from the same store,
   * never sent. A run: followed until it ends, then its end recorded; its report stays with its engine.
   */
  #followAttempt(attemptId: string): void {
    if (this.#followingAttempts.has(attemptId) || this.#submissions.has(attemptId)) return;
    this.#followingAttempts.add(attemptId);
    void (async () => {
      let delay = 400;
      let cancelSent = false;
      try {
        while (!this.#closing && this.#workspace.state === "ready") {
          const workspace = this.#workspace.db;
          const attempt = getAttempt(workspace, attemptId);
          if (!attempt || (attempt.status !== "submitting" && attempt.status !== "running")) return;
          const settle = (outcome: Parameters<typeof settleAttempt>[2]) => settleAttempt(workspace, attemptId, outcome, new Date().toISOString());
          if (attempt.homeId === null) {
            settle({ status: "not-sent", errorMessage: `Nivra stopped before sending the run, so ${RUN_NOTHING}.` });
            return;
          }
          const engine = this.#engines.get(attempt.targetId);
          const state = engine?.supervisor.state;
          if (engine && state?.status === "online") {
            if (state.info.homeId !== attempt.homeId) {
              settle({ status: "unknown", errorMessage: `it went to an engine whose records aren't here (another engine home on ${this.#labelOf(attempt.targetId)})` });
              return;
            }
            try {
              let summary: RunSummary | null;
              if (attempt.runId) summary = await engine.supervisor.call("runs.get", { runId: attempt.runId });
              else {
                summary = await engine.supervisor.call("runs.find", { clientRequestId: attemptId });
                if (!summary) {
                  const answered = this.#attemptAnswers.get(attemptId);
                  settle({ status: "not-sent", errorMessage: answered ? `The engine didn't start the run, so ${RUN_NOTHING}. ${answered}` : `Its engine has no record of the run, so it never ran: ${RUN_NOTHING}.` });
                  return;
                }
                this.#runs.set(summary.id, attempt.targetId);
                recordRun(workspace, attemptId, summary.id);
              }
              if (isTerminal(summary.status)) {
                await this.#finishAttempt(attempt, engine, summary);
                return;
              }
              if (attempt.cancelRequested && !cancelSent) {
                cancelSent = true;
                // A cancel its engine turned down is tried again on the next look, never left for the run to outlast.
                await engine.supervisor.call("runs.cancel", { runId: summary.id }).catch((error: unknown) => {
                  cancelSent = false;
                  this.#options.log(`A task run couldn't be cancelled yet, so Nivra tries again: ${errorText(error)}`);
                });
              }
              delay = 400;
            } catch (error) {
              if (isRunNotFound(error)) {
                settle({ status: "unknown", errorMessage: `the engine on ${this.#labelOf(attempt.targetId)} has no record of its run any more` });
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
        this.#options.log(`Following a task run stopped: ${errorText(error)}`);
      } finally {
        this.#followingAttempts.delete(attemptId);
        this.#attemptAnswers.delete(attemptId);
      }
    })();
  }

  /**
   * Records how a task run ended (D39). Its report stays with its engine: one that ran to its end is `answered`, whatever
   * it found. A cancel Nivra asked for keeps its reason; any other cancel, or a `run.interrupted` event, means Nivra or
   * its engine stopped first.
   */
  async #finishAttempt(attempt: AttemptRecord, engine: Engine, summary: RunSummary): Promise<void> {
    const settle = (outcome: Parameters<typeof settleAttempt>[2]) => {
      if (this.#workspace.state === "ready") settleAttempt(this.#workspace.db, attempt.id, outcome, new Date().toISOString());
    };
    if (summary.status === "succeeded") {
      // Its outcome is kept now, so its history shows without its engine; one that can't be read now is read when shown.
      try {
        const report = await engine.supervisor.call("runs.task", { runId: summary.id });
        if (report && report.request.clientRequestId === attempt.id && report.request.runId === summary.id) this.#keepOutcome(attempt.id, report);
      } catch {
        // Read when the run is shown.
      }
      return settle({ status: "answered" });
    }
    if (summary.status === "cancelled") {
      const now = this.#workspace.state === "ready" ? getAttempt(this.#workspace.db, attempt.id) : null;
      return settle({ status: now?.cancelReason ? "cancelled" : "interrupted" });
    }
    const known = await this.#knownSecrets();
    const { interrupted, kind } = await this.#failureOf(engine, summary.id);
    settle(interrupted ? { status: "interrupted" } : { status: "failed", errorKind: kind, errorMessage: maskForStorage(summary.error ?? "The run failed.", known) });
  }

  /**
   * Stops a task run for `reason`. One being sent stops at its own check; one whose run isn't known yet once it is found.
   * A stop its engine turns down is taken back and thrown, so the caller can say it couldn't stop it.
   */
  async #cancelAttempt(attempt: AttemptRecord, reason: CancelReason): Promise<void> {
    if (attempt.status !== "submitting" && attempt.status !== "running") return;
    const workspace = this.#workspaceDb();
    requestCancel(workspace, attempt.id, reason);
    const pending = this.#submissions.get(attempt.id);
    if (pending) pending.cancel ??= reason;
    if (attempt.runId) {
      await this.cancelRun(attempt.runId).catch((error: unknown) => {
        withdrawCancel(workspace, attempt.id, reason);
        throw error;
      });
    } else if (!pending) this.#followAttempt(attempt.id);
  }

  /**
   * Stops the project's task run started this session, for `reason`; says through `refusal` when it couldn't. A run
   * whose engine isn't online, and isn't being sent, isn't going any more (D4): its stop is recorded, and nothing is sent.
   */
  async #stopProjectAttempts(projectId: string, reason: CancelReason, refusal: (why: string) => string): Promise<void> {
    if (this.#workspace.state !== "ready") return;
    const workspace = this.#workspace.db;
    const attempts = openAttempts(workspace).filter((attempt) => this.#taskRuns.get(attempt.id)?.projectId === projectId);
    const going = (attempt: AttemptRecord) => this.#submissions.has(attempt.id) || this.#engines.get(attempt.targetId)?.supervisor.state.status === "online";
    for (const attempt of attempts.filter((one) => !going(one))) requestCancel(workspace, attempt.id, reason);
    const results = await Promise.allSettled(attempts.filter(going).map((attempt) => this.#cancelAttempt(attempt, reason)));
    const failed = results.flatMap((result) => (result.status === "rejected" ? [errorText(result.reason)] : []));
    if (failed.length) throw new Error(refusal(failed[0]!));
  }

  /** A task run as the window shows it: its record, and its engine's report, change and progress when they can be read. */
  async #attemptView(attempt: AttemptRecord): Promise<TaskAttemptView> {
    const workspace = this.#workspaceDb();
    const record = attemptRecord(workspace, attempt.id);
    const base: TaskAttemptView = {
      id: attempt.id,
      taskId: attempt.taskId,
      briefVersion: getArtifact(workspace, attempt.briefId)?.version ?? 0,
      status: attempt.status,
      note: attemptNote(attempt),
      runId: attempt.runId,
      cancelRequested: attempt.cancelRequested,
      report: null,
      proposal: null,
      progress: [],
      unresolved: null,
      decision: record.decision,
      decidedAt: record.decidedAt,
      revisionNote: record.revisionNote,
      apply: this.#applyView(attempt, record),
      acceptedAt: record.acceptedAt,
      acceptNote: record.acceptNote,
      // From what was kept when the run ended, until its report is read below.
      actions: this.#actionsOf(attempt, record, record.outcome?.verified ?? false, Boolean(record.outcome?.proposalHash)),
      createdAt: attempt.createdAt,
      settledAt: attempt.settledAt,
    };
    if (!attempt.runId) return base;
    const engine = this.#engines.get(attempt.targetId);
    const state = engine?.supervisor.state;
    if (!engine || state?.status !== "online") return { ...base, unresolved: `The engine on ${this.#labelOf(attempt.targetId)} isn't running, so this run can't be read now.` };
    if (state.info.homeId !== attempt.homeId) return { ...base, unresolved: "This run went to an engine whose records aren't here, so it can't be read." };
    try {
      const known = await this.#knownSecrets();
      const report: TaskReport | null = await engine.supervisor.call("runs.task", { runId: attempt.runId });
      // A report about another request or run is shown nowhere.
      if (report && (report.request.clientRequestId !== attempt.id || report.request.runId !== attempt.runId)) return { ...base, unresolved: "Its engine's report is about another run, so none of it is shown." };
      if (report && attempt.status === "answered") this.#keepOutcome(attempt.id, report);
      const proposal = report?.proposal ? await engine.supervisor.call("runs.proposal", { runId: attempt.runId }) : null;
      const actions = report ? this.#actionsOf(attempt, attemptRecord(workspace, attempt.id), report.verified, report.proposal !== null) : base.actions;
      return { ...base, report: report && maskValue(report, known), proposal: proposal && maskValue(proposal, known), progress: maskValue(await this.#progressOf(engine, attempt.runId), known), actions };
    } catch (error) {
      if (isRunNotFound(error)) return { ...base, unresolved: "Its engine has no record of this run any more." };
      return { ...base, unresolved: `Nivra can't read this run from its engine now (${errorText(error)}).` };
    }
  }

  /** Runs a decision, or a call about an apply, on an attempt with nothing else out on it: it offers nothing meanwhile. */
  async #deciding<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
    if (this.#applyCalls.has(attemptId)) throw new Error(DECIDING);
    this.#applyCalls.add(attemptId);
    try {
      return await work();
    } finally {
      this.#applyCalls.delete(attemptId);
    }
  }

  /** An attempt that ran to its end on its task's repository, with that repository still listed and on the same engine. */
  #decidable(taskId: string, attemptId: string): { attempt: AttemptRecord; project: ProjectRecord } {
    const workspace = this.#workspaceDb();
    const attempt = getAttempt(workspace, attemptId);
    if (!attempt || attempt.taskId !== taskId) throw new Error("That run is no longer here.");
    if (attempt.status !== "answered" || !attempt.runId || !attempt.homeId) throw new Error("This run didn't end with a report, so there is no change to decide on.");
    const task = getTask(workspace, taskId);
    if (!task) throw new Error("That task is no longer in the list.");
    const project = task.projectId ? this.#options.store.data.projects.find((p) => p.id === task.projectId) : undefined;
    if (!project || this.#removing.has(project.id)) throw new Error("This task's repository is no longer in the list, so its change can't be applied.");
    if (project.targetId !== attempt.targetId) throw new Error("This task now runs on another repository than the one this run changed, so its change can't be applied there.");
    return { attempt, project };
  }

  /** An attempt that ran to its end with a proposal no decision has been recorded on, as kept or as its engine reports it. */
  async #withProposal(taskId: string, attemptId: string): Promise<AttemptRecord> {
    const workspace = this.#workspaceDb();
    const attempt = getAttempt(workspace, attemptId);
    if (!attempt || attempt.taskId !== taskId) throw new Error("That run is no longer here.");
    if (attempt.status !== "answered" || !attempt.runId) throw new Error("This run didn't end with a report, so there is no change to decide on.");
    const record = attemptRecord(workspace, attemptId);
    if (record.decision !== null) throw new Error(DECIDED);
    let proposed = record.outcome?.proposalHash ?? null;
    if (record.outcome === null) proposed = (await this.#reportOf(await this.#attemptEngine(attempt), attempt)).proposal?.hash ?? null;
    if (proposed === null) throw new Error("This run proposed no change, so there is nothing to decide on.");
    return attempt;
  }

  /** An attempt's apply its engine has answered about and the person hasn't settled. */
  #settleable(taskId: string, attemptId: string): { attempt: AttemptRecord; apply: NonNullable<AttemptDecisionRecord["apply"]>; view: ApplyView } {
    const workspace = this.#workspaceDb();
    const attempt = getAttempt(workspace, attemptId);
    if (!attempt || attempt.taskId !== taskId) throw new Error("That run is no longer here.");
    const record = attemptRecord(workspace, attemptId);
    const apply = record.apply;
    if (record.decision !== "approved" || !apply?.view) throw new Error("Nothing has been applied for this run, so there is nothing to settle.");
    if (record.settle) throw new Error(SETTLE_ASKING);
    if (apply.view.resolution !== null) throw new Error("This change is settled already.");
    return { attempt, apply, view: apply.view };
  }

  /** The engine an attempt ran on, started if need be, holding the records it went to; or why it can't be used. */
  async #attemptEngine(attempt: AttemptRecord): Promise<Engine> {
    let engine: Engine;
    try {
      engine = await this.#started(attempt.targetId);
    } catch (error) {
      throw new Error(`The engine on ${this.#labelOf(attempt.targetId)} couldn't start (${errorText(error)}), so nothing was sent.`);
    }
    const state = engine.supervisor.state;
    if (state.status !== "online") throw new Error(`The engine on ${this.#labelOf(attempt.targetId)} isn't running, so nothing was sent. Open the project, then try again.`);
    if (state.info.homeId !== attempt.homeId) throw new Error("This run went to an engine whose records aren't here, so its change can't be decided on from this one.");
    return engine;
  }

  /** An attempt's report from its engine, kept as its outcome; refused when it can't be read or is about another run. */
  async #reportOf(engine: Engine, attempt: AttemptRecord): Promise<TaskReport> {
    let report: TaskReport | null;
    try {
      report = await engine.supervisor.call("runs.task", { runId: attempt.runId! });
    } catch (error) {
      throw new Error(`Nivra can't read this run's report from its engine now (${errorText(error)}), so nothing was sent. Try again.`);
    }
    if (!report || report.request.clientRequestId !== attempt.id || report.request.runId !== attempt.runId) throw new Error("This run's report can't be read from its engine, so nothing was sent. Run the task again.");
    this.#keepOutcome(attempt.id, report);
    return report;
  }

  /** How an attempt's run ended, kept once (D40): its history then shows without its engine. */
  #keepOutcome(attemptId: string, report: TaskReport): void {
    if (report.outcome === "in-progress" || this.#workspace.state !== "ready") return;
    recordOutcome(this.#workspace.db, attemptId, { outcome: report.outcome, verified: report.verified, proposalHash: report.proposal?.hash ?? null, baseline: report.snapshot?.baseline ?? null }, new Date().toISOString());
  }

  /**
   * Follows an apply its engine hasn't said the end of (D40), or a settling of it saved and not answered, by its request
   * id, never sending either again. Its own engine having no record of an apply means the approval never reached it: the
   * decision is taken back, so the person can approve again. Another engine's records can't say, and that is noted.
   */
  #followApply(attemptId: string): void {
    if (this.#followingApplies.has(attemptId)) return;
    this.#followingApplies.add(attemptId);
    void (async () => {
      let delay = 400;
      try {
        while (!this.#closing && this.#workspace.state === "ready") {
          const workspace = this.#workspace.db;
          const attempt = getAttempt(workspace, attemptId);
          const record = attemptRecord(workspace, attemptId);
          const apply = record.apply;
          const settling = record.settle !== null;
          if (!attempt || !apply || !(applyUnsettled(record) || settling)) return;
          // A call about it is still out in this session: its own answer comes first.
          if (this.#applyCalls.has(attemptId)) {
            await pause(delay);
            continue;
          }
          const engine = this.#engines.get(attempt.targetId);
          const state = engine?.supervisor.state;
          if (engine && state?.status === "online") {
            if (state.info.homeId !== attempt.homeId) {
              noteApply(workspace, attemptId, apply.requestId, `The apply went to an engine whose records aren't here (another engine home on ${this.#labelOf(attempt.targetId)}), so how it went can't be known from this one.`);
              clearSettle(workspace, attemptId, apply.requestId);
              return;
            }
            try {
              const view = await engine.supervisor.call("task.applyStatus", { requestId: apply.requestId });
              if (settling) {
                // A settling saved and not answered: what the engine says of the apply now is how it went, and what
                // follows from it follows. One that never reached the engine leaves the apply as it was, to settle again.
                if (view) await this.#recordSettled(attempt, apply.requestId, view);
                else {
                  noteApply(workspace, attemptId, apply.requestId, "Its engine has no record of this apply any more, so how settling it went can't be known.");
                  clearSettle(workspace, attemptId, apply.requestId);
                }
                return;
              }
              if (!view) {
                const answered = this.#applyAnswers.get(attemptId);
                withdrawDecision(workspace, attemptId, apply.requestId, answered ? `The engine didn't apply the change, so nothing was written: ${answered}` : APPLY_NEVER_SENT);
                return;
              }
              recordApply(workspace, attemptId, apply.requestId, maskValue(view, await this.#knownSecrets()), new Date().toISOString());
              delay = 400;
            } catch {
              delay = Math.min(delay * 2, 5_000);
            }
          } else {
            delay = Math.min(delay * 2, 5_000);
          }
          await pause(delay);
        }
      } catch (error) {
        this.#options.log(`Following an apply stopped: ${errorText(error)}`);
      } finally {
        this.#followingApplies.delete(attemptId);
        this.#applyAnswers.delete(attemptId);
      }
    })();
  }

  /**
   * What an engine that came online can say of the applies sent to its target (D40), asked by their request ids and
   * never sent again: an apply, or a settling of it saved before it was sent, whose end Nivra didn't hear (an answer
   * lost, or Nivra restarted) is followed until it is known; one its engine reported and the person hasn't settled is
   * read once more, since its engine may have settled it meanwhile.
   */
  #reconcileApplies(targetId: string): void {
    if (this.#workspace.state !== "ready") return;
    const workspace = this.#workspace.db;
    for (const attemptId of approvedApplies(workspace)) {
      const attempt = getAttempt(workspace, attemptId);
      if (!attempt || attempt.targetId !== targetId || this.#applyCalls.has(attemptId)) continue;
      const record = attemptRecord(workspace, attemptId);
      if (applyUnsettled(record) || record.settle) this.#followApply(attemptId);
      else if (this.#applyUnresolved(record)) this.#rereadApply(attemptId);
    }
  }

  /**
   * Reads once more an apply its engine reported and the person hasn't settled (D40): what its engine says now is kept
   * as a settle's answer would be, so a change settled meanwhile is followed by its task. A read that something newer
   * overtook (a settle sent or answered meanwhile) is dropped.
   */
  #rereadApply(attemptId: string): void {
    if (this.#rereading.has(attemptId)) return;
    this.#rereading.add(attemptId);
    void (async () => {
      try {
        const workspace = this.#workspaceDb();
        const attempt = getAttempt(workspace, attemptId);
        const record = attemptRecord(workspace, attemptId);
        const apply = record.apply;
        const engine = attempt ? this.#engines.get(attempt.targetId) : undefined;
        const state = engine?.supervisor.state;
        if (!attempt || !apply || !engine || state?.status !== "online" || state.info.homeId !== attempt.homeId) return;
        if (!this.#applyUnresolved(record) || applyUnsettled(record) || record.settle) return;
        const view = await engine.supervisor.call("task.applyStatus", { requestId: apply.requestId });
        if (!view) return;
        const masked = maskValue(view, await this.#knownSecrets());
        const now = attemptRecord(this.#workspaceDb(), attemptId);
        if (this.#applyCalls.has(attemptId) || now.settle || now.apply?.requestId !== apply.requestId || now.apply.readAt !== apply.readAt) return;
        this.#keepSettled(attempt, apply.requestId, masked);
      } catch (error) {
        this.#options.log(`Reading an apply again stopped: ${errorText(error)}`);
      } finally {
        this.#rereading.delete(attemptId);
      }
    })();
  }

  /** An attempt's apply as the window shows it, or null before one was asked for. */
  #applyView(attempt: AttemptRecord, record: AttemptDecisionRecord): TaskApplyView | null {
    const apply = record.apply;
    if (!apply) return null;
    const view = apply.view;
    const online = this.#engines.get(attempt.targetId)?.supervisor.state.status === "online";
    const unresolved =
      apply.note ??
      (applyUnsettled(record)
        ? online || this.#applyCalls.has(attempt.id)
          ? "Nivra is asking the engine how the apply went."
          : `The engine on ${this.#labelOf(attempt.targetId)} isn't running, so how the apply went can't be read now.`
        : record.settle && !this.#applyCalls.has(attempt.id)
          ? online
            ? SETTLE_LOST
            : `The engine on ${this.#labelOf(attempt.targetId)} isn't running, so how settling this change went can't be read now.`
          : null);
    return {
      requestId: apply.requestId,
      status: view?.status ?? null,
      refusal: view?.refusal ?? null,
      paths: view?.paths ?? [],
      folders: view?.folders ?? [],
      recovery: view?.recovery ?? null,
      failure: view?.failure ?? null,
      resolution: view?.resolution ?? null,
      unresolved,
    };
  }

  /**
   * What the person may do with an attempt now (D40): decide on a proposal no decision is recorded on (approve only when
   * every acceptance case passed), then settle its apply as its engine reports it. Nothing while a call is out.
   */
  #actionsOf(attempt: AttemptRecord, record: AttemptDecisionRecord, verified: boolean, proposed: boolean): AttemptAction[] {
    if (attempt.status !== "answered" || this.#applyCalls.has(attempt.id) || record.settle) return [];
    if (record.decision === null) return proposed ? [...(verified ? (["approve"] as const) : []), "reject", "revise"] : [];
    const view = record.apply?.view;
    if (record.decision !== "approved" || !view || view.resolution !== null || applyUnsettled(record)) return [];
    if (view.status === "applied") return record.acceptedAt ? [] : ["accept"];
    // A file moved aside with nothing in its place can only be restored: keeping that would leave it missing.
    if (view.status === "partial") return view.paths.some((one) => one.place === "aside") ? ["restore"] : ["restore", "keep"];
    return view.status === "not-applied" || view.status === "refused" || view.status === "unknown" ? ["dismiss"] : [];
  }

  /**
   * What a task's last run waits on (D40): its change being applied; the person's decision on its proposal; or the
   * person settling what was applied. Null when it waits on nothing.
   */
  #waitingOn(taskId: string): "applying" | "decision" | "settle" | null {
    if (this.#workspace.state !== "ready") return null;
    const latest = attemptsOf(this.#workspace.db, taskId).at(-1);
    if (!latest || latest.status !== "answered") return null;
    const record = attemptRecord(this.#workspace.db, latest.id);
    if (record.acceptedAt) return null;
    if (record.decision === null) return record.outcome?.proposalHash ? "decision" : null;
    if (record.decision !== "approved" || !record.apply) return null;
    if (applyUnsettled(record) || record.settle || this.#applyCalls.has(latest.id)) return "applying";
    const view = record.apply.view;
    return view && view.resolution === null ? "settle" : null;
  }

  /** Whether any of a task's applies is going, or left partial or unknown and not yet settled: its checkout is in play. */
  #applyOpen(taskId: string): boolean {
    if (this.#workspace.state !== "ready") return false;
    const workspace = this.#workspace.db;
    return attemptsOf(workspace, taskId).some((attempt) => {
      const record = attemptRecord(workspace, attempt.id);
      const view = record.apply?.view;
      return this.#applyCalls.has(attempt.id) || record.settle !== null || applyUnsettled(record) || (view !== undefined && view !== null && view.resolution === null && (view.status === "partial" || view.status === "unknown"));
    });
  }

  /**
   * Refuses changing what a task's runs answer to, its brief or its repository, while any of its applies isn't settled
   * (D40): one going or being settled, or one its engine reported and the person hasn't settled. Accepting an older
   * run's change would otherwise settle a task that has moved on. `except` is the attempt being decided on now.
   */
  #holdForSettling(taskId: string, what: string, except?: string): void {
    const workspace = this.#workspaceDb();
    for (const attempt of attemptsOf(workspace, taskId)) {
      if (attempt.id === except) continue;
      const record = attemptRecord(workspace, attempt.id);
      if (this.#applyCalls.has(attempt.id) || applyUnsettled(record) || record.settle) throw new Error(`This task's change is still being applied or settled, so ${what}. Wait for it to finish, then try again.`);
      if (this.#applyUnresolved(record)) throw new Error(`This task's change needs settling first, so ${what}: accept it, keep or restore what was applied, or dismiss it. Then try again.`);
    }
  }

  /**
   * Whether an apply its engine reported is still waiting on the person: applied, not applied, refused, partial or
   * unknown, with no resolution. Its engine keeps a record of it, and any copies it kept, until it is settled.
   */
  #applyUnresolved(record: AttemptDecisionRecord): boolean {
    const view = record.apply?.view;
    return view !== null && view !== undefined && view.resolution === null;
  }

  /** A task's state as the window shows it (D40): active while a run or its apply goes, in review while it waits on the person. */
  #taskStateOf(task: TaskRecord): TaskState {
    if (task.state === "completed" || this.#workspace.state !== "ready") return task.state;
    if (attemptsOf(this.#workspace.db, task.id).some((attempt) => attempt.status === "submitting" || attempt.status === "running")) return "active";
    const waiting = this.#waitingOn(task.id);
    return waiting === "applying" ? "active" : waiting ? "review" : task.state;
  }

  /** A run's latest progress, oldest first: what its steps said, and its model's calls. */
  async #progressOf(engine: Engine, runId: string): Promise<string[]> {
    const messages: string[] = [];
    for (let after = 0, pages = 0; pages < 4; pages++) {
      const page = await engine.supervisor.call("runs.events", { runId, after, limit: 500 });
      for (const event of page.events) if (event.type === "step.output" || event.type === "model.call" || event.type === "step.failed") messages.push(event.message);
      if (page.events.length < 500) break;
      after = page.next;
    }
    return messages.slice(-20);
  }

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

  /**
   * Cancels the project's queued and running explain and conversation runs, and stops its research with stops of its
   * own for `cause` (D37), all at once. When any can't be stopped, says so through `refusal`, naming each kind.
   */
  async #stopProjectRuns(projectId: string, cause: StopCause, refusal: (runs: string, why: string, them: "it" | "them") => string): Promise<void> {
    const research = this.#workspace.state === "ready" ? openTurns(this.#workspace.db, { projectId }).filter((link) => link.workflowId === "research") : [];
    // A run whose engine isn't online isn't running any more.
    const all = [...(this.#explainRuns.get(projectId) ?? []), ...(this.#conversationRuns.get(projectId) ?? [])];
    const runs = all.filter((runId) => this.#engines.get(this.#runs.get(runId) ?? "")?.supervisor.state.status === "online");
    const [results, researchFailed] = await Promise.all([Promise.allSettled(runs.map((runId) => this.cancelRun(runId))), this.#stopResearchRuns(research, cause)]);
    const failed = results.flatMap((result) => (result.status === "rejected" ? [errorText(result.reason)] : []));
    if (failed.length === 0 && researchFailed.length === 0) return;
    const kinds = [
      failed.length === 0 ? null : failed.length === 1 ? "an explain run" : `${failed.length} explain runs`,
      researchFailed.length === 0 ? null : researchFailed.length === 1 ? "a research run" : `${researchFailed.length} research runs`,
    ].filter((kind) => kind !== null);
    throw new Error(refusal(kinds.join(" and "), [...failed, ...researchFailed][0]!, failed.length + researchFailed.length === 1 ? "it" : "them"));
  }

  /**
   * Stops research runs with stops of their own, for `cause` (D37). A run is cancelled on its engine; one still being
   * sent stops at its own check, and one whose run isn't known yet once it is found. A run whose engine isn't online
   * isn't running any more (D4). Only a stop whose own cancel failed is taken back, so a stop that worked stays on
   * record whatever else failed. Returns why each of those failed, for the caller's refusal.
   */
  async #stopResearchRuns(links: readonly TurnRecord[], cause: StopCause): Promise<string[]> {
    if (this.#workspace.state !== "ready") return [];
    const workspace = this.#workspace.db;
    const stopped = links.flatMap((link) => {
      const token = this.#stopResearch(workspace, link.id, cause);
      return token ? [{ link, token }] : [];
    });
    const running = stopped.filter(({ link }) => link.runId && this.#engines.get(link.targetId)?.supervisor.state.status === "online");
    const results = await Promise.allSettled(running.map(({ link }) => this.cancelRun(link.runId!)));
    const failed = running.flatMap((stop, index) => {
      const result = results[index]!;
      return result.status === "rejected" ? [{ ...stop, why: errorText(result.reason) }] : [];
    });
    if (this.#workspace.state === "ready") for (const { link, token } of failed) withdrawStop(this.#workspace.db, link.id, token);
    return failed.map(({ why }) => why);
  }

  /**
   * Records why the project's open conversation turns stop, so each ends as cancelled by that, not by the person.
   * Returns a function that takes the reason back, for when they couldn't be stopped. A turn still being sent stops
   * through its epoch check either way. Research has stops of its own (D37), made by `#stopProjectRuns`.
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

  /**
   * Why a conversation can't take another run now (D31, D37): a turn, a review or research still going, in the person's
   * terms; null when it can.
   */
  #busyReason(conversationId: string, then: string): string | null {
    const open = openTurns(this.#workspaceDb(), { conversationId });
    if (!open.length) return null;
    if (open.some((link) => link.workflowId === "research")) return `Research of a plan's assumptions is running in this conversation. Wait for it, or cancel it, then ${then}.`;
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
    if (link.workflowId === "research") {
      // A stop of its own (D37). One being sent stops at its own check, one whose run isn't known yet once it is found;
      // a stop its engine can't carry out is taken back, and a newer stop is never cleared.
      const workspace = this.#workspaceDb();
      const token = this.#stopResearch(workspace, link.id, "person");
      if (!token) return;
      if (link.runId) {
        await this.cancelRun(link.runId).catch((error: unknown) => {
          withdrawStop(workspace, link.id, token);
          throw error;
        });
      } else if (!this.#submissions.has(link.id)) this.#follow(link.id);
      return;
    }
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

  /**
   * A plan version to research, with its conversation and project; refused in plain words when it can't be researched.
   */
  #researchSubject(planId: string): ResearchSubject {
    const workspace = this.#workspaceDb();
    const plan = getArtifact(workspace, planId);
    const conversation = plan?.kind === "plan" && plan.conversationId ? getConversation(workspace, plan.conversationId) : null;
    if (!plan || !conversation) throw new Error("That plan is no longer here.");
    const latestVersion = versionsOf(workspace, plan.lineageId).at(-1)?.version ?? plan.version;
    if (conversation.projectId === null) return { plan, latestVersion, conversation, project: null };
    const project = this.#options.store.data.projects.find((p) => p.id === conversation.projectId);
    if (!project) throw new Error(RESEARCH_CLOSED);
    if (this.#removing.has(project.id)) throw new Error("This plan's project is being removed, so its assumptions can't be checked.");
    return { plan, latestVersion, conversation, project: { label: project.label, targetLabel: this.#labelOf(project.targetId), modelSharing: project.sharing.modelContext } };
  }

  /**
   * Everything research of `subject` with `selection` would send, worked out from the records as they are now (D37):
   * the packet, what no query may name (every project's name, and the paths the plan cites), the permissions, and the
   * preview that shows them, with the fingerprint that binds it.
   */
  async #researchRequest(subject: ResearchSubject, selection: ResearchSelection): ReturnType<typeof researchRequest> {
    const credentials = await this.#options.credentials();
    return researchRequest(subject, selection, {
      webResearch: this.webResearch(),
      tavilyKey: Boolean(credentials["TAVILY_API_KEY"]),
      modelKey: Boolean(credentials["NEBIUS_API_KEY"]),
      known: await this.#knownSecrets(),
      projects: this.#options.store.data.projects.map(({ label, nativePath }) => ({ label, nativePath })),
      busy: this.#busyReason(subject.conversation.id, "start research"),
    });
  }

  /**
   * Why research must not go on (D37): the stop on record, or a permission withdrawn since it was asked for (research
   * turned off, the project's sharing turned off, or the project removed). Null when it may.
   */
  #researchStop(id: string, conversation: ConversationRecord, epoch: number, researchEpoch: number): StopCause | null {
    const recorded = this.#workspace.state === "ready" ? (getResearch(this.#workspace.db, id)?.stop?.cause ?? null) : null;
    if (recorded) return recorded;
    if (!this.webResearch() || this.#webResearchEpoch !== researchEpoch) return "web-research";
    if (conversation.projectId === null) return null;
    const project = this.#options.store.data.projects.find((p) => p.id === conversation.projectId);
    if (!project || this.#removing.has(project.id)) return "removal";
    if (!project.sharing.modelContext || this.#epochOf(project.id) !== epoch) return "model-sharing";
    return null;
  }

  /**
   * Records a research stop that a permission check found, unless one is on record already: that one says why (D37).
   */
  #recordResearchStop(id: string, cause: StopCause): void {
    if (this.#workspace.state !== "ready") return;
    const workspace = this.#workspace.db;
    if (!getResearch(workspace, id)?.stop) this.#stopResearch(workspace, id, cause);
  }

  /** Asks research to stop (D37), as `stopResearch` does; a newer stop leaves no earlier failure on show. */
  #stopResearch(workspace: WorkspaceDb, id: string, cause: StopCause): string | null {
    const token = stopResearch(workspace, id, cause);
    if (token) this.#researchStopFailures.delete(id);
    return token;
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
   * Sends a stored turn, review or research (D26, D31, D37). The request is written only after the engine's store is
   * recorded with it, so one with none was never sent. A failure known to come before writing is "not sent"; anything
   * after it (no answer, a closed connection, an error answer: the engine may have started the run first) leaves it to
   * be found by its request id.
   */
  async #submit(turnId: string, conversation: ConversationRecord, request: LinkRequest, epoch: number, researchEpoch = this.#webResearchEpoch): Promise<void> {
    const workspace = this.#workspaceDb();
    const label = this.#labelOf(conversation.targetId);
    const { what, nothing } = sendWords(request.workflowId);
    // A stop asked for meanwhile, or a permission withdrawn since: recorded, and research's with its own cause (D37).
    const stopped = (): boolean => {
      if (request.workflowId === "research") {
        const cause = this.#researchStop(turnId, conversation, epoch, researchEpoch);
        if (cause) this.#recordResearchStop(turnId, cause);
        return cause !== null;
      }
      const reason = this.#stopReason(turnId, conversation, epoch);
      if (reason) requestCancel(workspace, turnId, reason);
      return reason !== null;
    };
    const notSent = (why: string) => {
      this.#submissions.delete(turnId);
      this.#settle(turnId, { status: "not-sent", errorMessage: why });
    };
    let engine: Engine;
    try {
      engine = await this.#ensure(conversation.targetId);
      if (engine.supervisor.state.status === "starting") await engine.supervisor.start();
    } catch (error) {
      notSent(`The engine on ${label} couldn't start (${errorText(error)}), so ${what} wasn't sent and ${nothing}.`);
      return;
    }
    const state = engine.supervisor.state;
    if (state.status !== "online") {
      notSent(`The engine on ${label} isn't running${state.status === "failed" ? ` (${state.reason})` : ""}, so ${what} wasn't sent and ${nothing}.`);
      return;
    }
    if (stopped()) {
      this.#submissions.delete(turnId);
      this.#settle(turnId, { status: "cancelled", errorMessage: `It was stopped before it was sent, so ${nothing}.` });
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
        notSent(`The engine on ${label} didn't take ${what} (${errorText(error)}), so ${nothing}.`);
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
    // Research is stopped from its own records, with stops of its own (D37), never with the project's other runs.
    if (conversation.projectId !== null && request.workflowId !== "research") {
      const runs = this.#conversationRuns.get(conversation.projectId) ?? new Set<string>();
      runs.add(run.id);
      this.#conversationRuns.set(conversation.projectId, runs);
    }
    // Stopped while the request was out (a cancel, a deletion, consent withdrawn): the run stops now.
    const late = stopped();
    this.#submissions.delete(turnId);
    if (getTurn(workspace, turnId) === null) {
      this.#stopDeleted(engine, turnId, state.info.homeId, run.id);
      return;
    }
    if (late) {
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
          const { what, nothing } = sendWords(turn.workflowId);
          if (turn.homeId === null) {
            this.#settle(turnId, { status: "not-sent", errorMessage: `Nivra stopped before sending ${what}, so ${nothing}.` });
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
                  this.#settle(turnId, { status: "not-sent", errorMessage: `Its engine has no record of ${what}, so it never ran and ${nothing}.` });
                  return;
                }
                this.#runs.set(summary.id, turn.targetId);
                recordRun(workspace, turnId, summary.id);
              }
              if (isTerminal(summary.status)) {
                await this.#finish(turnId, engine, summary);
                this.#researchStopFailures.delete(turnId);
                return;
              }
              if (turn.cancelRequested && !cancelSent) {
                cancelSent = true;
                // Research's stop has a token of its own (D37). One its engine can't carry out is taken back by that
                // token alone, so a newer stop stays on record; the card says why, and Cancel works again. The run is
                // recorded by now, so a newer stop cancels it directly: this one is sent once.
                const stop = turn.workflowId === "research" ? (getResearch(workspace, turnId)?.stop ?? null) : null;
                await engine.supervisor.call("runs.cancel", { runId: summary.id }).catch((error: unknown) => {
                  if (!stop || this.#workspace.state !== "ready" || !withdrawStop(this.#workspace.db, turnId, stop.token)) return;
                  this.#researchStopFailures.set(turnId, researchStopFailedText(stop.cause, errorText(error)));
                });
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
    if (link?.workflowId === "research") return this.#finishResearch(link, engine, summary);
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

  /**
   * Records how research's run ended (D37), with the report its engine saved, masked again. A report that isn't the one
   * this research asked for (another plan version, packet, scope, queries, request or run) is kept nowhere, and its end
   * is unknown. A report that ended short is kept with how it ended: what was read, and what the model handed in, stay
   * as evidence.
   */
  async #finishResearch(link: TurnRecord, engine: Engine, summary: RunSummary): Promise<void> {
    const research = getResearch(this.#workspaceDb(), link.id);
    if (!research) return;
    const known = await this.#knownSecrets();
    const report = await engine.supervisor.call("runs.research", { runId: summary.id });
    if (report && !researchReportMatches(report, research, summary.id)) {
      this.#settle(link.id, { status: "unknown", errorMessage: "its engine's report is about something other than what this research sent, so none of it was kept" });
      return;
    }
    const kept = report ? maskValue(report, known) : null;
    const end = (outcome: Parameters<typeof settleResearch>[2], with_: ResearchReport | null) => {
      if (this.#workspace.state === "ready") settleResearch(this.#workspace.db, link.id, outcome, with_, new Date().toISOString());
    };
    if (summary.status === "succeeded") {
      if (kept?.outcome === "complete") end({ status: "answered" }, kept);
      else this.#settle(link.id, { status: "unknown", errorMessage: "its run finished, but its engine has no complete report stored for it" });
      return;
    }
    if (summary.status === "cancelled") {
      // A stop Nivra asked for is on record with its cause; any other cancel means Nivra or its engine stopped first.
      end({ status: getResearch(this.#workspaceDb(), link.id)?.stop ? "cancelled" : "interrupted" }, kept);
      return;
    }
    const { interrupted, kind } = await this.#failureOf(engine, summary.id);
    end(interrupted ? { status: "interrupted" } : { status: "failed", errorKind: kind, errorMessage: maskForStorage(summary.error ?? "The research failed.", known) }, kept);
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

  #researchView(research: ResearchRecord, engine: EngineView): ResearchView {
    const { link } = research;
    const workspace = this.#workspaceDb();
    const open = link.status === "submitting" || link.status === "running";
    const away = open && !this.#submissions.has(link.id) && engine.state.status !== "online";
    const amended = research.amendedPlanId ? getArtifact(workspace, research.amendedPlanId) : null;
    return {
      id: research.id,
      conversationId: research.conversationId,
      planId: research.planId,
      planLineage: research.planLineage,
      planVersion: research.planVersion,
      latestVersion: versionsOf(workspace, research.planLineage).at(-1)?.version ?? research.planVersion,
      status: link.status,
      note: researchNoteFor(link, research.stop),
      unresolved: away ? (engine.state.status === "failed" ? engine.state.reason : `The engine on ${engine.label} isn't running, so Nivra can't check this research yet. It checks again when you open the conversation.`) : null,
      runId: link.runId,
      cancelRequested: link.cancelRequested,
      stopCause: research.stop?.cause ?? null,
      stopFailed: open && !research.stop ? (this.#researchStopFailures.get(research.id) ?? null) : null,
      queries: research.queries,
      sites: research.sites,
      packetDigest: research.packetDigest,
      amended: amended ? { planId: amended.id, version: amended.version } : null,
      report: research.report as ResearchView["report"],
      createdAt: research.createdAt,
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
    // An acceptance case's command and expected output are kept as written (D39): what a case must print is exact.
    const cases = input.acceptanceCases.map((given, index) => {
      const label = `Acceptance case ${index + 1}`;
      const name = given.name.trim();
      const command = given.command.trim();
      if (!name) throw new Error(`${label} needs a name. Add one, then save it again.`);
      if (name.length > TASK_BRIEF_LIMITS.caseNameChars) throw new Error(`${label}'s name is ${name.length} characters long, and it can hold ${TASK_BRIEF_LIMITS.caseNameChars}. Shorten it, then save it again.`);
      if (!command) throw new Error(`${label} needs a command to run. Add one, then save it again.`);
      if (command.length > TASK_BRIEF_LIMITS.commandChars) throw new Error(`${label}'s command is ${command.length} characters long, and it can hold ${TASK_BRIEF_LIMITS.commandChars}. Shorten it, then save it again.`);
      if (command.includes("\0") || given.expectedOutput.includes("\0")) throw new Error(`${label} holds a NUL character, which a command can't carry. Remove it, then save it again.`);
      const bytes = Buffer.byteLength(given.expectedOutput);
      if (bytes > TASK_BRIEF_LIMITS.expectedOutputBytes) throw new Error(`${label}'s expected output is ${bytes} bytes, and it can hold ${TASK_BRIEF_LIMITS.expectedOutputBytes}. Shorten it, then save it again.`);
      if (!Number.isInteger(given.expectedExitCode) || given.expectedExitCode < 0 || given.expectedExitCode > 255) throw new Error(`${label}'s exit code must be a whole number from 0 to 255. Change it, then save it again.`);
      return { name, command, expectedOutput: given.expectedOutput, expectedExitCode: given.expectedExitCode };
    });
    if (cases.length > TASK_BRIEF_LIMITS.finalChecks) throw new Error(`There are ${cases.length} acceptance cases, and a brief can hold ${TASK_BRIEF_LIMITS.finalChecks}. Remove some, then save it again.`);
    return BriefFieldsSchema.parse({
      goal: text("The goal", input.goal, TASK_LIMITS.textChars),
      acceptanceCriteria: rows("Acceptance criterion", "acceptance criteria", input.acceptanceCriteria),
      scope: text("The scope", input.scope, TASK_LIMITS.textChars),
      exclusions: text("The exclusions", input.exclusions, TASK_LIMITS.textChars),
      context: text("The context", input.context, TASK_LIMITS.contextChars),
      assumptions: rows("Assumption", "assumptions", input.assumptions),
      checks: rows("Check", "checks", input.checks),
      acceptanceCases: cases,
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
    for (const given of fields.acceptanceCases) {
      refuseCredentials("An acceptance case's name", given.name, known);
      refuseCredentials("An acceptance case's command", given.command, known);
      refuseCredentials("An acceptance case's expected output", given.expectedOutput, known);
    }
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
      state: this.#taskStateOf(task),
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
      // Each time it comes online, at start or after a restart, what it can say of open applies is read back (D40).
      engine.supervisor.onChange((state) => {
        if (state.status === "online") this.#reconcileApplies(targetId);
      });
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

/** A task run's end in Nivra's words, when it ended without its run's own report to read; null while it goes. */
/**
 * Whether an apply was asked for and its engine hasn't said how it ended (D40): no answer yet, or one still claimed or
 * writing, with no note that it can't be known. Such an apply is only ever asked about by its request id.
 */
function applyUnsettled(record: AttemptDecisionRecord): boolean {
  const apply = record.apply;
  if (record.decision !== "approved" || !apply || apply.note !== null) return false;
  return !apply.view || apply.view.status === "claimed" || apply.view.status === "writing";
}

function attemptNote(attempt: AttemptRecord): string | null {
  switch (attempt.status) {
    case "failed":
      return `${attempt.errorMessage ?? "The run failed."} Nothing was resent.`;
    case "cancelled":
      return attempt.cancelReason === "sharing"
        ? "Stopped: this project's sharing or uploads were turned off. What it had sent stays where it went; its report says what that was."
        : attempt.cancelReason === "removal"
          ? "Stopped: the project was removed. What it had sent stays where it went."
          : attempt.errorMessage
            ? `Cancelled. ${attempt.errorMessage}`
            : "Cancelled. What it had sent stays where it went; its report says what that was.";
    case "interrupted":
      return "Interrupted: Nivra or its engine stopped while the run was going. It wasn't started again.";
    case "not-sent":
      return attempt.errorMessage ?? `Not sent: ${RUN_NOTHING}.`;
    case "unknown":
      return `Nivra can't tell how this run ended: ${attempt.errorMessage ?? "its engine can't say"}. Nothing was resent.`;
    default:
      return null;
  }
}

/** Every text of a run's brief, by the field a refusal names. */
function briefTexts(brief: TaskBrief): Array<[string, string]> {
  return [
    ["The goal", brief.goal],
    ["The scope", brief.scope],
    ["The exclusions", brief.exclusions],
    ["The context", brief.context],
    ...brief.acceptanceCriteria.map((text): [string, string] => ["An acceptance criterion", text]),
    ...brief.checks.map((text): [string, string] => ["A check", text]),
    ...brief.acceptanceCases.flatMap((given): Array<[string, string]> => [
      ["An acceptance case's name", given.name],
      ["An acceptance case's command", given.command],
      ["An acceptance case's expected output", given.expectedOutput],
    ]),
  ];
}
