import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { TASK_MODEL } from "@nivra/domain";
import { CHECK_IMAGE } from "../../engine/src/exec/check.ts";
import { TOOLCHAIN_SCRIPT } from "../../engine/src/task/scripts.ts";
import { TASK_FIX, TASK_FIXTURE } from "../../engine/scripts/task-fixture.ts";
import { RealGuest } from "../../engine/test/real-guest.ts";
import { startSandboxStub, type SandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { startStub, toolCall, type Stub } from "../../engine/test/stub-token-factory.ts";
import type { BriefFields } from "../src/shared/ipc.ts";

/**
 * A task run's recovery through the real host and engine (NIV-35): the built app, the production engine, and stand-ins
 * on this machine for Nebius Sandboxes and Token Factory, reached through the unpackaged-only switches.
 * - A cancel during the work sends nothing new.
 * - An engine killed mid-run reads the run as interrupted after Restart, and the recovery pass stops what it left.
 * - Quitting mid-run is timed, and the run reads as interrupted after a relaunch.
 * - A stale approval is refused in the engine's words.
 * - An apply held part way by `--nivra-test-apply-hold`, its engine killed, reads back as partial and is restored.
 * A packaged app ignores the switches, so these skip there; that it ignores the hold is test-switches.test.ts's.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const PROJECT_ID = "project-e00e2etaskrecovery";

let root: string;
let repo: string;
let hold: string;
let sandbox: SandboxStub<RealGuest>;
let model: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;
let taskId = "";
let launchArgs: string[] = [];
let executable: string | undefined;
/** Holds the model's next answers until released: the worker is then mid-work, waiting on its model call. */
let modelGate: Promise<void> | null = null;

const git = (args: string[]) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const greetPath = () => join(repo, "greet.sh");
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
const spawns = () => sandbox.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances").length;
const uploads = () => sandbox.requests.filter((request) => request.path === "/v1/files").length;
const toolchainOperations = () => sandbox.guest.service.operations.filter((operation) => (operation.body["args"] as string[] | undefined)?.[1] === TOOLCHAIN_SCRIPT);

async function launch(): Promise<void> {
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args: launchArgs, chromiumSandbox: true } : { args: [desktop, ...launchArgs], chromiumSandbox: true });
  page = await app.firstWindow();
}

/** The task, opened on its page. */
async function openTask(): Promise<void> {
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-open").click();
  await expect(page.getByTestId("task-state")).toHaveText("Ready");
}

/** What the task page says keeps Run from starting, if anything, for a failure's message. */
async function whyBlocked(): Promise<string> {
  await page.waitForTimeout(2_000);
  const blocked = page.getByTestId("task-run-blocked");
  return (await blocked.count()) ? `Run is blocked: ${await blocked.textContent()}` : "Run is disabled, with no reason shown";
}

/** Presses Run and Start on the run previewed; returns the new attempt's card once it is under way. */
async function startRun() {
  const card = page.getByTestId("task-attempt");
  const previous = (await card.count()) ? await card.getAttribute("data-attempt-id") : null;
  await expect(page.getByTestId("task-run"), await whyBlocked()).toBeEnabled();
  await page.getByTestId("task-run").click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("task-run-start").click();
  await expect(card).not.toHaveAttribute("data-attempt-id", previous ?? "", { timeout: 30_000 });
  return card;
}

/** A run to its proposed, verified change. */
async function proposedRun() {
  const card = await startRun();
  await expect(card).toHaveAttribute("data-status", "answered", { timeout: 60_000 });
  await expect(card.getByTestId("task-attempt-report")).toHaveAttribute("data-verified", "true");
  return card;
}

/** The local engine's process id, while it is online. */
const enginePid = () =>
  page.evaluate(async () => {
    const local = (await window.nivra.listEngines()).find((engine) => engine.targetId === "local");
    return local?.state.status === "online" ? local.state.info.pid : null;
  });

