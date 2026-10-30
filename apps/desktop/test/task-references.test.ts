import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkReferences, PROJECT_ATTACHMENTS_MOVED, REFERENCE_LIMITS, type ApplyView } from "@nivra/domain";
import { extractPdf, PDF_REFUSED } from "../src/main/attachment-pdf.ts";
import { validatePreparedImage } from "../src/main/attachment-image.ts";
import { referenceSha, TaskReferences } from "../src/main/task-references.ts";
import { briefFrom } from "../src/main/tasks.ts";
import { decide, insertAttempt, insertTask, recordApply, recordOutcome, settleAttempt, updateTask, withdrawDecision } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";

const roots: string[] = [], workspaces: WorkspaceDb[] = [];
after(() => { for (const workspace of workspaces) workspace.close(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nivra references ü ")); roots.push(root);
  const opened = openWorkspace(join(root, "workspace.db")); assert.equal(opened.state, "ready"); if (opened.state !== "ready") throw new Error("workspace");
  const workspace = opened.db; workspaces.push(workspace);
  const id = randomUUID(), briefId = randomUUID(), at = "2026-10-30T00:00:00.000Z";
  insertTask(workspace, { id, title: "Reference context", projectId: null, createdAt: at, updatedAt: at }, { id: briefId, content: briefFrom({ goal: "One change", acceptanceCriteria: ["One result"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] }), derivedFrom: null });
  const refs = new TaskReferences(workspace, join(root, "assets"));
  const file = (name: string, bytes: string | Buffer) => { const path = join(root, name); writeFileSync(path, bytes); return path; };
  return { root, workspace, id, briefId, refs, file };
}
import { png, pdf } from "./fixtures/reference-files.ts";
describe("task discussion and private reference storage", () => {
  it("keeps comments immutable, independently ordered and locally authored without changing the execution revision", () => {
    const { refs, id, workspace } = setup();
    const one = refs.addComment(id, "First", []), two = refs.addComment(id, "Second", []);
    assert.deepEqual(refs.comments(id).map((item) => [item.order, item.author, item.text]), [[1,"You","First"],[2,"You","Second"]]);
    assert.equal(one.id === two.id, false);
    assert.equal(workspace.db.prepare("SELECT revision FROM tasks WHERE id=?").get(id)!["revision"], 1);
    assert.throws(() => workspace.db.prepare("UPDATE task_comments SET content_json='{}' WHERE id=?").run(one.id), /immutable/);
    const restarted = new TaskReferences(workspace, refs.root); assert.equal(restarted.comments(id).length, 2);
  });
  it("copies regular UTF-8 files privately, excludes attachments by default, links comments and enforces task isolation", async () => {
    const { refs, id, file } = setup();
    const comment = refs.addComment(id, "Supporting note", []);
    const path = file("source.ts", "export const answer = 42;"), asset = await refs.importFile(id, path, [], comment.id);
    writeFileSync(path, "Changed original");
    assert.equal(refs.preview(id, asset.id).text, "export const answer = 42;");
    assert.deepEqual([refs.freeze(id, []).comments.length, refs.freeze(id, []).attachments.length], [1, 0]);
    refs.select(id, { excludedCommentIds: [], attachmentIds: [asset.id] });
    const frozen = refs.freeze(id, []); assert.equal(await checkReferences(frozen), true);
    assert.equal(frozen.attachments[0]!.text, "export const answer = 42;");
    assert.throws(() => refs.preview(randomUUID(), asset.id), /task/);
    const stored = join(refs.root, "unassigned", id, asset.id, "original");
    if (process.platform !== "win32") assert.equal((await import("node:fs")).statSync(stored).mode & 0o777, 0o600);
    assert.equal(refs.discussion(id).attachments[0]!.commentId, comment.id);
  });
  it("invalidates included sources and canonical summary facts, but leaves exclusions and unselected files out of bindings", async () => {
    const { refs, id, file, workspace, briefId } = setup();
    const included = refs.addComment(id, "Included", []), excluded = refs.addComment(id, "Excluded", []);
    refs.select(id, { excludedCommentIds: [excluded.id], attachmentIds: [] });
    const before = refs.digest(id);
    await refs.importFile(id, file("unused.md", "Unselected"), []); assert.equal(refs.digest(id), before);
    const newer = refs.addComment(id, "New excluded comment", []);
    refs.select(id, { excludedCommentIds: [excluded.id, newer.id], attachmentIds: [] }); assert.equal(refs.digest(id), before);
    refs.select(id, { excludedCommentIds: [excluded.id], attachmentIds: [] }); assert.notEqual(refs.digest(id), before);
    const attemptId = randomUUID(); insertAttempt(workspace, { id: attemptId, taskId: id, briefId, sessionId: randomUUID(), targetId: "local", createdAt: new Date().toISOString() });
    const pending = refs.digest(id); recordOutcome(workspace, attemptId, { outcome: "failed", verified: false, proposalHash: null, baseline: null }, new Date().toISOString());
    assert.notEqual(refs.digest(id), pending);
    assert.equal(refs.freeze(id, []).comments[0]!.id, included.id);
    settleAttempt(workspace, attemptId, { status: "failed", errorMessage: "Check failed" }, new Date().toISOString());
    assert.match(refs.discussion(id).activity.find((item) => item.kind === "attempt")!.label, /failed.*verification failed/);
  });
  it("keeps an accepted snapshot after removal, and refuses selected missing or damaged files without silently omitting them", async () => {
    const { refs, id, file } = setup(); const asset = await refs.importFile(id, file("note.md", "Frozen content"), []);
    refs.select(id, { excludedCommentIds: [], attachmentIds: [asset.id] }); const accepted = refs.freeze(id, []);
    const stored = join(refs.root, "unassigned", id, asset.id, "prepared.txt"); writeFileSync(stored, "Damaged");
    assert.throws(() => refs.freeze(id, []), /missing or damaged/); assert.equal(refs.discussion(id).attachments[0]!.state, "unavailable");
    rmSync(stored); assert.throws(() => refs.freeze(id, []), /missing or damaged/);
    refs.remove(id, asset.id); assert.equal(refs.selection(id).attachmentIds.length, 0);
    assert.equal(refs.discussion(id).attachments[0]!.state, "removed"); assert.equal(accepted.attachments[0]!.text, "Frozen content"); assert.equal(await checkReferences(accepted), true);
  });
  it("includes the masked written hand-in, hashes its exact payload and keeps accepted content independent of later summary changes", async () => {
    const { refs, id, workspace, briefId } = setup(), attemptId = randomUUID();
    insertAttempt(workspace, { id: attemptId, taskId: id, briefId, sessionId: randomUUID(), targetId: "local", createdAt: new Date().toISOString() });
    const before = refs.digest(id), key = "synthetic-hand-in-secret-123456789";
    refs.retainSummary(attemptId, `Found an existing guard; need clarification. ${key}`, [["NEBIUS_API_KEY", key]]);
    const accepted = refs.freeze(id, []), summary = JSON.parse(accepted.summaries[0]!.payload) as { workerSummary: string };
    assert.equal(summary.workerSummary.includes(key), false); assert.match(summary.workerSummary, /need clarification/);
    assert.notEqual(accepted.digest, before); assert.equal(await checkReferences(accepted), true);
    refs.retainSummary(attemptId, "A later report can't replace the first hand-in", []);
    assert.equal(refs.digest(id), accepted.digest);
    // A changed retained payload must invalidate a pending request, even with the same attempt/status identities.
    workspace.db.prepare("UPDATE task_run_summaries SET summary=? WHERE attempt_id=?").run("Different source summary", attemptId);
    assert.notEqual(refs.digest(id), accepted.digest); assert.match(accepted.summaries[0]!.payload, /need clarification/);
    assert.equal(await checkReferences(accepted), true);
  });
  it("projects partial and refused apply facts at their recorded observation time without claiming a pass", () => {
    const { refs, id, briefId, workspace } = setup(), attemptId = randomUUID(), requestId = randomUUID();
    const endedAt = "2026-10-30T00:00:01.000Z", observedAt = "2026-10-30T01:00:00.000Z";
    insertAttempt(workspace, { id: attemptId, taskId: id, briefId, sessionId: randomUUID(), targetId: "local", createdAt: endedAt });
    recordOutcome(workspace, attemptId, { outcome: "proposed", verified: false, proposalHash: "a".repeat(64), baseline: null }, endedAt);
    decide(workspace, attemptId, { kind: "approved", requestId, projectId: randomUUID() }, endedAt);
    const view: ApplyView = { applyId: randomUUID(), requestId, runId: randomUUID(), proposalHash: "a".repeat(64), status: "partial", refusal: null, paths: [], folders: [], recovery: null, failure: { step: "write", code: "EIO" }, resolution: null, createdAt: observedAt, updatedAt: observedAt };
    recordApply(workspace, attemptId, requestId, view, observedAt);
    let projected = refs.discussion(id).activity.find((item) => item.id === `${attemptId}:apply`)!;
    assert.equal(projected.at, observedAt); assert.match(projected.label, /partial/); assert.equal(projected.label.includes("passed"), false);
    recordApply(workspace, attemptId, requestId, { ...view, status: "refused" }, observedAt);
    projected = refs.discussion(id).activity.find((item) => item.id === `${attemptId}:apply`)!;
    assert.match(projected.label, /refused/);
    assert.equal(withdrawDecision(workspace, attemptId, requestId, "No change was applied"), true);
    assert.equal(refs.discussion(id).activity.some((item) => item.kind === "decision" && item.label === "Proposal approval withdrawn"), true);
  });
  it("verifies every destination before changing ownership; interrupted copies can be retried with IDs and comment links intact", async () => {
    const { refs, id, file, workspace } = setup(); const comment = refs.addComment(id, "Keep with task", []);
    const asset = await refs.importFile(id, file("note.md", "Move me"), [], comment.id); refs.select(id, { excludedCommentIds: [], attachmentIds: [asset.id] });
    const projectId = randomUUID();
    assert.throws(() => workspace.tx(() => { refs.move(id, projectId); throw new Error("interruption"); }), /interruption/);
    assert.equal(refs.discussion(id).attachments[0]!.projectId, null); assert.equal(refs.preview(id, asset.id).text, "Move me");
    workspace.tx(() => { refs.move(id, projectId); updateTask(workspace, id, 1, { projectId }, new Date().toISOString()); });
    const view = refs.discussion(id); assert.deepEqual([view.attachments[0]!.id, view.attachments[0]!.commentId, view.attachments[0]!.projectId], [asset.id, comment.id, projectId]);
    assert.equal(view.notice, PROJECT_ATTACHMENTS_MOVED); assert.equal(view.selection.attachmentIds.length, 0); assert.equal(refs.preview(id, asset.id).text, "Move me");
  });
  it("recovers a verified import receipt before metadata commit without deleting its valid copy", async () => {
    const { refs, id, file, workspace } = setup(); const asset = await refs.importFile(id, file("note.md", "Recovered"), []);
    workspace.db.prepare("DELETE FROM task_attachments WHERE id=?").run(asset.id);
    const restarted = new TaskReferences(workspace, refs.root);
    assert.equal(restarted.discussion(id).attachments.length, 1); assert.equal(restarted.preview(id, asset.id).text, "Recovered");
  });
  it("keeps a valid recovery copy and allows removal when a moved destination is damaged before cleanup", async () => {
    const { refs, id, file, workspace } = setup(); const asset = await refs.importFile(id, file("note.md", "Recovery copy"), []);
    const projectId = randomUUID(); workspace.tx(() => { refs.move(id, projectId); updateTask(workspace, id, 1, { projectId }, new Date().toISOString()); });
    writeFileSync(join(refs.root, projectId, id, asset.id, "prepared.txt"), "Damaged destination");
    const view = refs.discussion(id);
    assert.equal(view.attachments[0]!.state, "unavailable"); assert.match(view.notice!, /recovery copies were kept/);
    assert.equal(readFileSync(join(refs.root, "unassigned", id, asset.id, "prepared.txt"), "utf8"), "Recovery copy");
    refs.remove(id, asset.id); assert.equal(refs.discussion(id).attachments[0]!.state, "removed");
  });
  it("blocks credentials, unsafe sources, invalid encodings and inclusion overflow before sharing", async () => {
    const { refs, id, file, root } = setup(); const key = "synthetic-private-key-1234567890", known = [["NEBIUS_API_KEY", key]] as const;
    assert.throws(() => refs.addComment(id, key, known), /credential|key/i);
    await assert.rejects(refs.importFile(id, file("note.md", key), known), /credential|key/i);
    await assert.rejects(refs.importFile(id, file("binary.txt", Buffer.from([0xff, 0xfe])), []), /UTF-8/);
    const real = file("real.md", "Regular"), link = join(root, "link.md"); symlinkSync(real, link); await assert.rejects(refs.importFile(id, link, []), /Linked/);
    await assert.rejects(refs.importFile(id, root, []), /regular file/);
    for (let n = 0; n < 4; n++) refs.addComment(id, "x".repeat(8000), []);
    assert.throws(() => refs.freeze(id, []), /24,000/);
    const ids = refs.comments(id).map((item) => item.id); refs.select(id, { excludedCommentIds: ids, attachmentIds: [] });
    const assets: Array<{ id: string }> = []; for (let n = 0; n < 3; n++) assets.push(await refs.importFile(id, file(`part${n}.md`, "x".repeat(20_000)), []));
    assert.throws(() => refs.select(id, { excludedCommentIds: ids, attachmentIds: assets.map((item) => item.id) }), /40,000/);
  });
  it("validates prepared image hashes, dimensions and decoded bounds, previews those exact bytes and counts stored copies", async () => {
    const { refs, id, file } = setup(); const bytes = png(), asset = await refs.importFile(id, file("image.png", bytes), []);
    assert.equal(asset.state, "preparing"); assert.equal(refs.preview(id, asset.id).image, null);
    refs.prepareImage(id, asset.id, bytes.toString("base64"), asset.sha256, []);
    const preview = refs.preview(id, asset.id); assert.equal(preview.image, `data:image/png;base64,${bytes.toString("base64")}`);
    assert.deepEqual(validatePreparedImage(bytes), { width: 2, height: 1 });
    refs.select(id, { excludedCommentIds: [], attachmentIds: [asset.id] }); assert.equal(await checkReferences(refs.freeze(id, [])), true);
    assert.equal(refs.freeze(id, []).manifest.attachments[0]!.preparedSha256, referenceSha(bytes));
    const broken = Buffer.from(bytes); broken.writeUInt32BE(3000, 16); assert.throws(() => validatePreparedImage(broken), /static PNG/);
    assert.throws(() => refs.prepareImage(id, asset.id, "A".repeat(REFERENCE_LIMITS.imageBytes * 2), asset.sha256, []), /1 MiB/);
  });
});
describe("bounded PDF extraction in a host worker", () => {
  it("extracts text and labels the visual limitation; encryption, unreadable/scanned data and deadlines are refused", async () => {
    assert.match(await extractPdf(pdf()), /Reference PDF text/);
    await assert.rejects(extractPdf(Buffer.from("%PDF-1.7 /Encrypt")), (error: Error) => error.message === PDF_REFUSED);
    await assert.rejects(extractPdf(Buffer.from("%PDF-unreadable")), /PNG or JPEG/);
    await assert.rejects(extractPdf(pdf(" ")), /PNG or JPEG/);
    await assert.rejects(extractPdf(pdf(), { timeoutMs: 1 }), /five seconds/);
    const { refs, id, file } = setup(); const asset = await refs.importFile(id, file("reference.pdf", pdf()), []);
    assert.match(asset.detail!, /PDF text only/); assert.match(refs.preview(id, asset.id).text!, /Reference PDF text/);
  });
});
