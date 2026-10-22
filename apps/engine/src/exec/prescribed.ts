import { BoundaryUnavailableError, ExecRefusedError, ExecUncertainError, SessionOpenError, type CloseReport, type ExecRequest, type ExecResult, type ExecutionBackend, type ExecutionSession, type SessionStep } from "./backend.ts";
import { WorkspaceCancelled, WorkspaceRefusal, type RefusalCode } from "./git-tool.ts";
import { SandboxHttpError, SandboxNetworkError, SandboxTooLargeError } from "./nebius/api.ts";
import { SandboxOperationError } from "./nebius/session.ts";
import { buildPatch, collectResult, type PatchPolicy } from "./patch.ts";
import { buildReport, makeProposal, stepRecord, stoppedStepRecord, type Proposal, type StepRecord } from "./proposal.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";

/**
 * The prescribed path (NIV-43, D35): one commit's snapshot, fixed steps in a sandbox, and a checked patch proposed
 * from what they changed. The tests, the live check and the engine (B4) all run this one composition, in order:
 * 1. the snapshot, made by the engine that owns the checkout, through its own `Local` session. A run bound to a
 *    preview (D36) goes no further unless the snapshot's fingerprint is the preview's;
 * 2. a session on a backend that isolates files, opened with the snapshot. `Local` is refused before anything is sent;
 * 3. the steps, one operation each. An edit keeps its changes for the next step and for the result; a check throws
 *    its changes away;
 * 4. the collect step;
 * 5. the patch, validated and checked;
 * 6. the report, made before the session closes: each step's outcome, and every operation's status and usage;
 * 7. the proposal, bound by one hash, unless nothing changed;
 * 8. close, on a budget of its own, whatever happened before;
 * 9. cleanup's own record: what was stopped, what stays unresolved and what the provider keeps.
 *
 * Nothing writes the checkout. A step that can't be settled stops the run, and nothing is ever sent twice. Once a
 * session is open, every failure ends as an outcome with cleanup's record: none is thrown away.
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
  /** Stops the step once it has been running this long, and the run goes on: a check that serves something, say. */
  stopAfterMs?: number;
}

export type PrescribedOutcome =
  /** A proposal is ready to be approved. */
  | "proposed"
  /** The steps ran and changed nothing. */
  | "unchanged"
  /** Refused: before anything was sent, or what came back. */
  | "refused"
  /** The person cancelled the run. */
  | "cancelled"
  /** The run couldn't go on: lost state, an edit that failed or whose changes weren't kept, an operation that failed. */
  | "failed"
  /** It isn't known whether something started: it is never sent again, and closing looks for it. */
  | "uncertain";

/** What stopped a run, by kind: what leaves the engine is chosen by this code (B4), never by the message. */
export type PrescribedStopCode =
  /** The workspace rules refused it: the snapshot, what came back, or the change. */
  | RefusalCode
  /** The backend can't enforce what the run needs (isolation, no network). */
  | "boundary"
  /** The sandbox wouldn't run something, before it was sent: its state lost, its time, its key. */
  | "sandbox-refused"
  /** The sandbox's operation failed, or opening the session did after something was sent. */
  | "sandbox-failed"
  | "uncertain"
  | "cancelled"
  /** An edit exited with an error, or its changes weren't kept. */
  | "edit-failed"
  /** Anything else: a fault, reported with its words. */
  | "fault"
  /** The snapshot isn't the one the person was shown (D36): nothing was sent. */
  | "preview";

