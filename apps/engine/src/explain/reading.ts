import type { AnswerDueReason, JsonObject, RunUsage } from "@nivra/domain";
import type { ModelPolicy } from "../providers/policy.ts";
import { failure, ModelFailure, type InternalFailure, type ModelClient, type StepRecord } from "../providers/model.ts";
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

/** Runs the loop. Returns every request made, a failed one included, and the failure that ended it, if one did. */
export async function readUntilAnswered(options: ReadingOptions): Promise<{ steps: StepRecord[]; failed: ModelFailure | null }> {
  const { client, reading, budget, state, policy, model } = options;
  const agent = client.agent({ id: options.agent.id, name: options.agent.name, modelId: model, instructions: options.agent.instructions, tools: options.tools });
  const started = performance.now();
  const steps: StepRecord[] = [];
  let failed: ModelFailure | null = null;
  try {
    await client.call(agent, options.prompt, {
      maxSteps: options.limits.maxSteps,
      deadlines: { stepMs: options.limits.stepMs, totalMs: options.limits.totalMs },
      maxOutputTokens: options.maxOutputTokens,
      toolChoice: policy.explore,
      stopWhen: options.accepted,
      // An exploring step starts only with time left for it and for the answer after it (D22).
      prepareStep: ({ stepNumber }) => {
        reading.dueReasons = mustAnswer({ stepNumber, elapsedMs: performance.now() - started, budgetExhausted: budget.exhausted() }, options.limits);
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
        for (const rejected of step.rejectedTools) {
          if (rejected.tool === options.answerTool) reading.invalidAnswers++;
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
    failed = error instanceof ModelFailure ? error : failure("internal", error instanceof Error ? error.name : typeof error);
    // The request that failed is recorded once, as its own step: its own time, no usage, and why (D22). A failure
    // inside Nivra made no request, so it is the run's failure alone.
    const request = failed.failedStep;
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
  return { steps, failed };
}
