import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Tavily on 127.0.0.1 (NIV-45). It records every request with the credentials it came with, so a test
 * can check exactly what was sent and how, and answers each from a script: a status, a body, headers, a delay, a body
 * that keeps coming or stalls. Nothing here reaches the network.
 */

export interface TavilyCall {
  path: string;
  authorization: string | null;
  contentType: string | null;
  /** The body as sent, and parsed when it was JSON. */
  raw: string;
  body: Record<string, unknown> | null;
}

export interface TavilyReply {
  status?: number;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as it is, instead of `body`. */
  raw?: string;
  headers?: Record<string, string>;
  /** Waits this long before answering. */
  delayMs?: number;
  /** Streams this many bytes of filler with no declared length. */
  streamBytes?: number;
  /** Declares this length, then sends the body as it is. */
  declaredBytes?: number;
  /** Sends this many bytes of the body, then stops sending. */
  stallAfterBytes?: number;
}

export type TavilyScript = (call: TavilyCall, index: number) => TavilyReply | Promise<TavilyReply>;

export interface TavilyStub {
  url: string;
  calls: TavilyCall[];
  close(): Promise<void>;
}

async function read(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** A Search answer as Tavily documents it, with one result per hit. */
export function searchAnswer(hits: Array<{ url: string; title?: string; score?: number; content?: string }>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: "the query",
    answer: null,
    images: [],
    results: hits.map((hit) => ({ title: hit.title ?? "A page", url: hit.url, content: hit.content ?? "A search snippet, never given to the model.", score: hit.score ?? 0.5, raw_content: null })),
    response_time: 0.42,
    usage: { credits: 1 },
    request_id: "req-search-0001",
    ...extra,
  };
}

/** An Extract answer as Tavily documents it: each page's chunks joined by `[...]`. */
export function extractAnswer(pages: Array<{ url: string; chunks: string[] }>, failed: string[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    results: pages.map((page) => ({ url: page.url, raw_content: page.chunks.join(" [...] "), images: [] })),
    failed_results: failed.map((url) => ({ url, error: "Failed to fetch url: TAVILY-DETAIL-CANARY" })),
    response_time: 1.21,
    usage: { credits: 1 },
    request_id: "req-extract-0001",
    ...extra,
  };
}

export async function startTavilyStub(script: TavilyScript): Promise<TavilyStub> {
  const calls: TavilyCall[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await read(request);
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
      const header = (name: string) => (typeof request.headers[name] === "string" ? (request.headers[name] as string) : null);
      const call: TavilyCall = { path: new URL(request.url ?? "/", "http://127.0.0.1").pathname, authorization: header("authorization"), contentType: header("content-type"), raw, body };
      calls.push(call);
      const gone = new AbortController();
      response.on("close", () => gone.abort());
      const reply = await script(call, calls.length - 1);
      if (reply.delayMs) await pause(reply.delayMs, gone.signal);
      if (gone.signal.aborted) return;
      const text = reply.raw ?? JSON.stringify(reply.body ?? {});
      const headers: Record<string, string> = { "content-type": "application/json", ...reply.headers };
      if (reply.streamBytes !== undefined) {
        response.writeHead(reply.status ?? 200, headers);
        const piece = Buffer.alloc(64 * 1024, 0x61);
        for (let sent = 0; sent < reply.streamBytes && !gone.signal.aborted; sent += piece.byteLength) {
          if (!response.write(piece)) await new Promise((resolve) => response.once("drain", resolve));
        }
        response.end();
        return;
      }
      if (reply.declaredBytes !== undefined) headers["content-length"] = String(reply.declaredBytes);
      response.writeHead(reply.status ?? 200, headers);
      if (reply.stallAfterBytes !== undefined) {
        response.write(text.slice(0, reply.stallAfterBytes));
        // Holds the rest back until the engine gives up.
        await pause(60_000, gone.signal);
        response.destroy();
        return;
      }
      if (reply.declaredBytes !== undefined) {
        // The headers alone: an engine that reads the declared length refuses before any body comes.
        response.flushHeaders();
        await pause(10_000, gone.signal);
        response.destroy();
        return;
      }
      response.end(text);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
