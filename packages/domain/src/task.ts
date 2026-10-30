import { z } from "zod";
import { PreferenceSnapshot, RunChoices } from "./context.ts";
import { EnvironmentRef, TaskEnvironment } from "./environment.ts";
import { ModelFailureKind, RunRoute, RunUsage } from "./models.ts";
import { SandboxCleanup, SandboxStep, SandboxStopCode, SnapshotPreview, TargetName } from "./sandbox.ts";

/**
 * A task run (NIV-7, D39): one ready task's brief, one worker in a Nebius sandbox with networking off, and a change
 * the engine has checked. The worker edits a copy of one commit, reads files from the engine's own copy of it, and runs
 * only the brief's own acceptance cases and repository checks, by number: it never chooses a command. The verdict comes
 * from complete passing acceptance cases and required repository checks, compared by the engine outside every
 * process that ran the workspace's code. Before-change observations explain failures but never waive them.
 *
 * Both consents travel in the run's context, held in memory with the brief (D21): the project's model sharing (file
 * contents go to Token Factory) and its uploads (the commit goes to Nebius). Neither stands in for the other. The input
 * is stored with the run, masked, and binds it to the preview the person saw and to the brief version, by digest.
 */

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const count = z.number().int().nonnegative();
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const nonBlank = (text: string) => text.trim().length > 0;
const noNul = (text: string) => !text.includes("\0");

/** What one brief may ask of a run (D39). The host's own limits on a brief are the same or tighter. */
export const TASK_BRIEF_LIMITS = {
  /** Acceptance cases and repository checks together: each runs once more at the end, from the collected workspace. */
  finalChecks: 4,
  caseNameChars: 200,
  commandChars: 1_000,
  /** In bytes of UTF-8. */
  expectedOutputBytes: 4_096,
  goalChars: 4_000,
  criteria: 20,
  criterionChars: 1_000,
  scopeChars: 4_000,
  contextChars: 20_000,
  /** Baseline selections (D41): each runs once before the model, with networking off. */
  baseline: 3,
  /** Frozen files (D41): the worker can't write them, and the result counts only when they are unchanged. */
  frozen: 20,
  /** A baseline selection's output pattern, in characters, and the most of its output it is matched against. */
  patternChars: 500,
  patternInputBytes: 16_384,
} as const;

/** A command a run may run, as `/bin/sh -c` gets it: as written, with no NUL, which no argument can hold. */
const Command = z.string().min(1).max(TASK_BRIEF_LIMITS.commandChars).refine(nonBlank, "A command can't be blank.").refine(noNul, "A command can't hold a NUL character.");

/**
 * An acceptance case (D39): a command, run by `/bin/sh -c` in the workspace, and the exact output and exit code it must
 * give. It is frozen with the brief, so the worker can't change what it is judged by.
 */
export const AcceptanceCase = z.strictObject({
  name: z.string().min(1).max(TASK_BRIEF_LIMITS.caseNameChars).refine(nonBlank, "A case needs a name."),
  command: Command,
  /** Exactly what the command must print on its standard output, trailing newlines included. */
  expectedOutput: z
    .string()
    .refine((text) => utf8Bytes(text) <= TASK_BRIEF_LIMITS.expectedOutputBytes, `A case's expected output can be at most ${TASK_BRIEF_LIMITS.expectedOutputBytes} bytes.`)
    .refine(noNul, "A case's expected output can't hold a NUL character."),
  expectedExitCode: z.number().int().min(0).max(255),
});
export type AcceptanceCase = z.infer<typeof AcceptanceCase>;

/**
 * A baseline selection (D41): a command run once before the model, in the commit as it is, with networking off, and
 * what it must give there: its exit code, and either its exact output or a pattern its whole output must match. A
 * selection that fails for the bug the task fixes says so here, so an expected failure is told apart from a check that
 * can't run. A run whose selections don't give what the brief expects stops before the model.
 */
