import { isTerminal, type JsonObject, type RunStatus, type StartRunParams, type WorkflowId } from "@nivra/domain";
import type { z } from "zod";
import { errorFacts, internalMessage, publicFailure, Refusal, type Diagnostic, type DiagnosticCode, type ErrorFacts } from "../diagnostics.ts";
import type { BudgetJournal } from "../budget/journal.ts";
import type { NewEvent, RunStore } from "./store.ts";

/**
 * Starts queued runs within a concurrency cap, in submission order, and records how each one ends. It is the only way
 * runs start. Ported from Hird's scheduler (provenance.md): recovery is gated on holding the engine lock rather than on
 * a discovery file, since an engine that opened its database already holds it (D7). Each run's context lives here, in
 * memory, from submission until the run ends (D21): it is never stored, so a run starts only in the instance that
 * accepted it.
 */

export const MAX_CONCURRENT_RUNS = 2;
/**
 * Task runs (D39) have a slot of their own: one at a time, each as long as half an hour, never holding up the shared
 * slots that conversations, explanations, reviews, research and sandbox checks take, nor held up by them.
 */
export const MAX_TASK_RUNS = 1;
/**
 * An environment's preparation (D41) has a slot of its own too: one at a time, each as long as about half an hour with
 * its cleanup, so it never holds up the shared slots, nor a task.
 */
export const MAX_PREPARATIONS = 1;

/** Which slots a run takes: its own for a task or a preparation, the shared ones for everything else. */
const slotKind = (workflowId: WorkflowId): "task" | "environment" | "shared" => (workflowId === "task" ? "task" : workflowId === "environment" ? "environment" : "shared");

/** The parts of a Mastra run the scheduler drives. `watch` is Mastra internal API: re-test on every upgrade (D11). */
export interface RunHandle {
  start(args: { inputData: unknown }): Promise<unknown>;
  cancel(): Promise<void>;
  watch(callback: (event: { type: string; payload?: unknown }) => void): () => void;
}

/** Where runs come from: Mastra in production. */
export interface WorkflowSource {
  getWorkflow(id: string): { createRun(options: { runId: string }): Promise<RunHandle> };
}

export interface SchedulerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface WorkflowEntry {
  id: WorkflowId;
  title(input: unknown): string;
  /**
   * What Mastra is handed as the workflow's input, which it stores as it is: ids and paths only (D22). The whole input
   * stays in the run store, masked, where steps read it. Defaults to the whole input.
   */
  mastraInput?(input: unknown): unknown;
}

/**
 * The input Mastra gets for a run. A workflow that narrows it gets exactly what it returns: nothing it leaves out ever
 * falls back to the whole input, which would put the question and the choices in Mastra's records.
 */
export function mastraInputOf(entry: WorkflowEntry | undefined, input: unknown): unknown {
  return entry?.mastraInput ? entry.mastraInput(input) : input;
}

export interface SchedulerOptions {
  store: RunStore;
  workflows: ReadonlyMap<WorkflowId, WorkflowEntry>;
  instanceId: string;
  maxConcurrent?: number;
  maxTasks?: number;
  log: SchedulerLog;
  /** Writes one safe diagnostic line (NIV-27): how each failure is logged, never by an error's own words. */
  diagnose: (diagnostic: Diagnostic) => void;
  /** The budget journal (NIV-66): a run's grant is sealed in its terminal transition. */
  journal?: Pick<BudgetJournal, "endWith" | "accept" | "grantForRun">;
}

interface Slot {
  workflowId: WorkflowId;
  cancelRequested: boolean;
  run: RunHandle | null;
  done: Promise<void>;
  /** When the run started, on the monotonic clock. */
  startedAt: number;
  /** The step whose failure the run reported, for the diagnostic. */
  failedStep: string | null;
}

