import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

  // Creating the task takes the title to the new task's page and ends the composer's draft. Nothing is sent.
  await page.getByTestId("home-create-task").click();
  await expect(page.getByTestId("page-new-task")).toBeVisible();
  await expect(page.getByTestId("task-form-title")).toHaveValue(TITLE);
  await expect(page.getByTestId("nav-draft")).toHaveCount(0);
  expect((await page.evaluate(() => window.nivra.listTasks())).tasks).toHaveLength(0);
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

  // Esc closes a dialog, and what was typed is still there.
  await page.getByTestId("project-remove").click();
  await expect(page.getByTestId("project-remove-confirm")).toBeVisible();
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

  await menu.click();
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await expect(page.getByTestId("nav-settings")).not.toBeInViewport();
  // The section links scroll sideways in their own box; the page doesn't.
  const links = page.getByTestId("settings-tabs-scroll");
  await expect(links).toBeVisible();
  await page.getByTestId("settings-tab-diagnostics").click();
  await expect(page.getByTestId("settings-tab-diagnostics")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-tab-diagnostics")).toBeInViewport();
  expect(await sideways()).toBeLessThanOrEqual(0);
  // The page scrolls inside the main area, under the top bar, which stays.
  await page.getByTestId("diagnostics-app").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("diagnostics-app")).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
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
  await composer().fill("Fix rounding in invoice totals");
  const warning = page.getByTestId("draft-not-kept");
  await expect(warning).toHaveAttribute("data-reason", "storage");
  await expect(warning).toHaveText("This draft couldn't be kept on this computer. What you typed is still here.");
  await expect(composer()).toHaveValue("Fix rounding in invoice totals");

  await goTo(page, "settings-preferences");
  await expect(page.getByTestId("appearance-not-kept")).toHaveCount(0);
  await page.getByTestId("appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  await expect(page.getByTestId("appearance-not-kept")).toHaveText("Nivra couldn't keep this choice on this computer. It applies until Nivra closes.");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 10, 10)");
});
