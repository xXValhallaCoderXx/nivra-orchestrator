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

export type JournalEntry =
  | { type: "session"; at: string; homeId: string; pid: number; mode: "stub" | "live"; revision: string | null; dirty: boolean; approvalDigest: string }
  | { type: "start"; at: string; fixture: FixtureId; arm: Arm; clientRequestId: string; homeId: string; batchElapsedMs: number }
  | { type: "run"; at: string; fixture: FixtureId; arm: Arm; clientRequestId: string; runId: string | null; how: "started" | "found" | "not-sent" | "unknown" }
  | { type: "cancel"; at: string; fixture: FixtureId; arm: Arm; runId: string; why: "deadline" | "batch" }
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
 * Starts the engine on `home` and initializes it with the key (D8). `entry` is a test's stand-in for the engine. Closing
 * is bounded: shutdown, then its input closed, then killed (D4).
 */
export async function startEngine(home: string, options: { tokenFactoryUrl: string | null; apiKey: string; logPath: string; entry?: string }): Promise<EvalEngine> {
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
  const info = await client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "council-eval", version: "0" }, secrets: { NEBIUS_API_KEY: options.apiKey } });
  return {
    client,
    homeId: info.homeId,
    pid: info.pid,
    close: async () => {
      await client.call("shutdown", {}, { timeoutMs: 5_000 }).catch(() => undefined);
      child.stdin.end();
      await Promise.race([exited, pause(10_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

/** How a run ended, as the evaluation keeps it, read from its own engine: summary, every event and the report. */
async function collect(engine: EvalEngine, fixture: FixtureId, arm: Arm, clientRequestId: string, runId: string, timeoutMs: number): Promise<{ record: RunRecord; events: RunEvent[] }> {
  const summary: RunSummary = await engine.client.call("runs.get", { runId }, { timeoutMs });
  const events: RunEvent[] = [];
  for (let after = 0; ; ) {
    const page = await engine.client.call("runs.events", { runId, after, limit: 500 }, { timeoutMs });
    events.push(...page.events);
    if (page.events.length < 500) break;
    after = page.next;
  }
  const report: ReviewReport | null = await engine.client.call("runs.review", { runId }, { timeoutMs });
  const failed = events.find((event) => event.type === "run.failed");
  const kind = failed?.data?.["kind"];
  return {
    record: {
      fixture,
      arm,
      clientRequestId,
      runId,
      status: summary.status,
      failureKind: typeof kind === "string" ? kind : null,
      summary,
      report,
      requests: report ? report.budget.used.requests : 0,
      events: events.length,
      note: null,
    },
    events,
  };
}

/** At most `capMs`, and never past `until` on the monotonic clock: what a call may wait. 0 when `until` has passed. */
const within = (until: number, capMs: number) => Math.max(0, Math.min(capMs, Math.floor(until - performance.now())));

/**
 * Runs the batch, or resumes it from its journal. A run journalled as started but never ended is looked for by its
 * request id on the same store: one found is followed to its end (an engine that restarted ends it as interrupted), one
 * the store has no record of was never sent and starts afresh, and one on another store can't be told and is kept as
 * unknown. Nothing is ever sent twice.
 */
export async function runBatch(options: BatchOptions): Promise<{ records: RunRecord[]; stopped: string | null }> {
  const { frozen, out } = options;
  mkdirSync(join(out, "runs"), { recursive: true, mode: 0o700 });
  const journal = new Journal(out);
  const before = journal.read();
  const engine = await startEngine(join(out, "engine home"), { tokenFactoryUrl: options.tokenFactoryUrl, apiKey: options.apiKey, logPath: join(out, "engine.log"), ...(options.engineEntry ? { entry: options.engineEntry } : {}) });
  const sessionStart = performance.now();
  const { runner } = frozen.protocol;
  const deadlineOf = (arm: Arm) => options.deadlineMs ?? frozen.protocol.limits[arm].totalMs + runner.cancelMarginMs;
  const reconcileMs = options.reconcileMs ?? runner.reconcileMs;
  // Time the batch already used, and, for a run cut off mid-way, the whole of its windows: the cap is never undercounted.
  const previous = Math.max(0, ...before.filter((entry) => entry.type === "start" || entry.type === "end").map((entry) => entry.batchElapsedMs));
  const ended = new Set(before.filter((entry) => entry.type === "end").map((entry) => `${entry.fixture}:${entry.arm}`));
  const inflight = before.filter((entry): entry is Extract<JournalEntry, { type: "start" }> => entry.type === "start" && !ended.has(`${entry.fixture}:${entry.arm}`));
  let carried = previous + inflight.reduce((sum, entry) => sum + deadlineOf(entry.arm) + reconcileMs, 0);
  const elapsed = () => carried + (performance.now() - sessionStart);
  /** The batch's own end, on this session's monotonic clock. */
  const batchEnd = () => sessionStart - carried + runner.batchMs;
  journal.append({ type: "session", at: new Date().toISOString(), homeId: engine.homeId, pid: engine.pid, mode: options.mode, revision: options.revision, dirty: options.dirty, approvalDigest: frozen.approvalDigest });

  const records: RunRecord[] = before.filter((entry) => entry.type === "end").map((entry) => readRecord(out, entry.fixture, entry.arm));
  const usedRequests = () => records.reduce((sum, record) => sum + (record.requests ?? frozen.protocol.limits[record.arm].requests), 0);
  let stopped: string | null = before.find((entry): entry is Extract<JournalEntry, { type: "stop" }> => entry.type === "stop")?.why ?? null;

  /**
   * Follows a run to its end within its bounds: cancelled at its deadline (or sooner, to leave the batch room to settle
   * it), then given its window to settle. Every call waits only as long as is left. False when it is still going.
   */
  const follow = async (fixture: FixtureId, arm: Arm, runId: string): Promise<boolean> => {
    const startedAt = performance.now();
    const cancelAt = Math.min(startedAt + deadlineOf(arm), batchEnd() - reconcileMs);
    const giveUpAt = Math.min(cancelAt + reconcileMs, batchEnd());
    let cancelled = false;
    for (;;) {
      const now = performance.now();
      if (now >= giveUpAt) return false;
      if (!cancelled && now >= cancelAt) {
        cancelled = true;
        journal.append({ type: "cancel", at: new Date().toISOString(), fixture, arm, runId, why: now >= startedAt + deadlineOf(arm) ? "deadline" : "batch" });
        await engine.client.call("runs.cancel", { runId }, { timeoutMs: Math.max(1, within(giveUpAt, 10_000)) }).catch(() => undefined);
        continue;
      }
      const wait = within(cancelled ? giveUpAt : cancelAt, 10_000);
      const summary = wait > 0 ? await engine.client.call("runs.get", { runId }, { timeoutMs: wait }).catch(() => null) : null;
      if (summary && isTerminal(summary.status)) return true;
      await pause(Math.min(250, within(giveUpAt, 250)));
    }
  };

  const finish = async (fixture: FixtureId, arm: Arm, clientRequestId: string, runId: string | null, status: RunRecord["status"] | null) => {
    let record: RunRecord;
    if (runId && (await follow(fixture, arm, runId))) {
      const collected = await collect(engine, fixture, arm, clientRequestId, runId, 30_000);
      record = collected.record;
      writeFileSync(join(out, "runs", `${fixture}-${arm}.json`), `${JSON.stringify({ ...record, eventList: collected.events }, null, 2)}\n`, { mode: 0o600 });
    } else if (runId) {
      // Still going after its window to settle: kept as unresolved, with whatever the engine says of it now, never resent.
      const seen = await collect(engine, fixture, arm, clientRequestId, runId, 5_000).catch(() => null);
      const note = `The ${fixture} ${arm} run was still going ${Math.round(reconcileMs / 1000)} s after it was cancelled, so it is kept as unresolved, and the batch stopped. It is never sent again.`;
      record = { ...(seen?.record ?? { fixture, arm, clientRequestId, runId, failureKind: null, summary: null, report: null, events: 0 }), status: "unknown", requests: null, note };
      writeFileSync(join(out, "runs", `${fixture}-${arm}.json`), `${JSON.stringify({ ...record, eventList: seen?.events ?? [] }, null, 2)}\n`, { mode: 0o600 });
    } else {
      record = { fixture, arm, clientRequestId, runId: null, status: status ?? "unknown", failureKind: null, summary: null, report: null, requests: status === "not-sent" ? 0 : null, events: 0, note: null };
      writeFileSync(join(out, "runs", `${fixture}-${arm}.json`), `${JSON.stringify({ ...record, eventList: [] }, null, 2)}\n`, { mode: 0o600 });
    }
    journal.append({ type: "end", at: new Date().toISOString(), fixture, arm, clientRequestId, runId: record.runId, status: record.status, requests: record.requests, note: record.note, batchElapsedMs: Math.round(elapsed()) });
    records.push(record);
    options.log(`${fixture} ${arm.padEnd(7)} ${record.status}${record.report ? ` (${record.report.outcome})` : ""}: ${record.requests ?? "unknown"} requests, ${record.summary?.durationMs ?? "?"} ms`);
    return record;
  };

  try {
    // A run cut off mid-way: found by its request id on the same store, never sent again.
    for (const entry of inflight) {
      if (entry.homeId !== engine.homeId) {
        journal.append({ type: "run", at: new Date().toISOString(), fixture: entry.fixture, arm: entry.arm, clientRequestId: entry.clientRequestId, runId: null, how: "unknown" });
        stopped ??= stopFor(await finish(entry.fixture, entry.arm, entry.clientRequestId, null, "unknown"), frozen, options.mode);
        continue;
      }
      const found = await engine.client.call("runs.find", { clientRequestId: entry.clientRequestId });
      journal.append({ type: "run", at: new Date().toISOString(), fixture: entry.fixture, arm: entry.arm, clientRequestId: entry.clientRequestId, runId: found?.id ?? null, how: found ? "found" : "not-sent" });
      if (found) stopped ??= stopFor(await finish(entry.fixture, entry.arm, entry.clientRequestId, found.id, null), frozen, options.mode);
    }
    carried -= inflight.filter((entry) => !records.some((record) => record.clientRequestId === entry.clientRequestId)).reduce((sum, entry) => sum + deadlineOf(entry.arm) + reconcileMs, 0);
    const done = new Set(records.map((record) => `${record.fixture}:${record.arm}`));
    // Where this engine sends its requests: asked once, from its doctor, which reaches no network.
    const endpoint = stopped ? null : endpointFromDoctor(await engine.client.call("doctor", {}, { timeoutMs: 30_000 }));
    for (const { fixture, arm } of runOrder()) {
      if (stopped) break;
      if (options.only && !options.only.includes(fixture)) continue;
      if (done.has(`${fixture}:${arm}`)) continue;
      if (elapsed() + deadlineOf(arm) + reconcileMs > runner.batchMs) {
        stopped = "The next run, with its windows to cancel and to settle, could not end within the batch's 60 minutes, so the batch stopped.";
        break;
      }
      if (usedRequests() + frozen.protocol.limits[arm].requests > runner.maxRequests) {
        stopped = `The next run could take the batch past its ${runner.maxRequests} requests, so the batch stopped.`;
        break;
      }
      // Before any inference request: the model the engine would pick, from the listing it reads, and its sampling.
      const listed = await modelNow(options.apiKey, endpointFor(options.tokenFactoryUrl));
      const refused = "problem" in listed ? listed.problem : preflightProblem({ endpoint, model: listed.model, arm }, frozen, options.mode);
      if (refused) {
        stopped = refused;
        break;
      }
      const clientRequestId = randomUUID();
      journal.append({ type: "start", at: new Date().toISOString(), fixture, arm, clientRequestId, homeId: engine.homeId, batchElapsedMs: Math.round(elapsed()) });
      let runId: string | null = null;
      let how: "started" | "found" | "not-sent" | "unknown" = "started";
      try {
        runId = (await engine.client.call("runs.start", requestFor(frozen, fixture, arm, clientRequestId))).id;
      } catch (error) {
        // Refused before sending: nothing was written. An error answer comes after the engine has made the run or not,
        // so its store says which. No answer at all (a timeout, a closed connection) leaves it unknown: it may be starting.
        if (error instanceof TypeError) how = "not-sent";
        else if (error instanceof RpcCallError) {
          const found = await engine.client.call("runs.find", { clientRequestId }).catch(() => undefined);
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
    if (stopped && !before.some((entry) => entry.type === "stop")) journal.append({ type: "stop", at: new Date().toISOString(), why: stopped });
    await engine.close();
  }
  return { records: runOrder().flatMap(({ fixture, arm }) => records.filter((record) => record.fixture === fixture && record.arm === arm)), stopped };
}

/** A run the batch kept, read back from its evidence file (which also holds its events, as `eventList`). */
export function readRecord(out: string, fixture: FixtureId, arm: Arm): RunRecord {
  const { eventList: _events, ...record } = JSON.parse(readFileSync(join(out, "runs", `${fixture}-${arm}.json`), "utf8")) as RunRecord & { eventList: unknown };
  return record;
}
