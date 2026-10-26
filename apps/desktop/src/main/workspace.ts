import { createHash } from "node:crypto";
import type { ApplyView, ChatResult, HistoryRecord, ReviewPanel, ReviewReport } from "@nivra/domain";
import { str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";

/**
 * The workspace's records (D26), as plain functions over the open database: conversations, their turns, tasks, the
 * versions of plans and briefs, and reviews of plan versions (D31). No Electron (D12), so `node --test` drives them
 * directly.
 */

export interface ConversationRecord {
  id: string;
  kind: "general" | "project";
  /** The project it is about, fixed when it starts; null for a general conversation, which no repository reaches. */
  projectId: string | null;
  /** The project's label when it started, kept after the project is removed. */
  projectLabel: string | null;
  /** The engine its turns run on, fixed when it starts: `local` for a general conversation, else the project's (D17). */
  targetId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const conversationOf = (row: Row): ConversationRecord => ({
  id: str(row["id"]),
  kind: str(row["kind"]) === "project" ? "project" : "general",
  projectId: strOrNull(row["project_id"]),
  projectLabel: strOrNull(row["project_label"]),
  targetId: str(row["target_id"]),
  title: str(row["title"]),
  createdAt: str(row["created_at"]),
  updatedAt: str(row["updated_at"]),
});

export function insertConversation(workspace: WorkspaceDb, record: ConversationRecord): void {
  workspace.db
    .prepare("INSERT INTO conversations (id, kind, project_id, project_label, target_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(record.id, record.kind, record.projectId, record.projectLabel, record.targetId, record.title, record.createdAt, record.updatedAt);
}

/** Every conversation, the most recently active first. */
export function listConversations(workspace: WorkspaceDb): ConversationRecord[] {
  return workspace.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, id").all().map(conversationOf);
}

export function getConversation(workspace: WorkspaceDb, id: string): ConversationRecord | null {
  const row = workspace.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
  return row ? conversationOf(row) : null;
}

/**
 * A conversation's turn (D26): the run link the host saves before it asks an engine for anything, so a send whose
 * answer was lost can be found again on its own engine, and nothing is ever sent twice.
 * - `submitting`: saved; no run id yet. `homeId` is recorded just before the request is written, so a turn with none
 *   was never sent.
 * - `running`: the engine accepted it.
 * - `answered`, `failed`, `cancelled`, `interrupted`: how its run ended.
 * - `not-sent`: established that nothing reached an engine's store, so nothing reached a model.
 * - `unknown`: Nivra can't tell; it is never resent.
 */
export type TurnStatus = "submitting" | "running" | "answered" | "failed" | "cancelled" | "interrupted" | "not-sent" | "unknown";
export type CancelReason = "person" | "sharing" | "removal" | "deletion";
const OPEN = "('submitting', 'running')";

/**
 * A conversation's run link: a turn (`chat`) or a review of a plan version (`review`, D31). Both are sent, followed,
 * cancelled and stopped the same way; only how an ended run is read differs.
 */
export interface TurnRecord {
  id: string;
  conversationId: string;
  workflowId: string;
  /** The host session that started it: only that session's own submission is ever still in flight. */
  sessionId: string;
  targetId: string;
  /** The engine store it was sent to (`EngineInfo.homeId`), recorded just before sending. */
  homeId: string | null;
  runId: string | null;
  status: TurnStatus;
  cancelRequested: boolean;
  /** Who asked Nivra to stop it, when Nivra did; an engine's own cancellation has none. */
  cancelReason: CancelReason | null;
  errorKind: string | null;
  errorMessage: string | null;
  /** The preferences it was given, by id and revision (D21): never their text. */
  preferences: Array<{ id: string; revision: number }>;
  /** What history it was given: counts and the fingerprint, never text. */
  history: HistoryRecord | null;
  createdAt: string;
  settledAt: string | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: "person" | "assistant";
  text: string;
  /** An answer's whole reply, as the engine stored it and the host masked it again. */
  reply: ChatResult | null;
  turnId: string | null;
  createdAt: string;
}

const turnOf = (row: Row): TurnRecord => ({
  id: str(row["id"]),
  conversationId: str(row["conversation_id"]),
  workflowId: str(row["workflow_id"]),
  sessionId: str(row["session_id"]),
  targetId: str(row["target_id"]),
  homeId: strOrNull(row["home_id"]),
  runId: strOrNull(row["run_id"]),
  status: str(row["status"]) as TurnStatus,
  cancelRequested: Number(row["cancel_requested"]) === 1,
  cancelReason: strOrNull(row["cancel_reason"]) as CancelReason | null,
  errorKind: strOrNull(row["error_kind"]),
  errorMessage: strOrNull(row["error_message"]),
  preferences: JSON.parse(str(row["preferences_json"])) as TurnRecord["preferences"],
  history: row["history_json"] ? (JSON.parse(str(row["history_json"])) as HistoryRecord) : null,
  createdAt: str(row["created_at"]),
  settledAt: strOrNull(row["settled_at"]),
});

const messageOf = (row: Row): MessageRecord => ({
  id: str(row["id"]),
  conversationId: str(row["conversation_id"]),
  seq: Number(row["seq"]),
  role: str(row["role"]) === "assistant" ? "assistant" : "person",
  text: str(row["text"]),
  reply: row["reply_json"] ? (JSON.parse(str(row["reply_json"])) as ChatResult) : null,
  turnId: strOrNull(row["run_link_id"]),
  createdAt: str(row["created_at"]),
});

/** A conversation's title, from its first message: the first line, at most 60 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || "New conversation";
}

const nextSeq = (db: WorkspaceDb["db"], conversationId: string) => Number(db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?").get(conversationId)?.["seq"]);

/**
 * Starts a turn: its run link and the person's message, in one transaction. The first message names the conversation.
 * Refused (false) while the conversation has a turn still open: one turn at a time, however quickly two arrive.
 */
export function insertTurn(
  workspace: WorkspaceDb,
  turn: Pick<TurnRecord, "id" | "conversationId" | "sessionId" | "targetId" | "preferences" | "history" | "createdAt">,
  message: { id: string; text: string },
): boolean {
  return workspace.tx((db) => {
    if (db.prepare(`SELECT 1 FROM run_links WHERE conversation_id = ? AND status IN ${OPEN}`).get(turn.conversationId)) return false;
    db.prepare("INSERT INTO run_links (id, conversation_id, session_id, workflow_id, target_id, status, preferences_json, history_json, created_at) VALUES (?, ?, ?, 'chat', ?, 'submitting', ?, ?, ?)").run(
      turn.id,
      turn.conversationId,
      turn.sessionId,
      turn.targetId,
      JSON.stringify(turn.preferences),
      turn.history ? JSON.stringify(turn.history) : null,
      turn.createdAt,
    );
    const seq = nextSeq(db, turn.conversationId);
    db.prepare("INSERT INTO messages (id, conversation_id, seq, role, text, run_link_id, created_at) VALUES (?, ?, ?, 'person', ?, ?, ?)").run(message.id, turn.conversationId, seq, message.text, turn.id, turn.createdAt);
    db.prepare("UPDATE conversations SET updated_at = ?, title = CASE WHEN ? THEN ? ELSE title END WHERE id = ?").run(turn.createdAt, seq === 1 ? 1 : 0, titleFrom(message.text), turn.conversationId);
    return true;
  });
}

/** Records the engine store a turn is about to be sent to. After this, and only after it, the request is written. */
export function setTurnHome(workspace: WorkspaceDb, turnId: string, homeId: string): boolean {
  return Number(workspace.db.prepare("UPDATE run_links SET home_id = ? WHERE id = ? AND status = 'submitting' AND home_id IS NULL").run(homeId, turnId).changes) === 1;
}

/** The engine accepted the turn as `runId`. */
export function recordRun(workspace: WorkspaceDb, turnId: string, runId: string): boolean {
  return Number(workspace.db.prepare("UPDATE run_links SET run_id = ?, status = 'running' WHERE id = ? AND status = 'submitting'").run(runId, turnId).changes) === 1;
}

/**
 * Asks for an open turn to stop, keeping the first reason given. Research is stopped only by `stopResearch`, with a
 * token (D37), so a research link is left as it is.
 */
export function requestCancel(workspace: WorkspaceDb, turnId: string, reason: CancelReason): boolean {
  return Number(workspace.db.prepare(`UPDATE run_links SET cancel_requested = 1, cancel_reason = COALESCE(cancel_reason, ?) WHERE id = ? AND workflow_id <> 'research' AND status IN ${OPEN}`).run(reason, turnId).changes) === 1;
}

/**
 * Takes back a stop Nivra asked for and couldn't carry out, so the turn's end isn't later put down to it. A research
 * stop is withdrawn only by `withdrawStop`, with its token, so a research link is left as it is.
 */
export function withdrawCancel(workspace: WorkspaceDb, turnId: string, reason: CancelReason): void {
  workspace.db.prepare(`UPDATE run_links SET cancel_requested = 0, cancel_reason = NULL WHERE id = ? AND workflow_id <> 'research' AND cancel_reason = ? AND status IN ${OPEN}`).run(turnId, reason);
}

/** Ends an open turn without an answer. A turn that already ended keeps its first outcome. */
export function settleTurn(
  workspace: WorkspaceDb,
  turnId: string,
  outcome: { status: Exclude<TurnStatus, "submitting" | "running" | "answered">; errorKind?: string | null; errorMessage?: string | null },
  at: string,
): boolean {
  return (
    Number(
      workspace.db
        .prepare(`UPDATE run_links SET status = ?, error_kind = ?, error_message = ?, settled_at = ? WHERE id = ? AND status IN ${OPEN}`)
        .run(outcome.status, outcome.errorKind ?? null, outcome.errorMessage ?? null, at, turnId).changes,
    ) === 1
  );
}

/**
 * Ends an open turn with its answer, in one transaction: the answer once, whatever calls this twice, and nothing for a
 * turn or conversation deleted meanwhile.
 */
export function projectAnswer(workspace: WorkspaceDb, turnId: string, answer: { id: string; text: string; reply: ChatResult; createdAt: string }): boolean {
  return workspace.tx((db) => {
    const row = db.prepare(`SELECT conversation_id FROM run_links WHERE id = ? AND workflow_id = 'chat' AND status IN ${OPEN}`).get(turnId);
    if (!row) return false;
    const conversationId = str(row["conversation_id"]);
    db.prepare("INSERT INTO messages (id, conversation_id, seq, role, text, reply_json, run_link_id, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)").run(
      answer.id,
      conversationId,
      nextSeq(db, conversationId),
      answer.text,
      JSON.stringify(answer.reply),
      turnId,
      answer.createdAt,
    );
    db.prepare("UPDATE run_links SET status = 'answered', settled_at = ? WHERE id = ?").run(answer.createdAt, turnId);
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(answer.createdAt, conversationId);
    return true;
  });
}

export function getTurn(workspace: WorkspaceDb, turnId: string): TurnRecord | null {
  const row = workspace.db.prepare("SELECT * FROM run_links WHERE id = ?").get(turnId);
  return row ? turnOf(row) : null;
}

export function turnByRun(workspace: WorkspaceDb, runId: string): TurnRecord | null {
  const row = workspace.db.prepare("SELECT * FROM run_links WHERE run_id = ?").get(runId);
  return row ? turnOf(row) : null;
}

/** A conversation's turns, oldest first: its messages' run links, never its reviews. */
export function turnsOf(workspace: WorkspaceDb, conversationId: string): TurnRecord[] {
  return workspace.db.prepare("SELECT * FROM run_links WHERE conversation_id = ? AND workflow_id = 'chat' ORDER BY created_at, rowid").all(conversationId).map(turnOf);
}

/**
 * Run links still submitting or running, turns and reviews alike: of one conversation, or of every conversation about
 * one project. Everything that stops a conversation's work (a cancel, a deletion, consent withdrawn) goes through this.
 */
export function openTurns(workspace: WorkspaceDb, of: { conversationId: string } | { projectId: string }): TurnRecord[] {
  const rows =
    "conversationId" in of
      ? workspace.db.prepare(`SELECT * FROM run_links WHERE conversation_id = ? AND status IN ${OPEN} ORDER BY rowid`).all(of.conversationId)
      : workspace.db
          .prepare(`SELECT run_links.* FROM run_links JOIN conversations ON conversations.id = run_links.conversation_id WHERE conversations.project_id = ? AND run_links.status IN ${OPEN} ORDER BY run_links.rowid`)
          .all(of.projectId);
  return rows.map(turnOf);
}

/** A conversation's messages, in order. */
export function messagesOf(workspace: WorkspaceDb, conversationId: string): MessageRecord[] {
  return workspace.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId).map(messageOf);
}

/**
 * Deletes a conversation with its turns, messages and plans, then writes the WAL back, so the space they used, already
 * overwritten, holds no copy. Text copied into a task's brief stays with the task.
 */
export function deleteConversation(workspace: WorkspaceDb, conversationId: string): boolean {
  const deleted = Number(workspace.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId).changes) === 1;
  workspace.checkpoint();
  return deleted;
}

/** One immutable version of a plan or a brief (D26). An edit is a new version in the same lineage. */
export interface ArtifactRecord {
  id: string;
  kind: "plan" | "brief";
  lineageId: string;
  version: number;
  content: unknown;
  sha256: string;
  conversationId: string | null;
  taskId: string | null;
  messageId: string | null;
  runLinkId: string | null;
  derivedFrom: string | null;
  createdAt: string;
}

const artifactOf = (row: Row): ArtifactRecord => ({
  id: str(row["id"]),
  kind: str(row["kind"]) === "brief" ? "brief" : "plan",
  lineageId: str(row["lineage_id"]),
  version: Number(row["version"]),
  content: JSON.parse(str(row["content_json"])),
  sha256: str(row["sha256"]),
  conversationId: strOrNull(row["conversation_id"]),
  taskId: strOrNull(row["task_id"]),
  messageId: strOrNull(row["message_id"]),
  runLinkId: strOrNull(row["run_link_id"]),
  derivedFrom: strOrNull(row["derived_from"]),
  createdAt: str(row["created_at"]),
});

/**
 * Adds the next version to a lineage, in one transaction. With `after`, only when the latest version is still that one,
 * so an edit made from an older version never lands on top of a newer one (null then).
 */
export function insertArtifact(
  workspace: WorkspaceDb,
  artifact: Omit<ArtifactRecord, "version" | "sha256">,
  after?: number,
): ArtifactRecord | null {
  return workspace.tx((db) => {
    const latest = Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE lineage_id = ?").get(artifact.lineageId)?.["v"]);
    if (after !== undefined && latest !== after) return null;
    const json = JSON.stringify(artifact.content);
    const record: ArtifactRecord = { ...artifact, version: latest + 1, sha256: createHash("sha256").update(json).digest("hex") };
    db.prepare(
      "INSERT INTO artifacts (id, kind, lineage_id, version, content_json, sha256, conversation_id, task_id, message_id, run_link_id, derived_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(record.id, record.kind, record.lineageId, record.version, json, record.sha256, record.conversationId, record.taskId, record.messageId, record.runLinkId, record.derivedFrom, record.createdAt);
    return record;
  });
}

export function getArtifact(workspace: WorkspaceDb, id: string): ArtifactRecord | null {
  const row = workspace.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
  return row ? artifactOf(row) : null;
}

/** A lineage's versions, oldest first. */
export function versionsOf(workspace: WorkspaceDb, lineageId: string): ArtifactRecord[] {
  return workspace.db.prepare("SELECT * FROM artifacts WHERE lineage_id = ? ORDER BY version").all(lineageId).map(artifactOf);
}

/** A conversation's plans, every version. */
export function plansOf(workspace: WorkspaceDb, conversationId: string): ArtifactRecord[] {
  return workspace.db.prepare("SELECT * FROM artifacts WHERE kind = 'plan' AND conversation_id = ? ORDER BY created_at, version").all(conversationId).map(artifactOf);
}

export interface TaskRecord {
  id: string;
  title: string;
  projectId: string | null;
  state: "draft" | "ready" | "active" | "review" | "completed";
  /** Raised by every change to the task or its brief, so a change made from an older view is refused. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

const taskOf = (row: Row): TaskRecord => ({
  id: str(row["id"]),
  title: str(row["title"]),
  projectId: strOrNull(row["project_id"]),
  state: str(row["state"]) as TaskRecord["state"],
  revision: Number(row["revision"]),
  createdAt: str(row["created_at"]),
  updatedAt: str(row["updated_at"]),
});

/** Creates a task with its first brief, in one transaction. A brief's lineage is its task's id. */
export function insertTask(workspace: WorkspaceDb, task: Omit<TaskRecord, "revision" | "state">, brief: { id: string; content: unknown; derivedFrom: string | null }): void {
  workspace.tx((db) => {
    db.prepare("INSERT INTO tasks (id, title, project_id, state, revision, created_at, updated_at) VALUES (?, ?, ?, 'draft', 1, ?, ?)").run(task.id, task.title, task.projectId, task.createdAt, task.updatedAt);
    insertArtifact(workspace, { id: brief.id, kind: "brief", lineageId: task.id, content: brief.content, conversationId: null, taskId: task.id, messageId: null, runLinkId: null, derivedFrom: brief.derivedFrom, createdAt: task.createdAt });
  });
}

/** Changes a task, only from the revision it was read at; false when it changed meanwhile or is gone. */
export function updateTask(workspace: WorkspaceDb, taskId: string, revision: number, change: Partial<Pick<TaskRecord, "title" | "projectId" | "state">>, at: string): boolean {
  const current = getTask(workspace, taskId);
  if (!current || current.revision !== revision) return false;
  const next = { ...current, ...change };
  return (
    Number(
      workspace.db
        .prepare("UPDATE tasks SET title = ?, project_id = ?, state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
        .run(next.title, next.projectId, next.state, at, taskId, revision).changes,
    ) === 1
  );
}

export function getTask(workspace: WorkspaceDb, taskId: string): TaskRecord | null {
  const row = workspace.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  return row ? taskOf(row) : null;
}

/** Every task, the most recently changed first. */
export function listTasks(workspace: WorkspaceDb): TaskRecord[] {
  return workspace.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC, id").all().map(taskOf);
}

/** Deletes a task with its briefs and attempts. */
export function deleteTask(workspace: WorkspaceDb, taskId: string): boolean {
  const deleted = Number(workspace.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId).changes) === 1;
  workspace.checkpoint();
  return deleted;
}

/** One run of a task (D26, D39): a run link bound to one brief version, and how its run went. */
export interface AttemptRecord {
  /** The run link's id, sent as the request id. */
  id: string;
  taskId: string;
  briefId: string;
  sessionId: string;
  /** The engine it runs on, fixed when it starts: its project's (D17). */
  targetId: string;
  homeId: string | null;
  runId: string | null;
  status: TurnStatus;
  cancelRequested: boolean;
  cancelReason: CancelReason | null;
  errorKind: string | null;
  errorMessage: string | null;
  createdAt: string;
  settledAt: string | null;
}

const attemptOf = (row: Row): AttemptRecord => ({
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
  createdAt: str(row["created_at"]),
  settledAt: strOrNull(row["settled_at"]),
});

/**
 * Records an attempt at a task (D26): a run link bound to one brief version, which stays that version however the brief
 * is edited later. Its id is the request id, saved before the request is sent. Refused (false) while any task's attempt
 * is still open: one task runs at a time (D39), however quickly two arrive.
 */
export function insertAttempt(workspace: WorkspaceDb, attempt: { id: string; taskId: string; briefId: string; sessionId: string; targetId: string; status?: TurnStatus; createdAt: string }): boolean {
  const status = attempt.status ?? "submitting";
  return workspace.tx((db) => {
    if ((status === "submitting" || status === "running") && db.prepare(`SELECT 1 FROM run_links WHERE workflow_id = 'task' AND status IN ${OPEN}`).get()) return false;
    db.prepare("INSERT INTO run_links (id, task_id, brief_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, ?, ?, 'task', ?, ?, '[]', ?)").run(
      attempt.id,
      attempt.taskId,
      attempt.briefId,
      attempt.sessionId,
      attempt.targetId,
      status,
      attempt.createdAt,
    );
    return true;
  });
}

export function getAttempt(workspace: WorkspaceDb, attemptId: string): AttemptRecord | null {
  const row = workspace.db.prepare("SELECT * FROM run_links WHERE id = ? AND workflow_id = 'task'").get(attemptId);
  return row ? attemptOf(row) : null;
}

/** A task's attempts, oldest first, each with the brief version it is bound to. */
export function attemptsOf(workspace: WorkspaceDb, taskId: string): AttemptRecord[] {
  return workspace.db.prepare("SELECT * FROM run_links WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map(attemptOf);
}

/** Every task's attempt still being sent or going: at most one, while one task runs at a time (D39). */
export function openAttempts(workspace: WorkspaceDb): AttemptRecord[] {
  return workspace.db.prepare(`SELECT * FROM run_links WHERE workflow_id = 'task' AND status IN ${OPEN} ORDER BY rowid`).all().map(attemptOf);
}

/** Ends an open attempt, with its run's report kept by its engine (`answered`) or without; a first outcome is kept. */
export function settleAttempt(
  workspace: WorkspaceDb,
  attemptId: string,
  outcome: { status: Exclude<TurnStatus, "submitting" | "running">; errorKind?: string | null; errorMessage?: string | null },
  at: string,
): boolean {
  return (
    Number(
      workspace.db
        .prepare(`UPDATE run_links SET status = ?, error_kind = ?, error_message = ?, settled_at = ? WHERE id = ? AND workflow_id = 'task' AND status IN ${OPEN}`)
        .run(outcome.status, outcome.errorKind ?? null, outcome.errorMessage ?? null, at, attemptId).changes,
    ) === 1
  );
}

/** How an attempt's run ended, kept when it ended (D40), so its history shows without its engine. */
export interface AttemptOutcome {
  outcome: string;
  verified: boolean;
  proposalHash: string | null;
  baseline: string | null;
  at: string;
}

/**
 * What became of an attempt (D40), recorded apart: its run's outcome, the person's decision on its proposal, its apply
 * (the request id saved before it was sent, the engine's last answer about it, or the host's own note when the engine
 * couldn't say), and the person's acceptance of an applied change.
 */
export interface AttemptDecisionRecord {
  attemptId: string;
  outcome: AttemptOutcome | null;
  decision: "approved" | "rejected" | "revision" | null;
  decidedAt: string | null;
  revisionNote: string | null;
  apply: { requestId: string; view: ApplyView | null; readAt: string | null; note: string | null } | null;
  acceptedAt: string | null;
}

/** An attempt's record, or an empty one: nothing decided, nothing applied. */
export function attemptRecord(workspace: WorkspaceDb, attemptId: string): AttemptDecisionRecord {
  const row = workspace.db.prepare("SELECT * FROM attempt_records WHERE attempt_id = ?").get(attemptId);
  if (!row) return { attemptId, outcome: null, decision: null, decidedAt: null, revisionNote: null, apply: null, acceptedAt: null };
  const requestId = strOrNull(row["apply_request_id"]);
  return {
    attemptId,
    outcome: row["outcome"] === null ? null : { outcome: str(row["outcome"]), verified: Number(row["verified"]) === 1, proposalHash: strOrNull(row["proposal_hash"]), baseline: strOrNull(row["baseline"]), at: str(row["outcome_at"]) },
    decision: strOrNull(row["decision"]) as AttemptDecisionRecord["decision"],
    decidedAt: strOrNull(row["decided_at"]),
    revisionNote: strOrNull(row["revision_note"]),
    apply: requestId === null ? null : { requestId, view: row["apply_json"] ? (JSON.parse(str(row["apply_json"])) as ApplyView) : null, readAt: strOrNull(row["apply_read_at"]), note: strOrNull(row["apply_note"]) },
    acceptedAt: strOrNull(row["accepted_at"]),
  };
}

/** Keeps how an attempt's run ended, once: a later read never changes it. */
export function recordOutcome(workspace: WorkspaceDb, attemptId: string, outcome: Omit<AttemptOutcome, "at">, at: string): void {
  workspace.db
    .prepare(
      "INSERT INTO attempt_records (attempt_id, outcome, verified, proposal_hash, baseline, outcome_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (attempt_id) DO UPDATE SET outcome = excluded.outcome, verified = excluded.verified, proposal_hash = excluded.proposal_hash, baseline = excluded.baseline, outcome_at = excluded.outcome_at WHERE attempt_records.outcome IS NULL",
    )
    .run(attemptId, outcome.outcome, outcome.verified ? 1 : 0, outcome.proposalHash, outcome.baseline, at);
}

/**
 * Records the person's decision on an attempt's proposal, once: false when one is recorded already. An approval saves
 * its apply's request id with it, before anything is sent, and starts a new apply record.
 */
export function decide(workspace: WorkspaceDb, attemptId: string, decision: { kind: "approved"; requestId: string } | { kind: "rejected" } | { kind: "revision"; note: string }, at: string): boolean {
  return workspace.tx((db) => {
    db.prepare("INSERT INTO attempt_records (attempt_id) VALUES (?) ON CONFLICT (attempt_id) DO NOTHING").run(attemptId);
    const approved = decision.kind === "approved";
    const changed = db
      .prepare(
        `UPDATE attempt_records SET decision = ?, decided_at = ?, revision_note = ?${approved ? ", apply_request_id = ?, apply_json = NULL, apply_read_at = NULL, apply_note = NULL" : ""} WHERE attempt_id = ? AND decision IS NULL AND accepted_at IS NULL`,
      )
      .run(...([decision.kind, at, decision.kind === "revision" ? decision.note : null, ...(approved ? [decision.requestId] : []), attemptId] as string[]));
    return Number(changed.changes) === 1;
  });
}

/** The engine's answer about the apply sent as `requestId`, kept while that is still the attempt's apply. */
export function recordApply(workspace: WorkspaceDb, attemptId: string, requestId: string, view: ApplyView, at: string): boolean {
  return Number(workspace.db.prepare("UPDATE attempt_records SET apply_json = ?, apply_read_at = ?, apply_note = NULL WHERE attempt_id = ? AND apply_request_id = ?").run(JSON.stringify(view), at, attemptId, requestId).changes) === 1;
}

/** The host's own words about an apply its engine couldn't say anything about. */
export function noteApply(workspace: WorkspaceDb, attemptId: string, requestId: string, note: string): boolean {
  return Number(workspace.db.prepare("UPDATE attempt_records SET apply_note = ? WHERE attempt_id = ? AND apply_request_id = ?").run(note, attemptId, requestId).changes) === 1;
}

/**
 * Takes back an approval whose apply didn't change the checkout: one that never reached its engine, or whose result
 * the person dismissed. The apply stays on record; the person may decide again.
 */
export function withdrawDecision(workspace: WorkspaceDb, attemptId: string, requestId: string, note: string | null): boolean {
  return (
    Number(
      workspace.db
        .prepare("UPDATE attempt_records SET decision = NULL, decided_at = NULL, apply_note = COALESCE(?, apply_note) WHERE attempt_id = ? AND decision = 'approved' AND apply_request_id = ? AND accepted_at IS NULL")
        .run(note, attemptId, requestId).changes,
    ) === 1
  );
}

/** The person accepted the change its apply wrote. */
export function acceptChange(workspace: WorkspaceDb, attemptId: string, requestId: string, at: string): boolean {
  return Number(workspace.db.prepare("UPDATE attempt_records SET accepted_at = ? WHERE attempt_id = ? AND decision = 'approved' AND apply_request_id = ? AND accepted_at IS NULL").run(at, attemptId, requestId).changes) === 1;
}

/** Applies asked for whose engine hasn't said how they ended: followed by their request ids, never sent again. */
export function unsettledApplies(workspace: WorkspaceDb): Array<{ attemptId: string; requestId: string }> {
  return workspace.db
    .prepare("SELECT attempt_id, apply_request_id FROM attempt_records WHERE apply_request_id IS NOT NULL AND decision = 'approved' AND apply_note IS NULL AND (apply_json IS NULL OR json_extract(apply_json, '$.status') IN ('claimed', 'writing'))")
    .all()
    .map((row) => ({ attemptId: str(row["attempt_id"]), requestId: str(row["apply_request_id"]) }));
}

/** A review of one saved plan version (D31): what it was bound to, the report its engine saved, and its run link. */
export interface ReviewRecord {
  /** The run link's id, sent as the request id. */
  id: string;
  conversationId: string;
  planId: string;
  planLineage: string;
  planVersion: number;
  /** The plan version's own fingerprint, recorded only: the version is immutable. */
  planSha256: string;
  panel: ReviewPanel;
  packetDigest: string;
  preferencesDigest: string;
  /** Where the plan came from, frozen when the review was asked for: the project's label is kept after it is removed. */
  scope: { kind: "general" } | { kind: "project"; projectId: string; projectLabel: string | null; headAtStart: string | null };
  /** The engine's report, masked again, kept once when the review ended; null until then, or when it ended without one. */
  report: ReviewReport | null;
  reportedAt: string | null;
  createdAt: string;
  link: TurnRecord;
}

const REVIEW_COLUMNS =
  "reviews.id AS review_id, reviews.plan_id, reviews.plan_lineage, reviews.plan_version, reviews.plan_sha256, reviews.panel, reviews.packet_digest, reviews.preferences_digest, reviews.scope_kind, reviews.project_id AS scope_project_id, reviews.project_label AS scope_project_label, reviews.head_at_start, reviews.report_json, reviews.reported_at, run_links.*";

const reviewOf = (row: Row): ReviewRecord => {
  const link = turnOf(row);
  return {
    id: str(row["review_id"]),
    conversationId: link.conversationId,
    planId: str(row["plan_id"]),
    planLineage: str(row["plan_lineage"]),
    planVersion: Number(row["plan_version"]),
    planSha256: str(row["plan_sha256"]),
    panel: str(row["panel"]) === "single" ? "single" : "council",
    packetDigest: str(row["packet_digest"]),
    preferencesDigest: str(row["preferences_digest"]),
    scope:
      str(row["scope_kind"]) === "project"
        ? { kind: "project", projectId: str(row["scope_project_id"]), projectLabel: strOrNull(row["scope_project_label"]), headAtStart: strOrNull(row["head_at_start"]) }
        : { kind: "general" },
    report: row["report_json"] ? (JSON.parse(str(row["report_json"])) as ReviewReport) : null,
    reportedAt: strOrNull(row["reported_at"]),
    createdAt: link.createdAt,
    link,
  };
};

/**
 * Starts a review (D31): its run link and what it is bound to, in one transaction, before anything is sent. Refused
 * (false) while the conversation has a turn or a review still open: one at a time, however quickly two arrive.
 */
export function insertReview(
  workspace: WorkspaceDb,
  review: Omit<ReviewRecord, "report" | "reportedAt" | "link">,
  link: Pick<TurnRecord, "sessionId" | "targetId" | "preferences">,
): boolean {
  return workspace.tx((db) => {
    if (db.prepare(`SELECT 1 FROM run_links WHERE conversation_id = ? AND status IN ${OPEN}`).get(review.conversationId)) return false;
    db.prepare("INSERT INTO run_links (id, conversation_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, ?, 'review', ?, 'submitting', ?, ?)").run(
      review.id,
      review.conversationId,
      link.sessionId,
      link.targetId,
      JSON.stringify(link.preferences),
      review.createdAt,
    );
    const project = review.scope.kind === "project" ? review.scope : null;
    db.prepare(
      "INSERT INTO reviews (id, conversation_id, plan_id, plan_lineage, plan_version, plan_sha256, panel, packet_digest, preferences_digest, scope_kind, project_id, project_label, head_at_start, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      review.id,
      review.conversationId,
      review.planId,
      review.planLineage,
      review.planVersion,
      review.planSha256,
      review.panel,
      review.packetDigest,
      review.preferencesDigest,
      review.scope.kind,
      project?.projectId ?? null,
      project?.projectLabel ?? null,
      project?.headAtStart ?? null,
      review.createdAt,
    );
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(review.createdAt, review.conversationId);
    return true;
  });
}

export function getReview(workspace: WorkspaceDb, id: string): ReviewRecord | null {
  const row = workspace.db.prepare(`SELECT ${REVIEW_COLUMNS} FROM reviews JOIN run_links ON run_links.id = reviews.id WHERE reviews.id = ?`).get(id);
  return row ? reviewOf(row) : null;
}

/** A conversation's reviews, oldest first. */
export function reviewsOf(workspace: WorkspaceDb, conversationId: string): ReviewRecord[] {
  return workspace.db
    .prepare(`SELECT ${REVIEW_COLUMNS} FROM reviews JOIN run_links ON run_links.id = reviews.id WHERE reviews.conversation_id = ? ORDER BY reviews.created_at, run_links.rowid`)
    .all(conversationId)
    .map(reviewOf);
}

/**
 * Ends an open review, in one transaction: its run link's outcome, and the report its engine saved, when there is one.
 * A complete report ends it as answered. A review that already ended keeps its first outcome and its first report, and
 * one deleted meanwhile gets nothing.
 */
export function settleReview(
  workspace: WorkspaceDb,
  id: string,
  outcome: { status: Exclude<TurnStatus, "submitting" | "running">; errorKind?: string | null; errorMessage?: string | null },
  report: ReviewReport | null,
  at: string,
): boolean {
  return workspace.tx((db) => {
    const settled = Number(
      db
        .prepare(`UPDATE run_links SET status = ?, error_kind = ?, error_message = ?, settled_at = ? WHERE id = ? AND workflow_id = 'review' AND status IN ${OPEN}`)
        .run(outcome.status, outcome.errorKind ?? null, outcome.errorMessage ?? null, at, id).changes,
    );
    if (settled !== 1) return false;
    if (report) db.prepare("UPDATE reviews SET report_json = ?, reported_at = ? WHERE id = ? AND report_json IS NULL").run(JSON.stringify(report), at, id);
    return true;
  });
}
