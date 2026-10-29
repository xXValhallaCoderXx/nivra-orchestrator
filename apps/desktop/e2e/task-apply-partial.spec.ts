import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { openSwitcher } from "./places.ts";
import type { BriefFields } from "../src/shared/ipc";

/**
 * A change applied in part, through the window (D40): what only an engine cut short, or a disk that failed part way,
 * produces, which the real engine's journey can't show on demand. The local engine is the gated stand-in
 * (`--nivra-test-engine=gated`, honoured only when unpackaged): it answers the run with a verified change, and the
 * apply with one file as the change leaves it and another moved aside, its original kept. The card says where each is,
 * offers only Restore, says why it doesn't offer keeping it as is, restores the originals, and then dismisses the
 * result, after which the change can be decided on again. A packaged app ignores the switch, so this skips there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATED_HASH = "5".repeat(64);
const FIELDS: BriefFields = {
  goal: "greet with no name says Hello, world",
  acceptanceCriteria: ["check.sh passes"],
  scope: "",
  exclusions: "",
  context: "",
  assumptions: [],
  checks: [],
  acceptanceCases: [{ name: "greet with and without a name", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 }],
};

let root: string;
let app: ElectronApplication;
let page: Page;
let packaged = false;

const home = () => join(root, "engine home");
const count = (method: string) => (existsSync(join(home(), "calls.log")) ? readFileSync(join(home(), "calls.log"), "utf8").split("\n").filter((call) => call === method).length : 0);

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e apply partial "));
  mkdirSync(join(root, "user data"), { recursive: true });
  mkdirSync(home(), { recursive: true });
  // A run that ends with a verified change, and an apply of it left in part, one file moved aside.
  for (const name of ["accept", "release", "task-report", "partial-apply", "aside-apply"]) writeFileSync(join(home(), name), "");
  const repo = join(root, "greet");
  mkdirSync(repo);
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${home()}`, "--nivra-test-engine=gated"];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("shows a change applied in part file by file, offers only restoring it while a file is moved aside, restores it, and dismisses the result", async () => {
  test.skip(packaged, "a packaged app ignores the test engine switch");
  await page.evaluate(async () => {
    await window.nivra.setNebiusKey("test-key-0123456789");
    await window.nivra.setNebiusProjectId("project-e00e2epartial000");
  });
  const taskId = await page.evaluate(async (fields) => {
    const projectId = (await window.nivra.listProjects())[0]!.id;
    await window.nivra.setSharing(projectId, true);
    await window.nivra.setCloudExecution(projectId, true);
    const created = await window.nivra.createTask({ title: "Greet the world", fields, projectId, planId: null });
    return (await window.nivra.setTaskState(created.summary.id, created.revision, "ready")).summary.id;
  }, FIELDS);
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-open").click();
  await page.getByTestId("task-run").click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("task-run-start").click();
  const card = page.getByTestId("task-attempt");
  await expect(card).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  await expect(card.getByTestId("task-attempt-approve-what")).toContainText(`Change ${GATED_HASH.slice(0, 12)}`);
  await card.getByTestId("task-attempt-approve").click();
  await page.getByTestId("task-apply-confirm-go").click();

  // Applied in part: one file as the change leaves it, one moved aside with its original kept and nothing in its place.
  const apply = card.getByTestId("task-apply");
  await expect(apply).toHaveAttribute("data-status", "partial", { timeout: 30_000 });
  await expect(apply.getByTestId("task-apply-status")).toContainText("moved aside with their original kept and nothing in their place");
  await expect(apply.locator('[data-testid="task-apply-path"][data-path="greet.sh"]')).toHaveAttribute("data-place", "post");
  await expect(apply.locator('[data-testid="task-apply-path"][data-path="README.md"]')).toHaveAttribute("data-place", "aside");
  await expect(apply.locator('[data-testid="task-apply-path"][data-path="README.md"]')).toContainText("moved aside: its original is kept, and nothing is in its place");
  // Only Restore: keeping it as is would leave README.md missing, and the card says why.
  await expect(apply.getByTestId("task-apply-keep")).toHaveCount(0);
  await expect(apply.getByTestId("task-apply-keep-unavailable")).toContainText("a file the change replaces is missing from your checkout, its original kept aside");
  await expect(apply.getByTestId("task-apply-restore")).toBeVisible();
  await expect(page.getByTestId("task-state")).toHaveText("In review");

  await apply.getByTestId("task-apply-restore").click();
  await expect(apply).toHaveAttribute("data-status", "not-applied", { timeout: 30_000 });
  await expect(apply.getByTestId("task-apply-status")).toHaveText("The change isn't applied: none of it is in your checkout.");
  expect(count("task.restore")).toBe(1);

  // Dismissed: the approval is taken back with it, and the change can be decided on again.
  await apply.getByTestId("task-apply-dismiss").click();
  await expect(apply).toHaveAttribute("data-resolution", "dismissed", { timeout: 30_000 });
  await expect(card.getByTestId("task-attempt-approve")).toBeVisible();
  await expect(page.locator('[data-testid="task-attempt-row"]')).toHaveAttribute("data-apply", "not-applied");
  await expect(page.locator('[data-testid="task-attempt-row"]')).toContainText("dismissed");
  expect([count("task.apply"), count("task.dismiss")]).toEqual([1, 1]);
});
