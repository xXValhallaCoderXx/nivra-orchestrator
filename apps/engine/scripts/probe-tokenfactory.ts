// Live check (D13, D22): lists the Token Factory models this key can use, makes one Nemotron call that has to use a
// tool to answer, then probes whether a required and a forced tool choice are honoured. It is the same check as
// Settings → Check Token Factory, from a terminal. Costs a fraction of a cent. Nothing here runs in `pnpm test`.
//
// Usage: NEBIUS_API_KEY=... pnpm probe:tokenfactory [-- --model <id>]
//
// Exit codes, when run with `node scripts/probe-tokenfactory.ts` (pnpm reports every failure as 1): 0 the model
// called the tool and answered; 1 a request failed; 2 no key; 3 the model answered without calling the tool (treat
// tool calling on that model as unproven).
import { parseArgs } from "node:util";
import { TOKEN_FACTORY } from "../src/providers/model.ts";
import { PROBE_FACT, runProviderCheck } from "../src/providers/tool-call.ts";

process.env["MASTRA_TELEMETRY_DISABLED"] = "1";
const apiKey = process.env["NEBIUS_API_KEY"]?.trim();
// Mastra falls back to environment keys (D8); the key is passed explicitly below and removed from the environment.
delete process.env["NEBIUS_API_KEY"];
if (!apiKey) {
  console.error("NEBIUS_API_KEY is not set. Create a key in the Token Factory console, then run:\n  NEBIUS_API_KEY=... pnpm probe:tokenfactory");
  process.exit(2);
}

/** Text with the key taken out, in case a library echoes request details. */
const safe = (value: unknown): string => {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "unknown error").split(apiKey).join("[key]");
};

const { values } = parseArgs({ options: { model: { type: "string" } }, allowPositionals: false });

try {
  const result = await runProviderCheck({ apiKey, endpoint: TOKEN_FACTORY, ...(values.model ? { model: values.model } : {}) });
  console.log(`Token Factory lists ${result.models.total} models for this key; ${result.models.nvidia.length} from NVIDIA:`);
  for (const id of result.models.nvidia) console.log(`  ${id}`);
  console.log(`\n${safe(JSON.stringify({ ...result, answerMentionsFact: result.call?.answer.includes(PROBE_FACT) ?? false }, null, 2))}`);
  if (!result.call) {
    console.error(safe(result.problem ?? "The call wasn't made."));
    process.exit(1);
  }
  if (!result.call.toolCalled) {
    console.error("The model answered without calling the tool: treat tool calling on this model as unproven.");
    process.exit(3);
  }
} catch (error) {
  console.error(`Listing models failed: ${safe(error)}`);
  process.exit(1);
}
