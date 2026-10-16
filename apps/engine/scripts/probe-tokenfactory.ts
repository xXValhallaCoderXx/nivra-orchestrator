// Live check (D13): lists the Token Factory models this key can use, then makes one Nemotron call that has to use a
// tool to answer. Costs a fraction of a cent. Nothing here runs in `pnpm test`.
//
// Usage: NEBIUS_API_KEY=... pnpm probe:tokenfactory [-- --model <id>] [-- --list-only]
//
// Exit codes, when run with `node scripts/probe-tokenfactory.ts` (pnpm reports every failure as 1): 0 the model
// called the tool and answered; 1 a request failed; 2 no key; 3 the model answered without calling the tool (treat
// tool calling on that model as unproven).
import { parseArgs } from "node:util";
import { isNvidiaModel, listModels, pickNemotron, TOKEN_FACTORY_BASE_URL } from "../src/providers/tokenfactory.ts";

process.env["MASTRA_TELEMETRY_DISABLED"] = "1";
const apiKey = process.env["NEBIUS_API_KEY"]?.trim();
// Mastra falls back to environment keys (D8); the key is passed explicitly below and removed from the environment.
delete process.env["NEBIUS_API_KEY"];
if (!apiKey) {
  console.error("NEBIUS_API_KEY is not set. Create a key in the Token Factory console, then run:\n  NEBIUS_API_KEY=... pnpm probe:tokenfactory");
  process.exit(2);
}

/** Error text with the key taken out, in case a library echoes request details. */
const safe = (value: unknown): string => {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "unknown error").split(apiKey).join("[key]");
};

const { values } = parseArgs({
  options: { model: { type: "string" }, "list-only": { type: "boolean", default: false } },
  allowPositionals: false,
});

let ids: string[];
try {
  const models = await listModels(apiKey, { signal: AbortSignal.timeout(30_000) });
  ids = models.map((model) => model.id);
  const nvidia = ids.filter(isNvidiaModel);
  console.log(`Token Factory lists ${ids.length} models for this key; ${nvidia.length} from NVIDIA:`);
  for (const id of nvidia) console.log(`  ${id}`);
} catch (error) {
  console.error(`Listing models failed: ${safe(error)}`);
  process.exit(1);
}
if (values["list-only"]) process.exit(0);

const modelId = values.model ?? pickNemotron(ids);
if (!modelId) {
  console.error("No NVIDIA model is available to this key, so there is nothing to call.");
  process.exit(1);
}
if (!ids.includes(modelId)) console.warn(`Note: ${modelId} is not in this key's model list; trying it anyway.`);

const { Agent } = await import("@mastra/core/agent");
const { createTool } = await import("@mastra/core/tools");
const { z } = await import("zod");

const BUILD_COMMAND = "pnpm verify";
const toolCalls: string[] = [];
const readProjectFact = createTool({
  id: "read_project_fact",
  description: "Returns one fact about the project, by name. Known names: build_command.",
  inputSchema: z.object({ name: z.string().max(64).describe("The fact's name, for example build_command") }),
  execute: async (input) => {
    toolCalls.push(input.name);
    return input.name === "build_command" ? { value: BUILD_COMMAND } : { value: null, note: "Unknown fact name." };
  },
});

const agent = new Agent({
  id: "tokenfactory-probe",
  name: "Token Factory probe",
  instructions: "You answer questions about a software project. Look facts up with your tools; never guess them.",
  model: { providerId: "nebius", modelId, url: TOKEN_FACTORY_BASE_URL, apiKey },
  tools: { read_project_fact: readProjectFact },
  // Same settings as the engine's agents: Mastra never re-sends a model request.
  maxRetries: 0,
  errorProcessorDefaults: false,
  maxProcessorRetries: 0,
});

console.log(`\nCalling ${modelId} with one tool...`);
const started = performance.now();
try {
  const stream = await agent.stream("What is the project's build command? Look it up with your tool, then answer in one short sentence.", {
    maxSteps: 3,
    abortSignal: AbortSignal.timeout(120_000),
  });
  let text = "";
  for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: Record<string, unknown> }>) {
    if (chunk.type === "text-delta" && typeof chunk.payload?.["text"] === "string") text += chunk.payload["text"];
    if (chunk.type === "error") throw new Error(safe(chunk.payload?.["error"] ?? chunk.payload));
  }
  const output = (await stream.getFullOutput()) as {
    finishReason?: string;
    response?: { modelId?: string };
    totalUsage?: { inputTokens?: number; outputTokens?: number };
  };
  const elapsedMs = Math.round(performance.now() - started);
  console.log(`\n${text.trim() || "(no text)"}\n`);
  console.log(
    JSON.stringify(
      {
        requestedModel: modelId,
        servedModel: output.response?.modelId ?? null,
        toolCalls,
        answerMentionsFact: text.includes(BUILD_COMMAND),
        inputTokens: output.totalUsage?.inputTokens ?? null,
        outputTokens: output.totalUsage?.outputTokens ?? null,
        finishReason: output.finishReason ?? null,
        elapsedMs,
      },
      null,
      2,
    ),
  );
  if (toolCalls.length === 0) {
    console.error("The model answered without calling the tool: treat tool calling on this model as unproven.");
    process.exit(3);
  }
} catch (error) {
  console.error(`The model call failed: ${safe(error)}`);
  process.exit(1);
}
