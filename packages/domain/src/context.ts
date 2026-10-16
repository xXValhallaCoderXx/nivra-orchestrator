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

/** One confirmed preference as a run receives it. */
export const SnapshotPreference = z.strictObject({
  id: z.uuid(),
  statement: z.string().min(1).max(500),
  /** `personal` follows the engineer to every project; `project` applies to its own project's runs only. */
  scope: PreferenceScope,
  /** Raised by the host on every edit, so a run's record says which version it used. */
  revision: z.number().int().positive(),
});
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

/** Sent with every `runs.start`, even when it holds no preferences: a run never guesses its context. */
export const RunContext = z.strictObject({ preferences: PreferenceSnapshot });
export type RunContext = z.infer<typeof RunContext>;

/**
 * A fingerprint of a snapshot's records: SHA-256, in hex, of the JSON array of `[id, scope, revision, statement]`
 * sorted by id. Whoever holds the same records gets the same fingerprint, so a run can show that the exact values
 * arrived while its timeline keeps no preference text.
 */
export async function preferencesDigest(records: readonly SnapshotPreference[]): Promise<string> {
  const canonical = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => [r.id, r.scope, r.revision, r.statement]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
