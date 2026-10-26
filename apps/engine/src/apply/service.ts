import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ApplyParams, ApplyResolution, ApplyView } from "@nivra/domain";
import type { Database } from "../db/database.ts";
import type { ExecutionBackend } from "../exec/backend.ts";
import { WorkspaceCancelled } from "../exec/git-tool.ts";
import type { Proposal } from "../exec/proposal.ts";
import { type ApplyIo, nodeIo } from "./io.ts";
import { ApplyJournal, type ApplyRecord } from "./journal.ts";
import { ApplyRefusal, applyRefusalWords } from "./plan.ts";
import { revalidate } from "./revalidate.ts";
import { reconcile, restore, writeChange, type ApplyResult } from "./writer.ts";

/**
 * Applying proposals on the engine that owns the checkout (D40): one at a time, each claimed, checked again and
 * written, and recorded under the host's request id, so a repeated request gets the apply it started and nothing is
 * written twice. At start, before any apply call is answered, an apply its engine left writing is reconciled from what
 * is on disk, and nothing of the person's is written.
 */

export interface ApplyServiceDeps {
  database: Database;
  proposal(runId: string): Proposal | null;
  /** This engine's home: the proposal must have been made on it, and a lock it left is its own. */
  homeId: string;
  backend: ExecutionBackend;
  findGit(): string | null;
  platform: NodeJS.Platform;
  io?: ApplyIo;
  now?: () => Date;
}

