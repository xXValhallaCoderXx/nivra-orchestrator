import { randomUUID } from "node:crypto";
import type { ResearchSites, StopCause } from "../shared/research.ts";
import { str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";
import { getTurn, type CancelReason, type TurnRecord, type TurnStatus } from "./workspace.ts";

/**
 * Research of saved plans' assumptions in the workspace (NIV-45): a run link with workflow `research`, and a `research`
 * row with what it was bound to. It mirrors reviews (D31). The plan is referenced, never copied; the queries the person
 * approved are kept, as the report keeps them; the engine's report, masked again, is kept once, when the research ends.
 *
 * Its table is the workspace's third migration (D37).
 *
 * Every stop of a research run goes through `stopResearch`, and every withdrawal through `withdrawStop`: the person's
 * cancel, either permission turned off, a project removed and a conversation deleted. The generic `requestCancel` and
 * `withdrawCancel` in `workspace.ts` don't know about tokens, so they leave research links as they are: each of the
 * host's stop paths needs a research branch, and a path without one fails in tests rather than clearing a newer stop.
 */
/** The run link statuses of research still under way, as `workspace.ts` counts them. */
const OPEN = "('submitting', 'running')";

/** How a stop reads on the run link: both permissions are sharing, kept apart in the research row. */
const CANCEL_REASON: Readonly<Record<StopCause, CancelReason>> = { person: "person", "web-research": "sharing", "model-sharing": "sharing", removal: "removal", deletion: "deletion" };

export interface ResearchQuery {
  assumption: "A1" | "A2" | "A3";
  text: string;
  query: string;
}

/** One research run of one plan version: what it was bound to, how it stopped, its report and its amended plan. */
export interface ResearchRecord {
  /** The run link's id, sent as the request id. */
  id: string;
  conversationId: string;
  planId: string;
  planLineage: string;
  planVersion: number;
  /** The plan version's own fingerprint, recorded only: the version is immutable. */
  planSha256: string;
  packetDigest: string;
  queries: ResearchQuery[];
  /** The sites the person chose, as they were sent; null for none. */
  sites: ResearchSites | null;
  scope: { kind: "general" } | { kind: "project"; projectId: string; projectLabel: string | null; headAtStart: string | null };
  /** The newest stop asked for, with its token; null when none is pending or it was withdrawn. */
  stop: { cause: StopCause; token: string } | null;
  /** The plan version saved from this research, set once. */
  amendedPlanId: string | null;
  /** The engine's report, masked again, kept once; null until the research ends, or when it ended without one. */
  report: unknown | null;
  reportedAt: string | null;
  createdAt: string;
  link: TurnRecord;
}

function recordOf(workspace: WorkspaceDb, row: Row): ResearchRecord | null {
  const link = getTurn(workspace, str(row["id"]));
  if (!link) return null;
  const cause = strOrNull(row["stop_cause"]) as StopCause | null;
  return {
    id: str(row["id"]),
    conversationId: str(row["conversation_id"]),
    planId: str(row["plan_id"]),
    planLineage: str(row["plan_lineage"]),
    planVersion: Number(row["plan_version"]),
    planSha256: str(row["plan_sha256"]),
    packetDigest: str(row["packet_digest"]),
    queries: JSON.parse(str(row["queries_json"])) as ResearchQuery[],
    sites: row["sites_json"] ? (JSON.parse(str(row["sites_json"])) as ResearchSites) : null,
    scope:
      str(row["scope_kind"]) === "project"
        ? { kind: "project", projectId: str(row["project_id"]), projectLabel: strOrNull(row["project_label"]), headAtStart: strOrNull(row["head_at_start"]) }
        : { kind: "general" },
    stop: cause ? { cause, token: str(row["stop_token"]) } : null,
    amendedPlanId: strOrNull(row["amended_plan_id"]),
    report: row["report_json"] ? (JSON.parse(str(row["report_json"])) as unknown) : null,
    reportedAt: strOrNull(row["reported_at"]),
    createdAt: str(row["created_at"]),
    link,
  };
}

/**
 * Starts research: its run link and what it is bound to, in one transaction, before anything is sent. Refused (false)
 * while the conversation has any run still open, a turn, a review or research: one at a time (D31).
 */
export function insertResearch(
  workspace: WorkspaceDb,
  research: Omit<ResearchRecord, "stop" | "amendedPlanId" | "report" | "reportedAt" | "link">,
  link: Pick<TurnRecord, "sessionId" | "targetId">,
): boolean {
  return workspace.tx((db) => {
    if (db.prepare(`SELECT 1 FROM run_links WHERE conversation_id = ? AND status IN ${OPEN}`).get(research.conversationId)) return false;
    db.prepare("INSERT INTO run_links (id, conversation_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, ?, 'research', ?, 'submitting', '[]', ?)").run(
      research.id,
      research.conversationId,
      link.sessionId,
      link.targetId,
      research.createdAt,
    );
    const project = research.scope.kind === "project" ? research.scope : null;
    db.prepare(
      "INSERT INTO research (id, conversation_id, plan_id, plan_lineage, plan_version, plan_sha256, packet_digest, queries_json, sites_json, scope_kind, project_id, project_label, head_at_start, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      research.id,
      research.conversationId,
      research.planId,
      research.planLineage,
      research.planVersion,
      research.planSha256,
      research.packetDigest,
      JSON.stringify(research.queries),
      research.sites ? JSON.stringify(research.sites) : null,
      research.scope.kind,
      project?.projectId ?? null,
      project?.projectLabel ?? null,
      project?.headAtStart ?? null,
      research.createdAt,
    );
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(research.createdAt, research.conversationId);
    return true;
  });
}

export function getResearch(workspace: WorkspaceDb, id: string): ResearchRecord | null {
  const row = workspace.db.prepare("SELECT * FROM research WHERE id = ?").get(id);
  return row ? recordOf(workspace, row) : null;
}

/** Research still under way in any conversation, as run links: what turning research off stops (D37). */
export function openResearch(workspace: WorkspaceDb): TurnRecord[] {
  return workspace.db
    .prepare(`SELECT id FROM run_links WHERE workflow_id = 'research' AND status IN ${OPEN} ORDER BY rowid`)
    .all()
    .flatMap((row) => getTurn(workspace, str(row["id"])) ?? []);
}

/** A conversation's research, oldest first. */
export function researchOf(workspace: WorkspaceDb, conversationId: string): ResearchRecord[] {
  return workspace.db
    .prepare("SELECT * FROM research WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversationId)
    .flatMap((row) => recordOf(workspace, row) ?? []);
}

/**
 * Asks an open research run to stop, in one transaction: the run link's cancel flag and reason, and the research row's
 * cause with a new token, made here so no two stops share one. A later stop replaces both, so the newest stop is the one
 * on record. Returns the token, for withdrawing this stop if it fails; null when the run had already ended.
 */
export function stopResearch(workspace: WorkspaceDb, id: string, cause: StopCause): string | null {
  return workspace.tx((db) => {
    const open = Number(db.prepare(`UPDATE run_links SET cancel_requested = 1, cancel_reason = ? WHERE id = ? AND workflow_id = 'research' AND status IN ${OPEN}`).run(CANCEL_REASON[cause], id).changes) === 1;
    if (!open) return null;
    const token = randomUUID();
    db.prepare("UPDATE research SET stop_cause = ?, stop_token = ? WHERE id = ?").run(cause, token, id);
    return token;
  });
}

/**
 * Withdraws a stop that failed, as one atomic, conditional update: the run link's cancel flag and reason, and the
 * research row's cause and token, are cleared together, and only while the stored token is still that stop's and the run
 * is still open. A newer stop is never cleared, and a run that ended keeps the stop on record. True when it was withdrawn.
 */
export function withdrawStop(workspace: WorkspaceDb, id: string, token: string): boolean {
  return workspace.tx((db) => {
    const cleared =
      Number(
        db
          .prepare(`UPDATE research SET stop_cause = NULL, stop_token = NULL WHERE id = ? AND stop_token = ? AND EXISTS (SELECT 1 FROM run_links WHERE run_links.id = research.id AND status IN ${OPEN})`)
          .run(id, token).changes,
      ) === 1;
    if (!cleared) return false;
    db.prepare("UPDATE run_links SET cancel_requested = 0, cancel_reason = NULL WHERE id = ? AND workflow_id = 'research'").run(id);
    return true;
  });
}

/**
 * Ends an open research run, in one transaction: its run link's outcome, and the report its engine saved, when there is
 * one. A run that already ended keeps its first outcome and report; one deleted meanwhile gets nothing.
 */
export function settleResearch(
  workspace: WorkspaceDb,
  id: string,
  outcome: { status: Exclude<TurnStatus, "submitting" | "running">; errorKind?: string | null; errorMessage?: string | null },
  report: unknown | null,
  at: string,
): boolean {
  return workspace.tx((db) => {
    const settled = Number(
      db
        .prepare(`UPDATE run_links SET status = ?, error_kind = ?, error_message = ?, settled_at = ? WHERE id = ? AND workflow_id = 'research' AND status IN ${OPEN}`)
        .run(outcome.status, outcome.errorKind ?? null, outcome.errorMessage ?? null, at, id).changes,
    );
    if (settled !== 1) return false;
    if (report !== null && report !== undefined) db.prepare("UPDATE research SET report_json = ?, reported_at = ? WHERE id = ? AND report_json IS NULL").run(JSON.stringify(report), at, id);
    return true;
  });
}

/**
 * Records the plan version saved from this research's report, once: a plan of the same conversation and lineage, derived
 * from the version that was researched. False when one was already recorded, there is no report, or the plan isn't that.
 */
export function recordAmendedPlan(workspace: WorkspaceDb, id: string, planId: string): boolean {
  return (
    Number(
      workspace.db
        .prepare(
          "UPDATE research SET amended_plan_id = ? WHERE id = ? AND amended_plan_id IS NULL AND report_json IS NOT NULL AND EXISTS (SELECT 1 FROM artifacts WHERE artifacts.id = ? AND kind = 'plan' AND conversation_id = research.conversation_id AND lineage_id = research.plan_lineage AND derived_from = research.plan_id)",
        )
        .run(planId, id, planId).changes,
    ) === 1
  );
}
