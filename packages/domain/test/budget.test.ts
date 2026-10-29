import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUDGET_PRESETS,
  BudgetMonthLabel,
  BudgetPolicy,
  BudgetPolicyDraft,
  canMoveGrant,
  currencyOf,
  dayOf,
  GRANT_TRANSITIONS,
  GrantRequest,
  GrantState,
  isTimeZone,
  monthOf,
  NO_SUBLIMITS,
  priceTokens,
  priceUsage,
  PriceCatalogue,
  requestBound,
  type BudgetPolicyDraft as Draft,
  type ModelRate,
} from "../src/budget.ts";
import * as domain from "../src/index.ts";
import { CURRENT_PRICES, rateFor, TOKEN_FACTORY_PRICES, TOKEN_FACTORY_PRICES_2 } from "../src/prices.ts";

/** The shared monthly budget's contract (NIV-66): money in whole micro-units, bounds as a gate, months that only move forward. */

const SUPER: ModelRate = { model: "nvidia/nemotron-3-super-120b-a12b", inputMicrosPerMillion: 300_000, cachedInputMicrosPerMillion: 60_000, outputMicrosPerMillion: 900_000, bounds: null };
const BOUNDED: ModelRate = { ...SUPER, bounds: { inputTokens: 128_000, outputCappedByMaxTokens: true, source: "a written answer from the provider", establishedOn: "2026-10-29" } };

const DRAFT: Draft = {
  preset: "build",
  currency: "USD",
  monthlyMicros: BUDGET_PRESETS.build.monthlyMicros,
  timezone: "Asia/Singapore",
  thresholds: [50, 80, 100],
  sublimits: NO_SUBLIMITS,
  allowances: { sandboxOperations: 2_000, sandboxSeconds: 36_000, researchCredits: 200 },
  researchCreditMicros: null,
};

const iso = (at: number) => new Date(at).toISOString();

describe("prices in micro-units", () => {
  it("rounds every cost up, so a price under a micro-unit a token is never 0", () => {
    assert.equal(priceTokens(0, 300_000), 0);
    assert.equal(priceTokens(1, 300_000), 1);
    assert.equal(priceTokens(1, 30_000), 1);
    // Live run 1's reported input on 28 Oct, at Super's listed input price: 39,991.2 rounds up.
    assert.equal(priceTokens(133_304, 300_000), 39_992);
    assert.equal(priceTokens(1_000_000, 900_000), 900_000);
  });

  it("is exact for large counts, and refuses what isn't a whole, non-negative number", () => {
    assert.equal(priceTokens(9_000_000_000, 3_000_000), 27_000_000_000);
    assert.throws(() => priceTokens(-1, 300_000), RangeError);
    assert.throws(() => priceTokens(1.5, 300_000), RangeError);
    assert.throws(() => priceTokens(10, -1), RangeError);
    assert.throws(() => priceTokens(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), RangeError);
  });
});

describe("a request's reservation", () => {
  it("is null while the model's bounds aren't established, so nothing is called a ceiling", () => {
    assert.equal(requestBound(SUPER, 8_000), null);
  });

  it("is all of the most input at the full rate plus the output cap at the output rate, once they are", () => {
    const bound = requestBound(BOUNDED, 8_000);
    assert.deepEqual(bound, { inputTokens: 128_000, outputTokens: 8_000, micros: priceTokens(128_000, 300_000) + priceTokens(8_000, 900_000) });
    assert.equal(bound?.micros, 38_400 + 7_200);
    // A smaller output cap never frees more input: the input bound stands whole.
    assert.equal(requestBound(BOUNDED, 1_500)?.inputTokens, 128_000);
  });
});

