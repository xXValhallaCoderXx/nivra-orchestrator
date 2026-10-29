import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { goTo } from "./places.ts";

/** Real host persistence and UI, without provider keys, repositories or inference requests. */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
test.describe.configure({ mode: "serial" });
let root: string;
let app: ElectronApplication;
let page: Page;

async function launch(info: TestInfo) {
  const executable = info.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await expect(page.getByTestId("home-title")).toBeVisible();
}

async function startManual(title: string, outcome: string) {
  await goTo(page, "tasks");
  await page.getByRole("button", { name: "Break into tasks", exact: true }).click();
  const planning = page.getByTestId("planning-page");
  await planning.getByLabel("Planning title", { exact: true }).fill(title);
  await planning.getByLabel("Desired outcome", { exact: true }).fill(outcome);
  await planning.getByRole("button", { name: "Save planning brief", exact: true }).click();
  await expect(planning.getByRole("button", { name: "Save reviewed version", exact: true })).toBeVisible();
  await planning.getByRole("button", { name: "Plan manually", exact: true }).click();
  await expect(planning.getByRole("heading", { name: "What this affects", exact: true })).toBeVisible();
  return planning;
}

test.beforeAll(async ({}, info) => { root = mkdtempSync(join(tmpdir(), "nivra e2e reviewed planning ")); await launch(info); });
test.afterAll(async () => { await app?.close().catch(() => undefined); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

test("manual greenfield planning saves an edited native draft and resumes the reviewed proposal after restart", async ({}, info) => {
  const title = "Offline observation journal";
  const planning = await startManual(title, "A walker records and reopens one observation without connectivity.");
  await planning.getByRole("button", { name: "Add task", exact: true }).click();
  await planning.getByLabel("Task 1 title", { exact: true }).fill("Keep one observation offline");
  await planning.getByLabel("Task 1 goal", { exact: true }).fill("Retain an observation on this device.");
  const criteria = planning.getByLabel("Task 1 acceptance criteria, one per line", { exact: true });
  await criteria.fill("The saved observation can be reopened after restarting.");
  await criteria.press("End");
  await criteria.press("Enter");
  await criteria.pressSequentially("A second observation does not replace the first.");
  await planning.getByLabel("Task 1 title", { exact: true }).fill("Save and reopen one observation");
  await planning.getByRole("button", { name: "Save reviewed version", exact: true }).click();
  const save = planning.getByRole("button", { name: "Save selected drafts", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(planning.getByRole("button", { name: "Open saved draft", exact: true })).toBeVisible();
  const records = await page.evaluate(() => window.nivra.listPlanning(null));
  expect(records.length).toBe(1);
  const record = records[0]!;
  expect(record.saved.length).toBe(1);
  const tasks = await page.evaluate(() => window.nivra.listTasks());
  expect(tasks.tasks.length).toBe(1);
  expect(tasks.tasks[0]).toMatchObject({ title: "Save and reopen one observation", state: "draft", projectId: null });
  const task = await page.evaluate((id) => window.nivra.getTask(id), record.saved[0]!.taskId);
  expect(task.brief.content.acceptanceCriteria).toEqual(["The saved observation can be reopened after restarting.", "A second observation does not replace the first."]);
  expect(task.brief.content.acceptanceCases.length).toBe(0);
  expect(task.brief.content.checks.length).toBe(0);
  expect(await page.evaluate(() => window.nivra.listEngines())).toEqual([]);
  expect((await page.evaluate(() => window.nivra.getCompanionUsage())).used).toBe(0);
  await page.screenshot({ path: info.outputPath("planning-reviewed-draft.png") });
  await app.close();
  await launch(info);
  await goTo(page, "tasks");
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByTestId("planning-page").getByLabel("Task 1 title", { exact: true })).toHaveValue("Save and reopen one observation");
  await expect(page.getByRole("button", { name: "Open saved draft", exact: true })).toBeVisible();
  const reopened = await page.evaluate((id) => window.nivra.getPlanning(id), record.id);
  expect(reopened.saved.map((item) => item.taskId)).toEqual(record.saved.map((item) => item.taskId));
  expect((await page.evaluate(() => window.nivra.listConversations())).conversations.length).toBe(0);
  await page.getByRole("button", { name: "Open saved draft", exact: true }).click();
  await expect(page.getByTestId("page-task")).toBeVisible();
  await page.getByRole("button", { name: "Review source plan", exact: true }).click();
  await expect(page.getByTestId("planning-page").getByLabel("Planning title", { exact: true })).toHaveValue(title);
});

test("only the selected edited task is created and its omitted prerequisite and unresolved choice remain visible", async () => {
  const planning = await startManual("Observation export increment", "Export already-saved observations as a small file.");
  await planning.getByRole("button", { name: "Add task", exact: true }).click();
  await planning.getByLabel("Task 1 title", { exact: true }).fill("Agree an export format");
  await planning.getByLabel("Task 1 goal", { exact: true }).fill("Choose the first supported export format.");
  await planning.getByLabel("Task 1 acceptance criteria, one per line", { exact: true }).fill("The chosen format is written down.");
  await planning.getByRole("button", { name: "Add task", exact: true }).click();
  await planning.getByLabel("Task 2 title", { exact: true }).fill("Export one observation");
  await planning.getByLabel("Task 2 goal", { exact: true }).fill("Produce a file containing the selected observation.");
  await planning.getByLabel("Task 2 acceptance criteria, one per line", { exact: true }).fill("The exported file contains that observation.");
  await planning.getByLabel("Task 2 unresolved decisions, one per line", { exact: true }).fill("Which export format is the first increment using?");
  const second = planning.getByTestId("planning-item").nth(1);
  await second.getByLabel("Advisory prerequisite: Agree an export format", { exact: true }).check();
  await expect(planning.getByTestId("planning-item").first().getByRole("button", { name: "Discard task", exact: true })).toBeDisabled();
  await planning.getByRole("button", { name: "Save reviewed version", exact: true }).click();
  await planning.getByLabel("Save task 1", { exact: true }).uncheck();
  await expect(second).toContainText("A prerequisite is unselected");
  await expect(second).toContainText("Needs a decision");
  await planning.getByRole("button", { name: "Save selected drafts", exact: true }).click();
  await expect(second.getByRole("button", { name: "Open saved draft", exact: true })).toBeVisible();
  const records = await page.evaluate(() => window.nivra.listPlanning(null));
  const record = records.find((item) => item.request.brief.title === "Observation export increment")!;
  expect(record.saved.length).toBe(1);
  expect(record.saved[0]!.missingPrerequisites).toEqual([record.proposal!.items[0]!.id]);
  const tasks = await page.evaluate(() => window.nivra.listTasks());
  expect(tasks.tasks.length).toBe(2);
  expect(tasks.tasks.some((item) => item.title === "Agree an export format")).toBe(false);
  const task = await page.evaluate((id) => window.nivra.getTask(id), record.saved[0]!.taskId);
  expect(task.summary.state).toBe("draft");
  expect(task.brief.content.context).toContain("Needs a decision");
  expect(task.brief.content.context).toContain("Which export format is the first increment using?");
  expect(task.brief.content.context).toContain("Advisory prerequisites not selected");
  expect((await page.evaluate(() => window.nivra.getCompanionUsage())).used).toBe(0);
});

test("the companion transfers only the explicitly reviewed brief without spending a request or copying dialogue", async () => {
  await goTo(page, "home");
  await page.getByTestId("companion-launcher").click();
  await expect(page.getByTestId("companion-context")).toBeVisible();
  const marker = "temporary-dialogue-not-selected-for-planning-69";
  await page.getByTestId("companion-message").fill(marker);
  await page.getByTestId("companion-planning-open").click();
  await page.getByLabel("Planning brief title", { exact: true }).fill("Review observation filters");
  await page.getByLabel("Planning brief outcome", { exact: true }).fill("Find earlier observations by their label.");
  await page.getByLabel("Planning brief scope", { exact: true }).fill("Filter the already-saved list on this device.");
  await page.getByLabel("Planning brief constraints, one per line", { exact: true }).fill("Retain offline access.");
  await page.getByLabel("Planning brief decisions, one per line", { exact: true }).fill("Start with one label filter.");
  await page.getByTestId("companion-planning-transfer").click();
  await expect(page.getByTestId("companion-panel")).toBeHidden();
  const planning = page.getByTestId("planning-page");
  await expect(planning.getByLabel("Planning title", { exact: true })).toHaveValue("Review observation filters");
  await expect(planning.getByLabel("Desired outcome", { exact: true })).toHaveValue("Find earlier observations by their label.");
  await planning.getByRole("button", { name: "Save planning brief", exact: true }).click();
  await expect(planning.getByRole("button", { name: "Save reviewed version", exact: true })).toBeVisible();
  const records = await page.evaluate(() => window.nivra.listPlanning(null));
  const transferred = records.find((record) => record.request.brief.title === "Review observation filters")!;
  expect(transferred.request.brief.constraints).toEqual(["Retain offline access."]);
  expect(transferred.request.brief.decisions).toEqual(["Start with one label filter."]);
  expect(JSON.stringify(transferred.request).includes(marker)).toBe(false);
  expect((await page.evaluate(() => window.nivra.getCompanionUsage())).used).toBe(0);
  expect((await page.evaluate(() => window.nivra.listConversations())).conversations.length).toBe(0);
});