/** Kills the local engine, as a crash would, and presses the task page's Restart. */
async function killAndRestart(): Promise<void> {
  const pid = await enginePid();
  expect(pid).not.toBeNull();
  process.kill(pid!, "SIGKILL");
  await expect(page.getByTestId("task-engine-failed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("task-engine-restart")).toBeVisible();
  await page.getByTestId("task-engine-restart").click();
  await expect.poll(enginePid, { timeout: 30_000 }).not.toBeNull();
}

/** Approves the card's change and confirms it. */
async function approve(card: ReturnType<Page["getByTestId"]>): Promise<void> {
  await card.getByTestId("task-attempt-approve").click();
  await expect(page.getByTestId("task-apply-confirm-go")).toBeVisible();
  await page.getByTestId("task-apply-confirm-go").click();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e recovery ü%# "));
  repo = join(root, "greet");
  hold = join(root, "apply-hold");
  mkdirSync(repo, { recursive: true });
  for (const file of TASK_FIXTURE) writeFileSync(join(repo, file.path), String(file.bytes));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]);
  const guest = new RealGuest(CHECK_IMAGE.uuid);
  guest.busybox = true;
  sandbox = await startSandboxStub({ guest });
  const calls: Array<[string, Record<string, unknown>]> = [["read_file", { path: "greet.sh" }], ["edit_file", TASK_FIX], ["run_case", { number: 1 }], ["submit", { summary: "Defaulted the name to world." }]];
  model = await startStub({
    models: [{ id: TASK_MODEL, context_length: 131_072 }],
    chat: async (request) => {
      if (modelGate) await modelGate;
      const step = (request.body?.messages ?? []).filter((message) => (message as { role?: string }).role === "tool").length;
      const [tool, input] = calls[Math.min(step, calls.length - 1)]!;
      return toolCall(tool, input, { id: `call_${step}` });
    },
  });
  executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  launchArgs = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-sandboxes-url=${sandbox.url}`, `--nivra-token-factory-url=${model.url}`, `--nivra-test-apply-hold=${hold}`];
  await launch();
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
  if (packaged) return;
  await page.evaluate(async ([key, project]) => {
    await window.nivra.setNebiusKey(key!);
    await window.nivra.setNebiusProjectId(project!);
  }, [KEY, PROJECT_ID]);
  taskId = await page.evaluate(async (fields) => {
    const projectId = (await window.nivra.listProjects())[0]!.id;
    await window.nivra.setSharing(projectId, true);
    await window.nivra.setCloudExecution(projectId, true);
    const created = await window.nivra.createTask({ title: "Greet the world", fields, projectId, planId: null });
    return (await window.nivra.setTaskState(created.summary.id, created.revision, "ready")).summary.id;
  }, FIELDS);
  await openTask();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await sandbox?.close();
  await model?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("cancels a run while its worker waits on the model: it ends cancelled, and nothing new reaches either service after the cancel", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  let release!: () => void;
  modelGate = new Promise((resolve) => (release = resolve));
  const chats = model.chats().length;
  const card = await startRun();
  await expect.poll(() => model.chats().length, { timeout: 60_000 }).toBe(chats + 1);
  const sent = { spawns: spawns(), uploads: uploads(), chats: model.chats().length };
  // Esc never stops a run: only Stop does (NIV-56, G3).
  await page.keyboard.press("Escape");
  await expect(card).toHaveAttribute("data-status", "running");
  await expect(card.getByTestId("task-attempt-cancel")).toHaveText("Stop");
  await card.getByTestId("task-attempt-cancel").click();
  await expect(card).toHaveAttribute("data-status", "cancelled", { timeout: 60_000 });
  // The held request may still answer; nothing after the cancel was admitted: no operation, upload or model request.
  modelGate = null;
  release();
  expect({ spawns: spawns(), uploads: uploads(), chats: model.chats().length }).toEqual(sent);
  expect(readFileSync(greetPath(), "utf8")).toBe(ORIGINAL);
});

test("an engine killed while a run's operation goes reads the run as interrupted after Restart, and the recovery pass stops the operation it left", async () => {
  test.skip(packaged || process.platform === "win32", "needs the test endpoint switches, and a signal to kill the engine with");
  sandbox.guest.override = ({ args }) => (args[1] === TOOLCHAIN_SCRIPT ? { waits: true } : undefined);
  const before = toolchainOperations().length;
  const card = await startRun();
  await expect.poll(() => toolchainOperations().slice(before).some((operation) => operation.reads > 0), { timeout: 60_000 }).toBe(true);
  await killAndRestart();
  await expect(card).toHaveAttribute("data-status", "interrupted", { timeout: 60_000 });
  // The next engine's recovery pass, once it has the credentials, stops the operation the killed one left running.
  await expect.poll(() => toolchainOperations().slice(before).every((operation) => operation.cancelled), { timeout: 60_000 }).toBe(true);
  sandbox.guest.override = () => undefined;
  expect(readFileSync(greetPath(), "utf8")).toBe(ORIGINAL);
});

test("quitting while a run's operation goes closes the app, timed, and the run reads as interrupted after a relaunch", async ({}, testInfo) => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  sandbox.guest.override = ({ args }) => (args[1] === TOOLCHAIN_SCRIPT ? { waits: true } : undefined);
  const before = toolchainOperations().length;
  await startRun();
  await expect.poll(() => toolchainOperations().slice(before).some((operation) => operation.reads > 0), { timeout: 60_000 }).toBe(true);
  const quitting = performance.now();
  await app.close();
  const quitMs = Math.round(performance.now() - quitting);
  testInfo.annotations.push({ type: "quit-ms", description: String(quitMs) });
  console.log(`Quitting with a task run's operation going took ${quitMs} ms.`);
  // NIV-25's evidence: how long it takes, recorded; a quit that never ended would have failed the close above.
  expect(quitMs).toBeLessThan(60_000);
  await launch();
  await openTask();
  await expect(page.getByTestId("task-attempt")).toHaveAttribute("data-status", "interrupted", { timeout: 60_000 });
  await expect.poll(() => toolchainOperations().slice(before).every((operation) => operation.cancelled), { timeout: 60_000 }).toBe(true);
  sandbox.guest.override = () => undefined;
});

