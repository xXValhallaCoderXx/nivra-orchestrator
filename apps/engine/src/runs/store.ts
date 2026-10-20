import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canTransition,
  isTerminal,
  RunEvent,
  RunEventsPage,
  RunList,
  RunStatus,
  RunSummary,
  type JsonObject,
  type RunEventType,
  type RunRoute,
  type RunUsage,
  type WorkflowId,
} from "@nivra/domain";
import { Database, num, str, strOrNull, type Row } from "../db/database.ts";

/**
 * The engine's record of runs: status and an append-only timeline. Clients read these, never Mastra's tables.
 * Adapted from Hird's run store (provenance.md); backed by `node:sqlite` in `<home>/nivra.db`.
 */

const MAX_DATA_BYTES = 8_192;
/** The largest stored result: an explanation is far smaller, and a larger one is refused rather than cut. */
export const MAX_ARTIFACT_BYTES = 256_000;
const MAX_MESSAGE_CHARS = 2_000;
const PREVIEW_CHARS = 2_000;

export interface NewEvent {
  type: RunEventType;
  stepId?: string | null;
  message: string;
  data?: JsonObject | null;
}

export interface NewRun {
  workflowId: WorkflowId;
  title: string;
  input: unknown;
  clientRequestId: string | null;
  /** The engine instance that accepted the run: only its memory holds the run's context (D21). */
  instanceId: string;
}

export interface RunStoreOptions {
  database: Database;
  /** Applied to every text the store keeps: titles, inputs, messages, data and errors (D8). */
  mask?: (text: string) => string;
  now?: () => Date;
}

export class RunStore {
  readonly #database: Database;
  readonly #mask: (text: string) => string;
  readonly #now: () => Date;

  constructor(options: RunStoreOptions) {
    this.#database = options.database;
    this.#mask = options.mask ?? ((text) => text);
    this.#now = options.now ?? (() => new Date());
  }

