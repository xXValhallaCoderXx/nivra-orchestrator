import { createHash, randomUUID } from "node:crypto";
import { KNOWLEDGE_LIMITS, KnowledgeRecord, KnowledgeScope, KnowledgeSource } from "@nivra/domain";
import { refuseCredentials, type KnownSecrets } from "./protect.ts";
import { num, str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";

/** Host-owned selected outcomes. The table never holds an old statement after edit or forget. */
export interface NewKnowledge {
  scope: KnowledgeScope;
  projectId: string | null;
  kind: KnowledgeRecord["kind"];
  statement: string;
  origin: KnowledgeRecord["origin"];
  source: KnowledgeSource;
}

export interface KnowledgeWrite {
  operationId: string;
  expectedEpoch: number;
  known: KnownSecrets;
  at?: string;
  sessionId?: string;
}

const CHANGED = "The retained knowledge changed since this action was prepared, so nothing was saved. Refresh the companion, then try again.";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fromRow = (row: Row): KnowledgeRecord => KnowledgeRecord.parse({
  id: str(row["id"]), scope: { kind: str(row["scope_kind"]), id: str(row["scope_id"]) }, projectId: strOrNull(row["project_id"]),
  kind: str(row["kind"]), statement: strOrNull(row["statement"]), origin: str(row["origin"]), source: JSON.parse(str(row["source_json"])),
  revision: num(row["revision"]), state: str(row["state"]), createdAt: str(row["created_at"]), updatedAt: str(row["updated_at"]),
});

export function knowledgeEpoch(workspace: WorkspaceDb): number {
  return num(workspace.db.prepare("SELECT epoch FROM knowledge_state WHERE singleton = 1").get()?.["epoch"] ?? 0);
}

export function getKnowledge(workspace: WorkspaceDb, id: string): KnowledgeRecord | null {
  const row = workspace.db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id);
  return row ? fromRow(row) : null;
}

/** Exact scope only. Inactive rows are shown for correction; a forgotten statement never returns. */
export function listKnowledge(workspace: WorkspaceDb, scope: KnowledgeScope, options: { activeOnly?: boolean; includeForgotten?: boolean } = {}): KnowledgeRecord[] {
  const checked = KnowledgeScope.parse(scope);
  return workspace.db.prepare(`SELECT * FROM knowledge WHERE scope_kind = ? AND scope_id = ?${options.activeOnly ? " AND state = 'active'" : options.includeForgotten ? "" : " AND state <> 'forgotten'"} ORDER BY updated_at DESC, id`).all(checked.kind, checked.id).map(fromRow);
}

function cleanStatement(statement: string, known: KnownSecrets): string {
  const text = statement.trim();
  if (!text || text.length > KNOWLEDGE_LIMITS.statementChars) throw new Error(`A retained note needs between 1 and ${KNOWLEDGE_LIMITS.statementChars} characters. Shorten its wording, then save again.`);
  refuseCredentials("The retained note", text, known);
  return text;
}

function replay(workspace: WorkspaceDb, operationId: string, fingerprint: string): KnowledgeRecord | null {
  const row = workspace.db.prepare("SELECT fingerprint, knowledge_id FROM knowledge_actions WHERE id = ?").get(operationId);
  if (!row) return null;
  if (str(row["fingerprint"]) !== fingerprint) throw new Error("This save action was already used for different wording, so nothing was saved. Refresh the companion, then try again.");
  const found = getKnowledge(workspace, str(row["knowledge_id"]));
  if (!found) throw new Error(CHANGED);
  return found;
}

function checkEpoch(workspace: WorkspaceDb, expected: number): void {
  if (knowledgeEpoch(workspace) !== expected) throw new Error(CHANGED);
}

function recordAction(workspace: WorkspaceDb, options: KnowledgeWrite, fingerprint: string, id: string, at: string): void {
  workspace.db.prepare("INSERT INTO knowledge_actions (id, fingerprint, knowledge_id, created_at) VALUES (?, ?, ?, ?)").run(options.operationId, fingerprint, id, at);
  workspace.db.prepare("UPDATE knowledge_state SET epoch = epoch + 1 WHERE singleton = 1").run();
}

