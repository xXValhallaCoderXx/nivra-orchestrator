import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";

/**
 * Preferences through the real UI (D21, NIV-5): a preference confirmed in the window is kept by the host, survives a
 * restart of the app, and reaches the engine with each run, scoped to the run's project; an edit or a deletion reaches
 * the next run. The engine's own record of what it received (ids and a fingerprint) is checked against a fingerprint
 * worked out here from what was typed, so equal fingerprints mean every value arrived. Isolated with --user-data-dir
 * and --nivra-engine-home.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const canary = `nivra-preference-canary-${randomUUID()}`;
const PORTABLE = "Prefer named exports, ü%#";
const EDITED = "Prefer default exports, ü%#";
const ALPHA_OWN = `alpha keeps its tests in __tests__ ${canary}`;

type Context = { revision: number; count: number; records: Array<{ id: string; scope: string; intent: string; revision: number }>; digest: string };

let root: string;
let app: ElectronApplication;
let page: Page;
let lastRun: string | null = null;

function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return repo;
}

async function launch(testInfo: TestInfo): Promise<void> {
  const isolation = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  app = await electron.launch(
    executable ? { executablePath: join(desktop, executable), args: isolation, chromiumSandbox: true } : { args: [desktop, ...isolation], chromiumSandbox: true },
  );
  page = await app.firstWindow();
  lastRun = null;
}

async function pick(path: string): Promise<void> {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByTestId("project-add").click();
}

async function choose(label: string): Promise<void> {
  await page.getByTestId("project-select").click();
  await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
  await expect(page.getByTestId("project-select")).toHaveValue(label);
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
}

async function confirmPreference(statement: string, scope: "Every project" | string, intent?: "Default for this project" | "Decision to change existing conventions"): Promise<void> {
  await page.getByTestId("preference-scope").getByText(scope, { exact: true }).click();
  if (intent) await page.getByTestId("preference-intent-choice").getByText(intent, { exact: true }).click();
  await page.getByTestId("preference-input").fill(statement);
  await page.getByTestId("preference-confirm").click();
  await expect(page.getByTestId("preference-list")).toContainText(statement);
}

/** The fingerprint the chosen project's next run should receive, worked out here from the app's records (D21). */
async function expectedFor(label: string): Promise<{ digest: string; ids: string[]; revision: number }> {
  const { projects, preferences } = await page.evaluate(async () => ({ projects: await window.nivra.listProjects(), preferences: await window.nivra.listPreferences() }));
  const projectId = projects.find((p) => p.label === label)!.id;
  const records = preferences.records.filter((r) => r.status === "confirmed" && (r.scope === "personal" || r.projectId === projectId));
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [r.id, r.scope, r.intent, r.revision, r.statement]);
  return { digest: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"), ids: records.map((r) => r.id), revision: preferences.revision };
}

/** Runs hello on the chosen project and returns what its engine recorded about the context it received. */
async function runHello(): Promise<Context> {
  await page.getByTestId("hello-start").click();
  const status = page.getByTestId("hello-status");
  const runId = await expect
    .poll(async () => {
      const id = (await status.count()) ? await status.getAttribute("data-run-id") : null;
      return id !== null && id !== lastRun ? id : null;
    })
    .not.toBeNull()
    .then(() => status.getAttribute("data-run-id"));
  lastRun = runId;
  await expect(status).toHaveText("succeeded");
  const events = await page.evaluate(async (id) => (await window.nivra.runEvents(id, 0)).events, runId!);
  return events.find((e) => e.stepId === "context" && e.type === "step.output")!.data as Context;
}

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e preferences ü%# "));
  makeRepo("alpha");
  makeRepo("beta");
  await launch(testInfo);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("a preference confirmed in the window reaches the project's run, every value intact, its intent included", async () => {
  await pick(join(root, "alpha"));
  await expect(page.getByTestId("project-select")).toHaveValue("alpha");
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
  await confirmPreference(PORTABLE, "Every project");
  // A project's own preference can be a decision to change its conventions (D23); the badge says which it is.
  await confirmPreference(ALPHA_OWN, "alpha only", "Decision to change existing conventions");
  await expect(page.getByTestId("preference-row").filter({ hasText: ALPHA_OWN }).getByTestId("preference-intent")).toHaveText("Decision");
  await expect(page.getByTestId("preferences-summary")).toHaveText("Runs on alpha get 2 confirmed preferences: your personal ones and this project's own (revision 2).");

  const expected = await expectedFor("alpha");
  const received = await runHello();
  expect([received.count, received.revision, received.records.map((r) => r.id), received.digest]).toEqual([2, 2, expected.ids, expected.digest]);
  expect(received.records.map((r) => r.intent)).toEqual(["default", "override"]);
  await expect(page.getByTestId("hello-timeline")).toContainText(`2 confirmed preferences from the app (revision 2), fingerprint ${expected.digest.slice(0, 12)}`);
});

