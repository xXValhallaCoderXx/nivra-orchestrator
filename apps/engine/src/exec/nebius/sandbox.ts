import { ENVIRONMENT_FILTER } from "@nivra/domain";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
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

  /**
   * Written and flushed before anything is sent, so a crash right after the request can't lose its record. A last line
   * that an earlier crash cut short is cut off first, so the new entry starts a line of its own instead of turning the
   * torn one into damage.
   */
  append(entry: JournalEntry): void {
    if (!this.#path) {
      this.#memory.push(entry);
      return;
    }
    const fd = openSync(this.#path, "a+", 0o600);
    try {
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) ftruncateSync(fd, readFileSync(this.#path).lastIndexOf(0x0a) + 1);
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
          // Nivra's own words, with no path: a refusal can reach a run's report, its events and the model (D29).
          throw new SandboxRefusal(`A session's journal is damaged at line ${index + 1}, so what it records can't be trusted. Check the operations it names before starting more.`);
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

/** Something Nivra won't send, said in its own words. Thrown before anything is sent. */
export class SandboxRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRefusal";
  }
}

/**
 * The service created the operation, but its answer came after the deadline or once the work was cancelled. It is
 * journaled, so cleanup stops it, and it is never followed.
 */
export class SandboxLateSpawnError extends Error {
  readonly operationId: string;
  constructor(label: string, operationId: string) {
    super(`The ${label} operation was answered only after its deadline, or once the work was cancelled, so it isn't used; cleanup stops it.`);
    this.name = "SandboxLateSpawnError";
    this.operationId = operationId;
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
  /** Whether standard output was reported, as text that reads back exactly: a missing stream reads as "" otherwise. */
  stdoutExact: boolean;
  stderr: string;
  stderrTruncated: boolean;
  /** As the service reported it, raw: never converted to money. */
  usage: { durationSeconds: number | null; consumedCpu: unknown; consumedMemory: unknown; imageSize: number | null; resources: unknown };
  verdict: "passed" | "command-failed" | "timed-out" | "signalled" | "operation-failed" | "cancelled" | "unknown";
}

const text = (stream: { value?: string | undefined; encoding?: string | undefined } | null | undefined): string =>
  !stream?.value ? "" : stream.encoding === "base64" ? Buffer.from(stream.value, "base64").toString("utf8") : stream.value;

/** Whether a stream was reported at all, and as text that decodes exactly: base64 that isn't UTF-8 doesn't. */
function exact(stream: { value?: string | undefined; encoding?: string | undefined } | null | undefined): boolean {
  if (stream === null || stream === undefined) return false;
  if (stream.encoding !== "base64") return true;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(stream.value ?? "", "base64"));
    return true;
  } catch {
    return false;
  }
}

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
    stdoutExact: exact(result?.stdout),
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

/** Where an environment's dependencies are installed: the workspace every session uses, so they are found there. */
export const ENV_WORKSPACE = "/workspace";
/** Where the preparation inputs go on the sandbox's machine: outside the workspace. */
const ENV_INPUTS = "/nivra/env-inputs.tar.gz";
/** The path an environment's commands run with: a Node image's own, which isn't applied without a shell. */
export const ENV_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/**
 * What every command in a session from a prepared environment gets beneath its own (D41): the image's path, the home
 * corepack keeps pnpm in, and the switches that keep pnpm and corepack from asking anything. Nothing here is secret.
 */
export const ENV_COMMAND_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: ENV_PATH, HOME: "/root", CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });

/** npm's install flags a recipe may pass (NIV-55): each said exactly, off included. */
const NPM_INSTALL_FLAG = /^--(legacy-peer-deps|install-links|strict-peer-deps|engine-strict|ignore-scripts)(=false)?$|^--install-strategy=(hoisted|nested|shallow|linked)$|^--omit=(dev|optional|peer)$|^--include=(prod|dev|optional|peer)$/;

/**
 * Whether a preparation's install arguments are the only shape Nivra sends, so a preview and its preparation agree on
 * what runs. With no manager, D41's: `--frozen-lockfile`, then each filter as `--filter <filter>`. For a recipe (NIV-55):
 * pnpm's `install --frozen-lockfile` with filters, every filter one `ENVIRONMENT_FILTER` takes; npm's `ci --no-audit
 * --no-fund` with the install flags it may be given, each one exactly.
 */