export const BaselineSelection = z
  .strictObject({
    name: z.string().min(1).max(TASK_BRIEF_LIMITS.caseNameChars).refine(nonBlank, "A selection needs a name."),
    command: Command,
    expectedExitCode: z.number().int().min(0).max(255),
    /** Exactly what it must print, trailing newlines included; or `outputPattern`, never both. */
    expectedOutput: z
      .string()
      .refine((text) => utf8Bytes(text) <= TASK_BRIEF_LIMITS.expectedOutputBytes, `A selection's expected output can be at most ${TASK_BRIEF_LIMITS.expectedOutputBytes} bytes.`)
      .refine(noNul, "A selection's expected output can't hold a NUL character.")
      .optional(),
    /** A regular expression its whole output must match: Nivra anchors it at both ends (`baselinePattern`). */
    outputPattern: z
      .string()
      .min(1)
      .max(TASK_BRIEF_LIMITS.patternChars)
      .refine((pattern) => {
        try {
          baselinePattern(pattern);
          return true;
        } catch {
          return false;
        }
      }, "A selection's pattern must be a valid regular expression.")
      .optional(),
  })
  .refine((selection) => (selection.expectedOutput === undefined) !== (selection.outputPattern === undefined), "A selection gives either its exact output or a pattern, not both.");
export type BaselineSelection = z.infer<typeof BaselineSelection>;

/**
 * A baseline selection's pattern as Nivra matches it: against the whole output, anchored at both ends, `.` matching a
 * line break too. `a|b` is the whole output being `a` or `b`, never one that merely holds either. The pattern must be a
 * regular expression on its own first, so it can't close the anchoring group (`x)|(?:y` would): it throws otherwise.
 */
export const baselinePattern = (pattern: string): RegExp => {
  new RegExp(pattern, "s");
  return new RegExp(`^(?:${pattern})$`, "s");
};

/** A frozen file: a path in the commit, relative to the picked folder, as Git names it. */
const FrozenPath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((path) => !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === ".."), "A frozen file is a path inside the folder, such as tests/regression.test.ts.")
  .refine(noNul, "A frozen file's path can't hold a NUL character.");

/**
 * What a run is asked to do, exactly as frozen: the brief version's goal, criteria, scope and context for the worker,
 * its repository checks, and at least one acceptance case; and, when the brief has them, its baseline selections and
 * frozen files (D41). No defaults and no transforms, so its digest covers it.
 */
export const TaskBrief = z
  .strictObject({
    goal: z.string().max(TASK_BRIEF_LIMITS.goalChars).refine(nonBlank, "A task needs a goal."),
    acceptanceCriteria: z.array(z.string().max(TASK_BRIEF_LIMITS.criterionChars)).max(TASK_BRIEF_LIMITS.criteria),
    scope: z.string().max(TASK_BRIEF_LIMITS.scopeChars),
    exclusions: z.string().max(TASK_BRIEF_LIMITS.scopeChars),
    context: z.string().max(TASK_BRIEF_LIMITS.contextChars),
    /** Repository checks: every listed command is required for new runs. */
    checks: z.array(Command).max(TASK_BRIEF_LIMITS.finalChecks - 1),
    acceptanceCases: z.array(AcceptanceCase).min(1).max(TASK_BRIEF_LIMITS.finalChecks),
    baseline: z.array(BaselineSelection).max(TASK_BRIEF_LIMITS.baseline).optional(),
    frozen: z
      .array(FrozenPath)
      .max(TASK_BRIEF_LIMITS.frozen)
      .refine((paths) => new Set(paths).size === paths.length, "Each frozen file is named once.")
      .optional(),
  })
  .refine((brief) => brief.acceptanceCases.length + brief.checks.length <= TASK_BRIEF_LIMITS.finalChecks, `A run takes at most ${TASK_BRIEF_LIMITS.finalChecks} acceptance cases and repository checks in all.`);
export type TaskBrief = z.infer<typeof TaskBrief>;

/**
 * A brief's fingerprint: SHA-256, in hex, of a fixed-order, versioned JSON array of everything it holds, its cases
 * included. The host and the engine each work it out, and a run whose brief isn't the one named is refused. A brief
 * with no baseline selection and no frozen file digests as it did before D41.
 */
