import { spawn, type ChildProcess } from "node:child_process";
import { checkRequirements, EMPTY_CLOSE_REPORT, ExecRefusedError, type CloseReport, type ExecRequest, type ExecResult, type ExecutionBackend, type ExecutionCapabilities, type ExecutionSession } from "./backend.ts";
import { childEnv, insideWsl } from "./child-env.ts";
import { killTree } from "./kill.ts";

/** Runs commands directly on the target, with the engine's own permissions. It enforces nothing and says so (D9). */
export const LOCAL_CAPABILITIES: ExecutionCapabilities = Object.freeze({
  isolatesFilesystem: false,
  networkPolicy: "none",
  injectsCredentials: false,
  persistsBetweenExecs: true,
});

export interface LocalBackendOptions {
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** How long a stopped command gets between SIGTERM and SIGKILL (POSIX). */
  graceMs?: number;
  /** The monotonic clock a session's budget is measured on; tests replace it. */
  now?: () => number;
}

export function createLocalBackend(options: LocalBackendOptions = {}): ExecutionBackend {
  const backend: ExecutionBackend = {
    id: "local",
    label: "No isolation",
    capabilities: LOCAL_CAPABILITIES,
    open: async (spec) => {
      checkRequirements(backend, spec);
      if (spec.snapshot) throw new ExecRefusedError(`"No isolation" runs commands in a folder on this computer, so it can't take a snapshot to run elsewhere. Choose a sandbox for this run.`);
      const now = options.now ?? (() => performance.now());
      return new LocalSession(options, { deadline: spec.budgetMs === undefined ? Number.POSITIVE_INFINITY : now() + spec.budgetMs, now, signal: spec.signal ?? null });
    },
  };
  return backend;
}

const notStarted = (cancelled: boolean): ExecResult => ({
  exitCode: null,
  signal: null,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
  cancelled,
  durationMs: 0,
  persisted: true,
});

/** Collects one stream's bytes up to a cap, then drops the rest while still draining it. */
class Capped {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.#limit - this.#size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.#chunks.push(kept);
    this.#size += kept.length;
  }

  bytes(): Buffer {
    return Buffer.concat(this.#chunks);
  }

  text(): string {
    return this.bytes().toString("utf8");
  }
}

class LocalSession implements ExecutionSession {
  readonly capabilities = LOCAL_CAPABILITIES;
  readonly #options: LocalBackendOptions;
  readonly #running = new Set<ChildProcess>();
  /**
   * Every process group this session started (POSIX), kept for the session's whole life: a command that started a
   * background child and then exited is no longer running, but its child still sits in the command's group, and
   * closing the session must stop it too.
   */
  readonly #groups = new Set<number>();
  /** The session's own bounds: when its budget ends, and the signal that stops its work. */
  readonly #bounds: { deadline: number; now: () => number; signal: AbortSignal | null };
  #closing: Promise<CloseReport> | null = null;

