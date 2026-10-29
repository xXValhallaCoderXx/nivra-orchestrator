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

/**
 * The second version, as the public model list gave it on 29 October 2026 (SGT; its answer was dated 28 October, 17:23
 * UTC). Nemotron 3.5 Super VL replaces Nemotron 3 Super as the task model and the engine's first preference (Track A's
 * switch, D50); Super stays listed until Nebius removes it on 9 November 2026, so the list holds whichever the engine
 * picks. Super VL's currency is established: Nebius's announcement of 16 October 2026 gives its input and output prices
 * in US dollars. It gives no cached-input price, so Super VL has none here (the public list's per-token value is 0.06 a
 * million, its currency not given): its cached input is priced at the full input rate, which can only count more. The
 * other models' currency, every model's bounds (the most a request can be billed, reasoning included) and whether
 * listing models is charged aren't established, so no budget in dollars can be kept with this version either.
 */
export const TOKEN_FACTORY_PRICES_2: PriceCatalogue = Object.freeze({
  version: "token-factory-2026-10-29",
  source: "https://tokenfactory.nebius.com/api/public/models_info",
  retrievedOn: "2026-10-29",
  currency: null,
  listings: "unknown",
  models: [
    {
      model: "nvidia/Nemotron-3.5-Super-VL",
      inputMicrosPerMillion: 300_000,
      cachedInputMicrosPerMillion: null,
      outputMicrosPerMillion: 900_000,
      bounds: null,
      currency: {
        code: "USD" as const,
        source:
          'Nebius, "Three new open-weight models from US companies give builders more choice", 16 October 2026 (https://nebius.com/blog/posts/three-new-open-weight-models-from-us-companies-give-builders-more-choice): "On Token Factory: 0.30 USD per million input tokens and 0.90 USD per million output tokens."',
      },
    },
    { model: "nvidia/nemotron-3-super-120b-a12b", inputMicrosPerMillion: 300_000, cachedInputMicrosPerMillion: 60_000, outputMicrosPerMillion: 900_000, bounds: null },
    { model: "nvidia/Nemotron-3_5-Lightning", inputMicrosPerMillion: 60_000, cachedInputMicrosPerMillion: 30_000, outputMicrosPerMillion: 240_000, bounds: null },
    { model: "nvidia/Nemotron-3-Ultra-550b-a55b", inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 120_000, outputMicrosPerMillion: 3_000_000, bounds: null },
  ],
});

/** The price list the ledger prices new grants with. Past records keep the version they were priced with. */
export const CURRENT_PRICES: PriceCatalogue = TOKEN_FACTORY_PRICES_2;

/** A model's rate in `catalogue`, matched as Token Factory's listing is: without regard to case. Null when it has none. */
export function rateFor(catalogue: PriceCatalogue, model: string): PriceCatalogue["models"][number] | null {
  const wanted = model.toLowerCase();
  return catalogue.models.find((rate) => rate.model.toLowerCase() === wanted) ?? null;
}
