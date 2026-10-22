import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { renameRetrying } from "./host-store.ts";

/**
 * The host's workspace (D26): conversations, their messages and turns, native tasks, the versions of plans and briefs,
 * the reviews of plan versions (D31) and research of their assumptions (D37), in one SQLite file beside `nivra.json`.
 * The host is its only owner and opens it only on its own OS (D7); the engines keep their own run records. Built on
 * Node's own `node:sqlite`, so Electron's main process loads no addon (D6). Opened like an engine's database: WAL,
 * SQLite's exclusive lock taken at once and held until close (so a second Nivra on the same profile is refused instead
 * of waiting), foreign keys enforced, and deleted rows overwritten.
 *
 * Opening never throws. A file that can't be used is reported as state, so everything that doesn't need the workspace
 * keeps working, and only a damaged file is ever moved: kept aside with its journal files, never deleted. A file that
 * isn't a SQLite database at all is recognised by its header before SQLite opens it, because SQLite removes a stray WAL
 * file when it closes such a connection. For the same reason a database that a session left a journal beside (it
 * didn't close cleanly) is read first through a read-only connection, which can't fold the journal in or remove it, so a
 * damaged one is kept aside as it was found. A schema written by a newer Nivra is refused before anything is changed.
 */

export type Row = Record<string, SQLOutputValue>;
export const str = (value: SQLOutputValue | undefined): string => String(value);
export const strOrNull = (value: SQLOutputValue | undefined): string | null => (value === null || value === undefined ? null : String(value));
export const num = (value: SQLOutputValue | undefined): number => Number(value);

