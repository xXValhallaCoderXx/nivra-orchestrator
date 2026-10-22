import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskForStorage, maskValue, refuseCredentials } from "../src/main/protect.ts";

const KEY = "test-key-0123456789abcdef";
const known = [["NEBIUS_API_KEY", KEY]] as const;
// Fake credentials, built from parts so no whole token sits in the source.
const TOKEN = `ghp_${"q".repeat(36)}`;
const BLOCK = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";

describe("one protection policy for what the workspace keeps (D8, D26)", () => {
  it("names the saved secret a text holds, the Tavily key and the project id included, and says what to do for research (D37)", () => {
    const tavily = `tvly-dev-${"p".repeat(20)}`;
    const saved = [["NEBIUS_API_KEY", KEY], ["NEBIUS_PROJECT_ID", "project-e00protecttest"], ["TAVILY_API_KEY", tavily]] as const;
    const refusal = (field: string, text: string, action: Parameters<typeof refuseCredentials>[3]) => {
      try {
        refuseCredentials(field, text, saved, action);
      } catch (error) {
        return (error as Error).message;
      }
      return "not refused";
    };
    assert.deepEqual(
      [
        refusal("This plan version", "deploy to project-e00protecttest first", "research"),
        refusal("A2", `the key ${tavily} works`, "preview"),
        refusal("A1", `a tvly-dev-${"z".repeat(20)} key nobody saved`, "preview"),
        refusal("A1", "Python 3.12 distutils", "preview"),
      ],
      [
        "This plan version holds your saved Nebius project id, so nothing was sent. Edit the plan to remove it, then research the new version.",
        "A2 holds your saved Tavily key, so nothing was sent. Remove it, then preview again.",
        "A1 looks like it holds a Tavily API key, so nothing was sent. Remove it, then preview again.",
        "not refused",
      ],
    );
  });

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
