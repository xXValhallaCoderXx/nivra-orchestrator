import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskForStorage, maskValue, refuseCredentials } from "../src/main/protect.ts";

const KEY = "test-key-0123456789abcdef";
const known = [["NEBIUS_API_KEY", KEY]] as const;
// Fake credentials, built from parts so no whole token sits in the source.
const TOKEN = `ghp_${"q".repeat(36)}`;
const BLOCK = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";

describe("one protection policy for what the workspace keeps (D8, D26)", () => {
  it("refuses typed text holding the saved key or a recognised credential, naming the field and the kind, never the value", () => {
    assert.throws(() => refuseCredentials("Your message", `use ${KEY} here`, known, "send"), (error: Error) => error.message === "Your message holds your saved Token Factory key, so nothing was sent. Remove it, then send again." && !error.message.includes(KEY));
    assert.throws(() => refuseCredentials("The goal", `token ${TOKEN}`, known), (error: Error) => error.message === "The goal looks like it holds a GitHub token, so nothing was saved. Remove it, then save again." && !error.message.includes(TOKEN));
    assert.throws(() => refuseCredentials("The plan", BLOCK, known), /^Error: The plan looks like it holds a private key/);
    assert.doesNotThrow(() => refuseCredentials("Your message", "Rotate the GitHub token and AWS_SECRET_ACCESS_KEY monthly.", known, "send"));
  });

  it("masks what the engine or a model produced, keeping its line breaks, in every string of a structured reply", () => {
    assert.equal(maskForStorage(`k ${KEY}\n${TOKEN}`, known), "k [secret:NEBIUS_API_KEY]\n[redacted]");
    const masked = maskValue({ kind: "repository", answer: `see ${KEY}`, evidence: [{ statement: TOKEN, citations: [{ path: "a.ts", startLine: 1 }] }], cutOff: false }, known);
    assert.deepEqual(masked, { kind: "repository", answer: "see [secret:NEBIUS_API_KEY]", evidence: [{ statement: "[redacted]", citations: [{ path: "a.ts", startLine: 1 }] }], cutOff: false });
    assert.equal(maskForStorage(BLOCK, known).split("\n").length, BLOCK.split("\n").length);
  });
});