test("refuses a stale approval in the engine's words: a checkout edited after the run, then one moved to another commit", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switches");
  // Edited after the run: the approval is refused, and the edit is left as it is.
  const first = await proposedRun();
  writeFileSync(greetPath(), `${ORIGINAL}# an edit after the run\n`);
  await approve(first);
  await expect(first.getByTestId("task-apply")).toHaveAttribute("data-status", "refused", { timeout: 30_000 });
  await expect(first.getByTestId("task-apply-refusal")).toHaveAttribute("data-code", "uncommitted");
  expect(readFileSync(greetPath(), "utf8")).toBe(`${ORIGINAL}# an edit after the run\n`);
  git(["checkout", "--", "greet.sh"]);
  // A refused approval is settled before the next run, as a person would: the result dismissed, then the change
  // rejected, since the approval never took effect.
  await first.getByTestId("task-apply-dismiss").click();
  await expect(first.getByTestId("task-apply")).toHaveAttribute("data-resolution", "dismissed", { timeout: 30_000 });
  await first.getByTestId("task-attempt-reject").click();
  await expect(first.getByTestId("task-attempt-decision")).toHaveAttribute("data-decision", "rejected");
  // Moved to another commit after the run: refused too, nothing written.
  const second = await proposedRun();
  writeFileSync(join(repo, "NOTES.md"), "A note committed after the run.\n");
  git(["add", "NOTES.md"]);
  git(["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "a note"]);
  await approve(second);
  await expect(second.getByTestId("task-apply")).toHaveAttribute("data-status", "refused", { timeout: 30_000 });
  await expect(second.getByTestId("task-apply-refusal")).toHaveAttribute("data-code", "baseline-moved");
  expect(readFileSync(greetPath(), "utf8")).toBe(ORIGINAL);
  await second.getByTestId("task-apply-dismiss").click();
  await expect(second.getByTestId("task-apply")).toHaveAttribute("data-resolution", "dismissed", { timeout: 30_000 });
  await second.getByTestId("task-attempt-reject").click();
  await expect(second.getByTestId("task-attempt-decision")).toHaveAttribute("data-decision", "rejected");
});

test("an apply held before its new file is linked in, its engine killed, reads back as partial after Restart, and restoring puts the original back", async () => {
  test.skip(packaged || process.platform === "win32", "needs the test switches, and a signal to kill the engine with");
  const card = await proposedRun();
  writeFileSync(hold, "link 0\n");
  try {
    await approve(card);
    await expect.poll(() => existsSync(`${hold}.held`), { timeout: 30_000 }).toBe(true);
    // The original was moved aside; the new file wasn't linked in yet.
    expect(existsSync(greetPath())).toBe(false);
    unlinkSync(hold);
    await killAndRestart();
    const apply = card.getByTestId("task-apply");
    await expect(apply).toHaveAttribute("data-status", "partial", { timeout: 60_000 });
    await apply.getByTestId("task-apply-restore").click();
    if (await page.getByTestId("task-apply-confirm-go").isVisible().catch(() => false)) await page.getByTestId("task-apply-confirm-go").click();
    await expect(apply).toHaveAttribute("data-status", "not-applied", { timeout: 30_000 });
    expect(readFileSync(greetPath(), "utf8")).toBe(ORIGINAL);
  } finally {
    rmSync(hold, { force: true });
    rmSync(`${hold}.held`, { force: true });
  }
});
