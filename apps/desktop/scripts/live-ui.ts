// Drives a running Nivra through its UI and typed bridge for the live acceptance harness (NIV-14).
// The bridge is called with string expressions: scripts are compiled without the DOM's types (as in
// interrupt-observer.ts). Nothing here reads the key field: Playwright would print its value in a failure message.
import { createHash } from "node:crypto";
import type { ElectronApplication, Page } from "@playwright/test";
import type { ExplainResult, ProviderCheck, RunEvent, RunSummary } from "@nivra/domain";
import type { AppInfo, EngineView, PreferencesView, ProjectView, SettingsView } from "../src/shared/ipc.ts";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value as NonNullable<T>;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const arg = (value: unknown) => JSON.stringify(value);

/** The preferences a run on this project should receive, and their fingerprint, worked out here as D21 defines it. */
export function expectedSnapshot(view: PreferencesView, projectId: string) {
  const records = view.records.filter((r) => r.status === "confirmed" && (r.scope === "personal" || r.projectId === projectId));
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
  const digest = createHash("sha256")
    .update(JSON.stringify(sorted.map((r) => [r.id, r.scope, r.intent, r.revision, r.statement])))
    .digest("hex");
  return { revision: view.revision, ids: sorted.map((r) => r.id), revisions: sorted.map((r) => r.revision), digest };
}

export interface ContextReceived {
  revision: number;
  count: number;
  records: Array<{ id: string; scope: string; intent: string; revision: number }>;
  digest: string;
}

export class Ui {
  readonly app: ElectronApplication;
  readonly page: Page;
  constructor(app: ElectronApplication, page: Page) {
    this.app = app;
    this.page = page;
  }

  call<T>(expression: string): Promise<T> {
    return this.page.evaluate(expression) as Promise<T>;
  }
  /** The bridge's rejection message, or null when the call succeeded. */
  async refusal(expression: string): Promise<string | null> {
    return this.call<string | null>(`${expression}.then(() => null, (error) => String(error && error.message || error))`);
  }
  appInfo = () => this.call<AppInfo>("window.nivra.getAppInfo()");
  engines = () => this.call<EngineView[]>("window.nivra.listEngines()");
  projects = () => this.call<ProjectView[]>("window.nivra.listProjects()");
  preferences = () => this.call<PreferencesView>("window.nivra.listPreferences()");
  settings = () => this.call<SettingsView>("window.nivra.getSettings()");
  result = (runId: string) => this.call<{ summary: RunSummary; result: ExplainResult | null }>(`window.nivra.runResult(${arg(runId)})`);
  checkTokenFactory = (projectId: string) => this.call<ProviderCheck>(`window.nivra.checkTokenFactory(${arg(projectId)})`);
  restartEngine = (projectId: string) => this.call<void>(`window.nivra.restartEngine(${arg(projectId)})`);
  /** Only ever null, or a fake key in the bad-key profile: the real key is typed by the person. */
  setKey = (key: null | `nivra-acceptance-invalid-${string}`) => this.call<SettingsView>(`window.nivra.setNebiusKey(${arg(key)})`);

