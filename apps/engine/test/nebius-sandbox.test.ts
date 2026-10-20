import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { SandboxApi, SandboxDeadlineError, SandboxHttpError, SandboxNetworkError, type SandboxApiOptions, type Transport, type TransportRequest, type TransportResponse } from "../src/exec/nebius/api.ts";
import { CLEANUP_MAX_SECONDS, evaluate, probePlan, PROBE_LIMITS, runStageOne, stageZeroSummary, tokenOutlasts, type ProbeResults, type StepResult, type SubprocessResult } from "../src/exec/nebius/probe.ts";
import { classify, Journal, Sandbox, SandboxRefusal, type Outcome } from "../src/exec/nebius/sandbox.ts";

/**
 * Nebius Sandboxes, offline (NIV-29): the client and the lifecycle against a fake service that behaves as the
 * documentation of 20 October 2026 describes. Nothing here reaches the network.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Behaviour {
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

interface FakeOperation {
  uuid: string;
  body: Record<string, unknown>;
  env: Record<string, string>;
  behaviour: Behaviour;
  reads: number;
  status: string;
  cancelled: boolean;
  finishedBySubprocess: boolean;
  subprocesses: Map<number, { args: string[]; exitCode: number; stdout: string; stopped: boolean; pending: number }>;
  events: string[];
}

const encode = (value: unknown, status = 200, headers: Record<string, string> = {}): TransportResponse => ({ status, headers, body: new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value)) });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** What a working edit and test leave behind: the patch holding the edit, and the report holding the passing test. */
const REPORT = "PASS: Hello, Nivra\n";
const PATCH = '--- base/greet.sh\n+++ work/greet.sh\n-echo "Hello, world"\n+echo "Hello, Nivra"\n';

/** The service: operations as state machines, with faults a test can switch on. */
class FakeService {
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
        result: ended && !op.cancelled ? { state: { exit_code: op.behaviour.exitCode ?? 0, signal: null, timed_out: op.behaviour.timedOut ?? false }, stdout: { value: op.behaviour.stdout ?? "", encoding: "ascii" }, stderr: { value: "" } } : null,
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
      const stdout = /cat \/work\/greet\.sh/.test(args) ? 'echo "Hello, Nivra"\n' : /sha256sum/.test(args) ? `${sha(REPORT)}  /out/report.txt\n${sha(PATCH)}  /out/patch.diff\n` : /wget/.test(args) ? "BLOCKED http://example.test: bad address\n" : "";
      op.subprocesses.set(next, { args: [body.command, ...body.args], exitCode, stdout, stopped: false, pending: this.subprocessPending });
      op.events.push(`data: ${JSON.stringify({ type: "spawn", spid: next, env: body.env })}`);
      if (/touch \/tmp\/nivra-done/.test(args)) op.finishedBySubprocess = true;
      if (timeout?.started) return encode({ error: "gateway timeout" }, 504);
      return encode({ spid: next }, 201);
    }
    const sub = op.subprocesses.get(spid ?? -1);
    if (!sub) return encode({ error: "no such subprocess" }, 404);
    // As documented: a signalled child reports exit code -1 and its signal; one still running is "not ready yet".
    if (sub.stopped) return encode({ state: { exit_code: -1, signal: 9 } });
    if (/sleep 60/.test(sub.args.join(" ")) || sub.pending-- > 0) return encode({ error: "not ready" }, 425, { "retry-after": String(this.subprocessRetryAfter) });
    return encode({ state: { exit_code: sub.exitCode }, stdout: { value: sub.stdout } });
  }
}

/** A clock the tests move: sleeping advances it, so deadlines are reached without waiting. */
function clock() {
  let now = 0;
  const waits: number[] = [];
  return { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)), waits };
}

function sandboxOn(
  service: FakeService,
  options: { journal?: Journal; search?: { sinceMarginMs: number; pageSize: number; maxPages: number; maxCandidates: number; withinMs?: number }; time?: ReturnType<typeof clock>; transport?: Transport; api?: SandboxApiOptions; cap?: () => number } = {},
) {
  const time = options.time ?? clock();
  const api = new SandboxApi(options.transport ?? service.transport, { sleep: time.sleep, now: time.now, readDeadlineMs: 60_000, ...options.api });
  const journal = options.journal ?? new Journal();
  const sandbox = new Sandbox(api, { journal, sleep: time.sleep, now: time.now, pollMs: 1_000, ...(options.search ? { search: options.search } : {}), ...(options.cap ? { cap: options.cap } : {}) });
  return { sandbox, api, journal, time };
}

const succeed = (extra: Partial<Behaviour> = {}): Behaviour => ({ statuses: ["PENDING", "EXECUTING", "SUCCESS"], exitCode: 0, ...extra });
const step = (label: string, extra: Partial<Parameters<Sandbox["submit"]>[0]> = {}) => ({ label, command: "/bin/sh", args: ["-c", "true"], image: "base", disposable: true, timeoutSeconds: 30, ...extra });
const spawned = (service: FakeService) => service.requests.filter((r) => r.method === "POST" && r.path === "/v1/instances").map((r) => JSON.parse(String(r.body)) as { networking: { enabled: boolean }; disposable: unknown; env: Record<string, string> });

