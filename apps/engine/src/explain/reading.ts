import type { AnswerDueReason, JsonObject, RunUsage } from "@nivra/domain";
import type { ModelPolicy } from "../providers/policy.ts";
import { failure, ModelFailure, toModelFailure, type InternalFailure, type ModelClient, type StepRecord } from "../providers/model.ts";
import type { Hold, Refusal, RunBudget } from "../providers/run-budget.ts";
import type { Budget } from "./budget.ts";
import { mustAnswer, type ExplainLimits } from "./limits.ts";

/**
 * The model reading a repository through the read tools until its hand-in tool accepts (D22, D23), shared by the
 * explain run and repository conversations (D26). Every request is recorded as a `model.call` event, a failed one
 * once as its own step; an answer due by the step count, the clock or the budget is forced through the hand-in tool
 * when the model is known to honour that.
 */

/** Where the loop is, shared with the tools it drives: how many steps have finished, and whether this one must answer. */
export class Reading {
  finished = 0;
  answerDue = false;
  /** Why the answer was due when it was given; none while the model may keep reading. */
  dueReasons: AnswerDueReason[] = [];
  /** Answers Mastra turned down because they didn't match the schema: the tool never saw them. */
  invalidAnswers = 0;
  /** The steps that gave those answers, so what they cost can be counted. */
  invalidAnswerSteps: number[] = [];
}

export interface ReadingOptions {
  client: ModelClient;
  agent: { id: string; name: string; instructions: string };
  model: string;
  prompt: string;
  tools: Record<string, unknown>;
  /** The hand-in tool's name. */
  answerTool: string;
  accepted: () => boolean;
  policy: ModelPolicy;
  budget: Budget;
  /**
   * The run's shared limits (D30): each request is held and admitted before it is sent, and the run stops, never sending
   * it, when its estimated input can't be admitted.
   */
  runBudget: RunBudget;
  reading: Reading;
  state: { budgetExhausted: boolean };
  internal: InternalFailure;
  signal?: AbortSignal | undefined;
  limits: ExplainLimits;
  maxOutputTokens: number;
  /** Records one of the run's events. */
  event: (type: "model.call" | "tool.called", message: string, data: JsonObject) => void;
}

/** The usage a run's calls reported: totals stay null once one call didn't say, never 0 (D22). */
export function usageOf(steps: readonly StepRecord[]): RunUsage {
  const reported = steps.filter((step) => step.inputTokens !== null && step.outputTokens !== null);
  const all = reported.length === steps.length && steps.length > 0;
  return {
    inputTokens: all ? reported.reduce((sum, step) => sum + step.inputTokens!, 0) : null,
    outputTokens: all ? reported.reduce((sum, step) => sum + step.outputTokens!, 0) : null,
    calls: steps.length,
    reportedCalls: reported.length,
  };
}

/**
 * What the answers turned down cost (NIV-26): the steps that gave them, by step number, with their tokens as reported
 * (null once one of them didn't say, never 0) and their time. A step that gave two refused answers counts once.
 */
export function turnedDownCost(steps: readonly StepRecord[], stepNumbers: readonly number[]): { steps: number; inputTokens: number | null; outputTokens: number | null; elapsedMs: number } {
  const wanted = new Set(stepNumbers);
  const refused = steps.filter((step) => wanted.has(step.stepNumber));
  const reported = refused.every((step) => step.inputTokens !== null && step.outputTokens !== null);
  return {
    steps: refused.length,
    inputTokens: reported ? refused.reduce((sum, step) => sum + step.inputTokens!, 0) : null,
    outputTokens: reported ? refused.reduce((sum, step) => sum + step.outputTokens!, 0) : null,
    elapsedMs: Math.round(refused.reduce((sum, step) => sum + step.elapsedMs, 0)),
  };
}

/** The answers turned down before none was accepted, by cause, for a failure's message: empty when there were none. */
export function turnedDownText(refusals: { citations: number; conflicts: number; findings: number; schema: number }): string {
  const causes: Array<[number, string]> = [
    [refusals.citations, "citations"],
    [refusals.conflicts, "conflicts"],
    [refusals.findings, "findings"],
    [refusals.schema, "shape"],
  ];
  const total = causes.reduce((sum, [n]) => sum + n, 0);
  if (!total) return "";
  const parts = causes.filter(([n]) => n > 0).map(([n, cause]) => (cause === "findings" ? `${n} for having no findings` : `${n} for ${n === 1 ? "its" : "their"} ${cause}`));
  return `; ${total} turned down (${parts.join(", ")})`;
}

/** Why the run's budget stopped it, in Nivra's words (D30): it used its input budget, or ran out of time or requests. */
export function runBudgetFailure(refusal: Refusal): ModelFailure {
  if (refusal.reason === "cancelled") return new ModelFailure("cancelled", "Cancelled.");
  if (refusal.reason === "time" || refusal.reason === "deadline") return failure("timeout", "the run's time ran out before its next model call");
  if (refusal.reason === "requests") return failure("budget-exhausted", "it made every model call it may");
  return failure("budget-exhausted", `the next model call needed about ${refusal.needed.toLocaleString("en")} tokens, and about ${refusal.available.toLocaleString("en")} were left`);
}

