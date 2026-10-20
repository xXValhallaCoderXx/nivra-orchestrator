import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { readStatus, SandboxCancelledError, SandboxDeadlineError, SandboxHttpError, SandboxNotSentError, sleepFor, TERMINAL, type FileRef, type Operation, type OperationStatus, type SandboxApi, type SpawnAnswer, type SpawnBody } from "./api.ts";

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
 * - Every request and every wait has a deadline, writes included (D33): no request is sent, and no answer taken, once
 *   it has passed, and a write needs the client's `minWriteMs` left. An optional cap (the probe's overall deadline, or
 *   cleanup's) bounds them all, read afresh on every pass.
 * - An optional signal cancels the work: the request under way is cut off, a wait ends at once, and nothing more is
 *   started. Cleanup runs on a sandbox with a signal and a cap of its own, so cancelling the work never cancels it.
 * - Cancelling, or a disposable run, deletes nothing: images are retained for 180 days, after which untagged and
 *   unreferenced ones may be deleted, and there is no API to delete uploads, operation records or logs.
 */

export type JournalEntry =
  | { kind: "intent"; wall: string; correlation: string; label: string }
  /** `late`: the answer came after the deadline or the cancellation, so the operation is known only for cleanup. */
  | { kind: "submitted"; wall: string; correlation: string; operationId: string; late?: true }
  /** The service turned the spawn down (4xx): it created nothing. */
  | { kind: "refused"; wall: string; correlation: string; status: number }
  /** The spawn was never handed to the transport (cancelled, or out of time): nothing reached the service. */
  | { kind: "not-sent"; wall: string; correlation: string; reason: "cancelled" | "no-time" }
  | { kind: "uncertain"; wall: string; correlation: string; cause: string }
  | { kind: "found"; wall: string; correlation: string; operationId: string }
  | { kind: "cancel"; wall: string; operationId: string }
  /** How the provider answered a cancel: `accepted` isn't a stop yet; `conflict` means it had already ended. */
  | { kind: "cancel-answer"; wall: string; operationId: string; answer: "accepted" | "conflict" }
  | { kind: "terminal"; wall: string; operationId: string; status: OperationStatus }
  | { kind: "unresolved"; wall: string; correlation: string | null; operationId: string | null; reason: string }
  /** A session (D33): the base image it starts from and the snapshot it carries, by hash only. */
  | { kind: "session"; wall: string; sessionId: string; baseImage: string; snapshotSha256: string; workspace: string }
  /** An upload about to be sent, then the id it was given: what the provider may keep, whatever happens next. */
  | { kind: "upload"; wall: string; sha256: string; bytes: number }
  | { kind: "uploaded"; wall: string; uuid: string }
  /** A result image an operation reported, adopted as the session's state or not: kept by the provider either way. */
  | { kind: "image"; wall: string; operationId: string; image: string; adopted: boolean };

/**
 * What the provider keeps, as documented on 20 October 2026. It is a retention period, not a promise of deletion, and
 * there is no API to delete anything.
 */
export const RETENTION =
  "Images are retained for 180 days; after that, untagged and unreferenced images may be deleted. That is not a deletion guarantee, and there is no API to delete uploads, operation records or logs. Cancelling, or a disposable run, deletes nothing.";

/**
 * Everything the probe did, one JSON line per entry, written and flushed before the request it describes. With a file,
 * the file is the record: every read takes it afresh, so a fresh client (a reconnect, `--recover`) and the one before it
 * agree.
 */
export class Journal {
  readonly #path: string | null;
  readonly #memory: JournalEntry[] = [];

  constructor(path: string | null = null) {
    this.#path = path;
  }

