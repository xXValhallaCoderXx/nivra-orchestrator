import { createStep, createWorkflow } from "@mastra/core/workflows";
import { choicesDigest, preferencesDigest, isEnvironmentRef, projectFingerprint, TASK_MODEL, TaskOutcome, taskBriefDigest, type EnvironmentRef, type Mask, type RunRoute, type RunUsage, type StoredTaskInput, type TaskContext, type TaskEnvironment, type TaskReport, type TaskStopCode } from "@nivra/domain";
import { z } from "zod";
import { installGitAdvice } from "../advice.ts";
import { Refusal } from "../diagnostics.ts";
import type { ExecutionBackend } from "../exec/backend.ts";
import type { Proposal } from "../exec/proposal.ts";
import { createModelClient, failure, ModelFailure, type Endpoint, type ModelClient } from "../providers/model.ts";
import { policyFor } from "../providers/policy.ts";
import { RepoError } from "../repo/paths.ts";
import { runLimitsFor, TASK_LIMITS } from "../task/limits.ts";
import { earlyTaskReport, holdsValue, taskReport, taskStopWords, type TaskBound } from "../task/report.ts";
import { operationsForBrief, runWorker } from "../task/worker.ts";
import type { ExplainRecorder } from "./explain.ts";
import { guard } from "./guard.ts";

export const TASK_WORKFLOW_ID = "task";

/**
 * A task run (NIV-7, D39), on the production adapter: one worker, through `ModelClient`, on a copy of one commit in a
 * Nebius sandbox with networking off, through the prescribed path. Both consents arrive with the run, held in memory
 * with the brief (D21), and are read again before anything is sent; withdrawing either cancels the run. The key and
 * project id come from the vault (D8), never from the run's input, events or journals. Mastra gets nothing of a task
 * run: the brief stays in memory, the input in the run store, and the report and the proposal are the store's.
 */
export interface TaskDeps {
  recorder: ExplainRecorder;
  context: (runId: string) => TaskContext | null;
  task: (runId: string) => StoredTaskInput | null;
  requestId: (runId: string) => string | null;
  /** The store's own id (D26): a proposal is bound to the engine home that keeps it. */
  homeId: string;
  /** The Nebius key and project id, read from the vault as the run starts; null unless both are set. The key is Token Factory's too. */
  credentials: () => { key: string; project: string } | null;
  /**
   * A Nebius backend for one run, its operations limited to `operations`, its journals in the engine's home; its
   * sessions start from the prepared environment's image when the run is bound to one (D41).
   */
  sandbox: (operations: number, environment: TaskEnvironment | EnvironmentRef | null) => ExecutionBackend;
  /** The engine's own `Local` backend, for its git on the checkout. */
  local: ExecutionBackend;
  findGit: () => string | null;
  platform: NodeJS.Platform;
  /** Folders never sent: the engine's home. */
  exclude: readonly string[];
  /** The vault's keys: a commit holding one is refused, and so is a change or a write that adds one. */
  knownValues: () => string[];
  /** Every value the vault keeps: a proposal holding one isn't kept, since its bytes are never masked. */
  vaultValues: () => readonly string[];
  /** The engine shutting down (D4): it stops a run's cleanup too, and what that leaves stays journaled. */
  shutdown: AbortSignal;
  endpoint: Endpoint;
  mask: Mask;
  setMeta: (runId: string, meta: { usage?: RunUsage; route?: RunRoute }) => void;
  saveReport: (runId: string, report: TaskReport) => void;
  saveProposal: (runId: string, proposal: Proposal) => void;
  now?: () => Date;
  /** Tests only, in process: a client over a mock model. */
  modelClient?: (apiKey: string, endpoint: Endpoint) => ModelClient;
}

const Input = z.strictObject({});
const Prepared = z.strictObject({ model: z.string(), contextLength: z.number().nullable() });
const Done = z.strictObject({ outcome: TaskOutcome });

/** Ends a run that won't go on, in its code's words for where it stopped; the report says the same. */
const stop = (code: TaskStopCode, step: string | null) => new Refusal(`task-${code}`, taskStopWords(code, step));

