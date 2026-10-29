import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { priceUsage, requestBound, type BudgetGrant, type BudgetOperation, type JournalSeal, type ModelRate, type ModelUsage, type OperationKind } from "@nivra/domain";
import { type Database, num, type Row, str, strOrNull } from "../db/database.ts";

/**
 * The engine's journal of paid operations (NIV-66): what this engine spent under each grant the host gave it, kept in
 * its own nivra.db and never in Mastra's store. The host settles a grant from it, so it records only what it knows:
 * - a grant is accepted before any of its operations, in the same transaction that creates the run;
 * - each operation's row is written at its send point, as reserved, before anything goes out, and only when its bound
 *   fits what is left of the grant; it is closed on every path, as unsent (refused before the transport took it, and
 *   only that), reported, partial, or unknown (no usage came back), and an unknown row counts at its bound;
 * - a seal ends the journal: complete only at the normal end of the grant's work, by the instance that accepted it,
 *   with every row closed; interrupted otherwise, closing what was still open as unknown, because rows lost with a
 *   restored store can't be known.
 * Triggers keep it so: rows only move forward, nothing closed or sealed changes, and nothing is removed.
 */

export { BUDGET_JOURNAL_SCHEMA } from "./schema.ts";


export type OperationPart = "productive" | "finalisation";

/** Why an operation wasn't opened. Nothing was written, and nothing may be sent. */
export type OpenRefusal = "unaccepted" | "sealed" | "requests" | "money" | "unbounded" | "counted" | "model" | "output";

/** How an operation ended, as the code that sent it knows it. */
export type OperationOutcome =
  | { kind: "unsent" }
  | { kind: "answered"; usage: ModelUsage }
  | { kind: "no-usage" }
  | { kind: "units"; units: number | null };

const MODEL_KINDS: readonly OperationKind[] = ["model-request", "model-listing"];
const OPEN = ["reserved", "sent"];

interface AcceptedGrant {
  grant: BudgetGrant;
  instanceId: string;
  sealed: boolean;
}

export class BudgetJournal {
  readonly #database: Database;
  readonly #instanceId: string;
  readonly #now: () => Date;

  constructor(database: Database, instanceId: string, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#instanceId = instanceId;
    this.#now = now;
  }

