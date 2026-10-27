import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoachField, CoachQuestionField, type CoachChange } from "@nivra/domain";
import { applyCoachChange, COACH_FIELD_LABELS, fieldValue } from "../src/shared/coach.ts";
import { BRIEFS } from "./fixtures/briefs.ts";

const about = { reason: "Says what someone would see.", refs: [], usable: true };

/** How one of the coach's proposed changes turns a field into another (NIV-53): exactly that field, nothing deleted. */
describe("a coach's change to one field (NIV-53)", () => {
  it("replaces the goal, scope or exclusions, and adds to the end of the context after a blank line", () => {
    const brief = { ...BRIEFS.vague, context: "Older runs have no unit.\n" };
    assert.equal(applyCoachChange(brief, { field: "goal", text: "Records compare finish times in one unit", ...about }).goal, "Records compare finish times in one unit");
    assert.equal(applyCoachChange(brief, { field: "scope", text: "The records page", ...about }).scope, "The records page");
    assert.equal(applyCoachChange(brief, { field: "context", append: "Today, miles are read as kilometres.", ...about }).context, "Older runs have no unit.\n\nToday, miles are read as kilometres.");
    assert.equal(applyCoachChange(BRIEFS.vague, { field: "context", append: "Today, miles are read as kilometres.", ...about }).context, "Today, miles are read as kilometres.");
  });

  it("rewords items by number and adds new ones at the end, deleting none, and touches no other field", () => {
    const change: CoachChange = { field: "acceptanceCriteria", reword: [{ item: 1, text: "A 5 km run logged in miles shows its record in kilometres" }], add: ["A run with no unit is left out"], ...about };
    const after = applyCoachChange(BRIEFS.vague, change);
    assert.deepEqual(after.acceptanceCriteria, ["A 5 km run logged in miles shows its record in kilometres", "A run with no unit is left out"]);
    const untouched = (brief: typeof after) => [brief.goal, brief.scope, brief.exclusions, brief.context, brief.assumptions];
    assert.deepEqual(untouched(after), untouched(BRIEFS.vague));
    assert.deepEqual(BRIEFS.vague.acceptanceCriteria, ["It works"], "the brief it was given is unchanged");
    assert.deepEqual(applyCoachChange(BRIEFS.vague, { field: "assumptions", reword: [], add: ["Every run stores its unit"], ...about }).assumptions, ["Every run stores its unit"]);
  });

  it("refuses to reword an item the brief doesn't have", () => {
    assert.throws(() => applyCoachChange(BRIEFS.vague, { field: "acceptanceCriteria", reword: [{ item: 2, text: "x" }], add: [], ...about }), /^Error: The coach's change rewords item 2, and this brief has 1\.$/);
  });

  it("reads each field's value, and names every field a question can point to", () => {
    assert.deepEqual([fieldValue(BRIEFS.vague, "goal"), fieldValue(BRIEFS.vague, "acceptanceCriteria")], ["Fix the PR detection bug", ["It works"]]);
    assert.deepEqual(Object.keys(COACH_FIELD_LABELS).sort(), [...CoachQuestionField.options].sort());
    assert.ok(CoachField.options.every((field) => COACH_FIELD_LABELS[field]));
  });
});
