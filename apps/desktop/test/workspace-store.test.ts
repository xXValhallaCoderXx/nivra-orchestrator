import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import type { ReviewReport } from "@nivra/domain";
import {
  attemptsOf,
  deleteConversation,
  getArtifact,
  getConversation,
  getReview,
  getTurn,
  insertArtifact,
  insertAttempt,
  insertConversation,
  insertReview,
  insertTask,
  insertTurn,
  listConversations,
  messagesOf,
  openTurns,
  projectAnswer,
  recordOutcome,
  recordRun,
  reviewsOf,
  settleReview,
  settleTurn,
  turnsOf,
  versionsOf,
  type ConversationRecord,
} from "../src/main/workspace.ts";
import { classifyWorkspaceError, openWorkspace, WORKSPACE_MIGRATIONS, WorkspaceDb, type WorkspaceOpening } from "../src/main/workspace-db.ts";
import { acceptBuilds, environmentOf, insertPreparation, latestPreparation } from "../src/main/environment-store.ts";
import { setupOf } from "./fixtures/environment-recipe.ts";

const dirs: string[] = [];
const open: WorkspaceOpening[] = [];
after(() => {
  for (const opening of open) if (opening.state === "ready") opening.db.close();
  for (const dir of dirs) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "nivra workspace ü%# "));
  dirs.push(dir);
  return dir;
}

function opened(path: string, now?: () => number): WorkspaceOpening {
  const opening = openWorkspace(path, now);
  open.push(opening);
  return opening;
}

