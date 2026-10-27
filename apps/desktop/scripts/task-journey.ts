// The steps of a task's journey through the window (NIV-35, D41), shared by the offline journey (e2e/task-journey.spec.ts,
// against stand-ins) and the live run (scripts/task-live.ts): the project, its environment prepared, the task, the run
// previewed and started, and what came of it. Each step drives the window as a person would, and reads the app through
// its own bridge, called with string expressions: scripts are compiled without the DOM's types. Nothing here presses
// Prepare or Start more than once, and nothing reads a key field.
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import type { EnvironmentPreview, EnvironmentSpec } from "@nivra/domain";
import type { BriefFields, EnvironmentView, ProjectView, SettingsView, TaskAttemptView, TaskView } from "../src/shared/ipc.ts";

const arg = (value: unknown) => JSON.stringify(value);
const call = <T>(page: Page, expression: string) => page.evaluate(expression) as Promise<T>;

/** The checkout picked as Add project would pick it, then added; the project's id once its engine is online. */
export async function addProject(app: ElectronApplication, page: Page, folder: string): Promise<string> {
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, folder);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 60_000 });
  return (await call<ProjectView[]>(page, "window.nivra.listProjects()")).at(-1)!.id;
}

/** Waits until the Nebius key and project id are both saved in Settings, without reading either. */
export async function keysSaved(page: Page, timeoutMs: number): Promise<void> {
  await expect
    .poll(async () => {
      const settings = await call<SettingsView>(page, "window.nivra.getSettings()");
      return (settings.nebiusKey === "encrypted" || settings.nebiusKey === "unencrypted") && settings.nebiusProjectId === "set";
    }, { timeout: timeoutMs, intervals: [2_000] })
    .toBe(true);
}

