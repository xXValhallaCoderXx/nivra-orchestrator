import { z } from "zod";

/**
 * A REST client for Nebius Token Factory Sandboxes (NIV-29, NIV-41), over `fetch`, with the transport injectable so
 * tests run against a fake service. No SDK (the only one is Python) and no dependency.
 *
 * Responses are read leniently, since the API is in beta: fields Nivra needs are checked, the rest pass through.
 * Statuses are compared ignoring case.
 *
 * Every request has a deadline, the caller's `until`, on the client's monotonic clock, POST and DELETE as much as GET
 * (D33). A request's timeout is the smaller of its own limit and the whole milliseconds left. With less than that left
 * (a write needs `minWriteMs`), or once the client's signal has aborted, it isn't sent, and `SandboxNotSentError` says
 * so: that is the only case in which "not sent" is established. Once a request is handed to the transport, anything
 * can have reached the service. An answer that comes after its deadline, or after the work was cancelled, is never
 * taken as a result. Answers are bounded as they arrive, never read in full first.
 *
 * Reads are retried within their deadline, honouring `Retry-After`: their own budget, or the caller's `until` when that
 * comes first. No retry waits past it. A spawn is never retried: once it may have reached the service, a lost, late or
 * unreadable answer, or a server error, leaves it `uncertain`, for the caller to reconcile by its correlation id. A
 * client given a signal stops when it is aborted: the request under way and the reading of its answer are cut off, a
 * retry's wait ends, and nothing more is sent. No message ever carries a response body or a credential.
 */

export const SANDBOXES_BASE_URL = "https://api.tokenfactory.nebius.com/sandboxes";

export interface TransportRequest {
  method: "GET" | "POST" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs: number;
  /** The longest answer taken, in decoded bytes; a longer one is refused as it arrives. */
  maxBytes: number;
  /** Stops the request, and the reading of its answer, when aborted. */
  signal?: AbortSignal;
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
    // Whole milliseconds, as AbortSignal.timeout takes, rounded down so the deadline holds: with none left, nothing goes.
    const timeoutMs = Math.floor(request.timeoutMs);
    if (!(timeoutMs >= 1)) throw new SandboxNotSentError("The request", "no-time");
    const url = new URL(`${base}${request.path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: request.method,
      headers: { Authorization: `Bearer ${credentials.key}`, Project: credentials.project, ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
      // The same signal cuts off reading the answer below.
      signal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
    return { status: response.status, headers, body: await readBounded(response, request.maxBytes) };
  };
}

/**
 * An answer's body, decoded, refused once it passes `maxBytes`: a declared length over the cap is refused before
 * reading, and a body that keeps coming is cut off as soon as it passes it. A compressed answer's declared length
 * says nothing about its decoded size, so only the count read decides then.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (!response.headers.has("content-encoding") && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SandboxTooLargeError("The answer", maxBytes);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SandboxTooLargeError("The answer", maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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

/** A read given up because its deadline came first, saying how its last attempt went. */
export class SandboxDeadlineError extends SandboxNetworkError {
  constructor(what: string, last: Error | null) {
    super(what, last);
    this.message = `${what} got no answer before its deadline${last ? ` (its last attempt: ${last.message.replace(/\.$/, "")})` : ""}.`;
    this.name = "SandboxDeadlineError";
  }
}

/** An answer that came after its deadline: whatever it says isn't used, though the request may have taken effect. */
export class SandboxLateAnswerError extends SandboxNetworkError {
  constructor(what: string) {
    super(what, null);
    this.message = `${what} was answered only after its deadline, so the answer isn't used.`;
    this.name = "SandboxLateAnswerError";
  }
}

/** The work the request belonged to was cancelled while the request was under way, or before a retry. */
export class SandboxCancelledError extends Error {
  constructor(what: string) {
    super(`${what} was cancelled.`);
    this.name = "SandboxCancelledError";
  }
}

/**
 * Nothing was sent: the work had been cancelled, or too little time was left, before the request was handed to the
 * transport. The one failure after which "not sent" is established, so nothing needs looking for.
 */
