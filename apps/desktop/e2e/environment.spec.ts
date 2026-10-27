import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { BriefFields } from "../src/shared/ipc";

/**
 * A project's environment through the window (D41). The local engine is the gated stand-in (`--nivra-test-engine=gated`,
 * honoured only when unpackaged): it previews a pnpm workspace, prepares it, or fails its install as its flags say, and
 * answers a task run with a verified change made from the environment its input named. The window previews the
 * preparation on the project's own engine, asks for uploads with what is sent in front of the person, follows it, keeps
 * what it prepared, and shows a failed install's log as text. A brief's baseline checks and frozen files are written in
 * the brief's form; the run preview and the run's card show them with the environment. A packaged app ignores the
 * switch, so this skips there.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
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
const lines = (file: string) => (existsSync(join(home(), file)) ? readFileSync(join(home(), file), "utf8").split("\n").filter(Boolean) : []);

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e environment "));
  mkdirSync(join(root, "user data"), { recursive: true });
  mkdirSync(home(), { recursive: true });
  for (const name of ["accept", "release", "task-report"]) writeFileSync(join(home(), name), "");
  const repo = join(root, "mono");
  mkdirSync(repo);
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  packaged = executable !== undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${home()}`, "--nivra-test-engine=gated"];
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("prepares a project's environment from the window: previewed on its engine, uploads asked for with what is sent, kept, and a failed install's log shown as text", async () => {
  test.skip(packaged, "a packaged app ignores the test engine switch");
  await page.evaluate(async () => {
    await window.nivra.setNebiusKey("test-key-0123456789");
    await window.nivra.setNebiusProjectId("project-e00e2eenvironment");
  });
  const section = page.getByTestId("environment");
  await expect(section.getByTestId("environment-none")).toContainText("No environment is prepared for this project yet");
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-pins")).toContainText("pins pnpm@11.5.3, and asks for Node >=22");
  await expect(section.getByTestId("environment-sends")).toContainText(".npmrc is never sent.");
  await expect(section.getByTestId("environment-uploads-off")).toContainText("Uploads to Nebius Sandboxes are off for this project.");
  // Some of the workspace's packages: none chosen yet can't be prepared, and a new choice is previewed before it is.
  await section.getByTestId("environment-chosen").check();
  await expect(section.getByTestId("environment-prepare")).toBeDisabled();
  await section.getByTestId("environment-package").first().check();
  await expect(section.getByTestId("environment-stale")).toBeVisible();
  await expect(section.getByTestId("environment-prepare")).toBeDisabled();
  await section.getByTestId("environment-preview").click();
  await expect(section.getByTestId("environment-sends")).toContainText("pnpm install --frozen-lockfile --filter @mono/data...");
  await expect(section.getByTestId("environment-network")).toHaveText("Networking is on for the preparation only.");
  // Uploads are off: Prepare asks for them, saying what is sent and what isn't.
  await section.getByTestId("environment-prepare").click();
  await expect(page.getByTestId("environment-consent-allow")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("never sent: .npmrc");
  await page.getByTestId("environment-consent-allow").click();
  await expect(section.getByTestId("environment-prepared")).toContainText("Node v22.23.4, pnpm 11.5.3, x86_64", { timeout: 30_000 });
  await expect(section.getByTestId("environment-prepared")).toContainText("with @mono/data... installed");
  await expect(section.getByTestId("environment-status")).toHaveText("Ended");
  const sent = JSON.parse(lines("environments.log")[0]!.split(" ").slice(1).join(" ")) as { context: { spec: unknown; sharing: unknown } };
  expect(sent.context).toEqual({ sharing: { cloudExecution: true }, spec: { filters: ["@mono/data..."] } });

  // An install that fails: Nivra's words, and the end of its log as text, never as markup; what was prepared stays.
  writeFileSync(join(home(), "environment-outcome"), "failed");
  await section.getByTestId("environment-prepare").click();
  await expect(section.getByTestId("environment-status")).toHaveText("Failed", { timeout: 30_000 });
  await expect(section.getByTestId("environment-stopped")).toHaveText("The install in the sandbox didn't finish, so no environment was made.");
  await expect(section.getByTestId("environment-log")).toContainText("ERR_PNPM_OUTDATED_LOCKFILE <b>Cannot install</b> with frozen-lockfile");
  await expect(section.getByTestId("environment-log").locator("b")).toHaveCount(0);
  await expect(section.getByTestId("environment-prepared")).toBeVisible();
  rmSync(join(home(), "environment-outcome"));
  expect(lines("calls.log").filter((call) => call === "runs.start").length).toBe(2);
});

test("writes a brief's baseline checks and frozen files, previews a run from the prepared environment, and its card says how each went", async () => {
  test.skip(packaged, "a packaged app ignores the test engine switch");
  const taskId = await page.evaluate(async (fields) => {
    const projectId = (await window.nivra.listProjects())[0]!.id;
    await window.nivra.setSharing(projectId, true);
    const created = await window.nivra.createTask({ title: "Greet the world", fields, projectId, planId: null });
    return created.summary.id;
  }, FIELDS);
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).getByTestId("task-open").click();
  // The brief's form: a baseline check with a pattern, which fails as the bug does, and a frozen file.
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-baseline-add").click();
  await page.getByTestId("brief-baseline-name").fill("check.sh fails for the bug");
  await page.getByTestId("brief-baseline-command").fill("/bin/sh check.sh");
  await page.getByTestId("brief-baseline-mode").getByText("Pattern").click();
  await page.getByTestId("brief-baseline-pattern").fill("got: Hello, Ada.*");
  await page.getByTestId("brief-baseline-exit").fill("1");
  await page.getByTestId("brief-frozen").fill("check.sh");
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-brief-version")).toHaveText("· brief v2");
  await expect(page.getByTestId("task-brief-baseline")).toContainText("check.sh fails for the bug");
  await expect(page.getByTestId("task-brief-baseline")).toContainText("Its whole output must match this pattern, and it must exit 1");
  await expect(page.getByTestId("task-brief-frozen")).toContainText("check.sh");
  await page.getByTestId("task-mark-ready").click();

  // The run's preview: from the prepared environment, with the baseline check before the worker and the frozen file.
  await page.getByTestId("task-run").click();
  await expect(page.getByTestId("task-run-start")).toBeEnabled({ timeout: 30_000 });
  const preview = page.getByTestId("task-run-preview-body");
  await expect(preview.getByTestId("task-run-preview-environment")).toContainText("Starts from the prepared environment: Node v22.23.4, pnpm 11.5.3, prepared ");
  await expect(preview.getByTestId("task-run-preview-baseline")).toContainText("1 baseline check runs once on the commit as it is, with networking off.");
  await expect(preview.getByTestId("task-run-preview-frozen-file")).toContainText("check.sh, ");
  await expect(preview.getByTestId("task-run-preview-limits")).toContainText("1 baseline check before the worker");
  await page.getByTestId("task-run-start").click();

  // The card: started from the environment, the baseline check matched, the frozen file unchanged, and so verified.
  const card = page.getByTestId("task-attempt");
  await expect(card).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  await expect(card.getByTestId("task-attempt-environment")).toContainText("Started from the prepared environment: Node v22.23.4, pnpm 11.5.3, x86_64, image image-");
  await expect(card.getByTestId("task-attempt-baseline-check")).toHaveAttribute("data-match", "matched");
  await expect(card.getByTestId("task-attempt-frozen-file")).toHaveAttribute("data-state", "unchanged");
  await expect(card.getByTestId("task-attempt-verdict")).toContainText("Every acceptance case passed, and every frozen file is unchanged: the change is verified.");
  await expect(page.getByTestId("task-engine-failed")).toHaveCount(0);
  const run = JSON.parse(lines("tasks.log")[0]!.split(" ").slice(1).join(" ")) as { input: { environment?: { node: string } }; brief: { baseline?: unknown[]; frozen?: string[] } };
  expect([run.input.environment?.node, run.brief.baseline?.length, run.brief.frozen]).toEqual(["v22.23.4", 1, ["check.sh"]]);
});
