/**
 * Execution boundaries (D9, D33). Mastra orchestrates; a backend only runs commands, inside whatever boundary it really
 * enforces, and says so in `capabilities`. A run that needs a boundary a backend cannot give is refused before anything
 * is sent, never run unconfined: coding work asks for `requires.isolatesFilesystem`, which `Local` refuses. `Local` runs
 * on the target with no isolation; Nebius Sandboxes runs each command as one operation on a remote machine, from the
 * image the last one left (D28).
 */

export interface ExecutionCapabilities {
  /** Commands can't reach the target's files: they see only the session's workspace (for a remote backend, a copy). */
  isolatesFilesystem: boolean;
  /** What the backend can do about network access: nothing, all-or-nothing, or per-destination rules. */
  networkPolicy: "none" | "onOff" | "allowList";
  /** Credentials reach endpoints without the command seeing them. */
  injectsCredentials: boolean;
  /**
   * Files written by one command are there for the next. On a backend that keeps state in images, that holds for a
   * command that was persisted and ended on its own; `ExecResult.persisted` says whether it did.
   */
  persistsBetweenExecs: boolean;
}

export type NetworkRequirement = "open" | "deny" | "allowList";

/** The files a workspace that runs elsewhere starts with: one tar archive (built in B2), and what it must give. */
export interface SessionSnapshot {
  archive: Uint8Array;
  /** The archive's own sha256, checked against what the provider stored. */
  sha256: string;
  /** The digest of the canonical listing of what the archive gives once extracted, checked inside the boundary. */
  listingDigest: string;
}

export interface SessionSpec {
  /** The folder commands run in, in the target's own path form; for a remote backend, the folder on its machine. */
  workspace: string;
  network?: NetworkRequirement;
  /** What the session must enforce: refused before anything is sent when the backend can't (D9). */
  requires?: { isolatesFilesystem?: true };
  /** For a backend that runs elsewhere: the files the workspace starts with. A backend on the target refuses it. */
  snapshot?: SessionSnapshot;
  /** The session's whole time, from `open`, on the monotonic clock: no request, wait or command outlives it. */
  budgetMs?: number;
  /** Stops the session's work, the command under way included, with its reason. It never stops cleanup. */
  signal?: AbortSignal;
  /** How a session that fails once something was sent cleans up after itself, as `close` takes them: an engine shutting down stops it. */
  closing?: { signal?: AbortSignal; budgetMs?: number };
}

export interface ExecRequest {
  /** The program and its arguments. Never run through a shell. */
  argv: readonly [string, ...string[]];
  cwd: string;
  /** Added to the session's base environment (on the target, see `childEnv`); a remote backend passes only these. */
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Per stream; output beyond it is dropped and `truncated` is set. */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Told once the process exists, with its id (null when the backend has none to give). */
  onStart?: (info: { pid: number | null }) => void;
  /**
   * Told once, when the command is first known to be running: its process started here, or the sandbox reported it
   * executing. A command that ended before any read saw it running isn't reported.
   */
  onRunning?: () => void;
  /** False: the command's changes are thrown away afterwards (true unless given). A backend that can't refuses it. */
  persist?: boolean;
  /** The engine's name for the step, kept in the session's record; never model text. */
  label?: string;
  /** Bytes for the command's standard input, closed after them. A backend that can't give input refuses it. */
  stdin?: Uint8Array;
  /** `bytes`: standard output is kept as bytes too, in `stdoutBytes`, for output that isn't text. */
  output?: "text" | "bytes";
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Whether the command's changes are there for the next command. */
  persisted: boolean;
  /** Standard output as bytes, when asked for with `output: "bytes"`. */
  stdoutBytes?: Uint8Array;
  /**
   * False when the backend can't say standard output is exactly what was printed: none was reported, or it wasn't
   * text that reads back exactly. Left out by a backend that always can.
   */
  stdoutExact?: boolean;
}

/**
 * One step as a session recorded it, for the engine's own report, never for a model: provider ids are allowed here,
 * and only here. Usage is kept as the provider reported it, raw, null when it reported none, never turned into money.
 */
export interface SessionStep {
  label: string;
  operationId: string | null;
  status: string;
  verdict: "passed" | "command-failed" | "timed-out" | "signalled" | "operation-failed" | "cancelled" | "unknown";
  durationMs: number | null;
  persisted: boolean;
  usage: unknown;
}

