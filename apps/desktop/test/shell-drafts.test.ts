import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { secretShapes } from "@nivra/domain";
import { holdsCredential, looksLikeCredential } from "../src/renderer/src/shell/credentials.ts";
import { createDraftStore, DRAFT_PREFIX, duringKeyChange, type SavedKeyCheck } from "../src/renderer/src/shell/draft-store.ts";
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

// Synthetic saved keys, as the specs save: no recognised format, so only the saved-key check can catch them.
const SAVED = "test-key-0123456789";
const LATER = "test-key-later-555555";

/** Main's check, standing in: the keys saved now, how often it was asked, and a way to make it fail. */
function savedKeys(...keys: string[]) {
  const state = { keys: new Set(keys), calls: 0, failing: false };
  const check: SavedKeyCheck = async (text) => {
    state.calls += 1;
    if (state.failing) throw new Error("A saved key can't be read here.");
    return [...state.keys].some((key) => text.includes(key));
  };
  return { state, check };
}

/** A check whose answers the test hands out, in any order. */
function heldChecks() {
  const waiting: Array<{ text: string; answer(holds: boolean): void }> = [];
  const check: SavedKeyCheck = (text) => new Promise((resolve) => waiting.push({ text, answer: resolve }));
  return { waiting, check };
}

const clock = (iso: string) => () => new Date(iso);
const at = (storage: FakeStorage, key: string) => storage.entries.get(DRAFT_PREFIX + key);

