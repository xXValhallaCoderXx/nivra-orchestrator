import { randomUUID } from "node:crypto";
import { MAX_CHOICE_CHARS, MAX_CHOICES, MAX_PREFERENCES, PreferenceIntent, PreferenceScope, type PreferenceSnapshot } from "@nivra/domain";
import { z } from "zod";
import type { HostData, PreferenceEvidence, PreferenceRecord } from "./host-store.ts";

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
  /** A default, or a project's decision to change its existing conventions (D23); a default when not given. */
  intent?: PreferenceIntent;
}

/** What an edit sets: the wording, and whether a project's own preference is a default or a decision (D23). */
export interface PreferenceChange {
  statement: string;
  /** Unchanged when not given. */
  intent?: PreferenceIntent;
}

function cleanStatement(statement: string): string {
  const clean = statement.trim();
  if (!clean) throw new Error("A preference needs some words. Type what you prefer, then confirm it.");
  if (clean.length > MAX_STATEMENT) throw new Error(`A preference can be at most ${MAX_STATEMENT} characters; this one has ${clean.length}. Shorten it, then confirm it.`);
  return clean;
}

/** Scope alone never makes a decision: only a project's own preference can be one, and only when the person says so. */
function checkIntent(scope: PreferenceScope, intent: PreferenceIntent): PreferenceIntent {
  if (intent === "override" && scope !== "project") throw new Error("Only a project's own preference can be a decision to change its conventions. Make it this project's own, or keep it as a default.");
  return intent;
}

/**
 * The task's choices as the person typed them, trimmed and checked here so a refusal says what to do (D23). The engine
 * checks them again. They go with one run only and are never saved.
 */
export function cleanChoices(choices: readonly string[]): string[] {
  if (choices.length > MAX_CHOICES) throw new Error(`An explanation can carry at most ${MAX_CHOICES} choices; this one has ${choices.length}. Remove some, then explain again.`);
  const clean = choices.map((choice) => choice.trim());
  if (clean.some((choice) => !choice)) throw new Error("A choice needs some words. Type what this task should do, or remove the empty choice, then explain again.");
  const long = clean.find((choice) => choice.length > MAX_CHOICE_CHARS);
  if (long !== undefined) throw new Error(`A choice can be at most ${MAX_CHOICE_CHARS} characters; one has ${long.length}. Shorten it, then explain again.`);
  if (new Set(clean).size !== clean.length) throw new Error("The same choice is there twice. Remove one, then explain again.");
  return clean;
}

/** Records a preference the person typed and confirmed: confirming it is how it is made, so it starts confirmed. */
export function addPreference(data: HostData, input: NewPreference, now: Date): { data: HostData; record: PreferenceRecord } {
  const statement = cleanStatement(input.statement);
  if (data.preferences.length >= MAX_PREFERENCES) {
    throw new Error(`Nivra keeps at most ${MAX_PREFERENCES} preferences, replaced ones included. Delete one you no longer need, then add this one.`);
  }
  if (input.scope === "project" && !data.projects.some((p) => p.id === input.projectId)) throw new Error("That project is no longer in the list.");
  const intent = checkIntent(input.scope, input.intent ?? "default");
  const at = now.toISOString();
  const record: PreferenceRecord = {
    id: randomUUID(),
    statement,
    scope: input.scope,
    projectId: input.scope === "project" ? input.projectId : null,
    intent,
    status: "confirmed",
    origin: "entered",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
    supersedes: null,
    supersededBy: null,
    supersededAt: null,
    evidence: null,
  };
  return { data: { ...data, preferences: [...data.preferences, record], preferencesRevision: data.preferencesRevision + 1 }, record };
}

/**
 * Replaces a preference with a new decision (D23): a new record, in the person's wording and intent, with the same scope
 * and project, naming what it replaced. The old one stays as history, `superseded`, and no run gets it again. Only a
 * preference in use can be replaced; the store's revision rises once.
 */