/** What closing a session settled, and what it couldn't, in words a person can check. */
export interface CloseReport {
  steps: readonly SessionStep[];
  /** Remote work seen to stop: CANCELLED after a cancel the provider accepted. */
  stopped: readonly string[];
  /** Remote work that had already ended when it was asked to stop. */
  alreadyEnded: readonly string[];
  /** What couldn't be settled, each with why: never claimed stopped. */
  unresolved: readonly string[];
  /** What the provider keeps, and on what terms; null when nothing left the target. */
  retained: { uploads: number; images: number; operations: number; note: string } | null;
}

export interface ExecutionSession {
  /** Engine-admitted extra operations; never extends the session deadline or resets usage. */
  addOperationCapacity?(operations: number): void;
  readonly capabilities: ExecutionCapabilities;
  /**
   * The folder names this session's listings leave out at any depth (NIV-55): a prepared environment's dependency
   * folders, such as node_modules. Collect leaves out the same, so it finds what the prepare step listed. Unset: none.
   */
  readonly leftOut?: readonly string[];
  exec(request: ExecRequest): Promise<ExecResult>;
  /**
   * A file from the workspace's machine as it now stands, refused past `maxBytes`, with its sha256. `timeoutMs` is its
   * own deadline, within the session's: a read that doesn't finish by then is refused, so a slow one can't use up the
   * time kept for what comes after it.
   */
  download?(path: string, maxBytes: number, options?: { timeoutMs?: number }): Promise<{ bytes: Uint8Array; sha256: string }>;
  /** The steps recorded so far, as `close` will report them: for a report made before the session closes. */
  steps?(): readonly SessionStep[];
  /**
   * Stops anything still running and releases the session, within one budget (its own, or the one given), which
   * includes waiting for the command under way to stop. A second call gives the first one's report. It never rejects:
   * what it couldn't settle is in the report.
   */
  close(options?: { signal?: AbortSignal; budgetMs?: number }): Promise<CloseReport>;
}

export interface ExecutionBackend {
  readonly id: "local" | "nebius-sandbox" | "openshell";
  /** What the person sees, e.g. "No isolation". */
  readonly label: string;
  readonly capabilities: ExecutionCapabilities;
  open(spec: SessionSpec): Promise<ExecutionSession>;
}

/** The command was not started, and why, in words a person can act on. */
export class ExecRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecRefusedError";
  }
}

/** The boundary a run needs is not available here. Nothing ran (D9: no silent fallback). */
export class BoundaryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryUnavailableError";
  }
}

/**
 * It isn't known whether the command started, or whether it stopped: its request may have reached the provider. It is
 * never sent again, and nothing more runs in the session; closing it settles what it can and reports the rest.
 */
export class ExecUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecUncertainError";
  }
}

/** The session couldn't be opened after remote work had begun. Its cleanup has run, and `report` says what it settled. */
export class SessionOpenError extends Error {
  readonly report: CloseReport;
  constructor(message: string, report: CloseReport) {
    super(message);
    this.name = "SessionOpenError";
    this.report = report;
  }
}

/** A report with nothing in it, for a session that never left the target. */
export const EMPTY_CLOSE_REPORT: CloseReport = Object.freeze({ steps: [], stopped: [], alreadyEnded: [], unresolved: [], retained: null });

/** Refuses a session whose network requirement the backend cannot enforce. */
export function checkNetwork(backend: Pick<ExecutionBackend, "label" | "capabilities">, network: NetworkRequirement): void {
  const policy = backend.capabilities.networkPolicy;
  const enough = network === "open" || (network === "deny" && policy !== "none") || (network === "allowList" && policy === "allowList");
  if (!enough) {
    throw new BoundaryUnavailableError(
      `"${backend.label}" can't ${network === "deny" ? "block" : "restrict"} network access, so this run was not started. Choose a sandbox that enforces it, or allow the network for this run.`,
    );
  }
}

/** Refuses a session that needs a boundary the backend doesn't claim, before anything is sent (D9: no fallback). */
export function checkRequirements(backend: Pick<ExecutionBackend, "label" | "capabilities">, spec: Pick<SessionSpec, "network" | "requires">): void {
  checkNetwork(backend, spec.network ?? "open");
  if (spec.requires?.isolatesFilesystem && !backend.capabilities.isolatesFilesystem) {
    throw new BoundaryUnavailableError(`"${backend.label}" can't keep commands away from this computer's files, so this run was not started. Choose a sandbox that isolates them.`);
  }
}
