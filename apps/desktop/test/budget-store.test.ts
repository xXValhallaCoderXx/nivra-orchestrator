import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  CODING_WORKER_PROFILE,
  NO_SUBLIMITS,
  TOKEN_FACTORY_PRICES,
  type BudgetOperation,
  type BudgetPolicyDraft,
  type BudgetRecovery,
  type GrantRequest,
  type JournalSeal,
  type PriceCatalogue,
} from "@nivra/domain";
import {
  BUDGET_UNVERIFIED,
  budgetSummary,
  confirmMonth,
  currentPeriod,
  currentPolicy,
  ensureDurable,
  getGrant,
  ledgerState,
  markAccepted,
  markDispatching,
  markUncertain,
  observeProviderTime,
  recordClockJump,
  recordJournal,
  registerCatalogue,
  releaseGrant,
  setPolicy,
  startNewHistory,
  writeGrant,
  writeOff,
} from "../src/main/budget-store.ts";
import { openWorkspace, type WorkspaceDb, type WorkspaceOpening } from "../src/main/workspace-db.ts";

/**
 * The shared monthly budget's ledger (NIV-66), on a real workspace: grants written and counted in one transaction, so
 * two callers can't both take the last of the pool; unused allowance released only on affirmative evidence; each
 * journal row counted as the ledger works it out, never on the engine's word alone; unknown spend counted at its bound
 * and never as zero; a lost history binding in every mode; months that only move forward; and a history nothing can
 * quietly rewrite.
 */

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => {
  for (const db of open) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(): WorkspaceDb {
  const dir = mkdtempSync(join(tmpdir(), "nivra budget ü "));
  dirs.push(dir);
  const opening = openWorkspace(join(dir, "workspace.db"));
  assert.equal(opening.state, "ready", opening.state === "unavailable" ? opening.reason : "");
  const ready = opening as Extract<WorkspaceOpening, { state: "ready" }>;
  open.push(ready.db);
  return ready.db;
}

const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const LIGHTNING = "nvidia/Nemotron-3_5-Lightning";
const PROJECT = randomUUID();
const OCT = Date.parse("2026-10-28T01:00:00Z");
const NOV = Date.parse("2026-11-02T01:00:00Z");
const DEC = Date.parse("2026-12-03T01:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const HOME = "home-1";

/** A price list whose currency and bounds are established, as checkpoint 1 would make one. */
const ESTABLISHED: PriceCatalogue = {
  ...TOKEN_FACTORY_PRICES,
  version: "test-established-1",
  currency: { code: "USD", source: "a written answer from the provider (test)" },
  models: TOKEN_FACTORY_PRICES.models.map((rate) => ({ ...rate, bounds: { inputTokens: 128_000, outputCappedByMaxTokens: true as const, source: "test", establishedOn: "2026-10-28" } })),
};
// One request with Super's bounds: all 128,000 input at 0.30 a million, and 8,000 output at 0.90 a million.
const WORK_REQUEST = 38_400 + 7_200;
// The hand-in: 128,000 input and 1,500 output.
const HAND_IN = 38_400 + 1_350;
const GRANT_TOTAL = 2 * WORK_REQUEST + HAND_IN;

const DRAFT: BudgetPolicyDraft = {
  preset: "custom",
  currency: "USD",
  monthlyMicros: 200_000,
  timezone: "UTC",
  thresholds: [50, 80, 100],
  sublimits: NO_SUBLIMITS,
  allowances: { sandboxOperations: 100, sandboxSeconds: 3_600, researchCredits: 20 },
  researchCreditMicros: null,
};

function request(over: Partial<GrantRequest> = {}): GrantRequest {
  return {
    requestId: randomUUID(),
    workflow: "task",
    targetId: "local",
    attribution: { feature: "task", projectId: PROJECT, taskId: null, attemptId: null, queueId: null, queueItemId: null, profile: CODING_WORKER_PROFILE },
    models: [SUPER],
    productive: { requests: 2, outputTokens: 8_000 },
    finalisation: { requests: 1, outputTokens: 1_500 },
    allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 },
    extends: null,
    need: null,
    ...over,
  };
}

/** What the host passes: the ledger state its guard last verified, here the ledger as it stands. */
const context = (db: WorkspaceDb, now = OCT, catalogue: PriceCatalogue = ESTABLISHED) => ({ now, catalogue, timezone: "UTC", verified: ledgerState(db) });
/** What is left after a loss: `micros`, and plenty of each counted service. */
const left = (micros: number, allowances = { sandboxOperations: 1_000, sandboxSeconds: 100_000, researchCredits: 1_000 }) => ({ micros, allowances });

function granted(db: WorkspaceDb, over: Partial<GrantRequest> = {}, now = OCT, catalogue: PriceCatalogue = ESTABLISHED) {
  const result = writeGrant(db, request(over), context(db, now, catalogue));
  assert.ok("grant" in result, "refused" in result ? result.refused.message : "");
  return result.grant;
}

function refusal(db: WorkspaceDb, over: Partial<GrantRequest> = {}, now = OCT, catalogue: PriceCatalogue = ESTABLISHED) {
  const result = writeGrant(db, request(over), context(db, now, catalogue));
  assert.ok("refused" in result, "the grant was written");
  return result.refused;
}

// A reported request: 10,000 input (none of it cached) at 0.30 a million, and 1,000 output at 0.90 a million.
const row = (grantId: string, seq: number, over: Partial<BudgetOperation> = {}): BudgetOperation => ({
  id: randomUUID(),
  grantId,
  seq,
  kind: "model-request",
  model: SUPER,
  seat: "worker",
  instructionsSha256: null,
  state: "reported",
  boundMicros: WORK_REQUEST,
  usage: { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 1_000 },
  units: null,
  amountMicros: 3_900,
  ...over,
});

const seal = (grantId: string, kind: JournalSeal["kind"], rows: number): JournalSeal => ({ grantId, kind, rows, instanceId: randomUUID(), sealedAt: new Date(OCT).toISOString() });

const summary = (db: WorkspaceDb, now = OCT, catalogue: PriceCatalogue = ESTABLISHED) => budgetSummary(db, { now, catalogue, recovery: null, timezone: "UTC" });
const money = (db: WorkspaceDb, now = OCT) => {
  const totals = summary(db, now);
  return [totals.settledMicros, totals.unknownMicros, totals.reservedMicros];
};

/** A loss as the guard would have found it, for starting a new history. */
const lost = (db: WorkspaceDb): BudgetRecovery => ({
  reason: "ledger-behind",
  detectedAt: new Date(OCT).toISOString(),
  guard: { ledgerId: ledgerState(db)?.ledgerId ?? randomUUID(), revision: (ledgerState(db)?.revision ?? 0) + 5, chain: "0".repeat(64) },
  ledger: ledgerState(db) && { ledgerId: ledgerState(db)!.ledgerId, revision: ledgerState(db)!.revision },
});

function sent(db: WorkspaceDb, id: string, rows: BudgetOperation[], kind: JournalSeal["kind"] = "complete") {
  if (getGrant(db, id)?.state === "written") markDispatching(db, id, HOME, OCT, ledgerState(db));
  return recordJournal(db, id, rows, seal(id, kind, rows.length), OCT);
}

describe("writing grants", () => {
  it("writes the ledger's id and first month with its first grant, and moves the revision forward with each change", () => {
    const db = workspace();
    assert.equal(ledgerState(db), null);
    const grant = granted(db);
    assert.equal(ledgerState(db)?.revision, 1);
    assert.equal(currentPeriod(db)?.label, "2026-10");
    assert.equal(currentPeriod(db)?.openedBy, "first");
    assert.equal(grant.productiveMicros, 2 * WORK_REQUEST);
    assert.equal(grant.finalisationMicros, HAND_IN);
    assert.equal(getGrant(db, grant.id)?.state, "written");
    const chain = ledgerState(db)?.chain;
    assert.ok(markDispatching(db, grant.id, HOME, OCT, ledgerState(db)));
    assert.equal(ledgerState(db)?.revision, 2);
    assert.notEqual(ledgerState(db)?.chain, chain);
  });

  it("admits only one of two callers asking for the last of the pool, and writes nothing for the other", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    granted(db);
    const before = ledgerState(db);
    const second = refusal(db, { attribution: { ...request().attribution, feature: "review" } });
    assert.equal(second.code, "pool");
    assert.match(second.message, /monthly budget of 0\.20 dollars: 0\.14 is already spent or reserved/);
    assert.deepEqual(ledgerState(db), before, "a refusal changes nothing");
    assert.equal(summary(db).reservedMicros, GRANT_TOTAL);
  });

  it("refuses a model with no price, names it, and writes nothing", () => {
    const db = workspace();
    const refused = refusal(db, { models: ["nvidia/some-other-model"] });
    assert.equal(refused.code, "no-price");
    assert.match(refused.message, /nvidia\/some-other-model/);
    assert.equal(ledgerState(db), null);
  });

  it("refuses every model under a money policy until its bounds and the list's currency are established, and says how to go on", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    const refused = refusal(db, {}, OCT, TOKEN_FACTORY_PRICES);
    assert.equal(refused.code, "unestablished");
    assert.match(refused.message, /Turn the monthly budget off/);
  });

  it("admits a call that reaches no model under a money policy before anything is established, at no money", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    const grant = granted(db, { models: [], productive: { requests: 0, outputTokens: 0 }, finalisation: { requests: 0, outputTokens: 0 }, allowances: { sandboxOperations: 2, sandboxSeconds: 60, researchCredits: 0 } }, OCT, TOKEN_FACTORY_PRICES);
    assert.deepEqual([grant.productiveMicros, grant.finalisationMicros], [0, 0]);
    assert.deepEqual(summary(db, OCT).counted.used, { sandboxOperations: 2, sandboxSeconds: 60, researchCredits: 0 });
  });

  it("without a policy, writes and counts an unpriced grant, and shows its money as unknown, never 0", () => {
    const db = workspace();
    const grant = granted(db, {}, OCT, TOKEN_FACTORY_PRICES);
    assert.equal(grant.productiveMicros, null);
    const totals = summary(db, OCT, TOKEN_FACTORY_PRICES);
    assert.deepEqual([totals.settledMicros, totals.unknownMicros, totals.reservedMicros, totals.availableMicros, totals.poolMicros], [null, null, null, null, null]);
    for (const gap of ["currency-unconfirmed", "bounds-unestablished", "unpriced-usage", "listings-unpriced"] as const) assert.ok(totals.gaps.includes(gap), gap);
    assert.deepEqual(totals.breakdown.find((line) => line.dimension === "feature")?.settledMicros, null);
  });

  it("rolls back everything it wrote when its own transaction fails partway", () => {
    const db = workspace();
    db.db.exec("CREATE TEMP TRIGGER fail_grant BEFORE INSERT ON budget_grants BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    assert.throws(() => writeGrant(db, request(), context(db)), /injected/);
    db.db.exec("DROP TRIGGER fail_grant");
    assert.equal(ledgerState(db), null, "the revision it bumped was rolled back");
    assert.equal(currentPeriod(db), null, "the month it opened was rolled back");
    assert.equal(Number(db.db.prepare("SELECT count(*) AS n FROM budget_revisions").get()?.["n"]), 0);
  });

  it("refuses an extension that doesn't name its need", () => {
    const db = workspace();
    assert.throws(() => writeGrant(db, request({ extends: randomUUID(), need: null }), context(db)), /names the grant it extends and the one need/);
    assert.equal(ledgerState(db), null);
  });
});

