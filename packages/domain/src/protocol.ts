import { z } from "zod";

/**
 * The host–engine protocol (D2): JSON-RPC 2.0, one message per line, over the engine's stdin and stdout.
 * Bump `PROTOCOL_VERSION` whenever a change would break the other side; `initialize` refuses a mismatch.
 */
// NIV-69 / PR 46 reserves 20. Reconcile both contract sets when that branch lands.
export const PROTOCOL_VERSION = 21;

/**
 * The longest line either side accepts, in characters of decoded text. A longer line is a protocol error: it is never
 * buffered without bound.
 */
export const MAX_LINE_LENGTH = 8 * 1024 * 1024;

export const RequestId = z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]);
export type RequestId = z.infer<typeof RequestId>;

/** JSON-RPC 2.0's reserved codes, then Nivra's own in the server-error range (-32000 to -32099). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  NotInitialized: -32001,
  ShuttingDown: -32002,
  Cancelled: -32003,
  ProtocolMismatch: -32004,
  /** The run asked about isn't in this engine's store (D26): told apart from parameters that failed their schema. */
  RunNotFound: -32005,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const RpcError = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

const Method = z.string().min(1).max(128);

export const RequestMessage = z.object({ jsonrpc: z.literal("2.0"), id: RequestId, method: Method, params: z.unknown().optional() });
export type RequestMessage = z.infer<typeof RequestMessage>;

export const NotificationMessage = z.object({ jsonrpc: z.literal("2.0"), method: Method, params: z.unknown().optional() });
export type NotificationMessage = z.infer<typeof NotificationMessage>;

export const ResultMessage = z.object({ jsonrpc: z.literal("2.0"), id: RequestId, result: z.unknown() });
export type ResultMessage = z.infer<typeof ResultMessage>;

export const ErrorMessage = z.object({ jsonrpc: z.literal("2.0"), id: RequestId.nullable(), error: RpcError });
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export type Message =
  | { kind: "request"; message: RequestMessage }
  | { kind: "notification"; message: NotificationMessage }
  | { kind: "result"; message: ResultMessage }
  | { kind: "error"; message: ErrorMessage };

export type ParsedLine = { ok: true; value: Message } | { ok: false; id: RequestId | null; error: RpcError };

const invalid = (id: RequestId | null, message: string): ParsedLine => ({ ok: false, id, error: { code: ErrorCode.InvalidRequest, message } });

/**
 * Reads one line as a JSON-RPC message. It never throws: a line that is not a message comes back as the error to
 * answer with, and the id to answer it under when the line had a usable one.
 */
export function parseMessage(line: string): ParsedLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, id: null, error: { code: ErrorCode.ParseError, message: "The line is not valid JSON." } };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid(null, "A message must be one JSON object; batches are not supported.");
  }
  const fields = raw as Record<string, unknown>;
  const id = RequestId.safeParse(fields["id"]);
  const usableId = id.success ? id.data : null;

  if ("method" in fields) {
    if ("id" in fields) {
      const request = RequestMessage.safeParse(fields);
      return request.success ? { ok: true, value: { kind: "request", message: request.data } } : invalid(usableId, "The request is malformed.");
    }
    const notification = NotificationMessage.safeParse(fields);
    return notification.success
      ? { ok: true, value: { kind: "notification", message: notification.data } }
      : invalid(null, "The notification is malformed.");
  }
  if ("result" in fields) {
    const result = ResultMessage.safeParse(fields);
    return result.success ? { ok: true, value: { kind: "result", message: result.data } } : invalid(usableId, "The result is malformed.");
  }
  if ("error" in fields) {
    const error = ErrorMessage.safeParse(fields);
    return error.success ? { ok: true, value: { kind: "error", message: error.data } } : invalid(usableId, "The error is malformed.");
  }
  return invalid(usableId, "The object is not a JSON-RPC request, notification, result or error.");
}

export class LineTooLongError extends Error {
  readonly length: number;
  readonly limit: number;

  constructor(length: number, limit: number) {
    super(`A protocol line of ${length} characters is longer than the limit of ${limit}.`);
    this.name = "LineTooLongError";
    this.length = length;
    this.limit = limit;
  }
}

/**
 * Encodes one message as a protocol line, newline included. `JSON.stringify` escapes newlines inside strings, so the
 * result is always exactly one line.
 */
export function encodeMessage(message: RequestMessage | NotificationMessage | ResultMessage | ErrorMessage, limit = MAX_LINE_LENGTH): string {
  const line = JSON.stringify(message);
  if (line.length > limit) throw new LineTooLongError(line.length, limit);
  return `${line}\n`;
}
