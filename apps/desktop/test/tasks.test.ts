import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { REF_FORMAT, taskBriefDigest, type ChatResult, type EnvironmentRef } from "@nivra/domain";
import { BriefContentSchema, briefForRepository, briefFrom, nextState, NO_CASE, planFromAnswer, taskBriefOf, taskRunFingerprint } from "../src/main/tasks.ts";

const fields = { goal: "Add a CSV export", acceptanceCriteria: ["The list exports as CSV"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
const CASE = { name: "Exports one row", command: "sh export.sh", expectedOutput: "id,name\n1,Ada\n", expectedExitCode: 0 };
const source = (projectId: string | null) => ({ kind: "plan" as const, planId: "p", planLineage: "l", planVersion: 1, conversationId: "c", messageId: "m", projectId, headAtStart: null, citations: [] });

describe("native tasks and plans (D26, NIV-32)", () => {
  it("makes a ready task need a goal and a criterion, completes only a ready one, and refuses active and review in plain words", () => {
    const ready = briefFrom(fields);
    assert.equal(nextState("draft", "ready", ready), "ready");
    assert.throws(() => nextState("draft", "ready", briefFrom({ ...fields, acceptanceCriteria: [] })), /^Error: A task is ready once its brief has a goal and at least one acceptance criterion\. Add them, then mark it ready\.$/);
    assert.throws(() => nextState("draft", "completed", ready), /Mark the task ready before you complete it/);
    assert.deepEqual([nextState("ready", "completed", ready), nextState("completed", "draft", ready), nextState("ready", "draft", ready)], ["completed", "draft", "draft"]);
    assert.throws(() => nextState("ready", "active", ready), (error: Error) => error.message === "A task can't be marked active by hand.");
    assert.throws(() => nextState("ready", "review", ready), /^Error: A task can't be marked in review by hand\.$/);
  });

  it("reads a brief saved before acceptance cases as having none, and runs a brief only with one, four cases and checks at most", async () => {
    const { acceptanceCases: _none, ...older } = briefFrom(fields);
    assert.deepEqual(BriefContentSchema.parse(older).acceptanceCases, []);
    assert.deepEqual(taskBriefOf(briefFrom(fields)), { blocked: NO_CASE });
    assert.ok(!/NIV-\d/.test(NO_CASE), "no ticket numbers in what the person reads");
    const runnable = briefFrom({ ...fields, assumptions: ["Rows are small"], checks: ["sh test.sh"], acceptanceCases: [CASE] });
    const sent = taskBriefOf(runnable);
    assert.ok("brief" in sent);
    // What a run is sent: the brief's own words, its checks and its cases; never its assumptions or sources.
    assert.deepEqual(Object.keys(sent.brief).sort(), ["acceptanceCases", "acceptanceCriteria", "checks", "context", "exclusions", "goal", "scope"]);
    assert.deepEqual(taskBriefOf(briefFrom({ ...fields, checks: ["a", "b", "c", "d"], acceptanceCases: [CASE] })), { blocked: "A run takes at most 4 acceptance cases and checks in all, and this brief has 5. Remove some, then run it." });
    assert.deepEqual(taskBriefOf(briefFrom({ ...fields, checks: ["sh test.sh\0"], acceptanceCases: [CASE] })), { blocked: "This brief can't be run as it is: a check or a case holds something a command can't carry. Edit the brief, then run it." });
    assert.match(await taskBriefDigest(sent.brief), /^[0-9a-f]{64}$/);
  });

  it("fingerprints a run's preview by everything it would be bound to, both consents and the snapshot included", () => {
    const parts = { taskId: "t", briefId: "b", briefVersion: 2, briefDigest: "d".repeat(64), projectId: "p", targetId: "wsl:Ubuntu", sharing: { modelContext: true, cloudExecution: true }, snapshot: "f".repeat(64) };
    const one = taskRunFingerprint(parts);
    const others = [
      { ...parts, briefVersion: 3 },
      { ...parts, briefDigest: "e".repeat(64) },
      { ...parts, targetId: "local" },
      { ...parts, sharing: { modelContext: true, cloudExecution: false } },
      { ...parts, sharing: { modelContext: false, cloudExecution: true } },
      { ...parts, snapshot: "a".repeat(64) },
    ].map(taskRunFingerprint);
    assert.equal(new Set([one, ...others]).size, 7);
    assert.equal(taskRunFingerprint({ ...parts }), one);
  });

  it("binds a run from a recipe's environment by both its digests, its image, its setup files, the Nebius project and the target, and leaves v1 and v2 as they were (NIV-55)", () => {
    const parts = { taskId: "t", briefId: "b", briefVersion: 2, briefDigest: "d".repeat(64), projectId: "p", targetId: "wsl:Ubuntu", sharing: { modelContext: true, cloudExecution: true }, snapshot: "f".repeat(64) };
    const canonical = (form: unknown[]) => createHash("sha256").update(JSON.stringify(form)).digest("hex");
    const bound = ["t", "b", 2, "d".repeat(64), "p", "wsl:Ubuntu", true, true, "f".repeat(64)];
    const d41 = { image: "img-d41", inputsDigest: "c".repeat(64), projectFingerprint: "9".repeat(64) };
    // The forms before NIV-55, exactly: a run with no environment, and one from D41's.
    assert.deepEqual([taskRunFingerprint(parts), taskRunFingerprint({ ...parts, environment: d41 })], [canonical(["nivra.task-run-preview.v1", ...bound]), canonical(["nivra.task-run-preview.v2", ...bound, "img-d41", "c".repeat(64), "9".repeat(64)])]);
    const ref: EnvironmentRef = { format: REF_FORMAT, recipe: "1".repeat(64), verified: "2".repeat(64), configuration: "3".repeat(64), image: "img-recipe", projectFingerprint: "4".repeat(64), target: "wsl:Ubuntu", tools: [{ name: "node", version: "24.21.0" }], platform: { arch: "x86_64", libc: "musl" }, env: { CI: "1" }, dependencyFolders: ["node_modules"], builds: null, preparedAt: "2026-10-28T10:00:00.000Z" };
    const v3 = taskRunFingerprint({ ...parts, environment: ref });
    assert.equal(v3, canonical(["nivra.task-run-preview.v3", ...bound, "1".repeat(64), "2".repeat(64), "img-recipe", "3".repeat(64), "4".repeat(64), "wsl:Ubuntu"]));
    const changed = [{ recipe: "5".repeat(64) }, { verified: "5".repeat(64) }, { image: "img-other" }, { configuration: "5".repeat(64) }, { projectFingerprint: "5".repeat(64) }, { target: "local" }].map((change) => taskRunFingerprint({ ...parts, environment: { ...ref, ...change } }));
    assert.equal(new Set([v3, ...changed]).size, 7);
    // What a run carries only for display isn't bound: the versions shown, and when it was prepared.
    assert.equal(taskRunFingerprint({ ...parts, environment: { ...ref, tools: [{ name: "node", version: "24.20.0" }], preparedAt: "2026-10-29T10:00:00.000Z" } }), v3);
  });

  it("reads a brief saved before baseline checks and frozen files as having neither, and sends a run them only when it has them (D41)", async () => {
    const { baseline: _baseline, frozen: _frozen, ...older } = briefFrom({ ...fields, acceptanceCases: [CASE] });
    const read = BriefContentSchema.parse(older);
    assert.deepEqual([read.baseline, read.frozen], [[], []]);
    const plain = taskBriefOf(read);
    assert.ok("brief" in plain);
    const REPRODUCED = { name: "The export drops the header", command: "sh export.sh", expectedExitCode: 0, expectedOutput: "1,Ada\n" };
    const FAILS = { name: "The test fails for the bug", command: "sh test.sh", expectedExitCode: 1, outputPattern: "^FAIL export" };
    const extended = taskBriefOf(briefFrom({ ...fields, acceptanceCases: [CASE], baseline: [REPRODUCED, FAILS], frozen: ["tests/export.test.sh"] }));
    assert.ok("brief" in extended);
    assert.deepEqual([extended.brief.baseline, extended.brief.frozen], [[REPRODUCED, FAILS], ["tests/export.test.sh"]]);
    // Without them, the brief a run is sent digests as it did before them; with them, the digest binds them.
    assert.equal(await taskBriefDigest(plain.brief), await taskBriefDigest({ ...plain.brief, baseline: [], frozen: [] }));
    assert.notEqual(await taskBriefDigest(extended.brief), await taskBriefDigest(plain.brief));
    // One the domain would refuse is never sent: a selection with both its output and a pattern.
    assert.deepEqual(taskBriefOf(briefFrom({ ...fields, acceptanceCases: [CASE], baseline: [{ ...FAILS, expectedOutput: "x" }] })), { blocked: "This brief can't be run as it is: a check or a case holds something a command can't carry. Edit the brief, then run it." });
  });

  it("fingerprints a run from a prepared environment in the v2 form, binding its image and what binds that, and one without exactly as v1 did (D41)", () => {
    const parts = { taskId: "t", briefId: "b", briefVersion: 2, briefDigest: "d".repeat(64), projectId: "p", targetId: "wsl:Ubuntu", sharing: { modelContext: true, cloudExecution: true }, snapshot: "f".repeat(64) };
    // v1's form, worked out here as D39 defines it, independently of the host's code.
    const v1 = createHash("sha256").update(JSON.stringify(["nivra.task-run-preview.v1", "t", "b", 2, "d".repeat(64), "p", "wsl:Ubuntu", true, true, "f".repeat(64)])).digest("hex");
    assert.deepEqual([taskRunFingerprint(parts), taskRunFingerprint({ ...parts, environment: null })], [v1, v1]);
    const environment = { image: "image-1", inputsDigest: "a".repeat(64), projectFingerprint: "c".repeat(64) };
    const v2 = createHash("sha256").update(JSON.stringify(["nivra.task-run-preview.v2", "t", "b", 2, "d".repeat(64), "p", "wsl:Ubuntu", true, true, "f".repeat(64), "image-1", "a".repeat(64), "c".repeat(64)])).digest("hex");
    assert.equal(taskRunFingerprint({ ...parts, environment }), v2);
    const others = [{ ...environment, image: "image-2" }, { ...environment, inputsDigest: "b".repeat(64) }, { ...environment, projectFingerprint: "e".repeat(64) }].map((changed) => taskRunFingerprint({ ...parts, environment: changed }));
    assert.equal(new Set([v1, v2, ...others]).size, 5);
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
