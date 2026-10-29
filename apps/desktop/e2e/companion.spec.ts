import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { goTo } from "./places.ts";

/** No keys or cloud calls: native planning, temporary composer, persisted visibility and narrow-window access. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
test.describe.configure({ mode: "serial" });
let root: string;
let app: ElectronApplication;
let page: Page;
const marker = "companion-unsent-private-fixture-68";

async function launch(info: TestInfo) {
  const executable = info.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await expect(page.getByTestId("home-title")).toBeVisible();
}

test.beforeAll(async ({}, info) => { root = mkdtempSync(join(tmpdir(), "nivra e2e companion ")); await launch(info); });
test.afterAll(async () => { await app?.close().catch(() => undefined); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

test("an idea becomes a saved mission and first draft task without Git, a repository or a key", async ({}, info) => {
  await page.getByTestId("home-start-idea").click();
  await expect(page.getByTestId("companion-panel")).toBeVisible();
  await page.getByTestId("companion-idea-name").fill("Offline field log");
  await page.getByTestId("companion-idea-outcome").fill("A walker saves field observations without a connection.");
  await page.getByTestId("companion-idea-save").click();
  await expect(page.getByTestId("companion-idea-saved")).toContainText("Offline field log");
  await page.screenshot({ path: info.outputPath("companion-saved-idea.png") });
  await page.getByTestId("companion-minimise").click();
  await page.getByTestId("companion-launcher").click();
  await expect(page.getByTestId("companion-idea-saved")).toBeVisible();
  await page.getByTestId("companion-first-title").fill("Save one field observation");
  await page.getByTestId("companion-first-goal").fill("Retain one note on this device.");
  await page.getByTestId("companion-first-acceptance").fill("The saved note can be reopened.");
  await page.getByTestId("companion-first-save").click();
  await expect(page.getByTestId("page-task")).toBeVisible();
  const tasks = await page.evaluate(() => window.nivra.listTasks());
  expect(tasks.tasks.length).toBe(1);
  expect(tasks.tasks[0]?.state).toBe("draft");
  expect(tasks.tasks[0]?.projectId).toBeNull();
  const task = await page.evaluate((id) => window.nivra.getTask(id), tasks.tasks[0]!.id);
  expect(task.brief.content.acceptanceCriteria).toEqual(["The saved note can be reopened."]);
  expect(task.brief.content.acceptanceCases.length).toBe(0);
  expect(task.brief.content.checks.length).toBe(0);
  const missions = await page.evaluate(() => window.nivra.listMissions());
  expect(missions.missions.length).toBe(1);
});

test("minimising preserves the temporary composer; restart clears it and retains native work", async ({}, info) => {
  await page.getByTestId("companion-launcher").click();
  await page.getByTestId("companion-message").fill(marker);
  await page.getByTestId("companion-minimise").click();
  await page.getByTestId("companion-launcher").click();
  await expect(page.getByTestId("companion-message")).toHaveValue(marker);
  const stored = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(stored.includes(marker)).toBe(false);
  await app.close();
  await launch(info);
  await page.getByTestId("companion-launcher").click();
  await expect(page.getByTestId("companion-message")).toHaveValue("");
  expect((await page.evaluate(() => window.nivra.listTasks())).tasks.length).toBe(1);
  expect((await page.evaluate(() => window.nivra.listMissions())).missions.length).toBe(1);
  expect((await page.evaluate(() => window.nivra.listConversations())).conversations.length).toBe(0);
  await page.getByTestId("companion-minimise").click();
});

test("a selected task decision survives restart and can be corrected and forgotten", async ({}, info) => {
  await goTo(page, "tasks");
  await page.getByTestId("task-open").click();
  await page.getByTestId("companion-launcher").click();
  const knowledge = page.getByTestId("companion-knowledge");
  await knowledge.locator("summary").click();
  await page.getByTestId("companion-knowledge-statement").fill("The field log must work offline.");
  await page.getByTestId("companion-knowledge-save").click();
  await expect(page.getByTestId("companion-knowledge-ack")).toContainText("Remembered");
  await expect(page.getByTestId("companion-knowledge-item")).toContainText("The field log must work offline.");
  await app.close();
  await launch(info);
  await goTo(page, "tasks");
  await page.getByTestId("task-open").click();
  await page.getByTestId("companion-launcher").click();
  await page.getByTestId("companion-knowledge").locator("summary").click();
  await expect(page.getByTestId("companion-knowledge-item")).toContainText("The field log must work offline.");
  await page.getByTestId("companion-knowledge-item").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByTestId("companion-knowledge-statement").fill("The field log must retain notes offline.");
  await page.getByTestId("companion-knowledge-save").click();
  await expect(page.getByTestId("companion-knowledge-item")).toContainText("The field log must retain notes offline.");
  await page.getByTestId("companion-knowledge-item").getByRole("button", { name: "Forget", exact: true }).click();
  await expect(page.getByTestId("companion-knowledge-item")).toHaveCount(0);
  await expect(page.getByTestId("companion-knowledge-ack")).toContainText("Forgotten");
  await page.getByTestId("companion-minimise").click();
});

test("the launcher can be hidden, reopened by keyboard and restored without losing direct navigation", async () => {
  await page.getByTestId("companion-launcher").click();
  await page.getByLabel("Dismiss companion invitation").click();
  await page.getByTestId("companion-hide").click();
  await expect(page.getByTestId("companion-launcher")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+Space");
  await expect(page.getByTestId("companion-panel")).toBeVisible();
  await expect(page.getByTestId("companion-invitation")).toHaveCount(0);
  await page.getByTestId("companion-show-launcher").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("companion-panel")).toBeHidden();
  await goTo(page, "tasks");
  await expect(page.getByTestId("page-tasks")).toBeVisible();
});

test("an existing project with no commits offers a remedy and a Settings detour returns to its setup", async () => {
  const path = join(root, "existing field log");
  mkdirSync(path);
  const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path, encoding: "utf8" });
  if (init.status !== 0) throw new Error("The synthetic repository couldn't be initialised.");
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selected] })) as typeof dialog.showOpenDialog; }, path);
  await goTo(page, "home");
  await page.getByTestId("home-add-project").click();
  await expect(page.getByTestId("home-title")).toHaveText("existing field log");
  await page.getByTestId("home-guided-setup").click();
  await expect(page.getByTestId("companion-project-setup")).toContainText("no commits yet");
  await page.getByRole("button", { name: "Open Settings", exact: true }).last().click();
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await page.getByTestId("companion-return").click();
  await expect(page.getByTestId("home-title")).toHaveText("existing field log");
  await expect(page.getByTestId("companion-project-setup")).toContainText("no commits yet");
  await page.getByTestId("companion-minimise").click();
});

test("a short narrow window scrolls the companion with its close action reachable and no sideways overflow", async ({}, info) => {
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(820, 600); window.webContents.setZoomFactor(1.5); });
  await page.getByTestId("companion-launcher").click();
  const panel = page.getByTestId("companion-panel");
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const clipped = await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll<HTMLElement>("p, label, input, textarea, button, summary")).filter((child) => child.getClientRects().length > 0).filter((child) => {
      const rect = child.getBoundingClientRect();
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || (child.tagName === "P" && child.scrollWidth > child.clientWidth + 1);
    }).map((child) => ({ tag: child.tagName, text: child.textContent?.slice(0, 80), width: Math.round(child.getBoundingClientRect().width) }));
  });
  expect(clipped.length).toBe(0);
  await page.getByTestId("companion-message").fill("A temporary question");
  // Electron's page screenshot crops to CSS pixels when the app is zoomed. Capture the native client area instead.
  const captured = await app.evaluate(async ({ BrowserWindow }) => [...(await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG()]);
  writeFileSync(info.outputPath("companion-narrow.png"), Buffer.from(captured));
  await page.getByTestId("companion-minimise").click();
  await expect(panel).toBeHidden();
});
