import { z } from "zod";
import { PreferencesReceived } from "./chat.ts";
import { PreferenceSnapshot } from "./context.ts";
import { ModelFailureKind, RunBudgetRecord, RunRoute, RunUsage } from "./models.ts";
import { TASK_BRIEF_LIMITS } from "./task.ts";

/**
 * The task readiness coach (NIV-53): one bounded model call, asked for by the person, that reads one task's brief and
 * hands back at most three questions and proposed changes to six of its fields, each with its reason. It changes
 * nothing itself. The person ticks the changes they want, and the host saves them as a new brief version, only from
 * the version the coach read. Its suggested checks are text the person may copy, never acceptance cases.
 *
 * The packet travels in the run's context, held in memory like the preference snapshot (D21), and is never stored
 * with the run: the run records the task's ids, the brief version and fingerprints, so a report is bound to exactly
 * what was sent. A report never says the brief is ready or correct: its outcome is about the answer only.
 */

/** The coach's specialist profile: Track B's catalogue holds its entry, and its wording and version are the coach's. */
export const COACH_PROFILE = { id: "task-readiness-coach", version: 1 } as const;

/** The tool the coach hands its answer in with, which stubs script against. */
export const COACH_TOOL = "submit_coaching";

/** The first line of the coach's instructions, which a stub reads to tell its request apart. */
export const coachRoleMarker = (): string => `Nivra coach role: ${COACH_PROFILE.id}`;

/**
 * A coach run's bounds, as the engine enforces them: one model request, after one listing of the models, inside one
 * deadline for the whole run, the listing included. The input budget is an estimate for admission, not a ceiling.
 */
export const COACH_RUN_LIMITS = {
  requests: 1,
  totalMs: 180_000,
  requestMs: 150_000,
  listMs: 30_000,
  outputTokensPerRequest: 4_000,
  estimatedInputTokens: 60_000,
} as const;

/**
 * The most characters the coach's instructions, its tool's definition and the message's framing take beyond the packet
 * and the preferences. The engine's tests hold its own to it, so the estimate the preview shows is never below the one
 * the engine admits the request by.
 */
export const COACH_FIXED_CHARS = 12_000;
/** What each preference adds besides its statement: its label and framing in the message. */
export const COACH_PREFERENCE_CHARS = 120;

/**
 * A coach request's estimated input tokens, as the preview counts them: characters divided by 3, plus 64 for the
 * message template (D30). An estimate for admission against `COACH_RUN_LIMITS.estimatedInputTokens`, never a count.
 */
export function coachEstimatedInputTokens(packetChars: number, preferenceStatements: readonly string[]): number {
  const preferences = preferenceStatements.reduce((sum, statement) => sum + statement.length + COACH_PREFERENCE_CHARS, 0);
  return Math.ceil((packetChars + preferences + COACH_FIXED_CHARS) / 3) + 64;
}

/** What one packet may hold: a saved brief's own limits, the counts of what isn't sent, and the optional context. */
export const COACH_PACKET_LIMITS = {
  titleChars: 200,
  goalChars: TASK_BRIEF_LIMITS.goalChars,
  scopeChars: TASK_BRIEF_LIMITS.scopeChars,
  contextChars: TASK_BRIEF_LIMITS.contextChars,
  /** Criteria, assumptions and checks: as many as a saved brief holds, each as long. */
  items: TASK_BRIEF_LIMITS.criteria,
  itemChars: TASK_BRIEF_LIMITS.criterionChars,
  cases: TASK_BRIEF_LIMITS.finalChecks,
  caseNameChars: TASK_BRIEF_LIMITS.caseNameChars,
  baseline: TASK_BRIEF_LIMITS.baseline,
  frozen: TASK_BRIEF_LIMITS.frozen,
  gaps: 12,
  gapChars: 300,
  missionNameChars: 200,
  missionParts: 8,
  missionLabelChars: 60,
  missionTextChars: 4_000,
  findings: 3,
  findingTitleChars: 160,
  findingDetailChars: 1_000,
  findingRecommendationChars: 500,
} as const;

