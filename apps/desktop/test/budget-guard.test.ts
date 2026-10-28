import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CODING_WORKER_PROFILE, NO_SUBLIMITS, TOKEN_FACTORY_PRICES, type BudgetPolicyDraft, type GrantRequest, type PriceCatalogue } from "@nivra/domain";
import { BudgetGuard, checkHistory, type GuardRecord } from "../src/main/budget-guard.ts";
import { getGrant, ledgerState, markDispatching, recordJournal, releaseGrant, setPolicy, startNewHistory, writeGrant, type LedgerState } from "../src/main/budget-store.ts";
import { openWorkspace, type WorkspaceDb, type WorkspaceOpening } from "../src/main/workspace-db.ts";

/**
 * The budget's guard (NIV-66): losing, replacing or putting back the workspace never resets spending authority. A
 * backup restored at any point, even one holding the same number of grants, is caught by its revision; every crash
 * around a guard update leaves a safe state; and a needs-recovery state survives restarts until the person resolves it.
 */

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => {
  for (const db of open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const OCT = Date.parse("2026-10-28T01:00:00Z");
const AT = new Date(OCT).toISOString();
const HOME = "home-1";
const ESTABLISHED: PriceCatalogue = {
  ...TOKEN_FACTORY_PRICES,
  version: "test-established-1",
  currency: { code: "USD", source: "test" },
  models: TOKEN_FACTORY_PRICES.models.map((rate) => ({ ...rate, bounds: { inputTokens: 128_000, outputCappedByMaxTokens: true as const, source: "test", establishedOn: "2026-10-28" } })),
};
const DRAFT: BudgetPolicyDraft = {
  preset: "build",
  currency: "USD",
  monthlyMicros: 100_000_000,
  timezone: "UTC",
  thresholds: [80],
  sublimits: NO_SUBLIMITS,
  allowances: { sandboxOperations: 100, sandboxSeconds: 3_600, researchCredits: 20 },
  researchCreditMicros: null,
};

/** A profile folder: the workspace and its guard beside it, as the host keeps them. */
function profile(): { dbPath: string; guard: BudgetGuard; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "nivra guard ü "));
  dirs.push(dir);
  return { dbPath: join(dir, "workspace.db"), guard: new BudgetGuard(join(dir, "budget-guard.log")), dir };
}

function opening(path: string): Extract<WorkspaceOpening, { state: "ready" }> {
  const opened = openWorkspace(path);
  assert.equal(opened.state, "ready", opened.state === "unavailable" ? opened.reason : "");
  const ready = opened as Extract<WorkspaceOpening, { state: "ready" }>;
  open.push(ready.db);
  return ready;
}

/** A copy of the workspace as it is now, taken the way a backup tool would: the file after its journal is folded in. */
function backup(db: WorkspaceDb, to: string): void {
  db.checkpoint();
  copyFileSync(db.path, to);
}

/** Puts a copy back in place of the workspace, as a person restoring a backup would, and opens it again. */
function restore(db: WorkspaceDb, from: string): Extract<WorkspaceOpening, { state: "ready" }> {
  db.close();
  for (const suffix of ["-wal", "-shm"]) rmSync(`${db.path}${suffix}`, { force: true });
  copyFileSync(from, db.path);
  return opening(db.path);
}

const record = (state: LedgerState, recovery: GuardRecord["recovery"] = null): GuardRecord => ({ ledgerId: state.ledgerId, revision: state.revision, recovery, at: AT });

function request(): GrantRequest {
  return {
    requestId: randomUUID(),
    workflow: "task",
    targetId: "local",
    attribution: { feature: "task", projectId: null, taskId: null, attemptId: null, queueId: null, queueItemId: null, profile: CODING_WORKER_PROFILE },
    models: ["nvidia/nemotron-3-super-120b-a12b"],
    productive: { requests: 1, outputTokens: 8_000 },
    finalisation: { requests: 1, outputTokens: 1_500 },
    allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 },
    extends: null,
    need: null,
  };
}

/** Writes a grant as the host would before a send: no guard record yet, since nothing can be sent while it is only written. */
function written(db: WorkspaceDb): string {
  const result = writeGrant(db, request(), { now: OCT, catalogue: ESTABLISHED, timezone: "UTC" });
  assert.ok("grant" in result);
  return result.grant.id;
}

/** Marks a grant dispatching and records that revision in the guard, as the host does before it sends. */
function dispatched(db: WorkspaceDb, guard: BudgetGuard, id: string): void {
  const authority = markDispatching(db, id, HOME, OCT);
  assert.ok(authority);
  guard.append(record(authority));
}

function settled(db: WorkspaceDb, guard: BudgetGuard, id: string): void {
  const result = recordJournal(db, id, [], { grantId: id, kind: "complete", rows: 0, instanceId: randomUUID(), sealedAt: AT }, OCT);
  assert.ok("state" in result && result.authority);
  guard.append(record(result.authority));
}

const grants = (db: WorkspaceDb) => Number(db.db.prepare("SELECT count(*) AS n FROM budget_grants").get()?.["n"]);

