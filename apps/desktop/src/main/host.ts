import { randomUUID } from "node:crypto";
import type { DoctorReport, ProviderCheck, RunEventsPage, RunList, RunStatus, RunSummary, SecretName } from "@nivra/domain";
import type { AddProjectResult, EngineView, ProjectView, TargetsView } from "../shared/ipc.ts";
import type { HostStore, ProjectRecord } from "./host-store.ts";
import { folderLabel, uncHome, windowsPickProblem, wslPick } from "./paths.ts";
import { EngineSupervisor } from "./supervisor.ts";
import { listTargets, type TargetList, type TargetSources } from "./targets/registry.ts";
import type { ExecutionTarget } from "./targets/types.ts";
import { WslTarget } from "./targets/wsl.ts";

export interface HostOptions {
  sources: TargetSources;
  store: HostStore;
  logsDir: string;
  client: { name: string; version: string };
  credentials: () => Promise<Partial<Record<SecretName, string>>>;
  /** The host's own OS, which decides how a picked folder is read. */
  platform: NodeJS.Platform;
  log: (line: string) => void;
}

const SLOW_DRIVE =
  "This folder is on a Windows drive, which is slow from WSL: git and builds will run noticeably slower. For speed, keep the repository inside the distribution.";

/**
 * The host's core (D1, D7), without Electron: the targets this machine offers, one engine at a time on the chosen one,
 * the project registry, and the calls the window makes. Electron's main process is a thin shell over it (D12), so the
 * window, dialogs and IPC are all it adds.
 */
export class Host {
  readonly #options: HostOptions;
  #list: TargetList | null = null;
  #target: ExecutionTarget | null = null;
  #supervisor: EngineSupervisor | null = null;
  #warnings: string[] = [];
  #home: string | null = null;

  constructor(options: HostOptions) {
    this.#options = options;
  }

  /** Finds the targets and starts the engine on the chosen one (or the preferred one). */
  async init(): Promise<void> {
    this.#list = await listTargets(this.#options.sources);
    const saved = this.#options.store.data.selectedTargetId;
    const id = saved && this.#list.targets.some((t) => t.descriptor.id === saved) ? saved : this.#list.preferred;
    this.#activate(id);
  }

  targets(): TargetsView {
    const list = this.#requireList();
    const wsl = list.wsl ? { status: list.wsl.status, message: list.wsl.status === "ready" ? null : list.wsl.message } : null;
    return {
      targets: list.targets.map((t) => ({ id: t.descriptor.id, kind: t.descriptor.kind, label: t.descriptor.label, platform: t.descriptor.platform })),
      selectedId: this.#requireTarget().descriptor.id,
      wsl,
    };
  }

