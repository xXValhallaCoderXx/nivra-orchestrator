import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Budget } from "../src/explain/budget.ts";
import { Reading, readUntilAnswered } from "../src/explain/reading.ts";
import { createModelClient, InternalFailure, type StepRecord } from "../src/providers/model.ts";
import { RunBudget, type Ask, type Hold, type Refusal, type RunLimits } from "../src/providers/run-budget.ts";

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

  it("holds a reading run's request for its step's time or what is left, whichever is less, so only a run out of time refuses it", () => {
    const clock = fakeClock();
    const budget = new RunBudget({ requests: 16, totalMs: 200_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 160_000 }, { now: clock.now });
    clock.advance(140_000);
    assert.deepEqual(budget.hold({ inputTokens: 1_000, ms: 150_000 }), { reason: "time", needed: 150_000, available: 60_000 }, "a whole step's time no longer fits");
    const held = budget.hold({ inputTokens: 1_000, ms: 150_000 }, { upTo: true });
    assert.ok("admit" in held, JSON.stringify(held));
    assert.deepEqual(held.admit(), { ok: true, ms: 60_000 });
    held.settle([reported(1_000)]);
    clock.advance(60_000);
    assert.deepEqual(budget.hold({ inputTokens: 1_000, ms: 150_000 }, { upTo: true }), { reason: "deadline", needed: 0, available: 0 });
  });
});

/** Everything written to the console or stderr while `body` runs. */
async function printedDuring(body: () => Promise<unknown>): Promise<string[]> {
  const written: string[] = [];
  const originals = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
  const write = process.stderr.write.bind(process.stderr);
  const capture = (...args: unknown[]) => void written.push(args.map(String).join(" "));
  Object.assign(console, { error: capture, warn: capture, log: capture, info: capture, debug: capture });
  process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    Object.assign(console, originals);
    process.stderr.write = write;
  }
  return written;
}

/** A reading run's loop in process (D30), against Mastra's mock model: no network, no real model. */
describe("a reading run's requests under its budget (D30)", () => {
  const READING: RunLimits = { requests: 16, totalMs: 480_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 1_000_000 };
  /** Every request takes `ms` on the run's clock, reports `inputTokens`, and asks to look again. */
  async function read(runBudget: RunBudget, clock: ReturnType<typeof fakeClock>, request: { ms: number; inputTokens: number }) {
    let n = 0;
    const model = new MastraLanguageModelV2Mock({
      doGenerate: (async () => {
        clock.advance(request.ms);
        return {
          content: [{ type: "tool-call", toolCallId: `call-${n++}`, toolName: "look", input: "{}" }],
          finishReason: "tool-calls",
          usage: { inputTokens: request.inputTokens, outputTokens: 100, totalTokens: request.inputTokens + 100 },
          warnings: [],
        };
      }) as never,
    });
    const result = await readUntilAnswered({
      client: createModelClient({ apiKey: "test-key-0123456789", model: () => model }),
      agent: { id: "reading", name: "Reading", instructions: "Read, then answer." },
      model: "nvidia/test",
      prompt: "Read.",
      tools: {
        look: createTool({ id: "look", description: "Look again", inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
        submit: createTool({ id: "submit", description: "Answer", inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
      },
      answerTool: "submit",
      accepted: () => false,
      policy: { explore: "auto", forceAnswer: false, evidence: "a test" },
      budget: new Budget(64_000, 300),
      runBudget,
      reading: new Reading(),
      state: { budgetExhausted: false },
      internal: new InternalFailure(),
      limits: { maxSteps: 16, stepMs: 150_000, totalMs: 480_000 },
      maxOutputTokens: 4_000,
      event: () => {},
    });
    return { sent: model.doGenerateCalls.length, ...result };
  }

  it("sends only requests it held and admitted room for, so the budget records every request sent, near the run's end too", async () => {
    // The review's reproduction: 60 s and 50,000 tokens a request, in a run of 200 s. Each request after the first had
    // less than a step's 150 s left, its room was refused, and it went out anyway, uncounted: 4 sent, 1 recorded.
    const clock = fakeClock();
    const runBudget = new RunBudget({ ...READING, totalMs: 200_000 }, { now: clock.now });
    const { sent, steps, failed } = await read(runBudget, clock, { ms: 60_000, inputTokens: 50_000 });
    const { used, stopped } = runBudget.record();
    assert.deepEqual([sent, steps.length, used.requests, used.inputTokens, used.reportedInputTokens], [4, 4, 4, 200_000, 200_000]);
    assert.deepEqual([failed?.kind, stopped], ["timeout", "deadline"], "once no time is left nothing more is sent, and the run says why");
  });

  it("sends nothing whose admission is refused, and records no request for it", async () => {
    // Room held when the loop went on, then refused at admission, as when the run stops in between: the call ends before
    // the request, with no step for a request that never went.
    class AdmitsOnce extends RunBudget {
      #holds = 0;
      override hold(ask: Ask, options?: { upTo?: boolean }): Hold | Refusal {
        const held = super.hold(ask, options);
        if (!("admit" in held) || ++this.#holds === 1) return held;
        return { ...held, admit: () => ({ ok: false, refusal: { reason: "time", needed: 150_000, available: 0 } }) };
      }
    }
    const clock = fakeClock();
    const runBudget = new AdmitsOnce(READING, { now: clock.now });
    let run: Awaited<ReturnType<typeof read>> | undefined;
    const printed = await printedDuring(async () => void (run = await read(runBudget, clock, { ms: 1_000, inputTokens: 1_000 })));
    assert.equal(printed.length, 0, `stopping before a request prints nothing: ${printed.join(" | ").slice(0, 400)}`);
    assert.deepEqual([run?.sent, run?.steps.length, runBudget.record().used.requests], [1, 1, 1]);
    assert.deepEqual([run?.failed?.kind, run?.failed?.failedStep], ["timeout", null]);
  });

  it("sends no first request whose room can't be held, and says why", async () => {
    for (const [label, limits, kind] of [
      ["no input budget", { ...READING, estimatedInputTokens: 50 }, "budget-exhausted"],
      ["no requests", { ...READING, requests: 0 }, "budget-exhausted"],
      ["no time", { ...READING, totalMs: 0 }, "timeout"],
    ] as const) {
      const clock = fakeClock();
      const runBudget = new RunBudget(limits, { now: clock.now });
      const { sent, steps, failed } = await read(runBudget, clock, { ms: 1_000, inputTokens: 1_000 });
      assert.deepEqual([sent, steps.length, runBudget.record().used.requests, failed?.kind], [0, 0, 0, kind], label);
    }
  });
});
