import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { CHECK_IMAGE } from "../src/exec/check.ts";
import type { TransportRequest } from "../src/exec/nebius/api.ts";
import { FakeGuest } from "./fake-guest.ts";

/**
 * A stand-in for Nebius Sandboxes on 127.0.0.1, reached through the engine's loopback-only `--sandboxes-url` (D36):
 * the fake service and its guest (NIV-41, NIV-43) behind HTTP, so a real engine runs the production adapter against
 * it. It records every request with the credentials it came with, so tests can check what was sent and how. Nothing
 * here reaches the network.
 */

export interface StubbedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  project: string | null;
  /** The body as text: JSON for a spawn, the archive's bytes read as latin1 for an upload. */
  body: string;
}

export interface SandboxStub {
  /** The base URL to pass as `--sandboxes-url`. */
  url: string;
  guest: FakeGuest;
  requests: StubbedRequest[];
  /** Called with each request once it is recorded, before the service answers it: a promise holds it until it settles. */
  before: (request: StubbedRequest) => Promise<void> | undefined;
  close(): Promise<void>;
}

async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Starts the stub. Each operation that ends on its own ends at its first read, unless `quick` is false. */
export async function startSandboxStub(options: { quick?: boolean } = {}): Promise<SandboxStub> {
  const guest = new FakeGuest(CHECK_IMAGE.uuid);
  guest.quick = options.quick ?? true;
  const requests: StubbedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const bytes = await read(request);
      const method = (request.method ?? "GET") as TransportRequest["method"];
      const header = (name: string) => (typeof request.headers[name] === "string" ? (request.headers[name] as string) : null);
      const recorded = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: header("authorization"), project: header("project"), body: bytes.toString("latin1") };
      requests.push(recorded);
      // A connection the engine gives up on ends what it was waiting for, as a real one would.
      const gone = new AbortController();
      response.on("close", () => gone.abort());
      try {
        await stub.before(recorded);
        const answer = await guest.service.transport({
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: header("content-type") ? { "content-type": header("content-type")! } : {},
          ...(bytes.byteLength ? { body: url.pathname === "/v1/files" ? new Uint8Array(bytes) : bytes.toString("utf8") } : {}),
          timeoutMs: 600_000,
          maxBytes: 64 * 1024 * 1024,
          signal: gone.signal,
        });
        response.writeHead(answer.status, answer.headers);
        response.end(Buffer.from(answer.body));
      } catch {
        // The fake lost the answer, as a dropped connection does: the engine can't know what happened.
        response.destroy();
      }
    })();
  });
  const stub: SandboxStub = {
    url: "",
    guest,
    requests,
    before: () => undefined,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}