describe("the guard log", () => {
  it("keeps each record on a line of its own, fsynced, private, and reads back the last whole one", () => {
    const { guard } = profile();
    assert.equal(guard.last(), null);
    const first = record({ ledgerId: randomUUID(), revision: 1 });
    guard.append(first);
    guard.append({ ...first, revision: 2 });
    assert.equal(guard.last()?.revision, 2);
    if (process.platform !== "win32") assert.equal(statSync(guard.path).mode & 0o777, 0o600);
  });

  it("ignores a last line a crash cut short, and stands the next record on a line of its own", () => {
    const { guard } = profile();
    const first = record({ ledgerId: randomUUID(), revision: 1 });
    guard.append(first);
    appendFileSync(guard.path, `{"v":1,"ledgerId":"${first.ledgerId}","revision":2`);
    assert.equal(guard.last()?.revision, 1);
    guard.append({ ...first, revision: 3 });
    assert.equal(guard.last()?.revision, 3);
  });

  it("skips a line whose checksum doesn't match", () => {
    const { guard } = profile();
    const first = record({ ledgerId: randomUUID(), revision: 1 });
    guard.append(first);
    guard.append({ ...first, revision: 2 });
    const lines = readFileSync(guard.path, "utf8").split("\n");
    writeFileSync(guard.path, `${lines[0]}\n${lines[1]!.replace('"revision":2', '"revision":9')}\n`);
    assert.equal(guard.last()?.revision, 1);
  });

  it("can't be appended where a folder stands in its way, and says so by throwing", () => {
    const { guard } = profile();
    mkdirSync(guard.path);
    assert.throws(() => guard.append(record({ ledgerId: randomUUID(), revision: 1 })));
  });
});

describe("comparing a ledger with its guard", () => {
  const ledger: LedgerState = { ledgerId: randomUUID(), revision: 5 };

  it("finds nothing to protect on a fresh install, and rebuilds a missing guard from the ledger", () => {
    assert.deepEqual(checkHistory(null, null, false, OCT), { state: "fresh", append: null });
    assert.deepEqual(checkHistory(null, ledger, false, OCT), { state: "ok", append: record(ledger) });
  });

  it("lets a guard behind its ledger catch up, with no alarm", () => {
    assert.deepEqual(checkHistory(record({ ...ledger, revision: 4 }), ledger, false, OCT), { state: "ok", append: record(ledger) });
    assert.deepEqual(checkHistory(record(ledger), ledger, false, OCT), { state: "ok", append: null });
  });

  it("needs recovery for a missing ledger, another ledger, or one behind, and records it", () => {
    const guard = record(ledger);
    for (const [found, kept, reason] of [
      [null, false, "ledger-missing"],
      [null, true, "workspace-kept-aside"],
      [{ ledgerId: randomUUID(), revision: 9 }, false, "ledger-replaced"],
      [{ ...ledger, revision: 4 }, false, "ledger-behind"],
    ] as const) {
      const check = checkHistory(guard, found, kept, OCT);
      assert.equal(check.state, "needs-recovery", reason);
      assert.ok(check.state === "needs-recovery" && check.recovery.reason === reason && check.append?.recovery?.reason === reason);
    }
  });

  it("keeps a recorded recovery until the ledger the guard last saw is back", () => {
    const check = checkHistory(record(ledger), { ...ledger, revision: 2 }, false, OCT);
    assert.ok(check.state === "needs-recovery" && check.append);
    const persisted = check.append;
    assert.equal(checkHistory(persisted, { ...ledger, revision: 2 }, false, OCT).state, "needs-recovery");
    assert.equal(checkHistory(persisted, null, false, OCT).state, "needs-recovery");
    assert.deepEqual(checkHistory(persisted, ledger, false, OCT), { state: "ok", append: record(ledger) });
  });
});

describe("a backup put back after paid work, holding the same number of grants", () => {
  it("is caught when it was taken after a grant was written and before it was dispatched", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    const id = written(db);
    backup(db, join(dir, "after-written.db"));
    dispatched(db, guard, id);
    settled(db, guard, id);
    assert.equal(grants(db), 1);
    db = restore(db, join(dir, "after-written.db")).db;
    // The restored ledger holds the same one grant, still written, as if never sent.
    assert.deepEqual([grants(db), getGrant(db, id)?.state], [1, "written"]);
    const check = checkHistory(guard.last(), ledgerState(db), false, OCT);
    assert.ok(check.state === "needs-recovery" && check.recovery.reason === "ledger-behind");
  });

  it("is caught when it was taken after the grant was dispatched and before it settled", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    const id = written(db);
    dispatched(db, guard, id);
    backup(db, join(dir, "after-dispatching.db"));
    settled(db, guard, id);
    db = restore(db, join(dir, "after-dispatching.db")).db;
    assert.deepEqual([grants(db), getGrant(db, id)?.state], [1, "dispatching"]);
    const check = checkHistory(guard.last(), ledgerState(db), false, OCT);
    assert.ok(check.state === "needs-recovery" && check.recovery.reason === "ledger-behind");
  });

  it("is caught when it was taken before a policy change", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    guard.append(record(setPolicy(db, DRAFT, OCT).authority));
    backup(db, join(dir, "before-policy.db"));
    guard.append(record(setPolicy(db, { ...DRAFT, monthlyMicros: 25_000_000 }, OCT).authority));
    db = restore(db, join(dir, "before-policy.db")).db;
    assert.equal(grants(db), 0);
    const check = checkHistory(guard.last(), ledgerState(db), false, OCT);
    assert.ok(check.state === "needs-recovery" && check.recovery.reason === "ledger-behind");
  });
});