export async function taskBriefDigest(brief: TaskBrief): Promise<string> {
  const baseline = brief.baseline ?? [];
  const frozen = brief.frozen ?? [];
  const extended = baseline.length > 0 || frozen.length > 0;
  const canonical = [
    extended ? "nivra.task-brief.v2" : "nivra.task-brief.v1",
    brief.goal,
    brief.acceptanceCriteria,
    brief.scope,
    brief.exclusions,
    brief.context,
    brief.checks,
    brief.acceptanceCases.map((given) => [given.name, given.command, given.expectedOutput, given.expectedExitCode]),
    ...(extended ? [baseline.map((given) => [given.name, given.command, given.expectedExitCode, given.expectedOutput ?? null, given.outputPattern ?? null]), frozen] : []),
  ];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a task run gets besides its input (D21): held in the engine's memory for the run, never stored. */
export const TaskContext = z.strictObject({
  sharing: z.strictObject({ modelContext: z.boolean(), cloudExecution: z.boolean() }),
  brief: TaskBrief,
  preferences: PreferenceSnapshot,
  choices: RunChoices,
});
export type TaskContext = z.infer<typeof TaskContext>;

/**
 * A task run's input. `project` and `target` bind what comes back to where it may go (D34); `preview` is the
 * fingerprint of the snapshot the person was shown, and a commit that no longer matches it is refused before the upload.
 * The attempt is the run's request id: the host saves it before it sends the request (D26).
 */
export const TaskInput = z.strictObject({
  repoPath: z.string().min(1).max(4096),
  project: z.uuid(),
  target: TargetName,
  preview: Sha256Hex,
  taskId: z.uuid(),
  briefVersion: z.number().int().positive(),
  /** `taskBriefDigest` of the context's brief, checked before anything is sent. */
  briefDigest: Sha256Hex,
  preferencesDigest: Sha256Hex,
  choicesDigest: Sha256Hex,
  /**
   * The prepared environment the run starts from: D41's single setup, or a project-driven recipe's (NIV-55). Without
   * one, the run starts from Nivra's own base image.
   */
  environment: z.union([TaskEnvironment, EnvironmentRef]).optional(),
});
export type TaskInput = z.infer<typeof TaskInput>;

/** A task run's input as the engine reads it back from its store: masked, so only its shape is checked. */
export const StoredTaskInput = z.object({
  repoPath: z.string().min(1),
  project: z.string().min(1),
  target: z.string().min(1),
  preview: z.string().min(1),
  taskId: z.string().min(1),
  briefVersion: z.number().int().positive(),
  briefDigest: z.string().min(1),
  /** Absent only in historical records; every new request requires both. */
  preferencesDigest: z.string().min(1).optional(),
  choicesDigest: z.string().min(1).optional(),
  environment: z.union([z.object({ image: z.string().min(1), inputsDigest: z.string().min(1), projectFingerprint: z.string().min(1), node: z.string(), pnpm: z.string(), arch: z.string() }), EnvironmentRef]).optional(),
});
export type StoredTaskInput = z.infer<typeof StoredTaskInput>;

/**
 * The one model a task run uses (NIV-35, D50): Nemotron 3.5 Super VL, which replaces Nemotron 3 Super when Token
 * Factory retires it on 9 November 2026, and whose tool choice a check has seen honoured. The run takes it from Token
 * Factory's listing or stops at its model step, before any request to a model and before anything is uploaded: no
 * other model stands in. The run's preview names it.
 */
export const TASK_MODEL = "nvidia/Nemotron-3.5-Super-VL";

/**
 * A task run's bounds that no brief changes (D39, NIV-35): one source for the engine, which enforces them
 * (`TASK_LIMITS`, apps/engine/src/task/limits.ts), and for main, which shows them in Settings (getRunLimits). Times
 * come from the functions below, so every reader works them out the same way; a test pins each number on its own.
 */
export const TASK_RUN_BOUNDS = {
  /** Requests to the model in a run, the hand-in's among them. */
  modelRequests: 24,
  /** The output cap sent with each request; it counts the model's reasoning tokens too (`max_completion_tokens`). */
  outputTokensPerRequest: 8_000,
  /** The hand-in only calls submit with a short summary: its answer has a cap, and so a time, of its own. */
  handInOutputTokens: 1_500,
  /**
   * A request's time holds the whole of an answer of its cap at the slowest rate the live runs saw, 10 tokens a second
   * (run 3's ninth request gave 634 in 58.5 s), with time for its input and the queue besides. A request isn't streamed,
   * so its reply's headers come with its whole answer.
   */
  tokensPerSecond: 10,
  requestInputMs: 30_000,
  /** An estimated admission budget for the run's input, not a cap (D30). */
  estimatedInputTokens: 480_000,
  /** Tool calls the model may make, of which writes and runs of a case or a check are operations. */
  toolCalls: 48,
  writes: 8,
  runs: 4,
  /** Each command's time, a case's or a check's. */
  checkSeconds: 60,
  /** The sandbox session, from when it opens, and the whole run, from when it starts. */
  sessionMinutes: 45,
  runMinutes: 58,
} as const;

/** A request's time from its output cap: 830,000 ms for 8,000 tokens, and 180,000 ms for the hand-in's 1,500. */
export const requestMsFor = (outputTokens: number): number => TASK_RUN_BOUNDS.requestInputMs + (outputTokens / TASK_RUN_BOUNDS.tokensPerSecond) * 1000;

/** Minutes in milliseconds, for the session's and the run's. */
export const minutesMs = (minutes: number): number => minutes * 60_000;

/** A run's bounds, as the engine enforces them (D39), for the person to see before it starts. */
export const TaskRunLimits = z.strictObject({
  /** Hard limits: the model's requests, each request's time, and the output cap sent with each. */
  modelRequests: count,
  requestSeconds: count,
  outputTokensPerRequest: count,
  /** An estimated admission budget for the run's input, not a ceiling (D30). */
  estimatedInputTokens: count,
  toolCalls: count,
  writes: count,
  writeBytes: count,
  /** Runs of a case or a check by the worker, besides the final ones. */
  runs: count,
  /** The brief's baseline selections, each run once before the model (D41). */
  baselineChecks: count,
  /** Observed repository checks before worker edits; absent in historical limits. */
  comparisonChecks: count.optional(),
  /** Nebius operations at most: prepare, the toolchain probe, the writes, the runs, collect and the final checks. */
  operations: count,
  checkSeconds: count,
  /** The sandbox session, from when it opens, and the whole run, from when it starts. */
  sessionMinutes: count,
  runMinutes: count,
});
export type TaskRunLimits = z.infer<typeof TaskRunLimits>;

/**
 * What a task run of this checkout would send to Nebius, worked out on the engine that owns the checkout with no
 * network, with what the run is bound by. A commit that would be refused says why, naming the file: a preview is shown
 * to the person and never stored.
 */
export const TaskPreview = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    snapshot: SnapshotPreview,
    /** Each case's and check's program, as the toolchain probe looks for it before the model starts. */
    programs: z.array(z.string().max(128)).max(TASK_BRIEF_LIMITS.finalChecks),
    /** Cases and checks whose program can't be read from their first word: they run, and a missing one fails them. */
    unprobed: count,
    /**
     * The commit's files each acceptance case's command names: the worker can change them, and a case judges only what
     * its command prints, so the person is told before the run. `unclear` when Nivra can't read for sure which files
     * the command runs (an expansion, a substitution, a pattern, a quote it can't read).
     */
    caseFiles: z
      .array(z.strictObject({ number: z.number().int().min(1).max(TASK_BRIEF_LIMITS.finalChecks), files: z.array(z.string().max(1_024)).max(20), unclear: z.boolean().default(false) }))
      .max(TASK_BRIEF_LIMITS.finalChecks),
    /** The prepared environment the run would start from, checked against this commit's manifests (D41); null without one. */
    environment: TaskEnvironment.extend({ preparedAt: z.iso.datetime() }).nullable(),
    /** A project-driven recipe's environment instead (NIV-55), checked against this commit's setup files. D41's field is then null. */
    environmentRef: EnvironmentRef.nullable().optional(),
    /** The brief's frozen files, as this commit holds them: the worker can't write them, and the result counts only when they are unchanged. */
    frozen: z.array(z.strictObject({ path: z.string().max(1_024), sha256: Sha256Hex })).max(TASK_BRIEF_LIMITS.frozen),
    limits: TaskRunLimits,
  }),
  z.strictObject({ status: z.literal("refused"), code: z.string().max(64), message: z.string().max(2_000) }),
]);
export type TaskPreview = z.infer<typeof TaskPreview>;