describe("what a request cost", () => {
  it("prices reported cached input at its own rate, and all of it once", () => {
    const priced = priceUsage(SUPER, { inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 1_000 });
    assert.deepEqual(priced, { micros: priceTokens(6_000, 300_000) + priceTokens(4_000, 60_000) + priceTokens(1_000, 900_000), certainty: "reported" });
  });

  it("prices all input at the full rate, and says partial, when cached input wasn't reported or has no price", () => {
    assert.deepEqual(priceUsage(SUPER, { inputTokens: 10_000, cachedInputTokens: null, outputTokens: 1_000 }), { micros: 3_000 + 900, certainty: "partial" });
    assert.deepEqual(priceUsage({ ...SUPER, cachedInputMicrosPerMillion: null }, { inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 1_000 }), { micros: 3_900, certainty: "partial" });
    // A cached count larger than the input it is part of can't be right, so it isn't trusted.
    assert.deepEqual(priceUsage(SUPER, { inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 }), { micros: 30, certainty: "partial" });
  });

  it("is unknown when input or output wasn't reported, never zero", () => {
    assert.equal(priceUsage(SUPER, { inputTokens: null, cachedInputTokens: null, outputTokens: 10 }), null);
    assert.equal(priceUsage(SUPER, { inputTokens: 10, cachedInputTokens: null, outputTokens: null }), null);
  });
});

describe("budget months", () => {
  it("turns over at local midnight on the first, in the policy's zone", () => {
    const lastSecond = Date.parse("2026-10-31T15:59:59Z");
    const firstSecond = Date.parse("2026-11-01T00:00:00+08:00");
    const october = monthOf(lastSecond, "Asia/Singapore");
    const november = monthOf(firstSecond, "Asia/Singapore");
    assert.equal(october.label, "2026-10");
    assert.equal(november.label, "2026-11");
    assert.equal(november.index, october.index + 1);
    assert.equal(iso(october.endsAt), "2026-10-31T16:00:00.000Z");
    assert.equal(november.startsAt, october.endsAt);
    assert.equal(iso(october.startsAt), "2026-09-30T16:00:00.000Z");
  });

  it("follows daylight saving: London's October starts in summer time and its November in winter time", () => {
    const october = monthOf(Date.parse("2026-10-15T12:00:00Z"), "Europe/London");
    assert.equal(iso(october.startsAt), "2026-09-30T23:00:00.000Z");
    assert.equal(iso(october.endsAt), "2026-11-01T00:00:00.000Z");
    const november = monthOf(Date.parse("2026-11-15T12:00:00Z"), "America/New_York");
    // New York's clocks go back at 02:00 on 1 November 2026, so its November starts in daylight time.
    assert.equal(iso(november.startsAt), "2026-11-01T04:00:00.000Z");
    assert.equal(iso(november.endsAt), "2026-12-01T05:00:00.000Z");
  });

  it("numbers local days one after another, across local midnight and a change of summer time", () => {
    const before = dayOf(Date.parse("2026-10-28T15:59:59Z"), "Asia/Singapore");
    const after = dayOf(Date.parse("2026-10-28T16:00:00Z"), "Asia/Singapore");
    assert.deepEqual([before.label, after.label, after.index - before.index], ["2026-10-28", "2026-10-29", 1]);
    const saturday = dayOf(Date.parse("2026-10-24T12:00:00Z"), "Europe/London");
    const monday = dayOf(Date.parse("2026-10-26T12:00:00Z"), "Europe/London");
    assert.equal(monday.index - saturday.index, 2);
  });

  it("counts on across a year's end and a leap February", () => {
    const december = monthOf(Date.parse("2026-12-31T23:00:00Z"), "UTC");
    const january = monthOf(Date.parse("2027-01-01T00:00:00Z"), "UTC");
    assert.equal(january.index, december.index + 1);
    assert.equal(january.label, "2027-01");
    const february = monthOf(Date.parse("2028-02-29T12:00:00Z"), "UTC");
    assert.equal(iso(february.endsAt), "2028-03-01T00:00:00.000Z");
  });

  it("knows a time zone by name, and refuses one that isn't", () => {
    assert.equal(isTimeZone("Asia/Singapore"), true);
    assert.equal(isTimeZone("UTC"), true);
    assert.equal(isTimeZone("Mars/Olympus_Mons"), false);
    assert.equal(isTimeZone(""), false);
  });
});