describe("Nebius Sandboxes, offline: the operation's status apart from its command (NIV-29)", () => {
  it("tells a command that failed, timed out or was signalled apart from SUCCESS, reads any case, and keeps no image from a failure", () => {
    const op = (status: string, state: Record<string, unknown> | null, image: string | null = "img") => ({ uuid: "u", status, result_image_uuid: image, metadata: { result: state ? { state } : null } });
    assert.deepEqual(
      [
        classify(op("SUCCESS", { exit_code: 0 })).verdict,
        classify(op("success", { exit_code: 1 })).verdict,
        classify(op("SUCCESS", { exit_code: null, timed_out: true })).verdict,
        classify(op("SUCCESS", { exit_code: 137, signal: 9 })).verdict,
        classify(op("FAILED", null)).verdict,
        classify(op("FAILED", { timed_out: true })).verdict,
        classify(op("CANCELLED", null)).verdict,
        classify(op("weird", null)).status,
      ],
      ["passed", "command-failed", "timed-out", "signalled", "operation-failed", "timed-out", "cancelled", "UNKNOWN"],
    );
    assert.deepEqual([classify(op("FAILED", { exit_code: 1 })).resultImage, classify(op("SUCCESS", { exit_code: 0 })).resultImage], [null, "img"]);
  });
});

describe("Nebius Sandboxes, offline: spawning, one at a time, networking off (NIV-29)", () => {
  it("states networking off and disposability on every spawn, with a correlation id, and starts one operation at a time", async () => {
    const service = new FakeService(() => succeed());
    const { sandbox } = sandboxOn(service);
    const first = await sandbox.submit(step("one"));
    await assert.rejects(sandbox.submit(step("two")), (error: Error) => error instanceof SandboxRefusal && /^One operation at a time/.test(error.message));
    await sandbox.observe((first as { operationId: string }).operationId, 30);
    await sandbox.submit(step("two"));
    assert.deepEqual(spawned(service).map((body) => [body.networking.enabled, body.disposable, typeof body.env["NIVRA_CORRELATION"]]), [[false, true, "string"], [false, true, "string"]]);
    await assert.rejects(sandbox.submit(step("long", { timeoutSeconds: 500 })), /timeout must be between 1 and 180 s/);
  });

  it("runs the one networking-on operation only as the approved control: the base image, no files, one fixed command", async () => {
    const service = new FakeService(() => succeed());
    const { sandbox } = sandboxOn(service);
    const url = "http://example.test/";
    const refusals: Array<[Parameters<Sandbox["networkControl"]>[0], RegExp]> = [
      [{ approvedUrl: null, url, image: "base", baseImage: "base" }, /only with --network-control/],
      [{ approvedUrl: "http://other.test/", url, image: "base", baseImage: "base" }, /only the URL you approved/],
      [{ approvedUrl: url, url, image: "img-A", baseImage: "base" }, /public base image only/],
      [{ approvedUrl: url, url, image: "base", baseImage: "base", files: { "/x": { uuid: "f" } } }, /no files and runs one fixed command/],
      [{ approvedUrl: url, url, image: "base", baseImage: "base", command: "/bin/sh" }, /no files and runs one fixed command/],
    ];
    for (const [input, pattern] of refusals) await assert.rejects(sandbox.networkControl(input), pattern);
    assert.equal(service.spawns, 0);
    await sandbox.networkControl({ approvedUrl: url, url, image: "base", baseImage: "base" });
    const [body] = spawned(service) as unknown as Array<{ networking: { enabled: boolean }; disposable: boolean; command: string; args: string[]; files?: unknown }>;
    assert.deepEqual([body?.networking.enabled, body?.disposable, body?.command, body?.args.at(-1), body?.files], [true, true, "/bin/busybox", url, undefined]);
  });
});

