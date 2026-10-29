/**
 * The budget journal's tables (NIV-66), kept apart from budget/journal.ts so the engine's migrations can take them
 * without importing the journal, which imports the database.
 */

/** Added to the engine's migrations as one version (its number comes from main when it merges). */
export const BUDGET_JOURNAL_SCHEMA = `
  CREATE TABLE budget_accepted (
    grant_id TEXT PRIMARY KEY,
    run_id TEXT UNIQUE,
    request_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    grant_json TEXT NOT NULL,
    provider_date TEXT,
    accepted_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER budget_accepted_kept BEFORE UPDATE ON budget_accepted
  WHEN NEW.grant_id IS NOT OLD.grant_id OR NEW.run_id IS NOT OLD.run_id OR NEW.request_id IS NOT OLD.request_id OR NEW.instance_id IS NOT OLD.instance_id
    OR NEW.grant_json IS NOT OLD.grant_json OR NEW.accepted_at IS NOT OLD.accepted_at OR OLD.provider_date IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'an accepted grant is kept as it was accepted, and its provider time is recorded once'); END;
  CREATE TRIGGER budget_accepted_not_removed BEFORE DELETE ON budget_accepted BEGIN SELECT RAISE(ABORT, 'accepted grants are kept'); END;

  CREATE TABLE budget_journal (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES budget_accepted(grant_id),
    seq INTEGER NOT NULL CHECK (seq >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('model-request', 'model-listing', 'research-search', 'research-extract', 'sandbox-operation', 'sandbox-transfer')),
    part TEXT NOT NULL CHECK (part IN ('productive', 'finalisation')),
    model TEXT,
    seat TEXT,
    instructions_sha256 TEXT,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'unsent', 'sent', 'reported', 'partial', 'unknown')),
    bound_micros INTEGER CHECK (bound_micros >= 0),
    bound_units INTEGER CHECK (bound_units >= 0),
    usage_json TEXT,
    units INTEGER CHECK (units >= 0),
    amount_micros INTEGER CHECK (amount_micros >= 0),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (grant_id, seq),
    CHECK ((state IN ('reserved', 'sent')) = (closed_at IS NULL))
  ) STRICT;
  CREATE TRIGGER budget_journal_opened BEFORE INSERT ON budget_journal
  WHEN NEW.state IS NOT 'reserved' OR NEW.closed_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM budget_seals WHERE grant_id = NEW.grant_id)
    OR NEW.seq IS NOT (SELECT coalesce(max(seq), 0) + 1 FROM budget_journal WHERE grant_id = NEW.grant_id)
  BEGIN SELECT RAISE(ABORT, 'an operation is written as reserved, next in its grant''s unsealed journal'); END;
  CREATE TRIGGER budget_journal_moves BEFORE UPDATE ON budget_journal
  WHEN NEW.id IS NOT OLD.id OR NEW.grant_id IS NOT OLD.grant_id OR NEW.seq IS NOT OLD.seq OR NEW.kind IS NOT OLD.kind OR NEW.part IS NOT OLD.part
    OR NEW.model IS NOT OLD.model OR NEW.seat IS NOT OLD.seat OR NEW.instructions_sha256 IS NOT OLD.instructions_sha256
    OR NEW.bound_micros IS NOT OLD.bound_micros OR NEW.bound_units IS NOT OLD.bound_units OR NEW.opened_at IS NOT OLD.opened_at
    OR EXISTS (SELECT 1 FROM budget_seals WHERE grant_id = OLD.grant_id)
    OR NOT ((OLD.state = 'reserved' AND NEW.state IN ('unsent', 'sent', 'reported', 'partial', 'unknown'))
      OR (OLD.state = 'sent' AND NEW.state IN ('reported', 'partial', 'unknown')))
  BEGIN SELECT RAISE(ABORT, 'an operation keeps what it was opened with, and is closed once, before its grant is sealed'); END;
  CREATE TRIGGER budget_journal_not_removed BEFORE DELETE ON budget_journal BEGIN SELECT RAISE(ABORT, 'journalled operations are kept'); END;

  CREATE TABLE budget_seals (
    grant_id TEXT PRIMARY KEY REFERENCES budget_accepted(grant_id),
    kind TEXT NOT NULL CHECK (kind IN ('complete', 'interrupted')),
    rows INTEGER NOT NULL CHECK (rows >= 0),
    instance_id TEXT NOT NULL,
    sealed_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER budget_seals_whole BEFORE INSERT ON budget_seals
  WHEN EXISTS (SELECT 1 FROM budget_journal WHERE grant_id = NEW.grant_id AND state IN ('reserved', 'sent'))
    OR NEW.rows IS NOT (SELECT count(*) FROM budget_journal WHERE grant_id = NEW.grant_id)
    OR (NEW.kind = 'complete' AND NEW.instance_id IS NOT (SELECT instance_id FROM budget_accepted WHERE grant_id = NEW.grant_id))
  BEGIN SELECT RAISE(ABORT, 'a journal is sealed with every row closed, and complete only by the instance that accepted its grant'); END;
  CREATE TRIGGER budget_seals_kept BEFORE UPDATE ON budget_seals BEGIN SELECT RAISE(ABORT, 'a seal is kept as it was written'); END;
  CREATE TRIGGER budget_seals_not_removed BEFORE DELETE ON budget_seals BEGIN SELECT RAISE(ABORT, 'seals are kept'); END;
`;
