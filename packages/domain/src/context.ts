import { z } from "zod";

/**
 * What the host gives a run besides its input (D21): the confirmed preferences that apply to the run's project, as a
 * snapshot taken when the run was requested. The host's store is the only canonical copy (D7). An engine holds a
 * snapshot in memory for the life of its run and writes it nowhere, so neither Mastra's step records nor the run
 * timeline keep preference text.
 */

/** The most preferences the host keeps, so one snapshot never carries more. */
export const MAX_PREFERENCES = 50;

export const PreferenceScope = z.enum(["personal", "project"]);
export type PreferenceScope = z.infer<typeof PreferenceScope>;

/**
 * What a preference asks for (D23). A `default` applies where the repository has no convention of its own, so the
 * repository's conventions outrank it. An `override` is a project's decision to change its existing conventions, so
 * it outranks them; only a project's own preference can be one. Scope alone never makes a preference an override.
 */
export const PreferenceIntent = z.enum(["default", "override"]);
export type PreferenceIntent = z.infer<typeof PreferenceIntent>;

/** One confirmed preference as a run receives it. */
export const SnapshotPreference = z
  .strictObject({
    id: z.uuid(),
    statement: z.string().min(1).max(500),
    /** `personal` follows the engineer to every project; `project` applies to its own project's runs only. */
    scope: PreferenceScope,
    intent: PreferenceIntent,
    /** Raised by the host on every edit, so a run's record says which version it used. */
    revision: z.number().int().positive(),
  })
  .refine((record) => record.intent === "default" || record.scope === "project", "Only a project's own preference can override its conventions.");
export type SnapshotPreference = z.infer<typeof SnapshotPreference>;

export const PreferenceSnapshot = z.strictObject({
  /** The host store's preference revision when the snapshot was taken: every change to any preference raises it. */
  revision: z.number().int().nonnegative(),
  records: z
    .array(SnapshotPreference)
    .max(MAX_PREFERENCES)
    .refine((records) => new Set(records.map((r) => r.id)).size === records.length, "Each preference appears once."),
});
export type PreferenceSnapshot = z.infer<typeof PreferenceSnapshot>;

/**
 * Sent with every `runs.start`, even when it holds no preferences: a run never guesses its context. `sharing` is the
 * project's consent as the host held it when the run was asked for (D20, D22): without `modelContext`, the engine
 * sends nothing derived from the repository to a model.
 */
export const RunContext = z.strictObject({
  preferences: PreferenceSnapshot,
  sharing: z.strictObject({ modelContext: z.boolean() }),
});
export type RunContext = z.infer<typeof RunContext>;

/**
 * A fingerprint of a snapshot's records: SHA-256, in hex, of the JSON array of `[id, scope, intent, revision,
 * statement]` sorted by id. Whoever holds the same records gets the same fingerprint, so a run can show that the exact
 * values arrived while its timeline keeps no preference text.
 */
export async function preferencesDigest(records: readonly SnapshotPreference[]): Promise<string> {
  const canonical = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => [r.id, r.scope, r.intent, r.revision, r.statement]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bounded temporary decisions shared by Explain and coding runs (D23). */
export const MAX_CHOICES = 5;
export const MAX_CHOICE_CHARS = 300;
export const RunChoices = z.array(z.string().trim().min(1).max(MAX_CHOICE_CHARS)).max(MAX_CHOICES)
  .refine((choices) => new Set(choices).size === choices.length, "Each choice appears once.");

/** Order is meaningful; the digest contains no raw choice text. */
export async function choicesDigest(choices: readonly string[]): Promise<string> {
  const canonical = JSON.stringify(["nivra.run-choices.v1", RunChoices.parse(choices)]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