describe("Nebius Sandboxes, offline: lost answers, reconnects and cancels (NIV-29)", () => {
  it("finds a spawn whose answer was lost by its correlation id, adopts it, and never sends it again", async () => {
    const service = new FakeService(() => succeed());
    service.dropNextSpawnAnswer = true;
    const { sandbox } = sandboxOn(service);
    const submitted = await sandbox.submit(step("lost"));
    assert.ok("uncertain" in submitted);
    const found = await sandbox.reconcile(submitted.uncertain);
    assert.ok("operationId" in found);
    assert.equal((await sandbox.observe(found.operationId, 30)).verdict, "passed");
    assert.deepEqual([service.spawns, sandbox.journal.spawnsOf("lost")], [1, 1]);
  });

  it("treats a server error on a spawn as uncertain, never retries it, and leaves it unknown when it isn't found", async () => {
    const service = new FakeService(() => succeed());
    service.failNextSpawn = { create: false };
    const { sandbox } = sandboxOn(service);
    const submitted = await sandbox.submit(step("refused"));
    assert.ok("uncertain" in submitted);
    const found = await sandbox.reconcile(submitted.uncertain);
    assert.ok("unknown" in found && /no operation with its correlation id was found within 1 page\(s\) of 100, 0 operation\(s\) read/.test(found.unknown));
    assert.equal(service.spawns, 1);
    // Created, then a 5xx: found and adopted.
    const second = new FakeService(() => succeed());
    second.failNextSpawn = { create: true };
    const other = sandboxOn(second).sandbox;
    const again = await other.submit(step("created anyway"));
    assert.ok("uncertain" in again && "operationId" in (await other.reconcile(again.uncertain)));
    assert.equal(second.spawns, 1);
  });

  it("keeps the outcome unknown, never 'not started', when the operation lies beyond the search's bounds", async () => {
    const service = new FakeService(() => succeed());
    const { sandbox } = sandboxOn(service, { search: { sinceMarginMs: 86_400_000, pageSize: 2, maxPages: 2, maxCandidates: 50 } });
    service.dropNextSpawnAnswer = true;
    const submitted = await sandbox.submit(step("buried"));
    assert.ok("uncertain" in submitted);
    // Five newer operations push it past two pages of two.
    for (let i = 0; i < 5; i++) await service.transport({ method: "POST", path: "/v1/instances", body: JSON.stringify({ env: {} }), timeoutMs: 1 });
    const found = await sandbox.reconcile(submitted.uncertain);
    assert.ok("unknown" in found);
    assert.match(found.unknown, /2 page\(s\) of 2, 4 operation\(s\) read, since .*; the search stopped at its bounds$/);
  });

  it("reattaches a fresh client to the same operation from the journal, with one spawn", async () => {
    const service = new FakeService(() => ({ statuses: ["PENDING", "EXECUTING", "EXECUTING", "SUCCESS"], exitCode: 0, stdout: "done" }));
    const path = join(mkdtempSync(join(tmpdir(), "nivra probe ")), "journal.jsonl");
    const first = sandboxOn(service, { journal: new Journal(path) });
    const submitted = await first.sandbox.submit(step("reconnect"));
    // The first client goes away; a new one knows only the journal's file.
    const fresh = sandboxOn(service, { journal: new Journal(path) });
    const [operationId] = fresh.sandbox.journal.open().operations;
    assert.equal(operationId, (submitted as { operationId: string }).operationId);
    assert.equal((await fresh.sandbox.observe(operationId!, 30)).stdout, "done");
    assert.deepEqual([service.spawns, fresh.sandbox.journal.spawnsOf("reconnect"), first.sandbox.journal.open().operations], [1, 1, []]);
  });

  it("cancels to a terminal state, and reads a cancel of a finished operation as already ended", async () => {
    const service = new FakeService((body) => ((body["args"] as string[]).includes("60") ? { statuses: ["EXECUTING"], waits: true } : succeed()));
    const { sandbox } = sandboxOn(service);
    const running = (await sandbox.submit(step("cancel", { command: "/bin/sleep", args: ["60"], timeoutSeconds: 90 }))) as { operationId: string };
    assert.equal(await sandbox.waitFor(running.operationId, ["EXECUTING"], 30_000), "EXECUTING");
    const cancelled = await sandbox.cancel(running.operationId);
    assert.deepEqual([cancelled?.status, cancelled?.verdict, cancelled?.resultImage], ["CANCELLED", "cancelled", null]);
    const done = (await sandbox.submit(step("done"))) as { operationId: string };
    await sandbox.observe(done.operationId, 30);
    assert.equal((await sandbox.cancel(done.operationId))?.status, "SUCCESS");
  });

  it("stops observing at the operation's timeout plus the margin, and journals it as unresolved", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const { sandbox } = sandboxOn(service);
    const stuck = (await sandbox.submit(step("stuck", { timeoutSeconds: 5 }))) as { operationId: string };
    await assert.rejects(sandbox.observe(stuck.operationId, 5), /wasn't seen to end within 65 s/);
    assert.ok(sandbox.journal.entries.some((e) => e.kind === "unresolved" && e.operationId === stuck.operationId));
  });
});

describe("Nebius Sandboxes, offline: deadlines, retries and cleanup (NIV-29)", () => {
  it("honours Retry-After on a read, retries a lost read within its deadline, and gives up past it", async () => {
    const service = new FakeService(() => succeed());
    const { sandbox, api, time } = sandboxOn(service);
    const submitted = (await sandbox.submit(step("slow down"))) as { operationId: string };
    service.rateLimitNextRead = 7;
    await api.operation(submitted.operationId);
    assert.equal(time.waits[0], 7_000);
    let calls = 0;
    const hanging: Transport = async () => {
      calls++;
      throw new Error("timed out");
    };
    const waits: number[] = [];
    const impatient = new SandboxApi(hanging, { readDeadlineMs: 10_000, sleep: async (ms) => void waits.push(ms) });
    await assert.rejects(impatient.operation("x"), (error: Error) => error instanceof SandboxNetworkError && /got no answer/.test(error.message));
    assert.ok(calls >= 2, "a lost read is retried");
    const posts: TransportRequest[] = [];
    const failing = new SandboxApi(async (request) => (posts.push(request), encode({}, 500)), { sleep: async () => undefined });
    assert.equal((await failing.spawn({ command: "x", args: [], image: "i", shell: false, env: {}, disposable: true, networking: { enabled: false }, timeout: 5 })).status, "uncertain");
    assert.equal(posts.length, 1, "a spawn is never retried");
  });

  it("after a lost answer and an interruption, finds the operation first, then cancels it, so nothing is left running", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    service.dropNextSpawnAnswer = true;
    const { sandbox } = sandboxOn(service);
    const submitted = await sandbox.submit(step("interrupted"));
    assert.ok("uncertain" in submitted);
    const settled = await sandbox.cleanup();
    assert.deepEqual([settled.cancelled.length, settled.unresolved, service.operations[0]?.cancelled], [1, [], true]);
    assert.deepEqual(sandbox.journal.entries.map((e) => e.kind), ["intent", "uncertain", "found", "cancel", "terminal"]);
  });

  it("journals what it couldn't settle, and --recover settles it later from the journal", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    service.dropNextSpawnAnswer = true;
    const path = join(mkdtempSync(join(tmpdir(), "nivra probe ")), "journal.jsonl");
    const { sandbox } = sandboxOn(service, { journal: new Journal(path) });
    await sandbox.submit(step("hidden"));
    service.hidden.add(service.operations[0]!.uuid);
    const first = await sandbox.cleanup();
    assert.equal(first.unresolved.length, 1);
    service.hidden.clear();
    const recovered = await sandboxOn(service, { journal: new Journal(path) }).sandbox.cleanup();
    assert.deepEqual([recovered.cancelled.length, recovered.unresolved, service.operations[0]?.cancelled], [1, [], true]);
  });

  it("finds and stops an operation whose probe died after sending its spawn, before the answer: the intent alone is enough", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const path = join(mkdtempSync(join(tmpdir(), "nivra probe ")), "journal.jsonl");
    // The request reaches the service and creates the operation; the probe dies before its answer arrives.
    const dying: Transport = async (request) => {
      const response = await service.transport(request);
      return request.method === "POST" && request.path === "/v1/instances" ? new Promise<TransportResponse>(() => undefined) : response;
    };
    const time = clock();
    void new Sandbox(new SandboxApi(dying, { sleep: time.sleep }), { journal: new Journal(path), sleep: time.sleep, now: time.now }).submit(step("died"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([service.operations.length, new Journal(path).entries.map((e) => e.kind)], [1, ["intent"]]);
    const recovered = await sandboxOn(service, { journal: new Journal(path) }).sandbox.cleanup();
    assert.deepEqual([recovered.cancelled.length, recovered.unresolved, service.operations[0]?.cancelled], [1, [], true]);
    assert.deepEqual(new Journal(path).entries.map((e) => e.kind), ["intent", "found", "cancel", "terminal"]);
  });

  it("settles a spawn the service turned down, which created nothing, so the next one can go", async () => {
    const service = new FakeService(() => succeed());
    service.refuseNextSpawn = true;
    const { sandbox } = sandboxOn(service);
    await assert.rejects(sandbox.submit(step("refused")), (error: Error) => error instanceof SandboxHttpError && error.status === 400);
    assert.deepEqual([sandbox.journal.open(), sandbox.journal.entries.map((e) => e.kind)], [{ operations: [], uncertain: [] }, ["intent", "refused"]]);
    assert.ok("operationId" in (await sandbox.submit(step("next"))));
  });
});