export function createTaskWorkflow(deps: TaskDeps) {
  const now = deps.now ?? (() => new Date());
  const clientFor = (key: string) => (deps.modelClient ? deps.modelClient(key, deps.endpoint) : createModelClient({ apiKey: key, endpoint: deps.endpoint }));
  /** Each run's start, on the monotonic clock: its one deadline counts from here, its checks included (D39). */
  const startedAt = new Map<string, number>();
  const routes = new Map<string, RunRoute>();
  const requestOf = (runId: string) => ({ runId, clientRequestId: deps.requestId(runId) ?? runId });
  const boundOf = (runId: string, task: StoredTaskInput): TaskBound => ({ taskId: task.taskId, attemptId: requestOf(runId).clientRequestId, briefVersion: task.briefVersion, briefDigest: task.briefDigest });
  /** The bounds a run of its brief runs under, as its preview showed them; null when its context is gone. */
  const limitsOf = (runId: string) => {
    const brief = deps.context(runId)?.brief;
    return brief ? runLimitsFor(brief.acceptanceCases.length + brief.checks.length, brief.baseline?.length ?? 0, brief.checks.length) : null;
  };
  const early = (runId: string, task: StoredTaskInput, outcome: TaskReport["outcome"], code: TaskStopCode | null, step: string | null, finished: boolean) =>
    deps.saveReport(runId, earlyTaskReport({ outcome, code, step, task: boundOf(runId, task), request: requestOf(runId), route: routes.get(runId) ?? null, limits: limitsOf(runId), now: now(), finished }));
  const forget = (runId: string) => {
    startedAt.delete(runId);
    routes.delete(runId);
  };

  const taskOf = (runId: string): StoredTaskInput => {
    const task = deps.task(runId);
    if (!task) throw new Refusal("input-unreadable", "This run's request can't be read back from the engine's store, so it wasn't started. Run the task again.");
    return task;
  };
  /**
   * Both consents, the key and project id, this platform and the brief: all checked before anything is sent anywhere.
   * Consent can't change once the run is accepted, since its context is fixed then: withdrawing it cancels the run.
   */
  const allowed = async (runId: string, step: string): Promise<{ task: StoredTaskInput; context: TaskContext; credentials: { key: string; project: string } }> => {
    const task = taskOf(runId);
    const context = deps.context(runId);
    if (!context) {
      early(runId, task, "failed", "fault", step, true);
      throw new Refusal("context-missing", "This run's context is missing, so it wasn't started. Run the task again.");
    }
    const refuse = (code: TaskStopCode) => {
      early(runId, task, "refused", code, step, true);
      return stop(code, step);
    };
    if (deps.platform === "win32") throw refuse("native-windows");
    if (!context.sharing.modelContext) throw refuse("model-sharing");
    if (!context.sharing.cloudExecution) throw refuse("consent");
    const credentials = deps.credentials();
    if (!credentials) throw refuse("credentials");
    if ((await taskBriefDigest(context.brief)) !== task.briefDigest) throw refuse("brief");
    if (!task.preferencesDigest || !task.choicesDigest || await preferencesDigest(context.preferences.records) !== task.preferencesDigest || await choicesDigest(context.choices) !== task.choicesDigest) {
      throw new Refusal("context-mismatch", "The run's preferences or choices do not match its approved context. Preview it again, then start a new run.");
    }
    const privateTexts = [...context.preferences.records.map((record) => record.statement), ...context.choices];
    if (privateTexts.some((text) => deps.mask(text) !== text || deps.knownValues().some((value) => value.length > 0 && text.includes(value)))) {
      throw new Refusal("context-credentials", "A preference or choice holds a credential, so nothing was sent. Remove it, preview the run again, then start.");
    }
    // An environment's image is reachable only from the Nebius project it was prepared in (D41), and a recipe's
    // environment serves only the target it was prepared on (NIV-55).
    if (task.environment && (await projectFingerprint(credentials.project)) !== task.environment.projectFingerprint) throw refuse("environment");
    if (task.environment && isEnvironmentRef(task.environment) && task.environment.target !== task.target) throw refuse("environment");
    // Its task variables go to Nebius with every command: none may carry a value the vault keeps.
    const known = deps.knownValues().filter((value) => value.length > 0);
    if (task.environment && isEnvironmentRef(task.environment) && Object.values(task.environment.env).some((value) => known.some((secret) => value.includes(secret)))) throw refuse("environment");
    return { task, context, credentials };
  };

  const check = createStep({
    id: "check",
    description: "Check both consents, the key and project id, this platform and the brief, before anything is sent",
    inputSchema: Input,
    outputSchema: Input,
    execute: async ({ inputData, runId }) =>
      guard("task.check", deps.mask, async () => {
        startedAt.set(runId, performance.now());
        try {
          const { task, context } = await allowed(runId, "check");
          const { brief } = context;
          deps.recorder.output(runId, "check", `Both consents given; the key and project id are set. Brief v${task.briefVersion}: ${brief.acceptanceCases.length} acceptance ${brief.acceptanceCases.length === 1 ? "case" : "cases"}, ${brief.checks.length} repository ${brief.checks.length === 1 ? "check" : "checks"}.`, {
            target: task.target,
            briefVersion: task.briefVersion,
            briefDigest: task.briefDigest,
            preview: task.preview,
            cases: brief.acceptanceCases.length,
            checks: brief.checks.length,
          });
          early(runId, task, "in-progress", null, null, false);
          return inputData;
        } catch (error) {
          // A run stopped here never reaches the run step, which would forget its start.
          forget(runId);
          throw error;
        }
      }),
  });

  const prepare = createStep({
    id: "prepare",
    description: "Find the one model a task run uses in Token Factory's listing",
    inputSchema: Input,
    outputSchema: Prepared,
    execute: async ({ runId, abortSignal }) =>
      guard("task.prepare", deps.mask, async () => {
        const task = taskOf(runId);
        // Every stop here leaves a report saying how the run ended; `allowed` saves its own.
        let reported = false;
        try {
          let given;
          try {
            given = await allowed(runId, "prepare");
          } catch (error) {
            reported = true;
            throw error;
          }
          let models;
          try {
            models = await clientFor(given.credentials.key).listModels({ signal: abortSignal, timeoutMs: 30_000 });
          } catch (error) {
            if (!abortSignal.aborted) {
              early(runId, task, "failed", "model", "prepare", true);
              reported = true;
            }
            throw error;
          }
          // Only the model the preview names: no other stands in, so a key that isn't offered it stops the run here,
          // before any request to a model and before the upload.
          const model = models.ids.find((id) => id.toLowerCase() === TASK_MODEL.toLowerCase()) ?? null;
          if (!model) {
            early(runId, task, "failed", "model", "prepare", true);
            reported = true;
            throw failure("model-unavailable", `${TASK_MODEL} isn't listed for this key`);
          }
          const contextLength = models.contextLengths.get(model) ?? null;
          const route: RunRoute = { provider: "nebius", endpoint: deps.endpoint.kind, model };
          routes.set(runId, route);
          deps.setMeta(runId, { route });
          deps.recorder.output(runId, "prepare", `Model ${model}`, { model, contextLength });
          return { model, contextLength };
        } catch (error) {
          if (!reported) {
            const cancelled = abortSignal.aborted;
            early(runId, task, cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : "fault", "prepare", true);
          }
          forget(runId);
          throw error;
        }
      }),
  });

  const run = createStep({
    id: "run",
    description: "Snapshot the commit, let the worker change it in a sandbox, check the result, collect, and propose",
    inputSchema: Prepared,
    outputSchema: Done,
    execute: async ({ inputData, runId, abortSignal }) =>
      guard("task.run", deps.mask, async () => {
        const task = taskOf(runId);
        // A failure before the report is saved still leaves one that says how the run ended.
        let reported = false;
        try {
          // Checked again here: the key and project id can be removed between the steps. A refusal saves its own report.
          // Its step is `start`: what the worker's own runs of a case or check are called comes after the upload.
          let given;
          try {
            given = await allowed(runId, "start");
          } catch (error) {
            reported = true;
            throw error;
          }
          const { context, credentials } = given;
          const git = deps.findGit();
          if (!git) throw new RepoError("git-missing", `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(deps.platform)}`);
          const { brief } = context;
          const environment: TaskEnvironment | EnvironmentRef | null = task.environment ?? null;
          const local = await deps.local.open({ workspace: task.repoPath });
          let outcome;
          try {
            outcome = await runWorker({
              binding: { project: task.project, target: task.target, taskId: task.taskId, attemptId: boundOf(runId, task).attemptId, runId, briefVersion: task.briefVersion, briefSha256: task.briefDigest, homeId: deps.homeId },
              folder: task.repoPath,
              preview: task.preview,
              brief,
              preferences: context.preferences,
              choices: context.choices,
              backend: deps.sandbox(operationsForBrief(brief), environment),
              environment,
              local,
              git,
              client: clientFor(credentials.key),
              model: inputData.model,
              policy: policyFor(inputData.model),
              contextLength: inputData.contextLength,
              mask: deps.mask,
              knownValues: deps.knownValues(),
              exclude: deps.exclude,
              signal: abortSignal,
              closeSignal: deps.shutdown,
              deadline: (startedAt.get(runId) ?? performance.now()) + TASK_LIMITS.runMs,
              progress: (message, data) => deps.recorder.output(runId, "run", message, data),
              modelCall: (message, data) => deps.recorder.event(runId, "model.call", "run", message, data),
            });
          } finally {
            await local.close();
          }
          let { result } = outcome;
          // The proposal's bytes are kept as they are, never masked: one holding a value the vault keeps isn't kept.
          if (result.proposal && holdsValue(result.proposal, deps.vaultValues())) {
            result = { ...result, outcome: "refused", stopped: { code: "change", message: "proposal: it holds a value the vault keeps.", step: "proposal", detail: null }, report: null, proposal: null };
          }
          if (outcome.core) deps.setMeta(runId, { usage: outcome.core.worker.usage });
          // The report first: a proposal is kept only once the report that describes it is, so neither says what the
          // other doesn't.
          deps.saveReport(runId, taskReport({ result, core: outcome.core, task: boundOf(runId, task), request: requestOf(runId), route: routes.get(runId) ?? null, limits: limitsOf(runId), now: now(), mask: deps.mask }));
          reported = true;
          if (result.proposal) {
            try {
              deps.saveProposal(runId, result.proposal);
            } catch (error) {
              // Not kept: the report that said it was is replaced by one saying nothing was proposed.
              early(runId, task, "failed", "fault", "proposal", true);
              throw error;
            }
          }
          const unresolved = result.cleanup?.unresolved.length ?? 0;
          deps.recorder.output(runId, "run", `Run ${result.outcome}${result.outcome === "proposed" ? (outcome.core?.verified ? ", every acceptance case passed" : ", not every acceptance case passed") : ""}${unresolved ? `; ${unresolved} left open` : ""}.`, { outcome: result.outcome, verified: result.outcome === "proposed" && outcome.core?.verified === true, unresolved });
          if (result.outcome === "proposed" || result.outcome === "unchanged") return { outcome: result.outcome };
          if (result.outcome === "cancelled") throw new ModelFailure("cancelled", "Cancelled.");
          throw stop(result.stopped?.code ?? "fault", result.stopped?.step ?? null);
        } catch (error) {
          // Until runWorker returns, nothing was sent: once a session opens, its failures are outcomes. A report that
          // can't be saved after it leaves the fault's words, which claim nothing about what was sent.
          if (!reported) {
            const cancelled = abortSignal.aborted;
            early(runId, task, cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : error instanceof RepoError ? "git" : "fault", "start", true);
          }
          throw error;
        } finally {
          forget(runId);
        }
      }),
  });

  return createWorkflow({
    id: TASK_WORKFLOW_ID,
    description: "Runs one task's worker in a Nebius sandbox with networking off, checks the result with the brief's acceptance cases, and proposes the change",
    inputSchema: Input,
    outputSchema: Done,
    // Recovery belongs to the run scheduler and the journals: a run interrupted by a restart is never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(check)
    .then(prepare)
    .then(run)
    .commit();
}