/** The environment section's preview for the packages chosen, as the window shows it; its fingerprint from the host. */
export async function previewEnvironment(page: Page, projectId: string, spec: EnvironmentSpec): Promise<Extract<EnvironmentPreview, { status: "ready" }>> {
  const section = page.getByTestId("environment");
  await section.getByTestId("environment-preview").click();
  if (spec.filters.length) {
    await section.getByTestId("environment-chosen").check();
    for (const filter of spec.filters) {
      const name = filter.replace(/\.\.\.$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await section.getByRole("checkbox", { name: new RegExp(`^${name} \\(`) }).check();
    }
    await section.getByTestId("environment-preview").click();
  }
  await expect(section.getByTestId("environment-sends")).toContainText(`pnpm install --frozen-lockfile${spec.filters.map((filter) => ` --filter ${filter}`).join("")}`);
  const shown = await call<EnvironmentPreview>(page, `window.nivra.previewEnvironment(${arg(projectId)}, ${arg(spec)})`);
  if (shown.status !== "ready") throw new Error(`The environment's preview was refused (${shown.code}): ${shown.message}`);
  return shown;
}

export const environmentOf = (page: Page, projectId: string) => call<EnvironmentView>(page, `window.nivra.getEnvironment(${arg(projectId)})`);

/** Presses Prepare once, allows uploads in their own dialog when asked, and waits for the preparation to end. */
export async function prepareOnce(page: Page, projectId: string, timeoutMs: number, log: (line: string) => void): Promise<EnvironmentView> {
  const section = page.getByTestId("environment");
  await section.getByTestId("environment-prepare").click();
  const consent = page.getByTestId("environment-consent-allow");
  // Asked for only when the project's uploads are off; isVisible doesn't wait, so the dialog is waited for.
  if (await consent.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) {
    log("Uploads for the project allowed, in their own dialog.");
    await consent.click();
  }
  const deadline = performance.now() + timeoutMs;
  let last = "";
  let seen = 0;
  for (;;) {
    const view = await environmentOf(page, projectId);
    const status = view.preparation?.status ?? "none";
    if (status !== last) log(`Preparation: ${status}`);
    last = status;
    for (const line of view.preparation?.progress.slice(seen) ?? []) log(`  ${line}`);
    seen = view.preparation?.progress.length ?? 0;
    if (view.preparation && !["submitting", "running"].includes(view.preparation.status)) return view;
    if (performance.now() > deadline) throw new Error(`The preparation didn't end within ${Math.round(timeoutMs / 60_000)} minutes.`);
    await page.waitForTimeout(5_000);
  }
}

/** The task, created through the app's own call from the brief's fields, opened, and marked ready in the window. */
export async function createTask(page: Page, input: { title: string; fields: BriefFields; projectId: string; planId: string | null }): Promise<string> {
  const created = await call<TaskView>(page, `window.nivra.createTask(${arg(input)})`);
  await openTask(page, created.summary.id);
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-state")).toHaveText("Ready");
  return created.summary.id;
}

/** The task's page. */
export async function openTask(page: Page, taskId: string): Promise<void> {
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-open").click();
  await expect(page.getByTestId("task-title")).toBeVisible();
}

/**
 * What the run's preview shows, read before Start: the environment, the baseline checks, the frozen files and the
 * limits, and the fingerprints Start sends (the run's and its snapshot's).
 */
export interface RunShown {
  expected: string;
  snapshot: string;
  environment: string;
  baseline: string;
  frozen: string[];
  limits: string;
}

/** Opens the run's preview, allows sharing and uploads in their own dialogs when asked, and reads what it shows. */
export async function previewRun(page: Page): Promise<RunShown> {
  await page.getByTestId("task-run").click();
  const preview = page.getByTestId("task-run-preview-body");
  await expect(preview).toBeVisible({ timeout: 60_000 });
  for (const [ask, allow] of [
    ["task-run-ask-sharing", "task-run-allow-sharing"],
    ["task-run-ask-uploads", "task-run-allow-uploads"],
  ] as const) {
    if (await preview.getByTestId(ask).count()) await preview.getByTestId(allow).click();
  }
  await expect(page.getByTestId("task-run-start")).toBeEnabled({ timeout: 60_000 });
  const text = async (id: string) => (await preview.getByTestId(id).count() ? ((await preview.getByTestId(id).first().textContent()) ?? "") : "");
  return {
    expected: (await preview.getAttribute("data-expected")) ?? "",
    snapshot: (await preview.getAttribute("data-snapshot")) ?? "",
    environment: await text("task-run-preview-environment"),
    baseline: await text("task-run-preview-baseline"),
    frozen: await preview.getByTestId("task-run-preview-frozen-file").allTextContents(),
    limits: await text("task-run-preview-limits"),
  };
}

export const taskOf = (page: Page, taskId: string) => call<TaskView>(page, `window.nivra.getTask(${arg(taskId)})`);
export const attemptOf = (page: Page, taskId: string, attemptId: string) => call<TaskAttemptView>(page, `window.nivra.getTaskAttempt(${arg(taskId)}, ${arg(attemptId)})`);

/** Presses Start once, and returns the new attempt's id. */
export async function startOnce(page: Page, taskId: string): Promise<string> {
  const before = new Set((await taskOf(page, taskId)).attempts.map((attempt) => attempt.id));
  await page.getByTestId("task-run-start").click();
  let created: string | null = null;
  await expect
    .poll(async () => {
      created = (await taskOf(page, taskId)).attempts.find((attempt) => !before.has(attempt.id))?.id ?? null;
      return created;
    }, { timeout: 60_000 })
    .not.toBeNull();
  return created!;
}

/** Follows an attempt until its run ends, logging each progress line once; its view then. */
export async function followRun(page: Page, taskId: string, attemptId: string, timeoutMs: number, log: (line: string) => void): Promise<TaskAttemptView> {
  const deadline = performance.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const attempt = await attemptOf(page, taskId, attemptId);
    for (const line of attempt.progress.slice(seen)) log(`  ${line}`);
    seen = attempt.progress.length;
    if (!["submitting", "running"].includes(attempt.status)) return attempt;
    if (performance.now() > deadline) throw new Error(`The run didn't end within ${Math.round(timeoutMs / 60_000)} minutes.`);
    await page.waitForTimeout(5_000);
  }
}