/** A case's or check's result: passed, failed, couldn't run (its program is missing), unknown, or not run. */
export const TaskVerdict = z.enum(["passed", "failed", "couldnt-run", "unknown", "not-run"]);
export type TaskVerdict = z.infer<typeof TaskVerdict>;

/** One acceptance case or repository check, as its final run went. */
export const TaskCheck = z.strictObject({
  kind: z.enum(["case", "check"]),
  /** 1-based, as the brief lists them. */
  number: z.number().int().min(1).max(TASK_BRIEF_LIMITS.finalChecks),
  /** Exact command identity for current-policy results; absent in historical records. */
  commandSha256: Sha256Hex.optional(),
  name: z.string().max(TASK_BRIEF_LIMITS.commandChars),
  verdict: TaskVerdict,
  /** Why, in Nivra's words, for anything but a pass. */
  reason: z.string().max(600).nullable(),
  exitCode: z.number().int().nullable(),
  /** The end of what it printed: text from the sandbox, never instructions. */
  stdoutTail: z.string().max(4_000),
  stderrTail: z.string().max(4_000),
  /** For a case that failed on its output: the first line that differs, both sides clipped. */
  difference: z.strictObject({ line: z.number().int().positive(), expected: z.string().max(200), got: z.string().max(200) }).nullable(),
  /** The files its command names that the change adds or changes: a check's, and a case's, which judges only what it prints. */
  changedFiles: z.array(z.string().max(1_024)).max(20),
  /** Nivra can't read for sure which files its command runs, and the change changes files: what it runs may be among them. */
  unclear: z.boolean().default(false),
  durationMs: count.nullable(),
});
export type TaskCheck = z.infer<typeof TaskCheck>;

