import {
  ErrorCode,
  isMethodName,
  LineTooLongError,
  Methods,
  parseMessage,
  type MethodName,
  type RequestId,
  type RequestMessage,
  type ResultOf,
} from "@nivra/domain";
import type { z } from "zod";
import type { ProtocolOutput } from "./output.ts";

/** Thrown by a handler to answer with a specific protocol error. */
export class RpcFailure extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
    this.data = data;
  }
}

export type Handlers = {
  [M in MethodName]: (params: z.output<(typeof Methods)[M]["params"]>) => Promise<ResultOf<M>> | ResultOf<M>;
};

export interface RpcServerOptions {
  output: ProtocolOutput;
  handlers: Handlers;
  /** True once `initialize` has succeeded. */
  initialized: () => boolean;
  /** True once the engine has begun to stop: only `ping` and `shutdown` are still answered. */
  stopping: () => boolean;
  mask: (text: string) => string;
  log: (line: string) => void;
}

const BEFORE_INITIALIZE: readonly MethodName[] = ["initialize", "ping", "shutdown"];
const WHILE_STOPPING: readonly MethodName[] = ["ping", "shutdown"];

/** Up to five zod issues as "path: message", never the values that failed. */
function describeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5).map((issue) => `${issue.path.length ? issue.path.join(".") : "params"}: ${issue.message}`);
  const more = error.issues.length > 5 ? ` (and ${error.issues.length - 5} more)` : "";
  return `Invalid parameters: ${issues.join("; ")}${more}`;
}

/**
 * Answers the host's requests (D2). Each request is validated against its schema before the handler runs and the
 * result before it is sent. Requests run concurrently, so answers can arrive out of order, which JSON-RPC allows.
 */
export class RpcServer {
  readonly #options: RpcServerOptions;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: RpcServerOptions) {
    this.#options = options;
  }

  /** Handles one line from the host. */
  handleLine(line: string): void {
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      this.#track(this.#replyError(parsed.id, parsed.error.code, parsed.error.message));
      return;
    }
    const { value } = parsed;
    if (value.kind === "request") this.#track(this.#dispatch(value.message));
    else if (value.kind !== "notification") this.#options.log(`Ignored a ${value.kind} message: the engine sends no requests.`);
    // The host sends no notifications yet; unknown ones are ignored, as JSON-RPC asks.
  }

  /** Resolves when every request received so far has been answered. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  #track(work: Promise<void>): void {
    this.#inFlight.add(work);
    void work.finally(() => this.#inFlight.delete(work));
  }

  async #dispatch(request: RequestMessage): Promise<void> {
    const { id, method } = request;
    try {
      if (!isMethodName(method)) throw new RpcFailure(ErrorCode.MethodNotFound, `The engine has no method "${method.slice(0, 64)}".`);
      if (!this.#options.initialized() && !BEFORE_INITIALIZE.includes(method)) {
        throw new RpcFailure(ErrorCode.NotInitialized, "Call initialize before anything else.");
      }
      if (this.#options.stopping() && !WHILE_STOPPING.includes(method)) {
        throw new RpcFailure(ErrorCode.ShuttingDown, "The engine is shutting down.");
      }
      const schema = Methods[method];
      const params = schema.params.safeParse(request.params ?? {});
      if (!params.success) throw new RpcFailure(ErrorCode.InvalidParams, describeIssues(params.error));
      const handler = this.#options.handlers[method] as (params: unknown) => unknown;
      const result = await handler(params.data);
      const checked = schema.result.safeParse(result);
      if (!checked.success) {
        this.#options.log(`Handler for ${method} returned a result outside the protocol: ${describeIssues(checked.error)}`);
        throw new RpcFailure(ErrorCode.InternalError, `The engine produced an invalid result for ${method}.`);
      }
      await this.#options.output.send({ jsonrpc: "2.0", id, result: checked.data });
    } catch (error) {
      if (error instanceof LineTooLongError) {
        await this.#replyError(id, ErrorCode.InternalError, "The answer was too large to send.");
        return;
      }
      const failure =
        error instanceof RpcFailure ? error : new RpcFailure(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
      if (!(error instanceof RpcFailure)) this.#options.log(`${method} failed: ${this.#options.mask(failure.message)}`);
      await this.#replyError(id, failure.code, failure.message, failure.data);
    }
  }

  #replyError(id: RequestId | null, code: number, message: string, data?: unknown): Promise<void> {
    const error = { code, message: this.#options.mask(message), ...(data === undefined ? {} : { data }) };
    return this.#options.output.send({ jsonrpc: "2.0", id, error });
  }
}
