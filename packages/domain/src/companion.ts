import { z } from "zod";
import { PreferenceSnapshot } from "./context.ts";
import { KnowledgeSnapshot } from "./knowledge.ts";

/** Dialogue remains in memory; run inputs, workflow data and events contain references only. */
export const COMPANION_LIMITS = { messageChars: 8_000, historyMessages: 12, historyChars: 24_000, snapshotChars: 32_000, replyChars: 12_000, outputTokens: 4_000, stepMs: 150_000, totalMs: 180_000 } as const;
export const CompanionInput = z.strictObject({ sessionId: z.uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export type CompanionInput = z.infer<typeof CompanionInput>;
export const CompanionContext = z.strictObject({
  preferences: PreferenceSnapshot,
  sharing: z.strictObject({ modelContext: z.boolean() }),
  message: z.string().trim().min(1).max(COMPANION_LIMITS.messageChars),
  history: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(8_000) })).max(COMPANION_LIMITS.historyMessages)
    .refine((messages) => messages.reduce((n, message) => n + message.text.length, 0) <= COMPANION_LIMITS.historyChars, "The temporary history is too long."),
  snapshot: z.string().max(COMPANION_LIMITS.snapshotChars),
  knowledge: KnowledgeSnapshot.optional(),
});
export type CompanionContext = z.infer<typeof CompanionContext>;
export const CompanionAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("navigate"), destination: z.enum(["home", "settings", "environment", "explain", "task", "mission"]) }),
  z.strictObject({ kind: z.literal("draft-mission"), title: z.string().min(1).max(200), outcome: z.string().min(1).max(4_000) }),
  z.strictObject({ kind: z.literal("draft-task"), title: z.string().min(1).max(200), goal: z.string().min(1).max(4_000), scope: z.string().max(4_000), acceptance: z.array(z.string().min(1).max(500)).max(12) }),
]);
export type CompanionAction = z.infer<typeof CompanionAction>;
export const CompanionResult = z.strictObject({
  reply: z.string().trim().min(1).max(COMPANION_LIMITS.replyChars),
  actions: z.array(CompanionAction).max(6),
  captures: z.array(z.strictObject({ kind: z.enum(["decision", "constraint"]), statement: z.string().min(1).max(500), quote: z.string().min(1).max(COMPANION_LIMITS.messageChars), start: z.number().int().nonnegative(), end: z.number().int().positive() })).max(4),
});
export type CompanionResult = z.infer<typeof CompanionResult>;

/** Read-only local checks: no repository script, provider check, upload or installation. */
export const RepositoryInspection = z.strictObject({
  folder: z.enum(["available", "missing", "unavailable"]),
  git: z.strictObject({ available: z.boolean(), version: z.string().max(200).nullable() }),
  repository: z.enum(["repository", "not-repository", "unknown"]),
  baseline: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  changes: z.number().int().nonnegative().nullable(),
  checkedAt: z.iso.datetime(),
});
export type RepositoryInspection = z.infer<typeof RepositoryInspection>;
