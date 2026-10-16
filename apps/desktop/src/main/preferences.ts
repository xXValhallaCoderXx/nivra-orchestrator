import { randomUUID } from "node:crypto";
import { MAX_PREFERENCES, type PreferenceScope, type PreferenceSnapshot } from "@nivra/domain";
import type { HostData, PreferenceRecord } from "./host-store.ts";

/**
 * The engineer's preferences, as pure changes to the host's records (D21). The host store is the only canonical copy:
 * engines never open it and never keep their own. Each run gets a snapshot of what applies to its project, so an edit
 * or a deletion reaches the next run, and one project's own preferences never reach another project's runs.
 */

const MAX_STATEMENT = 500;

export interface NewPreference {
  statement: string;
  scope: PreferenceScope;
  /** The project a project preference belongs to; null for a personal one. */
  projectId: string | null;
}

function cleanStatement(statement: string): string {
  const clean = statement.trim();
  if (!clean) throw new Error("A preference needs some words. Type what you prefer, then confirm it.");
  if (clean.length > MAX_STATEMENT) throw new Error(`A preference can be at most ${MAX_STATEMENT} characters; this one has ${clean.length}. Shorten it, then confirm it.`);
  return clean;
}

/** Records a preference the person typed and confirmed: confirming it is how it is made, so it starts confirmed. */
export function addPreference(data: HostData, input: NewPreference, now: Date): { data: HostData; record: PreferenceRecord } {
  const statement = cleanStatement(input.statement);
  if (data.preferences.length >= MAX_PREFERENCES) {
    throw new Error(`Nivra keeps at most ${MAX_PREFERENCES} preferences. Delete one you no longer need, then add this one.`);
  }
  if (input.scope === "project" && !data.projects.some((p) => p.id === input.projectId)) throw new Error("That project is no longer in the list.");
  const at = now.toISOString();
  const record: PreferenceRecord = {
    id: randomUUID(),
    statement,
    scope: input.scope,
    projectId: input.scope === "project" ? input.projectId : null,
    status: "confirmed",
    origin: "entered",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
  };
  return { data: { ...data, preferences: [...data.preferences, record], preferencesRevision: data.preferencesRevision + 1 }, record };
}

/**
 * Rewords a preference. Its scope and project stay as they were: a project's own preference becomes personal only by
 * being added again as one. A confirmed preference stays confirmed, since the person wrote the new wording.
 */
export function editPreference(data: HostData, id: string, statement: string, now: Date): { data: HostData; record: PreferenceRecord } {
  const existing = data.preferences.find((p) => p.id === id);
  if (!existing) throw new Error("That preference no longer exists.");
  const clean = cleanStatement(statement);
  if (clean === existing.statement) return { data, record: existing };
  const at = now.toISOString();
  const record: PreferenceRecord = { ...existing, statement: clean, revision: existing.revision + 1, updatedAt: at, confirmedAt: existing.status === "confirmed" ? at : null };
  return { data: { ...data, preferences: data.preferences.map((p) => (p.id === id ? record : p)), preferencesRevision: data.preferencesRevision + 1 }, record };
}

/** Removes a preference; no later run receives it. Removing one that is already gone changes nothing. */
export function deletePreference(data: HostData, id: string): HostData {
  if (!data.preferences.some((p) => p.id === id)) return data;
  return { ...data, preferences: data.preferences.filter((p) => p.id !== id), preferencesRevision: data.preferencesRevision + 1 };
}

/** A project's own preferences go with it when it is removed from the list; personal ones stay. */
export function removeProjectPreferences(data: HostData, projectId: string): { data: HostData; removed: number } {
  const kept = data.preferences.filter((p) => p.projectId !== projectId);
  const removed = data.preferences.length - kept.length;
  return removed ? { data: { ...data, preferences: kept, preferencesRevision: data.preferencesRevision + 1 }, removed } : { data, removed };
}

/**
 * What a run on this project receives: the confirmed personal preferences and the project's own, as they are now.
 * Another project's own preferences and unconfirmed suggestions are never included.
 */
export function snapshotFor(data: HostData, projectId: string): PreferenceSnapshot {
  const records = data.preferences
    .filter((p) => p.status === "confirmed" && (p.scope === "personal" || p.projectId === projectId))
    .map(({ id, statement, scope, revision }) => ({ id, statement, scope, revision }));
  if (records.length > MAX_PREFERENCES) {
    throw new Error(`This project has ${records.length} confirmed preferences, and a run can carry ${MAX_PREFERENCES}. Delete some under Preferences, then start the run again.`);
  }
  return { revision: data.preferencesRevision, records };
}
