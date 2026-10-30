import { createHash } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import { resolveModelConfig } from "@mastra/core/llm";
import { noopLogger } from "@mastra/core/logger";
import { isMastraTimeoutError } from "@mastra/core/loop";
import { VISUAL_MODEL, type ModelEndpoint, type ModelFailureKind } from "@nivra/domain";
import type { BudgetJournal, OpenRefusal, OperationPart } from "../budget/journal.ts";
import { errorFacts, internalMessage, safeClass, type DiagnosticCode, type FailureFacts } from "../diagnostics.ts";
import { capCompletionTokens, listModels as fetchModels, TOKEN_FACTORY_BASE_URL, TokenFactoryError, type ModelEntry } from "./tokenfactory.ts";

/**
 * Every model call goes through here (D22): the only place that builds a Mastra `Agent`. Agents are standalone, never
 * registered with Mastra, so their loop writes nothing to `mastra.db`, and their logger is silenced, because Mastra's
 * default error log prints the request, prompt included. Nothing is ever re-sent: no retries, no error processors, no
 * fallback models. Deadlines are Mastra's own (`modelSettings.timeout`), which fail as timeouts; the abort signal is
 * kept for cancellation, which Mastra ends quietly.
 */

/** Where model requests go: Token Factory, or a stub on this machine that only tests point at. */
export interface Endpoint {
  url: string;
  kind: ModelEndpoint;
}

export const TOKEN_FACTORY: Endpoint = { url: TOKEN_FACTORY_BASE_URL, kind: "token-factory" };

/** A model call failed. `kind` lets the app say what to do without reading the message. */
export class ModelFailure extends Error {
  readonly kind: ModelFailureKind;
  readonly status: number | null;
  /** How long the call ran before it failed, when it got that far. */
  elapsedMs: number | null = null;
  /** Every request the call made, the failed one last when there was one. */
  steps: StepRecord[] = [];
  /**
   * The request that failed, reported once: Mastra's own error step, or one made here when Mastra reported none (a
   * deadline, a cancel). Null when nothing failed at the provider, as when a tool inside Nivra did.
   */
  failedStep: StepRecord | null = null;
  /** On a 429: how long Token Factory asked us to wait (`Retry-After`), when it said. */
  readonly retryAfterSeconds: number | null;
  /**
   * What the engine's diagnostic says about this failure (NIV-27): a code, where it happened, and the facts of the error
   * that caused it, never its words. Enumerable, so it survives Mastra's serialising of a step's error.
   */
  facts: FailureFacts | null = null;

  constructor(kind: ModelFailureKind, message: string, status: number | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ModelFailure";
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Records why, for the diagnostic: `stage` is an application-owned token, and `cause` is only ever described by its facts. */
  because(code: DiagnosticCode, stage: string, cause?: unknown): this {
    this.facts = { code, stage, error: cause === undefined ? null : errorFacts(cause) };
    return this;
  }
}

/**
 * The rate-limit values that matter, from Token Factory's documented headers. Below `MASTRA_PAUSE_THRESHOLD` remaining
 * tokens, Mastra waits 10 s after the step before going on, so a run records when that applied.
 */
export interface RateLimit {
  remainingTokens: number | null;
  remainingRequests: number | null;
  /** Seconds until the token limit resets. */
  resetTokensSeconds: number | null;
  /** Token Factory processed the request over the limit: later calls may be throttled. */
  overLimit: boolean;
}

export const MASTRA_PAUSE_THRESHOLD = 2_000;

/** True when Mastra pauses 10 s after a step with these values; null when the provider didn't say. */
export const belowPauseThreshold = (rate: RateLimit): boolean | null =>
  rate.remainingTokens === null ? null : rate.remainingTokens > 0 && rate.remainingTokens < MASTRA_PAUSE_THRESHOLD;

/** What one step of a call did: one model response, and the tools it called. */
export interface StepRecord {
  stepNumber: number;
  /** From the end of the previous step: the model's answer plus the tools it ran. */
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  servedModel: string | null;
  /** The tools the model called in this step, by name. */
  toolNames: string[];
  /**
   * Calls Mastra turned down because their input didn't match the tool's schema: the tool never ran, and the model was
   * told what to fix. Each problem is a field path and a rule, never the input itself.
   */
  rejectedTools: Array<{ tool: string; problems: string[] }>;
  rateLimit: RateLimit;
}

export interface CallResult {
  text: string;
  finishReason: string | null;
  steps: StepRecord[];
  /** Summed over the steps; null when any step didn't report it. */
  usage: { inputTokens: number | null; outputTokens: number | null };
  servedModel: string | null;
  elapsedMs: number;
}

export interface ModelList {
  ids: string[];
  /** The model's context length, when `/models` gives one. */
  contextLengths: ReadonlyMap<string, number>;
  /** The Date Token Factory's answer carried: the provider's clock (NIV-66), or null without a readable one. */
  providerDate: string | null;
}

/**
 * How a run's own code reports that something inside it failed, as opposed to the person cancelling it. The failure
 * is recorded before the call is aborted, so it is never reported as a cancellation.
 */
export class InternalFailure {
  readonly #controller = new AbortController();
  #failure: ModelFailure | null = null;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get failure(): ModelFailure | null {
    return this.#failure;
  }