  /**
   * Records that this engine accepted a grant, before any of its operations: inside the caller's transaction, the one
   * that creates its run, or before the first request of a call that isn't a run. `providerDate` is the Date of the
   * model listing's response, when one came: the provider's clock, which the host may take as a new month's evidence.
   * Accepting the same grant again changes nothing; another grant under its id is refused.
   */
  accept(grant: BudgetGrant, input: { runId: string | null; providerDate: string | null }): void {
    this.#database.tx((db) => {
      const json = JSON.stringify(grant);
      const kept = db.prepare("SELECT grant_json, run_id FROM budget_accepted WHERE grant_id = ?").get(grant.id);
      if (kept) {
        if (str(kept["grant_json"]) !== json || strOrNull(kept["run_id"]) !== input.runId) throw new Error("This grant was already accepted with other contents.");
        return;
      }
      db.prepare("INSERT INTO budget_accepted (grant_id, run_id, request_id, instance_id, grant_json, provider_date, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        grant.id,
        input.runId,
        grant.requestId,
        this.#instanceId,
        json,
        input.providerDate,
        this.#now().toISOString(),
      );
    });
  }

  /** Allowed model identifiers; a missing price never widens the grant. */
  models(grantId: string): readonly string[] {
    const accepted = acceptedIn(this.#database.open(), grantId);
    return accepted ? (accepted.grant.models ?? accepted.grant.rates.map((rate) => rate.model)) : [];
  }

  /** The accepted grant bound to this run, including after a restart. */
  grantForRun(runId: string): string | null {
    const row = this.#database.open().prepare("SELECT grant_id FROM budget_accepted WHERE run_id = ?").get(runId);
    return row ? str(row["grant_id"]) : null;
  }

  /**
   * Writes an operation's row at its send point, as reserved, before anything goes out; or refuses it, writing
   * nothing, when its grant isn't accepted or is sealed, or when it doesn't fit what is left of the grant: its part's
   * requests, its part's money (each row counted at its bound until its amount is known), or its counted services. A
   * model request's bound is worked out here from the grant's price for its model and the request's output cap; a priced
   * grant takes no request it can't bound.
   */
  open(
    grantId: string,
    operation: { kind: OperationKind; part: OperationPart; model: string | null; seat: string | null; instructionsSha256: string | null; outputTokens: number | null; boundUnits: number | null },
  ): { id: string; seq: number } | { refused: OpenRefusal } {
    return this.#database.tx((db) => {
      const accepted = acceptedIn(db, grantId);
      if (!accepted) return { refused: "unaccepted" as const };
      if (accepted.sealed) return { refused: "sealed" as const };
      const { grant } = accepted;
      const priced = grant.productiveMicros !== null;
      const rows = rowsIn(db, grantId).filter((row) => row.state !== "unsent");
      let boundMicros: number | null = null;
      if (operation.kind === "model-request") {
        const shape = operation.part === "productive" ? grant.productive : grant.finalisation;
        const models = grant.models ?? grant.rates.map((rate) => rate.model);
        if (operation.model === null || !models.some((model) => model.toLowerCase() === operation.model!.toLowerCase())) return { refused: "model" as const };
        if (operation.outputTokens === null || !Number.isSafeInteger(operation.outputTokens) || operation.outputTokens < 1 || operation.outputTokens > shape.outputTokens) return { refused: "output" as const };
        if (rows.filter((row) => row.kind === "model-request" && row.part === operation.part).length + 1 > shape.requests) return { refused: "requests" as const };
        const rate = rateOf(grant, operation.model);
        const bound = rate && operation.outputTokens !== null ? requestBound(rate, operation.outputTokens) : null;
        if (priced) {
          if (!bound) return { refused: "unbounded" as const };
          const limit = operation.part === "productive" ? grant.productiveMicros! : grant.finalisationMicros!;
          const held = rows.filter((row) => row.part === operation.part).reduce((sum, row) => sum + heldMicros(row), 0);
          if (held + bound.micros > limit) return { refused: "money" as const };
          boundMicros = bound.micros;
        }
      } else if (operation.kind === "model-listing") {
        if (rows.filter((row) => row.kind === "model-listing").length >= (grant.modelListings ?? 1)) return { refused: "requests" as const };
        if ((grant.models ?? grant.rates.map((rate) => rate.model)).length === 0) return { refused: "model" as const };
      } else if (!MODEL_KINDS.includes(operation.kind)) {
        const allowed = grant.allowances;
        const sandbox = operation.kind === "sandbox-operation" || operation.kind === "sandbox-transfer";
        const units = (kinds: readonly string[]) => rows.filter((row) => kinds.includes(row.kind)).reduce((sum, row) => sum + (row.units ?? row.boundUnits ?? 0), 0);
        if (sandbox && rows.filter((row) => row.kind === "sandbox-operation" || row.kind === "sandbox-transfer").length + 1 > allowed.sandboxOperations) return { refused: "counted" as const };
        if (operation.kind === "sandbox-operation" && units(["sandbox-operation"]) + (operation.boundUnits ?? 0) > allowed.sandboxSeconds) return { refused: "counted" as const };
        if (!sandbox && units(["research-search", "research-extract"]) + (operation.boundUnits ?? 0) > allowed.researchCredits) return { refused: "counted" as const };
      }
      const id = randomUUID();
      const seq = rowsIn(db, grantId).length + 1;
      db.prepare(
        `INSERT INTO budget_journal (id, grant_id, seq, kind, part, model, seat, instructions_sha256, state, bound_micros, bound_units, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      ).run(id, grantId, seq, operation.kind, operation.part, operation.model, operation.seat, operation.instructionsSha256, boundMicros, operation.boundUnits, this.#now().toISOString());
      return { id, seq };
    });
  }

  /** The transport took the operation: it may have been sent, so it can no longer close as unsent. */
  sent(operationId: string): void {
    const changed = this.#database.open().prepare("UPDATE budget_journal SET state = 'sent' WHERE id = ? AND state = 'reserved'").run(operationId);
    if (Number(changed.changes) !== 1) throw new Error("Only an operation still reserved can be marked sent.");
  }

  /**
   * Closes an operation, once. Unsent only while it was still reserved. A model's answer is priced from its usage at
   * the grant's price for its model: reported, or partial when cached input wasn't reported, and unknown when input or
   * output wasn't; an unpriced grant's rows carry no amount. No usage closes it unknown, at its bound. A counted service
   * closes with the units it reported, or unknown without them.
   */
  close(operationId: string, outcome: OperationOutcome): BudgetOperation["state"] {
    return this.#database.tx((db) => {
      const row = db.prepare("SELECT * FROM budget_journal WHERE id = ?").get(operationId);
      if (!row || !OPEN.includes(str(row["state"]))) throw new Error("Only an open operation can be closed, and only once.");
      const operation = rowOf(row);
      const accepted = acceptedIn(db, operation.grantId)!;
      const priced = accepted.grant.productiveMicros !== null;
      let state: BudgetOperation["state"];
      let amount: number | null = null;
      let usage: ModelUsage | null = null;
      let units: number | null = null;
      if (outcome.kind === "unsent") {
        if (operation.state !== "reserved") throw new Error("An operation the transport took can't close as unsent.");
        state = "unsent";
      } else if (outcome.kind === "answered") {
        usage = outcome.usage;
        const rate = rateOf(accepted.grant, operation.model);
        const cost = rate ? priceUsage(rate, outcome.usage) : null;
        state = cost ? cost.certainty : "unknown";
        amount = priced ? (cost ? cost.micros : operation.boundMicros) : null;
      } else if (outcome.kind === "no-usage") {
        state = "unknown";
        amount = priced ? operation.boundMicros : null;
      } else {
        units = outcome.units;
        state = outcome.units === null ? "unknown" : "reported";
      }
      db.prepare("UPDATE budget_journal SET state = ?, usage_json = ?, units = ?, amount_micros = ?, closed_at = ? WHERE id = ?").run(
        state,
        usage === null ? null : JSON.stringify(usage),
        units,
        amount,
        this.#now().toISOString(),
        operationId,
      );
      return state;
    });
  }

  /**
   * Seals a grant's journal, once. Complete only by the instance that accepted the grant, at the normal end of its
   * work, with every row closed. Interrupted closes every row still open as unknown, at its bound, then seals: rows lost
   * with a restored store can't be known, so it never claims completeness. Sealing again with the same kind returns the
   * seal as it was; with another, it is refused.
   */
  seal(grantId: string, kind: JournalSeal["kind"]): JournalSeal {
    return this.#database.tx((db) => {
      const accepted = acceptedIn(db, grantId);
      if (!accepted) throw new Error("There is no accepted grant to seal.");
      const kept = sealIn(db, grantId);
      if (kept) {
        if (kept.kind !== kind) throw new Error(`This grant's journal was already sealed ${kept.kind}.`);
        return kept;
      }
      const at = this.#now().toISOString();
      if (kind === "complete") {
        if (accepted.instanceId !== this.#instanceId) throw new Error("Only the engine instance that accepted a grant can seal its journal complete.");
        if (rowsIn(db, grantId).some((row) => OPEN.includes(row.state))) throw new Error("A journal is sealed complete only with every operation closed.");
      } else {
        const priced = accepted.grant.productiveMicros !== null;
        for (const row of rowsIn(db, grantId).filter((one) => OPEN.includes(one.state))) {
          db.prepare("UPDATE budget_journal SET state = 'unknown', amount_micros = ?, closed_at = ? WHERE id = ?").run(priced ? row.boundMicros : null, at, row.id);
        }
      }
      const rows = rowsIn(db, grantId).length;
      db.prepare("INSERT INTO budget_seals (grant_id, kind, rows, instance_id, sealed_at) VALUES (?, ?, ?, ?, ?)").run(grantId, kind, rows, this.#instanceId, at);
      return sealIn(db, grantId)!;
    });
  }

  /**
   * A run's terminal transition and its grant's seal, in one transaction: `transition` runs first, and when it moved the
   * run, the journal is sealed complete if this instance accepted the grant and every row is closed, and interrupted
   * otherwise, so a row left open never claims completeness and never stops a run from ending.
   */
  endWith(grantId: string, transition: () => boolean): boolean {
    return this.#database.tx((db) => {
      const moved = transition();
      if (!moved) return false;
      const accepted = acceptedIn(db, grantId);
      if (!accepted || sealIn(db, grantId)) return true;
      const whole = accepted.instanceId === this.#instanceId && !rowsIn(db, grantId).some((row) => OPEN.includes(row.state));
      this.seal(grantId, whole ? "complete" : "interrupted");
      return true;
    });
  }

  /**
   * At start: every grant another instance accepted and never sealed is sealed interrupted by this one, its open rows
   * closed as unknown. Its work can't have ended normally, so it is never sealed complete.
   */
  interruptOthers(): string[] {
    const ids = this.#database
      .open()
      .prepare("SELECT grant_id FROM budget_accepted WHERE instance_id IS NOT ? AND grant_id NOT IN (SELECT grant_id FROM budget_seals) ORDER BY accepted_at, rowid")
      .all(this.#instanceId)
      .map((row) => str(row["grant_id"]));
    for (const id of ids) this.seal(id, "interrupted");
    return ids;
  }

  /** One grant's journal, a page of rows by sequence after `after`, with its seal when it has one. */
  read(grantId: string, after = 0, limit = 200): { accepted: boolean; rows: BudgetOperation[]; seal: JournalSeal | null; next: number | null } {
    const db = this.#database.open();
    if (!acceptedIn(db, grantId)) return { accepted: false, rows: [], seal: null, next: null };
    const page = db.prepare("SELECT * FROM budget_journal WHERE grant_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(grantId, after, limit + 1).map(rowOf);
    const more = page.length > limit;
    const rows = page.slice(0, limit).map(operationOf);
    return { accepted: true, rows, seal: sealIn(db, grantId), next: more ? rows[rows.length - 1]!.seq : null };
  }

  /**
   * Records the Date of the model listing's response that a grant's work received, once: the provider's clock, which the
   * host may take as a new month's evidence. A later one changes nothing.
   */
  providerTime(grantId: string, date: string): void {
    this.#database.open().prepare("UPDATE budget_accepted SET provider_date = ? WHERE grant_id = ? AND provider_date IS NULL").run(date, grantId);
  }

  /** The Date of the provider's response that a grant's work received, when one came. */
  providerDate(grantId: string): string | null {
    const row = this.#database.open().prepare("SELECT provider_date FROM budget_accepted WHERE grant_id = ?").get(grantId);
    return row ? strOrNull(row["provider_date"]) : null;
  }
}

/** Keeps each write of the journal durable when it returns, so a row written before a send survives a stop. */
export function ensureJournalDurable(db: DatabaseSync): void {
  if (num(db.prepare("PRAGMA synchronous").get()?.["synchronous"] ?? 0) < 2) db.exec("PRAGMA synchronous = FULL");
}

interface JournalRow {
  id: string;
  grantId: string;
  seq: number;
  kind: OperationKind;
  part: OperationPart;
  model: string | null;
  seat: string | null;
  instructionsSha256: string | null;
  state: BudgetOperation["state"];
  boundMicros: number | null;
  boundUnits: number | null;
  usage: ModelUsage | null;
  units: number | null;
  amountMicros: number | null;
}

const nullableNum = (value: Row[string]) => (value === null || value === undefined ? null : num(value));

const rowOf = (row: Row): JournalRow => ({
  id: str(row["id"]),
  grantId: str(row["grant_id"]),
  seq: num(row["seq"]),
  kind: str(row["kind"]) as OperationKind,
  part: str(row["part"]) as OperationPart,
  model: strOrNull(row["model"]),
  seat: strOrNull(row["seat"]),
  instructionsSha256: strOrNull(row["instructions_sha256"]),
  state: str(row["state"]) as BudgetOperation["state"],
  boundMicros: nullableNum(row["bound_micros"]),
  boundUnits: nullableNum(row["bound_units"]),
  usage: row["usage_json"] === null ? null : (JSON.parse(str(row["usage_json"])) as ModelUsage),
  units: nullableNum(row["units"]),
  amountMicros: nullableNum(row["amount_micros"]),
});

/** A row as the host reads it: the domain's operation record. */
const operationOf = (row: JournalRow): BudgetOperation => ({
  id: row.id,
  grantId: row.grantId,
  seq: row.seq,
  kind: row.kind,
  model: row.model,
  seat: row.seat,
  instructionsSha256: row.instructionsSha256,
  state: row.state,
  boundMicros: row.boundMicros,
  usage: row.usage,
  units: row.units,
  amountMicros: row.amountMicros,
});

/** What a row holds of its part's money: its amount once known, its bound until then. */
const heldMicros = (row: JournalRow) => (row.state === "reported" || row.state === "partial" ? (row.amountMicros ?? 0) : (row.boundMicros ?? 0));

function acceptedIn(db: DatabaseSync, grantId: string): AcceptedGrant | null {
  const row = db.prepare("SELECT grant_json, instance_id, EXISTS (SELECT 1 FROM budget_seals WHERE grant_id = ?1) AS sealed FROM budget_accepted WHERE grant_id = ?1").get(grantId);
  return row ? { grant: JSON.parse(str(row["grant_json"])) as BudgetGrant, instanceId: str(row["instance_id"]), sealed: num(row["sealed"]) === 1 } : null;
}

function rowsIn(db: DatabaseSync, grantId: string): JournalRow[] {
  return db.prepare("SELECT * FROM budget_journal WHERE grant_id = ? ORDER BY seq").all(grantId).map(rowOf);
}

function sealIn(db: DatabaseSync, grantId: string): JournalSeal | null {
  const row = db.prepare("SELECT * FROM budget_seals WHERE grant_id = ?").get(grantId);
  return row ? { grantId: str(row["grant_id"]), kind: str(row["kind"]) as JournalSeal["kind"], rows: num(row["rows"]), instanceId: str(row["instance_id"]), sealedAt: str(row["sealed_at"]) } : null;
}

/** The grant's price for a model, matched without regard to case, as the host's ledger matches it. */
function rateOf(grant: BudgetGrant, model: string | null): ModelRate | null {
  if (model === null) return null;
  return grant.rates.find((rate) => rate.model.toLowerCase() === model.toLowerCase()) ?? null;
}
