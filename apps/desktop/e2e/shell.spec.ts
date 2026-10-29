import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { goTo, openSwitcher } from "./places.ts";

/**
 * The window's shell (NIV-56): drafts kept across navigation and a relaunch, a draft refused for what looks like a
 * credential (shown, never echoed, never kept, the typed text left as it is), storage that refuses every write, the
 * keyboard (Ctrl+K, F6, Ctrl+comma, Esc), and a narrow window (820 by 900 at 150% zoom: 547 CSS px). One profile for
 * the whole file, relaunched where a test says so; isolated with --user-data-dir and --nivra-engine-home. Nothing here
 * needs a key or sends anything.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "billing-service";
const TITLE = "Add CSV export for invoices";
// A shape the credential check knows (a GitHub token), built here so no token-like text sits in the repository.
const TOKEN = `ghp_${"Q".repeat(36)}`;

test.describe.configure({ mode: "serial" });

let root: string;
let app: ElectronApplication;
let page: Page;

async function launch(testInfo: TestInfo) {
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
  await page.waitForLoadState("load");
}

/** Closes the app the way a person does, then opens it again on the same profile. */
async function relaunch(testInfo: TestInfo) {
  await app.close();
  await launch(testInfo);
}

const composer = () => page.getByTestId("home-composer");
/** Everything the window shows as text, the fields' own values aside. */
const shownText = () => page.evaluate(() => document.body.innerText);
const stored = () => page.evaluate(() => Object.entries(window.localStorage).map(([key, value]) => `${key}=${value}`).join("\n"));

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e shell ü%# "));
  const repo = join(root, PROJECT);
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  await launch(testInfo);
  await app.evaluate(async ({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await openSwitcher(page);
  await page.getByTestId("project-add").click();
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(page.getByTestId("toast")).toContainText(`${PROJECT} added from`);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("a draft typed in the composer outlives navigation and a relaunch, and the sidebar lists it until the task is started", async ({}, testInfo) => {
  await composer().fill(TITLE);
  await expect(page.getByTestId("draft-not-kept")).toHaveCount(0);
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);
  await expect(page.getByTestId("nav-draft")).toContainText(TITLE);

  await goTo(page, "tasks");
  await goTo(page, "home");
  await expect(composer()).toHaveValue(TITLE);

  await relaunch(testInfo);
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(composer()).toHaveValue(TITLE);
  await expect(page.getByTestId("nav-draft")).toContainText(TITLE);

  // From the sidebar, anywhere: the draft's own place, with its text.
  await goTo(page, "settings-connections");
  await page.getByTestId("nav-draft").click();
  await expect(composer()).toHaveValue(TITLE);

  // Create task takes the title to the new task's page, and nothing is sent; the draft stays until the task exists, so
  // leaving the page first loses nothing.
  await page.getByTestId("home-create-task").click();
  await expect(page.getByTestId("page-new-task")).toBeVisible();
  await expect(page.getByTestId("task-form-title")).toHaveValue(TITLE);
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);
  expect((await page.evaluate(() => window.nivra.listTasks())).tasks).toHaveLength(0);
  await goTo(page, "home");
  await expect(composer()).toHaveValue(TITLE);
  // Once the task is created from it, the draft ends.
  await page.getByTestId("home-create-task").click();
  await page.getByTestId("task-form-create").click();
  await expect(page.getByTestId("task-title")).toHaveText(TITLE);
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  await goTo(page, "home");
  await expect(composer()).toHaveValue("");
});

test("a draft that looks like it holds a credential is refused: the warning shows, the credential is never echoed or kept, the text stays, and a relaunch doesn't bring it back", async ({}, testInfo) => {
  await composer().fill("Rotate the deploy key");
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);
  const typed = `Rotate the deploy key ${TOKEN}`;
  await composer().fill(typed);

  const warning = page.getByTestId("draft-not-kept");
  await expect(warning).toHaveAttribute("data-reason", "credential");
  await expect(warning).toContainText("This draft isn't kept");
  await expect(composer()).toHaveValue(typed);
  // Nowhere else: not in the warning, the sidebar or any other text the window shows, and nothing stored holds it.
  expect((await shownText()).includes(TOKEN)).toBe(false);
  expect((await stored()).includes(TOKEN)).toBe(false);
  // The copy kept before is gone too, so a relaunch can't bring back an older version as if it were the latest.
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);

  await relaunch(testInfo);
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(composer()).toHaveValue("");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  expect((await stored()).includes(TOKEN)).toBe(false);
});

