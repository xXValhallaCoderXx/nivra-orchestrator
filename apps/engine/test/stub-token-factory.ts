import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Token Factory on 127.0.0.1, reached through the engine's loopback-only `--token-factory-url` (D22):
 * `GET /models` and `POST /chat/completions`, answered with scripted, non-streaming OpenAI-style replies. It records
 * every request, so tests can count them and look at their headers and bodies. Tests never call a real model.
 */

export interface StubRequest {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  body: { model?: string; messages?: unknown[]; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number; [key: string]: unknown } | null;
  raw: string;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** A JSON body; `raw` sends text as it is instead. */
  body?: unknown;
  raw?: string;
  /** Wait this long before answering. */
  delayMs?: number;
  /** Drop the connection instead of answering, as a network failure would. */
  destroy?: boolean;
}

export interface StubOptions {
  models?: Array<{ id: string; context_length?: number }>;
  modelsReply?: Reply;
  /** The reply to the n-th chat request (0-based). */
  chat?: (request: StubRequest, index: number) => Reply | Promise<Reply>;
}

export interface Stub {
  /** The base URL to pass as `--token-factory-url`. */
  url: string;
  requests: StubRequest[];
  chats(): StubRequest[];
  close(): Promise<void>;
}

const usage = (prompt = 20, completion = 5) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });

/** A reply in which the model calls one tool. */
export function toolCall(name: string, args: Record<string, unknown>, options: { id?: string; tokens?: [number, number] | null } = {}): Reply {
  return {
    body: {
      id: `chatcmpl-${name}`,
      model: "nvidia/stub-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [{ id: options.id ?? `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
          finish_reason: "tool_calls",
        },
      ],
      ...(options.tokens === null ? {} : { usage: usage(...(options.tokens ?? [20, 5])) }),
    },
  };
}

/** A reply in which the model answers in text. */
export function text(content: string, options: { tokens?: [number, number] | null; headers?: Record<string, string> } = {}): Reply {
  return {
    ...(options.headers ? { headers: options.headers } : {}),
    body: {
      id: "chatcmpl-text",
      model: "nvidia/stub-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...(options.tokens === null ? {} : { usage: usage(...(options.tokens ?? [20, 5])) }),
    },
  };
}

/** An HTTP error with an OpenAI-style body. */
export const httpError = (status: number, message = "stub error"): Reply => ({ status, body: { error: { message, type: "stub" } } });

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startStub(options: StubOptions = {}): Promise<Stub> {
  const requests: StubRequest[] = [];
  let chatIndex = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let body: StubRequest["body"] = null;
      try {
        body = raw ? (JSON.parse(raw) as StubRequest["body"]) : null;
      } catch {
        body = null;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const recorded: StubRequest = { method: request.method ?? "", path, query: url.search, authorization: request.headers.authorization ?? null, body, raw };
      requests.push(recorded);
      let reply: Reply;
      if (path.endsWith("/models")) {
        reply = options.modelsReply ?? { body: { object: "list", data: options.models ?? [{ id: "nvidia/nemotron-3-super-120b-a12b" }] } };
      } else if (path.endsWith("/chat/completions")) {
        reply = options.chat ? await options.chat(recorded, chatIndex++) : httpError(500, "no script");
      } else {
        reply = httpError(404, "unknown path");
      }
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      if (reply.destroy) {
        request.socket.destroy();
        return;
      }
      if (response.destroyed) return;
      response.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    chats: () => requests.filter((r) => r.path.endsWith("/chat/completions")),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
