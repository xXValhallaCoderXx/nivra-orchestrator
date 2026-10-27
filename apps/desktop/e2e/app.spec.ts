import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * The built app, driven like a person would (B4, D17): the sandboxed window, the typed bridge, no engine until a
 * repository is added through the native picker (stubbed in main), its folder deciding where it runs, a hello run, a
 * cancelled run, Doctor, and quitting with no engine left behind. Isolated with --user-data-dir and
 * --nivra-engine-home.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_API = [
  "addMissionTask",
  "addPreference",
  "addProject",
  "approveTaskChange",
  "cancelMissionReview",
  "cancelPreparation",
  "cancelResearch",
  "cancelReview",
  "cancelRun",
  "cancelSandboxCheck",
  "cancelTaskRun",
  "cancelTurn",
  "checkTokenFactory",
  "checkWsl",
  "createConversation",
  "createMission",
  "createMissionTask",
  "createTask",
  "deleteConversation",
  "deleteMission",
  "deletePreference",
  "deleteTask",
  "editPreference",
  "exportPreferences",
  "getAppInfo",
  "getConversation",
  "getEnvironment",
  "getMission",
  "getSandboxCheck",
  "getSandboxStatus",
  "getSettings",
  "getTask",
  "getTaskAttempt",
  "getWsl",
  "importPreferences",
  "keepSuggestion",
  "listConversations",
  "listEngines",
  "listMissions",
  "listPlans",
  "listPreferences",
  "listProjects",
  "listResearch",
  "listReviews",
  "listTasks",
  "openConversation",
  "openMission",
  "openProject",
  "prepareEnvironment",
  "prepareMissionReview",
  "prepareResearch",
  "prepareReview",
  "previewEnvironment",
  "previewImport",
  "previewSandboxCheck",
  "previewTaskRun",
  "refreshBriefFromPlan",
  "rejectTaskChange",
  "removeMissionTask",
  "removeProject",
  "renameTask",
  "requestTaskRevision",
  "restartConversationEngine",
  "restartEngine",
  "restoreTaskChange",
  "reviseBrief",
  "reviseMission",
  "revisePlan",
  "runDoctor",
  "runEvents",
  "runResult",
  "saveAmendedPlan",
  "savePlan",
  "sendMessage",
  "setCloudExecution",
  "setNebiusKey",
  "setNebiusProjectId",
  "setSharing",
  "setTaskProject",
  "setTaskState",
  "setTavilyKey",
  "setWebResearch",
  "settleTaskChange",
  "startExplain",
  "startHello",
  "startMissionReview",
  "startResearch",
  "startReview",
  "startSandboxCheck",
  "startTaskRun",
  "supersedePreference",
];

let root: string;
let app: ElectronApplication;
let page: Page;
let repo: string;

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e ü%# "));
  repo = join(root, "repo ü%#");
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  const isolation = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  // The packaged project drives the electron-builder --dir output, with the runtime it ships (D5).
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  app = await electron.launch(
    executable ? { executablePath: join(desktop, executable), args: isolation, chromiumSandbox: true } : { args: [desktop, ...isolation], chromiumSandbox: true },
  );
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("the window is sandboxed and sees only the typed bridge", async () => {
  await expect(page).toHaveTitle("Nivra");
  const surface = await page.evaluate(() => ({
    api: Object.keys(window.nivra).sort(),
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(surface).toEqual({ api: EXPECTED_API, require: "undefined", process: "undefined" });
});

test("a fresh profile has no target to choose and starts no engine", async () => {
  await expect(page.getByTestId("engine-badge")).toHaveText("No folder chosen");
  const state = await page.evaluate(async () => ({ engines: await window.nivra.listEngines(), wsl: await window.nivra.getWsl() }));
  expect(state).toEqual({ engines: [], wsl: null });
  await expect(page.getByTestId("target-select")).toHaveCount(0);
});

test("a repository picked in the native dialog runs on its folder's engine, runs hello, and a held run cancels", async () => {
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("project-select")).toHaveValue("repo ü%#");
  await expect(page.getByTestId("project-target")).toHaveText(/· Local$/);
  await expect(page.getByTestId("engine-target")).toHaveText(/· Local$/);
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");

  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-status")).toHaveText("succeeded");
  await expect(page.getByTestId("hello-timeline")).toContainText("on main");

  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-timeline")).toContainText("Holding a child process");
  await page.getByTestId("hello-cancel").click();
  await expect(page.getByTestId("hello-status")).toHaveText("cancelled");
});

test("a key holding a character no key has is refused when it is saved, saying why, and nothing is saved", async () => {
  for (const key of ["test-key-\u200b0123456789", "test-key-01234\n56789", "test-key 0123456789"]) {
    const refusal = await page.evaluate((value) => window.nivra.setNebiusKey(value).then(() => null, (error: Error) => error.message), key);
    expect(refusal).toContain("so it wasn't saved. Copy the key again, then save it.");
  }
  expect((await page.evaluate(() => window.nivra.getSettings())).nebiusKey).toBe("none");
});

test("Doctor reports git and the execution boundaries", async () => {
  await page.getByTestId("doctor-run").click();
  await expect(page.getByTestId("doctor-report")).toContainText("Git");
  await expect(page.getByTestId("doctor-report")).toContainText("Execution boundaries");
});

test("quitting stops the engine", async () => {
  const pid = await page.evaluate(async () => {
    const view = (await window.nivra.listEngines()).find((e) => e.targetId === "local");
    return view?.state.status === "online" ? view.state.info.pid : null;
  });
  expect(pid).not.toBeNull();
  await app.close();
  const alive = () => {
    try {
      process.kill(pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(alive, { timeout: 10_000 }).toBe(false);
});
