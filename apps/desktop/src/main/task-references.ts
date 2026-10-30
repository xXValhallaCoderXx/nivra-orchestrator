import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { AttachmentMetadata, FrozenReferenceContext, PDF_LIMITATION, PROJECT_ATTACHMENTS_MOVED, REFERENCE_LIMITS, ReferenceManifest, ReferenceSelection, TaskComment, commentPayload, manifestPayload, type AttachmentPreview, type ReferenceReceipt, type TaskActivity, type TaskDiscussion } from "@nivra/domain";
import { imageInfo, validatePreparedImage } from "./attachment-image.ts";
import { extractPdf } from "./attachment-pdf.ts";
import { maskForStorage, refuseCredentials, type KnownSecrets } from "./protect.ts";
import { attemptRecord, attemptsOf, getTask, versionsOf } from "./workspace.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

export const referenceSha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const MAX_ORIGINAL = REFERENCE_LIMITS.originalImageBytes;
const utf8 = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const uuid = (id: string) => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("This attachment reference is invalid. Open the task again."); return id; };

/** Reject links, devices and pipes before reading, and bound reads even if a file grows after selection. */
function readRegular(path: string, max: number): Buffer {
  if (!isAbsolute(path)) throw new Error("Choose an absolute native file from the attachment picker.");
  const absolute = resolve(path);
  let parent = parse(absolute).root;
  for (const part of relative(parent, absolute).split(sep)) {
    parent = join(parent, part);
    if (lstatSync(parent).isSymbolicLink()) throw new Error("Linked files and folders can't be attached. Choose a regular file in its real folder.");
  }
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > max) throw new Error("This isn't a regular file within the attachment size limit. Choose a smaller regular file.");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("The selected file changed while being copied. Attach it again when it is saved.");
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
function privateWrite(path: string, bytes: string | Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Host-owned assets. All renderer operations address opaque IDs, never paths. */
export class TaskReferences {
  readonly workspace: WorkspaceDb;
  readonly root: string;
  readonly #busy = new Set<string>();
  constructor(workspace: WorkspaceDb, root: string) { this.workspace = workspace; this.root = resolve(root); }
  #task(taskId: string) { const task = getTask(this.workspace, uuid(taskId)); if (!task) throw new Error("That task is no longer here. Open another task."); return task; }
  #folder(taskId: string, projectId: string | null, id?: string): string {
    const path = join(this.root, projectId ? uuid(projectId) : "unassigned", uuid(taskId), ...(id ? [uuid(id)] : []));
    const rel = relative(this.root, path);
    if (isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error("The attachment path is unsafe.");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error("The attachment folder is linked. Restore its private folder before attaching files.");
    let cursor = this.root;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      try { mkdirSync(cursor, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink()) throw new Error("The attachment folder isn't a private regular folder. Restore it before trying again.");
    }
    const actual = relative(realpathSync.native(this.root), realpathSync.native(path));
    if (isAbsolute(actual) || actual.split(sep).includes("..")) throw new Error("The attachment folder moved. Open the task again.");
    return path;
  }
  #metadata(id: string, taskId: string): AttachmentMetadata {
    this.#task(taskId);
    const row = this.workspace.db.prepare("SELECT metadata_json FROM task_attachments WHERE id=? AND task_id=?").get(uuid(id), taskId);
    if (!row) throw new Error("That attachment isn't in this task. Open the task again.");
    return AttachmentMetadata.parse(JSON.parse(String(row["metadata_json"])));
  }
  #save(item: AttachmentMetadata): void { this.workspace.db.prepare("UPDATE task_attachments SET metadata_json=? WHERE id=? AND task_id=?").run(JSON.stringify(item), item.id, item.taskId); }
  #check(item: AttachmentMetadata, prepared: boolean): Buffer {
    const path = join(this.#folder(item.taskId, item.projectId, item.id), prepared ? item.kind === "image" ? "prepared.png" : "prepared.txt" : "original");
    try {
      const bytes = readRegular(path, prepared ? item.kind === "image" ? REFERENCE_LIMITS.imageBytes : 80_000 : MAX_ORIGINAL);
      if (referenceSha(bytes) !== (prepared ? item.preparedSha256 : item.sha256)) throw new Error("hash");
      if (prepared && item.kind === "image") validatePreparedImage(bytes);
      return bytes;
    } catch { throw new Error("This attachment is missing or damaged. Remove it and attach a valid copy before including it."); }
  }
  #all(taskId: string): AttachmentMetadata[] { return this.workspace.db.prepare("SELECT metadata_json FROM task_attachments WHERE task_id=? ORDER BY rowid").all(taskId).map((row) => AttachmentMetadata.parse(JSON.parse(String(row["metadata_json"])))); }
  #capacity(taskId: string, bytes: number, another = true): void {
    const all = this.#all(taskId).filter((item) => item.state !== "removed" || item.cleanupPending !== false);
    if (all.length + (another ? 1 : 0) > REFERENCE_LIMITS.stored || all.reduce((n, item) => n + item.bytes + item.preparedBytes, bytes) > REFERENCE_LIMITS.storedBytes) throw new Error("A task holds at most 10 attachments and 25 MiB including prepared images. Remove an attachment or choose a smaller file.");
  }
  comments(taskId: string): TaskComment[] {
    this.#task(taskId);
    return this.workspace.db.prepare("SELECT content_json FROM task_comments WHERE task_id=? ORDER BY seq").all(taskId).map((row) => TaskComment.parse(JSON.parse(String(row["content_json"]))));
  }
  addComment(taskId: string, input: string, known: KnownSecrets): TaskComment {
    this.#task(taskId);
    const text = input.trim();
    refuseCredentials("The comment", text, known);
    return this.workspace.tx(() => {
      const order = Number(this.workspace.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM task_comments WHERE task_id=?").get(taskId)!["seq"]);
      const item = { id: randomUUID(), taskId, order, author: "You" as const, createdAt: now(), text, sha256: "0".repeat(64) };
      item.sha256 = referenceSha(commentPayload(item));
      const comment = TaskComment.parse(item);
      this.workspace.db.prepare("INSERT INTO task_comments (id,task_id,seq,content_json) VALUES (?,?,?,?)").run(comment.id, taskId, order, JSON.stringify(comment));
      return comment;
    });
  }
  selection(taskId: string): ReferenceSelection {
    this.#task(taskId);
    const row = this.workspace.db.prepare("SELECT selection_json FROM task_reference_selection WHERE task_id=?").get(taskId);
    return row ? ReferenceSelection.parse(JSON.parse(String(row["selection_json"]))) : { excludedCommentIds: [], attachmentIds: [] };
  }
  select(taskId: string, input: ReferenceSelection): void {
    const selection = ReferenceSelection.parse(input);
    const comments = new Set(this.comments(taskId).map((item) => item.id));
    if (new Set(selection.attachmentIds).size !== selection.attachmentIds.length || new Set(selection.excludedCommentIds).size !== selection.excludedCommentIds.length || selection.excludedCommentIds.some((id) => !comments.has(id))) throw new Error("The selected references changed. Open the task again.");
    for (const id of selection.attachmentIds) this.#metadata(id, taskId);
    const previous = this.selection(taskId);
    const reducing = previous.excludedCommentIds.every((id) => selection.excludedCommentIds.includes(id)) && selection.attachmentIds.every((id) => previous.attachmentIds.includes(id)) && (selection.excludedCommentIds.length > previous.excludedCommentIds.length || selection.attachmentIds.length < previous.attachmentIds.length);
    // Removing context must remain possible while other included sources are oversized or damaged.
    // New inclusions and every preview/request still validate the complete selected context.
    if (!reducing) this.#build(taskId, selection);
    this.workspace.db.prepare("INSERT INTO task_reference_selection (task_id,selection_json,notice) VALUES (?, ?, NULL) ON CONFLICT(task_id) DO UPDATE SET selection_json=excluded.selection_json,notice=NULL").run(taskId, JSON.stringify(selection));
  }
  async importFile(taskId: string, path: string, known: KnownSecrets, commentId: string | null = null): Promise<AttachmentMetadata> {
    if (this.#busy.has(taskId)) throw new Error("An attachment is still being prepared. Wait for it before attaching another.");
    this.#busy.add(taskId);
    try {
      this.#task(taskId);
      if (commentId !== null && !this.comments(taskId).some((item) => item.id === commentId)) throw new Error("That comment belongs to another task. Open this task's discussion.");
      const name = basename(path);
      if (!name || name.length > 240 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Rename this file using a short plain filename, then attach it again.");
      refuseCredentials("The filename", name, known);
      const bytes = readRegular(path, MAX_ORIGINAL);
      let kind: AttachmentMetadata["kind"], mediaType: string, text: string | null = null, width: number | null = null, height: number | null = null;
      if (bytes.subarray(0, 5).toString() === "%PDF-") { kind = "pdf"; mediaType = "application/pdf"; text = await extractPdf(bytes); }
      else if (/\.(png|jpe?g|webp)$/i.test(name)) { kind = "image"; ({ mediaType, width, height } = imageInfo(bytes)); }
      else {
        if (!/\.(txt|md|mdx|markdown|[cm]?[jt]sx?|json|ya?ml|toml|css|scss|html?|xml|csv|py|rs|go|java|kt|swift|sh|sql|c|h|cpp|hpp|rb|vue|svelte|ini|conf)$/i.test(name) || bytes.length > REFERENCE_LIMITS.textBytes) throw new Error("Attach UTF-8 text, Markdown or source up to 128 KiB, a static image up to 5 MiB, or a readable PDF up to 5 MiB.");
        kind = "text"; mediaType = "text/plain";
        try { text = utf8(bytes); } catch { throw new Error("This file isn't UTF-8 text. Save it as UTF-8, then attach it again."); }
        if (/\x00/.test(text)) throw new Error("This file contains binary content. Attach a UTF-8 text file instead.");
      }
      if (text !== null) {
        if (text.length > REFERENCE_LIMITS.fileChars) throw new Error("This file exceeds 20,000 text characters. Attach a shorter relevant excerpt.");
        refuseCredentials("The attachment text", text, known);
      }
      const task = this.#task(taskId);
      this.#capacity(taskId, bytes.length + (text === null ? 0 : Buffer.byteLength(text)));
      const item: AttachmentMetadata = { id: randomUUID(), taskId, projectId: task.projectId, commentId, name, kind, mediaType, bytes: bytes.length, sha256: referenceSha(bytes), preparedSha256: text === null ? null : referenceSha(text), preparedBytes: text === null ? 0 : Buffer.byteLength(text), width, height, state: text === null ? "preparing" : "ready", detail: kind === "pdf" ? PDF_LIMITATION : null, createdAt: now() };
      const folder = this.#folder(taskId, task.projectId, item.id);
      privateWrite(join(folder, "original"), bytes);
      if (text !== null) privateWrite(join(folder, "prepared.txt"), text);
      this.#check(item, false);
      if (text !== null) this.#check(item, true);
      privateWrite(join(folder, "receipt.json"), JSON.stringify(item));
      this.workspace.db.prepare("INSERT INTO task_attachments (id,task_id,metadata_json) VALUES (?,?,?)").run(item.id, taskId, JSON.stringify(item));
      return item;
    } finally { this.#busy.delete(taskId); }
  }
  prepareImage(taskId: string, id: string, base64: string, expectedSource: string, known: KnownSecrets): void {
    const item = this.#metadata(id, taskId);
    if (item.kind !== "image" || item.state === "removed" || item.sha256 !== expectedSource) throw new Error("This image changed. Open the attachment again before preparing it.");
    refuseCredentials("The filename", item.name, known);
    this.#check(item, false);
    if (base64.length > Math.ceil(REFERENCE_LIMITS.imageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("The prepared image exceeds 1 MiB. Prepare a smaller image.");
    const bytes = Buffer.from(base64, "base64");
    const { width, height } = validatePreparedImage(bytes);
    if (item.preparedSha256 === referenceSha(bytes)) return;
    if (item.preparedSha256) throw new Error("This image is already prepared. Remove and reattach it to change its content.");
    this.#capacity(taskId, bytes.length, false);
    const path = join(this.#folder(taskId, item.projectId, id), "prepared.png");
    try { privateWrite(path, bytes); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || referenceSha(readRegular(path, REFERENCE_LIMITS.imageBytes)) !== referenceSha(bytes)) throw new Error("An interrupted image preparation left a different copy. Remove and reattach this image.");
    }
    this.#save({ ...item, state: "ready", preparedBytes: bytes.length, preparedSha256: referenceSha(bytes), width, height });
  }
  preview(taskId: string, id: string): AttachmentPreview {
    const item = this.#metadata(id, taskId);
    if (item.state === "removed") throw new Error("This attachment was removed. Attach a new copy to preview it.");
    this.#check(item, false);
    const prepared = item.preparedSha256 ? this.#check(item, true) : null;
    return { attachment: item, text: item.kind === "image" ? null : prepared ? utf8(prepared) : null, image: item.kind === "image" && prepared ? `data:image/png;base64,${prepared.toString("base64")}` : null, original: item.kind === "image" && !prepared ? `data:${item.mediaType};base64,${this.#check(item, false).toString("base64")}` : null };
  }
  remove(taskId: string, id: string): void {
    const item = this.#metadata(id, taskId);
    const removed: AttachmentMetadata = { ...item, state: "removed", cleanupPending: true, detail: "Attachment removed. Historical requests keep their frozen references." };
    const tombstone = join(this.#folder(taskId, item.projectId, id), "removed.json");
    try { privateWrite(tombstone, JSON.stringify(removed)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.workspace.tx(() => {
      this.#save(removed);
      const selection = this.selection(taskId);
      this.workspace.db.prepare("INSERT INTO task_reference_selection (task_id,selection_json,notice) VALUES (?, ?, NULL) ON CONFLICT(task_id) DO UPDATE SET selection_json=excluded.selection_json").run(taskId, JSON.stringify({ ...selection, attachmentIds: selection.attachmentIds.filter((one) => one !== id) }));
    });
    // Remove the registered copies, including a previous project's interrupted-move copies. Accepted requests own bytes.
    let failed = false;
    for (const owner of readdirSync(this.root, { withFileTypes: true })) {
      if (!owner.isDirectory() || owner.isSymbolicLink() || (owner.name !== "unassigned" && !/^[a-f0-9-]{36}$/i.test(owner.name))) continue;
      const folder = join(this.root, owner.name, taskId, id);
      try {
        if (lstatSync(join(this.root, owner.name, taskId)).isSymbolicLink() || lstatSync(folder).isSymbolicLink()) { failed = true; continue; }
        for (const name of ["original", "prepared.png", "prepared.txt"]) {
          try { unlinkSync(join(folder, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
    }
    if (failed) { this.#save({ ...removed, detail: "Removed from future context, but a private file couldn't be deleted. Close anything using it, restore write access, then press Retry file cleanup." }); throw new Error("The attachment is excluded, but some private copies couldn't be deleted. Close anything using them, restore write access, then press Retry file cleanup."); }
    this.#save({ ...removed, cleanupPending: false });
  }
  /** Keep the task and its cleanup records until every private copy and receipt has gone. */
  deleteTaskAssets(taskId: string): void {
    const task = this.#task(taskId);
    if (this.#busy.has(taskId)) throw new Error("An attachment is still being imported. Wait for it to finish, then delete the task again.");
    const notice = "Task deletion couldn't finish its private-file cleanup. The task and cleanup records were kept. Close anything using those files, restore write access to Nivra's data folder, then delete the task again.";
    this.workspace.db.prepare("INSERT INTO task_reference_selection (task_id,selection_json,notice) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET notice=excluded.notice").run(taskId, JSON.stringify(this.selection(taskId)), notice);
    try {
      this.#folder(taskId, task.projectId);
      for (const item of this.#all(taskId)) this.remove(taskId, item.id);
      for (const owner of readdirSync(this.root, { withFileTypes: true })) {
        if (owner.name !== "unassigned" && !/^[a-f0-9-]{36}$/i.test(owner.name)) continue;
        const folder = join(this.root, owner.name, taskId);
        try { lstatSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        // Validate parents before recursive removal, including interrupted imports/moves without metadata.
        rmSync(this.#folder(taskId, owner.name === "unassigned" ? null : owner.name), { recursive: true });
      }
    } catch { throw new Error(notice); }
  }
  /** Copies stay available after interruption; ownership changes only after every destination is verified. */
  move(taskId: string, projectId: string | null): void {
    this.#task(taskId);
    if (this.#busy.has(taskId)) throw new Error("Wait for the attachment import to finish before changing this task's project.");
    const all = this.#all(taskId);
    for (const item of all) {
      if (item.projectId === projectId || item.state === "removed") continue;
      const destination = this.#folder(taskId, projectId, item.id);
      for (const [name, prepared] of [["original", false], [item.kind === "image" ? "prepared.png" : "prepared.txt", true]] as const) {
        if (prepared && !item.preparedSha256) continue;
        const bytes = this.#check(item, prepared), path = join(destination, name);
        try { privateWrite(path, bytes); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (referenceSha(readRegular(path, MAX_ORIGINAL)) !== referenceSha(bytes)) throw new Error("An interrupted attachment move left a different destination copy. Restore that task's private attachment folder before moving it again.");
      }
      try { privateWrite(join(destination, "move-source.json"), JSON.stringify({ projectId: item.projectId })); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    for (const item of all) this.#save({ ...item, projectId });
    const selection = this.selection(taskId);
    this.workspace.db.prepare("INSERT INTO task_reference_selection (task_id,selection_json,notice) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET selection_json=excluded.selection_json,notice=excluded.notice").run(taskId, JSON.stringify({ ...selection, attachmentIds: [] }), PROJECT_ATTACHMENTS_MOVED);
  }
  /** After ownership committed, remove only a redundant, matching source; a restart can finish the same intent. */
  settleMoves(taskId: string): void {
    for (const item of this.#all(taskId).filter((item) => item.state !== "removed")) {
      const intent = join(this.#folder(taskId, item.projectId, item.id), "move-source.json");
      let source: { projectId: string | null };
      try { source = JSON.parse(readRegular(intent, 200).toString("utf8")) as { projectId: string | null }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("An attachment move's recovery record couldn't be read. Restore its private data folder before moving this task again."); }
      if (source.projectId === item.projectId) continue;
      const folder = this.#folder(taskId, source.projectId, item.id);
      for (const [name, prepared] of [["original", false], [item.kind === "image" ? "prepared.png" : "prepared.txt", true]] as const) {
        if (prepared && !item.preparedSha256) continue;
        // Destination first: never delete the only valid copy, including when its metadata committed before a crash.
        this.#check(item, prepared);
        try {
          const path = join(folder, name), bytes = readRegular(path, MAX_ORIGINAL);
          if (referenceSha(bytes) !== (prepared ? item.preparedSha256 : item.sha256)) throw new Error("different source");
          unlinkSync(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("An attachment's recovery copy differs or couldn't be removed. Keep it and restore write access to Nivra's data folder before moving this task again."); }
      }
      unlinkSync(intent);
    }
  }
  retainSummary(attemptId: string, summary: string | null, known: KnownSecrets): void {
    this.workspace.db.prepare("INSERT INTO task_run_summaries (attempt_id,summary) VALUES (?,?) ON CONFLICT(attempt_id) DO NOTHING").run(attemptId, summary === null ? null : maskForStorage(summary, known));
  }
  summaries(taskId: string, excludeId?: string) {
    return attemptsOf(this.workspace, taskId).filter((attempt) => attempt.id !== excludeId).slice(-20).map((attempt) => {
      const record = attemptRecord(this.workspace, attempt.id);
      const summary = this.workspace.db.prepare("SELECT summary FROM task_run_summaries WHERE attempt_id=?").get(attempt.id);
      const payload = JSON.stringify({ id: attempt.id, runId: attempt.runId, briefId: attempt.briefId, status: attempt.status, workerSummary: summary?.["summary"] ?? null, outcome: record?.outcome?.outcome ?? null, verified: record?.outcome?.verified ?? null, proposalHash: record?.outcome?.proposalHash ?? null, checks: this.workspace.db.prepare("SELECT label FROM task_activity WHERE task_id=? AND record_id=? AND kind='check' ORDER BY label").all(taskId, attempt.id).map((row) => String(row["label"])), decision: record?.decision ?? null, apply: record.apply ? { requestId: record.apply.requestId, resolution: record.apply.view?.resolution ?? null, status: record.apply.view?.status ?? null, note: record.apply.note, readAt: record.apply.readAt } : null, acceptedAt: record?.acceptedAt ?? null, error: attempt.errorMessage, createdAt: attempt.createdAt, settledAt: attempt.settledAt });
      return { id: attempt.id, payload, sha256: referenceSha(payload) };
    });
  }
  #build(taskId: string, selection: ReferenceSelection, excludeId?: string): FrozenReferenceContext {
    const comments = this.comments(taskId).filter((item) => !selection.excludedCommentIds.includes(item.id));
    if (comments.length > REFERENCE_LIMITS.comments || comments.reduce((n, item) => n + item.text.length, 0) > REFERENCE_LIMITS.discussionChars) throw new Error("Included discussion exceeds 50 comments or 24,000 characters. Exclude some comments before requesting AI.");
    const attachments = selection.attachmentIds.map((id) => this.#metadata(id, taskId));
    const summaries = this.summaries(taskId, excludeId);
    const manifest: ReferenceManifest = { version: 1, taskId, comments: comments.map(({ id, sha256 }) => ({ id, sha256 })), attachments: attachments.map((item) => { if (item.state !== "ready" || !item.preparedSha256) throw new Error("An included attachment isn't ready. Prepare or remove it before requesting AI."); return { id: item.id, sha256: item.sha256, preparedSha256: item.preparedSha256 }; }), summaries: summaries.map(({ id, sha256 }) => ({ id, sha256 })) };
    const content = attachments.map((item) => { this.#check(item, false); const bytes = this.#check(item, true); return { id: item.id, name: item.name, kind: item.kind, text: item.kind === "image" ? null : utf8(bytes), image: item.kind === "image" ? { mediaType: "image/png" as const, base64: bytes.toString("base64"), width: item.width!, height: item.height! } : null }; });
    const checked = FrozenReferenceContext.safeParse({ manifest, digest: referenceSha(manifestPayload(manifest)), comments, attachments: content, summaries });
    if (!checked.success) throw new Error("The selected context exceeds five files, three images or 40,000 text characters. Exclude some references before requesting AI.");
    return checked.data;
  }
  freeze(taskId: string, known: KnownSecrets): FrozenReferenceContext {
    const context = this.#build(taskId, this.selection(taskId));
    const text = JSON.stringify({ comments: context.comments, attachments: context.attachments.map(({ image: _image, ...item }) => item), summaries: context.summaries });
    refuseCredentials("The selected task context", text, known, "send");
    return context;
  }
  /** Re-read included bytes and facts synchronously at the final dispatch check. */
  digest(taskId: string, excludeId?: string): string { return this.#build(taskId, this.selection(taskId), excludeId).digest; }
  receipt(taskId: string, requestId: string): ReferenceReceipt | null {
    this.#task(taskId);
    const row = this.workspace.db.prepare("SELECT digest,manifest_json FROM task_context_receipts WHERE task_id=? AND request_id=?").get(taskId, requestId);
    if (!row) return null;
    const manifest = ReferenceManifest.parse(JSON.parse(String(row["manifest_json"])));
    const comments = this.comments(taskId).filter((comment) => manifest.comments.some((ref) => ref.id === comment.id && ref.sha256 === comment.sha256));
    return { digest: String(row["digest"]), manifest, comments, attachments: manifest.attachments.map((ref) => { const item = this.#metadata(ref.id, taskId); return { id: item.id, name: item.name, removed: item.state === "removed" }; }) };
  }
  record(taskId: string, kind: TaskActivity["kind"], label: string, recordId: string, at = now()): void {
    this.workspace.db.prepare("INSERT OR IGNORE INTO task_activity (id,task_id,at,kind,label,record_id) VALUES (?,?,?,?,?,?)").run(referenceSha(JSON.stringify([taskId, kind, label, recordId])), taskId, at, kind, label, recordId);
  }
  discussion(taskId: string): TaskDiscussion {
    const task = this.#task(taskId);
    let moveNotice: string | null = null;
    try { this.settleMoves(taskId); }
    catch { moveNotice = "An attachment move couldn't finish its cleanup. Valid recovery copies were kept. Restore the private attachment folder, or remove the affected attachment and attach a valid copy again."; }
    // Recover an import whose verified receipt was written before its database transaction committed.
    const folder = this.#folder(taskId, task.projectId);
    for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9-]{36}$/i.test(entry.name)) {
      if (this.workspace.db.prepare("SELECT id FROM task_attachments WHERE id=?").get(entry.name)) continue;
      try {
        let receipt: Buffer;
        try { receipt = readRegular(join(folder, entry.name, "removed.json"), 4_000); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; receipt = readRegular(join(folder, entry.name, "receipt.json"), 4_000); }
        const item = AttachmentMetadata.parse(JSON.parse(receipt.toString("utf8")));
        if (item.id !== entry.name || item.taskId !== taskId || item.projectId !== task.projectId) continue;
        if (item.state !== "removed") { this.#check(item, false); if (item.preparedSha256) this.#check(item, true); this.#capacity(taskId, item.bytes + item.preparedBytes); }
        this.workspace.db.prepare("INSERT INTO task_attachments (id,task_id,metadata_json) VALUES (?,?,?)").run(item.id, taskId, JSON.stringify(item));
      } catch { /* A partial copy without a valid receipt remains private for recovery; it is never claimed as imported. */ }
    }
    const activity: TaskActivity[] = versionsOf(this.workspace, taskId).map((brief) => ({ id: brief.id, at: brief.createdAt, kind: "brief", label: `Brief version ${brief.version}`, recordId: brief.id }));
    for (const attempt of attemptsOf(this.workspace, taskId)) {
      const record = attemptRecord(this.workspace, attempt.id);
      activity.push({ id: attempt.id, at: attempt.settledAt ?? attempt.createdAt, kind: "attempt", label: `Attempt ${attempt.status}${record?.outcome ? ` · ${record.outcome.outcome} · verification ${record.outcome.verified === true ? "passed" : record.outcome.verified === false ? "failed" : "unknown"}` : " · verification not recorded"}`, recordId: attempt.id });
      if (record?.decision) activity.push({ id: `${attempt.id}:decision`, at: record.decidedAt ?? attempt.createdAt, kind: "decision", label: `Proposal ${record.decision}`, recordId: attempt.id });
      if (record?.apply) activity.push({ id: `${attempt.id}:apply`, at: record.apply.readAt ?? record.decidedAt ?? attempt.settledAt ?? attempt.createdAt, kind: "apply", label: `Apply ${record.apply.view?.status ?? "unknown"} · ${record.apply.view?.resolution ?? "unsettled"}`, recordId: attempt.id });
      if (record?.acceptedAt) activity.push({ id: `${attempt.id}:accepted`, at: record.acceptedAt, kind: "acceptance", label: "Result accepted by you", recordId: attempt.id });
    }
    for (const row of this.workspace.db.prepare("SELECT * FROM task_activity WHERE task_id=? ORDER BY rowid").all(taskId)) activity.push({ id: String(row["id"]), at: String(row["at"]), kind: String(row["kind"]) as TaskActivity["kind"], label: String(row["label"]), recordId: String(row["record_id"]) });
    const row = this.workspace.db.prepare("SELECT notice FROM task_reference_selection WHERE task_id=?").get(taskId);
    const attachments = this.#all(taskId).map((item) => { if (item.state === "removed") return item; try { this.#check(item, false); if (item.preparedSha256) this.#check(item, true); return item; } catch (error) { return { ...item, state: "unavailable" as const, detail: (error as Error).message }; } });
    return { comments: this.comments(taskId), attachments, selection: this.selection(taskId), activity: activity.sort((a, b) => a.at.localeCompare(b.at)), historyNote: "Activity is projected from retained records. Earlier transitions and individual checks not retained here may be missing; open an attempt for its recorded checks.", notice: moveNotice ?? (row?.["notice"] ? String(row["notice"]) : null) };
  }
}
