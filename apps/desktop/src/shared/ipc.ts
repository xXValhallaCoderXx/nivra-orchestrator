import type {
  ApplyPath,
  ApplyRefusalCode,
  ApplyResolution,
  ApplyStatus,
  BaselineSelection,
  BuildsAcceptance,
  ChatResult,
  CoachField,
  DoctorReport,
  EngineInfo,
  EnvironmentChoices,
  EnvironmentPreviewV2,
  EnvironmentRef,
  EnvironmentReport,
  ExplainResult,
  HistoryRecord,
  MissionContent,
  PreferenceIntent,
  PreferenceScope,
  PreparedEnvironmentV2,
  ProviderCheck,
  ReviewPanel,
  ReviewReport,
  RunEventsPage,
  RunStatus,
  RunSummary,
  SandboxPreview,
  SandboxReport,
  SandboxStatus,
  SnapshotPreview,
  SpecialistId,
  TaskProposal,
  TaskReport,
  TaskRunLimits,
} from "@nivra/domain";
import type { CoachingView, CoachPreview, CoachSelection } from "./coach.ts";
import type { ResearchPreview, ResearchSelection, ResearchView } from "./research.ts";
import type { BudgetPolicy, BudgetPolicyDraft, BudgetRemaining, BudgetSummary, PriceCatalogue } from "@nivra/domain";

/**
 * The renderer's whole view of the app: named, typed calls on `window.nivra`, each an `ipcRenderer.invoke` (AGENTS.md,
 * Electron security rules). Every new call is added here first. The renderer imports domain types only (zod at
 * runtime would trip the CSP), and it never sends a filesystem path: folders come from the native picker in main (D1).
 * There is no target to choose: each project's folder decides which engine it uses (D17), so calls name a project.
 */

export const IPC = {
  getAppInfo: "app:info",
  copyText: "app:copy-text",
  draftHasSavedKey: "drafts:has-saved-key",
  listEngines: "engines:list",
  openProject: "projects:open",
  restartEngine: "engine:restart",
  runDoctor: "engine:doctor",
  getWsl: "wsl:get",
  checkWsl: "wsl:check",
  listProjects: "projects:list",
  addProject: "projects:add",
  removeProject: "projects:remove",
  setSharing: "projects:sharing",
  setCloudExecution: "projects:cloud-execution",
  previewSandboxCheck: "sandbox:preview",
  startSandboxCheck: "sandbox:start",
  cancelSandboxCheck: "sandbox:cancel",
  getSandboxCheck: "sandbox:get",
  getSandboxStatus: "sandbox:status",
  getEnvironment: "environment:get",
  resolveEnvironment: "environment:resolve",
  prepareEnvironment: "environment:prepare",
  acceptMissingBuilds: "environment:accept-builds",
  cancelPreparation: "environment:cancel",
  listPreferences: "preferences:list",
  addPreference: "preferences:add",
  editPreference: "preferences:edit",
  deletePreference: "preferences:delete",
  supersedePreference: "preferences:supersede",
  keepSuggestion: "preferences:keep",
  exportPreferences: "preferences:export",
  previewImport: "preferences:import-preview",
  importPreferences: "preferences:import",
  startHello: "runs:hello",
  startExplain: "runs:explain",
  runResult: "runs:result",
  runEvents: "runs:events",
  cancelRun: "runs:cancel",
  getSettings: "settings:get",
  setNebiusKey: "settings:nebius-key",
  setNebiusProjectId: "settings:nebius-project-id",
  setTavilyKey: "settings:tavily-key",
  setWebResearch: "settings:web-research",
  checkTokenFactory: "providers:check",
  listConversations: "conversations:list",
  createConversation: "conversations:create",
  getConversation: "conversations:get",
  openConversation: "conversations:open",
  sendMessage: "conversations:send",
  cancelTurn: "conversations:cancel-turn",
  deleteConversation: "conversations:delete",
  restartConversationEngine: "conversations:restart-engine",
  savePlan: "plans:save",
  revisePlan: "plans:revise",
  listPlans: "plans:list",
  prepareReview: "reviews:prepare",
  startReview: "reviews:start",
  listReviews: "reviews:list",
  cancelReview: "reviews:cancel",
  prepareResearch: "research:prepare",
  startResearch: "research:start",
  listResearch: "research:list",
  cancelResearch: "research:cancel",
  saveAmendedPlan: "research:save-amended",
  listTasks: "tasks:list",
  getTask: "tasks:get",
  createTask: "tasks:create",
  reviseBrief: "tasks:revise-brief",
  refreshBriefFromPlan: "tasks:refresh-brief",
  setTaskProject: "tasks:project",
  setTaskState: "tasks:state",
  renameTask: "tasks:rename",
  deleteTask: "tasks:delete",
  getRunLimits: "tasks:run-limits",
  previewTaskRun: "tasks:preview-run",
  startTaskRun: "tasks:start-run",
  cancelTaskRun: "tasks:cancel-run",
  getTaskAttempt: "tasks:attempt",
  approveTaskChange: "tasks:approve",
  rejectTaskChange: "tasks:reject",
  requestTaskRevision: "tasks:request-revision",
  settleTaskChange: "tasks:settle",
  restoreTaskChange: "tasks:restore",
  listMissions: "missions:list",
  getMission: "missions:get",
  openMission: "missions:open",
  createMission: "missions:create",
  reviseMission: "missions:revise",
  deleteMission: "missions:delete",
  createMissionTask: "missions:create-task",
  addMissionTask: "missions:add-task",
  removeMissionTask: "missions:remove-task",
  prepareMissionReview: "missions:prepare-review",
  startMissionReview: "missions:start-review",
  cancelMissionReview: "missions:cancel-review",
  prepareCoach: "coach:prepare",
  startCoach: "coach:start",
  listCoachings: "coach:list",
  cancelCoach: "coach:cancel",
  acceptCoachChanges: "coach:accept",
  getBudgetPolicy: "budget:get-policy",
  setBudgetPolicy: "budget:set-policy",
  budgetSummary: "budget:summary",
  budgetPrices: "budget:prices",
  confirmBudgetMonth: "budget:confirm-month",
  startNewBudgetHistory: "budget:start-new-history",
} as const;

/** The longest message a conversation's turn carries (D26): `CHAT_LIMITS.messageChars`, which a test keeps equal. */
export const MESSAGE_CHARS = 8_000;

