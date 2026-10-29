import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type TestInfo } from "@playwright/test";
import type { BudgetPolicyDraft } from "@nivra/domain";

/**
 * The shared budget's API in the built app (NIV-66): the calls the budget screen and the development harness both use,
 * through the preload, the trusted-sender check and the argument check. The app's own price list can't keep a budget in
 * dollars yet, so one is refused, saying why, and the budget stays as it was; the budget off (the existing per-run
 * limits) and a counts-only budget are each the person's own choice, and a counts-only one is saved and kept across a
 * relaunch; bad input never reaches the host; a month is confirmed only by the label shown; and a damaged history opens
 * with the budget needing recovery and changes refused. A budget in dollars that can be kept is tested through the
 * host, with a test price list (host-budget.test.ts).
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
let root: string;

test.afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

async function launch(testInfo: TestInfo, userData: string) {
  const isolation = [`--user-data-dir=${userData}`, `--nivra-engine-home=${join(root, "engine home")}`];
  const executable = testInfo.project.metadata["executable"] as string | undefined;
  const app = await electron.launch(
    executable ? { executablePath: join(desktop, executable), args: isolation, chromiumSandbox: true } : { args: [desktop, ...isolation], chromiumSandbox: true },
  );
  return { app, page: await app.firstWindow() };
}

/** A budget of no money: it holds the counted services' monthly allowances alone. */
const COUNTS = (draft: BudgetPolicyDraft): BudgetPolicyDraft => ({ ...draft, preset: "counts", currency: null, monthlyMicros: null, thresholds: [], researchCreditMicros: null });
const DRAFT: BudgetPolicyDraft = {
  preset: "build",
  currency: "USD",
  monthlyMicros: 100_000_000,
  timezone: "Asia/Singapore",
  thresholds: [50, 80, 100],
  sublimits: { dailyMicros: null, perQueueMicros: null, perTaskMicros: null, projects: [], profiles: [] },
  allowances: { sandboxOperations: 2_000, sandboxSeconds: 36_000, researchCredits: 200 },
  researchCreditMicros: null,
};

test("the budget's calls refuse a dollar budget the app can't keep yet, save a counts-only one, refuse bad input, keep both across a relaunch, and block changes after a damaged history", async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra budget e2e ü%# "));
  const userData = join(root, "user data");

  let { app, page } = await launch(testInfo, userData);
  /** Sets a policy, or turns the budget off with null, and says what came back: "accepted", or the error. */
  const attempt = (draft: BudgetPolicyDraft | null) =>
    page.evaluate(async (draft) => {
      try {
        await window.nivra.setBudgetPolicy(draft);
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }, draft);
  expect(await page.evaluate(() => window.nivra.getBudgetPolicy())).toBeNull();
  const dollars = await attempt(DRAFT);
  // Today's list (version 2): Super VL's prices are in US dollars, so the currency missing is the other models'.
  expect(dollars).toMatch(
    /Nivra can't keep a monthly budget in dollars yet: it hasn't established the currency of its prices for nvidia\/nemotron-3-super-120b-a12b, nvidia\/Nemotron-3_5-Lightning and nvidia\/Nemotron-3-Ultra-550b-a55b, the most a request can cost with any model on its price list or whether listing its models is charged,/,
  );
  expect(dollars).toMatch(/Your monthly budget stays off, and the existing per-run limits apply\./);
  expect(await page.evaluate(() => window.nivra.getBudgetPolicy())).toBeNull();
  const off = await page.evaluate(() => window.nivra.setBudgetPolicy(null));
  expect([off.policy, off.poolMicros, off.gaps.includes("currency-unconfirmed"), off.gaps.includes("bounds-unestablished")]).toEqual([null, null, true, true]);
  expect(await attempt({ ...DRAFT, monthlyMicros: 1.5 })).toMatch(/Invalid arguments for budget:set-policy/);
  const months = await page.evaluate(async (shown) => {
    const outcome = async (month: string) => {
      try {
        await window.nivra.confirmBudgetMonth(month);
        return "confirmed";
      } catch (error) {
        return String(error);
      }
    };
    return [await outcome("next month"), await outcome(shown), await outcome(shown)];
  }, off.clock.computerMonth);
  expect(months[0]).toMatch(/Invalid arguments for budget:confirm-month/);
  // The ledger's first month opens on the person's word; the same month again is refused.
  expect(months[1]).toBe("confirmed");
  expect(months[2]).toMatch(/still the same budget month/);
  // Counts only, its own choice: saved with today's price list, since it holds no money.
  const counts = await page.evaluate((draft) => window.nivra.setBudgetPolicy(draft), COUNTS(DRAFT));
  expect([counts.policy?.preset, counts.poolMicros, counts.counted.allowed]).toEqual(["counts", null, DRAFT.allowances]);
  expect(await page.evaluate(() => window.nivra.listEngines())).toEqual([]);
  await app.close();

  ({ app, page } = await launch(testInfo, userData));
  const relaunched = await page.evaluate(() => window.nivra.budgetSummary());
  expect([relaunched.policy?.preset, relaunched.period?.label, relaunched.recovery]).toEqual(["counts", off.clock.computerMonth, null]);
  expect(await attempt(DRAFT)).toMatch(/can't keep a monthly budget in dollars yet: .* Your budget wasn't changed: it still holds counts only\./);
  await app.close();

  writeFileSync(join(userData, "workspace.db"), "this is not a database ".repeat(40));
  rmSync(join(userData, "workspace.db-wal"), { force: true });
  ({ app, page } = await launch(testInfo, userData));
  const summary = await page.evaluate(() => window.nivra.budgetSummary());
  expect(summary.recovery?.reason).toBe("workspace-kept-aside");
  expect(await attempt(DRAFT)).toMatch(/budget history needs recovery first/);
  expect(await attempt(null)).toMatch(/budget history needs recovery first/);
  await app.close();
});