test("a draft holding one of your saved keys inside other words isn't kept: the warning shows, the field keeps it, nothing is listed, and a relaunch brings nothing back", async ({}, testInfo) => {
  // A synthetic key in no recognised format: only the check against the saved keys can catch it.
  const key = "test-key-shell-0123456789";
  await goTo(page, "settings-connections");
  await page.getByTestId("nebius-key").fill(key);
  await page.getByTestId("nebius-key-save").click();
  await expect(page.getByTestId("nebius-key-state")).toContainText("Key saved");
  await goTo(page, "home");
  const typed = `Rotate the deploy key ${key} before Friday`;
  await composer().fill(typed);
  const warning = page.getByTestId("draft-not-kept");
  await expect(warning).toHaveAttribute("data-reason", "credential");
  await expect(warning).toHaveText("This draft isn't kept: it contains one of your saved keys or text in a recognised credential format. What you typed is still here.");
  await expect(composer()).toHaveValue(typed);
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  expect([(await shownText()).includes(key), (await stored()).includes(key)]).toEqual([false, false]);

  await relaunch(testInfo);
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(composer()).toHaveValue("");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  await page.evaluate(() => window.nivra.setNebiusKey(null));
});

test("a draft kept before a key was saved, holding that key's text, leaves the sidebar once the key is saved", async () => {
  const key = "test-key-shell-later-9876543210";
  await composer().fill(`Use ${key} for the staging deploy`);
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);
  await goTo(page, "settings-connections");
  await page.getByTestId("nebius-key").fill(key);
  await page.getByTestId("nebius-key-save").click();
  await expect(page.getByTestId("nebius-key-state")).toContainText("Key saved");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  // The list empties as the save begins; the copy is removed by the check after it, a moment later.
  await expect.poll(async () => (await stored()).includes(key)).toBe(false);
  await goTo(page, "home");
  await expect(composer()).toHaveValue("");
  await page.evaluate(() => window.nivra.setNebiusKey(null));
});

test("while a key is being saved no draft is listed, and once the save settles, even by failing, each is checked and listed again", async ({}, testInfo) => {
  const title = "Draft kept through a slow save";
  await composer().fill(title);
  await expect(page.getByTestId("nav-draft").filter({ hasText: title })).toHaveCount(1);
  // The key's save, in this app only, waits until the test makes it fail; a relaunch brings back the real one.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("settings:nebius-key");
    ipcMain.handle("settings:nebius-key", () => new Promise((_resolve, reject) => ((globalThis as { failSave?: () => void }).failSave = () => reject(new Error("The test made this save fail.")))));
  });
  await goTo(page, "settings-connections");
  await page.getByTestId("nebius-key").fill("test-key-shell-slow-0123456789");
  await page.getByTestId("nebius-key-save").click();
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  await app.evaluate(() => (globalThis as { failSave?: () => void }).failSave?.());
  await expect(page.getByTestId("nebius-error")).toContainText("The test made this save fail.");
  await expect(page.getByTestId("nav-draft").filter({ hasText: title })).toHaveCount(1);

  await relaunch(testInfo);
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(composer()).toHaveValue(title);
  await composer().fill("");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
});

