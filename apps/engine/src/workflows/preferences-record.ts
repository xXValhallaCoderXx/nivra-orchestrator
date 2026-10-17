import { preferencesDigest, type JsonObject, type RunContext } from "@nivra/domain";

/**
 * What a run records about the preferences the app sent with it (D21): how many, their ids, scopes and revisions, the
 * store's revision and a fingerprint of the values, never their text. Hello and explain record it the same way.
 */
export async function describePreferences(preferences: RunContext["preferences"]): Promise<{ message: string; data: JsonObject }> {
  const { revision, records } = preferences;
  const digest = await preferencesDigest(records);
  const what = records.length === 0 ? "No confirmed preferences" : `${records.length} confirmed ${records.length === 1 ? "preference" : "preferences"}`;
  return {
    message: `${what} from the app (revision ${revision}), fingerprint ${digest.slice(0, 12)}`,
    data: { revision, count: records.length, records: records.map((record) => ({ id: record.id, scope: record.scope, revision: record.revision })), digest },
  };
}
