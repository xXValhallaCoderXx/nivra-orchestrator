import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURRENT_PRICES, rateFor, TASK_MODEL } from "@nivra/domain";
import { PREFERRED_NEMOTRON } from "../src/providers/tokenfactory.ts";

/**
 * The price list against the models the engine picks (NIV-66, Nate: "Update the preferred-model price catalogue before
 * ledger wiring lands, with the proposed consistency test"). Once grants reach model calls, a model the list doesn't
 * have is refused by name under a dollar budget, and counted but never priced without one; so a model switch that
 * outruns the price list fails here, offline, before it can reach the ledger.
 */
describe("the price list and the models the engine picks", () => {
  it("has an entry for the task model and for every model the engine prefers", () => {
    const missing = [TASK_MODEL, ...PREFERRED_NEMOTRON].filter((model) => rateFor(CURRENT_PRICES, model) === null);
    assert.deepEqual(missing, []);
  });
});