  /** `at` says where, for the diagnostic (NIV-27); an unknown error is named by an allowlisted class only. */
  fail(error: unknown, at: { code?: DiagnosticCode; stage: string } = { stage: "model.call" }): void {
    if (this.#failure) return;
    this.#failure = error instanceof ModelFailure ? error : failure("internal", safeClass(error) ?? "").because(at.code ?? "unexpected-error", at.stage, error);
    this.#controller.abort(this.#failure);
  }
}

export interface CallOptions {
  maxSteps: number;
  /** Per model call, and for the whole call including its tools. */
  deadlines: { stepMs: number; totalMs: number };
  maxOutputTokens: number;
  toolChoice?: ToolChoice;
  stopWhen?: () => boolean;
  /**
   * Before each request. A failure it records through `internal` ends the call there, and the request is never sent.
   * A request may have an output cap and a deadline of its own, in place of the call's (NIV-35), and, under a budget
   * grant, the part of the grant it draws on (the hand-in draws on the finalisation part).
   */
  prepareStep?: (step: { stepNumber: number }) => { activeTools?: string[]; toolChoice?: ToolChoice; maxOutputTokens?: number; stepMs?: number; budgetPart?: OperationPart } | undefined;
  /** Under a budget grant: the part of it this call's requests draw on, unless a step says otherwise. Productive by default. */
  budgetPart?: OperationPart;
  /** The person's cancel. */
  signal?: AbortSignal;
  internal?: InternalFailure;
  onStep?: (step: StepRecord) => void;
}

export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };

export interface AgentSpec {
  id: string;
  name: string;
  modelId: string;
  instructions: string;
  tools: Record<string, unknown>;
}

/** The one thing the client does with an agent; Mastra's own generic types don't survive the tools being dynamic. */
export type ModelPart = { type: "text"; text: string } | { type: "image"; image: string; mimeType: "image/png" };
export type ModelPrompt = string | ModelPart[];
export interface ModelAgent {
  generate(prompt: string | Array<{ role: "user"; content: ModelPart[] }>, options: never): Promise<unknown>;
}

