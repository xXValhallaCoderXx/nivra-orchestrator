import { CODING_PORTION, taskWorkLimits, type BudgetGrant, type TaskWork } from "@nivra/domain";
import type { BudgetJournal } from "../budget/journal.ts";

/** One live attempt. Replies are fenced by phase and monotonically increasing need, never by elapsed age. */
export class CodingCapacity {
  readonly root: BudgetGrant;
  readonly runId: string;
  readonly #journal: BudgetJournal;
  readonly #maximum: ReturnType<typeof taskWorkLimits>;
  #phase: "working" | "waiting" | "finalising" | "submitted" | "cancelled" = "working";
  #need = 0;
  #pending: { need: number; requests: number; rootGrantId: string } | null = null;
  #resolve: ((accepted: boolean) => void) | null = null;
  #requests: number;
  readonly #accepted = new Set<string>();
  reason: string | null = null;

  constructor(runId: string, root: BudgetGrant, work: TaskWork, journal: BudgetJournal) {
    this.#accepted.add(root.id);
    this.runId = runId; this.root = root; this.#journal = journal; this.#maximum = taskWorkLimits(work);
    this.#requests = Math.min(root.productive.requests, work.workingRequests);
  }
  pending() { return this.#pending ? { ...this.#pending } : null; }
  limits() { return { requests: this.#requests, toolCalls: Math.min(this.#maximum.toolCalls, this.#requests * 4), writes: Math.min(this.#maximum.writes, this.#requests), runs: Math.min(this.#maximum.runs, Math.ceil(this.#requests / 2)) }; }
  productiveGrant(): string { return this.#journal.productiveGrant(this.runId) ?? this.root.id; }

  finish(phase: "finalising" | "submitted" | "cancelled", reason?: string): void {
    if (this.#phase === "submitted" || this.#phase === "cancelled") return;
    this.#phase = phase;
    this.reason ??= reason ?? null;
    this.#pending = null;
    const resolve = this.#resolve; this.#resolve = null; resolve?.(false);
  }

  /** Called only after the previous model response and every tool/read-back have settled. */
  async ensure(used: { requests: number; toolCalls: number; writes: number; runs: number }, signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
    if (signal?.aborted) { this.finish("cancelled"); return false; }
    if (this.#phase !== "working") return false;
    const available = this.limits();
    if (used.requests < available.requests && used.toolCalls < available.toolCalls && used.writes < available.writes && used.runs < available.runs) return true;
    const requests = Math.min(CODING_PORTION.requests, this.#maximum.requests - 1 - this.#requests);
    if (requests <= 0) { this.finish("finalising", "The accepted task allowance is exhausted. Preview a new attempt with additional capacity if more work is needed."); return false; }
    this.#phase = "waiting";
    this.#pending = { need: ++this.#need, requests, rootGrantId: this.root.id };
    return await new Promise<boolean>((resolve) => {
      const stop = () => this.finish(signal?.aborted ? "cancelled" : "finalising", signal?.aborted ? undefined : "The host did not admit more work in time. No further productive request was sent.");
      const timer = setTimeout(stop, Math.max(1, Math.floor(timeoutMs)));
      this.#resolve = (accepted) => { clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve(accepted); };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    });
  }

  reply(need: number, grant: BudgetGrant | null, reason: string | null): boolean {
    const pending = this.#pending;
    if (this.#phase !== "waiting" || !pending || pending.need !== need) return false;
    if (!grant) { this.finish("finalising", reason ?? "Additional capacity was refused. Review the allowance before starting another attempt."); return false; }
    if (grant.requestId !== this.root.requestId || grant.productive.requests < 1 || grant.productive.requests > pending.requests || grant.productive.outputTokens !== this.root.productive.outputTokens || grant.finalisation.requests !== 0 || grant.finalisation.outputTokens !== 0) throw new Error("The extension does not match the pending capacity request.");
    if (this.#accepted.has(grant.id)) throw new Error("This grant already answered another capacity need.");
    this.#journal.acceptExtension(grant, this.runId, this.root.id);
    this.#accepted.add(grant.id);
    this.#requests += grant.productive.requests;
    this.#phase = "working"; this.#pending = null;
    const resolve = this.#resolve; this.#resolve = null; resolve?.(true);
    return true;
  }
}
