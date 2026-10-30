import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { goTo, openSwitcher } from "./places.ts";
import { HostStore } from "../src/main/host-store.ts";
import { keepSuggestion } from "../src/main/preferences.ts";

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
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
}

async function choose(label: string): Promise<void> {
  await page.getByTestId("project-select").click();
  await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
  await expect(page.getByTestId("project-select")).toHaveValue(label);
  await goTo(page, "home");
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online");
}

async function confirmPreference(statement: string, scope: "Every project" | string, intent?: "Default for this project" | "Decision to change existing conventions"): Promise<void> {
  await goTo(page, "settings-preferences");
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
  await goTo(page, "settings-diagnostics");
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
  await goTo(page, "settings-preferences");
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
  await goTo(page, "settings-preferences");
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

/** Makes the native save and open dialogs answer with `path`, as if the person had picked it. */
async function pickFile(path: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: picked })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
}

test("preferences go to a file the person picks and come back as they choose, never with ids, folders or history (D23)", async () => {
  const file = join(root, "exports", "nivra-preferences.json");
  mkdirSync(dirname(file), { recursive: true });
  await pickFile(file);

  await goTo(page, "settings-preferences");
  await page.getByTestId("preference-export").click();
  await page.getByTestId("preference-export-scopes").getByLabel("alpha's own (1)").check();
  await page.getByTestId("preference-export-save").click();
  await expect(page.getByTestId("preference-transfer")).toHaveText("Exported 2 preferences to nivra-preferences.json.");
  const text = readFileSync(file, "utf8");
  const exported = JSON.parse(text) as { format: string; version: number; projects: unknown[]; preferences: Array<{ scope: string; project: string | null; intent: string }> };
  expect([exported.format, exported.version, exported.projects, exported.preferences.map((p) => [p.scope, p.project, p.intent])]).toEqual([
    "nivra-preferences",
    2,
    [{ key: "p1", label: "alpha" }],
    [["project", "p1", "override"], ["personal", null, "default"]],
  ]);
  expect([/"id"|revision|Use tabs/.test(text), text.includes(root)]).toEqual([false, false]);

  // The personal one goes. An import that leaves the file's personal preferences out doesn't bring it back, and skips
  // alpha's own, which is still here; one that keeps them in does.
  await page.getByTestId("preference-row").filter({ hasText: "Use two spaces for indentation" }).getByTestId("preference-delete").click();
  await expect(page.getByTestId("preference-list")).not.toContainText("Use two spaces for indentation");
  await page.getByTestId("preference-import").click();
  await expect(page.getByTestId("preference-import-source")).toHaveCount(1);
  await expect(page.getByTestId("preference-import-project")).toHaveValue("alpha only");
  await expect(page.getByTestId("preference-import-entry").filter({ hasText: ALPHA_OWN })).toContainText("(already here: skipped)");
  await page.getByTestId("preference-import-personal-include").uncheck();
  await expect(page.getByTestId("preference-import-entry").filter({ hasText: "Use two spaces for indentation" })).toContainText("(left out)");
  await page.getByTestId("preference-import-save").click();
  await expect(page.getByTestId("preference-transfer")).toHaveText("Nothing imported; 1 already here; 1 left out.");
  await expect(page.getByTestId("preference-list")).not.toContainText("Use two spaces for indentation");

  await page.getByTestId("preference-import").click();
  await expect(page.getByTestId("preference-import-personal-include")).toBeChecked();
  await page.getByTestId("preference-import-save").click();
  await expect(page.getByTestId("preference-transfer")).toHaveText("Imported 1 preference; 1 already here.");
  await expect(page.getByTestId("preference-row").filter({ hasText: "Use two spaces for indentation" }).getByTestId("preference-revision")).toContainText("imported");
});

test("two projects with the same name in a file stay apart, neither goes anywhere until the person says where, and a repeat is shown as skipped (D23)", async () => {
  const file = join(root, "exports", "same-name.json");
  writeFileSync(
    file,
    JSON.stringify({
      format: "nivra-preferences",
      version: 2,
      exportedAt: new Date().toISOString(),
      projects: [{ key: "p1", label: "alpha" }, { key: "p2", label: "alpha" }],
      preferences: [
        { statement: "Keep functions small", scope: "personal", project: null, intent: "default" },
        { statement: "Keep functions small", scope: "personal", project: null, intent: "default" },
        { statement: "Use Jest for alpha's tests", scope: "project", project: "p1", intent: "default" },
        { statement: "Use Vitest for alpha's tests", scope: "project", project: "p2", intent: "default" },
      ],
    }),
  );
  await pickFile(file);

  await page.getByTestId("preference-import").click();
  const sources = page.getByTestId("preference-import-source");
  const destinations = page.getByTestId("preference-import-project");
  await expect(sources).toHaveCount(2);
  // The file holds the same personal preference twice: the second would add nothing, as the host will count it.
  await expect(page.getByTestId("preference-import-personal").getByTestId("preference-import-entry")).toHaveText(["Keep functions small", "Keep functions small (already here: skipped)"]);
  for (const i of [0, 1]) {
    await expect(sources.nth(i)).toContainText(`From alpha (${i + 1} of 2 projects with this name in the file)`);
    await expect(sources.nth(i)).toContainText("The file has 2 projects called alpha: choose where each one's preferences go, or leave them out.");
    await expect(destinations.nth(i)).toHaveValue("Leave them out");
  }

  await destinations.nth(0).click();
  await page.getByRole("option", { name: "alpha only" }).click();
  await expect(destinations.nth(0)).toHaveValue("alpha only");
  await expect(sources.nth(0).getByTestId("preference-import-entry")).toHaveText("Use Jest for alpha's tests (default)");
  await expect(sources.nth(1).getByTestId("preference-import-entry")).toHaveText("Use Vitest for alpha's tests (default) (left out)");
  await page.getByTestId("preference-import-save").click();
  await expect(page.getByTestId("preference-transfer")).toHaveText("Imported 2 preferences; 1 already here; 1 left out.");
  await expect(page.getByTestId("preference-list")).toContainText("Use Jest for alpha's tests");
  await expect(page.getByTestId("preference-list")).not.toContainText("Use Vitest for alpha's tests");
});

