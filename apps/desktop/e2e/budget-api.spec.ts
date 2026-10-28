import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type TestInfo } from "@playwright/test";
import type { BudgetPolicyDraft } from "@nivra/domain";

/**
 * The shared budget's API in the built app (NIV-66): the calls the budget screen and the development harness both use,
 * through the preload, the trusted-sender check and the argument check. A policy is saved and survives a relaunch, and
 * can be turned off; bad input never reaches the host; a month is confirmed only by the label shown; and a damaged
 * history opens with the budget needing recovery and changes refused.
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

test("the budget's calls set a policy, refuse bad input, keep it across a relaunch, and block changes after a damaged history", async ({}, testInfo) => {
  root = mkdtempSync(join(tmpdir(), "nivra budget e2e ü%# "));
  const userData = join(root, "user data");

  let { app, page } = await launch(testInfo, userData);
  expect(await page.evaluate(() => window.nivra.getBudgetPolicy())).toBeNull();
  const saved = await page.evaluate((draft) => window.nivra.setBudgetPolicy(draft), DRAFT);
  expect([saved.policy?.version, saved.poolMicros, saved.recovery]).toEqual([1, 100_000_000, null]);
  const refused = await page.evaluate(async (draft) => {
    try {
      await window.nivra.setBudgetPolicy({ ...draft, monthlyMicros: 1.5 });
      return "accepted";
    } catch (error) {
      return String(error);
    }
  }, DRAFT);
  expect(refused).toMatch(/Invalid arguments for budget:set-policy/);
  const months = await page.evaluate(async (shown) => {
    const outcome = async (month: string) => {
      try {
        await window.nivra.confirmBudgetMonth(month);
        return "confirmed";
      } catch (error) {
        return String(error);
      }
    };
    return [await outcome("next month"), await outcome(shown)];
  }, saved.clock.computerMonth);
  expect(months[0]).toMatch(/Invalid arguments for budget:confirm-month/);
  expect(months[1]).toMatch(/still the same budget month/);
  expect(await page.evaluate(() => window.nivra.listEngines())).toEqual([]);
  await app.close();

  ({ app, page } = await launch(testInfo, userData));
  expect((await page.evaluate(() => window.nivra.getBudgetPolicy()))?.version).toBe(1);
  const off = await page.evaluate(() => window.nivra.setBudgetPolicy(null));
  expect([off.policy, off.poolMicros]).toEqual([null, null]);
  expect(await page.evaluate(() => window.nivra.getBudgetPolicy())).toBeNull();
  await app.close();

  writeFileSync(join(userData, "workspace.db"), "this is not a database ".repeat(40));
  rmSync(join(userData, "workspace.db-wal"), { force: true });
  ({ app, page } = await launch(testInfo, userData));
  const summary = await page.evaluate(() => window.nivra.budgetSummary());
  expect(summary.recovery?.reason).toBe("workspace-kept-aside");
  const blocked = await page.evaluate(async (draft) => {
    try {
      await window.nivra.setBudgetPolicy(draft);
      return "accepted";
    } catch (error) {
      return String(error);
    }
  }, DRAFT);
  expect(blocked).toMatch(/budget history needs recovery first/);
  await app.close();
});
