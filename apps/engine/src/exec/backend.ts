/**
 * Execution boundaries (D9). Mastra orchestrates; a backend only runs commands, inside whatever boundary it really
 * enforces, and says so in `capabilities`. A run that needs a boundary a backend cannot give is refused, never run
 * unconfined. `Local` is the only backend in the bootstrap; Nebius Sandboxes and OpenShell add `runMain` and
 * `download` when they arrive.
 */

export interface ExecutionCapabilities {
  /** Commands cannot read or write outside the session's workspace. */
  isolatesFilesystem: boolean;
  /** What the backend can do about network access: nothing, all-or-nothing, or per-destination rules. */
  networkPolicy: "none" | "onOff" | "allowList";
  /** Credentials reach endpoints without the command seeing them. */
  injectsCredentials: boolean;
  /** Files written by one command are there for the next. */
  persistsBetweenExecs: boolean;
}

export type NetworkRequirement = "open" | "deny" | "allowList";

export interface SessionSpec {
  /** The folder commands run in, in the target's own path form. */
  workspace: string;
  network?: NetworkRequirement;
}

export interface ExecRequest {
  /** The program and its arguments. Never run through a shell. */
  argv: readonly [string, ...string[]];
  cwd: string;
  /** Added to the session's base environment (see `childEnv`). */
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Per stream; output beyond it is dropped and `truncated` is set. */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Told once the process exists, with its id (null when the backend has none to give). */
  onStart?: (info: { pid: number | null }) => void;
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
}

export interface ExecutionSession {
  readonly capabilities: ExecutionCapabilities;
  exec(request: ExecRequest): Promise<ExecResult>;
  /** Stops anything still running and releases the session. */
  close(): Promise<void>;
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
