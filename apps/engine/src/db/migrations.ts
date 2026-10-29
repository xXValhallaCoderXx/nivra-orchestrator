import { BUDGET_JOURNAL_SCHEMA } from "../budget/schema.ts";

/**
 * Schema versions of `<home>/nivra.db`, applied in order and tracked with `PRAGMA user_version`. Only ever append,
 * and keep each one additive: never edit a version that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  // v1: runs and their append-only events.
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     workflow_id TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     input TEXT NOT NULL,
     error TEXT,
     client_request_id TEXT UNIQUE,
     instance_id TEXT,
     created_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT
   );
   CREATE INDEX runs_status ON runs (status);
   CREATE TABLE run_events (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     step_id TEXT,
     message TEXT NOT NULL,
     data TEXT,
     PRIMARY KEY (run_id, seq)
   );`,
  // v2 (D22): what a run cost and where its model requests went, and stored results (an explanation).
  `ALTER TABLE runs ADD COLUMN duration_ms INTEGER;
   ALTER TABLE runs ADD COLUMN usage TEXT;
   ALTER TABLE runs ADD COLUMN route TEXT;
   CREATE TABLE artifacts (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     content TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (run_id, kind)
   );`,
  // v3 (D26): facts about the home's store. The engine sets `home_id` once, a random id the host records with each
  // conversation turn, so it can tell this store from another at the same path. As a newer schema, it also makes an
  // older engine refuse a home that holds chat runs.
  `CREATE TABLE meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // v4 (D39): a task run's proposal, exactly as it was bound: the binding, and the patch, report and post-image bytes,
  // never masked, since their digests are what the person approves. A change holding a value the vault keeps is refused
  // before it is kept. A proposal is written once and never changed.
  `CREATE TABLE proposals (
     run_id TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
     hash TEXT NOT NULL,
     binding TEXT NOT NULL,
     patch BLOB NOT NULL,
     report BLOB NOT NULL,
     post_image BLOB NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TRIGGER proposals_kept BEFORE UPDATE ON proposals BEGIN SELECT RAISE(ABORT, 'a proposal is kept as it was bound'); END;`,
  // v5 (D40): applying a proposal. A claim comes first, by the host's request id, so a repeated request finds its
  // apply, a refused one included; then the intent, written before anything of the person's is touched; then the
  // result, and how the person settled it. One apply is open for a folder at a time, a partial or unknown one included
  // until the person settles it, and a proposal is applied once. Rows are never removed: they are how a crash is
  // reconciled.
  `CREATE TABLE applies (
     id TEXT PRIMARY KEY,
     request_id TEXT NOT NULL UNIQUE,
     run_id TEXT NOT NULL,
     proposal_hash TEXT NOT NULL,
     destination TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('claimed', 'refused', 'writing', 'applied', 'not-applied', 'partial', 'unknown')),
     refusal TEXT,
     intent TEXT,
     created_folders TEXT NOT NULL DEFAULT '[]',
     result TEXT,
     resolution TEXT CHECK (resolution IN ('accepted', 'dismissed', 'kept')),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX applies_open ON applies (destination) WHERE state IN ('claimed', 'writing') OR (state IN ('partial', 'unknown') AND resolution IS NULL);
   CREATE UNIQUE INDEX applies_applied ON applies (run_id) WHERE state = 'applied';`,
  // v6 (NIV-66): the journal of paid operations under the host's grants: each grant accepted, each operation written at
  // its send point and closed on every path, and each journal sealed, complete or interrupted (budget/journal.ts).
  BUDGET_JOURNAL_SCHEMA,
];
