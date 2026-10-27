import { z } from "zod";
import { PreferencesReceived } from "./chat.ts";
import { PreferenceSnapshot } from "./context.ts";
import { ModelFailureKind, RunBudgetRecord, RunRoute, RunUsage } from "./models.ts";
import { MissionReviewPacket } from "./mission.ts";

/**
 * A review of one saved plan version (NIV-38, D30). The host freezes what it sends as a packet: the plan's text, its
 * assumptions, and the places the answer it came from looked. Two reviewers read the same packet on their own, one for
 * architecture, feasibility and scope and one for risks, failure behaviour and testability, then a chair keeps their
 * findings, dissent and gaps. A single reviewer covering both is the baseline it is compared with (A3); the window
 * offers only the council.
 *
 * The packet and the preferences travel in the run's context, held in memory like the preference snapshot (D21), and
 * are never stored with the run: the run records the plan's id and version and a fingerprint of each, so a report can
 * be bound to exactly what was reviewed. A report never says "approved": its outcome is about completeness only.
 */

/** What one packet may hold. The plan's text is the host's own limit for a plan; references, the most an answer gives. */
export const REVIEW_PACKET_LIMITS = {
  textChars: 20_000,
  assumptions: 20,
  assumptionChars: 1_000,
  /** 20 findings and 10 conflicts, each with up to 8 citations, as a plan saved from an answer can carry. */
  references: 240,
  pathChars: 500,
} as const;

/** The tools reviewers and the chair hand their reports in with, which stubs script against. */
export const REVIEW_TOOLS = { reviewer: "submit_review", chair: "submit_synthesis" } as const;

export const ReviewPanel = z.enum(["council", "single"]);
export type ReviewPanel = z.infer<typeof ReviewPanel>;

export const ReviewRole = z.enum(["architecture", "risks", "single"]);
export type ReviewRole = z.infer<typeof ReviewRole>;

/** The first line of each agent's instructions: who it is, for a stub, which can't tell parallel requests apart otherwise. */
export const reviewRoleMarker = (role: ReviewRole | "chair"): string => `Nivra review role: ${role}`;

/**
 * Where the plan came from: a general conversation, with no repository, or one project's, at the commit its answer read.
 * Neither carries a path or a project id: those stay in the host (D17).
 */
export const ReviewScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("general") }),
  z.strictObject({ kind: z.literal("project"), headAtStart: z.string().min(1).max(64).nullable() }),
]);
export type ReviewScope = z.infer<typeof ReviewScope>;

/**
 * Where the answer a plan came from looked: a path and lines, never the lines themselves. It shows that the place
 * exists, and was cited then; it supports no claim about the code, and nobody re-reads it for the review.
 */