export interface PrescribedResult {
  outcome: PrescribedOutcome;
  /**
   * What stopped the run: its code, its words, the step it stopped in, and git's or the sandbox's own words, which
   * never leave the engine.
   */
  stopped: { code: PrescribedStopCode; message: string; step: string | null; detail: string | null } | null;
  /** The snapshot, once taken. */
  snapshot: { baseline: string; prefix: string; fingerprint: string; files: number; archiveSha256: string } | null;
  /** Every step that ran, the collect step last; one that stopped the run is there too, with what is known of it. */
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
  /** When given, the snapshot's fingerprint must be this one: what the person was shown before any upload (D36). */
  expectedFingerprint?: string;
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
  /** Stops cleanup too, a failed open's included: an engine shutting down (D4). What it leaves stays journaled. */
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

/** What stopped the run, as an outcome and a code. Unknown errors are faults: "failed", with their words. */
function stopOf(error: unknown, cancelled: boolean): { outcome: PrescribedOutcome; code: PrescribedStopCode } {
  if (error instanceof WorkspaceCancelled) return { outcome: "cancelled", code: "cancelled" };
  if (error instanceof WorkspaceRefusal) return { outcome: "refused", code: error.code };
  if (error instanceof BoundaryUnavailableError) return { outcome: "refused", code: "boundary" };
  // Something that may still be running outranks a cancel: closing's record says what stays open.
  if (error instanceof ExecUncertainError || (error instanceof SessionOpenError && error.report.unresolved.length)) return { outcome: "uncertain", code: "uncertain" };
  if (cancelled) return { outcome: "cancelled", code: "cancelled" };
  if (error instanceof SessionOpenError) return { outcome: "failed", code: "sandbox-failed" };
  if (error instanceof ExecRefusedError) return { outcome: "failed", code: "sandbox-refused" };
  // An operation that failed, or a read of what it left (a download) that the service answered with an error.
  if (error instanceof SandboxOperationError || error instanceof SandboxHttpError || error instanceof SandboxNetworkError || error instanceof SandboxTooLargeError) return { outcome: "failed", code: "sandbox-failed" };
  return { outcome: "failed", code: "fault" };
}

const stoppedBy = (error: unknown, code: PrescribedStopCode, step: string | null): NonNullable<PrescribedResult["stopped"]> => {
  const words = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: step ? `${step}: ${words}` : words,
    step,
    detail: error instanceof WorkspaceRefusal ? error.detail : code === "fault" && error instanceof Error ? error.name : null,
  };
};