  /** Every event of a run, page by page, and its status. */
  async events(runId: string): Promise<{ status: string; events: RunEvent[] }> {
    const events: RunEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await this.call<{ events: RunEvent[]; next: number; status: string }>(`window.nivra.runEvents(${arg(runId)}, ${after})`);
      events.push(...page.events);
      if (!page.events.length || page.next === after) return { status: page.status, events };
      after = page.next;
    }
  }
  async status(runId: string): Promise<string> {
    return (await this.call<{ status: string }>(`window.nivra.runEvents(${arg(runId)}, 0)`)).status;
  }
  async ended(runId: string, timeoutMs = 600_000): Promise<string> {
    return waitFor(async () => {
      const status = await this.status(runId);
      return TERMINAL.has(status) ? status : null;
    }, timeoutMs, `run ${runId} to end`);
  }
  /** Waits for the run's first finished model step, which says nothing about whether the run is still going. */
  async firstModelCall(runId: string, timeoutMs = 180_000): Promise<void> {
    await waitFor(async () => {
      const { status, events } = await this.events(runId);
      return events.some((e) => e.type === "model.call") || TERMINAL.has(status);
    }, timeoutMs, `run ${runId}'s first model step`);
  }
  /** What the run's context step recorded about the preferences it received. */
  async received(runId: string): Promise<ContextReceived | null> {
    const { events } = await this.events(runId);
    return (events.find((e) => e.stepId === "context" && e.type === "step.output")?.data as ContextReceived | undefined) ?? null;
  }

  async engineOf(targetId: string): Promise<EngineView | null> {
    return (await this.engines()).find((e) => e.targetId === targetId) ?? null;
  }
  async online(targetId: string, timeoutMs = 240_000) {
    return waitFor(async () => {
      const view = await this.engineOf(targetId);
      return view?.state.status === "online" ? view.state.info : null;
    }, timeoutMs, `the ${targetId} engine`);
  }

  /**
   * Navigation in the window's shell (NIV-56), by test id only: each step presses a sidebar link, a Settings section's
   * link, a Home button or the switcher's field, then waits, within 30 s, for a test id only the place it opened shows.
   */
  private async open(...steps: Array<[press: string, shown: string]>): Promise<void> {
    for (const [press, shown] of steps) {
      await this.page.getByTestId(press).click();
      await this.page.getByTestId(shown).waitFor({ state: "visible", timeout: 30_000 });
    }
  }
  /** The project's Explain, from its Home. */
  readonly toExplain = () => this.open(["nav-home", "page-home"], ["home-explain", "page-explain"]);
  /** Settings' sections: Connections (the keys), Preferences, and Advanced diagnostics (hello, the engine's notices). */
  readonly toConnections = () => this.open(["nav-settings", "page-settings"], ["settings-tab-connections", "settings-connections"]);
  readonly toPreferences = () => this.open(["nav-settings", "page-settings"], ["settings-tab-preferences", "settings-preferences"]);
  readonly toDiagnostics = () => this.open(["nav-settings", "page-settings"], ["settings-tab-diagnostics", "settings-diagnostics"]);

  /** Adds a folder as the native dialog would return it, and waits for its engine. */
  async pick(path: string, targetId: string): Promise<ProjectView> {
    await this.app.evaluate(async ({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
    }, path);
    const before = new Set((await this.projects()).map((p) => p.id));
    await this.open(["project-select", "project-switcher-list"]);
    await this.page.getByTestId("project-add").click();
    const added = await waitFor(async () => (await this.projects()).find((p) => !before.has(p.id)) ?? null, 30_000, "the project to be added");
    if (added.targetId !== targetId) throw new Error(`the folder went to ${added.targetId}, not ${targetId}`);
    // Adding chooses the new project, once the window has the refreshed list: until then, choosing it could race.
    const select = this.page.getByTestId("project-select");
    await waitFor(async () => (await select.inputValue()) === added.label, 15_000, "the window to choose the new project");
    await this.online(targetId);
    return added;
  }
  /**
   * Chooses a project by its label. Choosing the one already chosen would clear the choice (Mantine's Select allows
   * that), so the open list is checked again, and closed rather than clicked when the project is already the choice.
   */
  async choose(project: ProjectView): Promise<void> {
    const select = this.page.getByTestId("project-select");
    if ((await select.inputValue()) === project.label) return;
    await select.click();
    const option = this.page.getByRole("option", { name: new RegExp(`^${project.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
    await option.waitFor({ timeout: 10_000 });
    if ((await option.getAttribute("aria-selected")) === "true" || (await select.inputValue()) === project.label) await this.page.keyboard.press("Escape");
    else await option.click();
    await waitFor(async () => (await select.inputValue()) === project.label, 10_000, "the project to be chosen");
  }

  private shownRun = async () => {
    const status = this.page.getByTestId("explain-status");
    return (await status.count()) ? await status.getAttribute("data-run-id") : null;
  };

  /** Presses Explain and refuses consent in the dialog. Returns whether a run appeared within five seconds. */
  async refuseConsent(): Promise<boolean> {
    const before = await this.shownRun();
    await this.toExplain();
    await this.page.getByTestId("explain-start").click();
    const dialog = this.page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await sleep(5_000);
    return (await this.shownRun()) !== before;
  }

  /** Starts an explanation with the question and choices given, allowing consent if asked, and returns its run id. */
  async explain(question: string, choices: readonly string[] = []): Promise<string> {
    await this.toExplain();
    await this.page.getByTestId("explain-question").fill(question);
    while (await this.page.getByTestId("explain-choice-remove").count()) await this.page.getByTestId("explain-choice-remove").first().click();
    for (const choice of choices) {
      await this.page.getByTestId("explain-choice-add").click();
      await this.page.getByTestId("explain-choice").last().fill(choice);
    }
    const before = await this.shownRun();
    await this.page.getByTestId("explain-start").click();
    const allow = this.page.getByTestId("explain-consent-allow");
    const started = await waitFor(async () => {
      if (await allow.isVisible().catch(() => false)) await allow.click();
      const shown = await this.shownRun();
      return shown && shown !== before ? shown : null;
    }, 60_000, "the explanation to start");
    return started;
  }

  /** Internal lifecycle checks use the typed bridge; Hello has no product UI. */
  async hello(seconds: 0 | 5 | 60): Promise<string> {
    await this.page.getByTestId("project-select").click();
    const projectId = await this.page.locator('[data-testid="switcher-project"][aria-selected="true"]').getAttribute("data-project-id");
    await this.page.keyboard.press("Escape");
    if (!projectId) throw new Error("Choose a project before starting the diagnostic run.");
    const run = await this.call<RunSummary>(`window.nivra.startHello(${arg(projectId)}, ${seconds * 1000})`);
    if (seconds > 0) await waitFor(async () => (await this.events(run.id)).events.some((event) => event.message.startsWith("Holding a child process")), 120_000, "the diagnostic child to hold");
    return run.id;
  }

  cancelRun = (runId: string) => this.call<void>(`window.nivra.cancelRun(${arg(runId)})`);

  async confirmPreference(statement: string, scope: string, intent?: "Default for this project" | "Decision to change existing conventions"): Promise<string> {
    await this.toPreferences();
    await this.page.getByTestId("preference-scope").getByText(scope, { exact: true }).click();
    if (intent) await this.page.getByTestId("preference-intent-choice").getByText(intent, { exact: true }).click();
    await this.page.getByTestId("preference-input").fill(statement);
    await this.page.getByTestId("preference-confirm").click();
    return waitFor(async () => (await this.preferences()).records.find((r) => r.statement === statement && r.status === "confirmed")?.id ?? null, 15_000, "the preference to be saved");
  }
  private row = (id: string) => this.page.locator(`[data-testid="preference-row"][data-preference-id="${id}"]`);
  async editPreference(id: string, statement: string): Promise<void> {
    await this.toPreferences();
    await this.row(id).getByTestId("preference-edit").click();
    await this.row(id).getByTestId("preference-edit-input").fill(statement);
    await this.row(id).getByTestId("preference-save").click();
    await waitFor(async () => (await this.preferences()).records.find((r) => r.id === id)?.statement === statement, 15_000, "the edit to be saved");
  }
  async replacePreference(id: string, statement: string): Promise<string> {
    await this.toPreferences();
    await this.row(id).getByTestId("preference-replace").click();
    await this.row(id).getByTestId("preference-edit-input").fill(statement);
    await this.row(id).getByTestId("preference-replace-save").click();
    return waitFor(async () => (await this.preferences()).records.find((r) => r.supersedes === id && r.status === "confirmed")?.id ?? null, 15_000, "the replacement to be saved");
  }
  async deletePreference(id: string): Promise<void> {
    await this.toPreferences();
    await this.row(id).getByTestId("preference-delete").click();
    await waitFor(async () => !(await this.preferences()).records.some((r) => r.id === id), 15_000, "the preference to be deleted");
  }
}
