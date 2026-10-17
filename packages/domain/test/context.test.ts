import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { MAX_PREFERENCES, preferencesDigest, RunContext, type SnapshotPreference } from "../src/context.ts";

const record = (statement = "Use pnpm", revision = 1): SnapshotPreference => ({ id: randomUUID(), statement, scope: "personal", intent: "default", revision });

describe("RunContext", () => {
  const sharing = { modelContext: false };

  it("accepts an empty snapshot and one at the limit", () => {
    assert.equal(RunContext.safeParse({ preferences: { revision: 0, records: [] }, sharing }).success, true);
    assert.equal(RunContext.safeParse({ preferences: { revision: 9, records: Array.from({ length: MAX_PREFERENCES }, () => record()) }, sharing: { modelContext: true } }).success, true);
  });

  it("refuses a missing snapshot or consent, too many records, a record twice, an empty statement and unknown fields", () => {
    const twice = record();
    const refused = [
      { sharing },
      { preferences: { revision: 1, records: [] } },
      { preferences: { revision: 1, records: Array.from({ length: MAX_PREFERENCES + 1 }, () => record()) }, sharing },
      { preferences: { revision: 1, records: [twice, twice] }, sharing },
      { preferences: { revision: 1, records: [record("")] }, sharing },
      { preferences: { revision: 1, records: [{ ...record(), projectId: randomUUID() }] }, sharing },
      { preferences: { revision: 1, records: [] }, sharing, path: "/home/someone/.config/Nivra/nivra.json" },
      { preferences: { revision: 1, records: [] }, sharing: { modelContext: "yes" } },
    ];
    assert.deepEqual(refused.map((context) => RunContext.safeParse(context).success), refused.map(() => false));
  });

  it("requires every record's intent, and lets only a project's own preference override its conventions (D23)", () => {
    const { intent: _intent, ...withoutIntent } = record();
    const parse = (records: unknown[]) => RunContext.safeParse({ preferences: { revision: 1, records }, sharing }).success;
    assert.deepEqual(
      [
        parse([withoutIntent]),
        parse([{ ...record(), intent: "override" }]),
        parse([{ ...record(), intent: "always" }]),
        parse([{ ...record(), scope: "project", intent: "override" }]),
        parse([{ ...record(), scope: "project", intent: "default" }]),
      ],
      [false, false, false, true, true],
    );
  });
});

describe("preferencesDigest", () => {
  it("is SHA-256 of the records as [id, scope, intent, revision, statement], sorted by id", async () => {
    const records = [record("b"), record("a ü%#", 4)];
    const sorted = [...records].sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, r.scope, r.intent, r.revision, r.statement]);
    assert.equal(await preferencesDigest(records), createHash("sha256").update(JSON.stringify(sorted)).digest("hex"));
    assert.equal(await preferencesDigest([]), createHash("sha256").update("[]").digest("hex"));
  });

  it("ignores the order records arrive in, and changes with any statement, scope, intent or revision", async () => {
    const [a, b] = [{ ...record("Prefer named exports"), scope: "project" as const }, record("Keep tests next to the code")] as const;
    const digest = await preferencesDigest([a, b]);
    assert.equal(await preferencesDigest([b, a]), digest);
    const changed = [
      [{ ...a, statement: "Prefer default exports" }, b],
      [{ ...a, scope: "personal" as const }, b],
      [{ ...a, intent: "override" as const }, b],
      [{ ...a, revision: 2 }, b],
      [a],
    ];
    for (const records of changed) assert.notEqual(await preferencesDigest(records), digest);
  });
});
