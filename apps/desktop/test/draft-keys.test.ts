import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containsSavedKey, DRAFT_KEY_NAMES } from "../src/main/draft-keys.ts";

// Synthetic keys, as the specs save: no recognised credential format, so only the saved-key check can catch them.
const NEBIUS = "test-key-0123456789";
const TAVILY = "test-tavily-key-9876543210";

/**
 * A draft against the API keys Nivra keeps (NIV-56; Nate, 29 Oct): yes or no, and nothing else. A key that can't be
 * read never reaches this: the store's strict read throws first (secret-store.test.ts).
 */
describe("a draft against the saved API keys (NIV-56)", () => {
  it("checks the Nebius and Tavily keys, never the project ID", () => {
    assert.deepEqual([...DRAFT_KEY_NAMES], ["NEBIUS_API_KEY", "TAVILY_API_KEY"]);
  });

  it("finds a whole saved key anywhere in the text, other words around it or not", () => {
    const values = [NEBIUS, TAVILY];
    assert.deepEqual(
      [`Use ${NEBIUS} for the call`, NEBIUS, `prefix${TAVILY}suffix`, `two lines\nthen ${TAVILY}`].map((text) => containsSavedKey(text, values)),
      [true, true, true, true],
    );
  });

  it("never matches part of a key, and ignores an empty one and no keys at all", () => {
    assert.deepEqual(
      ["test-key-012345678", "0123456789", "Use test-key- and 0123456789 apart", "", "Any text at all"].map((text) => containsSavedKey(text, [NEBIUS, ""])),
      [false, false, false, false, false],
    );
    assert.equal(containsSavedKey(`Use ${NEBIUS}`, []), false);
  });
});