describe("a policy", () => {
  it("takes a preset's amount in whole micro-units, in USD, with a known zone", () => {
    assert.equal(BudgetPolicyDraft.safeParse(DRAFT).success, true);
    assert.equal(BUDGET_PRESETS.explore.monthlyMicros, 25_000_000);
    assert.equal(BUDGET_PRESETS.intensive.monthlyMicros, 300_000_000);
  });

  it("refuses a fraction of a micro-unit, a negative or zero amount, another currency, an unknown zone or a threshold over 100", () => {
    for (const bad of [
      { ...DRAFT, monthlyMicros: 1.5 },
      { ...DRAFT, monthlyMicros: -1 },
      { ...DRAFT, monthlyMicros: 0 },
      { ...DRAFT, currency: "SGD" },
      { ...DRAFT, timezone: "Mars/Olympus_Mons" },
      { ...DRAFT, thresholds: [101] },
      { ...DRAFT, preset: "unlimited" },
      { ...DRAFT, sublimits: { ...NO_SUBLIMITS, dailyMicros: 0.25 } },
      { ...DRAFT, surprise: true },
    ]) {
      assert.equal(BudgetPolicyDraft.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 120));
    }
  });

  it("takes a counts-only budget: the preset counts, with no currency, amount, money sublimits, thresholds or credit price", () => {
    const counts = { ...DRAFT, preset: "counts", currency: null, monthlyMicros: null, thresholds: [], sublimits: NO_SUBLIMITS, researchCreditMicros: null };
    assert.equal(BudgetPolicyDraft.safeParse(counts).success, true);
    assert.equal(BudgetPolicy.safeParse({ ...counts, version: 1, replaces: null, createdAt: "2026-10-28T01:00:00.000Z" }).success, true);
  });

  it("refuses a budget that mixes the two kinds, as a draft and as a version kept", () => {
    const counts = { ...DRAFT, preset: "counts", currency: null, monthlyMicros: null, thresholds: [], sublimits: NO_SUBLIMITS, researchCreditMicros: null };
    for (const bad of [
      { ...DRAFT, currency: null },
      { ...DRAFT, monthlyMicros: null },
      { ...DRAFT, preset: "counts" },
      { ...counts, preset: "custom" },
      { ...counts, currency: "USD" },
      { ...counts, sublimits: { ...NO_SUBLIMITS, dailyMicros: 1_000_000 } },
      { ...counts, sublimits: { ...NO_SUBLIMITS, projects: [{ projectId: "6f1d1b3c-2f7e-4c8a-9e6b-1a2b3c4d5e6f", monthlyMicros: 1 }] } },
      { ...counts, thresholds: [80] },
      { ...counts, researchCreditMicros: 8_000 },
    ]) {
      assert.equal(BudgetPolicyDraft.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 160));
      assert.equal(BudgetPolicy.safeParse({ ...bad, version: 1, replaces: null, createdAt: "2026-10-28T01:00:00.000Z" }).success, false, JSON.stringify(bad).slice(0, 160));
    }
  });
});

describe("the price list", () => {
  it("parses, names its source, and establishes no currency or bounds yet", () => {
    assert.equal(PriceCatalogue.safeParse(TOKEN_FACTORY_PRICES).success, true);
    assert.equal(TOKEN_FACTORY_PRICES.currency, null);
    assert.equal(TOKEN_FACTORY_PRICES.listings, "unknown");
    assert.equal(TOKEN_FACTORY_PRICES.models.length, 3);
    assert.ok(TOKEN_FACTORY_PRICES.models.every((rate) => rate.bounds === null && rate.currency === undefined), "the first version is kept as it was");
  });

  it("is now the second version: Super VL first, in US dollars from Nebius's announcement, and Super, Lightning and Ultra with no currency yet", () => {
    assert.equal(CURRENT_PRICES, TOKEN_FACTORY_PRICES_2);
    assert.equal(PriceCatalogue.safeParse(CURRENT_PRICES).success, true);
    assert.deepEqual(
      CURRENT_PRICES.models.map((rate) => [rate.model, rate.inputMicrosPerMillion, rate.cachedInputMicrosPerMillion, rate.outputMicrosPerMillion, currencyOf(CURRENT_PRICES, rate)?.code ?? null]),
      [
        ["nvidia/Nemotron-3.5-Super-VL", 300_000, null, 900_000, "USD"],
        ["nvidia/nemotron-3-super-120b-a12b", 300_000, 60_000, 900_000, null],
        ["nvidia/Nemotron-3_5-Lightning", 60_000, 30_000, 240_000, null],
        ["nvidia/Nemotron-3-Ultra-550b-a55b", 1_000_000, 120_000, 3_000_000, null],
      ],
    );
    assert.match(rateFor(CURRENT_PRICES, "nvidia/Nemotron-3.5-Super-VL")?.currency?.source ?? "", /16 October 2026.*0\.30 USD per million input tokens and 0\.90 USD per million output tokens/);
    assert.deepEqual([CURRENT_PRICES.currency, CURRENT_PRICES.listings, CURRENT_PRICES.models.every((rate) => rate.bounds === null)], [null, "unknown", true]);
  });

  it("takes a model's own currency, else the list's, else none", () => {
    const usd = { code: "USD" as const, source: "test" };
    const rate = TOKEN_FACTORY_PRICES.models[0]!;
    assert.equal(currencyOf(TOKEN_FACTORY_PRICES, rate), null);
    assert.equal(currencyOf(TOKEN_FACTORY_PRICES, { ...rate, currency: usd }), usd);
    assert.equal(currencyOf({ ...TOKEN_FACTORY_PRICES, currency: usd }, rate), usd);
    assert.equal(currencyOf({ ...TOKEN_FACTORY_PRICES, currency: usd }, { ...rate, currency: null }), usd);
  });

  it("finds a model's rate without regard to case, and none for a model it doesn't list", () => {
    assert.equal(rateFor(TOKEN_FACTORY_PRICES, "NVIDIA/Nemotron-3-Super-120b-A12b")?.inputMicrosPerMillion, 300_000);
    assert.equal(rateFor(TOKEN_FACTORY_PRICES, "nvidia/some-other-model"), null);
  });
});

