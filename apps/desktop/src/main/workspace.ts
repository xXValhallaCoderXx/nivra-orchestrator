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
