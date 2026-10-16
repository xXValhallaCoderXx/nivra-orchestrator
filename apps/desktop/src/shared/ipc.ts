import type { DoctorReport, EngineInfo, ProviderCheck, RunEventsPage, RunList, RunStatus, RunSummary } from "@nivra/domain";

/**
 * The renderer's whole view of the app: named, typed calls on `window.nivra`, each an `ipcRenderer.invoke` (AGENTS.md,
 * Electron security rules). Every new call is added here first. The renderer imports domain types only (zod at
 * runtime would trip the CSP), and it never sends a filesystem path: folders come from the native picker in main (D1).
 */

export const IPC = {
  getAppInfo: "app:info",
  listTargets: "targets:list",
  selectTarget: "targets:select",
  engineStatus: "engine:status",
  restartEngine: "engine:restart",
  runDoctor: "engine:doctor",
  listProjects: "projects:list",
  addProject: "projects:add",
  removeProject: "projects:remove",
  startHello: "runs:hello",
  listRuns: "runs:list",
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

export interface TargetView {
  id: string;
  kind: "local" | "wsl";
  /** "Ubuntu · WSL", "Windows · Local", … (D1). */
  label: string;
  platform: string;
}

export interface TargetsView {
  targets: TargetView[];
  selectedId: string;
  /** What WSL discovery found; null off Windows. `message` says what to do when WSL cannot be used. */
  wsl: { status: "ready" | "missing" | "inbox-only" | "broken"; message: string | null } | null;
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
  targetId: string;
  label: string;
  /** For display only: the renderer never sends a path back. */
  displayPath: string;
}

export type AddProjectResult =
  | { status: "added"; project: ProjectView; warning: string | null }
  | { status: "cancelled" }
  | { status: "refused"; reason: string };

export interface SettingsView {
  nebiusKey: { set: boolean };
  /** How keys are kept on this machine: "encrypted" by the OS keychain, or "unencrypted" where none is available. */
  keyStorage: "encrypted" | "unencrypted";
  keyStorageNote: string | null;
}

export interface NivraApi {
  getAppInfo(): Promise<AppInfo>;
  listTargets(): Promise<TargetsView>;
  selectTarget(targetId: string): Promise<void>;
  engineStatus(): Promise<EngineView>;
  restartEngine(): Promise<void>;
  runDoctor(): Promise<DoctorReport>;
  listProjects(): Promise<ProjectView[]>;
  addProject(): Promise<AddProjectResult>;
  removeProject(projectId: string): Promise<void>;
  startHello(projectId: string, holdMs: number): Promise<RunSummary>;
  listRuns(): Promise<RunList>;
  runEvents(runId: string, after: number): Promise<RunEventsPage>;
  cancelRun(runId: string): Promise<{ status: RunStatus; wasTerminal: boolean }>;
  getSettings(): Promise<SettingsView>;
  setNebiusKey(key: string | null): Promise<SettingsView>;
  /** Token Factory from the current target's engine: its NVIDIA models and one Nemotron tool call (B7). */
  checkTokenFactory(): Promise<ProviderCheck>;
}
