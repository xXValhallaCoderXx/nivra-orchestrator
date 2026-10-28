import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CODING_WORKER_PROFILE, NO_SUBLIMITS, TOKEN_FACTORY_PRICES, type BudgetPolicyDraft, type GrantRequest, type PriceCatalogue } from "@nivra/domain";
import { BudgetGuard, checkHistory, type GuardRecord, type LedgerView } from "../src/main/budget-guard.ts";
import {
  answeredRecovery,
  chainAt,
  confirmMonth,
  currentPeriod,
  establishedMonth,
  getGrant,
  ledgerState,
  markDispatching,
  observeProviderTime,
  recordJournal,
  releaseGrant,
  setPolicy,
  startNewHistory,
  writeGrant,
  type LedgerState,
} from "../src/main/budget-store.ts";
import { openWorkspace, type WorkspaceDb, type WorkspaceOpening } from "../src/main/workspace-db.ts";

/**
 * The budget's guard (NIV-66): losing, replacing or putting back the workspace never resets spending authority. A
 * backup restored at any point, even one holding the same number of grants, is caught by its revision; one changed
 * since along another history is caught by its chained digest; every crash around a guard update leaves a safe state;
 * a needs-recovery state survives restarts until the person resolves it; and a new history can't be passed off later
 * by any copy of the one it replaced.
 */

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => {
  for (const db of open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const OCT = Date.parse("2026-10-28T01:00:00Z");
const NOV = Date.parse("2026-11-02T01:00:00Z");
const DEC = Date.parse("2026-12-03T01:00:00Z");
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

const digest = () => createHash("sha256").update(randomUUID()).digest("hex");

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

/** The month every record names unless a test says otherwise. */
const MONTH = "2026-10";
const record = (state: LedgerState, recovery: GuardRecord["recovery"] = null, month: string | null = MONTH, now = OCT): GuardRecord => ({
  ledgerId: state.ledgerId,
  revision: state.revision,
  chain: state.chain,
  month,
  recovery,
  at: new Date(now).toISOString(),
});
/** What the host appends once a change commits: its revision, with the latest month the ledger established, at the computer's time. */
const recorded = (db: WorkspaceDb, state: LedgerState, now = OCT): GuardRecord => record(state, null, establishedMonth(db), now);

/** The workspace's ledger as the host's check sees it against the guard's last record. */
function view(db: WorkspaceDb, guard: BudgetGuard): LedgerView | null {
  const ledger = ledgerState(db);
  const last = guard.last();
  return ledger === null ? null : { ...ledger, month: establishedMonth(db), chainAtGuard: last === null ? null : chainAt(db, last.ledgerId, last.revision), answered: answeredRecovery(db) };
}

/** What the host does at the first budget call of a session: check, and record what the check says to. */
function check(db: WorkspaceDb, guard: BudgetGuard, keptAside = false) {
  const found = checkHistory(guard.last(), view(db, guard), keptAside, OCT);
  if (found.append) guard.append(found.append);
  return found;
}

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

/** Writes a grant and records its revision, as the host does. A written grant isn't sent until it is marked dispatching. */
function written(db: WorkspaceDb, guard: BudgetGuard): string {
  const result = writeGrant(db, request(), { now: OCT, catalogue: ESTABLISHED, timezone: "UTC", verified: ledgerState(db) });
  assert.ok("grant" in result && result.authority);
  guard.append(recorded(db, result.authority));
  return result.grant.id;
}

/** Marks a grant dispatching and records that revision in the guard, as the host does before it sends. */
function dispatched(db: WorkspaceDb, guard: BudgetGuard, id: string): void {
  const authority = markDispatching(db, id, HOME, OCT, ledgerState(db));
  assert.ok(authority);
  guard.append(recorded(db, authority));
}

function settled(db: WorkspaceDb, guard: BudgetGuard, id: string): void {
  const result = recordJournal(db, id, [], { grantId: id, kind: "complete", rows: 0, instanceId: randomUUID(), sealedAt: AT }, OCT);
  assert.ok("state" in result && result.authority);
  guard.append(recorded(db, result.authority));
}

const grants = (db: WorkspaceDb) => Number(db.db.prepare("SELECT count(*) AS n FROM budget_grants").get()?.["n"]);

describe("the guard log", () => {
  it("keeps each record on a line of its own, fsynced, private, and reads back the last whole one", () => {
    const { guard } = profile();
    assert.equal(guard.last(), null);
    const first = record({ ledgerId: randomUUID(), revision: 1, chain: digest() });
    guard.append(first);
    guard.append({ ...first, revision: 2 });
    assert.equal(guard.last()?.revision, 2);
    if (process.platform !== "win32") assert.equal(statSync(guard.path).mode & 0o777, 0o600);
  });

  it("ignores a last line a crash cut short, and stands the next record on a line of its own", () => {
    const { guard } = profile();
    const first = record({ ledgerId: randomUUID(), revision: 1, chain: digest() });
    guard.append(first);
    appendFileSync(guard.path, `{"v":1,"ledgerId":"${first.ledgerId}","revision":2`);
    assert.equal(guard.last()?.revision, 1);
    guard.append({ ...first, revision: 3 });
    assert.equal(guard.last()?.revision, 3);
  });

  it("skips a line whose checksum doesn't match", () => {
    const { guard } = profile();
    const first = record({ ledgerId: randomUUID(), revision: 1, chain: digest() });
    guard.append(first);
    guard.append({ ...first, revision: 2 });
    const lines = readFileSync(guard.path, "utf8").split("\n");
    writeFileSync(guard.path, `${lines[0]}\n${lines[1]!.replace('"revision":2', '"revision":9')}\n`);
    assert.equal(guard.last()?.revision, 1);
  });

  it("can't be appended where a folder stands in its way, and says so by throwing", () => {
    const { guard } = profile();
    mkdirSync(guard.path);
    assert.throws(() => guard.append(record({ ledgerId: randomUUID(), revision: 1, chain: digest() })));
  });
});

describe("comparing a ledger with its guard", () => {
  const ledger: LedgerState = { ledgerId: randomUUID(), revision: 5, chain: digest() };
  const at5 = { ...ledger, month: MONTH, chainAtGuard: ledger.chain, answered: null };

  it("finds nothing to protect on a fresh install, and rebuilds a missing guard from the ledger", () => {
    assert.deepEqual(checkHistory(null, null, false, OCT), { state: "fresh", append: null });
    assert.deepEqual(checkHistory(null, { ...ledger, month: MONTH, chainAtGuard: null, answered: null }, false, OCT), { state: "ok", append: record(ledger) });
  });

  it("lets a guard behind its ledger catch up when the ledger holds the guard's history, with no alarm", () => {
    const earlier = { ledgerId: ledger.ledgerId, revision: 4, chain: digest() };
    assert.deepEqual(checkHistory(record(earlier), { ...ledger, month: MONTH, chainAtGuard: earlier.chain, answered: null }, false, OCT), { state: "ok", append: record(ledger) });
    assert.deepEqual(checkHistory(record(ledger), at5, false, OCT), { state: "ok", append: null });
  });

  it("needs recovery for a missing ledger, another, one behind, or one that reached the guard's revision along another history, and records it", () => {
    const guard = record(ledger);
    for (const [found, kept, reason] of [
      [null, false, "ledger-missing"],
      [null, true, "workspace-kept-aside"],
      [{ ledgerId: randomUUID(), revision: 9, chain: digest(), month: MONTH, chainAtGuard: null, answered: null }, false, "ledger-replaced"],
      [{ ...ledger, revision: 4, month: MONTH, chainAtGuard: null, answered: null }, false, "ledger-behind"],
      [{ ...ledger, revision: 7, chain: digest(), month: MONTH, chainAtGuard: digest(), answered: null }, false, "ledger-diverged"],
      [{ ...ledger, month: MONTH, chainAtGuard: digest(), answered: null }, false, "ledger-diverged"],
    ] as const) {
      const found_ = checkHistory(guard, found, kept, OCT);
      assert.equal(found_.state, "needs-recovery", reason);
      assert.ok(found_.state === "needs-recovery" && found_.recovery.reason === reason && found_.append?.recovery?.reason === reason, reason);
    }
  });

  it("keeps a recorded recovery until the ledger holds the guard's history again, whatever its revision reaches", () => {
    const found = checkHistory(record(ledger), { ...ledger, revision: 2, month: MONTH, chainAtGuard: null, answered: null }, false, OCT);
    assert.ok(found.state === "needs-recovery" && found.append);
    const persisted = found.append;
    assert.equal(checkHistory(persisted, { ...ledger, revision: 2, month: MONTH, chainAtGuard: null, answered: null }, false, OCT).state, "needs-recovery");
    assert.equal(checkHistory(persisted, null, false, OCT).state, "needs-recovery");
    // The rolled-back copy, changed until its revision passes the guard's, still doesn't hold the guard's history.
    assert.equal(checkHistory(persisted, { ...ledger, revision: 9, chain: digest(), month: MONTH, chainAtGuard: digest(), answered: null }, false, OCT).state, "needs-recovery");
    assert.deepEqual(checkHistory(persisted, at5, false, OCT), { state: "ok", append: record(ledger) });
  });

  it("clears a recorded recovery for the new history started for it, unchanged since, and for no other", () => {
    const found = checkHistory(record(ledger), { ...ledger, revision: 2, month: MONTH, chainAtGuard: null, answered: null }, false, OCT);
    assert.ok(found.state === "needs-recovery" && found.append);
    const persisted = found.append;
    const fresh: LedgerState = { ledgerId: randomUUID(), revision: 6, chain: digest() };
    const started = { ...fresh, month: MONTH, chainAtGuard: null, answered: { recovery: found.recovery, revision: 6 } };
    assert.deepEqual(checkHistory(persisted, started, false, OCT), { state: "ok", append: record(fresh) });
    // Started for another loss, or changed since it started: the recovery stands.
    const other = { ...found.recovery, detectedAt: new Date(OCT + 1).toISOString() };
    assert.equal(checkHistory(persisted, { ...started, answered: { recovery: other, revision: 6 } }, false, OCT).state, "needs-recovery");
    assert.equal(checkHistory(persisted, { ...started, revision: 7 }, false, OCT).state, "needs-recovery");
  });
});

describe("a backup put back after paid work, holding the same number of grants", () => {
  it("is caught when it was taken after a grant was written and before it was dispatched", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    const id = written(db, guard);
    backup(db, join(dir, "after-written.db"));
    dispatched(db, guard, id);
    settled(db, guard, id);
    assert.equal(grants(db), 1);
    db = restore(db, join(dir, "after-written.db")).db;
    // The restored ledger holds the same one grant, still written, as if never sent.
    assert.deepEqual([grants(db), getGrant(db, id)?.state], [1, "written"]);
    const found = check(db, guard);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-behind");
  });

  it("is caught when it was taken after the grant was dispatched and before it settled", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    const id = written(db, guard);
    dispatched(db, guard, id);
    backup(db, join(dir, "after-dispatching.db"));
    settled(db, guard, id);
    db = restore(db, join(dir, "after-dispatching.db")).db;
    assert.deepEqual([grants(db), getGrant(db, id)?.state], [1, "dispatching"]);
    const found = check(db, guard);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-behind");
  });

  it("is caught when it was taken before a policy change", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    guard.append(recorded(db, setPolicy(db, DRAFT, OCT, ESTABLISHED).authority!));
    backup(db, join(dir, "before-policy.db"));
    guard.append(recorded(db, setPolicy(db, { ...DRAFT, monthlyMicros: 25_000_000 }, OCT, ESTABLISHED).authority!));
    db = restore(db, join(dir, "before-policy.db")).db;
    assert.equal(grants(db), 0);
    const found = check(db, guard);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-behind");
  });

  it("is still caught once that copy was changed until its revision passed the guard's: it diverged", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    const id = written(db, guard);
    backup(db, join(dir, "after-written.db"));
    dispatched(db, guard, id);
    settled(db, guard, id);
    const reached = ledgerState(db)!.revision;
    db = restore(db, join(dir, "after-written.db")).db;
    // Changes made to the restored copy without the check, until it stands past the guard's revision.
    while (ledgerState(db)!.revision <= reached) setPolicy(db, { ...DRAFT, monthlyMicros: DRAFT.monthlyMicros + ledgerState(db)!.revision }, OCT, ESTABLISHED);
    const found = check(db, guard);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-diverged");
    assert.equal(getGrant(db, id)?.state, "written");
  });
});

