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
  type GrantRequest,
  type JournalSeal,
  type PriceCatalogue,
} from "@nivra/domain";
import {
  budgetSummary,
  confirmMonth,
  currentPeriod,
  getGrant,
  ledgerState,
  markAccepted,
  markDispatching,
  markUncertain,
  observeProviderTime,
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
 * two callers can't both take the last of the pool; unused allowance released only on affirmative evidence; unknown
 * spend counted at its bound and never as zero; months that only move forward; and a history nothing can quietly
 * rewrite.
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
const PROJECT = randomUUID();
const OCT = Date.parse("2026-10-28T01:00:00Z");
const NOV = Date.parse("2026-11-02T01:00:00Z");
const DEC = Date.parse("2026-12-03T01:00:00Z");
const HOME = "home-1";

/** A price list whose currency and bounds are established, as checkpoint 1 would make one. */
const ESTABLISHED: PriceCatalogue = {
  ...TOKEN_FACTORY_PRICES,
  version: "test-established-1",
  currency: { code: "USD", source: "a written answer from the provider (test)" },
  models: TOKEN_FACTORY_PRICES.models.map((rate) => ({ ...rate, bounds: { inputTokens: 128_000, outputCappedByMaxTokens: true as const, source: "test", establishedOn: "2026-10-28" } })),
};
// One request with Super's bounds: 120,000 input at 0.30 a million and 8,000 output at 0.90 a million.
const WORK_REQUEST = 36_000 + 7_200;
// The hand-in: 126,500 input and 1,500 output.
const HAND_IN = 37_950 + 1_350;
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

const context = (now = OCT, catalogue: PriceCatalogue = ESTABLISHED) => ({ now, catalogue, timezone: "UTC" });

function granted(db: WorkspaceDb, over: Partial<GrantRequest> = {}, now = OCT, catalogue: PriceCatalogue = ESTABLISHED) {
  const result = writeGrant(db, request(over), context(now, catalogue));
  assert.ok("grant" in result, "refused" in result ? result.refused.message : "");
  return result.grant;
}

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
  usage: { inputTokens: 10_000, cachedInputTokens: null, outputTokens: 1_000 },
  units: null,
  amountMicros: 3_900,
  ...over,
});

const seal = (grantId: string, kind: JournalSeal["kind"], rows: number): JournalSeal => ({ grantId, kind, rows, instanceId: randomUUID(), sealedAt: new Date(OCT).toISOString() });

const summary = (db: WorkspaceDb, now = OCT, catalogue: PriceCatalogue = ESTABLISHED) => budgetSummary(db, { now, catalogue, recovery: null });

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
    assert.ok(markDispatching(db, grant.id, HOME, OCT));
    assert.equal(ledgerState(db)?.revision, 2);
  });

  it("admits only one of two callers asking for the last of the pool, and writes nothing for the other", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    granted(db);
    const before = ledgerState(db);
    const second = writeGrant(db, request({ attribution: { ...request().attribution, feature: "review" } }), context());
    assert.ok("refused" in second);
    assert.equal(second.refused.code, "pool");
    assert.match(second.refused.message, /monthly budget of 0\.20 dollars/);
    assert.deepEqual(ledgerState(db), before, "a refusal changes nothing");
    assert.equal(summary(db).reservedMicros, GRANT_TOTAL);
  });

  it("refuses a model with no price, names it, and writes nothing", () => {
    const db = workspace();
    const refused = writeGrant(db, request({ models: ["nvidia/some-other-model"] }), context());
    assert.ok("refused" in refused);
    assert.equal(refused.refused.code, "no-price");
    assert.match(refused.refused.message, /nvidia\/some-other-model/);
    assert.equal(ledgerState(db), null);
  });

  it("refuses every model under a money policy until its bounds and the list's currency are established", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    const refused = writeGrant(db, request(), context(OCT, TOKEN_FACTORY_PRICES));
    assert.ok("refused" in refused);
    assert.equal(refused.refused.code, "unestablished");
  });

  it("without a policy, writes and counts an unpriced grant, and says the money total is incomplete", () => {
    const db = workspace();
    const grant = granted(db, {}, OCT, TOKEN_FACTORY_PRICES);
    assert.equal(grant.productiveMicros, null);
    const totals = summary(db, OCT, TOKEN_FACTORY_PRICES);
    assert.equal(totals.poolMicros, null);
    assert.equal(totals.availableMicros, null);
    for (const gap of ["currency-unconfirmed", "bounds-unestablished", "unpriced-usage", "listings-unpriced"] as const) assert.ok(totals.gaps.includes(gap), gap);
  });

  it("rolls back everything when the transaction around it fails", () => {
    const db = workspace();
    assert.throws(() =>
      db.tx(() => {
        granted(db);
        throw new Error("injected");
      }),
    );
    assert.equal(ledgerState(db), null);
    assert.equal(currentPeriod(db), null);
    assert.equal(summary(db).reservedMicros, 0);
  });
});

