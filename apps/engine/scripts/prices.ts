import { PriceCatalogue, type ModelRate } from "@nivra/domain";
import { PREFERRED_NEMOTRON } from "../src/providers/tokenfactory.ts";

/**
 * Prints a new price list version from Token Factory's public model list, for review (NIV-66). It reads only that
 * public list and sends no key. It is run by hand, never by a test or the app:
 *
 *   node scripts/prices.ts --version token-factory-2026-11-30
 *
 * The output is the version as JSON, to review and add to packages/domain/src/prices.ts beside the earlier ones; a kept
 * version is never edited. The list gives prices per million tokens and names no currency, so the version's currency
 * and each model's bounds stay null: only a supported source (Nebius's documentation, or a written answer from Nebius)
 * establishes them, by hand, in review.
 */

const SOURCE = "https://tokenfactory.nebius.com/api/public/models_info";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

/** A price per million tokens, as listed, in micro-units: refused when it isn't a whole number of micro-units. */
function micros(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${what} isn't a price the list should hold (${String(value)}).`);
  const scaled = Math.round(value * 1_000_000);
  if (Math.abs(scaled - value * 1_000_000) > 1e-6) throw new Error(`${what} (${value}) isn't a whole number of micro-units.`);
  return scaled;
}

async function main(): Promise<void> {
  const version = argument("--version");
  if (!version) throw new Error("Name the new version: --version token-factory-YYYY-MM-DD.");
  const retrievedOn = new Date().toISOString().slice(0, 10);
  const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`The public model list answered ${response.status}.`);
  const listed = (await response.json()) as unknown;
  if (!Array.isArray(listed)) throw new Error("The public model list isn't a list.");
  const flavors = listed.flatMap((entry) => (Array.isArray((entry as { flavors?: unknown }).flavors) ? ((entry as { flavors: unknown[] }).flavors as Record<string, unknown>[]) : []));
  const models: ModelRate[] = PREFERRED_NEMOTRON.map((id) => {
    const flavor = flavors.find((one) => typeof one["model_id"] === "string" && one["model_id"].toLowerCase() === id.toLowerCase());
    if (!flavor) throw new Error(`${id} isn't on the public model list.`);
    const cached = flavor["input_cached_price_per_million_tokens"];
    return {
      model: String(flavor["model_id"]),
      inputMicrosPerMillion: micros(flavor["input_price_per_million_tokens"], `${id}'s input price`),
      cachedInputMicrosPerMillion: cached === undefined || cached === null ? null : micros(cached, `${id}'s cached input price`),
      outputMicrosPerMillion: micros(flavor["output_price_per_million_tokens"], `${id}'s output price`),
      bounds: null,
    };
  });
  const catalogue = PriceCatalogue.parse({ version, source: SOURCE, retrievedOn, currency: null, listings: "unknown", models });
  process.stdout.write(`${JSON.stringify(catalogue, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
