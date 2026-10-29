import { minutesMs, requestMsFor, TASK_BRIEF_LIMITS, TASK_RUN_BOUNDS, type TaskRunLimits } from "@nivra/domain";
import { MAX_WRITE_BYTES } from "./scripts.ts";

/**
 * The bounds no brief changes, their numbers and why, are the domain's (`TASK_RUN_BOUNDS`), as the brief's are
 * (`TASK_BRIEF_LIMITS`); each request's time comes from its cap there too (`requestMsFor`). A request isn't streamed, so
 * its reply's headers come with its whole answer: the engine's fetch waits for them longer than any request's time
 * (`FETCH_HEADERS_MS`, providers/transport.ts).
 */
const BOUNDS = TASK_RUN_BOUNDS;

/**
 * A task run's bounds (NIV-7, D39), all enforced by the engine. There is one run deadline, and each phase has a cap
 * of its own; a later phase gets its cap or the time left, whichever is less. Inside the sandbox session, the time
 * everything after the work needs is reserved before the worker starts, so the worker can never spend it: collect's
 * operation and its two reads, then each final check. Close, patch construction and the report come after the session
 * and have caps of their own.
 */
export const TASK_LIMITS = {
  /**
   * Hard: requests, each one's time, and the output cap sent with each; estimated: the run's input budget (D30).
   * Room for a real repository's discovery, change and check (NIV-35): the first live run spent all of 12 requests,
   * about 133,000 input tokens, finding its way, so the requests, the tool calls and the input estimate rise together.
   * Each request's time is its cap's, at `tokensPerSecond`, with its input's time besides (the domain's `requestMsFor`);
   * the hand-in's too.
   */
  model: {
    requests: BOUNDS.modelRequests,
    stepMs: requestMsFor(BOUNDS.outputTokensPerRequest),
    outputTokensPerRequest: BOUNDS.outputTokensPerRequest,
    handIn: { outputTokens: BOUNDS.handInOutputTokens, stepMs: requestMsFor(BOUNDS.handInOutputTokens) },
    tokensPerSecond: BOUNDS.tokensPerSecond,
    estimatedInputTokens: BOUNDS.estimatedInputTokens,
  },
  /**
   * Tool calls the model may make, of which writes and runs of a case or check are operations. A search returns at most
   * `searchMatches` matches, each line cut to `searchLineChars` characters.
   */
  tools: { calls: BOUNDS.toolCalls, writes: BOUNDS.writes, runs: BOUNDS.runs, readBytes: 16_384, readTotalBytes: 256 * 1024, searchMatches: 40, searchLineChars: 200 },
  write: { timeoutMs: 30_000, downloadMs: 30_000, maxBytes: MAX_WRITE_BYTES },
  /** Acceptance cases plus repository checks, as the brief gives them (the domain's brief limits). */
  checks: { max: TASK_BRIEF_LIMITS.finalChecks, timeoutMs: BOUNDS.checkSeconds * 1000, outputTailBytes: 16_384, expectedOutputBytes: TASK_BRIEF_LIMITS.expectedOutputBytes, commandChars: TASK_BRIEF_LIMITS.commandChars },
  toolchain: { timeoutMs: 30_000 },
  prepareTimeoutSeconds: 60,
  collect: { timeoutMs: 60_000, downloadMs: 60_000 },
  snapshotMs: 2 * 60_000,
  /** Room in the work window for requests of their whole time, the hand-in's kept besides (NIV-35), and the reserve. */
  sessionMs: minutesMs(BOUNDS.sessionMinutes),
  closeMs: 7 * 60_000,
  patchMs: 3 * 60_000,
  reportMs: 15_000,
  runMs: minutesMs(BOUNDS.runMinutes),
  /**
   * As the Nebius session counts them (D33): the request that starts an operation, which comes before its timeout does;
   * how long it is watched past its timeout; and what a write needs left to be sent.
   */
  startRequestMs: 30_000,
  observeMarginMs: 60_000,
  minWriteMs: 2_000,
} as const;

/**
 * The most an operation of `timeoutMs` can take once it is sent: its start request, its timeout and the watch past it,
 * with a write's margin. A start whose answer is lost is searched for besides; then what comes after it may be left
 * not run, never run on a workspace whose state isn't known.
 */
export const operationMs = (timeoutMs: number): number => TASK_LIMITS.startRequestMs + Math.ceil(timeoutMs / 1000) * 1000 + TASK_LIMITS.observeMarginMs + TASK_LIMITS.minWriteMs;

/** The time kept, before the worker starts, for collect, its two reads and `finalChecks` checks, with a write's margin. */
export function reserveMs(finalChecks: number): number {
  const { collect, checks, minWriteMs } = TASK_LIMITS;
  return operationMs(collect.timeoutMs) + 2 * collect.downloadMs + finalChecks * operationMs(checks.timeoutMs) + minWriteMs;
}

/**
 * The operations a run may start: prepare, the toolchain probe, the brief's baseline selections (D41), the worker's
 * writes and runs, collect and the final checks.
 */
export const operationsFor = (finalChecks: number, baselineChecks = 0): number => 1 + 1 + baselineChecks + TASK_LIMITS.tools.writes + TASK_LIMITS.tools.runs + 1 + finalChecks;

/** What a tool needs left in the work window before it sends an operation: the operation, and its read when it has one. */
export const writeNeedsMs = (): number => operationMs(TASK_LIMITS.write.timeoutMs) + TASK_LIMITS.write.downloadMs;
export const runNeedsMs = (): number => operationMs(TASK_LIMITS.checks.timeoutMs);

/** The time the session leaves for what comes after it: close, the patch, and the report and proposal. */
export const AFTER_SESSION_MS = TASK_LIMITS.closeMs + TASK_LIMITS.patchMs + TASK_LIMITS.reportMs;

/** A run's bounds for a brief with `finalChecks` cases and checks and `baselineChecks` selections, as its preview shows them (D39, D41). */
export function runLimitsFor(finalChecks: number, baselineChecks = 0): TaskRunLimits {
  return {
    modelRequests: TASK_LIMITS.model.requests,
    requestSeconds: TASK_LIMITS.model.stepMs / 1000,
    outputTokensPerRequest: TASK_LIMITS.model.outputTokensPerRequest,
    estimatedInputTokens: TASK_LIMITS.model.estimatedInputTokens,
    toolCalls: TASK_LIMITS.tools.calls,
    writes: TASK_LIMITS.tools.writes,
    writeBytes: TASK_LIMITS.write.maxBytes,
    runs: TASK_LIMITS.tools.runs,
    baselineChecks,
    operations: operationsFor(finalChecks, baselineChecks),
    checkSeconds: TASK_LIMITS.checks.timeoutMs / 1000,
    sessionMinutes: TASK_LIMITS.sessionMs / 60_000,
    runMinutes: TASK_LIMITS.runMs / 60_000,
  };
}