export const HistoricalReference = z
  .strictObject({
    path: z.string().min(1).max(REVIEW_PACKET_LIMITS.pathChars),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((reference) => reference.endLine >= reference.startLine, "endLine must not come before startLine.");
export type HistoricalReference = z.infer<typeof HistoricalReference>;

/** What the reviewers read, exactly as sent: no defaults and no transforms, so its fingerprint covers what was sent. */
export const ReviewPacket = z
  .strictObject({
    scope: ReviewScope,
    text: z
      .string()
      .min(1)
      .max(REVIEW_PACKET_LIMITS.textChars)
      .refine((text) => text.trim().length > 0, "The plan's text is blank."),
    assumptions: z.array(z.string().min(1).max(REVIEW_PACKET_LIMITS.assumptionChars)).max(REVIEW_PACKET_LIMITS.assumptions),
    references: z.array(HistoricalReference).max(REVIEW_PACKET_LIMITS.references),
  })
  .refine((packet) => packet.scope.kind === "project" || packet.references.length === 0, "A general plan has no repository references.");
export type ReviewPacket = z.infer<typeof ReviewPacket>;

/**
 * What a review run gets besides its input (D21): held in the engine's memory for the run, never stored. The packet is
 * a saved plan version's, or a mission and up to five of its tasks (NIV-52), which the council reads in a mode of its own.
 */
export const ReviewContext = z.strictObject({
  preferences: PreferenceSnapshot,
  sharing: z.strictObject({ modelContext: z.boolean() }),
  packet: z.union([ReviewPacket, MissionReviewPacket]),
});
export type ReviewContext = z.infer<typeof ReviewContext>;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A review run's input, stored with the run (masked) and given to Mastra as `{ panel }` only: which panel, which plan
 * version, and the fingerprints of the packet and the preferences it must have been sent. The engine checks both
 * fingerprints against the context before any request.
 */
export const ReviewInput = z.strictObject({
  panel: ReviewPanel.default("council"),
  planId: z.uuid(),
  planVersion: z.number().int().positive(),
  packetDigest: Sha256Hex,
  preferencesDigest: Sha256Hex,
});
export type ReviewInput = z.infer<typeof ReviewInput>;

/** A review's input as the engine reads it back from its store: masked, so only its shape is checked. */
export const StoredReviewInput = z.object({
  panel: ReviewPanel,
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  packetDigest: z.string(),
  preferencesDigest: z.string(),
});
export type StoredReviewInput = z.infer<typeof StoredReviewInput>;

/**
 * A packet's fingerprint: SHA-256, in hex, of a fixed-order, versioned JSON array of its content. The host and the
 * engine each work it out, so a report can show it reviewed exactly what was sent while nothing stores the text. It
 * covers the content only; the plan's id and version are bound by the run's input.
 */
export async function packetDigest(packet: ReviewPacket): Promise<string> {
  const canonical = [
    "nivra.review-packet.v1",
    packet.scope.kind,
    packet.scope.kind === "project" ? packet.scope.headAtStart : null,
    packet.text,
    packet.assumptions,
    packet.references.map((reference) => [reference.path, reference.startLine, reference.endLine]),
  ];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** How large each part of a report may be: the engine clips to these and counts what it shortened. */
export const REVIEW_REPORT_LIMITS = {
  summaryChars: 1_500,
  findings: 8,
  titleChars: 160,
  detailChars: 1_000,
  recommendationChars: 500,
  refs: 6,
  refChars: 64,
  notes: 6,
  noteChars: 300,
  synthesisChars: 2_000,
  ids: 16,
  agreements: 8,
  statementChars: 400,
  dissent: 6,
  positions: 3,
  topicChars: 160,
  messageChars: 400,
  problems: 10,
  problemChars: 200,
} as const;

const count = z.number().int().nonnegative();
const text = (max: number) => z.string().max(max);
const FindingId = z.string().regex(/^(arch|risk|single)-[1-9][0-9]?$/);
const FindingIds = z.array(FindingId).max(REVIEW_REPORT_LIMITS.ids);
const Notes = z.array(text(REVIEW_REPORT_LIMITS.noteChars)).max(REVIEW_REPORT_LIMITS.notes);

/**
 * What a finding rests on, as the engine reads its references: `plan` when it is reasoned from what the plan says (the
 * plan or one of its assumptions), `assumption` when it relies on anything the packet doesn't hold, a claim about the
 * code included. A historical reference never makes a finding more than an assumption.
 */
export const FindingBasis = z.enum(["plan", "assumption"]);
export type FindingBasis = z.infer<typeof FindingBasis>;

export const ReviewFinding = z.strictObject({
  /** Given by the engine, stable within the report: `arch-1`, `risk-2`, `single-3`. */
  id: FindingId,
  title: text(REVIEW_REPORT_LIMITS.titleChars),
  detail: text(REVIEW_REPORT_LIMITS.detailChars),
  recommendation: text(REVIEW_REPORT_LIMITS.recommendationChars),
  severity: z.enum(["high", "medium", "low"]).nullable(),
  basis: FindingBasis,
  /** What in the packet it names: `plan`, `A3` (the third assumption), `E12` (the twelfth historical reference), or a preference's id. */
  refs: z.array(text(REVIEW_REPORT_LIMITS.refChars)).max(REVIEW_REPORT_LIMITS.refs),
  /** The engine changed the basis the reviewer gave, because its references didn't support it. */
  relabelled: z.boolean(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** What the engine had to change in a report to keep it within its limits and its packet, counted. */
const Adjusted = z.strictObject({
  dropped: count,
  refsDropped: count,
  relabelled: count,
  shortened: count,
  /** A mission review's findings set aside for naming no selected task, the mission or the backlog (NIV-52). */
  unanchored: count.optional(),
  /** A mission review's findings left out for having neither a title nor a detail (NIV-52); a plan review counts them as dropped. */
  empty: count.optional(),
});

export const ReviewerReport = z.strictObject({
  role: ReviewRole,
  summary: text(REVIEW_REPORT_LIMITS.summaryChars),
  findings: z.array(ReviewFinding).max(REVIEW_REPORT_LIMITS.findings),
  assumptions: Notes,
  gaps: Notes,
  adjusted: Adjusted,
});
export type ReviewerReport = z.infer<typeof ReviewerReport>;

const Roles = z.array(ReviewRole).max(3);

/** The chair's synthesis. Every agreement and position names its findings, and which reviewers they came from. */
export const ChairSynthesis = z.strictObject({
  summary: text(REVIEW_REPORT_LIMITS.synthesisChars),
  priorities: FindingIds,
  agreements: z.array(z.strictObject({ statement: text(REVIEW_REPORT_LIMITS.statementChars), findingIds: FindingIds, roles: Roles })).max(REVIEW_REPORT_LIMITS.agreements),
  dissent: z
    .array(
      z.strictObject({
        topic: text(REVIEW_REPORT_LIMITS.topicChars),
        positions: z.array(z.strictObject({ position: text(REVIEW_REPORT_LIMITS.statementChars), findingIds: FindingIds, roles: Roles })).max(REVIEW_REPORT_LIMITS.positions),
        note: text(REVIEW_REPORT_LIMITS.statementChars),
      }),
    )
    .max(REVIEW_REPORT_LIMITS.dissent),
  gaps: Notes,
  /** Findings the chair named nowhere, worked out by the engine: none is dropped silently. */
  unaddressed: FindingIds,
  adjusted: Adjusted,
});
export type ChairSynthesis = z.infer<typeof ChairSynthesis>;

/**
 * One stage of a review. `answered` gave a usable report; `failed` didn't, with the kind and Nivra's own words; `skipped`
 * never ran, and says why. `pending` and `running` appear only while the review is going, or in a report the engine
 * saved before it stopped.
 */
export const ReviewStage = z.strictObject({
  stage: z.enum(["reviewer", "chair"]),
  role: z.enum(["architecture", "risks", "single", "chair"]),
  status: z.enum(["pending", "running", "answered", "failed", "skipped"]),
  reason: z.enum(["reviewer-missing", "single-panel", "cancelled", "deadline", "budget", "interrupted"]).nullable(),
  kind: ModelFailureKind.nullable(),
  message: text(REVIEW_REPORT_LIMITS.messageChars).nullable(),
  /** For an answer the schema refused: field paths and rules, never the answer itself. */
  problems: z.array(text(REVIEW_REPORT_LIMITS.problemChars)).max(REVIEW_REPORT_LIMITS.problems),
  requests: z.number().int().min(0).max(1),
  /** The request's estimated input, and what the provider reported (null when it didn't). */
  estimatedInputTokens: count.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  elapsedMs: count.nullable(),
  finishReason: text(40).nullable(),
  servedModel: text(200).nullable(),
});
export type ReviewStage = z.infer<typeof ReviewStage>;

/** How complete a review is: never whether the plan is sound. */
export const ReviewOutcome = z.enum(["in-progress", "complete", "incomplete", "failed", "cancelled", "interrupted"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcome>;

/**
 * A review's report, stored by the engine (masked) and copied by the host into the plan's conversation. It is
 * self-contained: everything the window shows comes from it. It repeats what it was bound to, so the host can check it.
 */
export const ReviewReport = z.strictObject({
  panel: ReviewPanel,
  planId: z.string(),
  planVersion: z.number().int().positive(),
  packetDigest: z.string(),
  preferencesDigest: z.string(),
  outcome: ReviewOutcome,
  scope: ReviewScope,
  packet: z.strictObject({ textChars: count, assumptions: count, references: count }),
  request: z.strictObject({ runId: z.uuid(), clientRequestId: z.uuid() }),
  route: RunRoute.nullable(),
  /** What the requests were sent with: null means the provider's default, which Nivra doesn't set. */
  sampling: z.strictObject({ temperature: z.null(), topP: z.null(), maxOutputTokens: count, toolChoice: z.enum(["forced", "auto"]) }),
  preferences: PreferencesReceived,
  reviewers: z.array(ReviewerReport).max(2),
  synthesis: ChairSynthesis.nullable(),
  stages: z.array(ReviewStage).max(3),
  usage: RunUsage,
  budget: RunBudgetRecord,
  elapsedMs: count,
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ReviewReport = z.infer<typeof ReviewReport>;