describe("Nebius Sandboxes, offline: every wait ends at its deadline (NIV-29)", () => {
  it("starts no read at or after its deadline, caps each attempt's timeout by the time left, and says how the last one went", async () => {
    const service = new FakeService(() => succeed());
    const { sandbox, api, time } = sandboxOn(service);
    const submitted = (await sandbox.submit(step("busy"))) as { operationId: string };
    service.unavailableReads = 10;
    const before = service.requests.length;
    const start = time.now();
    await assert.rejects(
      api.operation(submitted.operationId, { until: start + 10_000 }),
      (error: Error) => error instanceof SandboxDeadlineError && /^Reading an operation got no answer before its deadline \(its last attempt: Reading an operation was answered with HTTP 503; try again in 4 s\)\.$/.test(error.message),
    );
    assert.deepEqual([service.requests.slice(before).map((r) => r.timeoutMs), time.now() - start], [[10_000, 6_000, 2_000], 8_000]);
  });

  it("cuts off a read whose connection hangs at the deadline, never after it", async () => {
    const time = clock();
    // Every request hangs until its own timeout, as a dead connection would.
    const hanging: Transport = async (request) => {
      await time.sleep(request.timeoutMs);
      throw new Error("timed out");
    };
    const api = new SandboxApi(hanging, { sleep: time.sleep, now: time.now });
    await assert.rejects(api.operation("op", { until: 5_000 }), SandboxDeadlineError);
    assert.equal(time.now(), 5_000);
  });

  it("ends observing, and a cancel's wait, at their deadline when reads hang, and journals the operation unresolved", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    let hang = false;
    const flaky: Transport = async (request) => {
      if (hang && request.method === "GET") {
        await time.sleep(request.timeoutMs);
        throw new Error("timed out");
      }
      return service.transport(request);
    };
    const { sandbox } = sandboxOn(service, { time, transport: flaky, api: { readDeadlineMs: 600_000 } });
    const running = (await sandbox.submit(step("stuck", { timeoutSeconds: 5 }))) as { operationId: string };
    hang = true;
    let start = time.now();
    await assert.rejects(sandbox.observe(running.operationId, 5), /wasn't seen to end within 65 s/);
    assert.equal(time.now() - start, 65_000);
    start = time.now();
    assert.equal(await sandbox.cancel(running.operationId), null);
    assert.equal(time.now() - start, 60_000);
    assert.equal(sandbox.journal.entries.filter((e) => e.kind === "unresolved").length, 2);
  });

  it("stops looking for a lost spawn at its time limit, and leaves it unknown", async () => {
    const service = new FakeService(() => succeed());
    service.dropNextSpawnAnswer = true;
    const time = clock();
    // Every listing takes 50 s; one given less time than that is cut off.
    const slow: Transport = async (request) => {
      if (request.method === "GET" && request.path === "/v1/operations") {
        await time.sleep(Math.min(request.timeoutMs, 50_000));
        if (request.timeoutMs < 50_000) throw new Error("timed out");
      }
      return service.transport(request);
    };
    const search = { sinceMarginMs: 86_400_000, pageSize: 1, maxPages: 10, maxCandidates: 50, withinMs: 120_000 };
    const { sandbox } = sandboxOn(service, { time, transport: slow, search, api: { readDeadlineMs: 600_000, requestTimeoutMs: 60_000 } });
    const submitted = await sandbox.submit(step("buried"));
    assert.ok("uncertain" in submitted);
    // Five newer operations come before it in the listing.
    for (let i = 0; i < 5; i++) await service.transport({ method: "POST", path: "/v1/instances", body: JSON.stringify({ env: {} }), timeoutMs: 1 });
    const start = time.now();
    const found = await sandbox.reconcile(submitted.uncertain);
    assert.ok("unknown" in found);
    assert.match(found.unknown, /within 2 page\(s\) of 1, 2 operation\(s\) read, since .*; the search stopped at its time limit$/);
    assert.equal(time.now() - start, 120_000);
  });

  it("stops a stage-1 step at the probe's cap and starts nothing after it, then cleanup without the cap settles the operation", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const path = join(mkdtempSync(join(tmpdir(), "nivra probe ")), "journal.jsonl");
    const capped = sandboxOn(service, { time, journal: new Journal(path), cap: () => 10_000 });
    const running = (await capped.sandbox.submit(step("long", { timeoutSeconds: 60 }))) as { operationId: string };
    await assert.rejects(capped.sandbox.observe(running.operationId, 60), /wasn't seen to end within 10 s/);
    assert.equal(time.now(), 10_000);
    const entries = new Journal(path).entries.length;
    await assert.rejects(capped.sandbox.submit(step("late")), /^SandboxRefusal: The probe's time ran out, so the late operation wasn't started\.$/);
    assert.deepEqual([new Journal(path).entries.length, service.spawns], [entries, 1]);
    const settled = await sandboxOn(service, { time, journal: new Journal(path) }).sandbox.cleanup();
    assert.deepEqual([settled.cancelled.length, settled.unresolved, service.operations[0]?.cancelled], [1, [], true]);
  });
});

