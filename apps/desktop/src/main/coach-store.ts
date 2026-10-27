import { ContextBinding } from "@nivra/domain";
import { str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";
import type { CancelReason, TurnStatus } from "./workspace.ts";

/**
 * Coachings of tasks in the workspace (NIV-53): a run link with workflow `coach`, owned by its task and bound to the
 * brief version the coach read, and a `coachings` row with what it was bound to. It mirrors reviews (D31) and research
 * (D37). The packet isn't kept, its fingerprint is, beside the context binding's (Track B's) and the preferences'; the
 * engine's report, masked again, is kept once, when the run ends; and the brief version the person's ticked changes
 * made is kept once, after the report.
 *
 * Its table is the workspace's migration 7 (workspace-db.ts), after Track B's missions (v6).
 */

const OPEN = "('submitting', 'running')";

/** A coaching's run link, as the workspace keeps it: where it went, how it went, and whether a stop was asked for. */
export interface CoachLink {
  id: string;
  taskId: string;
  briefId: string;
  sessionId: string;
  /** The engine it runs on, fixed when it starts: the task's project's, or `local` for a task with none (D17). */
  targetId: string;
  homeId: string | null;
  runId: string | null;
  status: TurnStatus;
  cancelRequested: boolean;
  cancelReason: CancelReason | null;
  errorKind: string | null;
  errorMessage: string | null;
  /** The preferences it was given, by id and revision (D21): never their text. */
  preferences: Array<{ id: string; revision: number }>;
  createdAt: string;
  settledAt: string | null;
}

/** One coaching of one task: what it was bound to, the report its engine saved, and the changes saved from it. */
export interface CoachingRecord {
  /** The run link's id, sent as the request id. */
  id: string;
  taskId: string;
  briefId: string;
  briefVersion: number;
  briefSha256: string;
  /** The task's title as it was sent. */
  title: string;
  /** The task's project when it was asked for; null for a task with no repository. */
  projectId: string | null;
  /** What it was bound to (Track B's context binding): ids, versions, digests and the title as sent, never the brief's text. */
  binding: ContextBinding;
  bindingDigest: string;
  packetDigest: string;
  preferencesDigest: string;
  profile: { id: string; version: number };
  /** The mission it was sent, as it was; null for none. */
  mission: { name: string; version: number } | null;
  /** How many findings and preferences it was sent. */
  findings: number;
  preferences: number;
  /** The engine's report, masked again, kept once; null until the run ends, or when it ended without one. */
  report: unknown | null;
  reportedAt: string | null;
  /** The brief version the person's ticked changes made, and which fields, kept once; null until then. */
  applied: { briefId: string; fields: string[]; at: string } | null;
  createdAt: string;
  link: CoachLink;
}

const linkOf = (row: Row): CoachLink => ({
  id: str(row["id"]),
  taskId: str(row["task_id"]),
  briefId: str(row["brief_id"]),
  sessionId: str(row["session_id"]),
  targetId: str(row["target_id"]),
  homeId: strOrNull(row["home_id"]),
  runId: strOrNull(row["run_id"]),
  status: str(row["status"]) as TurnStatus,
  cancelRequested: Number(row["cancel_requested"]) === 1,
  cancelReason: strOrNull(row["cancel_reason"]) as CancelReason | null,
  errorKind: strOrNull(row["error_kind"]),
  errorMessage: strOrNull(row["error_message"]),
  preferences: JSON.parse(str(row["preferences_json"])) as CoachLink["preferences"],
  createdAt: str(row["created_at"]),
  settledAt: strOrNull(row["settled_at"]),
});

/** A coach run link, or null for a run link of another workflow. */
export function getCoachLink(workspace: WorkspaceDb, id: string): CoachLink | null {
  const row = workspace.db.prepare("SELECT * FROM run_links WHERE id = ? AND workflow_id = 'coach'").get(id);
  return row ? linkOf(row) : null;
}

function recordOf(workspace: WorkspaceDb, row: Row): CoachingRecord | null {
  const link = getCoachLink(workspace, str(row["id"]));
  if (!link) return null;
  const applied = strOrNull(row["applied_brief_id"]);
  return {
    id: str(row["id"]),
    taskId: str(row["task_id"]),
    briefId: str(row["brief_id"]),
    briefVersion: Number(row["brief_version"]),
    briefSha256: str(row["brief_sha256"]),
    title: str(row["title"]),
    projectId: strOrNull(row["project_id"]),
    binding: ContextBinding.parse(JSON.parse(str(row["binding_json"]))),
    bindingDigest: str(row["binding_digest"]),
    packetDigest: str(row["packet_digest"]),
    preferencesDigest: str(row["preferences_digest"]),
    profile: { id: str(row["profile_id"]), version: Number(row["profile_version"]) },
    mission: row["mission_json"] ? (JSON.parse(str(row["mission_json"])) as CoachingRecord["mission"]) : null,
    findings: Number(row["findings"]),
    preferences: Number(row["preferences"]),
    report: row["report_json"] ? (JSON.parse(str(row["report_json"])) as unknown) : null,
    reportedAt: strOrNull(row["reported_at"]),
    applied: applied ? { briefId: applied, fields: JSON.parse(str(row["applied_fields_json"])) as string[], at: str(row["applied_at"]) } : null,
    createdAt: str(row["created_at"]),
    link,
  };
}

/**
 * Starts a coaching: its run link and what it is bound to, in one transaction, before anything is sent. Refused (false)
 * while the task has a coaching still open: one at a time for a task. A task's runs neither block it nor are blocked.
 */
export function insertCoaching(
  workspace: WorkspaceDb,
  coaching: Omit<CoachingRecord, "report" | "reportedAt" | "applied" | "link">,
  link: Pick<CoachLink, "sessionId" | "targetId" | "preferences">,
): boolean {
  return workspace.tx((db) => {
    if (db.prepare(`SELECT 1 FROM run_links WHERE workflow_id = 'coach' AND task_id = ? AND status IN ${OPEN}`).get(coaching.taskId)) return false;
    db.prepare("INSERT INTO run_links (id, task_id, brief_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, ?, ?, 'coach', ?, 'submitting', ?, ?)").run(
      coaching.id,
      coaching.taskId,
      coaching.briefId,
      link.sessionId,
      link.targetId,
      JSON.stringify(link.preferences),
      coaching.createdAt,
    );
    db.prepare(
      "INSERT INTO coachings (id, task_id, brief_id, brief_version, brief_sha256, title, project_id, binding_json, binding_digest, packet_digest, preferences_digest, profile_id, profile_version, mission_json, findings, preferences, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      coaching.id,
      coaching.taskId,
      coaching.briefId,
      coaching.briefVersion,
      coaching.briefSha256,
      coaching.title,
      coaching.projectId,
      JSON.stringify(coaching.binding),
      coaching.bindingDigest,
      coaching.packetDigest,
      coaching.preferencesDigest,
      coaching.profile.id,
      coaching.profile.version,
      coaching.mission ? JSON.stringify(coaching.mission) : null,
      coaching.findings,
      coaching.preferences,
      coaching.createdAt,
    );
    return true;
  });
}

export function getCoaching(workspace: WorkspaceDb, id: string): CoachingRecord | null {
  const row = workspace.db.prepare("SELECT * FROM coachings WHERE id = ?").get(id);
  return row ? recordOf(workspace, row) : null;
}

/** A task's coachings, the newest first. */
export function coachingsOf(workspace: WorkspaceDb, taskId: string): CoachingRecord[] {
  return workspace.db
    .prepare("SELECT * FROM coachings WHERE task_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(taskId)
    .flatMap((row) => recordOf(workspace, row) ?? []);
}

/**
 * Coachings still being sent or going: a task's, those asked for under a project (what turning its sharing off, or
 * removing it, stops), or every one. Oldest first.
 */
export function openCoachings(workspace: WorkspaceDb, of: { taskId: string } | { projectId: string } | null = null): CoachingRecord[] {
  const where = of === null ? "" : "taskId" in of ? "AND coachings.task_id = ?" : "AND coachings.project_id = ?";
  const params = of === null ? [] : ["taskId" in of ? of.taskId : of.projectId];
  return workspace.db
    .prepare(`SELECT coachings.* FROM coachings JOIN run_links ON run_links.id = coachings.id WHERE run_links.status IN ${OPEN} ${where} ORDER BY run_links.rowid`)
    .all(...params)
    .flatMap((row) => recordOf(workspace, row) ?? []);
}

/**
 * Ends an open coaching, in one transaction: its run link's outcome, and the report its engine saved, when there is
 * one. A coaching that already ended keeps its first outcome and report; one deleted meanwhile gets nothing.
 */
export function settleCoaching(
  workspace: WorkspaceDb,
  id: string,
  outcome: { status: Exclude<TurnStatus, "submitting" | "running">; errorKind?: string | null; errorMessage?: string | null },
  report: unknown | null,
  at: string,
): boolean {
  return workspace.tx((db) => {
    const settled = Number(
      db
        .prepare(`UPDATE run_links SET status = ?, error_kind = ?, error_message = ?, settled_at = ? WHERE id = ? AND workflow_id = 'coach' AND status IN ${OPEN}`)
        .run(outcome.status, outcome.errorKind ?? null, outcome.errorMessage ?? null, at, id).changes,
    );
    if (settled !== 1) return false;
    if (report !== null && report !== undefined) db.prepare("UPDATE coachings SET report_json = ?, reported_at = ? WHERE id = ? AND report_json IS NULL").run(JSON.stringify(report), at, id);
    return true;
  });
}

/**
 * Records the brief version made from this coaching's report, and which fields, once: the next version of the same
 * task's brief, made from the version the coach read (the trigger refuses anything else). Synchronous, so the host runs
 * it inside the transaction that saves that version: either both are kept or neither is. False when the changes were
 * recorded already, or there is no report.
 */
export function markCoachingApplied(workspace: WorkspaceDb, id: string, briefId: string, fields: readonly string[], at: string): boolean {
  return (
    Number(
      workspace.db
        .prepare("UPDATE coachings SET applied_brief_id = ?, applied_fields_json = ?, applied_at = ? WHERE id = ? AND applied_brief_id IS NULL AND report_json IS NOT NULL")
        .run(briefId, JSON.stringify(fields), at, id).changes,
    ) === 1
  );
}
