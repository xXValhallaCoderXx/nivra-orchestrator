import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { gzipSync } from "node:zlib";
import { OUTPUT_DIRS } from "../../repo/deny.ts";
import { BoundaryUnavailableError, checkRequirements, ExecRefusedError, ExecUncertainError, SessionOpenError, type CloseReport, type ExecRequest, type ExecResult, type ExecutionBackend, type ExecutionCapabilities, type ExecutionSession, type SessionSnapshot, type SessionSpec, type SessionStep } from "../backend.ts";
import { fetchTransport, SandboxApi, SandboxCancelledError, SandboxDeadlineError, SandboxHttpError, SandboxNotSentError, SandboxTooLargeError, sleepFor, type Transport } from "./api.ts";
import { Journal, RETENTION, Sandbox, SandboxLateSpawnError, SandboxRefusal, type JournalEntry, type Outcome, type SandboxOptions, type StepSpec } from "./sandbox.ts";

/**
 * Nebius Token Factory Sandboxes as an execution session (NIV-41, D33), on the pattern D28 adopted: each command is one
 * operation, started from the image the last persisted one left, with networking off. No process outlives its
 * command; files carry on through images only.
 *
 * - `open` refuses before anything is sent when it can't do what was asked: no key, the network not denied, no
 *   snapshot, or a snapshot over the upload limit once compressed. Otherwise it journals the session, uploads the
 *   snapshot once, compressed, and runs one prepare operation that extracts it over what the base image's workspace
 *   holds and prints a digest of what it then holds, dependency and build output left out, checked against the
 *   snapshot's. Its image is the first state.
 * - One owned operation at a time. Each command's intent is journaled and flushed before it is sent; a lost answer is
 *   looked for by its correlation id and never sent again. Every request ends by the session's deadline (D33).
 * - The state moves on only when a persisted command ended on its own, with SUCCESS and an image it kept. A persisted
 *   command whose changes weren't kept leaves the session stale: nothing more runs on an older copy of the workspace.
 *   An image the service no longer has means the state is lost, and nothing is recreated from the snapshot.
 * - Closing has one budget, which includes stopping the command under way: it reconciles, cancels only this
 *   session's own operations, searches again, and reports what it couldn't settle and what the service keeps. It
 *   never rejects, and a second close gives the same report.
 * - Recovery, for what an earlier engine left: a local scan of the journals, then one bounded pass. Nothing is
 *   replayed. Age alone never settles an operation: one still queued long after its timeout stays unresolved, for the
 *   next pass and for a person to check.
 * - Credentials come from a closure over the engine's memory (D8). The guest gets only what a command is given, and a
 *   correlation id.
 */

/** What the backend enforces, each with a contract test; D28 showed network denial and continuation live. */
export const NEBIUS_CAPABILITIES: ExecutionCapabilities = Object.freeze({
  isolatesFilesystem: true,
  networkPolicy: "onOff",
  injectsCredentials: false,
  persistsBetweenExecs: true,
});

export interface NebiusLimits {
  /** Operations one session may start, the prepare step included. */
  maxOperations: number;
  /** The longest a command may run (the account allows up to 3,600 s). */
  maxTimeoutSeconds: number;
  /** The snapshot as it is uploaded, compressed. */
  maxUploadBytes: number;
  maxDownloadBytes: number;
  /** Where the service cuts each stream off. */
  maxOutputBytes: number;
  requestTimeoutMs: number;
  /** The least time a POST or DELETE needs left to be sent at all. */
  minWriteMs: number;
  /** How long to keep observing past a command's own timeout. */
  observeMarginMs: number;
  pollMs: number;
  /** How long a cancel may take to reach a terminal state. */
  cancelWaitMs: number;
  /** How long to look for a spawn whose answer was lost. */
  searchMs: number;
  prepareTimeoutSeconds: number;
  /** A session's whole time when its spec gives none. */
  sessionBudgetMs: number;
  /** Closing's whole time when it is given none. */
  cleanupBudgetMs: number;
}

export const NEBIUS_LIMITS: Readonly<NebiusLimits> = Object.freeze({
  maxOperations: 40,
  maxTimeoutSeconds: 600,
  maxUploadBytes: 8 * 1024 * 1024,
  maxDownloadBytes: 16 * 1024 * 1024,
  maxOutputBytes: 65_536,
  requestTimeoutMs: 30_000,
  minWriteMs: 2_000,
  observeMarginMs: 60_000,
  pollMs: 1_000,
  cancelWaitMs: 60_000,
  searchMs: 120_000,
  prepareTimeoutSeconds: 120,
  sessionBudgetMs: 30 * 60_000,
  cleanupBudgetMs: 7 * 60_000,
});

export interface NebiusCredentials {
  key: string;
  project: string;
}

export interface NebiusBackendOptions {
  /** The key and project id, read from the engine's memory (D8); null when they haven't been given. */
  credentials: () => NebiusCredentials | null;
  /**
   * The image every session starts from, by its id: a public one (chosen from stage 0's list), or one prepared from
   * it whose workspace already holds dependency or build output folders (`OUTPUT_DIRS`, such as `node_modules` at any
   * depth). The snapshot is extracted over that workspace, never into an emptied one. The prepare step's listing leaves
   * those folders out, as a snapshot does, so everything else there must be exactly the snapshot.
   */
  baseImage: string;
  /** Where each session's journal goes: one file per session, 0600, in a 0700 folder. */
  journalDir: string;
  limits?: Partial<NebiusLimits>;
  /** The transport for these credentials; tests give a fake. */
  transport?: (credentials: NebiusCredentials) => Transport;
  /** What runs the prepare step's tools inside the sandbox: busybox, on the base image. */
  applets?: string;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  wallNow?: () => Date;
}

