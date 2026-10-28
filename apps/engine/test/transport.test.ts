import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { COACH_RUN_LIMITS, RESEARCH_LIMITS } from "@nivra/domain";
import { Agent, setGlobalDispatcher } from "undici";
import { EXPLAIN_LIMITS } from "../src/explain/limits.ts";
import { createModelClient, ModelFailure } from "../src/providers/model.ts";
import { CHECK_DEADLINE_MS } from "../src/providers/tool-call.ts";
import { FETCH_HEADERS_MS, useEngineTransport } from "../src/providers/transport.ts";
import { REVIEW_REQUEST_MS } from "../src/review/run.ts";
import { TASK_LIMITS } from "../src/task/limits.ts";
import { GENERAL_LIMITS } from "../src/workflows/chat.ts";
import { startStub, text } from "./stub-token-factory.ts";

/**
 * The engine's fetch (NIV-35): Node's own, through undici's agent with the engine's waits, so a model's reply, whose
 * headers come only with its whole answer, is never cut off before the request's own deadline; and the person's cancel
 * still ends a request in flight at once. Offline: local servers only. The waits here are short stand-ins for the
 * engine's 15 minutes, which a separate offline check shows past 300 s; undici counts them in half-second ticks, so they
 * are seconds, not milliseconds.
 */
after(() => setGlobalDispatcher(new Agent()));

/** A server that answers each request after `delayMs`, and notes when a client hung up first. */
async function slowServer(delayMs: number): Promise<{ url: string; closedEarly: () => number; close: () => Promise<void> }> {
  let closedEarly = 0;
  const server: Server = createServer((request: IncomingMessage, response) => {
    request.resume();
    const timer = setTimeout(() => response.end('{"ok":true}'), delayMs);
    response.on("close", () => {
      if (!response.writableEnded) {
        closedEarly++;
        clearTimeout(timer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    closedEarly: () => closedEarly,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

const failureCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "answered";
  } catch (error) {
    return String((error as { cause?: { code?: unknown } }).cause?.code ?? (error as Error).name);
  }
};

describe("the engine's fetch (NIV-35)", () => {
  it("waits longer than any model request's own deadline, from the task worker's 830 s down", () => {
    const deadlines = { task: TASK_LIMITS.model.stepMs, handIn: TASK_LIMITS.model.handIn.stepMs, chat: GENERAL_LIMITS.stepMs, explain: EXPLAIN_LIMITS.stepMs, review: REVIEW_REQUEST_MS, coach: COACH_RUN_LIMITS.requestMs, research: RESEARCH_LIMITS.modelMs, check: CHECK_DEADLINE_MS };
    assert.deepEqual(Object.entries(deadlines).filter(([, ms]) => ms >= FETCH_HEADERS_MS), []);
    assert.equal(FETCH_HEADERS_MS, 900_000);
  });

  it("makes Node's own fetch wait for a reply's headers as long as it is set to, and no longer", async () => {
    const server = await slowServer(3_000);
    try {
      useEngineTransport(1_000);
      assert.equal(await failureCode(fetch(server.url)), "UND_ERR_HEADERS_TIMEOUT");
      useEngineTransport(6_000);
      const reply = await fetch(server.url);
      assert.deepEqual([reply.status, await reply.text()], [200, '{"ok":true}']);
    } finally {
      await server.close();
    }
  });

  it("is what a model call's request goes through: Mastra's provider uses Node's own fetch", async () => {
    const stub = await startStub({ chat: () => ({ ...text("late but whole"), delayMs: 3_000 }) });
    try {
      const client = createModelClient({ apiKey: "test-key-0123456789", endpoint: { url: stub.url, kind: "loopback-test" } });
      const call = () => client.call(client.agent({ id: "t", name: "T", modelId: "nvidia/stub-model", instructions: "Answer.", tools: {} }), "Hello", { maxSteps: 1, deadlines: { stepMs: 10_000, totalMs: 20_000 }, maxOutputTokens: 50 });
      useEngineTransport(1_000);
      const cut = await call().catch((error: unknown) => error);
      assert.ok(cut instanceof ModelFailure, String(cut));
      useEngineTransport(6_000);
      assert.equal((await call()).text, "late but whole");
      assert.equal(stub.chats().length, 2, "a request was sent again");
    } finally {
      await stub.close();
    }
  });

  it("still ends a model request in flight at once when the person cancels, however long fetch would wait", async () => {
    const server = await slowServer(30_000);
    try {
      useEngineTransport();
      const client = createModelClient({ apiKey: "test-key-0123456789", endpoint: { url: server.url, kind: "loopback-test" } });
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(new Error("the person cancelled")), 300);
      const started = performance.now();
      const failure = await client.call(client.agent({ id: "t", name: "T", modelId: "nvidia/stub-model", instructions: "Answer.", tools: {} }), "Hello", { maxSteps: 1, deadlines: { stepMs: TASK_LIMITS.model.stepMs, totalMs: TASK_LIMITS.model.stepMs }, maxOutputTokens: 50, signal: cancel.signal }).catch((error: unknown) => error);
      const tookMs = performance.now() - started;
      assert.ok(failure instanceof ModelFailure && failure.kind === "cancelled", String(failure));
      assert.ok(tookMs < 5_000, `the cancel took ${Math.round(tookMs)} ms`);
      // The request was hung up on, not left to run on at Token Factory.
      for (let tries = 0; tries < 50 && server.closedEarly() === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(server.closedEarly(), 1);
    } finally {
      await server.close();
    }
  });
});
