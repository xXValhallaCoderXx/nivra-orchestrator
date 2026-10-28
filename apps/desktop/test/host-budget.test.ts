import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { BUDGET_PRESETS, CURRENT_PRICES, monthOf, NO_SUBLIMITS, type BudgetPolicyDraft, type PriceCatalogue } from "@nivra/domain";
import { BUDGET_GUARD_FAILED, BUDGET_GUARD_FAILED_AFTER_SAVE, BUDGET_NEEDS_RECOVERY, BudgetGuard } from "../src/main/budget-guard.ts";
import { dollarBudgetRefusal } from "../src/main/budget-store.ts";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import type { TargetFactory } from "../src/main/targets/registry.ts";

/**
 * The shared budget through the host (NIV-66): the API the window and the development harness both use. A budget in
 * dollars is set only with a price list that can keep it (a test list here; today's can't, and says why), and is never
 * turned off or into counts alone in its place; a policy's revision is in the guard before the call answers; a month is
 * confirmed only as it was shown; a damaged history blocks every budget change until the person starts a new one; and a
 * guard that can't be read or written stops spending, a change it couldn't record standing for the next start to catch
 * up with. No budget call starts an engine.
 */

const ENGINE = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url));
const dirs: string[] = [];
const hosts: Host[] = [];
after(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const DRAFT: BudgetPolicyDraft = {
  preset: "build",
  currency: "USD",
  monthlyMicros: BUDGET_PRESETS.build.monthlyMicros,
  timezone: "Asia/Singapore",
  thresholds: [50, 80, 100],
  sublimits: NO_SUBLIMITS,
  allowances: { sandboxOperations: 2_000, sandboxSeconds: 36_000, researchCredits: 200 },
  researchCreditMicros: null,
};

/** A test price list whose currency and every model's bounds are established, as Nebius's answers would make one. */
const ESTABLISHED: PriceCatalogue = {
  ...CURRENT_PRICES,
  version: "test-established-1",
  currency: { code: "USD", source: "test" },
  models: CURRENT_PRICES.models.map((rate) => ({ ...rate, bounds: { inputTokens: 128_000, outputCappedByMaxTokens: true as const, source: "test", establishedOn: "2026-10-28" } })),
};

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "nivra host budget ü "));
  dirs.push(dir);
  return dir;
}

/** A host on the records under `at`, pricing with `prices`; a second one on the same folder is a restart. */
function hostAt(at: string, prices: PriceCatalogue = ESTABLISHED): Host {
  const targets: TargetFactory = {
    local: new LocalTarget({ platform: "linux", runtime: { node: process.execPath, entry: ENGINE, runtimeHash: null }, home: join(at, "local home"), extraArgs: [] }),
    discoverWsl: async () => null,
  };
  const host = new Host({
    targets,
    store: new HostStore(join(at, "nivra.json")),
    workspacePath: join(at, "workspace.db"),
    logsDir: join(at, "logs"),
    client: { name: "host-budget-test", version: "0" },
    credentials: async () => ({}),
    platform: "linux",
    log: () => undefined,
    prices,
  });
  host.init();
  hosts.push(host);
  return host;
}

const guardAt = (at: string) => new BudgetGuard(join(at, "budget-guard.log"));

