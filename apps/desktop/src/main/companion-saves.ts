import { createHash } from "node:crypto";
import { str, type WorkspaceDb } from "./workspace-db.ts";

export const companionSaveFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Read inside the native save transaction. A reused id cannot save different content or recreate deleted work. */
export function companionSaveResult(workspace: WorkspaceDb, id: string, kind: "mission" | "task", fingerprint: string): string | null {
  const row = workspace.db.prepare("SELECT kind, fingerprint, result_id FROM companion_saves WHERE id = ?").get(id);
  if (!row) return null;
  if (str(row["kind"]) !== kind || str(row["fingerprint"]) !== fingerprint) throw new Error("This save action was already used for different work. Refresh the companion, then save again.");
  return str(row["result_id"]);
}

export function recordCompanionSave(workspace: WorkspaceDb, input: { id: string; kind: "mission" | "task"; fingerprint: string; resultId: string; scopeId: string | null; at: string }): void {
  workspace.db.prepare("INSERT INTO companion_saves (id, kind, fingerprint, result_id, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.id, input.kind, input.fingerprint, input.resultId, input.scopeId, input.at);
}