/** Scope/source validation belongs to the host context assembler; this validates shape, credentials and write races. */
export function saveKnowledge(workspace: WorkspaceDb, input: NewKnowledge, options: KnowledgeWrite): KnowledgeRecord {
  const statement = cleanStatement(input.statement, options.known);
  const at = options.at ?? new Date().toISOString();
  const checked = KnowledgeRecord.parse({ ...input, statement, id: randomUUID(), revision: 1, state: "active", createdAt: at, updatedAt: at });
  refuseCredentials("The retained note's source", JSON.stringify(checked.source), options.known);
  if (checked.origin === "validated-observation" && (checked.kind !== "observation" || checked.source.kind === "user")) throw new Error("A repository observation needs checked source evidence before it can be retained. Keep it as a proposal, then check its source.");
  const fingerprint = hash(["save", input.scope, input.projectId, input.kind, statement, input.origin, input.source]);
  return workspace.tx((db) => {
    const repeated = replay(workspace, options.operationId, fingerprint);
    if (repeated) return repeated;
    checkEpoch(workspace, options.expectedEpoch);
    const duplicate = db.prepare("SELECT * FROM knowledge WHERE scope_kind = ? AND scope_id = ? AND kind = ? AND origin = ? AND statement = ? AND state = 'active' AND project_id IS ?").get(checked.scope.kind, checked.scope.id, checked.kind, checked.origin, statement, checked.projectId);
    if (duplicate) {
      const existing = fromRow(duplicate);
      recordAction(workspace, options, fingerprint, existing.id, at);
      return existing;
    }
    const total = num(db.prepare("SELECT COUNT(*) AS n FROM knowledge WHERE scope_kind = ? AND scope_id = ? AND state <> 'forgotten'").get(checked.scope.kind, checked.scope.id)?.["n"]);
    if (total >= KNOWLEDGE_LIMITS.recordsPerScope) throw new Error("This scope has too many retained notes. Forget one you no longer need, then save this one.");
    db.prepare("INSERT INTO knowledge (id, scope_kind, scope_id, project_id, kind, statement, origin, source_json, revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)").run(checked.id, checked.scope.kind, checked.scope.id, checked.projectId, checked.kind, statement, checked.origin, JSON.stringify(checked.source), at, at);
    recordAction(workspace, options, fingerprint, checked.id, at);
    return getKnowledge(workspace, checked.id)!;
  });
}

export function editKnowledge(workspace: WorkspaceDb, id: string, revision: number, statement: string, options: KnowledgeWrite): KnowledgeRecord {
  const text = cleanStatement(statement, options.known);
  const fingerprint = hash(["edit", id, revision, text]);
  return workspace.tx((db) => {
    const repeated = replay(workspace, options.operationId, fingerprint);
    if (repeated) return repeated;
    checkEpoch(workspace, options.expectedEpoch);
    const before = getKnowledge(workspace, id);
    if (!before || before.revision !== revision || before.state === "forgotten") throw new Error(CHANGED);
    const at = options.at ?? new Date().toISOString();
    // The corrected statement is the person's own wording, not a fresh validation of old repository evidence.
    const source = KnowledgeSource.parse({ kind: "user", sessionId: options.sessionId ?? "knowledge-editor", requestId: options.operationId });
    db.prepare("UPDATE knowledge SET statement = ?, origin = 'user-stated', source_json = ?, state = 'active', revision = revision + 1, updated_at = ? WHERE id = ?").run(text, JSON.stringify(source), at, id);
    recordAction(workspace, options, fingerprint, id, at);
    return getKnowledge(workspace, id)!;
  });
}

export function forgetKnowledge(workspace: WorkspaceDb, id: string, revision: number, options: KnowledgeWrite): KnowledgeRecord {
  const fingerprint = hash(["forget", id, revision]);
  return workspace.tx((db) => {
    const repeated = replay(workspace, options.operationId, fingerprint);
    if (repeated) return repeated;
    checkEpoch(workspace, options.expectedEpoch);
    const before = getKnowledge(workspace, id);
    if (!before || before.revision !== revision) throw new Error(CHANGED);
    const at = options.at ?? new Date().toISOString();
    db.prepare("UPDATE knowledge SET statement = NULL, state = 'forgotten', revision = revision + 1, updated_at = ? WHERE id = ?").run(at, id);
    recordAction(workspace, options, fingerprint, id, at);
    return getKnowledge(workspace, id)!;
  });
}

/** Lazily invalidate checked sources; no model, timer or observer is involved. */
export function invalidateKnowledgeSources(workspace: WorkspaceDb, current: (record: KnowledgeRecord) => boolean, at = new Date().toISOString()): number {
  return workspace.tx((db) => {
    const rows = db.prepare("SELECT * FROM knowledge WHERE state = 'active'").all().map(fromRow);
    let changed = 0;
    for (const record of rows) {
      if (current(record)) continue;
      db.prepare("UPDATE knowledge SET state = 'stale', revision = revision + 1, updated_at = ? WHERE id = ?").run(at, record.id);
      changed++;
    }
    if (changed) db.prepare("UPDATE knowledge_state SET epoch = epoch + 1 WHERE singleton = 1").run();
    return changed;
  });
}

/** Exact user wording only: no model-authored paraphrase becomes a user-stated decision. */
export function validateKnowledgeQuote(message: string, quote: { start: number; end: number; text: string }, known: KnownSecrets): string {
  if (!Number.isInteger(quote.start) || !Number.isInteger(quote.end) || quote.start < 0 || quote.end <= quote.start || quote.end > message.length || message.slice(quote.start, quote.end) !== quote.text) throw new Error("This note doesn't quote the latest message exactly. Review its wording before retaining it.");
  const before = message.slice(0, quote.start).trimEnd();
  const after = message.slice(quote.end).trimStart();
  // Refuse clipped clauses/negations. Explicit semantic clarity and conflicts still require the host's decision.
  if ((before && !/[.!?]$/.test(before) && !/[\r\n]\s*$/.test(message.slice(0, quote.start))) || (after && !/[.!?]$/.test(quote.text.trim()) && !/^[\r\n]/.test(message.slice(quote.end)))) throw new Error("This note quotes only part of a statement. Review the complete wording before retaining it.");
  return cleanStatement(quote.text, known);
}