describe("crashes around a guard update", () => {
  it("after the ledger commit and before the append: nothing was sent, and the guard catches up with no alarm", () => {
    const { dbPath, guard } = profile();
    const db = opening(dbPath).db;
    const id = written(db, guard);
    // The dispatch mark commits; the process dies before its guard record, and so before anything was sent.
    markDispatching(db, id, HOME, OCT, ledgerState(db));
    assert.deepEqual(checkHistory(guard.last(), view(db, guard), false, OCT), { state: "ok", append: recorded(db, ledgerState(db)!) });
  });

  it("after the append and before the send: the grant is dispatching, so it is never released or sent again", () => {
    const { dbPath, guard } = profile();
    const db = opening(dbPath).db;
    const id = written(db, guard);
    dispatched(db, guard, id);
    assert.deepEqual(checkHistory(guard.last(), view(db, guard), false, OCT), { state: "ok", append: null });
    assert.equal(releaseGrant(db, id, OCT, ledgerState(db)), null);
    assert.equal(getGrant(db, id)?.state, "dispatching");
  });

  it("during the append: the torn record is ignored, nothing was sent on it, and the guard catches up", () => {
    const { dbPath, guard } = profile();
    const db = opening(dbPath).db;
    const id = written(db, guard);
    const authority = markDispatching(db, id, HOME, OCT, ledgerState(db))!;
    const line = JSON.stringify({ v: 1, ...recorded(db, authority) });
    appendFileSync(guard.path, line.slice(0, line.length - 7));
    assert.equal(guard.last()?.revision, authority.revision - 1);
    assert.deepEqual(checkHistory(guard.last(), view(db, guard), false, OCT), { state: "ok", append: recorded(db, authority) });
  });
});