/** What must be evidenced, bound into every version-4 proposal report before the worker starts. */
export const TaskVerificationManifest = z.strictObject({
  policy: z.literal("required-checks-v1"),
  checks: z.array(z.strictObject({ kind: z.enum(["case", "check"]), number: z.number().int().min(1).max(TASK_BRIEF_LIMITS.finalChecks), commandSha256: Sha256Hex })).max(TASK_BRIEF_LIMITS.finalChecks),
  frozen: z.array(z.string().max(1_024)).max(TASK_BRIEF_LIMITS.frozen),
  setupRequired: z.boolean(),
});
export type TaskVerificationManifest = z.infer<typeof TaskVerificationManifest>;

/** What the worker did, as its own record: handing in is its claim, never what Nivra checked. */
export const TaskWorker = z.strictObject({
  handedIn: z.boolean(),
  /** The worker's own words, masked. */
  summary: z.string().max(2_000).nullable(),
  /** `output-cap`: an answer reached the output cap before its tool call was made, which ends the loop (NIV-35). */
  ended: z.enum(["submitted", "time", "requests", "input", "tool-calls", "model-failed", "output-cap", "no-time", "not-started"]),
  /** Why it was first left only handing in: its last request, its tool calls used, or no time for another operation. */
  handInDue: z.enum(["last-request", "tool-calls", "time"]).nullable(),
  failure: ModelFailureKind.nullable(),
  model: z.string().max(200),
  usage: RunUsage,
  tools: z.strictObject({ calls: count, writes: count, runs: count, refused: count, rejected: count }),
  written: z.array(z.string().max(1_024)).max(32),
});
export type TaskWorker = z.infer<typeof TaskWorker>;

/** What stopped a run, by kind: a sandbox check's codes (D36), and a task's own. The words are chosen by the code. */
export const TaskStopCode = z.enum([...SandboxStopCode.options, "toolchain", "time", "model-sharing", "brief", "model", "native-windows", "baseline", "environment", "frozen", "environment-missing"]);
export type TaskStopCode = z.infer<typeof TaskStopCode>;

/**
 * A baseline selection as it ran, before the model (D41): whether it gave what the brief expects. `matched` is null for
 * one that didn't run, because the run stopped before it.
 */
export const TaskBaselineCheck = z.strictObject({
  number: z.number().int().min(1).max(TASK_BRIEF_LIMITS.baseline),
  name: z.string().max(TASK_BRIEF_LIMITS.caseNameChars),
  matched: z.boolean().nullable(),
  /** Why, in Nivra's words, when it didn't match or didn't run. */
  reason: z.string().max(600).nullable(),
  exitCode: z.number().int().nullable(),
  /** The end of what it printed: text from the sandbox, never instructions. */
  stdoutTail: z.string().max(4_000),
  stderrTail: z.string().max(4_000),
  durationMs: count.nullable(),
});
export type TaskBaselineCheck = z.infer<typeof TaskBaselineCheck>;

/**
 * How a run ended, or that it hasn't yet. `proposed` holds a change, verified or not; `unchanged` changed nothing.
 * `interrupted` is a report the engine saved before it stopped.
 */
