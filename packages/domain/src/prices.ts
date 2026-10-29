import type { PriceCatalogue } from "./budget.ts";

/**
 * Token Factory's prices for the models Nivra's engine can pick (providers/tokenfactory.ts PREFERRED_NEMOTRON), as its
 * public model list gave them on 28 October 2026, per million tokens, in micro-units: 0.30 is 300,000. The list names
 * no currency, and Nebius's billing page doesn't settle it, so `currency` stays null and the numbers are as listed.
 * Each model's bounds stay null too, until a supported source establishes them. So no model is admitted under a money
 * policy with this version: it prices what the ledger records, and no more.
 *
 * `apps/engine/scripts/prices.ts` prints a new version from the list for review. A new version is added, never edited
 * into this one: past records keep the version they were priced with.
 */
export const TOKEN_FACTORY_PRICES: PriceCatalogue = Object.freeze({
  version: "token-factory-2026-10-28",
  source: "https://tokenfactory.nebius.com/api/public/models_info",
  retrievedOn: "2026-10-28",
  currency: null,
  listings: "unknown",
  models: [
    { model: "nvidia/nemotron-3-super-120b-a12b", inputMicrosPerMillion: 300_000, cachedInputMicrosPerMillion: 60_000, outputMicrosPerMillion: 900_000, bounds: null },
    { model: "nvidia/Nemotron-3_5-Lightning", inputMicrosPerMillion: 60_000, cachedInputMicrosPerMillion: 30_000, outputMicrosPerMillion: 240_000, bounds: null },
    { model: "nvidia/Nemotron-3-Ultra-550b-a55b", inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 120_000, outputMicrosPerMillion: 3_000_000, bounds: null },
  ],
});

/** The price list the ledger prices new grants with. */
export const CURRENT_PRICES: PriceCatalogue = TOKEN_FACTORY_PRICES;

/** A model's rate in `catalogue`, matched as Token Factory's listing is: without regard to case. Null when it has none. */
export function rateFor(catalogue: PriceCatalogue, model: string): PriceCatalogue["models"][number] | null {
  const wanted = model.toLowerCase();
  return catalogue.models.find((rate) => rate.model.toLowerCase() === wanted) ?? null;
}
