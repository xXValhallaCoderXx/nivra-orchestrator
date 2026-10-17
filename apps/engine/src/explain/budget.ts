import type { StepRecord } from "../providers/model.ts";

/**
 * The token budget for a whole request (D22): instructions, preferences, tool definitions, the history and repository
 * excerpts, with room for the answer held back (`requestBudget`). Every tool result is charged before it is returned,
 * and tool calls run one at a time, so a single response can't overrun it. Characters are converted to tokens
 * conservatively, and the estimate is corrected by what the provider reports for each request.
 */
export const CHARS_PER_TOKEN = 3;
/** A tool result smaller than this isn't worth sending: the model is told to answer instead. */
export const MIN_RESULT_CHARS = 800;

export class Budget {
  readonly tokens: number;
  #estimatedChars: number;
  #reportedTokens = 0;
  #charsSinceReport = 0;

  /** `fixedChars`: what every request carries (instructions, the question, the map, preferences, tool definitions). */
  constructor(tokens: number, fixedChars: number) {
    this.tokens = tokens;
    this.#estimatedChars = fixedChars;
  }

  /** Tokens the next request will carry, by the larger of the estimate and the provider's last report. */
  used(): number {
    const estimate = Math.ceil(this.#estimatedChars / CHARS_PER_TOKEN);
    const reported = this.#reportedTokens + Math.ceil(this.#charsSinceReport / CHARS_PER_TOKEN);
    return Math.max(estimate, reported);
  }

  remainingChars(): number {
    return Math.max(0, (this.tokens - this.used()) * CHARS_PER_TOKEN);
  }

  exhausted(): boolean {
    return this.remainingChars() < MIN_RESULT_CHARS;
  }

  charge(chars: number): void {
    this.#estimatedChars += chars;
    this.#charsSinceReport += chars;
  }

  /**
   * After a step: its request's prompt tokens plus its answer are what the next request carries, plus the tool
   * results charged during the step (tools run before the step is reported).
   */
  observe(step: StepRecord): void {
    if (step.inputTokens === null) return;
    this.#reportedTokens = step.inputTokens + (step.outputTokens ?? 0) + Math.ceil(this.#charsSinceReport / CHARS_PER_TOKEN);
    this.#charsSinceReport = 0;
  }
}