test("New task from a project's Home opens on its repository with the strip; its draft comes back from the sidebar after navigation and a relaunch, and a credential in it is refused with the text kept", async ({}, testInfo) => {
  const title = "Export invoices as CSV";
  const goal = "Invoices can be downloaded as CSV with their totals";
  await composer().fill(title);
  await page.getByTestId("home-create-task").click();
  const form = () => page.getByTestId("new-task");
  await expect(page.getByTestId("task-form-title")).toHaveValue(title);
  await expect(page.getByTestId("task-form-repository")).toHaveValue(new RegExp(PROJECT));
  await expect(form().getByTestId("task-strip")).toBeVisible();
  await page.getByTestId("brief-goal").fill(goal);
  // Functions, since a relaunch makes a new page.
  const kept = () => page.locator('[data-testid="nav-draft"][data-draft-key^="new-task:"]');
  await expect(kept()).toContainText(title);
  for (const away of ["navigation", "relaunch"]) {
    if (away === "navigation") await goTo(page, "home");
    else await relaunch(testInfo);
    await kept().click();
    await expect(page.getByTestId("task-form-title")).toHaveValue(title);
    await expect(page.getByTestId("brief-goal")).toHaveValue(goal);
  }
  await page.getByTestId("brief-goal").fill(`Use ${TOKEN} for the call`);
  await expect(form().getByTestId("draft-not-kept")).toHaveAttribute("data-reason", "credential");
  await expect(page.getByTestId("brief-goal")).toHaveValue(`Use ${TOKEN} for the call`);
  await expect(kept()).toHaveCount(0);
  expect((await stored()).includes(TOKEN)).toBe(false);
  await page.getByTestId("brief-goal").fill(goal);
  await expect(kept()).toHaveCount(1);
});

test("a task page shows the strip at its step, brings the brief editor's draft back after navigation, and opens its project's Environment from readiness", async () => {
  // The form from the test before, saved as a draft task: its own draft goes.
  await page.getByTestId("task-form-create").click();
  const strip = page.getByTestId("page-task").getByTestId("task-strip");
  await expect(strip).toBeVisible();
  await expect(strip.locator('[aria-current="step"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="nav-draft"][data-draft-key^="new-task:"]')).toHaveCount(0);

  await page.getByTestId("task-edit-brief").click();
  const goal = "Invoices can be downloaded as CSV, totals and all";
  await page.getByTestId("brief-goal").fill(goal);
  const brief = page.locator('[data-testid="nav-draft"][data-draft-key^="brief:"]');
  await expect(brief).toHaveCount(1);
  await goTo(page, "home");
  await brief.click();
  await expect(page.getByTestId("task-brief-editor")).toBeVisible();
  await expect(page.getByTestId("brief-goal")).toHaveValue(goal);
  await page.getByTestId("task-brief-cancel").click();
  await expect(brief).toHaveCount(0);

  await page.getByTestId("task-readiness-environment").click();
  await expect(page.getByTestId("environment")).toBeVisible();
  await expect(page.getByTestId("nav-environment")).toHaveAttribute("aria-current", "page");
  await goTo(page, "home");
  await composer().fill("");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
});

test("a bare New task's draft and one the Home composer started are kept apart: both listed, each reopened with its text, context included", async () => {
  const drafts = () => page.locator('[data-testid="nav-draft"][data-draft-key^="new-task:"]');
  await page.getByTestId("nav-tasks").click();
  await page.getByTestId("tasks-new").click();
  await page.getByTestId("task-form-title").fill("Bare draft");
  await page.getByTestId("brief-more").click();
  await page.getByTestId("brief-context").fill("Context kept with the draft");
  await expect(drafts()).toHaveCount(1);
  await goTo(page, "home");
  await composer().fill("Composer draft");
  await page.getByTestId("home-create-task").click();
  await page.getByTestId("brief-goal").fill("Started from the composer");
  await expect(drafts()).toHaveCount(2);

  await page.locator('[data-testid="nav-draft"][data-draft-key$=":home"]').click();
  await expect(page.getByTestId("task-form-title")).toHaveValue("Composer draft");
  await expect(page.getByTestId("brief-goal")).toHaveValue("Started from the composer");
  await page.getByTestId("task-form-cancel").click();
  await expect(drafts()).toHaveCount(1);
  await drafts().click();
  await expect(page.getByTestId("task-form-title")).toHaveValue("Bare draft");
  await expect(page.getByTestId("brief-context")).toBeVisible();
  await expect(page.getByTestId("brief-context")).toHaveValue("Context kept with the draft");
  await page.getByTestId("task-form-cancel").click();
  await expect(drafts()).toHaveCount(0);
  await goTo(page, "home");
  await composer().fill("");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
});

