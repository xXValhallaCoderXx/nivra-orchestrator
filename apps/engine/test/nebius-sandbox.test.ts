import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { SandboxApi, SandboxNetworkError, type Transport, type TransportRequest, type TransportResponse } from "../src/exec/nebius/api.ts";
import { evaluate, probePlan, PROBE_LIMITS, runStageOne } from "../src/exec/nebius/probe.ts";
import { classify, Journal, Sandbox, SandboxRefusal } from "../src/exec/nebius/sandbox.ts";

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
  subprocesses: Map<number, { args: string[]; exitCode: number; stdout: string; stopped: boolean }>;
  events: string[];
}

const encode = (value: unknown, status = 200, headers: Record<string, string> = {}): TransportResponse => ({ status, headers, body: new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value)) });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
      const stdout = /cat \/work\/greet\.sh/.test(args) ? 'echo "Hello, Nivra"\n' : /sha256sum/.test(args) ? `${sha("PASS: Hello, Nivra\n")}  /out/report.txt\n${sha("--- base/greet.sh\n")}  /out/patch.diff\n` : /wget/.test(args) ? "BLOCKED http://example.test: bad address\n" : "";
      op.subprocesses.set(next, { args: [body.command, ...body.args], exitCode, stdout, stopped: false });
      op.events.push(`data: ${JSON.stringify({ type: "spawn", spid: next, env: body.env })}`);
      if (/touch \/tmp\/nivra-done/.test(args)) op.finishedBySubprocess = true;
      if (timeout?.started) return encode({ error: "gateway timeout" }, 504);
      return encode({ spid: next }, 201);
    }
    const sub = op.subprocesses.get(spid ?? -1);
    if (!sub || sub.stopped) return encode({ error: "no such subprocess" }, 404);
    if (/sleep 60/.test(sub.args.join(" "))) return encode({ state: { exit_code: null } });
    return encode({ state: { exit_code: sub.exitCode }, stdout: { value: sub.stdout } });
  }
}

/** A clock the tests move: sleeping advances it, so deadlines are reached without waiting. */
function clock() {
  let now = 0;
  const waits: number[] = [];
  return { now: () => now, sleep: async (ms: number) => void (waits.push(ms), (now += ms)), waits };
}

function sandboxOn(service: FakeService, options: { journal?: Journal; search?: { sinceMarginMs: number; pageSize: number; maxPages: number; maxCandidates: number } } = {}) {
  const time = clock();
  const api = new SandboxApi(service.transport, { sleep: time.sleep, readDeadlineMs: 60_000 });
  const journal = options.journal ?? new Journal();
  const sandbox = new Sandbox(api, { journal, sleep: time.sleep, now: time.now, pollMs: 1_000, ...(options.search ? { search: options.search } : {}) });
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
    await assert.rejects(sandbox.observe(stuck.operationId, 5), /hadn't ended 65 s after it started/);
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
    if (/sha256sum/.test(args)) {
      const report = "PASS: Hello, Nivra\n";
      const patch = "--- base/greet.sh\n+++ work/greet.sh\n-echo \"Hello, world\"\n+echo \"Hello, Nivra\"\n";
      return succeed({ stdout: `${sha(report)}  /out/report.txt\n${sha(patch)}  /out/patch.diff\n`, resultImage: "img-D", files: { "/out/report.txt": report, "/out/patch.diff": patch } });
    }
    if (/sleep 30/.test(args)) return { statuses: ["EXECUTING", "SUCCESS"], exitCode: null, timedOut: true };
    if (/sleep 60/.test(args)) return { statuses: ["EXECUTING"], waits: true };
    if (/nivra-done/.test(args)) {
      const report = "PASS: Hello, Nivra\n";
      const patch = "--- base/greet.sh\n";
      return { statuses: ["EXECUTING", "SUCCESS"], waits: true, exitCode: 0, resultImage: "img-P", files: { "/out/report.txt": report, "/out/patch.diff": patch } };
    }
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
    assert.deepEqual(judged.verdicts.map((v) => [v.id, v.outcome]), [["network", "pass"], ["continuation", "pass"], ["cancel", "pass"], ["reattach", "pass"], ["exit", "pass"], ["patch", "pass"], ["lost-answer", "pass"]]);
    assert.equal(judged.decision, "adopt");
    assert.deepEqual(settled, { cancelled: [], unresolved: [] });
    const bodies = spawned(service);
    assert.ok(bodies.length <= PROBE_LIMITS.maxOperations);
    assert.deepEqual(bodies.filter((b) => b.networking.enabled).length, 1, "only the control has networking on");
    assert.deepEqual(service.requests.filter((r) => r.path === "/v1/files").length, fixture.length, "the fixture's files, and nothing else, are uploaded");
    assert.deepEqual(results.subprocesses.map((s) => [s.label, s.exitCode]), [["edit", 0], ["inspect", 0], ["network attempt", 0], ["failing test", 1], ["passing test", 0], ["patch", 0], ["done", 0]]);
  });

  it("calls the network result inconclusive, and adopts nothing, when the positive control doesn't connect or doesn't run", async () => {
    const broken = await stageOne(probeService({ controlWorks: false }), "http://example.test/");
    assert.deepEqual([broken.judged.verdicts.find((v) => v.id === "network")?.outcome, broken.judged.decision], ["inconclusive", "inconclusive"]);
    const skipped = await stageOne(probeService({ controlWorks: true }), null);
    assert.deepEqual([skipped.judged.verdicts.find((v) => v.id === "network")?.outcome, skipped.judged.decision], ["inconclusive", "inconclusive"]);
  });
});
