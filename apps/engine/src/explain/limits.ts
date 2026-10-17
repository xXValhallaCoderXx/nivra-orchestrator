/** An explain run's whole budget, each model call's, and how many steps it may take (D22). */
export const EXPLAIN_LIMITS = { maxSteps: 16, stepMs: 150_000, totalMs: 480_000 } as const;

export type ExplainLimits = { maxSteps: number; stepMs: number; totalMs: number };

/** The last steps are kept for the answer, so one the tool turns down can be given again. */
export const ANSWER_STEPS = 3;

/**
 * Whether the next step must be the answer (D22): in the last steps allowed, when the budget is spent, or when there
 * isn't time for one more exploring call and the answer after it. Time is held back for the answer before another
 * exploration starts, so a call started late can't use up the run's deadline.
 */
export function mustAnswer(state: { stepNumber: number; elapsedMs: number; budgetExhausted: boolean }, limits: ExplainLimits = EXPLAIN_LIMITS): boolean {
  return state.stepNumber >= limits.maxSteps - ANSWER_STEPS || state.budgetExhausted || state.elapsedMs + 2 * limits.stepMs > limits.totalMs;
}