const L = COACH_PACKET_LIMITS;
const count = z.number().int().nonnegative();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** The brief's fields as the coach knows them: the six it may propose changes to. */
export const CoachField = z.enum(["goal", "acceptanceCriteria", "scope", "exclusions", "context", "assumptions"]);
export type CoachField = z.infer<typeof CoachField>;

/** The fields a question may point the person to: the six, and the brief's checks and acceptance cases, which only the person writes. */
export const CoachQuestionField = z.enum([...CoachField.options, "checks", "acceptanceCases"]);
export type CoachQuestionField = z.infer<typeof CoachQuestionField>;

/** A task with no repository, or one linked to a repository. Neither carries a path or a project id: those stay in the host (D17). */
export const CoachScope = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("general") }), z.strictObject({ kind: z.literal("project") })]);
export type CoachScope = z.infer<typeof CoachScope>;

/** A gap Nivra's own rules found in the brief, without a model: its code, how much it matters, and Nivra's words for it. */
export const CoachGap = z.strictObject({
  code: z.string().regex(/^[a-z][a-z-]{0,39}$/),
  tier: z.enum(["needed", "could-help", "before-run"]),
  field: z.enum([...CoachField.options, "acceptanceCases"]),
  item: z.number().int().positive().nullable(),
  missing: z.string().min(1).max(L.gapChars),
});
export type CoachGap = z.infer<typeof CoachGap>;

/**
 * What the coach reads, exactly as sent: no defaults and no transforms, so its fingerprint covers what was sent. The
 * brief's own words, its checks and its cases' names; only how many baseline checks and frozen files it has; the gaps
 * Nivra's rules found; and, when the person ticks them, the task's mission and up to three findings about it.
 */
export const CoachPacket = z.strictObject({
  scope: CoachScope,
  task: z.strictObject({
    title: z.string().min(1).max(L.titleChars),
    briefVersion: z.number().int().positive(),
    goal: z.string().max(L.goalChars),
    acceptanceCriteria: z.array(z.string().max(L.itemChars)).max(L.items),
    scope: z.string().max(L.scopeChars),
    exclusions: z.string().max(L.scopeChars),
    context: z.string().max(L.contextChars),
    assumptions: z.array(z.string().max(L.itemChars)).max(L.items),
    checks: z.array(z.string().max(L.itemChars)).max(L.items),
    caseNames: z.array(z.string().max(L.caseNameChars)).max(L.cases),
    baselineChecks: z.number().int().min(0).max(L.baseline),
    frozenFiles: z.number().int().min(0).max(L.frozen),
  }),
  gaps: z.array(CoachGap).max(L.gaps),
  mission: z
    .strictObject({
      name: z.string().min(1).max(L.missionNameChars),
      version: z.number().int().positive(),
      parts: z
        .array(z.strictObject({ label: z.string().min(1).max(L.missionLabelChars), text: z.string().max(L.missionTextChars) }))
        .min(1)
        .max(L.missionParts),
    })
    .nullable(),
  findings: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(L.findingTitleChars),
        detail: z.string().max(L.findingDetailChars),
        recommendation: z.string().max(L.findingRecommendationChars),
        /** The brief version the review that found it read; null when it isn't known. */
        reviewedBriefVersion: z.number().int().positive().nullable(),
      }),
    )
    .max(L.findings),
});
export type CoachPacket = z.infer<typeof CoachPacket>;

const TIER: Readonly<Record<CoachGap["tier"], string>> = { needed: "needed", "could-help": "could help", "before-run": "only to run it" };
const FIELD: Readonly<Record<CoachGap["field"], string>> = {
  goal: "goal",
  acceptanceCriteria: "acceptance criteria",
  scope: "scope",
  exclusions: "exclusions",
  context: "context",
  assumptions: "assumptions",
  acceptanceCases: "acceptance cases",
};

/**
 * The packet as one text: what the coach reads, and what the person sees in the preview, from the same function. The
 * labels (C1, A1, G1, M, F1) are what the coach's answer refers to.
 */