export function supersedePreference(data: HostData, id: string, change: { statement: string; intent: PreferenceIntent }, now: Date): { data: HostData; record: PreferenceRecord } {
  const existing = data.preferences.find((p) => p.id === id);
  if (!existing) throw new Error("That preference no longer exists.");
  if (existing.status !== "confirmed") throw new Error("Only a preference in use can be replaced, and this one isn't. Replace the one in use instead.");
  const statement = cleanStatement(change.statement);
  const intent = checkIntent(existing.scope, change.intent);
  if (existing.scope === "project" && !data.projects.some((p) => p.id === existing.projectId)) throw new Error("That project is no longer in the list.");
  if (data.preferences.length >= MAX_PREFERENCES) {
    throw new Error(`Nivra keeps at most ${MAX_PREFERENCES} preferences, replaced ones included. Delete one you no longer need, such as an old replaced one, then replace this one.`);
  }
  if (statement === existing.statement && intent === existing.intent) {
    throw new Error("The replacement says the same as the preference it replaces. Change the wording or what it asks for, or keep the preference as it is.");
  }
  const at = now.toISOString();
  const record: PreferenceRecord = {
    id: randomUUID(),
    statement,
    scope: existing.scope,
    projectId: existing.projectId,
    intent,
    status: "confirmed",
    origin: "entered",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
    supersedes: existing.id,
    supersededBy: null,
    supersededAt: null,
    evidence: null,
  };
  const replaced: PreferenceRecord = { ...existing, status: "superseded", supersededBy: record.id, supersededAt: at };
  return { data: { ...data, preferences: [...data.preferences.map((p) => (p.id === id ? replaced : p)), record], preferencesRevision: data.preferencesRevision + 1 }, record };
}

/** A run's suggestion as the person chose to keep it: their wording, the project, and where it came from. */
export interface KeptSuggestion {
  projectId: string;
  statement: string;
  evidence: PreferenceEvidence;
}

/**
 * Saves the wording the person confirmed for a run's suggestion as that project's own default (D23), with where it came
 * from: never a decision, and never personal (promotion is deferred). A suggestion already kept, and still in use, is
 * returned as it is, so a second click saves nothing.
 */
export function keepSuggestion(data: HostData, kept: KeptSuggestion, now: Date): { data: HostData; record: PreferenceRecord; created: boolean } {
  // Kept once and still in use: saved once. Kept, then replaced or deleted: keeping it again is a new choice.
  const existing = data.preferences.find((p) => p.status === "confirmed" && p.evidence?.runId === kept.evidence.runId && p.evidence.suggestion === kept.evidence.suggestion);
  if (existing) return { data, record: existing, created: false };
  const statement = cleanStatement(kept.statement);
  if (!data.projects.some((p) => p.id === kept.projectId)) throw new Error("That project is no longer in the list.");
  if (data.preferences.length >= MAX_PREFERENCES) throw new Error(`Nivra keeps at most ${MAX_PREFERENCES} preferences, replaced ones included. Delete one you no longer need, then keep this one.`);
  const at = now.toISOString();
  const record: PreferenceRecord = {
    id: randomUUID(),
    statement,
    scope: "project",
    projectId: kept.projectId,
    intent: "default",
    status: "confirmed",
    origin: "suggested",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
    supersedes: null,
    supersededBy: null,
    supersededAt: null,
    evidence: kept.evidence,
  };
  return { data: { ...data, preferences: [...data.preferences, record], preferencesRevision: data.preferencesRevision + 1 }, record, created: true };
}

/**
 * Fixes a preference's wording, or whether a project's own preference is a default or a decision (D23). Its scope and
 * project stay as they were: a project's own preference becomes personal only by being added again as one. Only a
 * confirmed preference can be edited, and it stays confirmed, since the person wrote the change.
 */
export function editPreference(data: HostData, id: string, change: PreferenceChange, now: Date): { data: HostData; record: PreferenceRecord } {
  const existing = data.preferences.find((p) => p.id === id);
  if (!existing) throw new Error("That preference no longer exists.");
  if (existing.status !== "confirmed") throw new Error("Only a preference in use can be edited, and this one isn't. Edit the one in use, or add a new one.");
  const statement = cleanStatement(change.statement);
  const intent = checkIntent(existing.scope, change.intent ?? existing.intent);
  if (statement === existing.statement && intent === existing.intent) return { data, record: existing };
  const at = now.toISOString();
  const record: PreferenceRecord = { ...existing, statement, intent, revision: existing.revision + 1, updatedAt: at, confirmedAt: at };
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
 * Another project's own preferences and unconfirmed suggestions are never included. With no project (a general
 * conversation, D26), only the personal ones.
 */
export function snapshotFor(data: HostData, projectId: string | null): PreferenceSnapshot {
  const records = data.preferences
    .filter((p) => p.status === "confirmed" && (p.scope === "personal" || (projectId !== null && p.projectId === projectId)))
    .map(({ id, statement, scope, intent, revision }) => ({ id, statement, scope, intent, revision }));
  if (records.length > MAX_PREFERENCES) {
    throw new Error(`This project has ${records.length} confirmed preferences, and a run can carry ${MAX_PREFERENCES}. Delete some under Preferences, then start the run again.`);
  }
  return { revision: data.preferencesRevision, records };
}