test("another project's runs get the personal preference, never the first project's own", async () => {
  await pick(join(root, "beta"));
  await expect(page.getByTestId("project-select")).toHaveValue("beta");
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
  await expect(page.getByTestId("preferences-summary")).toContainText("Runs on beta get 1 confirmed preference");
  await expect(page.getByTestId("preference-row").filter({ hasText: "alpha only" })).toContainText("not sent to beta");

  const expected = await expectedFor("beta");
  const received = await runHello();
  expect([received.count, received.records.map((r) => r.scope), received.digest]).toEqual([1, ["personal"], expected.digest]);
});

test("an edit reaches the next run", async () => {
  // Found by id: while it is being edited, the row's words are in an input, not its text.
  const id = await page.getByTestId("preference-row").filter({ hasText: PORTABLE }).getAttribute("data-preference-id");
  const row = page.locator(`[data-testid="preference-row"][data-preference-id="${id}"]`);
  await row.getByTestId("preference-edit").click();
  await row.getByTestId("preference-edit-input").fill(EDITED);
  await row.getByTestId("preference-save").click();
  await expect(page.getByTestId("preference-row").filter({ hasText: EDITED }).getByTestId("preference-revision")).toContainText("revision 2");

  const expected = await expectedFor("beta");
  const received = await runHello();
  expect([received.revision, received.records.map((r) => r.revision), received.digest]).toEqual([3, [2], expected.digest]);
});

test("preferences survive a restart of the app, and the next run gets them as they were left", async ({}, testInfo) => {
  const before = await expectedFor("beta");
  await app.close();
  await launch(testInfo);
  await choose("beta");
  await expect(page.getByTestId("preference-row")).toHaveCount(2);
  await expect(page.getByTestId("preference-list")).toContainText(EDITED);
  const received = await runHello();
  expect([received.revision, received.digest]).toEqual([before.revision, before.digest]);
});

test("a deleted preference is gone from the next run", async () => {
  await page.getByTestId("preference-row").filter({ hasText: EDITED }).getByTestId("preference-delete").click();
  await expect(page.getByTestId("preference-row")).toHaveCount(1);
  await expect(page.getByTestId("preferences-summary")).toContainText("Runs on beta get 0 confirmed preferences");
  const received = await runHello();
  expect([received.count, received.revision]).toEqual([0, 4]);
  await expect(page.getByTestId("hello-timeline")).toContainText("No confirmed preferences from the app (revision 4)");
});

test("a replaced preference stays as history, and the next run gets only its replacement (D23)", async () => {
  const [before, after] = ["Use tabs for indentation", "Use two spaces for indentation"];
  await confirmPreference(before, "Every project");
  const id = await page.getByTestId("preference-row").filter({ hasText: before }).getAttribute("data-preference-id");
  const row = page.locator(`[data-testid="preference-row"][data-preference-id="${id}"]`);
  await row.getByTestId("preference-replace").click();
  await row.getByTestId("preference-edit-input").fill(after);
  await row.getByTestId("preference-replace-save").click();
  await expect(page.getByTestId("preference-list")).toContainText(after);
  await expect(page.getByTestId("preference-list")).not.toContainText(before);
  await expect(page.getByTestId("preference-replaced-row")).toContainText(`“${before}” (Every project), replaced`);
  await expect(page.getByTestId("preference-replaced-row")).toContainText(`by “${after}”. No run gets it.`);

  const expected = await expectedFor("beta");
  const received = await runHello();
  expect([received.count, received.records.map((r) => r.id), received.digest]).toEqual([1, expected.ids, expected.digest]);
});

test("only the app's own store keeps preference text: nothing in the engine's databases or the logs", async () => {
  await app.close();
  const holding = (dir: string) =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name)).includes(canary))
      .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
  expect(holding(join(root, "engine home"))).toEqual([]);
  expect(holding(join(root, "user data"))).toEqual(["nivra.json"]);
});