test("the brief editor's draft stays with the version it was begun on: a newer brief never reopens with it, and Discard my edit removes it", async () => {
  const drafts = () => page.locator('[data-testid="nav-draft"][data-draft-key^="brief:"]');
  const openTask = async () => {
    await page.getByTestId("nav-tasks").click();
    await page.getByTestId("task-row").filter({ hasText: "Export invoices as CSV" }).getByTestId("task-open").click();
    await expect(page.getByTestId("task-edit-brief")).toBeVisible();
  };
  // Another save, from the task as it is now: the brief's next version.
  const saveElsewhere = (id: string) =>
    page.evaluate(async (taskId) => {
      const task = await window.nivra.getTask(taskId);
      const { goal: _goal, acceptanceCriteria, scope, exclusions, context, assumptions, checks, acceptanceCases, baseline, frozen } = task.brief.content;
      await window.nivra.reviseBrief(taskId, task.revision, { goal: `Saved elsewhere as v${task.brief.version + 1}`, acceptanceCriteria, scope, exclusions, context, assumptions, checks, acceptanceCases, baseline, frozen });
    }, id);

  await openTask();
  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-goal").fill("Begun on the first version");
  await expect(drafts()).toHaveCount(1);
  const key = (await drafts().getAttribute("data-draft-key"))!;
  const taskId = key.split(":")[1]!;
  await saveElsewhere(taskId);
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-edit-conflict")).toBeVisible();
  await page.getByTestId("brief-goal").fill("Typed again after the conflict");
  await expect.poll(async () => (await stored()).includes("Typed again after the conflict")).toBe(true);
  await expect(drafts()).toHaveAttribute("data-draft-key", key);
  await goTo(page, "home");
  await openTask();
  await expect(page.getByTestId("task-brief-editor")).toHaveCount(0);

  await page.getByTestId("task-edit-brief").click();
  await page.getByTestId("brief-goal").fill("Begun on the second version");
  await expect(drafts()).toHaveCount(2);
  await saveElsewhere(taskId);
  await page.getByTestId("task-brief-save").click();
  await expect(page.getByTestId("task-edit-conflict")).toBeVisible();
  await page.getByTestId("task-edit-discard").click();
  await expect(page.getByTestId("task-brief-editor")).toHaveCount(0);
  await expect(drafts()).toHaveCount(1);
  await expect(drafts()).toHaveAttribute("data-draft-key", key);
  // Nothing on the page restores or removes the first version's draft: the test removes it.
  await page.evaluate((name) => window.localStorage.removeItem(`nivra.drafts.v1:${name}`), key);
  await page.reload();
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
});

test("saving a key from a task's key prompt takes a draft holding it out of storage and the sidebar, and an edit open meanwhile keeps its text", async () => {
  // A synthetic key in no recognised format: only the check against the saved keys can catch it.
  const key = "test-key-prompt-0123456789";
  await composer().fill(`Rotate ${key} on Friday`);
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);
  await page.getByTestId("nav-tasks").click();
  await page.getByTestId("task-row").filter({ hasText: "Export invoices as CSV" }).getByTestId("task-open").click();
  await page.getByTestId("task-edit-brief").click();
  const typed = "Edited while the key is saved";
  await page.getByTestId("brief-goal").fill(typed);
  await page.getByTestId("task-readiness-add-keys").click();
  await page.getByTestId("key-prompt-key").fill(key);
  await page.getByTestId("key-prompt-project-id").fill("project-shell-prompt");
  await page.getByTestId("key-prompt-save").click();
  await expect(page.getByTestId("key-prompt")).toBeHidden();
  await expect.poll(async () => (await stored()).includes(key)).toBe(false);
  await expect(page.getByTestId("nav-draft").filter({ hasText: "Rotate" })).toHaveCount(0);
  await expect(page.getByTestId("brief-goal")).toHaveValue(typed);
  await page.getByTestId("task-brief-cancel").click();
  await page.evaluate(() => window.nivra.setNebiusKey(null).then(() => window.nivra.setNebiusProjectId(null)));
  await goTo(page, "home");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
});

