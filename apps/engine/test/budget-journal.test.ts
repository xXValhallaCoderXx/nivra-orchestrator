import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { priceUsage, type BudgetGrant, type ModelRate } from "@nivra/domain";
import { BUDGET_JOURNAL_SCHEMA, BudgetJournal, ensureJournalDurable } from "../src/budget/journal.ts";
import { Database } from "../src/db/database.ts";
import { RunScheduler, type RunHandle, type WorkflowEntry, type WorkflowSource } from "../src/runs/scheduler.ts";
import { RunStore } from "../src/runs/store.ts";
import type { WorkflowId } from "@nivra/domain";
import { startEngine, waitFor } from "./helpers.ts";

/**
 * The engine's journal of paid operations (NIV-66): a grant accepted before any operation; each operation written at
 * its send point only when its bound fits what is left, and closed on every path; unknown never zero; a complete seal
 * only from the instance that accepted the grant, with every row closed; and a journal put back from a backup, or left
 * by another instance, sealed interrupted, never complete.
 */

const dirs: string[] = [];
const open: Database[] = [];
after(() => {
  for (const database of open) database.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const RATE: ModelRate = {
  model: SUPER,
  inputMicrosPerMillion: 300_000,
  cachedInputMicrosPerMillion: 60_000,
  outputMicrosPerMillion: 900_000,
  bounds: { inputTokens: 128_000, outputCappedByMaxTokens: true, source: "test", establishedOn: "2026-10-28" },
};
// One work request: all 128,000 input at 0.30 a million and 8,000 output at 0.90 a million; the hand-in, 1,500 output.
const WORK = 38_400 + 7_200;
const HAND_IN = 38_400 + 1_350;
const AT = "2026-10-28T01:00:00.000Z";

function fresh(): { database: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "nivra journal ü "));
  dirs.push(dir);
  const path = join(dir, "nivra.db");
  return { database: opened(path), path };
}

/** Opens an engine database with the journal's tables, as its migration will add them. */
function opened(path: string): Database {
  const database = new Database(path);
  const db = database.open();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'budget_accepted'").get()) db.exec(BUDGET_JOURNAL_SCHEMA);
  open.push(database);
  return database;
}

function grant(over: Partial<BudgetGrant> = {}): BudgetGrant {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    catalogueVersion: "test-established-1",
    rates: [RATE],
    models: [SUPER],
    productiveMicros: 2 * WORK,
    finalisationMicros: HAND_IN,
    productive: { requests: 2, outputTokens: 8_000 },
    finalisation: { requests: 1, outputTokens: 1_500 },
    allowances: { sandboxOperations: 2, sandboxSeconds: 600, researchCredits: 3 },
    ...over,
  };
}

const request = (part: "productive" | "finalisation" = "productive", outputTokens = part === "productive" ? 8_000 : 1_500) => ({
  kind: "model-request" as const,
  part,
  model: SUPER,
  seat: "worker",
  instructionsSha256: null,
  outputTokens,
  boundUnits: null,
});
const service = (kind: "sandbox-operation" | "sandbox-transfer" | "research-search", boundUnits: number | null) => ({
  kind,
  part: "productive" as const,
  model: null,
  seat: null,
  instructionsSha256: null,
  outputTokens: null,
  boundUnits,
});

function accepted(journal: BudgetJournal, over: Partial<BudgetGrant> = {}): BudgetGrant {
  const one = grant(over);
  journal.accept(one, { runId: randomUUID(), providerDate: "Wed, 28 Oct 2026 01:00:00 GMT" });
  return one;
}

function opening(journal: BudgetJournal, grantId: string, operation: ReturnType<typeof request> | ReturnType<typeof service>) {
  const result = journal.open(grantId, operation);
  assert.ok("id" in result, "refused" in result ? result.refused : "");
  return result;
}

const REPORTED = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 1_000 };

describe("accepting a grant", () => {
  it("comes before any operation, once, and the same grant again changes nothing", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID(), () => new Date(AT));
    const one = grant();
    assert.deepEqual(journal.open(one.id, request()), { refused: "unaccepted" });
    const runId = randomUUID();
    journal.accept(one, { runId, providerDate: "Wed, 28 Oct 2026 01:00:00 GMT" });
    journal.accept(one, { runId, providerDate: "Wed, 28 Oct 2026 01:00:00 GMT" });
    assert.throws(() => journal.accept({ ...one, productiveMicros: 1 }, { runId, providerDate: null }), /other contents/);
    assert.equal(journal.providerDate(one.id), "Wed, 28 Oct 2026 01:00:00 GMT");
  });
});

