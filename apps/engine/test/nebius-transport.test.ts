import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchTransport, SandboxApi, SandboxNotSentError, SandboxTooLargeError, type TransportRequest } from "../src/exec/nebius/api.ts";

/**
 * The real transport over loopback (NIV-41, D33). However the server stalls, before its headers or partway through its
 * body, a request ends by its deadline, POST as much as GET. An answer over its cap is refused as it arrives, and
 * nothing is sent with no time left. Real timers: short deadlines, generous bounds.
 */
let server: Server;
let base = "";
const received: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    const url = request.url ?? "";
    // Never answers.
    if (url.startsWith("/silent")) return;
    // Sends its headers and the start of its body, then nothing more.
    if (url.startsWith("/stalls")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      return;
    }
    // Says its body is 2 MiB.
    if (url.startsWith("/declared")) {
      response.writeHead(200, { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) });
      response.write("{");
      return;
    }
    // Keeps sending, with no length given, until the client goes away.
    if (url.startsWith("/endless")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 120);
      const pump = () => {
        if (!response.destroyed) response.write(chunk, () => setImmediate(pump));
      };
      pump();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"uuid":"op","status":"SUCCESS"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const transport = (prefix = "") => fetchTransport({ key: "test-key", project: "test-project" }, `${base}${prefix}`);
const request = (method: TransportRequest["method"], path: string, extra: Partial<TransportRequest> = {}): TransportRequest => ({ method, path, timeoutMs: 300, maxBytes: 1_024 * 1_024, ...extra });

/** How long the work took to settle, and how it settled. */
async function timed(work: () => Promise<unknown>): Promise<{ ms: number; error: unknown }> {
  const started = performance.now();
  try {
    await work();
    return { ms: performance.now() - started, error: null };
  } catch (error) {
    return { ms: performance.now() - started, error };
  }
}

describe("Nebius Sandboxes, loopback: every request ends by its deadline, and every answer is bounded (NIV-41, D33)", () => {
  it("ends a GET and a POST that get no headers at their deadline", async () => {
    for (const method of ["GET", "POST"] as const) {
      const { ms, error } = await timed(() => transport()(request(method, "/silent", method === "POST" ? { body: "{}" } : {})));
      assert.equal((error as Error | null)?.name, "TimeoutError", `${method} was ended by its own timeout`);
      assert.ok(ms >= 250 && ms < 3_000, `${method} ended at its 300 ms deadline, not ${Math.round(ms)} ms`);
    }
  });

  it("ends a request whose body stops partway at its deadline, while the body is being read", async () => {
    const { ms, error } = await timed(() => transport()(request("GET", "/stalls")));
    assert.equal((error as Error | null)?.name, "TimeoutError");
    assert.ok(ms >= 250 && ms < 3_000, `ended at its 300 ms deadline, not ${Math.round(ms)} ms`);
  });

  it("refuses an answer whose declared length is over the cap without reading it, and one that keeps coming once it passes it", async () => {
    const declared = await timed(() => transport()(request("GET", "/declared", { maxBytes: 1_024, timeoutMs: 30_000 })));
    assert.ok(declared.error instanceof SandboxTooLargeError);
    assert.ok(declared.ms < 3_000, `refused at once, not after ${Math.round(declared.ms)} ms`);
    const endless = await timed(() => transport()(request("GET", "/endless", { maxBytes: 256 * 1024, timeoutMs: 30_000 })));
    assert.ok(endless.error instanceof SandboxTooLargeError);
    assert.ok(endless.ms < 5_000, `cut off once past the cap, not after ${Math.round(endless.ms)} ms`);
  });

  it("sends nothing with less than a millisecond left", async () => {
    const before = received.length;
    const { error } = await timed(() => transport()(request("POST", "/v1/instances", { timeoutMs: 0.5, body: "{}" })));
    assert.ok(error instanceof SandboxNotSentError && error.reason === "no-time");
    assert.equal(received.length, before, "the server saw no request");
  });

  it("leaves a spawn whose POST got no answer by its deadline uncertain, never 'not sent', once it reached the server", async () => {
    const api = new SandboxApi(transport("/silent"), { minWriteMs: 100 });
    const before = received.length;
    const { ms } = await timed(async () => {
      const answer = await api.spawn({ command: "/bin/true", args: [], image: "base", shell: false, env: {}, disposable: true, networking: { enabled: false }, timeout: 5 }, { until: performance.now() + 400 });
      assert.equal(answer.status, "uncertain");
    });
    assert.deepEqual(received.slice(before), ["POST /silent/v1/instances"]);
    assert.ok(ms < 3_000, `ended at its deadline, not after ${Math.round(ms)} ms`);
  });

  it("reads an ordinary answer in full", async () => {
    const answer = await transport()(request("GET", "/v1/operations/op"));
    assert.deepEqual([answer.status, new TextDecoder().decode(answer.body)], [200, '{"uuid":"op","status":"SUCCESS"}']);
  });
});
