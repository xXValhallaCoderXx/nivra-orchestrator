import type { DoctorReport, EngineInfo, ProviderCheck, RunEventsPage, RunStatus, RunSummary } from "@nivra/domain";

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
  startHello: "runs:hello",
  runEvents: "runs:events",
  cancelRun: "runs:cancel",
  getSettings: "settings:get",
  setNebiusKey: "settings:nebius-key",
  checkTokenFactory: "providers:check",
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
}

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
  removeProject(projectId: string): Promise<void>;
  startHello(projectId: string, holdMs: number): Promise<RunSummary>;
  /** A run's events after a cursor, from the engine that runs it (main remembers which). */
  runEvents(runId: string, after: number): Promise<RunEventsPage>;
  cancelRun(runId: string): Promise<{ status: RunStatus; wasTerminal: boolean }>;
  getSettings(): Promise<SettingsView>;
  setNebiusKey(key: string | null): Promise<SettingsView>;
  /** Token Factory from the project's engine: its NVIDIA models and one Nemotron tool call (B7). */
  checkTokenFactory(projectId: string): Promise<ProviderCheck>;
}
