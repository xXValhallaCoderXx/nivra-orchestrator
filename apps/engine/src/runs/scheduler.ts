import { isTerminal, type JsonObject, type RunContext, type RunStatus, type StartRunParams, type WorkflowId } from "@nivra/domain";
import type { NewEvent, RunStore } from "./store.ts";

/**
 * Starts queued runs within a concurrency cap, in submission order, and records how each one ends. It is the only way
 * runs start. Ported from Hird's scheduler (provenance.md): recovery is gated on holding the engine lock rather than on
 * a discovery file, since an engine that opened its database already holds it (D7). Each run's context lives here, in
 * memory, from submission until the run ends (D21): it is never stored, so a run starts only in the instance that
 * accepted it.
 */

export const MAX_CONCURRENT_RUNS = 2;

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
  log: SchedulerLog;
}

interface Slot {
  cancelRequested: boolean;
  run: RunHandle | null;
  done: Promise<void>;
  /** When the run started, on the monotonic clock. */
  startedAt: number;
}

type Settled = { status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">; event: NewEvent; error: string | null };

/** A failure's kind (D22), when the error carries one, wherever Mastra wrapped it. */
function failureData(error: unknown): JsonObject | null {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 6; current = (current as { cause?: unknown }).cause, depth++) {
    const { kind, retryAfterSeconds } = current as { kind?: unknown; retryAfterSeconds?: unknown };
    if (typeof kind === "string") return { kind, ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}) };
  }
  return null;
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : String(error);

/**
 * Maps how a Mastra run ended onto Nivra's statuses. Anything but success is a failure, except a cancel that was asked
 * for: an aborted step can surface as `failed`, and it is still a cancellation.
 */
export function settleOutcome(outcome: unknown, cancelRequested: boolean, cancelMessage = "Cancelled"): Settled {
  const result = (outcome ?? {}) as { status?: string; error?: unknown; tripwire?: { reason?: string } };
  if (result.status === "success") return { status: "succeeded", event: { type: "run.succeeded", message: "Succeeded" }, error: null };
  if (result.status === "canceled" || cancelRequested) return { status: "cancelled", event: { type: "run.cancelled", message: cancelMessage }, error: null };
  const error =
    result.status === "failed"
      ? errorMessage(result.error ?? "Run failed")
      : result.status === "tripwire"
        ? `Stopped by a guardrail: ${result.tripwire?.reason ?? "no reason given"}`
        : result.status === "suspended"
          ? "Suspended runs are not supported yet"
          : `Run ended with status "${String(result.status)}"`;
  const data = result.status === "failed" ? failureData(result.error) : null;
  return { status: "failed", event: { type: "run.failed", message: error, ...(data ? { data } : {}) }, error };
}

export class RunScheduler {
  readonly #store: RunStore;
  readonly #workflows: ReadonlyMap<WorkflowId, WorkflowEntry>;
  readonly #instanceId: string;
  readonly #maxConcurrent: number;
  readonly #log: SchedulerLog;
  readonly #slots = new Map<string, Slot>();
  readonly #contexts = new Map<string, RunContext>();
  #source: WorkflowSource | null = null;
  #recovered = false;
  #stopping: string | null = null;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#workflows = options.workflows;
    this.#instanceId = options.instanceId;
    this.#maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_RUNS;
    this.#log = options.log;
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
    const { id, created } = this.#store.create({
      workflowId: request.workflowId,
      title: entry.title(request.input),
      input: request.input,
      clientRequestId: request.clientRequestId,
      instanceId: this.#instanceId,
    });
    // A repeated request returns the run it already created, which keeps the context it came with.
    if (created) this.#contexts.set(id, request.context);
    this.pump();
    return id;
  }

  /** The context the host sent with a run, while the run lasts; null once it has ended. Steps read it by run id. */
  contextOf(runId: string): RunContext | null {
    return this.#contexts.get(runId) ?? null;
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
      slot.run?.cancel().catch((error: unknown) => this.#log.error(`Cancelling run ${runId} failed: ${errorMessage(error)}`));
    } else {
      // Queued, or running in no live process of ours: nothing is executing here, so record the cancellation.
      this.#store.transition(runId, "cancelled", { type: "run.cancelled", message: status === "queued" ? `${message} before it started` : message });
      this.#contexts.delete(runId);
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

  /** Starts queued runs while there is capacity. Synchronous, so slots are reserved before anything awaits. */
  pump(): void {
    if (!this.#recovered || !this.#source || this.#stopping) return;
    while (this.#slots.size < this.#maxConcurrent) {
      const runId = this.#store.nextQueued();
      if (!runId) return;
      if (!this.#store.transition(runId, "running", { type: "run.started", message: "Started", instanceId: this.#instanceId })) return;
      const slot: Slot = { cancelRequested: false, run: null, done: Promise.resolve(), startedAt: performance.now() };
      this.#slots.set(runId, slot);
      slot.done = this.#execute(runId, slot).catch((error: unknown) => this.#log.error(`Run ${runId} could not be recorded: ${errorMessage(error)}`));
    }
  }

  async #execute(runId: string, slot: Slot): Promise<void> {
    let unwatch = (): void => undefined;
    let settled: Settled;
    const cancelMessage = () => (this.#stopping ? `Cancelled: ${this.#stopping}` : "Cancelled");
    try {
      const run = this.#store.summary(runId);
      if (!run) throw new Error(`Run ${runId} disappeared from the store`);
      if (!this.#contexts.has(runId)) throw new Error("This run's context is missing, so it was not started. Start it again.");
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
      this.#store.setMeta(runId, { durationMs: performance.now() - slot.startedAt });
      this.#store.transition(runId, settled.status, { ...settled.event, error: settled.error });
    } finally {
      this.#slots.delete(runId);
      this.#contexts.delete(runId);
      this.pump();
    }
  }

  /** Step lifecycle from Mastra's run events. Only ids, statuses and error messages are kept. */
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
          const error = payload.error === undefined ? "Step failed" : errorMessage(payload.error);
          this.#store.append(runId, { type: "step.failed", stepId, message: `${stepId} failed: ${error}`, data: { error } });
        }
      }
    } catch (error) {
      this.#log.error(`Recording a step event for run ${runId} failed: ${errorMessage(error)}`);
    }
  }
}