describe("settling grants", () => {
  it("releases only a grant that never left written; one that may have been sent never comes back", () => {
    const db = workspace();
    const unsent = granted(db);
    assert.ok(releaseGrant(db, unsent.id, OCT, ledgerState(db)));
    assert.equal(getGrant(db, unsent.id)?.state, "released");
    const sentGrant = granted(db);
    markDispatching(db, sentGrant.id, HOME, OCT, ledgerState(db));
    assert.equal(releaseGrant(db, sentGrant.id, OCT, ledgerState(db)), null);
    markAccepted(db, sentGrant.id, OCT);
    assert.equal(releaseGrant(db, sentGrant.id, OCT, ledgerState(db)), null);
    assert.equal(summary(db).reservedMicros, GRANT_TOTAL);
  });

  it("settles a complete seal: reported rows count at the grant's prices, unknown rows at its bound whatever the engine said, and the rest is released", () => {
    const db = workspace();
    const grant = granted(db);
    const settled = sent(db, grant.id, [row(grant.id, 1), row(grant.id, 2, { state: "unknown", usage: null, boundMicros: null, amountMicros: 0 })]);
    assert.ok("state" in settled && settled.state === "settled");
    assert.deepEqual(money(db), [3_900, WORK_REQUEST, 0]);
    const totals = summary(db);
    assert.deepEqual([totals.usage!.requests, totals.usage!.unknownRequests, totals.usage!.inputTokens, totals.usage!.outputTokens], [1, 1, 10_000, 1_000]);
  });

  it("prices a request whose cached input wasn't reported as partial, all its input at the full rate", () => {
    const db = workspace();
    const grant = granted(db);
    const partial = row(grant.id, 1, { state: "partial", usage: { inputTokens: 10_000, cachedInputTokens: null, outputTokens: 1_000 } });
    assert.ok("state" in sent(db, grant.id, [partial]));
    assert.equal(summary(db).settledMicros, 3_900);
  });

  it("refuses a journal whose rows don't add up: an amount that isn't its usage at the grant's prices, a state its usage doesn't bear out, or a model the grant doesn't cover", () => {
    const db = workspace();
    for (const bad of [
      { amountMicros: 1 },
      { state: "reported" as const, usage: { inputTokens: 10_000, cachedInputTokens: null, outputTokens: 1_000 } },
      { state: "reported" as const, usage: null },
      { model: LIGHTNING },
      { model: null },
    ]) {
      const grant = granted(db);
      const result = sent(db, grant.id, [row(grant.id, 1, bad)]);
      assert.ok("refused" in result, JSON.stringify(bad));
      assert.equal(getGrant(db, grant.id)?.state, "dispatching", "a refused journal settles nothing");
    }
  });

  it("keeps an interrupted seal's remainder counted: the rows it holds settle, the rest stays reserved as unknown", () => {
    const db = workspace();
    const grant = granted(db);
    const result = sent(db, grant.id, [row(grant.id, 1)], "interrupted");
    assert.ok("state" in result && result.state === "uncertain");
    assert.deepEqual(money(db), [3_900, GRANT_TOTAL - 3_900, 0]);
    assert.ok(summary(db).gaps.includes("uncertain-grants"));
    assert.equal(releaseGrant(db, grant.id, OCT, ledgerState(db)), null, "an uncertain grant is never released");
  });

  it("counts a written-off grant in full as unknown spend, never as zero", () => {
    const db = workspace();
    const grant = granted(db);
    markDispatching(db, grant.id, HOME, OCT, ledgerState(db));
    markUncertain(db, grant.id, OCT);
    assert.ok(writeOff(db, grant.id, OCT));
    assert.deepEqual(money(db), [0, GRANT_TOTAL, 0]);
  });

  it("records a journal once: the same journal again changes nothing, and a different one is refused", () => {
    const db = workspace();
    const grant = granted(db);
    const rows = [row(grant.id, 2), row(grant.id, 1)];
    assert.ok("state" in sent(db, grant.id, rows));
    const revision = ledgerState(db)?.revision;
    const again = recordJournal(db, grant.id, [rows[1]!, rows[0]!], seal(grant.id, "complete", 2), OCT);
    assert.ok("state" in again && again.authority === null);
    assert.equal(ledgerState(db)?.revision, revision);
    const changed = recordJournal(db, grant.id, [rows[1]!, { ...rows[0]!, amountMicros: 1 }], seal(grant.id, "complete", 2), OCT);
    assert.ok("refused" in changed);
    assert.equal(summary(db).settledMicros, 7_800);
  });

  it("refuses a journal with open rows, rows of another grant, a wrong count or a gap in its numbering", () => {
    const db = workspace();
    const grant = granted(db);
    markDispatching(db, grant.id, HOME, OCT, ledgerState(db));
    for (const [rows, kept] of [
      [[row(grant.id, 1, { state: "sent" })], 1],
      [[row(randomUUID(), 1)], 1],
      [[row(grant.id, 1)], 2],
      [[row(grant.id, 1), row(grant.id, 3)], 2],
    ] as const) {
      assert.ok("refused" in recordJournal(db, grant.id, rows, seal(grant.id, "complete", kept), OCT));
    }
    assert.equal(getGrant(db, grant.id)?.state, "dispatching");
  });

  it("counts a counted service any of whose rows has no reported size at the grant's whole allowance, and every upload as an operation", () => {
    const db = workspace();
    const grant = granted(db, { models: [], productive: { requests: 0, outputTokens: 0 }, finalisation: { requests: 0, outputTokens: 0 }, allowances: { sandboxOperations: 5, sandboxSeconds: 600, researchCredits: 10 } });
    const service = (seq: number, over: Partial<BudgetOperation>) => row(grant.id, seq, { model: null, usage: null, amountMicros: null, boundMicros: null, ...over });
    const result = sent(db, grant.id, [
      service(1, { kind: "sandbox-operation", units: 30 }),
      service(2, { kind: "sandbox-transfer", units: null }),
      service(3, { kind: "research-search", state: "unknown", units: null }),
    ]);
    assert.ok("state" in result && result.state === "settled");
    assert.deepEqual(summary(db).counted.used, { sandboxOperations: 2, sandboxSeconds: 30, researchCredits: 10 });
    // No model was reached, so no money, and the summary says the services' use isn't priced in it.
    assert.deepEqual(money(db), [0, 0, 0]);
    assert.ok(summary(db).gaps.includes("services-unpriced"));
  });
});