function ready(path: string) {
  const opening = opened(path);
  assert.equal(opening.state, "ready", opening.state === "unavailable" ? opening.reason : "");
  return opening as Extract<WorkspaceOpening, { state: "ready" }>;
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** What a recipe-driven preparation is started with (NIV-55), as the store keeps it. */
const SETUP = await setupOf();
const AT = "2026-10-20T10:00:00.000Z";
const general = (id = randomUUID()): ConversationRecord => ({ id, kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "New conversation", createdAt: AT, updatedAt: AT });

describe("the workspace database (D26)", () => {
  it("opens a new file with the schema, WAL, foreign keys, secure deletion and SQLite's exclusive lock", () => {
    const path = join(folder(), "workspace.db");
    const workspace = ready(path);
    assert.deepEqual([workspace.schemaVersion, workspace.notice], [WORKSPACE_MIGRATIONS.length, null]);
    assert.match(workspace.sqlite, /^3\.\d+\.\d+$/);
    const pragma = (name: string) => Object.values(workspace.db.db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    assert.deepEqual([pragma("journal_mode"), pragma("foreign_keys"), pragma("secure_delete"), pragma("locking_mode"), pragma("user_version")], ["wal", 1, 1, "exclusive", WORKSPACE_MIGRATIONS.length]);
    // The lock is held from the start: no shared-memory file is ever made.
    assert.equal(existsSync(`${path}-shm`), false);
  });

  it("refuses a second Nivra on the same file at once, saying so, and touches nothing", () => {
    const dir = folder();
    const path = join(dir, "workspace.db");
    const first = ready(path);
    insertConversation(first.db, general());
    const second = opened(path);
    assert.equal(second.state, "unavailable");
    assert.match(second.state === "unavailable" ? second.reason : "", /^Another copy of Nivra is using your history \(SQLite error 5\)/);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes("unreadable")), []);
    assert.equal(listConversations(first.db).length, 1);
  });

  it("keeps what it holds across a restart: closed, then opened again", () => {
    const path = join(folder(), "workspace.db");
    const first = ready(path);
    const record = general();
    insertConversation(first.db, record);
    first.db.close();
    const again = ready(path);
    assert.deepEqual(getConversation(again.db, record.id), record);
    assert.equal(listConversations(again.db).length, 1);
  });

  it("refuses a schema a newer Nivra wrote before changing anything, the journal mode included", () => {
    const dir = folder();
    const path = join(dir, "workspace.db");
    const newer = new DatabaseSync(path);
    newer.exec("CREATE TABLE later (x); PRAGMA user_version = 99;");
    newer.close();
    const before = sha(path);
    const opening = opened(path);
    assert.equal(opening.state, "unavailable");
    assert.match(opening.state === "unavailable" ? opening.reason : "", /^Your history was saved by a newer version of Nivra \(schema v99; this version knows v8\), so this version won't read or change it\./);
    assert.deepEqual([sha(path), readdirSync(dir).sort()], [before, ["workspace.db"]]);
  });

  it("keeps a corrupt file aside with its journal files, byte for byte, and starts a new one with a notice", () => {
    const dir = folder();
    const path = join(dir, "workspace.db");
    writeFileSync(path, "this was never a database, but it is long enough to be read as one: ".repeat(20));
    writeFileSync(`${path}-wal`, "a write-ahead log that belongs with it");
    writeFileSync(`${path}-journal`, "a rollback journal that belongs with it");
    const before = [sha(path), sha(`${path}-wal`), sha(`${path}-journal`)];
    const reopened = opened(path, () => 1_700_000_000_000);
    assert.equal(reopened.state, "ready");
    assert.match(reopened.state === "ready" ? (reopened.notice ?? "") : "", /^Nivra couldn't read its history file \(not a SQLite database\), so it kept it aside as workspace\.db\.unreadable-1700000000000, with its journal files, and started a new one\./);
    const aside = `${path}.unreadable-1700000000000`;
    assert.deepEqual([sha(aside), sha(`${aside}-wal`), sha(`${aside}-journal`)], before);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes("unreadable")).sort(), ["workspace.db.unreadable-1700000000000", "workspace.db.unreadable-1700000000000-journal", "workspace.db.unreadable-1700000000000-wal"]);
    assert.equal(reopened.state === "ready" ? listConversations(reopened.db).length : -1, 0);
  });

  it("keeps journal files with no database aside too, rather than letting SQLite discard them", () => {
    const dir = folder();
    const path = join(dir, "workspace.db");
    writeFileSync(`${path}-wal`, "a write-ahead log whose database is gone");
    const before = sha(`${path}-wal`);
    const opening = opened(path, () => 1_700_000_000_001);
    assert.match(opening.state === "ready" ? (opening.notice ?? "") : "", /\(journal files without a database\)/);
    assert.equal(sha(`${path}.unreadable-1700000000001-wal`), before);
    // An empty file is a new database, unless a journal beside it says it had content.
    const emptied = join(folder(), "workspace.db");
    writeFileSync(emptied, "");
    writeFileSync(`${emptied}-wal`, "a write-ahead log whose database was emptied");
    const again = opened(emptied, () => 1_700_000_000_004);
    assert.match(again.state === "ready" ? (again.notice ?? "") : "", /\(journal files without a database\)/);
    assert.equal(readFileSync(`${emptied}.unreadable-1700000000004-wal`, "utf8"), "a write-ahead log whose database was emptied");
  });

  /** A workspace whose session wrote one more conversation, then died before it could close: that row is only in the WAL. */
  function leftByACrash(path: string): void {
    const seed = ready(path);
    insertConversation(seed.db, general());
    seed.db.close();
    const died = spawnSync(process.execPath, [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(${JSON.stringify(path)}, { timeout: 0 });
       db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL;");
       db.prepare("INSERT INTO conversations (id, kind, project_id, project_label, target_id, title, created_at, updated_at) VALUES (?, 'general', NULL, NULL, 'local', 'Only in the WAL', ?, ?)").run("${randomUUID()}", "${AT}", "${AT}");
       process.kill(process.pid, "SIGKILL");`,
    ]);
    assert.deepEqual([died.signal, existsSync(`${path}-wal`)], ["SIGKILL", true]);
  }

  it("opens a workspace a session left a journal beside with every write it holds, and leaves nothing beside it", () => {
    const dir = folder();
    const path = join(dir, "workspace.db");
    leftByACrash(path);
    const workspace = ready(path);
    assert.deepEqual([workspace.notice, listConversations(workspace.db).length], [null, 2]);
    workspace.db.close();
    assert.deepEqual(readdirSync(dir), ["workspace.db"]);
  });

  it("keeps a damaged workspace a session left a journal beside exactly as it was found, its journal included", () => {
    const dir = folder();
    const path = join(dir, "workspace.db");
    leftByACrash(path);
    // The schema page damaged past its header, where only SQLite can see it; the row in the WAL is the newest write.
    const bytes = readFileSync(path);
    bytes.fill(0xab, 100, 4096);
    writeFileSync(path, bytes);
    const before = [sha(path), sha(`${path}-wal`)];
    const opening = opened(path, () => 1_700_000_000_003);
    assert.equal(opening.state, "ready", opening.state === "unavailable" ? opening.reason : "");
    assert.match(opening.state === "ready" ? (opening.notice ?? "") : "", /^Nivra couldn't read its history file \(SQLite error 11\), so it kept it aside as workspace\.db\.unreadable-1700000000003, with its journal files, and started a new one\./);
    const aside = `${path}.unreadable-1700000000003`;
    assert.deepEqual([sha(aside), sha(`${aside}-wal`)], before);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes("unreadable")).sort(), ["workspace.db.unreadable-1700000000003", "workspace.db.unreadable-1700000000003-wal"]);
  });

  it("keeps aside a database SQLite finds damaged past a good header, and starts again", () => {
    const dir = folder();
    const path = join(dir, "workspace.db");
    const good = new DatabaseSync(path);
    good.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
    good.close();
    // A valid header with the rest of the first page overwritten: SQLite reports it as malformed.
    const bytes = readFileSync(path);
    bytes.fill(0xab, 100, bytes.length);
    writeFileSync(path, bytes);
    const before = sha(path);
    const opening = opened(path, () => 1_700_000_000_002);
    assert.equal(opening.state, "ready", opening.state === "unavailable" ? opening.reason : "");
    assert.match(opening.state === "ready" ? (opening.notice ?? "") : "", /^Nivra couldn't read its history file \(SQLite error (11|26)\), so it kept it aside as workspace\.db\.unreadable-1700000000002 and started a new one\./);
    assert.equal(sha(`${path}.unreadable-1700000000002`), before);
  });

  it("leaves a folder it may not write alone, and says which folder (POSIX)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
    const dir = folder();
    chmodSync(dir, 0o500);
    const opening = opened(join(dir, "workspace.db"));
    assert.equal(opening.state, "unavailable");
    assert.match(opening.state === "unavailable" ? opening.reason : "", /^Nivra can't open its history in .+ \(EACCES\)\. Check that the folder exists and that you can write to it/);
    chmodSync(dir, 0o700);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("tells failures apart by SQLite's primary result code or the file system's code, never by their text", () => {
    const sqlite = (errcode: number) => Object.assign(new Error("whatever SQLite said"), { errcode });
    const cases: Array<[unknown, string]> = [
      [sqlite(11), "corrupt"],
      [sqlite(26), "corrupt"],
      [sqlite(5), "locked"],
      [sqlite(5 | (1 << 8)), "locked"],
      [sqlite(6), "locked"],
      [sqlite(3), "access"],
      [sqlite(8), "access"],
      [sqlite(14), "access"],
      [sqlite(23), "access"],
      [sqlite(10 | (1 << 8)), "disk"],
      [sqlite(13), "disk"],
      [sqlite(1), "other"],
      [Object.assign(new Error("no"), { code: "EACCES" }), "access"],
      [Object.assign(new Error("no"), { code: "ENOSPC" }), "disk"],
      [Object.assign(new Error("database disk image is malformed"), { code: "ENOENT" }), "other"],
    ];
    assert.deepEqual(cases.map(([error]) => classifyWorkspaceError(error).problem), cases.map(([, problem]) => problem));
  });

  it("enforces the record rules in the schema: a general conversation has no project, versions never change", () => {
    const workspace = ready(join(folder(), "workspace.db"));
    assert.throws(() => insertConversation(workspace.db, { ...general(), projectId: randomUUID() }), /CHECK constraint failed/);
    const db = workspace.db.db;
    const task = randomUUID();
    db.prepare("INSERT INTO tasks (id, title, project_id, state, revision, created_at, updated_at) VALUES (?, 'T', NULL, 'draft', 1, ?, ?)").run(task, AT, AT);
    const brief = randomUUID();
    db.prepare("INSERT INTO artifacts (id, kind, lineage_id, version, content_json, sha256, task_id, created_at) VALUES (?, 'brief', ?, 1, '{}', 'x', ?, ?)").run(brief, task, task, AT);
    assert.throws(() => db.prepare("UPDATE artifacts SET content_json = '{\"goal\":\"changed\"}' WHERE id = ?").run(brief), /artifact versions are immutable/);
    assert.throws(() => db.prepare("INSERT INTO artifacts (id, kind, lineage_id, version, content_json, sha256, task_id, created_at) VALUES (?, 'brief', ?, 1, '{}', 'y', ?, ?)").run(randomUUID(), task, task, AT), /UNIQUE constraint failed/);
  });

  it("keeps one question and at most one answer per turn, and deleting a conversation takes its turns and messages", () => {
    const workspace = ready(join(folder(), "workspace.db"));
    const record = general();
    insertConversation(workspace.db, record);
    const db = workspace.db.db;
    const turn = randomUUID();
    db.prepare("INSERT INTO run_links (id, conversation_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, 's', 'chat', 'local', 'submitting', '[]', ?)").run(turn, record.id, AT);
    const message = (seq: number, role: string) => db.prepare("INSERT INTO messages (id, conversation_id, seq, role, text, run_link_id, created_at) VALUES (?, ?, ?, ?, 'x', ?, ?)").run(randomUUID(), record.id, seq, role, turn, AT);
    message(1, "person");
    message(2, "assistant");
    assert.throws(() => message(3, "assistant"), /UNIQUE constraint failed/);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(record.id);
    const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
    assert.deepEqual([count("messages"), count("run_links")], [0, 0]);
  });

  it("creates its folder when it is missing", () => {
    const dir = join(folder(), "nested", "deeper");
    const workspace = ready(join(dir, "workspace.db"));
    assert.equal(workspace.schemaVersion, WORKSPACE_MIGRATIONS.length);
    mkdirSync(dir, { recursive: true });
  });
});

describe("a conversation's turns and messages (D26)", () => {
  const turnOf = (conversationId: string) => ({ id: randomUUID(), conversationId, sessionId: "s", targetId: "local", preferences: [], history: null, createdAt: AT });
  const reply = (text: string) => ({ kind: "general" as const, text, cutOff: false, context: { preferences: { revision: 0, digest: "d", records: [] }, history: { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "d" } }, finishedAt: AT });

  it("takes one turn at a time, projects an answer once, keeps a turn's first outcome, and names the conversation from its first message", () => {
    const workspace = ready(join(folder(), "workspace.db"));
    const record = general();
    insertConversation(workspace.db, record);
    const first = turnOf(record.id);
    assert.equal(insertTurn(workspace.db, first, { id: randomUUID(), text: "How should I stage\nthis refactor?" }), true);
    assert.equal(insertTurn(workspace.db, turnOf(record.id), { id: randomUUID(), text: "And another?" }), false, "one turn at a time");
    assert.equal(getConversation(workspace.db, record.id)?.title, "How should I stage");
    assert.equal(recordRun(workspace.db, first.id, randomUUID()), true);
    const answer = { id: randomUUID(), text: "In two steps.", reply: reply("In two steps."), createdAt: AT };
    assert.deepEqual([projectAnswer(workspace.db, first.id, answer), projectAnswer(workspace.db, first.id, { ...answer, id: randomUUID() })], [true, false]);
    assert.equal(settleTurn(workspace.db, first.id, { status: "interrupted" }, AT), false, "an answered turn keeps its outcome");
    assert.deepEqual([getTurn(workspace.db, first.id)?.status, messagesOf(workspace.db, record.id).map((m) => [m.seq, m.role])], ["answered", [[1, "person"], [2, "assistant"]]]);
    workspace.db.close();
    // After a restart: the same, with nothing added.
    const again = ready(workspace.db.path);
    assert.deepEqual(messagesOf(again.db, record.id).map((m) => m.text), ["How should I stage\nthis refactor?", "In two steps."]);
  });

  it("deletes a conversation's turns and messages, and leaves none of their text in the file", () => {
    const path = join(folder(), "workspace.db");
    const workspace = ready(path);
    const record = general();
    insertConversation(workspace.db, record);
    const canary = `nivra-deleted-canary-${randomUUID()}`;
    const turn = turnOf(record.id);
    insertTurn(workspace.db, turn, { id: randomUUID(), text: `Question ${canary}` });
    recordRun(workspace.db, turn.id, randomUUID());
    projectAnswer(workspace.db, turn.id, { id: randomUUID(), text: `Answer ${canary}`, reply: reply(`Answer ${canary}`), createdAt: AT });
    assert.ok(readFileSync(path).includes(canary) || readFileSync(`${path}-wal`).includes(canary), "the text was there");
    assert.equal(deleteConversation(workspace.db, record.id), true);
    const db = workspace.db.db;
    const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
    assert.deepEqual([count("conversations"), count("run_links"), count("messages")], [0, 0, 0]);
    const files = readdirSync(dirname(path)).filter((name) => name.startsWith("workspace.db"));
    assert.deepEqual(files.filter((name) => readFileSync(join(dirname(path), name)).includes(canary)), []);
  });
});

describe("tasks, brief versions and attempts (D26)", () => {
  it("keeps every brief version, adds one only on top of the latest, and binds an attempt to the version it was made with", () => {
    const workspace = ready(join(folder(), "workspace.db"));
    const taskId = randomUUID();
    const v1 = { id: randomUUID(), content: { goal: "First goal" }, derivedFrom: null };
    insertTask(workspace.db, { id: taskId, title: "Export", projectId: null, createdAt: AT, updatedAt: AT }, v1);
    insertAttempt(workspace.db, { id: randomUUID(), taskId, briefId: v1.id, sessionId: "s", targetId: "local", status: "not-sent", createdAt: AT });
    const brief = (goal: string) => ({ id: randomUUID(), kind: "brief" as const, lineageId: taskId, content: { goal }, conversationId: null, taskId, messageId: null, runLinkId: null, derivedFrom: v1.id, createdAt: AT });
    assert.equal(insertArtifact(workspace.db, brief("Second goal"), 1)?.version, 2);
    assert.equal(insertArtifact(workspace.db, brief("Made from version 1"), 1), null, "an edit from an older version never lands on a newer one");
    assert.deepEqual(versionsOf(workspace.db, taskId).map((v) => [v.version, (v.content as { goal: string }).goal]), [[1, "First goal"], [2, "Second goal"]]);
    const [attempt] = attemptsOf(workspace.db, taskId);
    assert.deepEqual([attempt?.briefId, (getArtifact(workspace.db, attempt!.briefId)?.content as { goal: string }).goal], [v1.id, "First goal"]);
  });

  it("counts a task's runs only as its attempts, never another run link it owns, such as a coaching (NIV-53)", () => {
    const workspace = ready(join(folder(), "workspace.db"));
    const taskId = randomUUID();
    const v1 = { id: randomUUID(), content: { goal: "First goal" }, derivedFrom: null };
    insertTask(workspace.db, { id: taskId, title: "Export", projectId: null, createdAt: AT, updatedAt: AT }, v1);
    const run = randomUUID();
    insertAttempt(workspace.db, { id: run, taskId, briefId: v1.id, sessionId: "s", targetId: "local", status: "answered", createdAt: AT });
    // A later run link the task owns that isn't a run of it, still going: the last attempt stays the run.
    workspace.db.db
      .prepare("INSERT INTO run_links (id, task_id, brief_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, ?, 's', 'coach', 'local', 'running', '[]', ?)")
      .run(randomUUID(), taskId, v1.id, "2026-10-20T11:00:00.000Z");
    assert.deepEqual(attemptsOf(workspace.db, taskId).map((attempt) => [attempt.id, attempt.status]), [[run, "answered"]]);
  });
});

describe("reviews of plan versions (D31)", () => {
  const project = (id = randomUUID(), projectId = randomUUID()): ConversationRecord => ({ id, kind: "project", projectId, projectLabel: "shop", targetId: "wsl:Ubuntu", title: "New conversation", createdAt: AT, updatedAt: AT });
  const planIn = (workspace: WorkspaceDb, conversationId: string, text: string, lineageId: string = randomUUID(), after?: number) =>
    insertArtifact(workspace, { id: randomUUID(), kind: "plan", lineageId, content: { text }, conversationId, taskId: null, messageId: null, runLinkId: null, derivedFrom: null, createdAt: AT }, after)!;
  const DIGEST = "a".repeat(64);
  const reviewOf = (conversation: ConversationRecord, plan: { id: string; lineageId: string; version: number; sha256: string }, id: string = randomUUID()) => ({
    id,
    conversationId: conversation.id,
    planId: plan.id,
    planLineage: plan.lineageId,
    planVersion: plan.version,
    planSha256: plan.sha256,
    panel: "council" as const,
    packetDigest: DIGEST,
    preferencesDigest: "b".repeat(64),
    scope: conversation.projectId ? { kind: "project" as const, projectId: conversation.projectId, projectLabel: conversation.projectLabel, headAtStart: "c".repeat(40) } : { kind: "general" as const },
    createdAt: AT,
  });
  const LINK = { sessionId: "s", targetId: "wsl:Ubuntu", preferences: [{ id: randomUUID(), revision: 3 }] };
  /** A report as the engine hands one back: only what the store needs to keep it whole. */
  const reportFor = (review: ReturnType<typeof reviewOf>, summary: string): ReviewReport => ({
    panel: review.panel,
    planId: review.planId,
    planVersion: review.planVersion,
    packetDigest: review.packetDigest,
    preferencesDigest: review.preferencesDigest,
    outcome: "complete",
    scope: { kind: "general" },
    packet: { textChars: 10, assumptions: 0, references: 0 },
    request: { runId: randomUUID(), clientRequestId: review.id },
    route: null,
    sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" },
    preferences: { revision: 0, digest: "d", records: [] },
    reviewers: [{ role: "architecture", summary, findings: [], assumptions: [], gaps: [], adjusted: { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 } }],
    synthesis: null,
    stages: [],
    usage: { inputTokens: null, outputTokens: null, calls: 3, reportedCalls: 0 },
    budget: {
      limits: { requests: 3, totalMs: 330_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 120_000 },
      used: { requests: 3, elapsedMs: 1, inputTokens: 1, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: 3, overrunTokens: 0 },
      stopped: null,
    },
    elapsedMs: 1,
    updatedAt: AT,
    finishedAt: AT,
  });
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "not refused";
  };

  it("keeps the released v1 schema as it was, and moves a v1 file to the current version with every row as it was", () => {
    // Migrations are append-only: v1's text is pinned, so a released version is never edited.
    assert.equal(createHash("sha256").update(WORKSPACE_MIGRATIONS[0]!).digest("hex"), "2a9a9cd0cc12393f6975907a3f954c998e9dba9e9e9d70119332c8d09cbcf9cb");
    const path = join(folder(), "workspace.db");
    // A v1 file, written as v1 wrote one: its schema alone, then rows through the same functions.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    raw.exec("BEGIN IMMEDIATE");
    raw.exec(WORKSPACE_MIGRATIONS[0]!);
    raw.exec("PRAGMA user_version = 1; COMMIT;");
    const v1 = new WorkspaceDb(path, raw);
    const chat = general();
    insertConversation(v1, chat);
    const answered = { id: randomUUID(), conversationId: chat.id, sessionId: "s", targetId: "local", preferences: [], history: null, createdAt: AT };
    insertTurn(v1, answered, { id: randomUUID(), text: "How do I stage this?" });
    recordRun(v1, answered.id, randomUUID());
    projectAnswer(v1, answered.id, { id: randomUUID(), text: "In two steps.", reply: { kind: "general", text: "In two steps.", cutOff: false, context: { preferences: { revision: 0, digest: "d", records: [] }, history: { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "d" } }, finishedAt: AT }, createdAt: AT });
    const open = { ...answered, id: randomUUID() };
    insertTurn(v1, open, { id: randomUUID(), text: "And the next step?" });
    const plan = planIn(v1, chat.id, "Stage it in two steps.");
    const taskId = randomUUID();
    const brief = randomUUID();
    insertTask(v1, { id: taskId, title: "Stage", projectId: null, createdAt: AT, updatedAt: AT }, { id: brief, content: { goal: "Stage" }, derivedFrom: plan.id });
    insertAttempt(v1, { id: randomUUID(), taskId, briefId: brief, sessionId: "s", targetId: "local", status: "not-sent", createdAt: AT });
    const TABLES = ["conversations", "tasks", "artifacts", "run_links", "messages"];
    const dump = (db: DatabaseSync) => ({
      rows: TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      schema: db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND tbl_name IN ('conversations', 'tasks', 'artifacts', 'run_links', 'messages') AND name <> 'run_links_fixed' ORDER BY name").all(),
    });
    const before = dump(raw);
    assert.deepEqual(before.rows.map((rows) => rows.length), [1, 1, 2, 3, 3]);
    v1.close();

    const migrated = ready(path);
    assert.equal(migrated.schemaVersion, WORKSPACE_MIGRATIONS.length);
    assert.deepEqual(dump(migrated.db.db), before);
    assert.equal(Number(migrated.db.db.prepare("SELECT count(*) AS n FROM reviews").get()?.["n"]), 0);
    assert.equal(Number(migrated.db.db.prepare("SELECT count(*) AS n FROM research").get()?.["n"]), 0);
    assert.deepEqual(turnsOf(migrated.db, chat.id).map((turn) => [turn.id, turn.workflowId, turn.status]), [[answered.id, "chat", "answered"], [open.id, "chat", "submitting"]]);
    assert.deepEqual(openTurns(migrated.db, { conversationId: chat.id }).map((turn) => turn.id), [open.id]);
  });

  it("keeps the released v2 schema as it was, and moves a v2 file to v3 with every row as it was and no research yet", () => {
    // v2's text is pinned too, now that v3 follows it.
    assert.equal(createHash("sha256").update(WORKSPACE_MIGRATIONS[1]!).digest("hex"), "829d634378162a0bc4279bb301bf715ce2eab0c00bcc6fbcfd4aca5df4cba2d8");
    const path = join(folder(), "workspace.db");
    // A v2 file, written as v2 wrote one: its schema alone, then rows through the same functions.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    raw.exec("BEGIN IMMEDIATE");
    raw.exec(WORKSPACE_MIGRATIONS[0]!);
    raw.exec(WORKSPACE_MIGRATIONS[1]!);
    raw.exec("PRAGMA user_version = 2; COMMIT;");
    const v2 = new WorkspaceDb(path, raw);
    const conversation = project();
    insertConversation(v2, conversation);
    const plan = planIn(v2, conversation.id, "Rename the column in place.");
    const review = reviewOf(conversation, plan);
    assert.equal(insertReview(v2, review, LINK), true);
    const TABLES = ["conversations", "tasks", "artifacts", "run_links", "messages", "reviews"];
    const dump = (db: DatabaseSync) => ({
      rows: TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      schema: db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND tbl_name IN (${TABLES.map((table) => `'${table}'`).join(", ")}) ORDER BY name`).all(),
    });
    const before = dump(raw);
    assert.deepEqual(before.rows.map((rows) => rows.length), [1, 0, 1, 1, 0, 1]);
    v2.close();

    const migrated = ready(path);
    assert.equal(migrated.schemaVersion, WORKSPACE_MIGRATIONS.length);
    assert.deepEqual(dump(migrated.db.db), before);
    assert.equal(Number(migrated.db.db.prepare("SELECT count(*) AS n FROM research").get()?.["n"]), 0);
    assert.deepEqual(reviewsOf(migrated.db, conversation.id).map((row) => row.id), [review.id]);
  });

  it("binds a review to a review run and a plan version of its own conversation, one open run at a time, and never changes what it was bound to", () => {
    const workspace = ready(join(folder(), "workspace.db"));
    const db = workspace.db.db;
    const conversation = project();
    const other = general();
    insertConversation(workspace.db, conversation);
    insertConversation(workspace.db, other);
    const v1 = planIn(workspace.db, conversation.id, "Rename the column in place.");
    const v2 = planIn(workspace.db, conversation.id, "Add the new column first.", v1.lineageId, 1);
    const elsewhere = planIn(workspace.db, other.id, "Another conversation's plan.");
    const review = reviewOf(conversation, v1);
    assert.equal(insertReview(workspace.db, review, LINK), true);
    assert.equal(insertReview(workspace.db, reviewOf(conversation, v2), LINK), false, "one open run per conversation");
    assert.equal(insertTurn(workspace.db, { id: randomUUID(), conversationId: conversation.id, sessionId: "s", targetId: "wsl:Ubuntu", preferences: [], history: null, createdAt: AT }, { id: randomUUID(), text: "Meanwhile?" }), false, "a review holds the conversation as a turn does");
    // Every stop path sees it; the conversation's turns, and so its history, don't.
    assert.deepEqual([openTurns(workspace.db, { conversationId: conversation.id }).map((turn) => [turn.id, turn.workflowId]), turnsOf(workspace.db, conversation.id).length], [[[review.id, "review"]], 0]);
    assert.deepEqual(openTurns(workspace.db, { projectId: conversation.projectId! }).map((turn) => turn.id), [review.id]);
    const stored = getReview(workspace.db, review.id);
    assert.deepEqual(
      [stored?.planVersion, stored?.planSha256, stored?.scope, stored?.link.status, stored?.link.preferences, stored?.report],
      [1, v1.sha256, { kind: "project", projectId: conversation.projectId, projectLabel: "shop", headAtStart: "c".repeat(40) }, "submitting", LINK.preferences, null],
    );

    // What the triggers refuse, written past the functions.
    const link = (id: string, workflow: string, conversationId = conversation.id) =>
      db.prepare("INSERT INTO run_links (id, conversation_id, session_id, workflow_id, target_id, status, preferences_json, created_at) VALUES (?, ?, 's', ?, 'local', 'failed', '[]', ?)").run(id, conversationId, workflow, AT);
    const row = (values: ReturnType<typeof reviewOf>) =>
      db
        .prepare("INSERT INTO reviews (id, conversation_id, plan_id, plan_lineage, plan_version, plan_sha256, panel, packet_digest, preferences_digest, scope_kind, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'council', ?, ?, 'project', ?, ?)")
        .run(values.id, values.conversationId, values.planId, values.planLineage, values.planVersion, values.planSha256, values.packetDigest, values.preferencesDigest, conversation.projectId, AT);
    const BOUND = "a review is bound to a review run and to a plan version of its own conversation";
    const chatLink = randomUUID();
    link(chatLink, "chat");
    assert.equal(refusal(() => row(reviewOf(conversation, v2, chatLink))), BOUND, "a turn's run");
    const reviewLink = () => {
      const id = randomUUID();
      link(id, "review");
      return id;
    };
    assert.equal(refusal(() => row({ ...reviewOf(conversation, elsewhere, reviewLink()) })), BOUND, "another conversation's plan");
    assert.equal(refusal(() => row({ ...reviewOf(conversation, v2, reviewLink()), planVersion: 1 })), BOUND, "a version the plan isn't");
    assert.equal(refusal(() => row({ ...reviewOf(conversation, v2, reviewLink()), planSha256: v1.sha256 })), BOUND, "another version's fingerprint");
    const FROZEN = "a review never changes what it was bound to, and keeps its first report";
    assert.equal(refusal(() => db.prepare("UPDATE reviews SET packet_digest = ? WHERE id = ?").run("e".repeat(64), review.id)), FROZEN);
    assert.equal(refusal(() => db.prepare("UPDATE reviews SET plan_version = 2, plan_id = ?, plan_sha256 = ? WHERE id = ?").run(v2.id, v2.sha256, review.id)), FROZEN);
    assert.equal(refusal(() => db.prepare("UPDATE run_links SET workflow_id = 'chat' WHERE id = ?").run(review.id)), "a run link keeps its workflow and its owner");
    assert.equal(refusal(() => db.prepare("UPDATE run_links SET conversation_id = ? WHERE id = ?").run(other.id, review.id)), "a run link keeps its workflow and its owner");

    // It ends once, with its report; a turn's answer never lands on it, and the report is kept as it first was.
    assert.equal(projectAnswer(workspace.db, review.id, { id: randomUUID(), text: "x", reply: { kind: "general", text: "x", cutOff: false, context: { preferences: { revision: 0, digest: "d", records: [] }, history: { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "d" } }, finishedAt: AT }, createdAt: AT }), false);
    const report = reportFor(review, "Nothing material.");
    assert.equal(settleReview(workspace.db, review.id, { status: "answered" }, report, AT), true);
    assert.equal(settleReview(workspace.db, review.id, { status: "failed", errorMessage: "late" }, reportFor(review, "A later report."), AT), false);
    assert.equal(settleTurn(workspace.db, review.id, { status: "interrupted" }, AT), false);
    assert.equal(refusal(() => db.prepare("UPDATE reviews SET report_json = '{}' WHERE id = ?").run(review.id)), FROZEN);
    const ended = getReview(workspace.db, review.id);
    assert.deepEqual([ended?.link.status, ended?.link.errorMessage, ended?.reportedAt, ended?.report], ["answered", null, AT, report]);
    // The next one can start now, on the newer version; the first is still bound to v1.
    const again = reviewOf(conversation, v2);
    assert.equal(insertReview(workspace.db, again, LINK), true);
    assert.deepEqual(reviewsOf(workspace.db, conversation.id).map((r) => [r.planVersion, r.link.status]), [[1, "answered"], [2, "submitting"]]);
  });

  it("deletes a conversation's reviews with it, and leaves none of a report's text in the file", () => {
    const path = join(folder(), "workspace.db");
    const workspace = ready(path);
    const conversation = general();
    insertConversation(workspace.db, conversation);
    const plan = planIn(workspace.db, conversation.id, "Rename the column in place.");
    const review = reviewOf(conversation, plan);
    insertReview(workspace.db, review, LINK);
    const canary = `nivra-review-canary-${randomUUID()}`;
    settleReview(workspace.db, review.id, { status: "failed", errorKind: "malformed", errorMessage: "The risks review couldn't be used." }, reportFor(review, `Raised ${canary}`), AT);
    assert.ok(readFileSync(path).includes(canary) || readFileSync(`${path}-wal`).includes(canary), "the text was there");
    assert.equal(deleteConversation(workspace.db, conversation.id), true);
    const db = workspace.db.db;
    const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
    assert.deepEqual([count("reviews"), count("run_links"), count("artifacts")], [0, 0, 0]);
    const files = readdirSync(dirname(path)).filter((name) => name.startsWith("workspace.db"));
    assert.deepEqual(files.filter((name) => readFileSync(join(dirname(path), name)).includes(canary)), []);
  });
});

