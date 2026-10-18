import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_PREFERENCES } from "@nivra/domain";
import { HostStore, NO_SHARING, type HostData } from "../src/main/host-store.ts";
import { addPreference, cleanChoices, deletePreference, editPreference, keepSuggestion, removeProjectPreferences, snapshotFor, supersedePreference } from "../src/main/preferences.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const project = (id: string, nativePath: string) => ({ id, targetId: "local", nativePath, label: nativePath.split("/").at(-1)!, addedAt: "2026-10-17T10:00:00.000Z", sharing: NO_SHARING });
const empty = (): HostData => ({ version: 1, projects: [project(A, "/repos/a"), project(B, "/repos/b")], preferences: [], preferencesRevision: 0 });
const now = new Date("2026-10-17T12:00:00.000Z");
const later = new Date("2026-10-17T13:00:00.000Z");

/** Adds preferences in order and returns the records with the data. */
function withPreferences(...inputs: Array<[statement: string, projectId: string | null]>) {
  let data = empty();
  const ids: string[] = [];
  for (const [statement, projectId] of inputs) {
    const added = addPreference(data, { statement, scope: projectId ? "project" : "personal", projectId }, now);
    data = added.data;
    ids.push(added.record.id);
  }
  return { data, ids };
}

describe("preferences (D21)", () => {
  it("records what the person confirmed, trimmed, as confirmed and entered, and raises the revision", () => {
    const { data, record } = addPreference(empty(), { statement: "  Prefer named exports ü%#  ", scope: "personal", projectId: A }, now);
    assert.deepEqual(
      { statement: record.statement, scope: record.scope, projectId: record.projectId, status: record.status, origin: record.origin, revision: record.revision, confirmedAt: record.confirmedAt },
      { statement: "Prefer named exports ü%#", scope: "personal", projectId: null, status: "confirmed", origin: "entered", revision: 1, confirmedAt: now.toISOString() },
    );
    assert.equal(data.preferencesRevision, 1);
  });

  it("refuses an empty or overlong statement, a project that isn't listed, and more than the limit, saying what to do", () => {
    assert.throws(() => addPreference(empty(), { statement: "   ", scope: "personal", projectId: null }, now), /needs some words/);
    assert.throws(() => addPreference(empty(), { statement: "x".repeat(501), scope: "personal", projectId: null }, now), /at most 500 characters; this one has 501/);
    assert.throws(() => addPreference(empty(), { statement: "Use pnpm", scope: "project", projectId: "33333333-3333-4333-8333-333333333333" }, now), /no longer in the list/);
    let data = empty();
    for (let i = 0; i < MAX_PREFERENCES; i++) data = addPreference(data, { statement: `Preference ${i}`, scope: "personal", projectId: null }, now).data;
    assert.throws(() => addPreference(data, { statement: "One more", scope: "personal", projectId: null }, now), /at most 50 preferences/);
  });

  it("gives a project's runs the confirmed personal preferences and its own, never another project's own or a suggestion", () => {
    const { data, ids } = withPreferences(["Prefer named exports", null], ["Tests in __tests__", A], ["Tests next to the code", B]);
    const [personal, ofA, ofB] = ids;
    const suggested = { ...data.preferences[0]!, id: "44444444-4444-4444-8444-444444444444", statement: "Use Tailwind", status: "suggested" as const, confirmedAt: null };
    const withSuggestion = { ...data, preferences: [...data.preferences, suggested] };
    assert.deepEqual(snapshotFor(withSuggestion, A).records.map((r) => r.id), [personal, ofA]);
    assert.deepEqual(snapshotFor(withSuggestion, B).records.map((r) => r.id), [personal, ofB]);
    assert.deepEqual(snapshotFor(withSuggestion, B), {
      revision: 3,
      records: [
        { id: personal, statement: "Prefer named exports", scope: "personal", intent: "default", revision: 1 },
        { id: ofB, statement: "Tests next to the code", scope: "project", intent: "default", revision: 1 },
      ],
    });
  });

  it("sends the new wording after an edit, with both revisions raised, and keeps the scope", () => {
    const { data, ids } = withPreferences(["Prefer named exports", A]);
    const edited = editPreference(data, ids[0]!, { statement: "Prefer default exports" }, later);
    assert.deepEqual(
      [edited.record.statement, edited.record.scope, edited.record.projectId, edited.record.revision, edited.record.confirmedAt, edited.data.preferencesRevision],
      ["Prefer default exports", "project", A, 2, later.toISOString(), 2],
    );
    assert.deepEqual(snapshotFor(edited.data, A).records.map((r) => [r.statement, r.revision]), [["Prefer default exports", 2]]);
    assert.equal(editPreference(edited.data, ids[0]!, { statement: " Prefer default exports " }, later).data, edited.data, "the same words change nothing");
    assert.throws(() => editPreference(data, "44444444-4444-4444-8444-444444444444", { statement: "Anything" }, later), /no longer exists/);
  });

  it("records whether a project's own preference is a default or a decision, and lets only a project's own be a decision (D23)", () => {
    const decision = addPreference(empty(), { statement: "Replace Jest with Vitest", scope: "project", projectId: A, intent: "override" }, now);
    assert.deepEqual(snapshotFor(decision.data, A).records.map((r) => [r.statement, r.intent]), [["Replace Jest with Vitest", "override"]]);
    assert.equal(addPreference(empty(), { statement: "Use Vitest", scope: "project", projectId: A }, now).record.intent, "default", "a default unless the person says otherwise");
    assert.throws(() => addPreference(empty(), { statement: "Use Vitest", scope: "personal", projectId: null, intent: "override" }, now), /Only a project's own preference can be a decision/);

    // Changing what it asks for is an edit: the same record, a new revision, and the next run gets it.
    const asDefault = editPreference(decision.data, decision.record.id, { statement: "Replace Jest with Vitest", intent: "default" }, later);
    assert.deepEqual([asDefault.record.id, asDefault.record.intent, asDefault.record.revision, asDefault.data.preferencesRevision], [decision.record.id, "default", 2, 2]);
    assert.equal(editPreference(asDefault.data, decision.record.id, { statement: "Replace Jest with Vitest" }, later).data, asDefault.data, "an intent not given stays as it was");
    const personal = addPreference(empty(), { statement: "Use pnpm", scope: "personal", projectId: null }, now);
    assert.throws(() => editPreference(personal.data, personal.record.id, { statement: "Use pnpm", intent: "override" }, later), /Only a project's own preference can be a decision/);
  });

  it("edits only a preference in use", () => {
    const { data } = withPreferences(["Prefer named exports", null]);
    const suggested = { ...data.preferences[0]!, id: "44444444-4444-4444-8444-444444444444", status: "suggested" as const, confirmedAt: null };
    const withSuggestion = { ...data, preferences: [...data.preferences, suggested] };
    assert.throws(() => editPreference(withSuggestion, suggested.id, { statement: "Prefer default exports" }, later), /Only a preference in use can be edited/);
  });

  it("replaces a preference with a new decision, keeping the old one as history that no run gets (D23)", () => {
    const { data, ids } = withPreferences(["Use Vitest when adding tests", A], ["Prefer named exports", null]);
    const replaced = supersedePreference(data, ids[0]!, { statement: "Replace this project's Jest setup with Vitest", intent: "override" }, later);
    const old = replaced.data.preferences.find((p) => p.id === ids[0]);
    assert.deepEqual(
      [replaced.record.statement, replaced.record.scope, replaced.record.projectId, replaced.record.intent, replaced.record.revision, replaced.record.supersedes, replaced.record.origin],
      ["Replace this project's Jest setup with Vitest", "project", A, "override", 1, ids[0], "entered"],
    );
    assert.deepEqual([old?.status, old?.supersededBy, old?.supersededAt, old?.statement, old?.revision], ["superseded", replaced.record.id, later.toISOString(), "Use Vitest when adding tests", 1]);
    assert.equal(replaced.data.preferencesRevision, data.preferencesRevision + 1, "the store's revision rises once");
    assert.deepEqual(snapshotFor(replaced.data, A).records.map((r) => r.statement), ["Prefer named exports", "Replace this project's Jest setup with Vitest"]);

    // History can't be edited or replaced again; deleting the replacement leaves the history.
    assert.throws(() => editPreference(replaced.data, ids[0]!, { statement: "Anything" }, later), /Only a preference in use can be edited/);
    assert.throws(() => supersedePreference(replaced.data, ids[0]!, { statement: "Anything", intent: "default" }, later), /Only a preference in use can be replaced/);
    const deleted = deletePreference(replaced.data, replaced.record.id);
    assert.deepEqual([deleted.preferences.find((p) => p.id === ids[0])?.status, snapshotFor(deleted, A).records.map((r) => r.statement)], ["superseded", ["Prefer named exports"]]);
  });

  it("refuses a replacement that says the same, a personal decision, and one past the limit, saying what to do", () => {
    const { data, ids } = withPreferences(["Prefer named exports", null]);
    assert.throws(() => supersedePreference(data, ids[0]!, { statement: " Prefer named exports ", intent: "default" }, later), /says the same as the preference it replaces/);
    assert.throws(() => supersedePreference(data, ids[0]!, { statement: "Prefer default exports", intent: "override" }, later), /Only a project's own preference can be a decision/);
    let full = data;
    for (let i = 1; i < MAX_PREFERENCES; i++) full = addPreference(full, { statement: `Preference ${i}`, scope: "personal", projectId: null }, now).data;
    assert.throws(() => supersedePreference(full, ids[0]!, { statement: "Prefer default exports", intent: "default" }, later), /at most 50 preferences, replaced ones included/);
  });

  it("keeps a suggestion as the project's own default, in the person's wording, once (D23)", () => {
    const evidence = { runId: "55555555-5555-4555-8555-555555555555", suggestion: 1, headAtStart: "abc123", ranAt: now.toISOString(), citations: [{ path: "package.json", startLine: 4, endLine: 4 }] };
    const kept = keepSuggestion(empty(), { projectId: A, statement: "  Run tests with Jest ", evidence }, later);
    assert.deepEqual(
      [kept.created, kept.record.statement, kept.record.scope, kept.record.projectId, kept.record.intent, kept.record.origin, kept.record.status, kept.record.evidence, kept.data.preferencesRevision],
      [true, "Run tests with Jest", "project", A, "default", "suggested", "confirmed", evidence, 1],
    );
    const again = keepSuggestion(kept.data, { projectId: A, statement: "Different words", evidence }, later);
    assert.deepEqual([again.created, again.data, again.record.id], [false, kept.data, kept.record.id], "the same run's same suggestion saves once");
    assert.throws(() => keepSuggestion(empty(), { projectId: "33333333-3333-4333-8333-333333333333", statement: "Run tests with Jest", evidence }, later), /no longer in the list/);
    assert.deepEqual(snapshotFor(kept.data, B).records, [], "another project never gets it");
  });

  it("checks a task's choices before they are sent, saying what to fix (D23)", () => {
    assert.deepEqual(cleanChoices(["  Keep Jest for this task ", "Use pnpm"]), ["Keep Jest for this task", "Use pnpm"]);
    assert.deepEqual(cleanChoices([]), []);
    assert.throws(() => cleanChoices(["1", "2", "3", "4", "5", "6"]), /at most 5 choices; this one has 6/);
    assert.throws(() => cleanChoices(["Use pnpm", "   "]), /A choice needs some words/);
    assert.throws(() => cleanChoices(["x".repeat(301)]), /at most 300 characters; one has 301/);
    assert.throws(() => cleanChoices(["Use pnpm", " Use pnpm"]), /The same choice is there twice/);
  });

  it("sends nothing deleted, and a project's own preferences leave with it while personal ones stay", () => {
    const { data, ids } = withPreferences(["Prefer named exports", null], ["Tests in __tests__", A]);
    const deleted = deletePreference(data, ids[0]!);
    assert.deepEqual([snapshotFor(deleted, A).records.map((r) => r.id), deleted.preferencesRevision], [[ids[1]], 3]);
    assert.equal(deletePreference(deleted, ids[0]!), deleted, "deleting it again changes nothing");
    const removed = removeProjectPreferences(data, A);
    assert.deepEqual([removed.removed, removed.data.preferences.map((p) => p.id), removed.data.preferencesRevision], [1, [ids[0]], 3]);
    assert.equal(removeProjectPreferences(data, B).data, data);
  });

  it("keeps preferences in the host's file, where a new store reads them back after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra preferences "));
    dirs.push(dir);
    const path = join(dir, "nivra.json");
    const store = new HostStore(path);
    store.update((data) => ({ ...data, projects: [project(A, "/repos/a")] }));
    store.update((data) => addPreference(data, { statement: "Prefer named exports ü%#", scope: "project", projectId: A }, now).data);
    const reopened = new HostStore(path);
    assert.deepEqual(reopened.data.preferences, store.data.preferences);
    assert.equal(reopened.data.preferencesRevision, 1);
    assert.equal(readFileSync(path, "utf8").includes("Prefer named exports ü%#"), true);
  });
});