describe("opening an operation at its send point", () => {
  it("reserves a model request at its bound from the grant's price, and refuses one that doesn't fit, writing nothing", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    opening(journal, one.id, request());
    opening(journal, one.id, request());
    assert.deepEqual(journal.open(one.id, request()), { refused: "requests" });
    // The hand-in has its own part, which productive work can't use.
    opening(journal, one.id, request("finalisation"));
    const rows = journal.read(one.id).rows;
    assert.deepEqual(rows.map((row) => [row.state, row.boundMicros]), [["reserved", WORK], ["reserved", WORK], ["reserved", HAND_IN]]);
  });

  it("refuses a request whose bound would go past its part's money, and one a priced grant can't bound", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const tight = accepted(journal, { productiveMicros: WORK + 10 });
    opening(journal, tight.id, request());
    assert.deepEqual(journal.open(tight.id, request()), { refused: "money" });
    const other = accepted(journal, { models: [SUPER, "nvidia/some-other-model"] });
    assert.deepEqual(journal.open(other.id, { ...request(), model: "nvidia/some-other-model" }), { refused: "unbounded" });
    assert.equal(journal.read(other.id).rows.length, 0);
  });

  it("counts an unpriced grant's requests, with no bound and no amount", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const unpriced = accepted(journal, { productiveMicros: null, finalisationMicros: null, rates: [{ ...RATE, bounds: null }], productive: { requests: 1, outputTokens: 8_000 } });
    const { id } = opening(journal, unpriced.id, request());
    assert.deepEqual(journal.open(unpriced.id, request()), { refused: "requests" });
    journal.sent(id);
    assert.equal(journal.close(id, { kind: "answered", usage: REPORTED }), "reported");
    assert.deepEqual(journal.read(unpriced.id).rows.map((row) => [row.boundMicros, row.amountMicros]), [[null, null]]);
  });

  it("holds Nebius operations, their seconds and Tavily credits to the grant's allowances", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal, { allowances: { sandboxOperations: 2, sandboxSeconds: 600, researchCredits: 3 } });
    opening(journal, one.id, service("sandbox-operation", 500));
    assert.deepEqual(journal.open(one.id, service("sandbox-operation", 200)), { refused: "counted" });
    opening(journal, one.id, service("sandbox-transfer", null));
    assert.deepEqual(journal.open(one.id, service("sandbox-transfer", null)), { refused: "counted" });
    opening(journal, one.id, service("research-search", 2));
    assert.deepEqual(journal.open(one.id, service("research-search", 2)), { refused: "counted" });
    opening(journal, one.id, service("research-search", 1));
  });
});

describe("closing an operation", () => {
  it("prices an answer from its usage at the grant's price, as the host will work it out again", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    const reported = opening(journal, one.id, request());
    journal.sent(reported.id);
    assert.equal(journal.close(reported.id, { kind: "answered", usage: REPORTED }), "reported");
    const partial = opening(journal, one.id, request());
    assert.equal(journal.close(partial.id, { kind: "answered", usage: { ...REPORTED, cachedInputTokens: null } }), "partial");
    const rows = journal.read(one.id).rows;
    assert.deepEqual(
      rows.map((row) => row.amountMicros),
      [priceUsage(RATE, REPORTED)!.micros, priceUsage(RATE, { ...REPORTED, cachedInputTokens: null })!.micros],
    );
    assert.equal(rows[0]!.amountMicros, 3_900);
  });

  it("closes a request with no usage, or with input or output unreported, as unknown at its bound, never 0", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    const timedOut = opening(journal, one.id, request());
    journal.sent(timedOut.id);
    assert.equal(journal.close(timedOut.id, { kind: "no-usage" }), "unknown");
    const halfReported = opening(journal, one.id, request());
    assert.equal(journal.close(halfReported.id, { kind: "answered", usage: { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: null } }), "unknown");
    assert.deepEqual(journal.read(one.id).rows.map((row) => [row.state, row.amountMicros]), [["unknown", WORK], ["unknown", WORK]]);
  });

  it("closes as unsent only what the transport never took, and closes nothing twice", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    const refused = opening(journal, one.id, request());
    assert.equal(journal.close(refused.id, { kind: "unsent" }), "unsent");
    assert.throws(() => journal.close(refused.id, { kind: "no-usage" }), /only once/);
    // An unsent request frees its place: another may go out.
    const taken = opening(journal, one.id, request());
    journal.sent(taken.id);
    assert.throws(() => journal.close(taken.id, { kind: "unsent" }), /can't close as unsent/);
    assert.throws(() => journal.sent(taken.id), /still reserved/);
  });

  it("closes a counted service with the units it reported, or unknown without them", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    const search = opening(journal, one.id, service("research-search", 2));
    assert.equal(journal.close(search.id, { kind: "units", units: 1 }), "reported");
    const operation = opening(journal, one.id, service("sandbox-operation", 300));
    assert.equal(journal.close(operation.id, { kind: "units", units: null }), "unknown");
    assert.deepEqual(journal.read(one.id).rows.map((row) => [row.state, row.units, row.amountMicros]), [["reported", 1, null], ["unknown", null, null]]);
  });
});

