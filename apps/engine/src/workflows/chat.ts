import { createStep, createWorkflow } from "@mastra/core/workflows";
import { preferencesDigest, type ChatContext, type ChatResult, type GeneralReply, type Mask, type PreferencesReceived, type PreferenceSnapshot, type RepositoryReply, type RunRoute, type RunUsage } from "@nivra/domain";
import { z } from "zod";
import { installGitAdvice } from "../advice.ts";
import { describeHistory, generalPrompt, GENERAL_INSTRUCTIONS, historySection, REPOSITORY_INSTRUCTIONS, repositoryPrompt } from "../chat/prompt.ts";
import { ChatUnreadable, type ChatTask } from "../chat/task.ts";
import type { ExecutionBackend } from "../exec/backend.ts";
import { Budget } from "../explain/budget.ts";
import { checkCitation } from "../explain/citations.ts";
import { Ledger } from "../explain/ledger.ts";
import { canAnswerAgain, EXPLAIN_LIMITS } from "../explain/limits.ts";
import { rankConflict } from "../explain/precedence.ts";
import { Reading, readUntilAnswered, turnedDownCost, turnedDownText, usageOf } from "../explain/reading.ts";
import { createReplyTools, REPLY_TOOL_SPECS, toolDefinitionChars } from "../explain/tools.ts";
import { ANSWER_TOKENS, policyFor, requestBudget } from "../providers/policy.ts";
import { createModelClient, failure, InternalFailure, ModelFailure, toModelFailure, type Endpoint, type ModelClient, type StepRecord } from "../providers/model.ts";
import { pickNemotron } from "../providers/tokenfactory.ts";
import { RepoReader } from "../repo/files.ts";
import { buildMap } from "../repo/map.ts";
import { RepoError } from "../repo/paths.ts";
import type { ExplainRecorder } from "./explain.ts";
import { guard } from "./guard.ts";
import { describePreferences } from "./preferences-record.ts";

export const CHAT_WORKFLOW_ID = "chat";

/** A general turn makes one model call, with its own deadline and one for the run (D22). */
export const GENERAL_LIMITS = { stepMs: 150_000, totalMs: 180_000 } as const;

export interface ChatDeps {
  backend: ExecutionBackend;
  recorder: ExplainRecorder;
  findGit: () => string | null;
  platform: NodeJS.Platform;
  /** What the host sent with the run, held in memory by the scheduler (D21, D26). */
  context: (runId: string) => ChatContext | null;
  /** The person's message and the scope, from the run store: they never pass through Mastra (D22). */
  task: (runId: string) => ChatTask | null;
  apiKey: () => string | null;
  endpoint: Endpoint;
  mask: Mask;
  setMeta: (runId: string, meta: { usage?: RunUsage; route?: RunRoute }) => void;
  saveResult: (runId: string, result: ChatResult) => void;
  /** Tests only, in-process: a client over a mock model. */
  modelClient?: (apiKey: string, endpoint: Endpoint) => ModelClient;
}

const Input = z.strictObject({ repoPath: z.string().nullable() });
const Prepared = z.strictObject({ root: z.string().nullable(), head: z.string().nullable(), model: z.string(), contextLength: z.number().nullable() });
const Replied = z.strictObject({ kind: z.enum(["general", "repository"]), citations: z.number().int(), checked: z.number().int() });

async function preferencesReceived(preferences: PreferenceSnapshot): Promise<PreferencesReceived> {
  const { revision, records } = preferences;
  return { revision, digest: await preferencesDigest(records), records: records.map(({ id, scope, intent, revision }) => ({ id, scope, intent, revision })) };
}

/**
 * A conversation's turn (D26). A general turn makes one call with no tools: no repository, path or project preference
 * reaches it. A repository turn reads the project's tracked files with the explain run's tools, under its consent,
 * budget, citation checks and precedence (D22, D23), and hands in a reply that keeps evidence, proposals and
 * assumptions apart. Only the repository's path passes through Mastra.
 */