/** Runs the loop. Returns every request made, a failed one included, and the failure that ended it, if one did. */
export async function readUntilAnswered(options: ReadingOptions): Promise<{ steps: StepRecord[]; failed: ModelFailure | null }> {
  const { client, reading, budget, state, policy, model, runBudget } = options;
  const steps: StepRecord[] = [];
  // The first request is refused before it is sent if the run's budget can't admit it (D30).
  const first = runBudget.fits(budget.used());
  if (first) {
    if (first.reason === "input") runBudget.stop("exhausted");
    return { steps, failed: runBudgetFailure(first) };
  }
  const agent = client.agent({ id: options.agent.id, name: options.agent.name, modelId: model, instructions: options.agent.instructions, tools: options.tools });
  const started = performance.now();
  let failed: ModelFailure | null = null;
  // The step in flight's room in the run's budget, settled when the step is reported.
  const flight: { hold: Hold | null } = { hold: null };
  try {
    await client.call(agent, options.prompt, {
      maxSteps: options.limits.maxSteps,
      deadlines: { stepMs: options.limits.stepMs, totalMs: options.limits.totalMs },
      maxOutputTokens: options.maxOutputTokens,
      toolChoice: policy.explore,
      // A step that can't be admitted is never sent: the run stops, and ends as having used its budget (D30).
      stopWhen: () => {
        if (options.accepted()) return true;
        const next = runBudget.fits(budget.used());
        if (next?.reason === "input") runBudget.stop("exhausted");
        return next !== null;
      },
      // An exploring step starts only with time left for it and for the answer after it (D22).
      prepareStep: ({ stepNumber }) => {
        const next = budget.used();
        // Room for this request and a full-window answer after it, or the answer is due now (D30).
        const runBudgetLow = runBudget.fits(next, Math.max(0, budget.tokens)) !== null;
        const held = runBudget.hold({ inputTokens: next, ms: options.limits.stepMs });
        if ("admit" in held) {
          held.admit();
          flight.hold = held;
        }
        reading.dueReasons = mustAnswer({ stepNumber, elapsedMs: performance.now() - started, budgetExhausted: budget.exhausted(), runBudgetLow }, options.limits);
        reading.answerDue = reading.dueReasons.length > 0;
        // However the budget runs out, the run records that it did.
        if (reading.dueReasons.includes("budget")) state.budgetExhausted = true;
        if (!reading.answerDue) return { toolChoice: policy.explore };
        return { activeTools: [options.answerTool], toolChoice: policy.forceAnswer ? { type: "tool", toolName: options.answerTool } : "auto" };
      },
      internal: options.internal,
      ...(options.signal ? { signal: options.signal } : {}),
      onStep: (step) => {
        reading.finished++;
        steps.push(step);
        budget.observe(step);
        flight.hold?.settle([step]);
        flight.hold = null;
        for (const rejected of step.rejectedTools) {
          if (rejected.tool === options.answerTool) {
            reading.invalidAnswers++;
            reading.invalidAnswerSteps.push(step.stepNumber);
          }
          const count = rejected.problems.length;
          options.event("tool.called", `${rejected.tool} refused: its input didn't match the tool's schema (${count} ${count === 1 ? "problem" : "problems"})`, {
            tool: rejected.tool,
            step: step.stepNumber,
            refused: "invalid input",
            problems: rejected.problems,
          });
        }
        const tokens = step.inputTokens !== null && step.outputTokens !== null ? `${step.inputTokens} in / ${step.outputTokens} out tokens` : "tokens not reported";
        options.event("model.call", `Model step ${step.stepNumber + 1}: ${tokens}, ${(step.elapsedMs / 1000).toFixed(1)} s${step.toolNames.length ? ` (${step.toolNames.join(", ")})` : ""}`, {
          step: step.stepNumber,
          model,
          elapsedMs: step.elapsedMs,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          finishReason: step.finishReason,
          tools: step.toolNames,
          remainingTokens: step.rateLimit.remainingTokens,
        });
      },
    });
  } catch (error) {
    failed = error instanceof ModelFailure ? error : toModelFailure(error, "reading");
    // The request that failed is recorded once, as its own step: its own time, no usage, and why (D22). A failure
    // inside Nivra made no request, so it is the run's failure alone.
    const request = failed.failedStep;
    flight.hold?.settle(request ? [request] : []);
    flight.hold = null;
    if (request) {
      steps.push(request);
      options.event("model.call", `Model call failed: ${failed.message}`, {
        step: request.stepNumber,
        model,
        elapsedMs: request.elapsedMs,
        inputTokens: null,
        outputTokens: null,
        kind: failed.kind,
        ...(failed.retryAfterSeconds !== null ? { retryAfterSeconds: failed.retryAfterSeconds } : {}),
      });
    }
  }
  if (!failed && !options.accepted() && runBudget.stopped === "exhausted") {
    failed = runBudgetFailure(runBudget.fits(budget.used()) ?? { reason: "input", needed: budget.used(), available: 0 });
  }
  return { steps, failed };
}
