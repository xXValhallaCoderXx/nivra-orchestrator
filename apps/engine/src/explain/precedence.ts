import type { CheckedCitation, ConflictSource, ExplainConflict, PreferenceIntent, PreferenceScope, SnapshotPreference } from "@nivra/domain";
import type { AnswerConflict } from "./answer.ts";

/**
 * Precedence (D23). The model reports each conflict and names its sources; the engine ranks them, the same way every
 * time: this task's choices, then a project's decisions to change its conventions, then the repository's own
 * conventions, then a project's defaults, then personal defaults. The repository is a source only when the model
 * reported its convention with at least one line it was shown, so an unsupported claim about the code decides nothing.
 * Sources are told apart by kind and id, never by their words. The outcome is deterministic given the conflicts the
 * model reported, and claims no more: "none reported" doesn't mean none exist.
 */

export const RANK: Readonly<Record<ConflictSource, number>> = { choice: 1, override: 2, repository: 3, "project-default": 4, "personal-default": 5 };

/** A preference's place in the ranking, from its scope and intent: a personal preference is always a default. */
export function sourceOf(record: { scope: PreferenceScope; intent: PreferenceIntent }): Extract<ConflictSource, "override" | "project-default" | "personal-default"> {
  if (record.scope === "personal") return "personal-default";
  return record.intent === "override" ? "override" : "project-default";
}

/** The preference ids a run was given, and its choice ids. */
export interface KnownSources {
  preferences: ReadonlySet<string>;
  choices: ReadonlySet<string>;
}

/** The repository's side of a conflict, when the model reported one. */
const conventionOf = (conflict: { repositoryConvention: string | null }): string | null => conflict.repositoryConvention?.trim() || null;

/**
 * Why a reported conflict can't be used, for the model to fix: ids the run doesn't have, or fewer than two sides (the
 * repository's convention counts as one, and so does each distinct id). Empty when it can be used.
 */
export function conflictProblems(conflict: AnswerConflict, known: KnownSources): string[] {
  const preferenceIds = [...new Set(conflict.preferenceIds)];
  const choiceIds = [...new Set(conflict.choiceIds)];
  const problems = [
    ...preferenceIds.filter((id) => !known.preferences.has(id)).map((id) => `${id} isn't one of the engineer's preferences you were given`),
    ...choiceIds.filter((id) => !known.choices.has(id)).map((id) => `${id} isn't one of this task's choices`),
  ];
  const sides = (conventionOf(conflict) === null ? 0 : 1) + preferenceIds.filter((id) => known.preferences.has(id)).length + choiceIds.filter((id) => known.choices.has(id)).length;
  if (sides < 2) problems.push("a conflict needs at least two sides: the repository's convention, the engineer's preferences or this task's choices");
  return problems;
}

const byChoice = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1)) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ranks one reported conflict. `citations` are the conflict's citations as checked against what the model was shown
 * before it answered. Ids the run doesn't have are left out. The highest rank governs when exactly one source holds
 * it; two or more different sources there are `unresolved`, and nothing is picked.
 */
export function rankConflict(conflict: AnswerConflict, citations: CheckedCitation[], records: readonly SnapshotPreference[], choices: ReadonlySet<string>): ExplainConflict {
  const known = new Map(records.map((record) => [record.id, record]));
  const preferences = [...new Set(conflict.preferenceIds)]
    .flatMap((id) => known.get(id) ?? [])
    .sort((a, b) => RANK[sourceOf(a)] - RANK[sourceOf(b)] || (a.id < b.id ? -1 : 1));
  const chosen = [...new Set(conflict.choiceIds)].filter((id) => choices.has(id)).sort(byChoice);
  const convention = conventionOf(conflict);
  const established = convention !== null && citations.some((citation) => citation.checked);
  const candidates: Array<{ source: ConflictSource; id: string | null }> = [
    ...chosen.map((id) => ({ source: "choice" as const, id })),
    ...preferences.map((record) => ({ source: sourceOf(record), id: record.id })),
    ...(established ? [{ source: "repository" as const, id: null }] : []),
  ];
  const top = Math.min(...candidates.map((candidate) => RANK[candidate.source]));
  const leaders = candidates.filter((candidate) => RANK[candidate.source] === top);
  const governs = leaders.length === 1 ? leaders[0]! : null;
  return {
    topic: conflict.topic,
    repositoryConvention: convention,
    citations,
    preferences: preferences.map(({ id, revision, scope, intent }) => ({ id, revision, scope, intent })),
    choices: chosen,
    governs,
    reason: governs ? governs.source : "unresolved",
  };
}
