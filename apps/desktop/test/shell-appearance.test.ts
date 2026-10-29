import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLOR_SCHEME_KEY, createColorSchemeManager } from "../src/renderer/src/shell/color-scheme.ts";
import { FakeStorage } from "./fixtures/fake-storage.ts";

describe("the colour scheme manager (NIV-56, R29)", () => {
  it("keeps the choice under its versioned key and reads it back, System by default", () => {
    const storage = new FakeStorage();
    const manager = createColorSchemeManager(() => storage);
    assert.equal(manager.get("auto"), "auto");
    manager.set("dark");
    assert.deepEqual([storage.entries.get(COLOR_SCHEME_KEY), manager.get("auto"), manager.saveFailed()], ["dark", "dark", false]);
    storage.entries.set(COLOR_SCHEME_KEY, "purple");
    assert.equal(manager.get("auto"), "auto");
  });

  it("says when the choice couldn't be kept, and clears that once a later choice is", () => {
    const storage = new FakeStorage();
    const manager = createColorSchemeManager(() => storage);
    let heard = 0;
    manager.onSaveFailedChange(() => (heard += 1));
    storage.fail.add("write");
    manager.set("light");
    assert.deepEqual([manager.saveFailed(), heard, storage.entries.has(COLOR_SCHEME_KEY)], [true, 1, false]);
    storage.fail.delete("write");
    manager.set("light");
    assert.deepEqual([manager.saveFailed(), heard, storage.entries.get(COLOR_SCHEME_KEY)], [false, 2, "light"]);
  });

  it("never throws when storage does, or when there is none", () => {
    const storage = new FakeStorage();
    storage.fail = new Set(["read", "write", "remove"]);
    const manager = createColorSchemeManager(() => storage);
    assert.equal(manager.get("auto"), "auto");
    assert.doesNotThrow(() => manager.clear());
    manager.set("dark");
    assert.equal(manager.saveFailed(), true);
    const none = createColorSchemeManager(() => {
      throw new Error("SecurityError");
    });
    assert.equal(none.get("light"), "light");
    none.set("dark");
    assert.equal(none.saveFailed(), true);
  });
});