/** The schema, one entry per version. Append only: a released version is never edited. */
export const WORKSPACE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('general', 'project')),
    project_id TEXT,
    project_label TEXT,
    target_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((kind = 'general') = (project_id IS NULL))
  ) STRICT;
  CREATE INDEX conversations_updated ON conversations(updated_at);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'active', 'review', 'completed')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- Plans belong to the conversation they came from, briefs to their task. A row is never changed: an edit is a new
  -- version in the same lineage.
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('plan', 'brief')),
    lineage_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    content_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    message_id TEXT,
    run_link_id TEXT,
    derived_from TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (lineage_id, version),
    CHECK ((kind = 'plan') = (conversation_id IS NOT NULL)),
    CHECK ((kind = 'brief') = (task_id IS NOT NULL))
  ) STRICT;
  CREATE TRIGGER artifacts_immutable BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifact versions are immutable'); END;

  -- One attempt at a run: a conversation's turn now, a task's attempt later. Its id is the clientRequestId, saved before
  -- runs.start is sent, so a send whose answer was lost can be found again on its own engine.
  CREATE TABLE run_links (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    brief_id TEXT REFERENCES artifacts(id),
    session_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    home_id TEXT,
    run_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('submitting', 'running', 'answered', 'failed', 'cancelled', 'interrupted', 'not-sent', 'unknown')),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    cancel_reason TEXT CHECK (cancel_reason IN ('person', 'sharing', 'removal', 'deletion')),
    error_kind TEXT,
    error_message TEXT,
    preferences_json TEXT NOT NULL,
    history_json TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    CHECK ((conversation_id IS NULL) <> (task_id IS NULL)),
    CHECK ((task_id IS NULL) = (brief_id IS NULL))
  ) STRICT;
  CREATE INDEX run_links_open ON run_links(status) WHERE status IN ('submitting', 'running');

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('person', 'assistant')),
    text TEXT NOT NULL,
    reply_json TEXT,
    run_link_id TEXT REFERENCES run_links(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, seq)
  ) STRICT;
  -- A turn has one question and at most one answer, so projecting an answer twice still leaves one.
  CREATE UNIQUE INDEX messages_one_per_turn ON messages(run_link_id, role) WHERE run_link_id IS NOT NULL;
  `,
  `
  -- A review of one saved plan version (D31): a run link with workflow 'review', and what it was bound to when it was
  -- asked for. The plan is referenced, never copied (its versions are immutable), and the packet's text isn't kept: its
  -- fingerprint is. The engine's report, masked again, is kept once, when the review ends.
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY REFERENCES run_links(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    plan_lineage TEXT NOT NULL,
    plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
    plan_sha256 TEXT NOT NULL,
    panel TEXT NOT NULL CHECK (panel IN ('council', 'single')),
    packet_digest TEXT NOT NULL,
    preferences_digest TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('general', 'project')),
    project_id TEXT,
    project_label TEXT,
    head_at_start TEXT,
    report_json TEXT,
    reported_at TEXT,
    created_at TEXT NOT NULL,
    CHECK ((scope_kind = 'general') = (project_id IS NULL)),
    CHECK ((report_json IS NULL) = (reported_at IS NULL))
  ) STRICT;
  CREATE INDEX reviews_conversation ON reviews(conversation_id, created_at);
  CREATE TRIGGER reviews_bound BEFORE INSERT ON reviews
  WHEN NOT EXISTS (SELECT 1 FROM run_links WHERE id = NEW.id AND workflow_id = 'review' AND conversation_id = NEW.conversation_id)
    OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.plan_id AND kind = 'plan' AND conversation_id = NEW.conversation_id AND lineage_id = NEW.plan_lineage AND version = NEW.plan_version AND sha256 = NEW.plan_sha256
    )
  BEGIN SELECT RAISE(ABORT, 'a review is bound to a review run and to a plan version of its own conversation'); END;
  CREATE TRIGGER reviews_frozen BEFORE UPDATE ON reviews
  WHEN NEW.id IS NOT OLD.id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_lineage IS NOT OLD.plan_lineage
    OR NEW.plan_version IS NOT OLD.plan_version OR NEW.plan_sha256 IS NOT OLD.plan_sha256 OR NEW.panel IS NOT OLD.panel OR NEW.packet_digest IS NOT OLD.packet_digest
    OR NEW.preferences_digest IS NOT OLD.preferences_digest OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.project_id IS NOT OLD.project_id
    OR NEW.project_label IS NOT OLD.project_label OR NEW.head_at_start IS NOT OLD.head_at_start OR NEW.created_at IS NOT OLD.created_at
    OR OLD.report_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a review never changes what it was bound to, and keeps its first report'); END;
  -- A run link's workflow and owner are set once: a turn never becomes a review, or moves to another conversation.
  CREATE TRIGGER run_links_fixed BEFORE UPDATE OF workflow_id, conversation_id, task_id, brief_id ON run_links
  WHEN NEW.workflow_id IS NOT OLD.workflow_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.task_id IS NOT OLD.task_id OR NEW.brief_id IS NOT OLD.brief_id
  BEGIN SELECT RAISE(ABORT, 'a run link keeps its workflow and its owner'); END;
  `,
  `
  -- Research of one saved plan version's assumptions (NIV-45): a run link with workflow 'research', and what it was
  -- bound to. A stop's cause and token, the report and the amended plan are the only things that change afterwards.
  CREATE TABLE research (
    id TEXT PRIMARY KEY REFERENCES run_links(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    plan_lineage TEXT NOT NULL,
    plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
    plan_sha256 TEXT NOT NULL,
    packet_digest TEXT NOT NULL,
    queries_json TEXT NOT NULL,
    sites_json TEXT,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('general', 'project')),
    project_id TEXT,
    project_label TEXT,
    head_at_start TEXT,
    stop_cause TEXT CHECK (stop_cause IN ('person', 'web-research', 'model-sharing', 'removal', 'deletion')),
    stop_token TEXT,
    amended_plan_id TEXT,
    report_json TEXT,
    reported_at TEXT,
    created_at TEXT NOT NULL,
    CHECK ((scope_kind = 'general') = (project_id IS NULL)),
    CHECK ((report_json IS NULL) = (reported_at IS NULL)),
    CHECK ((stop_cause IS NULL) = (stop_token IS NULL))
  ) STRICT;
  CREATE INDEX research_conversation ON research(conversation_id, created_at);
  CREATE TRIGGER research_bound BEFORE INSERT ON research
  WHEN NOT EXISTS (SELECT 1 FROM run_links WHERE id = NEW.id AND workflow_id = 'research' AND conversation_id = NEW.conversation_id)
    OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.plan_id AND kind = 'plan' AND conversation_id = NEW.conversation_id AND lineage_id = NEW.plan_lineage AND version = NEW.plan_version AND sha256 = NEW.plan_sha256
    )
    OR NEW.stop_cause IS NOT NULL OR NEW.amended_plan_id IS NOT NULL OR NEW.report_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'research is bound to a research run and to a plan version of its own conversation'); END;
  CREATE TRIGGER research_frozen BEFORE UPDATE ON research
  WHEN NEW.id IS NOT OLD.id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_lineage IS NOT OLD.plan_lineage
    OR NEW.plan_version IS NOT OLD.plan_version OR NEW.plan_sha256 IS NOT OLD.plan_sha256 OR NEW.packet_digest IS NOT OLD.packet_digest
    OR NEW.queries_json IS NOT OLD.queries_json OR NEW.sites_json IS NOT OLD.sites_json OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.project_id IS NOT OLD.project_id
    OR NEW.project_label IS NOT OLD.project_label OR NEW.head_at_start IS NOT OLD.head_at_start OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.report_json IS NOT NULL AND (NEW.report_json IS NOT OLD.report_json OR NEW.reported_at IS NOT OLD.reported_at))
    OR (OLD.amended_plan_id IS NOT NULL AND NEW.amended_plan_id IS NOT OLD.amended_plan_id)
    -- The amended plan comes from a report, and is a version of the researched plan derived from it.
    OR (OLD.amended_plan_id IS NULL AND NEW.amended_plan_id IS NOT NULL AND (NEW.report_json IS NULL OR NOT EXISTS (
      SELECT 1 FROM artifacts
      WHERE id = NEW.amended_plan_id AND kind = 'plan' AND conversation_id = OLD.conversation_id AND lineage_id = OLD.plan_lineage AND derived_from = OLD.plan_id
    )))
    -- A stop is asked for, or withdrawn, only while the run is open.
    OR ((NEW.stop_cause IS NOT OLD.stop_cause OR NEW.stop_token IS NOT OLD.stop_token)
      AND NOT EXISTS (SELECT 1 FROM run_links WHERE id = OLD.id AND status IN ('submitting', 'running')))
  BEGIN SELECT RAISE(ABORT, 'research never changes what it was bound to, keeps its first report and its amended plan, and changes its stop only while it runs'); END;
  `,
];

export type WorkspaceOpening =
  | { state: "ready"; db: WorkspaceDb; schemaVersion: number; sqlite: string; notice: string | null }
  | { state: "unavailable"; reason: string };

/** An open workspace. Transactions nest as savepoints, as the engine's database does. */
export class WorkspaceDb {
  readonly path: string;
  readonly #db: DatabaseSync;
  #depth = 0;
  #closed = false;

  constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  get db(): DatabaseSync {
    if (this.#closed) throw new Error("Nivra's history is closed.");
    return this.#db;
  }

  tx<T>(work: (db: DatabaseSync) => T): T {
    const db = this.db;
    const savepoint = `sp${this.#depth}`;
    db.exec(this.#depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const result = work(db);
      this.#depth--;
      db.exec(this.#depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#depth--;
      if (this.#depth === 0) {
        if (db.isTransaction) db.exec("ROLLBACK");
      } else {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    }
  }

  /** Writes the WAL back into the file and empties it, so deleted rows, already overwritten, leave no copy there. */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

/** A schema version this app doesn't know: a newer Nivra wrote it. */
class NewerSchema extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`schema v${version}`);
    this.version = version;
  }
}