/** The most text a copy button may put on the clipboard (copyText), in characters. */
export const COPY_TEXT_CHARS = 65_536;

/** The most text one draft check takes (draftHasSavedKey), in characters: a draft's value and its label together. */
export const DRAFT_CHECK_CHARS = 262_144;

/** What the host takes in a task's title, brief and plan (D26); the window counts a plan's characters as they are typed. */
export const TASK_LIMITS = { titleChars: 200, textChars: 4_000, contextChars: 20_000, itemChars: 1_000, items: 20, planChars: 20_000 } as const;

/**
 * The review panels (D30), as the domain names them; a test keeps them equal. The window offers the council only: a
 * single reviewer is the baseline the council is measured against.
 */
export const REVIEW_PANELS = ["council", "single"] as const;

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  packaged: boolean;
}

/**
 * What WSL can offer on this Windows host (D17), with what to do when it offers nothing. `checking` until the first
 * discovery has finished; the whole view is null off Windows.
 */
export interface WslView {
  status: "checking" | "ready" | "missing" | "inbox-only" | "broken" | "no-usable-distribution";
  /** What happened and what to do; null when at least one distribution can be used. */
  message: string | null;
  /** WSL's own `WSL_E_*` code, when it gave one. */
  code: string | null;
  distros: Array<{ name: string; label: string; isDefault: boolean; problem: string | null }>;
}

export type EngineStateView =
  | { status: "stopped" }
  | { status: "starting"; detail: string }
  | { status: "online"; info: EngineInfo }
  | { status: "failed"; reason: string; code: string | null; logPath: string | null };

export interface EngineView {
  targetId: string;
  label: string;
  state: EngineStateView;
  /** Problems the target reported that do not stop the engine (no git, a distribution that opens as root, …). */
  warnings: string[];
}

export interface ProjectView {
  id: string;
  /** The engine this project's folder belongs to (D17): "local" or "wsl:<distro>". */
  targetId: string;
  /** "Ubuntu · WSL", "Windows · Local", … shown wherever work starts (D1). */
  targetLabel: string;
  label: string;
  /** For display only: the renderer never sends a path back. */
  displayPath: string;
  /** Something to tell the person about this project this session (it moved to another engine, say); null otherwise. */
  notice: string | null;
  /**
   * What the project allows to leave the machine (D20), each off until the person agrees: excerpts to Token Factory
   * (`modelContext`), and its commit uploaded to Nebius Sandboxes (`cloudExecution`, D36). Neither stands in for the other.
   */
  sharing: { modelContext: boolean; cloudExecution: boolean };
}

/**
 * A project's sandbox check this session (D36). `sending` while its start is out, `looking` when the answer was lost
 * and it is being found by its request id, `not-sent` when its engine has no record of it, `unknown` when its state
 * can't be read now; otherwise its run's status. The report is the engine's, whatever the status.
 */
export interface SandboxCheckView {
  runId: string | null;
  status: RunStatus | "sending" | "looking" | "not-sent" | "unknown";
  report: SandboxReport | null;
  /** Something to tell the person about it: stopped because uploads were turned off, say; null otherwise. */
  note: string | null;
}

/**
 * A preparation of a project's environment (D41), as the workspace keeps it and its engine reports it. `not-sent` and
 * `unknown` mean what they mean for a turn. Nothing is ever resent: preparing again makes a new preparation.
 */
export interface PreparationView {
  id: string;
  runId: string | null;
  status: TurnStatus;
  /** What happened, in Nivra's words, when it ended without its report or was stopped; null while it goes. */
  note: string | null;
  /** Why its engine can't be read now, while that lasts. */
  unresolved: string | null;
  cancelRequested: boolean;
  /** What the person chose when it was started (NIV-55); null for one an earlier version of Nivra started. */
  choices: EnvironmentChoices | null;
  /** Its engine's report: kept when it ended, read from its engine while it goes; null until there is one. */
  report: EnvironmentReport | null;
  /** Its latest progress, oldest first. */
  progress: string[];
  createdAt: string;
  settledAt: string | null;
}

/**
 * A project's environment (D41, NIV-55): what the person chose with its last preparation, what its last successful
 * preparation left and whether its task runs may start from it, and its latest preparation.
 */
export interface EnvironmentView {
  projectId: string;
  /** The choices made with its last preparation; null before the first, or when an earlier version of Nivra started it. */
  choices: EnvironmentChoices | null;
  /** What its task runs start from once it is ready; null until a preparation ends prepared. */
  prepared: PreparedEnvironmentV2 | null;
  /** Whether its task runs may start from it: every dependency build ran, or the person accepted those that didn't. */
  ready: boolean;
  /** The person's acceptance of the dependency builds that didn't run, for this environment; null when there is none. */
  builds: BuildsAcceptance | null;
  /** Its environment was prepared by an earlier version of Nivra, which task runs no longer start from. */
  legacy: boolean;
  preparation: PreparationView | null;
  /** Why Prepare can't be pressed now, in plain words; null when it can. Uploads, when off, are asked for when it is pressed. */
  blocked: string | null;
  /** Something to know about the prepared environment, such as that it was made in another Nebius project; null otherwise. */
  notice: string | null;
}

/** One of the engineer's preferences, from the host's canonical store (D21). */
export interface PreferenceView {
  id: string;
  statement: string;
  /** `personal` applies to every project; `project` only to its own project's runs. */
  scope: PreferenceScope;
  /** The project a project preference belongs to, and its label; both null for a personal one. */
  projectId: string | null;
  projectLabel: string | null;
  /** A default, which the repository's conventions outrank, or a project's decision to change them (D23). */
  intent: PreferenceIntent;
  /** Only confirmed preferences reach a run; a replaced one is kept as history (D23). */
  status: "suggested" | "confirmed" | "superseded";
  /** Typed in by the person, kept from a run's suggestion, or imported. */
  origin: "entered" | "suggested" | "imported";
  /** 1 when created, raised by every edit. */
  revision: number;
  updatedAt: string;
  confirmedAt: string | null;
  /** The preference this one replaced; for a replaced one, what replaced it and when. */
  supersedes: string | null;
  supersededBy: string | null;
  supersededAt: string | null;
  /** For one kept from a suggestion: the run, the suggestion's place, the HEAD it started at, when it ran, and the lines shown to the model. */
  evidence: { runId: string; suggestion: number; headAtStart: string | null; ranAt: string; citations: Array<{ path: string; startLine: number; endLine: number }> } | null;
}

