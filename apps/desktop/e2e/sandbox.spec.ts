import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { startSandboxStub, type SandboxStub } from "../../engine/test/stub-sandboxes.ts";

/**
 * A sandbox check through the real UI (NIV-44, D36). The built app reaches a stand-in for Nebius Sandboxes on this
 * machine through the unpackaged-only `--nivra-sandboxes-url` switch, so nothing reaches Nebius: the project id saved in
 * Settings, a preview of what would be uploaded, upload consent of its own, the check and its report, then uploads
 * turned off. A packaged app ignores the switch, so these tests skip there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");

let root: string;
let repo: string;
let stub: SandboxStub;
let app: ElectronApplication;
let page: Page;
let packaged = false;

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e sandbox ü%# "));
  repo = join(root, "timer-app");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Timer app\n");
  writeFileSync(join(repo, "src/timer.ts"), "export function startTimer() {}\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  stub = await startSandboxStub();
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`, `--nivra-sandboxes-url=${stub.url}`];
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
  await stub?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("previews what a check would upload, asks for upload consent of its own, then checks and reports", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await page.evaluate(() => window.nivra.setNebiusKey("test-key-0123456789"));
  await page.getByTestId("nebius-project-id").fill("project-e00e2esandbox");
  await page.getByTestId("nebius-project-id-save").click();
  await expect(page.getByTestId("nebius-project-id-state")).toHaveText("Project id saved");
  await page.getByTestId("sandbox-preview").click();
  await expect(page.getByTestId("sandbox-preview-panel")).toContainText("2 files");
  await expect(page.getByTestId("sandbox-preview-left-out")).toContainText("Left out: nothing.");
  await page.getByTestId("sandbox-start").click();
  // Its own dialog, about uploads: model-context consent is neither asked for nor taken.
  await expect(page.getByTestId("sandbox-consent-allow")).toBeVisible();
  await expect(page.getByText("Upload this project's commit to Nebius Sandboxes?")).toBeVisible();
  await expect(page.getByText("This is separate from sending content to Token Factory")).toBeVisible();
  expect(stub.requests.length).toBe(0);
  // A double press starts one check: the dialog stays on screen while it fades, and its button takes the first only.
  await page.getByTestId("sandbox-consent-allow").dblclick();
  await expect(page.getByTestId("sandbox-status")).toHaveText("succeeded");
  await expect(page.getByTestId("sandbox-error")).toHaveCount(0);
  await expect(page.getByTestId("sandbox-report")).toHaveAttribute("data-outcome", "unchanged");
  await expect(page.getByTestId("sandbox-report")).toContainText("The sandbox held exactly this commit, and the check changed nothing.");
  await expect(page.getByTestId("sandbox-report")).toContainText("busybox: BusyBox v1.36.1 (the fake guest)");
  await expect(page.getByTestId("sandbox-cleanup")).toContainText("Nebius keeps 1 upload");
  await expect(page.getByTestId("sandbox-uploads")).toBeVisible();
  await expect(page.getByTestId("explain-sharing")).toHaveCount(0);
  expect(stub.requests.filter((request) => request.path === "/v1/files").length).toBe(1);
  expect(stub.requests.every((request) => request.authorization === "Bearer test-key-0123456789" && request.project === "project-e00e2esandbox")).toBe(true);
});

test("turning uploads off asks again before anything more is uploaded", async () => {
  test.skip(packaged, "a packaged app ignores the test endpoint switch");
  await page.getByTestId("sandbox-uploads-off").click();
  await expect(page.getByTestId("sandbox-uploads")).toHaveCount(0);
  const before = stub.requests.length;
  await page.getByTestId("sandbox-preview").click();
  await expect(page.getByTestId("sandbox-preview-panel")).toContainText("2 files");
  await page.getByTestId("sandbox-start").click();
  await expect(page.getByTestId("sandbox-consent-allow")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sandbox-consent-allow")).toHaveCount(0);
  expect(stub.requests.length).toBe(before);
});