describe("grant states", () => {
  it("moves only forward, and settles, releases or is written off once", () => {
    assert.equal(canMoveGrant("written", "dispatching"), true);
    assert.equal(canMoveGrant("written", "released"), true);
    assert.equal(canMoveGrant("dispatching", "released"), false, "a grant that may have been sent is never released");
    assert.equal(canMoveGrant("accepted", "released"), false);
    assert.equal(canMoveGrant("uncertain", "released"), false);
    assert.equal(canMoveGrant("uncertain", "settled"), true);
    assert.equal(canMoveGrant("uncertain", "written-off"), true);
    // A grant still written when a new history is started can't be known unsent: it becomes uncertain, never released.
    assert.equal(canMoveGrant("written", "uncertain"), true);
    for (const terminal of ["settled", "released", "written-off"] as const) assert.deepEqual(GRANT_TRANSITIONS[terminal], []);
    assert.deepEqual(Object.keys(GRANT_TRANSITIONS).sort(), [...GrantState.options].sort());
  });
});

describe("a grant request", () => {
  it("names an extension's first grant and its one need together, or neither", () => {
    const base = {
      requestId: "0b8f3c2e-4a71-4c1e-9d6b-2f5a8e9c7d10",
      workflow: "task",
      targetId: "local",
      attribution: { feature: "task", projectId: null, taskId: null, attemptId: null, queueId: null, queueItemId: null, profile: null },
      models: [],
      productive: { requests: 0, outputTokens: 0 },
      finalisation: { requests: 0, outputTokens: 0 },
      allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 },
    };
    assert.equal(GrantRequest.safeParse({ ...base, extends: null, need: null }).success, true);
    assert.equal(GrantRequest.safeParse({ ...base, extends: base.requestId, need: "segment-2" }).success, true);
    assert.equal(GrantRequest.safeParse({ ...base, extends: base.requestId, need: null }).success, false);
    assert.equal(GrantRequest.safeParse({ ...base, extends: null, need: "segment-2" }).success, false);
  });
});

describe("a month's label", () => {
  it("is a year and a calendar month", () => {
    assert.deepEqual(["2026-11", "2026-12", "2027-01"].map((label) => BudgetMonthLabel.safeParse(label).success), [true, true, true]);
    assert.deepEqual(["2026-13", "2026-00", "2026-1", "next month"].map((label) => BudgetMonthLabel.safeParse(label).success), [false, false, false, false]);
  });
});

describe("the package's exports", () => {
  it("export the budget's contract and the price list", () => {
    assert.equal(typeof domain.priceTokens, "function");
    assert.equal(typeof domain.monthOf, "function");
    assert.equal(domain.TOKEN_FACTORY_PRICES.version, TOKEN_FACTORY_PRICES.version);
  });
});
