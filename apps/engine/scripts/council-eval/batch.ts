import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTerminal, LineSplitter, PROTOCOL_VERSION, RpcCallError, RpcClient, type ReviewReport, type RunEvent, type RunSummary } from "@nivra/domain";
import { canonical, requestFor, runOrder, type Arm, type FixtureId, type Frozen } from "./files.ts";
import { endpointFor, endpointFromDoctor, modelNow, preflightProblem } from "./preflight.ts";
import type { RunRecord } from "./score.ts";

/**
 * The evaluation's batch (NIV-40): every run, one at a time, on a real engine over stdio, in a home inside the evidence
 * folder. Before each run, with no inference request, the engine's endpoint, the model it would pick and that model's
 * sampling are checked against the protocol. Each request is journalled before it is sent, so a batch that was killed
 * is resumed by finding each run by its request id: never sent twice. Every wait is bounded: a run is cancelled at its
 * deadline, and one still going when its window to settle has passed is kept as unresolved, and the batch stops.
 * Nothing is retried or retaken, and every run is kept, whatever its end.
 */

const ENTRY = fileURLToPath(new URL("../../src/main.mjs", import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Internal timing seam: tests advance the monotonic clock without starving the real event loop. */
export interface BatchClock {
  now(): number;
  pause(ms: number): Promise<void>;
}
const CLOCK: BatchClock = { now: () => performance.now(), pause };

/**
 * The most each wait around the runs may take. The batch's 60 minutes count them all from its engine's start: a run is
 * started only if the waits around it and its own windows, each at its limit, could end within them, and no wait goes
 * past their end. Only stopping the engine comes after, in at most 15 s.
 */
export const WAITS = {
  /** Starting the engine: its `initialize`. */
  engineMs: 60_000,
  /** A check made before any inference request: the engine's doctor, once, and the model listing before each run. */
  checkMs: 30_000,
  /** A run's start: `runs.start`, and the search for the run after an error answer. */
  startMs: 60_000,
  /** Reading a run's record once it has ended: its summary, its events and its report. */
  collectMs: 30_000,
} as const;
/** The waits around one run, each at its limit: the model listing before it, its start, and reading its record. */
export const AROUND_RUN_MS = WAITS.checkMs + WAITS.startMs + WAITS.collectMs;
/**
 * Reading what the engine says of a run kept as unresolved (still going after its window to settle, or when the batch's
 * time ran out): a window of its own, after the window to settle, for its summary, its events and its report together.
 * At most 5 s, and less when the batch's time ends sooner.
 */
export const UNRESOLVED_READ_MS = 5_000;

export type JournalEntry =
  | { type: "session"; at: string; homeId: string; pid: number; mode: "stub" | "live"; revision: string | null; dirty: boolean; approvalDigest: string }
  | { type: "start"; at: string; fixture: FixtureId; arm: Arm; clientRequestId: string; homeId: string; batchElapsedMs: number }
  | { type: "run"; at: string; fixture: FixtureId; arm: Arm; clientRequestId: string; runId: string | null; how: "started" | "found" | "not-sent" | "unknown" }
  // `batchElapsedMs` is on the monotonic clock, as `start` and `end` have it; a journal written before it was added has none.
  | { type: "cancel"; at: string; fixture: FixtureId; arm: Arm; runId: string; why: "deadline" | "batch"; batchElapsedMs?: number }
  | { type: "end"; at: string; fixture: FixtureId; arm: Arm; clientRequestId: string; runId: string | null; status: RunRecord["status"]; requests: number | null; note: string | null; batchElapsedMs: number }
  | { type: "stop"; at: string; why: string };

/** The batch's journal: one JSON line per entry, each written through to disk before the batch goes on. */
export class Journal {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "journal.jsonl");
  }

  append(entry: JournalEntry): void {
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  read(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry);
  }
}

export interface EvalEngine {
  client: RpcClient;
  homeId: string;
  pid: number;
  close(): Promise<void>;
}

/**
 * Starts the engine on `home` and initializes it with the key (D8), within `timeoutMs`. `entry` is a test's stand-in for
 * the engine. Closing is bounded: shutdown, then its input closed, then killed (D4); an engine that didn't initialize is
 * stopped the same way, from its input.
 */