  /** Switches the engine to another target: the old one stops, the new one starts (one engine at a time). */
  async select(targetId: string): Promise<void> {
    if (this.#target?.descriptor.id === targetId) return;
    if (!this.#requireList().targets.some((t) => t.descriptor.id === targetId)) throw new Error(`There is no target ${targetId} on this machine.`);
    this.#options.store.update((data) => ({ ...data, selectedTargetId: targetId }));
    const previous = this.#supervisor;
    this.#activate(targetId);
    await previous?.stop();
  }

  engine(): EngineView {
    const target = this.#requireTarget();
    return { targetId: target.descriptor.id, label: target.descriptor.label, state: this.#requireSupervisor().state, warnings: this.#warnings };
  }

  /** Restarts the engine; a failure shows in the engine's state rather than here. */
  async restart(): Promise<void> {
    await this.#requireSupervisor().restart().catch(() => undefined);
    void this.#refreshWarnings();
  }

  doctor(): Promise<DoctorReport> {
    return this.#requireSupervisor().call("doctor", {});
  }

  checkTokenFactory(): Promise<ProviderCheck> {
    return this.#requireSupervisor().call("providers.check", {}, { timeoutMs: 180_000 });
  }

  projects(): ProjectView[] {
    const targetId = this.#requireTarget().descriptor.id;
    return this.#options.store.data.projects.filter((p) => p.targetId === targetId).map(view);
  }

  /** Where the folder picker should open: the distribution's home for a WSL target. */
  pickerDefault(): string | undefined {
    const target = this.#requireTarget();
    return target instanceof WslTarget && this.#home ? uncHome(target.descriptor.distro!, this.#home) : undefined;
  }

  /** Records a folder picked in the native dialog for the current target, converting its path once, here (D1). */
  async addPicked(picked: string): Promise<AddProjectResult> {
    const target = this.#requireTarget();
    let nativePath: string;
    let warning: string | null = null;
    if (target instanceof WslTarget) {
      const pick = wslPick(picked, target.descriptor.distro!);
      if (pick.kind === "refused") return { status: "refused", reason: pick.reason };
      if (pick.kind === "drive") {
        const linux = await target.toLinuxPath(pick.windowsPath);
        if (!linux) return { status: "refused", reason: `${target.descriptor.label} couldn't find ${pick.windowsPath}. Check the drive is mounted in WSL.` };
        nativePath = linux;
        warning = SLOW_DRIVE;
      } else {
        nativePath = pick.path;
      }
    } else {
      const problem = this.#options.platform === "win32" ? windowsPickProblem(picked) : null;
      if (problem) return { status: "refused", reason: problem };
      nativePath = picked;
    }
    const targetId = target.descriptor.id;
    const existing = this.#options.store.data.projects.find((p) => p.targetId === targetId && p.nativePath === nativePath);
    if (existing) return { status: "added", project: view(existing), warning };
    const record: ProjectRecord = { id: randomUUID(), targetId, nativePath, label: folderLabel(nativePath), addedAt: new Date().toISOString() };
    this.#options.store.update((data) => ({ ...data, projects: [...data.projects, record] }));
    return { status: "added", project: view(record), warning };
  }

  removeProject(projectId: string): void {
    this.#options.store.update((data) => ({ ...data, projects: data.projects.filter((p) => p.id !== projectId) }));
  }

  startHello(projectId: string, holdMs: number): Promise<RunSummary> {
    const project = this.#options.store.data.projects.find((p) => p.id === projectId);
    if (!project) return Promise.reject(new Error("That project is no longer in the list."));
    const target = this.#requireTarget();
    if (project.targetId !== target.descriptor.id) {
      const owner = this.#list?.targets.find((t) => t.descriptor.id === project.targetId)?.descriptor.label ?? project.targetId;
      return Promise.reject(new Error(`That project belongs to ${owner}. Choose that target to run it.`));
    }
    // Main mints the request id, so a retry never starts a second run (from Hird).
    return this.#requireSupervisor().call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: project.nativePath, holdMs } });
  }

  listRuns(): Promise<RunList> {
    return this.#requireSupervisor().call("runs.list", { limit: 20, cursor: null });
  }

  runEvents(runId: string, after: number): Promise<RunEventsPage> {
    return this.#requireSupervisor().call("runs.events", { runId, after, limit: 500 });
  }

  cancelRun(runId: string): Promise<{ status: RunStatus; wasTerminal: boolean }> {
    return this.#requireSupervisor().call("runs.cancel", { runId });
  }

  /** Hands a running engine the keys as they are now (D8). */
  async secretsChanged(): Promise<void> {
    const supervisor = this.#requireSupervisor();
    if (supervisor.state.status !== "online") return;
    const secrets = await this.#options.credentials();
    const remove = (["NEBIUS_API_KEY"] as const).filter((name) => !secrets[name]);
    await supervisor.call("secrets.update", { set: secrets, remove: [...remove] });
  }

  resumed(): void {
    this.#supervisor?.resumed();
  }

  async shutdown(): Promise<void> {
    await this.#supervisor?.stop();
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  #activate(targetId: string): void {
    const target = this.#requireList().targets.find((t) => t.descriptor.id === targetId)!;
    this.#target = target;
    this.#warnings = [];
    this.#home = null;
    this.#supervisor = new EngineSupervisor({
      target,
      logsDir: this.#options.logsDir,
      client: this.#options.client,
      credentials: this.#options.credentials,
      log: this.#options.log,
    });
    void this.#supervisor.start().catch((error: unknown) => this.#options.log(`[${targetId}] did not start: ${error instanceof Error ? error.message : String(error)}`));
    void this.#refreshWarnings();
  }

  async #refreshWarnings(): Promise<void> {
    const target = this.#target;
    if (!target) return;
    try {
      const probe = await target.probe();
      if (this.#target !== target) return;
      this.#warnings = probe.problems.filter((p) => p.severity === "warning").map((p) => p.message);
      this.#home = typeof probe.facts["home"] === "string" ? probe.facts["home"] : null;
    } catch {
      // A probe that fails shows in the engine's own start failure.
    }
  }

  #requireList(): TargetList {
    if (!this.#list) throw new Error("The host has not finished starting.");
    return this.#list;
  }

  #requireTarget(): ExecutionTarget {
    if (!this.#target) throw new Error("The host has not finished starting.");
    return this.#target;
  }

  #requireSupervisor(): EngineSupervisor {
    if (!this.#supervisor) throw new Error("The host has not finished starting.");
    return this.#supervisor;
  }
}

function view(record: ProjectRecord): ProjectView {
  return { id: record.id, targetId: record.targetId, label: record.label, displayPath: record.nativePath };
}
