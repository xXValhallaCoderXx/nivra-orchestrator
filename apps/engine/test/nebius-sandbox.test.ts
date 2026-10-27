import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { fetchTransport, SandboxApi, SandboxDeadlineError, SandboxHttpError, SandboxNetworkError, SandboxNotSentError, SandboxTooLargeError, type SpawnBody, type Transport, type TransportRequest, type TransportResponse } from "../src/exec/nebius/api.ts";
import { CLEANUP_MAX_SECONDS, evaluate, insideRepository, probePlan, PROBE_LIMITS, runStageOne, stageZeroSummary, tokenOutlasts, type ProbeResults, type StepResult, type SubprocessResult } from "../src/exec/nebius/probe.ts";
import { classify, Journal, Sandbox, SandboxRefusal, type Outcome } from "../src/exec/nebius/sandbox.ts";
import { ANY_SIZE, clock, encode, FakeService, holding, PATCH, REPORT, sandboxOn, settles, sha, spawned, step, succeed } from "./fake-sandboxes.ts";

/**
 * Nebius Sandboxes, offline (NIV-29, NIV-41): the client and the lifecycle against the fake service in
 * `fake-sandboxes.ts`. Nothing here reaches the network but loopback.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
/** A journal file in a folder of its own, removed after the tests. */
function journalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nivra probe "));
  dirs.push(dir);
  return join(dir, "journal.jsonl");
}

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

  it("reads signal -1 as no signal, as the live service reports a command that simply exited", () => {
    const op = (state: Record<string, unknown>) => ({ uuid: "u", status: "SUCCESS", metadata: { result: { state } } });
    // Seen live on 20 October 2026: exits 0 and 1 with signal -1, and a timeout as exit -1 with signal 9.
    assert.deepEqual(
      [
        classify(op({ exit_code: 0, signal: -1, timed_out: false })).verdict,
        classify(op({ exit_code: 1, signal: -1, timed_out: false })).verdict,
        classify(op({ exit_code: -1, signal: 9, timed_out: true })).verdict,
        classify(op({ exit_code: -1, signal: 9, timed_out: false })).verdict,
        classify(op({ exit_code: -1, signal: "SIGTERM" })).verdict,
      ],
      ["passed", "command-failed", "timed-out", "signalled", "signalled"],
    );
    assert.equal(classify(op({ exit_code: 0, signal: -1 })).signal, -1, "the evidence keeps the service's own value");
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

  it("runs an environment's preparation with networking on, kept, only from a pinned pnpm and a frozen install (NIV-49)", async () => {
    const service = new FakeService(() => succeed());
    const { sandbox, journal } = sandboxOn(service);
    const given = { image: "img-node", inputs: { uuid: "inputs" }, packageManager: "pnpm@11.5.3", installArgs: ["--frozen-lockfile", "--filter", "@scope/data..."], timeoutSeconds: 120 };
    const refusals: Array<[Partial<typeof given>, RegExp]> = [
      [{ packageManager: "pnpm@11" }, /exact pnpm version/],
      [{ packageManager: "npm@10.0.0" }, /exact pnpm version/],
      [{ installArgs: ["--filter", "a"] }, /frozen lockfile/],
      [{ installArgs: ["--frozen-lockfile", "a; curl x"] }, /plain arguments/],
      [{ timeoutSeconds: 500 }, /timeout must be between 1 and 180 s/],
    ];
    for (const [change, pattern] of refusals) await assert.rejects(sandbox.prepareEnvironment({ ...given, ...change }), pattern);
    assert.equal(service.spawns, 0);
    await sandbox.prepareEnvironment(given);
    const [body] = spawned(service) as unknown as Array<{ networking: { enabled: boolean }; disposable: boolean; image: string; args: string[]; files: Record<string, { uuid: string }> }>;
    assert.deepEqual([body?.networking.enabled, body?.disposable, body?.image, body?.args.slice(2), Object.keys(body?.files ?? {})], [true, false, "img-node", ["nivra-env-prepare", "/workspace", "/nivra/env-inputs.tar.gz", "11.5.3", "--frozen-lockfile", "--filter", "@scope/data..."], ["/nivra/env-inputs.tar.gz"]]);
    assert.equal(journal.spawnsOf("environment preparation"), 1);
  });

  it("imports an image only by a registry address with an exact tag, journaled as an operation cleanup can settle (NIV-49)", async () => {
    const service = new FakeService(() => succeed());
    const { sandbox, journal } = sandboxOn(service);
    for (const url of ["docker://docker.io/library/node", "https://docker.io/library/node:22", "docker://docker.io/library/node:22 --x"]) await assert.rejects(sandbox.importImage({ registryUrl: url, timeoutSeconds: 900 }), /registry address and an exact tag/);
    await assert.rejects(sandbox.importImage({ registryUrl: "docker://docker.io/library/node:22.23.4-alpine3.24", timeoutSeconds: 4_000 }), /between 1 and 3,600 s/);
    assert.equal(service.requests.length, 0, "a refused import sent something");
    const started = await sandbox.importImage({ registryUrl: "docker://docker.io/library/node:22.23.4-alpine3.24", timeoutSeconds: 900 });
    assert.ok("operationId" in started);
    const sent = service.requests.filter((request) => request.path === "/v1/images/import").map((request) => JSON.parse(String(request.body)) as unknown);
    assert.deepEqual(sent, [{ registry: { url: "docker://docker.io/library/node:22.23.4-alpine3.24" }, timeout: 900 }]);
    assert.deepEqual(journal.open().operations, [started.operationId], "the import isn't open in the journal for cleanup");
    await assert.rejects(sandbox.submit(step("meanwhile")), /One operation at a time/);
    const ended = await sandbox.observe(started.operationId, 900);
    assert.deepEqual([ended.status, ended.resultImage, journal.open().operations.length], ["SUCCESS", "img-imported", 0]);
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
    for (let i = 0; i < 5; i++) await service.transport({ method: "POST", path: "/v1/instances", body: JSON.stringify({ env: {} }), timeoutMs: 1, maxBytes: ANY_SIZE });
    const found = await sandbox.reconcile(submitted.uncertain);
    assert.ok("unknown" in found);
    assert.match(found.unknown, /2 page\(s\) of 2, 4 operation\(s\) read, since .*; the search stopped at its bounds$/);
  });

  it("reattaches a fresh client to the same operation from the journal, with one spawn", async () => {
    const service = new FakeService(() => ({ statuses: ["PENDING", "EXECUTING", "EXECUTING", "SUCCESS"], exitCode: 0, stdout: "done" }));
    const path = journalPath();
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
    await api.operation(submitted.operationId, { until: Number.POSITIVE_INFINITY });
    assert.equal(time.waits[0], 7_000);
    let calls = 0;
    const hanging: Transport = async () => {
      calls++;
      throw new Error("timed out");
    };
    const waits: number[] = [];
    const impatient = new SandboxApi(hanging, { readDeadlineMs: 10_000, sleep: async (ms) => void waits.push(ms) });
    await assert.rejects(impatient.operation("x", { until: Number.POSITIVE_INFINITY }), (error: Error) => error instanceof SandboxNetworkError && /got no answer/.test(error.message));
    assert.ok(calls >= 2, "a lost read is retried");
    const posts: TransportRequest[] = [];
    const failing = new SandboxApi(async (request) => (posts.push(request), encode({}, 500)), { sleep: async () => undefined });
    assert.equal((await failing.spawn({ command: "x", args: [], image: "i", shell: false, env: {}, disposable: true, networking: { enabled: false }, timeout: 5 }, { until: Number.POSITIVE_INFINITY })).status, "uncertain");
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
    assert.deepEqual(sandbox.journal.entries.map((e) => e.kind), ["intent", "uncertain", "found", "cancel", "cancel-answer", "terminal"]);
  });

  it("journals what it couldn't settle, and --recover settles it later from the journal", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    service.dropNextSpawnAnswer = true;
    const path = journalPath();
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
    const path = journalPath();
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
    assert.deepEqual(new Journal(path).entries.map((e) => e.kind), ["intent", "found", "cancel", "cancel-answer", "terminal"]);
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

  it("gives every request a whole number of milliseconds, however the deadline falls (the live run's RangeError)", async () => {
    let now = 0.5;
    const time = { now: () => now, sleep: async (ms: number) => void (now += ms) };
    const timeouts: number[] = [];
    const busy: Transport = async (request) => (timeouts.push(request.timeoutMs), encode({ error: "unavailable" }, 503, { "retry-after": "1" }));
    const api = new SandboxApi(busy, { sleep: time.sleep, now: time.now });
    await assert.rejects(api.operation("op", { until: 2_500.7 }), SandboxDeadlineError);
    assert.deepEqual([timeouts, timeouts.every((ms) => Number.isInteger(ms) && ms >= 1)], [[2_500, 1_500, 500], true]);
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
    for (let i = 0; i < 5; i++) await service.transport({ method: "POST", path: "/v1/instances", body: JSON.stringify({ env: {} }), timeoutMs: 1, maxBytes: ANY_SIZE });
    const start = time.now();
    const found = await sandbox.reconcile(submitted.uncertain);
    assert.ok("unknown" in found);
    assert.match(found.unknown, /within 2 page\(s\) of 1, 2 operation\(s\) read, since .*; the search stopped at its time limit$/);
    assert.equal(time.now() - start, 120_000);
  });

  it("stops a stage-1 step at the probe's cap and starts nothing after it, then cleanup without the cap settles the operation", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const path = journalPath();
    const capped = sandboxOn(service, { time, journal: new Journal(path), cap: () => 10_000 });
    const running = (await capped.sandbox.submit(step("long", { timeoutSeconds: 60 }))) as { operationId: string };
    await assert.rejects(capped.sandbox.observe(running.operationId, 60), /wasn't seen to end within 10 s/);
    assert.equal(time.now(), 10_000);
    const entries = new Journal(path).entries.length;
    await assert.rejects(capped.sandbox.submit(step("late")), /^SandboxRefusal: The time for this work ran out, so the late operation wasn't started\.$/);
    assert.deepEqual([new Journal(path).entries.length, service.spawns], [entries, 1]);
    const settled = await sandboxOn(service, { time, journal: new Journal(path) }).sandbox.cleanup();
    assert.deepEqual([settled.cancelled.length, settled.unresolved, service.operations[0]?.cancelled], [1, [], true]);
  });
});

describe("Nebius Sandboxes, offline: every request, writes included, ends by its deadline (NIV-41, D33)", () => {
  const body: SpawnBody = { command: "/bin/true", args: [], image: "base", shell: false, env: {}, disposable: true, networking: { enabled: false }, timeout: 5 };

  it("sends no POST or DELETE with less than its minimum left, and says nothing was sent (the P3 reproduction)", async () => {
    const service = new FakeService(() => succeed());
    const time = clock();
    const api = new SandboxApi(service.transport, { sleep: time.sleep, now: time.now });
    const writes: Array<[string, (until: number) => Promise<unknown>]> = [
      ["Starting an operation", (until) => api.spawn(body, { until })],
      ["Uploading a file", (until) => api.upload(new Uint8Array(3), { until })],
      ["Cancelling an operation", (until) => api.cancel("op", { until })],
      ["Starting a subprocess", (until) => api.spawnSubprocess("op", { command: "/bin/true", args: [], shell: false, env: {} }, { until })],
      ["Stopping a subprocess", (until) => api.killSubprocess("op", 2, { until })],
    ];
    for (const left of [1, api.minWriteMs - 1]) {
      for (const [what, write] of writes) {
        await assert.rejects(write(time.now() + left), (error: Error) => error instanceof SandboxNotSentError && error.reason === "no-time" && error.message === `${what} wasn't sent: too little time was left.`);
      }
    }
    assert.deepEqual([service.requests.length, api.posts], [0, []]);
  });

  it("gives every POST and DELETE the time left, never its full 30 s", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const api = new SandboxApi(service.transport, { sleep: time.sleep, now: time.now });
    const until = time.now() + 5_000;
    const created = await api.spawn(body, { until });
    assert.equal(created.status, "created");
    const id = (created as { id: string }).id;
    await api.upload(new Uint8Array(3), { until });
    await api.cancel(id, { until });
    await api.killSubprocess(id, 2, { until });
    assert.deepEqual(service.requests.map((r) => [r.method, r.timeoutMs]), [["POST", 5_000], ["POST", 5_000], ["DELETE", 5_000], ["DELETE", 5_000]]);
    // Through the lifecycle: with the cap 1 ms away, nothing starts and no cancel is sent; with 5 s left, the spawn gets 5 s.
    const capped = sandboxOn(service, { time, cap: () => time.now() + 1 });
    await assert.rejects(capped.sandbox.submit(step("late")), /^SandboxRefusal: The time for this work ran out, so the late operation wasn't started\.$/);
    assert.equal(await capped.sandbox.cancel(id), null);
    assert.deepEqual([service.requests.length, capped.journal.entries.map((e) => e.kind)], [4, ["unresolved"]]);
    await sandboxOn(service, { time, cap: () => time.now() + 5_000 }).sandbox.submit(step("on time"));
    assert.equal(service.requests.at(-1)?.timeoutMs, 5_000);
  });

  it("takes no answer that comes after its deadline: a read gives up, and a late spawn is kept only for cleanup to stop", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    // Every answer takes 3 s to come back.
    const slow: Transport = async (request) => {
      const response = await service.transport(request);
      await time.sleep(3_000);
      return response;
    };
    const api = new SandboxApi(slow, { sleep: time.sleep, now: time.now });
    await assert.rejects(api.operation("missing", { until: time.now() + 2_500 }), (error: Error) => error instanceof SandboxDeadlineError);
    const journal = new Journal();
    const cap = time.now() + 2_500;
    const late = sandboxOn(service, { time, journal, transport: slow, cap: () => cap });
    await assert.rejects(late.sandbox.submit(step("slow")), /^SandboxLateSpawnError: The slow operation was answered only after its deadline, or once the work was cancelled, so it isn't used; cleanup stops it\.$/);
    assert.deepEqual([journal.entries.map((e) => e.kind), journal.open().operations, service.spawns], [["intent", "submitted"], [service.operations[0]?.uuid], 1]);
    const settled = await sandboxOn(service, { time, journal }).sandbox.cleanup();
    assert.deepEqual([settled.cancelled.length, settled.unresolved, service.operations[0]?.cancelled, service.spawns], [1, [], true, 1]);
  });

  it("never asks again for an answer over its cap, and waits at least a quarter of a second between retries", async () => {
    let calls = 0;
    const huge: Transport = async () => (calls++, encode({ uuid: "x", status: "SUCCESS", padding: "y".repeat(2_000) }));
    const api = new SandboxApi(huge, { maxAnswerBytes: 1_000, sleep: async () => undefined });
    await assert.rejects(api.operation("x", { until: Number.POSITIVE_INFINITY }), (error: Error) => error instanceof SandboxTooLargeError && error.message === "Reading an operation was longer than the 1000 bytes Nivra takes.");
    assert.equal(calls, 1);
    const service = new FakeService(() => succeed());
    service.rateLimitNextRead = 0;
    const time = clock();
    const patient = new SandboxApi(service.transport, { sleep: time.sleep, now: time.now });
    await assert.rejects(patient.operation("missing", { until: Number.POSITIVE_INFINITY }), SandboxHttpError);
    assert.deepEqual(time.waits, [250]);
  });

  it("journals a spawn its client refused to send as not sent, so cleanup looks for nothing and counts no spawn", async () => {
    const service = new FakeService(() => succeed());
    const time = clock();
    const stopped = new AbortController();
    stopped.abort();
    // The lifecycle has no signal of its own, so the refusal comes from the client, after the intent is written.
    const api = new SandboxApi(service.transport, { sleep: time.sleep, now: time.now, signal: stopped.signal });
    const journal = new Journal();
    const sandbox = new Sandbox(api, { journal, sleep: time.sleep, now: time.now });
    await assert.rejects(sandbox.submit(step("unsent")), (error: Error) => error instanceof SandboxNotSentError && error.reason === "cancelled");
    assert.deepEqual([journal.entries.map((e) => e.kind), journal.open(), journal.spawnsOf("unsent"), service.requests.length], [["intent", "not-sent"], { operations: [], uncertain: [] }, 0, 0]);
  });

  it("ends the probe's uploads by its deadline: with no time left none is sent and nothing runs", async () => {
    const service = probeService({ controlWorks: true });
    const { sandbox, api, time } = sandboxOn(service);
    const results = await runStageOne({ sandbox, api, reconnect: () => sandbox, baseImage: "base", fixture, deny: [], networkControl: null, now: time.now, deadline: time.now() + 1, log: () => undefined });
    assert.deepEqual([results.errors, service.requests.length, results.steps.length], [[`uploads: Uploading a file wasn't sent: too little time was left. (0 of ${fixture.length} sent)`], 0, 0]);
  });

  it("reads a journal whose last line a crash cut short, keeping its spawn uncertain, and refuses one damaged elsewhere", () => {
    const path = journalPath();
    new Journal(path).append({ kind: "intent", wall: "2026-10-20T00:00:00.000Z", correlation: "c1", label: "one" });
    // The crash came while its answer was being recorded: the spawn may have reached the service.
    appendFileSync(path, '{"kind":"submitted","wall":"2026-10-20T00:00:01.000Z","corr');
    const journal = new Journal(path);
    assert.deepEqual([journal.entries.map((e) => e.kind), journal.open().uncertain.map((u) => u.correlation)], [["intent"], ["c1"]]);
    // The next entry cuts the torn line off first, so the journal stays readable rather than damaged in the middle.
    journal.append({ kind: "refused", wall: "2026-10-20T00:00:02.000Z", correlation: "c1", status: 400 });
    assert.deepEqual([new Journal(path).entries.map((e) => e.kind), readFileSync(path, "utf8").includes('"corr\n')], [["intent", "refused"], false]);
    writeFileSync(path, '{"kind":"intent","wall":"w","correlation":"c1","label":"one"}\nnot a line\n{"kind":"refused","wall":"w","correlation":"c1","status":400}\n');
    assert.throws(() => new Journal(path).entries, /^SandboxRefusal: A session's journal is damaged at line 2, so what it records can't be trusted\./);
  });

  it("leaves a spawn answered with a redirect uncertain, never followed and never taken as refused", async () => {
    const api = new SandboxApi(async () => encode({}, 302, { location: "https://elsewhere.test/" }), { sleep: async () => undefined });
    assert.deepEqual(await api.spawn(body, { until: Number.POSITIVE_INFINITY }), { status: "uncertain", cause: "the service answered HTTP 302" });
  });
});

describe("Nebius Sandboxes, offline: an interruption stops what is under way (NIV-29)", () => {
  it("cuts off a real request still waiting for its answer, and one whose answer is still arriving", async () => {
    // On loopback: one path never answers; the other sends its headers, then never finishes its body.
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/arriving")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const transport = fetchTransport({ key: "test-key", project: "test-project" }, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      for (const path of ["/waiting", "/arriving"]) {
        const stage = new AbortController();
        const started = performance.now();
        const request = transport({ method: "GET", path, timeoutMs: 30_000, maxBytes: ANY_SIZE, signal: stage.signal });
        setTimeout(() => stage.abort(), 50);
        await assert.rejects(request, { name: "AbortError" });
        assert.ok(performance.now() - started < 5_000, `${path} was cut off at once`);
      }
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("cuts off a read under way, sends nothing after it, and cleanup, with its own signal, still settles the operation", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const stage = new AbortController();
    let holdReads = false;
    const { transport, seen, held } = holding(service, (request) => holdReads && request.method === "GET");
    const journal = new Journal();
    const { sandbox } = sandboxOn(service, { transport, journal, signal: stage.signal });
    const running = (await sandbox.submit(step("long", { timeoutSeconds: 60 }))) as { operationId: string };
    holdReads = true;
    const observing = sandbox.observe(running.operationId, 60);
    await settles(() => held.length === 1);
    const sent = seen.length;
    stage.abort();
    await assert.rejects(observing, /^SandboxCancelledError: Reading an operation was cancelled\.$/);
    await assert.rejects(sandbox.submit(step("next")), /^SandboxCancelledError: Starting the next operation was cancelled\.$/);
    assert.equal(seen.length, sent, "nothing was sent after the interruption");
    const settled = await sandboxOn(service, { journal }).sandbox.cleanup();
    assert.deepEqual([settled.cancelled, settled.unresolved, service.operations[0]?.cancelled], [[running.operationId], [], true]);
  });

  it("keeps a spawn cut off on its way back as uncertain, and cleanup finds it by its correlation id and stops it", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const stage = new AbortController();
    // The service makes the operation; its answer is still on its way back when the interruption comes.
    const { transport, held } = holding(service, (request) => request.method === "POST" && request.path === "/v1/instances", { answerFirst: true });
    const journal = new Journal();
    const { sandbox } = sandboxOn(service, { transport, journal, signal: stage.signal });
    const submitting = sandbox.submit(step("cut off"));
    await settles(() => held.length === 1);
    stage.abort();
    const submitted = await submitting;
    assert.ok("uncertain" in submitted);
    assert.deepEqual([journal.entries.map((entry) => entry.kind), service.operations.length], [["intent", "uncertain"], 1]);
    const settled = await sandboxOn(service, { journal }).sandbox.cleanup();
    assert.deepEqual([settled.cancelled.length, settled.unresolved, service.operations[0]?.cancelled, service.spawns], [1, [], true, 1]);
  });

  it("stops uploading: the files after the one cut off are never sent, nothing runs, and the reason is kept", async () => {
    const service = probeService({ controlWorks: true });
    const stage = new AbortController();
    let uploads = 0;
    const { transport, seen, held } = holding(service, (request) => request.path === "/v1/files" && ++uploads === 2);
    const { sandbox, api, time } = sandboxOn(service, { transport, signal: stage.signal });
    const running = runStageOne({ sandbox, api, reconnect: () => sandbox, baseImage: "base", fixture, deny: [], networkControl: null, now: time.now, deadline: Number.POSITIVE_INFINITY, signal: stage.signal, log: () => undefined });
    await settles(() => held.length === 1);
    const sent = seen.length;
    stage.abort();
    const results = await running;
    assert.deepEqual([seen.length - sent, service.requests.filter((request) => request.path === "/v1/files").length, service.spawns, results.steps.length], [0, 1, 0, 0]);
    assert.deepEqual(results.errors, [`uploads: Uploading a file was cancelled. (1 of ${fixture.length} sent)`]);
  });

  it("ends a retry's wait at once, and makes no further attempt", async () => {
    const service = new FakeService(() => succeed());
    service.unavailableReads = 1;
    const stage = new AbortController();
    const time = clock();
    // The interruption comes while the read waits the 4 s the service asked for.
    const sleep = async (ms: number) => {
      if (ms === 4_000) stage.abort();
      await time.sleep(ms);
    };
    const api = new SandboxApi(service.transport, { sleep, now: time.now, signal: stage.signal });
    await assert.rejects(api.operation("op", { until: Number.POSITIVE_INFINITY }), /^SandboxCancelledError: Reading an operation was cancelled\.$/);
    assert.equal(service.requests.length, 1);
  });

  it("stops a wait under way when its cap moves earlier, instead of keeping the deadline it started with", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const base = clock();
    let cap = Number.POSITIVE_INFINITY;
    // After the first poll's wait, the cap moves to now, as the probe's Ctrl+C sets it.
    const time = { ...base, sleep: async (ms: number) => void (await base.sleep(ms), (cap = base.now())) };
    const { sandbox } = sandboxOn(service, { time, cap: () => cap });
    const running = (await sandbox.submit(step("long", { timeoutSeconds: 60 }))) as { operationId: string };
    await assert.rejects(sandbox.observe(running.operationId, 60), /wasn't seen to end within 1 s/);
    assert.deepEqual([service.requests.filter((request) => request.method === "GET").length, base.now()], [1, 1_000]);
  });

  it("keeps cleanup to its own budget: with none left it sends no cancel, and a later one with time settles the operation", async () => {
    const service = new FakeService(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const journal = new Journal();
    await sandboxOn(service, { time, journal }).sandbox.submit(step("long", { timeoutSeconds: 60 }));
    const spent = await sandboxOn(service, { time, journal, cap: () => time.now() }).sandbox.cleanup();
    assert.deepEqual([spent.cancelled, spent.unresolved.length, service.requests.filter((request) => request.method === "DELETE").length], [[], 1, 0]);
    const later = await sandboxOn(service, { time, journal }).sandbox.cleanup();
    assert.deepEqual([later.cancelled.length, later.unresolved, service.operations[0]?.cancelled], [1, [], true]);
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
    await assert.rejects(sandbox.download("img-D", "/out/report.txt", 50, null), /^SandboxTooLargeError: The file \/out\/report\.txt was longer than the 50 bytes Nivra takes\.$/);
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
  const journal = new Journal(journalPath());
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
    assert.deepEqual(results.subprocesses.map((s) => [s.label, s.exitCode, s.error]), [["edit", 0, null], ["inspect", 0, null], ["network attempt", 0, null], ["failing test", 1, null], ["passing test", 0, null], ["patch", 0, null], ["done", 0, null]]);
    assert.deepEqual(results.parentCancel, { parent: "CANCELLED", seconds: results.parentCancel?.seconds, child: "ended", childDetail: "exit -1, signal 9" });
  });

  it("keeps how each subprocess ended, its signal and its stderr, and why a cancelled parent's child couldn't be read", async () => {
    const service = probeService({ controlWorks: true });
    // As in stage 1's second run: the network attempt ends with exit -1 after its first line, and the child of the
    // cancelled parent can't be read. Here the service also says why, as the evidence now keeps.
    service.endSubprocess = { match: /wget/, state: { exit_code: -1, signal: 9, timed_out: false }, stdout: "CONTINUED\n", stderr: "Killed\n" };
    service.childReadAfterCancel = 404;
    const { results, judged } = await stageOne(service, "http://example.test/");
    assert.deepEqual(results.errors, []);
    const attempt = results.subprocesses.find((s) => s.label === "network attempt");
    assert.deepEqual([attempt?.exitCode, attempt?.signal, attempt?.timedOut, attempt?.stderr, attempt?.error], [-1, 9, false, "Killed\n", null]);
    const b = judged.patterns.find((p) => p.pattern === "B");
    const network = b?.verdicts.find((v) => v.id === "network");
    assert.deepEqual([network?.outcome, network?.detail], ["inconclusive", "0 attempt(s) blocked; the attempt: exit -1, signal 9; the control connected"]);
    assert.deepEqual([results.parentCancel?.child, results.parentCancel?.childDetail], ["unknown", "its read failed: Reading a subprocess was answered with HTTP 404."]);
    const cancel = b?.verdicts.find((v) => v.id === "cancel");
    assert.deepEqual([cancel?.outcome, cancel?.detail.endsWith("its subprocess couldn't be read (its read failed: Reading a subprocess was answered with HTTP 404.)")], ["inconclusive", true]);
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
  const inside = (label: string, exitCode: number, stdout = ""): SubprocessResult => ({ label, exitCode, signal: null, timedOut: false, seconds: seconds.b, stdout, stderr: "", error: null });
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
    parentCancel: { parent: "CANCELLED", seconds: 2, child: "ended", childDetail: "exit -1, signal 9" },
    errors: [],
  };
}

describe("Nebius Sandboxes, offline: each pattern judged on its own evidence (NIV-29)", () => {
  it("never adopts a quick pattern that failed its own checks on the strength of a slower one that passed", () => {
    const run = passing({ a: 25, b: 1 });
    // B is quick and broken: a connection got through, the failing test passed, and its cancel never ended the parent.
    run.subprocesses = run.subprocesses.map((s) => (s.label === "network attempt" ? { ...s, stdout: "CONTINUED\nREACHED http://example.test/\n" } : s.label === "failing test" ? { ...s, exitCode: 0 } : s));
    run.parentCancel = { parent: null, seconds: null, child: "unknown", childDetail: null };
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
    run.parentCancel = { parent: "CANCELLED", seconds: 2, child: "not ended", childDetail: null };
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
    // A file inside is still inside under a folder whose name starts with "..", or reached through a link from outside.
    const dotted = probe(["--credentials", join(REPOSITORY, "..private", "nebius.env"), "--stage", "0"]);
    assert.deepEqual([dotted.status, /is inside the repository, where it could be committed/.test(dotted.stderr)], [2, true]);
    symlinkSync(join(REPOSITORY, "README.md"), join(dir, "linked.env"));
    const linked = probe(["--credentials", join(dir, "linked.env"), "--stage", "0"]);
    assert.deepEqual([linked.status, /is inside the repository, where it could be committed/.test(linked.stderr)], [2, true]);
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

  it("finds a file inside the repository by its real path and whole components, however it is reached", { skip: process.platform === "win32" }, () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nivra repository check ")));
    const repository = join(root, "repo");
    mkdirSync(join(repository, "..private"), { recursive: true });
    writeFileSync(join(repository, "..private", "key.env"), "");
    writeFileSync(join(repository, "secret.env"), "");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "key.env"), "");
    symlinkSync(join(repository, "secret.env"), join(outside, "link.env"));
    symlinkSync(repository, join(outside, "repo-link"));
    const cases: Array<[string, boolean]> = [
      [join(repository, "..private", "key.env"), true],
      [join(outside, "link.env"), true],
      [join(outside, "repo-link", "secret.env"), true],
      [join(repository, "not-yet.env"), true],
      [join(repository, "..not-yet", "key.env"), true],
      [join(outside, "key.env"), false],
      [join(root, "repo-sibling.env"), false],
    ];
    assert.deepEqual(cases.map(([path]) => insideRepository(path, repository)), cases.map(([, inside]) => inside));
    rmSync(root, { recursive: true, force: true });
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
