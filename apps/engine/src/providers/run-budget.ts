import type { RunBudgetRecord } from "@nivra/domain";
import type { StepRecord } from "./model.ts";

/**
 * A run's shared limits across its model requests (NIV-38, D30). Two kinds, never mixed:
 * - **hard limits**, enforced: how many requests are admitted, the run's time on the monotonic clock (a request is
 *   given no more than the time left, and aborted at its deadline), and the output cap sent with every request;
 * - **an estimated admission budget** for input: each request is estimated whole (instructions, the message, every
 *   tool definition, a per-message allowance) at characters ÷ 3 until the provider reports. A tokenizer can count more
 *   than that, so the budget decides what is admitted and promises no ceiling: an overrun is recorded, never hidden.
 *
 * Requests are reserved before they are sent, all or nothing, so a later phase that must run (a council's chair) keeps
 * its room whatever the earlier ones report. A reservation, once held, is honoured. Cancelling, the deadline or running
 * out stops admission for good. Unknown usage stays null, and no currency is ever computed.
 */

export interface RunLimits {
  /** Hard: how many requests the run may make. */
  requests: number;
  /** Hard: the whole run's time. */
  totalMs: number;
  /** Hard: the output cap sent with every request. */
  outputTokensPerRequest: number;
  /** Estimated: the admission budget for the run's input, not a ceiling. */
  estimatedInputTokens: number;
}

/** One request to hold room for: its whole estimated input, and the time it may take. */
export interface Ask {
  inputTokens: number;
  ms: number;
}

export interface Refusal {
  reason: "requests" | "input" | "time" | "cancelled" | "deadline" | "exhausted";
  needed: number;
  available: number;
}

/** Room held for one request: admitted once, then settled with what the request did, or released unused. */
export interface Hold {
  /** Lets the request go: once only, refused after a stop or the deadline. `ms` is the time it may take. */
  admit(): { ok: true; ms: number } | { ok: false; refusal: Refusal };
  /** What the request did: the provider's counts replace the estimate; a request that reported nothing keeps it. */
  settle(steps: readonly StepRecord[]): void;
  /** Gives the room back, for a request never sent. */
  release(): void;
}

interface Held {
  ask: Ask;
  phase: number;
  reservation: number;
  admitted: boolean;
  done: boolean;
}

export class RunBudget {
  readonly limits: RunLimits;
  readonly #now: () => number;
  readonly #started: number;
  readonly #signal: AbortSignal | undefined;
  #stopped: RunBudgetRecord["stopped"] = null;
  /** Holds not yet settled or released. */
  readonly #open = new Set<Held>();
  /** Each reservation's phases: the time a phase holds is its longest request's. */
  readonly #phaseMs = new Map<number, number[]>();
  #reservations = 0;
  #admitted = 0;
  /** Input counted for settled requests: reported where the provider said, estimated where it didn't. */
  #countedInput = 0;
  #reportedInput: number | null = 0;
  #reportedOutput: number | null = 0;
  #unreported = 0;
  #overrun = 0;

  constructor(limits: RunLimits, options: { signal?: AbortSignal | undefined; now?: () => number } = {}) {
    this.limits = limits;
    this.#now = options.now ?? (() => performance.now());
    this.#started = this.#now();
    this.#signal = options.signal;
    this.#signal?.addEventListener("abort", () => this.stop("cancelled"), { once: true });
  }

  get stopped(): RunBudgetRecord["stopped"] {
    return this.#stopped;
  }

  /** Stops admission for good. The first reason given is kept. */
  stop(reason: NonNullable<RunBudgetRecord["stopped"]>): void {
    this.#stopped ??= reason;
  }

