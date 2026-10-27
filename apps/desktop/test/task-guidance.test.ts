import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COULD_HELP_SHOWN, NO_GAPS, NO_GAPS_DETAIL, taskGuidance } from "../src/shared/task-guidance.ts";
import { BRIEFS } from "./fixtures/briefs.ts";

const codes = (brief: Parameters<typeof taskGuidance>[0]) => taskGuidance(brief).items.map((item) => `${item.tier}:${item.code}${item.item ? `:${item.item}` : ""}`);

/** What a brief is missing, worked out without a model (NIV-53): specific, proportional, and never a verdict. */
describe("a brief's guidance, without a model (NIV-53)", () => {
  it("says what a vague task is missing, naming the criterion, and keeps the acceptance case for running", () => {
    assert.deepEqual(codes(BRIEFS.vague), ["could-help:criterion-vague:1", "could-help:current-behaviour", "before-run:no-case"]);
    const [vague] = taskGuidance(BRIEFS.vague).items;
    assert.deepEqual([vague?.field, vague?.missing], ["acceptanceCriteria", 'Criterion 1 may be hard to check: "It works"']);
  });

  it("asks an empty brief for its goal and a criterion, and nothing a run needs yet", () => {
    assert.deepEqual(codes(BRIEFS.empty), ["needed:goal-missing", "needed:criteria-missing"]);
  });

  it("finds no basic gap in a clear small task, and asks for no repository, baseline or environment", () => {
    assert.deepEqual(codes(BRIEFS.clearWithCase), []);
    assert.deepEqual(codes(BRIEFS.clearSmall), ["before-run:no-case"]);
    const [noCase] = taskGuidance(BRIEFS.clearSmall).items;
    assert.match(noCase?.how ?? "", /only when you want to run the task/);
    // Every gap is about a field the person writes in the brief: never a repository, a baseline or an environment.
    const fields = new Set(Object.values(BRIEFS).flatMap((brief) => taskGuidance(brief).items.map((item) => item.field)));
    assert.deepEqual([...fields].filter((field) => !["goal", "acceptanceCriteria", "scope", "exclusions", "context", "assumptions", "acceptanceCases"].includes(field)), []);
  });

  it("leaves alone a fix that says what happens now and a criterion that covers a failure", () => {
    assert.deepEqual(codes(BRIEFS.fixDescribed), []);
  });

  it("shows at most three gaps that could help at once, and counts the ones it holds back", () => {
    const guidance = taskGuidance(BRIEFS.large);
    assert.deepEqual(codes(BRIEFS.large), ["could-help:criterion-vague:1", "could-help:scope-missing", "could-help:failure-case", "before-run:no-case"]);
    assert.equal(guidance.items.filter((item) => item.tier === "could-help").length, COULD_HELP_SHOWN);
    assert.equal(guidance.held, 1, "the many-criteria gap waits until these are settled");
  });

  it("puts what a changed repository cleared first, as needed", () => {
    assert.deepEqual(codes(BRIEFS.moved), ["needed:rewrite", "before-run:no-case"]);
    assert.match(taskGuidance(BRIEFS.moved).items[0]?.how ?? "", /^Write the context and the assumptions again for this repository\.$/);
  });

  it("claims no more than its rules show, scores nothing, and names no ticket", () => {
    assert.equal(NO_GAPS, "No basic gaps detected.");
    assert.match(NO_GAPS_DETAIL, /don't show that the brief is complete or correct/);
    const all = Object.values(BRIEFS).flatMap((brief) => taskGuidance(brief).items);
    assert.ok(all.length > 0);
    for (const item of all) {
      assert.ok(item.missing && item.why && item.how, item.code);
      assert.equal(/NIV-\d|score|complete\b|ready to run/i.test(`${item.missing} ${item.why} ${item.how}`), false, item.code);
    }
  });
});
