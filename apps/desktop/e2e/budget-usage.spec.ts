import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { CURRENT_PRICES, NO_SUBLIMITS, requestMsFor, TASK_RUN_BOUNDS, taskWorkLimits, DEFAULT_WORKING_REQUESTS } from "@nivra/domain";
import { BudgetGuard } from "../src/main/budget-guard.ts";
import { establishedMonth, ledgerState, markDispatching, recordJournal, setPolicy, writeGrant } from "../src/main/budget-store.ts";
import { openWorkspace } from "../src/main/workspace-db.ts";
import { goTo } from "./places.ts";

/**
 * Settings › Budget and usage in this build (NIV-56): read-only, Nate's words, and the per-run limits the engine
 * enforces, as main reads them from the domain's one source: no usage, no money, no controls. When main can't give
 * them, the section says so and shows no figure. A fresh profile, no project needed.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORDS = "Coding model requests are recorded in the shared budget ledger. You can explicitly include coding in the shared monthly request allowance. Outside that pool, each attempt has a finite working request maximum, editable in its preview, with a hand-in reserved separately. Time or context can stop work sooner. Research, sandbox operations and other agents retain their existing accounting and limits.";

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

test("shows precise Companion and planning coverage and the engine's separate per-run limits", async () => {
  await goTo(page, "settings-budget");
  const section = page.getByTestId("budget-usage");
  await expect(page.getByTestId("settings-tab-budget")).toHaveAttribute("aria-current", "page");
  await expect(section.getByTestId("budget-usage-note")).toHaveText(WORDS);

  const defaults = taskWorkLimits({ workingRequests: DEFAULT_WORKING_REQUESTS });
  const n = (value: number) => value.toLocaleString("en-GB");
  const limit = (key: string) => section.locator(`[data-testid="budget-usage-limit"][data-key="${key}"]`);
  await expect(limit("requests")).toContainText(
    `At most ${n(defaults.requests)} model requests in a run, each of up to ${n(requestMsFor(TASK_RUN_BOUNDS.outputTokensPerRequest) / 1000)} s and ${n(TASK_RUN_BOUNDS.outputTokensPerRequest)} output tokens.`,
  );
  await expect(limit("requests")).toContainText("it isn't how long one takes. The output cap counts the model's reasoning tokens too.");
  await expect(limit("input")).toContainText(`an estimated ${n(defaults.inputTokens)} input tokens: an estimated admission budget, not a cap.`);
  await expect(limit("tools")).toContainText(
    `${n(defaults.toolCalls)} tool calls, of which ${n(defaults.writes)} writes and ${n(defaults.runs)} runs of a case or check, each command up to ${n(TASK_RUN_BOUNDS.checkSeconds)} s.`,
  );
  await expect(limit("time")).toContainText(`The sandbox for ${n(TASK_RUN_BOUNDS.sessionMinutes)} minutes, and the whole run for ${n(TASK_RUN_BOUNDS.runMinutes)} minutes.`);
  await expect(section.getByTestId("budget-usage-brief")).toContainText("Nebius operations, and the baseline checks it runs first, also depend on its brief's checks");

  // Read-only: no field, button or switch; no money, and no usage stated as a zero.
  await expect(section.locator("input, textarea, select, button, [role=button], [role=switch], [role=checkbox], [role=radio]")).toHaveCount(0);
  const text = (await section.textContent()) ?? "";
  expect([/\$|US\$|cost|price/i.test(text), /(^|[^\d,.])0([^\d,.]|$)/.test(text)]).toEqual([false, false]);
});

test("coding coverage expands only on Save and names previously recorded coding usage", async () => {
  await goTo(page, "settings-budget");
  await page.getByTestId("companion-limit-enabled").check();
  await page.getByTestId("companion-limit").fill("100");
  await page.getByTestId("coding-coverage").check();
  await expect(page.getByTestId("coding-coverage-preview")).toContainText("Already recorded coding this month");
  expect((await page.evaluate(() => window.nivra.getBudgetPolicy()))?.modelRequestLimits ?? []).toEqual([]);
  await page.getByTestId("companion-limit-save").click();
  await expect.poll(() => page.evaluate(async () => (await window.nivra.getCompanionUsage()).coverage)).toBe("companion-planning-and-coding");
  const policy = await page.evaluate(() => window.nivra.getBudgetPolicy());
  expect(policy?.modelRequestLimits).toEqual([{ pool: "companion-planning-and-coding", monthlyRequests: 100 }]);
  await page.getByTestId("coding-coverage").uncheck();
  await page.getByTestId("companion-limit-save").click();
  await expect.poll(() => page.evaluate(async () => (await window.nivra.getCompanionUsage()).coverage)).toBe("companion-and-planning");
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


test("sets one Companion and planning monthly request allowance and shows separate feature usage", async () => {
  await goTo(page, "settings-budget");
  const view = page.getByTestId("companion-usage");
  await expect(view).toContainText("Coding is included only when you explicitly save expanded coverage");
  await expect(view.getByTestId("coding-coverage")).not.toBeChecked();
  await expect(view.getByRole("heading", { name: "Companion and planning", exact: true })).toBeVisible();
  await view.getByTestId("companion-limit-enabled").check();
  await view.getByTestId("companion-limit").fill("12");
  await expect(view.getByLabel("Monthly AI request limit", { exact: true })).toHaveValue("12");
  await view.getByTestId("companion-limit-save").click();
  await expect.poll(async () => (await page.evaluate(() => window.nivra.getCompanionUsage())).limit).toBe(12);
  await page.reload(); await goTo(page,"settings-budget");
  await expect(page.getByTestId("companion-limit")).toHaveValue("12");
  const usage = await page.evaluate(() => window.nivra.getCompanionUsage());
  expect([usage.used,usage.reserved,usage.remaining]).toEqual([0,0,12]);
  expect([usage.features.companion.used, usage.features.planning.used]).toEqual([0, 0]);
  await expect(page.getByTestId("ai-usage-companion")).toContainText("Companion: 0 used, 0 reserved");
  await expect(page.getByTestId("ai-usage-planning")).toContainText("Planning AI: 0 used, 0 reserved");
});

/** An actual exhausted, settled ledger from last month, with no engine or provider involved. */
function seedExhaustedMonth(userData: string) {
  mkdirSync(userData, { recursive: true });
  const today = new Date();
  const previous = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 2);
  const opening = openWorkspace(join(userData, "workspace.db"));
  expect(opening.state).toBe("ready");
  if (opening.state !== "ready") throw new Error("The budget fixture couldn't open its workspace.");
  const workspace = opening.db;
  try {
    setPolicy(workspace, { preset: "counts", currency: null, monthlyMicros: null, timezone: "UTC", thresholds: [], sublimits: NO_SUBLIMITS, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 }, researchCreditMicros: null, modelRequestLimits: [{ feature: "companion", monthlyRequests: 1 }] }, previous, CURRENT_PRICES);
    const written = writeGrant(workspace, { requestId: randomUUID(), workflow: "companion", targetId: "local", attribution: { feature: "companion", projectId: null, taskId: null, attemptId: null, queueId: null, queueItemId: null, profile: null }, models: [CURRENT_PRICES.models[0]!.model], productive: { requests: 1, outputTokens: 4000 }, finalisation: { requests: 0, outputTokens: 0 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 }, extends: null, need: null }, { now: previous, catalogue: CURRENT_PRICES, timezone: "UTC", verified: ledgerState(workspace) });
    expect("grant" in written).toBe(true);
    if (!("grant" in written)) throw new Error("The budget fixture couldn't reserve its request.");
    const grantId = written.grant.id;
    markDispatching(workspace, grantId, "budget-fixture-home", previous, ledgerState(workspace));
    const settled = recordJournal(workspace, grantId, [{ id: randomUUID(), grantId, seq: 1, kind: "model-request", model: CURRENT_PRICES.models[0]!.model, seat: "worker", instructionsSha256: null, state: "reported", boundMicros: null, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }, units: null, amountMicros: null }], { grantId, kind: "complete", rows: 1, instanceId: randomUUID(), sealedAt: new Date(previous).toISOString() }, previous);
    expect("refused" in settled).toBe(false);
    const state = ledgerState(workspace)!;
    new BudgetGuard(join(userData, "budget-guard.log")).append({ ...state, month: establishedMonth(workspace), recovery: null, at: new Date(previous).toISOString() });
    return new Date(previous).toISOString().slice(0, 7);
  } finally {
    workspace.close();
  }
}

