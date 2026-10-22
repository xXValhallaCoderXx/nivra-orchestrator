import { createStep, createWorkflow } from "@mastra/core/workflows";
import { SandboxOutcome, type Mask, type SandboxContext, type SandboxReport, type SandboxStopCode, type StoredSandboxInput } from "@nivra/domain";
import { z } from "zod";
import { installGitAdvice } from "../advice.ts";
import { Refusal } from "../diagnostics.ts";
import type { ExecutionBackend } from "../exec/backend.ts";
import { CHECK_LIMITS, checkRecipe, checkReport, earlyReport, stopWords } from "../exec/check.ts";
import { runPrescribed, type PrescribedResult } from "../exec/prescribed.ts";
import { RepoError } from "../repo/paths.ts";
import type { ExplainRecorder } from "./explain.ts";
import { guard } from "./guard.ts";

export const SANDBOX_WORKFLOW_ID = "sandbox";

/**
 * A sandbox check of a project's commit (NIV-44, D36), on the production adapter. It runs no model and nothing the
 * renderer chose: the steps are the engine's own (`checkRecipe`). Its upload consent arrives with the run, held in
 * memory (D21), and is checked again before anything is sent. The key and project id come from the vault (D8), never
 * from the run's input, events or journals. Mastra gets the checkout's path alone; the report is saved by the run store.
 */
export interface SandboxDeps {
  recorder: Pick<ExplainRecorder, "output">;
  context: (runId: string) => SandboxContext | null;
  task: (runId: string) => StoredSandboxInput | null;
  requestId: (runId: string) => string | null;
  /** The key and project id, read from the vault as the check starts; null unless both are set. */
  credentials: () => { key: string; project: string } | null;
  /** The Nebius backend, its journals in the engine's home. */
  sandbox: () => ExecutionBackend;
  /** The engine's own `Local` backend, for its git on the checkout. */
  local: ExecutionBackend;
  findGit: () => string | null;
  platform: NodeJS.Platform;
  /** Folders never sent: the engine's home. */
  exclude: readonly string[];
  /** The vault's values: a commit holding one is refused, and so is a change that adds one. */
  knownValues: () => string[];
  /** The engine shutting down (D4): it stops a check's cleanup too, and what that leaves stays journaled. */
  shutdown: AbortSignal;
  mask: Mask;
  saveResult: (runId: string, report: SandboxReport) => void;
  now?: () => Date;
}

const Input = z.strictObject({ repoPath: z.string() });
const Checked = z.strictObject({ repoPath: z.string() });
const Done = z.strictObject({ outcome: SandboxOutcome });

/** Ends a check that won't go on, in its code's words for where it stopped; the report says the same. */
const stop = (code: SandboxStopCode, step: string | null = null) => new Refusal(`sandbox-${code}`, stopWords(code, step));