test("a key prompt's save that fails still has the drafts checked again and listed, none hidden for good", async ({}, testInfo) => {
  await composer().fill("Draft through a failed key save");
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);
  // The key's save, in this app only, waits until the test makes it fail; a relaunch brings back the real one.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("settings:nebius-key");
    ipcMain.handle("settings:nebius-key", () => new Promise((_resolve, reject) => ((globalThis as { failSave?: () => void }).failSave = () => reject(new Error("The test made this save fail.")))));
  });
  await page.getByTestId("nav-tasks").click();
  await page.getByTestId("task-row").filter({ hasText: "Export invoices as CSV" }).getByTestId("task-open").click();
  await page.getByTestId("task-readiness-add-keys").click();
  await page.getByTestId("key-prompt-key").fill("test-key-prompt-failing-0123456789");
  await page.getByTestId("key-prompt-project-id").fill("project-shell-prompt");
  await page.getByTestId("key-prompt-save").click();
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  await app.evaluate(() => (globalThis as { failSave?: () => void }).failSave?.());
  await expect(page.getByTestId("key-prompt")).toContainText("The test made this save fail.");
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);

  await relaunch(testInfo);
  await page.evaluate(() => window.nivra.setNebiusProjectId(null));
  await expect(composer()).toHaveValue("Draft through a failed key save");
  await composer().fill("");
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
});

test("Ctrl+K opens the switcher on the project in view, Esc closes it and leaves the typed text, F6 moves between the sidebar and the page, Ctrl+comma opens Settings", async () => {
  await composer().fill(TITLE);
  await page.getByTestId("main").focus();

  await page.keyboard.press("Control+K");
  await expect(page.getByTestId("project-switcher-list")).toBeVisible();
  await expect(page.getByTestId("project-select")).toBeFocused();
  await expect(page.getByTestId("switcher-project").filter({ hasText: PROJECT })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-switcher-list")).toBeHidden();
  await expect(page.getByTestId("project-select")).toBeFocused();
  await expect(composer()).toHaveValue(TITLE);

  // F6 from the sidebar goes to the page, and back; Shift+F6 goes the other way.
  await page.keyboard.press("F6");
  await expect(page.getByTestId("main")).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.getByTestId("project-select")).toBeFocused();
  await page.keyboard.press("Shift+F6");
  await expect(page.getByTestId("main")).toBeFocused();

  // While a dialog is open the shortcuts do nothing: nothing navigates away from it, and it keeps the focus.
  await page.getByTestId("project-remove").click();
  await expect(page.getByTestId("project-remove-confirm")).toBeVisible();
  await page.keyboard.press("Control+Comma");
  await page.keyboard.press("Control+K");
  await page.keyboard.press("F6");
  await expect(page.getByTestId("project-remove-confirm")).toBeVisible();
  await expect(page.getByTestId("page-settings")).toBeHidden();
  await expect(page.getByTestId("project-switcher-list")).toBeHidden();
  await expect(page.getByTestId("main")).not.toBeFocused();
  // Esc closes the dialog, and what was typed is still there.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-remove-confirm")).toBeHidden();
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(composer()).toHaveValue(TITLE);

  await page.keyboard.press("Control+Comma");
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await expect(page.getByTestId("settings-tab-connections")).toHaveAttribute("aria-current", "page");
  // It opens on the section last shown.
  await page.getByTestId("settings-tab-sharing").click();
  await goTo(page, "home");
  await page.keyboard.press("Control+Comma");
  await expect(page.getByTestId("settings-sharing")).toBeVisible();
  await goTo(page, "home");
  await expect(composer()).toHaveValue(TITLE);
});

test("the shortcuts leave zoom's own keys alone: Ctrl with = and 0 still zoom, and Ctrl+K and Ctrl+comma don't", async () => {
  // Zoom is handled in main, before the page sees a key, so the keys are sent the way the system sends them.
  const zoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());
  const press = (keyCode: string) =>
    app.evaluate(({ BrowserWindow }, code) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: code, modifiers: ["control"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: code, modifiers: ["control"] });
    }, keyCode);
  const before = await zoom();
  await press("K");
  await expect(page.getByTestId("project-switcher-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await press(",");
  await expect(page.getByTestId("page-settings")).toBeVisible();
  expect(await zoom()).toBe(before);
  await press("=");
  await expect.poll(zoom).toBeGreaterThan(before);
  await press("0");
  await expect.poll(zoom).toBe(before);
  await goTo(page, "home");
});