export function createChatWorkflow(deps: ChatDeps) {
  const clientFor = (key: string) => (deps.modelClient ? deps.modelClient(key, deps.endpoint) : createModelClient({ apiKey: key, endpoint: deps.endpoint }));

  const given = (runId: string): ChatContext => {
    const context = deps.context(runId);
    if (!context) throw failure("internal", "this run's context is missing").because("context-missing", "chat.context");
    return context;
  };

  const taskOf = (runId: string): ChatTask => {
    const task = deps.task(runId);
    if (!task) throw new ChatUnreadable();
    return task;
  };

  /** The key, and a repository turn's consent, checked before anything is sent anywhere. */
  const allowed = (runId: string, task: ChatTask): { context: ChatContext; key: string } => {
    const context = given(runId);
    if (task.scope.kind === "repository" && !context.sharing.modelContext) throw failure("sharing-refused");
    const key = deps.apiKey();
    if (!key) throw failure("no-key");
    return { context, key };
  };

  const openReader = async (root: string, signal: AbortSignal | undefined) => {
    const git = deps.findGit();
    if (!git) throw new RepoError("git-missing", `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(deps.platform)}`);
    const session = await deps.backend.open({ workspace: root });
    try {
      return { reader: await RepoReader.open({ root, session, git, mask: deps.mask, signal }), session };
    } catch (error) {
      await session.close();
      throw error;
    }
  };

  // What the turn was given is recorded first, even when it is refused: ids, revisions, counts and fingerprints.
  const context = createStep({
    id: "context",
    description: "Record the preferences and history the app sent with the turn, without their text",
    inputSchema: Input,
    outputSchema: Input,
    execute: async ({ inputData, runId }) => guard("chat.context", deps.mask, async () => {
      const turn = given(runId);
      const preferences = await describePreferences(turn.preferences);
      deps.recorder.output(runId, "context", preferences.message, preferences.data);
      const history = await describeHistory(turn.history);
      deps.recorder.output(runId, "context", history.message, history.data);
      const task = taskOf(runId);
      // A general conversation belongs to no project, so a project's own preference never reaches it (D21, D26).
      if (task.scope.kind === "general" && turn.preferences.records.some((record) => record.scope !== "personal")) {
        throw failure("internal", "a general conversation was sent a project's own preference").because("input-refused", "chat.context");
      }
      return inputData;
    }),
  });

  const prepare = createStep({
    id: "prepare",
    description: "Check the key and consent, read HEAD for a repository, and pick the model",
    inputSchema: Input,
    outputSchema: Prepared,
    execute: async ({ inputData, runId, abortSignal }) => guard("chat.prepare", deps.mask, async () => {
      const task = taskOf(runId);
      const { key } = allowed(runId, task);
      let root: string | null = null;
      let head: string | null = null;
      let files: { trackedFiles: number; hiddenFiles: number } | null = null;
      if (task.scope.kind === "repository" && inputData.repoPath) {
        const { reader, session } = await openReader(inputData.repoPath, abortSignal);
        try {
          head = await reader.head();
          root = reader.root;
          files = { trackedFiles: reader.readable.size, hiddenFiles: reader.hidden.size };
        } finally {
          await session.close();
        }
      }
      const client = clientFor(key);
      const models = await client.listModels({ signal: abortSignal, timeoutMs: 30_000 });
      const model = pickNemotron(models.ids);
      if (!model) throw failure("model-unavailable", "no NVIDIA model is listed for this key");
      deps.setMeta(runId, { route: { provider: "nebius", endpoint: deps.endpoint.kind, model } });
      const where = task.scope.kind === "repository" ? `Repository at ${head ? head.slice(0, 12) : "no commits yet"} (HEAD at run start); ` : "No repository: a general conversation; ";
      deps.recorder.output(runId, "prepare", `${where}model ${model}`, { root, head, model, contextLength: models.contextLengths.get(model) ?? null, ...(files ?? {}) });
      return { root, head, model, contextLength: models.contextLengths.get(model) ?? null };
    }),
  });

  const reply = createStep({
    id: "reply",
    description: "Reply to the person's message, reading the repository for a repository conversation",
    inputSchema: Prepared,
    outputSchema: Replied,
    execute: async ({ inputData, runId, abortSignal }) => guard("chat.reply", deps.mask, async () => {
      const task = taskOf(runId);
      const { context: turn, key } = allowed(runId, task);
      const preferences = await preferencesReceived(turn.preferences);
      const history = (await describeHistory(turn.history)).record;
      if (task.scope.kind === "general" || inputData.root === null) return general(runId, task, turn, key, inputData, abortSignal, { preferences, history });
      return repository(runId, task, turn, key, { ...inputData, root: inputData.root }, abortSignal, { preferences, history });
    }),
  });

  /** One call, no tools: nothing from a repository can reach it. An empty reply is never a useful answer. */
  async function general(
    runId: string,
    task: ChatTask,
    turn: ChatContext,
    key: string,
    prepared: z.infer<typeof Prepared>,
    signal: AbortSignal | undefined,
    recorded: GeneralReply["context"],
  ): Promise<z.infer<typeof Replied>> {
    const prompt = generalPrompt(task.message, turn.preferences, historySection(turn.history, deps.mask, "general"));
    const budget = new Budget(requestBudget(prepared.contextLength), GENERAL_INSTRUCTIONS.length + prompt.length);
    if (budget.used() > budget.tokens) {
      throw failure("context-too-small", `about ${budget.used()} tokens are needed for this message and its history, and ${Math.max(0, budget.tokens)} are available once ${ANSWER_TOKENS} are held back for the reply`);
    }
    const client = clientFor(key);
    const agent = client.agent({ id: "nivra-chat", name: "Nivra chat", modelId: prepared.model, instructions: GENERAL_INSTRUCTIONS, tools: {} });
    const steps: StepRecord[] = [];
    const record = (step: StepRecord) => {
      const tokens = step.inputTokens !== null && step.outputTokens !== null ? `${step.inputTokens} in / ${step.outputTokens} out tokens` : "tokens not reported";
      deps.recorder.event(runId, "model.call", "reply", `Model step ${step.stepNumber + 1}: ${tokens}, ${(step.elapsedMs / 1000).toFixed(1)} s`, {
        step: step.stepNumber,
        model: prepared.model,
        elapsedMs: step.elapsedMs,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        finishReason: step.finishReason,
        tools: step.toolNames,
        remainingTokens: step.rateLimit.remainingTokens,
      });
    };
    let text: string;
    let finishReason: string | null;
    try {
      const result = await client.call(agent, prompt, {
        maxSteps: 1,
        deadlines: GENERAL_LIMITS,
        maxOutputTokens: ANSWER_TOKENS,
        internal: new InternalFailure(),
        ...(signal ? { signal } : {}),
        onStep: (step) => {
          steps.push(step);
          record(step);
        },
      });
      text = result.text;
      finishReason = result.finishReason;
    } catch (error) {
      const failed = error instanceof ModelFailure ? error : toModelFailure(error, "chat.reply");
      // The request that failed is recorded once, as its own step (D22).
      const request = failed.failedStep;
      if (request) {
        steps.push(request);
        deps.recorder.event(runId, "model.call", "reply", `Model call failed: ${failed.message}`, {
          step: request.stepNumber,
          model: prepared.model,
          elapsedMs: request.elapsedMs,
          inputTokens: null,
          outputTokens: null,
          kind: failed.kind,
          ...(failed.retryAfterSeconds !== null ? { retryAfterSeconds: failed.retryAfterSeconds } : {}),
        });
      }
      deps.setMeta(runId, { usage: usageOf(steps) });
      throw failed;
    }
    deps.setMeta(runId, { usage: usageOf(steps) });
    if (!text) throw failure("malformed", "the model's reply was empty");
    // A reply stopped by the length limit is kept, and labelled: it is never shown as complete.
    const cutOff = finishReason === "length";
    const result: GeneralReply = { kind: "general", text, cutOff, context: recorded, finishedAt: new Date().toISOString() };
    deps.saveResult(runId, result);
    deps.recorder.output(runId, "reply", `Replied in ${text.length} characters${cutOff ? ", cut off at the length limit" : ""}`, { chars: text.length, cutOff });
    return { kind: "general", citations: 0, checked: 0 };
  }

  /** The explain run's reading, with a reply that keeps evidence, proposals and assumptions apart (D26). */
  async function repository(
    runId: string,
    task: ChatTask,
    turn: ChatContext,
    key: string,
    prepared: z.infer<typeof Prepared> & { root: string },
    signal: AbortSignal | undefined,
    recorded: { preferences: PreferencesReceived; history: RepositoryReply["context"]["history"] },
  ): Promise<z.infer<typeof Replied>> {
    const { reader, session } = await openReader(prepared.root, signal);
    try {
      const ledger = new Ledger();
      const map = await buildMap(reader, prepared.head);
      // Masked like every tool result; the ledger keeps the true paths, which citations are checked against (D22).
      const mapText = deps.mask(map.text);
      ledger.record(-1, "map", map.sources.map((source) => ({ path: source.path, startLine: 1, endLine: source.lines, sha256: source.sha256 })), mapText.length);
      const prompt = repositoryPrompt(task.message, mapText, turn.preferences, historySection(turn.history, deps.mask, "repository"));
      const definitions = toolDefinitionChars(REPLY_TOOL_SPECS);
      const budget = new Budget(requestBudget(prepared.contextLength), REPOSITORY_INSTRUCTIONS.length + prompt.length + definitions);
      const beforeReading = budget.used();
      deps.recorder.output(runId, "reply", `Request budget: ${Math.max(0, budget.tokens)} tokens; about ${beforeReading} are needed before any reading`, {
        tokens: budget.tokens,
        beforeReading,
        toolDefinitionChars: definitions,
        contextLength: prepared.contextLength,
      });
      if (budget.exhausted()) {
        throw failure(
          "context-too-small",
          `about ${beforeReading} tokens are needed before any reading, and ${Math.max(0, budget.tokens)} are available once ${ANSWER_TOKENS} are held back for the reply, which leaves no room to read`,
        );
      }
      const internal = new InternalFailure();
      const reading = new Reading();
      const policy = policyFor(prepared.model);
      const { tools, state } = createReplyTools({
        reader,
        ledger,
        budget,
        mask: deps.mask,
        internal,
        step: () => reading.finished,
        answerDue: () => reading.answerDue,
        // A reply has no findings check of its own, so this is asked of nothing yet; it is the same rule as explain's.
        answerAgain: () => canAnswerAgain({ stepNumber: reading.finished, dueReasons: reading.dueReasons, forced: policy.forceAnswer }, EXPLAIN_LIMITS),
        preferences: turn.preferences,
        choices: new Set(),
        signal,
        onTool: (event) => deps.recorder.event(runId, "tool.called", "reply", event.message, event.data),
      });
      const { steps, failed } = await readUntilAnswered({
        client: clientFor(key),
        agent: { id: "nivra-chat-repository", name: "Nivra repository chat", instructions: REPOSITORY_INSTRUCTIONS },
        model: prepared.model,
        prompt,
        tools,
        answerTool: "submit_reply",
        accepted: () => state.accepted !== null,
        policy,
        budget,
        reading,
        state,
        internal,
        signal,
        limits: EXPLAIN_LIMITS,
        maxOutputTokens: ANSWER_TOKENS,
        event: (type, message, data) => deps.recorder.event(runId, type, "reply", message, data),
      });
      deps.setMeta(runId, { usage: usageOf(steps) });
      if (failed) throw failed;
      const refusals = { citations: state.citationRefusals, conflicts: state.conflictRefusals, findings: state.findingsRefusals, schema: reading.invalidAnswers };
      if (!state.accepted || state.answerStep === null) {
        throw failure("malformed", `no reply was accepted within ${steps.length} model ${steps.length === 1 ? "step" : "steps"}${turnedDownText(refusals)}`);
      }
      const accepted = state.accepted;
      const answerStep = state.answerStep;
      const check = (citations: (typeof accepted.evidence)[number]["citations"]) => citations.map((citation) => checkCitation(citation, ledger.entries, answerStep));
      const evidence = accepted.evidence.map((item) => ({ statement: item.statement, citations: check(item.citations) }));
      const proposals = accepted.proposals.map((item) => ({ title: item.title, detail: item.detail, citations: check(item.citations) }));
      // The engine ranks what the model reported (D23); a conversation has no task choices.
      const conflicts = accepted.conflicts.map((conflict) => rankConflict(conflict, check(conflict.citations), turn.preferences.records, new Set()));
      const all = [...evidence, ...proposals, ...conflicts].flatMap((item) => item.citations);
      const checked = all.filter((citation) => citation.checked).length;
      const result: RepositoryReply = {
        kind: "repository",
        answer: accepted.answer,
        evidence,
        proposals,
        assumptions: accepted.assumptions,
        conflicts,
        gaps: accepted.gaps,
        headAtStart: prepared.head,
        headAtEnd: await reader.head(),
        context: {
          ...ledger.context(),
          preferences: recorded.preferences,
          hidden: map.hidden,
          budget: { tokens: budget.tokens, estimatedTokens: budget.used(), resultsLimited: state.resultsLimited, resultsReplaced: state.resultsReplaced, ranOut: state.budgetExhausted },
          answer: {
            dueReasons: reading.dueReasons,
            refusals,
            acceptedAfterRefusals: state.rejected + reading.invalidAnswers,
            conflictsDropped: state.conflictsDropped,
            suggestionsDropped: 0,
            turnedDown: turnedDownCost(steps, [...state.refusedSteps, ...reading.invalidAnswerSteps]),
          },
          history: recorded.history,
        },
        checks: { citations: all.length, checked },
        answeredAtStep: answerStep,
        finishedAt: new Date().toISOString(),
      };
      deps.saveResult(runId, result);
      deps.recorder.output(runId, "reply", `${checked} of ${all.length} citations point to lines the model was shown`, {
        citations: all.length,
        checked,
        evidence: evidence.length,
        proposals: proposals.length,
        assumptions: accepted.assumptions.length,
        conflicts: conflicts.length,
        changedFiles: result.context.changedFiles,
        headChanged: result.headAtEnd !== result.headAtStart,
      });
      return { kind: "repository", citations: all.length, checked };
    } finally {
      await session.close();
    }
  }

  return createWorkflow({
    id: CHAT_WORKFLOW_ID,
    description: "Replies to one message in a conversation: general with no tools, or reading a repository read-only through fixed tools",
    inputSchema: Input,
    outputSchema: Replied,
    // Recovery belongs to the run scheduler: a run interrupted by a restart is marked failed, never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(context)
    .then(prepare)
    .then(reply)
    .commit();
}
