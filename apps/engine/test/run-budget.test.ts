import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StepRecord } from "../src/providers/model.ts";
import { RunBudget, type Hold, type RunLimits } from "../src/providers/run-budget.ts";

/**
 * The shared run limits (NIV-38, D30): hard limits on requests, time and output, and an estimated budget for input that
 * decides admission without promising a ceiling. On a fake clock, so time is exact.
 */
const COUNCIL: RunLimits = { requests: 3, totalMs: 330_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 120_000 };
const reported = (inputTokens: number | null, outputTokens: number | null = 100): StepRecord => ({
  stepNumber: 0,
  elapsedMs: 1,
  inputTokens,
  outputTokens,
  finishReason: "tool-calls",
  servedModel: null,
  toolNames: [],
  rejectedTools: [],
  rateLimit: { remainingTokens: null, remainingRequests: null, resetTokensSeconds: null, overLimit: false },
});
const fakeClock = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};
const reviewers = (inputTokens: number) => [
  { inputTokens, ms: 150_000 },
  { inputTokens, ms: 150_000 },
];
function councilHolds(budget: RunBudget, reviewerInput: number, chairInput: number): Hold[][] {
  const reserved = budget.reserve([reviewers(reviewerInput), [{ inputTokens: chairInput, ms: 150_000 }]]);
  assert.ok(reserved.ok, JSON.stringify(reserved));
  return reserved.holds;
}

describe("RunBudget (NIV-38, D30)", () => {
  it("reserves every request of a run before any is sent, or none, and nothing more fits beside a held chair", () => {
    const clock = fakeClock();
    const budget = new RunBudget(COUNCIL, { now: clock.now });
    councilHolds(budget, 30_000, 45_000);
    assert.deepEqual(budget.fits(1_000), { reason: "requests", needed: 1, available: 0 });
    const tooMuch = new RunBudget(COUNCIL, { now: clock.now }).reserve([reviewers(50_000), [{ inputTokens: 45_000, ms: 150_000 }]]);
    assert.deepEqual(tooMuch, { ok: false, refusal: { reason: "input", needed: 145_000, available: 120_000 } });
    const tooLong = new RunBudget({ ...COUNCIL, totalMs: 200_000 }, { now: clock.now }).reserve([reviewers(1_000), [{ inputTokens: 1_000, ms: 150_000 }]]);
    assert.deepEqual(tooLong, { ok: false, refusal: { reason: "time", needed: 300_000, available: 200_000 } });
  });

  it("admits concurrent reviewers together, keeps the chair's full room when they report three times their estimate, and records the overrun", () => {
    const clock = fakeClock();
    const budget = new RunBudget(COUNCIL, { now: clock.now });
    const [[architecture, risks], [chair]] = councilHolds(budget, 30_000, 45_000) as [[Hold, Hold], [Hold]];
    assert.deepEqual([architecture.admit().ok, risks.admit().ok], [true, true], "both are in flight before either settles");
    architecture.settle([reported(90_000)]);
    risks.settle([reported(90_000)]);
    assert.equal(chair.admit().ok, true, "a reservation once held is honoured");
    chair.settle([reported(45_000)]);
    const used = budget.record().used;
    assert.deepEqual(
      [used.requests, used.inputTokens, used.reportedInputTokens, used.reportedOutputTokens, used.overrunTokens, used.unreportedRequests],
      [3, 225_000, 225_000, 300, 120_000, 0],
      "past the estimated budget, and said so",
    );
  });

  it("counts a request that reported nothing at its estimate, leaving the reported totals unknown, and a request let go unanswered too", () => {
    const budget = new RunBudget(COUNCIL, { now: fakeClock().now });
    const [[architecture, risks], [chair]] = councilHolds(budget, 30_000, 45_000) as [[Hold, Hold], [Hold]];
    architecture.admit();
    risks.admit();
    architecture.settle([reported(25_000)]);
    risks.settle([reported(null, null)]);
    chair.release();
    const used = budget.record().used;
    assert.deepEqual([used.requests, used.inputTokens, used.reportedInputTokens, used.reportedOutputTokens, used.unreportedRequests], [2, 55_000, null, null, 1]);

    const lost = new RunBudget(COUNCIL, { now: fakeClock().now });
    const held = lost.hold({ inputTokens: 10_000, ms: 1_000 });
    assert.ok("admit" in held);
    held.admit();
    held.release();
    assert.deepEqual([lost.record().used.inputTokens, lost.record().used.unreportedRequests], [10_000, 1], "it may have reached the provider, so it counts");
  });

  it("holds time back for later phases, admits a hold once, and admits nothing after a cancel or the deadline", () => {
    const clock = fakeClock();
    const budget = new RunBudget(COUNCIL, { now: clock.now });
    const [[architecture, risks], [chair]] = councilHolds(budget, 1_000, 1_000) as [[Hold, Hold], [Hold]];
    clock.advance(100_000);
    const first = architecture.admit();
    assert.deepEqual(first, { ok: true, ms: 80_000 }, "230 s are left, and 150 s are kept for the chair");
    assert.equal(architecture.admit().ok, false, "once only");
    assert.deepEqual(chair.admit(), { ok: true, ms: 150_000 });

    const cancel = new AbortController();
    const cancelled = new RunBudget(COUNCIL, { now: clock.now, signal: cancel.signal });
    const [[a]] = councilHolds(cancelled, 1_000, 1_000);
    cancel.abort();
    assert.deepEqual([a!.admit().ok, cancelled.stopped, cancelled.fits(1)?.reason], [false, "cancelled", "cancelled"]);

    const late = fakeClock();
    const expired = new RunBudget(COUNCIL, { now: late.now });
    const [[b]] = councilHolds(expired, 1_000, 1_000);
    late.advance(330_000);
    assert.deepEqual([b!.admit().ok, expired.stopped], [false, "deadline"]);
    void risks;
  });

  it("lets a reading run's requests in one at a time, and says when the next can't fit with room kept for the answer", () => {
    const budget = new RunBudget({ requests: 16, totalMs: 480_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 160_000 }, { now: fakeClock().now });
    for (const tokens of [30_000, 30_000, 30_000]) {
      assert.equal(budget.fits(tokens, 60_000), null);
      const held = budget.hold({ inputTokens: tokens, ms: 150_000 });
      assert.ok("admit" in held);
      held.admit();
      held.settle([reported(tokens)]);
    }
    assert.deepEqual(budget.fits(30_000, 60_000), { reason: "input", needed: 90_000, available: 70_000 }, "no room for another request and a full answer");
    assert.equal(budget.fits(30_000), null, "the answer itself still fits");
    budget.stop("exhausted");
    assert.deepEqual([budget.fits(1)?.reason, budget.record().stopped], ["exhausted", "exhausted"]);
  });
});
