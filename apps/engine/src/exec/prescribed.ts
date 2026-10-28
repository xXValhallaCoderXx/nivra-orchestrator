import { BoundaryUnavailableError, ExecRefusedError, ExecUncertainError, SessionOpenError, type CloseReport, type ExecRequest, type ExecResult, type ExecutionBackend, type ExecutionSession, type SessionStep } from "./backend.ts";
import { WorkspaceCancelled, WorkspaceRefusal, type RefusalCode } from "./git-tool.ts";
import { SandboxHttpError, SandboxNetworkError, SandboxTooLargeError } from "./nebius/api.ts";
import { EnvironmentMissingError, SandboxOperationError } from "./nebius/session.ts";
import { buildPatch, collectResult, type Collected, type PatchPolicy, type PatchResult } from "./patch.ts";
import { buildReport, makeProposal, stepRecord, stoppedStepRecord, type Proposal, type StepRecord } from "./proposal.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";

/**
 * The prescribed path (NIV-43, D35): one commit's snapshot, work in a sandbox, and a checked patch proposed from what
 * it changed. The tests, the live check, the sandbox check (B4) and a task's worker (D39) all run this one
 * composition, in order:
 * 1. the snapshot, made by the engine that owns the checkout, through its own `Local` session. A run bound to a
 *    preview (D36) goes no further unless the snapshot's fingerprint is the preview's;
 * 2. a session on a backend that isolates files, opened with the snapshot. `Local` is refused before anything is sent;
 * 3. the work: fixed steps, one operation each (an edit keeps its changes for the next step and for the result; a
 *    check throws its changes away), or the run's own `work`, a worker's;
 * 4. the collect step, its two reads each with a deadline of their own;
 * 5. the run's own `verify`, when it has one: checks run from collect's image, before the session closes;
 * 6. close, on a budget of its own, whatever happened before: nothing after it needs the session's time;
 * 7. the patch, validated and checked, its git commands under one deadline;
 * 8. the report (each step's outcome, and every operation's status and usage) and the proposal, bound by one hash,
 *    unless nothing changed;
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
  | "preview"
  /** A task's: a program its checks need isn't in the sandbox image (D39). Nothing was installed. */
  | "toolchain"
  /** A task's: its run's deadline left no time for a session (D39). Nothing was sent. */
  | "time"
  /** A task's: its baseline selections didn't give what the brief expects, so the model wasn't called (D41). */
  | "baseline"
  /** A task's: its environment wasn't prepared from this commit's manifests (D41). Nothing was sent. */
  | "environment"
  /** A task's: the brief freezes a file the commit doesn't hold (D41). Nothing was sent. */
  | "frozen"
  /** A task's: its prepared environment's image is gone from Nebius (NIV-55), found once the commit was sent. */
  | "environment-missing";

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

/** Whether the run goes on to collect, or how its work stopped it. */
export type WorkResult = { going: true } | { going: false; outcome: PrescribedOutcome; stopped: NonNullable<PrescribedResult["stopped"]> };

/**
 * What the run's own hooks are given: the snapshot, the workspace, and the steps recorded so far, to add theirs to.
 * `stage` is where the run is, for a stop's record: a hook sets it as it goes.
 */
