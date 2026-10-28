import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { Agent } from "@mastra/core/agent";
import { MastraTimeoutError } from "@mastra/core/loop";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { belowPauseThreshold, createModelClient, InternalFailure, ModelFailure, rateLimitOf, TOKEN_FACTORY, toModelFailure, type CallOptions } from "../src/providers/model.ts";

/** Model calls in-process, against Mastra's own mock model (D22): no network, no real model. */
type Generated = { content: unknown[]; finishReason: string; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; warnings: unknown[] };
const answer = (text: string, tokens: [number, number] | null = [10, 3]): Generated => ({
  content: [{ type: "text", text }],
  finishReason: "stop",
  usage: tokens ? { inputTokens: tokens[0], outputTokens: tokens[1], totalTokens: tokens[0] + tokens[1] } : {},
  warnings: [],
});
const useTool = (toolName: string, input: unknown): Generated => ({
  content: [{ type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
  finishReason: "tool-calls",
  usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  warnings: [],
});
const apiError = (statusCode: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${statusCode}`), { name: "AI_APICallError", statusCode, isRetryable: false, ...extra });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(doGenerate: (options: unknown) => Promise<Generated>, tools: Record<string, unknown> = {}) {
  const model = new MastraLanguageModelV2Mock({ doGenerate: doGenerate as never });
  const client = createModelClient({ apiKey: "test-key-0123456789", model: () => model });
  const agent = client.agent({ id: "test", name: "Test", modelId: "nvidia/test", instructions: "Answer briefly.", tools });
  const call = (options: Partial<CallOptions> = {}) => client.call(agent, "Hello", { maxSteps: 3, deadlines: { stepMs: 5_000, totalMs: 10_000 }, maxOutputTokens: 200, ...options });
  return { model, call };
}

const kindOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "no failure";
  } catch (error) {
    return error instanceof ModelFailure ? error.kind : `not a ModelFailure: ${String(error)}`;
  }
};

describe("ModelClient (D22)", () => {
  it("sends one request and never retries, whatever the provider says", async () => {
    for (const status of [401, 429, 500, 503]) {
      const { model, call } = harness(async () => {
        throw apiError(status, { isRetryable: status !== 401 });
      });
      await assert.rejects(call(), ModelFailure);
      assert.equal(model.doGenerateCalls.length, 1, `HTTP ${status}`);
    }
  });

  it("reports a failed request once, with the failure, never as a step of its own", async () => {
    const tools = { probe: createTool({ id: "probe", description: "Probe", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    for (const [label, script] of [["first request fails", [null]], ["a success, then a failure", [useTool("probe", {}), null]]] as const) {
      let n = 0;
      const seen: number[] = [];
      const { model, call } = harness(async () => {
        const reply = script[n++];
        if (!reply) throw apiError(500);
        return reply;
      }, tools);
      const error = await call({ onStep: (step) => seen.push(step.stepNumber) }).catch((e: unknown) => e);
      assert.ok(error instanceof ModelFailure);
      const succeeded = script.length - 1;
      assert.deepEqual([label, model.doGenerateCalls.length, seen, error.failedStep?.stepNumber, error.steps.length], [label, script.length, succeeded ? [0] : [], succeeded, script.length]);
    }
  });

  it("records a call whose input failed the tool's schema by field and rule, never the input, and lets the model retry", async () => {
    let ran = 0;
    const tools = { probe: createTool({ id: "probe", description: "Probe", inputSchema: z.object({ n: z.number().max(3) }), execute: async () => ({ ok: ++ran }) }) };
    let n = 0;
    const { call } = harness(async () => [useTool("probe", { n: 99 }), useTool("probe", { n: 2 }), answer("done")][n++]!, tools);
    const result = await call();
    assert.deepEqual([result.steps[0]?.rejectedTools.map((r) => r.tool), result.steps[1]?.rejectedTools, ran], [["probe"], [], 1]);
    assert.match(result.steps[0]!.rejectedTools[0]!.problems[0]!, /^n: /);
    assert.equal(JSON.stringify(result.steps[0]!.rejectedTools).includes("99"), false, "the input itself is never recorded");
  });

  it("records each step's tokens and sums them, or reports null when any step didn't say", async () => {
    let n = 0;
    const tools = { probe: createTool({ id: "probe", description: "Probe", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    const reported = harness(async () => (n++ === 0 ? useTool("probe", {}) : answer("done", [15, 4])), tools);
    const result = await reported.call();
    assert.deepEqual([result.text, result.steps.length, result.usage], ["done", 2, { inputTokens: 25, outputTokens: 6 }]);

    let m = 0;
    const silent = harness(async () => (m++ === 0 ? useTool("probe", {}) : answer("done", null)), tools);
    assert.deepEqual((await silent.call()).usage, { inputTokens: null, outputTokens: null });
  });

  it("fails one slow model call as a timeout, not a cancellation", async () => {
    const { call } = harness(async () => {
      await sleep(400);
      return answer("late");
    });
    const failure = await call({ deadlines: { stepMs: 100, totalMs: 5_000 } }).catch((error: unknown) => error);
    assert.ok(failure instanceof ModelFailure);
    assert.equal(failure.kind, "timeout");
    assert.match(failure.message, /one model call took longer/);
  });

  it("gives a request its own output cap and deadline when the call's step asks, and the call's to the others, never retrying (NIV-35)", async () => {
    const tools = { probe: createTool({ id: "probe", description: "Probe", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    let n = 0;
    const { model, call } = harness(async () => {
      if (n++ === 0) return useTool("probe", {});
      // The second request takes longer than its own deadline, though well inside the call's.
      await sleep(400);
      return answer("late");
    }, tools);
    const failure = await call({ deadlines: { stepMs: 5_000, totalMs: 10_000 }, prepareStep: ({ stepNumber }) => (stepNumber === 1 ? { maxOutputTokens: 50, stepMs: 100 } : undefined) }).catch((error: unknown) => error);
    assert.ok(failure instanceof ModelFailure);
    assert.deepEqual([failure.kind, model.doGenerateCalls.length, model.doGenerateCalls.map((options) => (options as { maxOutputTokens?: number }).maxOutputTokens)], ["timeout", 2, [200, 50]]);
    // A provider's failure of such a request is never retried either.
    let m = 0;
    const failing = harness(async () => {
      if (m++ === 0) return useTool("probe", {});
      throw apiError(503, { isRetryable: true });
    }, tools);
    await assert.rejects(failing.call({ prepareStep: ({ stepNumber }) => (stepNumber === 1 ? { maxOutputTokens: 50, stepMs: 1_000 } : undefined) }), ModelFailure);
    assert.equal(failing.model.doGenerateCalls.length, 2, "the failed request was sent again");
  });

  it("fails a run that outlasts its whole budget as a timeout, even when each call is quick", async () => {
    let n = 0;
    const slowTool = createTool({ id: "slow", description: "Slow", inputSchema: z.object({}), execute: async () => (await sleep(400), { ok: true }) });
    const { call } = harness(async () => (n++ === 0 ? useTool("slow", {}) : answer("done")), { slow: slowTool });
    const failure = await call({ deadlines: { stepMs: 5_000, totalMs: 200 } }).catch((error: unknown) => error);
    assert.ok(failure instanceof ModelFailure);
    assert.equal(failure.kind, "timeout");
    assert.match(failure.message, /the whole run took longer/);
  });

  it("ends as cancelled when the person cancels", async () => {
    const cancel = new AbortController();
    const { call } = harness(async () => {
      await sleep(300);
      return answer("late");
    });
    setTimeout(() => cancel.abort(), 50);
    assert.equal(await kindOf(call({ signal: cancel.signal })), "cancelled");
  });

  it("records exactly the requests the provider received, whether cancelled before, during or between them", async () => {
    const outcome = (error: unknown) => {
      assert.ok(error instanceof ModelFailure);
      return [error.kind, error.steps.length, error.failedStep?.stepNumber ?? null];
    };
    // Before any request: none is made, and none is recorded.
    const before = new AbortController();
    before.abort();
    const idle = harness(async () => answer("never"));
    const early = await idle.call({ signal: before.signal }).catch((e: unknown) => e);
    assert.deepEqual([idle.model.doGenerateCalls.length, ...outcome(early)], [0, "cancelled", 0, null]);

    // During a request: that request is the one that failed.
    const during = new AbortController();
    const slow = harness(async () => {
      await sleep(300);
      return answer("late");
    });
    setTimeout(() => during.abort(), 50);
    const mid = await slow.call({ signal: during.signal }).catch((e: unknown) => e);
    assert.deepEqual([slow.model.doGenerateCalls.length, ...outcome(mid)], [1, "cancelled", 1, 0]);

    // Between requests, once the first was reported: one request, one step, nothing failed at the provider.
    const between = new AbortController();
    const tools = { probe: createTool({ id: "probe", description: "Probe", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    let n = 0;
    const two = harness(async () => (n++ === 0 ? useTool("probe", {}) : answer("never")), tools);
    const afterStep = await two.call({ signal: between.signal, onStep: () => between.abort() }).catch((e: unknown) => e);
    assert.deepEqual([two.model.doGenerateCalls.length, ...outcome(afterStep)], [1, "cancelled", 1, null]);

    // Between requests, while the first one's tool ran: that request is recorded once, with the usage it reported.
    const inTool = new AbortController();
    const aborting = {
      probe: createTool({ id: "probe", description: "Probe", inputSchema: z.object({}), execute: async () => {
        inTool.abort();
        await sleep(50);
        return { ok: true };
      } }),
    };
    let m = 0;
    const seen: Array<[number, number | null]> = [];
    const three = harness(async () => (m++ === 0 ? useTool("probe", {}) : answer("never")), aborting);
    const cut = await three.call({ signal: inTool.signal, onStep: (step) => seen.push([step.stepNumber, step.inputTokens]) }).catch((e: unknown) => e);
    assert.deepEqual([three.model.doGenerateCalls.length, ...outcome(cut), seen], [1, "cancelled", 1, null, [[0, 10]]]);
  });

  it("keeps an internal failure a failure, never a cancellation", async () => {
    const internal = new InternalFailure();
    const broken = createTool({
      id: "broken",
      description: "Broken",
      inputSchema: z.object({}),
      execute: async () => {
        internal.fail(new Error("the repository disappeared"));
        return { refused: "internal" };
      },
    });
    let n = 0;
    const { call } = harness(async () => (n++ === 0 ? useTool("broken", {}) : answer("should not be reached")), { broken });
    const failure = await call({ internal }).catch((error: unknown) => error);
    assert.ok(failure instanceof ModelFailure);
    assert.equal(failure.kind, "internal");
    // Named by its class, never its words: those can quote the repository, and a failure's message is persisted.
    assert.deepEqual([/\(Error\)/.test(failure.message), failure.message.includes("the repository disappeared")], [true, false]);
    // What the diagnostic will say (NIV-27): a code, where, and the error's facts, never its words.
    assert.deepEqual([failure.facts?.code, failure.facts?.stage, failure.facts?.error?.classes, JSON.stringify(failure.facts).includes("disappeared")], ["unexpected-error", "model.call", ["Error"], false]);
  });

  it("prints nothing about a failed request, prompt included (Mastra's logger is silenced)", async () => {
    const canary = `nivra-prompt-canary-${Date.now()}`;
    const failing = async () => {
      throw apiError(500, { requestBodyValues: { messages: [{ role: "user", content: canary }] }, responseBody: canary });
    };
    /** Everything written to the console or stderr while `body` runs, objects shown as the console would show them. */
    const consoleDuring = async (body: () => Promise<unknown>): Promise<string[]> => {
      const written: string[] = [];
      const originals = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug, write: process.stderr.write.bind(process.stderr) };
      const capture = (...args: unknown[]) => void written.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 8 }))).join(" "));
      Object.assign(console, { error: capture, warn: capture, log: capture, info: capture, debug: capture });
      process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
      try {
        await body().catch(() => undefined);
      } finally {
        Object.assign(console, { error: originals.error, warn: originals.warn, log: originals.log, info: originals.info, debug: originals.debug });
        process.stderr.write = originals.write;
      }
      return written.filter((line) => line.includes(canary));
    };
    // The capture can see a leak: an agent with Mastra's default logger prints the prompt.
    const unsilenced = new Agent({ id: "control", name: "Control", instructions: "x", model: new MastraLanguageModelV2Mock({ doGenerate: failing as never }) as never, maxRetries: 0, errorProcessorDefaults: false, maxProcessorRetries: 0 });
    assert.ok((await consoleDuring(() => unsilenced.generate("Hello", { maxSteps: 1 } as never))).length > 0, "Mastra's default logger prints the prompt");
    const { call } = harness(failing);
    assert.deepEqual(await consoleDuring(() => call()), []);
  });
});

describe("toModelFailure", () => {
  it("names a failure by its class and status, walking the causes Mastra wraps it in", () => {
    const wrapped = (inner: unknown) => Object.assign(new Error("AGENT_GENERATE_FAILED"), { cause: inner });
    const cases: Array<[unknown, string]> = [
      [wrapped(apiError(401)), "auth"],
      [apiError(403), "auth"],
      [apiError(404), "model-unavailable"],
      [apiError(408), "timeout"],
      [apiError(429), "rate-limit"],
      [apiError(400), "bad-request"],
      [apiError(502), "provider"],
      [apiError(200, { message: "Invalid JSON response", cause: Object.assign(new Error("Unexpected token"), { name: "AI_JSONParseError" }) }), "bad-response"],
      [Object.assign(new Error("Invalid JSON response"), { name: "AI_JSONParseError" }), "bad-response"],
      [Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }), "network"],
      // As the AI SDK wraps fetch giving up on a late reply: its cause is undici's own error (NIV-35).
      [apiError(0, { statusCode: undefined, message: "Cannot connect to API: Headers Timeout Error", cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }), "timeout"],
      [apiError(0, { statusCode: undefined, message: "Cannot connect to API: Body Timeout Error", cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }) }), "timeout"],
      [wrapped(new MastraTimeoutError({ timeoutType: "step", timeoutMs: 1_000 })), "timeout"],
      [new Error("something odd"), "internal"],
    ];
    assert.deepEqual(cases.map(([error]) => toModelFailure(error).kind), cases.map(([, kind]) => kind));
  });

  it("names a model list it can't read as an unreadable answer, not as Nivra failing", async () => {
    const client = createModelClient({ apiKey: "test-key", endpoint: TOKEN_FACTORY, fetch: (async () => new Response("this is not JSON")) as typeof fetch });
    await assert.rejects(client.listModels(), (error: unknown) => error instanceof ModelFailure && error.kind === "bad-response" && /Try again/.test(error.message));
  });

  it("says what to do, not just what happened", () => {
    assert.match(toModelFailure(apiError(401)).message, /Check the key in Settings/);
    assert.match(toModelFailure(apiError(429)).message, /Wait a minute/);
  });

  it("says when to try again after a 429, from Retry-After or the token limit's reset", () => {
    const retry = toModelFailure(apiError(429, { responseHeaders: { "Retry-After": "12" } }));
    assert.deepEqual([retry.kind, retry.retryAfterSeconds], ["rate-limit", 12]);
    assert.match(retry.message, /Try again in 12 s/);
    assert.equal(toModelFailure(apiError(429, { responseHeaders: { "x-ratelimit-reset-tokens": "0.3" } })).retryAfterSeconds, 1);
  });
});

describe("rate-limit values", () => {
  it("reads the documented headers whatever their case, and says when Mastra would pause", () => {
    const low = rateLimitOf({ "X-RateLimit-Remaining-Tokens": "1500", "x-ratelimit-reset-tokens": "2", "x-ratelimit-over-limit": "yes" });
    assert.deepEqual([low.remainingTokens, low.resetTokensSeconds, low.overLimit, belowPauseThreshold(low)], [1500, 2, true, true]);
    assert.equal(belowPauseThreshold(rateLimitOf({ "x-ratelimit-remaining-tokens": "250000" })), false);
    assert.equal(belowPauseThreshold(rateLimitOf({})), null);
  });
});