export class SandboxNotSentError extends Error {
  readonly reason: "cancelled" | "no-time";
  constructor(what: string, reason: "cancelled" | "no-time") {
    super(`${what} wasn't sent: ${reason === "cancelled" ? "the work had been cancelled" : "too little time was left"}.`);
    this.name = "SandboxNotSentError";
    this.reason = reason;
  }
}

/** An answer longer than Nivra takes, refused as it arrived. Asking again would only bring the same answer. */
export class SandboxTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(what: string, maxBytes: number) {
    super(`${what} was longer than the ${maxBytes} bytes Nivra takes.`);
    this.name = "SandboxTooLargeError";
    this.maxBytes = maxBytes;
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

/**
 * What a spawn's answer establishes. `created` with `late` means the operation exists, but its answer came after the
 * deadline or the cancellation: it is recorded so that cleanup can stop it, and never used as a result.
 */
export type SpawnAnswer = { status: "created"; id: string; late?: true } | { status: "uncertain"; cause: string };

export interface SandboxApiOptions {
  /** Each request's own limit, before any deadline. */
  requestTimeoutMs?: number;
  /** How long reads may keep retrying, in all. */
  readDeadlineMs?: number;
  /** The least time a POST or DELETE needs left to be sent at all: below it, starting one would only lose its answer. */
  minWriteMs?: number;
  /** The slowest upload rate an upload is given time for, on top of its request's own limit. */
  uploadBytesPerSecond?: number;
  /** The longest answer taken, decoded, for anything but a download (which has its own cap). */
  maxAnswerBytes?: number;
  /** Waiting between retries, ended early by the signal; tests replace it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The monotonic clock every deadline is measured on, in ms; tests share theirs with `sleep`. */
  now?: () => number;
  /** Cancels the client's work: the request under way is cut off, and nothing more is sent. */
  signal?: AbortSignal;
}

/** The latest a request may still be going, on the client's monotonic clock. Every call has one. */
export interface Until {
  until: number;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A retry never comes sooner than this, whatever `Retry-After` says. */
const MIN_RETRY_WAIT_MS = 250;

/** Waits `ms`, or less when the signal aborts first; the caller checks the signal afterwards. */
export const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** One request as sent: its answer, and whether that answer came too late to be used. */
interface Sent {
  response: TransportResponse;
  late: boolean;
}

export class SandboxApi {
  readonly #transport: Transport;
  readonly #requestTimeoutMs: number;
  readonly #readDeadlineMs: number;
  readonly #uploadBytesPerSecond: number;
  readonly #maxAnswerBytes: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #signal: AbortSignal | null;
  /** The least time a POST or DELETE needs left; callers check it before journaling what they are about to send. */
  readonly minWriteMs: number;
  /** Every POST handed to the transport that created or may have created something, so a test or the evidence can count them. */
  readonly posts: string[] = [];

  constructor(transport: Transport, options: SandboxApiOptions = {}) {
    this.#transport = transport;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#readDeadlineMs = options.readDeadlineMs ?? 120_000;
    this.#uploadBytesPerSecond = options.uploadBytesPerSecond ?? 256 * 1024;
    this.#maxAnswerBytes = options.maxAnswerBytes ?? 4 * 1024 * 1024;
    this.#sleep = options.sleep ?? sleepFor;
    this.#now = options.now ?? (() => performance.now());
    this.#signal = options.signal ?? null;
    this.minWriteMs = options.minWriteMs ?? 2_000;
  }

  /** Permissions, the account's effective limits and when the token expires (read-only). */
  async whoami(options: Until): Promise<unknown> {
    return this.#json(await this.#read("Checking the account", { method: "GET", path: "/v1/whoami" }, [], options.until));
  }

  /** The public images (read-only). */
  async images(options: Until): Promise<unknown> {
    return this.#json(await this.#read("Listing public images", { method: "GET", path: "/v1/images" }, [], options.until));
  }