export function createSandboxWorkflow(deps: SandboxDeps) {
  const now = deps.now ?? (() => new Date());
  const requestOf = (runId: string) => ({ runId, clientRequestId: deps.requestId(runId) ?? runId });
  const early = (runId: string, outcome: SandboxReport["outcome"], code: SandboxStopCode | null, step: string | null, finished: boolean) =>
    deps.saveResult(runId, earlyReport({ outcome, code, step, request: requestOf(runId), now: now(), finished }));

  /** Upload consent, the credentials and a readable task: all checked before anything is sent anywhere. */
  const allowed = (runId: string): { task: StoredSandboxInput } => {
    const task = deps.task(runId);
    if (!task) throw new Refusal("input-unreadable", "This check's request can't be read back from the engine's store, so it wasn't started. Check again.");
    const context = deps.context(runId);
    if (!context) throw new Refusal("context-missing", "This check's context is missing, so it wasn't started. Check again.");
    if (!context.sharing.cloudExecution) {
      early(runId, "refused", "consent", "check", true);
      throw stop("consent");
    }
    if (!deps.credentials()) {
      early(runId, "refused", "credentials", "check", true);
      throw stop("credentials");
    }
    return { task };
  };

  const check = createStep({
    id: "check",
    description: "Check upload consent, the key and project id, and the request, before anything is sent",
    inputSchema: Input,
    outputSchema: Checked,
    execute: async ({ inputData, runId }) => guard("sandbox.check", deps.mask, async () => {
      const { task } = allowed(runId);
      deps.recorder.output(runId, "check", "Upload allowed for this project; the key and project id are set.", { target: task.target, preview: task.preview });
      early(runId, "in-progress", null, null, false);
      return { repoPath: inputData.repoPath };
    }),
  });

  const run = createStep({
    id: "run",
    description: "Snapshot the commit, run the check's probe in a sandbox with networking off, collect, and report",
    inputSchema: Checked,
    outputSchema: Done,
    execute: async ({ runId, abortSignal }) => guard("sandbox.run", deps.mask, async () => {
      // Checked again here: the key and project id can be removed between the steps. Consent can't change, since the
      // run's context is fixed when it is accepted: withdrawing it cancels the run.
      const { task } = allowed(runId);
      // A failure before the report is saved still leaves one that says how the check ended.
      let reported = false;
      try {
        const git = deps.findGit();
        if (!git) throw new RepoError("git-missing", `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(deps.platform)}`);
        const local = await deps.local.open({ workspace: task.repoPath });
        let result: PrescribedResult;
        try {
          result = await runPrescribed({
            project: task.project,
            target: task.target,
            folder: task.repoPath,
            expectedFingerprint: task.preview,
            steps: checkRecipe(),
            backend: deps.sandbox(),
            local,
            git,
            exclude: deps.exclude,
            knownValues: deps.knownValues(),
            budgetMs: CHECK_LIMITS.budgetMs,
            closeBudgetMs: CHECK_LIMITS.closeBudgetMs,
            collectTimeoutMs: CHECK_LIMITS.stepTimeoutMs,
            signal: abortSignal,
            closeSignal: deps.shutdown,
            onStep: (step) => deps.recorder.output(runId, "run", `${step.label}: ${step.cancelled ? "cancelled" : step.timedOut ? "timed out" : `exit ${String(step.exitCode)}`}${step.status ? `, ${step.status}` : ""}`, { step: step.label, status: step.status, exitCode: step.exitCode }),
          });
        } finally {
          await local.close();
        }
        deps.saveResult(runId, checkReport({ result, request: requestOf(runId), now: now() }));
        reported = true;
        const unresolved = result.cleanup?.unresolved.length ?? 0;
        deps.recorder.output(runId, "run", `Check ${result.outcome}${unresolved ? `; ${unresolved} left open` : ""}.`, { outcome: result.outcome, unresolved });
        if (result.outcome === "unchanged" || result.outcome === "proposed") return { outcome: result.outcome };
        throw stop(result.stopped?.code ?? (result.outcome === "cancelled" ? "cancelled" : "fault"), result.stopped?.step ?? null);
      } catch (error) {
        // Until runPrescribed returns, nothing was sent: once a session opens, its failures are outcomes. A report that
        // can't be saved after it leaves the fault's words, which claim nothing about what was sent.
        if (!reported) {
          const cancelled = abortSignal.aborted;
          early(runId, cancelled ? "cancelled" : "failed", cancelled ? "cancelled" : error instanceof RepoError ? "git" : "fault", "run", true);
        }
        throw error;
      }
    }),
  });

  return createWorkflow({
    id: SANDBOX_WORKFLOW_ID,
    description: "Checks a project's commit in a Nebius sandbox: upload, prepare, one fixed probe with networking off, collect, report",
    inputSchema: Input,
    outputSchema: Done,
    // Recovery belongs to the run scheduler and the journals: a check interrupted by a restart is never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(check)
    .then(run)
    .commit();
}
