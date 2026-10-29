import { createHash } from "node:crypto";
import { AcceptanceCase, TASK_RUN_BOUNDS, TASK_BRIEF_LIMITS, TASK_MODEL, TaskBrief, type ChatResult, type EnvironmentRef, type TaskEnvironment } from "@nivra/domain";
import { z } from "zod";
import { TASK_LIMITS, type BriefContent, type BriefFields, type BriefSource, type TaskState } from "../shared/ipc.ts";
import { planText } from "../shared/plans.ts";

/**
 * Native tasks and plans (D26, NIV-32), as plain functions: what a brief and a plan hold, how a plan is made from an
 * answer, how a brief is made directly or from a plan (the same shape either way), and which state changes are allowed.
 * A run of a task (D39) is sent the brief's own words and its acceptance cases, and its baseline checks and frozen files
 * when it has them (D41); its state never comes from a run yet.
 */

export const EXECUTION_POLICY = { concurrency: 1, network: "off", approval: "required" } as const;

export { TASK_LIMITS };

const Text = (max: number) => z.string().max(max);
const Items = z.array(z.string().trim().min(1).max(TASK_LIMITS.itemChars)).max(TASK_LIMITS.items);
const Line = z.strictObject({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() });
/** A brief's baseline selections and frozen files, exactly as a run's brief takes them (D41). */
const Baseline = TaskBrief.shape.baseline.unwrap();
const Frozen = TaskBrief.shape.frozen.unwrap();

