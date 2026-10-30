import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineSplitter, parseMessage, PROTOCOL_VERSION, RpcClient, type EngineInfo, type InitializeParams, type RunEventsPage } from "@nivra/domain";

export const MAIN = fileURLToPath(new URL("../src/main.mjs", import.meta.url));

/** Characters every engine path must survive: a space, a non-ASCII letter, "%" and "#" (D5, D7). */
export const AWKWARD = "nivra test ü%#";

/** A new folder under the temp folder whose name holds the awkward characters. */
export function tempDir(label = AWKWARD): string {
  return mkdtempSync(join(tmpdir(), `${label} `));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** A git repository with one commit on `main`, in a folder whose name holds the awkward characters. */
export function makeRepo(parent: string, name = `repo ${AWKWARD}`): string {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Nivra Test", "-c", "user.email=test@nivra.invalid", ...args], { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export async function waitFor<T>(check: () => T | Promise<T>, options: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<NonNullable<T>> {
  const deadline = performance.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value as NonNullable<T>;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${options.what ?? "a condition"}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 50));
  }
}

export interface EngineProcess {
  child: ChildProcessWithoutNullStreams;
  client: RpcClient;
  /** Every line the engine wrote to stdout. */
  lines: string[];
  notifications: Array<{ method: string; params: unknown }>;
  protocolErrors: string[];
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  initialize(secrets?: InitializeParams["secrets"]): Promise<EngineInfo>;
  /** Polls a run's events until `until` holds for the page. */
  waitForRun(runId: string, until: (page: RunEventsPage) => boolean, timeoutMs?: number): Promise<RunEventsPage>;
  kill(): void;
}

/** Starts the engine as the host would, over stdio, with `--home` (never the environment) for isolation (D3). */
export function startEngine(home: string, options: { heartbeatMs?: number; instanceId?: string; args?: string[]; env?: NodeJS.ProcessEnv; umask?: number } = {}): EngineProcess {
  const args = options.args ?? ["--stdio", "--home", home, "--instance", options.instanceId ?? randomUUID(), "--heartbeat-ms", String(options.heartbeatMs ?? 0)];
  // `env` is for a test that changes where the engine finds its tools, such as a fake git first on PATH.
  const bootstrap = options.umask === undefined ? [] : ["--import", `data:text/javascript,process.umask(${options.umask})`];
  const child = spawn(process.execPath, [...bootstrap, MAIN, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(options.env ? { env: options.env } : {}) });
  const lines: string[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const protocolErrors: string[] = [];
  let stderr = "";
  const client = new RpcClient({
    send: (line) => void child.stdin.write(line),
    onNotification: (method, params) => notifications.push({ method, params }),
    onProtocolError: (problem) => protocolErrors.push(problem),
    defaultTimeoutMs: 20_000,
  });
  const splitter = new LineSplitter();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) {
      lines.push(line);
      client.receive(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdin.on("error", () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => {
      client.close("The engine exited.");
      resolve({ code, signal });
    }),
  );
  const engine: EngineProcess = {
    child,
    client,
    lines,
    notifications,
    protocolErrors,
    stderr: () => stderr,
    exited,
    initialize: (secrets = {}) => client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "engine-test", version: "0" }, secrets }),
    waitForRun: (runId, until, timeoutMs = 20_000) =>
      waitFor(
        async () => {
          const page = await client.call("runs.events", { runId, after: 0, limit: 500 });
          return until(page) ? page : null;
        },
        { timeoutMs, what: `run ${runId}` },
      ),
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
  return engine;
}

/** Lines on stdout that are not JSON-RPC messages: must always be none (D2). */
export const impureLines = (lines: readonly string[]): string[] => lines.filter((line) => !parseMessage(line).ok);