/** The sandbox couldn't run the command: its operation failed, so nothing is known about what the command did. */
export class SandboxOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxOperationError";
  }
}

/** One file of a workspace, as the prepare step lists it: a regular file, or a symbolic link. */
export type ListingEntry = { path: string; kind: "file"; executable: boolean; sha256: string } | { path: string; kind: "link"; target: string };

/** One line of the canonical listing the prepare step prints, for a path relative to the workspace. */
export function listingLine(entry: ListingEntry): string {
  return entry.kind === "link" ? `l ${entry.target} ./${entry.path}\n` : `f ${entry.executable ? "x" : "-"} ${entry.sha256} ./${entry.path}\n`;
}

/**
 * The digest of a workspace's canonical listing: one line per file or link, sorted by its path's bytes as `sort` does
 * under LC_ALL=C, hashed. The prepare step prints the same from what it extracted, so the two agree only when the
 * sandbox holds exactly the snapshot.
 */
export function listingDigest(entries: readonly ListingEntry[]): { digest: string; entries: number } {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(`./${a.path}`), Buffer.from(`./${b.path}`)));
  return { digest: sha256(sorted.map(listingLine).join("")), entries: sorted.length };
}

/**
 * The snapshot as it is uploaded: its tar, gzip-compressed at level 9, with no time and no system in the header, so
 * the bytes hold nothing of when or where they were made. The prepare step extracts it with `tar -z`. The tar's own
 * sha256 stays the snapshot's identity; the upload limit applies to these bytes.
 */
export function compressSnapshot(archive: Uint8Array): Uint8Array {
  const compressed = gzipSync(archive, { level: 9 });
  // RFC 1952's header: bytes 4 to 7 are the time it was made, and byte 9 the system (255, unknown).
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  return compressed;
}

/**
 * find's expression for the dependency and build output folders (`OUTPUT_DIRS`), at any depth: each one met is left
 * out with all it holds. A snapshot never holds a file under one, so in the prepare step it leaves out only what the
 * base image brings (a prepared image's `node_modules`), and the collect step never brings such a folder back.
 */
export const OUTPUT_PRUNE = OUTPUT_DIRS.map((name) => `-type d -name ${name} -prune -o`).join(" ");

/** Where the snapshot and the listing go on the sandbox's machine: outside the workspace, so neither is in it. */
const ARCHIVE = "/nivra/snapshot.tar";
const LISTING = "/nivra/listing";

/**
 * The prepare step: a fixed script, given everything as positional arguments, so nothing is interpolated into it. $1
 * the workspace, $2 the archive (compressed), $3 what runs the tools (busybox), $4 the listing. It extracts the archive
 * over what the workspace already holds, removes it, and prints the line count and digest of the workspace's listing,
 * output folders left out. Paths with a newline in them are refused before anything is sent.
 */
export const PREPARE_SCRIPT = [
  "set -e",
  'bb="$3"',
  '$bb mkdir -p "$1"',
  '$bb tar -x -z -f "$2" -C "$1"',
  '$bb rm -f "$2"',
  'cd "$1"',
  `$bb find . ${OUTPUT_PRUNE} \\( -type f -o -type l \\) -print > "$4.paths"`,
  'LC_ALL=C $bb sort "$4.paths" > "$4.sorted"',
  ': > "$4"',
  "while IFS= read -r p; do",
  '  if [ -L "$p" ]; then',
  '    printf \'l %s %s\\n\' "$($bb readlink "$p")" "$p" >> "$4"',
  "  else",
  '    if [ -x "$p" ]; then x=x; else x=-; fi',
  '    printf \'f %s %s %s\\n\' "$x" "$($bb sha256sum < "$p" | $bb cut -d \' \' -f 1)" "$p" >> "$4"',
  "  fi",
  'done < "$4.sorted"',
  '$bb rm -f "$4.paths" "$4.sorted"',
  'echo "entries $($bb wc -l < "$4")"',
  'echo "digest $($bb sha256sum < "$4" | $bb cut -d \' \' -f 1)"',
].join("\n");

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
/** An image id as Nivra will use one: anything else is no image it can continue from. */
const IMAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CORRELATION = "NIVRA_CORRELATION";
/** Linux's signal numbers, as the sandbox's machine reports them, whatever the engine's own platform. */
const LINUX_SIGNALS = ["", "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR", "SIGSYS"];

/** A signal as a name, or null when none ended the command (the service reports -1 then). */
export function signalName(raw: number | string | null): string | null {
  if (typeof raw === "number") return raw > 0 ? LINUX_SIGNALS[raw] || `signal ${raw}` : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" || trimmed === "-1" || trimmed === "0" ? null : trimmed;
  }
  return null;
}

/** Text kept to `maxBytes` of UTF-8, saying whether anything was cut. */
function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= maxBytes ? { text, truncated: false } : { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Usage as the service reported it, or null when it reported none of it. Never money. */
function usageOf(outcome: Outcome): unknown {
  const { durationSeconds, consumedCpu, consumedMemory, imageSize, resources } = outcome.usage;
  return [durationSeconds, consumedCpu, consumedMemory, imageSize, resources].every((value) => value === null || value === undefined) ? null : outcome.usage;
}

/** A path on the sandbox's machine, as Nivra will pass one: absolute, normal, one visible line. */
function guestPath(path: string): boolean {
  return posix.isAbsolute(path) && posix.normalize(path) === path && path.length <= 4_096 && !/[\p{Cc}]/u.test(path);
}

function insideWorkspace(workspace: string, path: string): boolean {
  if (!guestPath(path)) return false;
  const rel = posix.relative(workspace, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../"));
}

/** What a step's journal entries say about the cancels it sent: stopped (CANCELLED after an accepted cancel) or not. */
function cancelsIn(entries: readonly JournalEntry[]): { stopped: string[]; alreadyEnded: string[] } {
  const accepted = new Set<string>();
  const asked = new Set<string>();
  const terminal = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === "cancel") asked.add(entry.operationId);
    if (entry.kind === "cancel-answer" && entry.answer === "accepted") accepted.add(entry.operationId);
    if (entry.kind === "terminal") terminal.set(entry.operationId, entry.status);
  }
  const stopped = [...asked].filter((id) => terminal.get(id) === "CANCELLED" && accepted.has(id));
  const alreadyEnded = [...asked].filter((id) => terminal.has(id) && !stopped.includes(id));
  return { stopped, alreadyEnded };
}

