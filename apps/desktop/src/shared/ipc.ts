import type {
  ChatResult,
  DoctorReport,
  EngineInfo,
  ExplainResult,
  HistoryRecord,
  PreferenceIntent,
  PreferenceScope,
  ProviderCheck,
  ReviewPanel,
  ReviewReport,
  RunEventsPage,
  RunStatus,
  RunSummary,
} from "@nivra/domain";

/**
 * The renderer's whole view of the app: named, typed calls on `window.nivra`, each an `ipcRenderer.invoke` (AGENTS.md,
 * Electron security rules). Every new call is added here first. The renderer imports domain types only (zod at
 * runtime would trip the CSP), and it never sends a filesystem path: folders come from the native picker in main (D1).
 * There is no target to choose: each project's folder decides which engine it uses (D17), so calls name a project.
 */

export const IPC = {
  getAppInfo: "app:info",
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
  listTasks: "tasks:list",
  getTask: "tasks:get",
  createTask: "tasks:create",
  reviseBrief: "tasks:revise-brief",
  refreshBriefFromPlan: "tasks:refresh-brief",
  setTaskProject: "tasks:project",
  setTaskState: "tasks:state",
  renameTask: "tasks:rename",
  deleteTask: "tasks:delete",
} as const;

/** The longest message a conversation's turn carries (D26): `CHAT_LIMITS.messageChars`, which a test keeps equal. */
export const MESSAGE_CHARS = 8_000;

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
  /** What the project allows to leave the machine (D20): off until the person agrees. */
  sharing: { modelContext: boolean };
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
}

/** A task's states (D26). `active` and `review` come only from attempts, which can't start yet. */
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

/** What a task asks for, as one immutable version. A direct task and one made from a plan have the same shape. */
export interface BriefContent {
  goal: string;
  acceptanceCriteria: string[];
  scope: string;
  exclusions: string;
  context: string;
  assumptions: string[];
  checks: string[];
  executionPolicy: { concurrency: 1; network: "off"; approval: "required" };
  sources: BriefSource[];
  /** Parts cleared because the task's repository changed: to write again for the new one. */
  revalidate: Array<"context" | "assumptions">;
}

/** The parts of a brief the person writes. */
export type BriefFields = Pick<BriefContent, "goal" | "acceptanceCriteria" | "scope" | "exclusions" | "context" | "assumptions" | "checks">;

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
  attempts: Array<{ id: string; briefVersion: number; status: TurnStatus; createdAt: string }>;
  /** Why the task can't run, in plain words; running tasks isn't available yet. */
  runUnavailable: string;
}

/** The workspace's state and every task, the most recently changed first; none while the workspace can't be used. */
export interface TasksView {
  workspace: WorkspaceView;
  tasks: TaskSummary[];
}

export interface NivraApi {
  getAppInfo(): Promise<AppInfo>;
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
  deleteTask(taskId: string): Promise<void>;
}
