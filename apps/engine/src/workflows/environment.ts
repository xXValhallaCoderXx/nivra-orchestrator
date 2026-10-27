import { createStep, createWorkflow } from "@mastra/core/workflows";
import { projectFingerprint, type EnvironmentContext, type EnvironmentReport, type EnvironmentStopCode, type Mask, type SandboxCleanup, type StoredEnvironmentInput } from "@nivra/domain";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { installGitAdvice } from "../advice.ts";
import { Refusal } from "../diagnostics.ts";
import type { ExecutionBackend } from "../exec/backend.ts";
import { safeUnresolved } from "../exec/check.ts";
import { WorkspaceRefusal } from "../exec/git-tool.ts";
import type { SandboxApi } from "../exec/nebius/api.ts";
import { Journal, Sandbox } from "../exec/nebius/sandbox.ts";
import { retainedIn, settleJournal, type NebiusCredentials, type RecoveryResult } from "../exec/nebius/session.ts";
import { takeSnapshot } from "../exec/snapshot.ts";
import { EnvironmentRefusal, environmentInputs, inputsArchive } from "../environment/inputs.ts";
import { prepareIn } from "../environment/prepare.ts";
import { environmentPreviewOf, PREPARE_LIMITS } from "../environment/preview.ts";
import { earlyEnvironmentReport, ENVIRONMENT_STOP_MESSAGES } from "../environment/report.ts";
import { RepoError } from "../repo/paths.ts";
import type { ExplainRecorder } from "./explain.ts";
import { guard } from "./guard.ts";

export const ENVIRONMENT_WORKFLOW_ID = "environment";

/**
 * An environment's preparation (NIV-49, D41), on the production adapter. It runs no model and nothing the renderer
 * chose: the steps are the engine's own (`prepareIn`), on the commit's manifests as the preview showed them. Its
 * upload consent arrives with the run, held in memory (D21), and is checked again before anything is sent. The key and
 * project id come from the vault (D8), never from the run's input, events or journals. The import and the preparation
 * are journaled in the engine's home, so a recovery pass settles what an interrupted one left open.
 */
export interface EnvironmentDeps {
  recorder: Pick<ExplainRecorder, "output">;
  context: (runId: string) => EnvironmentContext | null;
  task: (runId: string) => StoredEnvironmentInput | null;
  requestId: (runId: string) => string | null;
  credentials: () => NebiusCredentials | null;
  /** A client for these credentials, its requests cut off by `signal`. */
  client: (credentials: NebiusCredentials, signal: AbortSignal) => SandboxApi;
  /** Where this run's import and preparation are journaled: a file among the engine's journals. */
  journalPath: (runId: string) => string;
  /** Settles what a journal left open, on cleanup's own budget, with the bounded pass recovery runs. */
  settle: (path: string, credentials: NebiusCredentials) => Promise<RecoveryResult[]>;
  /** The engine's own `Local` backend, for its git on the checkout. */
  local: ExecutionBackend;
  findGit: () => string | null;
  platform: NodeJS.Platform;
  /** Folders never sent: the engine's home. */
  exclude: readonly string[];
  knownValues: () => string[];
  /** The engine shutting down (D4): it stops cleanup too, and what that leaves stays journaled. */
  shutdown: AbortSignal;
  mask: Mask;
  saveResult: (runId: string, report: EnvironmentReport) => void;
  now?: () => Date;
}

const Input = z.strictObject({ repoPath: z.string() });
const Done = z.strictObject({ outcome: z.literal("prepared") });

/** A journal's entries wherever it is now: settling moves one with nothing left open into `settled/` beside it. */
function entriesAt(path: string) {
  const settled = join(dirname(path), "settled", basename(path));
  return new Journal(existsSync(path) || !existsSync(settled) ? path : settled).entries;
}

/** Ends a preparation that won't go on, in its code's words; the report says the same. */
const stop = (code: EnvironmentStopCode) => new Refusal(`environment-${code}`, ENVIRONMENT_STOP_MESSAGES[code]);

/** How a preparation that stopped ended: refused before anything was sent, cancelled, uncertain, or failed. */
const outcomeOf = (code: EnvironmentStopCode): EnvironmentReport["outcome"] =>
  code === "cancelled" ? "cancelled" : code === "uncertain" ? "uncertain" : ["consent", "credentials", "native-windows", "preview", "layout", "git"].includes(code) ? "refused" : "failed";

