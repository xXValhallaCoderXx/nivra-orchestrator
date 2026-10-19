import { basename, join } from "node:path";
import {
  combinedMask,
  ErrorCode,
  ExplainInput,
  ExplainResult,
  HelloInput,
  LineSplitter,
  PROTOCOL_VERSION,
  type EngineFatal,
  type EngineInfo,
  type JsonObject,
  type SecretName,
  type WorkflowId,
} from "@nivra/domain";
import { ArgsError, readArgs, type EngineArgs } from "./args.ts";
import { Database, EngineLockedError } from "./db/database.ts";
import { libsqlFileUrl } from "./db/libsql-url.ts";
import { runDoctor } from "./doctor/doctor.ts";
import { childEnv, insideWsl } from "./exec/child-env.ts";
import { findGit } from "./exec/find-executable.ts";
import { createLocalBackend } from "./exec/local.ts";
import { readTask, TaskUnreadable } from "./explain/task.ts";
import { launcherWrite, ProtocolOutput, type RawWrite } from "./rpc/output.ts";
import { RpcFailure, RpcServer } from "./rpc/server.ts";
import { TOKEN_FACTORY_BASE_URL } from "./providers/tokenfactory.ts";
import { RunScheduler, type WorkflowEntry, type WorkflowSource } from "./runs/scheduler.ts";
import { RunStore } from "./runs/store.ts";
import { SecretVault, stripProviderEnv } from "./secrets/vault.ts";
import { ENGINE_VERSION, readRuntimeHash } from "./version.ts";

/** A dependency of the engine could not load: the runtime is damaged or incomplete (D5, D6). */
export class RuntimeBrokenError extends Error {
  constructor(what: string, cause: unknown) {
    super(`The engine's ${what} could not load (${cause instanceof Error ? cause.message : String(cause)}). Reinstall Nivra, or let it provision this target again.`);
    this.name = "RuntimeBrokenError";
  }
}

const WORKFLOWS: ReadonlyMap<WorkflowId, WorkflowEntry> = new Map<WorkflowId, WorkflowEntry>([
  ["hello", { id: "hello", title: (input: unknown) => `Hello · ${basename(HelloInput.parse(input).repoPath) || "repository"}` }],
  [
    "explain",
    {
      id: "explain",
      title: (input: unknown) => `Explain · ${basename(ExplainInput.parse(input).repoPath) || "repository"}`,
      // Mastra stores step data as it is: it gets the path, never the question or the choices (D22). This reads the
      // stored copy, which is masked, so only its shape is checked (D23).
      mastraInput: (input: unknown) => {
        const task = readTask(input);
        if (!task) throw new TaskUnreadable();
        return { repoPath: task.repoPath };
      },
    },
  ],
]);

export interface EngineOptions extends EngineArgs {
  output: ProtocolOutput;
  log: (line: string) => void;
  /** The engine's own module URL, for finding the staged runtime's manifest. */
  moduleUrl: string;
  env?: NodeJS.ProcessEnv;
}

export interface Engine {
  readonly instanceId: string;
  handleLine(line: string): void;
  /** Starts the engine's one shutdown path (D4) and resolves when everything has stopped and every answer is written. */
  shutdown(reason: string): Promise<void>;
  /** Resolves once the engine has shut down, whatever started it. */
  readonly closed: Promise<void>;
}

/**
 * Builds the engine for one home: takes the home's lock (D7), recovers interrupted runs, and answers the host over
 * `output`. Mastra and its storage driver are imported here rather than at the top, so a damaged runtime is reported
 * as such instead of crashing the import.
 */