export interface PreferencesView {
  /** Raised by every change to any preference; each run records the revision it was given. */
  revision: number;
  records: PreferenceView[];
}

/** How an export went (D23): saved, with how many preferences and the file's name (for display only), or cancelled. */
export type ExportResult = { status: "saved"; count: number; fileName: string } | { status: "cancelled" };

/** One preference in a file chosen for import: its wording and intent; its scope is the group it is listed under. */
export interface ImportEntryView {
  statement: string;
  intent: PreferenceIntent;
}

/**
 * One of the projects a file's preferences came from (D23), and where they could go: the local projects with the same
 * label, and the one suggested when the label is unambiguous (one match, and no other project in the file with the
 * same label). `sameLabel` and `position` tell two source projects with the same label apart.
 */
export interface ImportSourceView {
  /** The project's key in the file. */
  key: string;
  label: string;
  sameLabel: number;
  position: number;
  matches: Array<{ id: string; label: string }>;
  suggested: string | null;
  entries: ImportEntryView[];
}

export type ImportPreviewResult = { status: "preview"; previewId: string; personal: ImportEntryView[]; projects: ImportSourceView[] } | { status: "cancelled" };

export type AddProjectResult =
  | { status: "added"; project: ProjectView; warning: string | null }
  | { status: "cancelled" }
  | { status: "refused"; reason: string };

export interface SettingsView {
  /** How the saved key is actually kept: none, encrypted by the OS keychain, unencrypted, or unreadable here. */
  nebiusKey: "none" | "encrypted" | "unencrypted" | "unreadable";
  /** Whether a key saved now would be encrypted by the OS keychain. */
  keychain: "available" | "unavailable";
  /** What to tell the person about how their key is kept; null when there is nothing to say. */
  note: string | null;
  /** Whether a Nebius project id is saved, which Nebius Sandboxes needs with the key (D36). It is kept like the key. */
  nebiusProjectId: "none" | "set";
  /** Whether a Tavily API key is saved, which research needs (D37). It is kept like the Nebius key. */
  tavilyKey: "none" | "set";
  /** Whether research may send a plan version's approved queries to Tavily (D37): off until the person turns it on. */
  webResearch: boolean;
}

/** Whether the workspace (D26) could be opened; everything else works without it. */
export type WorkspaceView =
  | { state: "ready"; schemaVersion: number; sqlite: string; notice: string | null }
  | { state: "unavailable"; reason: string };

/** What a new conversation is about: nothing (general, no repository reaches it), or one project, fixed for good. */
export type ConversationScope = { kind: "general" } | { kind: "project"; projectId: string };

