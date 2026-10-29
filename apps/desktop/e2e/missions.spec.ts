import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { openSwitcher } from "./places.ts";
import { startStub, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";

/**
 * Missions through the window (NIV-52): a mission written with no repository, a backlog and its board, a review of
 * selected tasks previewed exactly and started only as previewed, two reviewers and a chair played by a loopback stub of
 * Token Factory (no real model), findings linked to the tasks they name, the task opened on its own page and edited by
 * hand, stale reports, rejected output shown as such, and a relaunch. A packaged app ignores the stub switch, so there
 * only the parts that need no model run.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-key-0123456789";

test.describe.configure({ mode: "serial" });

let root: string;
let stub: Stub;
let app: ElectronApplication;
let page: Page;
let packaged = false;

type Role = "architecture" | "risks" | "single" | "chair";
const roleOf = (request: StubRequest): Role | null => (/Nivra review role: (architecture|risks|single|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1] as Role | undefined) ?? null;
const finding = (title: string, refs: string[]) => ({ title, detail: `${title}, in detail.`, recommendation: `Act on: ${title}.`, severity: "medium", refs });
const COUNCIL: Record<Role, Reply> = {
  architecture: toolCall("submit_review", {
    summary: "The weekly total depends on stored runs, which come later in the order.",
    findings: [finding("Weekly total needs stored runs first", ["T2", "T1"])],
    assumptions: [],
    gaps: [],
  }),
  risks: toolCall("submit_review", {
    summary: "Nothing says how a lost run is noticed, and no task covers sync.",
    findings: [finding("No check for a run lost on restart", ["T1"]), finding("Nothing covers syncing between phones", ["backlog"])],
    assumptions: [],
    gaps: [],
  }),
  single: toolCall("submit_review", { summary: "Unused.", findings: [], assumptions: [], gaps: [] }),
  chair: toolCall("submit_synthesis", { summary: "Store runs before totals, and decide about sync.", priorities: ["arch-1", "risk-1"], agreements: [], dissent: [], gaps: [] }),
};
/** A test sets a role's reply here for the reviews it starts, and clears it after. */
let script: Partial<Record<Role, Reply>> = {};
const reviewRequests = () => stub.chats().filter((request) => roleOf(request) !== null);

async function launch(testInfo: TestInfo) {
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-token-factory-url=${stub.url}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
}

function makeRepo(path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# Linked\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

async function openMission(name: string) {
  await page.getByTestId("nav-missions").click();
  await page.getByTestId("mission-open").filter({ hasText: name }).click();
  await expect(page.getByTestId("mission-content")).toBeVisible();
}

const row = (title: string) => page.getByTestId("backlog-row").filter({ hasText: title });

/** Selects the given tasks, opens the review's preview, and starts it once the preview is in. */
async function reviewTasks(titles: string[]) {
  for (const title of titles) await row(title).getByTestId("backlog-select").check();
  await page.getByTestId("mission-review-open").click();
  await expect(page.getByTestId("mission-preview-text")).toBeVisible();
  await page.getByTestId("mission-review-start").click();
  await expect(page.getByTestId("mission-review-dialog")).toBeHidden();
}

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e missions ü%# "));
  makeRepo(join(root, "linked"));
  stub = await startStub({ chat: (request) => script[roleOf(request) ?? "single"] ?? COUNCIL[roleOf(request) ?? "single"] });
  await launch(testInfo);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await stub?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("a mission is written with no repository, saved in versions, and given a backlog that the board shows by state", async () => {
  await page.getByTestId("nav-missions").click();
  await expect(page.getByTestId("missions-empty")).toBeVisible();
  await page.getByTestId("missions-new").click();
  await page.getByTestId("mission-name").fill("Runner's log");
  await page.getByTestId("mission-save").click();
  await expect(page.getByTestId("mission-error")).toHaveText("A mission needs its outcome: what is true once it's done. Write it, then save it.");
  await page.getByTestId("mission-outcome").fill("A runner sees this week's distance against their plan.");
  await page.getByTestId("mission-users").fill("Club runners who log three runs a week.");
  await page.getByTestId("mission-success").fill("Shows within a second of opening\n\n");
  await page.getByTestId("mission-save").click();
  await expect(page.getByTestId("mission-content")).toContainText("A runner sees this week's distance against their plan.");
  await page.getByTestId("mission-edit").click();
  await page.getByTestId("mission-non-goals").fill("Social features");
  await page.getByTestId("mission-save").click();
  await expect(page.getByTestId("mission-content")).toContainText("Social features");
  for (const title of ["Store runs", "Weekly total", "Sync between phones"]) {
    await page.getByTestId("backlog-new-title").fill(title);
    await page.getByTestId("backlog-new").click();
    await expect(row(title)).toBeVisible();
  }
  await expect(page.locator('[data-testid="board-column"][data-state="draft"] [data-testid="board-card"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="board-column"][data-state="ready"] [data-testid="board-card"]')).toHaveCount(0);
  // A mission's own conversation is never one of the person's.
  const listed = await page.evaluate(() => window.nivra.listConversations());
  expect(listed.conversations).toEqual([]);
  const missions = await page.evaluate(() => window.nivra.listMissions());
  expect(missions.missions.map((mission) => [mission.name, mission.version, mission.tasks])).toEqual([["Runner's log", 2, 3]]);
});

test("a repository-linked task stays on the board but can't be selected, and says why", async () => {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, join(root, "linked"));
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("project-select")).toHaveValue("linked");
  const projectId = (await page.evaluate(() => window.nivra.listProjects()))[0]!.id;
  const fields = { goal: "Show the repo's runs.", acceptanceCriteria: ["They show."], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
  await page.evaluate(({ fields, projectId }) => window.nivra.createTask({ title: "Import old runs", fields, projectId, planId: null }), { fields, projectId });
  await openMission("Runner's log");
  await page.getByTestId("backlog-add-existing").click();
  await page.getByRole("option", { name: "Import old runs" }).click();
  await expect(row("Import old runs")).toBeVisible();
  await expect(row("Import old runs").getByTestId("backlog-select")).toBeDisabled();
  await expect(row("Import old runs").getByTestId("backlog-note")).toContainText("Mission reviews take only tasks that aren't linked to a repository, for now, and this one is.");
  await row("Import old runs").getByTestId("backlog-remove").click();
  await expect(row("Import old runs")).toHaveCount(0);
});

test("a review's preview shows exactly what it sends, who reads it and what it doesn't; with no key it fails before any request", async () => {
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
  await openMission("Runner's log");
  await row("Store runs").getByTestId("backlog-select").check();
  await row("Weekly total").getByTestId("backlog-select").check();
  await page.getByTestId("mission-review-open").click();
  const text = page.getByTestId("mission-preview-text");
  await expect(text).toContainText("The mission (mission):\nName: Runner's log");
  await expect(text).toContainText("Non-goals:\n- Social features");
  await expect(text).toContainText("The selected tasks: T1 to T2. The backlog holds 1 other task, which wasn't sent.");
  await expect(text).toContainText("T1. Store runs");
  await expect(text).toContainText("T2. Weekly total");
  await expect(text).not.toContainText("Sync between phones");
  await expect(page.getByTestId("mission-preview-scope")).toContainText("No repository: nothing is read from any folder.");
  await expect(page.getByTestId("mission-preview-preferences")).toHaveText("No preferences go with it: you have no confirmed personal ones.");
  await expect(page.getByTestId("mission-preview-specialists")).toContainText("Product architect (v1)");
  await expect(page.getByTestId("mission-preview-specialists")).toContainText("Risk and testability reviewer (v1)");
  await expect(page.getByTestId("mission-preview-specialists")).toContainText("Council chair (v1)");
  await expect(page.getByTestId("mission-preview-cost")).toHaveText("Two reviewers on their own, then the chair: up to 3 model calls, with the Nemotron model your key's listing gives. Nothing is retried.");
  await expect(page.getByTestId("mission-preview-not-sent")).toContainText("Any repository, file or conversation.");
  await page.getByTestId("mission-review-start").click();
  const card = page.getByTestId("mission-review").first();
  await expect(card.getByTestId("review-status")).toHaveText("Failed");
  await expect(card.getByTestId("review-note")).toHaveText("No Nebius key is set, so nothing was sent. Add your key in Settings, then try again. Nothing was resent.");
  await expect(card.getByTestId("review-not-approval")).toBeVisible();
  if (!packaged) expect(reviewRequests()).toEqual([]);
});

test("a review runs two reviewers and a chair; its findings name tasks, and a task opens on its own page, where a hand edit saves", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await page.evaluate((key) => window.nivra.setNebiusKey(key), KEY);
  await openMission("Runner's log");
  await reviewTasks(["Store runs", "Weekly total"]);
  const card = page.getByTestId("mission-review").first();
  await expect(card.getByTestId("review-status")).toHaveText("Complete");
  await expect(card.getByTestId("review-stage")).toHaveCount(3);
  await expect(card.getByTestId("review-finding")).toHaveCount(3);
  await expect(card.getByTestId("mission-finding-task")).toHaveText(["T2 · Weekly total", "T1 · Store runs", "T1 · Store runs"]);
  await expect(card.getByTestId("review-ref").filter({ hasText: "the backlog" })).toHaveCount(1);
  await expect(card.getByTestId("review-synthesis")).toContainText("Agreement isn't proof: both reviewers saw the same mission and tasks, and nothing else.");
  await expect(card.getByTestId("review-binding")).toContainText("No repository · Product architect v1, Risk and testability reviewer v1, Council chair v1");
  await expect(card.getByTestId("mission-review-stale")).toHaveCount(0);
  // Exactly the council's three requests, carrying the mission and the two tasks, and nothing of the third.
  const sent = reviewRequests();
  expect(sent.map(roleOf).sort()).toEqual(["architecture", "chair", "risks"]);
  const all = sent.map((request) => request.raw).join("\n");
  expect([all.includes("Runner's log"), all.includes("T1. Store runs"), all.includes("T2. Weekly total"), all.includes("Sync between phones")]).toEqual([true, true, true, false]);
  expect(stub.chats().length).toBe(3);
  // A finding's task opens on its own page; the person edits it there, by hand.
  await card.getByTestId("mission-finding-task").filter({ hasText: "T1 · Store runs" }).first().click();
  await expect(page.getByTestId("task-title")).toHaveText("Store runs");
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-goal").fill("Store each run on the phone, and keep it after a restart.");
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-brief-version")).toContainText("v2");
  // The review now says what changed since, and stays as it was.
  await openMission("Runner's log");
  await expect(card.getByTestId("mission-review-stale")).toContainText(`"Store runs" is now at brief v2; v1 was sent.`);
  await expect(card.getByTestId("review-finding")).toHaveCount(3);
  // Nothing was run: no task has an attempt.
  const tasks = await page.evaluate(() => window.nivra.listTasks());
  expect(tasks.tasks.every((task) => task.state === "draft")).toBe(true);
});

