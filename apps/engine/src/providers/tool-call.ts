import { TOKEN_FACTORY_BASE_URL } from "./tokenfactory.ts";

/** The fact the probe tool hands back; the model's answer should repeat it. */
export const PROBE_FACT = "pnpm verify";

export interface ToolCallResult {
  model: string;
  toolCalled: boolean;
  answer: string;
  servedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
}

/**
 * One Nemotron call through Token Factory that has to use a tool to answer (B7): proves the key, the model and tool
 * calling from wherever the engine runs. Mastra is imported here, when the call is made, so loading this module
 * costs nothing. The key is passed explicitly (D8) and the agent never re-sends a request.
 */
export async function nemotronToolCall(apiKey: string, modelId: string, signal: AbortSignal): Promise<ToolCallResult> {
  const [{ Agent }, { createTool }, { z }] = await Promise.all([import("@mastra/core/agent"), import("@mastra/core/tools"), import("zod")]);
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
  const agent = new Agent({
    id: "tokenfactory-check",
    name: "Token Factory check",
    instructions: "You answer questions about a software project. Look facts up with your tools; never guess them.",
    model: { providerId: "nebius", modelId, url: TOKEN_FACTORY_BASE_URL, apiKey },
    tools: { read_project_fact: readProjectFact },
    maxRetries: 0,
    errorProcessorDefaults: false,
    maxProcessorRetries: 0,
  });
  const started = performance.now();
  const stream = await agent.stream("What is the project's build command? Look it up with your tool, then answer in one short sentence.", { maxSteps: 3, abortSignal: signal });
  let answer = "";
  for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: Record<string, unknown> }>) {
    if (chunk.type === "text-delta" && typeof chunk.payload?.["text"] === "string") answer += chunk.payload["text"];
    if (chunk.type === "error") {
      const error = chunk.payload?.["error"] ?? chunk.payload;
      throw new Error(error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error));
    }
  }
  const output = (await stream.getFullOutput()) as { response?: { modelId?: string }; totalUsage?: { inputTokens?: number; outputTokens?: number } };
  return {
    model: modelId,
    toolCalled,
    answer: answer.trim(),
    servedModel: output.response?.modelId ?? null,
    inputTokens: output.totalUsage?.inputTokens ?? null,
    outputTokens: output.totalUsage?.outputTokens ?? null,
    elapsedMs: Math.round(performance.now() - started),
  };
}
