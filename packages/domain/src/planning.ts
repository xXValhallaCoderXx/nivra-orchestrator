import { ReferenceManifest, FrozenReferenceContext } from "./references.ts";
import { z } from "zod";
import { PreferenceSnapshot } from "./context.ts";
import { KnowledgeSnapshot } from "./knowledge.ts";

export const PLANNING_LIMITS = { tasks: 5, questions: 3, requests: 8, outputTokens: 8_000, stepMs: 150_000, totalMs: 480_000, inputTokens: 160_000, toolCalls: 32 } as const;
const text = (max = 4_000) => z.string().trim().max(max);
const lines = (count = 20) => z.array(z.string().trim().min(1).max(1_000)).max(count);
const localId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const PlanningBrief = z.strictObject({ title: text(200).min(1), outcome: text().min(1), intendedUsers: text(2_000), scope: text(), exclusions: text(), constraints: lines(), decisions: lines(), uncertainties: lines(), questions: lines(3) });
export type PlanningBrief = z.infer<typeof PlanningBrief>;
export const PlanningSource = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("manual") }), z.strictObject({ kind: z.enum(["task", "mission", "plan"]), id: z.uuid(), version: z.number().int().positive() })]);
export type PlanningSource = z.infer<typeof PlanningSource>;
export const PlanningRequest = z.strictObject({ brief: PlanningBrief, projectId: z.uuid().nullable(), missionId: z.uuid().nullable(), source: PlanningSource });
export type PlanningRequest = z.infer<typeof PlanningRequest>;
export const PlanningCitation = z.strictObject({ path: z.string().min(1).max(1_024), startLine: z.number().int().positive(), endLine: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().min(1).max(128) }).refine((citation) => citation.endLine >= citation.startLine, "A citation ends at or after its starting line.");
export const PlanningImpact = z.strictObject({ id: localId, area: text(200).min(1), effect: text(2_000).min(1), relationship: z.enum(["direct", "downstream"]), evidence: z.enum(["repository", "user", "inferred", "uninspected"]), citations: z.array(PlanningCitation).max(12), validation: lines(8) });
export const PlanningItem = z.strictObject({ id: localId, title: text(200).min(1), goal: text().min(1), scope: text(), exclusions: text(), acceptanceCriteria: lines(), impactIds: z.array(localId).max(20), prerequisites: z.array(localId).max(5), overlapTaskIds: z.array(z.uuid()).max(10), questions: lines(3) });
export type PlanningItem = z.infer<typeof PlanningItem>;
export const PlanningProposal = z.strictObject({ summary: text(4_000).min(1), challenges: lines(10), decisions: lines(), uncertainties: lines(), questions: lines(3), deferred: lines(), inspection: z.enum(["assessed", "provisional", "not-assessed", "greenfield"]), inspectionScope: text(), gaps: lines(), impacts: z.array(PlanningImpact).max(20), items: z.array(PlanningItem).max(5) }).superRefine((proposal, ctx) => {
  const ids = proposal.items.map((item) => item.id);
  const impacts = proposal.impacts.map((impact) => impact.id);
  if (new Set(ids).size !== ids.length || new Set(impacts).size !== impacts.length) ctx.addIssue({ code: "custom", message: "Planning item and impact IDs must be unique." });
  for (const item of proposal.items) {
    if (item.impactIds.some((id) => !impacts.includes(id)) || item.prerequisites.some((id) => id === item.id || !ids.includes(id))) ctx.addIssue({ code: "custom", message: "An item names an unknown impact or prerequisite." });
  }
  for (const impact of proposal.impacts) if (impact.evidence === "repository" && !impact.citations.length) ctx.addIssue({ code: "custom", message: "Repository observations need checked citations." });
});
export type PlanningProposal = z.infer<typeof PlanningProposal>;
/** Only references cross persisted workflow boundaries; the packet stays in scheduler memory. */
export const PlanningInput = z.strictObject({ planningId: z.uuid(), operationId: z.uuid(), revision: z.number().int().positive(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export type PlanningInput = z.infer<typeof PlanningInput>;
export const PlanningContext = z.strictObject({ references: FrozenReferenceContext.optional(), brief: PlanningBrief, snapshot: text(32_000), projectId: z.uuid().nullable().optional(), sharingEpoch: z.number().int().nonnegative().optional(), preferences: PreferenceSnapshot, knowledge: KnowledgeSnapshot.optional(), repository: z.strictObject({ repoPath: z.string().min(1).max(4_096), projectId: z.uuid(), sharingEpoch: z.number().int().nonnegative() }).nullable(), maxRequests: z.number().int().min(1).max(8) }).superRefine((context, ctx) => {
  if (context.projectId && context.sharingEpoch === undefined) ctx.addIssue({ code: "custom", message: "Project planning requires its captured sharing epoch." });
  if (context.repository && context.projectId && (context.repository.projectId !== context.projectId || context.repository.sharingEpoch !== context.sharingEpoch)) ctx.addIssue({ code: "custom", message: "Repository inspection must use the planning project and sharing epoch." });
});
export type PlanningContext = z.infer<typeof PlanningContext>;
export const PlanningEvidence = z.strictObject({ baseline: z.string().max(128).nullable(), files: z.array(PlanningCitation).max(128), searches: z.array(z.strictObject({ query: z.string().max(200), glob: z.string().max(200).optional(), regex: z.boolean().optional(), ignoreCase: z.boolean().optional(), digest: z.string().regex(/^[a-f0-9]{64}$/) })).max(32), inventory: z.array(z.strictObject({ glob: z.string().max(200).optional(), digest: z.string().regex(/^[a-f0-9]{64}$/) })).max(32) });
export type PlanningEvidence = z.infer<typeof PlanningEvidence>;
export const PlanningResult = z.strictObject({ sourceManifest: ReferenceManifest.optional(), proposal: PlanningProposal, evidence: PlanningEvidence, exploration: z.string().max(1_000) });
export type PlanningResult = z.infer<typeof PlanningResult>;
export interface PlanningSavedItem { itemId: string; taskId: string; briefId: string; missingPrerequisites: string[] }
export interface PlanningView { sourceManifest?: z.infer<typeof ReferenceManifest>; id: string; revision: number; request: PlanningRequest; proposal: PlanningProposal | null; evidence: PlanningEvidence | null; binding: string; stale: string | null; saved: PlanningSavedItem[]; createdAt: string; updatedAt: string; operation?: PlanningOperationView | null }
export interface PlanningOperationView { id: string; planningId: string; status: "submitting" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown"; message: string | null; maxRequests: number; runId: string | null }
export interface PlanningSave { id: string; revision: number; key: string; itemIds: string[] }