describe("crashes around a guard update", () => {
  it("after the ledger commit and before the append: nothing was sent, and the guard catches up with no alarm", () => {
    const { dbPath, guard } = profile();
    const db = opening(dbPath).db;
    const id = written(db);
    guard.append(record(ledgerState(db)!));
    // The dispatch mark commits; the process dies before its guard record, and so before anything was sent.
    markDispatching(db, id, HOME, OCT);
    const check = checkHistory(guard.last(), ledgerState(db), false, OCT);
    assert.deepEqual(check, { state: "ok", append: record(ledgerState(db)!) });
  });

  it("after the append and before the send: the grant is dispatching, so it is never released or sent again", () => {
    const { dbPath, guard } = profile();
    const db = opening(dbPath).db;
    const id = written(db);
    dispatched(db, guard, id);
    assert.deepEqual(checkHistory(guard.last(), ledgerState(db), false, OCT), { state: "ok", append: null });
    assert.equal(releaseGrant(db, id, OCT), null);
    assert.equal(getGrant(db, id)?.state, "dispatching");
  });

  it("during the append: the torn record is ignored, nothing was sent on it, and the guard catches up", () => {
    const { dbPath, guard } = profile();
    const db = opening(dbPath).db;
    const id = written(db);
    guard.append(record(ledgerState(db)!));
    const authority = markDispatching(db, id, HOME, OCT)!;
    const line = JSON.stringify({ v: 1, ...record(authority) });
    appendFileSync(guard.path, line.slice(0, line.length - 7));
    assert.equal(guard.last()?.revision, authority.revision - 1);
    assert.deepEqual(checkHistory(guard.last(), ledgerState(db), false, OCT), { state: "ok", append: record(authority) });
  });
});

describe("a damaged workspace after spend", () => {
  function spent() {
    const paths = profile();
    const db = opening(paths.dbPath).db;
    guard(paths.guard, setPolicy(db, DRAFT, OCT).authority);
    const id = written(db);
    dispatched(db, paths.guard, id);
    settled(db, paths.guard, id);
    backup(db, join(paths.dir, "good.db"));
    db.close();
    writeFileSync(paths.dbPath, "this is not a SQLite database at all");
    for (const suffix of ["-wal", "-shm"]) rmSync(`${paths.dbPath}${suffix}`, { force: true });
    return paths;
  }
  const guard = (log: BudgetGuard, authority: LedgerState) => log.append(record(authority));

  it("opens fresh, needs recovery, records it, and still needs it after a restart", () => {
    const { dbPath, guard: log } = spent();
    const reopened = opening(dbPath);
    assert.notEqual(reopened.notice, null, "the damaged file was kept aside");
    const check = checkHistory(log.last(), ledgerState(reopened.db), reopened.notice !== null, OCT);
    assert.ok(check.state === "needs-recovery" && check.recovery.reason === "workspace-kept-aside" && check.append);
    log.append(check.append);
    // A restart reads the recovery back from the guard, whatever the fresh workspace holds.
    const restarted = new BudgetGuard(log.path);
    assert.equal(restarted.last()?.recovery?.reason, "workspace-kept-aside");
    assert.equal(checkHistory(restarted.last(), ledgerState(reopened.db), false, OCT).state, "needs-recovery");
  });

  it("is resolved by putting back the matching copy", () => {
    const { dbPath, guard: log, dir } = spent();
    const reopened = opening(dbPath);
    const check = checkHistory(log.last(), ledgerState(reopened.db), true, OCT);
    assert.ok(check.state === "needs-recovery" && check.append);
    log.append(check.append);
    const back = restore(reopened.db, join(dir, "good.db"));
    const resolved = checkHistory(log.last(), ledgerState(back.db), false, OCT);
    assert.equal(resolved.state, "ok");
    assert.equal(resolved.append?.recovery, null);
  });

  it("is resolved by starting a new history, which records the loss", () => {
    const { dbPath, guard: log } = spent();
    const reopened = opening(dbPath);
    const check = checkHistory(log.last(), ledgerState(reopened.db), true, OCT);
    assert.ok(check.state === "needs-recovery" && check.append);
    log.append(check.append);
    const authority = startNewHistory(reopened.db, { reason: check.recovery.reason, remainingMicros: null, now: OCT, timezone: "UTC" });
    log.append(record(authority));
    assert.deepEqual(checkHistory(log.last(), ledgerState(reopened.db), false, OCT), { state: "ok", append: null });
    assert.equal(Number(reopened.db.db.prepare("SELECT count(*) AS n FROM budget_adjustments WHERE kind = 'history-lost'").get()?.["n"]), 1);
  });
});