export function renderCoachPacket(packet: CoachPacket): string {
  const { task } = packet;
  const text = (label: string, value: string) => `${label}:\n${value.trim() ? value : "(empty)"}`;
  const numbered = (label: string, prefix: string, items: readonly string[]) => `${label}:\n${items.length ? items.map((item, index) => `${prefix}${index + 1}. ${item}`).join("\n") : "(none)"}`;
  const listed = (label: string, items: readonly string[]) => `${label}:\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "(none)"}`;
  const parts = [
    `Task: ${task.title}`,
    `Brief version: v${task.briefVersion}. ${packet.scope.kind === "project" ? "The task is linked to a repository, whose files aren't included." : "The task isn't linked to a repository."}`,
    text("Goal", task.goal),
    numbered("Acceptance criteria", "C", task.acceptanceCriteria),
    text("Scope", task.scope),
    text("Exclusions", task.exclusions),
    text("Context", task.context),
    numbered("Assumptions", "A", task.assumptions),
    listed("Checks (the repository's own commands: reported by a run, never deciding it)", task.checks),
    listed("Acceptance cases (names only: their commands and expected output aren't included)", task.caseNames),
    `Baseline checks: ${task.baselineChecks}. Frozen files: ${task.frozenFiles}. (Counts only.)`,
    `What Nivra's own checks found, without a model:\n${
      packet.gaps.length ? packet.gaps.map((gap, index) => `G${index + 1} (${TIER[gap.tier]}; ${FIELD[gap.field]}${gap.item ? `, C${gap.item}` : ""}): ${gap.missing}`).join("\n") : "(nothing)"
    }`,
  ];
  if (packet.mission) {
    const { mission } = packet;
    parts.push(`Mission (M), v${mission.version}: ${mission.name}\n${mission.parts.map((part) => `${part.label}: ${part.text.trim() ? part.text : "(empty)"}`).join("\n")}`);
  }
  if (packet.findings.length) {
    parts.push(
      `Findings about this task that the person chose to include:\n${packet.findings
        .map((finding, index) => `F${index + 1}${finding.reviewedBriefVersion ? ` (its review read brief v${finding.reviewedBriefVersion})` : ""}: ${finding.title}\n${finding.detail}\nRecommendation: ${finding.recommendation}`)
        .join("\n\n")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * A packet's fingerprint: SHA-256, in hex, of a fixed-order, versioned JSON array of its content. The host and the
 * engine each work it out, so a report can show it read exactly what was sent while nothing stores the text.
 */
export async function coachPacketDigest(packet: CoachPacket): Promise<string> {
  const { task } = packet;
  const canonical = [
    "nivra.coach-packet.v1",
    packet.scope.kind,
    task.title,
    task.briefVersion,
    task.goal,
    task.acceptanceCriteria,
    task.scope,
    task.exclusions,
    task.context,
    task.assumptions,
    task.checks,
    task.caseNames,
    task.baselineChecks,
    task.frozenFiles,
    packet.gaps.map((gap) => [gap.code, gap.tier, gap.field, gap.item, gap.missing]),
    packet.mission ? [packet.mission.name, packet.mission.version, packet.mission.parts.map((part) => [part.label, part.text])] : null,
    packet.findings.map((finding) => [finding.title, finding.detail, finding.recommendation, finding.reviewedBriefVersion]),
  ];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a coach run gets besides its input (D21): held in the engine's memory for the run, never stored. */
export const CoachContext = z.strictObject({
  preferences: PreferenceSnapshot,
  sharing: z.strictObject({ modelContext: z.boolean() }),
  packet: CoachPacket,
});
export type CoachContext = z.infer<typeof CoachContext>;

/** Which coach profile a run asks for. The engine refuses one that isn't its own, before any request. */
export const CoachProfileRef = z.strictObject({ id: z.literal(COACH_PROFILE.id), version: z.number().int().positive() });
export type CoachProfileRef = z.infer<typeof CoachProfileRef>;

/**
 * A coach run's input, stored with the run (masked); Mastra gets none of it. The task, the brief version the packet
 * holds, and the fingerprints of the context binding (Track B's), the packet and the preferences; the profile; and, for
 * a live recipe, the only model the run may use, which the engine enforces before any inference request.
 */
export const CoachInput = z.strictObject({
  taskId: z.uuid(),
  briefId: z.uuid(),
  briefVersion: z.number().int().positive(),
  bindingDigest: Sha256Hex,
  packetDigest: Sha256Hex,
  preferencesDigest: Sha256Hex,
  profile: CoachProfileRef,
  model: z.string().min(1).max(200).optional(),
});
export type CoachInput = z.infer<typeof CoachInput>;

/** A coach run's input as the engine reads it back from its store: masked, so only its shape is checked. */
export const StoredCoachInput = z.object({
  taskId: z.string().min(1),
  briefId: z.string().min(1),
  briefVersion: z.number().int().positive(),
  bindingDigest: z.string().min(1),
  packetDigest: z.string().min(1),
  preferencesDigest: z.string().min(1),
  profile: z.object({ id: z.string().min(1), version: z.number().int().positive() }),
  model: z.string().min(1).optional(),
});
export type StoredCoachInput = z.infer<typeof StoredCoachInput>;

/** How large each part of a report may be. The engine drops what is over and counts it: a proposal is never clipped. */
export const COACH_REPORT_LIMITS = {
  summaryChars: 600,
  questions: 3,
  questionChars: 300,
  whyChars: 300,
  /** A new goal, scope or exclusions. */
  textChars: 1_000,
  /** What a change adds to the end of the context. */
  appendChars: 1_500,
  /** Items a change adds to the criteria or the assumptions, and items it rewords, each at most this long. */
  items: 5,
  rewords: 5,
  itemChars: 400,
  reasonChars: 300,
  refs: 4,
  checks: 2,
  checkNameChars: 200,
  commandChars: 500,
  outputChars: 500,
  unknowns: 4,
  unknownChars: 300,
  problems: 10,
  problemChars: 200,
  messageChars: 400,
} as const;

const R = COACH_REPORT_LIMITS;

/** What in the packet an answer may name: a gap (G1), a criterion (C1), an assumption (A1), the mission (M) or a finding (F1). */
export const CoachRef = z.string().regex(/^(G[1-9][0-9]?|C[1-9][0-9]?|A[1-9][0-9]?|M|F[1-3])$/);
const Refs = z.array(CoachRef).max(R.refs);

export const CoachQuestion = z.strictObject({
  /** Given by the engine, in the order the coach asked: Q1 to Q3. */
  id: z.enum(["Q1", "Q2", "Q3"]),
  text: z.string().min(1).max(R.questionChars),
  why: z.string().max(R.whyChars),
  /** The field the person updates to answer it, in the existing editor. */
  field: CoachQuestionField,
});
export type CoachQuestion = z.infer<typeof CoachQuestion>;

const Item = z.string().min(1).max(R.itemChars);
const Reword = z.strictObject({ item: z.number().int().min(1).max(L.items), text: Item });
/** Why, what it names, and whether the person may tick it: a change whose words were masked can't be used. */
const About = { reason: z.string().max(R.reasonChars), refs: Refs, usable: z.boolean() };

/**
 * One proposed change, at most one per field: a new goal, scope or exclusions; words added to the end of the context;
 * or items added to the criteria or the assumptions, and items there reworded by number. Nothing is ever deleted.
 */
export const CoachChange = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("goal"), text: z.string().min(1).max(R.textChars), ...About }),
  z.strictObject({ field: z.literal("scope"), text: z.string().min(1).max(R.textChars), ...About }),
  z.strictObject({ field: z.literal("exclusions"), text: z.string().min(1).max(R.textChars), ...About }),
  z.strictObject({ field: z.literal("context"), append: z.string().min(1).max(R.appendChars), ...About }),
  z.strictObject({ field: z.literal("acceptanceCriteria"), add: z.array(Item).max(R.items), reword: z.array(Reword).max(R.rewords), ...About }),
  z.strictObject({ field: z.literal("assumptions"), add: z.array(Item).max(R.items), reword: z.array(Reword).max(R.rewords), ...About }),
]);
export type CoachChange = z.infer<typeof CoachChange>;

/** A check the coach suggests: text for the person to read and copy, never run, never added, never checked by Nivra. */
export const CoachSuggestedCheck = z.strictObject({
  name: z.string().min(1).max(R.checkNameChars),
  command: z.string().min(1).max(R.commandChars),
  expectedOutput: z.string().max(R.outputChars),
  expectedExitCode: z.number().int().min(0).max(255).nullable(),
  reason: z.string().max(R.reasonChars),
});
export type CoachSuggestedCheck = z.infer<typeof CoachSuggestedCheck>;

/**
 * How a coach run went: never whether the brief is good. `complete` handed in something usable, which may be no
 * change at all; `unusable` handed in an answer the engine had to set aside entirely; `empty` handed in nothing.
 */
export const CoachOutcome = z.enum(["in-progress", "complete", "unusable", "empty", "failed", "cancelled", "interrupted"]);
export type CoachOutcome = z.infer<typeof CoachOutcome>;

/** The one request, as it went: its status, why it failed or was skipped, and what the provider reported. */
export const CoachStage = z.strictObject({
  status: z.enum(["pending", "running", "answered", "failed", "skipped"]),
  reason: z.enum(["cancelled", "deadline", "budget", "interrupted", "model-not-allowed"]).nullable(),
  kind: ModelFailureKind.nullable(),
  message: z.string().max(R.messageChars).nullable(),
  /** For an answer the schema refused, or items set aside: field paths and rules, never the answer itself. */
  problems: z.array(z.string().max(R.problemChars)).max(R.problems),
  requests: z.number().int().min(0).max(1),
  estimatedInputTokens: count.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  elapsedMs: count.nullable(),
  finishReason: z.string().max(40).nullable(),
  servedModel: z.string().max(200).nullable(),
});
export type CoachStage = z.infer<typeof CoachStage>;

/** What the engine set aside from an answer, counted: none is dropped silently. */
export const CoachDropped = z.strictObject({ questions: count, changes: count, items: count, refs: count, checks: count, unknowns: count });
export type CoachDropped = z.infer<typeof CoachDropped>;

/**
 * A coach run's report, stored by the engine (masked) and copied by the host into the task's coaching. It is
 * self-contained, and repeats what it was bound to, so the host can check it is the one it asked for.
 */
export const CoachReport = z.strictObject({
  profile: z.strictObject({ id: z.string().max(64), version: z.number().int().positive() }),
  /** SHA-256 of the instructions the coach was sent, pinned to the profile's version. */
  instructionsSha256: Sha256Hex,
  taskId: z.string(),
  briefVersion: z.number().int().positive(),
  bindingDigest: z.string(),
  packetDigest: z.string(),
  preferencesDigest: z.string(),
  outcome: CoachOutcome,
  scope: z.enum(["general", "project"]),
  packet: z.strictObject({ chars: count, criteria: count, assumptions: count, gaps: count, mission: z.boolean(), findings: count }),
  summary: z.string().max(R.summaryChars),
  questions: z.array(CoachQuestion).max(R.questions),
  changes: z.array(CoachChange).max(CoachField.options.length),
  suggestedChecks: z.array(CoachSuggestedCheck).max(R.checks),
  unknowns: z.array(z.string().max(R.unknownChars)).max(R.unknowns),
  dropped: CoachDropped,
  stage: CoachStage,
  request: z.strictObject({ runId: z.uuid(), clientRequestId: z.uuid() }),
  route: RunRoute.nullable(),
  /** What the request was sent with: null means the provider's default, which Nivra doesn't set. The coach's answer is always forced. */
  sampling: z.strictObject({ temperature: z.null(), topP: z.null(), maxOutputTokens: count, toolChoice: z.literal("forced") }),
  preferences: PreferencesReceived,
  usage: RunUsage,
  budget: RunBudgetRecord,
  elapsedMs: count,
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type CoachReport = z.infer<typeof CoachReport>;