  /**
   * Uploads one file's bytes; returns its id. Not retried: a repeat upload of the same bytes is only a duplicate. Its
   * limit grows with its size. An answer after the deadline isn't used, though the file may have been stored.
   */
  async upload(bytes: Uint8Array, options: Until): Promise<{ uuid: string; sha256: string | null }> {
    const what = "Uploading a file";
    const limit = this.#requestTimeoutMs + Math.ceil((bytes.byteLength / this.#uploadBytesPerSecond) * 1000);
    const { response, late } = await this.#send(what, { method: "POST", path: "/v1/files", headers: { "content-type": "application/octet-stream" }, body: bytes }, { until: options.until, limit, write: "upload" });
    if (late) throw this.#late(what);
    if (response.status < 200 || response.status > 299) throw this.#httpError(what, response);
    const parsed = Uploaded.parse(this.#json(response));
    return { uuid: parsed.uuid, sha256: parsed.sha256 ?? null };
  }

  /**
   * Starts an operation. Never retried. Refused before sending (`SandboxNotSentError`) when cancelled or out of time:
   * then nothing was created. Once sent, a lost, late or unreadable answer, a server error or a redirect may still have
   * created it: `uncertain`, for the caller to reconcile by its correlation id. A client error (4xx) created nothing and
   * is thrown.
   */
  async spawn(body: SpawnBody, options: Until & { discardAnswer?: boolean }): Promise<SpawnAnswer> {
    const what = "Starting an operation";
    let sent: Sent;
    try {
      sent = await this.#send(what, { method: "POST", path: "/v1/instances", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { until: options.until, limit: this.#requestTimeoutMs, write: "spawn" });
    } catch (error) {
      if (error instanceof SandboxNotSentError) throw error;
      return { status: "uncertain", cause: error instanceof Error ? error.message : "the request failed" };
    }
    const { response, late } = sent;
    // A server error, or a redirect (never followed), says nothing about whether the operation was made.
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) return { status: "uncertain", cause: `the service answered HTTP ${response.status}` };
    if (response.status < 200 || response.status > 299) throw this.#httpError(what, response);
    // The probe's lost-answer case throws the answer away on purpose, as a dropped connection would.
    if (options.discardAnswer) return { status: "uncertain", cause: "the answer was discarded on purpose" };
    const created = Created.safeParse(this.#jsonOrNull(response));
    if (!created.success) return { status: "uncertain", cause: "its answer couldn't be read" };
    return late ? { status: "created", id: created.data.uuid, late: true } : { status: "created", id: created.data.uuid };
  }

  async operation(id: string, options: { inflight?: boolean } & Until): Promise<Operation> {
    const response = await this.#read("Reading an operation", { method: "GET", path: `/v1/operations/${encodeURIComponent(id)}`, ...(options.inflight ? { query: { inflight: "1" } } : {}) }, [], options.until);
    return Operation.parse(this.#json(response));
  }

  /** One page of operations, as the service orders them. */
  async list(query: { kind?: string; since?: string; limit: number; offset: number }, options: Until): Promise<Operation[]> {
    const params: Record<string, string> = { limit: String(query.limit), offset: String(query.offset) };
    if (query.kind) params["kind"] = query.kind;
    if (query.since) params["since"] = query.since;
    const response = await this.#read("Listing operations", { method: "GET", path: "/v1/operations", query: params }, [], options.until);
    const body = this.#json(response);
    const items = Array.isArray(body) ? body : [];
    return items.flatMap((item) => {
      const parsed = Operation.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /**
   * Asks for an operation to stop: `accepted` is not stopped yet. `conflict` means it had already ended. An answer
   * after the deadline isn't used: whether the cancel took effect is then for a later read to say.
   */
  async cancel(id: string, options: Until): Promise<"accepted" | "conflict"> {
    const what = "Cancelling an operation";
    const { response, late } = await this.#send(what, { method: "DELETE", path: `/v1/operations/${encodeURIComponent(id)}` }, { until: options.until, limit: this.#requestTimeoutMs, write: "cancel" });
    if (late) throw this.#late(what);
    if (response.status === 202 || response.status === 200 || response.status === 204) return "accepted";
    if (response.status === 409) return "conflict";
    throw this.#httpError(what, response);
  }

  /**
   * Starts a subprocess inside a running operation. A 504, or any answer lost once sent, may have started it:
   * `uncertain`, for the caller to settle from the operation's events. Never retried.
   */
  async spawnSubprocess(operationId: string, body: Pick<SpawnBody, "command" | "args" | "shell" | "env"> & { cwd?: string }, options: Until): Promise<{ status: "created"; spid: number } | { status: "uncertain"; cause: string }> {
    const what = "Starting a subprocess";
    let sent: Sent;
    try {
      sent = await this.#send(what, { method: "POST", path: `/v1/operations/${encodeURIComponent(operationId)}/subprocesses`, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { until: options.until, limit: this.#requestTimeoutMs, write: "subprocess" });
    } catch (error) {
      if (error instanceof SandboxNotSentError) throw error;
      return { status: "uncertain", cause: error instanceof Error ? error.message : "the request failed" };
    }
    const { response, late } = sent;
    if (late) return { status: "uncertain", cause: "its answer came only after its deadline" };
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) return { status: "uncertain", cause: `the service answered HTTP ${response.status}` };
    if (response.status < 200 || response.status > 299) throw this.#httpError(what, response);
    const created = Subprocess.safeParse(this.#jsonOrNull(response));
    return created.success ? { status: "created", spid: created.data.spid } : { status: "uncertain", cause: "its answer couldn't be read" };
  }

  /**
   * A subprocess's result, reconstructed by the service from the operation's events. While the child is still running
   * the service answers 425 with when to ask again: that is `pending`, never a failure, for the caller to poll within
   * its own deadline.
   */
  async subprocess(operationId: string, spid: number, options: Until): Promise<{ status: "ready"; result: unknown } | { status: "pending"; retryAfterMs: number | null }> {
    const response = await this.#read("Reading a subprocess", { method: "GET", path: `/v1/operations/${encodeURIComponent(operationId)}/subprocesses/${spid}` }, [425], options.until);
    if (response.status === 425) return { status: "pending", retryAfterMs: retryAfterMs(response) };
    return { status: "ready", result: this.#json(response) };
  }

  async killSubprocess(operationId: string, spid: number, options: Until & { signal?: string }): Promise<void> {
    const what = "Stopping a subprocess";
    const { response, late } = await this.#send(what, { method: "DELETE", path: `/v1/operations/${encodeURIComponent(operationId)}/subprocesses/${spid}`, query: { signal: options.signal ?? "SIGKILL" } }, { until: options.until, limit: this.#requestTimeoutMs, write: "kill" });
    if (late) throw this.#late(what);
    if (response.status >= 300 && response.status !== 404 && response.status !== 409) throw this.#httpError(what, response);
  }

  /** The operation's event log so far, as text (server-sent events), without following it. */
  async events(operationId: string, options: Until): Promise<string> {
    return decode((await this.#read("Reading an operation's events", { method: "GET", path: `/v1/operations/${encodeURIComponent(operationId)}/events`, query: { follow: "0" } }, [], options.until)).body);
  }

  /** A file from a stored image, refused as it arrives once it passes `maxBytes`. */
  async download(image: string, path: string, maxBytes: number, options: Until): Promise<Uint8Array> {
    try {
      return (await this.#read("Downloading a file", { method: "GET", path: `/v1/inspect/${encodeURIComponent(image)}/download`, query: { path } }, [], options.until, maxBytes)).body;
    } catch (error) {
      if (error instanceof SandboxTooLargeError) throw new SandboxTooLargeError(`The file ${path}`, maxBytes);
      throw error;
    }
  }

  /**
   * A read, retried after a 429, a server error or a lost answer, until the earlier of its own budget and `until`. A
   * status in `answers` is an answer the endpoint documents, handed back as it is. No attempt starts once the deadline
   * has passed, each attempt's timeout is capped by the time left, an answer that comes after it is never taken, and a
   * retry that would have to wait past it is given up: a `SandboxDeadlineError`, which says how the last attempt went.
   * An answer over the cap isn't asked for again.
   */
  async #read(what: string, request: Omit<TransportRequest, "timeoutMs" | "maxBytes">, answers: readonly number[], until: number, maxBytes = this.#maxAnswerBytes): Promise<TransportResponse> {
    const deadline = Math.min(this.#now() + this.#readDeadlineMs, until);
    let last: Error | null = null;
    for (let attempt = 0; ; attempt++) {
      let sent: Sent | null = null;
      let lost: unknown = null;
      try {
        sent = await this.#send(what, request, { until: deadline, limit: this.#requestTimeoutMs, maxBytes });
      } catch (error) {
        if (error instanceof SandboxCancelledError || error instanceof SandboxTooLargeError) throw error;
        if (error instanceof SandboxNotSentError) throw error.reason === "cancelled" ? new SandboxCancelledError(what) : new SandboxDeadlineError(what, last);
        lost = error;
      }
      if (sent?.late) {
        if (this.#signal?.aborted) throw new SandboxCancelledError(what);
        throw new SandboxDeadlineError(what, last);
      }
      const response = sent?.response ?? null;
      if (response && ((response.status >= 200 && response.status <= 299) || answers.includes(response.status))) return response;
      if (response && response.status !== 429 && response.status < 500) throw this.#httpError(what, response);
      last = response ? this.#httpError(what, response) : lost instanceof Error ? lost : new SandboxNetworkError(what, lost);
      const wait = Math.max(MIN_RETRY_WAIT_MS, (response ? retryAfterMs(response) : null) ?? 1_000 * 2 ** Math.min(attempt, 4));
      if (this.#now() + wait >= deadline) throw new SandboxDeadlineError(what, last);
      await this.#sleep(wait, this.#signal ?? undefined);
      if (this.#signal?.aborted) throw new SandboxCancelledError(what);
    }
  }

  /**
   * One request, sent only with its deadline ahead and the work not cancelled; otherwise `SandboxNotSentError`, and
   * the transport is never entered. Its timeout is the smaller of `limit` and the whole milliseconds left, so it ends by
   * the deadline whatever its method. A write needs `minWriteMs` left. Once sent, the signal cuts it off, and an answer
   * that comes after the deadline or the cancellation is marked `late`, for the caller to discard.
   */
  async #send(what: string, request: Omit<TransportRequest, "timeoutMs" | "maxBytes">, bounds: { until: number; limit: number; maxBytes?: number; write?: string }): Promise<Sent> {
    if (this.#signal?.aborted) throw new SandboxNotSentError(what, "cancelled");
    const left = Math.floor(bounds.until - this.#now());
    if (left < Math.max(1, bounds.write ? this.minWriteMs : 1)) throw new SandboxNotSentError(what, "no-time");
    const maxBytes = bounds.maxBytes ?? this.#maxAnswerBytes;
    if (bounds.write === "upload" || bounds.write === "spawn" || bounds.write === "subprocess") this.posts.push(bounds.write);
    let response: TransportResponse;
    try {
      response = await this.#transport({ ...request, timeoutMs: Math.min(bounds.limit, left), maxBytes, ...(this.#signal ? { signal: this.#signal } : {}) });
    } catch (error) {
      if (error instanceof SandboxTooLargeError) throw new SandboxTooLargeError(what, maxBytes);
      throw this.#signal?.aborted ? new SandboxCancelledError(what) : new SandboxNetworkError(what, error);
    }
    // The transport's own cap, again, for one that read the whole answer anyway.
    if (response.body.byteLength > maxBytes) throw new SandboxTooLargeError(what, maxBytes);
    return { response, late: this.#signal?.aborted === true || this.#now() >= bounds.until };
  }

  #late(what: string): Error {
    return this.#signal?.aborted ? new SandboxCancelledError(what) : new SandboxLateAnswerError(what);
  }

  #json(response: TransportResponse): unknown {
    const text = decode(response.body);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error("The service answered with something that isn't JSON.");
    }
  }

  #jsonOrNull(response: TransportResponse): unknown {
    try {
      return this.#json(response);
    } catch {
      return null;
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
