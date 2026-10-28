import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { after, describe, it } from "node:test";
import { COACH_RUN_LIMITS, RESEARCH_LIMITS } from "@nivra/domain";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { EXPLAIN_LIMITS } from "../src/explain/limits.ts";
import { createModelClient, ModelFailure } from "../src/providers/model.ts";
import { CHECK_DEADLINE_MS } from "../src/providers/tool-call.ts";
import { engineDispatcher, FETCH_HEADERS_MS, useEngineTransport } from "../src/providers/transport.ts";
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

/**
 * A server that answers each request after `delayMs`, and notes when a client hung up first. With `body`, it sends the
 * headers at once and holds the body for `delayMs` instead.
 */
async function slowServer(delayMs: number, options: { body?: boolean } = {}): Promise<{ url: string; closedEarly: () => number; close: () => Promise<void> }> {
  let closedEarly = 0;
  const server: Server = createServer((request: IncomingMessage, response) => {
    request.resume();
    if (options.body) response.writeHead(200, { "content-type": "application/json" }).flushHeaders();
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

  it("waits as long for the rest of a reply's body, once its headers have come", async () => {
    const server = await slowServer(3_000, { body: true });
    try {
      useEngineTransport(1_000);
      const cut = await fetch(server.url);
      assert.equal(await failureCode(cut.text()), "UND_ERR_BODY_TIMEOUT");
      useEngineTransport(6_000);
      assert.equal(await (await fetch(server.url)).text(), '{"ok":true}');
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

  it("hangs up on a model request that reaches its own deadline, rather than leaving it to fetch's wait", async () => {
    const server = await slowServer(30_000);
    try {
      useEngineTransport();
      const client = createModelClient({ apiKey: "test-key-0123456789", endpoint: { url: server.url, kind: "loopback-test" } });
      const started = performance.now();
      const failure = await client.call(client.agent({ id: "t", name: "T", modelId: "nvidia/stub-model", instructions: "Answer.", tools: {} }), "Hello", { maxSteps: 1, deadlines: { stepMs: 1_000, totalMs: 10_000 }, maxOutputTokens: 50 }).catch((error: unknown) => error);
      const tookMs = performance.now() - started;
      assert.ok(failure instanceof ModelFailure && failure.kind === "timeout", String(failure));
      assert.ok(tookMs < 5_000, `the deadline took ${Math.round(tookMs)} ms`);
      for (let tries = 0; tries < 50 && server.closedEarly() === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(server.closedEarly(), 1, "the request was left open");
    } finally {
      await server.close();
    }
  });

  it("takes the proxy from the environment where Node itself would, with the same waits", async () => {
    // A proxy that notes what it was asked for and refuses it: undici asks a proxy to tunnel (CONNECT), even for http.
    const seen: string[] = [];
    const proxy: Server = createServer((request, response) => {
      seen.push(String(request.url));
      request.resume();
      response.writeHead(403).end();
    });
    proxy.on("connect", (request: IncomingMessage, socket: Socket) => {
      seen.push(String(request.url));
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const at = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      assert.ok(engineDispatcher(FETCH_HEADERS_MS, { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: at }) instanceof EnvHttpProxyAgent);
      assert.ok(!(engineDispatcher(FETCH_HEADERS_MS, { NODE_USE_ENV_PROXY: "true", HTTP_PROXY: at }) instanceof EnvHttpProxyAgent), "only Node's own value turns it on");
      const dispatcher = engineDispatcher(FETCH_HEADERS_MS, { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: at });
      await fetch("http://nivra-proxy-check.invalid/models", { dispatcher, signal: AbortSignal.timeout(5_000) } as RequestInit).then((answer) => answer.text()).catch(() => undefined);
      // The request went to the proxy, never straight to the address it named.
      assert.equal(seen.length, 1, JSON.stringify(seen));
      assert.match(seen[0]!, /nivra-proxy-check\.invalid/);
    } finally {
      await new Promise<void>((resolve) => (proxy.closeAllConnections(), proxy.close(() => resolve())));
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