type Problem = "corrupt" | "locked" | "access" | "disk" | "newer" | "other";

/**
 * What kind of failure an error is, from SQLite's primary result code (`node:sqlite` reports it in `errcode`) or the
 * file system's errno code, never from message text.
 */
export function classifyWorkspaceError(error: unknown): { problem: Problem; code: string } {
  if (error instanceof NewerSchema) return { problem: "newer", code: `schema v${error.version}` };
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    const code = `SQLite error ${errcode}`;
    if (primary === 11 || primary === 26) return { problem: "corrupt", code };
    if (primary === 5 || primary === 6) return { problem: "locked", code };
    if (primary === 3 || primary === 8 || primary === 14 || primary === 23) return { problem: "access", code };
    if (primary === 10 || primary === 13) return { problem: "disk", code };
    return { problem: "other", code };
  }
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string") {
    if (errno === "EACCES" || errno === "EPERM" || errno === "EROFS") return { problem: "access", code: errno };
    if (errno === "ENOSPC" || errno === "EIO" || errno === "EDQUOT") return { problem: "disk", code: errno };
    return { problem: "other", code: errno };
  }
  return { problem: "other", code: error instanceof Error ? error.name : "an unknown error" };
}

/** The files SQLite may keep beside a database. */
const COMPANIONS = ["", "-wal", "-shm", "-journal"] as const;
/** The journals a session leaves beside the database when it doesn't close cleanly; closing removes them. */
const JOURNALS = ["-wal", "-journal"] as const;
const SQLITE_HEADER = "SQLite format 3\0";

