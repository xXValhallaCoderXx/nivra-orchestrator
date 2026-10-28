import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { TASK_MODEL } from "@nivra/domain";
import { openSwitcher } from "./places.ts";
import { CHECK_IMAGE } from "../../engine/src/exec/check.ts";
import { FIXED_GREET, TASK_FIX, TASK_FIXTURE } from "../../engine/scripts/task-fixture.ts";
import { RealGuest } from "../../engine/test/real-guest.ts";
import { startSandboxStub, type SandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { startStub, toolCall, type Stub } from "../../engine/test/stub-token-factory.ts";
import type { BriefFields } from "../src/shared/ipc";

/**
 * Deciding on a run's change through the real UI, and applying it (NIV-8, NIV-13, D40). The built app reaches
 * stand-ins on this machine through its unpackaged-only switches, as `task-run.spec.ts` does; each run's model reads,
 * fixes, runs the case and hands in, from the start of its own conversation. One task, three runs: the first change
 * approved, applied to the checkout unstaged and accepted; the second rejected, the checkout untouched; the third sent
 * back for a revision, its note in the brief's next version. A packaged app ignores the switches, so these skip there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const PROJECT_ID = "project-e00e2etaskapply0";
const NOTE = "Keep the default name in one place.";

let root: string;
let repo: string;
let sandbox: SandboxStub<RealGuest>;
let model: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;
let taskId = "";

const git = (args: string[]) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const greet = () => readFileSync(join(repo, "greet.sh"), "utf8");
const ORIGINAL = String(TASK_FIXTURE.find((file) => file.path === "greet.sh")!.bytes);

const FIELDS: BriefFields = {
  goal: "greet with no name says Hello, world",
  acceptanceCriteria: ["check.sh passes"],
  scope: "",
  exclusions: "",
  context: "",
  assumptions: [],
  checks: ["/bin/sh check.sh"],
  acceptanceCases: [{ name: "greet with and without a name", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 }],
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e apply ü%# "));
  repo = join(root, "greet");
  mkdirSync(repo, { recursive: true });
  for (const file of TASK_FIXTURE) writeFileSync(join(repo, file.path), String(file.bytes));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]);
  const guest = new RealGuest(CHECK_IMAGE.uuid);
  guest.busybox = true;
  sandbox = await startSandboxStub({ guest });
  // Each run's worker, from its own first request: a step is one tool result back in the conversation.
  const calls: Array<[string, Record<string, unknown>]> = [["read_file", { path: "greet.sh" }], ["edit_file", TASK_FIX], ["run_case", { number: 1 }], ["submit", { summary: "Defaulted the name to world." }]];
  model = await startStub({
    models: [{ id: TASK_MODEL, context_length: 131_072 }],
    chat: (request) => {
      const step = (request.body?.messages ?? []).filter((message) => (message as { role?: string }).role === "tool").length;
      const [tool, input] = calls[Math.min(step, calls.length - 1)]!;
      return toolCall(tool, input, { id: `call_${step}` });
    },
  });
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-sandboxes-url=${sandbox.url}`, `--nivra-token-factory-url=${model.url}`];
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
  await sandbox?.close();
  await model?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Presses Run, starts the run previewed, and waits for the new run's card to show it ended. */
async function runOnce(): Promise<void> {
  const card = page.getByTestId("task-attempt");
  const previous = (await card.count()) ? await card.getAttribute("data-attempt-id") : null;
  await expect(page.getByTestId("task-run")).toBeEnabled();
  await page.getByTestId("task-run").click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("task-run-start").click();
  await expect(card).not.toHaveAttribute("data-attempt-id", previous ?? "", { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-status", "answered", { timeout: 60_000 });
  await expect(card.getByTestId("task-attempt-report")).toHaveAttribute("data-outcome", "proposed");
}

test("approves a verified change by its hash and applies it to the checkout, unstaged, the original kept; accepting it completes the task", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  await page.evaluate(async ([key, project]) => {
    await window.nivra.setNebiusKey(key!);
    await window.nivra.setNebiusProjectId(project!);
  }, [KEY, PROJECT_ID]);
  // The task, its consents and its readiness, set up through the app's own calls: the run and the decisions are the UI's.
  taskId = await page.evaluate(async (fields) => {
    const projectId = (await window.nivra.listProjects())[0]!.id;
    await window.nivra.setSharing(projectId, true);
    await window.nivra.setCloudExecution(projectId, true);
    const created = await window.nivra.createTask({ title: "Greet the world", fields, projectId, planId: null });
    return (await window.nivra.setTaskState(created.summary.id, created.revision, "ready")).summary.id;
  }, FIELDS);
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-open").click();
  await expect(page.getByTestId("task-state")).toHaveText("Ready");
  await runOnce();

  // Approve and apply: the change's hash and its commit shown first, then what applying does, before anything is written.
  const card = page.getByTestId("task-attempt");
  await expect(card.getByTestId("task-attempt-report")).toHaveAttribute("data-verified", "true");
  const hash = await page.evaluate(async ([task, attempt]) => (await window.nivra.getTaskAttempt(task!, attempt!)).proposal!.hash, [taskId, (await card.getAttribute("data-attempt-id"))!]);
  await expect(card.getByTestId("task-attempt-approve-what")).toContainText(`Change ${hash.slice(0, 12)}, made from commit ${git(["rev-parse", "HEAD"]).trim().slice(0, 12)}.`);
  expect(greet()).toBe(ORIGINAL);
  await card.getByTestId("task-attempt-approve").click();
  await expect(page.getByTestId("task-apply-confirm-go")).toBeVisible();
  expect(greet(), "nothing is written before the person confirms").toBe(ORIGINAL);
  await page.getByTestId("task-apply-confirm-go").click();

  const apply = card.getByTestId("task-apply");
  await expect(apply).toHaveAttribute("data-status", "applied", { timeout: 30_000 });
  await expect(card.getByTestId("task-attempt-decision")).toHaveAttribute("data-decision", "approved");
  await expect(apply.getByTestId("task-apply-status")).toHaveText("The change is applied to your checkout. Nothing is staged or committed.");
  await expect(apply.getByTestId("task-apply-path")).toHaveCount(1);
  await expect(apply.getByTestId("task-apply-path")).toHaveAttribute("data-place", "post");
  await expect(apply.getByTestId("task-apply-path")).toHaveAttribute("data-path", "greet.sh");
  const recovery = (await apply.getByTestId("task-apply-recovery").locator("code").textContent())!;
  expect(recovery).toMatch(/^nivra-apply\/[0-9a-f-]{36}$/);
  // The checkout: greet.sh fixed and left unstaged; its original kept in the repository's git folder.
  expect([greet(), git(["status", "--porcelain"]), git(["diff", "--cached", "--name-only"])]).toEqual([FIXED_GREET, " M greet.sh\n", ""]);
  expect(existsSync(join(repo, ".git", recovery))).toBe(true);

  // Accepting it completes the task, and the change stays. Every copy Nivra kept stays in the recovery folder, as the card
  // says, greet.sh's original among them, in case a program that had it open saves into it.
  await expect(apply.getByTestId("task-apply-dismiss")).toHaveCount(0);
  await apply.getByTestId("task-apply-accept").click();
  await expect(apply).toHaveAttribute("data-resolution", "accepted");
  await expect(apply.getByTestId("task-apply-resolution")).toHaveText("You accepted the change. The task is completed.");
  await expect(page.getByTestId("task-state")).toHaveText("Completed");
  await expect(apply.getByTestId("task-apply-recovery")).toContainText("Delete that folder when you no longer need them.");
  expect([greet(), readdirSync(join(repo, ".git", recovery)).sort(), readFileSync(join(repo, ".git", recovery, "orig-0"), "utf8")]).toEqual([FIXED_GREET, ["new-0", "orig-0"], ORIGINAL]);
  await expect(page.getByTestId("task-attempt-error")).toHaveCount(0);
});

test("rejects a second run's change: nothing is applied, the checkout untouched, and the list shows both runs newest first", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  // The accepted change undone by hand, so the next run starts from the commit again.
  git(["checkout", "--", "greet.sh"]);
  await page.getByTestId("task-reopen").click();
  await expect(page.getByTestId("task-state")).toHaveText("Draft");
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-state")).toHaveText("Ready");
  await runOnce();

  const card = page.getByTestId("task-attempt");
  await card.getByTestId("task-attempt-reject").click();
  await expect(card.getByTestId("task-attempt-decision")).toHaveAttribute("data-decision", "rejected");
  await expect(card.getByTestId("task-attempt-decision")).toContainText("Nothing was sent, and your checkout wasn't touched.");
  await expect(card.getByTestId("task-apply")).toHaveCount(0);
  await expect(card.getByTestId("task-attempt-approve")).toHaveCount(0);
  expect([greet(), git(["status", "--porcelain"])]).toEqual([ORIGINAL, ""]);
  expect(existsSync(join(repo, ".git", "nivra-apply", "lock"))).toBe(false);

  // Both runs, newest first: this one rejected, the first approved and accepted.
  const rows = page.getByTestId("task-attempt-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-decision", "rejected");
  await expect(rows.nth(1)).toHaveAttribute("data-decision", "approved");
  await expect(rows.nth(1)).toContainText("accepted");
  await expect(rows.first()).toContainText("Run 2: brief v1");
});

test("sends a third run's change back for a revision: the note goes into the brief's next version, and the next run is the person's to start", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  const before = await page.evaluate((id) => window.nivra.getTask(id), taskId);
  await runOnce();

  const card = page.getByTestId("task-attempt");
  await card.getByTestId("task-attempt-revise").click();
  await expect(card.getByTestId("task-attempt-revision-send")).toBeDisabled();
  await card.getByTestId("task-attempt-revision-note").fill(NOTE);
  await card.getByTestId("task-attempt-revision-send").click();
  await expect(card.getByTestId("task-attempt-decision")).toHaveAttribute("data-decision", "revision");
  await expect(card.getByTestId("task-attempt-revision-shown")).toHaveText(NOTE);

  // The brief's next version holds the note; nothing ran on its own, and the checkout is as it was.
  const after = await page.evaluate((id) => window.nivra.getTask(id), taskId);
  expect([after.brief.version, after.brief.content.context.includes(NOTE), after.attempts.length]).toEqual([before.brief.version + 1, true, before.attempts.length + 1]);
  await expect(page.getByTestId("task-versions")).toContainText(`v${after.brief.version}`);
  await expect(page.getByTestId("task-run")).toBeEnabled();
  expect([greet(), git(["status", "--porcelain"])]).toEqual([ORIGINAL, ""]);
  const rows = page.getByTestId("task-attempt-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute("data-decision", "revision");
});

test("in a narrow window the preview and the apply dialog fill it with their buttons in view, and the decision follows the result", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  // Narrower than the page's 48em breakpoint (NIV-56, G3: NW1, NW3): 820 by 900, the window's least width, at 125% zoom.
  // The design's 547 by 600 (150%) needs the shell's navigation to collapse below its own breakpoint, which today's
  // doesn't: the branch that lands second with Next B's shell checks that width too.
  const was = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return { size: win.getContentSize(), zoom: win.webContents.getZoomFactor() };
  });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(820, 900);
    win.webContents.setZoomFactor(1.25);
  });
  try {
    await expect.poll(() => page.evaluate(() => Math.round(window.innerWidth))).toBe(656);
    const card = page.getByTestId("task-attempt");
    const previous = await card.getAttribute("data-attempt-id");
    await page.getByTestId("task-run").click();
    const start = page.getByTestId("task-run-start");
    await expect(start).toBeEnabled({ timeout: 30_000 });
    await expect(start).toBeInViewport();
    await start.click();
    await expect(card).not.toHaveAttribute("data-attempt-id", previous ?? "", { timeout: 30_000 });
    await expect(card).toHaveAttribute("data-status", "answered", { timeout: 60_000 });
    // The decision comes right after the result, before the checks and the change; the bar keeps Approve in view.
    const order = await page.evaluate(() => {
      const at = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;
      const before = (a: string, b: string) => Boolean(at(a).compareDocumentPosition(at(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
      return [before("task-attempt-result", "task-attempt-decision-ask"), before("task-attempt-decision-ask", "task-attempt-change")];
    });
    expect(order).toEqual([true, true]);
    await expect(page.getByTestId("task-attempt-approve-bar")).toBeInViewport();
    // The bar's Approve opens the same confirmation, filling the window with Apply in view; Esc closes it, and nothing is written.
    await page.getByTestId("task-attempt-approve-bar").click();
    await expect(page.getByTestId("task-apply-confirm-go")).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-apply-confirm-go")).toBeHidden();
    expect([greet(), git(["status", "--porcelain"])]).toEqual([ORIGINAL, ""]);
    await card.getByTestId("task-attempt-reject").click();
    await expect(card.getByTestId("task-attempt-decision")).toHaveAttribute("data-decision", "rejected");
  } finally {
    await app.evaluate(({ BrowserWindow }, { size, zoom }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.webContents.setZoomFactor(zoom);
      win.setContentSize(size[0]!, size[1]!);
    }, was);
  }
});