describe("sealing a journal", () => {
  it("seals complete only with every row closed, only by the instance that accepted the grant, once", () => {
    const { database } = fresh();
    const instance = randomUUID();
    const journal = new BudgetJournal(database, instance);
    const one = accepted(journal);
    const { id } = opening(journal, one.id, request());
    assert.throws(() => journal.seal(one.id, "complete"), /every operation closed/);
    journal.close(id, { kind: "answered", usage: REPORTED });
    assert.throws(() => new BudgetJournal(database, randomUUID()).seal(one.id, "complete"), /instance that accepted/);
    const seal = journal.seal(one.id, "complete");
    assert.deepEqual([seal.kind, seal.rows, seal.instanceId], ["complete", 1, instance]);
    assert.deepEqual(journal.seal(one.id, "complete"), seal);
    assert.throws(() => journal.seal(one.id, "interrupted"), /already sealed complete/);
    assert.deepEqual(journal.open(one.id, request()), { refused: "sealed" });
    assert.deepEqual(journal.read(one.id).seal, seal);
  });

  it("seals interrupted by closing every row still open as unknown at its bound", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    const answered = opening(journal, one.id, request());
    journal.close(answered.id, { kind: "answered", usage: REPORTED });
    const inFlight = opening(journal, one.id, request());
    journal.sent(inFlight.id);
    opening(journal, one.id, request("finalisation"));
    const seal = journal.seal(one.id, "interrupted");
    assert.deepEqual([seal.kind, seal.rows], ["interrupted", 3]);
    assert.deepEqual(journal.read(one.id).rows.map((row) => [row.state, row.amountMicros]), [["reported", 3_900], ["unknown", WORK], ["unknown", HAND_IN]]);
  });

  it("seals a grant another instance accepted and never sealed as interrupted, never complete", () => {
    const { database } = fresh();
    const before = new BudgetJournal(database, randomUUID());
    const one = accepted(before);
    const sealedBefore = accepted(before);
    opening(before, one.id, request());
    before.seal(sealedBefore.id, "complete");
    const restarted = new BudgetJournal(database, randomUUID());
    assert.throws(() => restarted.seal(one.id, "complete"), /instance that accepted/);
    assert.deepEqual(restarted.interruptOthers(), [one.id]);
    assert.equal(restarted.read(one.id).seal?.kind, "interrupted");
    assert.deepEqual(restarted.read(one.id).rows.map((row) => row.state), ["unknown"]);
    assert.deepEqual(restarted.interruptOthers(), []);
  });

  it("seals a journal put back from a backup as interrupted, holding only the rows the backup kept", () => {
    const { database, path } = fresh();
    const instance = randomUUID();
    const journal = new BudgetJournal(database, instance);
    const one = accepted(journal);
    const first = opening(journal, one.id, request());
    journal.close(first.id, { kind: "answered", usage: REPORTED });
    // A backup taken now, after one closed row, before the work went on.
    database.open().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(path, `${path}.backup`);
    const second = opening(journal, one.id, request());
    journal.sent(second.id);
    journal.close(second.id, { kind: "answered", usage: REPORTED });
    // The engine is killed, and the backup is put back in place of its store.
    database.close();
    copyFileSync(`${path}.backup`, path);
    rmSync(`${path}-wal`, { force: true });
    const restored = opened(path);
    const restarted = new BudgetJournal(restored, randomUUID());
    assert.deepEqual(restarted.interruptOthers(), [one.id]);
    const read = restarted.read(one.id);
    assert.deepEqual([read.seal?.kind, read.seal?.rows, read.rows.length], ["interrupted", 1, 1]);
  });
});