/**
 * A file of exported preferences (D23), version 2: each one's wording, scope and intent, and for a project's own, the
 * project it came from by a key that means something only in this file, with that project's label. Two projects with
 * the same label stay two. No store ids, folders, revisions or evidence: the file leaves the app, and an import makes
 * new records.
 */
export const PreferenceExport = z
  .strictObject({
    format: z.literal("nivra-preferences"),
    version: z.literal(2),
    exportedAt: z.iso.datetime(),
    projects: z.array(z.strictObject({ key: z.string().regex(/^p[1-9][0-9]{0,2}$/), label: z.string().min(1).max(200) })).max(MAX_PREFERENCES),
    preferences: z
      .array(
        z
          .strictObject({
            statement: z
              .string()
              .max(MAX_STATEMENT)
              .refine((statement) => statement.trim().length > 0),
            scope: PreferenceScope,
            /** The key of the project a project preference came from; null for a personal one. */
            project: z.string().nullable(),
            intent: PreferenceIntent,
          })
          .refine((entry) => (entry.scope === "project") === (entry.project !== null))
          .refine((entry) => entry.intent === "default" || entry.scope === "project"),
      )
      .max(MAX_PREFERENCES),
  })
  .refine((file) => new Set(file.projects.map((project) => project.key)).size === file.projects.length)
  .refine((file) => file.preferences.every((entry) => entry.project === null || file.projects.some((project) => project.key === entry.project)));
export type PreferenceExport = z.infer<typeof PreferenceExport>;

/** The scopes an export holds: personal preferences, and each chosen project's own. */
export interface ExportScopes {
  personal: boolean;
  projectIds: readonly string[];
}

/**
 * An export of the confirmed preferences in the scopes the person chose (D23). A statement that holds a saved key is
 * refused rather than written to a file that leaves the app.
 */
export function buildExport(data: HostData, scopes: ExportScopes, secrets: readonly string[], now: Date): { text: string; count: number } {
  const chosen = new Set(scopes.projectIds);
  const records = data.preferences.filter((p) => p.status === "confirmed" && (p.scope === "personal" ? scopes.personal : p.projectId !== null && chosen.has(p.projectId)));
  if (records.length === 0) throw new Error("There is nothing to export in the scopes you chose. Choose your personal preferences, or a project with preferences of its own, then export again.");
  if (records.some((p) => secrets.some((secret) => secret.length > 0 && p.statement.includes(secret)))) {
    throw new Error("A preference holds your saved Nebius key, so nothing was exported. Edit that preference to take the key out, then export again.");
  }
  // Each source project gets a key of its own in this file, so two with the same label are never merged.
  const keys = new Map<string, string>();
  for (const p of records) if (p.projectId !== null && !keys.has(p.projectId)) keys.set(p.projectId, `p${keys.size + 1}`);
  const file = PreferenceExport.parse({
    format: "nivra-preferences",
    version: 2,
    exportedAt: now.toISOString(),
    projects: [...keys].map(([projectId, key]) => ({ key, label: data.projects.find((p) => p.id === projectId)?.label ?? "A removed project" })),
    preferences: records.map((p) => ({ statement: p.statement, scope: p.scope, project: p.projectId === null ? null : keys.get(p.projectId)!, intent: p.intent })),
  });
  return { text: `${JSON.stringify(file, null, 2)}\n`, count: records.length };
}

const NOT_AN_EXPORT = "That file isn't a Nivra preferences export, or it was changed since it was exported, so nothing was imported. Choose a file Nivra exported.";

/** Reads an export (D23). A file that isn't one is refused in Nivra's words, never quoting it. */
export function parseImport(text: string): PreferenceExport {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(NOT_AN_EXPORT);
  }
  const parsed = PreferenceExport.safeParse(json);
  if (!parsed.success) throw new Error(NOT_AN_EXPORT);
  return parsed.data;
}

/** Whether the store already holds this preference, in use, for this project. */
const alreadyHere = (data: HostData, entry: PreferenceExport["preferences"][number], projectId: string | null) =>
  data.preferences.some((p) => p.status === "confirmed" && p.statement === entry.statement.trim() && p.scope === entry.scope && p.projectId === projectId && p.intent === entry.intent);

