import { choicesDigest, preferencesDigest, StoredTaskInput } from "../src/index.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Methods, StartRunParams } from "../src/methods.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { WorkflowId } from "../src/runs.ts";
import { SandboxStopCode } from "../src/sandbox.ts";
import { minutesMs, requestMsFor, TASK_BRIEF_LIMITS, TaskBrief, taskBriefDigest, TaskPreview, TaskReport, TaskStopCode, type TaskBrief as Brief } from "../src/task.ts";

/** A task run's contract (NIV-7, D39): what a run takes, what it never takes, what binds it, and what it gives back. */
const BRIEF: Brief = {
  goal: "greet with no name says Hello, world",
  acceptanceCriteria: ["greet with no name prints Hello, world"],
  scope: "greet.sh",
  exclusions: "",
  context: "",
  checks: ["/bin/sh check.sh"],
  acceptanceCases: [{ name: "Greets by name, and the world by default", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 }],
};
const FINGERPRINT = "f".repeat(64);
const request = async (overrides: { input?: Record<string, unknown>; context?: unknown; brief?: unknown } = {}) => { const clientRequestId = randomUUID(); return ({
  clientRequestId,
  budget: { id: randomUUID(), requestId: clientRequestId, catalogueVersion: "test", models: ["nvidia/Nemotron-3.5-Super-VL"], rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: 23, outputTokens: 8000 }, finalisation: { requests: 1, outputTokens: 1500 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } },
  workflowId: "task",
  input: { repoPath: "/home/someone/repo", project: randomUUID(), target: "wsl:Ubuntu-24.04", preview: FINGERPRINT, taskId: randomUUID(), briefVersion: 3, preferencesDigest: await preferencesDigest([]), choicesDigest: await choicesDigest([]), briefDigest: await taskBriefDigest(BRIEF), ...overrides.input },
  context: overrides.context ?? { sharing: { modelContext: true, cloudExecution: true }, brief: overrides.brief ?? BRIEF, preferences: { revision: 0, records: [] }, choices: [] },
}); };