/** What the service keeps from a session, counted from its journal: the record that outlives any client. */
/** What the provider keeps of what a journal records: its uploads, the images reported, and every operation known or maybe started. */
export function retainedIn(entries: readonly JournalEntry[]): CloseReport["retained"] {
  const uploads = entries.filter((e) => e.kind === "upload").length;
  const images = new Set(entries.flatMap((e) => (e.kind === "image" ? [e.image] : []))).size;
  const known = new Set(entries.flatMap((e) => (e.kind === "submitted" || e.kind === "found" ? [e.operationId] : [])));
  const settled = new Set(entries.flatMap((e) => (e.kind === "submitted" || e.kind === "found" || e.kind === "refused" || e.kind === "not-sent" ? [e.correlation] : [])));
  const maybe = entries.filter((e) => e.kind === "intent" && !settled.has(e.correlation)).length;
  return { uploads, images, operations: known.size + maybe, note: RETENTION };
}

/**
 * Moves a journal whose session left nothing open into `settled/` beside it, so that scanning at engine start reads
 * only the journals that may still need something, however many sessions came before. It is kept, not deleted: it is
 * the record of what was sent.
 */
export function settleJournal(path: string): void {
  const folder = join(dirname(path), "settled");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  renameSync(path, join(folder, basename(path)));
}

/** Cleanup's unresolved items, in words a person can check. */
function describeUnresolved(item: string): string {
  const spawn = /^spawn (.*) \(([^)]+)\)$/.exec(item);
  return spawn ? `It isn't known whether "${spawn[1]}" started (correlation ${spawn[2]}); it may still be running.` : `Operation ${item} wasn't seen to end; it may still be running.`;
}

/** The longest a timer can wait: Node fires a longer one after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** The refusal for a command whose request carries a credential. */
const CARRIES_CREDENTIAL = "The command holds the sandbox's key or project id, so it wasn't sent.";

/** A command that was never sent because the work was cancelled first: Local's "not started" result. */
class NotStarted extends Error {}

/** One step's operation, seen to its end, and anything the caller's `onStart` threw, to give back once it settled. */
interface Ran {
  operationId: string;
  outcome: Outcome;
  durationMs: number;
  callbackError: unknown;
}

export function createNebiusBackend(options: NebiusBackendOptions): ExecutionBackend {
  const limits: NebiusLimits = { ...NEBIUS_LIMITS, ...options.limits };
  const backend: ExecutionBackend = {
    id: "nebius-sandbox",
    label: "Nebius Sandboxes (remote, network off)",
    capabilities: NEBIUS_CAPABILITIES,
    open: async (spec) => {
      checkRequirements(backend, spec);
      if ((spec.network ?? "open") !== "deny") throw new BoundaryUnavailableError(`"${backend.label}" runs every command with the network off, and this run asked for network access, so it was not started. Run it with the network denied.`);
      const credentials = options.credentials();
      if (!credentials) throw new BoundaryUnavailableError("Nebius Sandboxes needs your Token Factory key and a Nebius project id, and they haven't been given. Add them in Settings, then try again.");
      const snapshot = spec.snapshot;
      if (!snapshot) throw new ExecRefusedError("A Nebius session starts from a snapshot of the workspace, and none was given, so nothing was sent.");
      const sent = compressSnapshot(snapshot.archive);
      if (sent.byteLength > limits.maxUploadBytes) throw new ExecRefusedError(`The workspace's snapshot is ${sent.byteLength} bytes compressed, over the ${limits.maxUploadBytes} Nivra sends to a sandbox, so nothing was sent.`);
      if (sha256(snapshot.archive) !== snapshot.sha256) throw new ExecRefusedError("The snapshot's bytes don't match its sha256, so nothing was sent.");
      if (!guestPath(spec.workspace) || spec.workspace === "/") throw new ExecRefusedError(`The workspace must be a folder like /workspace on the sandbox's machine; "${spec.workspace}" isn't one, so nothing was sent.`);
      if (spec.signal?.aborted) throw new ExecRefusedError("This run was cancelled before anything was sent to the sandbox.");
      const session = new NebiusSession(options, limits, credentials, spec);
      await session.start(snapshot, sent);
      return session;
    },
  };
  return backend;
}

class NebiusSession implements ExecutionSession {
  readonly capabilities = NEBIUS_CAPABILITIES;
  readonly #options: NebiusBackendOptions;
  readonly #limits: NebiusLimits;
  readonly #credentials: NebiusCredentials;
  readonly #transport: Transport;
  readonly #workspace: string;
  readonly #sessionId = randomUUID();
  readonly #journalPath: string;
  readonly #journal: Journal;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #wallNow: () => Date;
  /** Stops the session's work: the spec's signal, or closing. */
  readonly #work = new AbortController();
  /** Stops cleanup itself, stopping a cancelled command included: closing's own signal. Never the work's. */
  readonly #cleanup = new AbortController();
  readonly #specSignal: AbortSignal | null;
  /** How a failed open cleans up after itself: the spec's own closing signal and budget. */
  readonly #openClosing: { signal?: AbortSignal; budgetMs?: number };
  readonly #onSpecAbort = () => this.#work.abort(this.#specSignal?.reason);
  readonly #deadline: number;
  readonly #steps: SessionStep[] = [];
  #image: string;
  #state: { kind: "open" } | { kind: "stale" | "lost" | "unsettled"; why: string } = { kind: "open" };
  #busy = false;
  #operations = 0;
  #active: Promise<unknown> = Promise.resolve();
  #closing: Promise<CloseReport> | null = null;
  /** Closing's own deadline and signal, once it has begun: the command under way stops within them. */
  #closeBounds: { deadline: number; signal: AbortSignal | null } | null = null;