describe("policies", () => {
  it("never resets what was spent: a lower limit admits nothing new, and open grants keep what they hold", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: 1_000_000 }, OCT);
    const grant = granted(db);
    const lowered = setPolicy(db, { ...DRAFT, monthlyMicros: 100_000 }, OCT).policy!;
    assert.deepEqual([lowered.version, lowered.replaces], [2, 1]);
    assert.equal(getGrant(db, grant.id)?.state, "written");
    assert.equal(summary(db).reservedMicros, GRANT_TOTAL);
    assert.equal(summary(db).availableMicros, 100_000 - GRANT_TOTAL);
    assert.equal(refusal(db).code, "pool");
  });

  it("turns the monthly budget off as a version of its own, keeping what was spent, and turning it off again changes nothing", () => {
    const db = workspace();
    assert.deepEqual(setPolicy(db, null, OCT), { policy: null, authority: null });
    setPolicy(db, DRAFT, OCT);
    granted(db);
    const off = setPolicy(db, null, OCT);
    assert.ok(off.authority && off.policy === null);
    assert.equal(currentPolicy(db), null);
    assert.equal(setPolicy(db, null, OCT).authority, null);
    // With the budget off, the pool no longer binds, and the grant written under it still counts.
    granted(db);
    assert.equal(summary(db).reservedMicros, 2 * GRANT_TOTAL);
    assert.equal(setPolicy(db, DRAFT, OCT).policy?.version, 3);
    assert.equal(refusal(db).code, "pool");
  });

  it("refuses money admission while this month holds spend that couldn't be priced, and admits again with the budget off or in a later month", () => {
    const db = workspace();
    const unpriced = granted(db, {}, OCT, TOKEN_FACTORY_PRICES);
    assert.ok("state" in sent(db, unpriced.id, [row(unpriced.id, 1)]));
    // What the unpriced request reported still shows, though its money can't.
    const totals = summary(db);
    assert.deepEqual([totals.settledMicros, totals.usage!.requests, totals.usage!.inputTokens], [null, 1, 10_000]);
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT);
    const refused = refusal(db);
    assert.equal(refused.code, "unpriced-spend");
    assert.match(refused.message, /couldn't price/);
    assert.equal(summary(db).availableMicros, null);
    observeProviderTime(db, NOV, NOV, "UTC");
    granted(db, {}, NOV);
    assert.equal(summary(db, NOV).availableMicros, 10_000_000 - GRANT_TOTAL);
  });

  it("keeps each sublimit inside the pool: project, per-task and daily", () => {
    const db = workspace();
    const attemptId = randomUUID();
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000, sublimits: { ...NO_SUBLIMITS, projects: [{ projectId: PROJECT, monthlyMicros: GRANT_TOTAL }], perTaskMicros: GRANT_TOTAL, dailyMicros: 3 * GRANT_TOTAL } }, OCT);
    granted(db, { attribution: { ...request().attribution, attemptId } });
    const project = refusal(db);
    assert.ok(project.code === "sublimit" && /project/.test(project.message));
    const elsewhere = { ...request().attribution, projectId: randomUUID() };
    assert.match(refusal(db, { attribution: { ...elsewhere, attemptId } }).message, /per-task/);
    granted(db, { attribution: elsewhere });
    granted(db, { attribution: { ...elsewhere, projectId: randomUUID() } });
    assert.match(refusal(db, { attribution: { ...elsewhere, projectId: randomUUID() } }).message, /daily limit .* or wait for tomorrow/);
  });

  it("holds the daily limit when the computer's clock moves back a day", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000, sublimits: { ...NO_SUBLIMITS, dailyMicros: GRANT_TOTAL } }, OCT);
    granted(db, {}, OCT);
    assert.match(refusal(db, {}, OCT - DAY).message, /daily/);
  });

  it("holds a task's limit across a month's end", () => {
    const db = workspace();
    const attemptId = randomUUID();
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000, sublimits: { ...NO_SUBLIMITS, perTaskMicros: GRANT_TOTAL } }, OCT);
    granted(db, { attribution: { ...request().attribution, attemptId } }, OCT);
    observeProviderTime(db, NOV, NOV, "UTC");
    assert.match(refusal(db, { attribution: { ...request().attribution, attemptId } }, NOV).message, /per-task/);
  });

  it("holds counted services to their monthly allowance", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    assert.equal(refusal(db, { models: [], allowances: { sandboxOperations: 101, sandboxSeconds: 0, researchCredits: 0 } }).code, "counted");
  });
});

