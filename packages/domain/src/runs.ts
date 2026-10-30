import { MAX_CHOICES, MAX_CHOICE_CHARS } from "./context.ts";
import { z } from "zod";
import { RunRoute, RunUsage } from "./models.ts";

/** Stable application statuses for any run, independent of a workflow's own stages (from Hird's run model). */
export const RunStatus = z.enum(["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunId = z.uuid();

export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
export const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.includes(status);

/**
 * Which status changes are legal. Terminal statuses never change: the first recorded outcome wins. A queued run can
 * fail without starting when the engine that accepted it stopped (D21).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled", "failed"],
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
  "model.call",
  "tool.called",
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

export const WorkflowId = z.enum(["hello", "explain", "chat", "review", "sandbox", "research", "task", "environment", "coach", "companion", "planning"]);
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

/** The most choices one explanation can carry, and the longest each can be (NIV-11, D23). */
export { MAX_CHOICES, MAX_CHOICE_CHARS } from "./context.ts";

/**
 * Explain a repository with evidence (NIV-6, NIV-9). The question is stored with the run, masked, but never handed to
 * Mastra, which stores step data as it is (D22): its steps get only the path. Choices are the person's explicit
 * decisions for this task (NIV-11, D23): they outrank the repository and every preference, for this run only, and are
 * never saved to the engineer's profile.
 */
export const ExplainInput = z.strictObject({
  repoPath: z.string().min(1).max(4096),
  /** Empty asks for the default: the repository's stack, structure and conventions. */
  question: z.string().max(2_000).default(""),
  choices: z
    .array(z.string().trim().min(1).max(MAX_CHOICE_CHARS))
    .max(MAX_CHOICES)
    .refine((choices) => new Set(choices).size === choices.length, "Each choice appears once.")
    .default([]),
});
export type ExplainInput = z.infer<typeof ExplainInput>;

/**
 * An explain run's input as the engine reads it back from its store (D23). The store keeps it masked, and masking can
 * lengthen text (a key becomes `[secret:NEBIUS_API_KEY]`) or make two choices the same, so only its shape is checked:
 * what `runs.start` accepted stays accepted.
 */
export const StoredExplainInput = z.object({
  repoPath: z.string().min(1),
  question: z.string().default(""),
  choices: z.array(z.string()).max(MAX_CHOICES).default([]),
});
export type StoredExplainInput = z.infer<typeof StoredExplainInput>;

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
  /** Measured with a monotonic clock while the run was going; null until it ends. */
  durationMs: z.number().int().nonnegative().nullable(),
  usage: RunUsage.nullable(),
  route: RunRoute.nullable(),
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
