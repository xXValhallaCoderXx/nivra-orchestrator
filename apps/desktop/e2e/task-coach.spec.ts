import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { startSandboxStub, type SandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";
import { startTavilyStub, type TavilyStub } from "../../engine/test/stub-tavily.ts";
import type { BriefFields, TaskView } from "../src/shared/ipc";
import { seedMission, seedMissionReview } from "./seed-workspace.ts";

/**
 * The task readiness coach through the window (NIV-53): what a brief is missing, worked out without a model; a preview
 * of exactly what the coach reads, bound to what starts; a coaching played by a loopback stub of Token Factory, so no
 * real model is called; the person's ticked changes saved as the next brief version and nothing else; and an edit that
 * keeps its own base. Stubs of Nebius Sandboxes and Tavily stand by to show the coach reaches neither. A packaged app
 * ignores the stub switches, so there only the coaching with no key, which fails before any request, runs.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";
const COACH_TOOL = "submit_coaching";
const ANSWER = {
  summary: "The goal is clear. The criterion doesn't say what someone would see.",
  questions: [{ text: "Which unit should records use?", why: "The criterion needs one to check.", field: "acceptanceCriteria" }],
  changes: [
    { field: "goal", text: "Records compare finish times in one unit", reason: "Names the outcome.", refs: [] },
    { field: "acceptanceCriteria", reword: [{ item: 1, text: "A 5 km run logged in miles shows its record in kilometres" }], add: ["A run with no unit is left out"], reason: "Says what someone would see.", refs: ["G1", "C1"] },
    { field: "context", append: "Today, a run logged in miles is compared as if it were in kilometres.", reason: "Says what happens now.", refs: [] },
  ],
  suggestedChecks: [{ name: "Units", command: "pnpm --filter @sheetless/data test", expectedOutput: "", expectedExitCode: 0, reason: "Runs the suite." }],
  unknowns: ["Whether older runs store a unit."],
};
const VAGUE: BriefFields = { goal: "Fix the PR detection bug", acceptanceCriteria: ["It works"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
const CLEAR: BriefFields = {
  goal: "Add a CSV export to the task list",
  acceptanceCriteria: ["Exporting a list of 2 tasks downloads a file with a header row and 2 rows"],
  scope: "",
  exclusions: "",
  context: "",
  assumptions: [],
  checks: [],
  acceptanceCases: [{ name: "Exports two rows", command: "sh export.sh", expectedOutput: "id,title\n1,Ada\n2,Grace\n", expectedExitCode: 0 }],
};

// Each test builds on the one before (one profile, one key, the same tasks): see review.spec.ts.
test.describe.configure({ mode: "serial" });

let root: string;
let repo: string;
let model: Stub;
let sandbox: SandboxStub;
let tavily: TavilyStub;
let app: ElectronApplication;
let page: Page;
let packaged = false;
/** A task in a seeded mission, with four findings about it from a seeded review: the last one's detail holds the key. */
let missionTaskId: string;
/** The stub's next answers to the coach, as a test sets them. */
let script: () => Reply = () => toolCall(COACH_TOOL, ANSWER);

const isCoach = (request: StubRequest) => JSON.stringify(request.body?.messages ?? []).includes("Nivra coach role: task-readiness-coach");
const coachRequests = () => model.chats().filter(isCoach).length;
const listings = () => model.requests.filter((request) => request.path.endsWith("/models")).length;
const git = (args: string[]) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

async function launch(testInfo: TestInfo) {
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [
    `--user-data-dir=${join(root, "user data")}`,
    `--nivra-engine-home=${join(root, "engine home")}`,
    `--nivra-token-factory-url=${model.url}`,
    `--nivra-sandboxes-url=${sandbox.url}`,
    `--nivra-tavily-url=${tavily.url}`,
  ];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
}

async function createTask(title: string, fields: BriefFields, projectId: string | null = null): Promise<string> {
  const created = await page.evaluate(async (input) => window.nivra.createTask(input), { title, fields, projectId, planId: null });
  await openTask(created.summary.id);
  return created.summary.id;
}

async function openTask(taskId: string) {
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-open").click();
  await expect(page.locator(`[data-testid="task"][data-task-id="${taskId}"]`)).toBeVisible();
}

const taskView = (taskId: string) => page.evaluate(async (id) => window.nivra.getTask(id), taskId) as Promise<TaskView>;

/** Opens the coach's dialog from the page's Coach tab, waits for its preview, and starts it. */
async function askTheCoach() {
  await page.getByTestId("task-tab-coach").click();
  await page.getByTestId("coach-ask").click();
  await expect(page.getByTestId("coach-preview")).toBeVisible();
  await page.getByTestId("coach-start").click();
  await expect(page.getByTestId("coach-dialog")).toBeHidden();
}

const latestCoaching = () => page.getByTestId("coaching").first();

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e coach ü%# "));
  repo = join(root, "records");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Records\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]);
  // A mission and a review of it, put there through the workspace's own functions before the app opens it.
  mkdirSync(join(root, "user data"), { recursive: true });
  const workspace = join(root, "user data", "workspace.db");
  const seeded = seedMission(workspace, {
    mission: { name: "Trustworthy records", intendedUsers: "Runners", outcome: "Records compare like with like.", successCriteria: [], constraints: [], nonGoals: [] },
    tasks: [{ title: "Records keep their units", goal: "Store each run's unit with it", acceptanceCriteria: ["It works"] }],
  });
  missionTaskId = seeded.taskIds[0]!;
  const finding = (role: "architecture" | "risks", title: string, detail = "Older runs have no unit.") => ({ role, title, detail, recommendation: "Say what happens to them.", refs: ["T1"] });
  seedMissionReview(workspace, {
    missionId: seeded.missionId,
    taskIds: seeded.taskIds,
    findings: [finding("architecture", "Units aren't stored"), finding("architecture", "Two code paths compare times"), finding("risks", "Old records change"), finding("risks", "A pasted key", `Someone pasted ${KEY} into a note.`)],
  });
  model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: () => script() });
  sandbox = await startSandboxStub();
  tavily = await startTavilyStub(() => ({ status: 500, body: { error: "nothing here is for research" } }));
  await launch(testInfo);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await Promise.all([model?.close(), sandbox?.close(), tavily?.close()]);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("with no key, the preview still shows what the coach would read, and the engine refuses before any request", async () => {
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  const taskId = await createTask("Coach with no key", VAGUE);
  await askTheCoach();
  await expect(latestCoaching()).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
  await expect(page.getByTestId("coaching-note")).toContainText(/key/i);
  expect((await taskView(taskId)).brief.version).toBe(1);
  if (!packaged) expect([listings(), coachRequests()]).toEqual([0, 0]);
});

