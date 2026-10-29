import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Row = Record<string, SQLOutputValue>;

export const str = (value: SQLOutputValue | undefined): string => String(value);
export const strOrNull = (value: SQLOutputValue | undefined): string | null => (value === null || value === undefined ? null : String(value));
export const num = (value: SQLOutputValue | undefined): number => Number(value);

/** Another engine holds this home's database (D7). */
export class EngineLockedError extends Error {
  constructor(path: string) {
    super(`Another Nivra engine is using ${dirname(path)}. Close it, or start this engine with a different --home.`);
    this.name = "EngineLockedError";
  }
}

/** SQLite's "busy" and "locked" result codes, as `node:sqlite` reports them in `errcode`. */
const isBusy = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return code === 5 || code === 6;
};

/**
 * The engine's own SQLite database (`<home>/nivra.db`), ported from Hird. With `exclusive`, the connection takes
 * SQLite's exclusive lock when it opens and keeps it until it closes, so a second engine on the same home is refused
 * at once (D7). The lock belongs to the process: the OS releases it when the process dies, so it cannot go stale.
 * Locking mode is set before WAL, so no shared-memory file is ever created.
 */
export class Database {
  readonly path: string;
  readonly #exclusive: boolean;
  #db: DatabaseSync | null = null;
  #depth = 0;

  constructor(path: string, options: { exclusive?: boolean } = {}) {
    this.path = path;
    this.#exclusive = options.exclusive ?? false;
  }

  open(): DatabaseSync {
    if (this.#db) return this.#db;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Create the file private before SQLite opens it: the WAL file copies its mode. (Windows ignores modes.)
    if (!existsSync(this.path)) closeSync(openSync(this.path, "a", 0o600));
    chmodSync(this.path, 0o600);
    const db = new DatabaseSync(this.path, { timeout: this.#exclusive ? 0 : 5_000 });
    try {
      if (this.#exclusive) db.exec("PRAGMA locking_mode = EXCLUSIVE;");
      // FULL: a write is durable when it returns, so a budget journal row written before a send survives a stop (NIV-66).
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      // A write takes the exclusive lock now, and EXCLUSIVE mode keeps it.
      if (this.#exclusive) db.exec("BEGIN IMMEDIATE; COMMIT;");
      migrate(db);
    } catch (error) {
      db.close();
      if (isBusy(error)) throw new EngineLockedError(this.path);
      throw error;
    }
    this.#db = db;
    return db;
  }

  /**
   * Runs `work` atomically. Nested calls become savepoints, so a store method that is itself transactional can be
   * used inside a larger transaction.
   */
  tx<T>(work: (db: DatabaseSync) => T): T {
    const db = this.open();
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

  close(): void {
    this.#db?.close();
    this.#db = null;
  }
}

function migrate(db: DatabaseSync): void {
  const version = num(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
  if (version > MIGRATIONS.length) {
    throw new Error(`This engine's database was written by a newer Nivra (schema v${version}, this engine knows v${MIGRATIONS.length}). Update Nivra.`);
  }
  for (let next = version; next < MIGRATIONS.length; next++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
