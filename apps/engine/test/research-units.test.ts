import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Until research's integration window exports it, the domain's contract is read straight from its file (NIV-45).
import { RESEARCH_LIMITS as DOMAIN_LIMITS, ResearchRequestFailure } from "../../../packages/domain/src/research.ts";
import { RESEARCH_LIMITS } from "../src/research/limits.ts";
import type { RequestFailure } from "../src/research/retrieval.ts";

/** Research's parts, in process (NIV-45). */
describe("the engine's research limits (NIV-45)", () => {
  it("are the domain contract's, number for number, and so are the request failure kinds", () => {
    assert.deepEqual(RESEARCH_LIMITS, DOMAIN_LIMITS);
    const kinds: Record<RequestFailure, true> = {
      auth: true,
      "rate-limit": true,
      "plan-limit": true,
      rejected: true,
      server: true,
      redirect: true,
      deadline: true,
      cutoff: true,
      "too-large": true,
      malformed: true,
      network: true,
      "not-sent": true,
      "no-answer": true,
      cancelled: true,
      model: true,
    };
    assert.deepEqual(Object.keys(kinds).sort(), [...ResearchRequestFailure.options].sort());
  });
});
