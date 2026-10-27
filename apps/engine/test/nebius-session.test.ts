import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { BoundaryUnavailableError, ExecRefusedError, ExecUncertainError, SessionOpenError, type ExecRequest, type ExecutionSession, type SessionSpec } from "../src/exec/backend.ts";
import type { Transport, TransportResponse } from "../src/exec/nebius/api.ts";
import { Journal, RETENTION } from "../src/exec/nebius/sandbox.ts";
import { safeUnresolved } from "../src/exec/check.ts";
import { compressSnapshot, createNebiusBackend, listingDigest, NEBIUS_CAPABILITIES, NEBIUS_LIMITS, PREPARE_SCRIPT, reconcileJournals, SandboxOperationError, scanJournals, signalName, type ListingEntry, type NebiusBackendOptions } from "../src/exec/nebius/session.ts";
import { writeTar } from "../src/exec/tar.ts";
import { FakeGuest } from "./fake-guest.ts";
import { clock, FakeService, holding, settles, sha, succeed, type Behaviour } from "./fake-sandboxes.ts";
import { sessionContract } from "./session-contract.ts";

/**
 * The Nebius execution session (NIV-41, D33) against the fake service: the shared contract, what the backend claims
 * and never sends, the state moving only on what was kept, lost and late answers, closing, opening that fails after
 * something was sent, and recovery. Nothing here reaches the network.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `nivra session ${label} `));
  dirs.push(dir);
  return dir;
};

const KEY = "nivra-session-key-0123456789";
const PROJECT = "project-session-test-0123";
const ARCHIVE = new TextEncoder().encode("a pretend archive: the fake service never opens it");
const DIGEST = "d".repeat(64);
const SNAPSHOT = { archive: ARCHIVE, sha256: sha(new TextDecoder().decode(ARCHIVE)), listingDigest: DIGEST };
const WORKSPACE = "/workspace";

const args = (body: Record<string, unknown>) => (body["args"] as string[] | undefined) ?? [];
const isPrepare = (body: Record<string, unknown>) => args(body)[1] === PREPARE_SCRIPT;
/** What the prepare step prints when the sandbox holds exactly the snapshot. */
const prepared = (digest = DIGEST, extra: Partial<Behaviour> = {}): Behaviour => succeed({ stdout: `entries 3\ndigest ${digest}\n`, ...extra });

/** A service that prepares every session, then gives each command what `behave` says. */
function serviceFor(behave: (body: Record<string, unknown>) => Behaviour = () => succeed(), prepare: () => Behaviour = () => prepared()) {
  return new FakeService((body) => (isPrepare(body) ? prepare() : behave(body)));
}

function backendOn(service: FakeService, options: Partial<NebiusBackendOptions> & { time?: ReturnType<typeof clock>; via?: Transport } = {}) {
  const time = options.time ?? clock();
  const journalDir = options.journalDir ?? join(tempDir("journals"), "sandbox");
  const { time: _time, via, ...rest } = options;
  const backend = createNebiusBackend({
    credentials: () => ({ key: KEY, project: PROJECT }),
    baseImage: "base-image",
    journalDir,
    transport: () => via ?? service.transport,
    now: time.now,
    sleep: time.sleep,
    wallNow: () => new Date("2026-10-20T12:00:00Z"),
    ...rest,
  });
  return { backend, time, journalDir };
}

const spec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({ workspace: WORKSPACE, network: "deny", requires: { isolatesFilesystem: true }, snapshot: SNAPSHOT, ...extra });
const command = (argv: ExecRequest["argv"], extra: Partial<ExecRequest> = {}): ExecRequest => ({ argv, cwd: WORKSPACE, timeoutMs: 30_000, maxOutputBytes: 4_096, ...extra });
const spawnBodies = (service: FakeService) => service.requests.filter((r) => r.method === "POST" && r.path === "/v1/instances").map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);
const deletes = (service: FakeService) => service.requests.filter((r) => r.method === "DELETE").length;

/** Commands for the shared contract, as the fake service runs them. */
function contractService() {
  return serviceFor((body) => {
    const [program, verb, ...rest] = [body["command"] as string, ...args(body)];
    if (program !== "/bin/nivra-test") return { statuses: ["PENDING", "FAILED"] };
    if (verb === "print") return succeed({ stdout: rest[0] ?? "", stderr: rest[1] ?? "" });
    if (verb === "exit") return succeed({ exitCode: Number(rest[0]) });
    if (verb === "echo") return succeed({ stdout: rest[0] ?? "" });
    if (verb === "flood") return succeed({ stdout: "x".repeat(Math.min(Number(rest[0]), body["truncate_output_at"] as number)), truncated: true });
    // `forever`: the service's own timeout ends it, or a cancel does.
    return (body["timeout"] as number) <= 1 ? { statuses: ["EXECUTING", "SUCCESS"], timedOut: true } : { statuses: ["EXECUTING"], waits: true };
  });
}

sessionContract({
  name: "Nebius Sandboxes (the fake service)",
  makeBackend: () => backendOn(contractService()).backend,
  spec: () => spec(),
  cwd: WORKSPACE,
  shortTimeoutMs: 1_000,
  programs: {
    print: (stdout, stderr) => ["/bin/nivra-test", "print", stdout, stderr],
    exit: (code) => ["/bin/nivra-test", "exit", String(code)],
    echo: (text) => ["/bin/nivra-test", "echo", text],
    forever: () => ["/bin/nivra-test", "forever"],
    flood: (bytes) => ["/bin/nivra-test", "flood", String(bytes)],
    missing: () => ["/bin/nivra-missing"],
  },
});