export interface ModelClient {
  readonly endpoint: Endpoint;
  listModels(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ModelList>;
  agent(spec: AgentSpec): ModelAgent;
  call(agent: ModelAgent, prompt: ModelPrompt, options: CallOptions): Promise<CallResult>;
}

/**
 * A client bound to a budget grant (NIV-66): every request it sends is journalled at its send point, under the grant
 * the host gave its run. A request whose bound doesn't fit what is left of the grant is never sent.
 */
export interface BudgetBinding {
  journal: Pick<BudgetJournal, "open" | "sent" | "close" | "providerTime">;
  grantId: string;
  /** Allowed candidate IDs for selection. The journal enforces them again at send. */
  models?: readonly string[];
  /** The council seat or role the requests are made for, when they have one. */
  seat: string | null;
}

export interface ModelClientOptions {
  apiKey: string;
  endpoint?: Endpoint;
  /** Under a budget grant: where its requests are journalled. */
  budget?: BudgetBinding;
  /** Tests only: the HTTP client for `/models`. */
  fetch?: typeof fetch;
  /** Tests only, in-process: the model itself (a mock), instead of the endpoint. */
  model?: (modelId: string) => unknown;
}

export function createModelClient(options: ModelClientOptions): ModelClient {
  const endpoint = options.endpoint ?? TOKEN_FACTORY;
  // Each agent's provider requests, as they start and end, for the call in progress (see `countAttempts`).
  const slots = new WeakMap<object, AttemptSlot>();
  const modelIds = new WeakMap<object, string>();
  return {
    endpoint,

    async listModels({ signal, timeoutMs = 30_000 } = {}) {
      timeoutMs = Math.max(1, Math.floor(timeoutMs));
      const timeout = AbortSignal.timeout(timeoutMs);
      const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let entries: ModelEntry[];
      let providerDate: string | null;
      let listing: string | null = null;
      if (options.budget) {
        const opened = options.budget.journal.open(options.budget.grantId, { kind: "model-listing", part: "productive", model: null, seat: options.budget.seat, instructionsSha256: null, outputTokens: null, boundUnits: null });
        if ("refused" in opened) throw failure("budget-exhausted", REFUSED[opened.refused]);
        listing = opened.id;
      }
      let handed = false;
      try {
        ({ entries, date: providerDate } = await fetchModels(options.apiKey, {
          baseUrl: endpoint.url,
          signal: both,
          fetch: (async (url, request) => {
            if (request?.signal?.aborted) throw new ModelFailure("cancelled", "Cancelled.");
            if (listing) options.budget!.journal.sent(listing);
            handed = true;
            return (options.fetch ?? fetch)(url, request);
          }) as typeof fetch,
        }));
        if (providerDate && options.budget) options.budget.journal.providerTime(options.budget.grantId, providerDate);
      } catch (error) {
        if (signal?.aborted) throw new ModelFailure("cancelled", "Cancelled.");
        if (timeout.aborted) throw new ModelFailure("timeout", `Token Factory didn't list its models within ${Math.round(timeoutMs / 1000)} s. Check the network on this target, then try again.`);
        if (error instanceof TokenFactoryError) throw failure(kindForStatus(error.status), "", error.status);
        throw toModelFailure(error, "models.list");
      } finally {
        if (listing) options.budget!.journal.close(listing, handed ? { kind: "no-usage" } : { kind: "unsent" });
      }
      const contextLengths = new Map<string, number>();
      for (const entry of entries) if (entry.contextLength !== null) contextLengths.set(entry.id, entry.contextLength);
      return { ids: entries.map((entry) => entry.id), contextLengths, providerDate };
    },

    agent(spec) {
      const configured = options.model?.(spec.modelId) ?? { providerId: "nebius", modelId: spec.modelId, url: endpoint.url, apiKey: options.apiKey };
      const slot: AttemptSlot = { listener: null, part: "productive", internal: null };
      const agent = new Agent({
        id: spec.id,
        name: spec.name,
        instructions: spec.instructions,
        // Resolved as the Agent would resolve it, then watched, so every provider request is known when it starts.
        // The router's model sends each request's cap as max_completion_tokens (D50); a model a test hands in is left as
        // it is. countAttempts stays outermost, so it sees each call with its maxOutputTokens before the cap is moved, and
        // the budget journal works out each request's bound from it.
        model: (async () => {
          const resolved = (await resolveModelConfig(configured as never)) as object;
          return countAttempts(options.model ? resolved : capCompletionTokens(resolved), slot, options.budget ?? null);
        }) as never,
        tools: spec.tools as never,
        maxRetries: 0,
        errorProcessorDefaults: false,
        maxProcessorRetries: 0,
      });
      // Internal API (D11): reaches the loop's logger too, which __setLogger alone does not. Covered by stderr canaries.
      agent.__registerPrimitives({ logger: noopLogger });
      slots.set(agent, slot);
      modelIds.set(agent, spec.modelId);
      return agent as unknown as ModelAgent;
    },

    async call(agent, prompt, call) {
      if (Array.isArray(prompt) && prompt.some((part) => part.type === "image") && modelIds.get(agent)?.toLowerCase() !== VISUAL_MODEL.toLowerCase()) throw failure("model-unavailable", "Selected images require the visual task model; no request was sent.");
      const internal = call.internal ?? new InternalFailure();
      const abortSignal = call.signal ? AbortSignal.any([call.signal, internal.signal]) : internal.signal;
      const steps: StepRecord[] = [];
      const started = performance.now();
      let mark = started;
      // Mastra reports a request that failed as a step of its own; it is held back and reported with the failure.
      let errorStep: StepRecord | null = null;
      // Every provider request this call started, in order: one per step.
      const attempts: Attempt[] = [];
      const slot = slots.get(agent as object);
      if (slot) {
        slot.part = call.budgetPart ?? "productive";
        slot.internal = internal;
        slot.listener = (event) => {
          if (event.type === "start") {
            attempts.push({ startedAt: performance.now(), endedAt: null, result: undefined });
            return;
          }
          const last = attempts.at(-1);
          if (last) Object.assign(last, { endedAt: performance.now(), result: event.result });
        };
      }
      const failed = (failure: ModelFailure): ModelFailure => {
        const now = performance.now();
        failure.elapsedMs = Math.round(now - started);
        // The request Mastra hadn't reported when the call stopped, if one had started: none when a cancel came before
        // the first request or between two.
        const unreported = attempts.length > steps.length ? attempts[steps.length]! : null;
        if (errorStep) {
          failure.failedStep = errorStep;
        } else if (unreported?.result !== undefined) {
          // It was answered, and its tools were cut off: a request that happened, reported with what it said.
          const record = stepRecord(steps.length, unreported.result, Math.round((unreported.endedAt ?? now) - unreported.startedAt));
          steps.push(record);
          try {
            call.onStep?.(record);
          } catch {
            // The failure being reported matters more than the step's record.
          }
        } else if (unreported && failure.kind !== "internal") {
          failure.failedStep = emptyStep(steps.length, Math.round(now - unreported.startedAt));
        }
        if (failure.failedStep) steps.push(failure.failedStep);
        failure.steps = steps;
        return failure;
      };
      let output: { text?: string; finishReason?: string; response?: { modelId?: string } };
      try {
        output = (await agent.generate(typeof prompt === "string" ? prompt : [{ role: "user", content: prompt }], {
          maxSteps: call.maxSteps,
          ...(call.stopWhen ? { stopWhen: () => call.stopWhen!() } : {}),
          ...(call.toolChoice ? { toolChoice: call.toolChoice } : {}),
          ...(call.prepareStep
            ? {
                prepareStep: ({ stepNumber, abort }: { stepNumber: number; abort: (reason: string) => never }) => {
                  const asked = call.prepareStep!({ stepNumber });
                  // The grant's part is the journal's to know, never Mastra's.
                  if (asked?.budgetPart && slot) slot.part = asked.budgetPart;
                  const prepared = asked === undefined ? undefined : withoutPart(asked);
                  // Mastra's tripwire ends the loop before the request, quietly: a throw here would be logged with its stack.
                  if (internal.failure) abort("stopped before its request");
                  if (!prepared || (prepared.maxOutputTokens === undefined && prepared.stepMs === undefined)) return prepared;
                  // Mastra takes a step's settings whole, so the call's are given again beside its own, retries off.
                  const { maxOutputTokens = call.maxOutputTokens, stepMs = call.deadlines.stepMs, ...rest } = prepared;
                  return { ...rest, modelSettings: { maxOutputTokens, maxRetries: 0, timeout: { stepMs: Math.max(1, Math.floor(stepMs)), totalMs: Math.max(1, Math.floor(call.deadlines.totalMs)) } } };
                },
              }
            : {}),
          toolCallConcurrency: 1,
          modelSettings: { maxOutputTokens: call.maxOutputTokens, timeout: { stepMs: Math.max(1, Math.floor(call.deadlines.stepMs)), totalMs: Math.max(1, Math.floor(call.deadlines.totalMs)) } },
          abortSignal,
          onStepFinish: (step: unknown) => {
            try {
              const now = performance.now();
              const record = stepRecord(steps.length, step, Math.round(now - mark));
              mark = now;
              if (record.finishReason === "error" || record.finishReason === "aborted") {
                errorStep = record;
                return;
              }
              steps.push(record);
              call.onStep?.(record);
            } catch (error) {
              internal.fail(error, { code: "callback-threw", stage: "model.step" });
            }
          },
        } as never)) as typeof output;
      } catch (error) {
        if (internal.failure) throw failed(internal.failure);
        if (call.signal?.aborted) throw failed(new ModelFailure("cancelled", "Cancelled."));
        throw failed(toModelFailure(error));
      } finally {
        if (slot) {
          slot.listener = null;
          slot.internal = null;
        }
      }
      if (internal.failure) throw failed(internal.failure);
      if (output.finishReason === "aborted" || call.signal?.aborted) throw failed(new ModelFailure("cancelled", "Cancelled."));
      // Mastra reported a failed request but finished anyway: it was a request all the same, so it is counted.
      if (errorStep) {
        steps.push(errorStep);
        call.onStep?.(errorStep);
      }
      return {
        text: (output.text ?? "").trim(),
        finishReason: output.finishReason ?? null,
        steps,
        usage: { inputTokens: total(steps, "inputTokens"), outputTokens: total(steps, "outputTokens") },
        servedModel: output.response?.modelId || ([...steps].reverse().find((step) => step.servedModel)?.servedModel ?? null),
        elapsedMs: Math.round(performance.now() - started),
      };
    },
  };
}

function stepRecord(stepNumber: number, raw: unknown, elapsedMs: number): StepRecord {
  const step = (raw ?? {}) as {
    usage?: { inputTokens?: unknown; outputTokens?: unknown };
    finishReason?: unknown;
    response?: { modelId?: unknown; headers?: unknown };
    toolCalls?: unknown;
    toolResults?: unknown;
    content?: unknown;
  };
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
  // Mastra's steps carry tool calls either flat or as chunks, depending on the callback.
  // A provider's own result (a request reported here rather than by Mastra) lists its tool calls in `content`.
  type Call = { type?: unknown; toolName?: unknown; payload?: { toolName?: unknown } };
  const parts = Array.isArray(step.content) ? (step.content as Call[]).filter((part) => part?.type === "tool-call") : [];
  const calls = Array.isArray(step.toolCalls) ? (step.toolCalls as Call[]) : parts;
  const toolNames = calls.map((call) => call.payload?.toolName ?? call.toolName).filter((name): name is string => typeof name === "string");
  const results = Array.isArray(step.toolResults) ? (step.toolResults as Array<{ toolName?: unknown; result?: unknown; payload?: { toolName?: unknown; result?: unknown } }>) : [];
  const rejectedTools = results.flatMap((entry) => {
    const tool = entry.payload?.toolName ?? entry.toolName;
    const problems = schemaProblems(entry.payload?.result ?? entry.result);
    return typeof tool === "string" && problems ? [{ tool, problems }] : [];
  });
  return {
    stepNumber,
    elapsedMs,
    inputTokens: count(step.usage?.inputTokens),
    outputTokens: count(step.usage?.outputTokens),
    finishReason: typeof step.finishReason === "string" ? step.finishReason : null,
    servedModel: typeof step.response?.modelId === "string" && step.response.modelId ? step.response.modelId : null,
    toolNames,
    rejectedTools,
    rateLimit: rateLimitOf(step.response?.headers),
  };
}

/**
 * The problems in Mastra's answer to a call whose input failed the tool's schema (`{ error: true, validationErrors,
 * message }`): the "- path: rule" lines of its message, which end before the arguments it quotes back. Null for any
 * other result.
 */
function schemaProblems(result: unknown): string[] | null {
  if (!result || typeof result !== "object") return null;
  const value = result as { error?: unknown; validationErrors?: unknown; message?: unknown };
  if (value.error !== true || !("validationErrors" in value) || typeof value.message !== "string") return null;
  const listed = value.message.split("\n\nProvided arguments:")[0]!.split("\n").filter((line) => line.startsWith("- "));
  return listed.slice(0, 10).map((line) => line.slice(2, 202));
}

type AttemptSlot = {
  listener: ((event: { type: "start" } | { type: "end"; result: unknown }) => void) | null;
  /** The part of the grant the next request draws on. */
  part: OperationPart;
  /** The call in progress, so a request its grant refuses fails the call in Nivra's words. */
  internal: InternalFailure | null;
};
type Attempt = { startedAt: number; endedAt: number | null; result: unknown };

/**
 * The model, with each provider request reported to the call in progress as it starts and ends, so a failure can be
 * matched to the request it cut off, and a cancel before or between requests records none (D22). Methods run on the
 * model itself, so its private state is untouched.
 *
 * Under a budget grant (NIV-66) this is the real send point: each request's row is written to the journal, as
 * reserved, before it goes out, with the output cap it actually carries; one the grant refuses is never sent, and the
 * call fails in Nivra's words. The row is marked sent as the transport takes it, and closed on every path: from the
 * usage that came back, or unknown, at its bound, when none did. Nothing is ever sent again (D22).
 */
function countAttempts<T extends object>(model: T, slot: AttemptSlot, budget: BudgetBinding | null): T {
  return new Proxy(model, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      // Every method runs on the model itself: Mastra's models keep private fields a proxy can't reach.
      if (property !== "doGenerate" && property !== "doStream") return (value as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const row = budget ? openRow(budget, slot, target, args[0]) : null;
        slot.listener?.({ type: "start" });
        let result: unknown;
        try {
          if (row) budget!.journal.sent(row);
          result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          return result;
        } finally {
          slot.listener?.({ type: "end", result });
          if (row) closeRow(budget!, slot, row, property === "doGenerate" ? result : undefined);
        }
      };
    },
  });
}

