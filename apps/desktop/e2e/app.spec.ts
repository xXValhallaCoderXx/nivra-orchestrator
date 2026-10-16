import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * The built app, driven like a person would (B4): the sandboxed window, the typed bridge, the engine coming online on
 * the local target, a repository added through the native picker (stubbed in main), a hello run, a cancelled run,
 * Doctor, and quitting with no engine left behind. Isolated with --user-data-dir and --nivra-engine-home.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_API = [
  "addProject",
  "cancelRun",
  "checkTokenFactory",
  "engineStatus",
  "getAppInfo",
  "getSettings",
  "listProjects",
  "listRuns",
  "listTargets",
  "removeProject",
  "restartEngine",
  "runDoctor",
  "runEvents",
  "selectTarget",
  "setNebiusKey",
  "startHello",
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

test("the engine comes online on the local target", async () => {
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
  await expect(page.getByTestId("target-select")).toHaveValue(/· Local$/);
});

test("a repository picked in the native dialog runs hello, and a held run cancels", async () => {
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("project-select")).toHaveValue("repo ü%#");

  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-status")).toHaveText("succeeded");
  await expect(page.getByTestId("hello-timeline")).toContainText("on main");

  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-timeline")).toContainText("Holding a child process");
  await page.getByTestId("hello-cancel").click();
  await expect(page.getByTestId("hello-status")).toHaveText("cancelled");
});

test("Doctor reports git and the execution boundaries", async () => {
  await page.getByTestId("doctor-run").click();
  await expect(page.getByTestId("doctor-report")).toContainText("Git");
  await expect(page.getByTestId("doctor-report")).toContainText("Execution boundaries");
});

test("quitting stops the engine", async () => {
  const pid = await page.evaluate(async () => {
    const view = await window.nivra.engineStatus();
    return view.state.status === "online" ? view.state.info.pid : null;
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