export async function startEngine(home: string, options: { tokenFactoryUrl: string | null; apiKey: string; logPath: string; timeoutMs?: number; entry?: string }): Promise<EvalEngine> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stub = options.tokenFactoryUrl ? ["--token-factory-url", options.tokenFactoryUrl] : [];
  const child = spawn(process.execPath, [options.entry ?? ENTRY, "--stdio", "--home", home, "--heartbeat-ms", "0", "--nivra-engine", ...stub], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const client = new RpcClient({
    send: (line) => void child.stdin.write(line),
    onProtocolError: (problem) => appendFileSync(options.logPath, `protocol error: ${problem}\n`, { mode: 0o600 }),
    defaultTimeoutMs: 60_000,
  });
  const splitter = new LineSplitter();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) client.receive(line);
  });
  child.stderr.on("data", (chunk: Buffer) => appendFileSync(options.logPath, chunk, { mode: 0o600 }));
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      client.close("The engine exited.");
      resolve();
    }),
  );
  const stop = async () => {
    child.stdin.end();
    await Promise.race([exited, pause(10_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const info = await client
    .call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "council-eval", version: "0" }, secrets: { NEBIUS_API_KEY: options.apiKey } }, { timeoutMs: options.timeoutMs ?? 60_000 })
    .catch(async (error: unknown) => {
      await stop();
      throw error;
    });
  return {
    client,
    homeId: info.homeId,
    pid: info.pid,
    close: async () => {
      await client.call("shutdown", {}, { timeoutMs: 5_000 }).catch(() => undefined);
      await stop();
    },
  };
}

export interface BatchOptions {
  frozen: Frozen;
  /** The evidence folder: journal, runs, engine home and log. */
  out: string;
  mode: "stub" | "live";
  tokenFactoryUrl: string | null;
  apiKey: string;
  revision: string | null;
  dirty: boolean;
  /** Tests only: these fixtures; each run's deadline and window to settle instead of the protocol's; a stand-in engine. */
  only?: readonly FixtureId[];
  deadlineMs?: number;
  reconcileMs?: number;
  engineEntry?: string;
  clock?: BatchClock;
  log: (line: string) => void;
}

/** Why the batch must stop after this run, in Nivra's words; null when it goes on (the protocol's stops). */
export function stopFor(record: RunRecord, frozen: Frozen, mode: "stub" | "live"): string | null {
  const { protocol } = frozen;
  if (record.status === "unknown") return record.note ?? `Nivra can't tell whether the ${record.fixture} ${record.arm} run started, so the batch stopped: nothing more is sent.`;
  const route = record.report?.route ?? record.summary?.route ?? null;
  if (route && route.model !== protocol.model) return `The engine picked ${route.model}, not ${protocol.model}, so the batch stopped.`;
  if (mode === "live" && route && route.endpoint !== protocol.endpoint) return `A run went to ${route.endpoint}, not Token Factory, so the batch stopped.`;
  if (record.report && canonical(record.report.sampling) !== canonical(protocol.sampling)) return "A run's sampling differs from the protocol's, so the batch stopped.";
  if (record.failureKind === "auth" || record.failureKind === "rate-limit") return `A run failed with ${record.failureKind}, so the batch stopped.`;
  if (record.requests !== null && record.requests > protocol.limits[record.arm].requests) return `A ${record.arm} run made ${record.requests} requests, more than its ${protocol.limits[record.arm].requests}, so the batch stopped.`;
  return null;
}

/** At most `capMs`, and never past `until` on the monotonic clock: what a call may wait. 0 when `until` has passed. */
const within = (until: number, capMs: number, now: number) => Math.max(0, Math.min(capMs, Math.floor(until - now)));

/** A collection can retain useful evidence even when a later read has no budget or fails. */
interface Collected {
  record: RunRecord;
  events: RunEvent[];
  incomplete: "deadline" | "read" | null;
}

class CollectionDeadline extends Error {}