describe("a run's end", () => {
  it("seals its grant in the run's own terminal transaction: complete with every row closed, interrupted with one open", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const done = accepted(journal);
    journal.close(opening(journal, done.id, request()).id, { kind: "answered", usage: REPORTED });
    assert.equal(journal.endWith(done.id, () => true), true);
    assert.equal(journal.read(done.id).seal?.kind, "complete");
    const cut = accepted(journal);
    opening(journal, cut.id, request());
    journal.endWith(cut.id, () => true);
    assert.deepEqual([journal.read(cut.id).seal?.kind, journal.read(cut.id).rows[0]!.state], ["interrupted", "unknown"]);
  });

  it("seals nothing when the run didn't move, and keeps the run where it was when the seal can't be written", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    assert.equal(journal.endWith(one.id, () => false), false);
    assert.equal(journal.read(one.id).seal, null);
    const db = database.open();
    db.exec("CREATE TABLE moved (n INTEGER)");
    db.exec("CREATE TEMP TRIGGER no_seal BEFORE INSERT ON budget_seals BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    assert.throws(() => journal.endWith(one.id, () => (db.exec("INSERT INTO moved VALUES (1)"), true)), /injected/);
    db.exec("DROP TRIGGER no_seal");
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM moved").get()?.["n"]), 0, "the transition rolled back with the seal");
  });
});

describe("a run's end, in the scheduler", () => {
  /** A scheduler whose one workflow ends with the given status, after `during` has run. */
  function scheduled(during: () => void = () => undefined) {
    const { database } = fresh();
    const instanceId = randomUUID();
    const store = new RunStore({ database });
    const journal = new BudgetJournal(database, instanceId);
    const workflows = new Map<WorkflowId, WorkflowEntry>([["hello", { id: "hello", title: () => "Hello" }]]);
    const scheduler = new RunScheduler({ store, workflows, instanceId, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, diagnose: () => undefined, journal });
    const handle: RunHandle = {
      start: async () => {
        during();
        return { status: "success", result: { greeting: "hello" } } as never;
      },
      cancel: async () => undefined,
      watch: () => () => undefined,
    };
    const source: WorkflowSource = { getWorkflow: () => ({ createRun: async () => handle }) };
    scheduler.attach(source);
    scheduler.recover();
    const submit = (budget?: BudgetGrant) => scheduler.submit({ clientRequestId: budget?.requestId ?? randomUUID(), ...(budget ? { budget } : {}), workflowId: "hello", input: { repoPath: "/repo", holdMs: 0 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } });
    return { store, journal, scheduler, submit };
  }
  const ended = async (store: RunStore, runId: string) => waitFor(() => (["succeeded", "failed", "cancelled"].includes(String(store.status(runId))) ? true : null), { what: "the run to end" });

  it("seals the grant a run was started under complete when its work ends with every row closed", async () => {
    const box: { journal?: BudgetJournal; grantId?: string } = {};
    const { store, journal, scheduler, submit } = scheduled(() => box.journal!.close(opening(box.journal!, box.grantId!, request()).id, { kind: "answered", usage: REPORTED }));
    const one = grant();
    Object.assign(box, { journal, grantId: one.id });
    const runId = submit(one);
    await ended(store, runId);
    assert.deepEqual([journal.read(one.id).seal?.kind, journal.read(one.id).seal?.rows], ["complete", 1]);
  });

  it("seals it interrupted when the run ends with a row still open, and seals nothing for a run with no grant", async () => {
    const box: { journal?: BudgetJournal; grantId?: string } = {};
    const { store, journal, scheduler, submit } = scheduled(() => void (box.grantId && opening(box.journal!, box.grantId, request())));
    const one = grant();
    Object.assign(box, { journal, grantId: one.id });
    const runId = submit(one);
    await ended(store, runId);
    assert.equal(journal.read(one.id).seal?.kind, "interrupted");
    const other = accepted(journal);
    box.grantId = undefined;
    await ended(store, submit());
    assert.equal(journal.read(other.id).seal, null);
  });
});

