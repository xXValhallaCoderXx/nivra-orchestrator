import type { AnswerDueReason } from "@nivra/domain";

/** An explain run's whole budget, each model call's, and how many steps it may take (D22). */
export const EXPLAIN_LIMITS = { maxSteps: 16, stepMs: 150_000, totalMs: 480_000 } as const;

/**
 * The estimated input budget for a whole run that reads a repository (D30): explain, and a repository conversation's
 * turn. Each request re-sends what was read so far, so a run's input grows with every step; a live turn sent 219,488
 * tokens over 14 calls. 160,000 leaves the heaviest explain run seen (77,514) as it was, and makes a run that grows past
 * about 100,000 give its answer, since a full-window answer must still fit after the next request. An estimate, not a
 * ceiling: the provider's counts replace it as they arrive, and an overrun is recorded.
 */
export const READING_INPUT_TOKENS = 160_000;

export type ExplainLimits = { maxSteps: number; stepMs: number; totalMs: number };

/** The last steps are kept for the answer, so one the tool turns down can be given again. */
export const ANSWER_STEPS = 3;

/**
 * Why the next step must be the answer (D22, D23); none while the model may keep reading. It is due in the last steps
 * allowed, when the budget is spent, or when there isn't time for one more exploring call and the answer after it.
 * Time is held back for the answer before another exploration starts, so a call started late can't use up the run's
 * deadline.
 */
export function mustAnswer(
  state: { stepNumber: number; elapsedMs: number; budgetExhausted: boolean; runBudgetLow?: boolean },
  limits: ExplainLimits = EXPLAIN_LIMITS,
): AnswerDueReason[] {
  const reasons: AnswerDueReason[] = [];
  if (state.stepNumber >= limits.maxSteps - ANSWER_STEPS) reasons.push("last-steps");
  if (state.elapsedMs + 2 * limits.stepMs > limits.totalMs) reasons.push("time");
  if (state.budgetExhausted) reasons.push("budget");
  // The run's input budget can't hold another exploring request and a full answer after it (D30).
  if (state.runBudgetLow) reasons.push("run-budget");
  return reasons;
}

/**
 * Whether an answer turned down now could be given again (NIV-26): there must be a step left for it, the clock and the
 * budget must not have made the answer due (the time rule holds back one whole call only while it hasn't fired), and
 * once the answer is due the model must be one known to honour a forced answer, so the next one can't be lost to a
 * reply in text. With one step allowed it is never true, so a single-call run makes no repair request.
 */
export function canAnswerAgain(state: { stepNumber: number; dueReasons: readonly AnswerDueReason[]; forced: boolean }, limits: ExplainLimits = EXPLAIN_LIMITS): boolean {
  if (state.stepNumber + 1 >= limits.maxSteps) return false;
  if (state.dueReasons.includes("time") || state.dueReasons.includes("budget") || state.dueReasons.includes("run-budget")) return false;
  return state.dueReasons.length === 0 || state.forced;
}

/**
 * How many more exploring turns the model has after the one in progress, `step` (0-based), before the answer is due by
 * the step count (D23). Turns are model steps, not tool calls: one step can carry several calls.
 */
export function turnsBeforeAnswer(step: number, limits: ExplainLimits = EXPLAIN_LIMITS): number {
  return Math.max(0, limits.maxSteps - ANSWER_STEPS - step - 1);
}
