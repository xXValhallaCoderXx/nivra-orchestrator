import { createStep, createWorkflow } from "@mastra/core/workflows";
import { preferencesDigest, type AnswerDueReason, type ExplainResult, type JsonObject, type RunContext, type RunRoute, type RunUsage } from "@nivra/domain";
import { z } from "zod";
import { installGitAdvice } from "../advice.ts";
import type { ExecutionBackend } from "../exec/backend.ts";
import { Budget } from "../explain/budget.ts";
import { checkCitation } from "../explain/citations.ts";
import { Ledger } from "../explain/ledger.ts";
import { EXPLAIN_LIMITS, mustAnswer } from "../explain/limits.ts";
import { rankConflict } from "../explain/precedence.ts";
import { DEFAULT_QUESTION, explainPrompt, INSTRUCTIONS } from "../explain/prompt.ts";
import { TaskUnreadable, type ExplainTask } from "../explain/task.ts";
import { createExplainTools, toolDefinitionChars } from "../explain/tools.ts";
import { ANSWER_TOKENS, policyFor, requestBudget } from "../providers/policy.ts";
import { createModelClient, failure, InternalFailure, ModelFailure, type Endpoint, type ModelClient, type StepRecord } from "../providers/model.ts";
import { pickNemotron } from "../providers/tokenfactory.ts";
import { RepoReader } from "../repo/files.ts";
import { buildMap } from "../repo/map.ts";
import { describePreferences } from "./preferences-record.ts";
import { RepoError } from "../repo/paths.ts";
import type { Mask } from "../secrets/patterns.ts";

export const EXPLAIN_WORKFLOW_ID = "explain";

export interface ExplainRecorder {
  output(runId: string, stepId: string, message: string, data?: JsonObject): void;
  event(runId: string, type: "model.call" | "tool.called", stepId: string, message: string, data: JsonObject): void;
}

export interface ExplainDeps {
  backend: ExecutionBackend;
  recorder: ExplainRecorder;
  findGit: () => string | null;
  platform: NodeJS.Platform;
  /** What the host sent with the run, held in memory by the scheduler (D21). */
  context: (runId: string) => RunContext | null;
  /** The person's question and choices, from the run store: they never pass through Mastra (D22, D23). */
  task: (runId: string) => ExplainTask | null;
  apiKey: () => string | null;
  endpoint: Endpoint;
  mask: Mask;
  setMeta: (runId: string, meta: { usage?: RunUsage; route?: RunRoute }) => void;
  saveResult: (runId: string, result: ExplainResult) => void;
  /** Tests only, in-process: a client over a mock model. */
  modelClient?: (apiKey: string, endpoint: Endpoint) => ModelClient;
}

const Input = z.strictObject({ repoPath: z.string() });
const Prepared = z.strictObject({ root: z.string(), head: z.string().nullable(), model: z.string(), contextLength: z.number().nullable() });
const Explained = z.strictObject({ citations: z.number().int(), checked: z.number().int() });

/** The usage a run's calls reported: totals stay null once one call didn't say, never 0 (D22). */
function usageOf(steps: readonly StepRecord[]): RunUsage {
  const reported = steps.filter((step) => step.inputTokens !== null && step.outputTokens !== null);
  const all = reported.length === steps.length && steps.length > 0;
  return {
    inputTokens: all ? reported.reduce((sum, step) => sum + step.inputTokens!, 0) : null,
    outputTokens: all ? reported.reduce((sum, step) => sum + step.outputTokens!, 0) : null,
    calls: steps.length,
    reportedCalls: reported.length,
  };
}

