import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { secretShapes } from "@nivra/domain";
import { holdsCredential, looksLikeCredential } from "../src/renderer/src/shell/credentials.ts";
import { createDraftStore, DRAFT_PREFIX } from "../src/renderer/src/shell/draft-store.ts";
import { FakeStorage } from "./fixtures/fake-storage.ts";

// Shapes only: none of these is a real credential.
const FAKE_GITHUB = `ghp_${"a".repeat(36)}`;
const FAKE_KEY_BLOCK = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
const SAMPLES = [
  "Add CSV export for invoices",
  "Use the key sk-short",
  `Use sk-${"x".repeat(24)} for the call`,
  `sk-proj-${"Y".repeat(30)}`,
  `${"AKIA"}${"ABCDEFGHIJKLMNOP"}`,
  `${"ASIA"}${"0123456789ABCDEF"} and more`,
  FAKE_GITHUB,
  `github_pat_${"b".repeat(22)}`,
  "xoxb-1234567890-abc",
  `lin_api_${"c".repeat(20)}`,
  `tvly-${"d".repeat(16)}`,
  FAKE_KEY_BLOCK,
  "-----BEGIN RSA PRIVATE KEY----- but no end",
  "-----END RSA PRIVATE KEY----- before -----BEGIN RSA PRIVATE KEY-----",
  "a ghp_ token that is too short",
  "tvly-short",
];

describe("the renderer's credential check (NIV-56)", () => {
  it("finds exactly what the domain's shapes find, so the copy can't drift from packages/domain", () => {
    const disagreements = SAMPLES.filter((sample) => looksLikeCredential(sample) !== secretShapes(sample).length > 0);
    assert.deepEqual(disagreements, []);
    assert.equal(SAMPLES.filter(looksLikeCredential).length, 10);
  });

  it("looks inside a draft's every string, wherever it sits", () => {
    assert.equal(holdsCredential({ title: "Fine", fields: { goal: "Fine", criteria: ["one", `two ${FAKE_GITHUB}`] } }), true);
    assert.equal(holdsCredential({ title: "Fine", count: 3, done: false, nothing: null }), false);
  });
});

describe("the draft store (NIV-56, R30)", () => {
  const clock = (iso: string) => () => new Date(iso);

  it("keeps a draft under the versioned prefix, reads it back, and lists the newest first", () => {
    const storage = new FakeStorage();
    let now = "2026-10-28T13:41:00.000Z";
    const store = createDraftStore(storage, () => new Date(now));
    assert.deepEqual(store.write("home-composer:project:a", { title: "Add CSV export" }, "Add CSV export"), { kept: true });
    now = "2026-10-28T13:45:00.000Z";
    assert.deepEqual(store.write("brief:t1:1", { goal: "A goal" }, "Fix rounding"), { kept: true });
    assert.deepEqual([...storage.entries.keys()].sort(), [`${DRAFT_PREFIX}brief:t1:1`, `${DRAFT_PREFIX}home-composer:project:a`]);
    assert.deepEqual(JSON.parse(storage.entries.get(`${DRAFT_PREFIX}home-composer:project:a`)!), { label: "Add CSV export", savedAt: "2026-10-28T13:41:00.000Z", value: { title: "Add CSV export" } });
    assert.deepEqual(store.read("home-composer:project:a"), { title: "Add CSV export" });
    assert.deepEqual(store.list().map((draft) => draft.key), ["brief:t1:1", "home-composer:project:a"]);
    assert.equal(store.available, true);
  });

  it("survives a new store over the same storage, as a restart does, and forgets a discarded draft", () => {
    const storage = new FakeStorage();
    createDraftStore(storage, clock("2026-10-28T10:00:00.000Z")).write("home-composer:general", { title: "Kept" }, "Kept");
    const again = createDraftStore(storage);
    assert.deepEqual(again.read("home-composer:general"), { title: "Kept" });
    again.discard("home-composer:general");
    assert.deepEqual([again.read("home-composer:general"), again.list().length], [null, 0]);
  });

  it("never keeps a draft that looks like it holds a credential, and removes the copy it kept before", () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, clock("2026-10-28T10:00:00.000Z"));
    store.write("home-composer:general", { title: "Use the key" }, "Use the key");
    const refused = store.write("home-composer:general", { title: `Use the key ${FAKE_GITHUB}` }, "Use the key");
    assert.deepEqual(refused, { kept: false, reason: "credential" });
    assert.equal(storage.entries.size, 0);
    assert.equal([...storage.entries.values()].some((value) => value.includes("ghp_")), false);
    assert.deepEqual(createDraftStore(storage).read("home-composer:general"), null);
    // A label is shown in the sidebar, so it is checked too.
    assert.deepEqual(store.write("brief:t1:1", { goal: "Fine" }, FAKE_KEY_BLOCK), { kept: false, reason: "credential" });
  });

  it("says when storage refused a write, deletes nothing, and keeps the earlier copy", () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, clock("2026-10-28T10:00:00.000Z"));
    store.write("home-composer:general", { title: "First" }, "First");
    storage.fail.add("write");
    assert.deepEqual(store.write("home-composer:general", { title: "First, then more" }, "First, then more"), { kept: false, reason: "storage" });
    assert.deepEqual(store.read("home-composer:general"), { title: "First" });
  });

  it("works with storage that can't be read at all: it says so, reads nothing and keeps nothing", () => {
    const storage = new FakeStorage();
    storage.fail.add("read");
    storage.fail.add("write");
    const store = createDraftStore(storage);
    assert.equal(store.available, false);
    assert.deepEqual([store.read("x:y"), store.list(), store.write("home-composer:general", { title: "T" }, "T")], [null, [], { kept: false, reason: "storage" }]);
    const none = createDraftStore(null);
    assert.deepEqual([none.available, none.list(), none.write("a:b", "text", "label")], [false, [], { kept: false, reason: "storage" }]);
    assert.doesNotThrow(() => none.discard("a:b"));
  });

  it("skips entries it can't read as drafts, and tells its listeners about every change", () => {
    const storage = new FakeStorage();
    storage.entries.set(`${DRAFT_PREFIX}broken`, "{not json");
    storage.entries.set(`${DRAFT_PREFIX}partial`, JSON.stringify({ label: "No time" }));
    storage.entries.set("someone-else", JSON.stringify({ label: "x", savedAt: "y", value: 1 }));
    const store = createDraftStore(storage);
    let heard = 0;
    const stop = store.subscribe(() => (heard += 1));
    store.write("a:b", "text", "label");
    store.discard("a:b");
    stop();
    store.write("a:c", "text", "label");
    assert.deepEqual([store.list().map((draft) => draft.key), heard, store.version()], [["a:c"], 2, 3]);
  });
});