describe("a damaged workspace after spend", () => {
  function spent() {
    const paths = profile();
    const db = opening(paths.dbPath).db;
    paths.guard.append(recorded(db, setPolicy(db, DRAFT, OCT, ESTABLISHED).authority!));
    const id = written(db, paths.guard);
    dispatched(db, paths.guard, id);
    settled(db, paths.guard, id);
    backup(db, join(paths.dir, "good.db"));
    db.close();
    writeFileSync(paths.dbPath, "this is not a SQLite database at all");
    for (const suffix of ["-wal", "-shm"]) rmSync(`${paths.dbPath}${suffix}`, { force: true });
    return paths;
  }

  it("opens fresh, needs recovery, records it, and still needs it after a restart", () => {
    const { dbPath, guard } = spent();
    const reopened = opening(dbPath);
    assert.notEqual(reopened.notice, null, "the damaged file was kept aside");
    const found = check(reopened.db, guard, reopened.notice !== null);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "workspace-kept-aside");
    // A restart reads the recovery back from the guard, whatever the fresh workspace holds.
    const restarted = new BudgetGuard(guard.path);
    assert.equal(restarted.last()?.recovery?.reason, "workspace-kept-aside");
    assert.equal(checkHistory(restarted.last(), view(reopened.db, restarted), false, OCT).state, "needs-recovery");
  });

  it("is resolved by putting back the matching copy", () => {
    const { dbPath, guard, dir } = spent();
    const reopened = opening(dbPath);
    assert.equal(check(reopened.db, guard, true).state, "needs-recovery");
    const back = restore(reopened.db, join(dir, "good.db"));
    const resolved = check(back.db, guard);
    assert.equal(resolved.state, "ok");
    assert.equal(resolved.append?.recovery, null);
    assert.equal(check(back.db, guard).state, "ok");
  });

  it("is resolved by starting a new history, which records the loss under a new ledger id", () => {
    const { dbPath, guard } = spent();
    const reopened = opening(dbPath);
    const found = check(reopened.db, guard, true);
    assert.ok(found.state === "needs-recovery");
    const authority = startNewHistory(reopened.db, { recovery: found.recovery, remaining: null, now: OCT, timezone: "UTC" });
    assert.ok(authority.revision > found.recovery.guard.revision);
    assert.notEqual(authority.ledgerId, found.recovery.guard.ledgerId);
    guard.append(recorded(reopened.db, authority));
    assert.deepEqual(checkHistory(guard.last(), view(reopened.db, guard), false, OCT), { state: "ok", append: null });
    assert.equal(Number(reopened.db.db.prepare("SELECT count(*) AS n FROM budget_adjustments WHERE kind = 'history-lost'").get()?.["n"]), 1);
  });
});

