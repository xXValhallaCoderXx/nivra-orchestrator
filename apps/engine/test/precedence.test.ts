import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckedCitation, ConflictSource, SnapshotPreference } from "@nivra/domain";
import type { AnswerConflict } from "../src/explain/answer.ts";
import { conflictProblems, rankConflict, sourceOf } from "../src/explain/precedence.ts";

/**
 * Precedence (D23), as a pure function: the model reports a conflict and names its sources; the engine ranks them.
 * Nothing here involves a model.
 */
const record = (id: string, scope: SnapshotPreference["scope"], intent: SnapshotPreference["intent"]): SnapshotPreference => ({ id, statement: `statement of ${id}`, scope, intent, revision: 1 });
const P = "10000000-0000-4000-8000-000000000001";
const P2 = "10000000-0000-4000-8000-000000000002";
const D = "20000000-0000-4000-8000-000000000001";
const D2 = "20000000-0000-4000-8000-000000000002";
const O = "30000000-0000-4000-8000-000000000001";
const O2 = "30000000-0000-4000-8000-000000000002";
const RECORDS = [record(P, "personal", "default"), record(P2, "personal", "default"), record(D, "project", "default"), record(D2, "project", "default"), record(O, "project", "override"), record(O2, "project", "override")];
const CHOICES = new Set(["c1", "c2"]);
const SHOWN: CheckedCitation = { path: "package.json", startLine: 3, endLine: 3, checked: true, problem: null };
const UNSHOWN: CheckedCitation = { path: "package.json", startLine: 9, endLine: 9, checked: false, problem: "lines not shown" };

const conflict = (sources: { repository?: string | null; preferenceIds?: string[]; choiceIds?: string[] }): AnswerConflict => ({
  topic: "test runner",
  repositoryConvention: sources.repository ?? null,
  citations: [],
  preferenceIds: sources.preferenceIds ?? [],
  choiceIds: sources.choiceIds ?? [],
});
const rank = (sources: Parameters<typeof conflict>[0], citations: CheckedCitation[] = sources.repository ? [SHOWN] : []) => rankConflict(conflict(sources), citations, RECORDS, CHOICES);

/** One source of each kind, highest rank first. */
const KINDS: Array<{ source: ConflictSource; id: string | null; sources: Parameters<typeof conflict>[0] }> = [
  { source: "choice", id: "c1", sources: { choiceIds: ["c1"] } },
  { source: "override", id: O, sources: { preferenceIds: [O] } },
  { source: "repository", id: null, sources: { repository: "Jest" } },
  { source: "project-default", id: D, sources: { preferenceIds: [D] } },
  { source: "personal-default", id: P, sources: { preferenceIds: [P] } },
];
const join = (a: Parameters<typeof conflict>[0], b: Parameters<typeof conflict>[0]) => ({
  repository: a.repository ?? b.repository ?? null,
  preferenceIds: [...(a.preferenceIds ?? []), ...(b.preferenceIds ?? [])],
  choiceIds: [...(a.choiceIds ?? []), ...(b.choiceIds ?? [])],
});

describe("rankConflict (D23)", () => {
  it("lets the higher-ranked source govern in every pair of kinds", () => {
    const outcomes: string[] = [];
    for (let i = 0; i < KINDS.length; i++) {
      for (let j = i + 1; j < KINDS.length; j++) {
        const ranked = rank(join(KINDS[i]!.sources, KINDS[j]!.sources));
        outcomes.push(`${KINDS[i]!.source}>${KINDS[j]!.source}: ${ranked.reason} ${ranked.governs?.id ?? "-"}`);
      }
    }
    const expected = KINDS.flatMap((higher, i) => KINDS.slice(i + 1).map((lower) => `${higher.source}>${lower.source}: ${higher.source} ${higher.id ?? "-"}`));
    assert.deepEqual(outcomes, expected);
  });

  it("calls two different sources at the top rank unresolved, and picks neither", () => {
    const ties = [{ choiceIds: ["c1", "c2"] }, { preferenceIds: [O, O2] }, { preferenceIds: [D, D2] }, { preferenceIds: [P, P2] }].map((sources) => rank(sources));
    assert.deepEqual(ties.map((t) => [t.reason, t.governs]), ties.map(() => ["unresolved", null]));
  });

  it("lets a choice govern over two disagreeing decisions, and ignores ties below the top", () => {
    assert.deepEqual(rank({ choiceIds: ["c2"], preferenceIds: [O, O2] }).governs, { source: "choice", id: "c2" });
    assert.deepEqual(rank({ repository: "Jest", preferenceIds: [D, D2, P, P2] }).governs, { source: "repository", id: null });
  });

  it("doesn't rank a repository convention with no line shown to the model, but still reports it", () => {
    const ranked = rank({ repository: "Jest", preferenceIds: [D, P] }, [UNSHOWN]);
    assert.deepEqual([ranked.reason, ranked.governs?.id, ranked.repositoryConvention, ranked.citations], ["project-default", D, "Jest", [UNSHOWN]]);
    // A blank convention is none, whatever it cites.
    assert.equal(rank({ repository: "  ", preferenceIds: [D] }, [SHOWN]).repositoryConvention, null);
  });

  it("ranks a personal preference as a default whatever its intent, and a project's by its intent", () => {
    assert.deepEqual(
      [sourceOf({ scope: "personal", intent: "override" }), sourceOf({ scope: "project", intent: "override" }), sourceOf({ scope: "project", intent: "default" })],
      ["personal-default", "override", "project-default"],
    );
  });

  it("counts a repeated id once, leaves out ids the run doesn't have, and gives the same output whatever the order", () => {
    const repeated = rank({ preferenceIds: [P, P, "40000000-0000-4000-8000-000000000001"], choiceIds: ["c1", "c1", "c9"] });
    assert.deepEqual([repeated.preferences.map((p) => p.id), repeated.choices, repeated.reason], [[P], ["c1"], "choice"]);
    const orders = [
      { repository: "Jest", preferenceIds: [P, O, D], choiceIds: ["c2", "c1"] },
      { repository: "Jest", preferenceIds: [D, P, O], choiceIds: ["c1", "c2"] },
      { repository: "Jest", preferenceIds: [O, D, P], choiceIds: ["c2", "c1"] },
    ].map((sources) => rank(sources));
    for (const ranked of orders) assert.deepEqual(ranked, orders[0]);
    assert.deepEqual([orders[0]!.preferences.map((p) => p.id), orders[0]!.choices, orders[0]!.reason], [[O, D, P], ["c1", "c2"], "unresolved"]);
  });
});

describe("conflictProblems", () => {
  const known = { preferences: new Set(RECORDS.map((r) => r.id)), choices: CHOICES };

  it("accepts two sides of any kind, and names unknown ids and one-sided conflicts", () => {
    assert.deepEqual([conflictProblems(conflict({ repository: "Jest", preferenceIds: [P] }), known), conflictProblems(conflict({ choiceIds: ["c1", "c2"] }), known)], [[], []]);
    assert.deepEqual(conflictProblems(conflict({ preferenceIds: [P, P] }), known), ["a conflict needs at least two sides: the repository's convention, the engineer's preferences or this task's choices"]);
    assert.deepEqual(conflictProblems(conflict({ repository: "Jest", preferenceIds: ["p9"], choiceIds: ["c3"] }), known), [
      "p9 isn't one of the engineer's preferences you were given",
      "c3 isn't one of this task's choices",
      "a conflict needs at least two sides: the repository's convention, the engineer's preferences or this task's choices",
    ]);
  });
});