export function createExplainWorkflow(deps: ExplainDeps) {
  const clientFor = (key: string) => (deps.modelClient ? deps.modelClient(key, deps.endpoint) : createModelClient({ apiKey: key, endpoint: deps.endpoint }));

  /** The run's consent and key, checked before anything is sent anywhere. */
  const allowed = (runId: string): { context: RunContext; key: string } => {
    const context = deps.context(runId);
    if (!context) throw failure("internal", "this run's context is missing");
    if (!context.sharing.modelContext) throw failure("sharing-refused");
    const key = deps.apiKey();
    if (!key) throw failure("no-key");
    return { context, key };
  };

  const openReader = async (root: string, signal: AbortSignal | undefined) => {
    const git = deps.findGit();
    if (!git) throw new RepoError(`Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(deps.platform)}`);
    const session = await deps.backend.open({ workspace: root });
    try {
      return { reader: await RepoReader.open({ root, session, git, mask: deps.mask, signal }), session };
    } catch (error) {
      await session.close();
      throw error;
    }
  };

  // What the run was given is recorded first, even when it is refused: ids, revisions and a fingerprint, never text.
  const context = createStep({
    id: "context",
    description: "Record the preferences the app sent with the run, without their text",
    inputSchema: Input,
    outputSchema: Input,
    execute: async ({ inputData, runId }) => {
      const given = deps.context(runId);
      if (!given) throw failure("internal", "this run's context is missing");
      const { message, data } = await describePreferences(given.preferences);
      deps.recorder.output(runId, "context", message, data);
      // Before anything is sent anywhere: a task that can't be read back never becomes the default question.
      if (!deps.task(runId)) throw new TaskUnreadable();
      return inputData;
    },
  });

  const prepare = createStep({
    id: "prepare",
    description: "Check consent and the key, resolve the repository, read HEAD, and pick the model",
    inputSchema: Input,
    outputSchema: Prepared,
    execute: async ({ inputData, runId, abortSignal }) => {
      const { key } = allowed(runId);
      const { reader, session } = await openReader(inputData.repoPath, abortSignal);
      let head: string | null;
      try {
        head = await reader.head();
      } finally {
        await session.close();
      }
      const client = clientFor(key);
      const models = await client.listModels({ signal: abortSignal, timeoutMs: 30_000 });
      const model = pickNemotron(models.ids);
      if (!model) throw failure("model-unavailable", "no NVIDIA model is listed for this key");
      deps.setMeta(runId, { route: { provider: "nebius", endpoint: deps.endpoint.kind, model } });
      deps.recorder.output(runId, "prepare", `Repository at ${head ? head.slice(0, 12) : "no commits yet"} (HEAD at run start); model ${model}`, {
        root: reader.root,
        head,
        model,
        contextLength: models.contextLengths.get(model) ?? null,
        trackedFiles: reader.readable.size,
        hiddenFiles: reader.hidden.size,
      });
      return { root: reader.root, head, model, contextLength: models.contextLengths.get(model) ?? null };
    },
  });

  const explain = createStep({
    id: "explain",
    description: "Read the repository with the model and check its answer's citations",
    inputSchema: Prepared,
    outputSchema: Explained,
    execute: async ({ inputData, runId, abortSignal }) => {
      const { context, key } = allowed(runId);
      const task = deps.task(runId);
      if (!task) throw new TaskUnreadable();
      const question = task.question.trim() || DEFAULT_QUESTION;
      const choiceIds = new Set(task.choices.map((choice) => choice.id));
      const { reader, session } = await openReader(inputData.root, abortSignal);
      try {
        const ledger = new Ledger();
        const map = await buildMap(reader, inputData.head);
        // Folder and file names can carry a secret too, so the map is masked like every tool result, and the budget
        // counts what is actually sent. The ledger keeps the true paths: they are what citations are checked against.
        const mapText = deps.mask(map.text);
        // The map is delivered before the first step.
        ledger.record(-1, "map", map.sources.map((source) => ({ path: source.path, startLine: 1, endLine: source.lines, sha256: source.sha256 })), mapText.length);
        const prompt = explainPrompt(question, mapText, context.preferences, task.choices);
        const definitions = toolDefinitionChars();
        const budget = new Budget(requestBudget(inputData.contextLength), INSTRUCTIONS.length + prompt.length + definitions);
        const beforeReading = budget.used();
        deps.recorder.output(runId, "explain", `Request budget: ${budget.tokens} tokens, about ${beforeReading} of them before any reading`, {
          tokens: budget.tokens,
          beforeReading,
          toolDefinitionChars: definitions,
          contextLength: inputData.contextLength,
        });
        // A model whose context can't hold the instructions and the map with room to read is refused before any chat
        // request is made (D23), never sent more than it allows.
        if (budget.exhausted()) {
          throw failure(
            "context-too-small",
            `about ${beforeReading} tokens are needed before any reading, and ${Math.max(0, budget.tokens)} are available once ${ANSWER_TOKENS} are held back for the answer, which leaves no room to read`,
          );
        }
        const policy = policyFor(inputData.model);
        const internal = new InternalFailure();
        let finished = 0;
        // Set before each step: whether it must give the answer, which is then accepted whatever it cites, and why.
        let answerDue = false;
        let dueReasons: AnswerDueReason[] = [];
        // Answers Mastra turned down because they didn't match the schema: the tool never saw them.
        let invalidAnswers = 0;
        const { tools, state } = createExplainTools({
          reader,
          ledger,
          budget,
          mask: deps.mask,
          internal,
          step: () => finished,
          answerDue: () => answerDue,
          preferences: context.preferences,
          choices: choiceIds,
          signal: abortSignal,
          onTool: (event) => deps.recorder.event(runId, "tool.called", "explain", event.message, event.data),
        });
        const client = clientFor(key);
        const agent = client.agent({ id: "nivra-explain", name: "Nivra explain", modelId: inputData.model, instructions: INSTRUCTIONS, tools });
        const started = performance.now();
        const steps: StepRecord[] = [];
        let failed: ModelFailure | null = null;
        try {
          await client.call(agent, prompt, {
            maxSteps: EXPLAIN_LIMITS.maxSteps,
            deadlines: { stepMs: EXPLAIN_LIMITS.stepMs, totalMs: EXPLAIN_LIMITS.totalMs },
            maxOutputTokens: ANSWER_TOKENS,
            toolChoice: policy.explore,
            stopWhen: () => state.accepted !== null,
            // An exploring step starts only with time left for it and for the answer after it (D22).
            prepareStep: ({ stepNumber }) => {
              dueReasons = mustAnswer({ stepNumber, elapsedMs: performance.now() - started, budgetExhausted: budget.exhausted() });
              answerDue = dueReasons.length > 0;
              // However the budget runs out, the run records that it did.
              if (dueReasons.includes("budget")) state.budgetExhausted = true;
              if (!answerDue) return { toolChoice: policy.explore };
              return { activeTools: ["submit_answer"], toolChoice: policy.forceAnswer ? { type: "tool", toolName: "submit_answer" } : "auto" };
            },
            internal,
            ...(abortSignal ? { signal: abortSignal } : {}),
            onStep: (step) => {
              finished++;
              steps.push(step);
              budget.observe(step);
              for (const rejected of step.rejectedTools) {
                if (rejected.tool === "submit_answer") invalidAnswers++;
                const count = rejected.problems.length;
                deps.recorder.event(runId, "tool.called", "explain", `${rejected.tool} refused: its input didn't match the tool's schema (${count} ${count === 1 ? "problem" : "problems"})`, {
                  tool: rejected.tool,
                  step: step.stepNumber,
                  refused: "invalid input",
                  problems: rejected.problems,
                });
              }
              const tokens = step.inputTokens !== null && step.outputTokens !== null ? `${step.inputTokens} in / ${step.outputTokens} out tokens` : "tokens not reported";
              deps.recorder.event(runId, "model.call", "explain", `Model step ${step.stepNumber + 1}: ${tokens}, ${(step.elapsedMs / 1000).toFixed(1)} s${step.toolNames.length ? ` (${step.toolNames.join(", ")})` : ""}`, {
                step: step.stepNumber,
                model: inputData.model,
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
            deps.recorder.event(runId, "model.call", "explain", `Model call failed: ${failed.message}`, {
              step: request.stepNumber,
              model: inputData.model,
              elapsedMs: request.elapsedMs,
              inputTokens: null,
              outputTokens: null,
              kind: failed.kind,
              ...(failed.retryAfterSeconds !== null ? { retryAfterSeconds: failed.retryAfterSeconds } : {}),
            });
          }
        }
        deps.setMeta(runId, { usage: usageOf(steps) });
        if (failed) throw failed;
        if (!state.accepted || state.answerStep === null) {
          const turnedDown = state.rejected + invalidAnswers;
          throw failure("malformed", `no answer was accepted within ${steps.length} model ${steps.length === 1 ? "step" : "steps"}${turnedDown ? `; ${turnedDown} turned down` : ""}`);
        }
        const answer = state.accepted;
        const answerStep = state.answerStep;
        const check = (citations: typeof answer.findings[number]["citations"]) => citations.map((citation) => checkCitation(citation, ledger.entries, answerStep));
        const findings = answer.findings.map((finding) => ({ statement: finding.statement, citations: check(finding.citations) }));
        // The engine ranks what the model reported (D23): who governs never comes from the model's words.
        const conflicts = answer.conflicts.map((conflict) => rankConflict(conflict, check(conflict.citations), context.preferences.records, choiceIds));
        // A suggestion keeps only lines the model was shown, and goes when none are left: nothing unsupported is offered.
        const suggestions = answer.suggestions.flatMap((suggestion) => {
          const shown = check(suggestion.citations).filter((citation) => citation.checked);
          return shown.length ? [{ statement: suggestion.statement, citations: shown }] : [];
        });
        const suggestionsDropped = answer.suggestions.length - suggestions.length;
        const all = [...findings, ...conflicts].flatMap((item) => item.citations);
        const checked = all.filter((citation) => citation.checked).length;
        const records = context.preferences.records;
        // What the context view shows (D23): what the run was given, what was left out, and how the budget and the answer went.
        const details = {
          preferences: { revision: context.preferences.revision, digest: await preferencesDigest(records), records: records.map(({ id, scope, intent, revision }) => ({ id, scope, intent, revision })) },
          hidden: map.hidden,
          budget: { tokens: budget.tokens, estimatedTokens: budget.used(), resultsLimited: state.resultsLimited, resultsReplaced: state.resultsReplaced, ranOut: state.budgetExhausted },
          answer: {
            dueReasons,
            refusals: { citations: state.citationRefusals, conflicts: state.conflictRefusals, schema: invalidAnswers },
            acceptedAfterRefusals: state.rejected + invalidAnswers,
            conflictsDropped: state.conflictsDropped,
            suggestionsDropped,
          },
        };
        const result: ExplainResult = {
          question,
          choices: task.choices,
          headAtStart: inputData.head,
          headAtEnd: await reader.head(),
          summary: answer.summary,
          findings,
          conflicts,
          suggestions,
          preferenceDifferences: [],
          gaps: answer.gaps,
          context: { ...ledger.context(), ...details },
          checks: { citations: all.length, checked },
          answeredAtStep: answerStep,
          finishedAt: new Date().toISOString(),
        };
        deps.saveResult(runId, result);
        deps.recorder.output(runId, "explain", `${checked} of ${all.length} citations point to lines the model was shown`, {
          citations: all.length,
          checked,
          changedFiles: result.context.changedFiles,
          headChanged: result.headAtEnd !== result.headAtStart,
          conflicts: conflicts.length,
          unresolved: conflicts.filter((conflict) => conflict.reason === "unresolved").length,
          conflictsDropped: state.conflictsDropped,
          suggestions: suggestions.length,
          suggestionsDropped,
        });
        return { citations: all.length, checked };
      } finally {
        await session.close();
      }
    },
  });

  return createWorkflow({
    id: EXPLAIN_WORKFLOW_ID,
    description: "Explains a repository with evidence, reading it read-only through fixed tools",
    inputSchema: Input,
    outputSchema: Explained,
    // Recovery belongs to the run scheduler: a run interrupted by a restart is marked failed, never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(context)
    .then(prepare)
    .then(explain)
    .commit();
}
