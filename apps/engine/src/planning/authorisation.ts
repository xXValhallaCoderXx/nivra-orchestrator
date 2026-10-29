import { failure } from "../providers/model.ts";

interface Pending { operationId: string; request: number; sharingEpoch: number; resolve(): void; reject(): void }

/** One-use authorisation for the next repository inference. Nothing is stored or inferred from an old permit. */
export class PlanningAuthorisation {
  readonly #pending = new Map<string, Pending>();
  async wait(runId: string, operationId: string, request: number, sharingEpoch: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#pending.has(runId) || this.#pending.size >= 32) throw failure("internal", "this planning request cannot wait for authorisation");
    await new Promise<void>((resolve, reject) => {
      const clear = () => { this.#pending.delete(runId); signal.removeEventListener("abort", stop); };
      const stop = () => { clear(); reject(failure("cancelled")); };
      this.#pending.set(runId, { operationId, request, sharingEpoch, resolve: () => { clear(); resolve(); }, reject: stop });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
    signal.throwIfAborted();
  }
  pending(runId: string, operationId: string): { request: number | null; sharingEpoch: number | null } {
    const waiting = this.#pending.get(runId);
    return waiting?.operationId === operationId ? { request: waiting.request, sharingEpoch: waiting.sharingEpoch } : { request: null, sharingEpoch: null };
  }
  authorize(runId: string, operationId: string, request: number, sharingEpoch: number): boolean {
    const waiting = this.#pending.get(runId);
    if (!waiting || waiting.operationId !== operationId || waiting.request !== request || waiting.sharingEpoch !== sharingEpoch) return false;
    waiting.resolve();
    return true;
  }
  end(operationId: string): void {
    for (const waiting of this.#pending.values()) if (waiting.operationId === operationId) waiting.reject();
  }
}