/**
 * What is wrong with the files at `path` before SQLite touches them, or null: a main file that isn't a SQLite database
 * (an empty one is a new database, unless a journal says it had content), or journal files with no database to belong
 * to.
 */
function damageBeforeOpening(path: string): string | null {
  if (!existsSync(path)) return COMPANIONS.some((suffix) => suffix && existsSync(`${path}${suffix}`)) ? "journal files without a database" : null;
  const fd = openSync(path, "r");
  try {
    if (fstatSync(fd).size === 0) return JOURNALS.some((suffix) => existsSync(`${path}${suffix}`)) ? "journal files without a database" : null;
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, header, 0, header.length, 0);
    return read < header.length || header.toString("latin1") !== SQLITE_HEADER ? "not a SQLite database" : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens the workspace at `path`, creating it on first use. A damaged file is kept aside as `<name>.unreadable-<ms>`,
 * with each journal file under the same name plus its own suffix, so SQLite can still open the set together; a fresh
 * workspace then starts, with a notice. Every other failure leaves the files alone.
 */
export function openWorkspace(path: string, now: () => number = Date.now): WorkspaceOpening {
  const folder = dirname(path);
  let notice: string | null = null;
  let damage: string | null;
  try {
    damage = damageBeforeOpening(path);
  } catch (error) {
    const { problem, code } = classifyWorkspaceError(error);
    return { state: "unavailable", reason: unavailableReason(problem, code, folder) };
  }
  if (damage) {
    const kept = setAside(path, damage, now);
    if ("reason" in kept) return { state: "unavailable", reason: kept.reason };
    notice = kept.notice;
  } else {
    const found = checkLeftBehind(path);
    if (found) {
      const { problem, code } = classifyWorkspaceError(found);
      if (problem !== "corrupt") return { state: "unavailable", reason: unavailableReason(problem, code, folder) };
      const kept = setAside(path, code, now);
      if ("reason" in kept) return { state: "unavailable", reason: kept.reason };
      notice = kept.notice;
    }
  }
  const first = tryOpen(path);
  if ("db" in first) return { state: "ready", ...first, notice };
  const { problem, code } = classifyWorkspaceError(first.error);
  // SQLite itself found damage the header didn't show: keep aside what is there, once, and start again.
  if (problem !== "corrupt" || notice) return { state: "unavailable", reason: [notice, unavailableReason(problem, code, folder)].filter(Boolean).join(" ") };
  const kept = setAside(path, code, now);
  if ("reason" in kept) return { state: "unavailable", reason: kept.reason };
  const second = tryOpen(path);
  if ("db" in second) return { state: "ready", ...second, notice: kept.notice };
  const again = classifyWorkspaceError(second.error);
  return { state: "unavailable", reason: `${kept.notice} The new one couldn't be opened either: ${unavailableReason(again.problem, again.code, folder)}` };
}

/**
 * Reads a database that a session left a journal beside, through a read-only connection: its schema version and its
 * schema, which is what opening reads. A writing connection that finds damage would fold the journal into the file, or
 * remove it, as it closes; a read-only one can do neither, so whatever it finds, the files are as they were. Returns
 * what went wrong, or null when there is nothing to read first or nothing wrong.
 */
function checkLeftBehind(path: string): unknown {
  if (!existsSync(path) || !JOURNALS.some((suffix) => existsSync(`${path}${suffix}`))) return null;
  // The connection may make the shared-memory index it reads the journal with. Nothing else uses one (Nivra's own
  // connection keeps its index in memory), so one it made is removed, and a damaged set is kept as it was found.
  const index = `${path}-shm`;
  const hadIndex = existsSync(index);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    const version = num(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (version > WORKSPACE_MIGRATIONS.length) return new NewerSchema(version);
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
    return null;
  } catch (error) {
    return error;
  } finally {
    try {
      db?.close();
      if (!hadIndex) rmSync(index, { force: true });
    } catch {
      // A read-only connection that can't close, or an index that stays, changes nothing in the files that matter.
    }
  }
}

/** Moves the database and its journal files aside together, under one name, and says so. Nothing is deleted. */
function setAside(path: string, why: string, now: () => number): { notice: string } | { reason: string } {
  const aside = `${path}.unreadable-${now()}`;
  let journals = false;
  try {
    for (const suffix of COMPANIONS) {
      if (!existsSync(`${path}${suffix}`)) continue;
      renameRetrying(`${path}${suffix}`, `${aside}${suffix}`);
      journals ||= (JOURNALS as readonly string[]).includes(suffix);
    }
  } catch (error) {
    return { reason: `Nivra couldn't read its history file (${why}) and couldn't move it aside (${classifyWorkspaceError(error).code}). Move ${basename(path)} and the files beside it that start with that name out of ${dirname(path)}, then open Nivra again.` };
  }
  // The journal files are named only when they were there to keep.
  return { notice: `Nivra couldn't read its history file (${why}), so it kept it aside as ${basename(aside)}${journals ? ", with its journal files," : ""} and started a new one. Your projects, preferences and key are kept separately and weren't affected.` };
}

function tryOpen(path: string): { db: WorkspaceDb; schemaVersion: number; sqlite: string } | { error: unknown } {
  let db: DatabaseSync | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Created private before SQLite opens it: the WAL file copies its mode. (Windows ignores modes.)
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    db = new DatabaseSync(path, { timeout: 0 });
    // Exclusive before anything is read, so no shared-memory file is made and a second Nivra is refused at once.
    db.exec("PRAGMA locking_mode = EXCLUSIVE;");
    const version = num(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    // A newer schema is refused before anything is written, the journal mode included.
    if (version > WORKSPACE_MIGRATIONS.length) throw new NewerSchema(version);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    db.exec("BEGIN IMMEDIATE; COMMIT;");
    migrate(db, version);
    const sqlite = str(db.prepare("SELECT sqlite_version() AS v").get()?.["v"]);
    return { db: new WorkspaceDb(path, db), schemaVersion: WORKSPACE_MIGRATIONS.length, sqlite };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Closing a connection that failed to open can fail too; the first error is the one that matters.
    }
    return { error };
  }
}

function migrate(db: DatabaseSync, from: number): void {
  for (let next = from; next < WORKSPACE_MIGRATIONS.length; next++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(WORKSPACE_MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function unavailableReason(problem: Problem, code: string, folder: string): string {
  switch (problem) {
    case "newer":
      return `Your history was saved by a newer version of Nivra (${code}; this version knows v${WORKSPACE_MIGRATIONS.length}), so this version won't read or change it. Update Nivra to use your conversations and tasks.`;
    case "locked":
      return `Another copy of Nivra is using your history (${code}), so conversations and tasks aren't available here. Close the other Nivra, then open this one again.`;
    case "access":
      return `Nivra can't open its history in ${folder} (${code}). Check that the folder exists and that you can write to it, then open Nivra again.`;
    case "disk":
      return `The disk holding Nivra's history is full or reporting errors (${code}), so conversations and tasks aren't available. Free some space or check the disk, then open Nivra again.`;
    default:
      return `Nivra couldn't open its history (${code}). Open Nivra again; if this keeps happening, the history file is in ${folder}.`;
  }
}