export interface WorkContext {
  snapshot: Snapshot;
  workspace: string;
  steps: StepRecord[];
  stage: string | null;
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
  /**
   * The work, in place of `steps`: given the open session, it runs its own operations. It throws what the steps would
   * (an uncertain command, a refusal, a cancel), or says how it stopped.
   */
  work?: (session: ExecutionSession, context: WorkContext) => Promise<WorkResult>;
  /**
   * After the snapshot, before anything is sent: why the run can't go on with this commit, or null. A task's
   * environment and frozen files are checked here (D41).
   */
  admit?: (snapshot: Snapshot) => { code: PrescribedStopCode; message: string } | null;
  /** After collect, before close: checks from collect's image. What they find is the hook's own to record. */
  verify?: (session: ExecutionSession, context: WorkContext & { collected: Collected }) => Promise<void>;
  /** The report and the proposal, in place of the prescribed path's own: a task's, which binds more. */
  finish?: (input: { snapshot: Snapshot; patch: PatchResult; steps: readonly StepRecord[]; operations: readonly SessionStep[] }) => { report: Uint8Array; proposal: Proposal | null };
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
  /** Each of collect's two reads, on its own. */
  downloadTimeoutMs?: number;
  /** One deadline for the snapshot's git commands, and one for the patch's, from when each begins. */
  snapshotMs?: number;
  patchMs?: number;
  /**
   * The run's one absolute deadline, on `now`'s clock (D39). The snapshot and the session each get their cap or the time
   * left before `afterSessionMs`, whichever is less, so what comes after the session keeps its time; close and the
   * patch then each get their cap or the time left, whichever is less. With no deadline, each phase has its cap.
   */
  deadline?: number;
  /** What the session leaves before `deadline`: close's, the patch's and the report's time. */
  afterSessionMs?: number;
  /** The monotonic clock those deadlines are read on: tests give theirs. */
  now?: () => number;
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
/** The least time a session is opened with under a run's deadline: an upload, a prepare and a collect, at the least. */
const MIN_SESSION_MS = 3 * 60_000;
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
  if (error instanceof EnvironmentMissingError) return { outcome: "failed", code: "environment-missing" };
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

  const now = run.now ?? (() => performance.now());
  const within = (ms: number | undefined, what: string) => (ms === undefined ? {} : { deadline: { at: now() + ms, what, now } });
  // A phase's cap, or the time left before the run's deadline less `keep`, whichever is less (D39).
  const capped = (cap: number | undefined, keep = 0): number | undefined => {
    if (run.deadline === undefined) return cap;
    const left = Math.max(0, Math.floor(run.deadline - now() - keep));
    return cap === undefined ? left : Math.min(cap, left);
  };
  const afterSession = run.afterSessionMs ?? 0;

