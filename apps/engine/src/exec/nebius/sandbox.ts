import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { readStatus, TERMINAL, type FileRef, type Operation, type OperationStatus, type SandboxApi, type SpawnBody } from "./api.ts";

/**
 * The lifecycle of Nebius Sandboxes operations, as Nivra models it (NIV-29), from the documentation of 20 October 2026:
 * - Each operation starts fresh compute from an image; no process outlives it. State continues only through the image an
 *   operation that succeeded leaves (`result_image_uuid`), or, inside one live operation, between its subprocesses.
 * - An operation's status is not its command's outcome: SUCCESS can carry a non-zero exit, a timeout or a signal.
 * - Networking is on unless a spawn turns it off, every time. Here it is always off, except for the probe's one fixed
 *   positive control, which needs an explicit approval.
 * - A spawn has no idempotency key. Each carries a correlation id in its environment, journaled before the request, so
 *   a spawn whose answer was lost can be looked for. A bounded search that finds nothing leaves it unknown, never "not
 *   started", and nothing is ever resubmitted.
 * - A lost connection is not a cancellation; a cancel's 202 is not a stop. Cancelling polls to a terminal state.
 * - Cancelling, or a disposable run, deletes nothing: images are retained for 180 days, after which untagged and
 *   unreferenced ones may be deleted, and there is no API to delete uploads, operation records or logs.
 */

export type JournalEntry =
  | { kind: "intent"; wall: string; correlation: string; label: string }
  | { kind: "submitted"; wall: string; correlation: string; operationId: string }
  | { kind: "uncertain"; wall: string; correlation: string; cause: string }
  | { kind: "found"; wall: string; correlation: string; operationId: string }
  | { kind: "cancel"; wall: string; operationId: string }
  | { kind: "terminal"; wall: string; operationId: string; status: OperationStatus }
  | { kind: "unresolved"; wall: string; correlation: string | null; operationId: string | null; reason: string };

/**
 * Everything the probe did, one JSON line per entry, written before the request it describes. With a file, the file is
 * the record: every read takes it afresh, so a fresh client (a reconnect, `--recover`) and the one before it agree.
 */
export class Journal {
  readonly #path: string | null;
  readonly #memory: JournalEntry[] = [];

  constructor(path: string | null = null) {
    this.#path = path;
  }

