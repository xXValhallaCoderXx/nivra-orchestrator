import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ChatInput,
  ChatResult,
  combinedMask,
  ReviewReport,
  ErrorCode,
  ExplainInput,
  ExplainResult,
  HelloInput,
  isTerminal,
  LineSplitter,
  PROTOCOL_VERSION,
  SandboxReport,
  type EngineFatal,
  type EngineInfo,
  type ChatContext,
  type JsonObject,
  type ReviewContext,
  type RunContext,
  type SandboxContext,
  type SandboxPreview,
  type SandboxStatus,
  type SecretName,
  type WorkflowId,
} from "@nivra/domain";
import { installGitAdvice } from "./advice.ts";
import { ArgsError, readArgs, type EngineArgs } from "./args.ts";
import { errorFacts, formatDiagnostic, internalMessage, publicFailure, Refusal, type Diagnostic } from "./diagnostics.ts";
import { Database, EngineLockedError } from "./db/database.ts";
import { libsqlFileUrl } from "./db/libsql-url.ts";
import { runDoctor } from "./doctor/doctor.ts";
import { CHECK_IMAGE, CHECK_LIMITS, previewOf, readSandboxTask, safeUnresolved } from "./exec/check.ts";
import { childEnv, insideWsl } from "./exec/child-env.ts";
import { findGit } from "./exec/find-executable.ts";
import { WorkspaceRefusal } from "./exec/git-tool.ts";
import { createLocalBackend } from "./exec/local.ts";
import { fetchTransport, SANDBOXES_BASE_URL, type Transport } from "./exec/nebius/api.ts";
import { createNebiusBackend, NEBIUS_LIMITS, reconcileJournals, scanJournals, type NebiusCredentials } from "./exec/nebius/session.ts";
import { takeSnapshot } from "./exec/snapshot.ts";
import { ChatUnreadable, readChatTask } from "./chat/task.ts";
import { readTask, TaskUnreadable } from "./explain/task.ts";
import { asEnded, readReviewTask, ReviewUnreadable } from "./review/task.ts";
import { launcherWrite, ProtocolOutput, type RawWrite } from "./rpc/output.ts";
import { RpcFailure, RpcServer } from "./rpc/server.ts";
import { TOKEN_FACTORY_BASE_URL } from "./providers/tokenfactory.ts";
import { RunScheduler, type WorkflowEntry, type WorkflowSource } from "./runs/scheduler.ts";
import { RunStore } from "./runs/store.ts";
import { SecretVault, stripProviderEnv } from "./secrets/vault.ts";
import { ENGINE_VERSION, readRuntimeHash } from "./version.ts";

/** What the engine says when it stops because something inside it failed (NIV-27): Nivra's own words only. */
const CRASH_MESSAGE = "The engine stopped because something inside it failed. Start it again; if it keeps happening, report it with the engine log.";

/**
 * What the launcher writes when an error reaches no handler (NIV-27): one diagnostic line, and the message for the
 * app's `engine.fatal`. Node's own report of an uncaught error prints its message and properties, which can quote the
 * key or the repository, so it never runs.
 */