/** What a failed run's diagnostic says, before the run's own ids are added. */
type FailureDiagnostic = { code: DiagnosticCode; stage: string | null; reason: string | null; kind: string | null; error: ErrorFacts | null };
type Settled = { status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">; event: NewEvent; error: string | null; diagnostic: FailureDiagnostic | null };

/**
 * A failure as it is stored and shown (D22, NIV-27): Nivra's own message, with its kind when it has one; `internal` and
 * the one internal message for anything whose message Nivra didn't write, which is never kept.
 */
function failureOf(error: unknown): { message: string; data: JsonObject | null; diagnostic: FailureDiagnostic } {
  const known = publicFailure(error);
  if (!known) {
    return { message: internalMessage(), data: { kind: "internal" }, diagnostic: { code: "unexpected-error", stage: null, reason: null, kind: "internal", error: errorFacts(error) } };
  }
  const data = known.kind
    ? { kind: known.kind, ...(known.retryAfterSeconds !== null ? { retryAfterSeconds: known.retryAfterSeconds } : {}), ...(known.stage ? { stage: known.stage } : {}) }
    : null;
  return {
    message: known.message,
    data,
    diagnostic: { code: known.code, stage: known.facts?.stage ?? null, reason: known.reason, kind: known.kind, error: known.facts?.error ?? null },
  };
}

/** Whether a stored review input names the same panel, plan version and fingerprints as a new one. */
function sameReview(stored: unknown, input: unknown): boolean {
  const keys = ["panel", "planId", "planVersion", "packetDigest", "preferencesDigest"] as const;
  const a = (stored ?? {}) as Record<string, unknown>;
  const b = (input ?? {}) as Record<string, unknown>;
  return keys.every((key) => a[key] === (b[key] ?? (key === "panel" ? "council" : undefined)));
}

/** Whether a stored sandbox check's input names the same checkout, project, target and preview as a new one (D36). */
function sameSandbox(stored: unknown, input: unknown): boolean {
  const keys = ["repoPath", "project", "target", "preview"] as const;
  const a = (stored ?? {}) as Record<string, unknown>;
  const b = (input ?? {}) as Record<string, unknown>;
  return keys.every((key) => a[key] === b[key]);
}

/** Whether a stored research input names the same plan version and packet fingerprint as a new one (D37). */
function sameResearch(stored: unknown, input: unknown): boolean {
  const keys = ["planId", "planVersion", "packetDigest"] as const;
  const a = (stored ?? {}) as Record<string, unknown>;
  const b = (input ?? {}) as Record<string, unknown>;
  return keys.every((key) => a[key] === b[key]);
}

/** Whether a stored task run's input names the same checkout, project, target, preview, task and brief as a new one (D39). */
function sameTask(stored: unknown, input: unknown): boolean {
  const keys = ["repoPath", "project", "target", "preview", "taskId", "briefVersion", "briefDigest"] as const;
  const a = (stored ?? {}) as Record<string, unknown>;
  const b = (input ?? {}) as Record<string, unknown>;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * Whether a stored coaching's input names the same task, brief version, fingerprints, profile and allowed model as a
 * new one (NIV-53): everything it is bound to, so the same request id with any other input is refused, never answered
 * with the run it started.
 */
function sameCoach(stored: unknown, input: unknown): boolean {
  const keys = ["taskId", "briefId", "briefVersion", "bindingDigest", "packetDigest", "preferencesDigest", "knowledgeDigest", "model"] as const;
  const a = (stored ?? {}) as Record<string, unknown>;
  const b = (input ?? {}) as Record<string, unknown>;
  const profile = (value: Record<string, unknown>) => (value["profile"] ?? {}) as Record<string, unknown>;
  return keys.every((key) => a[key] === b[key]) && profile(a)["id"] === profile(b)["id"] && profile(a)["version"] === profile(b)["version"];
}

/**
 * The context each kind of run carries (D21), as the protocol's start parameters define it, kept with the run's
 * workflow so each workflow reads only its own.
 */
export type ContextOf = { [P in z.output<typeof StartRunParams> as P["workflowId"]]: P["context"] };

/**
 * Maps how a Mastra run ended onto Nivra's statuses. Anything but success is a failure, except a cancel that was asked
 * for: an aborted step can surface as `failed`, and it is still a cancellation. A failure keeps Nivra's own words only.
 */
export function settleOutcome(outcome: unknown, cancelRequested: boolean, cancelMessage = "Cancelled"): Settled {
  const result = (outcome ?? {}) as { status?: string; error?: unknown };
  if (result.status === "success") return { status: "succeeded", event: { type: "run.succeeded", message: "Succeeded" }, error: null, diagnostic: null };
  if (result.status === "canceled" || cancelRequested) return { status: "cancelled", event: { type: "run.cancelled", message: cancelMessage }, error: null, diagnostic: null };
  if (result.status === "failed") {
    const failed = failureOf(result.error);
    return { status: "failed", event: { type: "run.failed", message: failed.message, ...(failed.data ? { data: failed.data } : {}) }, error: failed.message, diagnostic: failed.diagnostic };
  }
  // A guardrail's reason, or a status Nivra doesn't know, is the library's text: neither is kept.
  const message = result.status === "tripwire" ? "Stopped by a guardrail." : result.status === "suspended" ? "Suspended runs are not supported yet." : internalMessage();
  return { status: "failed", event: { type: "run.failed", message }, error: message, diagnostic: { code: "unexpected-error", stage: "run", reason: null, kind: null, error: null } };
}

export class RunScheduler {
  readonly #store: RunStore;
  readonly #workflows: ReadonlyMap<WorkflowId, WorkflowEntry>;
  readonly #instanceId: string;
  readonly #maxConcurrent: number;
  readonly #maxTasks: number;
  readonly #log: SchedulerLog;
  readonly #diagnose: (diagnostic: Diagnostic) => void;
  readonly #slots = new Map<string, Slot>();
  readonly #contexts = new Map<string, { workflowId: WorkflowId; context: ContextOf[WorkflowId] }>();
  /** Each live run's request id, for its diagnostic. */
  readonly #requests = new Map<string, string>();
  #source: WorkflowSource | null = null;
  #recovered = false;
  #stopping: string | null = null;
  readonly #journal: Pick<BudgetJournal, "endWith" | "accept" | "grantForRun"> | null;
  /** Each live run's budget grant, held in memory like its context (NIV-66). */
  readonly #grants = new Map<string, string>();

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#workflows = options.workflows;
    this.#instanceId = options.instanceId;
    this.#maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_RUNS;
    this.#maxTasks = options.maxTasks ?? MAX_TASK_RUNS;
    this.#log = options.log;
    this.#diagnose = options.diagnose;
    this.#journal = options.journal ?? null;
  }

  /** The live run's accepted grant ID; no grant or budget context enters workflow data. */
  grantOf(runId: string): string | null {
    return this.#grants.get(runId) ?? null;
  }

  attach(source: WorkflowSource): void {
    this.#source = source;
    this.pump();
  }

  /** Call once this process holds the engine lock: runs another instance accepted fail as interrupted, then queued runs start. */
  recover(): string[] {
    const interrupted = this.#store.reconcile(this.#instanceId);
    if (interrupted.length) this.#log.warn(`Marked ${interrupted.length} interrupted run(s) as failed: ${interrupted.join(", ")}`);
    this.#recovered = true;
    this.pump();
    return interrupted;
  }

  /** Records a queued run, keeps its context for as long as the run lasts, and starts it if there is capacity. */
  submit(request: StartRunParams): string {
    const entry = this.#workflows.get(request.workflowId);
    if (!entry) throw new Error(`Unknown workflow ${request.workflowId}`);
    if (request.budget && (request.budget.requestId !== request.clientRequestId || !this.#journal)) {
      throw new Refusal("request-conflict", "This run's budget grant doesn't belong to its request, so nothing was started.");
    }
    const { id, created } = this.#store.create({
      workflowId: request.workflowId,
      title: entry.title(request.input),
      input: request.input,
      clientRequestId: request.clientRequestId,
      instanceId: this.#instanceId,
    }, (runId, newlyCreated) => {
      const held = this.#journal?.grantForRun(runId) ?? null;
      if ((!newlyCreated && (held ?? undefined) !== request.budget?.id) || (held !== null && held !== request.budget?.id)) throw new Refusal("request-conflict", "This request already has another budget grant, so nothing was started.");
      if (request.budget) this.#journal!.accept(request.budget, { runId, providerDate: null });
    });
    // A repeated request returns the run it already created, which keeps the context it came with. The same id with
    // other work is refused: a review is bound to its plan version and fingerprints (D30), a check to its preview (D36),
    // research to its plan version and packet (D37), a task run to its preview and brief (D39), a coaching to everything it
    // is bound to (NIV-53), and nothing is sent twice.
    if (!created) {
      const existing = this.#store.summary(id);
      const other =
        existing &&
        ((request.workflowId === "review" && !sameReview(existing.input, request.input)) ||
          (request.workflowId === "sandbox" && !sameSandbox(existing.input, request.input)) ||
          // A preparation is bound to the same checkout, project, target and preview as a check (D41).
          (request.workflowId === "environment" && !sameSandbox(existing.input, request.input)) ||
          (request.workflowId === "research" && !sameResearch(existing.input, request.input)) ||
          (request.workflowId === "task" && !sameTask(existing.input, request.input)) ||
          (request.workflowId === "coach" && !sameCoach(existing.input, request.input)) ||
          ((request.workflowId === "companion" || request.workflowId === "planning") && JSON.stringify(existing.input) !== JSON.stringify(request.input)));
      if (existing && (existing.workflowId !== request.workflowId || other)) {
        throw new Refusal("request-conflict", "This request id already started another run, with other input. Send the new request with a new id.");
      }
    }
    if (created) {
      this.#contexts.set(id, { workflowId: request.workflowId, context: request.context });
      this.#requests.set(id, request.clientRequestId);
      if (request.budget) this.#grants.set(id, request.budget.id);
    }
    this.pump();
    return id;
  }

  /**
   * The context the host sent with a run of `workflowId`, while the run lasts: null once it has ended, and for another
   * workflow's run. Steps read it by run id, each workflow asking for its own kind.
   */
  contextOf<W extends WorkflowId>(runId: string, workflowId: W): ContextOf[W] | null {
    const held = this.#contexts.get(runId);
    return held && held.workflowId === workflowId ? (held.context as ContextOf[W]) : null;
  }

  /**
   * Requests cancellation and returns the run's status now (a running run reaches `cancelled` once its step stops).
   * `wasTerminal` is true when the run had already finished. Null for an unknown run.
   */
  cancel(runId: string, message = "Cancelled"): { status: RunStatus; wasTerminal: boolean } | null {
    const status = this.#store.status(runId);
    if (!status) return null;
    if (isTerminal(status)) return { status, wasTerminal: true };
    const slot = this.#slots.get(runId);
    if (slot) {
      slot.cancelRequested = true;
      slot.run?.cancel().catch((error: unknown) => this.#diagnose({ code: "cancel-failed", stage: "run.cancel", run: runId, error: errorFacts(error) }));
    } else {
      // Queued, or running in no live process of ours: nothing is executing here, so record the cancellation.
      const end = () => this.#store.transition(runId, "cancelled", { type: "run.cancelled", message: status === "queued" ? `${message} before it started` : message });
      const grantId = this.#grants.get(runId);
      if (grantId !== undefined && this.#journal) this.#journal.endWith(grantId, end);
      else end();
      this.#grants.delete(runId);
      this.#contexts.delete(runId);
      this.#requests.delete(runId);
    }
    return { status: this.#store.status(runId) ?? status, wasTerminal: false };
  }

  /**
   * Stops starting runs and cancels every queued or running one, saying why. Resolves when the running ones have
   * settled, or after `graceMs`, whichever comes first.
   */
  async stop(reason: string, graceMs: number): Promise<void> {
    this.#stopping = reason;
    for (const runId of this.#store.active()) this.cancel(runId, `Cancelled: ${reason}`);
    const settled = Promise.allSettled([...this.#slots.values()].map((slot) => slot.done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    clearTimeout(timer);
  }

  /**
   * Starts queued runs, oldest first, each while its kind of slot has room: a task waits only for a task, and other
   * runs only for each other. Synchronous, so slots are reserved before anything awaits.
   */
  pump(): void {
    if (!this.#recovered || !this.#source || this.#stopping) return;
    for (;;) {
      const next = this.#store.queued().find((queued) => this.#hasRoom(queued.workflowId));
      if (!next) return;
      const runId = next.id;
      if (!this.#store.transition(runId, "running", { type: "run.started", message: "Started", instanceId: this.#instanceId })) return;
      const slot: Slot = { workflowId: next.workflowId, cancelRequested: false, run: null, done: Promise.resolve(), startedAt: performance.now(), failedStep: null };
      this.#slots.set(runId, slot);
      slot.done = this.#execute(runId, slot).catch((error: unknown) => this.#diagnose({ code: "record-failed", stage: "run.settle", run: runId, error: errorFacts(error) }));
    }
  }

  /** Whether a run of `workflowId` would find a slot of its kind free. */
  #hasRoom(workflowId: WorkflowId): boolean {
    const kind = slotKind(workflowId);
    const used = [...this.#slots.values()].filter((slot) => slotKind(slot.workflowId) === kind).length;
    return used < (kind === "task" ? this.#maxTasks : kind === "environment" ? MAX_PREPARATIONS : this.#maxConcurrent);
  }

  async #execute(runId: string, slot: Slot): Promise<void> {
    let unwatch = (): void => undefined;
    let settled: Settled;
    let workflow: string | null = null;
    const cancelMessage = () => (this.#stopping ? `Cancelled: ${this.#stopping}` : "Cancelled");
    try {
      const run = this.#store.summary(runId);
      if (!run) throw new Refusal("run-missing", "This run is no longer in the engine's store, so it was not started.");
      workflow = run.workflowId;
      if (!this.#contexts.has(runId)) throw new Refusal("context-missing", "This run's context is missing, so it was not started. Start it again.");
      const handle = await this.#source!.getWorkflow(run.workflowId).createRun({ runId });
      slot.run = handle;
      unwatch = handle.watch((event) => this.#onWatch(runId, slot, event));
      settled = slot.cancelRequested
        ? settleOutcome({ status: "canceled" }, true, cancelMessage())
        : settleOutcome(await handle.start({ inputData: mastraInputOf(this.#workflows.get(run.workflowId), run.input) }), slot.cancelRequested, cancelMessage());
    } catch (error) {
      settled = slot.cancelRequested ? settleOutcome({ status: "canceled" }, true, cancelMessage()) : settleOutcome({ status: "failed", error }, false);
    }
    try {
      unwatch();
      const elapsedMs = performance.now() - slot.startedAt;
      this.#store.setMeta(runId, { durationMs: elapsedMs });
      // The run's grant is sealed in the same transaction as its terminal transition, and only here (NIV-66).
      const grantId = this.#grants.get(runId);
      const end = () => this.#store.transition(runId, settled.status, { ...settled.event, error: settled.error });
      if (grantId !== undefined && this.#journal) this.#journal.endWith(grantId, end);
      else end();
      this.#grants.delete(runId);
      // One line per failed run, with what can safely be said about it (NIV-27).
      if (settled.diagnostic) {
        const { code, stage, reason, kind, error } = settled.diagnostic;
        this.#diagnose({ code, stage: stage ?? slot.failedStep ?? "run", reason, kind, error, run: runId, request: this.#requests.get(runId) ?? null, workflow, step: slot.failedStep, counts: { elapsedMs } });
      }
    } finally {
      this.#slots.delete(runId);
      this.#contexts.delete(runId);
      this.#requests.delete(runId);
      this.pump();
    }
  }

  /** Step lifecycle from Mastra's run events. Only ids, statuses and Nivra's own failure messages are kept (NIV-27). */
  #onWatch(runId: string, slot: Slot, event: { type: string; payload?: unknown }): void {
    try {
      const payload = (event.payload ?? {}) as { id?: unknown; status?: unknown; error?: unknown };
      const stepId = typeof payload.id === "string" ? payload.id : null;
      if (!stepId) return;
      if (event.type === "workflow-step-start") {
        this.#store.append(runId, { type: "step.started", stepId, message: `Started ${stepId}` });
      } else if (event.type === "workflow-step-result") {
        if (payload.status === "success") {
          this.#store.append(runId, { type: "step.succeeded", stepId, message: `Finished ${stepId}` });
        } else if (payload.status === "failed" && slot.cancelRequested) {
          this.#store.append(runId, { type: "step.cancelled", stepId, message: `Cancelled ${stepId}` });
        } else if (payload.status === "failed") {
          slot.failedStep ??= stepId;
          const error = publicFailure(payload.error)?.message ?? internalMessage();
          this.#store.append(runId, { type: "step.failed", stepId, message: `${stepId} failed: ${error}`, data: { error } });
        }
      }
    } catch (error) {
      this.#diagnose({ code: "record-failed", stage: "run.events", run: runId, error: errorFacts(error) });
    }
  }
}
