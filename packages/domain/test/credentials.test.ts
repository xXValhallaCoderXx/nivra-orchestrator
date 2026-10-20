import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combinedMask, hasKeyBlock, maskKnownValues, maskSecretPatterns, secretShapes } from "../src/credentials.ts";

// Fake credentials in each recognised shape, built from parts so no whole token sits in the source: none is real.
const SAMPLES = {
  "aws-access-key": `AKIA${"QWERTYUI".repeat(2)}`,
  "github-token": `ghp_${"a".repeat(36)}`,
  "github-fine-grained-token": `github_pat_${"b".repeat(22)}`,
  "api-key": `sk-proj-${"c".repeat(24)}`,
  "slack-token": `xoxb-${"1234567890"}-abcdef`,
  "linear-token": `lin_api_${"d".repeat(24)}`,
} as const;
const KEY_BLOCK = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----";

describe("credential shapes, shared by the engine and the host (D22, D26)", () => {
  it("names each shape it finds, a private key block first, and never the value", () => {
    for (const [id, sample] of Object.entries(SAMPLES)) assert.deepEqual(secretShapes(`before ${sample} after`), [id], id);
    assert.deepEqual(secretShapes(`${KEY_BLOCK}\n${SAMPLES["aws-access-key"]}`), ["private-key", "aws-access-key"]);
    assert.deepEqual(secretShapes("rotate AWS_SECRET_ACCESS_KEY and the GitHub token monthly"), []);
  });

  it("masks every shape, and keeps a key block's line breaks when asked, so line numbers stay right", () => {
    const text = `a ${SAMPLES["github-token"]} b\n${KEY_BLOCK}\nlast`;
    assert.equal(maskSecretPatterns(text), "a [redacted] b\n[redacted]\nlast");
    const kept = maskSecretPatterns(text, { keepLines: true });
    assert.equal(kept.split("\n").length, text.split("\n").length);
    assert.equal(hasKeyBlock(kept), false);
  });

  it("masks known values longest first, so a value inside another is replaced whole, then the shapes", () => {
    const values = [["SHORT", "abc12345"], ["LONG", "xyz-abc12345-long"]] as const;
    assert.equal(maskKnownValues("k=xyz-abc12345-long and abc12345", values), "k=[secret:LONG] and [secret:SHORT]");
    assert.equal(maskKnownValues("nothing here", []), "nothing here");
    assert.equal(maskKnownValues("an empty value is ignored", [["EMPTY", ""]]), "an empty value is ignored");
    const mask = combinedMask((text) => maskKnownValues(text, values));
    assert.equal(mask(`abc12345 ${SAMPLES["slack-token"]}`), "[secret:SHORT] [redacted]");
  });
});
