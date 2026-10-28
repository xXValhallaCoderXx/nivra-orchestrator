import { BuildsAcceptance, EnvironmentReport, EnvironmentSetup, PreparedEnvironmentV2 } from "@nivra/domain";
import { str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";
import type { TurnStatus } from "./workspace.ts";

/**
 * A project's environment in the workspace (NIV-49, NIV-55): what the person chose with its last preparation, the
 * environment its last successful preparation left, any acceptance of builds that preparation didn't run, and each
 * preparation, kept as a task's attempt is. A preparation's id is the request id, saved before runs.start is sent; the
 * engine store it goes to is recorded just before the request is written, so one with none was never sent; and its
 * engine's report, masked again, is kept once, when it ends. The prepared environment is kept only from a report whose
 * outcome is `prepared`. Its tables are the workspace's fifth migration, and the acceptance's column a later one.
 *
 * Rows are read with the domain's schemas, never cast. One written by D41's single setup, or one Nivra can't read, is
 * legacy: it says "prepare again", and nothing in it is used for a run.
 */

const OPEN = "('submitting', 'running')";

/** Who asked Nivra to stop a preparation: the person, uploads turned off, or the project removed. */
export type PreparationStop = "person" | "uploads" | "removal";

export interface EnvironmentRecord {
  projectId: string;
  /** What the person chose with the last preparation they started; null when that was D41's setup, or can't be read. */
  setup: EnvironmentSetup | null;
  /** What the project's task runs start from: the last preparation that ended prepared left it; null before one did. */
  prepared: PreparedEnvironmentV2 | null;
  /** The environment kept is D41's, or can't be read: prepare again. */
  legacy: boolean;
  /** The preparation that left it. */
  preparedBy: string | null;
  /** The person's acceptance of the dependency builds its preparation didn't run, bound to its verified record. */
  builds: BuildsAcceptance | null;
  updatedAt: string;
}

/** One preparation of a project's environment, as a task's attempt is kept (D26, D41). */
export interface PreparationRecord {
  /** The request id it is sent with. */
  id: string;
  projectId: string;
  /** The host session that started it: only that session's own submission is ever still in flight. */
  sessionId: string;
  /** The engine it runs on, fixed when it starts: its project's (D17). */
  targetId: string;
  /** The engine store it was sent to (`EngineInfo.homeId`), recorded just before sending. */
  homeId: string | null;
  runId: string | null;
  status: TurnStatus;
  cancelRequested: boolean;
  cancelReason: PreparationStop | null;
  errorKind: string | null;
  errorMessage: string | null;
  /** What it was started with; null for one D41's setup started, or one that can't be read. */
  setup: EnvironmentSetup | null;
  /** The fingerprint of the preview the person was shown, which the engine checks again before sending anything. */
  preview: string;
  /** Its engine's report, masked again, kept once when it ended; null until then, when it ended without one, or when it can't be read. */
  report: EnvironmentReport | null;
  reportedAt: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** A JSON column read with a schema: what it holds, or null when it's empty, isn't JSON, or isn't that shape. */
function parsed<T>(text: unknown, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }): T | null {
  if (typeof text !== "string" || text === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const read = schema.safeParse(value);
  return read.success ? read.data : null;
}

const environmentOfRow = (row: Row): EnvironmentRecord => {
  const prepared = parsed(row["prepared_json"], PreparedEnvironmentV2);
  return {
    projectId: str(row["project_id"]),
    setup: parsed(row["spec_json"], EnvironmentSetup),
    prepared,
    legacy: row["prepared_json"] !== null && prepared === null,
    preparedBy: strOrNull(row["prepared_by"]),
    // Only for the environment kept now: the trigger binds it, and reading it again costs nothing.
    builds: prepared ? (parsed(row["builds_json"], BuildsAcceptance) ?? null) : null,
    updatedAt: str(row["updated_at"]),
  };
};

const preparationOf = (row: Row): PreparationRecord => ({
  id: str(row["id"]),
  projectId: str(row["project_id"]),
  sessionId: str(row["session_id"]),
  targetId: str(row["target_id"]),
  homeId: strOrNull(row["home_id"]),
  runId: strOrNull(row["run_id"]),
  status: str(row["status"]) as TurnStatus,
  cancelRequested: Number(row["cancel_requested"]) === 1,
  cancelReason: strOrNull(row["cancel_reason"]) as PreparationStop | null,
  errorKind: strOrNull(row["error_kind"]),
  errorMessage: strOrNull(row["error_message"]),
  setup: parsed(row["spec_json"], EnvironmentSetup),
  preview: str(row["preview"]),
  report: parsed(row["report_json"], EnvironmentReport),
  reportedAt: strOrNull(row["reported_at"]),
  createdAt: str(row["created_at"]),
  settledAt: strOrNull(row["settled_at"]),
});

/** The project's environment as the workspace keeps it, or null before its first preparation was started. */
export function environmentOf(workspace: WorkspaceDb, projectId: string): EnvironmentRecord | null {
  const row = workspace.db.prepare("SELECT * FROM environments WHERE project_id = ?").get(projectId);
  return row ? environmentOfRow(row) : null;
}

/**
 * Starts a preparation, in one transaction, before anything is sent: its record, and what it was started with as the
 * project's choices. A prepared environment the project has stays until another preparation ends prepared. Refused
 * (false) while the project has a preparation still open: one at a time, however quickly two arrive.
 */
export function insertPreparation(workspace: WorkspaceDb, preparation: Pick<PreparationRecord, "id" | "projectId" | "sessionId" | "targetId" | "preview" | "createdAt"> & { setup: EnvironmentSetup }): boolean {
  return workspace.tx((db) => {
    if (db.prepare(`SELECT 1 FROM preparations WHERE project_id = ? AND status IN ${OPEN}`).get(preparation.projectId)) return false;
    const setup = JSON.stringify(EnvironmentSetup.parse(preparation.setup));
    db.prepare("INSERT INTO preparations (id, project_id, session_id, target_id, status, spec_json, preview, created_at) VALUES (?, ?, ?, ?, 'submitting', ?, ?, ?)").run(
      preparation.id,
      preparation.projectId,
      preparation.sessionId,
      preparation.targetId,
      setup,
      preparation.preview,
      preparation.createdAt,
    );
    db.prepare("INSERT INTO environments (project_id, spec_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (project_id) DO UPDATE SET spec_json = excluded.spec_json, updated_at = excluded.updated_at").run(
      preparation.projectId,
      setup,
      preparation.createdAt,
    );
    return true;
  });
}

export function getPreparation(workspace: WorkspaceDb, id: string): PreparationRecord | null {
  const row = workspace.db.prepare("SELECT * FROM preparations WHERE id = ?").get(id);
  return row ? preparationOf(row) : null;
}

export function preparationByRun(workspace: WorkspaceDb, runId: string): PreparationRecord | null {
  const row = workspace.db.prepare("SELECT * FROM preparations WHERE run_id = ?").get(runId);
  return row ? preparationOf(row) : null;
}

/** The project's latest preparation, or null before its first. */
export function latestPreparation(workspace: WorkspaceDb, projectId: string): PreparationRecord | null {
  const row = workspace.db.prepare("SELECT * FROM preparations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(projectId);
  return row ? preparationOf(row) : null;
}

/** Preparations still being sent or going: of one project, of one engine's target, or all of them. */
export function openPreparations(workspace: WorkspaceDb, of: { projectId: string } | { targetId: string } | null = null): PreparationRecord[] {
  const rows =
    of === null
      ? workspace.db.prepare(`SELECT * FROM preparations WHERE status IN ${OPEN} ORDER BY rowid`).all()
      : "projectId" in of
        ? workspace.db.prepare(`SELECT * FROM preparations WHERE project_id = ? AND status IN ${OPEN} ORDER BY rowid`).all(of.projectId)
        : workspace.db.prepare(`SELECT * FROM preparations WHERE target_id = ? AND status IN ${OPEN} ORDER BY rowid`).all(of.targetId);
  return rows.map(preparationOf);
}

/** Records the engine store a preparation is about to be sent to. After this, and only after it, the request is written. */
export function setPreparationHome(workspace: WorkspaceDb, id: string, homeId: string): boolean {
  return Number(workspace.db.prepare("UPDATE preparations SET home_id = ? WHERE id = ? AND status = 'submitting' AND home_id IS NULL").run(homeId, id).changes) === 1;
}

/** The engine accepted the preparation as `runId`. */
export function recordPreparationRun(workspace: WorkspaceDb, id: string, runId: string): boolean {
  return Number(workspace.db.prepare("UPDATE preparations SET run_id = ?, status = 'running' WHERE id = ? AND status = 'submitting'").run(runId, id).changes) === 1;
}

/** Asks an open preparation to stop, keeping the first reason given. */
export function requestPreparationStop(workspace: WorkspaceDb, id: string, reason: PreparationStop): boolean {
  return Number(workspace.db.prepare(`UPDATE preparations SET cancel_requested = 1, cancel_reason = COALESCE(cancel_reason, ?) WHERE id = ? AND status IN ${OPEN}`).run(reason, id).changes) === 1;
}

/** Takes back a stop Nivra asked for and couldn't carry out, so the preparation's end isn't later put down to it. */
export function withdrawPreparationStop(workspace: WorkspaceDb, id: string, reason: PreparationStop): void {
  workspace.db.prepare(`UPDATE preparations SET cancel_requested = 0, cancel_reason = NULL WHERE id = ? AND cancel_reason = ? AND status IN ${OPEN}`).run(id, reason);
}

/**
 * Ends an open preparation, in one transaction: how it ended, the report its engine saved when there is one, and the
 * environment it prepared, kept as the project's only when the report's outcome is `prepared`. A new environment ends
 * any acceptance of builds given for the one before. A preparation that already ended keeps its first outcome and report.
 */
export function settlePreparation(
  workspace: WorkspaceDb,
  id: string,
  outcome: { status: Exclude<TurnStatus, "submitting" | "running">; errorKind?: string | null; errorMessage?: string | null },
  ended: { report: EnvironmentReport | null; prepared: PreparedEnvironmentV2 | null },
  at: string,
): boolean {
  return workspace.tx((db) => {
    const settled = Number(
      db.prepare(`UPDATE preparations SET status = ?, error_kind = ?, error_message = ?, settled_at = ? WHERE id = ? AND status IN ${OPEN}`).run(outcome.status, outcome.errorKind ?? null, outcome.errorMessage ?? null, at, id).changes,
    );
    if (settled !== 1) return false;
    if (!ended.report) return true;
    db.prepare("UPDATE preparations SET report_json = ?, reported_at = ? WHERE id = ? AND report_json IS NULL").run(JSON.stringify(ended.report), at, id);
    if (ended.prepared === null || ended.report.outcome !== "prepared") return true;
    const projectId = str(db.prepare("SELECT project_id FROM preparations WHERE id = ?").get(id)?.["project_id"]);
    db.prepare("UPDATE environments SET prepared_json = ?, prepared_by = ?, builds_json = NULL, updated_at = ? WHERE project_id = ?").run(JSON.stringify(PreparedEnvironmentV2.parse(ended.prepared)), id, at, projectId);
    return true;
  });
}

/**
 * Records the person's acceptance of the dependency builds the project's environment didn't run (NIV-55), bound to its
 * verified record by digest: false when the environment kept now isn't that one. It ends when another preparation leaves
 * an environment, and never carries over to one it wasn't given for.
 */
export function acceptBuilds(workspace: WorkspaceDb, projectId: string, acceptance: BuildsAcceptance, at: string): boolean {
  const accepted = BuildsAcceptance.parse(acceptance);
  return (
    Number(
      workspace.db
        .prepare("UPDATE environments SET builds_json = ?, updated_at = ? WHERE project_id = ? AND prepared_json IS NOT NULL AND json_extract(prepared_json, '$.verifiedDigest') = ?")
        .run(JSON.stringify(accepted), at, projectId, accepted.verified).changes,
    ) === 1
  );
}
