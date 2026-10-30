import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_PREFERENCES } from "@nivra/domain";
import { HostStore, NO_SHARING, type HostData } from "../src/main/host-store.ts";
import {
  addPreference,
  applyImport,
  buildExport,
  cleanChoices,
  deletePreference,
  editPreference,
  keepSuggestion,
  parseImport,
  previewImport,
  promotePreference,
  removeProjectPreferences,
  snapshotFor,
  supersedePreference,
} from "../src/main/preferences.ts";

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
    // Replaced since, it isn't in use: keeping it again is a new choice, and saves it.
    const replaced = supersedePreference(kept.data, kept.record.id, { statement: "Run tests with Vitest", intent: "default" }, later).data;
    const rekept = keepSuggestion(replaced, { projectId: A, statement: "Run tests with Jest", evidence }, later);
    assert.deepEqual([rekept.created, rekept.record.status, rekept.data.preferences.length], [true, "confirmed", 3]);
    assert.throws(() => keepSuggestion(empty(), { projectId: "33333333-3333-4333-8333-333333333333", statement: "Run tests with Jest", evidence }, later), /no longer in the list/);
    assert.deepEqual(snapshotFor(kept.data, B).records, [], "another project never gets it");
  });

  it("promotes entered, imported and suggestion-derived project preferences as independent personal defaults (NIV-10)", () => {
    const sourceText = "Private alpha uses /repos/a/internal-tests";
    const entered = addPreference(empty(), { statement: sourceText, scope: "project", projectId: A, intent: "override" }, now);
    const suggested = keepSuggestion(empty(), { projectId: A, statement: sourceText, evidence: { runId: "55555555-5555-4555-8555-555555555555", suggestion: 0, headAtStart: "private-head", ranAt: now.toISOString(), citations: [{ path: "private-source.ts", startLine: 2, endLine: 4 }] } }, now);
    const file = parseImport(buildExport(entered.data, { personal: false, projectIds: [A] }, [], now).text);
    const imported = applyImport(empty(), file, { personal: false, projects: [{ source: "p1", project: A }] }, now);
    for (const data of [entered.data, suggested.data, imported.data]) {
      const source = structuredClone(data.preferences[0]!);
      const promoted = promotePreference(data, source.id, source.revision, "  Prefer tests beside the code ü%#  ", later);
      assert.equal(promoted.created, true);
      assert.equal(promoted.data.preferences.length, 2);
      assert.deepEqual(promoted.data.preferences.find((record) => record.id === source.id), source);
      const personal = promoted.record;
      assert.notEqual(personal.id, source.id);
      assert.deepEqual([personal.statement, personal.scope, personal.projectId, personal.intent, personal.origin, personal.status, personal.evidence, personal.supersedes, personal.revision, personal.confirmedAt],
        ["Prefer tests beside the code ü%#", "personal", null, "default", "entered", "confirmed", null, null, 1, later.toISOString()]);
      assert.equal(promoted.data.preferencesRevision, data.preferencesRevision + 1);
      assert.deepEqual(snapshotFor(promoted.data, B).records, [{ id: personal.id, statement: personal.statement, scope: "personal", intent: "default", revision: 1 }]);
      assert.equal(snapshotFor(promoted.data, A).records.length, 2);
      assert.equal(JSON.stringify(personal).includes("private"), false, "no source content, HEAD or citations copied");
    }
  });

  it("refuses a stale, replaced, deleted, unconfirmed or personal source, and a removed project (NIV-10)", () => {
    const { data, ids } = withPreferences(["Alpha uses Jest", A], ["Keep functions small", null]);
    const id = ids[0]!;
    const edited = editPreference(data, id, { statement: "Alpha uses Vitest" }, later).data;
    const replaced = supersedePreference(data, id, { statement: "Alpha uses Vitest", intent: "default" }, later).data;
    const removed = { ...data, projects: data.projects.filter((project) => project.id !== A) };
    const suggested = { ...data, preferences: data.preferences.map((record) => record.id === id ? { ...record, status: "suggested" as const, confirmedAt: null } : record) };
    for (const candidate of [edited, replaced, deletePreference(data, id), removed, suggested]) {
      const before = JSON.stringify(candidate);
      assert.throws(() => promotePreference(candidate, id, 1, "Prefer Vitest", later), /Reopen Use in every project/);
      assert.equal(JSON.stringify(candidate), before, "a refusal leaves the records unchanged");
    }
    assert.throws(() => promotePreference(data, ids[1]!, 1, "Prefer Vitest", later), /Reopen Use in every project/);
    assert.equal(promotePreference(edited, id, 2, "Prefer Vitest", later).created, true, "a fresh source review is accepted");
  });

  it("deduplicates trimmed exact personal wording, even at capacity, without changing the source or revision (NIV-10)", () => {
    let { data, ids } = withPreferences(["Alpha uses Jest", A], ["Prefer Vitest", null]);
    for (let i = data.preferences.length; i < MAX_PREFERENCES; i++) data = addPreference(data, { statement: `Other preference ${i}`, scope: "personal", projectId: null }, now).data;
    const existing = promotePreference(data, ids[0]!, 1, " Prefer Vitest ", later);
    assert.deepEqual([existing.created, existing.record.id, existing.data.preferencesRevision], [false, ids[1], data.preferencesRevision]);
    assert.equal(existing.data, data);
    assert.throws(() => promotePreference(data, ids[0]!, 1, "Prefer vitest", later), /at most 50 preferences/);
    assert.throws(() => promotePreference(data, ids[0]!, 1, "   ", later), /needs some words/);
    assert.throws(() => promotePreference(data, ids[0]!, 1, "x".repeat(501), later), /at most 500 characters/);
    const deleted = deletePreference(data, ids[1]!);
    assert.equal(promotePreference(deleted, ids[0]!, 1, "Prefer Vitest", later).created, true, "a later explicit confirmation can recreate a deleted default");
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

  it("exports only the confirmed preferences in the scopes chosen, each source project by a key of its own and its label (D23)", () => {
    const { data, ids } = withPreferences(["Prefer named exports", null], ["Tests in __tests__", A], ["Tests next to the code", B]);
    const replaced = supersedePreference(data, ids[0]!, { statement: "Prefer default exports", intent: "default" }, later).data;
    const { text, count } = buildExport(replaced, { personal: true, projectIds: [A] }, ["sk-saved-key-0123456789"], later);
    const file = JSON.parse(text) as { format: string; version: number; projects: unknown[]; preferences: unknown[] };
    assert.deepEqual([count, file.format, file.version, file.projects], [2, "nivra-preferences", 2, [{ key: "p1", label: "a" }]]);
    assert.deepEqual(file.preferences, [
      { statement: "Tests in __tests__", scope: "project", project: "p1", intent: "default" },
      { statement: "Prefer default exports", scope: "personal", project: null, intent: "default" },
    ]);
    assert.equal([ids[0]!, A, B, '"id"', "revision", "/repos/", "Prefer named exports"].some((needle) => text.includes(needle)), false, "no store ids, folders, revisions or history");
    assert.throws(() => buildExport(replaced, { personal: false, projectIds: [] }, [], later), /nothing to export in the scopes you chose/);
  });

  it("refuses to export a statement that holds the saved key", () => {
    const { data } = withPreferences(["Use the key sk-saved-key-0123456789 for tests", null]);
    assert.throws(() => buildExport(data, { personal: true, projectIds: [] }, ["sk-saved-key-0123456789"], later), /holds your saved Nebius key, so nothing was exported/);
  });

  it("refuses a file that isn't an export, or names a project it doesn't list, without quoting it", () => {
    const secret = `private-${"x".repeat(20)}`;
    const v2 = (body: object) => JSON.stringify({ format: "nivra-preferences", version: 2, exportedAt: now.toISOString(), projects: [], preferences: [], ...body });
    for (const text of [
      `{"format":"something-else","secret":"${secret}"}`,
      `not json ${secret}`,
      JSON.stringify({ format: "nivra-preferences", version: 1, exportedAt: now.toISOString(), preferences: [{ statement: secret, scope: "personal", project: null, intent: "default" }] }),
      v2({ preferences: [{ statement: secret, scope: "project", project: "p1", intent: "default" }] }),
      v2({ projects: [{ key: "p1", label: secret }, { key: "p1", label: "b" }] }),
      v2({ projects: [{ key: "p1", label: secret }], preferences: [{ statement: "   ", scope: "project", project: "p1", intent: "default" }] }),
    ]) {
      assert.throws(
        () => parseImport(text),
        (error: unknown) => error instanceof Error && /isn't a Nivra preferences export/.test(error.message) && !error.message.includes(secret),
      );
    }
  });

  /** An export from a profile whose projects are `sources` ([label, folder, statement] each), plus one personal preference. */
  function exportFrom(sources: Array<[label: string, folder: string, statement: string]>) {
    let data: HostData = { version: 1, projects: [], preferences: [], preferencesRevision: 0 };
    sources.forEach(([label, folder], i) => (data = { ...data, projects: [...data.projects, { ...project(`0000000${i}-0000-4000-8000-000000000000`, folder), label }] }));
    data = addPreference(data, { statement: "Prefer named exports", scope: "personal", projectId: null }, now).data;
    sources.forEach(([, , statement], i) => (data = addPreference(data, { statement, scope: "project", projectId: data.projects[i]!.id }, now).data));
    return parseImport(buildExport(data, { personal: true, projectIds: data.projects.map((p) => p.id) }, [], now).text);
  }
  const sameName = () => exportFrom([["app", "/one/app", "Use Jest"], ["app", "/two/app", "Use Vitest"]]);
  const destination = (...folders: string[]): HostData => ({ version: 1, projects: folders.map((folder, i) => ({ ...project(`d000000${i}-0000-4000-8000-000000000000`, folder), label: "app" })), preferences: [], preferencesRevision: 0 });

  it("keeps two source projects with the same name apart, and suggests neither, with one project of that name here (D23)", () => {
    const file = sameName();
    assert.deepEqual(file.projects, [{ key: "p1", label: "app" }, { key: "p2", label: "app" }]);
    const here = destination("/home/me/app");
    const [one] = here.projects.map((p) => p.id);
    const preview = previewImport(here, file);
    assert.deepEqual(
      preview.projects.map((source) => [source.key, source.sameLabel, source.position, source.matches, source.suggested, source.entries.map((e) => e.statement)]),
      [
        ["p1", 2, 1, [one], null, ["Use Jest"]],
        ["p2", 2, 2, [one], null, ["Use Vitest"]],
      ],
    );
    // Untouched, nothing of either goes anywhere; the person's choice sends one and leaves the other out.
    const untouched = applyImport(here, file, { personal: false, projects: [{ source: "p1", project: null }, { source: "p2", project: null }] }, later);
    assert.deepEqual([untouched.added, untouched.leftOut, untouched.data], [0, 3, here]);
    const chosen = applyImport(here, file, { personal: false, projects: [{ source: "p1", project: one! }, { source: "p2", project: null }] }, later);
    assert.deepEqual([chosen.added, chosen.leftOut, chosen.data.preferences.map((p) => [p.statement, p.projectId])], [1, 2, [["Use Jest", one]]]);
  });

  it("keeps two source projects with the same name apart with two projects of that name here, each going where the person says", () => {
    const file = sameName();
    const here = destination("/home/me/app", "/work/app");
    const [first, second] = here.projects.map((p) => p.id);
    assert.deepEqual(previewImport(here, file).projects.map((source) => [source.matches.length, source.suggested]), [[2, null], [2, null]]);
    const imported = applyImport(here, file, { personal: false, projects: [{ source: "p1", project: second! }, { source: "p2", project: first! }] }, later);
    assert.deepEqual(imported.data.preferences.map((p) => [p.statement, p.projectId, p.origin]), [["Use Jest", second, "imported"], ["Use Vitest", first, "imported"]]);
  });

  it("suggests a destination only when one project here has the name and no other project in the file does", () => {
    const file = exportFrom([["web", "/one/web", "Use Mantine"], ["api", "/one/api", "Use Fastify"]]);
    const here: HostData = { version: 1, projects: [{ ...project(B, "/home/me/web"), label: "web" }], preferences: [], preferencesRevision: 0 };
    assert.deepEqual(previewImport(here, file).projects.map((source) => [source.label, source.suggested]), [["web", B], ["api", null]]);
    // A project the file lists without preferences brings nothing, so it neither shows nor makes a label ambiguous.
    const edited = parseImport(JSON.stringify({ ...file, projects: [...file.projects, { key: "p3", label: "web" }] }));
    assert.deepEqual(previewImport(here, edited).projects.map((source) => [source.key, source.sameLabel, source.position, source.suggested]), [["p1", 1, 1, B], ["p2", 1, 1, null]]);
  });

  it("leaves the file's personal preferences out when the person says so, and every other project's runs unchanged (D23)", () => {
    const file = exportFrom([["a", "/one/a", "Tests in __tests__"]]);
    const { data: before } = withPreferences(["Keep functions small", null], ["Run checks through pnpm scripts", B]);
    const imported = applyImport(before, file, { personal: false, projects: [{ source: "p1", project: A }] }, later);
    assert.deepEqual([imported.added, imported.leftOut], [1, 1]);
    assert.deepEqual(imported.data.preferences.slice(0, -1), before.preferences, "what was here is untouched");
    assert.deepEqual(imported.data.preferences.map((p) => [p.statement, p.scope, p.projectId]).at(-1), ["Tests in __tests__", "project", A]);
    assert.deepEqual(snapshotFor(imported.data, B).records, snapshotFor(before, B).records, "another project's runs get what they got before");
    assert.deepEqual(snapshotFor(imported.data, A).records.map((r) => r.statement), ["Keep functions small", "Tests in __tests__"], "no personal preference came from the file");
  });

  it("imports as the person chose, skipping what is already here, as confirmed and imported, within the limit (D23)", () => {
    const { data } = withPreferences(["Prefer named exports", null]);
    const file = exportFrom([["a", "/one/a", "Tests in __tests__"], ["b", "/one/b", "Replace Jest with Vitest"]]);
    const imported = applyImport(data, file, { personal: true, projects: [{ source: "p1", project: A }, { source: "p2", project: null }] }, later);
    assert.deepEqual([imported.added, imported.alreadyHere, imported.leftOut, imported.data.preferencesRevision], [1, 1, 1, data.preferencesRevision + 1]);
    const added = imported.data.preferences.at(-1)!;
    assert.deepEqual([added.statement, added.scope, added.projectId, added.status, added.origin, added.confirmedAt], ["Tests in __tests__", "project", A, "confirmed", "imported", later.toISOString()]);
    assert.equal(applyImport(imported.data, file, { personal: true, projects: [{ source: "p1", project: A }, { source: "p2", project: null }] }, later).data, imported.data, "importing it again adds nothing");

    // A choice that doesn't match the file, or names a project that has gone, is refused.
    assert.throws(() => applyImport(data, file, { personal: true, projects: [{ source: "p1", project: A }] }, later), /don't match the file/);
    assert.throws(() => applyImport(data, file, { personal: true, projects: [{ source: "p1", project: A }, { source: "p2", project: null }, { source: "p3", project: null }] }, later), /don't match the file/);
    assert.throws(() => applyImport(data, file, { personal: true, projects: [{ source: "p1", project: "33333333-3333-4333-8333-333333333333" }, { source: "p2", project: null }] }, later), /no longer in the list/);
    let full = data;
    for (let i = 1; i < MAX_PREFERENCES; i++) full = addPreference(full, { statement: `Preference ${i}`, scope: "personal", projectId: null }, now).data;
    assert.throws(() => applyImport(full, file, { personal: true, projects: [{ source: "p1", project: A }, { source: "p2", project: B }] }, later), /past 50 preferences, replaced ones included \(50 now, 2 to add\)/);
  });
});
