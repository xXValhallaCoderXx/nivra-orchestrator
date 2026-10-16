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
];