  /** Written and flushed before anything is sent, so a crash right after the request can't lose its record. */
  append(entry: JournalEntry): void {
    if (!this.#path) {
      this.#memory.push(entry);
      return;
    }
    const fd = openSync(this.#path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The entries as written. A crash in the middle of a write leaves a last line with no newline, and it is left out.
   * That loses nothing that was sent unrecorded: an intent is flushed before its request, so a torn intent was never
   * sent, and a torn record of an answer leaves its intent unsettled, so the spawn stays uncertain and is looked for. A
   * damaged line anywhere else means the record can't be trusted, and is said so.
   */
  get entries(): readonly JournalEntry[] {
    if (!this.#path) return this.#memory;
    if (!existsSync(this.#path)) return [];
    const text = readFileSync(this.#path, "utf8");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    return complete
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as JournalEntry;
        } catch {
          throw new SandboxRefusal(`The journal at ${this.#path} is damaged at line ${index + 1}, so what it records can't be trusted. Check the operations it names before starting more.`);
        }
      });
  }

  /**
   * Operations known and not yet seen to end, and spawns whose operation hasn't been found: what cleanup must settle.
   * A spawn is settled only by its answer, by being found, by the service turning it down, or by never having been
   * sent. Every other intent is uncertain, whether or not its lost answer was journaled: a probe that dies after sending
   * a spawn, before its answer arrives, leaves only the intent, and the operation may be running.
   */
  open(): { operations: string[]; uncertain: Array<{ correlation: string; wall: string; label: string }> } {
    const entries = this.entries;
    const ended = new Set(entries.flatMap((e) => (e.kind === "terminal" ? [e.operationId] : [])));
    const operations = [...new Set(entries.flatMap((e) => (e.kind === "submitted" || e.kind === "found" ? [e.operationId] : [])))].filter((id) => !ended.has(id));
    const settled = new Set(entries.flatMap((e) => (e.kind === "submitted" || e.kind === "found" || e.kind === "refused" || e.kind === "not-sent" ? [e.correlation] : [])));
    const uncertain = entries.flatMap((e) => (e.kind === "intent" && !settled.has(e.correlation) ? [{ correlation: e.correlation, wall: e.wall, label: e.label }] : []));
    return { operations, uncertain };
  }

  /** How many spawns were sent for a label: the evidence that nothing was sent twice. One never sent doesn't count. */
  spawnsOf(label: string): number {
    const entries = this.entries;
    const unsent = new Set(entries.flatMap((e) => (e.kind === "not-sent" ? [e.correlation] : [])));
    return entries.filter((e) => e.kind === "intent" && e.label === label && !unsent.has(e.correlation)).length;
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
  /** Any result image the service named, whatever the status: what it keeps, counted for retention. */
  imageReported: string | null;
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

/**
 * Whether a reported signal means one ended the command. The service reports -1 when none did, and the signal's
 * number when one did, with exit code -1 (seen live on 20 October 2026); a name counts too.
 */
const ended = (signal: number | string | null): boolean => (typeof signal === "number" ? signal > 0 : typeof signal === "string" ? signal.trim() !== "" && Number(signal) !== -1 && signal !== "0" : false);

/** What an operation's answer says happened, the operation's status kept apart from its command's outcome. */
export function classify(operation: Operation): Outcome {
  const status = readStatus(operation.status);
  const result = operation.metadata?.result ?? null;
  const state = result?.state ?? null;
  const exitCode = typeof state?.exit_code === "number" ? state.exit_code : null;
  // Kept as the service reported it, for the evidence; only `ended` decides whether a signal stopped the command.
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
            : ended(signal)
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
    imageReported: operation.result_image_uuid ?? operation.result?.image ?? null,
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
  /** Where the service cuts each stream off, at most `MAX_OUTPUT_BYTES`. */
  maxOutputBytes?: number;
}

export interface SandboxOptions {
  journal: Journal;
  /** How long to keep observing past an operation's own timeout. */
  observeMarginMs?: number;
  pollMs?: number;
  /** How long a cancel may take to reach a terminal state. */
  cancelWaitMs?: number;
  /** Bounds on looking for a spawn whose answer was lost, its time among them (120 s unless given). */
  search?: { sinceMarginMs: number; pageSize: number; maxPages: number; maxCandidates: number; withinMs?: number };
  /** The longest timeout a step may ask for. */
  maxTimeoutSeconds?: number;
  /** Waiting, ended early by the signal; tests replace it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A monotonic clock, in ms. */
  now?: () => number;
  wallNow?: () => Date;
  /** The latest any wait may end, on the same clock: the probe's overall deadline, or cleanup's own. */
  cap?: () => number;
  /** Cancels the work. The sandbox's client should carry the same signal, so a request under way is cut off too. */
  signal?: AbortSignal;
}

const CORRELATION = "NIVRA_CORRELATION";
const MAX_OUTPUT_BYTES = 65_536;

export class Sandbox {
  readonly #api: SandboxApi;
  readonly #journal: Journal;
  readonly #observeMarginMs: number;
  readonly #pollMs: number;
  readonly #cancelWaitMs: number;
  readonly #search: Required<NonNullable<SandboxOptions["search"]>>;
  readonly #maxTimeoutSeconds: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #wallNow: () => Date;
  readonly #cap: (() => number) | null;
  readonly #signal: AbortSignal | null;

  constructor(api: SandboxApi, options: SandboxOptions) {
    this.#api = api;
    this.#journal = options.journal;
    this.#observeMarginMs = options.observeMarginMs ?? 60_000;
    this.#pollMs = options.pollMs ?? 1_000;
    this.#cancelWaitMs = options.cancelWaitMs ?? 60_000;
    this.#search = { withinMs: 120_000, ...(options.search ?? { sinceMarginMs: 24 * 60 * 60 * 1000, pageSize: 100, maxPages: 10, maxCandidates: 50 }) };
    this.#maxTimeoutSeconds = options.maxTimeoutSeconds ?? 180;
    this.#sleep = options.sleep ?? sleepFor;
    this.#now = options.now ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? (() => new Date());
    this.#cap = options.cap ?? null;
    this.#signal = options.signal ?? null;
  }

  get journal(): Journal {
    return this.#journal;
  }

  /** A wait's deadline, no later than the cap as it is now: a loop asks again on every pass. */
  #until(deadline: number): number {
    return Math.min(deadline, this.#cap ? this.#cap() : Number.POSITIVE_INFINITY);
  }

  /** Whether a write still fits under the cap: it needs the client's `minWriteMs` left to be sent at all. */
  #writeFits(): boolean {
    return this.#until(Number.POSITIVE_INFINITY) - this.#now() >= this.#api.minWriteMs;
  }

  /**
   * Refuses to start anything once the work is cancelled, or with too little time left under the cap for its request:
   * nothing is sent, and nothing journaled.
   */
  #refuseAfterCap(what: string): void {
    if (this.#signal?.aborted) throw new SandboxCancelledError(`Starting ${what}`);
    if (!this.#writeFits()) throw new SandboxRefusal(`The time for this work ran out, so ${what} wasn't started.`);
  }

  /** A poll's wait, ended at once by the signal, which then stops the loop. */
  async #pause(ms: number, what: string): Promise<void> {
    await this.#sleep(ms, this.#signal ?? undefined);
    if (this.#signal?.aborted) throw new SandboxCancelledError(what);
  }

  /**
   * An operation as read before `deadline`; null when the read was cut off by it, or answered only once it had passed. A
   * read that gave up on its own budget while the deadline is still ahead is a failure, and is thrown as one.
   */
  async #readBy(operationId: string, deadline: number): Promise<Operation | null> {
    try {
      const operation = await this.#api.operation(operationId, { until: deadline });
      return this.#now() < deadline ? operation : null;
    } catch (error) {
      if (error instanceof SandboxDeadlineError && this.#now() >= deadline) return null;
      throw error;
    }
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
      truncate_output_at: Math.min(step.maxOutputBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
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
    this.#refuseAfterCap(`the ${label} operation`);
    const open = this.#journal.open();
    if (open.operations.length || open.uncertain.length) throw new SandboxRefusal("One operation at a time: an earlier one hasn't ended, or a spawn whose answer was lost hasn't been settled.");
    const correlation = randomUUID();
    this.#journal.append({ kind: "intent", wall: this.#wallNow().toISOString(), correlation, label });
    let answer: SpawnAnswer;
    try {
      answer = await this.#api.spawn({ ...body, env: { ...body.env, [CORRELATION]: correlation } }, { ...options, until: this.#until(Number.POSITIVE_INFINITY) });
    } catch (error) {
      // Turned down, or never sent, so nothing was created. Any other failure leaves the intent open, for cleanup to
      // look for.
      if (error instanceof SandboxHttpError && error.status >= 400 && error.status <= 499) this.#journal.append({ kind: "refused", wall: this.#wallNow().toISOString(), correlation, status: error.status });
      else if (error instanceof SandboxNotSentError) this.#journal.append({ kind: "not-sent", wall: this.#wallNow().toISOString(), correlation, reason: error.reason });
      throw error;
    }
    if (answer.status === "created") {
      this.#journal.append({ kind: "submitted", wall: this.#wallNow().toISOString(), correlation, operationId: answer.id, ...(answer.late ? { late: true as const } : {}) });
      // Known only so that cleanup can stop it: an answer after the deadline, or the cancellation, starts nothing more.
      if (answer.late) throw this.#signal?.aborted ? new SandboxCancelledError(`Starting the ${label} operation`) : new SandboxRefusal(`The ${label} operation was answered only after its deadline, so it isn't used; cleanup stops it.`);
      return { operationId: answer.id };
    }
    this.#journal.append({ kind: "uncertain", wall: this.#wallNow().toISOString(), correlation, cause: answer.cause });
    return { uncertain: correlation };
  }

  /**
   * Polls an operation until it ends, within its own timeout plus the margin, or the cap if that comes first. An
   * operation not seen to end by then is journaled as unresolved, for cleanup to settle.
   */
  async observe(operationId: string, timeoutSeconds: number): Promise<Outcome> {
    const started = this.#now();
    const end = started + timeoutSeconds * 1000 + this.#observeMarginMs;
    for (let deadline = this.#until(end); this.#now() < deadline; deadline = this.#until(end)) {
      const operation = await this.#readBy(operationId, deadline);
      if (!operation) break;
      const status = readStatus(operation.status);
      if (status !== "UNKNOWN" && TERMINAL.has(status)) {
        this.#journal.append({ kind: "terminal", wall: this.#wallNow().toISOString(), operationId, status });
        return classify(operation);
      }
      await this.#pause(Math.min(this.#pollMs, deadline - this.#now()), "Observing an operation");
    }
    this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation: null, operationId, reason: "it wasn't seen to end before observing it ran out of time" });
    throw new SandboxRefusal(`Operation ${operationId} wasn't seen to end within ${Math.max(0, Math.round((this.#until(end) - started) / 1000))} s.`);
  }

  /** Waits until an operation reaches one of `statuses` (or ends), within `withinMs`; the last status seen otherwise. */
  async waitFor(operationId: string, statuses: readonly OperationStatus[], withinMs: number): Promise<OperationStatus | "UNKNOWN"> {
    const end = this.#now() + withinMs;
    let status: OperationStatus | "UNKNOWN" = "UNKNOWN";
    for (let deadline = this.#until(end); this.#now() < deadline; deadline = this.#until(end)) {
      const operation = await this.#readBy(operationId, deadline);
      if (!operation) break;
      status = readStatus(operation.status);
      if (status !== "UNKNOWN" && (statuses.includes(status) || TERMINAL.has(status))) return status;
      await this.#pause(Math.min(this.#pollMs, deadline - this.#now()), "Waiting for an operation");
    }
    return status;
  }

  /**
   * Asks an operation to stop, then polls until it has ended; null when it hadn't within the wait (or the cap). With too
   * little time left under the cap for the request, no cancel is sent: the operation is journaled unresolved, for
   * `--recover`.
   */
  async cancel(operationId: string): Promise<Outcome | null> {
    if (this.#signal?.aborted) throw new SandboxCancelledError("Cancelling an operation");
    if (!this.#writeFits()) {
      this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation: null, operationId, reason: "no time was left to cancel it" });
      return null;
    }
    this.#journal.append({ kind: "cancel", wall: this.#wallNow().toISOString(), operationId });
    const answer = await this.#api.cancel(operationId, { until: this.#until(Number.POSITIVE_INFINITY) });
    this.#journal.append({ kind: "cancel-answer", wall: this.#wallNow().toISOString(), operationId, answer });
    const end = this.#now() + this.#cancelWaitMs;
    for (let deadline = this.#until(end); this.#now() < deadline; deadline = this.#until(end)) {
      const operation = await this.#readBy(operationId, deadline);
      if (!operation) break;
      const status = readStatus(operation.status);
      if (status !== "UNKNOWN" && TERMINAL.has(status)) {
        this.#journal.append({ kind: "terminal", wall: this.#wallNow().toISOString(), operationId, status });
        return classify(operation);
      }
      await this.#pause(Math.min(this.#pollMs, deadline - this.#now()), "Cancelling an operation");
    }
    this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation: null, operationId, reason: "a cancel didn't reach a terminal state in time" });
    return null;
  }

  /**
   * Looks for the operation a spawn with a lost answer may have created, by its correlation id, within bounds: a window
   * starting a day before the intent (so a stepped or skewed clock can't hide it), up to `maxPages` pages and
   * `maxCandidates` operations read in full, and `withinMs` of searching (or the cap). Exactly one match is adopted;
   * otherwise it stays unknown, with the bounds it was searched within.
   */
  async reconcile(correlation: string): Promise<{ operationId: string } | { unknown: string }> {
    const intent = this.#journal.entries.find((e) => e.kind === "intent" && e.correlation === correlation);
    const wall = intent && "wall" in intent ? Date.parse(intent.wall) : this.#wallNow().getTime();
    const since = new Date(wall - this.#search.sinceMarginMs).toISOString();
    const end = this.#now() + this.#search.withinMs;
    const matches = new Set<string>();
    let candidates = 0;
    let pages = 0;
    let exhausted = false;
    let outOfTime = false;
    search: for (; pages < this.#search.maxPages; pages++) {
      let page: Operation[];
      try {
        if (this.#now() >= this.#until(end)) throw new SandboxDeadlineError("Listing operations", null);
        page = await this.#api.list({ kind: "instance", since, limit: this.#search.pageSize, offset: pages * this.#search.pageSize }, { until: this.#until(end) });
      } catch (error) {
        if (!(error instanceof SandboxDeadlineError)) throw error;
        outOfTime = true;
        break;
      }
      for (const summary of page) {
        if (candidates >= this.#search.maxCandidates) break search;
        let env = summary.metadata?.env ?? null;
        if (env === null) {
          const operation = await this.#readBy(summary.uuid, this.#until(end));
          if (!operation) {
            outOfTime = true;
            break search;
          }
          env = operation.metadata?.env ?? null;
        }
        candidates++;
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
    const stopped = exhausted ? "" : outOfTime ? "; the search stopped at its time limit" : "; the search stopped at its bounds";
    const reason = matches.size > 1 ? `${matches.size} operations carry its correlation id (${bounds})` : `no operation with its correlation id was found within ${bounds}${stopped}`;
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
    this.#refuseAfterCap(`the subprocess ${input.label}`);
    const correlation = randomUUID();
    const answer = await this.#api.spawnSubprocess(operationId, { command: input.command, args: input.args, shell: false, env: { ...input.env, [CORRELATION]: correlation } }, { until: this.#until(Number.POSITIVE_INFINITY) });
    if (answer.status === "created") return { spid: answer.spid };
    const events = await this.#api.events(operationId, { until: this.#until(Number.POSITIVE_INFINITY) }).catch(() => "");
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

  /**
   * A subprocess's result, polled until it has ended, within `withinMs`; null when it hadn't by then. A signalled child
   * reports exit code -1 and its signal. While the child runs the service says when to ask again (HTTP 425): that wait
   * is honoured, never past the deadline. Once the deadline is reached no request is made and no answer is taken, so a
   * result shows the child ended within the limit: the probe counts it as evidence that a cancel stopped the child.
   */
  async subprocessResult(operationId: string, spid: number, withinMs: number): Promise<{ exitCode: number | null; signal: number | string | null; timedOut: boolean; stdout: string; stderr: string } | null> {
    const end = this.#now() + withinMs;
    for (let deadline = this.#until(end); this.#now() < deadline; deadline = this.#until(end)) {
      let answer: Awaited<ReturnType<SandboxApi["subprocess"]>>;
      try {
        answer = await this.#api.subprocess(operationId, spid, { until: deadline });
      } catch (error) {
        if (error instanceof SandboxDeadlineError && this.#now() >= deadline) return null;
        throw error;
      }
      // An answer that arrives once the time is up says nothing about the limit.
      if (this.#now() >= deadline) return null;
      let wait = this.#pollMs;
      if (answer.status === "ready") {
        const raw = answer.result as { state?: { exit_code?: unknown; signal?: unknown; timed_out?: unknown } | null; stdout?: { value?: string; encoding?: string } | null; stderr?: { value?: string; encoding?: string } | null } | null;
        const exitCode = typeof raw?.state?.exit_code === "number" ? raw.state.exit_code : null;
        const signal = typeof raw?.state?.signal === "number" || typeof raw?.state?.signal === "string" ? raw.state.signal : null;
        if (exitCode !== null || signal !== null) return { exitCode, signal, timedOut: raw?.state?.timed_out === true, stdout: text(raw?.stdout), stderr: text(raw?.stderr) };
      } else if (answer.retryAfterMs !== null) {
        wait = Math.max(wait, answer.retryAfterMs);
      }
      await this.#pause(Math.min(wait, deadline - this.#now()), "Reading a subprocess");
    }
    return null;
  }

  /** A file from an image, bounded, and checked against the hash the operation printed when there is one. */
  async download(image: string, path: string, maxBytes: number, expectedSha256: string | null): Promise<{ bytes: Uint8Array; sha256: string }> {
    const bytes = await this.#api.download(image, path, maxBytes, { until: this.#until(Number.POSITIVE_INFINITY) });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expectedSha256 !== null && sha256 !== expectedSha256) throw new SandboxRefusal(`The downloaded ${path} doesn't match the hash the operation printed.`);
    return { bytes, sha256 };
  }
}
