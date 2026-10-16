import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_PREFERENCES } from "@nivra/domain";
import { HostStore, type HostData } from "../src/main/host-store.ts";
import { addPreference, deletePreference, editPreference, removeProjectPreferences, snapshotFor } from "../src/main/preferences.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const project = (id: string, nativePath: string) => ({ id, targetId: "local", nativePath, label: nativePath.split("/").at(-1)!, addedAt: "2026-10-17T10:00:00.000Z" });
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
        { id: personal, statement: "Prefer named exports", scope: "personal", revision: 1 },
        { id: ofB, statement: "Tests next to the code", scope: "project", revision: 1 },
      ],
    });
  });

  it("sends the new wording after an edit, with both revisions raised, and keeps the scope", () => {
    const { data, ids } = withPreferences(["Prefer named exports", A]);
    const edited = editPreference(data, ids[0]!, "Prefer default exports", later);
    assert.deepEqual(
      [edited.record.statement, edited.record.scope, edited.record.projectId, edited.record.revision, edited.record.confirmedAt, edited.data.preferencesRevision],
      ["Prefer default exports", "project", A, 2, later.toISOString(), 2],
    );
    assert.deepEqual(snapshotFor(edited.data, A).records.map((r) => [r.statement, r.revision]), [["Prefer default exports", 2]]);
    assert.equal(editPreference(edited.data, ids[0]!, " Prefer default exports ", later).data, edited.data, "the same words change nothing");
    assert.throws(() => editPreference(data, "44444444-4444-4444-8444-444444444444", "Anything", later), /no longer exists/);
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