export interface ConversationSummary {
  id: string;
  kind: "general" | "project";
  projectId: string | null;
  /** The project's label when the conversation started, kept after the project is removed. */
  projectLabel: string | null;
  /** Whether its project is still in the list; null for a general conversation. */
  projectPresent: boolean | null;
  /** The engine its turns run on: `local` for a general conversation, else the project's (D17). */
  targetId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationsView {
  workspace: WorkspaceView;
  conversations: ConversationSummary[];
}

/**
 * A turn's state (D26). `not-sent` is claimed only when it is established that nothing reached an engine's store;
 * `unknown` when Nivra can't tell. Nothing is ever resent: sending again starts a new turn.
 */
export type TurnStatus = "submitting" | "running" | "answered" | "failed" | "cancelled" | "interrupted" | "not-sent" | "unknown";

export interface TurnView {
  id: string;
  status: TurnStatus;
  /** What happened, in Nivra's words, when it ended without an answer; null while it goes, and once answered. */
  note: string | null;
  /** Why its engine can't be reached to check it, while that lasts; it is checked again when the conversation opens. */
  unresolved: string | null;
  runId: string | null;
  cancelRequested: boolean;
  /** What the turn was given: how many preferences, and the history sent and left out (counts, never text). */
  given: { preferences: number; history: HistoryRecord | null };
  createdAt: string;
  settledAt: string | null;
}

export interface MessageView {
  id: string;
  seq: number;
  role: "person" | "assistant";
  text: string;
  /** An answer's whole reply: a general one's text, or a repository one's evidence, proposals and assumptions. */
  reply: ChatResult | null;
  turnId: string | null;
  createdAt: string;
}

export interface ConversationView {
  summary: ConversationSummary;
  messages: MessageView[];
  turns: TurnView[];
  /** The engine its turns run on. */
  engine: EngineView;
  /** Why it can't continue (its project was removed); null when it can. */
  closed: string | null;
  /** The review still going in this conversation, which holds it as a turn does (D31); null when none is. */
  openReview: string | null;
  /** The research still going in this conversation, which holds it as a turn does (D37); null when none is. */
  openResearch: string | null;
}

/** A task's states (D26). `active` and `review` can't be set by hand. */
export const TASK_STATES = ["draft", "ready", "active", "review", "completed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Where a brief came from: a version of a plan saved from a conversation's answer. */
export interface BriefSource {
  kind: "plan";
  planId: string;
  planLineage: string;
  planVersion: number;
  conversationId: string | null;
  messageId: string | null;
  /** The project of the conversation it came from; null for a general one. */
  projectId: string | null;
  /** For a repository answer: HEAD when its evidence was read. */
  headAtStart: string | null;
  /** The lines its evidence and proposals cited that were shown to the model. */
  citations: Array<{ path: string; startLine: number; endLine: number }>;
}

/**
 * An acceptance case (D39): a command, run in the sandbox, and the exact output and exit code it must give. A run's
 * verdict comes from these alone; repository checks are reported and never decide it.
 */
export interface AcceptanceCaseView {
  name: string;
  command: string;
  /** Exactly what the command must print, trailing newlines included. */
  expectedOutput: string;
  expectedExitCode: number;
}

/** What a task asks for, as one immutable version. A direct task and one made from a plan have the same shape. */
export interface BriefContent {
  goal: string;
  acceptanceCriteria: string[];
  scope: string;
  exclusions: string;
  context: string;
  assumptions: string[];
  /** The repository's own commands, which a run reports and which never decide its verdict (D39). */
  checks: string[];
  /** What a run is judged by (D39). A brief saved before them has none. */
  acceptanceCases: AcceptanceCaseView[];
  /**
   * Commands run once before the worker, on the commit as it is, with networking off, and what each must give there
   * (D41): its exit code, and its exact output or a pattern. A brief saved before them has none.
   */
  baseline: BaselineSelection[];
  /** Files the worker can't change: a run's result counts only when they are unchanged (D41). A brief saved before them has none. */
  frozen: string[];
  executionPolicy: { concurrency: 1; network: "off"; approval: "required" };
  sources: BriefSource[];
  /** Parts cleared because the task's repository changed: to write again for the new one. */
  revalidate: Array<"context" | "assumptions">;
}

/** The parts of a brief the person writes. Baseline checks and frozen files left out are none. */
export type BriefFields = Pick<BriefContent, "goal" | "acceptanceCriteria" | "scope" | "exclusions" | "context" | "assumptions" | "checks" | "acceptanceCases"> &
  Partial<Pick<BriefContent, "baseline" | "frozen">>;

export interface PlanView {
  id: string;
  lineageId: string;
  version: number;
  text: string;
  conversationId: string;
  messageId: string;
  /** The conversation's project, which a task made from this plan starts on; null for a general conversation. */
  projectId: string | null;
  /** What the answer it came from took as true without checking; a task made from it starts with them. */
  assumptions: string[];
  /** The latest version in its lineage. */
  latest: number;
  createdAt: string;
}

/** What a review of one saved plan version would send (D31), worked out from the records as they are now. Nothing is sent. */
export interface ReviewPreview {
  planId: string;
  planLineage: string;
  planVersion: number;
  /** The latest version in the plan's lineage. */
  latestVersion: number;
  panel: ReviewPanel;
  /** Where the plan came from: a general conversation, or a project's, with its engine and whether it allows sharing. */
  scope: { kind: "general" } | { kind: "project"; projectLabel: string; targetLabel: string; headAtStart: string | null; sharing: boolean };
  /** What the reviewers get: the plan's text, its assumptions and where its answer looked, counted; the preferences in full. */
  sends: { textChars: number; assumptions: number; references: number; preferences: Array<{ statement: string; scope: PreferenceScope; intent: PreferenceIntent }> };
  /** The most model calls it makes: two reviewers and a chair, or one reviewer. */
  requests: number;
  /** Why it can't start now (a turn or a review still going, or sharing off), in plain words; null when it can. */
  blocked: string | null;
  /** The fingerprint of what it would send: starting is refused when that changed since this preview. */
  expected: string;
}

/**
 * A review of a plan version (D31): what it was bound to, how its run went, and the report its engine saved, kept when
 * it ended. `not-sent` and `unknown` mean what they mean for a turn. Nothing is ever resent: reviewing again makes a new
 * review.
 */
export interface ReviewView {
  id: string;
  conversationId: string;
  planId: string;
  planLineage: string;
  planVersion: number;
  /** The latest version of its plan now, so a review of an older version can say so. */
  latestVersion: number;
  panel: ReviewPanel;
  status: TurnStatus;
  /** What happened, in Nivra's words, when it ended without a complete report; null while it goes, and once complete. */
  note: string | null;
  /** Why its engine can't be reached to check it, while that lasts. */
  unresolved: string | null;
  runId: string | null;
  cancelRequested: boolean;
  /** Where the plan came from, frozen when the review was asked for. */
  scope: { kind: "general" } | { kind: "project"; projectLabel: string | null; headAtStart: string | null };
  packetDigest: string;
  preferencesDigest: string;
  /** How many preferences it was sent. */
  given: { preferences: number };
  /** The packet's historical references, E1 first: where the answer the plan came from looked, never the lines. */
  references: Array<{ path: string; startLine: number; endLine: number }>;
  /** The engine's report, masked again; null while it goes, or when it ended without one. */
  report: ReviewReport | null;
  createdAt: string;
  settledAt: string | null;
}

export interface TaskSummary {
  id: string;
  title: string;
  state: TaskState;
  projectId: string | null;
  projectLabel: string | null;
  /** Whether its project is still in the list; null without one. */
  projectPresent: boolean | null;
  briefVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskView {
  summary: TaskSummary;
  revision: number;
  brief: { id: string; version: number; sha256: string; content: BriefContent; createdAt: string };
  versions: Array<{ id: string; version: number; createdAt: string }>;
  /** Each plan the brief came from: the version it used, and the latest there is (its id to update from), or that it was deleted. */
  sourcePlans: Array<{ planLineage: string; usedVersion: number; latestVersion: number | null; latestPlanId: string | null; conversationId: string | null }>;
  /** Its runs, oldest first, each bound to the brief version it ran. */
  attempts: Array<{
    id: string;
    briefVersion: number;
    status: TurnStatus;
    note: string | null;
    /** What became of it, as the workspace keeps it (D40): read without its engine. */
    outcome: TaskReport["outcome"] | null;
    verified: boolean;
    decision: AttemptDecision | null;
    /** Its apply's last known status, null while its engine hasn't said; and how the person settled it. */
    apply: { status: ApplyStatus | null; resolution: ApplyResolution | null } | null;
    acceptedAt: string | null;
    createdAt: string;
    settledAt: string | null;
  }>;
  /** Why Run can't be pressed now, in plain words; null when it can (the preview then says what it would send). */
  runBlocked: string | null;
}

/**
 * What a run of a task would send, and where, worked out from its brief and its repository's commit as they are now
 * (D39). Nothing is sent. `expected` binds a start to this preview: starting is refused when anything here changed.
 */
/**
 * A task run's bounds that no brief changes, as the engine enforces them (Settings › Budget and usage): the
 * brief-independent fields of TaskRunLimits, read by main from the domain's one source (TASK_RUN_BOUNDS). The ones a
 * brief changes, its Nebius operations and baseline checks, are in each run's preview.
 */
export type RunLimitsView = Pick<
  TaskRunLimits,
  "modelRequests" | "requestSeconds" | "outputTokensPerRequest" | "estimatedInputTokens" | "toolCalls" | "writes" | "runs" | "checkSeconds" | "sessionMinutes" | "runMinutes"
>;

export interface TaskRunPreview {
  taskId: string;
  briefVersion: number;
  /** The repository the task runs on, and its engine. */
  project: { label: string; targetLabel: string };
  /** What the commit's snapshot sends to Nebius; null when the preview stopped first (see `blocked`). */
  snapshot: SnapshotPreview | null;
  /** What goes to each service, in plain words, and what each keeps: Nebius's own terms come with the snapshot. */
  sends: { tokenFactory: string[]; nebius: string[] };
  keeps: { tokenFactory: string; nebius: string | null };
  cases: Array<AcceptanceCaseView & { number: number }>;
  checks: Array<{ number: number; command: string }>;
  /**
   * The brief's baseline checks (D41): each runs once before the worker, on the commit as it is, and the run stops there
   * when one doesn't give what the brief expects.
   */
  baseline: Array<BaselineSelection & { number: number }>;
  /** The brief's frozen files, with their SHA-256 in the commit once its engine has read them (null before). */
  frozen: Array<{ path: string; sha256: string | null }>;
  /** The prepared environment the run starts from, as its engine checked it against the commit's setup files (NIV-55); null without one. */
  environment: EnvironmentRef | null;
  /** The programs the run looks for before the model starts, and how many commands start with something it can't read. */
  programs: string[];
  unprobed: number;
  /**
   * The commit's files each acceptance case runs: the worker can change them, and a case judges only what it prints.
   * `unclear` when Nivra can't read for sure which files a case's command runs.
   */
  caseFiles: Array<{ number: number; files: string[]; unclear: boolean }>;
  /** The bounds the engine holds the run to; null when the preview stopped first. */
  limits: TaskRunLimits | null;
  /** The project's two consents, as they are now: both are needed. */
  consents: { modelContext: boolean; cloudExecution: boolean };
  /** Why it can't start now, in plain words; null when it can. */
  blocked: string | null;
  expected: string;
  /** The snapshot's own fingerprint, which the engine checks again before uploading; null with no snapshot. */
  snapshotFingerprint: string | null;
}

/**
 * One run of a task (D39): how it went, and, read from its engine when it can be, the engine's report and its change.
 * `not-sent` and `unknown` mean what they mean for a turn. Nothing is ever resent: running again makes a new attempt.
 */
/** How the person decided on an attempt's proposal (D40): approved (the apply request itself), rejected, or a revision asked. */
export type AttemptDecision = "approved" | "rejected" | "revision";

/** What the person may do with an attempt now; the window offers exactly these. */
export type AttemptAction = "approve" | "reject" | "revise" | "accept" | "dismiss" | "restore" | "keep";

/**
 * An attempt's apply (D40), as the host keeps it and its engine reports it. The request id is saved before the apply
 * is sent, so after a restart the host asks the engine for it and never sends it again.
 */
export interface TaskApplyView {
  requestId: string;
  /** Null until the engine has answered, or while it can't be read. */
  status: ApplyStatus | null;
  /** For a refused apply: its code, Nivra's words, and the proposal's path it names. */
  refusal: { code: ApplyRefusalCode; message: string; path: string | null } | null;
  /** Every path the change writes, and where it is now. */
  paths: ApplyPath[];
  /** Folders Nivra created that are still there. */
  folders: string[];
  /** Where Nivra keeps the originals it moved aside: a folder inside the repository's git folder. */
  recovery: string | null;
  /** What stopped the write, by its step and the error's code. */
  failure: { step: string; code: string | null } | null;
  resolution: ApplyResolution | null;
  /** Why it can't be read now (its engine offline, or another engine's records), while that lasts. */
  unresolved: string | null;
}

export interface TaskAttemptView {
  id: string;
  taskId: string;
  briefVersion: number;
  status: TurnStatus;
  /** What happened, in Nivra's words, when it ended without a report of its run; null while it goes. */
  note: string | null;
  runId: string | null;
  cancelRequested: boolean;
  /** The engine's report: what the worker did, each case's and check's verdict, cleanup's record; null until there is one. */
  report: TaskReport | null;
  /** The change it proposes, as text to read; null when it proposed none, or can't be read now. */
  proposal: TaskProposal | null;
  /** The run's latest progress, oldest first. */
  progress: string[];
  /** Why its engine can't be read now, while that lasts. */
  unresolved: string | null;
  /** The person's decision on its proposal, and when; a revision's note. */
  decision: AttemptDecision | null;
  decidedAt: string | null;
  revisionNote: string | null;
  /** Its apply, once approved. */
  apply: TaskApplyView | null;
  /** When the person accepted the applied change: only that completes the task, and only when it hasn't moved on. */
  acceptedAt: string | null;
  /** Why accepting didn't complete the task: its brief or its repository changed after this run. */
  acceptNote: string | null;
  /** What the person may do now. */
  actions: AttemptAction[];
  createdAt: string;
  settledAt: string | null;
}

/** The workspace's state and every task, the most recently changed first; none while the workspace can't be used. */
export interface TasksView {
  workspace: WorkspaceView;
  tasks: TaskSummary[];
}

/** A mission in the list (NIV-52): its latest version's name, how many tasks its backlog holds, and whether a review of it is going. */
export interface MissionSummary {
  id: string;
  name: string;
  version: number;
  tasks: number;
  updatedAt: string;
  reviewing: boolean;
}

export interface MissionsView {
  workspace: WorkspaceView;
  missions: MissionSummary[];
}

/** A task in a mission's backlog, as the mission's page and its board show it. */
export interface MissionTaskView {
  task: TaskSummary;
  /** Why it can't be selected for a review, in plain words; null when it can. */
  unreviewable: string | null;
}

/** A specialist as the window shows it: who it is, which version of its instructions, and what it looks at. */
export interface SpecialistView {
  id: SpecialistId;
  version: number;
  name: string;
  personality: string;
  purpose: string;
}

/** A mission's task as a review was sent it: its reference there, and whether it is still here to open. */
export interface ReviewedTaskView {
  ref: string;
  taskId: string;
  title: string;
  briefVersion: number;
  present: boolean;
}

/**
 * A review of a mission's selected tasks (NIV-52): a review of the plan Nivra wrote from them (D31's lifecycle), with
 * what it was sent, and what has changed since.
 */
export interface MissionReviewView extends ReviewView {
  /** The mission's version it was sent; null when Nivra can't read what it was sent. */
  missionVersion: number | null;
  tasks: ReviewedTaskView[];
  specialists: SpecialistView[];
  /** The only model it could use, or null for the listing's Nemotron pick (D22). */
  model: string | null;
  /** Exactly what the reviewers read about the mission and its tasks. */
  text: string;
  /** What changed since it was sent, one line each; empty when nothing has. A stale review stays as it was. */
  stale: string[];
  /** Whether the preferences it was sent have changed since: shown, never blocking. */
  preferencesChanged: boolean;
}

/** One mission: its latest version, its backlog, the tasks it could take, and its reviews, newest first. */
export interface MissionView {
  id: string;
  latest: { id: string; version: number; content: MissionContent; createdAt: string };
  versions: Array<{ version: number; createdAt: string }>;
  backlog: MissionTaskView[];
  /** Tasks in no mission's backlog, which this one can take. */
  available: TaskSummary[];
  reviews: MissionReviewView[];
  /** Whether a review of it is going. */
  reviewing: boolean;
  engine: EngineView;
}

/** What a review of a mission's selected tasks would send (NIV-52), worked out from the records as they are now. Nothing is sent. */
export interface MissionReviewPreview {
  missionId: string;
  missionVersion: number;
  tasks: ReviewedTaskView[];
  /** Exactly what the reviewers read about the mission and its tasks, and its length. */
  text: string;
  chars: number;
  othersInBacklog: number;
  preferences: Array<{ statement: string; scope: PreferenceScope; intent: PreferenceIntent }>;
  specialists: SpecialistView[];
  model: string | null;
  /** The most model calls it makes: two reviewers, then the chair. */
  requests: number;
  notSent: readonly string[];
  /** Why it can't start now, in plain words; null when it can. */
  blocked: string | null;
  /** The fingerprint of what it would send: starting is refused when that changed since this preview. */
  expected: string;
}

export interface NivraApi {
  getAppInfo(): Promise<AppInfo>;
  /**
   * Puts text a person asked to copy on the clipboard, for the window's copy buttons: the window itself has no clipboard
   * access (every permission is refused), so main writes it. Text of at most COPY_TEXT_CHARS characters; anything else is
   * refused, saying so, and nothing is copied.
   */
  copyText(text: string): Promise<void>;
  /**
   * Whether a draft's text holds one of the API keys Nivra keeps, whole, anywhere in it: true or false, and nothing
   * else (no key, no fragment, no place). Text of at most DRAFT_CHECK_CHARS characters; anything else is refused. It
   * fails when a saved key can't be read: the window then treats the draft as unchecked, never as clean.
   */
  draftHasSavedKey(text: string): Promise<boolean>;
  /** One view per engine a project uses or that is running; nothing is started by asking. */
  listEngines(): Promise<EngineView[]>;
  /** Starts the engine of the project's folder if it isn't running yet, never another one (D17). */
  openProject(projectId: string): Promise<EngineView>;
  restartEngine(projectId: string): Promise<void>;
  runDoctor(projectId: string): Promise<DoctorReport>;
  getWsl(): Promise<WslView | null>;
  /** Looks for WSL distributions again (after the person installed or fixed one). */
  checkWsl(): Promise<WslView | null>;
  listProjects(): Promise<ProjectView[]>;
  addProject(): Promise<AddProjectResult>;
  /** Removes the folder from the list, with its own preferences; says how many of those went with it. */
  removeProject(projectId: string): Promise<{ preferencesRemoved: number }>;
  listPreferences(): Promise<PreferencesView>;
  /**
   * Saves a preference the person typed and confirmed. A project preference names its project; a personal one, null.
   * Only a project's own preference can be a decision to change its conventions (`override`).
   */
  addPreference(statement: string, scope: PreferenceScope, projectId: string | null, intent: PreferenceIntent): Promise<PreferenceView>;
  /** Fixes a preference's wording, or whether a project's own preference is a default or a decision. */
  editPreference(id: string, statement: string, intent: PreferenceIntent): Promise<PreferenceView>;
  deletePreference(id: string): Promise<void>;
  /** Replaces a preference with a new decision; the old one is kept as history, and no run gets it again (D23). */
  supersedePreference(id: string, statement: string, intent: PreferenceIntent): Promise<PreferenceView>;
  /** Keeps a suggestion from one of the project's explanations this session as its own default, in the person's wording (D23). */
  keepSuggestion(projectId: string, runId: string, index: number, statement: string): Promise<PreferenceView>;
  /**
   * Exports the confirmed preferences in the scopes chosen (personal, and each chosen project's own) to a file the person
   * picks in the native dialog: no ids, no evidence, never a saved key (D23).
   */
  exportPreferences(scopes: { personal: boolean; projectIds: string[] }): Promise<ExportResult>;
  /** Asks for an export file in the native dialog, and says what importing it would do; nothing is saved yet. */
  previewImport(): Promise<ImportPreviewResult>;
  /**
   * Imports a previewed file as the person chose: whether its personal preferences come in, and for each of its source
   * projects, by key, the local project its preferences go to, or null to leave them out.
   */
  importPreferences(previewId: string, choice: { personal: boolean; projects: Array<{ source: string; project: string | null }> }): Promise<{ added: number; alreadyHere: number; leftOut: number }>;
  /** Runs hello on the project's engine, with a snapshot of the preferences that apply to the project (D21). */
  startHello(projectId: string, holdMs: number): Promise<RunSummary>;
  /** Allows or stops sending the project's content to Token Factory (D20); stopping cancels its explain runs. */
  setSharing(projectId: string, modelContext: boolean): Promise<ProjectView>;
  /**
   * Allows or stops uploading the project's commit to Nebius Sandboxes (D36), on its own: model-context consent never
   * stands in for it. Stopping cancels the project's sandbox check, its task run and its environment's preparation
   * (D41), and its notice says what Nebius keeps.
   */
  setCloudExecution(projectId: string, cloudExecution: boolean): Promise<ProjectView>;
  /** What a sandbox check of the project would send, from its own engine with no network. Nothing is uploaded. */
  previewSandboxCheck(projectId: string): Promise<SandboxPreview>;
  /** Starts the check previewed; refused when uploads aren't allowed, or when what it would send changed since (`expected`). */
  startSandboxCheck(projectId: string, expected: string): Promise<SandboxCheckView>;
  /** Stops the project's sandbox check; what it uploaded stays with Nebius. */
  cancelSandboxCheck(projectId: string): Promise<SandboxCheckView>;
  /** The project's sandbox check this session, as it is now; null when none was started. */
  getSandboxCheck(projectId: string): Promise<SandboxCheckView | null>;
  /** What the project's engine has left open in Nebius from earlier sessions, and its recovery pass. */
  getSandboxStatus(projectId: string): Promise<SandboxStatus>;
  /** The project's environment (D41, NIV-55): the choices made, what its task runs start from and whether it is ready, and its latest preparation. */
  getEnvironment(projectId: string): Promise<EnvironmentView>;
  /**
   * The project's own setup resolved into a recipe with these choices (NIV-55), from its own engine with no network:
   * refused, waiting for a choice, or ready with what preparing it would send and run. Nothing is stored.
   */
  resolveEnvironment(projectId: string, choices: EnvironmentChoices): Promise<EnvironmentPreviewV2>;
  /**
   * Prepares the environment previewed (D41, NIV-55); refused when uploads are off, the key or project id is missing, on
   * Windows itself, or when what it would send changed since the preview (`expected`).
   */
  prepareEnvironment(projectId: string, choices: EnvironmentChoices, expected: string): Promise<EnvironmentView>;
  /** Accepts the environment without the dependency builds its preparation didn't run, for the verified record shown (`verified`). */
  acceptMissingBuilds(projectId: string, verified: string): Promise<EnvironmentView>;
  /** Stops the project's preparation; what it uploaded stays with Nebius. */
  cancelPreparation(projectId: string): Promise<EnvironmentView>;
  /**
   * Explains the project's repository with evidence (NIV-6); refused while sharing is off. An empty question means the
   * default. `choices` are this task's explicit decisions, up to five: they outrank everything for this run only and
   * are never saved (D23).
   */
  startExplain(projectId: string, question: string, choices: string[]): Promise<RunSummary>;
  /** An explain run's summary and stored result, from the engine that ran it. */
  runResult(runId: string): Promise<{ summary: RunSummary; result: ExplainResult | null }>;
  /** A run's events after a cursor, from the engine that runs it (main remembers which). */
  runEvents(runId: string, after: number): Promise<RunEventsPage>;
  cancelRun(runId: string): Promise<{ status: RunStatus; wasTerminal: boolean }>;
  getSettings(): Promise<SettingsView>;
  setNebiusKey(key: string | null): Promise<SettingsView>;
  /** Saves the Nebius project id that Nebius Sandboxes needs with the key, kept like the key (D8, D36); null removes it. */
  setNebiusProjectId(projectId: string | null): Promise<SettingsView>;
  /** Saves the Tavily API key research needs, kept like the Nebius key (D8, D37); null removes it. */
  setTavilyKey(key: string | null): Promise<SettingsView>;
  /** Allows or stops research's queries to Tavily, for the whole app (D37); stopping stops research under way. */
  setWebResearch(on: boolean): Promise<SettingsView>;
  /** Token Factory from the project's engine: its NVIDIA models and one Nemotron tool call (B7). */
  checkTokenFactory(projectId: string): Promise<ProviderCheck>;
  /** The workspace's state and every conversation, the most recently active first. Reading starts no engine. */
  listConversations(): Promise<ConversationsView>;
  /** Starts a conversation, general or about one project; its scope never changes afterwards. Starts no engine. */
  createConversation(scope: ConversationScope): Promise<ConversationSummary>;
  /** One conversation as it is now. Reading starts no engine and asks none. */
  getConversation(conversationId: string): Promise<ConversationView>;
  /** Opens a conversation: a turn left open is followed on its own engine, which starts if needed. Nothing is resent. */
  openConversation(conversationId: string): Promise<ConversationView>;
  /** Sends a message as a new turn. Refused at once, with nothing stored, when it can't go; the answer comes later. */
  sendMessage(conversationId: string, text: string): Promise<ConversationView>;
  /** Stops a turn that is being sent or is running; its end is recorded as cancelled by the person. */
  cancelTurn(conversationId: string, turnId: string): Promise<ConversationView>;
  /** Deletes a conversation with its turns, messages and plans; its open turn is stopped first. */
  deleteConversation(conversationId: string): Promise<void>;
  /** Restarts the engine a conversation's turns run on (a general one has no project to restart it from). */
  restartConversationEngine(conversationId: string): Promise<ConversationView>;
  /** Saves an answer as plan v1 of a new lineage; null text keeps the answer's own. */
  savePlan(conversationId: string, messageId: string, text: string | null): Promise<PlanView>;
  /** Saves an edit of a plan as its next version; earlier versions, and briefs made from them, stay as they are. */
  revisePlan(planId: string, text: string): Promise<PlanView>;
  /** A conversation's plans, every version, oldest first. */
  listPlans(conversationId: string): Promise<PlanView[]>;
  /** What a review of this plan version would send, with its fingerprint. Reads only: nothing is stored or sent. */
  prepareReview(planId: string, panel: ReviewPanel): Promise<ReviewPreview>;
  /** Starts the review previewed; refused when what it would send changed since (`expected` is the preview's fingerprint). */
  startReview(planId: string, panel: ReviewPanel, expected: string): Promise<ReviewView>;
  /** A conversation's reviews, oldest first. Reading starts no engine and asks none. */
  listReviews(conversationId: string): Promise<ReviewView[]>;
  /** What research of this plan version's assumptions would send, with its fingerprint. Reads only: nothing is stored or sent. */
  prepareResearch(planId: string, selection: ResearchSelection): Promise<ResearchPreview>;
  /** Starts the research previewed; refused when what it would send changed since (`expected` is the preview's fingerprint). */
  startResearch(planId: string, selection: ResearchSelection, expected: string): Promise<ResearchView>;
  /** A conversation's research, oldest first. Reading starts no engine and asks none. */
  listResearch(conversationId: string): Promise<ResearchView[]>;
  /** Stops research that is being sent or is running; its end is recorded as cancelled by the person. */
  cancelResearch(conversationId: string, researchId: string): Promise<ResearchView[]>;
  /** Saves the version amended from research as the plan's next version, once, while the researched version is the latest. */
  saveAmendedPlan(researchId: string, text: string, assumptions: string[]): Promise<PlanView>;
  /** Stops a review being sent or running; its end is recorded as cancelled by the person. */
  cancelReview(conversationId: string, reviewId: string): Promise<ReviewView[]>;
  listTasks(): Promise<TasksView>;
  getTask(taskId: string): Promise<TaskView>;
  /** Creates a task and its brief v1, written directly or from a plan version; either way the brief has the same shape. */
  createTask(input: { title: string; fields: BriefFields; projectId: string | null; planId: string | null }): Promise<TaskView>;
  /** Saves a brief edit as its next version, from the task's revision as read. */
  reviseBrief(taskId: string, revision: number, fields: BriefFields): Promise<TaskView>;
  /** Takes a newer version of the plan a brief came from into its next version. */
  refreshBriefFromPlan(taskId: string, revision: number, planId: string): Promise<TaskView>;
  /** Sets the repository a task will run on, or none; what came from another project's conversation is cleared. */
  setTaskProject(taskId: string, revision: number, projectId: string | null): Promise<TaskView>;
  /** Moves a task to the state asked for, when its brief allows it. */
  setTaskState(taskId: string, revision: number, state: TaskState): Promise<TaskView>;
  renameTask(taskId: string, revision: number, title: string): Promise<TaskView>;
  /** Deletes a task with its brief versions and runs; refused while a run of it goes. */
  deleteTask(taskId: string): Promise<void>;
  /** What a run of the task would send, and where, with its fingerprint. Nothing is sent or stored. */
  /** A task run's bounds that no brief changes, from the domain's one source; nothing is asked of an engine. */
  getRunLimits(): Promise<RunLimitsView>;
  previewTaskRun(taskId: string): Promise<TaskRunPreview>;
  /** Starts the run previewed; refused when anything it would send changed since (`expected`, `snapshot`). */
  startTaskRun(taskId: string, expected: string, snapshot: string): Promise<TaskAttemptView>;
  /** Stops a run being sent or going; its end is recorded as cancelled by the person. What it uploaded stays with Nebius. */
  cancelTaskRun(taskId: string, attemptId: string): Promise<TaskAttemptView>;
  /** One run of a task as it is now, read from its engine when that is online. */
  getTaskAttempt(taskId: string, attemptId: string): Promise<TaskAttemptView>;
  /**
   * Approves the attempt's proposal by the hash the person saw and applies it on its engine (D40): offered only when
   * every acceptance case passed. The request id is saved before it is sent.
   */
  approveTaskChange(taskId: string, attemptId: string, approvedHash: string): Promise<TaskAttemptView>;
  /** Rejects the proposal: nothing is sent, and the checkout is untouched. */
  rejectTaskChange(taskId: string, attemptId: string): Promise<TaskAttemptView>;
  /** Asks for a revision: the note goes into a new brief version, and the next attempt starts when the person runs it. */
  requestTaskRevision(taskId: string, attemptId: string, note: string): Promise<TaskAttemptView>;
  /** Settles the apply: accepts an applied change (completing the task), dismisses one not applied, or keeps a partial one. */
  settleTaskChange(taskId: string, attemptId: string, as: ApplyResolution): Promise<TaskAttemptView>;
  /** Takes a partial apply back to the originals, never overwriting a version another program saved. */
  restoreTaskChange(taskId: string, attemptId: string): Promise<TaskAttemptView>;
  /** Every mission, the most recently changed first (NIV-52). */
  listMissions(): Promise<MissionsView>;
  /** One mission as it is now: its latest version, backlog, the tasks it could take, and its reviews. */
  getMission(missionId: string): Promise<MissionView>;
  /** Opens a mission: a review left open by an earlier session is followed on its engine, never resent. */
  openMission(missionId: string): Promise<MissionView>;
  /** Saves a new mission as v1; needs a name and an outcome. */
  createMission(content: MissionContent): Promise<MissionView>;
  /** Saves an edit as the mission's next version, only from the version the person read. */
  reviseMission(missionId: string, version: number, content: MissionContent): Promise<MissionView>;
  /** Deletes a mission with its versions, backlog and reviews; its tasks stay, in no mission. */
  deleteMission(missionId: string): Promise<void>;
  /** Makes a direct task with a title only, in the mission's backlog. */
  createMissionTask(missionId: string, title: string): Promise<MissionView>;
  /** Puts an existing task in the mission's backlog; the task itself doesn't change. */
  addMissionTask(missionId: string, taskId: string): Promise<MissionView>;
  /** Takes a task out of the mission's backlog; the task itself doesn't change. */
  removeMissionTask(missionId: string, taskId: string): Promise<MissionView>;
  /** What a review of the selected tasks would send, exactly, with its fingerprint. Nothing is sent or stored. */
  prepareMissionReview(missionId: string, taskIds: string[]): Promise<MissionReviewPreview>;
  /** Starts the review previewed; refused when anything it would send changed since (`expected`). */
  startMissionReview(missionId: string, taskIds: string[], expected: string): Promise<MissionView>;
  /** Stops a mission's review the person no longer wants. */
  cancelMissionReview(missionId: string, reviewId: string): Promise<MissionView>;
  /** What asking the coach about the task would send (NIV-53), with the mission and findings ticked; nothing is sent. */
  prepareCoach(taskId: string, selection: CoachSelection): Promise<CoachPreview>;
  /** Asks the coach, bound to the preview the person saw: refused when what it would send changed since. */
  startCoach(taskId: string, selection: CoachSelection, expected: string): Promise<CoachingView>;
  /** The task's coachings, the newest first; one left open is followed on its own engine, and nothing is resent. */
  listCoachings(taskId: string): Promise<CoachingView[]>;
  cancelCoach(taskId: string, coachingId: string): Promise<void>;
  /** Saves the ticked changes as the brief's next version, from the task's revision as it was read; a stale answer is refused. */
  acceptCoachChanges(taskId: string, revision: number, coachingId: string, fields: CoachField[]): Promise<TaskView>;
  /** The person's monthly budget policy (NIV-66), or null before they chose one. */
  getBudgetPolicy(): Promise<BudgetPolicy | null>;
  /** Saves a monthly budget as the next policy version, or with null turns it off. What was already spent or reserved stays as it was. */
  setBudgetPolicy(draft: BudgetPolicyDraft | null): Promise<BudgetSummary>;
  /** This month's budget as Nivra counts it, with every reason its totals can't be read as complete. */
  budgetSummary(): Promise<BudgetSummary>;
  /** The price list Nivra counts with, and what about it isn't established yet. */
  budgetPrices(): Promise<PriceCatalogue>;
  /** Confirms the new budget month the summary showed by this computer's clock (its label, such as 2026-11), when the provider's clock hasn't shown it yet. */
  confirmBudgetMonth(month: string): Promise<BudgetSummary>;
  /** Starts a new budget history after a loss, with what is left of this month (money in micro-units, and each counted service), or null to wait for next month. */
  startNewBudgetHistory(remaining: BudgetRemaining | null): Promise<BudgetSummary>;
}