export function crashReport(error: unknown): { line: string; message: string } {
  return { line: formatDiagnostic({ code: "crashed", stage: "process", error: errorFacts(error) }), message: CRASH_MESSAGE };
}

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
  [
    "chat",
    {
      id: "chat",
      title: (input: unknown) => {
        const { scope } = ChatInput.parse(input);
        return scope.kind === "repository" ? `Chat · ${basename(scope.repoPath) || "repository"}` : "Chat";
      },
      // Mastra gets the repository's path, never the message (D22); a general turn gives it nothing.
      mastraInput: (input: unknown) => {
        const task = readChatTask(input);
        if (!task) throw new ChatUnreadable();
        return { repoPath: task.scope.kind === "repository" ? task.scope.repoPath : null };
      },
    },
  ],
  [
    "review",
    {
      id: "review",
      title: (input: unknown) => {
        const task = readReviewTask(input);
        return task ? `${task.panel === "single" ? "Single review" : "Council review"} · plan v${task.planVersion}` : "Review";
      },
      // Mastra gets the panel alone: the plan's id, version and fingerprints stay in the run store, and the packet in
      // memory (D21, D30).
      mastraInput: (input: unknown) => {
        const task = readReviewTask(input);
        if (!task) throw new ReviewUnreadable();
        return { panel: task.panel };
      },
    },
  ],
  [
    "sandbox",
    {
      id: "sandbox",
      title: (input: unknown) => `Sandbox check · ${basename(readSandboxTask(input)?.repoPath ?? "") || "repository"}`,
      // Mastra gets the checkout's path alone (D22): the project, the target and the preview stay in the run store.
      mastraInput: (input: unknown) => {
        const task = readSandboxTask(input);
        if (!task) throw new Refusal("input-unreadable", "This check's request can't be read back from the engine's store, so it wasn't started. Check again.");
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

  let mastraModules: [
    typeof import("@mastra/core/mastra"),
    typeof import("@mastra/libsql"),
    typeof import("./workflows/hello.ts"),
    typeof import("./workflows/explain.ts"),
    typeof import("./workflows/chat.ts"),
    typeof import("./workflows/review.ts"),
    typeof import("./workflows/sandbox.ts"),
  ];
  try {
    mastraModules = await Promise.all([
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("./workflows/hello.ts"),
      import("./workflows/explain.ts"),
      import("./workflows/chat.ts"),
      import("./workflows/review.ts"),
      import("./workflows/sandbox.ts"),
    ]);
  } catch (error) {
    database.close();
    throw new RuntimeBrokenError("workflow runtime", error);
  }
  const [
    { Mastra },
    { LibSQLStore },
    { createHelloWorkflow, HELLO_WORKFLOW_ID },
    { createExplainWorkflow, EXPLAIN_WORKFLOW_ID },
    { createChatWorkflow, CHAT_WORKFLOW_ID },
    { createReviewWorkflow, REVIEW_WORKFLOW_ID },
    { createSandboxWorkflow, SANDBOX_WORKFLOW_ID },
  ] = mastraModules;

  const vault = new SecretVault();
  // Known key values and credential shapes are masked in everything stored (D8, D22).
  const mask = combinedMask(vault.mask);
  // Every failure the engine logs, as one bounded line that never holds an error's own words (NIV-27).
  const diagnose = (diagnostic: Diagnostic) => log(mask(formatDiagnostic(diagnostic)));
  const store = new RunStore({ database, mask: (text) => mask(text) });
  // Names this home's store for the host (D26), as its path can't.
  const homeId = store.homeId();
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
    homeId,
    runtimeHash,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });

  // Each workflow reads the context its own kind of run carries (D21, D26). A sandbox check's alone holds no
  // preferences: its consent is for uploads, never for a model (D36).
  const runContext = (runId: string): RunContext | null => {
    const given = scheduler.contextOf(runId);
    return given && "preferences" in given && !("history" in given) && !("packet" in given) ? given : null;
  };
  const sandboxContext = (runId: string): SandboxContext | null => {
    const given = scheduler.contextOf(runId);
    return given && !("preferences" in given) ? given : null;
  };
  const reviewContext = (runId: string): ReviewContext | null => {
    const given = scheduler.contextOf(runId);
    return given && "packet" in given ? given : null;
  };
  const chatContext = (runId: string): ChatContext | null => {
    const given = scheduler.contextOf(runId);
    return given && "history" in given ? given : null;
  };
  const recorder = {
    output: (runId: string, stepId: string, message: string, data?: JsonObject) => void store.append(runId, { type: "step.output", stepId, message, data: data ?? null }),
    event: (runId: string, type: "model.call" | "tool.called", stepId: string, message: string, data: JsonObject) => void store.append(runId, { type, stepId, message, data }),
  };

  // Nebius Sandboxes (D33–D36): the key and project id from the vault only (D8), every session journaled under the
  // engine's home, and a stub on this machine in their place when the tests name one.
  const journals = join(home, "sandbox");
  const sandboxCredentials = (): NebiusCredentials | null => {
    const key = vault.get("NEBIUS_API_KEY");
    const project = vault.get("NEBIUS_PROJECT_ID");
    return key && project ? { key, project } : null;
  };
  // The key refuses a commit, or a change, that holds it (D34). The project id doesn't: it names the account the
  // upload goes to, so a commit naming it, as infrastructure code does, sends Nebius nothing it doesn't know.
  const knownValues = () => (["NEBIUS_API_KEY"] as const).flatMap((name) => vault.get(name) ?? []);
  const sandboxLimits = {
    ...NEBIUS_LIMITS,
    maxOperations: CHECK_LIMITS.maxOperations,
    maxTimeoutSeconds: CHECK_LIMITS.stepTimeoutMs / 1000,
    prepareTimeoutSeconds: CHECK_LIMITS.stepTimeoutMs / 1000,
    sessionBudgetMs: CHECK_LIMITS.budgetMs,
    cleanupBudgetMs: CHECK_LIMITS.closeBudgetMs,
  };
  const sandboxTransport = (given: NebiusCredentials): Transport => fetchTransport(given, options.sandboxesUrl ?? SANDBOXES_BASE_URL);
  const sandboxBackend = () => createNebiusBackend({ credentials: sandboxCredentials, baseImage: CHECK_IMAGE.uuid, journalDir: journals, limits: sandboxLimits, transport: sandboxTransport });
  // Stops the engine's background work, and a check's cleanup, when the engine shuts down (D4).
  const engineStop = new AbortController();

  // What an earlier engine left open (D33): read at start with no network, then settled by one bounded pass once the
  // credentials arrive. Nothing is replayed. The list is read again only while no check is going, so it never holds
  // the journal of a session this engine has open; a journal a pass settles leaves it at once.
  let scanned = scanJournals(journals);
  const pass: SandboxStatus["pass"] = { state: scanned.open.length ? "waiting-for-credentials" : "idle", startedAt: null, finishedAt: null, stopped: 0, alreadyEnded: 0, unresolved: [] };
  const checksActive = () => store.active().some((runId) => store.summary(runId)?.workflowId === "sandbox");
  /** Whether a check of this project is going here, besides the one this request started (D36). */
  const checkGoing = (project: string, clientRequestId: string) =>
    store.active().some((runId) => {
      const summary = store.summary(runId);
      return summary?.workflowId === "sandbox" && readSandboxTask(summary.input)?.project === project && store.requestIdOf(runId) !== clientRequestId;
    });
  const rescan = () => {
    if (!checksActive()) scanned = scanJournals(journals);
  };
  const recover = (): void => {
    // A journal moved aside since the list was read was settled by then.
    scanned = { ...scanned, open: scanned.open.filter((scan) => existsSync(scan.path)) };
    if (pass.state === "running" || engineStop.signal.aborted || scanned.open.length === 0) return;
    const credentials = sandboxCredentials();
    if (!credentials) {
      pass.state = "waiting-for-credentials";
      return;
    }
    Object.assign(pass, { state: "running", startedAt: new Date().toISOString(), finishedAt: null, stopped: 0, alreadyEnded: 0, unresolved: [] });
    void reconcileJournals(scanned.open, { credentials, budgetMs: CHECK_LIMITS.closeBudgetMs, signal: engineStop.signal, transport: sandboxTransport, limits: sandboxLimits })
      .then((results) => {
        pass.stopped = results.reduce((sum, result) => sum + result.stopped.length, 0);
        pass.alreadyEnded = results.reduce((sum, result) => sum + result.alreadyEnded.length, 0);
        pass.unresolved = results.flatMap((result) => result.unresolved).slice(0, 200).map(safeUnresolved);
        const settled = new Set(results.filter((result) => result.unresolved.length === 0).map((result) => result.path));
        scanned = { ...scanned, open: scanned.open.filter((scan) => !settled.has(scan.path)) };
      })
      .catch((error: unknown) => {
        diagnose({ code: "unexpected-error", stage: "sandbox.recover", error: errorFacts(error) });
        pass.unresolved = [safeUnresolved("")];
      })
      .finally(() => {
        Object.assign(pass, { state: "done", finishedAt: new Date().toISOString() });
        rescan();
      });
  };
  const sandboxStatus = (): SandboxStatus => ({
    open: scanned.open.slice(0, 200).map((scan) => ({ journal: basename(scan.path).slice(0, 128), operations: scan.operations.length, uncertain: scan.uncertain.length, damaged: scan.damaged !== null })),
    unread: scanned.unread,
    pass: { ...pass, unresolved: [...pass.unresolved] },
  });
  /** What a check of this checkout would send, with no network; a commit that would be refused says why. */
  const sandboxPreview = async (repoPath: string): Promise<SandboxPreview> => {
    const git = locateGit();
    if (!git) throw new RpcFailure(ErrorCode.InvalidParams, `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(process.platform)}`);
    const session = await backend.open({ workspace: repoPath });
    try {
      return previewOf(await takeSnapshot({ folder: repoPath, session, git, exclude: [home], knownValues: knownValues() }));
    } catch (error) {
      // It names the file it is about: a preview is shown to the person, and never stored (D36).
      if (error instanceof WorkspaceRefusal) return { status: "refused", code: error.code, message: mask(error.message).slice(0, 2_000) };
      throw error;
    } finally {
      await session.close();
    }
  };

  const mastra = new Mastra({
    workflows: {
      [HELLO_WORKFLOW_ID]: createHelloWorkflow({
        backend,
        mask,
        platform: process.platform,
        findGit: locateGit,
        engineInfo: () => info() as unknown as JsonObject,
        // Called while a step runs, long after the scheduler below exists.
        context: runContext,
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
        context: runContext,
        task: (runId) => readTask(store.summary(runId)?.input),
        apiKey: () => vault.get("NEBIUS_API_KEY"),
        endpoint,
        mask,
        setMeta: (runId, meta) => store.setMeta(runId, meta),
        saveResult: (runId, result) => store.saveArtifact(runId, "explain", JSON.stringify(result)),
        recorder,
      }),
      [CHAT_WORKFLOW_ID]: createChatWorkflow({
        backend,
        platform: process.platform,
        findGit: locateGit,
        context: chatContext,
        task: (runId) => readChatTask(store.summary(runId)?.input),
        apiKey: () => vault.get("NEBIUS_API_KEY"),
        endpoint,
        mask,
        setMeta: (runId, meta) => store.setMeta(runId, meta),
        saveResult: (runId, result) => store.saveArtifact(runId, "chat", JSON.stringify(result)),
        recorder,
      }),
      [REVIEW_WORKFLOW_ID]: createReviewWorkflow({
        context: reviewContext,
        task: (runId) => readReviewTask(store.summary(runId)?.input),
        requestId: (runId) => store.requestIdOf(runId),
        apiKey: () => vault.get("NEBIUS_API_KEY"),
        endpoint,
        mask,
        setMeta: (runId, meta) => store.setMeta(runId, meta),
        saveResult: (runId, report) => store.saveArtifact(runId, "review", JSON.stringify(report)),
        recorder,
      }),
      [SANDBOX_WORKFLOW_ID]: createSandboxWorkflow({
        recorder,
        context: sandboxContext,
        task: (runId) => readSandboxTask(store.summary(runId)?.input),
        requestId: (runId) => store.requestIdOf(runId),
        credentials: sandboxCredentials,
        sandbox: sandboxBackend,
        local: backend,
        findGit: locateGit,
        platform: process.platform,
        exclude: [home],
        knownValues,
        shutdown: engineStop.signal,
        mask,
        saveResult: (runId, report) => store.saveArtifact(runId, "sandbox", JSON.stringify(report)),
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
    diagnose,
  });
  scheduler.attach(mastra as unknown as WorkflowSource);
  // This process holds the home's lock, so no other engine can be running these runs (D7).
  scheduler.recover();

  let initialized = false;
  let stopping: Promise<void> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  const notFound = (runId: string): never => {
    throw new RpcFailure(ErrorCode.RunNotFound, `There is no run ${runId} in this engine's store.`);
  };

  const server = new RpcServer({
    output,
    log,
    diagnose,
    mask,
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
        // In the background, on its own budget: the host's wait for `initialize` never covers it.
        recover();
        // Deliberately console.log: the launcher sends it to stderr, and the stdout purity test proves it (D2).
        console.log(`Nivra engine ${ENGINE_VERSION} ready for ${params.client.name} ${params.client.version}`);
        return info();
      },
      "secrets.update": (params) => {
        for (const [name, value] of Object.entries(params.set)) if (value) vault.set(name as SecretName, value);
        for (const name of params.remove) vault.remove(name);
        recover();
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
          const result = await runProviderCheck({
            apiKey: key,
            endpoint,
            ...(model ? { model } : {}),
            onDiagnostic: (facts) => diagnose({ ...facts, kind: "internal", method: "providers.check" }),
          });
          return {
            ...result,
            call: result.call ? { ...result.call, answer: mask(result.call.answer) } : null,
            problem: result.problem === null ? null : mask(result.problem),
          };
        } catch (error) {
          // Only listing the models throws: everything after it is reported in the result. Only Nivra's own words go
          // back, and the diagnostic says what happened (NIV-27).
          const known = publicFailure(error);
          throw new RpcFailure(ErrorCode.InternalError, known?.message ?? internalMessage(), { kind: known?.kind ?? "internal" }, { cause: error });
        }
      },
      "runs.start": (params) => {
        // One check of a project at a time (D36). The host refuses a second as well; a repeated request still gets its run.
        if (params.workflowId === "sandbox" && checkGoing(params.input.project, params.clientRequestId)) {
          throw new RpcFailure(ErrorCode.InvalidParams, "A sandbox check of this project is already going on its engine. Wait for it to end, or cancel it, then check again.");
        }
        try {
          return store.summary(scheduler.submit(params)) ?? notFound("just created");
        } catch (error) {
          // The same request id with other work: refused, in Nivra's words, and nothing is started (D30).
          if (error instanceof Refusal && error.code === "request-conflict") throw new RpcFailure(ErrorCode.InvalidParams, error.message);
          throw error;
        }
      },
      "runs.get": ({ runId }) => store.summary(runId) ?? notFound(runId),
      "runs.find": ({ clientRequestId }) => store.findByRequest(clientRequestId),
      "runs.list": ({ limit, cursor }) => store.list({ limit, cursor }),
      "runs.events": ({ runId, after, limit }) => store.events(runId, after, limit) ?? notFound(runId),
      "runs.cancel": ({ runId }) => scheduler.cancel(runId) ?? notFound(runId),
      "runs.result": ({ runId }) => {
        if (!store.status(runId)) notFound(runId);
        const stored = store.artifact(runId, "explain");
        return stored === null ? null : ExplainResult.parse(JSON.parse(stored));
      },
      "runs.reply": ({ runId }) => {
        if (!store.status(runId)) notFound(runId);
        const stored = store.artifact(runId, "chat");
        return stored === null ? null : ChatResult.parse(JSON.parse(stored));
      },
      "runs.review": ({ runId }) => {
        const status = store.status(runId);
        if (!status) notFound(runId);
        const stored = store.artifact(runId, "review");
        if (stored === null) return null;
        // A report saved mid-review, of a run that has ended, reads as interrupted (D30).
        const report = ReviewReport.parse(JSON.parse(stored));
        return status && isTerminal(status) ? asEnded(report) : report;
      },
      "runs.sandbox": ({ runId }) => {
        const status = store.status(runId);
        if (!status) notFound(runId);
        const stored = store.artifact(runId, "sandbox");
        if (stored === null) return null;
        // A report saved mid-check, of a run that has ended, reads as interrupted (D36).
        const report = SandboxReport.parse(JSON.parse(stored));
        return status && isTerminal(status) && report.outcome === "in-progress" ? { ...report, outcome: "interrupted" as const, finishedAt: report.updatedAt } : report;
      },
      "sandbox.preview": ({ repoPath }) => sandboxPreview(repoPath),
      "sandbox.status": () => {
        rescan();
        return sandboxStatus();
      },
      "sandbox.recover": () => {
        if (checksActive()) throw new RpcFailure(ErrorCode.InvalidParams, "A sandbox check is going on this engine. Let it end, then try again.");
        rescan();
        recover();
        return sandboxStatus();
      },
    },
  });

  const shutdown = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log(`Shutting down: ${reason}`);
      // A recovery pass, and a check's cleanup, stop now: what they leave stays journaled for the next start.
      engineStop.abort(new Error("The engine is shutting down."));
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
    const [, { LibSQLStore }] = await Promise.all([
      import("@mastra/core/mastra"),
      import("@mastra/libsql"),
      import("./workflows/hello.ts"),
      import("./workflows/explain.ts"),
      import("./workflows/chat.ts"),
      import("./workflows/review.ts"),
      import("./workflows/sandbox.ts"),
    ]);
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