test("a clear small task shows that no basic gap was found, with its caveat, and asks nothing more", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  await page.evaluate(async (key) => window.nivra.setNebiusKey(key), KEY);
  await createTask("CSV export", CLEAR);
  await expect(page.getByTestId("coach-no-gaps")).toContainText("No basic gaps detected.");
  await expect(page.getByTestId("coach-no-gaps")).toContainText("They don't show that the brief is complete or correct.");
  await expect(page.getByTestId("coach-guidance-item")).toHaveCount(0);
});

test("a vague task: its gaps, the exact preview, one request, and only the ticked changes saved as v2, kept across a restart", async ({}, testInfo) => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  const taskId = await createTask("Personal records use one unit", VAGUE);
  await page.getByTestId("task-tab-coach").click();
  await expect(page.locator('[data-testid="coach-guidance-item"][data-code="criterion-vague"]')).toBeVisible();
  await expect(page.locator('[data-testid="coach-guidance-item"][data-code="current-behaviour"]')).toBeVisible();
  const sent = [listings(), coachRequests()];
  await page.getByTestId("coach-ask").click();
  await expect(page.getByTestId("coach-preview-text")).toContainText("C1. It works");
  await expect(page.getByTestId("coach-preview-limits")).toContainText("an estimate, not a cap");
  expect([listings(), coachRequests()]).toEqual(sent);
  await page.getByTestId("coach-start").click();
  await expect(latestCoaching()).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  expect([listings() - sent[0]!, coachRequests() - sent[1]!]).toEqual([1, 1]);

  // With the title being edited, a question's Update waits and says why, and the title's edit is left as it is.
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-rename").click();
  await page.getByTestId("task-title-input").fill("A title being edited");
  await expect(page.locator('[data-testid="coach-update-field"][data-field="acceptanceCriteria"]')).toBeDisabled();
  await expect(page.getByTestId("coach-update-blocked").first()).toHaveText("Save or cancel your other edit first.");
  await expect(page.getByTestId("task-title-input")).toHaveValue("A title being edited");
  await page.getByTestId("task-title-cancel").click();
  await expect(page.locator('[data-testid="coach-update-field"][data-field="acceptanceCriteria"]')).toBeEnabled();

  // A question opens the editor at its field, and an edit already open keeps what the person typed.
  await page.getByTestId("task-tab-brief").click();
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-goal").fill("My own goal, not saved yet");
  await page.getByTestId("task-tab-coach").click();
  await page.locator('[data-testid="coach-update-field"][data-field="acceptanceCriteria"]').click();
  await expect(page.getByTestId("brief-goal")).toHaveValue("My own goal, not saved yet");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("brief-criteria");
  await expect(page.getByTestId("coach-question")).toBeVisible();
  await expect(page.getByTestId("coach-save")).toBeDisabled();
  await expect(page.getByTestId("coach-save-blocked")).toHaveText("Save or cancel your brief edits first.");
  await page.getByTestId("task-brief-cancel").click();

  // The suggested check is text to copy with the keyboard, never part of the brief.
  await page.getByTestId("coach-check-text").selectText();
  await page.keyboard.press("Control+C");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain("pnpm --filter @sheetless/data test");

  await page.locator('[data-testid="coach-change"][data-field="acceptanceCriteria"]').getByTestId("coach-change-tick").check();
  await page.locator('[data-testid="coach-change"][data-field="context"]').getByTestId("coach-change-tick").check();
  await page.getByTestId("coach-save").click();
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v2");
  await expect(page.getByTestId("coach-applied")).toHaveText("Saved as v2 with 2 of 3 changes.");
  const saved = await taskView(taskId);
  expect([saved.brief.content.goal, saved.brief.content.acceptanceCriteria, saved.brief.content.context, saved.brief.content.acceptanceCases.length, saved.summary.state, saved.attempts.length]).toEqual([
    VAGUE.goal,
    ["A 5 km run logged in miles shows its record in kilometres", "A run with no unit is left out"],
    "Today, a run logged in miles is compared as if it were in kilometres.",
    0,
    "draft",
    0,
  ]);
  expect(coachRequests() - sent[1]!).toBe(1);

  await app.close();
  await launch(testInfo);
  await openTask(taskId);
  await expect(page.getByTestId("coach-applied")).toHaveText("Saved as v2 with 2 of 3 changes.");
  await expect(page.getByTestId("coaching")).toHaveCount(1);
  expect(coachRequests() - sent[1]!).toBe(1);
});