/** Why a grant refused a request, in Nivra's words: the detail of a budget-exhausted failure, never a provider's. */
const REFUSED: Record<OpenRefusal, string> = {
  unaccepted: "its budget grant wasn't accepted",
  sealed: "its budget grant had already ended",
  requests: "its budget grant allows no more requests",
  money: "its budget grant has no room for another request",
  unbounded: "its budget grant can't bound this model's requests",
  counted: "its budget grant allows no more of that service",
  model: "its budget grant does not allow that model",
  output: "its output cap is outside its budget grant",
};

/** Writes a request's row before it is sent; a refusal fails the call, and nothing is sent. */
function openRow(budget: BudgetBinding, slot: AttemptSlot, target: object, options: unknown): string {
  const call = (options ?? {}) as { maxOutputTokens?: unknown; prompt?: unknown };
  const modelId = (target as { modelId?: unknown }).modelId;
  let opened: ReturnType<BudgetJournal["open"]>;
  try {
    opened = budget.journal.open(budget.grantId, {
      kind: "model-request",
      part: slot.part,
      model: typeof modelId === "string" ? modelId : null,
      seat: budget.seat,
      instructionsSha256: instructionsDigest(call.prompt),
      outputTokens: typeof call.maxOutputTokens === "number" ? call.maxOutputTokens : null,
      boundUnits: null,
    });
  } catch (error) {
    // The journal couldn't be written: nothing may be sent without its row.
    slot.internal?.fail(error, { code: "unexpected-error", stage: "budget.open" });
    throw slot.internal?.failure ?? error;
  }
  if ("refused" in opened) {
    const refused = failure("budget-exhausted", REFUSED[opened.refused]);
    slot.internal?.fail(refused);
    throw refused;
  }
  return opened.id;
}