  append(entry: JournalEntry): void {
    if (this.#path) appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    else this.#memory.push(entry);
  }

  get entries(): readonly JournalEntry[] {
    if (!this.#path) return this.#memory;
    return existsSync(this.#path) ? readFileSync(this.#path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as JournalEntry) : [];
  }

  /** Operations known and not yet seen to end, and spawns whose operation hasn't been found: what cleanup must settle. */
  open(): { operations: string[]; uncertain: Array<{ correlation: string; wall: string; label: string }> } {
    const entries = this.entries;
    const ended = new Set(entries.flatMap((e) => (e.kind === "terminal" ? [e.operationId] : [])));
    const operations = [...new Set(entries.flatMap((e) => (e.kind === "submitted" || e.kind === "found" ? [e.operationId] : [])))].filter((id) => !ended.has(id));
    const settled = new Set(entries.flatMap((e) => (e.kind === "submitted" || e.kind === "found" ? [e.correlation] : [])));
    const intents = new Map(entries.flatMap((e) => (e.kind === "intent" ? [[e.correlation, e] as const] : [])));
    const uncertain = [...new Set(entries.flatMap((e) => (e.kind === "uncertain" ? [e.correlation] : [])))]
      .filter((correlation) => !settled.has(correlation))
      .map((correlation) => ({ correlation, wall: intents.get(correlation)?.wall ?? "", label: intents.get(correlation)?.label ?? "" }));
    return { operations, uncertain };
  }

  /** How many spawns were sent for a label: the evidence that nothing was sent twice. */
  spawnsOf(label: string): number {
    return this.entries.filter((e) => e.kind === "intent" && e.label === label).length;
  }
}

/** Something Nivra won't send, said in its own words. */
export class SandboxRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRefusal";
  }
}

export interface Outcome {
  operationId: string;
  status: OperationStatus | "UNKNOWN";
  exitCode: number | null;
  signal: number | string | null;
  timedOut: boolean;
  /** Only an operation that succeeded leaves a continuation point, and only when the service names one. */
  resultImage: string | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
  /** As the service reported it, raw: never converted to money. */
  usage: { durationSeconds: number | null; consumedCpu: unknown; consumedMemory: unknown; imageSize: number | null; resources: unknown };
  verdict: "passed" | "command-failed" | "timed-out" | "signalled" | "operation-failed" | "cancelled" | "unknown";
}

const text = (stream: { value?: string | undefined; encoding?: string | undefined } | null | undefined): string =>
  !stream?.value ? "" : stream.encoding === "base64" ? Buffer.from(stream.value, "base64").toString("utf8") : stream.value;

/** What an operation's answer says happened, the operation's status kept apart from its command's outcome. */
export function classify(operation: Operation): Outcome {
  const status = readStatus(operation.status);
  const result = operation.metadata?.result ?? null;
  const state = result?.state ?? null;
  const exitCode = typeof state?.exit_code === "number" ? state.exit_code : null;
  const signal = state?.signal ?? null;
  const timedOut = state?.timed_out === true;
  const verdict: Outcome["verdict"] =
    status === "CANCELLED"
      ? "cancelled"
      : status === "FAILED"
        ? timedOut
          ? "timed-out"
          : "operation-failed"
        : status === "SUCCESS"
          ? timedOut
            ? "timed-out"
            : signal !== null && signal !== 0
              ? "signalled"
              : exitCode === 0
                ? "passed"
                : exitCode === null
                  ? "unknown"
                  : "command-failed"
          : "unknown";
  return {
    operationId: operation.uuid,
    status,
    exitCode,
    signal,
    timedOut,
    resultImage: status === "SUCCESS" ? (operation.result_image_uuid ?? operation.result?.image ?? null) : null,
    stdout: text(result?.stdout),
    stdoutTruncated: result?.stdout?.truncated === true,
    stderr: text(result?.stderr),
    stderrTruncated: result?.stderr?.truncated === true,
    usage: { durationSeconds: operation.duration ?? null, consumedCpu: operation.consumed_cpu ?? null, consumedMemory: operation.consumed_memory ?? null, imageSize: operation.image_size ?? null, resources: result?.resources ?? null },
    verdict,
  };
}

/** One step's operation. Networking isn't part of it: ordinary execution always runs with it off. */
export interface StepSpec {
  label: string;
  command: string;
  args: string[];
  image: string;
  disposable: boolean;
  timeoutSeconds: number;
  files?: Record<string, FileRef>;
  env?: Record<string, string>;
  cwd?: string;
}

export interface SandboxOptions {
  journal: Journal;
  /** How long to keep observing past an operation's own timeout. */
  observeMarginMs?: number;
  pollMs?: number;
  /** How long a cancel may take to reach a terminal state. */
  cancelWaitMs?: number;
  /** Bounds on looking for a spawn whose answer was lost. */
  search?: { sinceMarginMs: number; pageSize: number; maxPages: number; maxCandidates: number };
  /** The longest timeout a step may ask for. */
  maxTimeoutSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock, in ms. */
  now?: () => number;
  wallNow?: () => Date;
}

const CORRELATION = "NIVRA_CORRELATION";
const MAX_OUTPUT_BYTES = 65_536;

export class Sandbox {
  readonly #api: SandboxApi;
  readonly #journal: Journal;
  readonly #observeMarginMs: number;
  readonly #pollMs: number;
  readonly #cancelWaitMs: number;
  readonly #search: NonNullable<SandboxOptions["search"]>;
  readonly #maxTimeoutSeconds: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #wallNow: () => Date;

