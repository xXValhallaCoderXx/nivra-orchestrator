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


test("first-save proposal validation keeps one record and retains the edited selection through navigation", async () => {
  await goTo(page, "tasks");
  await page.getByRole("button", { name: "Break into tasks", exact: true }).click();
  const planning = page.getByTestId("planning-page");
  const title = "Validate before keeping observation drafts";
  await planning.getByLabel("Planning title", { exact: true }).fill(title);
  await planning.getByLabel("Desired outcome", { exact: true }).fill("Keep the selected observation work for review.");
  await planning.getByRole("button", { name: "Plan manually", exact: true }).click();
  await planning.getByRole("button", { name: "Add task", exact: true }).click();
  await planning.getByLabel("Task 1 title", { exact: true }).fill("Keep one observation");
  await planning.getByLabel("Task 1 goal", { exact: true }).fill("Reopen one saved observation.");
  await planning.getByRole("button", { name: "Add task", exact: true }).click();
  await planning.getByLabel("Task 2 title", { exact: true }).fill("An incomplete proposed task");
  await planning.getByLabel("Save task 2", { exact: true }).uncheck();
  await planning.getByRole("button", { name: "Save planning brief", exact: true }).click();
  await expect(planning.getByTestId("planning-error")).toBeVisible();
  const afterFailure = (await page.evaluate(() => window.nivra.listPlanning(null))).filter((record) => record.request.brief.title === title);
  expect(afterFailure.length).toBe(1);
  await expect(planning.getByLabel("Task 2 title", { exact: true })).toHaveValue("An incomplete proposed task");
  await expect(planning.getByLabel("Save task 2", { exact: true })).not.toBeChecked();
  await planning.getByLabel("Task 2 goal", { exact: true }).fill("Review a second observation without saving it yet.");
  await planning.getByRole("button", { name: "Save reviewed version", exact: true }).click();
  await expect(planning.getByTestId("planning-error")).toBeHidden();
  await expect(planning.getByLabel("Save task 1", { exact: true })).toBeChecked();
  await expect(planning.getByLabel("Save task 2", { exact: true })).not.toBeChecked();
  const afterCorrection = (await page.evaluate(() => window.nivra.listPlanning(null))).filter((record) => record.request.brief.title === title);
  expect(afterCorrection.length).toBe(1);
  expect(afterCorrection[0]!.id).toBe(afterFailure[0]!.id);
  expect(afterCorrection[0]!.proposal!.items[1]!.goal).toBe("Review a second observation without saving it yet.");
  await goTo(page, "tasks");
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(planning.getByLabel("Save task 1", { exact: true })).toBeChecked();
  await expect(planning.getByLabel("Save task 2", { exact: true })).not.toBeChecked();
});

test("a valid first save preserves selection and an unchanged remainder can be explicitly reviewed and saved", async () => {
  await goTo(page, "tasks");
  await page.getByRole("button", { name: "Break into tasks", exact: true }).click();
  const planning = page.getByTestId("planning-page");
  const title = "Save observation work in two reviews";
  await planning.getByLabel("Planning title", { exact: true }).fill(title);
  await planning.getByLabel("Desired outcome", { exact: true }).fill("Save two reviewed tasks in separate increments.");
  await planning.getByRole("button", { name: "Plan manually", exact: true }).click();
  for (let index = 1; index <= 2; index++) {
    await planning.getByRole("button", { name: "Add task", exact: true }).click();
    await planning.getByLabel(`Task ${index} title`, { exact: true }).fill(`Observation increment ${index}`);
    await planning.getByLabel(`Task ${index} goal`, { exact: true }).fill(`Keep observation increment ${index} separate.`);
  }
  await planning.getByLabel("Save task 2", { exact: true }).uncheck();
  await planning.getByRole("button", { name: "Save planning brief", exact: true }).click();
  await expect(planning.getByLabel("Save task 1", { exact: true })).toBeChecked();
  await expect(planning.getByLabel("Save task 2", { exact: true })).not.toBeChecked();
  const save = planning.getByRole("button", { name: "Save selected drafts", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(planning.getByRole("button", { name: "Open saved draft", exact: true })).toHaveCount(1);
  await expect(planning.getByLabel("Save task 2", { exact: true })).not.toBeChecked();
  await planning.getByLabel("Save task 2", { exact: true }).check();
  await expect(save).toBeDisabled();
  const first = (await page.evaluate(() => window.nivra.listPlanning(null))).find((record) => record.request.brief.title === title)!;
  await planning.getByRole("button", { name: "Review remaining tasks", exact: true }).click();
  await expect(save).toBeEnabled();
  const reviewed = await page.evaluate((id) => window.nivra.getPlanning(id), first.id);
  expect(reviewed.revision).toBe(first.revision + 1);
  expect(reviewed.proposal).toEqual(first.proposal);
  await save.click();
  await expect(planning.getByRole("button", { name: "Open saved draft", exact: true })).toHaveCount(2);
  await expect(planning.getByTestId("planning-error")).toBeHidden();
  const saved = await page.evaluate((id) => window.nivra.getPlanning(id), first.id);
  expect(saved.saved.length).toBe(2);
  expect(new Set(saved.saved.map((item) => item.taskId)).size).toBe(2);
  expect(saved.saved[0]!.taskId).toBe(first.saved[0]!.taskId);
});

test("a companion handoff replaces an already-open unsaved planner with the newly reviewed brief", async () => {
  await goTo(page, "tasks");
  await page.getByRole("button", { name: "Break into tasks", exact: true }).click();
  const planning = page.getByTestId("planning-page");
  await planning.getByLabel("Planning title", { exact: true }).fill("An older unsaved planner");
  await planning.getByLabel("Desired outcome", { exact: true }).fill("This is the previous form.");
  for (const title of ["Transferred observation sorting", "Transferred observation search"]) {
    await page.getByTestId("companion-launcher").click();
    const handoff = page.getByTestId("companion-planning-open");
    if (await handoff.getAttribute("aria-expanded") !== "true") await handoff.click();
    await page.getByLabel("Planning brief title", { exact: true }).fill(title);
    await page.getByLabel("Planning brief outcome", { exact: true }).fill(`Review ${title.toLowerCase()}.`);
    await page.getByTestId("companion-planning-transfer").click();
    await expect(planning.getByLabel("Planning title", { exact: true })).toHaveValue(title);
    await expect(planning.getByLabel("Desired outcome", { exact: true })).toHaveValue(`Review ${title.toLowerCase()}.`);
  }
  await planning.getByRole("button", { name: "Save planning brief", exact: true }).click();
  await expect(planning.getByRole("button", { name: "Save reviewed version", exact: true })).toBeVisible();
  const records = await page.evaluate(() => window.nivra.listPlanning(null));
  expect(records.some((record) => record.request.brief.title === "An older unsaved planner")).toBe(false);
  expect(records.some((record) => record.request.brief.title === "Transferred observation sorting")).toBe(false);
  expect(records.filter((record) => record.request.brief.title === "Transferred observation search").length).toBe(1);
  expect((await page.evaluate(() => window.nivra.getCompanionUsage())).used).toBe(0);
});