async function collect(client: Pick<RpcClient, "call">, fixture: FixtureId, arm: Arm, clientRequestId: string, runId: string, until: number, clock: BatchClock, lastSummary: RunSummary | null): Promise<Collected> {
  const timeoutMs = () => {
    const remaining = within(until, WAITS.collectMs, clock.now());
    // Zero disables RpcClient's timer. Neither zero nor a manufactured 1 ms is safe after exhaustion.
    if (remaining <= 0) throw new CollectionDeadline();
    return remaining;
  };
  let summary = lastSummary;
  let report: ReviewReport | null = null;
  const events: RunEvent[] = [];
  let incomplete: Collected["incomplete"] = null;
  try {
    summary = await client.call("runs.get", { runId }, { timeoutMs: timeoutMs() });
    for (let after = 0; ; ) {
      const page = await client.call("runs.events", { runId, after, limit: 500 }, { timeoutMs: timeoutMs() });
      events.push(...page.events);
      if (page.events.length < 500) break;
      after = page.next;
    }
    report = await client.call("runs.review", { runId }, { timeoutMs: timeoutMs() });
  } catch (error) {
    incomplete = error instanceof CollectionDeadline ? "deadline" : "read";
  }
  const kind = events.find((event) => event.type === "run.failed")?.data?.["kind"];
  return {
    record: {
      fixture, arm, clientRequestId, runId,
      status: incomplete ? "unknown" : summary!.status,
      failureKind: typeof kind === "string" ? kind : null,
      summary, report,
      requests: incomplete ? null : report ? report.budget.used.requests : 0,
      events: events.length,
      note: null,
    },
    events,
    incomplete,
  };
}

/** Internal follow/collection seam shared by the runner and deterministic deadline tests; not a wire contract. */
export interface FollowOptions {
  client: Pick<RpcClient, "call">;
  fixture: FixtureId;
  arm: Arm;
  clientRequestId: string;
  runId: string;
  deadlineMs: number;
  reconcileMs: number;
  batchEnd(): number;
  cancelIntent(why: "deadline" | "batch"): void;
  clock?: BatchClock;
}

export async function finishRun(options: FollowOptions): Promise<{ record: RunRecord; events: RunEvent[] }> {
  const { client, fixture, arm, clientRequestId, runId, deadlineMs, reconcileMs, batchEnd, cancelIntent } = options;
  const clock = options.clock ?? CLOCK;
  const startedAt = clock.now();
  const lastAt = batchEnd() - WAITS.collectMs;
  const cancelAt = Math.min(startedAt + deadlineMs, lastAt - reconcileMs);
  const giveUpAt = Math.min(cancelAt + reconcileMs, lastAt);
  let intent = false;
  let attempted = false;
  let acknowledged = false;
  let late = false;
  let summary: RunSummary | null = null;
  let outcome: "ended" | "window" | "batch";
  for (;;) {
    const now = clock.now();
    if (within(batchEnd(), 10_000, now) <= 0) { outcome = "batch"; break; }
    // Cancellation comes before give-up, but never before the hard-budget check. Intent is durable before dispatch.
    if (!intent && now >= cancelAt) {
      intent = true;
      cancelIntent(now >= startedAt + deadlineMs ? "deadline" : "batch");
      const dispatchAt = clock.now();
      const remaining = within(batchEnd(), 10_000, dispatchAt);
      if (remaining <= 0) { outcome = "batch"; break; }
      const settling = within(giveUpAt, 10_000, dispatchAt);
      late = settling <= 0;
      attempted = true;
      await client.call("runs.cancel", { runId }, { timeoutMs: late ? remaining : Math.min(settling, remaining) })
        .then(() => { acknowledged = true; }, () => undefined);
      // The original giveUpAt is retained; no reconciliation window begins at the late send or acknowledgement.
      continue;
    }
    if (now >= giveUpAt) { outcome = "window"; break; }
    const wait = within(Math.min(intent ? giveUpAt : cancelAt, batchEnd()), 10_000, clock.now());
    const seen = wait > 0 ? await client.call("runs.get", { runId }, { timeoutMs: wait }).catch(() => null) : null;
    if (seen) {
      summary = seen;
      if (isTerminal(seen.status)) { outcome = "ended"; break; }
    }
    const delay = within(Math.min(intent ? giveUpAt : cancelAt, batchEnd()), 250, clock.now());
    await clock.pause(delay);
  }

  const until = Math.min(clock.now() + (outcome === "ended" ? WAITS.collectMs : UNRESOLVED_READ_MS), batchEnd());
  const collected = await collect(client, fixture, arm, clientRequestId, runId, until, clock, summary);
  if (outcome === "ended" && collected.incomplete === null) return collected;
  const run = `${fixture} ${arm} run`;
  let reason: string;
  if (outcome === "batch") {
    if (clock.now() < batchEnd()) reason = `The batch budget had less than 1 ms left, so no new bounded request could be started for the ${run}.`;
    else if (attempted) reason = `The batch's 60 minutes ran out before the ${run} could be confirmed ended.`;
    else if (intent) reason = `Cancellation intent for the ${run} was recorded, but the batch budget expired before the request could be sent.`;
    else reason = `The runner resumed too late to request cancellation of the ${run} within the batch's 60 minutes.`;
  } else if (outcome === "ended") reason = `The ${run} was observed to end, but its complete evidence could not be collected.`;
  else if (late) reason = `The runner requested cancellation of the ${run} with no time left for its original reconciliation wait. No new reconciliation window was opened.`;
  else reason = `The ${run} was not observed to end within its original reconciliation window.`;
  const cancellation = attempted ? acknowledged ? " The cancellation request was acknowledged." : " The cancellation request was not acknowledged; its outcome is unknown." : "";
  const collection = collected.incomplete === "deadline" ? " Evidence collection did not finish within its budget." : collected.incomplete === "read" ? " The engine did not return complete evidence." : "";
  const terminal = outcome !== "ended" && collected.record.summary && isTerminal(collected.record.summary.status) ? ` A later evidence read observed status ${collected.record.summary.status}.` : "";
  const note = `${reason}${cancellation}${collection}${terminal} It is kept as unresolved, and the batch stopped. It is never sent again.`;
  return { record: { ...collected.record, status: "unknown", requests: null, note }, events: collected.events };
}