/**
 * Closes a request's row from what came back: its usage, or unknown at its bound. The output count is the provider's
 * completion count, which carries the reasoning it generated, so reasoning is billed inside output once, never added
 * again and never dropped. A reported reasoning count larger than the output count contradicts that, so the usage
 * can't be trusted and the row keeps its whole bound, as when no usage came back. A row that can't be closed fails
 * the call.
 */
function closeRow(budget: BudgetBinding, slot: AttemptSlot, rowId: string, result: unknown): void {
  const raw = (result as { usage?: unknown } | undefined)?.usage;
  // Provider V2 reports scalar counts; V3/V4 report { inputTokens: { total, cacheRead },
  // outputTokens: { total, reasoning } }. The total already contains reasoning.
  const usage = (raw ?? {}) as { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown; reasoningTokens?: unknown };
  const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
  const inputDetails = typeof usage.inputTokens === "object" && usage.inputTokens !== null ? usage.inputTokens as { total?: unknown; cacheRead?: unknown } : null;
  const outputDetails = typeof usage.outputTokens === "object" && usage.outputTokens !== null ? usage.outputTokens as { total?: unknown; reasoning?: unknown } : null;
  const input = count(inputDetails ? inputDetails.total : usage.inputTokens);
  const output = count(outputDetails ? outputDetails.total : usage.outputTokens);
  const cached = count(inputDetails ? inputDetails.cacheRead : usage.cachedInputTokens);
  const reasoning = count(outputDetails ? outputDetails.reasoning : usage.reasoningTokens);
  const consistent = reasoning === null || (output !== null && reasoning <= output);
  try {
    budget.journal.close(
      rowId,
      raw && consistent ? { kind: "answered", usage: { inputTokens: input, cachedInputTokens: cached, outputTokens: output } } : { kind: "no-usage" },
    );
  } catch (error) {
    // An answer whose row can't be closed isn't used: the row stays open, and the journal is sealed interrupted.
    slot.internal?.fail(error, { code: "unexpected-error", stage: "budget.close" });
    throw slot.internal?.failure ?? error;
  }
}