test("an answer proposing no change shows its summary and unknowns under No changes proposed", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  script = () => toolCall(COACH_TOOL, { summary: "I can't tell which unit records should use, so I'm not proposing a change yet.", unknowns: ["Which unit records use"] });
  await createTask("Unsure answer", VAGUE);
  await askTheCoach();
  await expect(latestCoaching()).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  await expect(page.getByTestId("coach-no-changes")).toHaveText("No changes proposed");
  await expect(page.getByTestId("coach-summary")).toContainText("I can't tell which unit");
  await expect(page.getByTestId("coach-unknowns")).toContainText("Which unit records use");
  await expect(page.getByTestId("coach-save")).toHaveCount(0);
});

test("a malformed answer and a cancel each leave the brief as it was, with one request each", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  script = () => text("Sure, here are my thoughts on the brief.");
  const taskId = await createTask("Malformed and cancelled", VAGUE);
  const before = coachRequests();
  await askTheCoach();
  await expect(latestCoaching()).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
  expect([(await taskView(taskId)).brief.version, coachRequests() - before]).toEqual([1, 1]);
  script = () => ({ ...toolCall(COACH_TOOL, ANSWER), delayMs: 15_000 });
  await askTheCoach();
  await expect.poll(() => coachRequests() - before, { timeout: 15_000 }).toBe(2);
  await page.getByTestId("coach-cancel").click();
  await expect(latestCoaching()).toHaveAttribute("data-status", "cancelled", { timeout: 30_000 });
  expect([(await taskView(taskId)).brief.version, coachRequests() - before]).toEqual([1, 2]);
  script = () => toolCall(COACH_TOOL, ANSWER);
});

test("a stale answer can't be saved after a manual edit, and says so", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  const taskId = await createTask("Edited after the answer", VAGUE);
  await askTheCoach();
  await expect(latestCoaching()).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  await page.getByTestId("task-tab-brief").click();
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-scope").fill("The records page");
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v2");
  await expect(page.getByTestId("coach-stale")).toContainText("Your brief changed since the coach read it: it read v1, and the brief is now at v2.");
  await expect(page.getByTestId("coach-save")).toBeDisabled();
  expect((await taskView(taskId)).brief.content.scope).toBe("The records page");
});

test("an edit keeps the revision it started from: a save made meanwhile, then a refresh, and the old draft is refused, its text kept", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  const taskId = await createTask("Two writers", VAGUE);
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-goal").fill("The old draft's goal");
  // Another save lands, and something on the page reads the task again.
  await page.evaluate(async (id) => {
    const task = await window.nivra.getTask(id);
    const { goal: _goal, acceptanceCriteria, scope, exclusions, context, assumptions, checks, acceptanceCases, baseline, frozen } = task.brief.content;
    await window.nivra.reviseBrief(id, task.revision, { goal: "The other writer's goal", acceptanceCriteria, scope, exclusions, context, assumptions, checks, acceptanceCases, baseline, frozen });
  }, taskId);
  await page.getByTestId("task-mark-ready").click();
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v2");
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-edit-conflict")).toContainText("This task changed since you started editing: brief v2 is saved now");
  await expect(page.getByTestId("brief-goal")).toHaveValue("The old draft's goal");
  const after = await taskView(taskId);
  expect([after.brief.version, after.brief.content.goal]).toEqual([2, "The other writer's goal"]);
  await page.getByTestId("task-edit-discard").click();
  await expect(page.getByTestId("brief-goal")).toHaveCount(0);
});