  // 1. The snapshot: nothing is sent unless it is taken. A fault here is thrown: nothing was sent, nothing needs cleaning.
  let snapshot: Snapshot;
  try {
    snapshot = await takeSnapshot({ folder: run.folder, session: run.local, git: run.git, ...(run.baseline ? { baseline: run.baseline } : {}), ...(run.exclude ? { exclude: run.exclude } : {}), ...(run.knownValues ? { knownValues: run.knownValues } : {}), ...(run.signal ? { signal: run.signal } : {}), ...within(capped(run.snapshotMs, afterSession), "Taking the snapshot") });
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

  // What the run's own rules refuse of this commit goes nowhere either.
  const refusal = run.admit?.(snapshot) ?? null;
  if (refusal) return ended("refused", { snapshot: summary, stopped: { code: refusal.code, message: refusal.message, step: "snapshot", detail: null } });

  // 2. The session. A backend that can't keep commands away from this computer's files is refused here, and so is a
  // session the run's deadline leaves too little time to settle.
  const sessionMs = capped(run.budgetMs, afterSession);
  if (run.deadline !== undefined && sessionMs !== undefined && sessionMs < MIN_SESSION_MS) {
    return ended("failed", { snapshot: summary, stopped: { code: "time", message: "open: the run's time ran out before a session could be opened, so nothing was sent.", step: "open", detail: null } });
  }
  let session: ExecutionSession;
  try {
    session = await run.backend.open({ workspace, network: "deny", requires: { isolatesFilesystem: true }, snapshot: snapshot.archive, closing, ...(sessionMs ? { budgetMs: sessionMs } : {}), ...(run.signal ? { signal: run.signal } : {}) });
  } catch (error) {
    // Before anything was sent, a refusal is the backend's; once something was, the open's own cleanup has its record.
    const stop = error instanceof ExecRefusedError ? (cancelled() ? { outcome: "cancelled" as const, code: "cancelled" as const } : { outcome: "refused" as const, code: "sandbox-refused" as const }) : stopOf(error, cancelled());
    return ended(stop.outcome, { snapshot: summary, stopped: stoppedBy(error, stop.code, "open"), cleanup: error instanceof SessionOpenError ? error.report : null });
  }

  // 3–5. The work, the collect step and the checks after it.
  let outcome: PrescribedOutcome = "failed";
  let stopped: PrescribedResult["stopped"] = null;
  let report: Uint8Array | null = null;
  let proposal: Proposal | null = null;
  let collected: Collected | null = null;
  const context: WorkContext = { snapshot, workspace, steps, stage: null };
  try {
    const worked = await (run.work ?? prescribedWork(run))(session, context);
    if (!worked.going) {
      outcome = worked.outcome;
      stopped = worked.stopped;
    } else {
      context.stage = "collect";
      const before = session.steps?.().length ?? 0;
      let collecting;
      try {
        collecting = await collectResult(session, { workspace, ...(run.applets !== undefined ? { applets: run.applets } : {}), timeoutMs: run.collectTimeoutMs ?? 60_000, ...(run.downloadTimeoutMs ? { downloadTimeoutMs: run.downloadTimeoutMs } : {}), ...(run.signal ? { signal: run.signal } : {}) });
      } catch (error) {
        steps.push(stoppedStepRecord("collect", session.steps?.().slice(before).at(-1)));
        throw error;
      }
      steps.push(stepRecord("collect", collecting.ran, session.steps?.().slice(before).at(-1)));
      run.onStep?.(steps.at(-1)!);
      if (run.verify) {
        context.stage = "verify";
        await run.verify(session, { ...context, collected: collecting.collected });
      }
      // The person's cancel ends the run where it lands, during the checks after collect as well as before: no patch is
      // begun after it, and the report names the stage it stopped in.
      if (cancelled()) throw new WorkspaceCancelled();
      collected = collecting.collected;
    }
  } catch (error) {
    const stop = stopOf(error, cancelled());
    outcome = stop.outcome;
    stopped = stoppedBy(error, stop.code, context.stage);
  }
  // 6. Close, whatever happened: its record is cleanup's own, outside what is approved. Nothing after it needs the session.
  const closeMs = capped(run.closeBudgetMs);
  const cleanup = await session.close({ ...closing, ...(closeMs !== undefined ? { budgetMs: closeMs } : {}) });
  // 7–8. The patch, the report and the proposal, from what was collected.
  if (collected && !stopped) {
    try {
      context.stage = "patch";
      const patch = await buildPatch({ snapshot, collected, session: run.local, git: run.git, ...(run.knownValues ? { knownValues: run.knownValues } : {}), ...(run.policy ? { policy: run.policy } : {}), ...(run.scratch ? { scratch: run.scratch } : {}), ...(run.signal ? { signal: run.signal } : {}), ...within(capped(run.patchMs), "Building the patch") });
      context.stage = "report";
      const operations = session.steps?.() ?? [];
      if (run.finish) ({ report, proposal } = run.finish({ snapshot, patch, steps, operations }));
      else {
        report = buildReport({ snapshot, patch, steps, operations });
        proposal = patch.bytes.byteLength ? makeProposal({ project: run.project, target: run.target, snapshot, patch, report }) : null;
      }
      outcome = proposal ? "proposed" : "unchanged";
    } catch (error) {
      const stop = stopOf(error, cancelled());
      outcome = stop.outcome;
      stopped = stoppedBy(error, stop.code, context.stage);
      report = null;
      proposal = null;
    }
  }
  return { outcome, stopped, snapshot: summary, steps, report, proposal, cleanup };
}

/** The prescribed steps as a run's work: each one operation, an edit's changes kept, a check's thrown away. */
function prescribedWork(run: PrescribedRun): NonNullable<PrescribedRun["work"]> {
  return async (session, context) => {
    const { workspace, steps } = context;
    for (const step of run.steps) {
      context.stage = step.label;
      const ran = await runStep(session, step, workspace, run, steps);
      if (ran.result.cancelled && !ran.stoppedAsPrescribed) {
        return { going: false, outcome: "cancelled", stopped: { code: "cancelled", message: `${step.label}: the run was cancelled while it ran.`, step: step.label, detail: null } };
      }
      if (step.keeps && (!ran.result.persisted || ran.result.exitCode !== 0)) {
        // An edit that failed, or whose changes weren't kept, is never proposed, nor run on.
        const why = ran.result.persisted ? `it exited ${String(ran.result.exitCode)}, so what it changed isn't proposed.` : "the sandbox didn't keep what it changed, so the run stopped: the next step would have run on an older copy of the workspace.";
        return { going: false, outcome: "failed", stopped: { code: "edit-failed", message: `${step.label}: ${why}`, step: step.label, detail: null } };
      }
    }
    return { going: true };
  };
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
