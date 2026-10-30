import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { goTo, openSwitcher } from "./places.ts";

/** Keyless preview/detour coverage also runs in the packaged app. No provider request is accepted. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
test.describe.configure({ mode: "serial" });
let app: ElectronApplication; let page: Page; let root: string; let projectId: string; let taskId: string;
let development: ViteDevServer | undefined;
test.beforeAll(async ({}, info) => {
  root = mkdtempSync(join(tmpdir(), "nivra task preferences "));
  const repo = join(root, "repository"); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "A preview fixture.\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "README.md"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: repo }); expect(result.status).toBe(0);
  }
  const executable = info.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  if (info.project.name === "development") {
    // Serve React's development runtime: production bundles do not replay StrictMode effects.
    development = await createServer({ configFile: false, root: join(desktop, "src/renderer"), plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
    await development.listen();
  }
  const env = development ? { ...process.env, ELECTRON_RENDERER_URL: development.resolvedUrls!.local[0]! } : undefined;
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], ...(env ? { env } : {}), chromiumSandbox: true });
  page = await app.firstWindow(); await expect(page.getByTestId("home-title")).toBeVisible();
  if (development) expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:/);
  await app.evaluate(async ({ dialog }, picked) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog; }, repo);
  await openSwitcher(page); await page.getByTestId("project-add").click();
  await expect.poll(async () => (await page.evaluate(() => window.nivra.listProjects())).length).toBe(1);
  ({ projectId, taskId } = await page.evaluate(async () => {
    const project = (await window.nivra.listProjects())[0]!;
    const task = await window.nivra.createTask({ title: "Preference preview fixture", projectId: project.id, planId: null, fields: { goal: "Review the context", acceptanceCriteria: ["Context is visible"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [{ name: "A case", command: "printf ok", expectedOutput: "ok", expectedExitCode: 0 }] } });
    await window.nivra.setTaskState(task.summary.id, task.revision, "ready");
    return { projectId: project.id, taskId: task.summary.id };
  }));
  await goTo(page, "tasks"); await page.getByRole("button", { name: "Preference preview fixture", exact: true }).click();
});
test.afterAll(async () => { await app?.close().catch(() => undefined); await development?.close(); if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

test("temporary choices survive Preferences and failed starts, require refresh, and clear only on explicit preview cancellation", async () => {
  await page.getByTestId("task-run").click();
  const preview = page.getByTestId("task-run-preview-body");
  await expect(preview.getByTestId("task-run-preferences")).toContainText("No confirmed preferences apply");
  await page.getByTestId("task-working-requests").fill("16");
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await preview.getByRole("button", { name: "Add run choice", exact: true }).click();
  await preview.getByLabel("Run choice 1", { exact: true }).fill("Preserve the existing public API");
  await expect(preview).toContainText("Choices changed. Refresh");
  await expect(page.getByTestId("task-run-start")).toBeDisabled();
  await preview.getByRole("button", { name: "Edit preferences", exact: true }).click();
  await expect(page.getByTestId("task-run-preview")).toBeHidden();
  await page.getByTestId("preference-input").fill("Prefer explicit return types");
  await page.getByTestId("preference-confirm").click();
  await expect(page.getByTestId("preference-list")).toContainText("Prefer explicit return types");
  await page.getByTestId("task-preferences-return").click();
  await expect(page.getByTestId("task-working-requests")).toHaveValue("16");
  await expect(page.getByTestId("task-work-allowance")).toContainText("Up to 16 working requests");
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Preserve the existing public API");
  await expect(preview.getByTestId("task-run-preferences")).toContainText("Prefer explicit return types");
  // Synthetic credentials satisfy the preview only. Revoke sharing before Start so no provider work is admitted.
  await page.evaluate(async (id) => { await window.nivra.setNebiusKey("task-preview-synthetic-key-0123456789"); await window.nivra.setNebiusProjectId("project-e00preview0001"); await window.nivra.setSharing(id, true); await window.nivra.setCloudExecution(id, true); }, projectId);
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled();
  await page.evaluate(() => window.nivra.addPreference("A relevant change after preview", "personal", null, "default"));
  await page.getByTestId("task-run-start").click();
  await expect(page.getByTestId("task-run-preview-error")).toContainText("changed since you previewed");
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Preserve the existing public API");
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await expect(preview.getByTestId("task-run-preferences")).toContainText("A relevant change after preview");
  await expect(page.getByTestId("task-run-start")).toBeEnabled();
  await page.evaluate((id) => window.nivra.setSharing(id, false), projectId);
  await page.getByTestId("task-run-start").click();
  await expect(page.getByTestId("task-run-preview-error")).toBeVisible();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Preserve the existing public API");
  expect((await page.evaluate((id) => window.nivra.getTask(id), taskId)).attempts.length).toBe(0);
  // A second detour retains choices even while moving between Preferences and another Settings section.
  await preview.getByRole("button", { name: "Edit preferences", exact: true }).click();
  await goTo(page, "settings-connections");
  // Leaving Preferences for the task list is not an explicit Cancel either.
  await goTo(page, "tasks");
  await page.getByRole("button", { name: "Preference preview fixture", exact: true }).click();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Preserve the existing public API");
  await expect(page.getByTestId("task-working-requests")).toHaveValue("16");
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("task-run").click();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveCount(0);
});

test("switching tasks clears the originating preview's temporary choices", async () => {
  const preview = page.getByTestId("task-run-preview-body");
  await preview.getByRole("button", { name: "Add run choice", exact: true }).click();
  await preview.getByLabel("Run choice 1", { exact: true }).fill("Only the originating task gets this");
  await preview.getByRole("button", { name: "Edit preferences", exact: true }).click();
  await page.evaluate(async (id) => {
    const task = await window.nivra.createTask({ title: "Another preference task", projectId: id, planId: null, fields: { goal: "Another task", acceptanceCriteria: ["One result"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [{ name: "One case", command: "printf ok", expectedOutput: "ok", expectedExitCode: 0 }] } });
    await window.nivra.setTaskState(task.summary.id, task.revision, "ready");
  }, projectId);
  await goTo(page, "tasks"); await page.getByRole("button", { name: "Another preference task", exact: true }).click();
  await page.getByTestId("task-run").click();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  await goTo(page, "tasks"); await page.getByRole("button", { name: "Preference preview fixture", exact: true }).click();
  await page.getByTestId("task-run").click();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveCount(0);
  expect((await page.evaluate((id) => window.nivra.getTask(id), taskId)).attempts.length).toBe(0);
});

test("a revised brief requires another preview while retaining this task's temporary choices", async () => {
  const preview = page.getByTestId("task-run-preview-body");
  await preview.getByRole("button", { name: "Add run choice", exact: true }).click();
  await preview.getByLabel("Run choice 1", { exact: true }).fill("Keep this choice while reviewing the new brief");
  await page.evaluate((id) => window.nivra.setSharing(id, true), projectId);
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled();
  await page.evaluate(async (id) => {
    const view = await window.nivra.getTask(id);
    const { acceptanceCriteria, scope, exclusions, context, assumptions, checks, acceptanceCases, baseline, frozen } = view.brief.content;
    const revised = await window.nivra.reviseBrief(id, view.revision, { goal: "Review the changed context", acceptanceCriteria, scope, exclusions, context, assumptions, checks, acceptanceCases, baseline, frozen });
    await window.nivra.setTaskState(id, revised.revision, "ready");
  }, taskId);
  await page.getByTestId("task-run-start").click();
  await expect(page.getByTestId("task-run-preview-error")).toContainText("changed since you previewed");
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Keep this choice while reviewing the new brief");
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Keep this choice while reviewing the new brief");
  expect((await page.evaluate((id) => window.nivra.getTask(id), taskId)).attempts.length).toBe(0);
});

test("invalid choices remain editable after returning from Preferences, and can be corrected or removed", async () => {
  const preview = page.getByTestId("task-run-preview");
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  // The previous scenario revised the brief; open its current view before testing a validation-only detour.
  await goTo(page, "tasks"); await page.getByRole("button", { name: "Preference preview fixture", exact: true }).click();
  await page.getByTestId("task-run").click();
  await preview.getByRole("button", { name: "Add run choice", exact: true }).click();
  await preview.getByLabel("Run choice 1", { exact: true }).fill("Preserve the public API");
  await preview.getByRole("button", { name: "Add run choice", exact: true }).click();
  await preview.getByRole("button", { name: "Edit preferences", exact: true }).click();
  await page.getByTestId("task-preferences-return").click();
  await expect(preview.getByTestId("task-run-preview-error")).toBeVisible();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Preserve the public API");
  await preview.getByLabel("Run choice 2", { exact: true }).fill("Keep existing check names");
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await expect(preview.getByTestId("task-run-preferences")).toBeVisible();
  await expect(page.getByTestId("task-run-start")).toBeEnabled();
  // Duplicate choices are another validation failure; removing one must preserve the other.
  await preview.getByLabel("Run choice 2", { exact: true }).fill("Preserve the public API");
  await preview.getByRole("button", { name: "Edit preferences", exact: true }).click();
  await page.getByTestId("task-preferences-return").click();
  await expect(preview.getByTestId("task-run-preview-error")).toBeVisible();
  await preview.getByRole("button", { name: "Remove choice 2", exact: true }).click();
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await expect(preview.getByLabel("Run choice 1", { exact: true })).toHaveValue("Preserve the public API");
  await expect(preview.getByLabel("Run choice 2", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("task-run-start")).toBeEnabled();
  expect((await page.evaluate((id) => window.nivra.getTask(id), taskId)).attempts.length).toBe(0);
});

test("a finite request limit survives Preferences while coding shares the monthly allowance", async () => {
  const preview = page.getByTestId("task-run-preview-body");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("task-run-preview")).toBeHidden();
  await page.evaluate(() => window.nivra.setCompanionLimit(100, true));
  await goTo(page, "tasks");
  await page.getByRole("button", { name: "Preference preview fixture", exact: true }).click();
  await page.getByTestId("task-run").click();
  await page.getByLabel(/^Use the monthly allowance without/).uncheck();
  await page.getByTestId("task-working-requests").fill("16");
  await preview.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await preview.getByRole("button", { name: "Edit preferences", exact: true }).click();
  await page.getByTestId("task-preferences-return").click();
  await expect(page.getByTestId("task-working-requests")).toHaveValue("16");
  await expect(page.getByTestId("task-work-allowance")).toContainText("Up to 16 working requests");
  await expect(page.getByLabel(/^Use the monthly allowance without/)).not.toBeChecked();
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.nivra.setCompanionLimit(null, false));
});