  constructor(api: SandboxApi, options: SandboxOptions) {
    this.#api = api;
    this.#journal = options.journal;
    this.#observeMarginMs = options.observeMarginMs ?? 60_000;
    this.#pollMs = options.pollMs ?? 1_000;
    this.#cancelWaitMs = options.cancelWaitMs ?? 60_000;
    this.#search = options.search ?? { sinceMarginMs: 24 * 60 * 60 * 1000, pageSize: 100, maxPages: 10, maxCandidates: 50 };
    this.#maxTimeoutSeconds = options.maxTimeoutSeconds ?? 180;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? (() => new Date());
  }

  get journal(): Journal {
    return this.#journal;
  }

  /** Starts one step's operation with networking off. Refused while another operation is open: one at a time. */
  async submit(step: StepSpec, options: { discardAnswer?: boolean } = {}): Promise<{ operationId: string } | { uncertain: string }> {
    if (!(step.timeoutSeconds > 0 && step.timeoutSeconds <= this.#maxTimeoutSeconds)) throw new SandboxRefusal(`A step's timeout must be between 1 and ${this.#maxTimeoutSeconds} s.`);
    return this.#spawn(step.label, {
      command: step.command,
      args: step.args,
      image: step.image,
      shell: false,
      env: { ...step.env },
      ...(step.cwd ? { cwd: step.cwd } : {}),
      disposable: step.disposable,
      networking: { enabled: false },
      timeout: step.timeoutSeconds,
      truncate_output_at: MAX_OUTPUT_BYTES,
      ...(step.files ? { files: step.files } : {}),
    }, options);
  }

