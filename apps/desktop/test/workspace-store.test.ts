import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { attemptsOf, deleteConversation, getArtifact, getConversation, getTurn, insertArtifact, insertAttempt, insertConversation, insertTask, insertTurn, listConversations, messagesOf, projectAnswer, recordRun, settleTurn, versionsOf, type ConversationRecord } from "../src/main/workspace.ts";
import { classifyWorkspaceError, openWorkspace, WORKSPACE_MIGRATIONS, type WorkspaceOpening } from "../src/main/workspace-db.ts";

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
const AT = "2026-10-20T10:00:00.000Z";
const general = (id = randomUUID()): ConversationRecord => ({ id, kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "New conversation", createdAt: AT, updatedAt: AT });

describe("the workspace database (D26)", () => {
  it("opens a new file with the schema, WAL, foreign keys, secure deletion and SQLite's exclusive lock", () => {
    const path = join(folder(), "workspace.db");
    const workspace = ready(path);
    assert.deepEqual([workspace.schemaVersion, workspace.notice], [WORKSPACE_MIGRATIONS.length, null]);
    assert.match(workspace.sqlite, /^3\.\d+\.\d+$/);
    const pragma = (name: string) => Object.values(workspace.db.db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    assert.deepEqual([pragma("journal_mode"), pragma("foreign_keys"), pragma("secure_delete"), pragma("locking_mode"), pragma("user_version")], ["wal", 1, 1, "exclusive", 1]);
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
    assert.match(opening.state === "unavailable" ? opening.reason : "", /^Your history was saved by a newer version of Nivra \(schema v99; this version knows v1\), so this version won't read or change it\./);
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
    assert.equal(workspace.schemaVersion, 1);
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
});