test("promotion starts blank, reviews the source, and cancelling, leaving or reloading discard its temporary wording (NIV-10)", async () => {
  await choose("alpha");
  await goTo(page, "settings-preferences");
  const before = await page.evaluate(() => window.nivra.listPreferences());
  expect(await page.getByTestId("preference-list").evaluate((list) => list.scrollWidth - list.clientWidth)).toBeLessThanOrEqual(1);
  const source = page.getByTestId("preference-row").filter({ hasText: ALPHA_OWN });
  const open = async () => {
    await source.getByTestId("preference-promote").click();
    await expect(page.getByTestId("preference-promotion-input")).toHaveValue("");
    await expect(page.getByTestId("preference-promotion-input")).toBeFocused();
    await expect(page.getByTestId("preference-promotion-confirm")).toBeDisabled();
    await expect(page.getByTestId("preference-promotion-source")).toHaveText(ALPHA_OWN);
    await expect(page.getByTestId("preference-promotion-review")).toContainText("Decision to change existing conventions");
    await expect(page.getByTestId("preference-promotion-review")).toContainText("No repository evidence recorded");
    await page.getByTestId("preference-promotion-input").fill("An unconfirmed promotion draft");
  };
  await open();
  await page.getByTestId("preference-promotion-cancel").click();
  await open();
  await page.keyboard.press("Escape");
  await open();
  // Settings remains mounted when hidden. Exercise a route change while the review still owns the focus.
  await page.getByTestId("nav-home").evaluate((button) => (button as HTMLElement).click());
  await expect(page.getByTestId("page-home")).toBeVisible();
  await expect(page.getByTestId("preference-promotion-review")).not.toBeVisible();
  await goTo(page, "settings-preferences");
  await open();
  await page.reload();
  await goTo(page, "settings-preferences");
  await source.getByTestId("preference-promote").click();
  await expect(page.getByTestId("preference-promotion-input")).toHaveValue("");
  await page.getByTestId("preference-promotion-cancel").click();
  expect(await page.evaluate(() => window.nivra.listPreferences())).toEqual(before);
  expect(readFileSync(join(root, "user data", "nivra.json"), "utf8").includes("An unconfirmed promotion draft")).toBe(false);
});

test("promotion refuses a source edited since review, without adding personal wording (NIV-10)", async () => {
  await choose("alpha");
  await confirmPreference("Temporary project preference for stale review", "alpha only");
  const source = (await page.evaluate(() => window.nivra.listPreferences())).records.find((r) => r.statement === "Temporary project preference for stale review")!;
  await page.locator(`[data-preference-id="${source.id}"]`).getByTestId("preference-promote").click();
  await page.getByTestId("preference-promotion-input").fill("Temporary portable wording");
  await page.evaluate((id) => window.nivra.editPreference(id, "Revised temporary project preference", "default"), source.id);
  await page.getByTestId("preference-promotion-confirm").click();
  await expect(page.getByTestId("preference-promotion-error")).toContainText("source preference changed");
  await expect(page.getByTestId("preference-promotion-confirm")).toBeDisabled();
  expect((await page.evaluate(() => window.nivra.listPreferences())).records.some((r) => r.statement === "Temporary portable wording")).toBe(false);
  await page.getByTestId("preference-promotion-cancel").click();
  await page.locator(`[data-preference-id="${source.id}"]`).getByTestId("preference-delete").click();
});

