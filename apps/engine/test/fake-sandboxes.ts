import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { SandboxApi, type SandboxApiOptions, type Transport, type TransportRequest, type TransportResponse } from "../src/exec/nebius/api.ts";
import { Journal, Sandbox } from "../src/exec/nebius/sandbox.ts";

/**
 * A fake Nebius Sandboxes service and the helpers the sandbox tests share (NIV-29, NIV-41). It behaves as the
 * documentation of 20 October 2026 describes and as the live runs showed; nothing here reaches the network.
 */

export interface Behaviour {
  /** Statuses the operation reports on successive reads, the last repeated. */
  statuses: string[];
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  resultImage?: string | null;
  /** Files a successful operation leaves in its result image. */
  files?: Record<string, string>;
  /** Stays executing until something else ends it (a cancel, a subprocess). */
  waits?: boolean;
}

export interface FakeOperation {
  uuid: string;
  body: Record<string, unknown>;
  env: Record<string, string>;
  behaviour: Behaviour;
  reads: number;
  status: string;
  cancelled: boolean;
  finishedBySubprocess: boolean;
  subprocesses: Map<number, { args: string[]; exitCode: number; stdout: string; stopped: boolean; pending: number; ends?: { state: Record<string, unknown>; stderr: string } }>;
  events: string[];
}

export const encode = (value: unknown, status = 200, headers: Record<string, string> = {}): TransportResponse => ({ status, headers, body: new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value)) });
export const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** What a working edit and test leave behind: the patch holding the edit, and the report holding the passing test. */
export const REPORT = "PASS: Hello, Nivra\n";
export const PATCH = '--- base/greet.sh\n+++ work/greet.sh\n-echo "Hello, world"\n+echo "Hello, Nivra"\n';
/** Room enough for any answer the fake gives, for tests that call its transport directly. */
export const ANY_SIZE = 1_000_000;

/** The service: operations as state machines, with faults a test can switch on. */
export class FakeService {
  readonly operations: FakeOperation[] = [];
  readonly images = new Map<string, Record<string, string>>();
  readonly requests: TransportRequest[] = [];
  spawns = 0;
  /** The next spawn creates its operation, then its answer is lost. */
  dropNextSpawnAnswer = false;
  /** The next spawn answers 5xx, creating the operation or not. */
  failNextSpawn: { create: boolean } | null = null;
  /** The next spawn is turned down (400), creating nothing. */
  refuseNextSpawn = false;
  /** How many reads of an operation answer 503 (with Retry-After: 4) before it is read again. */
  unavailableReads = 0;
  /** How many times each new subprocess answers "not ready yet" (425) before its result, and the wait it asks for. */
  subprocessPending = 0;
  subprocessRetryAfter = 3;
  /** The next read answers 429 with this Retry-After. */
  rateLimitNextRead: number | null = null;
  /** Operations whose list entries are hidden (as if beyond the search window). */
  hidden = new Set<string>();
  /** The next subprocess spawn answers 504, having started it or not. */
  timeoutNextSubprocess: { started: boolean } | null = null;
  /** Subprocesses whose command matches end this way instead, with this output. */
  endSubprocess: { match: RegExp; state: Record<string, unknown>; stdout: string; stderr: string } | null = null;
  /** Reading a subprocess of a cancelled operation answers this status instead of the child's end. */
  childReadAfterCancel: number | null = null;
  lowercase = false;
  readonly behave: (body: Record<string, unknown>) => Behaviour;
  constructor(behave: (body: Record<string, unknown>) => Behaviour) {
    this.behave = behave;
  }