  /**
   * The probe's positive network control, the one operation that runs with networking on: only with an approval for
   * exactly this URL, on the public base image, with no files and one fixed command, and thrown away afterwards.
   */
  async networkControl(input: { approvedUrl: string | null; url: string; image: string; baseImage: string; files?: unknown; command?: unknown }): Promise<{ operationId: string } | { uncertain: string }> {
    if (input.approvedUrl === null) throw new SandboxRefusal("The network control runs only with --network-control <url>, after you approve that URL.");
    if (input.url !== input.approvedUrl) throw new SandboxRefusal("The network control may reach only the URL you approved.");
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(input.url)) throw new SandboxRefusal("The network control needs an http or https URL.");
    if (input.image !== input.baseImage) throw new SandboxRefusal("The network control runs on the public base image only, never on an image made from the fixture.");
    if (input.files !== undefined || input.command !== undefined) throw new SandboxRefusal("The network control carries no files and runs one fixed command.");
    return this.#spawn("network control", {
      command: "/bin/busybox",
      args: ["wget", "-q", "-T", "10", "-O", "/dev/null", input.url],
      image: input.image,
      shell: false,
      env: {},
      disposable: true,
      networking: { enabled: true },
      timeout: 30,
      truncate_output_at: MAX_OUTPUT_BYTES,
    });
  }

  async #spawn(label: string, body: SpawnBody, options: { discardAnswer?: boolean } = {}): Promise<{ operationId: string } | { uncertain: string }> {
    if (body.networking.enabled && label !== "network control") throw new SandboxRefusal("Networking stays off for every operation but the approved network control.");
    if (typeof body.disposable !== "boolean") throw new SandboxRefusal("Every spawn says whether it is disposable.");
    const open = this.#journal.open();
    if (open.operations.length || open.uncertain.length) throw new SandboxRefusal("One operation at a time: an earlier one hasn't ended, or a spawn whose answer was lost hasn't been settled.");
    const correlation = randomUUID();
    this.#journal.append({ kind: "intent", wall: this.#wallNow().toISOString(), correlation, label });
    const answer = await this.#api.spawn({ ...body, env: { ...body.env, [CORRELATION]: correlation } }, options);
    if (answer.status === "created") {
      this.#journal.append({ kind: "submitted", wall: this.#wallNow().toISOString(), correlation, operationId: answer.id });
      return { operationId: answer.id };
    }
    this.#journal.append({ kind: "uncertain", wall: this.#wallNow().toISOString(), correlation, cause: answer.cause });
    return { uncertain: correlation };
  }

  /** Polls an operation until it ends, or until its own timeout plus the margin has passed. */
  async observe(operationId: string, timeoutSeconds: number): Promise<Outcome> {
    const deadline = this.#now() + timeoutSeconds * 1000 + this.#observeMarginMs;
    for (;;) {
      const operation = await this.#api.operation(operationId);
      const status = readStatus(operation.status);
      if (status !== "UNKNOWN" && TERMINAL.has(status)) {
        this.#journal.append({ kind: "terminal", wall: this.#wallNow().toISOString(), operationId, status });
        return classify(operation);
      }
      if (this.#now() > deadline) {
        this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation: null, operationId, reason: "it hadn't ended when observing it ran out of time" });
        throw new SandboxRefusal(`Operation ${operationId} hadn't ended ${Math.round((timeoutSeconds * 1000 + this.#observeMarginMs) / 1000)} s after it started.`);
      }
      await this.#sleep(this.#pollMs);
    }
  }

  /** Waits until an operation reaches one of `statuses` (or ends), within `withinMs`. */
  async waitFor(operationId: string, statuses: readonly OperationStatus[], withinMs: number): Promise<OperationStatus | "UNKNOWN"> {
    const deadline = this.#now() + withinMs;
    for (;;) {
      const status = readStatus((await this.#api.operation(operationId)).status);
      if (status !== "UNKNOWN" && (statuses.includes(status) || TERMINAL.has(status))) return status;
      if (this.#now() > deadline) return status;
      await this.#sleep(this.#pollMs);
    }
  }

  /** Asks an operation to stop, then polls until it has ended; null when it hadn't within the wait. */
  async cancel(operationId: string): Promise<Outcome | null> {
    this.#journal.append({ kind: "cancel", wall: this.#wallNow().toISOString(), operationId });
    await this.#api.cancel(operationId);
    const deadline = this.#now() + this.#cancelWaitMs;
    for (;;) {
      const operation = await this.#api.operation(operationId);
      const status = readStatus(operation.status);
      if (status !== "UNKNOWN" && TERMINAL.has(status)) {
        this.#journal.append({ kind: "terminal", wall: this.#wallNow().toISOString(), operationId, status });
        return classify(operation);
      }
      if (this.#now() > deadline) {
        this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation: null, operationId, reason: "a cancel didn't reach a terminal state in time" });
        return null;
      }
      await this.#sleep(this.#pollMs);
    }
  }

  /**
   * Looks for the operation a spawn with a lost answer may have created, by its correlation id, within bounds: a window
   * starting a day before the intent (so a stepped or skewed clock can't hide it), up to `maxPages` pages and
   * `maxCandidates` operations read in full. Exactly one match is adopted; otherwise it stays unknown, with the bounds.
   */
  async reconcile(correlation: string): Promise<{ operationId: string } | { unknown: string }> {
    const intent = this.#journal.entries.find((e) => e.kind === "intent" && e.correlation === correlation);
    const wall = intent && "wall" in intent ? Date.parse(intent.wall) : this.#wallNow().getTime();
    const since = new Date(wall - this.#search.sinceMarginMs).toISOString();
    const matches = new Set<string>();
    let candidates = 0;
    let pages = 0;
    let exhausted = false;
    search: for (; pages < this.#search.maxPages; pages++) {
      const page = await this.#api.list({ kind: "instance", since, limit: this.#search.pageSize, offset: pages * this.#search.pageSize });
      for (const summary of page) {
        if (candidates >= this.#search.maxCandidates) break search;
        candidates++;
        const env = summary.metadata?.env ?? (await this.#api.operation(summary.uuid)).metadata?.env ?? null;
        if (env?.[CORRELATION] === correlation) matches.add(summary.uuid);
      }
      if (page.length < this.#search.pageSize) {
        exhausted = true;
        break;
      }
    }
    if (matches.size === 1) {
      const operationId = [...matches][0]!;
      this.#journal.append({ kind: "found", wall: this.#wallNow().toISOString(), correlation, operationId });
      return { operationId };
    }
    const bounds = `${pages + (exhausted ? 1 : 0)} page(s) of ${this.#search.pageSize}, ${candidates} operation(s) read, since ${since}`;
    const reason = matches.size > 1 ? `${matches.size} operations carry its correlation id (${bounds})` : `no operation with its correlation id was found within ${bounds}${exhausted ? "" : "; the search stopped at its bounds"}`;
    this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation, operationId: null, reason });
    return { unknown: reason };
  }

  /**
   * After a failure or an interruption, in this order, so an operation found by searching is stopped too: reconcile the
   * uncertain spawns, cancel every operation that hasn't ended (known or just found), wait for each to end, search once
   * more, and journal what stays unresolved, for `--recover`.
   */
  async cleanup(): Promise<{ cancelled: string[]; unresolved: string[] }> {
    for (const { correlation } of this.#journal.open().uncertain) await this.reconcile(correlation).catch(() => undefined);
    const cancelled: string[] = [];
    const stopAll = async () => {
      for (const operationId of this.#journal.open().operations) {
        const outcome = await this.cancel(operationId).catch(() => null);
        if (outcome) cancelled.push(operationId);
      }
    };
    await stopAll();
    for (const { correlation } of this.#journal.open().uncertain) await this.reconcile(correlation).catch(() => undefined);
    await stopAll();
    const open = this.#journal.open();
    const unresolved = [...open.operations, ...open.uncertain.map((u) => `spawn ${u.label} (${u.correlation})`)];
    for (const item of unresolved) this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation: null, operationId: null, reason: `still open after cleanup: ${item}` });
    return { cancelled, unresolved };
  }

  /**
   * Starts a subprocess in a running operation, with a correlation id. A 504 may have started it: the operation's
   * events are read for a spawn carrying that id; without one it stays uncertain, and is never started again.
   */
  async subprocess(operationId: string, input: { label: string; command: string; args: string[]; env?: Record<string, string> }): Promise<{ spid: number } | { uncertain: string }> {
    const correlation = randomUUID();
    const answer = await this.#api.spawnSubprocess(operationId, { command: input.command, args: input.args, shell: false, env: { ...input.env, [CORRELATION]: correlation } });
    if (answer.status === "created") return { spid: answer.spid };
    const events = await this.#api.events(operationId).catch(() => "");
    for (const line of events.split("\n")) {
      if (!line.startsWith("data:") || !line.includes(correlation)) continue;
      try {
        const event = JSON.parse(line.slice(5)) as { type?: unknown; spid?: unknown };
        if (String(event.type).includes("spawn") && typeof event.spid === "number") return { spid: event.spid };
      } catch {
        // Not an event Nivra reads.
      }
    }
    return { uncertain: `the subprocess ${input.label} may or may not have started (${answer.cause})` };
  }

  /** A subprocess's result, polled until it has an exit code, within `withinMs`. */
  async subprocessResult(operationId: string, spid: number, withinMs: number): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string } | null> {
    const deadline = this.#now() + withinMs;
    for (;;) {
      const raw = (await this.#api.subprocess(operationId, spid)) as { state?: { exit_code?: unknown; timed_out?: unknown } | null; stdout?: { value?: string; encoding?: string } | null; stderr?: { value?: string; encoding?: string } | null } | null;
      const exitCode = typeof raw?.state?.exit_code === "number" ? raw.state.exit_code : null;
      if (exitCode !== null) return { exitCode, timedOut: raw?.state?.timed_out === true, stdout: text(raw?.stdout), stderr: text(raw?.stderr) };
      if (this.#now() > deadline) return null;
      await this.#sleep(this.#pollMs);
    }
  }

  /** A file from an image, bounded, and checked against the hash the operation printed when there is one. */
  async download(image: string, path: string, maxBytes: number, expectedSha256: string | null): Promise<{ bytes: Uint8Array; sha256: string }> {
    const bytes = await this.#api.download(image, path, maxBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expectedSha256 !== null && sha256 !== expectedSha256) throw new SandboxRefusal(`The downloaded ${path} doesn't match the hash the operation printed.`);
    return { bytes, sha256 };
  }
}
