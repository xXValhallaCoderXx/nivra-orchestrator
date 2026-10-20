import { BoundaryUnavailableError, ExecRefusedError, ExecUncertainError, SessionOpenError, type CloseReport, type ExecRequest, type ExecResult, type ExecutionBackend, type ExecutionSession } from "./backend.ts";
import { WorkspaceCancelled, WorkspaceRefusal, type RefusalCode } from "./git-tool.ts";
import { SandboxOperationError } from "./nebius/session.ts";
import { buildPatch, collectResult, type PatchPolicy } from "./patch.ts";
import { buildReport, makeProposal, stepRecord, type Proposal, type StepRecord } from "./proposal.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";

/**
 * The prescribed path (NIV-43, D35): one commit's snapshot, fixed steps in a sandbox, and a checked patch proposed
 * from what they changed. The tests, the live check and the engine (B4) all run this one composition, in order:
 * 1. the snapshot, made by the engine that owns the checkout, through its own `Local` session;
 * 2. a session on a backend that isolates files, opened with the snapshot. `Local` is refused before anything is sent;
 * 3. the steps, one operation each. An edit keeps its changes for the next step and for the result; a check throws
 *    its changes away;
 * 4. the collect step;
 * 5. the patch, validated and checked;
 * 6. the report, made before the session closes: each step's outcome, provider status and usage;
 * 7. the proposal, bound by one hash, unless nothing changed;
 * 8. close, on a budget of its own, whatever happened before;
 * 9. cleanup's own record: what was stopped, what stays unresolved and what the provider keeps.
 *
 * Nothing writes the checkout. A step that can't be settled stops the run, and nothing is ever sent twice.
 */

export interface PrescribedStep {
  /** An engine-chosen name, never model text: it goes in the record and the report. */
  label: string;
  argv: ExecRequest["argv"];
  /** The step's folder, inside the workspace; the workspace itself unless given. */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** An edit keeps its changes for the next step and the result. A check throws its changes away. */
  keeps: boolean;
  /** Stops the step once it has run this long, and the run goes on: a check that serves something, say. */
  stopAfterMs?: number;
}

export type PrescribedOutcome =
  /** A proposal is ready to be approved. */
  | "proposed"
  /** The steps ran and changed nothing. */
  | "unchanged"
  /** Refused, with a code: before anything was sent, or what came back. */
  | "refused"
  /** The person cancelled the run. */
  | "cancelled"
  /** The run couldn't go on: lost state, an edit whose changes weren't kept, an operation that failed. */
  | "failed"
  /** It isn't known whether a step started: it is never sent again, and closing looks for it. */
  | "uncertain";

export interface PrescribedResult {
  outcome: PrescribedOutcome;
  /** What stopped the run: its words, the workspace rules' code when they refused it, and git's or the sandbox's own words, which never leave the engine. */
  stopped: { code: RefusalCode | null; message: string; detail: string | null } | null;
  /** The snapshot, once taken. */
  snapshot: { baseline: string; prefix: string; fingerprint: string; files: number; archiveSha256: string } | null;
  /** Every step that ran, the collect step last. */
  steps: StepRecord[];
  /** The report bound into the proposal, made before the session closed; null when the run stopped before it. */
  report: Uint8Array | null;
  proposal: Proposal | null;
  /** Cleanup's own record; null when no session was opened. */
  cleanup: CloseReport | null;
}