describe("budget months", () => {
  it("never open on the computer's clock alone: a grant late in the next month still counts in the current one", () => {
    const db = workspace();
    granted(db, {}, OCT);
    const later = granted(db, {}, NOV);
    assert.equal(currentPeriod(db)?.label, "2026-10");
    assert.equal(getGrant(db, later.id)?.periodIndex, currentPeriod(db)?.index);
  });

  it("open when the provider's clock passes the boundary, once, and a clock moved back reopens nothing", () => {
    const db = workspace();
    granted(db, {}, OCT);
    assert.equal(observeProviderTime(db, OCT, OCT, "UTC").opened, null);
    const november = observeProviderTime(db, NOV, NOV, "UTC").opened;
    assert.deepEqual([november?.label, november?.openedBy], ["2026-11", "corroborated"]);
    assert.equal(observeProviderTime(db, OCT, NOV, "UTC").opened, null);
    assert.equal(observeProviderTime(db, NOV, NOV, "UTC").opened, null);
    assert.equal(currentPeriod(db)?.label, "2026-11");
  });

  it("open on the person's confirmation of the month they were shown, and refuse another month or the same one", () => {
    const db = workspace();
    granted(db, {}, OCT);
    assert.equal(summary(db, DEC).clock.computerMonth, "2026-12");
    assert.deepEqual(confirmMonth(db, "2026-10", OCT, "UTC"), { refused: "not-later" });
    assert.deepEqual(confirmMonth(db, "2026-11", DEC, "UTC"), { refused: "not-shown" });
    const confirmed = confirmMonth(db, "2026-12", DEC, "UTC");
    assert.ok("opened" in confirmed);
    assert.deepEqual([confirmed.opened.label, confirmed.opened.openedBy], ["2026-12", "confirmed"]);
  });

  it("show the clock's recorded jumps since the month opened, newest first", () => {
    const db = workspace();
    granted(db, {}, OCT);
    recordClockJump(db, "jump-forward", OCT + 1_000, 7 * DAY);
    recordClockJump(db, "jump-back", OCT + 2_000, -2 * DAY);
    assert.deepEqual(summary(db).clock.jumps.map((jump) => [jump.kind, jump.deltaMs]), [["jump-back", -2 * DAY], ["jump-forward", 7 * DAY]]);
  });

  it("jump months without carrying anything over, and keep an open grant, and its late journal, in its own month", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: GRANT_TOTAL }, OCT);
    const october = granted(db, {}, OCT);
    markDispatching(db, october.id, HOME, OCT, ledgerState(db));
    observeProviderTime(db, DEC, DEC, "UTC");
    assert.equal(currentPeriod(db)?.label, "2026-12");
    // December has its own pool, no more: November's allowance wasn't added to it.
    granted(db, {}, DEC);
    assert.equal(refusal(db, {}, DEC).code, "pool");
    recordJournal(db, october.id, [row(october.id, 1)], seal(october.id, "complete", 1), DEC);
    assert.equal(getGrant(db, october.id)?.state, "settled");
    assert.equal(summary(db, DEC).settledMicros, 0, "October's late journal settles in October, not December");
  });
});