test("Esc never stops a run: a held hello run keeps running", async () => {
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 60_000 });
  await goTo(page, "settings-diagnostics");
  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-timeline")).toContainText("Holding a child process");
  await page.keyboard.press("Escape");
  await page.getByTestId("main").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("hello-status")).toHaveText("running");
  await page.getByTestId("hello-cancel").click();
  await expect(page.getByTestId("hello-status")).toHaveText("cancelled");
  await goTo(page, "home");
});

test("a copy button puts exactly the shown text on the clipboard, through main, and says so; main refuses what isn't text or is too long", async () => {
  await goTo(page, "settings-diagnostics");
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  await app.evaluate(({ clipboard }) => clipboard.writeText("before"));
  const shown = (await page.getByTestId("app-details").textContent()) ?? "";
  expect(shown).toContain("Nivra ");
  await page.getByTestId("copy-app-details").click();
  await expect(page.getByTestId("toast").filter({ hasText: "Copied" })).toBeVisible();
  expect(await clipboard()).toBe(shown);

  // Main takes text only, and only so much of it: a refusal says what happened, and nothing is copied.
  const refusal = (value: unknown) => page.evaluate((given) => (window.nivra.copyText as (value: unknown) => Promise<void>)(given).then(() => null, (error: Error) => error.message), value);
  expect(await refusal("x".repeat(65_537))).toContain("more than the 65,536 Nivra copies at once, so nothing was copied.");
  expect(await refusal(42)).toContain("Nivra copies only text, so nothing was copied.");
  expect(await clipboard()).toBe(shown);

  // The engine's own details copy the same way.
  const engine = page.getByTestId("engine-details");
  await expect(engine).toContainText("Engine ");
  await page.getByTestId("copy-engine-details").click();
  await expect.poll(clipboard).toBe((await engine.textContent()) ?? "");
  await expect(page.getByTestId("copy-failed")).toHaveCount(0);
  await goTo(page, "home");
});

test("the draft check takes only text, and only so much, and answers only yes or no", async () => {
  const check = (value: unknown) =>
    page.evaluate((given) => (window.nivra.draftHasSavedKey as (value: unknown) => Promise<boolean>)(given).then((answer) => ({ answer, error: null }), (error: Error) => ({ answer: null, error: error.message })), value);
  expect(await check("Add CSV export for invoices")).toEqual({ answer: false, error: null });
  const long = await check("x".repeat(262_145));
  expect([long.answer, long.error?.includes("Nivra checks a draft of at most 262,144 characters of text, so this one wasn't checked.")]).toEqual([null, true]);
  const notText = await check(42);
  expect([notText.answer, notText.error?.includes("so this one wasn't checked.")]).toEqual([null, true]);
});

test("Home and Settings show what another place changed: sharing and uploads allowed, research turned on", async () => {
  const projectId = (await page.evaluate(() => window.nivra.listProjects()))[0]!.id;
  // As a task page and a research dialog would, while another place is in view.
  await goTo(page, "tasks");
  await page.evaluate(async (id) => {
    await window.nivra.setSharing(id, true);
    await window.nivra.setCloudExecution(id, true);
    await window.nivra.setWebResearch(true);
  }, projectId);
  await goTo(page, "home");
  await expect(page.getByTestId("home-setup-sharing")).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("home-setup-uploads")).toHaveAttribute("data-state", "ok");
  await goTo(page, "settings-sharing");
  await expect(page.getByTestId("sharing-model-context")).toBeChecked();
  await expect(page.getByTestId("sharing-uploads")).toBeChecked();
  await expect(page.getByTestId("web-research-switch")).toBeChecked();
  // Put back as they were.
  await page.evaluate(async (id) => {
    await window.nivra.setSharing(id, false);
    await window.nivra.setCloudExecution(id, false);
    await window.nivra.setWebResearch(false);
  }, projectId);
  await goTo(page, "home");
  await expect(page.getByTestId("home-setup-sharing")).toHaveAttribute("data-state", "off");
});