describe("a task run's request (NIV-7)", () => {
  it("requires both context digests on new requests and permits absent digests only in historical reads", async () => {
    const given = await request();
    for (const key of ["preferencesDigest", "choicesDigest"] as const) {
      const input: Record<string, unknown> = { ...given.input }; delete input[key];
      assert.equal(StartRunParams.safeParse({ ...given, input }).success, false);
      assert.equal(StoredTaskInput.safeParse(input).success, true);
    }
    const changed = await choicesDigest(["Use pnpm", "Keep the public API"]);
    assert.equal(changed === await choicesDigest(["Keep the public API", "Use pnpm"]), false);
    assert.equal(changed, await choicesDigest([" Use pnpm ", "Keep the public API"]));
    assert.equal(StartRunParams.safeParse({ ...given, context: { ...given.context, choices: ["duplicate", "duplicate"] } }).success, false);
  });

  it("takes the checkout, its project and target, the preview's fingerprint, the task and its brief by version and digest, with both consents and the brief in its context", async () => {
    const parsed = StartRunParams.parse(await request());
    assert.deepEqual([parsed.workflowId, WorkflowId.parse("task"), PROTOCOL_VERSION], ["task", "task", 23]);
    assert.equal(StartRunParams.safeParse(await request({ input: { target: "local" } })).success, true);
    assert.deepEqual(
      ["runs.task", "runs.proposal", "task.preview"].map((name) => [Object.hasOwn(Methods, name), name.startsWith("runs.") ? Methods[name as "runs.task"].result.safeParse(null).success : null]),
      [[true, true], [true, true], [true, null]],
    );
  });

  it("needs both consents, and takes no other workflow's context, no command, no key and nothing beyond what it is bound to", async () => {
    const refused = [
      await request({ context: { sharing: { cloudExecution: true }, brief: BRIEF } }),
      await request({ context: { sharing: { modelContext: true }, brief: BRIEF } }),
      await request({ context: { sharing: { modelContext: true, cloudExecution: true } } }),
      await request({ context: { sharing: { modelContext: true, cloudExecution: true }, brief: BRIEF, preferences: { revision: 0, records: [] } } }),
      await request({ input: { argv: ["/bin/sh", "-c", "curl example.com"] } }),
      await request({ input: { key: "a-key-from-the-renderer" } }),
      await request({ input: { briefDigest: "not a digest" } }),
      await request({ input: { briefVersion: 0 } }),
      await request({ input: { taskId: "not-a-uuid" } }),
      await request({ input: { preview: "not a fingerprint" } }),
      await request({ input: { target: "elsewhere" } }),
    ];
    assert.deepEqual(
      refused.map((params) => StartRunParams.safeParse(params).success),
      refused.map(() => false),
    );
  });

  it("takes a brief with one to four cases and checks in all, each command as written, and refuses anything a run can't hold", () => {
    const one = BRIEF.acceptanceCases[0]!;
    assert.equal(TaskBrief.safeParse({ ...BRIEF, checks: [], acceptanceCases: [one, one, one, one] }).success, true);
    assert.equal(TaskBrief.safeParse({ ...BRIEF, acceptanceCases: [{ ...one, expectedOutput: "é".repeat(TASK_BRIEF_LIMITS.expectedOutputBytes / 2) }] }).success, true, "4,096 bytes of two-byte letters");
    const refused: unknown[] = [
      { ...BRIEF, acceptanceCases: [] },
      { ...BRIEF, checks: ["a", "b", "c"], acceptanceCases: [one, one] },
      { ...BRIEF, checks: [], acceptanceCases: [one, one, one, one, one] },
      { ...BRIEF, goal: "  " },
      { ...BRIEF, checks: [" "] },
      { ...BRIEF, checks: ["sh check.sh\0"] },
      { ...BRIEF, checks: ["c".repeat(TASK_BRIEF_LIMITS.commandChars + 1)] },
      { ...BRIEF, acceptanceCases: [{ ...one, name: " " }] },
      { ...BRIEF, acceptanceCases: [{ ...one, command: "" }] },
      { ...BRIEF, acceptanceCases: [{ ...one, expectedOutput: `${"é".repeat(TASK_BRIEF_LIMITS.expectedOutputBytes / 2)}x` }] },
      { ...BRIEF, acceptanceCases: [{ ...one, expectedOutput: "Hello\0" }] },
      { ...BRIEF, acceptanceCases: [{ ...one, expectedExitCode: 256 }] },
      { ...BRIEF, acceptanceCases: [{ ...one, expectedExitCode: -1 }] },
      { ...BRIEF, acceptanceCases: [{ ...one, expectedExitCode: 1.5 }] },
      { ...BRIEF, acceptanceCases: [{ ...one, timeoutSeconds: 600 }] },
      { ...BRIEF, assumptions: [] },
    ];
    assert.deepEqual(
      refused.map((brief) => TaskBrief.safeParse(brief).success),
      refused.map(() => false),
    );
  });

  it("fingerprints a brief by everything it holds, in a fixed order, so the host and the engine get the same digest", async () => {
    const digest = await taskBriefDigest(BRIEF);
    const by = (brief: Brief) =>
      createHash("sha256")
        .update(JSON.stringify(["nivra.task-brief.v1", brief.goal, brief.acceptanceCriteria, brief.scope, brief.exclusions, brief.context, brief.checks, brief.acceptanceCases.map((c) => [c.name, c.command, c.expectedOutput, c.expectedExitCode])]))
        .digest("hex");
    assert.equal(digest, by(BRIEF));
    // The same brief with its keys in another order gives the same digest; any change to what it holds gives another.
    const reordered = { acceptanceCases: BRIEF.acceptanceCases, checks: BRIEF.checks, context: BRIEF.context, exclusions: BRIEF.exclusions, scope: BRIEF.scope, acceptanceCriteria: BRIEF.acceptanceCriteria, goal: BRIEF.goal };
    assert.equal(await taskBriefDigest(reordered), digest);
    const one = BRIEF.acceptanceCases[0]!;
    const changed = await Promise.all(
      [
        { ...BRIEF, goal: `${BRIEF.goal}.` },
        { ...BRIEF, checks: ["/bin/sh check.sh "] },
        { ...BRIEF, acceptanceCases: [{ ...one, expectedOutput: "Hello, Ada\nHello, world" }] },
        { ...BRIEF, acceptanceCases: [{ ...one, expectedExitCode: 1 }] },
        { ...BRIEF, acceptanceCases: [{ ...one, name: "Another name" }] },
      ].map(taskBriefDigest),
    );
    assert.equal(new Set([digest, ...changed]).size, 6);
  });
});