export async function createEngine(options: EngineOptions): Promise<Engine> {
  const { home, instanceId, output, log } = options;
  const env = options.env ?? process.env;
  const database = new Database(join(home, "nivra.db"), { exclusive: true });
  database.open();

  let mastraModules: [typeof import("@mastra/core/mastra"), typeof import("@mastra/libsql"), typeof import("./workflows/hello.ts"), typeof import("./workflows/explain.ts")];
  try {
    mastraModules = await Promise.all([import("@mastra/core/mastra"), import("@mastra/libsql"), import("./workflows/hello.ts"), import("./workflows/explain.ts")]);
  } catch (error) {
    database.close();
    throw new RuntimeBrokenError("workflow runtime", error);
  }
  const [{ Mastra }, { LibSQLStore }, { createHelloWorkflow, HELLO_WORKFLOW_ID }, { createExplainWorkflow, EXPLAIN_WORKFLOW_ID }] = mastraModules;

  const vault = new SecretVault();
  // Known key values and credential shapes are masked in everything stored (D8, D22).
  const mask = combinedMask(vault.mask);
  const store = new RunStore({ database, mask: (text) => mask(text) });
  const backend = createLocalBackend({ baseEnv: env });
  const toolEnv = childEnv(env, {}, { stripWindowsPaths: process.platform === "linux" && insideWsl(env) });
  const locateGit = () => findGit({ env: toolEnv });
  const runtimeHash = readRuntimeHash(options.moduleUrl);
  // Token Factory, or a test stub on this machine when the loopback-only argument names one (D22).
  const endpoint = options.tokenFactoryUrl ? { url: options.tokenFactoryUrl, kind: "loopback-test" as const } : { url: TOKEN_FACTORY_BASE_URL, kind: "token-factory" as const };
  const info = (): EngineInfo => ({
    protocolVersion: PROTOCOL_VERSION,
    engineVersion: ENGINE_VERSION,
    instanceId,
    pid: process.pid,
    home,
    runtimeHash,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });

  const mastra = new Mastra({
    workflows: {
      [HELLO_WORKFLOW_ID]: createHelloWorkflow({
        backend,
        platform: process.platform,
        findGit: locateGit,
        engineInfo: () => info() as unknown as JsonObject,
        // Called while a step runs, long after the scheduler below exists.
        context: (runId) => scheduler.contextOf(runId),
        recorder: {
          output: (runId, stepId, message, data) => void store.append(runId, { type: "step.output", stepId, message, data: data ?? null }),
          command: (runId, stepId, phase, message, data) =>
            void store.append(runId, { type: phase === "started" ? "command.started" : "command.finished", stepId, message, data: data ?? null }),
        },
      }),
      [EXPLAIN_WORKFLOW_ID]: createExplainWorkflow({
        backend,
        platform: process.platform,
        findGit: locateGit,
        context: (runId) => scheduler.contextOf(runId),
        task: (runId) => readTask(store.summary(runId)?.input),
        apiKey: () => vault.get("NEBIUS_API_KEY"),
        endpoint,
        mask,
        setMeta: (runId, meta) => store.setMeta(runId, meta),
        saveResult: (runId, result) => store.saveArtifact(runId, "explain", JSON.stringify(result)),
        recorder: {
          output: (runId, stepId, message, data) => void store.append(runId, { type: "step.output", stepId, message, data: data ?? null }),
          event: (runId, type, stepId, message, data) => void store.append(runId, { type, stepId, message, data }),
        },
      }),
    },
    storage: new LibSQLStore({ id: "nivra-engine", url: libsqlFileUrl(join(home, "mastra.db")) }),
    logger: false,
  });

  const scheduler = new RunScheduler({
    store,
    workflows: WORKFLOWS,
    instanceId,
    log: { info: log, warn: (m) => log(`warning: ${m}`), error: (m) => log(`error: ${m}`) },
  });
  scheduler.attach(mastra as unknown as WorkflowSource);
  // This process holds the home's lock, so no other engine can be running these runs (D7).
  scheduler.recover();

  let initialized = false;
  let stopping: Promise<void> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  const notFound = (runId: string): never => {
    throw new RpcFailure(ErrorCode.InvalidParams, `There is no run ${runId}.`);
  };

  const server = new RpcServer({
    output,
    log,
    mask: vault.mask,
    initialized: () => initialized,
    stopping: () => stopping !== null,
    handlers: {
      initialize: (params) => {
        if (params.protocolVersion !== PROTOCOL_VERSION) {
          throw new RpcFailure(
            ErrorCode.ProtocolMismatch,
            `This engine speaks protocol ${PROTOCOL_VERSION} and the app speaks ${params.protocolVersion}. Let Nivra install the engine again.`,
            { engineProtocolVersion: PROTOCOL_VERSION },
          );
        }
        for (const [name, value] of Object.entries(params.secrets)) if (value) vault.set(name as SecretName, value);
        initialized = true;
        // Deliberately console.log: the launcher sends it to stderr, and the stdout purity test proves it (D2).
        console.log(`Nivra engine ${ENGINE_VERSION} ready for ${params.client.name} ${params.client.version}`);
        return info();
      },
      "secrets.update": (params) => {
        for (const [name, value] of Object.entries(params.set)) if (value) vault.set(name as SecretName, value);
        for (const name of params.remove) vault.remove(name);
        return { ok: true as const };
      },
      shutdown: () => {
        void shutdown("the app asked it to stop");
        return { ok: true as const };
      },
      ping: () => ({ instanceId }),
      doctor: () => runDoctor({ home, platform: process.platform, arch: process.arch, toolEnv, findGit: locateGit, backend, vault, endpoint }),
      "providers.check": async ({ model }) => {
        // B7: Token Factory reached from wherever this engine runs, with the key held in memory (D8).
        const key = vault.get("NEBIUS_API_KEY");
        if (!key) throw new RpcFailure(ErrorCode.InvalidParams, "No Nebius key is set. Add it in Settings, then check again.");
        const { runProviderCheck } = await import("./providers/tool-call.ts");
        try {
          const result = await runProviderCheck({ apiKey: key, endpoint, ...(model ? { model } : {}) });
          return {
            ...result,
            call: result.call ? { ...result.call, answer: vault.mask(result.call.answer) } : null,
            problem: result.problem === null ? null : vault.mask(result.problem),
          };
        } catch (error) {
          // Only listing the models throws: everything after it is reported in the result.
          const kind = error instanceof Error && "kind" in error ? String(error.kind) : "internal";
          throw new RpcFailure(ErrorCode.InternalError, vault.mask(error instanceof Error ? error.message : String(error)), { kind });
        }
      },
      "runs.start": (params) => store.summary(scheduler.submit(params)) ?? notFound("just created"),
      "runs.get": ({ runId }) => store.summary(runId) ?? notFound(runId),
      "runs.list": ({ limit, cursor }) => store.list({ limit, cursor }),
      "runs.events": ({ runId, after, limit }) => store.events(runId, after, limit) ?? notFound(runId),
      "runs.cancel": ({ runId }) => scheduler.cancel(runId) ?? notFound(runId),
      "runs.result": ({ runId }) => {
        if (!store.status(runId)) notFound(runId);
        const stored = store.artifact(runId, "explain");
        return stored === null ? null : ExplainResult.parse(JSON.parse(stored));
      },
    },
  });

  const shutdown = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log(`Shutting down: ${reason}`);
      try {
        await scheduler.stop(reason, 3_000);
        await server.idle();
      } finally {
        database.close();
        resolveClosed();
      }
    })();
    return stopping;
  };

  return { instanceId, handleLine: (line) => server.handleLine(line), shutdown, closed };
}