test("a narrow window folds the sidebar behind the menu button; Settings and a dialog scroll inside themselves, their actions in reach, and nothing scrolls sideways", async () => {
  // 820 by 900 at 150% zoom, then the window's least height: 547 by 600, then 547 by 373 CSS px.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setContentSize(820, 900);
    window.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(547);
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await expect(page.getByTestId("top-bar")).toBeVisible();
  await expect(page.getByTestId("nav-home")).not.toBeInViewport();
  const menu = page.getByTestId("nav-menu");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("nav-home")).toBeInViewport();
  await expect(page.getByTestId("nav-home")).toBeFocused();
  // Esc closes it, and the focus goes back to the menu button.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  expect(await sideways()).toBeLessThanOrEqual(0);

  // Esc in the top bar's switcher closes only the switcher, not the sidebar open beside it.
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("project-select").click();
  await expect(page.getByTestId("project-switcher-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-switcher-list")).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "true");

  // From the sidebar over the page, the place it opens takes the focus.
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await expect(page.getByTestId("nav-settings")).not.toBeInViewport();
  await expect(page.getByTestId("main")).toBeFocused();
  // The section links overflow, and scroll sideways in their own box; the page doesn't.
  const links = page.getByTestId("settings-tabs-scroll");
  await expect(links).toBeVisible();
  expect(await links.locator(".mantine-ScrollArea-viewport").evaluate((box) => box.scrollWidth > box.clientWidth)).toBe(true);
  await page.getByTestId("settings-tab-diagnostics").click();
  await expect(page.getByTestId("settings-tab-diagnostics")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-tab-diagnostics")).toBeInViewport();
  expect(await sideways()).toBeLessThanOrEqual(0);
  // The page scrolls inside the main area, never the window, under the top bar, which stays.
  await page.getByTestId("diagnostics-app").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("diagnostics-app")).toBeInViewport();
  expect(await page.getByTestId("main").evaluate((main) => main.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByTestId("top-bar")).toBeInViewport();
  await page.getByTestId("settings-tab-connections").scrollIntoViewIfNeeded();
  await page.getByTestId("settings-tab-connections").click();
  await expect(page.getByTestId("settings-connections")).toBeVisible();
  expect(await sideways()).toBeLessThanOrEqual(0);

  // A dialog in the shortest window: its title stays, its body scrolls inside it, and its actions stay in reach.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(820, 560));
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(380);
  await menu.click();
  await page.getByTestId("nav-home").click();
  await expect(composer()).toHaveValue(TITLE);
  expect(await sideways()).toBeLessThanOrEqual(0);
  await page.getByTestId("project-remove").scrollIntoViewIfNeeded();
  await page.getByTestId("project-remove").click();
  // Mantine's dialog box is the part that scrolls.
  const dialog = page.getByRole("dialog");
  const title = dialog.getByRole("heading", { name: `Remove ${PROJECT} from Nivra?` });
  await expect(title).toBeInViewport();
  await expect(page.getByTestId("project-remove-confirm")).toBeInViewport();
  const scrolls = await dialog.evaluate((box) => ({ overflows: box.scrollHeight > box.clientHeight, fits: box.getBoundingClientRect().bottom <= window.innerHeight + 1 }));
  expect(scrolls).toEqual({ overflows: true, fits: true });
  await dialog.evaluate((box) => box.scrollTo({ top: box.scrollHeight }));
  await expect.poll(() => dialog.evaluate((box) => box.scrollTop)).toBeGreaterThan(0);
  await expect(title).toBeInViewport();
  await expect(page.getByTestId("project-remove-confirm")).toBeInViewport();
  expect(await sideways()).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-remove-confirm")).toBeHidden();
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
});

test("storage that refuses every write: a draft says it couldn't be kept and keeps the text, and Dark applies with a note that it lasts until Nivra closes", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.webContents.setZoomFactor(1);
    window.setContentSize(1280, 900);
  });
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  });
  // The draft kept before storage refused is still there, listed and restorable.
  await expect(page.getByTestId("nav-draft")).toContainText(TITLE);
  await composer().fill("Fix rounding in invoice totals");
  const warning = page.getByTestId("draft-not-kept");
  await expect(warning).toHaveAttribute("data-reason", "storage");
  await expect(warning).toHaveText("This draft couldn't be kept on this computer. What you typed is still here. An earlier copy may still be listed under Unsaved drafts.");
  await expect(composer()).toHaveValue("Fix rounding in invoice totals");
  await expect(page.getByTestId("nav-draft")).toHaveCount(1);
  await expect(page.getByTestId("nav-draft")).toContainText(TITLE);

  await goTo(page, "settings-preferences");
  await expect(page.getByTestId("appearance-not-kept")).toHaveCount(0);
  await page.getByTestId("appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  await expect(page.getByTestId("appearance-not-kept")).toHaveText("Nivra couldn't keep this choice on this computer. It applies until Nivra closes.");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 10, 10)");
});