/** One of an export's source projects, as an import preview shows it. */
export interface ImportSource {
  /** The project's key in the file. */
  key: string;
  label: string;
  /** How many of the file's projects have this label, and which of them this is: two "app"s stay two. */
  sameLabel: number;
  position: number;
  /** The local projects with the same label. */
  matches: string[];
  /** Where it would go untouched: the one local project with its label, only when no other project in the file has it. */
  suggested: string | null;
  entries: Array<{ statement: string; intent: PreferenceIntent }>;
}

/**
 * What importing would do (D23): the file's personal preferences, and each of its source projects with the local
 * projects whose label matches. A destination is suggested only when the label is unambiguous: one local match, and no
 * other project in the file with the same label. Otherwise the person chooses where each goes.
 */
export function previewImport(data: HostData, file: PreferenceExport): { personal: Array<{ statement: string; intent: PreferenceIntent }>; projects: ImportSource[] } {
  const personal = file.preferences.filter((entry) => entry.scope === "personal").map(({ statement, intent }) => ({ statement, intent }));
  // Only the projects the file has preferences for are shown, and only they can make a label ambiguous.
  const listed = file.projects.filter((source) => file.preferences.some((entry) => entry.project === source.key));
  const projects = listed.map((source): ImportSource => {
    const same = listed.filter((project) => project.label === source.label);
    const matches = data.projects.filter((project) => project.label === source.label).map((project) => project.id);
    return {
      key: source.key,
      label: source.label,
      sameLabel: same.length,
      position: same.indexOf(source) + 1,
      matches,
      suggested: same.length === 1 && matches.length === 1 ? matches[0]! : null,
      entries: file.preferences.filter((entry) => entry.project === source.key).map(({ statement, intent }) => ({ statement, intent })),
    };
  });
  return { personal, projects };
}

/**
 * What the person chose to import (D23): whether the file's personal preferences come in, and for each of its source
 * projects, by key, the local project its preferences go to, or null to leave them out. Every source project needs a
 * choice: where one goes is never guessed.
 */
export interface ImportChoice {
  personal: boolean;
  projects: ReadonlyArray<{ source: string; project: string | null }>;
}

/**
 * Adds an export's preferences as the person chose (D23). Each chosen project is checked against the list as it is
 * now; preferences already here are skipped; the limit applies to the whole import. Added ones are confirmed,
 * `origin: imported`, and the store's revision rises once.
 */
export function applyImport(data: HostData, file: PreferenceExport, choice: ImportChoice, now: Date): { data: HostData; added: number; alreadyHere: number; leftOut: number } {
  const destination = new Map(choice.projects.map((chosen) => [chosen.source, chosen.project]));
  const sources = new Set(file.preferences.flatMap((entry) => (entry.project === null ? [] : [entry.project])));
  if (destination.size !== choice.projects.length || [...sources].some((key) => !destination.has(key)) || [...destination.keys()].some((key) => !sources.has(key))) {
    throw new Error("The import's choices don't match the file. Preview the file again, then import.");
  }
  const at = now.toISOString();
  const added: PreferenceRecord[] = [];
  let present = 0;
  let leftOut = 0;
  for (const entry of file.preferences) {
    const projectId = entry.project === null ? null : (destination.get(entry.project) ?? null);
    if (entry.scope === "personal" ? !choice.personal : projectId === null) {
      leftOut++;
      continue;
    }
    if (projectId !== null && !data.projects.some((p) => p.id === projectId)) throw new Error("A project chosen for the import is no longer in the list. Choose again where its preferences go, then import.");
    const statement = cleanStatement(entry.statement);
    const intent = checkIntent(entry.scope, entry.intent);
    const twice = added.some((p) => p.statement === statement && p.scope === entry.scope && p.projectId === projectId && p.intent === intent);
    if (twice || alreadyHere(data, entry, projectId)) {
      present++;
      continue;
    }
    added.push({
      id: randomUUID(),
      statement,
      scope: entry.scope,
      projectId,
      intent,
      status: "confirmed",
      origin: "imported",
      revision: 1,
      createdAt: at,
      updatedAt: at,
      confirmedAt: at,
      supersedes: null,
      supersededBy: null,
      supersededAt: null,
      evidence: null,
    });
  }
  if (data.preferences.length + added.length > MAX_PREFERENCES) {
    throw new Error(
      `Importing would take Nivra past ${MAX_PREFERENCES} preferences, replaced ones included (${data.preferences.length} now, ${added.length} to add). Delete some, or leave some of the file's out, then import again.`,
    );
  }
  if (added.length === 0) return { data, added: 0, alreadyHere: present, leftOut };
  return { data: { ...data, preferences: [...data.preferences, ...added], preferencesRevision: data.preferencesRevision + 1 }, added: added.length, alreadyHere: present, leftOut };
}