describe("a new history after a ledger behind its guard", () => {
  it("makes every grant still open uncertain, so one the lost history had sent is never released, and no copy of that history passes later", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    const kept = written(db, guard);
    const sentLater = written(db, guard);
    backup(db, join(dir, "early.db"));
    dispatched(db, guard, sentLater);
    backup(db, join(dir, "later.db"));
    settled(db, guard, sentLater);
    db = restore(db, join(dir, "early.db")).db;
    const found = check(db, guard);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-behind");
    // Before: both grants read written in the restored copy, though one of them was sent.
    assert.deepEqual([getGrant(db, kept)?.state, getGrant(db, sentLater)?.state], ["written", "written"]);
    const authority = startNewHistory(db, { recovery: found.recovery, remaining: { micros: 10_000_000, allowances: DRAFT.allowances }, now: OCT, timezone: "UTC" });
    guard.append(recorded(db, authority));
    assert.deepEqual([getGrant(db, kept)?.state, getGrant(db, sentLater)?.state], ["uncertain", "uncertain"]);
    assert.equal(releaseGrant(db, sentLater, OCT, ledgerState(db)), null);
    assert.equal(markDispatching(db, kept, HOME, OCT, ledgerState(db)), null);
    assert.equal(check(db, guard).state, "ok");
    // A copy of the lost history, taken past the new history's starting revision, is another ledger now.
    db = restore(db, join(dir, "later.db")).db;
    const later = check(db, guard);
    assert.ok(later.state === "needs-recovery" && later.recovery.reason === "ledger-replaced");
  });

  it("clears a recovery whose new history couldn't be recorded in the guard at the next start, with no second loss", () => {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    const id = written(db, guard);
    backup(db, join(dir, "early.db"));
    dispatched(db, guard, id);
    db = restore(db, join(dir, "early.db")).db;
    const found = check(db, guard);
    assert.ok(found.state === "needs-recovery");
    // The new history commits, but its guard record is never written.
    const authority = startNewHistory(db, { recovery: found.recovery, remaining: null, now: OCT, timezone: "UTC" });
    assert.deepEqual(check(db, guard), { state: "ok", append: recorded(db, authority) });
    assert.equal(Number(db.db.prepare("SELECT count(*) AS n FROM budget_adjustments").get()?.["n"]), 1);
    assert.equal(check(db, guard).state, "ok");
  });
});