describe("the draft store (NIV-56, R30)", () => {
  it("keeps a draft under the versioned prefix once it is checked, reads it back, and lists the newest first", async () => {
    const storage = new FakeStorage();
    let now = "2026-10-28T13:41:00.000Z";
    const keys = savedKeys();
    const store = createDraftStore(storage, keys.check, () => new Date(now));
    assert.deepEqual(await store.write("home-composer:project:a", { title: "Add CSV export" }, "Add CSV export"), { kept: true });
    now = "2026-10-28T13:45:00.000Z";
    assert.deepEqual(await store.write("brief:t1:1", { goal: "A goal" }, "Fix rounding"), { kept: true });
    assert.deepEqual([...storage.entries.keys()].sort(), [`${DRAFT_PREFIX}brief:t1:1`, `${DRAFT_PREFIX}home-composer:project:a`]);
    assert.deepEqual(JSON.parse(at(storage, "home-composer:project:a")!), { label: "Add CSV export", savedAt: "2026-10-28T13:41:00.000Z", value: { title: "Add CSV export" } });
    assert.deepEqual(store.read("home-composer:project:a"), { title: "Add CSV export" });
    assert.deepEqual(store.list().map((draft) => draft.key), ["brief:t1:1", "home-composer:project:a"]);
    assert.deepEqual([store.available, store.unchecked, keys.state.calls], [true, false, 2]);
  });

  it("shows a stored copy only once it is checked against the current keys, as after a restart, and forgets a discarded one", async () => {
    const storage = new FakeStorage();
    await createDraftStore(storage, savedKeys().check, clock("2026-10-28T10:00:00.000Z")).write("home-composer:general", { title: "Kept" }, "Kept");
    const again = createDraftStore(storage, savedKeys().check);
    assert.deepEqual([again.read("home-composer:general"), again.list().length], [null, 0]);
    await again.recheck();
    assert.deepEqual(again.read("home-composer:general"), { title: "Kept" });
    again.discard("home-composer:general");
    assert.deepEqual([again.read("home-composer:general"), again.list().length, storage.entries.size], [null, 0, 0]);
  });

  it("refuses a recognised credential format at once, without asking main, and removes the copy kept before", async () => {
    const storage = new FakeStorage();
    const keys = savedKeys();
    const store = createDraftStore(storage, keys.check, clock("2026-10-28T10:00:00.000Z"));
    await store.write("home-composer:general", { title: "Use the key" }, "Use the key");
    const asked = keys.state.calls;
    assert.deepEqual(await store.write("home-composer:general", { title: `Use the key ${FAKE_GITHUB}` }, "Use the key"), { kept: false, reason: "credential" });
    assert.deepEqual([keys.state.calls, storage.entries.size], [asked, 0]);
    assert.equal([...storage.entries.values()].some((value) => value.includes("ghp_")), false);
  });

  it("refuses a draft holding a saved key inside other text, and removes the copy kept before", async () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, savedKeys(SAVED).check, clock("2026-10-28T10:00:00.000Z"));
    await store.write("home-composer:general", { title: "Rotate the key" }, "Rotate the key");
    assert.deepEqual(await store.write("home-composer:general", { title: `Rotate the key${SAVED}today` }, "Rotate the key"), { kept: false, reason: "credential" });
    assert.deepEqual([storage.entries.size, store.list().length], [0, 0]);
  });

  it("checks the label too: a saved key in it, or a recognised format, refuses the draft", async () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, savedKeys(SAVED).check);
    assert.deepEqual(await store.write("brief:t1:1", { goal: "Fine" }, `Title with ${SAVED}`), { kept: false, reason: "credential" });
    assert.deepEqual(await store.write("brief:t1:2", { goal: "Fine" }, FAKE_KEY_BLOCK), { kept: false, reason: "credential" });
    assert.equal(storage.entries.size, 0);
  });

  it("keeps nothing it couldn't check, and keeps the copy kept before as it was", async () => {
    const storage = new FakeStorage();
    const keys = savedKeys();
    const store = createDraftStore(storage, keys.check, clock("2026-10-28T10:00:00.000Z"));
    await store.write("home-composer:general", { title: "First" }, "First");
    const before = at(storage, "home-composer:general");
    keys.state.failing = true;
    assert.deepEqual(await store.write("home-composer:general", { title: "First, then more" }, "First, then more"), { kept: false, reason: "unchecked" });
    assert.deepEqual([at(storage, "home-composer:general"), store.read("home-composer:general")], [before, { title: "First" }]);
  });

  it("stores only the latest text when answers come out of order, and an older answer never overwrites it", async () => {
    const storage = new FakeStorage();
    const held = heldChecks();
    const store = createDraftStore(storage, held.check);
    const first = store.write("home-composer:general", { title: "A" }, "A");
    const second = store.write("home-composer:general", { title: "A and B" }, "A and B");
    await Promise.resolve();
    // The label, then each object key and string as stored: what main is asked about.
    assert.deepEqual(held.waiting.map((asked) => asked.text), ["A\ntitle\nA", "A and B\ntitle\nA and B"]);
    held.waiting[1]!.answer(false);
    assert.deepEqual(await second, { kept: true });
    held.waiting[0]!.answer(false);
    assert.deepEqual(await first, { kept: false, reason: "unchecked" });
    assert.deepEqual(store.read("home-composer:general"), { title: "A and B" });
    // A late match for older text never removes the newer copy either.
    const third = store.write("home-composer:general", { title: "C" }, "C");
    const fourth = store.write("home-composer:general", { title: "C, D" }, "C, D");
    await Promise.resolve();
    held.waiting[3]!.answer(false);
    await fourth;
    held.waiting[2]!.answer(true);
    await third;
    assert.deepEqual(store.read("home-composer:general"), { title: "C, D" });
  });

  it("never stores a write that a discard overtook", async () => {
    const storage = new FakeStorage();
    const held = heldChecks();
    const store = createDraftStore(storage, held.check);
    const pending = store.write("home-composer:general", { title: "Typed, then cleared" }, "Typed, then cleared");
    await Promise.resolve();
    store.discard("home-composer:general");
    held.waiting[0]!.answer(false);
    await pending;
    assert.equal(storage.entries.size, 0);
  });

  it("checks stored copies again: one that fails is removed, one that can't be checked is kept out of sight", async () => {
    const storage = new FakeStorage();
    const record = (title: string) => JSON.stringify({ label: title, savedAt: "2026-10-28T10:00:00.000Z", value: { title } });
    storage.entries.set(`${DRAFT_PREFIX}a:clean`, record("Clean"));
    storage.entries.set(`${DRAFT_PREFIX}a:holds`, record(`Holds ${SAVED}`));
    storage.entries.set(`${DRAFT_PREFIX}a:format`, record(`Holds ${FAKE_GITHUB}`));
    const keys = savedKeys(SAVED);
    const store = createDraftStore(storage, keys.check);
    await store.recheck();
    assert.deepEqual([store.list().map((draft) => draft.key), [...storage.entries.keys()].sort()], [["a:clean"], [`${DRAFT_PREFIX}a:clean`]]);
    // A check that errors hides the copy and says so, but keeps it.
    keys.state.failing = true;
    await store.recheck();
    assert.deepEqual([store.list().length, store.read("a:clean"), store.unchecked, storage.entries.has(`${DRAFT_PREFIX}a:clean`)], [0, null, true, true]);
    keys.state.failing = false;
    await store.recheck();
    assert.deepEqual([store.list().map((draft) => draft.key), store.unchecked], [["a:clean"], false]);
  });

  it("asks again when a key was saved while a write was being checked, so an answer about the old keys never keeps it", async () => {
    const storage = new FakeStorage();
    const keys = new Set<string>();
    // The write's own check is held; every later one answers from the keys saved by then.
    let held: ((holds: boolean) => void) | null = null;
    let asked = 0;
    const check: SavedKeyCheck = (text) => {
      asked += 1;
      if (asked === 1) return new Promise((resolve) => (held = resolve));
      return Promise.resolve([...keys].some((key) => text.includes(key)));
    };
    const store = createDraftStore(storage, check);
    const written = store.write("home-composer:general", { title: `Rotate ${LATER}` }, "Rotate");
    await Promise.resolve();
    keys.add(LATER);
    await store.recheck();
    held!(false);
    assert.deepEqual(await written, { kept: false, reason: "credential" });
    assert.deepEqual([storage.entries.size, store.list().length, store.read("home-composer:general")], [0, 0, null]);
    // A clean text in the same race is kept, on the current keys' answer, and not called unchecked.
    asked = 0;
    const clean = store.write("home-composer:general", { title: "Rotate the deploy key on Friday" }, "Rotate");
    await Promise.resolve();
    await store.recheck();
    held!(false);
    assert.deepEqual(await clean, { kept: true });
    assert.deepEqual(store.read("home-composer:general"), { title: "Rotate the deploy key on Friday" });
  });

  it("removes, after a recheck, a copy that holds a key saved since it was kept", async () => {
    const storage = new FakeStorage();
    const keys = savedKeys();
    const store = createDraftStore(storage, keys.check);
    assert.deepEqual(await store.write("home-composer:general", { title: `Rotate ${LATER}` }, "Rotate"), { kept: true });
    keys.state.keys.add(LATER);
    await store.recheck();
    assert.deepEqual([store.read("home-composer:general"), store.list().length, storage.entries.size], [null, 0, 0]);
  });

  it("says when storage refused a write, deletes nothing, and keeps the earlier copy", async () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, savedKeys().check, clock("2026-10-28T10:00:00.000Z"));
    await store.write("home-composer:general", { title: "First" }, "First");
    storage.fail.add("write");
    assert.deepEqual(await store.write("home-composer:general", { title: "First, then more" }, "First, then more"), { kept: false, reason: "storage" });
    assert.deepEqual([store.read("home-composer:general"), store.list().length], [{ title: "First" }, 1]);
  });

  it("works with storage that can't be read at all: it says so, reads nothing and keeps nothing", async () => {
    const storage = new FakeStorage();
    storage.fail.add("read");
    storage.fail.add("write");
    const store = createDraftStore(storage, savedKeys().check);
    assert.equal(store.available, false);
    assert.deepEqual([store.read("x:y"), store.list(), await store.write("home-composer:general", { title: "T" }, "T")], [null, [], { kept: false, reason: "storage" }]);
    const none = createDraftStore(null, savedKeys().check);
    assert.deepEqual([none.available, none.list(), await none.write("a:b", "text", "label")], [false, [], { kept: false, reason: "storage" }]);
    assert.doesNotThrow(() => none.discard("a:b"));
    await assert.doesNotReject(() => none.recheck());
  });

  it("skips entries it can't read as drafts, and tells its listeners about every change", async () => {
    const storage = new FakeStorage();
    storage.entries.set(`${DRAFT_PREFIX}broken`, "{not json");
    storage.entries.set(`${DRAFT_PREFIX}partial`, JSON.stringify({ label: "No time" }));
    storage.entries.set("someone-else", JSON.stringify({ label: "x", savedAt: "y", value: 1 }));
    const store = createDraftStore(storage, savedKeys().check);
    await store.recheck();
    let heard = 0;
    const stop = store.subscribe(() => (heard += 1));
    await store.write("a:b", "text", "label");
    store.discard("a:b");
    stop();
    await store.write("a:c", "text", "label");
    assert.deepEqual([store.list().map((draft) => draft.key), heard], [["a:c"], 2]);
  });

  it("hides every stored copy while a key is saved, checks a write made meanwhile only once it settles, then checks every copy against the keys as they are", async () => {
    const storage = new FakeStorage();
    const keys = savedKeys();
    const store = createDraftStore(storage, keys.check, clock("2026-10-28T10:00:00.000Z"));
    await store.write("home-composer:general", { title: `Rotate ${LATER}` }, "Rotate");
    await store.write("new-task:general", { title: "Fix rounding" }, "Fix rounding");
    const settle = store.keysChanging();
    assert.deepEqual([store.list().length, store.read("home-composer:general"), store.read("new-task:general")], [0, null, null]);
    const asked = keys.state.calls;
    const written = store.write("home-composer:project:p1", { title: `Use ${LATER} here` }, "Use");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual([keys.state.calls - asked, storage.entries.has(`${DRAFT_PREFIX}home-composer:project:p1`), store.list().length], [0, false, 0]);
    // The save wrote the key, then settled.
    keys.state.keys.add(LATER);
    await settle();
    assert.deepEqual(await written, { kept: false, reason: "credential" });
    assert.deepEqual([store.list().map((draft) => draft.key), [...storage.entries.keys()]], [["new-task:general"], [`${DRAFT_PREFIX}new-task:general`]]);
  });

  it("shows nothing until every key change under way has settled, a failed one too", async () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, savedKeys().check);
    await store.write("a:b", "text", "label");
    const first = store.keysChanging();
    const second = store.keysChanging();
    await first();
    assert.equal(store.list().length, 0);
    await second();
    await second();
    assert.deepEqual(store.list().map((draft) => draft.key), ["a:b"]);
  });

  it("never lets an older recheck remove a copy a write replaced meanwhile, even one that held a recognised format", async () => {
    const storage = new FakeStorage();
    const held = heldChecks();
    storage.entries.set(`${DRAFT_PREFIX}a:first`, JSON.stringify({ label: "First", savedAt: "2026-10-28T10:00:00.000Z", value: "fine" }));
    storage.entries.set(`${DRAFT_PREFIX}b:second`, JSON.stringify({ label: "Second", savedAt: "2026-10-28T10:00:00.000Z", value: FAKE_GITHUB }));
    const store = createDraftStore(storage, held.check);
    const pass = store.recheck();
    const written = store.write("b:second", "clean now", "Second");
    assert.equal(held.waiting.length, 2);
    held.waiting[1]!.answer(false);
    assert.deepEqual(await written, { kept: true });
    held.waiting[0]!.answer(false);
    await pass;
    assert.deepEqual([store.read("a:first"), store.read("b:second")], ["fine", "clean now"]);
  });

  it("takes every copy out of sight when a recheck can't read storage, and tells its listeners", async () => {
    const storage = new FakeStorage();
    const store = createDraftStore(storage, savedKeys().check);
    await store.write("a:b", "text", "label");
    let heard = 0;
    store.subscribe(() => (heard += 1));
    storage.fail.add("read");
    await store.recheck();
    storage.fail.delete("read");
    assert.deepEqual([store.list().length, store.read("a:b"), heard > 0], [0, null, true]);
  });

  it("checks a draft's object keys as well as its values, since both are stored", async () => {
    assert.equal(holdsCredential({ fine: { [FAKE_GITHUB]: 1 } }), true);
    const storage = new FakeStorage();
    const keys = savedKeys(SAVED);
    const store = createDraftStore(storage, keys.check);
    assert.deepEqual(await store.write("a:b", { [FAKE_GITHUB]: "value" }, "label"), { kept: false, reason: "credential" });
    assert.equal(keys.state.calls, 0);
    assert.deepEqual(await store.write("a:c", { fields: { [`note ${SAVED}`]: true } }, "label"), { kept: false, reason: "credential" });
    assert.equal(storage.entries.size, 0);
  });

  it("runs a key's save with every draft out of sight, and checks them all once it settles, a failed save too", async () => {
    const storage = new FakeStorage();
    const keys = savedKeys();
    const store = createDraftStore(storage, keys.check);
    await store.write("a:b", { title: `Use ${LATER}` }, "Use");
    await store.write("a:c", "clean", "Clean");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    let during = -1;
    const saved = await duringKeyChange(store, async () => {
      during = store.list().length;
      keys.state.keys.add(LATER);
      return "saved";
    });
    await settle();
    assert.deepEqual([saved, during, store.list().map((draft) => draft.key)], ["saved", 0, ["a:c"]]);
    during = -1;
    await assert.rejects(
      duringKeyChange(store, async () => {
        during = store.list().length;
        throw new Error("The save was refused.");
      }),
      /refused/,
    );
    await settle();
    assert.deepEqual([during, store.list().map((draft) => draft.key)], [0, ["a:c"]]);
  });
});
