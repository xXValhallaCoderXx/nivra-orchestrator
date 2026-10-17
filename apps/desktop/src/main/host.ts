import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DoctorReport, ExplainResult, ProviderCheck, RunEventsPage, RunStatus, RunSummary, SecretName } from "@nivra/domain";
import type { AddProjectResult, EngineView, PreferencesView, PreferenceView, ProjectView, WslView } from "../shared/ipc.ts";
import { migrateHostData, NO_SHARING, type HostStore, type PreferenceRecord, type ProjectRecord } from "./host-store.ts";
import { classifyPicked, folderLabel, sameFolder } from "./paths.ts";
import { addPreference, cleanChoices, deletePreference, editPreference, removeProjectPreferences, snapshotFor, type NewPreference, type PreferenceChange } from "./preferences.ts";
import { EngineSupervisor, type SupervisorOptions } from "./supervisor.ts";
import type { TargetFactory, WslTargets } from "./targets/registry.ts";
import { labelFor, type ExecutionTarget } from "./targets/types.ts";
import { isHiddenDistro, wslGuidance } from "./targets/wsl-discovery.ts";

export interface HostOptions {
  targets: TargetFactory;
  store: HostStore;
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
}

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
  /** Projects being removed: no explanation may start for them, and a late answer to one that did is not accepted. */
  readonly #removing = new Set<string>();
  #wsl: WslTargets | null = null;
  #wslChecked = false;
  #discovering: Promise<WslTargets | null> | null = null;
  #closing: Promise<void> | null = null;

  constructor(options: HostOptions) {
    this.#options = options;
  }

  /** Brings older records in line (D17) and starts looking for WSL in the background. Starts no engine. */
  init(): void {
    const migrated = migrateHostData(this.#options.store.data, this.#options.platform);
    if (migrated.changed) this.#options.store.update(() => migrated.data);
    for (const [id, notice] of migrated.notices) this.#notices.set(id, notice);
    void this.#discover();
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
      await this.#stopExplainRuns(projectId, (runs, why, them) => `Sharing for this project is off, but Nivra couldn't stop ${runs} (${why}). Restart the project's engine to stop ${them}.`);
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
    try {
      await this.#stopExplainRuns(projectId, (runs, why) => `Nivra couldn't stop ${runs} (${why}), so the project is still in the list. Restart its engine, then remove it again.`);
    } catch (error) {
      this.#removing.delete(projectId);
      throw error;
    }
    this.#notices.delete(projectId);
    this.#explainRuns.delete(projectId);
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

  /** Stops every engine in parallel, each in the D4 order; none can start afterwards. */
  shutdown(): Promise<void> {
    this.#closing ??= Promise.allSettled([...this.#engines.values()].map((engine) => engine.supervisor.close())).then(() => undefined);
    return this.#closing;
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  #epochOf(projectId: string): number {
    return this.#sharingEpochs.get(projectId) ?? 0;
  }

  /** Cancels the project's queued and running explain runs; when one can't be stopped, says so through `refusal`. */
  async #stopExplainRuns(projectId: string, refusal: (runs: string, why: string, them: "it" | "them") => string): Promise<void> {
    // A run whose engine isn't online isn't running any more.
    const runs = [...(this.#explainRuns.get(projectId) ?? [])].filter((runId) => this.#engines.get(this.#runs.get(runId) ?? "")?.supervisor.state.status === "online");
    const failed = (await Promise.allSettled(runs.map((runId) => this.cancelRun(runId)))).filter((result) => result.status === "rejected");
    if (failed.length === 0) return;
    const why = failed[0]!.reason instanceof Error ? failed[0]!.reason.message : String(failed[0]!.reason);
    throw new Error(refusal(failed.length === 1 ? "an explain run" : `${failed.length} explain runs`, why, failed.length === 1 ? "it" : "them"));
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
    const targetId = this.#runs.get(runId);
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
