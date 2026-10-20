import { createHash } from "node:crypto";
import type { ChatResult, HistoryRecord } from "@nivra/domain";
import { str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";

/**
 * The workspace's records (D26), as plain functions over the open database: conversations now, their turns, tasks and
 * the versions of plans and briefs as they arrive. No Electron (D12), so `node --test` drives them directly.
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

export interface TurnRecord {
  id: string;
  conversationId: string;
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

/** Asks for an open turn to stop, keeping the first reason given. */
export function requestCancel(workspace: WorkspaceDb, turnId: string, reason: CancelReason): boolean {
  return Number(workspace.db.prepare(`UPDATE run_links SET cancel_requested = 1, cancel_reason = COALESCE(cancel_reason, ?) WHERE id = ? AND status IN ${OPEN}`).run(reason, turnId).changes) === 1;
}

/** Takes back a stop Nivra asked for and couldn't carry out, so the turn's end isn't later put down to it. */
export function withdrawCancel(workspace: WorkspaceDb, turnId: string, reason: CancelReason): void {
  workspace.db.prepare(`UPDATE run_links SET cancel_requested = 0, cancel_reason = NULL WHERE id = ? AND cancel_reason = ? AND status IN ${OPEN}`).run(turnId, reason);
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
    const row = db.prepare(`SELECT conversation_id FROM run_links WHERE id = ? AND status IN ${OPEN}`).get(turnId);
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

/** A conversation's turns, oldest first. */
export function turnsOf(workspace: WorkspaceDb, conversationId: string): TurnRecord[] {
  return workspace.db.prepare("SELECT * FROM run_links WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId).map(turnOf);
}

/** Turns still submitting or running: of one conversation, or of every conversation about one project. */
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

/**
 * Records an attempt at a task (D26): a run link bound to one brief version, which stays that version however the brief
 * is edited later. Nothing creates one yet: running tasks isn't available. Its run would be the one to start.
 */
export function insertAttempt(workspace: WorkspaceDb, attempt: { id: string; taskId: string; briefId: string; sessionId: string; targetId: string; status: TurnStatus; createdAt: string }): void {
  workspace.db
    .prepare("INSERT INTO run_links (id, task_id, brief_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, ?, ?, 'task', ?, ?, '[]', ?)")
    .run(attempt.id, attempt.taskId, attempt.briefId, attempt.sessionId, attempt.targetId, attempt.status, attempt.createdAt);
}

/** A task's attempts, oldest first, each with the brief version it is bound to. */
export function attemptsOf(workspace: WorkspaceDb, taskId: string): Array<{ id: string; briefId: string; status: TurnStatus; createdAt: string }> {
  return workspace.db
    .prepare("SELECT id, brief_id, status, created_at FROM run_links WHERE task_id = ? ORDER BY created_at, rowid")
    .all(taskId)
    .map((row) => ({ id: str(row["id"]), briefId: str(row["brief_id"]), status: str(row["status"]) as TurnStatus, createdAt: str(row["created_at"]) }));
}