  /** This store's id (D26): made the first time an engine that knows it opens the home, and kept from then on. */
  homeId(): string {
    return this.#database.tx((db) => {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'home_id'").get();
      if (row) return str(row["value"]);
      const id = randomUUID();
      db.prepare("INSERT INTO meta (key, value) VALUES ('home_id', ?)").run(id);
      return id;
    });
  }

  /** The run a request id created, or null when this store has none (D26). */
  findByRequest(clientRequestId: string): RunSummary | null {
    const row = this.#database.open().prepare("SELECT * FROM runs WHERE client_request_id = ?").get(clientRequestId);
    return row ? toSummary(row) : null;
  }

  /** Records a queued run. A repeated `clientRequestId` returns the run it already created. */
  create(run: NewRun): { id: string; created: boolean } {
    return this.#database.tx((db) => {
      if (run.clientRequestId) {
        const existing = db.prepare("SELECT id FROM runs WHERE client_request_id = ?").get(run.clientRequestId);
        if (existing) return { id: str(existing["id"]), created: false };
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO runs (id, workflow_id, title, status, input, client_request_id, instance_id, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      ).run(id, run.workflowId, this.#text(run.title), this.#mask(JSON.stringify(run.input ?? null)), run.clientRequestId, run.instanceId, this.#iso());
      this.#insertEvent(db, id, { type: "run.queued", message: "Queued" });
      return { id, created: true };
    });
  }

  /**
   * Moves a run to another status and records the matching event in the same transaction. Illegal moves (anything
   * out of a terminal status) are refused, so the first recorded outcome wins.
   */
  transition(runId: string, to: RunStatus, change: NewEvent & { error?: string | null; instanceId?: string }): boolean {
    return this.#database.tx((db) => {
      const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
      if (!row || !canTransition(RunStatus.parse(row["status"]), to)) return false;
      const now = this.#iso();
      db.prepare(
        `UPDATE runs SET status = ?,
           error = COALESCE(?, error),
           instance_id = COALESCE(?, instance_id),
           started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END
         WHERE id = ?`,
      ).run(to, change.error ? this.#text(change.error) : null, change.instanceId ?? null, to, now, isTerminal(to) ? 1 : 0, now, runId);
      this.#insertEvent(db, runId, change);
      return true;
    });
  }

  /** Appends to a run's timeline. Returns null for an unknown or finished run: its timeline is closed. */
  append(runId: string, event: NewEvent): RunEvent | null {
    return this.#database.tx((db) => {
      const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
      if (!row || isTerminal(RunStatus.parse(row["status"]))) return null;
      return this.#insertEvent(db, runId, event);
    });
  }

  /**
   * After a start: runs another engine instance accepted cannot go on here. Those it was executing fail as interrupted
   * and are never replayed. Those still queued fail too, without starting: the context they were given lived only in
   * that instance's memory (D21). Returns the interrupted ids.
   */
  reconcile(instanceId: string): string[] {
    const rows = this.#database
      .open()
      .prepare("SELECT id, status FROM runs WHERE status IN ('queued', 'running', 'waiting_for_approval') AND (instance_id IS NULL OR instance_id <> ?) ORDER BY rowid")
      .all(instanceId);
    const interrupted: string[] = [];
    for (const row of rows) {
      const id = str(row["id"]);
      const done = this.transition(
        id,
        "failed",
        str(row["status"]) === "queued"
          ? {
              type: "run.interrupted",
              message: "Interrupted: the engine stopped before this run started, and what the run was given was lost with it. It was not started. Start it again.",
              error: "Interrupted by an engine restart before it started",
            }
          : {
              type: "run.interrupted",
              message: "Interrupted: the engine stopped while this run was going. It was not started again.",
              error: "Interrupted by an engine restart",
            },
      );
      if (done) interrupted.push(id);
    }
    return interrupted;
  }

  /** What a run cost and where its model requests went (D22). Each field is set as it becomes known. */
  setMeta(runId: string, meta: { durationMs?: number; usage?: RunUsage; route?: RunRoute }): void {
    const db = this.#database.open();
    if (meta.durationMs !== undefined) db.prepare("UPDATE runs SET duration_ms = ? WHERE id = ?").run(Math.max(0, Math.round(meta.durationMs)), runId);
    if (meta.usage !== undefined) db.prepare("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(meta.usage), runId);
    if (meta.route !== undefined) db.prepare("UPDATE runs SET route = ? WHERE id = ?").run(JSON.stringify(meta.route), runId);
  }

  /** Stores a run's result, masked. A result over `MAX_ARTIFACT_BYTES` is refused: a cut one would no longer parse. */
  saveArtifact(runId: string, kind: string, content: string): void {
    const masked = this.#mask(content);
    if (Buffer.byteLength(masked) > MAX_ARTIFACT_BYTES) throw new Error(`The run's ${kind} result is ${Buffer.byteLength(masked)} bytes, over the ${MAX_ARTIFACT_BYTES} Nivra stores.`);
    this.#database
      .open()
      .prepare("INSERT INTO artifacts (run_id, kind, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (run_id, kind) DO UPDATE SET content = excluded.content, created_at = excluded.created_at")
      .run(runId, kind, masked, this.#iso());
  }

  artifact(runId: string, kind: string): string | null {
    const row = this.#database.open().prepare("SELECT content FROM artifacts WHERE run_id = ? AND kind = ?").get(runId, kind);
    return row ? str(row["content"]) : null;
  }

  status(runId: string): RunStatus | null {
    const row = this.#database.open().prepare("SELECT status FROM runs WHERE id = ?").get(runId);
    return row ? RunStatus.parse(row["status"]) : null;
  }

  summary(runId: string): RunSummary | null {
    const row = this.#database.open().prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    return row ? toSummary(row) : null;
  }

  /** Newest first. `cursor` is the `nextCursor` of the previous page (a row position, so equal timestamps are safe). */
  list(options: { limit: number; cursor?: number | null }): RunList {
    const rows = this.#database
      .open()
      .prepare("SELECT rowid AS position, * FROM runs WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?")
      .all(options.cursor ?? null, options.cursor ?? null, options.limit + 1);
    const page = rows.slice(0, options.limit);
    const more = rows.length > options.limit;
    return RunList.parse({ runs: page.map(toSummary), nextCursor: more ? num(page.at(-1)?.["position"]) : null });
  }

  /** Events after `after` (a sequence number), with the cursor to continue from. Null for an unknown run. */
  events(runId: string, after: number, limit: number): RunEventsPage | null {
    const status = this.status(runId);
    if (!status) return null;
    const events = this.#database
      .open()
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(runId, after, limit)
      .map((row) =>
        RunEvent.parse({
          runId,
          seq: num(row["seq"]),
          at: str(row["at"]),
          type: str(row["type"]),
          stepId: strOrNull(row["step_id"]),
          message: str(row["message"]),
          data: row["data"] === null ? null : JSON.parse(str(row["data"])),
        }),
      );
    return RunEventsPage.parse({ events, next: events.at(-1)?.seq ?? after, status });
  }

  /** The oldest queued run, or null. */
  nextQueued(): string | null {
    const row = this.#database.open().prepare("SELECT id FROM runs WHERE status = 'queued' ORDER BY rowid LIMIT 1").get();
    return row ? str(row["id"]) : null;
  }

  /** Runs that are queued or going. */
  active(): string[] {
    return this.#database
      .open()
      .prepare("SELECT id FROM runs WHERE status IN ('queued', 'running', 'waiting_for_approval') ORDER BY rowid")
      .all()
      .map((row) => str(row["id"]));
  }

  #insertEvent(db: DatabaseSync, runId: string, event: NewEvent): RunEvent {
    const last = db.prepare("SELECT MAX(seq) AS seq FROM run_events WHERE run_id = ?").get(runId);
    const stored = RunEvent.parse({
      runId,
      seq: num(last?.["seq"] ?? 0) + 1,
      at: this.#iso(),
      type: event.type,
      stepId: event.stepId ?? null,
      message: this.#text(event.message),
      data: event.data ? this.#capData(event.data) : null,
    });
    db.prepare("INSERT INTO run_events (run_id, seq, at, type, step_id, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      runId,
      stored.seq,
      stored.at,
      stored.type,
      stored.stepId,
      stored.message,
      stored.data ? JSON.stringify(stored.data) : null,
    );
    return stored;
  }

  /** Masks secrets and caps size. Oversized data becomes a readable preview, never cut-off JSON. */
  #capData(data: JsonObject): JsonObject {
    const json = this.#mask(JSON.stringify(data));
    if (Buffer.byteLength(json) <= MAX_DATA_BYTES) return JSON.parse(json) as JsonObject;
    return { truncated: true, bytes: Buffer.byteLength(json), preview: json.slice(0, PREVIEW_CHARS) };
  }

  #text(value: string): string {
    const masked = this.#mask(value);
    return masked.length > MAX_MESSAGE_CHARS ? `${masked.slice(0, MAX_MESSAGE_CHARS)}…` : masked;
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

/**
 * A run's input as stored. It is masked as one text, so a private-key block split across fields is masked too, and a
 * mask that spans fields can leave text that is no longer JSON. That input reads as null: the run is refused before
 * its workflow starts (D23), and every other run still lists.
 */
function storedInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toSummary(row: Row): RunSummary {
  return RunSummary.parse({
    id: str(row["id"]),
    workflowId: str(row["workflow_id"]),
    title: str(row["title"]),
    status: str(row["status"]),
    input: storedInput(str(row["input"])),
    createdAt: str(row["created_at"]),
    startedAt: strOrNull(row["started_at"]),
    finishedAt: strOrNull(row["finished_at"]),
    error: strOrNull(row["error"]),
    durationMs: row["duration_ms"] === null || row["duration_ms"] === undefined ? null : num(row["duration_ms"]),
    usage: row["usage"] ? JSON.parse(str(row["usage"])) : null,
    route: row["route"] ? JSON.parse(str(row["route"])) : null,
  });
}
