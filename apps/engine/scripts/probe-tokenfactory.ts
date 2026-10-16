// Live check (D13): lists the Token Factory models this key can use, then makes one Nemotron call that has to use a
// tool to answer. Costs a fraction of a cent. Nothing here runs in `pnpm test`.
//
// Usage: NEBIUS_API_KEY=... pnpm probe:tokenfactory [-- --model <id>] [-- --list-only]
//
// Exit codes, when run with `node scripts/probe-tokenfactory.ts` (pnpm reports every failure as 1): 0 the model
// called the tool and answered; 1 a request failed; 2 no key; 3 the model answered without calling the tool (treat
// tool calling on that model as unproven).
import { parseArgs } from "node:util";
import { nemotronToolCall, PROBE_FACT } from "../src/providers/tool-call.ts";
import { isNvidiaModel, listModels, pickNemotron } from "../src/providers/tokenfactory.ts";

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

console.log(`\nCalling ${modelId} with one tool...`);
try {
  const result = await nemotronToolCall(apiKey, modelId, AbortSignal.timeout(120_000));
  console.log(`\n${result.answer || "(no text)"}\n`);
  console.log(JSON.stringify({ ...result, answerMentionsFact: result.answer.includes(PROBE_FACT) }, null, 2));
  if (!result.toolCalled) {
    console.error("The model answered without calling the tool: treat tool calling on this model as unproven.");
    process.exit(3);
  }
} catch (error) {
  console.error(`The model call failed: ${safe(error)}`);
  process.exit(1);
}