describe("settling grants", () => {
  it("releases only a grant that never left written; one that may have been sent never comes back", () => {
    const db = workspace();
    const unsent = granted(db);
    assert.ok(releaseGrant(db, unsent.id, OCT));
    assert.equal(getGrant(db, unsent.id)?.state, "released");
    const sent = granted(db);
    markDispatching(db, sent.id, HOME, OCT);
    assert.equal(releaseGrant(db, sent.id, OCT), null);
    markAccepted(db, sent.id, OCT);
    assert.equal(releaseGrant(db, sent.id, OCT), null);
    assert.equal(summary(db).reservedMicros, GRANT_TOTAL);
  });

  it("settles a complete seal: reported rows count, unknown rows count at their bound, and the rest is released", () => {
    const db = workspace();
    const grant = granted(db);
    markDispatching(db, grant.id, HOME, OCT);
    const rows = [row(grant.id, 1), row(grant.id, 2, { state: "unknown", usage: null, amountMicros: WORK_REQUEST })];
    const settled = recordJournal(db, grant.id, rows, seal(grant.id, "complete", 2), OCT);
    assert.ok("state" in settled && settled.state === "settled");
    const totals = summary(db);
    assert.deepEqual([totals.settledMicros, totals.unknownMicros, totals.reservedMicros], [3_900, WORK_REQUEST, 0]);
  });

  it("keeps an interrupted seal's remainder counted: the rows it holds settle, the rest stays reserved as unknown", () => {
    const db = workspace();
    const grant = granted(db);
    markDispatching(db, grant.id, HOME, OCT);
    const result = recordJournal(db, grant.id, [row(grant.id, 1)], seal(grant.id, "interrupted", 1), OCT);
    assert.ok("state" in result && result.state === "uncertain");
    const totals = summary(db);
    assert.deepEqual([totals.settledMicros, totals.unknownMicros, totals.reservedMicros], [3_900, GRANT_TOTAL - 3_900, 0]);
    assert.ok(totals.gaps.includes("uncertain-grants"));
    assert.equal(releaseGrant(db, grant.id, OCT), null, "an uncertain grant is never released");
  });

  it("counts a written-off grant in full as unknown spend, never as zero", () => {
    const db = workspace();
    const grant = granted(db);
    markDispatching(db, grant.id, HOME, OCT);
    markUncertain(db, grant.id, OCT);
    assert.ok(writeOff(db, grant.id, OCT));
    const totals = summary(db);
    assert.deepEqual([totals.settledMicros, totals.unknownMicros, totals.reservedMicros], [0, GRANT_TOTAL, 0]);
  });

  it("records a journal once: the same journal again changes nothing, and a different one is refused", () => {
    const db = workspace();
    const grant = granted(db);
    markDispatching(db, grant.id, HOME, OCT);
    const rows = [row(grant.id, 2), row(grant.id, 1)];
    assert.ok("state" in recordJournal(db, grant.id, rows, seal(grant.id, "complete", 2), OCT));
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
    markDispatching(db, grant.id, HOME, OCT);
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
});

describe("policies", () => {
  it("never resets what was spent: a lower limit admits nothing new, and open grants keep what they hold", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: 1_000_000 }, OCT);
    const grant = granted(db);
    const lowered = setPolicy(db, { ...DRAFT, monthlyMicros: 100_000 }, OCT).policy;
    assert.deepEqual([lowered.version, lowered.replaces], [2, 1]);
    assert.equal(getGrant(db, grant.id)?.state, "written");
    assert.equal(summary(db).reservedMicros, GRANT_TOTAL);
    assert.equal(summary(db).availableMicros, 100_000 - GRANT_TOTAL);
    const refused = writeGrant(db, request(), context());
    assert.ok("refused" in refused && refused.refused.code === "pool");
  });

  it("keeps each sublimit inside the pool: project, per-task and daily", () => {
    const db = workspace();
    const attemptId = randomUUID();
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000, sublimits: { ...NO_SUBLIMITS, projects: [{ projectId: PROJECT, monthlyMicros: GRANT_TOTAL }], perTaskMicros: GRANT_TOTAL, dailyMicros: 3 * GRANT_TOTAL } }, OCT);
    granted(db, { attribution: { ...request().attribution, attemptId } });
    const project = writeGrant(db, request(), context());
    assert.ok("refused" in project && project.refused.code === "sublimit" && /project/.test(project.refused.message));
    const elsewhere = { ...request().attribution, projectId: randomUUID() };
    const task = writeGrant(db, request({ attribution: { ...elsewhere, attemptId } }), context());
    assert.ok("refused" in task && /per-task/.test(task.refused.message));
    granted(db, { attribution: elsewhere });
    granted(db, { attribution: { ...elsewhere, projectId: randomUUID() } });
    const daily = writeGrant(db, request({ attribution: { ...elsewhere, projectId: randomUUID() } }), context());
    assert.ok("refused" in daily && /daily/.test(daily.refused.message));
  });

  it("holds counted services to their monthly allowance", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    const refused = writeGrant(db, request({ models: [], allowances: { sandboxOperations: 101, sandboxSeconds: 0, researchCredits: 0 } }), context());
    assert.ok("refused" in refused && refused.refused.code === "counted");
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

  it("open on the person's confirmation, and refuse one in the same month", () => {
    const db = workspace();
    granted(db, {}, OCT);
    assert.deepEqual(confirmMonth(db, OCT, "UTC"), { refused: "not-later" });
    const confirmed = confirmMonth(db, DEC, "UTC");
    assert.ok("opened" in confirmed);
    assert.deepEqual([confirmed.opened.label, confirmed.opened.openedBy], ["2026-12", "confirmed"]);
  });

  it("jump months without carrying anything over, and keep an open grant, and its late journal, in its own month", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: GRANT_TOTAL }, OCT);
    const october = granted(db, {}, OCT);
    markDispatching(db, october.id, HOME, OCT);
    observeProviderTime(db, DEC, DEC, "UTC");
    assert.equal(currentPeriod(db)?.label, "2026-12");
    // December has its own pool, no more: November's allowance wasn't added to it.
    granted(db, {}, DEC);
    const over = writeGrant(db, request(), context(DEC));
    assert.ok("refused" in over && over.refused.code === "pool");
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
  it("answer one need once, refuse another shape for it, and refuse work that has ended", () => {
    const db = workspace();
    const first = granted(db);
    markDispatching(db, first.id, HOME, OCT);
    const need = { extends: first.id, need: "segment-2", requestId: first.requestId };
    const extension = granted(db, need);
    const again = writeGrant(db, request(need), context());
    assert.ok("grant" in again && again.grant.id === extension.id && again.authority === null);
    const other = writeGrant(db, request({ ...need, productive: { requests: 3, outputTokens: 8_000 } }), context());
    assert.ok("refused" in other && other.refused.code === "duplicate-need");
    recordJournal(db, first.id, [], seal(first.id, "complete", 0), OCT);
    const late = writeGrant(db, request({ ...need, need: "segment-3" }), context());
    assert.ok("refused" in late && late.refused.code === "closed");
  });
});