/**
 * Counts consecutive watchdog ticks in which nothing arrived from the host (D4), so a long sleep or a stalled main
 * thread counts as one silent tick, not as the whole timeout. `heartbeatMs` 0 turns it off.
 */
export function startWatchdog(heartbeatMs: number, received: () => number, onSilence: () => void, ticks = 3): () => void {
  if (heartbeatMs <= 0) return () => undefined;
  const interval = Math.max(50, Math.floor(heartbeatMs / ticks));
  let last = received();
  let silent = 0;
  const timer = setInterval(() => {
    const now = received();
    if (now !== last) {
      last = now;
      silent = 0;
      return;
    }
    silent++;
    if (silent >= ticks) {
      clearInterval(timer);
      onSilence();
    }
  }, interval);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Loads everything a run needs, without a home: `node:sqlite`, Mastra, the workflows and libsql's native driver. Used
 * by staging and by WSL provisioning to prove a runtime works before it is used (D5). Prints `engine.selfCheck`.
 */
export async function selfCheck(output: ProtocolOutput, log: (line: string) => void, moduleUrl: string): Promise<number> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    new DatabaseSync(":memory:").close();
    const [, { LibSQLStore }] = await Promise.all([import("@mastra/core/mastra"), import("@mastra/libsql"), import("./workflows/hello.ts"), import("./workflows/explain.ts")]);
    await new LibSQLStore({ id: "nivra-self-check", url: ":memory:" }).init();
  } catch (error) {
    await fatal(output, log, "runtime-broken", new RuntimeBrokenError("runtime", error).message);
    return 5;
  }
  await output.send({
    jsonrpc: "2.0",
    method: "engine.selfCheck",
    params: { ok: true, engineVersion: ENGINE_VERSION, node: process.versions.node, platform: process.platform, arch: process.arch, runtimeHash: readRuntimeHash(moduleUrl) },
  });
  return 0;
}