test("a project's task needs its sharing: the preview says so, Ask is off, and nothing is sent", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("nav-projects").click();
  await page.getByTestId("project-add").click();
  const projects = await page.evaluate(() => window.nivra.listProjects());
  const projectId = projects.find((project) => project.label === "records")!.id;
  const before = coachRequests();
  await createTask("A project's task", VAGUE, projectId);
  await page.getByTestId("task-tab-coach").click();
  await page.getByTestId("coach-ask").click();
  await expect(page.getByTestId("coach-preview-blocked")).toContainText("doesn't allow sending its content to Token Factory");
  await expect(page.getByTestId("coach-start")).toBeDisabled();
  await page.getByTestId("coach-dialog-cancel").click();
  expect(coachRequests()).toBe(before);
});

test("findings to tick: a fourth can't be ticked, and one that can't be sent leaves the choices there to untick", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  const before = coachRequests();
  await openTask(missionTaskId);
  await page.getByTestId("task-tab-coach").click();
  await page.getByTestId("coach-ask").click();
  await expect(page.getByTestId("coach-preview")).toBeVisible();
  const finding = (id: string) => page.locator(`[data-testid="coach-option-finding"][data-finding-id="${id}"]`);
  await expect(page.getByTestId("coach-option-finding")).toHaveCount(4);
  for (const id of ["arch-1", "arch-2", "risk-1"]) {
    await finding(id).check();
    await expect(page.getByTestId("coach-preview")).toBeVisible();
  }
  await expect(finding("risk-2")).toBeDisabled();
  await expect(page.getByTestId("coach-findings-limit")).toHaveText("At most 3 findings go with one coaching. Untick one to choose another.");
  await finding("arch-1").uncheck();
  await expect(finding("risk-2")).toBeEnabled();
  await expect(page.getByTestId("coach-findings-limit")).toBeHidden();
  // The fourth holds the saved key: its preview is refused, and the choices stay so it can be unticked.
  await finding("risk-2").check();
  await expect(page.getByTestId("coach-preview-error")).toContainText("detail holds");
  await expect(page.getByTestId("coach-preview")).toBeHidden();
  await expect(page.getByTestId("coach-option-finding")).toHaveCount(4);
  await finding("risk-2").uncheck();
  await expect(page.getByTestId("coach-preview")).toBeVisible();
  await expect(page.getByTestId("coach-preview-error")).toBeHidden();
  await expect(page.getByTestId("coach-preview-text")).toContainText("F2 (its review read brief v1): Old records change");
  await page.getByTestId("coach-dialog-cancel").click();
  expect(coachRequests()).toBe(before);
});

test("a completed task's coaching offers no editor and no save, and says to reopen it", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  const taskId = await createTask("Completed after the answer", VAGUE);
  await askTheCoach();
  await expect(latestCoaching()).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  for (const state of ["ready", "completed"] as const) {
    await page.evaluate(async ({ id, to }) => window.nivra.setTaskState(id, (await window.nivra.getTask(id)).revision, to), { id: taskId, to: state });
  }
  await openTask(taskId);
  await expect(page.getByTestId("task-state")).toHaveText("Completed");
  await expect(page.getByTestId("coach-update-field").first()).toBeDisabled();
  await expect(page.getByTestId("coach-update-blocked").first()).toHaveText("A completed task's brief can't change. Reopen it to change it.");
  await expect(page.getByTestId("coach-save")).toBeDisabled();
  await expect(page.getByTestId("coach-save-blocked")).toHaveText("A completed task's brief can't change. Reopen it to save these changes.");
  await expect(page.getByTestId("task-edit-brief")).toBeDisabled();
});

test("the coach reached no sandbox, no web search and no task run, and left the checkout as it was", async () => {
  test.skip(packaged, "a packaged app ignores the stub switches");
  expect([sandbox.requests.length, tavily.calls.length]).toEqual([0, 0]);
  const tasks = await page.evaluate(() => window.nivra.listTasks());
  const views = await Promise.all(tasks.tasks.map((task) => taskView(task.id)));
  expect(views.map((view) => view.attempts.length)).toEqual(views.map(() => 0));
  expect(git(["status", "--porcelain"])).toBe("");
});