export interface PrescribedRun {
  project: string;
  target: string;
  /** The picked folder, in the owning engine's path form. */
  folder: string;
  /** When given, the checkout's HEAD must be this commit. */
  baseline?: string;
  steps: readonly PrescribedStep[];
  /** A backend that isolates files (Nebius). */
  backend: ExecutionBackend;
  /** A session on the target that owns the checkout, for the engine's own git. */
  local: ExecutionSession;
  git: string;
  /** The workspace on the sandbox's machine, `/workspace` unless given. */
  workspace?: string;
  /** What runs the collect step's tools, busybox unless given. */
  applets?: string;
  collectTimeoutMs?: number;
  /** Folders never sent (the engine home). */
  exclude?: readonly string[];
  /** The vault's own values: a file holding one refuses the snapshot, and so does a change that adds one. */
  knownValues?: readonly string[];
  policy?: Partial<PatchPolicy>;
  /** The session's whole time, and closing's. */
  budgetMs?: number;
  closeBudgetMs?: number;
  /** The person's cancel: it stops the run's work, never its cleanup. */
  signal?: AbortSignal;
  /** Stops cleanup too: an engine shutting down (D4). What it leaves stays journaled for recovery. */
  closeSignal?: AbortSignal;
  /** Where the patch's temporary store goes. */
  scratch?: string;
  /** Each step's record as it ends, for progress. */
  onStep?: (record: StepRecord) => void;
  /** Calls `fire` after `ms` unless cancelled first: the real clock unless given (tests give theirs). */
  timer?: (ms: number, fire: () => void) => () => void;
}

const WORKSPACE = "/workspace";
const realTimer = (ms: number, fire: () => void) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

const why = (error: unknown): NonNullable<PrescribedResult["stopped"]> => ({
  code: error instanceof WorkspaceRefusal ? error.code : null,
  message: error instanceof Error ? error.message : String(error),
  detail: error instanceof WorkspaceRefusal ? error.detail : null,
});

/** What stopped the run, as an outcome; null for a fault, which is thrown once the session is closed. */
function outcomeOf(error: unknown, cancelled: boolean): PrescribedOutcome | null {
  if (error instanceof WorkspaceCancelled) return "cancelled";
  if (error instanceof WorkspaceRefusal || error instanceof BoundaryUnavailableError) return "refused";
  if (error instanceof ExecUncertainError) return "uncertain";
  if (error instanceof ExecRefusedError) return cancelled ? "cancelled" : "failed";
  if (error instanceof SandboxOperationError || error instanceof SessionOpenError) return "failed";
  return null;
}