describe("price lists", () => {
  it("keep a version as first registered, and price new grants only with the version they name", () => {
    const db = workspace();
    const first = granted(db);
    registerCatalogue(db, ESTABLISHED, OCT);
    assert.throws(() => registerCatalogue(db, { ...ESTABLISHED, listings: "free" }, OCT), /already kept/);
    const dearer: PriceCatalogue = { ...ESTABLISHED, version: "test-established-2", models: ESTABLISHED.models.map((rate) => ({ ...rate, inputMicrosPerMillion: rate.inputMicrosPerMillion * 2 })) };
    const second = granted(db, {}, OCT, dearer);
    assert.equal(getGrant(db, first.id)?.catalogueVersion, "test-established-1");
    assert.equal(getGrant(db, second.id)?.catalogueVersion, "test-established-2");
    assert.ok((second.productiveMicros ?? 0) > (first.productiveMicros ?? 0));
  });
});

describe("extensions", () => {
  it("answer one need once, refuse any other request for it, and refuse work that has ended", () => {
    const db = workspace();
    const first = granted(db);
    markDispatching(db, first.id, HOME, OCT, ledgerState(db));
    const asked = request({ extends: first.id, need: "segment-2", requestId: first.requestId });
    const extension = writeGrant(db, asked, context(db));
    assert.ok("grant" in extension);
    const again = writeGrant(db, { ...asked }, context(db));
    assert.ok("grant" in again && again.grant.id === extension.grant.id && again.authority === null);
    for (const other of [
      { productive: { requests: 3, outputTokens: 8_000 } },
      { allowances: { sandboxOperations: 1, sandboxSeconds: 0, researchCredits: 0 } },
      { attribution: { ...asked.attribution, feature: "review" as const } },
      { finalisation: { requests: 2, outputTokens: 1_500 } },
    ]) {
      const result = writeGrant(db, { ...asked, ...other }, context(db));
      assert.ok("refused" in result && result.refused.code === "duplicate-need", JSON.stringify(other));
    }
    recordJournal(db, first.id, [], seal(first.id, "complete", 0), OCT);
    assert.equal(refusal(db, { extends: first.id, need: "segment-3", requestId: first.requestId }).code, "closed");
  });
});

