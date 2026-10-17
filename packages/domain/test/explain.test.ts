import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { ExplainResult } from "../src/explain.ts";
import { ExplainInput, MAX_CHOICE_CHARS, MAX_CHOICES, StoredExplainInput } from "../src/runs.ts";

describe("ExplainInput choices (NIV-11, D23)", () => {
  const input = (choices: unknown) => ExplainInput.safeParse({ repoPath: "/repo", choices });

  it("defaults to none, trims each choice, and keeps them in order", () => {
    assert.deepEqual(ExplainInput.parse({ repoPath: "/repo" }).choices, []);
    assert.deepEqual(ExplainInput.parse({ repoPath: "/repo", choices: ["  Keep Jest for this task ", "Use pnpm"] }).choices, ["Keep Jest for this task", "Use pnpm"]);
  });

  it("refuses more than five, an empty or over-long choice, and the same choice twice after trimming", () => {
    const refused = [
      Array.from({ length: MAX_CHOICES + 1 }, (_, i) => `Choice ${i}`),
      ["   "],
      ["x".repeat(MAX_CHOICE_CHARS + 1)],
      ["Use pnpm", " Use pnpm "],
      "Use pnpm",
    ];
    assert.deepEqual(refused.map((choices) => input(choices).success), refused.map(() => false));
    assert.equal(input(Array.from({ length: MAX_CHOICES }, (_, i) => `${i}`.padEnd(MAX_CHOICE_CHARS, "x"))).success, true);
  });
});

describe("StoredExplainInput", () => {
  it("reads back what masking made longer or identical, but not a malformed input", () => {
    const masked = { repoPath: "/repo", question: `${"q".repeat(1_990)} [secret:NEBIUS_API_KEY]`, choices: ["Avoid [secret:NEBIUS_API_KEY]", "Avoid [secret:NEBIUS_API_KEY]"] };
    assert.equal(ExplainInput.safeParse(masked).success, false);
    assert.deepEqual(StoredExplainInput.parse(masked).choices, masked.choices);
    assert.deepEqual(StoredExplainInput.parse({ repoPath: "/repo" }), { repoPath: "/repo", question: "", choices: [] });
    for (const bad of [null, "text", { question: "no path" }, { repoPath: "/repo", choices: "one" }]) assert.equal(StoredExplainInput.safeParse(bad).success, false);
  });
});

describe("ExplainResult", () => {
  it("still reads a result stored under protocol 3, with none of the fields added since", () => {
    const stored = {
      question: "q",
      headAtStart: null,
      headAtEnd: null,
      summary: "s",
      findings: [],
      preferenceDifferences: [{ preferenceId: randomUUID(), revision: 2, repositoryConvention: "kebab-case", citations: [] }],
      gaps: [],
      context: { map: [], reads: [], searches: 0, searchHits: 0, chars: 0, changedFiles: [] },
      checks: { citations: 0, checked: 0 },
      answeredAtStep: 1,
      finishedAt: new Date().toISOString(),
    };
    const result = ExplainResult.parse(stored);
    assert.deepEqual([result.choices, result.conflicts, result.suggestions, result.preferenceDifferences.length], [[], [], [], 1]);
  });
});