export async function runPrescribed(run: PrescribedRun): Promise<PrescribedResult> {
  const workspace = run.workspace ?? WORKSPACE;
  const steps: StepRecord[] = [];
  const cancelled = () => run.signal?.aborted === true;
  const ended = (outcome: PrescribedOutcome, rest: Partial<PrescribedResult>): PrescribedResult => ({ outcome, stopped: null, snapshot: null, steps, report: null, proposal: null, cleanup: null, ...rest });
  const closing = { ...(run.closeBudgetMs ? { budgetMs: run.closeBudgetMs } : {}), ...(run.closeSignal ? { signal: run.closeSignal } : {}) };

  // 1. The snapshot: nothing is sent unless it is taken. A fault here is thrown: nothing was sent, nothing needs cleaning.
  let snapshot: Snapshot;
  try {
    snapshot = await takeSnapshot({ folder: run.folder, session: run.local, git: run.git, ...(run.baseline ? { baseline: run.baseline } : {}), ...(run.exclude ? { exclude: run.exclude } : {}), ...(run.knownValues ? { knownValues: run.knownValues } : {}), ...(run.signal ? { signal: run.signal } : {}) });
  } catch (error) {
    if (!(error instanceof WorkspaceRefusal || error instanceof WorkspaceCancelled)) throw error;
    const stop = stopOf(error, cancelled());
    return ended(stop.outcome, { stopped: stoppedBy(error, stop.code, "snapshot") });
  }
  const summary = { baseline: snapshot.baseline, prefix: snapshot.prefix, fingerprint: snapshot.fingerprint, files: snapshot.files.length, archiveSha256: snapshot.archive.sha256 };
  // A commit, or what would be sent of it, that changed since the person saw it goes nowhere.
  if (run.expectedFingerprint !== undefined && snapshot.fingerprint !== run.expectedFingerprint) {
    return ended("refused", { snapshot: summary, stopped: { code: "preview", message: "snapshot: what would be sent changed since it was previewed, so nothing was sent.", step: "snapshot", detail: null } });
  }

  // 2. The session. A backend that can't keep commands away from this computer's files is refused here.
  let session: ExecutionSession;
  try {
    session = await run.backend.open({ workspace, network: "deny", requires: { isolatesFilesystem: true }, snapshot: snapshot.archive, closing, ...(run.budgetMs ? { budgetMs: run.budgetMs } : {}), ...(run.signal ? { signal: run.signal } : {}) });
  } catch (error) {
    // Before anything was sent, a refusal is the backend's; once something was, the open's own cleanup has its record.
    const stop = error instanceof ExecRefusedError ? (cancelled() ? { outcome: "cancelled" as const, code: "cancelled" as const } : { outcome: "refused" as const, code: "sandbox-refused" as const }) : stopOf(error, cancelled());
    return ended(stop.outcome, { snapshot: summary, stopped: stoppedBy(error, stop.code, "open"), cleanup: error instanceof SessionOpenError ? error.report : null });
  }

  // 3–7. The steps, the collect step, the patch, the report and the proposal.
  let outcome: PrescribedOutcome = "failed";
  let stopped: PrescribedResult["stopped"] = null;
  let report: Uint8Array | null = null;
  let proposal: Proposal | null = null;
  let stage: string | null = null;
  try {
    let going = true;
    for (const step of run.steps) {
      stage = step.label;
      const ran = await runStep(session, step, workspace, run, steps);
      if (ran.result.cancelled && !ran.stoppedAsPrescribed) {
        outcome = "cancelled";
        stopped = { code: "cancelled", message: `${step.label}: the run was cancelled while it ran.`, step: step.label, detail: null };
      } else if (step.keeps && (!ran.result.persisted || ran.result.exitCode !== 0)) {
        // An edit that failed, or whose changes weren't kept, is never proposed, nor run on.
        outcome = "failed";
        const why = ran.result.persisted ? `it exited ${String(ran.result.exitCode)}, so what it changed isn't proposed.` : "the sandbox didn't keep what it changed, so the run stopped: the next step would have run on an older copy of the workspace.";
        stopped = { code: "edit-failed", message: `${step.label}: ${why}`, step: step.label, detail: null };
      } else continue;
      going = false;
      break;
    }
    if (going) {
      stage = "collect";
      const before = session.steps?.().length ?? 0;
      let collecting;
      try {
        collecting = await collectResult(session, { workspace, ...(run.applets ? { applets: run.applets } : {}), timeoutMs: run.collectTimeoutMs ?? 60_000, ...(run.signal ? { signal: run.signal } : {}) });
      } catch (error) {
        steps.push(stoppedStepRecord("collect", session.steps?.().slice(before).at(-1)));
        throw error;
      }
      steps.push(stepRecord("collect", collecting.ran, session.steps?.().slice(before).at(-1)));
      run.onStep?.(steps.at(-1)!);
      stage = "patch";
      const patch = await buildPatch({ snapshot, collected: collecting.collected, session: run.local, git: run.git, ...(run.knownValues ? { knownValues: run.knownValues } : {}), ...(run.policy ? { policy: run.policy } : {}), ...(run.scratch ? { scratch: run.scratch } : {}), ...(run.signal ? { signal: run.signal } : {}) });
      stage = "report";
      report = buildReport({ snapshot, patch, steps, operations: session.steps?.() ?? [] });
      proposal = patch.bytes.byteLength ? makeProposal({ project: run.project, target: run.target, snapshot, patch, report }) : null;
      outcome = proposal ? "proposed" : "unchanged";
    }
  } catch (error) {
    const stop = stopOf(error, cancelled());
    outcome = stop.outcome;
    stopped = stoppedBy(error, stop.code, stage);
  }
  // 8–9. Close, whatever happened: its record is cleanup's own, outside what is approved.
  const cleanup = await session.close(closing);
  return { outcome, stopped, snapshot: summary, steps, report, proposal, cleanup };
}

/**
 * One step as one command, its record kept whatever happens. A prescribed stop counts from when the command is first
 * seen running, so a command still waiting to start is never taken for one that ran and was stopped.
 */
async function runStep(session: ExecutionSession, step: PrescribedStep, workspace: string, run: PrescribedRun, steps: StepRecord[]): Promise<{ result: ExecResult; stoppedAsPrescribed: boolean }> {
  const before = session.steps?.().length ?? 0;
  const recorded = (): SessionStep | undefined => session.steps?.().slice(before).at(-1);
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
      ...(step.stopAfterMs === undefined ? {} : { onRunning: () => void (cancelTimer = (run.timer ?? realTimer)(step.stopAfterMs!, () => stop.abort(new Error(`${step.label} ran for ${step.stopAfterMs} ms, and was stopped as prescribed.`)))) }),
    });
    steps.push(stepRecord(step.label, result, recorded()));
    run.onStep?.(steps.at(-1)!);
    return { result, stoppedAsPrescribed: stop.signal.aborted && !(run.signal?.aborted ?? false) };
  } catch (error) {
    steps.push(stoppedStepRecord(step.label, recorded()));
    throw error;
  } finally {
    cancelTimer();
  }
}
