import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EngineFatal,
  ErrorCode,
  LineSplitter,
  PROTOCOL_VERSION,
  RpcCallError,
  RpcClient,
  type EngineInfo,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type SecretName,
} from "@nivra/domain";
import { decodeToolText, forceKill } from "./targets/process.ts";
import { TargetUnavailableError, type EngineLaunch, type ExecutionTarget } from "./targets/types.ts";

/**
 * Starts, watches and stops one engine on one target (D4, D12). Plain Node: Electron-specific inputs (log folder,
 * credentials, the resume hook) are passed in. Ported in spirit from Hird's engine-process.ts (state union, coalescing
 * start, log file as stderr); the discovery file, port probing, pid file and adoption are gone with HTTP (D2).
 */

export type EngineState =
  | { status: "stopped" }
  | { status: "starting"; detail: string }
  | { status: "online"; info: EngineInfo }
  | { status: "failed"; reason: string; code: string | null; logPath: string | null };

export interface SupervisorOptions {
  target: ExecutionTarget;
  logsDir: string;
  client: { name: string; version: string };
  /** The keys to hand the engine in `initialize`, read when it starts (D8). */
  credentials: () => Promise<Partial<Record<SecretName, string>>>;
  /** How long the engine waits for the host before stopping (D4); the supervisor pings six times as often. */
  heartbeatMs?: number;
  startTimeoutMs?: number;
  /** The quit order's waits (D4): after `shutdown`, then after closing stdin. */
  shutdownGraceMs?: number;
  eofGraceMs?: number;
  /** The host's own OS, which decides how a stuck engine is forced down. */
  hostPlatform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  log?: (line: string) => void;
}

/** Why an engine did not start, with a code the UI can act on. */
export class EngineStartError extends Error {
  readonly code: string;
  readonly logPath: string | null;

  constructor(code: string, message: string, logPath: string | null) {
    super(message);
    this.name = "EngineStartError";
    this.code = code;
    this.logPath = logPath;
  }
}

/** The engine is not running, so the call was not sent. */
export class EngineOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineOfflineError";
  }
}

interface Running {
  child: ChildProcess;
  client: RpcClient;
  launch: EngineLaunch;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>;
  fatal: EngineFatal | null;
  expectExit: boolean;
}

const describeExit = (code: number | null, signal: NodeJS.Signals | null): string => (signal ? `signal ${signal}` : `exit code ${String(code)}`);

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