describe("Nebius Sandboxes, offline: subprocesses and downloads (NIV-29)", () => {
  it("starts subprocesses in a live parent, settles a 504 from its events, and leaves one with no spawn event uncertain", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING", "SUCCESS"], waits: true, exitCode: 0 }));
    const { sandbox } = sandboxOn(service);
    const parent = (await sandbox.submit(step("parent", { disposable: false, timeoutSeconds: 180 }))) as { operationId: string };
    const first = await sandbox.subprocess(parent.operationId, { label: "failing", command: "/bin/sh", args: ["/work/test.sh", "Hello, world"] });
    assert.ok("spid" in first);
    assert.equal((await sandbox.subprocessResult(parent.operationId, first.spid, 10_000))?.exitCode, 1);
    service.timeoutNextSubprocess = { started: true };
    const settled = await sandbox.subprocess(parent.operationId, { label: "inspect", command: "/bin/sh", args: ["-c", "cat /work/greet.sh"] });
    assert.ok("spid" in settled, "a 504 whose spawn shows in the events is settled");
    service.timeoutNextSubprocess = { started: false };
    const lost = await sandbox.subprocess(parent.operationId, { label: "lost", command: "/bin/true", args: [] });
    assert.ok("uncertain" in lost && /may or may not have started/.test(lost.uncertain));
  });

  it("waits for a subprocess that isn't ready yet as long as the service says, within its deadline, and never past it", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING", "SUCCESS"], waits: true, exitCode: 0 }));
    service.subprocessPending = 2;
    const { sandbox, time } = sandboxOn(service);
    const parent = (await sandbox.submit(step("parent", { disposable: false, timeoutSeconds: 180 }))) as { operationId: string };
    const failing = await sandbox.subprocess(parent.operationId, { label: "failing", command: "/bin/sh", args: ["/work/test.sh", "Hello, world"] });
    assert.ok("spid" in failing);
    const before = time.waits.length;
    const result = await sandbox.subprocessResult(parent.operationId, failing.spid, 30_000);
    assert.deepEqual([result?.exitCode, time.waits.slice(before)], [1, [3_000, 3_000]]);
    // A child that keeps running is given up at the deadline, never waited on past it.
    const sleeper = await sandbox.subprocess(parent.operationId, { label: "sleeper", command: "/bin/sleep", args: ["60"] });
    assert.ok("spid" in sleeper);
    const start = time.now();
    assert.equal(await sandbox.subprocessResult(parent.operationId, sleeper.spid, 10_000), null);
    assert.equal(time.now() - start, 10_000);
    // Once its parent is cancelled, the child reports the signal that ended it.
    await sandbox.cancel(parent.operationId);
    assert.deepEqual(await sandbox.subprocessResult(parent.operationId, sleeper.spid, 10_000), { exitCode: -1, signal: 9, timedOut: false, stdout: "", stderr: "" });
  });

  it("makes no request and takes no answer once a subprocess's deadline is reached, however long the service says to wait", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING", "SUCCESS"], waits: true, exitCode: 0 }));
    const { sandbox, time } = sandboxOn(service);
    const parent = (await sandbox.submit(step("parent", { disposable: false, timeoutSeconds: 180 }))) as { operationId: string };
    // Not ready at first, with 10 s to wait; ready from the next read, which would come at the 5 s deadline.
    service.subprocessPending = 1;
    service.subprocessRetryAfter = 10;
    const spawned = await sandbox.subprocess(parent.operationId, { label: "passing", command: "/bin/sh", args: ["/work/test.sh", "Hello, Nivra"] });
    assert.ok("spid" in spawned);
    const reads = () => service.requests.filter((r) => r.method === "GET" && r.path.endsWith(`/subprocesses/${spawned.spid}`)).length;
    const start = time.now();
    assert.equal(await sandbox.subprocessResult(parent.operationId, spawned.spid, 5_000), null);
    assert.deepEqual([reads(), time.now() - start], [1, 5_000]);
  });

  it("refuses a download over its cap, or one that doesn't match the hash the operation printed", async () => {
    const service = new FakeService(() => succeed());
    service.images.set("img-D", { "/out/patch.diff": "--- base/greet.sh\n", "/out/report.txt": "x".repeat(100) });
    const { sandbox } = sandboxOn(service);
    assert.equal((await sandbox.download("img-D", "/out/patch.diff", 1_000, sha("--- base/greet.sh\n"))).sha256, sha("--- base/greet.sh\n"));
    await assert.rejects(sandbox.download("img-D", "/out/report.txt", 50, null), /is 100 bytes, over the 50 Nivra takes/);
    await assert.rejects(sandbox.download("img-D", "/out/patch.diff", 1_000, sha("something else")), /doesn't match the hash the operation printed/);
  });
});