/**
 * Runs the batch, or resumes it from its journal. A run journalled as started but never ended is looked for by its
 * request id on the same store: one found is followed to its end (an engine that restarted ends it as interrupted), one
 * the store has no record of was never sent and starts afresh, and one on another store can't be told and is kept as
 * unknown. Nothing is ever sent twice, and a stop is never lost: the protocol's stops are checked again on every run
 * the journal kept. The batch's 60 minutes count every wait from its engine's start (`WAITS`), and none goes past them.
 */
export async function runBatch(options: BatchOptions): Promise<{ records: RunRecord[]; stopped: string | null }> {
  const { frozen, out } = options;
  const clock = options.clock ?? CLOCK;
  const budget = (until: number, capMs: number) => within(until, capMs, clock.now());
  mkdirSync(join(out, "runs"), { recursive: true, mode: 0o700 });
  const journal = new Journal(out);
  const before = journal.read();
  // The batch's clock starts before its engine does: starting it is one of the waits its 60 minutes count.
  const sessionStart = clock.now();
  const { runner } = frozen.protocol;
  const deadlineOf = (arm: Arm) => options.deadlineMs ?? frozen.protocol.limits[arm].totalMs + runner.cancelMarginMs;
  const reconcileMs = options.reconcileMs ?? runner.reconcileMs;
  // Time the batch already used, and, for a run cut off mid-way, the whole of its windows: the cap is never undercounted.
  const previous = Math.max(0, ...before.filter((entry) => entry.type === "start" || entry.type === "end").map((entry) => entry.batchElapsedMs));
  const ended = new Set(before.filter((entry) => entry.type === "end").map((entry) => `${entry.fixture}:${entry.arm}`));
  const inflight = before.filter((entry): entry is Extract<JournalEntry, { type: "start" }> => entry.type === "start" && !ended.has(`${entry.fixture}:${entry.arm}`));
  let carried = previous + inflight.reduce((sum, entry) => sum + deadlineOf(entry.arm) + reconcileMs, 0);
  const elapsed = () => carried + (clock.now() - sessionStart);
  /** The batch's own end, on this session's monotonic clock. */
  const batchEnd = () => sessionStart - carried + runner.batchMs;
  /** Whether a wait of `ms`, at its limit, would still end within the batch's 60 minutes. */
  const fits = (ms: number) => elapsed() + ms <= runner.batchMs;
  const ranOut = "The batch's 60 minutes ran out before its next wait could end within them, so the batch stopped.";

  const records: RunRecord[] = before.filter((entry) => entry.type === "end").map((entry) => readRecord(out, entry.fixture, entry.arm));
  const usedRequests = () => records.reduce((sum, record) => sum + (record.requests ?? frozen.protocol.limits[record.arm].requests), 0);
  // The stop the journal holds, or one a run it kept makes: a batch killed after a run's end was written and before its
  // stop was stops again here, before anything more is sent.
  let stopped: string | null = before.find((entry): entry is Extract<JournalEntry, { type: "stop" }> => entry.type === "stop")?.why ?? records.map((record) => stopFor(record, frozen, options.mode)).find((why) => why !== null) ?? null;
  const ordered = () => runOrder().flatMap(({ fixture, arm }) => records.filter((record) => record.fixture === fixture && record.arm === arm));
  const recordStop = () => {
    if (stopped && !before.some((entry) => entry.type === "stop")) journal.append({ type: "stop", at: new Date().toISOString(), why: stopped });
  };

  /** Keeps a run: its evidence file (with its events), then its end in the journal. */
  const keep = (record: RunRecord, eventList: readonly RunEvent[]): RunRecord => {
    writeFileSync(join(out, "runs", `${record.fixture}-${record.arm}.json`), `${JSON.stringify({ ...record, eventList }, null, 2)}\n`, { mode: 0o600 });
    journal.append({ type: "end", at: new Date().toISOString(), fixture: record.fixture, arm: record.arm, clientRequestId: record.clientRequestId, runId: record.runId, status: record.status, requests: record.requests, note: record.note, batchElapsedMs: Math.round(elapsed()) });
    records.push(record);
    options.log(`${record.fixture} ${record.arm.padEnd(7)} ${record.status}${record.report ? ` (${record.report.outcome})` : ""}: ${record.requests ?? "unknown"} requests, ${record.summary?.durationMs ?? "?"} ms`);
    return record;
  };
  /** A run with no record on an engine: never sent, or one that can't be told. */
  const unseen = (fixture: FixtureId, arm: Arm, clientRequestId: string, status: "not-sent" | "unknown", note: string | null): RunRecord =>
    keep({ fixture, arm, clientRequestId, runId: null, status, failureKind: null, summary: null, report: null, requests: status === "not-sent" ? 0 : null, events: 0, note }, []);

  if (!fits(WAITS.engineMs)) {
    // No time left even to start the engine: a run that was out is kept as unresolved, unread, and never sent again.
    for (const entry of inflight) {
      const note = `The batch's 60 minutes ran out before the ${entry.fixture} ${entry.arm} run could be followed, so it is kept as unresolved, and the batch stopped. It is never sent again.`;
      stopped ??= stopFor(unseen(entry.fixture, entry.arm, entry.clientRequestId, "unknown", note), frozen, options.mode);
    }
    stopped ??= ranOut;
    recordStop();
    return { records: ordered(), stopped };
  }
  const engine = await startEngine(join(out, "engine home"), { tokenFactoryUrl: options.tokenFactoryUrl, apiKey: options.apiKey, logPath: join(out, "engine.log"), timeoutMs: WAITS.engineMs, ...(options.engineEntry ? { entry: options.engineEntry } : {}) });
  journal.append({ type: "session", at: new Date().toISOString(), homeId: engine.homeId, pid: engine.pid, mode: options.mode, revision: options.revision, dirty: options.dirty, approvalDigest: frozen.approvalDigest });

  const finish = async (fixture: FixtureId, arm: Arm, clientRequestId: string, runId: string | null, status: "not-sent" | "unknown" | null): Promise<RunRecord> => {
    if (!runId) return unseen(fixture, arm, clientRequestId, status ?? "unknown", null);
    const finished = await finishRun({
      client: engine.client, fixture, arm, clientRequestId, runId, deadlineMs: deadlineOf(arm), reconcileMs, batchEnd, clock,
      cancelIntent: (why) => journal.append({ type: "cancel", at: new Date().toISOString(), fixture, arm, runId, why, batchElapsedMs: Math.round(elapsed()) }),
    });
    return keep(finished.record, finished.events);
  };

  try {
    // A run cut off mid-way: found by its request id on the same store, never sent again.
    for (const entry of inflight) {
      if (entry.homeId !== engine.homeId) {
        journal.append({ type: "run", at: new Date().toISOString(), fixture: entry.fixture, arm: entry.arm, clientRequestId: entry.clientRequestId, runId: null, how: "unknown" });
        stopped ??= stopFor(await finish(entry.fixture, entry.arm, entry.clientRequestId, null, "unknown"), frozen, options.mode);
        continue;
      }
      const found = await engine.client.call("runs.find", { clientRequestId: entry.clientRequestId }, { timeoutMs: Math.max(1, budget(batchEnd(), WAITS.startMs)) });
      journal.append({ type: "run", at: new Date().toISOString(), fixture: entry.fixture, arm: entry.arm, clientRequestId: entry.clientRequestId, runId: found?.id ?? null, how: found ? "found" : "not-sent" });
      if (found) stopped ??= stopFor(await finish(entry.fixture, entry.arm, entry.clientRequestId, found.id, null), frozen, options.mode);
    }
    carried -= inflight.filter((entry) => !records.some((record) => record.clientRequestId === entry.clientRequestId)).reduce((sum, entry) => sum + deadlineOf(entry.arm) + reconcileMs, 0);
    const done = new Set(records.map((record) => `${record.fixture}:${record.arm}`));
    // Where this engine sends its requests: asked once, from its doctor, which reaches no network.
    if (!stopped && !fits(WAITS.checkMs)) stopped = ranOut;
    const endpoint = stopped ? null : endpointFromDoctor(await engine.client.call("doctor", {}, { timeoutMs: WAITS.checkMs }));
    for (const { fixture, arm } of runOrder()) {
      if (stopped) break;
      if (options.only && !options.only.includes(fixture)) continue;
      if (done.has(`${fixture}:${arm}`)) continue;
      if (!fits(AROUND_RUN_MS + deadlineOf(arm) + reconcileMs)) {
        stopped = "The next run, with the checks before it, its start, its windows to cancel and to settle, and reading its record, could not end within the batch's 60 minutes, so the batch stopped.";
        break;
      }
      if (usedRequests() + frozen.protocol.limits[arm].requests > runner.maxRequests) {
        stopped = `The next run could take the batch past its ${runner.maxRequests} requests, so the batch stopped.`;
        break;
      }
      // Before any inference request: the model the engine would pick, from the listing it reads, and its sampling.
      const listed = await modelNow(options.apiKey, endpointFor(options.tokenFactoryUrl), WAITS.checkMs);
      const refused = "problem" in listed ? listed.problem : preflightProblem({ endpoint, model: listed.model, arm }, frozen, options.mode);
      if (refused) {
        stopped = refused;
        break;
      }
      const clientRequestId = randomUUID();
      journal.append({ type: "start", at: new Date().toISOString(), fixture, arm, clientRequestId, homeId: engine.homeId, batchElapsedMs: Math.round(elapsed()) });
      const startBy = clock.now() + WAITS.startMs;
      let runId: string | null = null;
      let how: "started" | "found" | "not-sent" | "unknown" = "started";
      try {
        runId = (await engine.client.call("runs.start", requestFor(frozen, fixture, arm, clientRequestId), { timeoutMs: WAITS.startMs })).id;
      } catch (error) {
        // Refused before sending: nothing was written. An error answer comes after the engine has made the run or not,
        // so its store says which. No answer at all (a timeout, a closed connection) leaves it unknown: it may be starting.
        if (error instanceof TypeError) how = "not-sent";
        else if (error instanceof RpcCallError) {
          const found = await engine.client.call("runs.find", { clientRequestId }, { timeoutMs: Math.max(1, budget(startBy, WAITS.startMs)) }).catch(() => undefined);
          how = found ? "found" : found === null ? "not-sent" : "unknown";
          runId = found?.id ?? null;
        } else how = "unknown";
        if (!runId) options.log(`${fixture} ${arm}: runs.start failed (${error instanceof RpcCallError ? `error ${error.code}` : error instanceof Error ? error.name : "unknown"}); ${how}`);
      }
      journal.append({ type: "run", at: new Date().toISOString(), fixture, arm, clientRequestId, runId, how });
      const record = await finish(fixture, arm, clientRequestId, runId, runId ? null : how === "not-sent" ? "not-sent" : "unknown");
      stopped = stopFor(record, frozen, options.mode);
    }
  } finally {
    recordStop();
    await engine.close();
  }
  return { records: ordered(), stopped };
}

/** A run the batch kept, read back from its evidence file (which also holds its events, as `eventList`). */
export function readRecord(out: string, fixture: FixtureId, arm: Arm): RunRecord {
  const { eventList: _events, ...record } = JSON.parse(readFileSync(join(out, "runs", `${fixture}-${arm}.json`), "utf8")) as RunRecord & { eventList: unknown };
  return record;
}
