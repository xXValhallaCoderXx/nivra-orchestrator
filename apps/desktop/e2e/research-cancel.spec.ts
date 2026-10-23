import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { seedPlan } from "./seed-workspace.ts";

/**
 * Research whose cancel fails, through the window (D37, R3 of NIV-45). The local engine is the gated stand-in
 * (`--nivra-test-engine=gated`, honoured only when unpackaged), which can lose a start's answer and turn a cancel down,
 * as a real engine never does; its switches are files in its home. The card must say why the research goes on and leave
 * Cancel to press again. A packaged app ignores the switch and runs the real engine, so there only that is checked.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEEDED = { question: "Can we move the build image to Python 3.12?", plan: "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils." };
const ASSUMPTION = "distutils is still in Python 3.12's standard library.";

// Each test builds on the one before (one profile, one engine home): see workspace.spec.ts.
test.describe.configure({ mode: "serial" });

let root: string;
let app: ElectronApplication;
let page: Page;
let packaged = false;

const home = () => join(root, "engine home");
const flag = (name: string) => writeFileSync(join(home(), name), "");
const unflag = (name: string) => rmSync(join(home(), name), { force: true });
const count = (method: string) => (existsSync(join(home(), "calls.log")) ? readFileSync(join(home(), "calls.log"), "utf8").split("\n").filter((call) => call === method).length : 0);

async function launch(testInfo: TestInfo) {
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${home()}`, "--nivra-test-engine=gated"];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
}

/** Starts research of the seeded plan's typed assumption, and returns its card. */
async function startResearch() {
  await page.getByTestId("plan-research-open").click();
  await page.getByTestId("research-type").fill(ASSUMPTION);
  await page.getByTestId("research-add").click();
  await page.getByTestId("research-preview-button").click();
  await page.getByTestId("research-start").click();
  const open = page.locator('[data-testid="research"][data-status="submitting"], [data-testid="research"][data-status="running"]');
  await expect(open).toHaveCount(1);
  return page.locator(`[data-testid="research"][data-research-id="${await open.getAttribute("data-research-id")}"]`);
}

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e research cancel "));
  mkdirSync(join(root, "user data"), { recursive: true });
  mkdirSync(home(), { recursive: true });
  seedPlan(join(root, "user data", "workspace.db"), SEEDED);
  await launch(testInfo);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("only an unpackaged app runs the gated stand-in; a packaged one ignores the switch and runs its own engine", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Repo\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, repo);
  await page.getByTestId("project-add").click();
  const version = async () => {
    const local = (await page.evaluate(() => window.nivra.listEngines())).find((engine) => engine.targetId === "local");
    return local?.state.status === "online" ? local.state.info.engineVersion : null;
  };
  await expect.poll(version).not.toBeNull();
  expect([packaged, await version() === "gated"]).toEqual([packaged, !packaged]);
});

test("a cancel made while research's start had lost its answer, and turned down once its run is found, is taken back: the card says why, and Cancel works again", async () => {
  test.skip(packaged, "a packaged app ignores --nivra-test-engine");
  await page.evaluate(async (tavily) => {
    await window.nivra.setNebiusKey("test-key-0123456789");
    await window.nivra.setTavilyKey(tavily);
    await window.nivra.setWebResearch(true);
  }, `tvly-dev-e2e-cancel-${"t".repeat(16)}`);
  // The engine records the run, then holds its answer to runs.start.
  flag("accept");
  unflag("release");
  await page.getByTestId("nav-planning").click();
  await page.getByTestId("nav-conversation").filter({ hasText: SEEDED.question }).click();
  const card = await startResearch();
  await expect.poll(() => count("runs.start")).toBe(1);
  await card.getByTestId("research-cancel").click();
  await expect(card.getByTestId("research-status")).toHaveText("Cancelling");
  // The answer is lost (an error after the run was recorded), the run goes on, and its cancel is turned down once.
  flag("running");
  flag("fail-cancel-once");
  flag("error-start");
  flag("release");
  await expect(card.getByTestId("research-stop-failed")).toHaveText(
    "Nivra couldn't stop this research (the run couldn't be stopped). Press Cancel to try again, or restart its engine to stop it.",
  );
  await expect(card.getByTestId("research-status")).toHaveText("Researching");
  await expect(card.getByTestId("research-cancel")).toBeEnabled();
  expect(count("runs.cancel")).toBe(1);
  await card.getByTestId("research-cancel").click();
  await expect(card.getByTestId("research-status")).toHaveText("Cancelled");
  await expect(card.getByTestId("research-stop-failed")).toHaveCount(0);
  expect([count("runs.cancel"), count("runs.start")]).toEqual([2, 1]);
});

test("the person's own cancel, turned down by the engine, says why, and Cancel works again", async () => {
  test.skip(packaged, "a packaged app ignores --nivra-test-engine");
  // From here, runs.start is answered at once, and the run keeps running until it is cancelled.
  unflag("error-start");
  unflag("accept");
  flag("release");
  flag("running");
  const card = await startResearch();
  await expect(card.getByTestId("research-status")).toHaveText("Researching");
  flag("fail-cancel-once");
  await card.getByTestId("research-cancel").click();
  await expect(card.getByTestId("research-card-error")).toContainText("the run couldn't be stopped");
  await expect(card.getByTestId("research-status")).toHaveText("Researching");
  await expect(card.getByTestId("research-cancel")).toBeEnabled();
  await card.getByTestId("research-cancel").click();
  await expect(card.getByTestId("research-status")).toHaveText("Cancelled");
  expect([count("runs.cancel"), count("runs.start")]).toEqual([4, 2]);
});
