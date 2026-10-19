import type { ChatResult, DoctorReport, EngineInfo, ExplainResult, HistoryRecord, PreferenceIntent, PreferenceScope, ProviderCheck, RunEventsPage, RunStatus, RunSummary } from "@nivra/domain";

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
} as const;

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
}