test("promotion checks saved keys and refuses an unreadable secret store without saving (NIV-10)", async () => {
  const saved = "promotion-saved-key-0123456789";
  await page.evaluate((value) => window.nivra.setNebiusKey(value), saved);
  const before = await page.evaluate(() => window.nivra.listPreferences());
  try {
    await page.getByTestId("preference-row").filter({ hasText: ALPHA_OWN }).getByTestId("preference-promote").click();
    await page.getByTestId("preference-promotion-input").fill(`Use this ${saved}`);
    await page.getByTestId("preference-promotion-confirm").click();
    await expect(page.getByTestId("preference-promotion-error")).toContainText("nothing was saved");
    await expect(page.getByTestId("preference-promotion-error")).not.toContainText(saved);
  } finally {
    await page.evaluate(() => window.nivra.setNebiusKey(null));
  }
  const secretFile = join(root, "user data", "secrets.json");
  const prior = existsSync(secretFile) ? readFileSync(secretFile) : null;
  try {
    writeFileSync(secretFile, "not readable JSON");
    await page.getByTestId("preference-promotion-input").fill("Prefer small API clients");
    await page.getByTestId("preference-promotion-confirm").click();
    await expect(page.getByTestId("preference-promotion-error")).toContainText("couldn't read your saved keys");
    expect(await page.evaluate(() => window.nivra.listPreferences())).toEqual(before);
  } finally {
    if (prior) writeFileSync(secretFile, prior);
    else rmSync(secretFile, { force: true });
  }
  await page.getByTestId("preference-promotion-cancel").click();
});

test("a kept suggestion promotes after restart, preserves historical evidence, and only new wording reaches another project (NIV-10)", async ({}, testInfo) => {
  const projectId = (await page.evaluate(() => window.nivra.listProjects())).find((p) => p.label === "alpha")!.id;
  await app.close();
  const store = new HostStore(join(root, "user data", "nivra.json"));
  // A retained suggestion from an earlier session: no new model request or repository read is involved.
  store.update((data) => keepSuggestion(data, { projectId, statement: "Alpha's private module prefers named exports", evidence: {
    runId: randomUUID(), suggestion: 0, headAtStart: "a".repeat(40), ranAt: "2026-10-18T12:00:00.000Z", citations: [{ path: "private/alpha-module.ts", startLine: 4, endLine: 8 }],
  } }, new Date()).data);
  await launch(testInfo);
  await choose("alpha");
  await goTo(page, "settings-preferences");
  const source = (await page.evaluate(() => window.nivra.listPreferences())).records.find((r) => r.statement === "Alpha's private module prefers named exports")!;
  const sourceRow = page.locator(`[data-preference-id="${source.id}"]`);
  await sourceRow.getByTestId("preference-promote").click();
  await expect(page.getByTestId("preference-promotion-evidence")).toContainText("Historical evidence");
  await expect(page.getByTestId("preference-promotion-evidence")).toContainText("private/alpha-module.ts:4–8");
  await expect(page.getByTestId("preference-promotion-input")).toHaveValue("");
  await page.getByTestId("preference-promotion-input").fill("Prefer named exports in new modules ü%#");
  await page.screenshot({ path: testInfo.outputPath("promotion-review.png"), animations: "disabled" });
  await page.getByTestId("preference-promotion-confirm").click();
  await expect(page.getByTestId("preference-promotion-note")).toContainText("Personal default confirmed");
  const after = await page.evaluate(() => window.nivra.listPreferences());
  const personal = after.records.find((r) => r.statement === "Prefer named exports in new modules ü%#")!;
  expect(after.records.find((r) => r.id === source.id)).toEqual(source);
  expect([personal.scope, personal.intent, personal.origin, personal.projectId, personal.evidence]).toEqual(["personal", "default", "entered", null, null]);
  await expect(page.locator(`[data-preference-id="${personal.id}"]`).getByTestId("preference-promote")).toHaveCount(0);

  await sourceRow.getByTestId("preference-promote").click();
  await page.getByTestId("preference-promotion-input").fill(personal.statement);
  await page.getByTestId("preference-promotion-confirm").click();
  await expect(page.getByTestId("preference-promotion-note")).toContainText("already confirmed");
  expect((await page.evaluate(() => window.nivra.listPreferences())).revision).toBe(after.revision);
  await choose("beta");
  const expected = await expectedFor("beta");
  const received = await runHello();
  expect([received.digest, received.records.map((r) => r.id).includes(source.id), received.records.map((r) => r.id).includes(personal.id)]).toEqual([expected.digest, false, true]);
  await app.close();
  await launch(testInfo);
  await choose("beta");
  expect((await runHello()).digest).toBe(expected.digest);
  await goTo(page, "settings-preferences");
  const personalRow = page.locator(`[data-preference-id="${personal.id}"]`);
  await personalRow.getByTestId("preference-edit").click();
  await personalRow.getByTestId("preference-edit-input").fill("Prefer explicit exports in new modules");
  await personalRow.getByTestId("preference-save").click();
  await expect(personalRow.getByTestId("preference-revision")).toContainText("revision 2");
  expect((await runHello()).digest).toBe((await expectedFor("beta")).digest);
  await goTo(page, "settings-preferences");
  await personalRow.getByTestId("preference-delete").click();
  await expect(personalRow).toHaveCount(0);
  expect((await runHello()).records.some((r) => r.id === personal.id)).toBe(false);
  expect((await page.evaluate(() => window.nivra.listPreferences())).records.find((r) => r.id === source.id)).toEqual(source);
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
