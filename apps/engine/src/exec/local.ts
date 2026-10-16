import { spawn, type ChildProcess } from "node:child_process";
import { checkNetwork, ExecRefusedError, type ExecRequest, type ExecResult, type ExecutionBackend, type ExecutionCapabilities, type ExecutionSession } from "./backend.ts";
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
}

export function createLocalBackend(options: LocalBackendOptions = {}): ExecutionBackend {
  const backend: ExecutionBackend = {
    id: "local",
    label: "No isolation",
    capabilities: LOCAL_CAPABILITIES,
    open: async (spec) => {
      checkNetwork(backend, spec.network ?? "open");
      return new LocalSession(options);
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

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
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
  #closed = false;

  constructor(options: LocalBackendOptions) {
    this.#options = options;
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    if (this.#closed) return Promise.reject(new ExecRefusedError("This session is closed."));
    const platform = this.#options.platform ?? process.platform;
    const [program, ...args] = request.argv;
    if (platform === "win32" && /\.(cmd|bat)$/i.test(program)) {
      return Promise.reject(new ExecRefusedError(`${program} is a batch file. Nivra starts programs without a shell, so it can't run it on this target.`));
    }
    if (request.signal?.aborted) return Promise.resolve(notStarted(true));

    const env = childEnv(this.#options.baseEnv ?? process.env, request.env ?? {}, { platform, stripWindowsPaths: platform === "linux" && insideWsl() });
    const started = performance.now();
    return new Promise<ExecResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(program, args, {
          cwd: request.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
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
      request.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (outcome: { result: ExecResult } | { error: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(exitFallback);
        request.signal?.removeEventListener("abort", onAbort);
        this.#running.delete(child);
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.result);
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("spawn", () => request.onStart?.({ pid: child.pid ?? null }));
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
   */
  async close(): Promise<void> {
    this.#closed = true;
    const platform = this.#options.platform ?? process.platform;
    await Promise.all([...this.#running].map((child) => killTree(child, { platform })));
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
      await new Promise((resolve) => setTimeout(resolve, this.#options.graceMs ?? 2_000));
      signal("SIGKILL");
    }
    this.#groups.clear();
  }
}