describe("the budget through the host", () => {
  it("starts with no policy, saves one as version 1 with its revision in the guard, and keeps it across a restart", async () => {
    const at = root();
    const host = hostAt(at);
    assert.equal(await host.getBudgetPolicy(), null);
    const summary = await host.setBudgetPolicy(DRAFT);
    assert.deepEqual([summary.policy?.version, summary.poolMicros, summary.recovery], [1, 100_000_000, null]);
    for (const gap of ["currency-unconfirmed", "bounds-unestablished"] as const) assert.ok(!summary.gaps.includes(gap), gap);
    assert.deepEqual([guardAt(at).last()?.revision, guardAt(at).last()?.month], [1, monthOf(Date.now(), DRAFT.timezone).label]);
    await host.shutdown();
    const restarted = hostAt(at);
    assert.equal((await restarted.getBudgetPolicy())?.monthlyMicros, 100_000_000);
    assert.equal((await restarted.budgetSummary()).recovery, null);
  });

  it("refuses a budget in dollars that today's price list can't keep, says why, saves nothing, and keeps counts alone as a choice of its own", async () => {
    const at = root();
    const host = hostAt(at, CURRENT_PRICES);
    await assert.rejects(host.setBudgetPolicy(DRAFT), (error: Error) => error.message === dollarBudgetRefusal(CURRENT_PRICES, null));
    assert.equal(await host.getBudgetPolicy(), null);
    assert.equal(guardAt(at).last(), null, "nothing was written, so nothing was recorded");
    const summary = await host.budgetSummary();
    for (const gap of ["currency-unconfirmed", "bounds-unestablished"] as const) assert.ok(summary.gaps.includes(gap), gap);
    const off = await host.setBudgetPolicy(null);
    assert.deepEqual([off.policy, off.poolMicros], [null, null]);
  });

  it("keeps a budget in dollars as it was when a change to it can't be kept: never turned off or into counts alone", async () => {
    const at = root();
    const first = hostAt(at);
    await first.setBudgetPolicy(DRAFT);
    await first.shutdown();
    const before = guardAt(at).last();
    const today = hostAt(at, CURRENT_PRICES);
    await assert.rejects(today.setBudgetPolicy({ ...DRAFT, monthlyMicros: 25_000_000 }), /Your budget wasn't changed: it stays at 100\.00 dollars a month\./);
    assert.deepEqual([(await today.getBudgetPolicy())?.version, (await today.getBudgetPolicy())?.monthlyMicros, guardAt(at).last()?.revision], [1, 100_000_000, before?.revision]);
    // Turning it off is the person's own choice, and stays open to them.
    const off = await today.setBudgetPolicy(null);
    assert.deepEqual([off.policy, guardAt(at).last()?.revision], [null, (before?.revision ?? 0) + 1]);
  });

  it("refuses a policy that isn't valid, and saves nothing", async () => {
    const host = hostAt(root());
    await assert.rejects(host.setBudgetPolicy({ ...DRAFT, monthlyMicros: 1.5 }));
    await assert.rejects(host.setBudgetPolicy({ ...DRAFT, timezone: "Mars/Olympus_Mons" }));
    assert.equal(await host.getBudgetPolicy(), null);
  });

  it("turns the monthly budget off as a new version, recorded in the guard", async () => {
    const at = root();
    const host = hostAt(at);
    await host.setBudgetPolicy(DRAFT);
    const off = await host.setBudgetPolicy(null);
    assert.deepEqual([off.policy, off.poolMicros, off.availableMicros], [null, null, null]);
    assert.equal(guardAt(at).last()?.revision, 2);
    assert.equal(await host.getBudgetPolicy(), null);
  });

  it("confirms only the month it showed, and none while the computer's clock is still in the current one", async () => {
    const host = hostAt(root());
    const summary = await host.setBudgetPolicy(DRAFT);
    assert.equal(summary.clock.computerMonth, monthOf(Date.now(), DRAFT.timezone).label);
    await assert.rejects(host.confirmBudgetMonth(summary.clock.computerMonth), /still the same budget month/);
    await assert.rejects(host.confirmBudgetMonth("2099-01"), /so that month wasn't confirmed/);
    await assert.rejects(host.confirmBudgetMonth("next month"));
  });

  it("refuses to start a new history when nothing needs recovery", async () => {
    const host = hostAt(root());
    await assert.rejects(host.startNewBudgetHistory(null), /doesn't need recovery/);
  });

  it("after a damaged history, blocks every budget change until the person starts a new one, which records the loss under a new ledger id", async () => {
    const at = root();
    const first = hostAt(at);
    await first.setBudgetPolicy(DRAFT);
    const before = guardAt(at).last()!;
    await first.shutdown();
    for (const suffix of ["-wal", "-shm"]) rmSync(join(at, `workspace.db${suffix}`), { force: true });
    writeFileSync(join(at, "workspace.db"), "this is not a SQLite database at all");

    const second = hostAt(at);
    const blocked = await second.budgetSummary();
    assert.equal(blocked.recovery?.reason, "workspace-kept-aside");
    assert.equal(blocked.policy, null, "the policy went with the damaged file");
    await assert.rejects(second.setBudgetPolicy(DRAFT), (error: Error) => error.message === BUDGET_NEEDS_RECOVERY);
    await assert.rejects(second.confirmBudgetMonth(blocked.clock.computerMonth), (error: Error) => error.message === BUDGET_NEEDS_RECOVERY);
    await second.shutdown();

    // The state survives a restart: it is in the guard, not in the fresh workspace.
    const third = hostAt(at);
    const flagged = await third.budgetSummary();
    assert.deepEqual([flagged.recovery?.reason, flagged.settledMicros, flagged.usage, flagged.gaps.includes("needs-recovery")], ["workspace-kept-aside", null, null, true]);
    await assert.rejects(third.startNewBudgetHistory({ micros: -1, allowances: DRAFT.allowances }));
    const resumed = await third.startNewBudgetHistory(null);
    assert.deepEqual([resumed.recovery, resumed.gaps.includes("history-lost"), resumed.availableMicros, resumed.afterLoss?.remaining], [null, true, 0, null]);
    const after = guardAt(at).last()!;
    assert.notEqual(after.ledgerId, before.ledgerId);
    assert.ok(after.revision > before.revision);
    const saved = await third.setBudgetPolicy(DRAFT);
    assert.equal(saved.policy?.version, 1);
    await third.shutdown();
    assert.equal((await hostAt(at).budgetSummary()).recovery, null);
  });

  it("stops all spending when its guard can't be read", async () => {
    const at = root();
    mkdirSync(join(at, "budget-guard.log"));
    const host = hostAt(at);
    await assert.rejects(host.budgetSummary(), (error: Error) => error.message === BUDGET_GUARD_FAILED);
    await assert.rejects(host.setBudgetPolicy(DRAFT), (error: Error) => error.message === BUDGET_GUARD_FAILED);
  });

  it("when its guard can't be written after a change commits: says the change was saved, spends nothing more this session, and catches up at the next start", async () => {
    const at = root();
    const host = hostAt(at);
    await host.setBudgetPolicy(DRAFT);
    const log = join(at, "budget-guard.log");
    const kept = readFileSync(log);
    rmSync(log);
    mkdirSync(log);
    await assert.rejects(host.setBudgetPolicy({ ...DRAFT, monthlyMicros: 25_000_000 }), (error: Error) => error.message === BUDGET_GUARD_FAILED_AFTER_SAVE);
    await assert.rejects(host.budgetSummary(), (error: Error) => error.message === BUDGET_GUARD_FAILED);
    await host.shutdown();
    rmSync(log, { recursive: true });
    writeFileSync(log, kept);
    const restarted = hostAt(at);
    const summary = await restarted.budgetSummary();
    assert.deepEqual([summary.recovery, summary.policy?.version, summary.poolMicros], [null, 2, 25_000_000]);
    assert.equal(guardAt(at).last()?.revision, 2);
  });
});