/** Asks for a grant as the host would, at the computer's time `now`, without recording it. */
const ask = (db: WorkspaceDb, over: Partial<GrantRequest> = {}, now = NOV) =>
  writeGrant(db, { ...request(), ...over }, { now, catalogue: ESTABLISHED, timezone: "UTC", verified: ledgerState(db) });
const operations = (count: number): Partial<GrantRequest> => ({
  models: [],
  productive: { requests: 0, outputTokens: 0 },
  finalisation: { requests: 0, outputTokens: 0 },
  allowances: { sandboxOperations: count, sandboxSeconds: 0, researchCredits: 0 },
});
const code = (result: ReturnType<typeof ask>) => ("refused" in result ? result.refused.code : "granted");

describe("a backup from an older month put back after the real month began", () => {
  /** October's history is backed up; November opens on the provider's clock and is spent in; then October's copy is put back. */
  function restoredFromOctober() {
    const { dbPath, guard, dir } = profile();
    let db = opening(dbPath).db;
    guard.append(recorded(db, setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT, ESTABLISHED).authority!));
    const id = written(db, guard);
    backup(db, join(dir, "october.db"));
    guard.append(recorded(db, observeProviderTime(db, NOV, NOV, "UTC").authority!));
    dispatched(db, guard, id);
    db = restore(db, join(dir, "october.db")).db;
    const found = check(db, guard);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-behind");
    assert.equal(currentPeriod(db)?.label, "2026-10");
    return { db, guard, recovery: found.recovery };
  }

  it("keeps a wait through November once November is confirmed, for money and Nebius operations alike", () => {
    const { db, guard, recovery } = restoredFromOctober();
    guard.append(recorded(db, startNewHistory(db, { recovery, remaining: null, now: NOV, timezone: "UTC" })));
    assert.equal(check(db, guard).state, "ok");
    assert.deepEqual([code(ask(db)), code(ask(db, operations(1)))], ["history-wait", "history-wait"]);
    assert.ok("opened" in confirmMonth(db, "2026-11", NOV, "UTC"));
    assert.deepEqual([code(ask(db)), code(ask(db, operations(1)))], ["history-wait", "history-wait"]);
    assert.ok("opened" in confirmMonth(db, "2026-12", DEC, "UTC"));
    assert.equal(code(ask(db, {}, DEC)), "granted");
  });

  it("keeps a finite allowance, money and Nebius operations, through November once November is confirmed", () => {
    const { db, guard, recovery } = restoredFromOctober();
    const left = { micros: 100_000, allowances: { sandboxOperations: 2, sandboxSeconds: 0, researchCredits: 0 } };
    guard.append(recorded(db, startNewHistory(db, { recovery, remaining: left, now: NOV, timezone: "UTC" })));
    assert.deepEqual([code(ask(db)), code(ask(db, operations(2)))], ["granted", "granted"]);
    assert.ok("opened" in confirmMonth(db, "2026-11", NOV, "UTC"));
    // What was admitted before November was confirmed still counts against what the person said was left.
    assert.deepEqual([code(ask(db)), code(ask(db, operations(1)))], ["pool", "counted"]);
    assert.ok("opened" in confirmMonth(db, "2026-12", DEC, "UTC"));
    assert.deepEqual([code(ask(db, {}, DEC)), code(ask(db, operations(1), DEC))], ["granted", "granted"]);
  });
});