async function fatal(output: ProtocolOutput, log: (line: string) => void, code: EngineFatal["code"], message: string): Promise<void> {
  log(`fatal (${code}): ${message}`);
  await output.send({ jsonrpc: "2.0", method: "engine.fatal", params: { code, message } });
}

/** The engine's process: reads JSON-RPC lines on stdin and answers on stdout until it shuts down. Returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const log = (line: string) => void process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const write: RawWrite = launcherWrite() ?? ((chunk, callback) => process.stdout.write(chunk, callback));
  let engine: Engine | null = null;
  const output = new ProtocolOutput(write, (error) => {
    log(`The app's end of the protocol closed (${error.message}).`);
    void engine?.shutdown("the app closed the connection");
  });
  process.stdout.on("error", (error) => output.fail(error));
  if (argv.includes("--self-check")) return selfCheck(output, log, import.meta.url);

  let args: EngineArgs;
  try {
    args = readArgs(argv);
  } catch (error) {
    await fatal(output, log, "bad-arguments", error instanceof ArgsError ? error.message : String(error));
    return 4;
  }
  stripProviderEnv(process.env);

  try {
    engine = await createEngine({ ...args, output, log, moduleUrl: import.meta.url });
  } catch (error) {
    if (error instanceof EngineLockedError) {
      await fatal(output, log, "locked", error.message);
      return 3;
    }
    if (error instanceof RuntimeBrokenError) {
      await fatal(output, log, "runtime-broken", error.message);
      return 5;
    }
    await fatal(output, log, "home-unusable", `The engine could not open ${args.home}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const running = engine;

  const splitter = new LineSplitter();
  let received = 0;
  const take = (lines: readonly string[]) => {
    for (const line of lines) {
      received++;
      if (line.trim()) running.handleLine(line);
    }
  };
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      take(splitter.push(chunk));
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      void running.shutdown("the app sent a line longer than the protocol allows");
    }
  });
  process.stdin.on("end", () => {
    try {
      const last = splitter.end();
      if (last !== null) take([last]);
    } catch {
      // A broken last line changes nothing: the input has ended either way.
    }
    void running.shutdown("the app closed the engine's input");
  });
  process.stdin.on("error", () => void running.shutdown("the engine's input failed"));
  const stopWatchdog = startWatchdog(args.heartbeatMs, () => received, () => void running.shutdown("the app stopped answering"));
  process.once("SIGTERM", () => void running.shutdown("it received SIGTERM"));
  process.once("SIGINT", () => void running.shutdown("it received SIGINT"));

  await running.closed;
  stopWatchdog();
  return 0;
}