export function isInstallArgs(args: readonly string[], manager?: "npm" | "pnpm"): boolean {
  if (manager === "npm") return args[0] === "ci" && args[1] === "--no-audit" && args[2] === "--no-fund" && args.slice(3).every((arg) => NPM_INSTALL_FLAG.test(arg));
  const rest = manager === "pnpm" ? (args[0] === "install" ? args.slice(1) : null) : args;
  if (!rest || rest[0] !== "--frozen-lockfile" || (rest.length - 1) % 2 !== 0) return false;
  for (let index = 1; index < rest.length; index += 2) {
    if (rest[index] !== "--filter" || !ENVIRONMENT_FILTER.test(rest[index + 1]!)) return false;
  }
  return true;
}

/**
 * The variables a recipe's preparation may carry, beneath the image's path (NIV-55): the switches that keep corepack and
 * pnpm from asking, downloading or switching versions, and pnpm 10's install options. Nothing that names a registry, a
 * proxy or a credential: an install with networking on reaches only what the lockfile names.
 */
const PREPARATION_ENV = /^(PATH|HOME|CI|COREPACK_ENABLE_DOWNLOAD_PROMPT|COREPACK_ENABLE_STRICT|COREPACK_ENABLE_PROJECT_SPEC|npm_config_update_notifier|npm_config_manage_package_manager_versions|pnpm_config_pm_on_fail|npm_config_node_linker|npm_config_shamefully_hoist|npm_config_auto_install_peers|npm_config_strict_peer_dependencies)$/;
const PREPARATION_VALUE = /^[A-Za-z0-9@._/:,=+-]{0,400}$/;

/**
 * An environment's preparation: a fixed script, given everything as positional arguments, so nothing is interpolated
 * into it. $1 the workspace, $2 the inputs archive, $3 the package manager (npm or pnpm), $4 its exact version ("bundled"
 * for the npm the image has), $5 how pnpm is activated (corepack, npm-global, corepack-else-npm-global, or none), $6
 * npm's own exact version to install first ("none" to keep the image's), then the install's own arguments.
 *
 * It prints how pnpm was activated, the versions and the machine it prepared, for the environment's verified record;
 * then the install. The install's own log goes to a file outside the workspace, and only its end is printed, so the
 * service's output cap can't cut off the line that says whether the install finished. After it, pnpm 10.1 and later is
 * asked which dependency builds it didn't run, between markers: an older pnpm would read the unknown command as the name
 * of a script or a dependency's program and run it, so it isn't asked. A bootstrap that fails says so on a line of its
 * own and exits 70 (npm) or 71 (pnpm), before any version is printed.
 */