test("only explicit month confirmation renews an exhausted settled allowance, without starting an engine", async ({}, testInfo) => {
  const fixture = mkdtempSync(join(tmpdir(), "nivra budget month ü "));
  const userData = join(fixture, "user data");
  const previousMonth = seedExhaustedMonth(userData);
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${userData}`, `--nivra-engine-home=${join(fixture, "engine home")}`];
  const monthApp = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  try {
    const monthPage = await monthApp.firstWindow();
    await goTo(monthPage, "settings-budget");
    const view = monthPage.getByTestId("companion-usage");
    await expect(view.getByTestId("companion-usage-count")).toContainText(`${previousMonth}: 1 requests used, 0 reserved`);
    await expect(view).toContainText("0 requests remain available");
    const shown = await monthPage.evaluate(() => window.nivra.budgetSummary());
    const currentMonth = shown.clock.computerMonth;
    expect(currentMonth > previousMonth).toBe(true);
    await view.getByTestId("companion-limit-save").click();
    await view.getByRole("button", { name: "Refresh usage" }).click();
    await expect(view).toContainText(`${previousMonth}: 1 requests used`);
    await expect(view).toContainText("0 requests remain available");
    await expect(view.getByTestId("companion-month-confirm")).toHaveText(`Confirm ${currentMonth} has begun`);
    await view.getByTestId("companion-month-confirm").click();
    await expect(view.getByTestId("companion-usage-count")).toContainText(`${currentMonth}: 0 requests used, 0 reserved`);
    await expect(view).toContainText("1 requests remain available");
    await expect(view.getByTestId("companion-month-confirmation")).toHaveCount(0);
    expect(await monthPage.evaluate(() => window.nivra.listEngines())).toEqual([]);
    await monthPage.reload();
    await goTo(monthPage, "settings-budget");
    await expect(monthPage.getByTestId("companion-usage-count")).toContainText(`${currentMonth}: 0 requests used`);
    expect(new BudgetGuard(join(userData, "budget-guard.log")).last()?.month).toBe(currentMonth);
  } finally {
    await monthApp.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("month confirmation cannot bypass budget history recovery", async ({}, testInfo) => {
  const fixture = mkdtempSync(join(tmpdir(), "nivra budget month recovery ü "));
  const userData = join(fixture, "user data");
  seedExhaustedMonth(userData);
  writeFileSync(join(userData, "workspace.db"), "not a SQLite budget history ".repeat(40));
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  const args = [`--user-data-dir=${userData}`, `--nivra-engine-home=${join(fixture, "engine home")}`];
  const recoveryApp = await electron.launch(executable ? { executablePath: join(desktop, executable), args, chromiumSandbox: true } : { args: [desktop, ...args], chromiumSandbox: true });
  try {
    const recoveryPage = await recoveryApp.firstWindow();
    await goTo(recoveryPage, "settings-budget");
    await expect(recoveryPage.getByTestId("companion-usage")).toContainText("budget history needs recovery");
    await expect(recoveryPage.getByTestId("companion-month-confirm")).toBeDisabled();
    expect(await recoveryPage.evaluate(() => window.nivra.listEngines())).toEqual([]);
  } finally {
    await recoveryApp.close();
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
  }
});