/** A request the engine refuses before any claim: nothing is recorded, and the words are Nivra's own. */
export class ApplyRequestRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyRequestRefusal";
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class ApplyService {
  readonly #deps: ApplyServiceDeps;
  readonly #journal: ApplyJournal;
  readonly #io: ApplyIo;
  /** Applies run one after another on an engine: each is checked again right before it writes. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ApplyServiceDeps) {
    this.#deps = deps;
    this.#journal = new ApplyJournal(deps.database, deps.now);
    this.#io = deps.io ?? nodeIo;
    this.#reconcileAtStart();
  }

  /** What an engine that stopped left: a claim with no intent wrote nothing; one writing is read from the disk. */
  #reconcileAtStart(): void {
    for (const record of this.#journal.interrupted()) this.#journal.refuse(record.id, new ApplyRefusal("interrupted"));
    for (const record of this.#journal.writing()) {
      if (!record.intent) continue;
      let result: ApplyResult;
      try {
        result = reconcile(record.intent, this.#io);
      } catch {
        result = { state: "unknown", paths: [], folders: [], failure: { step: "reconcile", code: null } };
      }
      this.#journal.settle(record.id, { ...result, failure: { step: "interrupted", code: null } });
    }
  }

  apply(params: ApplyParams): Promise<ApplyView> {
    return this.#serialised(async () => {
      const repeated = this.#journal.byRequest(params.requestId);
      if (repeated) return this.view(repeated);
      if (this.#deps.platform === "win32") throw new ApplyRequestRefusal("Applying changes on Windows itself isn't available yet, so nothing was written.");
      const proposal = this.#deps.proposal(params.runId);
      if (!proposal) throw new ApplyRequestRefusal("This engine has no proposal for that run, so nothing was written. Run the task again.");
      const git = this.#deps.findGit();
      if (!git) throw new ApplyRequestRefusal("Git isn't installed on this target, or isn't on its PATH, so nothing was written. Install it, then apply again.");
      const applyId = randomUUID();
      const { record } = this.#journal.claim({ applyId, requestId: params.requestId, runId: params.runId, proposalHash: proposal.hash, destination: proposal.binding.destination.root });
      if (record.state === "refused") return this.view(record);
      let session: Awaited<ReturnType<ExecutionBackend["open"]>> | null = null;
      try {
        session = await this.#deps.backend.open({ workspace: params.repoPath });
        const plan = await revalidate({ proposal, approvedHash: params.approvedHash, repoPath: params.repoPath, project: params.project, target: params.target, task: params.task, git: { session, git } });
        await writeChange({ applyId, plan, journal: this.#journal, engineId: this.#deps.homeId, io: this.#io });
      } catch (error) {
        if (error instanceof ApplyRefusal) this.#journal.refuse(applyId, error);
        // Anything else before the intent was recorded wrote nothing of the person's: the claim is let go.
        else if (this.#journal.get(applyId)?.state === "claimed") {
          this.#journal.refuse(applyId, new ApplyRefusal(error instanceof WorkspaceCancelled ? "git" : "filesystem"));
          if (!(error instanceof WorkspaceCancelled)) throw error;
        } else throw error;
      } finally {
        await session?.close();
      }
      return this.view(this.#journal.get(applyId)!);
    });
  }

  status(requestId: string): ApplyView | null {
    const record = this.#journal.byRequest(requestId);
    return record ? this.view(record) : null;
  }

  /** Takes a partial apply back to its originals, never overwriting a version another program saved since. */
  restore(applyId: string): Promise<ApplyView> {
    return this.#serialised(async () => {
      const record = this.#record(applyId);
      if (record.state !== "partial" || record.resolution !== null || !record.intent) throw new ApplyRequestRefusal("Only a change that was applied in part can be restored this way, so nothing was written.");
      const result = await restore(record.intent, { io: this.#io, created: record.created });
      this.#journal.settle(applyId, result);
      return this.view(this.#journal.get(applyId)!);
    });
  }

  /**
   * Settles an apply as the person decided. The copies in its recovery folder still equal to the original or to
   * Nivra's own bytes are removed; any other is kept (a program still writing through a file it had open writes into
   * the copy). Its lock is let go, and the folder is free for the next apply.
   */
  dismiss(applyId: string, as: ApplyResolution): Promise<ApplyView> {
    return this.#serialised(async () => {
      const record = this.#record(applyId);
      const allowed: Record<ApplyResolution, readonly string[]> = { accepted: ["applied"], dismissed: ["refused", "not-applied", "unknown"], kept: ["partial"] };
      if (record.resolution !== null || !allowed[as].includes(record.state)) throw new ApplyRequestRefusal("This apply can't be settled that way now, so nothing changed.");
      if (record.intent) this.#release(record);
      this.#journal.resolve(applyId, as);
      return this.view(this.#journal.get(applyId)!);
    });
  }

  #release(record: ApplyRecord): void {
    const intent = record.intent!;
    const io = this.#io;
    const releasable = new Map<string, string>();
    for (const [index, one] of intent.paths.entries()) {
      releasable.set(one.temp, one.post.sha256);
      if (one.aside && one.pre.sha256) releasable.set(one.aside, one.pre.sha256);
      // A version taken back is releasable only when it is Nivra's own.
      for (const name of this.#names(intent.recovery).filter((name) => name.startsWith(`back-${index}-`))) releasable.set(name, one.post.sha256);
    }
    for (const [name, wanted] of releasable) {
      const path = join(intent.recovery, name);
      try {
        const stats = io.lstat(path);
        if (stats?.isFile() && sha256(io.read(path)) === wanted) io.unlink(path);
      } catch {
        // Kept: it can be removed by hand.
      }
    }
    try {
      if (this.#names(intent.recovery).length === 0) io.rmdir(intent.recovery);
    } catch {
      // Kept.
    }
    // The lock, when it is this apply's: a partial or unknown apply kept it until now.
    const lock = join(intent.gitDir, "nivra-apply", "lock");
    try {
      const held = JSON.parse(new TextDecoder().decode(io.read(lock))) as { engine?: unknown; applyId?: unknown };
      if (held.engine === this.#deps.homeId && held.applyId === record.id) io.unlink(lock);
    } catch {
      // None, or another apply's.
    }
  }

  #names(folder: string): string[] {
    try {
      return this.#io.readdir(folder);
    } catch {
      return [];
    }
  }

  #record(applyId: string): ApplyRecord {
    const record = this.#journal.get(applyId);
    if (!record) throw new ApplyRequestRefusal("This engine has no apply by that id.");
    return record;
  }

  #serialised<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** An apply as the host reads it: Nivra's words for a refusal, paths the proposal binds, no absolute path (D29). */
  view(record: ApplyRecord): ApplyView {
    const result = record.result;
    const intent = record.intent;
    const paths =
      result?.paths ??
      (intent?.paths.map((one) => ({ path: one.path, place: "pre" as const, found: one.pre, kept: [], changedSince: false })) ?? []);
    return {
      applyId: record.id,
      requestId: record.requestId,
      runId: record.runId,
      proposalHash: record.proposalHash,
      status: record.state,
      refusal: record.refusal ? { code: record.refusal.code, message: applyRefusalWords(record.refusal.code), path: record.refusal.path } : null,
      paths: paths.map((one) => {
        const change = intent?.paths.find((planned) => planned.path === one.path)?.change ?? "changed";
        return { path: one.path, change, place: one.place, found: { kind: one.found.kind, mode: one.found.mode, size: one.found.size }, kept: one.kept.slice(0, 32), changedSince: one.changedSince };
      }),
      folders: result?.folders ?? [],
      recovery: intent ? `nivra-apply/${record.id}` : null,
      failure: result?.failure ? { step: result.failure.step.slice(0, 80), code: result.failure.code } : null,
      resolution: record.resolution,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
