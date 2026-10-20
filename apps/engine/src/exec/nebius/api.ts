import { z } from "zod";

/**
 * A REST client for Nebius Token Factory Sandboxes (NIV-29), over `fetch`, with the transport injectable so tests run
 * against a fake service. No SDK (the only one is Python) and no dependency. It is not wired into the engine: no
 * backend claims anything from it until the proof says it may (D9, D27).
 *
 * Responses are read leniently, since the API is in beta: fields Nivra needs are checked, the rest pass through.
 * Statuses are compared ignoring case. A spawn is never retried: when its answer is lost or is a server error, the
 * operation may exist, so the result is `uncertain` and the caller reconciles. Reads are retried within their deadline,
 * honouring `Retry-After`. No message ever carries a response body or a credential.
 */

export const SANDBOXES_BASE_URL = "https://api.tokenfactory.nebius.com/sandboxes";

export interface TransportRequest {
  method: "GET" | "POST" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** The transport for the real service: the key and project id go in headers only, and never into an error. */
export function fetchTransport(credentials: { key: string; project: string }, base = SANDBOXES_BASE_URL): Transport {
  return async (request) => {
    const url = new URL(`${base}${request.path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
    const response = await fetch(url, {
      method: request.method,
      headers: { Authorization: `Bearer ${credentials.key}`, Project: credentials.project, ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(request.timeoutMs),
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
    return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
  };
}

/** A failure Nivra can name: the request, the HTTP status, and when to try again; never the body. */
export class SandboxHttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(what: string, status: number, retryAfterSeconds: number | null) {
    super(`${what} was answered with HTTP ${status}${retryAfterSeconds !== null ? `; try again in ${retryAfterSeconds} s` : ""}.`);
    this.name = "SandboxHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request got no answer within its deadline, or the connection failed. */
export class SandboxNetworkError extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what} got no answer (${cause instanceof Error ? cause.name : "an unknown error"}).`);
    this.name = "SandboxNetworkError";
  }
}

export const STATUSES = ["PENDING", "ASSIGNED", "EXECUTING", "SUCCESS", "FAILED", "CANCELLED"] as const;
export type OperationStatus = (typeof STATUSES)[number];
export const TERMINAL: ReadonlySet<OperationStatus> = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/** A status as Nivra reads it: any case; anything else is `UNKNOWN`, never guessed. */
export function readStatus(raw: unknown): OperationStatus | "UNKNOWN" {
  const upper = typeof raw === "string" ? raw.toUpperCase() : "";
  return (STATUSES as readonly string[]).includes(upper) ? (upper as OperationStatus) : "UNKNOWN";
}

const Stream = z.looseObject({ value: z.string().optional(), encoding: z.string().optional(), truncated: z.boolean().optional() }).nullable().optional();

/** An operation as the service describes it. Only what Nivra reads is checked. */
export const Operation = z.looseObject({
  uuid: z.string(),
  kind: z.string().optional(),
  status: z.string(),
  error: z.unknown().optional(),
  created_at: z.string().optional(),
  duration: z.number().nullable().optional(),
  image_size: z.number().nullable().optional(),
  consumed_cpu: z.unknown().optional(),
  consumed_memory: z.unknown().optional(),
  image_uuid: z.string().nullable().optional(),
  result_image_uuid: z.string().nullable().optional(),
  metadata: z
    .looseObject({
      env: z.record(z.string(), z.string()).nullable().optional(),
      result: z
        .looseObject({
          state: z.looseObject({ exit_code: z.number().nullable().optional(), signal: z.union([z.number(), z.string()]).nullable().optional(), timed_out: z.boolean().nullable().optional() }).nullable().optional(),
          stdout: Stream,
          stderr: Stream,
          resources: z.looseObject({}).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  result: z.looseObject({ image: z.string().nullable().optional(), tag: z.string().nullable().optional() }).nullable().optional(),
});
export type Operation = z.infer<typeof Operation>;

const Created = z.looseObject({ uuid: z.string() });
const Uploaded = z.looseObject({ uuid: z.string(), sha256: z.string().optional(), size: z.number().optional() });
const Subprocess = z.looseObject({ spid: z.number() });

/** A file placed in the operation's filesystem. */
export interface FileRef {
  uuid: string;
  uid?: number;
  gid?: number;
  mode?: string;
}

/** What a spawn asks for, in the service's own field names. Network and disposability are always stated. */
export interface SpawnBody {
  command: string;
  args: string[];
  image: string;
  shell: boolean;
  env: Record<string, string>;
  cwd?: string;
  disposable: boolean;
  networking: { enabled: boolean };
  timeout: number;
  truncate_output_at?: number;
  files?: Record<string, FileRef>;
}

export type SpawnAnswer = { status: "created"; id: string } | { status: "uncertain"; cause: string };

export interface SandboxApiOptions {
  /** Each request's own deadline. */
  requestTimeoutMs?: number;
  /** How long reads may keep retrying, in all. */
  readDeadlineMs?: number;
  /** Waiting between retries; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SandboxApi {
  readonly #transport: Transport;
  readonly #requestTimeoutMs: number;
  readonly #readDeadlineMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Every POST that created or may have created something, so a test or the evidence can count them. */
  readonly posts: string[] = [];

  constructor(transport: Transport, options: SandboxApiOptions = {}) {
    this.#transport = transport;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#readDeadlineMs = options.readDeadlineMs ?? 120_000;
    this.#sleep = options.sleep ?? sleepFor;
  }

  /** Permissions, the account's effective limits and when the token expires (read-only). */
  async whoami(): Promise<unknown> {
    return this.#json(await this.#read("Checking the account", { method: "GET", path: "/v1/whoami" }));
  }

  /** The public images (read-only). */
  async images(): Promise<unknown> {
    return this.#json(await this.#read("Listing public images", { method: "GET", path: "/v1/images" }));
  }

  /** Uploads one file's bytes; returns its id. Not retried: a repeat upload of the same bytes is only a duplicate. */
  async upload(bytes: Uint8Array): Promise<{ uuid: string; sha256: string | null }> {
    this.posts.push("upload");
    const response = await this.#send("Uploading a file", { method: "POST", path: "/v1/files", headers: { "content-type": "application/octet-stream" }, body: bytes });
    if (response.status < 200 || response.status > 299) throw this.#httpError("Uploading a file", response);
    const parsed = Uploaded.parse(this.#json(response));
    return { uuid: parsed.uuid, sha256: parsed.sha256 ?? null };
  }

  /**
   * Starts an operation. Never retried. A lost answer, or a server error, may still have created it: `uncertain`, for
   * the caller to reconcile by its correlation id. A client error (4xx) created nothing and is thrown.
   */
  async spawn(body: SpawnBody, options: { discardAnswer?: boolean } = {}): Promise<SpawnAnswer> {
    this.posts.push("spawn");
    let response: TransportResponse;
    try {
      response = await this.#send("Starting an operation", { method: "POST", path: "/v1/instances", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      return { status: "uncertain", cause: error instanceof Error ? error.message : "the request failed" };
    }
    if (response.status >= 500) return { status: "uncertain", cause: `the service answered HTTP ${response.status}` };
    if (response.status < 200 || response.status > 299) throw this.#httpError("Starting an operation", response);
    // The probe's lost-answer case throws the answer away on purpose, as a dropped connection would.
    if (options.discardAnswer) return { status: "uncertain", cause: "the answer was discarded on purpose" };
    return { status: "created", id: Created.parse(this.#json(response)).uuid };
  }

  async operation(id: string, options: { inflight?: boolean } = {}): Promise<Operation> {
    const response = await this.#read("Reading an operation", { method: "GET", path: `/v1/operations/${encodeURIComponent(id)}`, ...(options.inflight ? { query: { inflight: "1" } } : {}) });
    return Operation.parse(this.#json(response));
  }

  /** One page of operations, as the service orders them. */
  async list(query: { kind?: string; since?: string; limit: number; offset: number }): Promise<Operation[]> {
    const params: Record<string, string> = { limit: String(query.limit), offset: String(query.offset) };
    if (query.kind) params["kind"] = query.kind;
    if (query.since) params["since"] = query.since;
    const response = await this.#read("Listing operations", { method: "GET", path: "/v1/operations", query: params });
    const body = this.#json(response);
    const items = Array.isArray(body) ? body : [];
    return items.flatMap((item) => {
      const parsed = Operation.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Asks for an operation to stop: `accepted` is not stopped yet. `conflict` means it had already ended. */
  async cancel(id: string): Promise<"accepted" | "conflict"> {
    const response = await this.#send("Cancelling an operation", { method: "DELETE", path: `/v1/operations/${encodeURIComponent(id)}` });
    if (response.status === 202 || response.status === 200 || response.status === 204) return "accepted";
    if (response.status === 409) return "conflict";
    throw this.#httpError("Cancelling an operation", response);
  }

  /**
   * Starts a subprocess inside a running operation. A 504 may have started it: `uncertain`, for the caller to settle
   * from the operation's events. Never retried.
   */
  async spawnSubprocess(operationId: string, body: Pick<SpawnBody, "command" | "args" | "shell" | "env"> & { cwd?: string }): Promise<{ status: "created"; spid: number } | { status: "uncertain"; cause: string }> {
    this.posts.push("subprocess");
    let response: TransportResponse;
    try {
      response = await this.#send("Starting a subprocess", { method: "POST", path: `/v1/operations/${encodeURIComponent(operationId)}/subprocesses`, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      return { status: "uncertain", cause: error instanceof Error ? error.message : "the request failed" };
    }
    if (response.status === 504 || response.status >= 500) return { status: "uncertain", cause: `the service answered HTTP ${response.status}` };
    if (response.status < 200 || response.status > 299) throw this.#httpError("Starting a subprocess", response);
    return { status: "created", spid: Subprocess.parse(this.#json(response)).spid };
  }

  /**
   * A subprocess's result, reconstructed by the service from the operation's events. While the child is still running
   * the service answers 425 with when to ask again: that is `pending`, never a failure, for the caller to poll within
   * its own deadline.
   */
  async subprocess(operationId: string, spid: number): Promise<{ status: "ready"; result: unknown } | { status: "pending"; retryAfterMs: number | null }> {
    const response = await this.#read("Reading a subprocess", { method: "GET", path: `/v1/operations/${encodeURIComponent(operationId)}/subprocesses/${spid}` }, [425]);
    if (response.status === 425) return { status: "pending", retryAfterMs: retryAfterMs(response) };
    return { status: "ready", result: this.#json(response) };
  }

  async killSubprocess(operationId: string, spid: number, signal = "SIGKILL"): Promise<void> {
    const response = await this.#send("Stopping a subprocess", { method: "DELETE", path: `/v1/operations/${encodeURIComponent(operationId)}/subprocesses/${spid}`, query: { signal } });
    if (response.status >= 300 && response.status !== 404 && response.status !== 409) throw this.#httpError("Stopping a subprocess", response);
  }

  /** The operation's event log so far, as text (server-sent events), without following it. */
  async events(operationId: string): Promise<string> {
    return decode((await this.#read("Reading an operation's events", { method: "GET", path: `/v1/operations/${encodeURIComponent(operationId)}/events`, query: { follow: "0" } })).body);
  }

  /** A file from a stored image, refused past `maxBytes`. */
  async download(image: string, path: string, maxBytes: number): Promise<Uint8Array> {
    const response = await this.#read("Downloading a file", { method: "GET", path: `/v1/inspect/${encodeURIComponent(image)}/download`, query: { path } });
    if (response.body.byteLength > maxBytes) throw new Error(`The file ${path} is ${response.body.byteLength} bytes, over the ${maxBytes} Nivra takes.`);
    return response.body;
  }

  /**
   * A read, retried after a 429 or a server error, or a lost answer, within the read deadline. A status in `answers` is
   * an answer the endpoint documents, handed back as it is.
   */
  async #read(what: string, request: Omit<TransportRequest, "timeoutMs">, answers: readonly number[] = []): Promise<TransportResponse> {
    const deadline = performance.now() + this.#readDeadlineMs;
    for (let attempt = 0; ; attempt++) {
      let response: TransportResponse | null = null;
      let lost: unknown = null;
      try {
        response = await this.#send(what, request);
      } catch (error) {
        lost = error;
      }
      if (response && ((response.status >= 200 && response.status <= 299) || answers.includes(response.status))) return response;
      const retryable = !response || response.status === 429 || response.status >= 500;
      const wait = response ? retryAfterMs(response) ?? 1_000 * 2 ** Math.min(attempt, 4) : 1_000 * 2 ** Math.min(attempt, 4);
      if (!retryable || performance.now() + wait > deadline) {
        if (response) throw this.#httpError(what, response);
        throw lost instanceof SandboxNetworkError ? lost : new SandboxNetworkError(what, lost);
      }
      await this.#sleep(wait);
    }
  }

  async #send(what: string, request: Omit<TransportRequest, "timeoutMs">): Promise<TransportResponse> {
    try {
      return await this.#transport({ ...request, timeoutMs: this.#requestTimeoutMs });
    } catch (error) {
      throw new SandboxNetworkError(what, error);
    }
  }

  #json(response: TransportResponse): unknown {
    const text = decode(response.body);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error("The service answered with something that isn't JSON.");
    }
  }

  #httpError(what: string, response: TransportResponse): SandboxHttpError {
    const after = retryAfterMs(response);
    return new SandboxHttpError(what, response.status, after === null ? null : Math.ceil(after / 1000));
  }
}

function retryAfterMs(response: TransportResponse): number | null {
  const header = response.headers["retry-after"];
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