export class EngineSupervisor {
  readonly #options: SupervisorOptions;
  readonly #listeners = new Set<(state: EngineState) => void>();
  readonly #logPath: string;
  #state: EngineState = { status: "stopped" };
  #running: Running | null = null;
  #starting: Promise<EngineInfo> | null = null;
  #stopping: Promise<void> | null = null;
  #pinger: ReturnType<typeof setInterval> | null = null;

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.#logPath = join(options.logsDir, `${options.target.descriptor.id.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
  }

  get target(): ExecutionTarget {
    return this.#options.target;
  }

  get state(): EngineState {
    return this.#state;
  }

  get logPath(): string {
    return this.#logPath;
  }

  onChange(listener: (state: EngineState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts the engine, or joins a start in progress. Resolves with what `initialize` answered. */
  start(): Promise<EngineInfo> {
    if (this.#state.status === "online") return Promise.resolve(this.#state.info);
    this.#starting ??= this.#start().finally(() => (this.#starting = null));
    return this.#starting;
  }

  async restart(): Promise<EngineInfo> {
    await this.stop();
    return this.start();
  }

  /** Sends one request to the running engine. */
  call<M extends MethodName>(method: M, params: ParamsOf<M>, options: { timeoutMs?: number } = {}): Promise<ResultOf<M>> {
    const running = this.#running;
    if (this.#state.status !== "online" || !running) {
      const why = this.#state.status === "failed" ? this.#state.reason : this.#state.status === "starting" ? "The engine is still starting." : "The engine isn't running.";
      return Promise.reject(new EngineOfflineError(why));
    }
    return running.client.call(method, params, options);
  }

  /** The machine woke up: show the engine the host is still here before its watchdog counts a silent tick (D4). */
  resumed(): void {
    if (this.#state.status === "online") void this.#running?.client.call("ping", {}).catch(() => undefined);
  }

  /** Stops the engine in the D4 order: `shutdown`, then closing its input, then force. */
  stop(): Promise<void> {
    this.#stopping ??= this.#stop().finally(() => (this.#stopping = null));
    return this.#stopping;
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  #set(state: EngineState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch (error) {
        this.#log(`An engine state listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  #log(line: string): void {
    this.#options.log?.(`[${this.#options.target.descriptor.id}] ${line}`);
  }

  async #start(): Promise<EngineInfo> {
    await this.#stopping;
    try {
      try {
        return await this.#attempt(false);
      } catch (error) {
        if (this.#options.target.descriptor.kind !== "wsl" || !needsReprovision(error)) throw error;
        this.#log(`Installing the runtime again: ${error instanceof Error ? error.message : String(error)}`);
        return await this.#attempt(true);
      }
    } catch (error) {
      const failure = error instanceof EngineStartError ? error : explainStartError(error, this.#logPath);
      this.#set({ status: "failed", reason: failure.message, code: failure.code, logPath: failure.logPath });
      throw failure;
    }
  }

  async #attempt(reprovision: boolean): Promise<EngineInfo> {
    const target = this.#options.target;
    const heartbeatMs = this.#options.heartbeatMs ?? 30_000;
    this.#set({ status: "starting", detail: `Preparing ${target.descriptor.label}…` });
    const instanceId = randomUUID();
    const launch = await target.prepare({ instanceId, heartbeatMs, reprovision, onProgress: (detail) => this.#set({ status: "starting", detail }) });
    this.#set({ status: "starting", detail: "Starting the engine…" });

    mkdirSync(this.#options.logsDir, { recursive: true });
    if (existsSync(this.#logPath) && statSync(this.#logPath).size > 0) renameSync(this.#logPath, this.#logPath.replace(/\.log$/, ".1.log"));
    const logFd = openSync(this.#logPath, "w");
    let child: ChildProcess;
    try {
      // Not detached: on Windows the engine (or wsl.exe) then sits in libuv's kill-on-close job object and dies with
      // the app even when quitting never runs (D4). Its stderr goes straight to the log file.
      child = (this.#options.spawn ?? nodeSpawn)(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", logFd], windowsHide: true });
    } finally {
      closeSync(logFd);
    }
    const running: Running = {
      child,
      launch,
      fatal: null,
      expectExit: false,
      client: new RpcClient({
        send: (line) => void child.stdin?.write(line),
        onNotification: (method, params) => {
          if (method !== "engine.fatal") return;
          const fatal = EngineFatal.safeParse(params);
          if (fatal.success) running.fatal = fatal.data;
        },
        onProtocolError: (problem) => this.#log(problem),
        defaultTimeoutMs: 30_000,
      }),
      exited: new Promise((resolve) => {
        child.once("error", (error) => resolve({ code: null, signal: null, error }));
        child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
      }),
    };
    this.#running = running;
    child.stdin?.on("error", () => undefined);
    const splitter = new LineSplitter();
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        for (const line of splitter.push(chunk)) running.client.receive(line);
      } catch (error) {
        this.#log(`The engine broke the protocol: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    void running.exited.then((exit) => this.#onExit(running, exit));

    try {
      const secrets = await this.#options.credentials();
      const answered = running.client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: this.#options.client, secrets }, { timeoutMs: this.#options.startTimeoutMs ?? 60_000 });
      const info = await Promise.race([
        answered,
        running.exited.then((exit) => {
          throw this.#exitError(running, exit);
        }),
      ]);
      this.#set({ status: "online", info });
      this.#startPinging(running, heartbeatMs);
      return info;
    } catch (error) {
      running.expectExit = true;
      await this.#forceDown(running);
      if (error instanceof EngineStartError) throw error;
      if (error instanceof RpcCallError && error.code === ErrorCode.ProtocolMismatch) throw new EngineStartError("protocol-mismatch", error.message, this.#logPath);
      // An exit that raced the failing call says more than the call's own error.
      const exit = await running.exited;
      if (running.fatal || exit.code !== null || exit.error) throw this.#exitError(running, exit);
      throw explainStartError(error, this.#logPath);
    }
  }

  #exitError(running: Running, exit: { code: number | null; signal: NodeJS.Signals | null; error: Error | null }): EngineStartError {
    if (running.fatal) return new EngineStartError(running.fatal.code, running.fatal.message, this.#logPath);
    if (exit.error) return new EngineStartError("spawn-failed", `The engine could not be started: ${exit.error.message}`, this.#logPath);
    const tail = readLogTail(this.#logPath);
    // wsl.exe's own words when the runtime it was asked to run is not there; it gives no code for this.
    if (this.#options.target.descriptor.kind === "wsl" && /execvpe\(/.test(tail)) {
      return new EngineStartError("runtime-missing", "The engine runtime in this distribution is missing or damaged.", this.#logPath);
    }
    return new EngineStartError("exited", `The engine stopped while starting (${describeExit(exit.code, exit.signal)}).${tail ? ` Last log lines: ${tail.slice(-300)}` : ""}`, this.#logPath);
  }

  #onExit(running: Running, exit: { code: number | null; signal: NodeJS.Signals | null; error: Error | null }): void {
    running.client.close("The engine exited.");
    if (this.#running !== running) return;
    this.#stopPinging();
    this.#running = null;
    if (running.expectExit || this.#state.status !== "online") return;
    const reason = running.fatal ? running.fatal.message : `The engine stopped unexpectedly (${describeExit(exit.code, exit.signal)}).`;
    this.#set({ status: "failed", reason, code: running.fatal?.code ?? "exited", logPath: this.#logPath });
  }

  #startPinging(running: Running, heartbeatMs: number): void {
    this.#stopPinging();
    if (heartbeatMs <= 0) return;
    this.#pinger = setInterval(() => {
      void running.client.call("ping", {}, { timeoutMs: Math.max(1_000, heartbeatMs / 2) }).catch((error: unknown) => this.#log(`ping failed: ${error instanceof Error ? error.message : String(error)}`));
    }, Math.max(1_000, Math.floor(heartbeatMs / 6)));
    this.#pinger.unref?.();
  }

  #stopPinging(): void {
    if (this.#pinger) clearInterval(this.#pinger);
    this.#pinger = null;
  }

  async #stop(): Promise<void> {
    await this.#starting?.catch(() => undefined);
    const running = this.#running;
    if (!running) {
      if (this.#state.status !== "failed") this.#set({ status: "stopped" });
      return;
    }
    running.expectExit = true;
    this.#stopPinging();
    const shutdownGrace = this.#options.shutdownGraceMs ?? 5_000;
    const eofGrace = this.#options.eofGraceMs ?? 2_000;
    await within(running.client.call("shutdown", {}, { timeoutMs: shutdownGrace }).catch(() => undefined), shutdownGrace);
    if ((await within(running.exited, shutdownGrace)) === "timeout") {
      running.child.stdin?.end();
      if ((await within(running.exited, eofGrace)) === "timeout") await this.#forceDown(running);
    }
    await running.launch.cleanup?.();
    if (this.#running === running) this.#running = null;
    this.#set({ status: "stopped" });
  }

  /** The quit order's last step (D4), also used when a start fails. */
  async #forceDown(running: Running): Promise<void> {
    const kind = this.#options.target.descriptor.kind;
    const host = this.#options.hostPlatform ?? process.platform;
    // Killing wsl.exe ends the session's pipes; the engine then sees EOF, and cleanup removes anything left.
    if (kind === "wsl") running.child.kill();
    else await forceKill(running.child, host);
    await within(running.exited, 5_000);
    if (kind === "wsl") await running.launch.cleanup?.();
  }
}

/** A start failure that installing the WSL runtime again may fix. */
function needsReprovision(error: unknown): boolean {
  return error instanceof EngineStartError && ["runtime-broken", "runtime-missing", "protocol-mismatch"].includes(error.code);
}

function explainStartError(error: unknown, logPath: string): EngineStartError {
  if (error instanceof EngineStartError) return error;
  if (error instanceof TargetUnavailableError) return new EngineStartError(error.problems.find((p) => p.severity === "blocking")?.code ?? "unavailable", error.message, null);
  if (error instanceof Error && error.name === "RpcTimeoutError") return new EngineStartError("no-answer", "The engine started but didn't answer within a minute.", logPath);
  return new EngineStartError("failed", error instanceof Error ? error.message : String(error), logPath);
}

/** The last few lines of the engine's log, for an error message. */
export function readLogTail(path: string, bytes = 4_096): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const length = Math.min(bytes, size);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return decodeToolText(buffer).trim().split("\n").slice(-12).join("\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}
