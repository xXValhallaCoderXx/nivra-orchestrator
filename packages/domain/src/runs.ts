import { z } from "zod";

/** Stable application statuses for any run, independent of a workflow's own stages (from Hird's run model). */
export const RunStatus = z.enum(["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunId = z.uuid();

export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
export const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.includes(status);

/** Which status changes are legal. Terminal statuses never change: the first recorded outcome wins. */
export const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_for_approval", "succeeded", "failed", "cancelled"],
  waiting_for_approval: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
export const canTransition = (from: RunStatus, to: RunStatus): boolean => ALLOWED_TRANSITIONS[from].includes(to);

/**
 * What a timeline entry is. `step.output` carries what a step found (as data); the `command.` types follow one
 * command an execution session ran.
 */
export const RunEventType = z.enum([
  "run.queued",
  "run.started",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "step.started",
  "step.succeeded",
  "step.failed",
  "step.cancelled",
  "step.output",
  "command.started",
  "command.finished",
]);
export type RunEventType = z.infer<typeof RunEventType>;

export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** One entry in a run's append-only timeline. `seq` starts at 1 and increases per run. */
export const RunEvent = z.strictObject({
  runId: z.uuid(),
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  type: RunEventType,
  stepId: z.string().nullable(),
  message: z.string(),
  data: JsonObject.nullable(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const WorkflowId = z.enum(["hello"]);
export type WorkflowId = z.infer<typeof WorkflowId>;

/**
 * The bootstrap's harmless run (B2): reports the engine, resolves the repository, reads git's version and status,
 * then optionally holds a child process for `holdMs`, so cancellation is exercised on every platform.
 */
export const HelloInput = z.strictObject({
  repoPath: z.string().min(1).max(4096),
  holdMs: z.number().int().min(0).max(600_000).default(0),
});
export type HelloInput = z.infer<typeof HelloInput>;

export const RunSummary = z.strictObject({
  id: z.uuid(),
  workflowId: WorkflowId,
  title: z.string(),
  status: RunStatus,
  input: z.unknown(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** A page of runs, newest first. `nextCursor` continues the list (an opaque row position, not a time). */
export const RunList = z.strictObject({
  runs: z.array(RunSummary),
  nextCursor: z.number().int().positive().nullable(),
});
export type RunList = z.infer<typeof RunList>;

/** Events after a cursor, plus the run's status so one poll answers "is it done?". */
export const RunEventsPage = z.strictObject({
  events: z.array(RunEvent),
  next: z.number().int().nonnegative(),
  status: RunStatus,
});
export type RunEventsPage = z.infer<typeof RunEventsPage>;