describe("the engine at start", () => {
  it("opens its database with every write durable, and seals what another instance left unsealed as interrupted", async () => {
    const { database, path } = fresh();
    assert.equal(Number(database.open().prepare("PRAGMA synchronous").get()?.["synchronous"]), 2);
    const earlier = new BudgetJournal(database, randomUUID());
    const left = accepted(earlier);
    opening(earlier, left.id, request());
    database.close();
    const engine = startEngine(join(path, ".."));
    try {
      await engine.initialize();
    } finally {
      engine.kill();
      await engine.exited;
    }
    const after = opened(path);
    const read = new BudgetJournal(after, randomUUID()).read(left.id);
    assert.deepEqual([read.seal?.kind, read.rows[0]!.state], ["interrupted", "unknown"]);
  });
});

describe("reading a journal", () => {
  it("pages rows by sequence, with the seal once there is one, and says when the grant was never accepted", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal, { productive: { requests: 5, outputTokens: 8_000 }, productiveMicros: 5 * WORK });
    for (let i = 0; i < 5; i++) journal.close(opening(journal, one.id, request()).id, { kind: "answered", usage: REPORTED });
    const first = journal.read(one.id, 0, 2);
    assert.deepEqual([first.rows.map((row) => row.seq), first.next, first.seal], [[1, 2], 2, null]);
    const last = journal.read(one.id, 4, 2);
    assert.deepEqual([last.rows.map((row) => row.seq), last.next], [[5], null]);
    journal.seal(one.id, "complete");
    assert.equal(journal.read(one.id, 0, 10).seal?.rows, 5);
    assert.deepEqual(journal.read(randomUUID()), { accepted: false, rows: [], seal: null, next: null });
  });
});

describe("what the journal refuses outright", () => {
  it("keeps every write durable, and never lets a row, a seal or an accepted grant be changed or removed by hand", () => {
    const { database } = fresh();
    const db = database.open();
    db.exec("PRAGMA synchronous = NORMAL");
    ensureJournalDurable(db);
    assert.equal(Number(db.prepare("PRAGMA synchronous").get()?.["synchronous"]), 2);
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal);
    const closed = opening(journal, one.id, request());
    journal.close(closed.id, { kind: "answered", usage: REPORTED });
    const other = accepted(journal);
    const live = opening(journal, other.id, request());
    journal.seal(one.id, "complete");
    for (const statement of [
      `UPDATE budget_journal SET amount_micros = 0 WHERE id = '${closed.id}'`,
      `UPDATE budget_journal SET state = 'unsent' WHERE id = '${closed.id}'`,
      `UPDATE budget_journal SET bound_micros = 0 WHERE id = '${live.id}'`,
      `DELETE FROM budget_journal WHERE id = '${live.id}'`,
      `INSERT INTO budget_journal (id, grant_id, seq, kind, part, state, opened_at) VALUES ('${randomUUID()}', '${one.id}', 2, 'model-request', 'productive', 'reserved', 'x')`,
      `INSERT INTO budget_journal (id, grant_id, seq, kind, part, state, opened_at) VALUES ('${randomUUID()}', '${other.id}', 5, 'model-request', 'productive', 'reserved', 'x')`,
      `INSERT INTO budget_journal (id, grant_id, seq, kind, part, state, opened_at, closed_at) VALUES ('${randomUUID()}', '${other.id}', 2, 'model-request', 'productive', 'reported', 'x', 'x')`,
      "UPDATE budget_seals SET rows = 0",
      "DELETE FROM budget_seals",
      `INSERT INTO budget_seals (grant_id, kind, rows, instance_id, sealed_at) VALUES ('${other.id}', 'interrupted', 1, 'x', 'x')`,
      "UPDATE budget_accepted SET grant_json = '{}'",
      "DELETE FROM budget_accepted",
    ]) {
      assert.throws(() => db.exec(statement), Error, statement);
    }
    assert.deepEqual(journal.read(other.id).rows.map((row) => row.state), ["reserved"]);
  });
});


