import { createTool } from "@mastra/core/tools";
import type { AnswerSchemaProbe, ProviderCheck, ToolChoiceProbe } from "@nivra/domain";
import { z } from "zod";
import { ANSWER_TOOL_DESCRIPTION, AnswerInput } from "../explain/answer.ts";
import type { FailureFacts } from "../diagnostics.ts";
import { belowPauseThreshold, createModelClient, ModelFailure, toModelFailure, type Endpoint, type ModelClientOptions, type ToolChoice } from "./model.ts";
import { isNvidiaModel, pickNemotron } from "./tokenfactory.ts";

/** The fact the probe tool hands back; the model's answer should repeat it. */
export const PROBE_FACT = "pnpm verify";

/** The whole check ends within this, below the host's 180 s limit for the request (D22). */
export const CHECK_DEADLINE_MS = 150_000;

export interface CheckOptions {
  apiKey: string;
  endpoint: Endpoint;
  /** A model to call instead of the preferred Nemotron. */
  model?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Tests only. */
  fetch?: ModelClientOptions["fetch"];
  agentModel?: ModelClientOptions["model"];
  /** Told what can safely be said about a failure inside Nivra that the result reports as its problem (NIV-27). */
  onDiagnostic?: (facts: FailureFacts) => void;
}

/**
 * Token Factory from wherever this engine runs (B7, D22). It lists the models (with their context length), makes one
 * call that has to use a tool to answer, then three small probes: whether `toolChoice: "required"` is honoured, whether
 * a forced named tool is chosen over the other of two, and whether a forced `submit_answer` fills in the explain
 * workflow's real answer schema. Together they say what the workflow can rely on. One tiny case each: evidence, not
 * proof of reliability. A failed listing throws a `ModelFailure`; everything after it is reported in the result.
 */