  remainingMs(): number {
    return Math.max(0, this.limits.totalMs - (this.#now() - this.#started));
  }

  /** Input counted so far plus what open holds have reserved. */
  #committedInput(): number {
    let held = 0;
    for (const hold of this.#open) held += hold.ask.inputTokens;
    return this.#countedInput + held;
  }

  #requestsCommitted(): number {
    let open = 0;
    for (const hold of this.#open) if (!hold.admitted) open++;
    return this.#admitted + open;
  }

  #refusedNow(): Refusal | null {
    if (this.#signal?.aborted) this.stop("cancelled");
    if (this.remainingMs() <= 0) this.stop("deadline");
    if (this.#stopped) return { reason: this.#stopped === "exhausted" ? "exhausted" : this.#stopped, needed: 0, available: 0 };
    return null;
  }

  /**
   * Whether a request of `inputTokens` could be admitted now, keeping room for `keepInput` more after it (the answer
   * that must follow). Null when it fits; otherwise why not.
   */
  fits(inputTokens: number, keepInput = 0): Refusal | null {
    const stopped = this.#refusedNow();
    if (stopped) return stopped;
    if (this.#requestsCommitted() + 1 > this.limits.requests) return { reason: "requests", needed: 1, available: Math.max(0, this.limits.requests - this.#requestsCommitted()) };
    const available = this.limits.estimatedInputTokens - this.#committedInput();
    if (inputTokens + keepInput > available) return { reason: "input", needed: inputTokens + keepInput, available: Math.max(0, available) };
    return null;
  }

  /**
   * Holds room for every request of a run's phases at once, or for none: the phases run one after another, the requests
   * of a phase together. The time a reservation needs is the sum of each phase's longest request.
   */
  reserve(phases: readonly (readonly Ask[])[]): { ok: true; holds: Hold[][] } | { ok: false; refusal: Refusal } {
    const stopped = this.#refusedNow();
    if (stopped) return { ok: false, refusal: stopped };
    const asks = phases.flat();
    const requestsLeft = this.limits.requests - this.#requestsCommitted();
    if (asks.length > requestsLeft) return { ok: false, refusal: { reason: "requests", needed: asks.length, available: Math.max(0, requestsLeft) } };
    const input = asks.reduce((sum, ask) => sum + ask.inputTokens, 0);
    const available = this.limits.estimatedInputTokens - this.#committedInput();
    if (input > available) return { ok: false, refusal: { reason: "input", needed: input, available: Math.max(0, available) } };
    const phaseMs = phases.map((phase) => Math.max(0, ...phase.map((ask) => ask.ms)));
    const ms = phaseMs.reduce((sum, value) => sum + value, 0);
    if (ms > this.remainingMs()) return { ok: false, refusal: { reason: "time", needed: Math.round(ms), available: Math.round(this.remainingMs()) } };
    const reservation = this.#reservations++;
    this.#phaseMs.set(reservation, phaseMs);
    return { ok: true, holds: phases.map((phase, index) => phase.map((ask) => this.#hold(ask, reservation, index))) };
  }

  /** Holds room for one request, as a reservation of its own. */
  hold(ask: Ask): Hold | Refusal {
    const reserved = this.reserve([[ask]]);
    return reserved.ok ? reserved.holds[0]![0]! : reserved.refusal;
  }

  #hold(ask: Ask, reservation: number, phase: number): Hold {
    const held: Held = { ask, phase, reservation, admitted: false, done: false };
    this.#open.add(held);
    return {
      admit: () => {
        if (held.admitted || held.done) return { ok: false, refusal: { reason: "requests", needed: 1, available: 0 } };
        const stopped = this.#refusedNow();
        if (stopped) return { ok: false, refusal: stopped };
        // Time is kept for the phases after this one, so a slow request can't use up the chair's.
        const later = (this.#phaseMs.get(reservation) ?? []).slice(phase + 1).reduce((sum, value) => sum + value, 0);
        const ms = Math.min(ask.ms, this.remainingMs() - later);
        if (ms <= 0) return { ok: false, refusal: { reason: "time", needed: Math.round(ask.ms), available: Math.max(0, Math.round(this.remainingMs() - later)) } };
        held.admitted = true;
        this.#admitted++;
        return { ok: true, ms: Math.floor(ms) };
      },
      settle: (steps) => {
        if (held.done) return;
        held.done = true;
        this.#open.delete(held);
        if (!held.admitted) return;
        this.#count(held.ask, steps);
      },
      release: () => {
        if (held.done) return;
        held.done = true;
        this.#open.delete(held);
        // A request let go is counted even if it never answered: it may have reached the provider.
        if (held.admitted) this.#count(held.ask, []);
      },
    };
  }

  #count(ask: Ask, steps: readonly StepRecord[]): void {
    const reported = steps.filter((step) => step.inputTokens !== null);
    if (steps.length === 0 || reported.length < steps.length) {
      // A request that didn't say what it used counts as estimated, and leaves the reported totals unknown.
      this.#unreported++;
      this.#reportedInput = null;
      this.#reportedOutput = null;
    }
    if (steps.length === 0) {
      this.#countedInput += ask.inputTokens;
      return;
    }
    let input = 0;
    for (const step of steps) {
      if (step.inputTokens === null) {
        input += ask.inputTokens;
        continue;
      }
      input += step.inputTokens;
      if (this.#reportedInput !== null) this.#reportedInput += step.inputTokens;
      if (this.#reportedOutput !== null) this.#reportedOutput = step.outputTokens === null ? null : this.#reportedOutput + step.outputTokens;
    }
    this.#countedInput += input;
    if (input > ask.inputTokens) this.#overrun += input - ask.inputTokens;
  }

  record(): RunBudgetRecord {
    return {
      limits: { ...this.limits },
      used: {
        requests: this.#admitted,
        elapsedMs: Math.round(this.#now() - this.#started),
        inputTokens: Math.round(this.#countedInput),
        reportedInputTokens: this.#reportedInput,
        reportedOutputTokens: this.#reportedOutput,
        unreportedRequests: this.#unreported,
        overrunTokens: Math.round(this.#overrun),
      },
      stopped: this.#stopped,
    };
  }
}