describe("finite grant handoff", () => {
  it("refuses an unpriced request outside the granted model or output cap", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal, { productiveMicros: null, finalisationMicros: null, rates: [] });
    assert.deepEqual(journal.open(one.id, { ...request(), model: "nvidia/another" }), { refused: "model" });
    assert.deepEqual(journal.open(one.id, request("productive", 8_001)), { refused: "output" });
    assert.deepEqual(journal.open(one.id, { ...request(), outputTokens: null }), { refused: "output" });
    assert.equal(journal.read(one.id).rows.length, 0);
    opening(journal, one.id, request());
    assert.equal(journal.read(one.id).rows.length, 1);
  });

  it("bounds listings independently of inference requests", () => {
    const { database } = fresh();
    const journal = new BudgetJournal(database, randomUUID());
    const one = accepted(journal, { modelListings: 1 });
    const listing = { kind: "model-listing" as const, part: "productive" as const, model: null, seat: null, instructionsSha256: null, outputTokens: null, boundUnits: null };
    const opened = journal.open(one.id, listing);
    assert.ok("id" in opened);
    journal.sent(opened.id);
    journal.close(opened.id, { kind: "units", units: 0 });
    assert.deepEqual(journal.open(one.id, listing), { refused: "requests" });
    opening(journal, one.id, request());
  });

  it("accepts a grant atomically before pumping and seals a queued cancellation", () => {
    const { database } = fresh();
    const store = new RunStore({ database });
    const journal = new BudgetJournal(database, randomUUID());
    const scheduler = new RunScheduler({ store, journal, instanceId: randomUUID(), workflows: new Map([["hello", { id: "hello" as const, title: () => "Hello" }]]), log: { info: () => undefined, warn: () => undefined, error: () => undefined }, diagnose: () => undefined });
    const budget = grant();
    const request = { clientRequestId: budget.requestId, budget, workflowId: "hello" as const, input: { repoPath: "/repo", holdMs: 0 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } };
    const id = scheduler.submit(request);
    assert.equal(journal.grantForRun(id), budget.id);
    assert.equal(scheduler.submit(request), id);
    assert.equal(store.list({ limit: 10 }).runs.length, 1);
    assert.throws(() => scheduler.submit({ ...request, budget: { ...budget, id: randomUUID() } }), /another budget grant/);
    assert.throws(() => scheduler.submit({ ...request, budget: undefined }), /another budget grant/);
    scheduler.cancel(id);
    assert.equal(store.status(id), "cancelled");
    assert.equal(journal.read(budget.id).seal?.kind, "complete");
    assert.equal(journal.read(budget.id).rows.length, 0);
    assert.equal(scheduler.grantOf(id), null);
  });

  it("records nothing when a grant names another request", () => {
    const { database } = fresh();
    const store = new RunStore({ database });
    const journal = new BudgetJournal(database, randomUUID());
    const scheduler = new RunScheduler({ store, journal, instanceId: randomUUID(), workflows: new Map([["hello", { id: "hello" as const, title: () => "Hello" }]]), log: { info: () => undefined, warn: () => undefined, error: () => undefined }, diagnose: () => undefined });
    const budget = grant();
    assert.throws(() => scheduler.submit({ clientRequestId: randomUUID(), budget, workflowId: "hello", input: { repoPath: "/repo", holdMs: 0 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } }), /doesn't belong/);
    assert.equal(store.list({ limit: 10 }).runs.length, 0);
    assert.equal(journal.read(budget.id).accepted, false);
  });
});


describe("grant handoff through a real engine", () => {
  it("accepts once, exposes the complete journal, and never replays after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra grant rpc "));
    dirs.push(root);
    const home = join(root, "engine");
    const budget = grant({ productiveMicros: null, finalisationMicros: null });
    const request = { clientRequestId: budget.requestId, budget, workflowId: "hello" as const, input: { repoPath: root, holdMs: 0 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } };
    let engine = startEngine(home);
    let runId = "";
    try {
      await engine.initialize();
      const missing = await engine.client.call("budget.journal", { grantId: randomUUID() });
      assert.deepEqual([missing.accepted, missing.rows.length, missing.seal], [false, 0, null]);
      const run = await engine.client.call("runs.start", request);
      runId = run.id;
      assert.equal(Object.hasOwn(run.input as object, "budget"), false);
      await engine.waitForRun(run.id, (page) => page.status === "failed");
      const journal = await engine.client.call("budget.journal", { grantId: budget.id });
      assert.deepEqual([journal.accepted, journal.rows.length, journal.seal?.kind], [true, 0, "complete"]);
      assert.equal((await engine.client.call("runs.start", request)).id, run.id);
      await assert.rejects(engine.client.call("runs.start", { ...request, budget: { ...budget, requestId: randomUUID() } }));
      await engine.client.call("shutdown", {});
      await engine.exited;
      engine = startEngine(home);
      await engine.initialize();
      const again = await engine.client.call("runs.start", request);
      assert.deepEqual([again.id, again.status], [runId, "failed"]);
      const retained = await engine.client.call("budget.journal", { grantId: budget.id });
      assert.equal(retained.seal?.kind, "complete");
      assert.equal(retained.rows.length, 0);
    } finally {
      engine.kill();
      await engine.exited;
    }
  });
});