export async function runProviderCheck(options: CheckOptions): Promise<ProviderCheck> {
  const client = createModelClient({
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.agentModel ? { model: options.agentModel } : {}),
  });
  const deadline = performance.now() + (options.deadlineMs ?? CHECK_DEADLINE_MS);
  const remaining = () => deadline - performance.now();
  const within = (cap: number) => {
    const ms = Math.max(1_000, Math.min(cap, remaining() - 1_000));
    return { stepMs: ms, totalMs: ms };
  };
  const signalled = (error: unknown) => error instanceof ModelFailure && error.kind === "cancelled";

  const list = await client.listModels({ ...(options.signal ? { signal: options.signal } : {}), timeoutMs: Math.min(30_000, remaining()) });
  const nvidia = list.ids.filter(isNvidiaModel);
  const chosen = options.model ?? pickNemotron(list.ids);
  const models = { total: list.ids.length, nvidia, contextLength: chosen ? (list.contextLengths.get(chosen) ?? null) : null };
  const base = { endpoint: options.endpoint.kind, models };
  if (!chosen) return { ...base, call: null, probes: null, problem: "This key can't use any NVIDIA model.", problemKind: "model-unavailable", retryAfterSeconds: null };

  let toolCalled = false;
  const readProjectFact = createTool({
    id: "read_project_fact",
    description: "Returns one fact about the project, by name. Known names: build_command.",
    inputSchema: z.object({ name: z.string().max(64).describe("The fact's name, for example build_command") }),
    execute: async (input) => {
      toolCalled = true;
      return input.name === "build_command" ? { value: PROBE_FACT } : { value: null, note: "Unknown fact name." };
    },
  });
  const agent = client.agent({
    id: "tokenfactory-check",
    name: "Token Factory check",
    modelId: chosen,
    instructions: "You answer questions about a software project. Look facts up with your tools; never guess them.",
    tools: { read_project_fact: readProjectFact },
  });
  let call: ProviderCheck["call"];
  try {
    const result = await client.call(agent, "What is the project's build command? Look it up with your tool, then answer in one short sentence.", {
      maxSteps: 3,
      deadlines: within(60_000),
      maxOutputTokens: 400,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const last = result.steps.at(-1)?.rateLimit ?? null;
    call = {
      model: chosen,
      toolCalled,
      answer: result.text.slice(0, 500),
      servedModel: result.servedModel,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      elapsedMs: result.elapsedMs,
      rateLimit: {
        remainingTokens: last?.remainingTokens ?? null,
        resetTokensSeconds: last?.resetTokensSeconds ?? null,
        belowPauseThreshold: last ? belowPauseThreshold(last) : null,
      },
    };
  } catch (error) {
    if (signalled(error)) throw error;
    // Never the error's own words: they can quote the key (a header error does) or the provider (NIV-27).
    const failed = error instanceof ModelFailure ? error : toModelFailure(error, "providers.check.call");
    if (failed.kind === "internal" && failed.facts) options.onDiagnostic?.(failed.facts);
    return { ...base, call: null, probes: null, problem: `The call to ${chosen} failed. ${failed.message}`, problemKind: failed.kind, retryAfterSeconds: failed.retryAfterSeconds };
  }

  /** One response with a fresh agent; reports which of its tools ran, or "failed". Skipped without time for it. */
  const probe = async (tools: Record<string, ReturnType<typeof createTool>>, prompt: string, toolChoice: ToolChoice, ran: () => string[]) => {
    if (remaining() < 15_000) return { outcome: "skipped" as const, called: [] as string[] };
    const probeAgent = client.agent({ id: "tokenfactory-probe", name: "Token Factory probe", modelId: chosen, instructions: "You are terse.", tools });
    try {
      const result = await client.call(probeAgent, prompt, {
        maxSteps: 1,
        deadlines: within(45_000),
        maxOutputTokens: 1_000,
        toolChoice,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { outcome: "answered" as const, called: result.steps.flatMap((step) => step.toolNames), ran: ran() };
    } catch (error) {
      if (signalled(error)) throw error;
      const failed = toModelFailure(error, "providers.check.probe");
      if (failed.kind === "internal" && failed.facts) options.onDiagnostic?.(failed.facts);
      return { outcome: "failed" as const, called: [] as string[] };
    }
  };
  const noteTool = (id: string, description: string, ran: string[]) =>
    createTool({ id, description, inputSchema: z.object({}), execute: async () => (ran.push(id), { noted: true }) });

  // 1. `required`: a prompt that needs no tool, so the tool runs only if the choice is honoured.
  const requiredRan: string[] = [];
  const required = await probe({ note_ready: noteTool("note_ready", "Records that you are ready.", requiredRan) }, "Reply with the single word: ready.", "required", () => requiredRan);
  const requiredToolChoice: ToolChoiceProbe = required.outcome === "answered" ? (requiredRan.length ? "honoured" : "ignored") : required.outcome;

  // 2. A named tool forced, when the prompt points at the other one.
  const forcedRan: string[] = [];
  const forced = await probe(
    { note_ready: noteTool("note_ready", "Records that you are ready.", forcedRan), note_busy: noteTool("note_busy", "Records that you are busy.", forcedRan) },
    "You are ready. Record that you are ready.",
    { type: "tool", toolName: "note_busy" },
    () => forcedRan,
  );
  const forcedToolChoice: ToolChoiceProbe =
    forced.outcome === "answered" ? (forcedRan.length === 1 && forcedRan[0] === "note_busy" ? "honoured" : "ignored") : forced.outcome;

  // 3. `submit_answer` forced, with the real answer schema: the tool runs only if its input passed validation.
  let submitted = false;
  const submitAnswer = createTool({
    id: "submit_answer",
    description: ANSWER_TOOL_DESCRIPTION,
    inputSchema: AnswerInput,
    execute: async () => {
      submitted = true;
      return { accepted: true };
    },
  });
  const excerpt = [
    "This is the only file of a tiny repository, as a tool showed it to you:",
    "README.md",
    "    1| # Demo",
    "    2| Build with `pnpm build`.",
    "    3| Test with `pnpm test`.",
    "Submit your answer: a one-sentence summary, and one finding about how to build and test it that cites README.md lines 2 to 3.",
  ].join("\n");
  const answer = await probe({ submit_answer: submitAnswer }, excerpt, { type: "tool", toolName: "submit_answer" }, () => (submitted ? ["submit_answer"] : []));
  const answerSchema: AnswerSchemaProbe =
    answer.outcome === "answered" ? (submitted ? "valid" : answer.called.includes("submit_answer") ? "invalid" : "ignored") : answer.outcome;

  return {
    ...base,
    call,
    probes: { requiredToolChoice, forcedToolChoice, answerSchema },
    problem: toolCalled ? null : "The model answered without calling the tool, so tool calling on it is unproven.",
    problemKind: null,
    retryAfterSeconds: null,
  };
}
