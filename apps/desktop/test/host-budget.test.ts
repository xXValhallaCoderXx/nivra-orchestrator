import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { BUDGET_PRESETS, NO_SUBLIMITS, type BudgetPolicyDraft } from "@nivra/domain";
import { BUDGET_GUARD_FAILED, BUDGET_NEEDS_RECOVERY, BudgetGuard } from "../src/main/budget-guard.ts";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import type { TargetFactory } from "../src/main/targets/registry.ts";

/**
 * The shared budget through the host (NIV-66): the API the window and the development harness both use. A policy is
 * saved only once its revision is in the guard; a damaged history blocks every budget change until the person starts
 * a new one; and a guard that can't be written stops spending. No budget call starts an engine.
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

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "nivra host budget ü "));
  dirs.push(dir);
  return dir;
}

/** A host on the records under `at`; a second one on the same folder is a restart. */
function hostAt(at: string): Host {
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
  });
  host.init();
  hosts.push(host);
  return host;
}

describe("the budget through the host", () => {
  it("starts with no policy, saves one as version 1 with its revision in the guard, and keeps it across a restart", async () => {
    const at = root();
    const host = hostAt(at);
    assert.equal(await host.getBudgetPolicy(), null);
    const summary = await host.setBudgetPolicy(DRAFT);
    assert.deepEqual([summary.policy?.version, summary.poolMicros, summary.recovery], [1, 100_000_000, null]);
    // Today's price list establishes no currency or bounds, and the summary says so.
    for (const gap of ["currency-unconfirmed", "bounds-unestablished"] as const) assert.ok(summary.gaps.includes(gap), gap);
    assert.equal(new BudgetGuard(join(at, "budget-guard.log")).last()?.revision, 1);
    await host.shutdown();
    const restarted = hostAt(at);
    assert.equal((await restarted.getBudgetPolicy())?.monthlyMicros, 100_000_000);
    assert.equal((await restarted.budgetSummary()).recovery, null);
  });

  it("refuses a policy that isn't valid, and saves nothing", async () => {
    const host = hostAt(root());
    await assert.rejects(host.setBudgetPolicy({ ...DRAFT, monthlyMicros: 1.5 }));
    await assert.rejects(host.setBudgetPolicy({ ...DRAFT, timezone: "Mars/Olympus_Mons" }));
    assert.equal(await host.getBudgetPolicy(), null);
  });

  it("refuses to confirm a new month while the computer's clock is still in the current one", async () => {
    const host = hostAt(root());
    await host.setBudgetPolicy(DRAFT);
    await assert.rejects(host.confirmBudgetMonth(), /still the same budget month/);
  });

  it("refuses to start a new history when nothing needs recovery", async () => {
    const host = hostAt(root());
    await assert.rejects(host.startNewBudgetHistory(null), /doesn't need recovery/);
  });

  it("after a damaged history, blocks every budget change until the person starts a new one, which records the loss", async () => {
    const at = root();
    const first = hostAt(at);
    await first.setBudgetPolicy(DRAFT);
    await first.shutdown();
    for (const suffix of ["-wal", "-shm"]) rmSync(join(at, `workspace.db${suffix}`), { force: true });
    writeFileSync(join(at, "workspace.db"), "this is not a SQLite database at all");

    const second = hostAt(at);
    const blocked = await second.budgetSummary();
    assert.equal(blocked.recovery?.reason, "workspace-kept-aside");
    assert.equal(blocked.policy, null, "the policy went with the damaged file");
    await assert.rejects(second.setBudgetPolicy(DRAFT), (error: Error) => error.message === BUDGET_NEEDS_RECOVERY);
    await assert.rejects(second.confirmBudgetMonth(), (error: Error) => error.message === BUDGET_NEEDS_RECOVERY);
    await second.shutdown();

    // The state survives a restart: it is in the guard, not in the fresh workspace.
    const third = hostAt(at);
    assert.equal((await third.budgetSummary()).recovery?.reason, "workspace-kept-aside");
    const resumed = await third.startNewBudgetHistory(null);
    assert.deepEqual([resumed.recovery, resumed.gaps.includes("history-lost")], [null, true]);
    const saved = await third.setBudgetPolicy(DRAFT);
    assert.equal(saved.policy?.version, 1);
  });

  it("stops all spending when its guard can't be written", async () => {
    const at = root();
    mkdirSync(join(at, "budget-guard.log"));
    const host = hostAt(at);
    await assert.rejects(host.budgetSummary(), (error: Error) => error.message === BUDGET_GUARD_FAILED);
    await assert.rejects(host.setBudgetPolicy(DRAFT), (error: Error) => error.message === BUDGET_GUARD_FAILED);
  });
});