  readonly transport: Transport = async (request) => {
    this.requests.push(request);
    const path = request.path;
    if (request.method === "GET" && this.rateLimitNextRead !== null) {
      const seconds = this.rateLimitNextRead;
      this.rateLimitNextRead = null;
      return encode({ error: "slow down" }, 429, { "retry-after": String(seconds) });
    }
    if (request.method === "POST" && path === "/v1/files") return encode({ uuid: randomUUID(), sha256: "x", size: 1 }, 201);
    if (request.method === "POST" && path === "/v1/instances") return this.#spawn(JSON.parse(String(request.body)) as Record<string, unknown>);
    const subprocess = /^\/v1\/operations\/([^/]+)\/subprocesses(?:\/(\d+))?$/.exec(path);
    if (subprocess) return this.#subprocess(request, subprocess[1]!, subprocess[2] ? Number(subprocess[2]) : null);
    const events = /^\/v1\/operations\/([^/]+)\/events$/.exec(path);
    if (events) return { status: 200, headers: {}, body: new TextEncoder().encode(this.#find(events[1]!)?.events.join("\n") ?? "") };
    const one = /^\/v1\/operations\/([^/]+)$/.exec(path);
    if (one && request.method === "GET" && this.unavailableReads > 0) {
      this.unavailableReads--;
      return encode({ error: "unavailable" }, 503, { "retry-after": "4" });
    }
    if (one && request.method === "GET") return this.#read(one[1]!);
    if (one && request.method === "DELETE") return this.#cancel(one[1]!);
    if (request.method === "GET" && path === "/v1/operations") {
      const limit = Number(request.query?.["limit"] ?? 100);
      const offset = Number(request.query?.["offset"] ?? 0);
      const listed = [...this.operations].reverse().filter((op) => !this.hidden.has(op.uuid));
      return encode(listed.slice(offset, offset + limit).map((op) => ({ uuid: op.uuid, kind: "instance", status: op.status })));
    }
    const download = /^\/v1\/inspect\/([^/]+)\/download$/.exec(path);
    if (download) {
      const content = this.images.get(download[1]!)?.[request.query?.["path"] ?? ""];
      return content === undefined ? encode({ error: "no such file" }, 404) : { status: 200, headers: {}, body: new TextEncoder().encode(content) };
    }
    return encode({ error: "unknown" }, 404);
  };

  #find(uuid: string): FakeOperation | undefined {
    return this.operations.find((op) => op.uuid === uuid);
  }

  #spawn(body: Record<string, unknown>): TransportResponse {
    this.spawns++;
    if (this.refuseNextSpawn) {
      this.refuseNextSpawn = false;
      return encode({ error: "bad request" }, 400);
    }
    const fail = this.failNextSpawn;
    this.failNextSpawn = null;
    if (fail && !fail.create) return encode({ error: "unavailable" }, 503);
    const behaviour = this.behave(body);
    const op: FakeOperation = { uuid: randomUUID(), body, env: (body["env"] as Record<string, string>) ?? {}, behaviour, reads: 0, status: "PENDING", cancelled: false, finishedBySubprocess: false, subprocesses: new Map(), events: [] };
    this.operations.push(op);
    if (fail) return encode({ error: "unavailable" }, 503);
    if (this.dropNextSpawnAnswer) {
      this.dropNextSpawnAnswer = false;
      throw new Error("the connection dropped");
    }
    return encode({ uuid: op.uuid, ...body }, 201);
  }

  #status(op: FakeOperation): string {
    if (op.cancelled) return "CANCELLED";
    if (op.behaviour.waits && !op.finishedBySubprocess) return op.reads > 0 ? "EXECUTING" : "PENDING";
    return op.behaviour.statuses[Math.min(op.reads, op.behaviour.statuses.length - 1)]!;
  }

  #read(uuid: string): TransportResponse {
    const op = this.#find(uuid);
    if (!op) return encode({ error: "no such operation" }, 404);
    op.status = this.#status(op);
    op.reads++;
    const ended = ["SUCCESS", "FAILED", "CANCELLED"].includes(op.status);
    const succeeded = op.status === "SUCCESS";
    const image = succeeded && op.behaviour.resultImage !== null && op.body["disposable"] === false ? (op.behaviour.resultImage ?? `img-${op.uuid.slice(0, 8)}`) : null;
    if (image && op.behaviour.files) this.images.set(image, op.behaviour.files);
    return encode({
      uuid: op.uuid,
      kind: "instance",
      status: this.lowercase ? op.status.toLowerCase() : op.status,
      duration: ended ? 1.5 : null,
      consumed_cpu: ended ? 0.4 : null,
      result_image_uuid: image,
      metadata: {
        env: op.env,
        // As the live service reports it: signal -1 when none ended the command; exit code -1 and SIGKILL on a timeout.
        result: ended && !op.cancelled ? { state: { exit_code: op.behaviour.timedOut ? -1 : (op.behaviour.exitCode ?? 0), signal: op.behaviour.timedOut ? 9 : -1, timed_out: op.behaviour.timedOut ?? false }, stdout: { value: op.behaviour.stdout ?? "", encoding: "ascii" }, stderr: { value: "" } } : null,
      },
    });
  }

  #cancel(uuid: string): TransportResponse {
    const op = this.#find(uuid);
    if (!op) return encode({ error: "no such operation" }, 404);
    if (["SUCCESS", "FAILED", "CANCELLED"].includes(this.#status(op))) return encode({ error: "already finished" }, 409);
    op.cancelled = true;
    for (const sub of op.subprocesses.values()) sub.stopped = true;
    return encode(undefined, 202);
  }

  #subprocess(request: TransportRequest, uuid: string, spid: number | null): TransportResponse {
    const op = this.#find(uuid);
    if (!op) return encode({ error: "no such operation" }, 404);
    if (request.method === "POST") {
      const body = JSON.parse(String(request.body)) as { command: string; args: string[]; env: Record<string, string> };
      const timeout = this.timeoutNextSubprocess;
      this.timeoutNextSubprocess = null;
      if (timeout && !timeout.started) return encode({ error: "gateway timeout" }, 504);
      const next = op.subprocesses.size + 2;
      const args = [body.command, ...body.args].join(" ");
      const exitCode = /test\.sh Hello, world$/.test(args) ? 1 : 0;
      const custom = this.endSubprocess?.match.test(args) ? this.endSubprocess : null;
      const stdout = custom ? custom.stdout : /cat \/work\/greet\.sh/.test(args) ? 'echo "Hello, Nivra"\n' : /sha256sum/.test(args) ? `${sha(REPORT)}  /out/report.txt\n${sha(PATCH)}  /out/patch.diff\n` : /wget/.test(args) ? "BLOCKED http://example.test: bad address\n" : "";
      op.subprocesses.set(next, { args: [body.command, ...body.args], exitCode, stdout, stopped: false, pending: this.subprocessPending, ...(custom ? { ends: { state: custom.state, stderr: custom.stderr } } : {}) });
      op.events.push(`data: ${JSON.stringify({ type: "spawn", spid: next, env: body.env })}`);
      if (/touch \/tmp\/nivra-done/.test(args)) op.finishedBySubprocess = true;
      if (timeout?.started) return encode({ error: "gateway timeout" }, 504);
      return encode({ spid: next }, 201);
    }
    const sub = op.subprocesses.get(spid ?? -1);
    if (!sub) return encode({ error: "no such subprocess" }, 404);
    // As documented: a signalled child reports exit code -1 and its signal; one still running is "not ready yet".
    if (sub.stopped && op.cancelled && this.childReadAfterCancel !== null) return encode({ error: "the operation isn't running" }, this.childReadAfterCancel);
    if (sub.stopped) return encode({ state: { exit_code: -1, signal: 9 } });
    if (/sleep 60/.test(sub.args.join(" ")) || sub.pending-- > 0) return encode({ error: "not ready" }, 425, { "retry-after": String(this.subprocessRetryAfter) });
    if (sub.ends) return encode({ state: sub.ends.state, stdout: { value: sub.stdout }, stderr: { value: sub.ends.stderr } });
    return encode({ state: { exit_code: sub.exitCode }, stdout: { value: sub.stdout } });
  }
}