describe("coachings of tasks (NIV-53)", () => {
  it("moves a v6 file to v7 with every row as it was and no coaching yet, then takes one bound to a task's brief", () => {
    const path = join(folder(), "workspace.db");
    // A v6 file, written as v6 wrote one: its schema alone, then rows through the same functions.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    raw.exec("BEGIN IMMEDIATE");
    for (const migration of WORKSPACE_MIGRATIONS.slice(0, 6)) raw.exec(migration);
    raw.exec("PRAGMA user_version = 6; COMMIT;");
    const v6 = new WorkspaceDb(path, raw);
    const taskId = randomUUID();
    const brief = randomUUID();
    insertTask(v6, { id: taskId, title: "Stage", projectId: null, createdAt: AT, updatedAt: AT }, { id: brief, content: { goal: "Stage" }, derivedFrom: null });
    const attempt = randomUUID();
    insertAttempt(v6, { id: attempt, taskId, briefId: brief, sessionId: "s", targetId: "local", status: "answered", createdAt: AT });
    const TABLES = ["tasks", "artifacts", "run_links", "missions", "mission_versions", "mission_tasks"];
    const dump = (db: DatabaseSync) => ({
      rows: TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      schema: db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND tbl_name IN (${TABLES.map((table) => `'${table}'`).join(", ")}) ORDER BY name`).all(),
    });
    const before = dump(raw);
    assert.deepEqual(before.rows.map((rows) => rows.length), [1, 1, 1, 0, 0, 0]);
    v6.close();

    // On to the latest: v7, then v8 (NIV-55), which changes none of these tables.
    const migrated = ready(path);
    assert.equal(migrated.schemaVersion, WORKSPACE_MIGRATIONS.length);
    assert.deepEqual(dump(migrated.db.db), before);
    assert.equal(Number(migrated.db.db.prepare("SELECT count(*) AS n FROM coachings").get()?.["n"]), 0);
    // The task's runs are still its only attempts.
    assert.deepEqual(attemptsOf(migrated.db, taskId).map((one) => one.id), [attempt]);
  });
});

describe("an acceptance of missing builds (NIV-55)", () => {
  it("moves a v7 file to v8 with every environment row as it was and no acceptance yet, then takes one for the environment kept now", async () => {
    // v7's text is pinned too, now that v8 (the acceptance of missing builds, NIV-55) follows it.
    assert.equal(createHash("sha256").update(WORKSPACE_MIGRATIONS[6]!).digest("hex"), "9e430b4dd824bf2180bc1f2f93e6ed163c0877993fbd6c83dc4e3940c236e6aa");
    const path = join(folder(), "workspace.db");
    // A v7 file, written as v7 wrote one: its schema alone, then D41's rows as they were written.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    raw.exec("BEGIN IMMEDIATE");
    for (const migration of WORKSPACE_MIGRATIONS.slice(0, 7)) raw.exec(migration);
    raw.exec("PRAGMA user_version = 7; COMMIT;");
    const project = randomUUID();
    const preparation = randomUUID();
    raw.prepare("INSERT INTO preparations (id, project_id, session_id, target_id, status, spec_json, preview, report_json, reported_at, created_at, settled_at) VALUES (?, ?, 's', 'local', 'answered', '{\"filters\":[]}', 'x', '{}', ?, ?, ?)").run(preparation, project, AT, AT, AT);
    raw.prepare("INSERT INTO environments (project_id, spec_json, prepared_json, prepared_by, updated_at) VALUES (?, '{\"filters\":[]}', '{\"image\":\"img-d41\"}', ?, ?)").run(project, preparation, AT);
    const COLUMNS = "project_id, spec_json, prepared_json, prepared_by, updated_at";
    const before = [raw.prepare(`SELECT ${COLUMNS} FROM environments ORDER BY rowid`).all(), raw.prepare("SELECT * FROM preparations ORDER BY rowid").all()];
    raw.close();

    const migrated = ready(path);
    assert.equal(migrated.schemaVersion, 8);
    const db = migrated.db.db;
    assert.deepEqual([db.prepare(`SELECT ${COLUMNS} FROM environments ORDER BY rowid`).all(), db.prepare("SELECT * FROM preparations ORDER BY rowid").all()], before);
    assert.deepEqual(db.prepare("SELECT builds_json FROM environments").all().map((row) => row["builds_json"]), [null]);
    // D41's environment reads as legacy, and takes no acceptance: there is no verified record to bind one to.
    assert.equal(environmentOf(migrated.db, project)?.legacy, true);
    assert.equal(acceptBuilds(migrated.db, project, { verified: "0".repeat(64), missing: [], acceptedAt: AT }, AT), false);
  });
});

describe("a project's environment (D41)", () => {
  it("keeps the released v3 and v4 schemas as they were, and moves a v4 file to v5 with every row as it was and no environment yet", () => {
    // v3's and v4's text are pinned too, now that v5 follows them.
    assert.equal(createHash("sha256").update(WORKSPACE_MIGRATIONS[2]!).digest("hex"), "2e78a5cf059685f43088c3972680a1d7cfd4fc91eb3e5e057d1d261eef172dca");
    assert.equal(createHash("sha256").update(WORKSPACE_MIGRATIONS[3]!).digest("hex"), "1a730d45a78676e8ea59b7719ace1854ea48bb6fb580b7edf78eae2cd906633e");
    // v5's text is pinned too, now that v6 (missions, NIV-52) follows it.
    assert.equal(createHash("sha256").update(WORKSPACE_MIGRATIONS[4]!).digest("hex"), "52329f99bba37c8918ac28b8ec27ae55c6573363c07ac22b72a3c0d4ec3b81d0");
    // v6's text is pinned too, now that v7 (coachings, NIV-53) follows it.
    assert.equal(createHash("sha256").update(WORKSPACE_MIGRATIONS[5]!).digest("hex"), "cb5a4607d4188a99cf3434acbbf457a52fe86c97ec66bae7fd44d980b963013a");
    const path = join(folder(), "workspace.db");
    // A v4 file, written as v4 wrote one: its schema alone, then rows through the same functions.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    raw.exec("BEGIN IMMEDIATE");
    for (const migration of WORKSPACE_MIGRATIONS.slice(0, 4)) raw.exec(migration);
    raw.exec("PRAGMA user_version = 4; COMMIT;");
    const v4 = new WorkspaceDb(path, raw);
    const chat = general();
    insertConversation(v4, chat);
    insertTurn(v4, { id: randomUUID(), conversationId: chat.id, sessionId: "s", targetId: "local", preferences: [], history: null, createdAt: AT }, { id: randomUUID(), text: "How do I stage this?" });
    const taskId = randomUUID();
    const brief = randomUUID();
    insertTask(v4, { id: taskId, title: "Stage", projectId: randomUUID(), createdAt: AT, updatedAt: AT }, { id: brief, content: { goal: "Stage" }, derivedFrom: null });
    const attempt = randomUUID();
    insertAttempt(v4, { id: attempt, taskId, briefId: brief, sessionId: "s", targetId: "wsl:Ubuntu", status: "answered", createdAt: AT });
    recordOutcome(v4, attempt, { outcome: "proposed", verified: true, proposalHash: "5".repeat(64), baseline: "a".repeat(40) }, AT);
    const TABLES = ["conversations", "tasks", "artifacts", "run_links", "messages", "reviews", "research", "attempt_records"];
    const dump = (db: DatabaseSync) => ({
      rows: TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      schema: db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND tbl_name IN (${TABLES.map((table) => `'${table}'`).join(", ")}) ORDER BY name`).all(),
    });
    const before = dump(raw);
    assert.deepEqual(before.rows.map((rows) => rows.length), [1, 1, 1, 2, 1, 0, 0, 1]);
    v4.close();

    const migrated = ready(path);
    assert.equal(migrated.schemaVersion, WORKSPACE_MIGRATIONS.length);
    assert.deepEqual(dump(migrated.db.db), before);
    const count = (table: string) => Number(migrated.db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
    assert.deepEqual([count("environments"), count("preparations")], [0, 0]);
    // A project from before has no environment, and takes its first preparation.
    const projectId = randomUUID();
    assert.deepEqual([environmentOf(migrated.db, projectId), latestPreparation(migrated.db, projectId)], [null, null]);
    const id = randomUUID();
    assert.equal(insertPreparation(migrated.db, { id, projectId, sessionId: "s", targetId: "wsl:Ubuntu", setup: SETUP, preview: "e".repeat(64), createdAt: AT }), true);
    assert.deepEqual([environmentOf(migrated.db, projectId)?.setup, environmentOf(migrated.db, projectId)?.prepared, latestPreparation(migrated.db, projectId)?.id], [SETUP, null, id]);
  });

  it("moves a v5 file to v6 (missions, NIV-52) with every row and every earlier table as it was, and no mission yet", () => {
    const path = join(folder(), "workspace.db");
    // A v5 file, written as v5 wrote one: its schema alone, then rows through the same functions, an environment included.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    raw.exec("BEGIN IMMEDIATE");
    for (const migration of WORKSPACE_MIGRATIONS.slice(0, 5)) raw.exec(migration);
    raw.exec("PRAGMA user_version = 5; COMMIT;");
    const v5 = new WorkspaceDb(path, raw);
    const chat = general();
    insertConversation(v5, chat);
    insertTurn(v5, { id: randomUUID(), conversationId: chat.id, sessionId: "s", targetId: "local", preferences: [], history: null, createdAt: AT }, { id: randomUUID(), text: "How do I stage this?" });
    insertTask(v5, { id: randomUUID(), title: "Stage", projectId: null, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: { goal: "Stage" }, derivedFrom: null });
    insertPreparation(v5, { id: randomUUID(), projectId: randomUUID(), sessionId: "s", targetId: "wsl:Ubuntu", setup: SETUP, preview: "e".repeat(64), createdAt: AT });
    const TABLES = ["conversations", "tasks", "artifacts", "run_links", "messages", "reviews", "research", "attempt_records", "environments", "preparations"];
    const dump = (db: DatabaseSync) => ({
      rows: TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      schema: db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND tbl_name IN (${TABLES.map((table) => `'${table}'`).join(", ")}) ORDER BY name`).all(),
    });
    const before = dump(raw);
    assert.deepEqual(before.rows.map((rows) => rows.length), [1, 1, 1, 1, 1, 0, 0, 0, 1, 1]);
    v5.close();

    const migrated = ready(path);
    // On to the latest: v6, then v7 (coachings, NIV-53), which changes none of these tables, and v8 (NIV-55), which adds
    // only an empty builds_json column to environments, and its two triggers.
    assert.equal(migrated.schemaVersion, WORKSPACE_MIGRATIONS.length);
    const after = dump(migrated.db.db);
    // Plain objects on both sides: a row SQLite gives has no prototype, and a copy of one does.
    const plain = (rows: readonly unknown[]) => rows.map((row) => ({ ...(row as Record<string, unknown>) }));
    const environments = TABLES.indexOf("environments");
    const withoutBuilds = (rows: readonly unknown[]) => plain(rows).map(({ builds_json, ...rest }) => (assert.equal(builds_json, null), rest));
    assert.deepEqual(after.rows.map((rows, index) => (index === environments ? withoutBuilds(rows) : plain(rows))), before.rows.map(plain));
    const v8 = new Set(["environments_builds", "environments_builds_new"]);
    assert.deepEqual(plain(after.schema.filter((row) => !v8.has(String(row["name"])))).map((row) => (row["name"] === "environments" ? { ...row, sql: String(row["sql"]).replace(", builds_json TEXT", "") } : row)), plain(before.schema));
    const count = (table: string) => Number(migrated.db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
    assert.deepEqual([count("missions"), count("mission_versions"), count("mission_tasks")], [0, 0, 0]);
    assert.deepEqual(listConversations(migrated.db).map((conversation) => conversation.id), [chat.id], "an existing conversation stays listed");
  });
});
