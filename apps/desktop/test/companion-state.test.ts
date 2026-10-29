import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendDialogue, companionHint, guidedBrief, hintKey, knowledgeScopeKey, returnProjectPresent } from "../src/renderer/src/features/companion-state.ts";

describe("the companion's scoped temporary state (NIV-68)", () => {
  it("takes work identity from the page and never lends a task the switcher's project", () => {
    const shell = { kind: "project", projectId: "unrelated" } as const;
    assert.deepEqual(companionHint({ kind: "task", id: "task-a", tab: "coach" }, shell), { taskId: "task-a" });
    assert.deepEqual(companionHint({ kind: "mission", id: "mission-a" }, shell), { missionId: "mission-a" });
    assert.deepEqual(companionHint({ kind: "home" }, shell), { projectId: "unrelated" });
    assert.deepEqual(companionHint({ kind: "home" }, { kind: "general" }), {});
  });

  it("keeps independent keys for project, task, mission and repository-free guidance", () => {
    assert.deepEqual([hintKey({}), hintKey({ projectId: "a" }), hintKey({ taskId: "a" }), hintKey({ missionId: "a" })], ["general", "project:a", "task:a", "mission:a"]);
    assert.equal(knowledgeScopeKey({ kind: "task", taskId: "a" }), "task:a");
  });

  it("bounds dialogue by both recent lines and total text without changing a previous buffer", () => {
    let lines = [] as ReturnType<typeof appendDialogue>;
    for (let index = 0; index < 20; index++) lines = appendDialogue(lines, { role: "user", text: `turn ${index}` });
    assert.equal(lines.length, 12);
    assert.equal(lines[0]?.text, "turn 8");
    const previous = lines;
    lines = appendDialogue(lines, { role: "assistant", text: "x".repeat(40_000) });
    assert.equal(previous.length, 12);
    assert.equal(lines.at(-1)?.text.length, 16_000);
    lines = appendDialogue(lines, { role: "assistant", text: "y".repeat(16_000) });
    assert.ok(lines.reduce((total, line) => total + line.text.length, 0) <= 32_000);
  });

  it("saves human acceptance wording without inventing executable checks", () => {
    const brief = guidedBrief(" Let a runner log distance ", " One form ", "Displays the entered distance\n\nCan correct an entry\n");
    assert.equal(brief.goal, "Let a runner log distance");
    assert.deepEqual(brief.acceptanceCriteria, ["Displays the entered distance", "Can correct an entry"]);
    assert.equal(brief.acceptanceCases.length, 0);
    assert.equal(brief.checks.length, 0);
  });

  it("refuses return to a removed project instead of substituting another selected one", () => {
    const destination = { scope: { kind: "project", projectId: "original" }, route: { kind: "task", id: "a", tab: "brief" }, hint: { taskId: "a" } } as const;
    assert.equal(returnProjectPresent(destination, ["different"]), false);
    assert.equal(returnProjectPresent(destination, ["original", "different"]), true);
    assert.equal(returnProjectPresent({ ...destination, scope: { kind: "general" } }, []), true);
    assert.equal(returnProjectPresent({ ...destination, projectId: "task-project" }, ["original"]), false);
    assert.equal(returnProjectPresent({ ...destination, projectId: "task-project" }, ["task-project"]), true);
  });
});
