import { Methods, type MethodName, type ParamsOf, type ResultOf } from "./methods.ts";
import { encodeMessage, ErrorCode, parseMessage, type RpcError } from "./protocol.ts";

/** The engine answered with a JSON-RPC error. `code` is the protocol's, never words to parse. */
export class RpcCallError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = "RpcCallError";
    this.code = error.code;
    this.data = error.data;
  }
}

/** The connection ended before the engine answered. */
export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RpcClosedError";
  }
}

/** The engine did not answer in time. The request may still be running in the engine. */
export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`The engine did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "RpcTimeoutError";
  }
}

export interface RpcClientOptions {
  /** Writes one encoded line (newline included) to the engine. */
  send: (line: string) => void;
  onNotification?: (method: string, params: unknown) => void;
  /** A line from the engine that is not a JSON-RPC message, or an answer to nothing. The engine broke the protocol. */
  onProtocolError?: (problem: string) => void;
  defaultTimeoutMs?: number;
}

interface Pending {
  method: MethodName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The host's side of the protocol (D2), independent of how lines travel: main feeds it the engine's stdout lines
 * through `receive` and gives it a `send` that writes to the engine's stdin. Parameters are checked before they are
 * sent and results when they arrive, against the same schemas the engine uses.
 */
export class RpcClient {
  readonly #options: RpcClientOptions;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: Error | null = null;

  constructor(options: RpcClientOptions) {
    this.#options = options;
  }

  get pending(): number {
    return this.#pending.size;
  }

  call<M extends MethodName>(method: M, params: ParamsOf<M>, options: { timeoutMs?: number } = {}): Promise<ResultOf<M>> {
    if (this.#closed) return Promise.reject(this.#closed);
    const checked = Methods[method].params.safeParse(params);
    if (!checked.success) return Promise.reject(new TypeError(`Parameters for ${method} do not match the protocol.`));
    const id = this.#nextId++;
    const line = encodeMessage({ jsonrpc: "2.0", id, method, params: checked.data });
    const timeoutMs = options.timeoutMs ?? this.#options.defaultTimeoutMs ?? 30_000;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new RpcTimeoutError(method, timeoutMs));
            }, timeoutMs)
          : null;
      (timer as { unref?: () => void } | null)?.unref?.();
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.#options.send(line);
      } catch (error) {
        this.#settle(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Feeds one line the engine wrote. */
  receive(line: string): void {
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      this.#options.onProtocolError?.(`The engine wrote a line that is not a JSON-RPC message (${parsed.error.message})`);
      return;
    }
    const { value } = parsed;
    if (value.kind === "notification") {
      this.#options.onNotification?.(value.message.method, value.message.params);
      return;
    }
    if (value.kind === "request") {
      this.#options.onProtocolError?.(`The engine sent a request (${value.message.method}); it may only answer and notify.`);
      return;
    }
    const id = value.message.id;
    const pending = typeof id === "number" ? this.#settle(id) : null;
    if (!pending) {
      this.#options.onProtocolError?.(`The engine answered a request that is not waiting (id ${String(id)}).`);
      return;
    }
    if (value.kind === "error") {
      pending.reject(new RpcCallError(value.message.error));
      return;
    }
    const result = Methods[pending.method].result.safeParse(value.message.result);
    if (result.success) pending.resolve(result.data);
    else pending.reject(new RpcCallError({ code: ErrorCode.InternalError, message: `The engine answered ${pending.method} with a result Nivra does not recognise.` }));
  }

  /** The engine is gone: every waiting call fails with `reason`, and later calls fail at once. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = new RpcClosedError(reason);
    for (const id of [...this.#pending.keys()]) this.#settle(id)?.reject(this.#closed);
  }

  #settle(id: number): Pending | null {
    const pending = this.#pending.get(id);
    if (!pending) return null;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }
}