test("a sound selection may come back with no findings, which reads as nothing raised, never as approval", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  script = {
    architecture: toolCall("submit_review", { summary: "The selection fits the mission; nothing material to raise.", findings: [], assumptions: [], gaps: [] }),
    risks: toolCall("submit_review", { summary: "Each criterion can be checked as written.", findings: [], assumptions: [], gaps: [] }),
    chair: toolCall("submit_synthesis", { summary: "Neither reviewer raised anything material.", priorities: [], agreements: [], dissent: [], gaps: [] }),
  };
  try {
    await openMission("Runner's log");
    await reviewTasks(["Sync between phones"]);
    const card = page.getByTestId("mission-review").first();
    await expect(card.getByTestId("review-status")).toHaveText("Complete");
    await expect(card.getByTestId("review-finding")).toHaveCount(0);
    await expect(card.getByTestId("review-nothing-raised")).toHaveText([
      "Raised nothing material. That isn't an approval: it saw only the mission and the selected tasks.",
      "Raised nothing material. That isn't an approval: it saw only the mission and the selected tasks.",
    ]);
  } finally {
    script = {};
  }
});

test("rejected output: findings that name only tasks that weren't sent are set aside, and the review shows as incomplete with the count", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  script = {
    architecture: toolCall("submit_review", { summary: "Two problems.", findings: [finding("Something about T7", ["T7"]), finding("Something else", ["T9", "E1"])], assumptions: [], gaps: [] }),
  };
  try {
    await openMission("Runner's log");
    await reviewTasks(["Store runs"]);
    const card = page.getByTestId("mission-review").first();
    await expect(card.getByTestId("review-status")).toHaveText("Incomplete");
    await expect(card.getByTestId("review-incomplete")).toBeVisible();
    await expect(card.locator('[data-testid="review-stage"][data-role="architecture"]')).toHaveAttribute("data-status", "failed");
    await expect(card.locator('[data-testid="review-stage"][data-role="architecture"]')).toContainText("2 findings named nothing in the selection");
    await expect(card.locator('[data-testid="review-stage"][data-role="chair"]')).toHaveAttribute("data-status", "skipped");
    await expect(card.getByTestId("review-nothing-raised")).toHaveCount(0);
    // The other reviewer's findings are kept: both name what was sent (T1, and the backlog).
    await expect(card.getByTestId("review-finding")).toHaveCount(2);
  } finally {
    script = {};
  }
});

test("a relaunch keeps every review, its stale lines and the board; nothing is sent again", async ({}, testInfo) => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  const before = reviewRequests().length;
  await app.close();
  await launch(testInfo);
  await openMission("Runner's log");
  await expect(page.getByTestId("mission-review")).toHaveCount(4);
  await expect(page.getByTestId("mission-review-stale").first()).toBeVisible();
  await expect(page.locator('[data-testid="board-card"]')).toHaveCount(3);
  expect(reviewRequests().length).toBe(before);
});

test("deleting a mission takes its versions, backlog and reviews, and leaves its tasks", async () => {
  await openMission("Runner's log");
  await page.getByTestId("mission-delete").click();
  await page.getByTestId("mission-delete-confirm").click();
  await expect(page.getByTestId("missions-empty")).toBeVisible();
  const tasks = await page.evaluate(() => window.nivra.listTasks());
  expect(tasks.tasks.map((task) => task.title).sort()).toEqual(["Import old runs", "Store runs", "Sync between phones", "Weekly total"]);
});