/** The digest of the system instructions a request actually carried, or null when it carried none. */
function instructionsDigest(prompt: unknown): string | null {
  if (!Array.isArray(prompt)) return null;
  const system = (prompt as Array<{ role?: unknown; content?: unknown }>).filter((message) => message?.role === "system" && typeof message.content === "string");
  if (system.length === 0) return null;
  return createHash("sha256").update(system.map((message) => message.content as string).join("\n")).digest("hex");
}

/** A step's settings without the grant's part, which is the journal's to know. */
function withoutPart<T extends { budgetPart?: OperationPart }>(prepared: T): Omit<T, "budgetPart"> {
  const { budgetPart: _part, ...rest } = prepared;
  return rest;
}

/** A request Mastra didn't report as a step, because it was cut off: its time, and nothing it didn't say. */
function emptyStep(stepNumber: number, elapsedMs: number): StepRecord {
  return { stepNumber, elapsedMs, inputTokens: null, outputTokens: null, finishReason: null, servedModel: null, toolNames: [], rejectedTools: [], rateLimit: rateLimitOf(undefined) };
}

/** Reads one header, whatever its case, as a number; null when it is absent or not a number. */
function numberHeader(headers: unknown, name: string): number | null {
  if (!headers || typeof headers !== "object") return null;
  const entry = Object.entries(headers as Record<string, unknown>).find(([key]) => key.toLowerCase() === name);
  const value = typeof entry?.[1] === "string" ? Number.parseFloat(entry[1]) : typeof entry?.[1] === "number" ? entry[1] : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

export function rateLimitOf(headers: unknown): RateLimit {
  const overLimit = headers && typeof headers === "object" ? Object.entries(headers as Record<string, unknown>).some(([key, value]) => key.toLowerCase() === "x-ratelimit-over-limit" && value === "yes") : false;
  return {
    remainingTokens: numberHeader(headers, "x-ratelimit-remaining-tokens"),
    remainingRequests: numberHeader(headers, "x-ratelimit-remaining-requests"),
    resetTokensSeconds: numberHeader(headers, "x-ratelimit-reset-tokens"),
    overLimit,
  };
}

/** A sum that stays null as soon as one step didn't report its share: unknown is never shown as a number. */
function total(steps: readonly StepRecord[], field: "inputTokens" | "outputTokens"): number | null {
  if (steps.length === 0) return null;
  let sum = 0;
  for (const step of steps) {
    const value = step[field];
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
/** Fetch gave up waiting for a reply's headers or body (NIV-35): the reply was late, not the network down. */
const WAIT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const UNREADABLE = new Set(["AI_JSONParseError", "AI_TypeValidationError", "AI_InvalidResponseDataError", "AI_EmptyResponseBodyError", "AI_NoContentGeneratedError"]);

function kindForStatus(status: number): ModelFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model-unavailable";
  if (status === 408) return "timeout";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "provider";
  if (status >= 400) return "bad-request";
  // Below 400, the request was answered but the body couldn't be read: the AI SDK raises a 200 it can't parse this way.
  return "bad-response";
}

const MESSAGES: Record<ModelFailureKind, (detail: string, status: number | null) => string> = {
  "sharing-refused": () => "This project doesn't allow sending its content to Token Factory, so nothing was sent. Allow sharing for it, then try again.",
  "no-key": () => "No Nebius key is set, so nothing was sent. Add your key in Settings, then try again.",
  "context-too-small": (d) =>
    `The model's context is too small for Nivra's instructions, the preferences this project's runs get and this repository's starting map${d ? ` (${d})` : ""}, so nothing was sent to it. Shorten the question or the choices, or delete preferences you don't need; if that isn't enough, this key needs a model with a larger context: Check Token Factory in Settings shows what it can use.`,
  "budget-exhausted": (d) =>
    `This run used its input budget${d ? ` (${d})` : ""}, so it stopped before sending more to the model. Ask a narrower question, or start again.`,
  auth: (_d, s) => `Token Factory refused the API key (HTTP ${s ?? "401"}). Check the key in Settings, or create a new one in the Token Factory console.`,
  "rate-limit": (d) => `Token Factory is rate-limiting this key (HTTP 429). ${d ? `Try again in ${d}.` : "Wait a minute, then try again."}`,
  "model-unavailable": (d) => `The model isn't available to this key${d ? ` (${d})` : ""}. Check Token Factory in Settings to see which models the key can use.`,
  provider: (d, s) => `Token Factory had a problem answering${s ? ` (HTTP ${s}${d ? `: ${d}` : ""})` : d ? ` (${d})` : ""}. Try again in a few minutes.`,
  "bad-request": (d, s) => `Token Factory turned the request down (HTTP ${s ?? "400"}${d ? `: ${d}` : ""}). This looks like a Nivra problem; report it with the engine log.`,
  "bad-response": (d) => `Token Factory's answer couldn't be read${d ? ` (${d})` : ""}. Try again; if it keeps happening, try another model.`,
  network: (d) => `Token Factory couldn't be reached from this engine${d ? ` (${d})` : ""}. Check the network on this target, then try again.`,
  timeout: (d) => `The model didn't answer in time${d ? ` (${d})` : ""}. Try again, or ask a narrower question.`,
  cancelled: () => "Cancelled.",
  malformed: (d) => `The model didn't give a usable answer${d ? ` (${d})` : ""}. Try again, or ask a narrower question.`,
  // Named by an allowlisted class at most: an error's own text, and an unknown class's name, can quote the provider,
  // the model's output or the repository, and a failure's message is persisted, in Mastra's records too (NIV-27).
  internal: (d) => internalMessage(d),
};

export function failure(kind: ModelFailureKind, detail = "", status: number | null = null, retryAfterSeconds: number | null = null): ModelFailure {
  return new ModelFailure(kind, MESSAGES[kind](detail, status), status, retryAfterSeconds);
}

/**
 * Names what went wrong from the error's class and status, never its words, walking the `cause` chain: Mastra wraps
 * provider errors. `@ai-sdk/provider` isn't a dependency, so errors are recognised by name. The message is Nivra's own:
 * the provider's text can echo the key, the question or the repository, and a failure's message is persisted.
 */
export function toModelFailure(error: unknown, stage = "model.call"): ModelFailure {
  if (error instanceof ModelFailure) return error;
  const seen = new Set<unknown>();
  let fetchFailed = false;
  for (let current: unknown = error; current && typeof current === "object" && !seen.has(current); ) {
    seen.add(current);
    if (isMastraTimeoutError(current)) return failure("timeout", `${current.timeoutType === "total" ? "the whole run" : "one model call"} took longer than ${Math.round(current.timeoutMs / 1000)} s`);
    const e = current as { name?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; cause?: unknown; responseHeaders?: unknown };
    const name = typeof e.name === "string" ? e.name : "";
    const message = typeof e.message === "string" ? e.message.slice(0, 200) : "";
    if (name === "AI_APICallError" && typeof e.statusCode === "number") {
      if (e.statusCode === 429) {
        // Token Factory documents Retry-After in seconds; without it, the token limit's reset time says the same.
        const wait = numberHeader(e.responseHeaders, "retry-after") ?? numberHeader(e.responseHeaders, "x-ratelimit-reset-tokens");
        const seconds = wait === null ? null : Math.max(1, Math.ceil(wait));
        return failure("rate-limit", seconds === null ? "" : `${seconds} s`, 429, seconds);
      }
      return failure(kindForStatus(e.statusCode), "", e.statusCode);
    }
    if (UNREADABLE.has(name)) return failure("bad-response", name.replace(/^AI_/, ""));
    if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return failure("network", e.code);
    if (typeof e.code === "string" && WAIT_CODES.has(e.code)) return failure("timeout", "its reply took longer than the engine's fetch waits for one");
    if (name === "TypeError" && /fetch failed/i.test(message)) fetchFailed = true;
    current = e.cause;
  }
  if (fetchFailed) return failure("network", "fetch failed");
  return failure("internal", safeClass(error) ?? "").because("unexpected-error", stage, error);
}