describe("a history started again after a loss", () => {
  it("records the loss, holds spending to the allowance the person set, or to none while they wait", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT);
    startNewHistory(db, { recovery: lost(db), remaining: left(GRANT_TOTAL + 1_000), now: OCT, timezone: "UTC" });
    granted(db);
    const totals = summary(db);
    assert.deepEqual([totals.settledMicros, totals.availableMicros, totals.afterLoss?.remaining?.micros, totals.afterLoss?.since.micros], [null, 1_000, GRANT_TOTAL + 1_000, GRANT_TOTAL]);
    assert.deepEqual([totals.usage, totals.counted.used, totals.breakdown.length], [null, null, 0], "a month whose history was lost has no month-wide figures");
    assert.ok(totals.gaps.includes("history-lost"));
    const past = refusal(db);
    assert.ok(past.code === "pool" && /after Nivra lost its budget history/.test(past.message) && /confirm it in your budget/.test(past.message));
    startNewHistory(db, { recovery: lost(db), remaining: null, now: OCT, timezone: "UTC" });
    assert.equal(refusal(db).code, "history-wait");
    assert.equal(summary(db).availableMicros, 0);
  });

  it("binds without a policy too: waiting admits nothing, and an allowance admits only priced grants that fit it", () => {
    const db = workspace();
    startNewHistory(db, { recovery: lost(db), remaining: null, now: OCT, timezone: "UTC" });
    assert.equal(refusal(db, {}, OCT, TOKEN_FACTORY_PRICES).code, "history-wait");
    assert.equal(refusal(db, { models: [], allowances: { sandboxOperations: 1, sandboxSeconds: 0, researchCredits: 0 } }).code, "history-wait");
    startNewHistory(db, { recovery: lost(db), remaining: left(GRANT_TOTAL), now: OCT, timezone: "UTC" });
    assert.equal(refusal(db, {}, OCT, TOKEN_FACTORY_PRICES).code, "unestablished");
    granted(db);
    assert.equal(refusal(db).code, "pool");
  });

  it("counts every grant written after the loss against its allowance, even with the computer's clock moved back past it", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT);
    startNewHistory(db, { recovery: lost(db), remaining: left(GRANT_TOTAL), now: OCT, timezone: "UTC" });
    granted(db, {}, OCT - 2 * DAY);
    assert.equal(refusal(db, {}, OCT - 2 * DAY).code, "pool");
  });

  it("takes a new ledger id past the guard's revision, keeps the month, and makes every open grant uncertain", () => {
    const db = workspace();
    const written = granted(db);
    const dispatching = granted(db);
    markDispatching(db, dispatching.id, HOME, OCT, ledgerState(db));
    const before = ledgerState(db)!;
    const recovery = lost(db);
    const authority = startNewHistory(db, { recovery, remaining: null, now: DEC, timezone: "UTC" });
    assert.notEqual(authority.ledgerId, before.ledgerId);
    assert.equal(authority.revision, recovery.guard.revision + 1);
    assert.deepEqual(ledgerState(db), authority);
    assert.equal(currentPeriod(db)?.label, "2026-10", "a new history keeps the month; it doesn't open one by the computer's clock");
    assert.deepEqual([getGrant(db, written.id)?.state, getGrant(db, dispatching.id)?.state], ["uncertain", "uncertain"]);
    assert.equal(releaseGrant(db, written.id, OCT, ledgerState(db)), null);
  });
});

describe("a daily limit", () => {
  const daily: BudgetPolicyDraft = { ...DRAFT, monthlyMicros: 10_000_000, sublimits: { ...NO_SUBLIMITS, dailyMicros: GRANT_TOTAL } };

  it("holds when the clock ran ahead and came back: a grant written ahead keeps the later ones on its day", () => {
    const db = workspace();
    setPolicy(db, daily, OCT);
    granted(db, {}, OCT + 3 * DAY);
    assert.match(refusal(db, {}, OCT).message, /daily/);
  });

  it("holds when only a clock record was written ahead", () => {
    const db = workspace();
    setPolicy(db, daily, OCT);
    recordClockJump(db, "jump-forward", OCT + 3 * DAY, 3 * DAY);
    granted(db, {}, OCT);
    assert.match(refusal(db, {}, OCT).message, /daily/);
  });
});