test("a read that fails shows as a failure, never as an empty list or a wait that doesn't end", async () => {
  // Stand-ins for failing reads, in this app only, then the page loaded again so every read is made afresh.
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ["tasks:list", "settings:get", "conversations:create"]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        throw new Error("The test made this read fail.");
      });
    }
  });
  await page.reload();
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  await expect(page.getByTestId("host-error")).toContainText("The test made this read fail.");
  await expect(page.getByTestId("host-error")).toContainText("If this keeps happening, quit Nivra and open it again.");
  await expect(page.getByTestId("host-error")).not.toContainText("tries again");
  await expect(page.getByTestId("home-tasks-state")).toContainText("Nivra couldn't read the tasks");
  await expect(page.getByText(`No tasks in ${PROJECT} yet`)).toHaveCount(0);
  await expect(page.getByTestId("home-setup-key")).toContainText("Nebius key and project ID: couldn't be read");
  await expect(page.getByTestId("home-create-task")).toBeDisabled();
  await expect(page.getByTestId("main")).toContainText("Tasks can't be written until Nivra can read them again");
  // A conversation that couldn't start says so under its button, and stays said.
  await page.getByTestId("home-conversation").click();
  await expect(page.getByTestId("home-conversation-error")).toContainText("Nivra couldn't start the conversation: The test made this read fail.");
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
});

test("while the projects can't be read, no draft is called removed: each stays listed to open, with nothing to discard", async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("projects:list");
    ipcMain.handle("projects:list", () => {
      throw new Error("The test made this read fail.");
    });
  });
  await page.reload();
  await expect(page.getByTestId("host-error")).toContainText("The test made this read fail.");
  await expect(page.getByTestId("nav-draft").filter({ hasText: TITLE })).toHaveCount(1);
  await expect(page.locator('[data-testid="nav-draft"][data-gone]')).toHaveCount(0);
  await expect(page.getByTestId("nav-draft-discard")).toHaveCount(0);
});

test("with a secrets file Nivra can't read, a draft is unchecked and not kept: the field keeps it, nothing is listed or stored, and nothing of the file shows", async ({}, testInfo) => {
  // Nothing under the drafts prefix from earlier tests, so whatever is there afterwards is this test's.
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith("nivra.drafts.v1:")) window.localStorage.removeItem(key);
  });
  await app.close();
  const marker = "corrupt-secrets-marker-0123456789";
  writeFileSync(join(root, "user data", "secrets.json"), `{"NEBIUS_API_KEY": {"scheme": "plain", "value": "${marker}`);
  await launch(testInfo);
  await expect(page.getByTestId("home-title")).toHaveText(PROJECT);
  const typed = "Draft while the keys can't be read";
  await composer().fill(typed);
  const warning = page.getByTestId("draft-not-kept");
  await expect(warning).toHaveAttribute("data-reason", "unchecked");
  await expect(warning).toHaveText("This draft couldn't be checked against your saved keys, so it isn't kept. What you typed is still here.");
  await expect(composer()).toHaveValue(typed);
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  const kept = await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith("nivra.drafts.v1:")).length);
  expect([kept, (await shownText()).includes(marker)]).toEqual([0, false]);
});

test("New mission on the general Home opens the mission form at once, and Missions in the sidebar still shows the list", async () => {
  await openSwitcher(page);
  await page.getByTestId("switcher-general").click();
  await page.getByTestId("home-new-mission").click();
  await expect(page.getByTestId("mission-new")).toBeVisible();
  await page.getByTestId("nav-missions").click();
  await expect(page.getByTestId("missions-new")).toBeVisible();
  await expect(page.getByTestId("mission-new")).toHaveCount(0);
});