describe("Nebius session: what it claims, and what it never sends (D9, D33)", () => {
  it("claims isolation, an on/off network, no injected credentials, and files kept between persisted commands", () => {
    assert.deepEqual(NEBIUS_CAPABILITIES, { isolatesFilesystem: true, networkPolicy: "onOff", injectsCredentials: false, persistsBetweenExecs: true });
  });

  it("runs every operation with networking off, sends only the snapshot and each command's own environment, and no host path or credential", async () => {
    const service = serviceFor();
    const { backend, journalDir } = backendOn(service);
    const session = await backend.open(spec());
    await session.exec(command(["/bin/sh", "-c", "true"], { env: { FOO: "bar" } }));
    await session.exec(command(["/bin/true"], { persist: false }));
    await session.close();
    const bodies = spawnBodies(service);
    assert.deepEqual(bodies.map((b) => [(b["networking"] as { enabled: boolean }).enabled, b["shell"]]), [[false, false], [false, false], [false, false]]);
    assert.deepEqual(Object.keys((bodies[0]?.["files"] as Record<string, unknown>) ?? {}), ["/nivra/snapshot.tar"], "the prepare step carries the snapshot, and nothing else");
    assert.deepEqual([bodies[1]?.["files"], bodies[2]?.["files"]], [undefined, undefined]);
    assert.deepEqual(bodies.map((b) => Object.keys(b["env"] as Record<string, string>).sort()), [["NIVRA_CORRELATION"], ["FOO", "NIVRA_CORRELATION"], ["NIVRA_CORRELATION"]]);
    assert.deepEqual([...gunzipSync(service.uploads[0] ?? new Uint8Array())], [...ARCHIVE], "the upload is the snapshot's bytes exactly, compressed");
    const sent = service.requests.map((r) => `${r.path} ${JSON.stringify(r.query ?? {})} ${typeof r.body === "string" ? r.body : ""}`).join("\n");
    for (const forbidden of [KEY, PROJECT, homedir(), tmpdir(), journalDir]) assert.equal(sent.includes(forbidden), false, `nothing sent holds ${forbidden === KEY ? "the key" : forbidden === PROJECT ? "the project id" : "a host path"}`);
  });

  it("refuses, with nothing sent, a session it can't keep to", async () => {
    const service = serviceFor();
    const { backend } = backendOn(service);
    const stopped = new AbortController();
    stopped.abort();
    const cases: Array<[SessionSpec, RegExp]> = [
      [spec({ network: "open" }), /^BoundaryUnavailableError: "Nebius Sandboxes \(remote, network off\)" runs every command with the network off, and this run asked for network access, so it was not started\./],
      [{ workspace: WORKSPACE, snapshot: SNAPSHOT }, /runs every command with the network off/],
      [spec({ network: "allowList" }), /^BoundaryUnavailableError: .* can't restrict network access/],
      [{ workspace: WORKSPACE, network: "deny" }, /^ExecRefusedError: A Nebius session starts from a snapshot of the workspace, and none was given, so nothing was sent\.$/],
      [spec({ snapshot: { ...SNAPSHOT, sha256: "0".repeat(64) } }), /^ExecRefusedError: The snapshot's bytes don't match its sha256, so nothing was sent\.$/],
      [spec({ workspace: "workspace" }), /must be a folder like \/workspace/],
      [spec({ workspace: "/" }), /must be a folder like \/workspace/],
      [spec({ signal: stopped.signal }), /^ExecRefusedError: This run was cancelled before anything was sent to the sandbox\.$/],
    ];
    for (const [given, pattern] of cases) await assert.rejects(backend.open(given), pattern);
    await assert.rejects(backendOn(service, { limits: { maxUploadBytes: 10 } }).backend.open(spec()), /^ExecRefusedError: The workspace's snapshot is \d+ bytes compressed, over the 10 Nivra sends to a sandbox, so nothing was sent\.$/);
    await assert.rejects(backendOn(service, { credentials: () => null }).backend.open(spec()), (error: Error) => error instanceof BoundaryUnavailableError && /needs your Token Factory key and a Nebius project id/.test(error.message));
    assert.equal(service.requests.length, 0);
  });

  it("refuses a command it won't send, before sending anything", async () => {
    const service = serviceFor((body) => (args(body).includes("forever") ? { statuses: ["EXECUTING"], waits: true } : succeed()));
    const { backend } = backendOn(service, { limits: { maxOperations: 3 } });
    const session = await backend.open(spec({ budgetMs: 1_000_000 }));
    const before = service.requests.length;
    const refusals: Array<[ExecRequest, RegExp]> = [
      [command(["sh", "-c", "true"]), /Give the program's full path on the sandbox's machine \(for example \/bin\/sh\); "sh" wasn't run\./],
      [command(["/bin/true"], { cwd: "/etc" }), /The command's folder, \/etc, is outside the session's workspace \(\/workspace\), so it wasn't run\./],
      [command(["/bin/true"], { cwd: "/workspace/../etc" }), /is outside the session's workspace/],
      [command(["/bin/true"], { env: { NIVRA_CORRELATION: "mine" } }), /NIVRA_CORRELATION is Nivra's own variable/],
      [command(["/bin/true"], { env: { "NOT A NAME": "x" } }), /a variable Nivra won't pass/],
      [command(["/bin/echo", `key=${KEY}`]), /holds the sandbox's key or project id, so it wasn't sent/],
      [command(["/bin/true"], { env: { WHERE: PROJECT } }), /holds the sandbox's key or project id, so it wasn't sent/],
      [command(["/bin/cat"], { stdin: new Uint8Array([1]) }), /can't give a command input, or keep its output as bytes/],
      [command(["/bin/cat"], { output: "bytes" }), /can't give a command input, or keep its output as bytes/],
      [command(["/bin/sleep", "999"], { timeoutMs: 601_000 }), /A command may run for at most 600 s here, and \/bin\/sleep asked for 601 s/],
    ];
    for (const [request, pattern] of refusals) await assert.rejects(session.exec(request), (error: Error) => error instanceof ExecRefusedError && pattern.test(error.message));
    assert.equal(service.requests.length, before, "nothing was sent for any of them");
    // One command at a time.
    const running = session.exec(command(["/bin/nivra-test", "forever"], { timeoutMs: 60_000 }));
    await settles(() => spawnBodies(service).length === 2);
    await assert.rejects(session.exec(command(["/bin/true"])), /^ExecRefusedError: One command at a time: another is still running in this session\.$/);
    const report = await session.close();
    assert.equal((await running).cancelled, true);
    assert.equal(report.stopped.length, 1);
    // A run's time and its operations are bounded too.
    const tight = await backendOn(serviceFor()).backend.open(spec({ budgetMs: 80_000 }));
    await assert.rejects(tight.exec(command(["/bin/true"], { timeoutMs: 30_000 })), /^ExecRefusedError: There isn't enough time left in this run to give \/bin\/true its 30 s, so it wasn't run\.$/);
    await tight.close();
    const counted = await backendOn(serviceFor(), { limits: { maxOperations: 2 } }).backend.open(spec());
    await counted.exec(command(["/bin/true"]));
    await assert.rejects(counted.exec(command(["/bin/true"])), /^ExecRefusedError: This session has started 2 operations, the most one session may, so \/bin\/true wasn't run\.$/);
    await counted.close();
  });
});

describe("Nebius session: one owned operation at a time, the state moving only on what was kept (D28, D33)", () => {
  it("continues from the image each persisted command leaves, and leaves the state alone after a disposable one", async () => {
    const images = ["img-A", "img-ignored", "img-C", "img-D"];
    let next = 0;
    const service = serviceFor(() => succeed({ resultImage: images[next++] ?? null }), () => prepared(DIGEST, { resultImage: "img-prepared" }));
    const session = await backendOn(service).backend.open(spec());
    const a = await session.exec(command(["/bin/true"], { label: "A" }));
    const b = await session.exec(command(["/bin/true"], { label: "B", persist: false }));
    const c = await session.exec(command(["/bin/true"], { label: "C" }));
    await session.exec(command(["/bin/true"], { label: "D" }));
    const report = await session.close();
    assert.deepEqual(spawnBodies(service).map((body) => [body["image"], body["disposable"]]), [["base-image", false], ["img-prepared", false], ["img-A", true], ["img-A", false], ["img-C", false]]);
    assert.deepEqual([a.persisted, b.persisted, c.persisted], [true, false, true]);
    assert.deepEqual(report.steps.map((s) => [s.label, s.persisted]), [["prepare", true], ["A", true], ["B", false], ["C", true], ["D", true]]);
  });

  it("keeps a failing command's exit code apart from the operation's status, and that command's changes still count", async () => {
    const service = serviceFor((body) => (args(body).includes("/workspace/test.sh") ? succeed({ exitCode: 1, stdout: "FAIL: expected 'Hello, world'" }) : succeed()));
    const session = await backendOn(service).backend.open(spec());
    const failed = await session.exec(command(["/bin/sh", "/workspace/test.sh"]));
    assert.deepEqual([failed.exitCode, failed.signal, failed.timedOut, failed.cancelled, failed.persisted, failed.stdout], [1, null, false, false, true, "FAIL: expected 'Hello, world'"]);
    assert.equal((await session.exec(command(["/bin/true"]))).exitCode, 0, "the session goes on");
    await session.close();
  });

  it("leaves the session stale when a persisted command's changes weren't kept, and never runs the next one on the older image", async () => {
    const cases: Array<[Behaviour, RegExp]> = [
      [succeed({ resultImage: null }), /its answer named no image the sandbox kept/],
      [succeed({ resultImage: "not an image id" }), /its answer named no image the sandbox kept/],
      [{ statuses: ["EXECUTING", "SUCCESS"], timedOut: true }, /it timed out/],
      [succeed({ exitCode: -1, signal: 15 }), /a signal ended it/],
    ];
    for (const [behaviour, why] of cases) {
      const service = serviceFor(() => behaviour);
      const session = await backendOn(service).backend.open(spec());
      const result = await session.exec(command(["/bin/sh", "-c", "make"], { label: "build" }));
      assert.equal(result.persisted, false);
      const spawned = spawnBodies(service).length;
      await assert.rejects(session.exec(command(["/bin/true"])), (error: Error) => error instanceof ExecRefusedError && /^The sandbox didn't keep the result of an earlier command \(build: /.test(error.message) && why.test(error.message) && /Start again from the commit\.$/.test(error.message));
      assert.equal(spawnBodies(service).length, spawned, "nothing ran on the older image");
      await assert.rejects(session.download!("/nivra/out/result.tar", 1_000), /^ExecRefusedError: Nothing can be read from this session now \(build: /);
      await session.close();
    }
  });

  it("treats an image the service no longer has as lost state, and never recreates the work from the snapshot", async () => {
    const service = serviceFor(() => succeed({ resultImage: "img-A" }));
    const session = await backendOn(service).backend.open(spec());
    await session.exec(command(["/bin/true"]));
    service.expiredImages.add("img-A");
    await assert.rejects(session.exec(command(["/bin/true"])), /^ExecRefusedError: The sandbox no longer has this workspace's saved state \(HTTP 410\), so \/bin\/true wasn't run and nothing more can run in this session\. Start again from the commit\.$/);
    await assert.rejects(session.exec(command(["/bin/true"])), /no longer has this workspace's saved state \(its image answered HTTP 410\)/);
    await session.close();
    assert.deepEqual([service.uploads.length, spawnBodies(service).filter((body) => body["image"] === "base-image").length], [1, 1], "no second upload, and nothing started again from the base image");
  });

  it("says when output was cut, by the service or by the command's own cap", async () => {
    const service = serviceFor((body) => (args(body)[0] === "service" ? succeed({ stdout: "x".repeat(100), truncated: true }) : succeed({ stdout: "y".repeat(5_000) })));
    const session = await backendOn(service).backend.open(spec());
    const byService = await session.exec(command(["/bin/out", "service"]));
    const byCap = await session.exec(command(["/bin/out", "local"], { maxOutputBytes: 1_000 }));
    assert.deepEqual([byService.truncated, byService.stdout.length, byCap.truncated, byCap.stdout.length], [true, 100, true, 1_000]);
    assert.equal(spawnBodies(service).at(-1)?.["truncate_output_at"], 1_000);
    await session.close();
  });

  it("reads a file from the workspace's machine as it now stands, bounded, and says when there is none", async () => {
    const service = serviceFor(() => succeed({ resultImage: "img-out", files: { "/nivra/out/result.tar": "the result" } }));
    const session = await backendOn(service).backend.open(spec());
    await session.exec(command(["/bin/sh", "-c", "collect"]));
    const file = await session.download!("/nivra/out/result.tar", 1_000);
    assert.deepEqual([new TextDecoder().decode(file.bytes), file.sha256], ["the result", sha("the result")]);
    await assert.rejects(session.download!("/nivra/out/missing", 1_000), /^ExecRefusedError: There's no file at \/nivra\/out\/missing in the sandbox\.$/);
    await assert.rejects(session.download!("/nivra/out/result.tar", 5), /is longer than the 5 bytes asked for/);
    await assert.rejects(session.download!("relative/path", 5), /full path on the sandbox's machine/);
    await session.close();
  });
});

describe("Nebius session: lost answers, late answers and deadlines (D33)", () => {
  it("finds a command whose spawn answer was lost, follows it to its end, and sends it once", async () => {
    const service = serviceFor(() => succeed({ stdout: "found" }));
    const session = await backendOn(service).backend.open(spec());
    service.dropNextSpawnAnswer = true;
    const result = await session.exec(command(["/bin/true"]));
    assert.deepEqual([result.stdout, service.spawns], ["found", 2]);
    await session.close();
  });

  it("never sends a command again when its spawn can't be found, runs nothing more, and closing looks for it once more", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const session = await backendOn(service).backend.open(spec());
    service.dropNextSpawnAnswer = true;
    service.hideNextSpawn = true;
    await assert.rejects(session.exec(command(["/bin/true"], { label: "lost" })), (error: Error) => error instanceof ExecUncertainError && /^It isn't known whether \/bin\/true started \(no operation with its correlation id was found within/.test(error.message));
    await assert.rejects(session.exec(command(["/bin/true"])), /^ExecRefusedError: An earlier command in this session wasn't settled \(it isn't known whether lost started\)/);
    const report = await session.close();
    assert.deepEqual([service.spawns, report.unresolved.length, /^It isn't known whether "lost" started \(correlation [0-9a-f-]+\); it may still be running\.$/.test(report.unresolved[0] ?? "")], [2, 1, true]);
  });

  it("takes no late answer: a spawn answered after the run's deadline is only stopped, never followed", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    let late = false;
    // The command's spawn is answered 250 s later, past the session's 200 s.
    const via: Transport = async (request) => {
      const response = await service.transport(request);
      if (late && request.method === "POST" && request.path === "/v1/instances") await time.sleep(250_000);
      return response;
    };
    const session = await backendOn(service, { time, via }).backend.open(spec({ budgetMs: 200_000 }));
    late = true;
    await assert.rejects(session.exec(command(["/bin/sleep", "60"])), (error: Error) => error instanceof ExecUncertainError && /was started, but its answer came only after the run's deadline or its cancellation, so Nivra didn't follow it; closing the session stops it\.$/.test(error.message));
    const report = await session.close();
    assert.deepEqual([report.stopped.length, report.unresolved, service.operations.at(-1)?.cancelled], [1, [], true]);
  });

  it("gives up a read whose Retry-After runs past the deadline, and leaves the command for closing to stop", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const session = await backendOn(service).backend.open(spec());
    await assert.rejects(session.exec(command(["/bin/sleep", "60"], { onStart: () => (service.rateLimitNextRead = 100_000) })), (error: Error) => error instanceof ExecUncertainError && /wasn't seen to end before the run's time ran out/.test(error.message));
    const report = await session.close();
    assert.deepEqual([report.stopped.length, report.unresolved], [1, []]);
  });
});

describe("Nebius session: closing, and what it settles (D33)", () => {
  it("closes once, within one budget that includes stopping the command under way, and never rejects", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const { backend, time } = backendOn(service);
    const session = await backend.open(spec());
    const running = session.exec(command(["/bin/sleep", "60"], { timeoutMs: 60_000 }));
    await settles(() => spawnBodies(service).length === 2);
    const started = time.now();
    const report = await session.close({ budgetMs: 120_000 });
    assert.deepEqual([(await running).cancelled, report.stopped.length, report.unresolved], [true, 1, []]);
    assert.ok(time.now() - started <= 120_000, "closing kept to its budget, the cancel included");
    const requests = service.requests.length;
    assert.equal(await session.close(), report, "a second close gives the first one's report");
    assert.equal(service.requests.length, requests, "and sends nothing");
  });

  it("tells an operation it stopped from one that had already ended", async () => {
    const service = serviceFor(() => ({ statuses: ["SUCCESS"], exitCode: 0 }));
    const session = await backendOn(service).backend.open(spec());
    // Its end isn't seen in time, so closing asks it to stop: it had already ended.
    await assert.rejects(session.exec(command(["/bin/true"], { onStart: () => (service.rateLimitNextRead = 100_000) })), ExecUncertainError);
    const report = await session.close();
    assert.deepEqual([report.stopped, report.alreadyEnded.length, report.unresolved], [[], 1, []]);
  });

  it("reports what it couldn't stop, within its budget, and what the service keeps", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const { backend, time } = backendOn(service, { limits: { cancelWaitMs: 10_000 } });
    const session = await backend.open(spec());
    service.ignoreCancels = true;
    const running = session.exec(command(["/bin/sleep", "60"], { timeoutMs: 60_000 }));
    await settles(() => spawnBodies(service).length === 2);
    const started = time.now();
    const report = await session.close({ budgetMs: 30_000 });
    await assert.rejects(running, (error: Error) => error instanceof ExecUncertainError && /asked the sandbox to stop \/bin\/sleep, but it wasn't seen to stop/.test(error.message));
    assert.ok(time.now() - started <= 30_000, `closing kept to its 30 s, not ${time.now() - started} ms`);
    assert.deepEqual([report.stopped, report.unresolved.length, /wasn't seen to end; it may still be running\.$/.test(report.unresolved[0] ?? "")], [[], 1, true]);
    assert.deepEqual(report.retained, { uploads: 1, images: 1, operations: 2, note: RETENTION });
  });

  it("never rejects, even when every request fails", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    let broken = false;
    const via: Transport = async (request) => {
      if (broken) throw new Error("the connection is gone");
      return service.transport(request);
    };
    const session = await backendOn(service, { via, limits: { cancelWaitMs: 5_000, searchMs: 5_000 } }).backend.open(spec());
    await assert.rejects(session.exec(command(["/bin/sleep", "60"], { onStart: () => (service.rateLimitNextRead = 100_000) })), ExecUncertainError);
    broken = true;
    const report = await session.close({ budgetMs: 20_000 });
    assert.equal(report.unresolved.length, 1);
  });
});

describe("Nebius session: the snapshot is uploaded compressed (NIV-49)", () => {
  const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  /** Every entry of every journal in `journalDir`, settled ones included. */
  const journalEntries = (journalDir: string) =>
    [journalDir, join(journalDir, "settled")]
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".jsonl")).flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)));

  it("uploads the tar gzip-compressed, the same bytes every time, and journals the tar's sha256 as the session's snapshot and the compressed bytes as the upload", async () => {
    const service = serviceFor();
    const { backend, journalDir } = backendOn(service);
    for (let i = 0; i < 2; i++) await (await backend.open(spec())).close();
    assert.equal(service.uploads.length, 2);
    const [first, second] = service.uploads.map((bytes) => Buffer.from(bytes));
    assert.ok(first!.equals(second!), "the same tar was compressed to different bytes");
    assert.deepEqual([...first!.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255], "gzip at level 9, with no time and no system in its header");
    assert.ok(first!.equals(Buffer.from(compressSnapshot(ARCHIVE))));
    assert.ok(Buffer.from(gunzipSync(first!)).equals(Buffer.from(ARCHIVE)), "the upload isn't the snapshot's tar, compressed");
    const entries = journalEntries(journalDir);
    assert.deepEqual(
      entries.filter((entry) => entry["kind"] === "session").map((entry) => entry["snapshotSha256"]),
      [SNAPSHOT.sha256, SNAPSHOT.sha256],
    );
    assert.deepEqual(
      entries.filter((entry) => entry["kind"] === "upload").map((entry) => [entry["sha256"], entry["bytes"]]),
      [
        [hex(first!), first!.byteLength],
        [hex(first!), first!.byteLength],
      ],
    );
  });

  it("opens a snapshot whose tar is over the upload limit when it compresses under it, and refuses one that doesn't, with nothing sent", async () => {
    const text = new TextEncoder().encode("export const line = 'a line of source, repeated as source repeats itself';\n".repeat(130_000));
    const big = writeTar([{ path: "src/big.ts", kind: "file", executable: false, bytes: text }]);
    assert.ok(big.byteLength > NEBIUS_LIMITS.maxUploadBytes, `the tar is only ${big.byteLength} bytes`);
    const listing = listingDigest([{ path: "src/big.ts", kind: "file", executable: false, sha256: hex(text) }]).digest;
    const guest = new FakeGuest();
    guest.quick = true;
    const session = await backendOn(guest.service).backend.open(spec({ snapshot: { archive: big, sha256: hex(big), listingDigest: listing } }));
    await session.close();
    const sent = guest.service.uploads[0]?.byteLength ?? Number.POSITIVE_INFINITY;
    assert.ok(sent < NEBIUS_LIMITS.maxUploadBytes, `${sent} bytes were sent`);
    // The guest decompressed and extracted it, and its listing had the snapshot's digest: the session opened.
    const extracted = guest.workspaces.get("img-guest-1")?.get("src/big.ts");
    assert.deepEqual([extracted?.kind, extracted?.kind === "file" ? extracted.bytes.byteLength : null], ["file", text.byteLength]);

    const noise = writeTar([{ path: "noise.bin", kind: "file", executable: false, bytes: randomBytes(NEBIUS_LIMITS.maxUploadBytes) }]);
    const refused = serviceFor();
    await assert.rejects(
      backendOn(refused).backend.open(spec({ snapshot: { archive: noise, sha256: hex(noise), listingDigest: DIGEST } })),
      /^ExecRefusedError: The workspace's snapshot is \d+ bytes compressed, over the 8388608 Nivra sends to a sandbox, so nothing was sent\.$/,
    );
    assert.equal(refused.requests.length, 0);
  });
});

describe("Nebius session: an open that fails after something was sent closes itself (D33)", () => {
  const opening = async (service: FakeService, given: Partial<SessionSpec> = {}, via?: Transport) => {
    const error = await backendOn(service, via ? { via } : {}).backend.open(spec(given)).then(
      () => assert.fail("the session opened"),
      (failure: Error) => failure,
    );
    assert.ok(error instanceof SessionOpenError, `${error.name}: ${error.message}`);
    return error;
  };

  it("when the service stored different bytes", async () => {
    const service = serviceFor();
    service.wrongUploadHash = true;
    const error = await opening(service);
    assert.match(error.message, /^The sandbox stored different bytes from the ones Nivra sent, so the session was stopped\.$/);
    assert.deepEqual([spawnBodies(service).length, error.report.retained?.uploads], [0, 1]);
  });

  it("when the sandbox's copy doesn't match the snapshot", async () => {
    const service = serviceFor(() => succeed(), () => prepared("e".repeat(64)));
    const error = await opening(service);
    assert.match(error.message, /its listing differs/);
    assert.deepEqual([error.report.retained?.uploads, error.report.retained?.images, error.report.steps.map((s) => s.label)], [1, 1, ["prepare"]]);
  });

  it("when preparing fails", async () => {
    const error = await opening(serviceFor(() => succeed(), () => succeed({ exitCode: 1 })));
    assert.match(error.message, /^Preparing the workspace in the sandbox didn't finish \(command-failed\), so the session was stopped\.$/);
  });

  it("when the upload was cut off, which may still have stored it", async () => {
    const service = serviceFor();
    const stopping = new AbortController();
    const { transport, held } = holding(service, (request) => request.path === "/v1/files");
    const opened = backendOn(service, { via: transport }).backend.open(spec({ signal: stopping.signal }));
    await settles(() => held.length === 1);
    stopping.abort();
    const error = await opened.then(
      () => assert.fail("the session opened"),
      (failure: Error) => failure,
    );
    assert.ok(error instanceof SessionOpenError);
    assert.match(error.message, /^Sending the workspace failed \(Uploading a file was cancelled\.\), and the service may have stored it anyway\.$/);
    assert.deepEqual([spawnBodies(service).length, error.report.retained?.uploads], [0, 1]);
  });
});

describe("Nebius session: recovery, a local scan and then one bounded pass (D33)", () => {
  /** A session left by an engine that stopped: its command's end wasn't seen, and it never closed. */
  async function abandoned(service: FakeService, journalDir: string, time: ReturnType<typeof clock>): Promise<void> {
    const session: ExecutionSession = await backendOn(service, { journalDir, time }).backend.open(spec());
    await assert.rejects(session.exec(command(["/bin/sleep", "60"], { onStart: () => (service.rateLimitNextRead = 100_000) })), ExecUncertainError);
  }

  it("finds what an earlier engine left with no network, and settles it in one pass on one budget; a pass that runs out leaves the rest", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const journalDir = join(tempDir("recovery"), "sandbox");
    await abandoned(service, journalDir, time);
    await abandoned(service, journalDir, time);
    const before = service.requests.length;
    const scans = scanJournals(journalDir).open;
    assert.deepEqual([scans.length, scans.every((s) => s.operations.length === 1 && s.damaged === null), service.requests.length - before], [2, true, 0]);
    // The first pass has room for one journal: its cancel is never seen to end, and the budget is gone.
    service.ignoreCancels = true;
    const options = { credentials: { key: KEY, project: PROJECT }, transport: () => service.transport, now: time.now, sleep: time.sleep, limits: { cancelWaitMs: 10_000 } };
    const first = await reconcileJournals(scans, { ...options, budgetMs: 12_000 });
    assert.deepEqual(first.map((r) => [r.stopped.length, r.unresolved.length]), [[0, 1], [0, 1]]);
    assert.match(first[1]?.unresolved[0] ?? "", /^Not looked at in this pass: it ran out of time\. It stays for the next\.$/);
    service.ignoreCancels = false;
    const second = await reconcileJournals(scanJournals(journalDir).open, { ...options, budgetMs: 120_000 });
    assert.deepEqual(second.map((r) => [r.stopped.length, r.unresolved]), [[1, []], [1, []]]);
    assert.deepEqual(scanJournals(journalDir).open, []);
  });

  it("never searches for an image import whose answer was lost: it carries no correlation id, so it stays open and says where to look (NIV-49)", async () => {
    const service = serviceFor();
    const time = clock();
    const journalDir = join(tempDir("import"), "sandbox");
    mkdirSync(journalDir, { recursive: true });
    const journal = new Journal(join(journalDir, "import.jsonl"));
    const correlation = "0f1e2d3c-4b5a-4968-8776-655443322110";
    journal.append({ kind: "intent", wall: new Date().toISOString(), correlation, label: "image import" });
    journal.append({ kind: "uncertain", wall: new Date().toISOString(), correlation, cause: "the connection dropped" });
    const started = time.now();
    const pass = await reconcileJournals(scanJournals(journalDir).open, { credentials: { key: KEY, project: PROJECT }, transport: () => service.transport, now: time.now, sleep: time.sleep, budgetMs: 600_000 });
    assert.equal(service.requests.filter((request) => request.path === "/v1/operations").length, 0, "the pass searched for the import");
    assert.equal(time.now() - started, 0, "the pass spent time on the import");
    assert.deepEqual(pass.map((r) => [r.stopped.length, r.unresolved]), [[0, ["It isn't known whether an image import started, and Nivra can't look for one: any image it made is in your Nebius project."]]]);
    assert.equal(safeUnresolved(pass[0]!.unresolved[0]!), pass[0]!.unresolved[0], "its words don't leave the engine as written");
    assert.equal(scanJournals(journalDir).open.length, 1, "the import was settled without being found");
  });

  it("stops a pass when the engine shuts down partway, keeping what it didn't settle for the next", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const journalDir = join(tempDir("shutdown"), "sandbox");
    await abandoned(service, journalDir, time);
    await abandoned(service, journalDir, time);
    service.ignoreCancels = true;
    const shutdown = new AbortController();
    // The shutdown comes while the first journal's cancel is being waited on.
    const sleep = async (ms: number) => {
      shutdown.abort();
      await time.sleep(ms);
    };
    const pass = await reconcileJournals(scanJournals(journalDir).open, { credentials: { key: KEY, project: PROJECT }, transport: () => service.transport, now: time.now, sleep, budgetMs: 600_000, signal: shutdown.signal });
    assert.deepEqual(pass.map((r) => [r.stopped.length, r.unresolved.length]), [[0, 1], [0, 1]]);
    assert.match(pass[1]?.unresolved[0] ?? "", /^Not looked at in this pass: it was stopped\. It stays for the next\.$/);
    assert.equal(scanJournals(journalDir).open.length, 2, "both stay open for the next pass");
  });

  it("never settles an operation by its age: one queued past its timeout and margins stays unresolved, and is found and stopped later", async () => {
    const service = serviceFor(() => ({ statuses: ["PENDING"], waits: false }));
    const time = clock();
    const journalDir = join(tempDir("queued"), "sandbox");
    const session = await backendOn(service, { journalDir, time }).backend.open(spec());
    service.dropNextSpawnAnswer = true;
    service.hideNextSpawn = true;
    await assert.rejects(session.exec(command(["/bin/sleep", "60"], { label: "queued" })), ExecUncertainError);
    const options = { credentials: { key: KEY, project: PROJECT }, transport: () => service.transport, now: time.now, sleep: time.sleep, budgetMs: 600_000 };
    // Ten hours later, far past its 60 s timeout and every margin, it is still unresolved, not retired.
    await time.sleep(10 * 60 * 60 * 1000);
    const late = await reconcileJournals(scanJournals(journalDir).open, options);
    assert.deepEqual(late.map((r) => [r.stopped.length, r.unresolved.length]), [[0, 1]]);
    assert.match(late[0]?.unresolved[0] ?? "", /^It isn't known whether "queued" started/);
    // Once the service lists it again, the next pass finds it and stops it.
    service.hidden.clear();
    const found = await reconcileJournals(scanJournals(journalDir).open, options);
    assert.deepEqual(found.map((r) => [r.stopped.length, r.unresolved]), [[1, []]]);
    assert.equal(service.operations.at(-1)?.cancelled, true);
  });

  it("reports a journal it can't read, rather than guessing what it held", () => {
    const journalDir = tempDir("damaged");
    writeFileSync(join(journalDir, "broken.jsonl"), "not a journal line\n");
    const [scan] = scanJournals(journalDir).open;
    assert.match(scan?.damaged ?? "", /is damaged at line 1/);
  });
});

describe("Nebius session: what the independent review of B1 found, each failing on the code before its fix", () => {
  /** A clock whose sleeps also give way to other work, so a close can begin while a stop is still waiting. */
  function yieldingClock() {
    const base = clock();
    return { now: base.now, waits: base.waits, sleep: async (ms: number) => (await new Promise((resolve) => setImmediate(resolve)), await base.sleep(ms)) };
  }

  it("keeps a close to its budget and signal when the person's cancel began the stop before it", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = yieldingClock();
    const session = await backendOn(service, { time }).backend.open(spec());
    // The cancel is accepted, but the operation never stops: the stop would wait its 60 s.
    service.ignoreCancels = true;
    const person = new AbortController();
    const running = session.exec(command(["/bin/sleep", "60"], { timeoutMs: 60_000, signal: person.signal, onStart: () => person.abort() }));
    await settles(() => service.requests.some((r) => r.method === "DELETE"));
    const engine = new AbortController();
    const started = time.now();
    const closing = session.close({ budgetMs: 5_000, signal: engine.signal });
    engine.abort();
    const report = await closing;
    await assert.rejects(running, ExecUncertainError);
    assert.ok(time.now() - started <= 5_000, `closing took ${time.now() - started} ms of its 5,000`);
    assert.equal(report.unresolved.length, 1);
  });

  it("cuts a torn last line off before the next entry, so a crash leaves no damage and the next pass settles it", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const journalDir = join(tempDir("torn"), "sandbox");
    const session = await backendOn(service, { journalDir, time }).backend.open(spec());
    await assert.rejects(session.exec(command(["/bin/sleep", "60"], { onStart: () => (service.rateLimitNextRead = 100_000) })), ExecUncertainError);
    // The engine died in the middle of a write.
    const [name] = readdirSync(journalDir).filter((file) => file.endsWith(".jsonl"));
    appendFileSync(join(journalDir, name!), '{"kind":"cancel","wall":"2026-10-20T12:00:00.000Z","operat');
    const { open } = scanJournals(journalDir);
    assert.deepEqual(open.map((s) => [s.damaged, s.operations.length]), [[null, 1]]);
    const [result] = await reconcileJournals(open, { credentials: { key: KEY, project: PROJECT }, transport: () => service.transport, now: time.now, sleep: time.sleep, budgetMs: 120_000 });
    assert.deepEqual([result?.stopped.length, result?.unresolved], [1, []]);
    assert.ok(existsSync(join(journalDir, "settled", name!)), "settled, and moved aside");
  });

  it("keeps passing over the rest when one journal can't be read", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const time = clock();
    const journalDir = join(tempDir("one damaged"), "sandbox");
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(join(journalDir, "0-damaged.jsonl"), "not a journal line\n");
    const session = await backendOn(service, { journalDir, time }).backend.open(spec());
    await assert.rejects(session.exec(command(["/bin/sleep", "60"], { onStart: () => (service.rateLimitNextRead = 100_000) })), ExecUncertainError);
    const results = await reconcileJournals(scanJournals(journalDir).open, { credentials: { key: KEY, project: PROJECT }, transport: () => service.transport, now: time.now, sleep: time.sleep, budgetMs: 120_000 });
    assert.deepEqual(results.map((r) => [r.stopped.length, r.unresolved.length]), [[0, 1], [1, 0]]);
  });

  it("finds open work however many settled journals sort before it, and moves a clean session's journal aside", async () => {
    const journalDir = join(tempDir("many"), "sandbox");
    mkdirSync(journalDir, { recursive: true });
    for (let i = 0; i < 600; i++) writeFileSync(join(journalDir, `${String(i).padStart(4, "0")}.jsonl`), `${JSON.stringify({ kind: "intent", wall: "w", correlation: `c${i}`, label: "x" })}\n${JSON.stringify({ kind: "refused", wall: "w", correlation: `c${i}`, status: 400 })}\n`);
    writeFileSync(join(journalDir, "zzzz.jsonl"), `${JSON.stringify({ kind: "intent", wall: "w", correlation: "open", label: "x" })}\n`);
    const scan = scanJournals(journalDir);
    assert.deepEqual([scan.open.map((s) => s.uncertain.map((u) => u.correlation)), scan.unread], [[["open"]], 0]);
    const service = serviceFor();
    const cleanDir = join(tempDir("clean"), "sandbox");
    const session = await backendOn(service, { journalDir: cleanDir }).backend.open(spec());
    await session.exec(command(["/bin/true"]));
    assert.deepEqual((await session.close()).unresolved, []);
    assert.deepEqual([readdirSync(cleanDir).filter((file) => file.endsWith(".jsonl")).length, readdirSync(join(cleanDir, "settled")).length], [0, 1]);
  });

  it("counts every image the service keeps, one first seen when closing included", async () => {
    // It had ended, with an image, before closing asked it to stop.
    const service = serviceFor(() => ({ statuses: ["SUCCESS"], exitCode: 0, resultImage: "img-late" }));
    const session = await backendOn(service).backend.open(spec());
    await assert.rejects(session.exec(command(["/bin/true"], { onStart: () => (service.rateLimitNextRead = 100_000) })), ExecUncertainError);
    const report = await session.close();
    assert.deepEqual([report.alreadyEnded.length, report.retained?.images], [1, 2]);
  });

  it("never reports as not started a command the service made, when its answer came as the run was cancelled", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    const person = new AbortController();
    let armed = false;
    // The service makes the operation; the person's cancel lands as its answer arrives.
    const via: Transport = async (request) => {
      const response = await service.transport(request);
      if (armed && request.method === "POST" && request.path === "/v1/instances") person.abort();
      return response;
    };
    const session = await backendOn(service, { via }).backend.open(spec());
    armed = true;
    await assert.rejects(session.exec(command(["/bin/sleep", "60"], { signal: person.signal })), (error: Error) => error instanceof ExecUncertainError && /was started, but its answer came only after the run's deadline or its cancellation/.test(error.message));
    await assert.rejects(session.exec(command(["/bin/true"])), /^ExecRefusedError: An earlier command in this session wasn't settled/);
    const report = await session.close();
    assert.deepEqual([report.stopped.length, service.operations.at(-1)?.cancelled, report.retained?.operations], [1, true, 2]);
  });

  it("leaves no listener on a long-lived run signal once each session is closed", async () => {
    const longLived = new AbortController();
    const { backend } = backendOn(serviceFor());
    for (let i = 0; i < 3; i++) await (await backend.open(spec({ signal: longLived.signal }))).close();
    assert.equal(getEventListeners(longLived.signal, "abort").length, 0);
  });

  it("follows a command to its end when the caller's onStart throws, then gives that error back, with the session still sound", async () => {
    const service = serviceFor();
    const session = await backendOn(service).backend.open(spec());
    await assert.rejects(
      session.exec(command(["/bin/true"], {
        onStart: () => {
          throw new Error("the caller's own bug");
        },
      })),
      /^Error: the caller's own bug$/,
    );
    assert.equal((await session.exec(command(["/bin/true"]))).exitCode, 0);
    await session.close();
  });

  it("names a Linux signal by Linux's numbers, whatever the engine's platform", () => {
    assert.deepEqual(
      [signalName(-1), signalName(0), signalName(9), signalName(15), signalName(21), signalName(22), signalName(64), signalName("SIGTERM"), signalName("-1"), signalName(null)],
      [null, null, "SIGKILL", "SIGTERM", "SIGTTIN", "SIGTTOU", "signal 64", "SIGTERM", null, null],
    );
  });
});

describe("Nebius session: what the review of PR 7 found, failing on the code before its fix", () => {
  /** `promise`'s value, or `fallback` once `ms` of real time have passed first. */
  async function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<F>((resolve) => (timer = setTimeout(resolve, ms, fallback)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("cuts off a cancel already under way when closing's budget runs out, with no signal, and keeps its operation for the next pass", async () => {
    const service = serviceFor(() => ({ statuses: ["EXECUTING"], waits: true }));
    // The person's cancel sends the stop's DELETE, and its connection then waits, as one to a slow service would: only
    // its signal ends it here. A real one would end at the 30 s it was given when it was sent, long after closing's 50.
    let slow = true;
    const { transport, held } = holding(service, (request) => slow && request.method === "DELETE");
    const time = clock();
    const journalDir = join(tempDir("close expiry"), "sandbox");
    const session = await backendOn(service, { via: transport, time, journalDir }).backend.open(spec());
    const person = new AbortController();
    const running = session.exec(command(["/bin/sleep", "60"], { timeoutMs: 60_000, signal: person.signal, onStart: () => person.abort() }));
    await settles(() => held.length === 1);
    const started = performance.now();
    const closing = session.close({ budgetMs: 50 });
    const ended = await within(closing.then(() => "closed"), 5_000, "still waiting");
    const tookMs = performance.now() - started;
    assert.equal(ended, "closed", "closing waited on the cancel past its budget");
    assert.ok(tookMs < 2_000, `closing took ${Math.round(tookMs)} ms of its 50`);
    // Closing ended the stop and sends nothing more, so the command's error promises no retry from it.
    await assert.rejects(running, (error: Error) => error instanceof ExecUncertainError && /wasn't seen to stop; it stays journaled, and the next recovery pass looks for it again\.$/.test(error.message));
    const report = await closing;
    assert.deepEqual([held.length, report.stopped, report.unresolved.length], [1, [], 1]);
    assert.match(report.unresolved[0] ?? "", /wasn't seen to end; it may still be running\.$/);
    // What closing couldn't settle stays journaled, and the next pass settles it.
    const { open } = scanJournals(journalDir);
    assert.deepEqual(open.map((scan) => scan.operations.length), [1]);
    slow = false;
    const [result] = await reconcileJournals(open, { credentials: { key: KEY, project: PROJECT }, transport: () => service.transport, now: time.now, sleep: time.sleep, budgetMs: 120_000 });
    assert.deepEqual([result?.stopped.length, result?.unresolved], [1, []]);
  });
});

describe("Nebius session: the prepare step's listing, checked with this machine's own tools", () => {
  it("prints the digest Nivra computes for the same files", { skip: process.platform === "win32" ? "needs a POSIX shell and tar" : false }, () => {
    const root = tempDir("listing");
    const source = join(root, "source");
    mkdirSync(join(source, "bin"), { recursive: true });
    mkdirSync(join(source, "dir with space"), { recursive: true });
    writeFileSync(join(source, "a.txt"), "hello\n");
    writeFileSync(join(source, "bin", "run.sh"), "#!/bin/sh\necho run\n");
    chmodSync(join(source, "bin", "run.sh"), 0o755);
    writeFileSync(join(source, "dir with space", "ü.txt"), "unicode\n");
    writeFileSync(join(source, "empty"), "");
    symlinkSync("a.txt", join(source, "link"));
    // Names whose order under LC_ALL=C (by byte) differs from a locale's (which ignores case and punctuation first).
    writeFileSync(join(source, "B.txt"), "upper\n");
    writeFileSync(join(source, "a-b"), "dash\n");
    writeFileSync(join(source, "a_b"), "underscore\n");
    const plain = join(root, "plain.tar");
    const tar = spawnSync("tar", ["-c", "-f", plain, "-C", source, "."], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    // As the session uploads it: compressed. The digest is the listing's, whatever carried the files.
    const archive = join(root, "snapshot.tar");
    writeFileSync(archive, compressSnapshot(readFileSync(plain)));
    const workspace = join(root, "workspace");
    const listing = join(root, "listing");
    const ran = spawnSync("/bin/sh", ["-c", PREPARE_SCRIPT, "nivra-prepare", workspace, archive, "", listing], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const expected: ListingEntry[] = [
      { path: "a.txt", kind: "file", executable: false, sha256: sha("hello\n") },
      { path: "bin/run.sh", kind: "file", executable: true, sha256: sha("#!/bin/sh\necho run\n") },
      { path: "dir with space/ü.txt", kind: "file", executable: false, sha256: sha("unicode\n") },
      { path: "empty", kind: "file", executable: false, sha256: sha("") },
      { path: "link", kind: "link", target: "a.txt" },
      { path: "B.txt", kind: "file", executable: false, sha256: sha("upper\n") },
      { path: "a-b", kind: "file", executable: false, sha256: sha("dash\n") },
      { path: "a_b", kind: "file", executable: false, sha256: sha("underscore\n") },
    ];
    const { digest, entries } = listingDigest(expected);
    assert.deepEqual([/^entries\s+(\d+)$/m.exec(ran.stdout)?.[1], /^digest ([0-9a-f]{64})$/m.exec(ran.stdout)?.[1]], [String(entries), digest], readFileSync(listing, "utf8"));
    assert.equal(existsSync(archive), false, "the archive is removed once extracted");
  });

  it("extracts over what the workspace already holds, and leaves out only the dependency and build folders in it, at any depth", { skip: process.platform === "win32" ? "needs a POSIX shell and tar" : false }, () => {
    const root = tempDir("prepared listing");
    const source = join(root, "source");
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, "src", "a.js"), "export const a = 1;\n");
    // Named like output folders, but a file and a link: the commit's own, so listed.
    writeFileSync(join(source, "out"), "a file named out\n");
    symlinkSync("src", join(source, "dist"));
    const plain = join(root, "plain.tar");
    const tar = spawnSync("tar", ["-c", "-f", plain, "-C", source, "."], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    const { digest } = listingDigest([
      { path: "src/a.js", kind: "file", executable: false, sha256: sha("export const a = 1;\n") },
      { path: "out", kind: "file", executable: false, sha256: sha("a file named out\n") },
      { path: "dist", kind: "link", target: "src" },
    ]);
    /** The digest the prepare step prints for the snapshot extracted over a workspace holding `held`. */
    const printed = (held: Record<string, string>) => {
      const guest = tempDir("prepared guest");
      const workspace = join(guest, "workspace");
      for (const [path, text] of Object.entries(held)) {
        mkdirSync(dirname(join(workspace, path)), { recursive: true });
        writeFileSync(join(workspace, path), text);
      }
      writeFileSync(join(guest, "snapshot.tar"), compressSnapshot(readFileSync(plain)));
      const ran = spawnSync("/bin/sh", ["-c", PREPARE_SCRIPT, "nivra-prepare", workspace, join(guest, "snapshot.tar"), "", join(guest, "listing")], { encoding: "utf8" });
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(readFileSync(join(workspace, "node_modules", "dep", "index.js"), "utf8"), "dep\n", "the workspace was emptied");
      return /^digest ([0-9a-f]{64})$/m.exec(ran.stdout)?.[1];
    };
    const dependencies = { "node_modules/dep/index.js": "dep\n", "packages/a/node_modules/dep/index.js": "dep\n", "packages/a/.next/cache/x": "x\n", "coverage/lcov.info": "x\n", "crates/b/target/debug/b": "x\n" };
    assert.equal(printed(dependencies), digest);
    assert.notEqual(printed({ ...dependencies, "packages/a/index.js": "stray\n" }), digest, "a file outside the dependency folders was left out");
  });
});
