import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ChatInput,
  ChatResult,
  CoachReport,
  combinedMask,
  EnvironmentReport,
  projectFingerprint,
  ReviewReport,
  ErrorCode,
  ExplainInput,
  ExplainResult,
  HelloInput,
  isTerminal,
  LineSplitter,
  PROTOCOL_VERSION,
  ResearchReport,
  SandboxReport,
  TaskReport,
  type EngineFatal,
  type EngineInfo,
  type ChatContext,
  type CoachContext,
  type EnvironmentChoices,
  type EnvironmentPreview,
  type EnvironmentPreviewV2,
  type EnvironmentSpec,
  type PreviousSettlement,
  type JsonObject,
  type ResearchContext,
  type ReviewContext,
  type RunContext,
  type SandboxContext,
  type SandboxPreview,
  type SandboxStatus,
  type SecretName,
  type TaskContext,
  type TaskEnvironment,
  type TaskPreview,
  type WorkflowId,
} from "@nivra/domain";
import { installGitAdvice } from "./advice.ts";
import { ApplyRequestRefusal, ApplyService } from "./apply/service.ts";
import type { ApplyHook } from "./apply/writer.ts";
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
import { fetchTransport, SandboxApi, SANDBOXES_BASE_URL, type Transport } from "./exec/nebius/api.ts";
import { ENV_COMMAND_ENV, Journal } from "./exec/nebius/sandbox.ts";
import { createNebiusBackend, NEBIUS_LIMITS, reconcileJournals, scanJournals, type NebiusCredentials } from "./exec/nebius/session.ts";
import { takeSnapshot } from "./exec/snapshot.ts";
import { ChatUnreadable, readChatTask } from "./chat/task.ts";
import { asEnded as asEndedCoaching, coachUnreadable, readCoachTask } from "./coach/task.ts";
import { readTask, TaskUnreadable } from "./explain/task.ts";
import { asInterrupted, readResearchTask } from "./research/task.ts";
import { asEnded, readReviewTask, ReviewUnreadable } from "./review/task.ts";
import { launcherWrite, ProtocolOutput, type RawWrite } from "./rpc/output.ts";
import { RpcFailure, RpcServer } from "./rpc/server.ts";
import { TOKEN_FACTORY_BASE_URL } from "./providers/tokenfactory.ts";
import { useEngineTransport } from "./providers/transport.ts";
import { RunScheduler, type WorkflowEntry, type WorkflowSource } from "./runs/scheduler.ts";
import { RunStore } from "./runs/store.ts";
import { SecretVault, stripProviderEnv } from "./secrets/vault.ts";
import { EnvironmentRefusal, environmentInputs } from "./environment/inputs.ts";
import { environmentPreviewOf, environmentResolutionOf, PREPARE_LIMITS } from "./environment/preview.ts";
import { readEnvironmentInput } from "./environment/report.ts";
import { TASK_LIMITS } from "./task/limits.ts";
import { proposalView, readTaskInput, taskPreviewOf } from "./task/report.ts";
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
  [
    "task",
    {
      id: "task",
      title: (input: unknown) => `Task · ${basename(readTaskInput(input)?.repoPath ?? "") || "repository"}`,
      // Mastra gets nothing of a task run: the brief stays in memory (D21), and the checkout, the project, the target, the
      // preview and the brief's version and digest in the run store (D39).
      mastraInput: (input: unknown) => {
        if (!readTaskInput(input)) throw new Refusal("input-unreadable", "This run's request can't be read back from the engine's store, so it wasn't started. Run the task again.");
        return {};
      },
    },
  ],
  [
    "environment",
    {
      id: "environment",
      title: (input: unknown) => `Environment · ${basename(readEnvironmentInput(input)?.repoPath ?? "") || "repository"}`,
      // Mastra gets the checkout's path alone (D22): the project, the target and the preview stay in the run store, and
      // the spec in memory (D21, D41).
      mastraInput: (input: unknown) => {
        const task = readEnvironmentInput(input);
        if (!task) throw new Refusal("input-unreadable", "This preparation's request can't be read back from the engine's store, so it wasn't started. Prepare the environment again.");
        return { repoPath: task.repoPath };
      },
    },
  ],
  [
    "coach",
    {
      id: "coach",
      // The brief's version only: a task's title is the person's words, and stays out of the run's record (NIV-53).
      title: (input: unknown) => {
        const task = readCoachTask(input);
        return task ? `Coach · brief v${task.briefVersion}` : "Coach";
      },
      // Mastra gets nothing of a coaching: the task's ids, the brief version and the fingerprints stay in the run store,
      // and the packet in memory (D21, NIV-53).
      mastraInput: (input: unknown) => {
        if (!readCoachTask(input)) throw coachUnreadable();
        return {};
      },
    },
  ],
  [
    "research",
    {
      id: "research",
      title: (input: unknown) => {
        const task = readResearchTask(input);
        return task ? `Research · plan v${task.planVersion}` : "Research";
      },
      // Mastra gets nothing of a research run: the plan's id, version and fingerprint stay in the run store, and the
      // packet in memory (D21, D37).
      mastraInput: (input: unknown) => {
        if (!readResearchTask(input)) throw new Refusal("input-unreadable", "This research's plan and fingerprint can't be read back from the engine's store, so nothing was sent. Start the research again.");
        return {};
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
 * A test's hold on the apply writer (NIV-35): before the step its file names, the writer writes `<file>.held` and
 * waits forever, so the test stops the engine with the apply part way and sees it reconciled after a restart. The
 * engine answers everything else meanwhile. With no file, or another step named, it holds nothing.
 */
function applyHold(file: string): ApplyHook {
  return async (step) => {
    let wanted: string;
    try {
      wanted = readFileSync(file, "utf8").trim();
    } catch {
      return;
    }
    if (step !== wanted) return;
    writeFileSync(`${file}.held`, `${step}\n`, { mode: 0o600 });
    await new Promise<never>(() => undefined);
  };
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
    typeof import("./workflows/research.ts"),
    typeof import("./workflows/task.ts"),
    typeof import("./workflows/environment.ts"),
    typeof import("./workflows/coach.ts"),
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
      import("./workflows/research.ts"),
      import("./workflows/task.ts"),
      import("./workflows/environment.ts"),
      import("./workflows/coach.ts"),
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
    { createResearchWorkflow, RESEARCH_WORKFLOW_ID },
    { createTaskWorkflow, TASK_WORKFLOW_ID },
    { createEnvironmentWorkflow, ENVIRONMENT_WORKFLOW_ID },
    { createCoachWorkflow, COACH_WORKFLOW_ID },
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
  // Applying proposals to the person's checkout (D40). An apply an earlier engine left writing is reconciled here,
  // before any apply call is answered, writing nothing of the person's.
  const applies = new ApplyService({
    ...(options.applyHold ? { before: applyHold(options.applyHold) } : {}),
    database,
    proposal: (runId) => store.proposal(runId),
    verified: (runId) => {
      const stored = store.artifact(runId, "task");
      return stored !== null && TaskReport.parse(JSON.parse(stored)).verified;
    },
    homeId,
    backend,
    findGit: locateGit,
    platform: process.platform,
  });
  /** A request the apply service refused before claiming anything, in Nivra's words. */
  const applyCall = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApplyRequestRefusal) throw new RpcFailure(ErrorCode.InvalidParams, error.message);
      throw error;
    }
  };
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

  // Each workflow reads only the context its own kind of run carries (D21, D26), chosen by the run's workflow and
  // never by the context's shape. A sandbox check's holds no preferences: its consent is for uploads, never for a
  // model (D36).
  const runContext = (runId: string): RunContext | null => scheduler.contextOf(runId, "explain") ?? scheduler.contextOf(runId, "hello");
  const sandboxContext = (runId: string): SandboxContext | null => scheduler.contextOf(runId, "sandbox");
  const reviewContext = (runId: string): ReviewContext | null => scheduler.contextOf(runId, "review");
  const chatContext = (runId: string): ChatContext | null => scheduler.contextOf(runId, "chat");
  const researchContext = (runId: string): ResearchContext | null => scheduler.contextOf(runId, "research");
  const taskContext = (runId: string): TaskContext | null => scheduler.contextOf(runId, "task");
  const coachContext = (runId: string): CoachContext | null => scheduler.contextOf(runId, "coach");
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
  // A task run's backend (D39): its operations limited to what its brief needs, its commands to the longest it runs.
  // Bound to a prepared environment (D41), its sessions start from that image, every command with the image's path.
  const taskBackend = (operations: number, environment: TaskEnvironment | null) =>
    createNebiusBackend({
      credentials: sandboxCredentials,
      baseImage: environment?.image ?? CHECK_IMAGE.uuid,
      ...(environment ? { env: ENV_COMMAND_ENV } : {}),
      journalDir: journals,
      limits: { ...NEBIUS_LIMITS, maxOperations: operations, maxTimeoutSeconds: TASK_LIMITS.checks.timeoutMs / 1000, prepareTimeoutSeconds: TASK_LIMITS.prepareTimeoutSeconds, sessionBudgetMs: TASK_LIMITS.sessionMs, cleanupBudgetMs: TASK_LIMITS.closeMs },
      transport: sandboxTransport,
    });
  // A task's commit and changes are refused if they hold a key the vault keeps; the project id names the account, as
  // for a check (D36). Its proposal, kept unmasked, is refused if it holds any value the vault keeps (D39).
  const taskKnownValues = () => (["NEBIUS_API_KEY", "TAVILY_API_KEY"] as const).flatMap((name) => vault.get(name) ?? []);
  // Stops the engine's background work, and a check's cleanup, when the engine shuts down (D4).
  const engineStop = new AbortController();

  // What an earlier engine left open (D33): read at start with no network, then settled by one bounded pass once the
  // credentials arrive. Nothing is replayed. The list is read again only while no check is going, so it never holds
  // the journal of a session this engine has open; a journal a pass settles leaves it at once.
  let scanned = scanJournals(journals);
  const pass: SandboxStatus["pass"] = { state: scanned.open.length ? "waiting-for-credentials" : "idle", startedAt: null, finishedAt: null, stopped: 0, alreadyEnded: 0, unresolved: [] };
  /** Whether a run that can hold Nebius operations is queued or running here: a check, a task (D39), or a preparation (D41). */
  const sessionsActive = () =>
    store.active().some((runId) => {
      const workflowId = store.summary(runId)?.workflowId;
      return workflowId === "sandbox" || workflowId === "task" || workflowId === "environment";
    });
  /** Whether a preparation of this project is queued or running here: one at a time (D41). */
  const environmentGoing = (project: string) =>
    store.active().some((runId) => {
      const summary = store.summary(runId);
      return summary?.workflowId === "environment" && readEnvironmentInput(summary.input)?.project === project;
    });
  /** Whether a task is queued or running here: one at a time on an engine (D39). */
  const taskGoing = () => store.active().some((runId) => store.summary(runId)?.workflowId === "task");
  /** Whether a check of this project is queued or running here (D36). */
  const checkGoing = (project: string) =>
    store.active().some((runId) => {
      const summary = store.summary(runId);
      return summary?.workflowId === "sandbox" && readSandboxTask(summary.input)?.project === project;
    });
  const rescan = () => {
    if (!sessionsActive()) scanned = scanJournals(journals);
    // With nothing left open, there is nothing to wait for the credentials for.
    if (scanned.open.length === 0 && pass.state === "waiting-for-credentials") pass.state = "idle";
  };
  const recover = (): void => {
    // A journal moved aside since the list was read, by hand or by a pass that then failed, has nothing to settle.
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

  /**
   * Why a prepared environment can't be used with this commit and these credentials, in Nivra's words; null when it
   * can (D41). The credentials are checked only when they are set: a run checks them again as it starts.
   */
  const environmentProblem = async (snapshot: Parameters<typeof environmentInputs>[0], environment: TaskEnvironment): Promise<string | null> => {
    let digest: string;
    try {
      digest = environmentInputs(snapshot).digest;
    } catch (error) {
      if (error instanceof EnvironmentRefusal) return `This commit's manifests can't be prepared from any more: ${error.message}`;
      throw error;
    }
    if (digest !== environment.inputsDigest) return "This commit's manifests, lockfile or workspace file aren't the ones the project's environment was prepared from. Prepare the environment again, then preview the run.";
    const credentials = sandboxCredentials();
    if (credentials && (await projectFingerprint(credentials.project)) !== environment.projectFingerprint) {
      return "The project's environment was prepared in another Nebius project than the one in Settings, and an image can only be used in its own project. Prepare the environment again, then preview the run.";
    }
    return null;
  };
  /** What a task run of this checkout would send to Nebius, with no network, and the bounds of a run of this brief. */
  const taskPreview = async (repoPath: string, brief: Pick<TaskContext["brief"], "acceptanceCases" | "checks" | "baseline" | "frozen">, environment: (TaskEnvironment & { preparedAt: string }) | undefined): Promise<TaskPreview> => {
    const git = locateGit();
    if (!git) throw new RpcFailure(ErrorCode.InvalidParams, `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(process.platform)}`);
    const session = await backend.open({ workspace: repoPath });
    try {
      const snapshot = await takeSnapshot({ folder: repoPath, session, git, exclude: [home], knownValues: taskKnownValues() });
      if (environment) {
        const problem = await environmentProblem(snapshot, environment);
        if (problem) return { status: "refused", code: "environment", message: problem };
      }
      return taskPreviewOf(snapshot, brief, environment ?? null);
    } catch (error) {
      // It names the file it is about: a preview is shown to the person, and never stored (D36).
      if (error instanceof WorkspaceRefusal) return { status: "refused", code: error.code, message: mask(error.message).slice(0, 2_000) };
      throw error;
    } finally {
      await session.close();
    }
  };

  /** A project's own setup resolved into a recipe, with no network (NIV-55); a refusal names the file and says why. */
  const environmentResolve = async (repoPath: string, choices: EnvironmentChoices, previous: PreviousSettlement | null): Promise<EnvironmentPreviewV2> => {
    const git = locateGit();
    if (!git) throw new RpcFailure(ErrorCode.InvalidParams, `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(process.platform)}`);
    const session = await backend.open({ workspace: repoPath });
    try {
      const shown = await environmentResolutionOf(await takeSnapshot({ folder: repoPath, session, git, exclude: [home], knownValues: taskKnownValues() }), choices, previous);
      return shown.status === "refused" ? { ...shown, message: mask(shown.message).slice(0, 2_000) } : shown;
    } catch (error) {
      if (error instanceof WorkspaceRefusal) return { status: "refused", code: error.code, message: mask(error.message).slice(0, 2_000), rows: [] };
      throw error;
    } finally {
      await session.close();
    }
  };

  /** What preparing this checkout's environment would send and run, with no network (D41); a layout it can't prepare says why. */
  const environmentPreview = async (repoPath: string, spec: EnvironmentSpec): Promise<EnvironmentPreview> => {
    const git = locateGit();
    if (!git) throw new RpcFailure(ErrorCode.InvalidParams, `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(process.platform)}`);
    const session = await backend.open({ workspace: repoPath });
    try {
      return environmentPreviewOf(await takeSnapshot({ folder: repoPath, session, git, exclude: [home], knownValues: taskKnownValues() }), spec);
    } catch (error) {
      // Both name the file they are about: a preview is shown to the person, and never stored.
      if (error instanceof WorkspaceRefusal) return { status: "refused", code: error.code, message: mask(error.message).slice(0, 2_000) };
      if (error instanceof EnvironmentRefusal) return { status: "refused", code: error.code, message: mask(error.message).slice(0, 2_000) };
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
      [COACH_WORKFLOW_ID]: createCoachWorkflow({
        recorder,
        context: coachContext,
        task: (runId) => readCoachTask(store.summary(runId)?.input),
        requestId: (runId) => store.requestIdOf(runId),
        apiKey: () => vault.get("NEBIUS_API_KEY"),
        endpoint,
        mask,
        setMeta: (runId, meta) => store.setMeta(runId, meta),
        saveResult: (runId, report) => store.saveArtifact(runId, "coach", JSON.stringify(report)),
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
      [ENVIRONMENT_WORKFLOW_ID]: createEnvironmentWorkflow({
        recorder,
        context: (runId) => scheduler.contextOf(runId, "environment"),
        task: (runId) => readEnvironmentInput(store.summary(runId)?.input),
        requestId: (runId) => store.requestIdOf(runId),
        credentials: sandboxCredentials,
        client: (given, signal) => new SandboxApi(sandboxTransport(given), { requestTimeoutMs: NEBIUS_LIMITS.requestTimeoutMs, minWriteMs: NEBIUS_LIMITS.minWriteMs, signal }),
        journalPath: (runId) => {
          mkdirSync(journals, { recursive: true, mode: 0o700 });
          return join(journals, `environment-${runId}.jsonl`);
        },
        settle: (path, given) => {
          const open = new Journal(path).open();
          return reconcileJournals([{ path, operations: open.operations, uncertain: open.uncertain, damaged: null }], { credentials: given, budgetMs: PREPARE_LIMITS.closeMs, signal: engineStop.signal, transport: sandboxTransport, limits: sandboxLimits });
        },
        local: backend,
        findGit: locateGit,
        platform: process.platform,
        exclude: [home],
        knownValues: taskKnownValues,
        shutdown: engineStop.signal,
        mask,
        saveResult: (runId, report) => store.saveArtifact(runId, "environment", JSON.stringify(report)),
      }),
      [RESEARCH_WORKFLOW_ID]: createResearchWorkflow({
        recorder,
        context: researchContext,
        task: (runId) => readResearchTask(store.summary(runId)?.input),
        requestId: (runId) => store.requestIdOf(runId),
        modelKey: () => vault.get("NEBIUS_API_KEY"),
        tavilyKey: () => vault.get("TAVILY_API_KEY"),
        endpoint,
        mask,
        // A query that holds any value the vault keeps is refused before it leaves (D37): the keys and the project id.
        knownValues: () => vault.values(),
        setMeta: (runId, meta) => store.setMeta(runId, meta),
        saveResult: (runId, report) => store.saveArtifact(runId, "research", JSON.stringify(report)),
        // Tavily, or a stub on this machine when the loopback-only argument names one (D37).
        ...(options.tavilyUrl ? { tavilyUrl: options.tavilyUrl } : {}),
      }),
      [TASK_WORKFLOW_ID]: createTaskWorkflow({
        recorder,
        context: taskContext,
        task: (runId) => readTaskInput(store.summary(runId)?.input),
        requestId: (runId) => store.requestIdOf(runId),
        homeId,
        credentials: sandboxCredentials,
        sandbox: taskBackend,
        local: backend,
        findGit: locateGit,
        platform: process.platform,
        exclude: [home],
        knownValues: taskKnownValues,
        vaultValues: () => vault.values(),
        shutdown: engineStop.signal,
        endpoint,
        mask,
        setMeta: (runId, meta) => store.setMeta(runId, meta),
        saveReport: (runId, report) => store.saveArtifact(runId, "task", JSON.stringify(report)),
        saveProposal: (runId, proposal) => store.saveProposal(runId, proposal),
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
        // One check of a project at a time (D36), for a new request: a repeated one still gets its own run, ended or not.
        // The host refuses a second check as well.
        if (params.workflowId === "sandbox" && store.findByRequest(params.clientRequestId) === null && checkGoing(params.input.project)) {
          throw new RpcFailure(ErrorCode.InvalidParams, "A sandbox check of this project is already going on its engine, so another wasn't started. Wait for it to end, then check again.");
        }
        // A task never runs on Windows itself in this version, and one task runs at a time on an engine (D39), for a new
        // request: a repeated one still gets the run it started. The host refuses both as well.
        if (params.workflowId === "task" && store.findByRequest(params.clientRequestId) === null) {
          if (process.platform === "win32") throw new RpcFailure(ErrorCode.InvalidParams, "Running tasks on Windows itself isn't available yet, so nothing was started. Add the repository from a WSL distribution, then run the task there.");
          if (taskGoing()) throw new RpcFailure(ErrorCode.InvalidParams, "A task is already running on this engine, so another wasn't started. Wait for it to end, or cancel it, then run this one again.");
        }
        // One preparation of a project at a time, and none on Windows itself (D41), for a new request.
        if (params.workflowId === "environment" && store.findByRequest(params.clientRequestId) === null) {
          if (process.platform === "win32") throw new RpcFailure(ErrorCode.InvalidParams, "Preparing an environment on Windows itself isn't available yet, so nothing was started. Add the repository from a WSL distribution, then prepare it there.");
          if (environmentGoing(params.input.project)) throw new RpcFailure(ErrorCode.InvalidParams, "This project's environment is already being prepared on its engine, so another preparation wasn't started. Wait for it to end, then try again.");
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
      "runs.research": ({ runId }) => {
        const status = store.status(runId);
        if (!status) notFound(runId);
        const stored = store.artifact(runId, "research");
        if (stored === null) return null;
        // A report saved mid-run, of a run that has ended, reads as interrupted: what it was sending may have gone
        // out (D37).
        const report = ResearchReport.parse(JSON.parse(stored));
        return status && isTerminal(status) ? asInterrupted(report) : report;
      },
      "runs.task": ({ runId }) => {
        const status = store.status(runId);
        if (!status) notFound(runId);
        const stored = store.artifact(runId, "task");
        if (stored === null) return null;
        // A report saved mid-run, of a run that has ended, reads as interrupted (D39).
        const report = TaskReport.parse(JSON.parse(stored));
        return status && isTerminal(status) && report.outcome === "in-progress" ? { ...report, outcome: "interrupted" as const, finishedAt: report.updatedAt } : report;
      },
      "runs.proposal": ({ runId }) => {
        if (!store.status(runId)) notFound(runId);
        const proposal = store.proposal(runId);
        return proposal === null ? null : proposalView(proposal, mask);
      },
      "task.preview": ({ repoPath, brief, environment }) => taskPreview(repoPath, brief, environment),
      "environment.preview": ({ repoPath, spec }) => environmentPreview(repoPath, spec),
      "environment.resolve": ({ repoPath, choices, previous }) => environmentResolve(repoPath, choices, previous),
      "runs.coach": ({ runId }) => {
        const status = store.status(runId);
        if (!status) notFound(runId);
        const stored = store.artifact(runId, "coach");
        if (stored === null) return null;
        // A report saved mid-coaching, of a run that has ended, reads as interrupted (NIV-53).
        const report = CoachReport.parse(JSON.parse(stored));
        return status && isTerminal(status) ? asEndedCoaching(report) : report;
      },
      "runs.environment": ({ runId }) => {
        const status = store.status(runId);
        if (!status) notFound(runId);
        const stored = store.artifact(runId, "environment");
        if (stored === null) return null;
        // A report saved mid-preparation, of a run that has ended, reads as interrupted (D41).
        const report = EnvironmentReport.parse(JSON.parse(stored));
        return status && isTerminal(status) && report.outcome === "in-progress" ? { ...report, outcome: "interrupted" as const, finishedAt: report.updatedAt } : report;
      },
      "sandbox.preview": ({ repoPath }) => sandboxPreview(repoPath),
      "sandbox.status": () => {
        rescan();
        return sandboxStatus();
      },
      "task.apply": (params) => applyCall(() => applies.apply(params)),
      "task.applyStatus": ({ requestId }) => applies.status(requestId),
      "task.restore": ({ applyId }) => applyCall(() => applies.restore(applyId)),
      "task.dismiss": ({ applyId, as }) => applyCall(() => applies.dismiss(applyId, as)),
      "sandbox.recover": () => {
        if (sessionsActive()) throw new RpcFailure(ErrorCode.InvalidParams, "A sandbox check or a task is going on this engine. Let it end, then try again.");
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
      import("./workflows/research.ts"),
      import("./workflows/task.ts"),
      import("./workflows/environment.ts"),
      import("./workflows/coach.ts"),
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
  // Before any request: fetch waits as long as a model's whole answer can take (NIV-35).
  useEngineTransport(args.fetchWaitMs);

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
