import type { AnswerDueReason } from "@nivra/domain";

/** An explain run's whole budget, each model call's, and how many steps it may take (D22). */
export const EXPLAIN_LIMITS = { maxSteps: 16, stepMs: 150_000, totalMs: 480_000 } as const;

export type ExplainLimits = { maxSteps: number; stepMs: number; totalMs: number };

/** The last steps are kept for the answer, so one the tool turns down can be given again. */
export const ANSWER_STEPS = 3;

/**
 * Why the next step must be the answer (D22, D23); none while the model may keep reading. It is due in the last steps
 * allowed, when the budget is spent, or when there isn't time for one more exploring call and the answer after it.
 * Time is held back for the answer before another exploration starts, so a call started late can't use up the run's
 * deadline.
 */
export function mustAnswer(state: { stepNumber: number; elapsedMs: number; budgetExhausted: boolean }, limits: ExplainLimits = EXPLAIN_LIMITS): AnswerDueReason[] {
  const reasons: AnswerDueReason[] = [];
  if (state.stepNumber >= limits.maxSteps - ANSWER_STEPS) reasons.push("last-steps");
  if (state.elapsedMs + 2 * limits.stepMs > limits.totalMs) reasons.push("time");
  if (state.budgetExhausted) reasons.push("budget");
  return reasons;
}

/**
 * How many more exploring turns the model has after the one in progress, `step` (0-based), before the answer is due by
 * the step count (D23). Turns are model steps, not tool calls: one step can carry several calls.
 */
export function turnsBeforeAnswer(step: number, limits: ExplainLimits = EXPLAIN_LIMITS): number {
  return Math.max(0, limits.maxSteps - ANSWER_STEPS - step - 1);
}