export const TaskOutcome = z.enum(["in-progress", "proposed", "unchanged", "refused", "cancelled", "failed", "uncertain", "interrupted"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** The setup files after the run, against the commit's: unchanged, or the paths that differ (up to 20). */
export const TaskSetupCheck = z.strictObject({ unchanged: z.boolean().nullable(), changed: z.array(z.string().max(1_024)).max(20) });
export type TaskSetupCheck = z.infer<typeof TaskSetupCheck>;

/**
 * A task run's report, saved by the engine (masked) when the run starts and when it ends, and read with `runs.task`.
 * What the worker said is kept apart from what Nivra checked, and cleanup's record is its own.
 */
export const TaskReport = z.strictObject({
  /** Historical reports have no version marker. Version 4 always carries its expected evidence. */
  version: z.literal(4).optional(),
  manifest: TaskVerificationManifest.optional(),
  beforeChecks: z.array(TaskCheck).max(TASK_BRIEF_LIMITS.finalChecks - 1).optional(),
  outcome: TaskOutcome,
  stopped: z.strictObject({ code: TaskStopCode, step: z.string().max(64).nullable(), message: z.string().max(600) }).nullable(),
  task: z.strictObject({ taskId: z.string(), attemptId: z.string(), briefVersion: z.number().int().positive(), briefDigest: z.string() }),
  snapshot: z.strictObject({ baseline: z.string(), prefix: z.string(), fingerprint: Sha256Hex, files: count, archiveSha256: Sha256Hex }).nullable(),
  toolchain: z.array(z.strictObject({ program: z.string().max(128), finding: z.enum(["present", "missing", "unknown"]) })).max(TASK_BRIEF_LIMITS.finalChecks),
  /** The prepared environment the run started from (D41); null for a run on Nivra's own base image. */
  environment: TaskEnvironment.nullable().default(null),
  /** A project-driven recipe's environment the run started from (NIV-55); D41's field is then null. */
  environmentRef: EnvironmentRef.nullable().optional(),
  /**
   * The setup files in the collected workspace, compared with the commit's (NIV-55): any difference and the change
   * isn't verified. Null when the run has no prepared environment, or nothing was collected.
   */
  setup: TaskSetupCheck.nullable().optional(),
  /** The brief's baseline selections, as they ran before the model (D41). */
  baseline: z.array(TaskBaselineCheck).max(TASK_BRIEF_LIMITS.baseline).default([]),
  /** The bounds the run ran under, beside what it used (D41); null for a report kept from before, whose bounds weren't kept. */
  limits: TaskRunLimits.nullable().default(null),
  /** The frozen files in the collected workspace, each compared with the commit's: any difference and the change isn't verified. */
  frozen: z.array(z.strictObject({ path: z.string().max(1_024), unchanged: z.boolean().nullable() })).max(TASK_BRIEF_LIMITS.frozen).default([]),
  worker: TaskWorker.nullable(),
  checks: z.array(TaskCheck).max(TASK_BRIEF_LIMITS.finalChecks),
  /** The recorded verdict. Current approval is independently established from the hash-bound proposal report. */
  verified: z.boolean(),
  steps: z.array(SandboxStep).max(24),
  proposal: z.strictObject({ hash: Sha256Hex, patchSha256: Sha256Hex, patchBytes: count, files: count }).nullable(),
  /** The digest of the report bound into the proposal; null when the run stopped before it. */
  reportSha256: Sha256Hex.nullable(),
  cleanup: SandboxCleanup.nullable(),
  route: RunRoute.nullable(),
  request: z.strictObject({ runId: z.uuid(), clientRequestId: z.uuid() }),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
}).refine((report) => report.version !== 4 || (report.manifest !== undefined && report.beforeChecks !== undefined), "A version-4 report must retain its expected-check manifest and before-change observations.");
export type TaskReport = z.infer<typeof TaskReport>;

/** The most of a patch `runs.proposal` gives as text, in bytes: the stored bytes are exact, whatever is shown. */
export const PATCH_SHOWN_BYTES = 512 * 1024;

const PathState = z.strictObject({ mode: z.string().max(8), sha256: Sha256Hex });

/**
 * A run's proposal as the person reads it before deciding: its hash, the commit and folder it applies to, every path
 * it changes with its state before and after, and the patch as text, masked.
 */
export const TaskProposal = z.strictObject({
  hash: Sha256Hex,
  baseline: Commit,
  prefix: z.string().max(4_096),
  paths: z.array(z.strictObject({ path: z.string().max(4_096), change: z.enum(["added", "changed", "deleted"]), before: PathState.nullable(), after: PathState.nullable() })).max(500),
  patch: z.string(),
  patchBytes: count,
  /** The patch shown is cut at `PATCH_SHOWN_BYTES`. */
  truncated: z.boolean(),
});
export type TaskProposal = z.infer<typeof TaskProposal>;