/** A clock the tests move: sleeping advances it, so deadlines are reached without waiting. */
export function clock() {
  let now = 0;
  const waits: number[] = [];
  return { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)), waits };
}

export function sandboxOn(
  service: FakeService,
  options: {
    journal?: Journal;
    search?: { sinceMarginMs: number; pageSize: number; maxPages: number; maxCandidates: number; withinMs?: number };
    time?: ReturnType<typeof clock>;
    transport?: Transport;
    api?: SandboxApiOptions;
    cap?: () => number;
    signal?: AbortSignal;
  } = {},
) {
  const time = options.time ?? clock();
  const signal = options.signal ? { signal: options.signal } : {};
  const api = new SandboxApi(options.transport ?? service.transport, { sleep: time.sleep, now: time.now, readDeadlineMs: 60_000, ...options.api, ...signal });
  const journal = options.journal ?? new Journal();
  const sandbox = new Sandbox(api, { journal, sleep: time.sleep, now: time.now, pollMs: 1_000, ...(options.search ? { search: options.search } : {}), ...(options.cap ? { cap: options.cap } : {}), ...signal });
  return { sandbox, api, journal, time };
}

/**
 * A transport that holds the requests `hold` picks until their signal aborts, as a connection still waiting would; the
 * rest go straight to the service. With `answerFirst`, the service acts on a held request before its answer is held.
 */
export function holding(service: FakeService, hold: (request: TransportRequest) => boolean, options: { answerFirst?: boolean } = {}) {
  const seen: TransportRequest[] = [];
  const held: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    seen.push(request);
    if (!hold(request)) return service.transport(request);
    if (options.answerFirst) await service.transport(request);
    held.push(request);
    return new Promise<TransportResponse>((_resolve, reject) => {
      const stop = () => reject(new DOMException("This operation was aborted", "AbortError"));
      if (request.signal?.aborted) stop();
      else request.signal?.addEventListener("abort", stop, { once: true });
    });
  };
  return { transport, seen, held };
}

/** Lets pending work run until `check` holds; the fake clock means nothing here waits in real time. */
export async function settles(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1_000 && !check(); turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), "the work under test never reached the point it was waited for");
}

export const succeed = (extra: Partial<Behaviour> = {}): Behaviour => ({ statuses: ["PENDING", "EXECUTING", "SUCCESS"], exitCode: 0, ...extra });
export const step = (label: string, extra: Partial<Parameters<Sandbox["submit"]>[0]> = {}) => ({ label, command: "/bin/sh", args: ["-c", "true"], image: "base", disposable: true, timeoutSeconds: 30, ...extra });
export const spawned = (service: FakeService) => service.requests.filter((r) => r.method === "POST" && r.path === "/v1/instances").map((r) => JSON.parse(String(r.body)) as { networking: { enabled: boolean }; disposable: unknown; env: Record<string, string> });