describe("the latest month a lost history established, kept by the guard whatever the computer's clock says", () => {
  /** After the computer's clock moved back from November. */
  const OCT_BACK = Date.parse("2026-10-30T09:00:00Z");
  /** The computer's clock, a few minutes behind the provider's at the month's end. */
  const OCT_BEHIND = Date.parse("2026-10-31T23:50:00Z");
  const NOV_FIRST = Date.parse("2026-11-01T00:05:00Z");
  const NOV_AGAIN = Date.parse("2026-11-05T01:00:00Z");
  // One grant of request(): 128,000 input and 8,000 output, then the hand-in's 128,000 and 1,500: 45,600 + 39,750.
  const ONE_GRANT = 85_350;
  /** What the person can say is left after a loss: wait for the month after, nothing, or one grant and two Nebius operations. */
  const CHOICES = [
    { choice: "wait", remaining: null },
    { choice: "zero", remaining: { micros: 0, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } } },
    { choice: "finite", remaining: { micros: ONE_GRANT, allowances: { sandboxOperations: 2, sandboxSeconds: 0, researchCredits: 0 } } },
  ] as const;

  /** A grant written at the computer's time `now` and marked dispatching, each change recorded in the guard as the host does. */
  function spentAt(db: WorkspaceDb, guard: BudgetGuard, now: number): void {
    const result = ask(db, {}, now);
    assert.ok("grant" in result && result.authority);
    guard.append(recorded(db, result.authority, now));
    const authority = markDispatching(db, result.grant.id, HOME, now, ledgerState(db));
    assert.ok(authority);
    guard.append(recorded(db, authority, now));
  }

  /** Puts October's copy back, and the check finds the ledger behind its guard. */
  function putBack(db: WorkspaceDb, guard: BudgetGuard, copy: string, now: number) {
    const restored = restore(db, copy).db;
    const found = checkHistory(guard.last(), view(restored, guard), false, now);
    if (found.append) guard.append(found.append);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-behind");
    assert.equal(currentPeriod(restored)?.label, "2026-10");
    return { db: restored, recovery: found.recovery };
  }

  /**
   * Nate's first case: November opens on the provider's clock and is spent in; the computer's clock moves back to
   * October, and a policy saved then writes October's time into the guard's last record; October's copy is put back.
   */
  function clockMovedBack() {
    const { dbPath, guard, dir } = profile();
    const db = opening(dbPath).db;
    guard.append(recorded(db, setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT, ESTABLISHED).authority!, OCT));
    spentAt(db, guard, OCT);
    backup(db, join(dir, "october.db"));
    guard.append(recorded(db, observeProviderTime(db, NOV, NOV, "UTC").authority!, NOV));
    spentAt(db, guard, NOV);
    guard.append(recorded(db, setPolicy(db, { ...DRAFT, monthlyMicros: 20_000_000 }, OCT_BACK, ESTABLISHED).authority!, OCT_BACK));
    assert.equal(guard.last()?.at.slice(0, 7), "2026-10", "the guard's last record was written at October's time");
    return { guard, dir, ...putBack(db, guard, join(dir, "october.db"), OCT_BACK), now: OCT_BACK };
  }

  /**
   * Nate's second case: the provider's clock opens November while this computer's still says October, November is
   * spent in with every guard record written at October's time, and October's copy is put back.
   */
  function providerAhead() {
    const { dbPath, guard, dir } = profile();
    const db = opening(dbPath).db;
    guard.append(recorded(db, setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT, ESTABLISHED).authority!, OCT));
    spentAt(db, guard, OCT);
    backup(db, join(dir, "october.db"));
    guard.append(recorded(db, observeProviderTime(db, NOV_FIRST, OCT_BEHIND, "UTC").authority!, OCT_BEHIND));
    spentAt(db, guard, OCT_BEHIND);
    assert.deepEqual([currentPeriod(db)?.label, guard.last()?.at.slice(0, 7)], ["2026-11", "2026-10"], "November opened, every record written at October's time");
    return { guard, dir, ...putBack(db, guard, join(dir, "october.db"), OCT_BEHIND), now: OCT_BEHIND };
  }

  /**
   * Starts a new history with what the person chose, then has the provider's clock show November again with this
   * computer's still in October, and checks that what the person chose still holds there; December frees it.
   */
  function holdsThroughNovember(lost: ReturnType<typeof clockMovedBack>, choice: (typeof CHOICES)[number]) {
    const { db, guard, recovery, now } = lost;
    guard.append(recorded(db, startNewHistory(db, { recovery, remaining: choice.remaining, now, timezone: "UTC" }), now));
    assert.equal(check(db, guard).state, "ok");
    assert.equal(observeProviderTime(db, NOV_AGAIN, now, "UTC").opened?.label, "2026-11", choice.choice);
    if (choice.choice === "wait") {
      assert.deepEqual([code(ask(db, {}, now)), code(ask(db, operations(1), now))], ["history-wait", "history-wait"], choice.choice);
    } else if (choice.choice === "zero") {
      assert.deepEqual([code(ask(db, {}, now)), code(ask(db, operations(1), now))], ["pool", "counted"], choice.choice);
    } else {
      assert.deepEqual([code(ask(db, {}, now)), code(ask(db, {}, now)), code(ask(db, operations(2), now)), code(ask(db, operations(1), now))], ["granted", "pool", "granted", "counted"], choice.choice);
    }
    assert.equal(observeProviderTime(db, DEC, now, "UTC").opened?.label, "2026-12", choice.choice);
    assert.deepEqual([code(ask(db, {}, now)), code(ask(db, operations(1), now))], ["granted", "granted"], choice.choice);
    // How: the guard kept November, whatever its records' times said, and the loss holds through it.
    assert.equal(recovery.guard.month, "2026-11", choice.choice);
  }

  it("holds a wait, zero left, or a finite allowance with Nebius operations through November after the computer's clock moved back", () => {
    for (const choice of CHOICES) holdsThroughNovember(clockMovedBack(), choice);
  });

  it("holds a wait, zero left, or a finite allowance with Nebius operations through November when the provider's clock ran ahead of the computer's", () => {
    for (const choice of CHOICES) holdsThroughNovember(providerAhead(), choice);
  });

  it("carries November through the recovery: the new history's records keep it, and a second loss holds through it too", () => {
    const lost = clockMovedBack();
    const { db, guard, recovery, dir, now } = lost;
    guard.append(recorded(db, startNewHistory(db, { recovery, remaining: null, now, timezone: "UTC" }), now));
    guard.append(recorded(db, setPolicy(db, { ...DRAFT, monthlyMicros: 30_000_000 }, now, ESTABLISHED).authority!, now));
    const carried = guard.last();
    // October's first copy is put back again: it holds neither November nor the first loss. Only the guard remembers.
    const restored = restore(db, join(dir, "october.db")).db;
    const found = check(restored, guard);
    assert.ok(found.state === "needs-recovery" && found.recovery.reason === "ledger-replaced");
    holdsThroughNovember({ ...lost, db: restored, recovery: found.recovery }, CHOICES[0]);
    assert.equal(carried?.month, "2026-11", "the new history's records named November while its ledger was in October");
  });

  it("never records an earlier month than the guard's last, and a recovery it records keeps the guard's month apart from its time", () => {
    const ledger: LedgerState = { ledgerId: randomUUID(), revision: 5, chain: digest() };
    const earlier = { ledgerId: ledger.ledgerId, revision: 4, chain: digest() };
    const caughtUp = checkHistory(record(earlier, null, "2026-11"), { ...ledger, month: "2026-10", chainAtGuard: earlier.chain, answered: null }, false, OCT);
    assert.equal(caughtUp.append?.month, "2026-11");
    assert.equal(checkHistory(null, { ...ledger, month: "2026-12", chainAtGuard: null, answered: null }, false, OCT).append?.month, "2026-12");
    const lostOne = checkHistory(record(ledger, null, "2026-11", OCT_BACK), null, false, NOV);
    assert.ok(lostOne.state === "needs-recovery");
    assert.deepEqual([lostOne.recovery.guard.month, lostOne.recovery.guard.at, lostOne.append?.month], ["2026-11", new Date(OCT_BACK).toISOString(), "2026-11"]);
  });
});