export function createEnvironmentWorkflow(deps: EnvironmentDeps) {
  const now = deps.now ?? (() => new Date());
  const requestOf = (runId: string) => ({ runId, clientRequestId: deps.requestId(runId) ?? runId });
  const early = (runId: string, outcome: EnvironmentReport["outcome"], code: EnvironmentStopCode | null, step: string | null, finished: boolean) =>
    deps.saveResult(runId, earlyEnvironmentReport({ outcome, code, step, request: requestOf(runId), now: now(), finished }));

  /** Upload consent, the credentials, this platform and a readable request: all checked before anything is sent. */
  const allowed = (runId: string, step: string): { task: StoredEnvironmentInput; context: EnvironmentContext; credentials: NebiusCredentials } => {
    const task = deps.task(runId);
    if (!task) throw new Refusal("input-unreadable", "This preparation's request can't be read back from the engine's store, so it wasn't started. Prepare the environment again.");
    const context = deps.context(runId);
    if (!context) throw new Refusal("context-missing", "This preparation's context is missing, so it wasn't started. Prepare the environment again.");
    const refuse = (code: EnvironmentStopCode) => {
      early(runId, "refused", code, step, true);
      return stop(code);
    };
    if (deps.platform === "win32") throw refuse("native-windows");
    if (!context.sharing.cloudExecution) throw refuse("consent");
    const credentials = deps.credentials();
    if (!credentials) throw refuse("credentials");
    return { task, context, credentials };
  };

  const check = createStep({
    id: "check",
    description: "Check upload consent, the key and project id, this platform and the request, before anything is sent",
    inputSchema: Input,
    outputSchema: Input,
    execute: async ({ inputData, runId }) =>
      guard("environment.check", deps.mask, async () => {
        const { task, context } = allowed(runId, "check");
        deps.recorder.output(runId, "check", "Upload allowed for this project; the key and project id are set.", { target: task.target, preview: task.preview, filters: context.spec.filters.length });
        early(runId, "in-progress", null, null, false);
        return { repoPath: inputData.repoPath };
      }),
  });

  const run = createStep({
    id: "run",
    description: "Read the commit's manifests, import the pinned image if needed, prepare it with networking on, and report",
    inputSchema: Input,
    outputSchema: Done,
    execute: async ({ runId, abortSignal }) =>
      guard("environment.run", deps.mask, async () => {
        // Checked again here: the key and project id can be removed between the steps.
        const { task, context, credentials } = allowed(runId, "run");
        let reported = false;
        const report = (value: EnvironmentReport) => {
          deps.saveResult(runId, value);
          reported = true;
        };
        try {
          const git = deps.findGit();
          if (!git) throw new RepoError("git-missing", `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(deps.platform)}`);
          // The commit as the preview showed it: anything different is refused before anything is sent.
          const local = await deps.local.open({ workspace: task.repoPath });
          let shown;
          let snapshot;
          try {
            snapshot = await takeSnapshot({ folder: task.repoPath, session: local, git, exclude: deps.exclude, knownValues: deps.knownValues(), signal: abortSignal });
            shown = environmentPreviewOf(snapshot, context.spec);
          } catch (error) {
            const code: EnvironmentStopCode = error instanceof EnvironmentRefusal ? "layout" : error instanceof WorkspaceRefusal ? (error.code === "git" || error.code === "git-version" ? "git" : "preview") : abortSignal.aborted ? "cancelled" : "fault";
            report(earlyEnvironmentReport({ outcome: outcomeOf(code), code, step: "preview", request: requestOf(runId), now: now(), finished: true }));
            throw stop(code);
          } finally {
            await local.close();
          }
          if (shown.fingerprint !== task.preview) {
            report(earlyEnvironmentReport({ outcome: "refused", code: "preview", step: "preview", request: requestOf(runId), now: now(), finished: true }));
            throw stop("preview");
          }
          const inputs = environmentInputs(snapshot);
          deps.recorder.output(runId, "run", `${inputs.files.length} inputs, ${shown.sentBytes} bytes to send; ${inputs.packageManager}; networking on for the preparation only.`, { inputs: inputs.files.length, sentBytes: shown.sentBytes });

          // The import and the preparation, journaled, on one deadline; cleanup has its own.
          const path = deps.journalPath(runId);
          const journal = new Journal(path);
          const deadline = performance.now() + (PREPARE_LIMITS.importSeconds + PREPARE_LIMITS.prepareSeconds) * 1000 + 6 * 60_000;
          const api = deps.client(credentials, abortSignal);
          const sandbox = new Sandbox(api, { journal, signal: abortSignal, pollMs: PREPARE_LIMITS.pollMs, cap: () => deadline, maxTimeoutSeconds: Math.max(PREPARE_LIMITS.importSeconds, PREPARE_LIMITS.prepareSeconds) });
          const outcome = await prepareIn({
            api,
            sandbox,
            journal,
            archive: inputsArchive(inputs.files),
            packageManager: inputs.packageManager,
            installArgs: shown.installArgs,
            limits: { importSeconds: PREPARE_LIMITS.importSeconds, prepareSeconds: PREPARE_LIMITS.prepareSeconds },
            until: () => deadline,
            signal: abortSignal,
            progress: (message) => deps.recorder.output(runId, "run", message, {}),
          });

          // What the import or the preparation left open, settled by the bounded pass recovery runs.
          const open = journal.open();
          let cleanup: SandboxCleanup;
          if (open.operations.length || open.uncertain.length) {
            const passes = await deps.settle(path, credentials).catch(() => [] as RecoveryResult[]);
            const unresolved = passes.length ? passes.flatMap((pass) => pass.unresolved) : ["Something Nivra started in a sandbox couldn't be settled, and may still be running. It stays journaled, for the next recovery pass."];
            cleanup = { stopped: passes.reduce((sum, pass) => sum + pass.stopped.length, 0), alreadyEnded: passes.reduce((sum, pass) => sum + pass.alreadyEnded.length, 0), unresolved: unresolved.slice(0, 50).map((item) => deps.mask(safeUnresolved(item)).slice(0, 400)), retained: retainedIn(entriesAt(path)) };
          } else {
            cleanup = { stopped: 0, alreadyEnded: 0, unresolved: [], retained: retainedIn(entriesAt(path)) };
            // A preparation stopped before anything was journaled leaves no journal to move.
            if (existsSync(path)) settleJournal(path);
          }

          const finished = now().toISOString();
          const install = outcome.install && { exitCode: outcome.install.exitCode, logTail: deps.mask(outcome.install.logTail).slice(-8_000) };
          const steps = outcome.steps.map((step) => ({ ...step, stdoutTail: deps.mask(step.stdoutTail).slice(-2_000), stderrTail: deps.mask(step.stderrTail).slice(-2_000) }));
          if (!outcome.prepared) {
            const code = outcome.stopped?.code ?? "fault";
            report({ outcome: outcomeOf(code), stopped: { code, step: outcome.stopped?.step ?? null, message: ENVIRONMENT_STOP_MESSAGES[code] }, prepared: null, install, steps, cleanup, request: requestOf(runId), updatedAt: finished, finishedAt: finished });
            deps.recorder.output(runId, "run", `Preparation ${outcomeOf(code)}.`, { code });
            throw stop(code);
          }
          report({
            outcome: "prepared",
            stopped: null,
            prepared: {
              ...outcome.prepared,
              baseline: snapshot.baseline,
              inputsDigest: inputs.digest,
              spec: context.spec,
              installArgs: shown.installArgs,
              projectFingerprint: await projectFingerprint(credentials.project),
              preparedAt: finished,
            },
            install,
            steps,
            cleanup,
            request: requestOf(runId),
            updatedAt: finished,
            finishedAt: finished,
          });
          deps.recorder.output(runId, "run", `Prepared: Node ${outcome.prepared.node}, pnpm ${outcome.prepared.pnpm}, ${outcome.prepared.arch}.`, { node: outcome.prepared.node, pnpm: outcome.prepared.pnpm, arch: outcome.prepared.arch });
          return { outcome: "prepared" as const };
        } catch (error) {
          // A report that can't be saved after this leaves the fault's words, which claim nothing about what was sent.
          if (!reported) {
            const cancelled = abortSignal.aborted;
            early(runId, cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : error instanceof RepoError ? "git" : "fault", "run", true);
          }
          throw error;
        }
      }),
  });

  return createWorkflow({
    id: ENVIRONMENT_WORKFLOW_ID,
    description: "Prepares a project's Node environment in a Nebius sandbox: its manifests only, the pinned image, the frozen install with networking on, kept as an image",
    inputSchema: Input,
    outputSchema: Done,
    // Recovery belongs to the run scheduler and the journals: a preparation interrupted by a restart is never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(check)
    .then(run)
    .commit();
}