export const BriefSourceSchema: z.ZodType<BriefSource> = z.strictObject({
  kind: z.literal("plan"),
  planId: z.string(),
  planLineage: z.string(),
  planVersion: z.number().int().positive(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  projectId: z.string().nullable(),
  headAtStart: z.string().nullable(),
  citations: z.array(Line),
});

export const BriefContentSchema: z.ZodType<BriefContent> = z.strictObject({
  goal: Text(TASK_LIMITS.textChars),
  acceptanceCriteria: Items,
  scope: Text(TASK_LIMITS.textChars),
  exclusions: Text(TASK_LIMITS.textChars),
  context: Text(TASK_LIMITS.contextChars),
  assumptions: Items,
  checks: Items,
  // A brief saved before acceptance cases existed has none (D39).
  acceptanceCases: z.array(AcceptanceCase).max(TASK_BRIEF_LIMITS.finalChecks).default([]),
  // A brief saved before baseline checks and frozen files has neither (D41).
  baseline: Baseline.default([]),
  frozen: Frozen.default([]),
  executionPolicy: z.strictObject({ concurrency: z.literal(1), network: z.literal("off"), approval: z.literal("required") }),
  sources: z.array(BriefSourceSchema).max(10),
  revalidate: z.array(z.enum(["context", "assumptions"])),
});

/** What the person writes in a brief, checked for size; the rest is Nivra's. Baseline checks and frozen files left out are none. */
export const BriefFieldsSchema: z.ZodType<BriefFields> = z.strictObject({
  goal: Text(TASK_LIMITS.textChars).transform((text) => text.trim()),
  acceptanceCriteria: Items,
  scope: Text(TASK_LIMITS.textChars).transform((text) => text.trim()),
  exclusions: Text(TASK_LIMITS.textChars).transform((text) => text.trim()),
  context: Text(TASK_LIMITS.contextChars).transform((text) => text.trim()),
  assumptions: Items,
  checks: Items,
  acceptanceCases: z.array(AcceptanceCase).max(TASK_BRIEF_LIMITS.finalChecks),
  baseline: Baseline.default([]),
  frozen: Frozen.default([]),
});

/** A plan as one immutable version: its text, and where it came from. */
export interface PlanContent {
  text: string;
  conversationId: string;
  messageId: string;
  runId: string | null;
  /** The conversation's project; null for a general one. */
  projectId: string | null;
  kind: "general" | "repository";
  headAtStart: string | null;
  citations: Array<{ path: string; startLine: number; endLine: number }>;
  assumptions: string[];
}

/**
 * A plan from an answer: a general answer's text; a repository answer's reply, what it proposes with each proposal's
 * detail, and what it assumed. Only citations to lines the model was shown come with it.
 */
export function planFromAnswer(reply: ChatResult, at: { conversationId: string; messageId: string; runId: string | null; projectId: string | null }): PlanContent {
  if (reply.kind === "general") return { text: planText(reply), ...at, kind: "general", headAtStart: null, citations: [], assumptions: [] };
  const shown = [...reply.evidence, ...reply.proposals].flatMap((item) => item.citations.filter((citation) => citation.checked).map(({ path, startLine, endLine }) => ({ path, startLine, endLine })));
  return { text: planText(reply), ...at, kind: "repository", headAtStart: reply.headAtStart, citations: shown, assumptions: reply.assumptions };
}

/** A brief from what the person wrote, with Nivra's fixed policy. A direct task has no sources. */
export function briefFrom(fields: BriefFields, sources: BriefSource[] = []): BriefContent {
  return { ...fields, baseline: fields.baseline ?? [], frozen: fields.frozen ?? [], executionPolicy: { ...EXECUTION_POLICY }, sources, revalidate: [] };
}

/** The source a brief made from a plan version records. */
export function sourceFrom(plan: { id: string; lineageId: string; version: number; content: PlanContent }): BriefSource {
  return {
    kind: "plan",
    planId: plan.id,
    planLineage: plan.lineageId,
    planVersion: plan.version,
    conversationId: plan.content.conversationId,
    messageId: plan.content.messageId,
    projectId: plan.content.projectId,
    headAtStart: plan.content.headAtStart,
    citations: plan.content.citations,
  };
}

/**
 * The brief for a task given another repository, or none (D26): what came from another project's conversation (its
 * sources, the context and the assumptions) is cleared and marked to be written again for this one. A brief with
 * nothing from another project needs no new version.
 */
export function briefForRepository(brief: BriefContent, projectId: string | null): BriefContent | null {
  const elsewhere = (source: BriefSource) => source.projectId !== null && source.projectId !== projectId;
  if (!brief.sources.some(elsewhere)) return null;
  return { ...brief, sources: brief.sources.filter((source) => !elsewhere(source)), context: "", assumptions: [], revalidate: ["context", "assumptions"] };
}

/** Whether a brief is complete enough for its task to be ready: a goal and at least one acceptance criterion. */
export const briefIsReady = (brief: BriefContent): boolean => brief.goal.trim().length > 0 && brief.acceptanceCriteria.length > 0;

/**
 * The state a task moves to when the person asks for `requested`, or why it can't. Ready needs a goal and a criterion;
 * completed is the person's acceptance of a ready task; reopening goes back to draft. Active and review can't be set
 * by hand.
 */
export function nextState(current: TaskState, requested: TaskState, brief: BriefContent): TaskState {
  if (requested === "active" || requested === "review") throw new Error(`A task can't be marked ${requested === "active" ? "active" : "in review"} by hand.`);
  if (requested === current) return current;
  if (requested === "ready") {
    if (current !== "draft") throw new Error("Only a draft can be marked ready.");
    if (!briefIsReady(brief)) throw new Error("A task is ready once its brief has a goal and at least one acceptance criterion. Add them, then mark it ready.");
    return "ready";
  }
  if (requested === "completed") {
    if (current !== "ready") throw new Error("Mark the task ready before you complete it.");
    return "completed";
  }
  // Back to draft: a ready task to change it, or a completed one reopened.
  return "draft";
}

/** Why a brief can't be run without an acceptance case: Nivra judges a run by its cases alone (D39). */
export const NO_CASE = "Add an acceptance case, so Nivra can check the result itself: a command, and exactly what it must print and the exit code it must give.";

/**
 * What a run of this brief is sent (D39): its own words, its checks as the repository's commands, and its acceptance
 * cases, with its baseline checks and frozen files only when it has them, so a brief without them digests as it did
 * before (D41); or why it can't run as it is, in plain words. Assumptions and sources stay with the task.
 */
export function taskBriefOf(content: BriefContent): { brief: TaskBrief } | { blocked: string } {
  if (content.acceptanceCases.length === 0) return { blocked: NO_CASE };
  const total = content.acceptanceCases.length + content.checks.length;
  if (total > TASK_BRIEF_LIMITS.finalChecks) {
    return { blocked: `A run takes at most ${TASK_BRIEF_LIMITS.finalChecks} acceptance cases and checks in all, and this brief has ${total}. Remove some, then run it.` };
  }
  const parsed = TaskBrief.safeParse({
    goal: content.goal,
    acceptanceCriteria: content.acceptanceCriteria,
    scope: content.scope,
    exclusions: content.exclusions,
    context: content.context,
    checks: content.checks,
    acceptanceCases: content.acceptanceCases.map(({ name, command, expectedOutput, expectedExitCode }) => ({ name, command, expectedOutput, expectedExitCode })),
    ...(content.baseline.length
      ? {
          // Each as written, so one with both its output and a pattern, or neither, is refused rather than repaired.
          baseline: content.baseline.map(({ name, command, expectedExitCode, expectedOutput, outputPattern }) => ({
            name,
            command,
            expectedExitCode,
            ...(expectedOutput !== undefined ? { expectedOutput } : {}),
            ...(outputPattern !== undefined ? { outputPattern } : {}),
          })),
        }
      : {}),
    ...(content.frozen.length ? { frozen: content.frozen } : {}),
  });
  return parsed.success ? { brief: parsed.data } : { blocked: "This brief can't be run as it is: a check or a case holds something a command can't carry. Edit the brief, then run it." };
}

/**
 * A run preview's fingerprint (D39): SHA-256 of a fixed-order, versioned JSON array of what the run would be bound to.
 * The host works it out from its records as they are and the snapshot's own fingerprint, which the engine checks again.
 * A run from a prepared environment is bound to it too, by its image and what binds that (D41): the v2 form. A run from
 * a recipe's environment is bound by both its digests, its image, its setup files' digest, the Nebius project and the
 * target (NIV-55): the v3 form. A run with none keeps the v1 form exactly, and one from D41's the v2 form.
 */
export function taskRunFingerprint(parts: {
  taskId: string;
  briefId: string;
  briefVersion: number;
  briefDigest: string;
  projectId: string;
  targetId: string;
  sharing: { modelContext: boolean; cloudExecution: boolean };
  snapshot: string;
  requiredChecks?: { finalChecks: number; baselineChecks: number; comparisonChecks: number };
  environment?: Pick<TaskEnvironment, "image" | "inputsDigest" | "projectFingerprint"> | EnvironmentRef | null;
}): string {
  const bound = [parts.taskId, parts.briefId, parts.briefVersion, parts.briefDigest, parts.projectId, parts.targetId, parts.sharing.modelContext, parts.sharing.cloudExecution, parts.snapshot];
  const { environment } = parts;
  const canonical = !environment
    ? ["nivra.task-run-preview.v1", ...bound]
    : "format" in environment
      ? ["nivra.task-run-preview.v3", ...bound, environment.recipe, environment.verified, environment.image, environment.configuration, environment.projectFingerprint, environment.target]
      : ["nivra.task-run-preview.v2", ...bound, environment.image, environment.inputsDigest, environment.projectFingerprint];
  const checks = parts.requiredChecks;
  const approved = checks ? ["nivra.task-run-preview.v4", canonical, "required-checks-v1", checks,
    3 + TASK_RUN_BOUNDS.writes + TASK_RUN_BOUNDS.runs + checks.finalChecks + checks.baselineChecks + checks.comparisonChecks,
    TASK_RUN_BOUNDS] : canonical;
  return createHash("sha256").update(JSON.stringify(approved)).digest("hex");
}

/** What a run sends to each service, in plain words (D39). */
export const TASK_SENDS = {
  tokenFactory: [
    "The brief: its goal, acceptance criteria, scope, exclusions and context, with its acceptance cases and checks, and any baseline checks and frozen files.",
    "The names of the commit's files, the files the worker reads, the lines its searches find, and what the cases and checks it runs print.",
    "Nivra's instructions to the worker, and the tools it may use.",
    `All of it to one model, ${TASK_MODEL}. If Token Factory doesn't offer your key that model, the run stops before any request to a model; no other model stands in.`,
  ],
  nebius: [
    "The commit's files, as counted above: never your uncommitted work, nor the files left out.",
    "Everything the worker writes, as the arguments of the commands that write it.",
    "The commands of the cases, the checks and any baseline checks, and Nivra's own commands that prepare, write, look for programs and collect.",
  ],
} as const;

/** What each service keeps of a run, in plain words: Nebius in its own terms, and its operation records as the probe showed. */
export const TOKEN_FACTORY_KEEPS = "Token Factory keeps what it receives, under its own terms. What was sent can't be withdrawn.";
export const nebiusKeeps = (retention: string): string => `${retention} Nebius keeps each operation's arguments in its records, so what the worker writes stays there too.`;