describe("what a task run gives back (NIV-7)", () => {
  const counted = { count: 0, sample: [] };
  const limits = { modelRequests: 12, requestSeconds: 150, outputTokensPerRequest: 8_000, estimatedInputTokens: 160_000, toolCalls: 24, writes: 8, writeBytes: 32_768, runs: 4, baselineChecks: 0, operations: 17, checkSeconds: 60, sessionMinutes: 20, runMinutes: 33 };
  const snapshot = { baseline: "b".repeat(40), prefix: "", files: 2, bytes: 3_072, leftOut: { secret: counted, output: counted, submodule: counted, excluded: counted }, untracked: counted, lfsPointers: 0, fingerprint: FINGERPRINT, retention: "Images are retained for 180 days." };

  it("previews what a run would send and what bounds it, or why it can't, never both", () => {
    const ready = { status: "ready", snapshot, programs: [".", "/bin/sh"], unprobed: 0, caseFiles: [{ number: 1, files: ["greet.sh"] }], environment: null, frozen: [], limits };
    assert.equal(TaskPreview.safeParse(ready).success, true);
    assert.equal(TaskPreview.safeParse({ ...ready, caseFiles: [{ number: 5, files: ["greet.sh"] }] }).success, false, "a case is numbered one to four");
    // A preview kept from before `unclear` reads as one Nivra could read; a case it can't read may name no file.
    const kept = TaskPreview.parse(ready);
    assert.deepEqual(kept.status === "ready" ? kept.caseFiles : null, [{ number: 1, files: ["greet.sh"], unclear: false }]);
    assert.equal(TaskPreview.safeParse({ ...ready, caseFiles: [{ number: 2, files: [], unclear: true }] }).success, true);
    assert.equal(TaskPreview.safeParse({ status: "refused", code: "content", message: "src/a.ts in this commit holds what looks like a private key." }).success, true);
    assert.equal(TaskPreview.safeParse({ ...ready, status: "refused", code: "content", message: "x" }).success, false);
    assert.equal(TaskPreview.safeParse({ ...ready, programs: ["a", "b", "c", "d", "e"] }).success, false, "four cases and checks have four programs at most");
  });

  it("reports by a closed set of stop codes, a sandbox check's and a task's own, keeping the worker's claim apart from the checks", () => {
    const report = {
      outcome: "proposed",
      stopped: null,
      task: { taskId: randomUUID(), attemptId: randomUUID(), briefVersion: 3, briefDigest: "d".repeat(64) },
      snapshot: { baseline: "b".repeat(40), prefix: "", fingerprint: FINGERPRINT, files: 2, archiveSha256: "a".repeat(64) },
      toolchain: [{ program: ".", finding: "present" }],
      worker: { handedIn: true, summary: "Defaulted the name to world.", ended: "submitted", handInDue: null, failure: null, model: "nvidia/nemotron-3-super-120b-a12b", usage: { inputTokens: 900, outputTokens: 40, calls: 4, reportedCalls: 4 }, tools: { calls: 4, writes: 1, runs: 1, refused: 0, rejected: 0 }, written: ["greet.sh"] },
      checks: [{ kind: "case", number: 1, name: "Greets", verdict: "passed", reason: null, exitCode: 0, stdoutTail: "Hello, Ada\nHello, world\n", stderrTail: "", difference: null, changedFiles: [], durationMs: 20 }],
      verified: true,
      steps: [],
      proposal: { hash: "c".repeat(64), patchSha256: "e".repeat(64), patchBytes: 300, files: 1 },
      reportSha256: "d".repeat(64),
      cleanup: { stopped: 0, alreadyEnded: 0, unresolved: [], retained: { uploads: 1, images: 4, operations: 6, note: "Images are retained for 180 days." } },
      route: { provider: "nebius", endpoint: "token-factory", model: "nvidia/nemotron-3-super-120b-a12b" },
      request: { runId: randomUUID(), clientRequestId: randomUUID() },
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    assert.equal(TaskReport.safeParse(report).success, true);
    assert.equal(TaskReport.safeParse({ ...report, version: 4 }).success, false, "new reports require an explicit manifest and observations");
    const manifest = { policy: "required-checks-v1", checks: [{ kind: "case", number: 1, commandSha256: "a".repeat(64) }], frozen: [], setupRequired: false };
    assert.equal(TaskReport.safeParse({ ...report, version: 4, manifest, beforeChecks: [] }).success, true);
    assert.equal(TaskReport.safeParse({ ...report, version: 4, manifest }).success, false);
    assert.equal(TaskReport.parse(report).checks[0]?.unclear, false, "a check kept from before `unclear` reads as one Nivra could read");
    assert.equal(TaskReport.safeParse({ ...report, outcome: "refused", stopped: { code: "model-sharing", step: "check", message: "x" }, worker: null, checks: [], verified: false, proposal: null, reportSha256: null }).success, true);
    assert.equal(TaskReport.safeParse({ ...report, stopped: { code: "something-else", step: null, message: "x" } }).success, false);
    assert.equal(TaskReport.safeParse({ ...report, checks: Array.from({ length: 5 }, () => report.checks[0]) }).success, false, "four cases and checks at most");
    assert.equal(TaskReport.safeParse({ ...report, checks: [{ ...report.checks[0], verdict: "skipped" }] }).success, false);
    for (const code of ["context-mismatch", "context-credentials"]) {
      assert.equal(TaskReport.safeParse({ ...report, outcome: "refused", stopped: { code, step: "prepare", message: "x" }, worker: null, checks: [], verified: false, proposal: null, reportSha256: null }).success, true);
    }
    assert.deepEqual([TaskStopCode.options.length, SandboxStopCode.options.every((code) => TaskStopCode.options.includes(code))], [SandboxStopCode.options.length + 12, true]);
  });
});

describe("a task run's times, from the bounds no brief changes (NIV-35)", () => {
  it("works a request's time out from its cap, the hand-in's from its own, and minutes in milliseconds", () => {
    assert.deepEqual([requestMsFor(8_000), requestMsFor(1_500), minutesMs(45), minutesMs(58)], [830_000, 180_000, 2_700_000, 3_480_000]);
  });
});
