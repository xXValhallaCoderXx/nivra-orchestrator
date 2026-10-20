import type { ChatResult } from "@nivra/domain";
import { z } from "zod";
import { TASK_LIMITS, type BriefContent, type BriefFields, type BriefSource, type TaskState } from "../shared/ipc.ts";

/**
 * Native tasks and plans (D26, NIV-32), as plain functions: what a brief and a plan hold, how a plan is made from an
 * answer, how a brief is made directly or from a plan (the same shape either way), and which state changes are allowed.
 * Running a task isn't available yet, so no state here comes from a run.
 */

export const RUN_UNAVAILABLE =
  "Running tasks isn't available yet. Nivra first needs a sandbox that isolates the code it runs, an agent that makes the change inside it, and a review step where you approve the change before it reaches your files. Until then, nothing runs.";

export const EXECUTION_POLICY = { concurrency: 1, network: "off", approval: "required" } as const;

export { TASK_LIMITS };

const Text = (max: number) => z.string().max(max);
const Items = z.array(z.string().trim().min(1).max(TASK_LIMITS.itemChars)).max(TASK_LIMITS.items);
const Line = z.strictObject({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() });

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
  executionPolicy: z.strictObject({ concurrency: z.literal(1), network: z.literal("off"), approval: z.literal("required") }),
  sources: z.array(BriefSourceSchema).max(10),
  revalidate: z.array(z.enum(["context", "assumptions"])),
});

/** What the person writes in a brief, checked for size; the rest is Nivra's. */
export const BriefFieldsSchema: z.ZodType<BriefFields> = z.strictObject({
  goal: Text(TASK_LIMITS.textChars).transform((text) => text.trim()),
  acceptanceCriteria: Items,
  scope: Text(TASK_LIMITS.textChars).transform((text) => text.trim()),
  exclusions: Text(TASK_LIMITS.textChars).transform((text) => text.trim()),
  context: Text(TASK_LIMITS.contextChars).transform((text) => text.trim()),
  assumptions: Items,
  checks: Items,
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
  if (reply.kind === "general") return { text: reply.text, ...at, kind: "general", headAtStart: null, citations: [], assumptions: [] };
  const parts = [reply.answer];
  if (reply.proposals.length) parts.push(`Proposed:\n${reply.proposals.map((p) => `- ${p.title}: ${p.detail}`).join("\n")}`);
  if (reply.assumptions.length) parts.push(`Assumed:\n${reply.assumptions.map((a) => `- ${a}`).join("\n")}`);
  const shown = [...reply.evidence, ...reply.proposals].flatMap((item) => item.citations.filter((citation) => citation.checked).map(({ path, startLine, endLine }) => ({ path, startLine, endLine })));
  return { text: parts.join("\n\n"), ...at, kind: "repository", headAtStart: reply.headAtStart, citations: shown, assumptions: reply.assumptions };
}

/** A brief from what the person wrote, with Nivra's fixed policy. A direct task has no sources. */
export function briefFrom(fields: BriefFields, sources: BriefSource[] = []): BriefContent {
  return { ...fields, executionPolicy: { ...EXECUTION_POLICY }, sources, revalidate: [] };
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
 * completed is the person's acceptance of a ready task; reopening goes back to draft. Active and review come only from
 * attempts, which can't start yet.
 */
export function nextState(current: TaskState, requested: TaskState, brief: BriefContent): TaskState {
  if (requested === "active" || requested === "review") throw new Error(`${RUN_UNAVAILABLE.split(".")[0]}, so a task can't be ${requested === "active" ? "active" : "in review"}.`);
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