describe("a queue's limit", () => {
  it("holds within the pool, and across a month's end", () => {
    const db = workspace();
    const queueId = randomUUID();
    const inQueue = (id: string) => ({ attribution: { ...request().attribution, queueId: id } });
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000, sublimits: { ...NO_SUBLIMITS, perQueueMicros: GRANT_TOTAL } }, OCT);
    granted(db, inQueue(queueId), OCT);
    assert.match(refusal(db, inQueue(queueId)).message, /per-queue/);
    observeProviderTime(db, NOV, NOV, "UTC");
    assert.match(refusal(db, inQueue(queueId), NOV).message, /per-queue/);
    granted(db, inQueue(randomUUID()), NOV);
  });
});

describe("spend that couldn't be priced", () => {
  it("doesn't hold up a call that reaches no model: it needs no money", () => {
    const db = workspace();
    granted(db, {}, OCT, TOKEN_FACTORY_PRICES);
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT);
    assert.equal(refusal(db).code, "unpriced-spend");
    granted(db, { ...{ models: [], productive: { requests: 0, outputTokens: 0 }, finalisation: { requests: 0, outputTokens: 0 } }, allowances: { sandboxOperations: 1, sandboxSeconds: 0, researchCredits: 0 } });
  });

  it("in a task's earlier month says the task's limit can't be checked, without telling the person to wait for next month", () => {
    const db = workspace();
    const attemptId = randomUUID();
    const ofTask = { attribution: { ...request().attribution, attemptId } };
    granted(db, ofTask, OCT, TOKEN_FACTORY_PRICES);
    observeProviderTime(db, NOV, NOV, "UTC");
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000, sublimits: { ...NO_SUBLIMITS, perTaskMicros: 2 * GRANT_TOTAL } }, NOV);
    const refused = refusal(db, ofTask, NOV);
    assert.equal(refused.code, "unpriced-spend");
    assert.match(refused.message, /remove the task limit/);
    assert.doesNotMatch(refused.message, /next month/);
  });
});

describe("a lost history and the counted services", () => {
  it("holds them to what the person said was left, with a policy or without one", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    const service = (operations: number) => ({ ...{ models: [], productive: { requests: 0, outputTokens: 0 }, finalisation: { requests: 0, outputTokens: 0 } }, allowances: { sandboxOperations: operations, sandboxSeconds: 0, researchCredits: 0 } });
    startNewHistory(db, { recovery: lost(db), remaining: left(10_000_000, { sandboxOperations: 10, sandboxSeconds: 0, researchCredits: 0 }), now: OCT, timezone: "UTC" });
    granted(db, service(10));
    const refused = refusal(db, service(1));
    assert.equal(refused.code, "counted");
    assert.match(refused.message, /you said were left this month/);
    assert.deepEqual(summary(db).afterLoss?.since.counted, { sandboxOperations: 10, sandboxSeconds: 0, researchCredits: 0 });
    setPolicy(db, null, OCT);
    assert.equal(refusal(db, service(1)).code, "counted");
  });

  it("records the loss in the current month even with the computer's clock ahead, so it binds there", () => {
    const db = workspace();
    granted(db, {}, OCT);
    startNewHistory(db, { recovery: lost(db), remaining: null, now: DEC, timezone: "UTC" });
    assert.equal(refusal(db, {}, DEC).code, "history-wait");
  });

  it("counts a sandbox operation of unknown length at the grant's whole sandbox time", () => {
    const db = workspace();
    const grant = granted(db, { ...{ models: [], productive: { requests: 0, outputTokens: 0 }, finalisation: { requests: 0, outputTokens: 0 } }, allowances: { sandboxOperations: 5, sandboxSeconds: 600, researchCredits: 0 } });
    const service = (seq: number, over: Partial<BudgetOperation>) => row(grant.id, seq, { model: null, usage: null, amountMicros: null, boundMicros: null, ...over });
    sent(db, grant.id, [service(1, { kind: "sandbox-operation", units: 30 }), service(2, { kind: "sandbox-operation", state: "unknown", units: null })]);
    assert.deepEqual(summary(db).counted.used, { sandboxOperations: 2, sandboxSeconds: 600, researchCredits: 0 });
  });
});

describe("writes that depend on the guard", () => {
  it("are refused on a ledger that doesn't hold the history the guard last verified, and allowed on one that moved on from it", () => {
    const db = workspace();
    const grant = granted(db);
    const verified = ledgerState(db)!;
    const elsewhere = { ...verified, chain: "f".repeat(64) };
    const unverified = (error: Error) => error.message === BUDGET_UNVERIFIED;
    assert.throws(() => writeGrant(db, request(), { ...context(db), verified: elsewhere }), unverified);
    assert.throws(() => writeGrant(db, request(), { ...context(db), verified: null }), unverified);
    assert.throws(() => markDispatching(db, grant.id, HOME, OCT, elsewhere), unverified);
    assert.throws(() => releaseGrant(db, grant.id, OCT, elsewhere), unverified);
    assert.equal(getGrant(db, grant.id)?.state, "written");
    assert.ok(markDispatching(db, granted(db).id, HOME, OCT, verified));
  });
});