export const ENV_PREPARE_SCRIPT = [
  "set -e",
  'ws="$1"; inputs="$2"; manager="$3"; version="$4"; via="$5"; npmpin="$6"; shift 6',
  'mkdir -p "$ws"',
  'tar -x -z -f "$inputs" -C "$ws"',
  'rm -f "$inputs"',
  'cd "$ws"',
  'if [ "$npmpin" != "none" ]; then',
  '  if ! npm install -g "npm@$npmpin" > /nivra/bootstrap.log 2>&1; then tail -c 4000 /nivra/bootstrap.log; echo "bootstrap-failed npm"; exit 70; fi',
  "fi",
  'if [ "$manager" = "pnpm" ]; then',
  '  use="$via"',
  '  if [ "$via" = "corepack-else-npm-global" ]; then if command -v corepack > /dev/null 2>&1; then use=corepack; else use=npm-global; fi; fi',
  '  if [ "$use" = "corepack" ]; then',
  '    if ! { corepack enable pnpm && corepack prepare "pnpm@$version" --activate; } > /nivra/bootstrap.log 2>&1; then tail -c 4000 /nivra/bootstrap.log; echo "bootstrap-failed pnpm"; exit 71; fi',
  "  else",
  '    if ! npm install -g "pnpm@$version" > /nivra/bootstrap.log 2>&1; then tail -c 4000 /nivra/bootstrap.log; echo "bootstrap-failed pnpm"; exit 71; fi',
  "  fi",
  '  echo "via $use"',
  "fi",
  'echo "node $(node --version)"',
  'echo "npm $(npm --version)"',
  'if [ "$manager" = "pnpm" ]; then echo "pnpm $(pnpm --version)"; fi',
  'echo "arch $(uname -m)"',
  'if "$manager" "$@" > /nivra/install.log 2>&1; then tail -c 8000 /nivra/install.log; echo "installed"; else status=$?; tail -c 16000 /nivra/install.log; exit "$status"; fi',
  'major="${version%%.*}"; rest="${version#*.}"; minor="${rest%%.*}"',
  'if [ "$manager" = "pnpm" ] && { [ "$major" -gt 10 ] || { [ "$major" -eq 10 ] && [ "$minor" -ge 1 ]; }; }; then echo "builds-begin"; pnpm ignored-builds 2>&1 | tail -c 4000 || true; echo "builds-end"; fi',
].join("\n");

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

  /**
   * An environment's preparation (NIV-49), the one other operation that runs with networking on, declared beforehand:
   * on the base image the environment pins, with only its preparation inputs (manifests, the lockfile, the workspace
   * file and non-secret install settings, as one archive) and the fixed preparation script, which installs from the
   * frozen lockfile with the pinned package manager. It is kept, so its result image is the environment; the worker's
   * work and every check then run on that image with networking off.
   */
  async prepareEnvironment(
    input: { image: string; inputs: FileRef; timeoutSeconds: number } & (
      | { packageManager: string; installArgs: string[] }
      | { recipe: { manager: "npm" | "pnpm"; version: string; via: string; npmPin: string | null; installArgs: string[]; env: Readonly<Record<string, string>> } }
    ),
  ): Promise<{ operationId: string } | { uncertain: string }> {
    if (!(input.timeoutSeconds > 0 && input.timeoutSeconds <= this.#maxTimeoutSeconds)) throw new SandboxRefusal(`A step's timeout must be between 1 and ${this.#maxTimeoutSeconds} s.`);
    let positional: string[];
    // The image's own environment isn't applied without a shell, so its path is given; nothing here is secret.
    let env: Record<string, string> = { PATH: ENV_PATH, HOME: "/root", CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false" };
    if ("packageManager" in input) {
      // D41's single setup: pnpm at the commit's exact pin, through corepack.
      if (!/^pnpm@\d+\.\d+\.\d+$/.test(input.packageManager)) throw new SandboxRefusal("An environment pins its package manager to an exact pnpm version, such as pnpm@11.5.3.");
      if (!isInstallArgs(input.installArgs)) throw new SandboxRefusal("An environment installs only from its frozen lockfile, with plain arguments.");
      positional = ["pnpm", input.packageManager.slice("pnpm@".length), "corepack", "none", "install", ...input.installArgs];
    } else {
      // A project-driven recipe (NIV-55): its manager, version, activation and install, each in the one shape allowed.
      const recipe = input.recipe;
      if (recipe.manager !== "npm" && recipe.manager !== "pnpm") throw new SandboxRefusal("An environment installs with npm or pnpm.");
      const exact = /^\d+\.\d+\.\d+$/;
      if (recipe.manager === "pnpm" ? !exact.test(recipe.version) : recipe.version !== "bundled" && !exact.test(recipe.version)) throw new SandboxRefusal("An environment pins its package manager to an exact version.");
      if (recipe.manager === "pnpm" ? !["corepack", "npm-global", "corepack-else-npm-global"].includes(recipe.via) : recipe.via !== "none") throw new SandboxRefusal("An environment activates pnpm through corepack or npm, and npm through nothing.");
      if (recipe.npmPin !== null && !exact.test(recipe.npmPin)) throw new SandboxRefusal("An environment installs npm only at an exact version.");
      if (!isInstallArgs(recipe.installArgs, recipe.manager)) throw new SandboxRefusal("An environment installs only from its frozen lockfile, with the install options Nivra knows.");
      for (const [key, value] of Object.entries(recipe.env)) {
        if (!PREPARATION_ENV.test(key) || !PREPARATION_VALUE.test(value)) throw new SandboxRefusal(`An environment's preparation can't be given ${key}: only the switches and install options Nivra knows.`);
      }
      positional = [recipe.manager, recipe.version, recipe.via, recipe.npmPin ?? "none", ...recipe.installArgs];
      env = { ...env, ...recipe.env, PATH: ENV_PATH };
    }
    return this.#spawn("environment preparation", {
      command: "/bin/sh",
      args: ["-c", ENV_PREPARE_SCRIPT, "nivra-env-prepare", ENV_WORKSPACE, ENV_INPUTS, ...positional],
      image: input.image,
      shell: false,
      env,
      disposable: false,
      networking: { enabled: true },
      timeout: input.timeoutSeconds,
      truncate_output_at: MAX_OUTPUT_BYTES,
      files: { [ENV_INPUTS]: input.inputs },
    });
  }

  /**
   * An image imported from a public registry (NIV-49): the service's own operation, journaled as a spawn is, so that
   * cleanup can settle it. It carries no files, no command and no credentials. A lost answer leaves it uncertain, and
   * since an import carries no correlation, a search can't find it: cleanup then says it is unresolved.
   */
  async importImage(input: { registryUrl: string; timeoutSeconds: number }): Promise<{ operationId: string } | { uncertain: string }> {
    if (!/^docker:\/\/[a-z0-9.-]+(\/[a-z0-9._-]+)+:[A-Za-z0-9._-]{1,128}$/.test(input.registryUrl)) throw new SandboxRefusal("An image is imported by its registry address and an exact tag, such as docker://docker.io/library/node:22.23.4-alpine3.24.");
    if (!(input.timeoutSeconds > 0 && input.timeoutSeconds <= 3_600)) throw new SandboxRefusal("An import's timeout must be between 1 and 3,600 s.");
    return this.#journaled("image import", (_correlation, until) => this.#api.importImage(input.registryUrl, input.timeoutSeconds, { until }));
  }

  async #spawn(label: string, body: SpawnBody, options: { discardAnswer?: boolean } = {}): Promise<{ operationId: string } | { uncertain: string }> {
    if (body.networking.enabled && label !== "network control" && label !== "environment preparation") throw new SandboxRefusal("Networking stays off for every operation but the approved network control and an environment's declared preparation.");
    if (typeof body.disposable !== "boolean") throw new SandboxRefusal("Every spawn says whether it is disposable.");
    return this.#journaled(label, (correlation, until) => this.#api.spawn({ ...body, env: { ...body.env, [CORRELATION]: correlation } }, { ...options, until }));
  }

  /**
   * Starts one operation, journaled: refused while another is open, its intent flushed before the request, then its
   * answer, or that the service turned it down, or that it was never sent.
   */
  async #journaled(label: string, send: (correlation: string, until: number) => Promise<SpawnAnswer>): Promise<{ operationId: string } | { uncertain: string }> {
    this.#refuseAfterCap(`the ${label} operation`);
    const open = this.#journal.open();
    if (open.operations.length || open.uncertain.length) throw new SandboxRefusal("One operation at a time: an earlier one hasn't ended, or a spawn whose answer was lost hasn't been settled.");
    const correlation = randomUUID();
    this.#journal.append({ kind: "intent", wall: this.#wallNow().toISOString(), correlation, label });
    let answer: SpawnAnswer;
    try {
      answer = await send(correlation, this.#until(Number.POSITIVE_INFINITY));
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
      if (answer.late) throw new SandboxLateSpawnError(label, answer.id);
      return { operationId: answer.id };
    }
    this.#journal.append({ kind: "uncertain", wall: this.#wallNow().toISOString(), correlation, cause: answer.cause });
    return { uncertain: correlation };
  }

  /**
   * Journals an operation seen to end, and any image it reported, adopted or not: the service keeps it either way, so
   * what is retained can be counted from the journal alone.
   */
  #ended(operationId: string, operation: Operation, status: OperationStatus): Outcome {
    this.#journal.append({ kind: "terminal", wall: this.#wallNow().toISOString(), operationId, status });
    const outcome = classify(operation);
    if (outcome.imageReported !== null) this.#journal.append({ kind: "image", wall: this.#wallNow().toISOString(), operationId, image: outcome.imageReported, adopted: false });
    return outcome;
  }

  /**
   * Polls an operation until it ends, within its own timeout plus the margin, or the cap if that comes first. An
   * operation not seen to end by then is journaled as unresolved, for cleanup to settle.
   */
  /** Follows an operation to its end; `onStatus` is told each status read on the way. */
  async observe(operationId: string, timeoutSeconds: number, onStatus?: (status: OperationStatus) => void): Promise<Outcome> {
    const started = this.#now();
    const end = started + timeoutSeconds * 1000 + this.#observeMarginMs;
    for (let deadline = this.#until(end); this.#now() < deadline; deadline = this.#until(end)) {
      const operation = await this.#readBy(operationId, deadline);
      if (!operation) break;
      const status = readStatus(operation.status);
      if (status !== "UNKNOWN") onStatus?.(status);
      if (status !== "UNKNOWN" && TERMINAL.has(status)) return this.#ended(operationId, operation, status);
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
      if (status !== "UNKNOWN" && TERMINAL.has(status)) return this.#ended(operationId, operation, status);
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
    // An import carries no correlation id (NIV-49), so one whose answer was lost can't be looked for: it stays unknown,
    // and no recovery pass spends its time searching for it.
    if (intent?.kind === "intent" && intent.label === "image import") {
      const reason = "an import carries no correlation id, so it can't be looked for";
      this.#journal.append({ kind: "unresolved", wall: this.#wallNow().toISOString(), correlation, operationId: null, reason });
      return { unknown: reason };
    }
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