  constructor(options: LocalBackendOptions, bounds: { deadline: number; now: () => number; signal: AbortSignal | null }) {
    this.#options = options;
    this.#bounds = bounds;
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    if (this.#closing) return Promise.reject(new ExecRefusedError("This session is closed."));
    const platform = this.#options.platform ?? process.platform;
    const [program, ...args] = request.argv;
    if (platform === "win32" && /\.(cmd|bat)$/i.test(program)) {
      return Promise.reject(new ExecRefusedError(`${program} is a batch file. Nivra starts programs without a shell, so it can't run it on this target.`));
    }
    if (request.persist === false) return Promise.reject(new ExecRefusedError(`"No isolation" runs commands in the folder itself, so it can't throw a command's changes away. ${program} wasn't run.`));
    if (request.timeoutMs > this.#bounds.deadline - this.#bounds.now()) return Promise.reject(new ExecRefusedError(`There isn't enough time left in this run to give ${program} its ${Math.ceil(request.timeoutMs / 1000)} s, so it wasn't run.`));
    const signal = request.signal && this.#bounds.signal ? AbortSignal.any([request.signal, this.#bounds.signal]) : (request.signal ?? this.#bounds.signal ?? undefined);
    if (signal?.aborted) return Promise.resolve(notStarted(true));

    const env = childEnv(this.#options.baseEnv ?? process.env, request.env ?? {}, { platform, stripWindowsPaths: platform === "linux" && insideWsl() });
    const started = performance.now();
    return new Promise<ExecResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(program, args, {
          cwd: request.cwd,
          env,
          stdio: [request.stdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
          // POSIX: its own process group, so the whole tree can be stopped. Windows: inside libuv's job object (D4).
          detached: platform !== "win32",
          shell: false,
        });
      } catch (error) {
        reject(new ExecRefusedError(`Could not start ${program}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.#running.add(child);
      if (platform !== "win32" && child.pid !== undefined) this.#groups.add(child.pid);
      const stdout = new Capped(request.maxOutputBytes);
      const stderr = new Capped(request.maxOutputBytes);
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let exitFallback: ReturnType<typeof setTimeout> | undefined;

      const stop = () => void killTree(child, { platform, ...(this.#options.graceMs === undefined ? {} : { graceMs: this.#options.graceMs }) });
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        stop();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (outcome: { result: ExecResult } | { error: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(exitFallback);
        signal?.removeEventListener("abort", onAbort);
        this.#running.delete(child);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.result);
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      // A command that stops reading early closes its end; that is the command's business, not a failure here.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(request.stdin);
      child.once("spawn", () => {
        request.onStart?.({ pid: child.pid ?? null });
        request.onRunning?.();
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        // Only a process that never started reports here (ENOENT, EACCES): nothing ran.
        if (child.pid === undefined) finish({ error: new ExecRefusedError(`Could not start ${program} (${error.code ?? error.message}).`) });
      });
      const result = (code: number | null, signal: NodeJS.Signals | null): ExecResult => ({
        exitCode: code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        cancelled,
        durationMs: Math.round(performance.now() - started),
        persisted: true,
        ...(request.output === "bytes" ? { stdoutBytes: new Uint8Array(stdout.bytes()) } : {}),
      });
      child.once("close", (code, signal) => finish({ result: result(code, signal) }));
      // A descendant holding the pipes open must not keep the result waiting after the process itself has gone.
      child.once("exit", (code, signal) => {
        exitFallback = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ result: result(code, signal) });
        }, 2_000);
      });
    });
  }

  /**
   * Stops everything the session started. On POSIX every process group it created is signalled, including groups whose
   * leader already exited (SIGTERM, then SIGKILL after the grace period). On Windows a finished command's background
   * descendants cannot be found from its process id once it has exited; they sit in libuv's kill-on-close job object
   * and die with the engine (D4). That is why general coding commands do not run unconfined on native Windows (D15).
   * Nothing left the target, so the report is empty. A second call gives the first one's. A budget shortens the grace
   * before SIGKILL to fit it, and an aborted signal leaves none.
   */
  close(options: { signal?: AbortSignal; budgetMs?: number } = {}): Promise<CloseReport> {
    const grace = options.signal?.aborted ? 0 : Math.min(this.#options.graceMs ?? 2_000, (options.budgetMs ?? Number.POSITIVE_INFINITY) / 2);
    this.#closing ??= this.#stopAll(grace).then(
      () => EMPTY_CLOSE_REPORT,
      () => EMPTY_CLOSE_REPORT,
    );
    return this.#closing;
  }

  async #stopAll(graceMs: number): Promise<void> {
    const platform = this.#options.platform ?? process.platform;
    await Promise.all([...this.#running].map((child) => killTree(child, { platform, graceMs })));
    if (platform === "win32") return;
    const signal = (signalName: NodeJS.Signals) =>
      [...this.#groups].filter((group) => {
        try {
          process.kill(-group, signalName);
          return true;
        } catch {
          return false; // ESRCH: nothing left in that group
        }
      });
    const remaining = signal("SIGTERM");
    if (remaining.length > 0) {
      if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
      signal("SIGKILL");
    }
    this.#groups.clear();
  }
}