/** The service as the probe meets it: each probe command gets the behaviour the documentation leads us to expect. */
function probeService(options: { controlWorks: boolean }) {
  return new FakeService((body) => {
    const args = [body["command"], ...((body["args"] as string[]) ?? [])].join(" ");
    if (/busybox wget/.test(args)) return options.controlWorks ? succeed() : succeed({ exitCode: 1 });
    if (/sed -i/.test(args) && /ls \/sys\/class\/net/.test(args)) return succeed({ stdout: "interfaces: lo ", resultImage: "img-A" });
    if (/CONTINUED/.test(args)) return succeed({ stdout: "CONTINUED\nBLOCKED http://example.test/: bad address\nBLOCKED http://93.184.215.14/: network is unreachable\n" });
    if (/test\.sh Hello, world/.test(args)) return succeed({ exitCode: 1, stdout: "FAIL: expected 'Hello, world', got 'Hello, Nivra'" });
    if (/sha256sum/.test(args)) return succeed({ stdout: `${sha(REPORT)}  /out/report.txt\n${sha(PATCH)}  /out/patch.diff\n`, resultImage: "img-D", files: { "/out/report.txt": REPORT, "/out/patch.diff": PATCH } });
    if (/sleep 30/.test(args)) return { statuses: ["EXECUTING", "SUCCESS"], exitCode: null, timedOut: true };
    if (/sleep 60/.test(args)) return { statuses: ["EXECUTING"], waits: true };
    if (/nivra-done/.test(args)) return { statuses: ["EXECUTING", "SUCCESS"], waits: true, exitCode: 0, resultImage: "img-P", files: { "/out/report.txt": REPORT, "/out/patch.diff": PATCH } };
    return succeed({ stdout: "done" });
  });
}

const FIXTURE = fileURLToPath(new URL("./fixtures/sandbox-probe/", import.meta.url));
const fixture = readdirSync(FIXTURE).sort().map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(FIXTURE, name))) }));

async function stageOne(service: FakeService, networkControl: string | null) {
  const journal = new Journal(join(mkdtempSync(join(tmpdir(), "nivra probe ")), "journal.jsonl"));
  const { sandbox, api, time } = sandboxOn(service, { journal });
  const results = await runStageOne({
    sandbox,
    api,
    reconnect: () => sandboxOn(service, { journal }).sandbox,
    baseImage: "base",
    fixture,
    deny: ["http://example.test/", "http://93.184.215.14/"],
    networkControl,
    now: time.now,
    deadline: Number.POSITIVE_INFINITY,
    log: () => undefined,
  });
  const settled = await sandbox.cleanup();
  return { results, settled, judged: evaluate(results), journal };
}

describe("Nebius Sandboxes, offline: the whole probe against the fake service (NIV-29)", () => {
  it("plans at most twelve operations, uploads only the fixture, and keeps networking off but for the control", () => {
    const plan = probePlan(fixture.map((file) => ({ name: file.name, bytes: file.bytes.byteLength })));
    assert.ok(plan.operations <= PROBE_LIMITS.maxOperations);
    assert.ok(fixture.reduce((n, f) => n + f.bytes.byteLength, 0) <= PROBE_LIMITS.maxUploadBytes);
    assert.deepEqual(plan.steps.filter((s) => s.network === "on (approved control)").map((s) => s.id), ["3"]);
    assert.ok(plan.steps.every((s) => s.timeoutSeconds === null || s.timeoutSeconds <= PROBE_LIMITS.maxParentTimeoutSeconds));
  });

  it("runs stage 1 one operation at a time, judges every threshold, and adopts when each holds", async () => {
    const service = probeService({ controlWorks: true });
    const { results, settled, judged } = await stageOne(service, "http://example.test/");
    assert.deepEqual(results.errors, []);
    const every = ["network", "continuation", "cancel", "exit", "patch", "reattach", "timeout"].map((id) => [id, "pass"]);
    assert.deepEqual(judged.patterns.map((p) => [p.pattern, p.verdicts.map((v) => [v.id, v.outcome]), p.outcome]), [["A", every, "adopt"], ["B", every, "adopt"]]);
    assert.deepEqual(judged.recorded.map((v) => [v.id, v.outcome]), [["lost-answer", "pass"]]);
    assert.deepEqual([judged.decision, results.parentCancel?.child], ["adopt", "ended"]);
    assert.deepEqual(settled, { cancelled: [], unresolved: [] });
    const bodies = spawned(service);
    assert.ok(bodies.length <= PROBE_LIMITS.maxOperations);
    assert.deepEqual(bodies.filter((b) => b.networking.enabled).length, 1, "only the control has networking on");
    assert.deepEqual(service.requests.filter((r) => r.path === "/v1/files").length, fixture.length, "the fixture's files, and nothing else, are uploaded");
    assert.deepEqual(results.subprocesses.map((s) => [s.label, s.exitCode]), [["edit", 0], ["inspect", 0], ["network attempt", 0], ["failing test", 1], ["passing test", 0], ["patch", 0], ["done", 0]]);
  });

  it("calls the network result inconclusive, and adopts nothing, when the positive control doesn't connect or doesn't run", async () => {
    const network = (judged: ReturnType<typeof evaluate>) => judged.patterns.map((p) => p.verdicts.find((v) => v.id === "network")?.outcome);
    const broken = await stageOne(probeService({ controlWorks: false }), "http://example.test/");
    assert.deepEqual([network(broken.judged), broken.judged.decision, broken.judged.pattern], [["inconclusive", "inconclusive"], "inconclusive", null]);
    const skipped = await stageOne(probeService({ controlWorks: true }), null);
    assert.deepEqual([network(skipped.judged), skipped.judged.decision, skipped.judged.pattern], [["inconclusive", "inconclusive"], "inconclusive", null]);
  });
});

