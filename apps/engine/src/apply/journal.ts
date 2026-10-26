import { type Database, type Row, str } from "../db/database.ts";
import { ApplyRefusal } from "./plan.ts";
import type { ApplyIntent, ApplyJournalPort, ApplyResult, ApplyState } from "./writer.ts";

/** Where an apply is: claimed while it is revalidated, refused, writing once its intent is kept, then its result. */
export type ApplyRecordState = "claimed" | "refused" | "writing" | ApplyState;

export interface ApplyRecord {
  id: string;
  requestId: string;
  runId: string;
  proposalHash: string;
  /** The repository's top level: one apply is open there at a time. */
  destination: string;
  state: ApplyRecordState;
  intent: ApplyIntent | null;
  /** The folders the apply created, in order. */
  created: string[];
  result: ApplyResult | null;
  createdAt: string;
  updatedAt: string;
}

/** SQLite names the columns of the index a row broke, not the index: `applies_open` is the one on the destination. */
const openElsewhere = (error: unknown) => String((error as Error | null)?.message ?? "").includes("UNIQUE constraint failed: applies.destination");

/**
 * The engine's record of each apply (D40), in its own database (migration 5). The intent is written with SQLite's
 * synchronous mode FULL, so it is on disk before the writer touches anything of the person's.
 */
export class ApplyJournal implements ApplyJournalPort {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * Claims a folder for one apply, by the host's request id: a repeated request gets the apply it started. A folder
   * with an apply open (a partial or unknown one included) is refused as busy, and a proposal already applied as a
   * duplicate.
   */
  claim(input: { applyId: string; requestId: string; runId: string; proposalHash: string; destination: string }): { record: ApplyRecord; repeated: boolean } {
    return this.#database.tx((db) => {
      const existing = db.prepare("SELECT * FROM applies WHERE request_id = ?").get(input.requestId);
      if (existing) return { record: recordOf(existing), repeated: true };
      if (db.prepare("SELECT 1 FROM applies WHERE run_id = ? AND state = 'applied'").get(input.runId)) throw new ApplyRefusal("duplicate");
      const at = this.#now().toISOString();
      try {
        db.prepare("INSERT INTO applies (id, request_id, run_id, proposal_hash, destination, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?)").run(input.applyId, input.requestId, input.runId, input.proposalHash, input.destination, at, at);
      } catch (error) {
        if (openElsewhere(error)) throw new ApplyRefusal("busy");
        throw error;
      }
      return { record: recordOf(db.prepare("SELECT * FROM applies WHERE id = ?").get(input.applyId)!), repeated: false };
    });
  }

  /** A claim refused before anything was written: the folder is free again. */
  refuse(applyId: string): void {
    this.#update(applyId, "UPDATE applies SET state = 'refused', updated_at = ? WHERE id = ? AND state = 'claimed'");
  }

  settled(applyId: string): boolean {
    const row = this.#database.open().prepare("SELECT state FROM applies WHERE id = ?").get(applyId);
    return !row || ["refused", "applied", "not-applied"].includes(str(row["state"]));
  }

  intend(applyId: string, intent: ApplyIntent): void {
    const db = this.#database.open();
    db.exec("PRAGMA synchronous = FULL");
    const changed = db.prepare("UPDATE applies SET state = 'writing', intent = ?, updated_at = ? WHERE id = ? AND state = 'claimed'").run(JSON.stringify(intent), this.#now().toISOString(), applyId);
    if (Number(changed.changes) !== 1) throw new Error("An apply's intent can be recorded only once, for an apply that is claimed.");
  }

  created(applyId: string, folder: string): void {
    this.#database.tx((db) => {
      const row = db.prepare("SELECT created_folders FROM applies WHERE id = ?").get(applyId);
      const folders = row ? (JSON.parse(str(row["created_folders"])) as string[]) : [];
      db.prepare("UPDATE applies SET created_folders = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...folders, folder]), this.#now().toISOString(), applyId);
    });
  }

  settle(applyId: string, result: ApplyResult): void {
    const changed = this.#database
      .open()
      .prepare("UPDATE applies SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN ('writing', 'partial', 'unknown')")
      .run(result.state, JSON.stringify(result), this.#now().toISOString(), applyId);
    if (Number(changed.changes) !== 1) throw new Error("Only an apply that has started writing can be settled.");
  }

  get(applyId: string): ApplyRecord | null {
    const row = this.#database.open().prepare("SELECT * FROM applies WHERE id = ?").get(applyId);
    return row ? recordOf(row) : null;
  }

  byRequest(requestId: string): ApplyRecord | null {
    const row = this.#database.open().prepare("SELECT * FROM applies WHERE request_id = ?").get(requestId);
    return row ? recordOf(row) : null;
  }

  /** Applies that were writing when their engine stopped: what reconciling at start looks at. */
  writing(): ApplyRecord[] {
    return this.#database.open().prepare("SELECT * FROM applies WHERE state = 'writing' ORDER BY created_at").all().map(recordOf);
  }

  #update(applyId: string, sql: string): void {
    this.#database.open().prepare(sql).run(this.#now().toISOString(), applyId);
  }
}

function recordOf(row: Row): ApplyRecord {
  const json = <T>(value: Row[string]): T | null => (value === null || value === undefined ? null : (JSON.parse(String(value)) as T));
  return {
    id: str(row["id"]),
    requestId: str(row["request_id"]),
    runId: str(row["run_id"]),
    proposalHash: str(row["proposal_hash"]),
    destination: str(row["destination"]),
    state: str(row["state"]) as ApplyRecordState,
    intent: json<ApplyIntent>(row["intent"]),
    created: json<string[]>(row["created_folders"]) ?? [],
    result: json<ApplyResult>(row["result"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}