describe("a history started again after a loss", () => {
  it("records the loss, holds spending to the allowance the person set, or to none while they wait", () => {
    const db = workspace();
    setPolicy(db, { ...DRAFT, monthlyMicros: 10_000_000 }, OCT);
    startNewHistory(db, { reason: "ledger-behind", remainingMicros: GRANT_TOTAL, now: OCT, timezone: "UTC" });
    granted(db);
    const past = writeGrant(db, request(), context());
    assert.ok("refused" in past && past.refused.code === "pool" && /lost this month's history/.test(past.refused.message));
    assert.ok(summary(db).gaps.includes("history-lost"));
    startNewHistory(db, { reason: "ledger-behind", remainingMicros: null, now: OCT, timezone: "UTC" });
    const waiting = writeGrant(db, request(), context());
    assert.ok("refused" in waiting && waiting.refused.code === "history-wait");
  });
});

describe("what the ledger refuses outright", () => {
  it("never lets a recorded change be edited or removed by hand", () => {
    const db = workspace();
    setPolicy(db, DRAFT, OCT);
    const grant = granted(db);
    markDispatching(db, grant.id, HOME, OCT);
    recordJournal(db, grant.id, [row(grant.id, 1)], seal(grant.id, "complete", 1), OCT);
    const sql = db.db;
    for (const statement of [
      `UPDATE budget_grants SET state = 'released', revision = revision + 1 WHERE id = '${grant.id}'`,
      `UPDATE budget_grants SET productive_micros = 0, revision = revision + 1 WHERE id = '${grant.id}'`,
      `DELETE FROM budget_grants WHERE id = '${grant.id}'`,
      "UPDATE budget_operations SET amount_micros = 0",
      "DELETE FROM budget_operations",
      "UPDATE budget_policies SET policy_json = '{}'",
      "UPDATE budget_authority SET revision = 1",
      "DELETE FROM budget_authority",
      "INSERT INTO budget_periods (idx, label, starts_at, ends_at, timezone, opened_by, evidence_json, opened_at, revision) VALUES (0, '0000-01', 'x', 'x', 'UTC', 'confirmed', '{}', 'x', 99)",
    ]) {
      assert.throws(() => sql.exec(statement), Error, statement);
    }
    assert.equal(getGrant(db, grant.id)?.state, "settled");
  });
});