/** An operation's outcome, as `classify` reads the service's answer. */
const outcome = (stdout: string, state: { exit_code?: number | null; timed_out?: boolean } = { exit_code: 0 }, status = "SUCCESS", image: string | null = null): Outcome =>
  classify({ uuid: randomUUID(), status, result_image_uuid: image, metadata: { result: { state, stdout: { value: stdout } } } });

/** Results in which both patterns pass every check, each at its own pace; a test then breaks what it is about. */
function passing(seconds: { a: number; b: number }): ProbeResults {
  const done = (id: string, label: string, result: Outcome): StepResult => ({ id, label, operationId: result.operationId, outcome: result, seconds: seconds.a, note: "" });
  const inside = (label: string, exitCode: number, stdout = ""): SubprocessResult => ({ label, exitCode, seconds: seconds.b, stdout });
  const denied = "CONTINUED\nBLOCKED http://example.test/: bad address\n";
  const download = (step: string, path: string) => ({ step, path, bytes: 10, sha256: sha(path), matched: true, holds: true });
  return {
    steps: [
      done("1", "edit", outcome("interfaces: lo ", { exit_code: 0 }, "SUCCESS", "img-A")),
      done("2", "network denied", outcome(denied)),
      done("3", "network control", outcome("")),
      done("4", "failing test", outcome("FAIL", { exit_code: 1 })),
      done("5", "patch", outcome("hashes", { exit_code: 0 }, "SUCCESS", "img-D")),
      done("6", "timeout", outcome("", { exit_code: null, timed_out: true })),
      done("7", "cancel", outcome("", {}, "CANCELLED")),
      done("8", "reconnect", outcome("done")),
      done("9", "lost answer", outcome("lost-and-found")),
      done("10", "parent", outcome("", { exit_code: 0 }, "SUCCESS", "img-P")),
      done("11", "parent cancel", outcome("", {}, "CANCELLED")),
    ],
    subprocesses: [inside("edit", 0), inside("inspect", 0, 'echo "Hello, Nivra"\n'), inside("network attempt", 0, denied), inside("failing test", 1), inside("passing test", 0), inside("patch", 0), inside("done", 0)],
    downloads: [download("5", "/out/patch.diff"), download("5", "/out/report.txt"), download("10", "/out/patch.diff"), download("10", "/out/report.txt")],
    reattach: { sameOperation: true, spawns: 1 },
    lostAnswer: { found: true, spawns: 1, detail: "adopted" },
    cancel: { reachedTerminal: true, status: "CANCELLED", seconds: 2 },
    parentCancel: { parent: "CANCELLED", seconds: 2, child: "ended" },
    errors: [],
  };
}

describe("Nebius Sandboxes, offline: each pattern judged on its own evidence (NIV-29)", () => {
  it("never adopts a quick pattern that failed its own checks on the strength of a slower one that passed", () => {
    const run = passing({ a: 25, b: 1 });
    // B is quick and broken: a connection got through, the failing test passed, and its cancel never ended the parent.
    run.subprocesses = run.subprocesses.map((s) => (s.label === "network attempt" ? { ...s, stdout: "CONTINUED\nREACHED http://example.test/\n" } : s.label === "failing test" ? { ...s, exitCode: 0 } : s));
    run.parentCancel = { parent: null, seconds: null, child: "unknown" };
    const judged = evaluate(run);
    assert.deepEqual(judged.patterns.map((p) => [p.pattern, p.outcome, p.latency.outcome]), [["A", "adopt with concern", "concern"], ["B", "defer", "adopt"]]);
    assert.deepEqual(judged.patterns[1]?.verdicts.filter((v) => v.outcome !== "pass").map((v) => v.id), ["network", "cancel", "exit"]);
    assert.deepEqual([judged.decision, judged.pattern], ["adopt with concern", "A"]);
  });

  it("defers when the pattern that passes is too slow and the quick one fails, and adopts the quick one once it passes", () => {
    const broken = passing({ a: 45, b: 1 });
    broken.subprocesses = broken.subprocesses.map((s) => (s.label === "inspect" ? { ...s, stdout: "" } : s));
    const judged = evaluate(broken);
    assert.deepEqual([judged.patterns.map((p) => p.outcome), judged.decision, judged.pattern], [["defer", "defer"], "defer", null]);
    const working = evaluate(passing({ a: 45, b: 1 }));
    assert.deepEqual([working.patterns.map((p) => p.outcome), working.decision, working.pattern], [["defer", "adopt"], "adopt", "B"]);
  });

  it("fails a patch that matches its hash but doesn't hold the edit: an empty or failed diff matches its own hash too", () => {
    const run = passing({ a: 5, b: 1 });
    run.downloads = run.downloads.map((d) => (d.step === "10" && d.path.endsWith("patch.diff") ? { ...d, holds: false } : d));
    const judged = evaluate(run);
    const patch = judged.patterns[1]?.verdicts.find((v) => v.id === "patch");
    assert.deepEqual([patch?.outcome, patch?.detail, judged.patterns[1]?.outcome, judged.pattern], ["fail", "2 of 2 download(s) matched their hashes; 1 held what they should", "defer", "A"]);
  });

  it("holds a parent whose running subprocess was never reported stopped as inconclusive, never as passed", () => {
    const run = passing({ a: 45, b: 1 });
    run.parentCancel = { parent: "CANCELLED", seconds: 2, child: "not ended" };
    const judged = evaluate(run);
    assert.deepEqual([judged.patterns[1]?.verdicts.find((v) => v.id === "cancel")?.outcome, judged.decision, judged.pattern], ["inconclusive", "inconclusive", null]);
  });
});

