import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { CHECK_IMAGE } from "../../engine/src/exec/check.ts";
import { TASK_FIX, TASK_FIXTURE } from "../../engine/scripts/task-fixture.ts";
import { RealGuest } from "../../engine/test/real-guest.ts";
import { startSandboxStub, type SandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { startStub, toolCall, type Stub } from "../../engine/test/stub-token-factory.ts";

/**
 * A task run through the real UI (NIV-7, D39). The built app reaches stand-ins on this machine through its unpackaged-
 * only switches: Nebius Sandboxes, whose guest runs each command with this machine's tools, and Token Factory, whose
 * model reads, fixes, runs the case and hands in. An acceptance case written in the brief, the run's preview of what
 * goes where, the run, and what Nivra found, with the checkout untouched. A packaged app ignores the switches, so these
 * tests skip there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const PROJECT_ID = "project-e00e2etaskrun0";

let root: string;
let repo: string;
let sandbox: SandboxStub<RealGuest>;
let model: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;

const git = (args: string[]) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e task ü%# "));
  repo = join(root, "greet");
  mkdirSync(repo, { recursive: true });
  for (const file of TASK_FIXTURE) writeFileSync(join(repo, file.path), String(file.bytes));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]);
  const guest = new RealGuest(CHECK_IMAGE.uuid);
  guest.busybox = true;
  sandbox = await startSandboxStub({ guest });
  const calls: Array<[string, Record<string, unknown>]> = [["read_file", { path: "greet.sh" }], ["edit_file", TASK_FIX], ["run_case", { number: 1 }], ["submit", { summary: "Defaulted the name to world." }]];
  model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: (_request, index) => toolCall(calls[Math.min(index, calls.length - 1)]![0], calls[Math.min(index, calls.length - 1)]![1], { id: `call_${index}` }) });
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-sandboxes-url=${sandbox.url}`, `--nivra-token-factory-url=${model.url}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await sandbox?.close();
  await model?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("writes an acceptance case into a brief, previews what a run sends where, runs it, and shows what Nivra found, the checkout untouched", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  const greetBefore = readFileSync(join(repo, "greet.sh"), "utf8");
  await page.evaluate(async ([key, project]) => {
    await window.nivra.setNebiusKey(key!);
    await window.nivra.setNebiusProjectId(project!);
  }, [KEY, PROJECT_ID]);

  // The brief, with its repository check and one acceptance case written in the form.
  await page.getByTestId("nav-tasks").click();
  await page.getByTestId("tasks-new").click();
  await page.getByTestId("task-form-title").fill("Greet the world");
  await page.getByTestId("task-form-repository").click();
  await page.getByRole("option", { name: /^greet/ }).click();
  await page.getByTestId("brief-goal").fill("greet with no name says Hello, world");
  await page.getByTestId("brief-criteria").fill("check.sh passes");
  await page.getByTestId("brief-checks").fill("/bin/sh check.sh");
  await page.getByTestId("brief-case-add").click();
  await page.getByTestId("brief-case-name").fill("greet with and without a name");
  await page.getByTestId("brief-case-command").fill(". ./greet.sh; greet Ada; greet");
  await page.getByTestId("brief-case-output").fill("Hello, Ada\nHello, world");
  await expect(page.getByLabel("The output ends with a new line")).toBeChecked();
  await page.getByTestId("task-form-create").click();
  await expect(page.getByTestId("task-title")).toHaveText("Greet the world");
  await expect(page.getByTestId("task-brief-case")).toContainText(". ./greet.sh; greet Ada; greet");
  await expect(page.getByTestId("task-run")).toBeDisabled();
  await expect(page.getByTestId("task-run-blocked")).toHaveText("Mark the task ready first: a run needs a goal and at least one acceptance criterion.");
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-state")).toHaveText("Ready");

  // The preview: what goes to each service, what each keeps, how the result is judged, the bounds; nothing sent yet.
  // Neither consent is given yet: each is asked for in the preview, in its own dialog's words, and the start waits.
  await page.getByTestId("task-run").click();
  const preview = page.getByTestId("task-run-preview-body");
  await expect(preview.getByTestId("task-run-preview-snapshot")).toContainText("2 files");
  await expect(preview).toContainText("To Token Factory, as the project's sharing allows (off)");
  await expect(preview.getByTestId("task-run-ask-uploads")).toContainText("it is for this project only: its sandbox checks and its task runs");
  await expect(page.getByTestId("task-run-start")).toBeDisabled();
  await preview.getByTestId("task-run-allow-sharing").click();
  await expect(preview.getByTestId("task-run-ask-sharing")).toHaveCount(0);
  await preview.getByTestId("task-run-allow-uploads").click();
  await expect(preview.getByTestId("task-run-ask-uploads")).toHaveCount(0);
  await expect(preview).toContainText("To Token Factory, as the project's sharing allows (on)");
  await expect(preview).toContainText("To Nebius Sandboxes, as the project's uploads allow (on)");
  await expect(preview.getByTestId("task-run-preview-keeps")).toContainText("Nebius keeps each operation's arguments in its records, so what the worker writes stays there too.");
  await expect(preview.getByTestId("task-run-preview-judged")).toContainText("Case 1, greet with and without a name");
  await expect(preview.getByTestId("task-run-preview-judged")).toContainText("Check 1:");
  await expect(preview.getByTestId("task-run-preview-limits")).toContainText("(an estimate, not a cap)");
  // The case sources greet.sh, which the worker may change: the preview says the case judges only what it prints.
  await expect(preview.getByTestId("task-run-preview-case-files")).toContainText("Case 1 runs greet.sh, from the repository, which the worker can change. Nivra judges only what a case prints");
  await expect(preview.getByTestId("task-run-preview-blocked")).toHaveCount(0);
  expect([sandbox.requests.length, model.chats().length]).toEqual([0, 0]);
  // A double press starts one run: the dialog stays on screen while it fades, and its button takes the first only.
  await page.getByTestId("task-run-start").dblclick();

  // The run, and what Nivra found: every case and check judged, the worker's own account kept apart, the change shown.
  const attempt = page.getByTestId("task-attempt");
  await expect(attempt).toHaveAttribute("data-status", "answered", { timeout: 60_000 });
  const report = attempt.getByTestId("task-attempt-report");
  await expect(report).toHaveAttribute("data-outcome", "proposed");
  await expect(report).toHaveAttribute("data-verified", "true");
  await expect(report.getByTestId("task-attempt-verdict")).toContainText("Every acceptance case passed: the change is verified.");
  await expect(report.getByTestId("task-attempt-check")).toHaveCount(2);
  for (const row of await report.getByTestId("task-attempt-check").all()) await expect(row).toHaveAttribute("data-verdict", "passed");
  await expect(report.getByTestId("task-attempt-check-files")).toHaveText("The change also changes greet.sh, which this case runs: Nivra judged only what it printed.");
  await expect(report.getByTestId("task-attempt-summary")).toHaveText("The worker's own account, which Nivra didn't check: Defaulted the name to world.");
  await expect(report.getByTestId("task-attempt-patch")).toContainText(`printf 'Hello, %s\\n' "\${1:-world}"`);
  await expect(report.getByTestId("task-attempt-cleanup")).toContainText("Nebius keeps 1 upload");
  await expect(attempt.getByTestId("task-attempt-progress")).toContainText("Final checks: case 1 passed, check 1 passed");
  await expect(page.getByTestId("task-run-error")).toHaveCount(0);

  // One run, one upload, every operation with networking off; the checkout as it was.
  expect(sandbox.requests.filter((request) => request.path === "/v1/files").length).toBe(1);
  expect(sandbox.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances").every((request) => (JSON.parse(request.body) as { networking: { enabled: boolean } }).networking.enabled === false)).toBe(true);
  expect([readFileSync(join(repo, "greet.sh"), "utf8"), git(["status", "--porcelain"])]).toEqual([greetBefore, ""]);
  const tasks = await page.evaluate(() => window.nivra.listTasks());
  const view = await page.evaluate((taskId) => window.nivra.getTask(taskId), tasks.tasks[0]!.id);
  expect(view.attempts.map((one) => [one.status, one.briefVersion])).toEqual([["answered", 1]]);
});
