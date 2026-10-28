import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containsSavedKey, DRAFT_CHECK_FAILED, DRAFT_KEY_NAMES } from "../src/main/draft-keys.ts";

// Synthetic keys, as the specs save: no recognised credential format, so only the saved-key check can catch them.
const NEBIUS = "test-key-0123456789";
const TAVILY = "test-tavily-key-9876543210";
const saved = (value: string | null, state: "none" | "encrypted" | "unencrypted" | "unreadable" = value ? "encrypted" : "none") => ({ state, value });

/** A draft against the API keys Nivra keeps (NIV-56; Nate, 29 Oct): yes or no, and nothing else. */
describe("a draft against the saved API keys (NIV-56)", () => {
  it("checks the Nebius and Tavily keys, never the project ID", () => {
    assert.deepEqual([...DRAFT_KEY_NAMES], ["NEBIUS_API_KEY", "TAVILY_API_KEY"]);
  });

  it("finds a whole saved key anywhere in the text, other words around it or not", () => {
    const keys = [saved(NEBIUS), saved(TAVILY)];
    assert.deepEqual(
      [`Use ${NEBIUS} for the call`, NEBIUS, `prefix${TAVILY}suffix`, `two lines\nthen ${TAVILY}`].map((text) => containsSavedKey(text, keys)),
      [true, true, true, true],
    );
  });

  it("never matches part of a key, and ignores keys that are empty or not saved", () => {
    const keys = [saved(NEBIUS), saved(""), saved(null)];
    assert.deepEqual(
      ["test-key-012345678", "0123456789", "Use test-key- and 0123456789 apart", "", "Any text at all"].map((text) => containsSavedKey(text, keys)),
      [false, false, false, false, false],
    );
    assert.equal(containsSavedKey("unencrypted keys count the same: test-key-0123456789", [saved(NEBIUS, "unencrypted")]), true);
  });

  it("fails when a saved key can't be read, in words that hold neither the draft nor a key", () => {
    const text = `Use ${NEBIUS} here`;
    assert.throws(() => containsSavedKey(text, [saved(NEBIUS), saved(null, "unreadable")]), (error: Error) => {
      assert.equal(error.message, DRAFT_CHECK_FAILED);
      assert.equal([text, NEBIUS].some((secret) => error.message.includes(secret)), false);
      return true;
    });
  });
});
