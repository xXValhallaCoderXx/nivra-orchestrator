import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatResult } from "@nivra/domain";
import { briefForRepository, briefFrom, nextState, planFromAnswer, RUN_UNAVAILABLE } from "../src/main/tasks.ts";

const fields = { goal: "Add a CSV export", acceptanceCriteria: ["The list exports as CSV"], scope: "", exclusions: "", context: "", assumptions: [], checks: [] };
const source = (projectId: string | null) => ({ kind: "plan" as const, planId: "p", planLineage: "l", planVersion: 1, conversationId: "c", messageId: "m", projectId, headAtStart: null, citations: [] });

describe("native tasks and plans (D26, NIV-32)", () => {
  it("makes a ready task need a goal and a criterion, completes only a ready one, and refuses active and review in plain words", () => {
    const ready = briefFrom(fields);
    assert.equal(nextState("draft", "ready", ready), "ready");
    assert.throws(() => nextState("draft", "ready", briefFrom({ ...fields, acceptanceCriteria: [] })), /^Error: A task is ready once its brief has a goal and at least one acceptance criterion\. Add them, then mark it ready\.$/);
    assert.throws(() => nextState("draft", "completed", ready), /Mark the task ready before you complete it/);
    assert.deepEqual([nextState("ready", "completed", ready), nextState("completed", "draft", ready), nextState("ready", "draft", ready)], ["completed", "draft", "draft"]);
    assert.throws(() => nextState("ready", "active", ready), (error: Error) => error.message === "Running tasks isn't available yet, so a task can't be active." && !/NIV-/.test(error.message));
    assert.throws(() => nextState("ready", "review", ready), /so a task can't be in review/);
    assert.ok(!/NIV-\d/.test(RUN_UNAVAILABLE), "no ticket numbers in what the person reads");
  });

  it("gives a direct brief and one from a plan the same shape and the fixed policy", () => {
    const direct = briefFrom(fields);
    const planned = briefFrom(fields, [source(null)]);
    assert.deepEqual(Object.keys(direct).sort(), Object.keys(planned).sort());
    assert.deepEqual([direct.executionPolicy, direct.sources, planned.sources.length, direct.revalidate], [{ concurrency: 1, network: "off", approval: "required" }, [], 1, []]);
  });

  it("clears what came from another project's conversation when a task changes repository, and nothing otherwise", () => {
    const brief = { ...briefFrom({ ...fields, context: "Alpha's README says…", assumptions: ["Alpha uses Vite"] }, [source("alpha"), source(null)]) };
    const moved = briefForRepository(brief, "beta");
    assert.deepEqual([moved?.sources.map((s) => s.projectId), moved?.context, moved?.assumptions, moved?.revalidate, moved?.goal], [[null], "", [], ["context", "assumptions"], fields.goal]);
    assert.equal(briefForRepository(brief, "alpha"), null, "the same project keeps it");
    assert.equal(briefForRepository(briefFrom(fields, [source(null)]), "beta"), null, "a general conversation's plan belongs to no project");
  });

  it("makes a plan from a repository answer with its proposals and assumptions, and only lines the model was shown", () => {
    const reply = {
      kind: "repository",
      answer: "Add the export beside the list.",
      evidence: [{ statement: "The list lives in list.tsx.", citations: [{ path: "src/list.tsx", startLine: 3, endLine: 9, checked: true, problem: null }, { path: "src/x.ts", startLine: 1, endLine: 1, checked: false, problem: "file not read" }] }],
      proposals: [{ title: "Add export-button.tsx", detail: "A kebab-case component.", citations: [] }],
      assumptions: ["Exports start from the list."],
      headAtStart: "abc123",
    } as unknown as ChatResult;
    const plan = planFromAnswer(reply, { conversationId: "c", messageId: "m", runId: "r", projectId: "alpha" });
    assert.equal(plan.text, "Add the export beside the list.\n\nProposed:\n- Add export-button.tsx: A kebab-case component.\n\nAssumed:\n- Exports start from the list.");
    assert.deepEqual([plan.citations, plan.assumptions, plan.headAtStart, plan.projectId, plan.kind], [[{ path: "src/list.tsx", startLine: 3, endLine: 9 }], ["Exports start from the list."], "abc123", "alpha", "repository"]);
  });
});
