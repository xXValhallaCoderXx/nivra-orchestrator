import { type Database, type Row, str } from "../db/database.ts";
import { ApplyRefusal, type ApplyRefusalCode } from "./plan.ts";
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
  /** Why it was refused, by code, and the proposal's path the refusal names. */
  refusal: { code: ApplyRefusalCode; path: string | null } | null;
  intent: ApplyIntent | null;
  /** The folders the apply created, in order. */
  created: string[];
  result: ApplyResult | null;
  resolution: "accepted" | "dismissed" | "kept" | null;
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
      const at = this.#now().toISOString();
      const insert = (state: "claimed" | "refused", refusal: ApplyRefusal | null) =>
        db
          .prepare("INSERT INTO applies (id, request_id, run_id, proposal_hash, destination, state, refusal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(input.applyId, input.requestId, input.runId, input.proposalHash, input.destination, state, refusal && JSON.stringify({ code: refusal.code, path: refusal.path }), at, at);
      // A refused claim is kept too, under its request id: a repeat gets the same answer, and nothing more.
      if (db.prepare("SELECT 1 FROM applies WHERE run_id = ? AND state = 'applied'").get(input.runId)) insert("refused", new ApplyRefusal("duplicate"));
      else {
        try {
          insert("claimed", null);
        } catch (error) {
          if (!openElsewhere(error)) throw error;
          insert("refused", new ApplyRefusal("busy"));
        }
      }
      return { record: recordOf(db.prepare("SELECT * FROM applies WHERE id = ?").get(input.applyId)!), repeated: false };
    });
  }

  /** A claim refused before anything was written: the folder is free again. */
  refuse(applyId: string, refusal: ApplyRefusal): void {
    this.#database
      .open()
      .prepare("UPDATE applies SET state = 'refused', refusal = ?, updated_at = ? WHERE id = ? AND state = 'claimed'")
      .run(JSON.stringify({ code: refusal.code, path: refusal.path }), this.#now().toISOString(), applyId);
  }

  settled(applyId: string): boolean {
    const row = this.#database.open().prepare("SELECT state, resolution FROM applies WHERE id = ?").get(applyId);
    return !row || ["refused", "applied", "not-applied"].includes(str(row["state"])) || row["resolution"] !== null;
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
      .prepare("UPDATE applies SET state = ?, result = ?, updated_at = ? WHERE id = ? AND state IN ('writing', 'partial', 'unknown') AND resolution IS NULL")
      .run(result.state, JSON.stringify(result), this.#now().toISOString(), applyId);
    if (Number(changed.changes) !== 1) throw new Error("Only an apply that has started writing, and isn't settled by the person, can be given a result.");
  }

  /** How the person settled an apply: it is over, and its folder free for the next one. */
  resolve(applyId: string, resolution: "accepted" | "dismissed" | "kept"): void {
    const changed = this.#database
      .open()
      .prepare("UPDATE applies SET resolution = ?, updated_at = ? WHERE id = ? AND state IN ('refused', 'applied', 'not-applied', 'partial', 'unknown') AND resolution IS NULL")
      .run(resolution, this.#now().toISOString(), applyId);
    if (Number(changed.changes) !== 1) throw new Error("Only an apply that has ended, and isn't settled yet, can be settled.");
  }

  /** A claim whose engine stopped before it recorded an intent: nothing of the person's was written. */
  interrupted(): ApplyRecord[] {
    return this.#database.open().prepare("SELECT * FROM applies WHERE state = 'claimed' ORDER BY created_at").all().map(recordOf);
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
    refusal: json<ApplyRecord["refusal"]>(row["refusal"]),
    intent: json<ApplyIntent>(row["intent"]),
    created: json<string[]>(row["created_folders"]) ?? [],
    result: json<ApplyResult>(row["result"]),
    resolution: (row["resolution"] ?? null) as ApplyRecord["resolution"],
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}