describe("a history that needs recovery", () => {
  it("has no month-wide figures in the summary, and says why", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    granted(db);
    const totals = budgetSummary(db, { now: OCT, catalogue: ESTABLISHED, recovery: lost(db), timezone: "UTC" });
    assert.deepEqual([totals.settledMicros, totals.availableMicros, totals.usage, totals.counted.used, totals.breakdown.length], [null, null, null, null, 0]);
    assert.ok(totals.gaps.includes("needs-recovery"));
  });
});

describe("durability", () => {
  it("keeps each commit durable when it returns, as the guard's order needs", () => {
    const db = workspace();
    db.db.exec("PRAGMA synchronous = NORMAL");
    ensureDurable(db);
    assert.equal(Number(db.db.prepare("PRAGMA synchronous").get()?.["synchronous"]), 2);
  });
});

describe("what the ledger refuses outright", () => {
  it("never lets a recorded change be edited or removed by hand", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    const written = granted(db);
    const grant = granted(db, { models: [], productive: { requests: 0, outputTokens: 0 }, finalisation: { requests: 0, outputTokens: 0 } });
    sent(db, grant.id, [row(grant.id, 1, { kind: "sandbox-operation", model: null, usage: null, amountMicros: null, units: 1 })]);
    const open = granted(db, { models: [], productive: { requests: 0, outputTokens: 0 }, finalisation: { requests: 0, outputTokens: 0 } });
    markDispatching(db, open.id, HOME, OCT, ledgerState(db));
    recordClockJump(db, "jump-forward", OCT, 2 * 60_000);
    const sql = db.db;
    for (const statement of [
      `DELETE FROM budget_grants WHERE id = '${grant.id}'`,
      "UPDATE budget_operations SET amount_micros = 0",
      "DELETE FROM budget_operations",
      "UPDATE budget_policies SET policy_json = '{}'",
      "UPDATE budget_authority SET revision = 1",
      "UPDATE budget_authority SET ledger_id = 'another', revision = revision + 1",
      "DELETE FROM budget_authority",
      "UPDATE budget_revisions SET chain = 'x'",
      "DELETE FROM budget_revisions",
      "INSERT INTO budget_revisions (ledger_id, revision, chain, at) VALUES ('another', 99, 'x', 'x')",
      "DELETE FROM budget_clock",
      "DELETE FROM price_catalogues",
      "INSERT INTO budget_policies (version, policy_json, replaces, revision, created_at) VALUES (9, NULL, 8, 99, 'x')",
    ]) {
      assert.throws(() => sql.exec(statement), Error, statement);
    }
    // Edits made the way a write path would make them, the revision moved forward first, so that each is refused only
    // for what it changes: a settled grant released, what a grant was written with changed, a written grant made
    // uncertain with no new history, a grant inserted already settled or on a day before the last, an operation of a
    // kind there isn't, and a month opened behind the current one.
    const current = "(SELECT revision FROM budget_authority)";
    const byHand = (statement: string) => () => sql.exec(`UPDATE budget_authority SET revision = revision + 1; ${statement}`);
    for (const statement of [
      `UPDATE budget_grants SET state = 'released', revision = ${current} WHERE id = '${grant.id}'`,
      `UPDATE budget_grants SET productive_micros = 1, revision = ${current} WHERE id = '${grant.id}'`,
      `UPDATE budget_grants SET written_revision = 1, revision = ${current} WHERE id = '${written.id}'`,
      `UPDATE budget_grants SET state = 'uncertain', revision = ${current} WHERE id = '${written.id}'`,
      `INSERT INTO budget_grants SELECT '${randomUUID()}', request_id, request_sha256, workflow, target_id, 'home-x', period_idx, policy_version, catalogue_version, grant_json,
        attribution_json, feature, project_id, attempt_id, queue_id, profile_id, model, productive_micros, finalisation_micros, extends_id, need, 'settled', 'complete', 0,
        ${current}, day_idx, ${current}, created_at, updated_at FROM budget_grants WHERE id = '${written.id}'`,
      `INSERT INTO budget_grants SELECT '${randomUUID()}', request_id, request_sha256, workflow, target_id, NULL, period_idx, policy_version, catalogue_version, grant_json,
        attribution_json, feature, project_id, attempt_id, queue_id, profile_id, model, productive_micros, finalisation_micros, extends_id, need, 'written', NULL, NULL,
        ${current}, day_idx - 1, ${current}, created_at, updated_at FROM budget_grants WHERE id = '${written.id}'`,
      `INSERT INTO budget_operations (id, grant_id, seq, kind, model, state, amount_micros, counted_micros, units, operation_json, recorded_at)
        VALUES ('${randomUUID()}', '${open.id}', 1, 'made-up', NULL, 'reported', NULL, NULL, NULL, '{}', 'x')`,
      `INSERT INTO budget_periods (idx, label, starts_at, ends_at, timezone, opened_by, evidence_json, opened_at, revision) VALUES (0, '0000-01', 'x', 'x', 'UTC', 'confirmed', '{}', 'x', ${current})`,
    ]) {
      assert.throws(byHand(statement), Error, statement);
    }
    assert.deepEqual([getGrant(db, grant.id)?.state, getGrant(db, written.id)?.state], ["settled", "written"]);
  });
});