describe("Nebius Sandboxes, offline: the probe's credentials, and what stage 0 shows (NIV-29)", () => {
  const SCRIPT = fileURLToPath(new URL("../scripts/sandbox-probe.ts", import.meta.url));
  const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
  const KEY = `nivra-probe-key-${"k".repeat(16)}`;
  // Every case here stops before the probe sends anything: no case reaches stage 0's requests.
  const probe = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env["PATH"] ?? "", HOME: tmpdir() }, encoding: "utf8" });

  it("takes the key only from a file only you can read, outside the repository, and sends nothing otherwise", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra probe credentials "));
    const file = join(dir, "nebius.env");
    writeFileSync(file, `NEBIUS_API_KEY=${KEY}\nNEBIUS_PROJECT_ID=project-1\n`);
    chmodSync(file, 0o644);
    const readable = probe(["--credentials", file, "--stage", "0"]);
    assert.deepEqual([readable.status, /can be read by others \(mode 644\)\. Run chmod 600 on it, then try again\. Nothing was sent\./.test(readable.stderr)], [2, true]);
    const missing = probe(["--credentials", join(dir, "absent.env"), "--stage", "0"]);
    assert.deepEqual([missing.status, /^There's no file at .*absent\.env\. Create it with NEBIUS_API_KEY=/.test(missing.stderr)], [2, true]);
    const inside = probe(["--credentials", join(REPOSITORY, "nebius.env"), "--stage", "0"]);
    assert.deepEqual([inside.status, /is inside the repository, where it could be committed/.test(inside.stderr)], [2, true]);
    chmodSync(file, 0o600);
    writeFileSync(file, `NEBIUS_API_KEY=${KEY}\n`);
    const half = probe(["--credentials", file, "--stage", "0"]);
    assert.deepEqual([half.status, /must both be set, in /.test(half.stderr)], [2, true]);
    // Accepted: it gets as far as choosing a stage, and the key appears nowhere.
    writeFileSync(file, `NEBIUS_API_KEY=${KEY}\nNEBIUS_PROJECT_ID=project-1\n`);
    const accepted = probe(["--credentials", file, "--evidence", dir, "--stage", "9"]);
    assert.deepEqual([accepted.status, /^Choose --plan/.test(accepted.stderr), `${accepted.stdout}${accepted.stderr}`.includes(KEY)], [2, true, false]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows the permissions, limits, expiry and images stage 1 needs, and never the token's id", () => {
    // The shapes are the documented WhoAmIResponse and ImageListResponse.
    const whoami = {
      token_uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      token_expiration: 1735689600,
      permissions: { import: true, spawn: true, spawn_disposable: true, list: true, cancel: true, set_image_tag: false },
      limits: { instance_max_timeout: 3600, instance_max_concurrency: 10 },
      operations_stat: {},
    };
    const images = { images: [{ uuid: "u-busybox", tag: "busybox:latest", created_at: "2026-01-01T00:00:00Z", operation_uuid: null }, { uuid: "u-python", tag: "python:3.12" }] };
    const summary = stageZeroSummary(whoami, images);
    assert.equal(summary.ready, true);
    assert.deepEqual(summary.lines, [
      "The key and project were accepted.",
      "Permissions granted: import, spawn, spawn_disposable, list, cancel.",
      "Limits: instance_max_timeout 3600, instance_max_concurrency 10.",
      "The token expires: 2025-01-01T00:00:00.000Z.",
      "2 public image(s); busybox or alpine: busybox:latest (u-busybox).",
    ]);
    assert.equal(summary.lines.join("\n").includes("a1b2c3d4"), false);
    const short = stageZeroSummary({ ...whoami, permissions: { ...whoami.permissions, cancel: false }, limits: { instance_max_timeout: 120 } }, { images: [] });
    assert.deepEqual(
      [short.ready, short.lines[1], short.lines[2], short.lines[4]],
      [false, "Permissions granted: import, spawn, spawn_disposable, list. Stage 1 also needs: cancel.", "Limits: instance_max_timeout 120. Stage 1's longest operation needs 180 s.", "0 public image(s); busybox or alpine: none."],
    );
  });

  it("starts stage 1 only on a token that outlasts it and its cleanup, or one renewed with each request", () => {
    const needed = PROBE_LIMITS.overallMinutes * 60 + CLEANUP_MAX_SECONDS;
    const at = Date.parse("2026-10-20T04:28:22Z");
    const reading = (expiration: number | null | undefined, offsetMs = 0) => ({ whoami: expiration === undefined ? {} : { token_expiration: expiration }, atMs: at + offsetMs });
    // As both of stage 0's keys showed: an expiry minutes after each request, moving forward with it, is renewed.
    assert.deepEqual(tokenOutlasts(reading(at / 1000 + 300), reading(at / 1000 + 315, 15_000), needed), { ok: true, renewed: true, expiresAt: "2026-10-20T04:33:37.000Z" });
    // A fixed expiry must outlast stage 1 and its cleanup.
    assert.deepEqual(tokenOutlasts(reading(at / 1000 + 300), reading(at / 1000 + 300, 15_000), needed), { ok: false, renewed: false, expiresAt: "2026-10-20T04:33:22.000Z" });
    assert.equal(tokenOutlasts(reading(at / 1000 + 3_600), reading(at / 1000 + 3_600, 15_000), needed).ok, true);
    assert.deepEqual([tokenOutlasts(reading(null), reading(null, 15_000), needed).ok, tokenOutlasts(reading(undefined), reading(undefined, 15_000), needed).ok], [true, false]);
    assert.equal(needed, 27 * 60);
  });
});