export async function runPrescribed(run: PrescribedRun): Promise<PrescribedResult> {
  const workspace = run.workspace ?? WORKSPACE;
  const steps: StepRecord[] = [];
  const cancelled = () => run.signal?.aborted === true;
  const ended = (outcome: PrescribedOutcome, rest: Partial<PrescribedResult>): PrescribedResult => ({ outcome, stopped: null, snapshot: null, steps, report: null, proposal: null, cleanup: null, ...rest });

  // 1. The snapshot: nothing is sent unless it is taken.
  let snapshot: Snapshot;
  try {
    snapshot = await takeSnapshot({ folder: run.folder, session: run.local, git: run.git, ...(run.baseline ? { baseline: run.baseline } : {}), ...(run.exclude ? { exclude: run.exclude } : {}), ...(run.knownValues ? { knownValues: run.knownValues } : {}), ...(run.signal ? { signal: run.signal } : {}) });
  } catch (error) {
    const outcome = outcomeOf(error, cancelled());
    if (outcome === null) throw error;
    return ended(outcome, { stopped: why(error) });
  }
  const summary = { baseline: snapshot.baseline, prefix: snapshot.prefix, fingerprint: snapshot.fingerprint, files: snapshot.files.length, archiveSha256: snapshot.archive.sha256 };

  // 2. The session. A backend that can't keep commands away from this computer's files is refused here.
  let session: ExecutionSession;
  try {
    session = await run.backend.open({ workspace, network: "deny", requires: { isolatesFilesystem: true }, snapshot: snapshot.archive, ...(run.budgetMs ? { budgetMs: run.budgetMs } : {}), ...(run.signal ? { signal: run.signal } : {}) });
  } catch (error) {
    const outcome = error instanceof SessionOpenError ? "failed" : error instanceof ExecRefusedError ? (cancelled() ? "cancelled" : "refused") : outcomeOf(error, cancelled());
    if (outcome === null) throw error;
    return ended(outcome, { snapshot: summary, stopped: why(error), cleanup: error instanceof SessionOpenError ? error.report : null });
  }

  // 3–7. The steps, the collect step, the patch, the report and the proposal.
  const closing = { ...(run.closeBudgetMs ? { budgetMs: run.closeBudgetMs } : {}), ...(run.closeSignal ? { signal: run.closeSignal } : {}) };
  let outcome: PrescribedOutcome = "failed";
  let stopped: PrescribedResult["stopped"] = null;
  let report: Uint8Array | null = null;
  let proposal: Proposal | null = null;
  try {
    let going = true;
    for (const step of run.steps) {
      const ran = await runStep(session, step, workspace, run);
      steps.push(stepRecord(step.label, ran.result, ran.recorded));
      run.onStep?.(steps.at(-1)!);
      if (ran.result.cancelled && !ran.stoppedAsPrescribed) {
        outcome = "cancelled";
        stopped = { code: null, message: `The run was cancelled during ${step.label}.`, detail: null };
      } else if (step.keeps && (!ran.result.persisted || ran.result.exitCode !== 0)) {
        // An edit that failed, or whose changes weren't kept, is never proposed, nor run on.
        outcome = "failed";
        stopped = { code: null, message: ran.result.persisted ? `${step.label} exited ${String(ran.result.exitCode)}, so what it changed isn't proposed.` : `The sandbox didn't keep what ${step.label} changed, so the run stopped: the next step would have run on an older copy of the workspace.`, detail: null };
      } else continue;
      going = false;
      break;
    }
    if (going) {
      const before = session.steps?.().length ?? 0;
      const { collected, ran } = await collectResult(session, { workspace, ...(run.applets ? { applets: run.applets } : {}), timeoutMs: run.collectTimeoutMs ?? 60_000, ...(run.signal ? { signal: run.signal } : {}) });
      steps.push(stepRecord("collect", ran, session.steps?.().slice(before).at(-1)));
      run.onStep?.(steps.at(-1)!);
      const patch = await buildPatch({ snapshot, collected, session: run.local, git: run.git, ...(run.knownValues ? { knownValues: run.knownValues } : {}), ...(run.policy ? { policy: run.policy } : {}), ...(run.scratch ? { scratch: run.scratch } : {}), ...(run.signal ? { signal: run.signal } : {}) });
      report = buildReport({ snapshot, patch, steps });
      proposal = patch.bytes.byteLength ? makeProposal({ project: run.project, target: run.target, snapshot, patch, report }) : null;
      outcome = proposal ? "proposed" : "unchanged";
    }
  } catch (error) {
    const mapped = outcomeOf(error, cancelled());
    if (mapped === null) {
      await session.close(closing);
      throw error;
    }
    outcome = mapped;
    stopped = why(error);
  }
  // 8–9. Close, whatever happened: its record is cleanup's own, outside what is approved.
  const cleanup = await session.close(closing);
  return { outcome, stopped, snapshot: summary, steps, report, proposal, cleanup };
}

/** One step as one command, with the session's own record of it, and whether a prescribed stop ended it. */
async function runStep(session: ExecutionSession, step: PrescribedStep, workspace: string, run: PrescribedRun): Promise<{ result: ExecResult; recorded: ReturnType<NonNullable<ExecutionSession["steps"]>>[number] | undefined; stoppedAsPrescribed: boolean }> {
  const before = session.steps?.().length ?? 0;
  const stop = new AbortController();
  let cancelTimer = () => {};
  const signals = [run.signal, step.stopAfterMs === undefined ? undefined : stop.signal].filter((signal): signal is AbortSignal => signal !== undefined);
  try {
    const result = await session.exec({
      argv: step.argv,
      cwd: step.cwd ? `${workspace}/${step.cwd}` : workspace,
      ...(step.env ? { env: { ...step.env } } : {}),
      timeoutMs: step.timeoutMs,
      maxOutputBytes: step.maxOutputBytes ?? 16_384,
      persist: step.keeps,
      label: step.label,
      ...(signals.length ? { signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) } : {}),
      ...(step.stopAfterMs === undefined ? {} : { onStart: () => void (cancelTimer = (run.timer ?? realTimer)(step.stopAfterMs!, () => stop.abort(new Error(`${step.label} ran for ${step.stopAfterMs} ms, and was stopped as prescribed.`)))) }),
    });
    return { result, recorded: session.steps?.().slice(before).at(-1), stoppedAsPrescribed: stop.signal.aborted && !(run.signal?.aborted ?? false) };
  } finally {
    cancelTimer();
  }
}
