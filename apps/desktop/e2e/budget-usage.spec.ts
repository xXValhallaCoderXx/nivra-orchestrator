import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { requestMsFor, TASK_RUN_BOUNDS } from "@nivra/domain";
import { goTo } from "./places.ts";

/**
 * Settings › Budget and usage in this build (NIV-56): read-only, Nate's words, and the per-run limits the engine
 * enforces, as main reads them from the domain's one source: no usage, no money, no controls. When main can't give
 * them, the section says so and shows no figure. A fresh profile, no project needed.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORDS = "Other agents, research and sandbox operations aren't covered by the Companion AI request allowance. Their existing per-run limits apply.";

let root: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra e2e budget ü%# "));
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${join(root, "user data")}`, `--nivra-engine-home=${join(root, "engine home")}`];
  app = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

test("shows precise companion coverage and the engine's separate per-run limits", async () => {
  await goTo(page, "settings-budget");
  const section = page.getByTestId("budget-usage");
  await expect(page.getByTestId("settings-tab-budget")).toHaveAttribute("aria-current", "page");
  await expect(section.getByTestId("budget-usage-note")).toHaveText(WORDS);

  const n = (value: number) => value.toLocaleString("en-GB");
  const limit = (key: string) => section.locator(`[data-testid="budget-usage-limit"][data-key="${key}"]`);
  await expect(limit("requests")).toContainText(
    `At most ${n(TASK_RUN_BOUNDS.modelRequests)} model requests in a run, each of up to ${n(requestMsFor(TASK_RUN_BOUNDS.outputTokensPerRequest) / 1000)} s and ${n(TASK_RUN_BOUNDS.outputTokensPerRequest)} output tokens.`,
  );
  await expect(limit("requests")).toContainText("it isn't how long one takes. The output cap counts the model's reasoning tokens too.");
  await expect(limit("input")).toContainText(`an estimated ${n(TASK_RUN_BOUNDS.estimatedInputTokens)} input tokens: an estimated admission budget, not a cap.`);
  await expect(limit("tools")).toContainText(
    `${n(TASK_RUN_BOUNDS.toolCalls)} tool calls, of which ${n(TASK_RUN_BOUNDS.writes)} writes and ${n(TASK_RUN_BOUNDS.runs)} runs of a case or check, each command up to ${n(TASK_RUN_BOUNDS.checkSeconds)} s.`,
  );
  await expect(limit("time")).toContainText(`The sandbox for ${n(TASK_RUN_BOUNDS.sessionMinutes)} minutes, and the whole run for ${n(TASK_RUN_BOUNDS.runMinutes)} minutes.`);
  await expect(section.getByTestId("budget-usage-brief")).toContainText("Nebius operations, and the baseline checks it runs first, also depend on its brief's checks");

  // Read-only: no field, button or switch; no money, and no usage stated as a zero.
  await expect(section.locator("input, textarea, select, button, [role=button], [role=switch], [role=checkbox], [role=radio]")).toHaveCount(0);
  const text = (await section.textContent()) ?? "";
  expect([/\$|US\$|cost|price/i.test(text), /(^|[^\d,.])0([^\d,.]|$)/.test(text)]).toEqual([false, false]);
});

test("when main can't give the limits, the section says so and shows no figure", async () => {
  // A stand-in for a failing call, in this app only, then the page loaded again so the section asks afresh.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("tasks:run-limits");
    ipcMain.handle("tasks:run-limits", () => {
      throw new Error("No limits here.");
    });
  });
  await page.reload();
  await goTo(page, "settings-budget");
  const section = page.getByTestId("budget-usage");
  await expect(section.getByTestId("budget-usage-error")).toHaveText("Nivra couldn't read the per-run limits, so none are shown here. Each run's preview shows its bounds before it starts.");
  await expect(section.getByTestId("budget-usage-note")).toHaveText(WORDS);
  await expect(section.getByTestId("budget-usage-limit")).toHaveCount(0);
  expect(/\d/.test((await section.textContent()) ?? "")).toBe(false);
});


test("sets a companion-only monthly request allowance and keeps other per-run limits separate", async () => {
  await goTo(page, "settings-budget");
  const view = page.getByTestId("companion-usage");
  await expect(view).toContainText("doesn't cover other agents");
  await view.getByTestId("companion-limit-enabled").check();
  await view.getByTestId("companion-limit").fill("12");
  await view.getByTestId("companion-limit-save").click();
  await expect.poll(async () => (await page.evaluate(() => window.nivra.getCompanionUsage())).limit).toBe(12);
  await page.reload(); await goTo(page,"settings-budget");
  await expect(page.getByTestId("companion-limit")).toHaveValue("12");
  const usage = await page.evaluate(() => window.nivra.getCompanionUsage());
  expect([usage.used,usage.reserved,usage.remaining]).toEqual([0,0,12]);
});