  constructor(options: NebiusBackendOptions, limits: NebiusLimits, credentials: NebiusCredentials, spec: SessionSpec) {
    this.#options = options;
    this.#limits = limits;
    this.#credentials = credentials;
    this.#transport = (options.transport ?? ((given) => fetchTransport(given)))(credentials);
    this.#workspace = spec.workspace;
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? sleepFor;
    this.#wallNow = options.wallNow ?? (() => new Date());
    this.#deadline = this.#now() + (spec.budgetMs ?? limits.sessionBudgetMs);
    this.#image = options.baseImage;
    this.#specSignal = spec.signal ?? null;
    this.#openClosing = spec.closing ?? {};
    this.#specSignal?.addEventListener("abort", this.#onSpecAbort, { once: true });
    mkdirSync(options.journalDir, { recursive: true, mode: 0o700 });
    this.#journalPath = join(options.journalDir, `${this.#sessionId}.jsonl`);
    this.#journal = new Journal(this.#journalPath);
  }

  /** A client whose requests stop when `signal` aborts. */
  #client(signal: AbortSignal | null): SandboxApi {
    return new SandboxApi(this.#transport, {
      requestTimeoutMs: this.#limits.requestTimeoutMs,
      minWriteMs: this.#limits.minWriteMs,
      readDeadlineMs: this.#limits.searchMs,
      now: this.#now,
      sleep: this.#sleep,
      ...(signal ? { signal } : {}),
    });
  }

  /** The lifecycle over this session's journal, bounded by `cap` and stopped by `signal`. */
  #sandbox(api: SandboxApi, cap: () => number, signal: AbortSignal | null): Sandbox {
    const options: SandboxOptions = {
      journal: this.#journal,
      observeMarginMs: this.#limits.observeMarginMs,
      pollMs: this.#limits.pollMs,
      cancelWaitMs: this.#limits.cancelWaitMs,
      search: { sinceMarginMs: 24 * 60 * 60 * 1000, pageSize: 25, maxPages: 10, maxCandidates: 50, withinMs: this.#limits.searchMs },
      maxTimeoutSeconds: Math.max(this.#limits.maxTimeoutSeconds, this.#limits.prepareTimeoutSeconds),
      now: this.#now,
      sleep: this.#sleep,
      wallNow: this.#wallNow,
      cap,
      ...(signal ? { signal } : {}),
    };
    return new Sandbox(api, options);
  }

  /**
   * Uploads the snapshot, as `sent` (compressed), and prepares the workspace from it. The journal keeps the tar's
   * sha256 as the session's snapshot and the compressed bytes' digest and size as the upload. Once anything has been
   * sent, a failure closes the session.
   */
  async start(snapshot: SessionSnapshot, sent: Uint8Array): Promise<void> {
    const wall = () => this.#wallNow().toISOString();
    this.#journal.append({ kind: "session", wall: wall(), sessionId: this.#sessionId, baseImage: this.#options.baseImage, snapshotSha256: snapshot.sha256, workspace: this.#workspace });
    if (this.#deadline - this.#now() < this.#limits.minWriteMs) throw new ExecRefusedError("There wasn't time left in this run to send the workspace, so nothing was sent.");
    const api = this.#client(this.#work.signal);
    const sentSha256 = sha256(sent);
    this.#journal.append({ kind: "upload", wall: wall(), sha256: sentSha256, bytes: sent.byteLength });
    let uploaded: { uuid: string; sha256: string | null };
    try {
      uploaded = await api.upload(sent, { until: this.#deadline });
    } catch (error) {
      if (error instanceof SandboxNotSentError) throw new ExecRefusedError(error.reason === "cancelled" ? "This run was cancelled before anything was sent to the sandbox." : "There wasn't time left in this run to send the workspace, so nothing was sent.");
      throw await this.#failOpen(`Sending the workspace failed (${error instanceof Error ? error.message : String(error)}), and the service may have stored it anyway.`);
    }
    this.#journal.append({ kind: "uploaded", wall: wall(), uuid: uploaded.uuid });
    if (uploaded.sha256 !== null && uploaded.sha256 !== sentSha256) throw await this.#failOpen("The sandbox stored different bytes from the ones Nivra sent, so the session was stopped.");
    const step: StepSpec = {
      label: "prepare",
      command: "/bin/sh",
      args: ["-c", PREPARE_SCRIPT, "nivra-prepare", this.#workspace, ARCHIVE, this.#options.applets ?? "/bin/busybox", LISTING],
      image: this.#options.baseImage,
      disposable: false,
      timeoutSeconds: this.#limits.prepareTimeoutSeconds,
      files: { [ARCHIVE]: { uuid: uploaded.uuid } },
      maxOutputBytes: 4_096,
    };
    let ran: Ran;
    try {
      ran = await this.#runStep(step, this.#work.signal);
    } catch (error) {
      const why = error instanceof NotStarted ? "the run was cancelled before it began." : error instanceof Error ? error.message : String(error);
      throw await this.#failOpen(`Preparing the workspace in the sandbox failed: ${why}`);
    }
    const { outcome } = ran;
    const image = this.#keep(ran, true, "prepare");
    const printed = /^digest ([0-9a-f]{64})$/m.exec(outcome.stdout)?.[1] ?? null;
    if (outcome.verdict !== "passed" || !image) throw await this.#failOpen(`Preparing the workspace in the sandbox didn't finish (${outcome.verdict}${image ? "" : ", and it kept no image"}), so the session was stopped.`);
    if (printed !== snapshot.listingDigest) throw await this.#failOpen("The sandbox's copy of the workspace doesn't match the snapshot (its listing differs), so the session was stopped.");
    this.#image = image;
  }

  /** Closes the session after a failed start, on the spec's closing signal and budget, and gives the error that carries its report. */
  async #failOpen(message: string): Promise<SessionOpenError> {
    return new SessionOpenError(message, await this.close(this.#openClosing));
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    let refusal: string | null;
    try {
      refusal = this.#refusal(request);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    if (refusal) return Promise.reject(new ExecRefusedError(refusal));
    const signal = request.signal ? AbortSignal.any([this.#work.signal, request.signal]) : this.#work.signal;
    if (signal.aborted) return Promise.resolve(notStarted());
    this.#busy = true;
    const run = this.#exec(request, signal).finally(() => (this.#busy = false));
    this.#active = run.catch(() => undefined);
    return run;
  }

  /** Why a command won't be sent, before anything is: in words a person can act on; null when it can go. */
  #refusal(request: ExecRequest): string | null {
    const [program] = request.argv;
    if (this.#closing) return "This session is closed.";
    if (this.#state.kind === "stale") return `The sandbox didn't keep the result of an earlier command (${this.#state.why}), so nothing more runs in this session: it would run on an older copy of the workspace. Start again from the commit.`;
    if (this.#state.kind === "lost") return `The sandbox no longer has this workspace's saved state (${this.#state.why}), so nothing more can run in this session. Start again from the commit.`;
    if (this.#state.kind === "unsettled") return `An earlier command in this session wasn't settled (${this.#state.why}), so nothing more runs here until the session is closed.`;
    if (this.#busy) return "One command at a time: another is still running in this session.";
    if (this.#operations >= this.#limits.maxOperations) return `This session has started ${this.#operations} operations, the most one session may, so ${program} wasn't run.`;
    if (!guestPath(program)) return `Give the program's full path on the sandbox's machine (for example /bin/sh); "${program}" wasn't run.`;
    if (request.argv.some((arg) => arg.includes("\0"))) return `An argument to ${program} holds a NUL character, so it wasn't run.`;
    if (!insideWorkspace(this.#workspace, request.cwd)) return `The command's folder, ${request.cwd}, is outside the session's workspace (${this.#workspace}), so it wasn't run.`;
    for (const [name, value] of Object.entries(request.env ?? {})) {
      if (name === CORRELATION) return `${CORRELATION} is Nivra's own variable, so a command can't set it; ${program} wasn't run.`;
      if (!ENV_NAME.test(name) || value.includes("\0")) return `The command's environment has a variable Nivra won't pass (${ENV_NAME.test(name) ? name : "a name that isn't one"}), so it wasn't run.`;
    }
    const carried = [...request.argv, ...Object.entries(request.env ?? {}).flat()];
    if (carried.some((text) => text.includes(this.#credentials.key) || text.includes(this.#credentials.project))) return CARRIES_CREDENTIAL;
    if (request.stdin !== undefined || request.output === "bytes") return `The sandbox can't give a command input, or keep its output as bytes, so ${program} wasn't run.`;
    if (!(request.timeoutMs > 0) || request.timeoutMs > this.#limits.maxTimeoutSeconds * 1000) return `A command may run for at most ${this.#limits.maxTimeoutSeconds} s here, and ${program} asked for ${Math.ceil(request.timeoutMs / 1000)} s, so it wasn't run.`;
    if (Math.ceil(request.timeoutMs / 1000) * 1000 + this.#limits.observeMarginMs + this.#limits.minWriteMs > this.#deadline - this.#now()) return `There isn't enough time left in this run to give ${program} its ${Math.ceil(request.timeoutMs / 1000)} s, so it wasn't run.`;
    return null;
  }

  async #exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
    const [command, ...args] = request.argv;
    const persist = request.persist !== false;
    const label = request.label ?? "command";
    const step: StepSpec = {
      label,
      command,
      args,
      image: this.#image,
      disposable: !persist,
      timeoutSeconds: Math.ceil(request.timeoutMs / 1000),
      env: { ...request.env },
      cwd: request.cwd,
      maxOutputBytes: Math.min(request.maxOutputBytes, this.#limits.maxOutputBytes),
    };
    let ran: Ran;
    try {
      ran = await this.#runStep(step, signal, request.onStart, request.onRunning);
    } catch (error) {
      if (error instanceof NotStarted) return notStarted();
      throw error;
    }
    const { outcome } = ran;
    const image = this.#keep(ran, persist, label);
    if (persist && !image) {
      const why = outcome.verdict === "timed-out" ? "it timed out" : outcome.verdict === "signalled" ? "a signal ended it" : outcome.verdict === "cancelled" ? "it was cancelled" : outcome.status !== "SUCCESS" ? `its operation ended ${outcome.status}` : "its answer named no image the sandbox kept";
      this.#state = { kind: "stale", why: `${label}: ${why}` };
    }
    if (image) this.#image = image;
    // The caller's own callback failed: its error is given back now that the command has settled.
    if (ran.callbackError !== null) throw ran.callbackError;
    if (outcome.verdict === "operation-failed") throw new SandboxOperationError(`The sandbox couldn't run ${command}: its operation failed, so nothing is known about what the command did.`);
    if (outcome.verdict === "unknown") throw new SandboxOperationError(`${command} ended, but the sandbox didn't say how (status ${outcome.status}), so its outcome is unknown.`);
    const stdout = capText(outcome.stdout, request.maxOutputBytes);
    const stderr = capText(outcome.stderr, request.maxOutputBytes);
    return {
      exitCode: outcome.exitCode,
      signal: signalName(outcome.signal),
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutExact: outcome.stdoutExact,
      truncated: outcome.stdoutTruncated || outcome.stderrTruncated || stdout.truncated || stderr.truncated,
      timedOut: outcome.timedOut,
      cancelled: outcome.verdict === "cancelled",
      durationMs: Math.round(ran.durationMs),
      persisted: image !== null,
    };
  }

  /**
   * Records a step, and gives the image to continue from: only when the step was persisted and ended on its own, with
   * SUCCESS and an image Nivra can use. Every image an operation reports is journaled where its end was seen; the one
   * adopted is journaled again here, as the session's state.
   */
  #keep(ran: Ran, persist: boolean, label: string): string | null {
    const { outcome } = ran;
    const endedOnItsOwn = outcome.status === "SUCCESS" && !outcome.timedOut && signalName(outcome.signal) === null && outcome.verdict !== "unknown";
    const image = persist && endedOnItsOwn && outcome.resultImage !== null && IMAGE_ID.test(outcome.resultImage) ? outcome.resultImage : null;
    if (image !== null) this.#journal.append({ kind: "image", wall: this.#wallNow().toISOString(), operationId: ran.operationId, image, adopted: true });
    this.#steps.push({ label, operationId: ran.operationId, status: outcome.status, verdict: outcome.verdict, durationMs: Math.round(ran.durationMs), persisted: image !== null, usage: usageOf(outcome) });
    return image;
  }

  /**
   * One step as one operation: journaled and sent, its lost answer looked for, then observed to its end. An abort
   * stops the operation on a client of its own, within the stop budget (or closing's), so the cancel isn't cut off with
   * the work. What can't be settled leaves the session unsettled, and is never sent again.
   */
  async #runStep(step: StepSpec, signal: AbortSignal, onStart?: ExecRequest["onStart"], onRunning?: ExecRequest["onRunning"]): Promise<Ran> {
    const sandbox = this.#sandbox(this.#client(signal), () => this.#deadline, signal);
    const started = this.#now();
    let submitted: { operationId: string } | { uncertain: string };
    try {
      submitted = await sandbox.submit(step);
    } catch (error) {
      throw this.#spawnFailure(step, error);
    }
    this.#operations++;
    let operationId: string;
    if ("uncertain" in submitted) {
      const found = await sandbox.reconcile(submitted.uncertain).catch((error: unknown) => ({ unknown: error instanceof Error ? error.message : String(error) }));
      if (!("operationId" in found)) {
        this.#state = { kind: "unsettled", why: `it isn't known whether ${step.label} started` };
        throw new ExecUncertainError(`It isn't known whether ${step.command} started (${found.unknown}). Nivra won't send it again; closing the session looks for it once more and stops it.`);
      }
      operationId = found.operationId;
    } else {
      operationId = submitted.operationId;
    }
    // A callback that throws is the caller's own error: the command runs on, is followed to its end, and the error is
    // given back once the session's state is settled.
    let callbackError: unknown = null;
    try {
      onStart?.({ pid: null });
    } catch (error) {
      callbackError = error ?? new Error("onStart failed");
    }
    // The first read that finds it executing: the command is running.
    let running = false;
    const onStatus = (status: string) => {
      if (running || status !== "EXECUTING") return;
      running = true;
      try {
        onRunning?.();
      } catch (error) {
        callbackError ??= error ?? new Error("onRunning failed");
      }
    };
    try {
      return { operationId, outcome: await sandbox.observe(operationId, step.timeoutSeconds, onStatus), durationMs: this.#now() - started, callbackError };
    } catch (error) {
      if (signal.aborted) return { ...(await this.#stopped(operationId, step, started)), callbackError };
      this.#state = { kind: "unsettled", why: `${step.label} wasn't seen to end` };
      throw new ExecUncertainError(`${step.command} wasn't seen to end before the run's time ran out (${error instanceof Error ? error.message : String(error)}). Closing the session stops it.`);
    }
  }

  /**
   * Stops an operation whose work was cancelled, on a client of its own. It keeps to the stop budget and, once closing
   * has begun, to closing's deadline: each request and wait reads it afresh, and closing cuts off the one under way when
   * its time runs out or its signal aborts, however the stop began.
   */
  async #stopped(operationId: string, step: StepSpec, started: number): Promise<Omit<Ran, "callbackError">> {
    const stopUntil = this.#now() + this.#limits.minWriteMs + this.#limits.requestTimeoutMs + this.#limits.cancelWaitMs;
    const cap = () => Math.min(stopUntil, this.#closeBounds?.deadline ?? Number.POSITIVE_INFINITY);
    const stop = this.#sandbox(this.#client(this.#cleanup.signal), cap, this.#cleanup.signal);
    const outcome = await stop.cancel(operationId).catch(() => null);
    if (!outcome) {
      this.#state = { kind: "unsettled", why: `${step.label} wasn't seen to stop` };
      // Once closing has cut the stop off, by its time or its signal, it sends nothing more: recovery looks again.
      const next = this.#cleanup.signal.aborted ? "it stays journaled, and the next recovery pass looks for it again" : "closing the session tries again";
      throw new ExecUncertainError(`Nivra asked the sandbox to stop ${step.command}, but it wasn't seen to stop; ${next}.`);
    }
    return { operationId, outcome, durationMs: this.#now() - started };
  }

  /** What a spawn that wasn't made, or whose making isn't known, means for the session. */
  #spawnFailure(step: StepSpec, error: unknown): Error {
    // Made, journaled, and never followed: an answer after the deadline or the cancellation, whatever the signal says.
    if (error instanceof SandboxLateSpawnError) {
      this.#operations++;
      this.#state = { kind: "unsettled", why: `${step.label}'s answer came after the deadline or the cancellation` };
      return new ExecUncertainError(`${step.command} was started, but its answer came only after the run's deadline or its cancellation, so Nivra didn't follow it; closing the session stops it.`);
    }
    if (error instanceof SandboxCancelledError || (error instanceof SandboxNotSentError && error.reason === "cancelled")) return new NotStarted();
    if (error instanceof SandboxNotSentError) return new ExecRefusedError(`There isn't enough time left in this run to start ${step.command}, so it wasn't sent.`);
    if (error instanceof SandboxHttpError) {
      if ((error.status === 404 || error.status === 410) && step.image !== this.#options.baseImage) {
        this.#state = { kind: "lost", why: `its image answered HTTP ${error.status}` };
        return new ExecRefusedError(`The sandbox no longer has this workspace's saved state (HTTP ${error.status}), so ${step.command} wasn't run and nothing more can run in this session. Start again from the commit.`);
      }
      if (error.status === 401 || error.status === 403) return new ExecRefusedError(`Nebius turned the key down (HTTP ${error.status}), so ${step.command} wasn't started. Check the key and the project id, then try again.`);
      if (error.status === 429) return new ExecRefusedError(`Nebius is limiting requests (HTTP 429), so ${step.command} wasn't started. Wait a minute, then try again.`);
      return new ExecRefusedError(`Nebius refused to start ${step.command} (HTTP ${error.status}).`);
    }
    if (error instanceof SandboxRefusal && /^The time for this work ran out/.test(error.message)) return new ExecRefusedError(`There isn't enough time left in this run to start ${step.command}, so it wasn't sent.`);
    // Every other refusal comes before the intent is written (one at a time, a damaged journal): nothing was sent.
    if (error instanceof SandboxRefusal) return new ExecRefusedError(`${step.command} wasn't sent: ${error.message}`);
    // Anything else may have come after the intent was written, so the spawn may have reached the service.
    this.#state = { kind: "unsettled", why: `starting ${step.label} failed` };
    return new ExecUncertainError(`Starting ${step.command} failed (${error instanceof Error ? error.message : String(error)}); it may have reached the sandbox, so it won't be sent again. Closing the session looks for it.`);
  }

  async download(path: string, maxBytes: number, options: { timeoutMs?: number } = {}): Promise<{ bytes: Uint8Array; sha256: string }> {
    if (this.#closing) throw new ExecRefusedError("This session is closed.");
    // A stale session's image is older than what its last command was meant to leave: reading it would mislead.
    if (this.#state.kind !== "open") throw new ExecRefusedError(`Nothing can be read from this session now (${this.#state.why}).`);
    if (!guestPath(path)) throw new ExecRefusedError(`Give the file's full path on the sandbox's machine; "${path}" isn't one.`);
    if (!(maxBytes > 0) || maxBytes > this.#limits.maxDownloadBytes) throw new ExecRefusedError(`A download may be at most ${this.#limits.maxDownloadBytes} bytes.`);
    if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) throw new ExecRefusedError("A download needs some time to run.");
    // Its own deadline, within the session's: the earlier of the two.
    const until = options.timeoutMs === undefined ? this.#deadline : Math.min(this.#deadline, this.#now() + options.timeoutMs);
    const sandbox = this.#sandbox(this.#client(this.#work.signal), () => until, this.#work.signal);
    try {
      return await sandbox.download(this.#image, path, maxBytes, null);
    } catch (error) {
      if (error instanceof SandboxHttpError && error.status === 404) throw new ExecRefusedError(`There's no file at ${path} in the sandbox.`);
      if (error instanceof SandboxTooLargeError) throw new ExecRefusedError(`${path} is longer than the ${maxBytes} bytes asked for, so it wasn't read.`);
      if (error instanceof SandboxDeadlineError && options.timeoutMs !== undefined && !this.#work.signal.aborted) throw new ExecRefusedError(`${path} wasn't read back within its ${Math.round(options.timeoutMs / 1000)} s.`);
      throw error;
    }
  }

  steps(): readonly SessionStep[] {
    return [...this.#steps];
  }

  close(options: { signal?: AbortSignal; budgetMs?: number } = {}): Promise<CloseReport> {
    this.#closing ??= this.#close(options).catch((error: unknown) => this.#report([`Closing the session failed (${error instanceof Error ? error.message : String(error)}); what it started may still be running.`]));
    return this.#closing;
  }

  async #close(options: { signal?: AbortSignal; budgetMs?: number }): Promise<CloseReport> {
    const budgetMs = options.budgetMs ?? this.#limits.cleanupBudgetMs;
    const deadline = this.#now() + budgetMs;
    this.#closeBounds = { deadline, signal: options.signal ?? null };
    // Closing's signal stops cleanup, and a stop already under way, however that stop began. Its listener goes once
    // closing ends, so a long-lived signal holds nothing of the session.
    const listening = new AbortController();
    if (options.signal?.aborted) this.#cleanup.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", () => this.#cleanup.abort(options.signal?.reason), { once: true, signal: listening.signal });
    // So does closing's deadline. A request a stop sent before closing began was given the time left then, which can be
    // longer than closing has: only this cuts it off at closing's end. Like a request's own timeout, it runs in real
    // time, and it keeps the process alive until then, so closing ends however little else is waiting. What it leaves
    // open stays journaled, for recovery.
    const expiry = budgetMs <= MAX_TIMER_MS ? setTimeout(() => this.#cleanup.abort(new Error("Closing's time ran out.")), Math.max(0, budgetMs)) : null;
    this.#specSignal?.removeEventListener("abort", this.#onSpecAbort);
    let settled: { unresolved: string[] };
    try {
      this.#work.abort(new Error("The session is closing."));
      // The command under way stops within closing's own deadline and signal (see #stopped).
      await this.#active;
      settled = await this.#sandbox(this.#client(this.#cleanup.signal), () => deadline, this.#cleanup.signal).cleanup();
    } finally {
      if (expiry) clearTimeout(expiry);
      listening.abort();
    }
    const report = this.#report(settled.unresolved.map(describeUnresolved));
    // Nothing left open: the journal moves aside, so a scan at the next start reads only what may still need it.
    if (report.unresolved.length === 0) {
      try {
        settleJournal(this.#journalPath);
      } catch {
        // Left where it is, it is scanned again and found settled: nothing is lost.
      }
    }
    return report;
  }

  #report(unresolved: string[]): CloseReport {
    let entries: readonly JournalEntry[] = [];
    try {
      entries = this.#journal.entries;
    } catch (error) {
      unresolved = [...unresolved, error instanceof Error ? error.message : String(error)];
    }
    return { steps: [...this.#steps], ...cancelsIn(entries), unresolved, retained: retainedIn(entries) };
  }
}

const notStarted = (): ExecResult => ({ exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, cancelled: true, durationMs: 0, persisted: false });

/** A journal an earlier engine left with work open, or one that can't be read. */
export interface JournalScan {
  path: string;
  operations: string[];
  uncertain: Array<{ correlation: string; label: string; wall: string }>;
  damaged: string | null;
}

/** The most journals one scan reads; any beyond are counted in `unread`, never passed over in silence. */
const SCAN_LIMIT = 5_000;

/**
 * The journals in `dir` with work open: operations not seen to end, spawns not settled, or a journal that can't be
 * read. Local only, with no network, so an engine can run it at start without waiting on anything. A session that
 * closed with nothing open moved its journal into `settled/`, so the journals here are the few that may need something.
 * Should there be more than one scan reads, `unread` says how many weren't looked at.
 */
export function scanJournals(dir: string): { open: JournalScan[]; unread: number } {
  if (!existsSync(dir)) return { open: [], unread: 0 };
  const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  const open = names.slice(0, SCAN_LIMIT).flatMap((name): JournalScan[] => {
    const path = join(dir, name);
    try {
      const state = new Journal(path).open();
      return state.operations.length || state.uncertain.length ? [{ path, operations: state.operations, uncertain: state.uncertain, damaged: null }] : [];
    } catch (error) {
      return [{ path, operations: [], uncertain: [], damaged: error instanceof Error ? error.message : String(error) }];
    }
  });
  return { open, unread: Math.max(0, names.length - SCAN_LIMIT) };
}

export interface RecoveryResult {
  path: string;
  stopped: string[];
  alreadyEnded: string[];
  unresolved: string[];
}

/**
 * One bounded pass over what `scanJournals` found, on one overall budget: reconcile, cancel only each journal's own
 * operations, search again, and journal what stays open. Nothing is replayed. A journal the pass didn't reach, because
 * it ran out of time or was stopped, stays as it was, for the next pass, and so does one the pass couldn't settle; a
 * failure with one journal never stops the others. A journal left with nothing open moves into `settled/`.
 */
export async function reconcileJournals(
  scans: readonly JournalScan[],
  options: { credentials: NebiusCredentials; budgetMs: number; signal?: AbortSignal; transport?: (credentials: NebiusCredentials) => Transport; limits?: Partial<NebiusLimits>; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; wallNow?: () => Date },
): Promise<RecoveryResult[]> {
  const limits: NebiusLimits = { ...NEBIUS_LIMITS, ...options.limits };
  const now = options.now ?? (() => performance.now());
  const deadline = now() + options.budgetMs;
  const transport = (options.transport ?? ((given) => fetchTransport(given)))(options.credentials);
  const signal = options.signal ?? null;
  const results: RecoveryResult[] = [];
  for (const scan of scans) {
    if (scan.damaged) {
      results.push({ path: scan.path, stopped: [], alreadyEnded: [], unresolved: [scan.damaged] });
      continue;
    }
    if (signal?.aborted || deadline - now() < limits.minWriteMs) {
      results.push({ path: scan.path, stopped: [], alreadyEnded: [], unresolved: [`Not looked at in this pass: it ${signal?.aborted ? "was stopped" : "ran out of time"}. It stays for the next.`] });
      continue;
    }
    try {
      const journal = new Journal(scan.path);
      const api = new SandboxApi(transport, { requestTimeoutMs: limits.requestTimeoutMs, minWriteMs: limits.minWriteMs, readDeadlineMs: limits.searchMs, now, ...(options.sleep ? { sleep: options.sleep } : {}), ...(signal ? { signal } : {}) });
      const sandbox = new Sandbox(api, {
        journal,
        observeMarginMs: limits.observeMarginMs,
        pollMs: limits.pollMs,
        cancelWaitMs: limits.cancelWaitMs,
        search: { sinceMarginMs: 24 * 60 * 60 * 1000, pageSize: 25, maxPages: 10, maxCandidates: 50, withinMs: limits.searchMs },
        now,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.wallNow ? { wallNow: options.wallNow } : {}),
        cap: () => deadline,
        ...(signal ? { signal } : {}),
      });
      const settled = await sandbox.cleanup();
      const result = { path: scan.path, ...cancelsIn(journal.entries), unresolved: settled.unresolved.map(describeUnresolved) };
      if (result.unresolved.length === 0) settleJournal(scan.path);
      results.push(result);
    } catch (error) {
      results.push({ path: scan.path, stopped: [], alreadyEnded: [], unresolved: [`This pass couldn't settle it (${error instanceof Error ? error.message : String(error)}). It stays for the next.`] });
    }
  }
  return results;
}
