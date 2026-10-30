import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { png, pdf } from "../test/fixtures/reference-files.ts";
import { goTo, openSwitcher } from "./places.ts";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
let app: ElectronApplication, page: Page, root: string, taskId: string;
test.beforeAll(async ({}, info) => {
  root = mkdtempSync(join(tmpdir(), "nivra discussion acceptance "));
  const executable = info.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow(); await expect(page.getByTestId("home-title")).toBeVisible();
  taskId = await page.evaluate(async () => (await window.nivra.createTask({ title: "Discussion acceptance", projectId: null, planId: null, fields: { goal: "Review supporting files", acceptanceCriteria: ["The preview matches"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [{ name: "Case", command: "printf ok", expectedOutput: "ok", expectedExitCode: 0 }] } })).summary.id);
  await goTo(page, "tasks"); await page.getByRole("button", { name: "Discussion acceptance", exact: true }).click();
});
test.afterAll(async () => { await app?.close(); if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
async function picked(path: string) { await app.evaluate(async ({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, path); }
async function newTask(title: string) {
  const id = await page.evaluate(async (title) => (await window.nivra.createTask({ title, projectId: null, planId: null, fields: { goal: "Review references", acceptanceCriteria: ["The context is usable"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] } })).summary.id, title);
  await goTo(page, "tasks"); await page.getByRole("button", { name: title, exact: true }).click(); return id;
}
test("comments, prepared images, text-only PDF extraction and project moves through the packaged bridge", async () => {
  const panel = page.getByTestId("task-discussion"); await expect(panel).toBeVisible();
  const revision = await page.evaluate(async (id) => (await window.nivra.getTask(id)).revision, taskId);
  await panel.getByLabel("Add a comment", { exact: true }).fill("Compare the selected reference with the approved brief."); await panel.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(panel).toContainText("Compare the selected reference");
  expect(await page.evaluate(async (id) => (await window.nivra.getTask(id)).revision, taskId)).toBe(revision);
  const note = join(root, "reference.md"); writeFileSync(note, "The exact supporting text."); await picked(note); await panel.getByRole("button", { name: "Attach reference file", exact: true }).click();
  await expect(panel.getByLabel("Include reference.md", { exact: true })).not.toBeChecked(); await panel.getByLabel("Include reference.md", { exact: true }).check();
  const image = join(root, "reference.png"); writeFileSync(image, png()); await picked(image); await panel.getByRole("button", { name: "Attach reference file", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible(); await expect(page.getByRole("dialog").locator("img")).toBeVisible(); await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await panel.getByLabel("Include reference.png", { exact: true }).check();
  const document = join(root, "reference.pdf"); writeFileSync(document, pdf("Packaged PDF extraction works")); await picked(document); await panel.getByRole("button", { name: "Attach reference file", exact: true }).click();
  await expect(panel.getByLabel("Include reference.pdf", { exact: true })).toBeEnabled(); await panel.getByLabel("Include reference.pdf", { exact: true }).check(); await panel.getByRole("button", { name: "Review included context", exact: true }).click();
  const context = panel.getByTestId("included-task-context"); await context.locator("summary").click(); await expect(context).toContainText("Packaged PDF extraction works"); await expect(context).toContainText("PDF text only"); await expect(context.locator("img")).toBeVisible();
  const binding = await page.evaluate(async (id) => {
    const references = await window.nivra.previewTaskReferences(id), companion = await window.nivra.getCompanionContext({ taskId: id });
    return { reference: references.digest, companion: companion.references?.digest, attachments: references.attachments.length, image: references.attachments.find((item) => item.image)?.image?.base64 };
  }, taskId);
  expect(binding.companion).toBe(binding.reference); expect(binding.attachments).toBe(3); expect(binding.image!.length).toBeGreaterThan(20);
  await panel.getByLabel("Include comment", { exact: true }).uncheck();
  expect(await page.evaluate(async (id) => (await window.nivra.previewTaskReferences(id)).comments.length, taskId)).toBe(0);
  const repo = join(root, "repository"); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Source-only acceptance fixture.\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "README.md"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "fixture"]]) expect(spawnSync("git", args, { cwd: repo }).status).toBe(0);
  await picked(repo); await openSwitcher(page); await page.getByTestId("project-add").click(); await expect.poll(async () => (await page.evaluate(() => window.nivra.listProjects())).length).toBe(1);
  await page.evaluate(async (id) => { const project = (await window.nivra.listProjects())[0]!, task = await window.nivra.getTask(id); await window.nivra.setTaskProject(id, task.revision, project.id); }, taskId);
  await goTo(page, "tasks"); await page.getByRole("button", { name: "Discussion acceptance", exact: true }).click();
  await expect(panel).toContainText("Project changed. Your attachments are still here. Select which ones to include again.");
  expect(await page.evaluate(async (id) => (await window.nivra.getTaskDiscussion(id)).selection.attachmentIds.length, taskId)).toBe(0);
  await panel.getByLabel("Include reference.png", { exact: true }).check();
  const first = await page.evaluate(async (id) => { const task = await window.nivra.getTask(id); await window.nivra.setTaskState(id, task.revision, "ready"); return window.nivra.previewTaskRun(id); }, taskId);
  expect(first.references?.attachments.length).toBe(1); expect(first.blocked).not.toBeNull();
});
test("individual exclusions recover an oversized discussion without resetting the checkbox", async () => {
  const id = await newTask("Oversized discussion");
  await page.evaluate(async (id) => { for (let n = 0; n < 5; n++) await window.nivra.addTaskComment(id, String(n).repeat(8000)); }, id);
  const panel = page.getByTestId("task-discussion"), comments = panel.getByLabel("Include comment", { exact: true }); await expect(comments).toHaveCount(5);
  await comments.nth(0).uncheck();
  await expect.poll(() => page.evaluate(async (id) => (await window.nivra.getTaskDiscussion(id)).selection.excludedCommentIds.length, id)).toBe(1);
  await panel.getByRole("button", { name: "Review included context", exact: true }).click(); await expect(panel).toContainText("24,000"); await expect(comments.nth(0)).not.toBeChecked();
  await comments.nth(1).uncheck();
  await expect.poll(() => page.evaluate(async (id) => (await window.nivra.getTaskDiscussion(id)).selection.excludedCommentIds.length, id)).toBe(2);
  await panel.getByRole("button", { name: "Review included context", exact: true }).click(); await expect(panel.getByTestId("included-task-context")).toContainText("3 comments");
  expect(await page.evaluate(async (id) => (await window.nivra.previewTaskReferences(id)).comments.reduce((n, comment) => n + comment.text.length, 0), id)).toBe(24_000);
});
test("failed removal keeps a cleanup retry, and deleting the task removes unselected private copies and receipts", async () => {
  const id = await newTask("Cleanup retry"), panel = page.getByTestId("task-discussion");
  const path = join(root, "cleanup.md"); writeFileSync(path, "Private copied text"); await picked(path); await panel.getByRole("button", { name: "Attach reference file", exact: true }).click();
  const item = panel.getByTestId("task-attachment").filter({ hasText: "cleanup.md" }); await expect(item).toBeVisible(); await item.getByLabel("Include cleanup.md", { exact: true }).check();
  const asset = await page.evaluate(async (id) => (await window.nivra.getTaskDiscussion(id)).attachments[0]!, id);
  const userData = await app.evaluate(({ app }) => app.getPath("userData")), folder = join(userData, "task-assets", "unassigned", id), prepared = join(folder, asset.id, "prepared.txt");
  rmSync(prepared); mkdirSync(prepared); writeFileSync(join(prepared, "obstruction"), "Blocked private file");
  await item.getByRole("button", { name: "Remove", exact: true }).click(); await expect(item.getByRole("button", { name: "Retry file cleanup", exact: true })).toBeVisible();
  expect(await page.evaluate(async (id) => (await window.nivra.getTaskDiscussion(id)).selection.attachmentIds.length, id)).toBe(0);
  rmSync(prepared, { recursive: true }); await item.getByRole("button", { name: "Retry file cleanup", exact: true }).click(); await expect(item.getByRole("button", { name: "Retry file cleanup", exact: true })).toHaveCount(0);
  const other = join(root, "unselected.md"); writeFileSync(other, "Never selected or sent"); await picked(other); await panel.getByRole("button", { name: "Attach reference file", exact: true }).click(); await expect(panel.getByLabel("Include unselected.md", { exact: true })).not.toBeChecked();
  await page.getByTestId("task-more").click(); await page.getByTestId("task-delete").click(); await page.getByTestId("task-delete-confirm").click();
  await expect.poll(() => existsSync(folder)).toBe(false); expect(existsSync(path)).toBe(true); expect(existsSync(other)).toBe(true);
});
