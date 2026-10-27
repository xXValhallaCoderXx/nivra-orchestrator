import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { ENVIRONMENT_BASE, EnvironmentPreview, EnvironmentReport, EnvironmentSpec, PreparedEnvironment, projectFingerprint } from "../src/environment.ts";
import { StartRunParams } from "../src/methods.ts";
import { baselinePattern, TaskBrief, taskBriefDigest, TaskInput, TaskReport, type TaskBrief as Brief } from "../src/task.ts";

/**
 * A project's environment and what a brief gains with it (NIV-49, D41): which packages to install and nothing that is a
 * command, the binding a task run checks, the baseline selections that run before the model, and the frozen files.
 */
const FINGERPRINT = "f".repeat(64);
const BRIEF: Brief = {
  goal: "Normalise historical units before finish-time PR detection",
  acceptanceCriteria: ["Prior sets are compared in the finishing workout's units"],
  scope: "packages/data",
  exclusions: "",
  context: "",
  checks: [],
  acceptanceCases: [{ name: "The data suite", command: "pnpm --filter data exec vitest run", expectedOutput: "tests 5 passed 5\n", expectedExitCode: 0 }],
};
const SELECTION = { name: "The regression alone fails for the bug", command: "pnpm --filter data exec vitest run tests/r.test.ts", expectedExitCode: 0, expectedOutput: "failed\tAssertionError\tone\n" };
const PATTERN = { name: "The other tests pass", command: "pnpm --filter data exec vitest run --exclude tests/r.test.ts", expectedExitCode: 0, outputPattern: "^tests \\d+ passed \\d+ failed 0\\n$" };

describe("a project's environment (NIV-49, D41)", () => {
  it("is chosen as pnpm filters only: workspace selectors, never anything a shell would read", () => {
    assert.equal(EnvironmentSpec.safeParse({ filters: [] }).success, true);
    assert.equal(EnvironmentSpec.safeParse({ filters: ["@sheetless/data...", "./packages/domain", "!web", "^app"] }).success, true);
    for (const filter of ["a b", "a;b", "$(x)", "`x`", "a|b", "", "x".repeat(201)]) assert.equal(EnvironmentSpec.safeParse({ filters: [filter] }).success, false, filter);
    assert.equal(EnvironmentSpec.safeParse({ filters: Array.from({ length: 9 }, (_, i) => `p${i}`) }).success, false, "eight filters at most");
    assert.equal(EnvironmentSpec.safeParse({ filters: [], command: "pnpm install" }).success, false, "no command");
  });

  it("previews what preparation sends and runs, or why it can't, never both", () => {
    const ready = {
      status: "ready",
      baseline: "b".repeat(40),
      packageManager: "pnpm@11.5.3",
      nodeRequirement: ">=22",
      packages: [{ name: "@sheetless/data", path: "packages/data" }],
      inputs: [{ path: "package.json", bytes: 300, sha256: "a".repeat(64) }],
      inputsDigest: "c".repeat(64),
      sentBytes: 2_000,
      leftOut: [".npmrc"],
      base: { tag: ENVIRONMENT_BASE.tag, registryUrl: ENVIRONMENT_BASE.registryUrl, node: ENVIRONMENT_BASE.node },
      installArgs: ["--frozen-lockfile", "--filter", "@sheetless/data..."],
      network: "On for the preparation only.",
      retention: "Images are retained for 180 days.",
      limits: { importSeconds: 900, prepareSeconds: 600, operations: 1 },
      fingerprint: FINGERPRINT,
    };
    assert.equal(EnvironmentPreview.safeParse(ready).success, true);
    assert.equal(EnvironmentPreview.safeParse({ status: "refused", code: "layout", message: "packages/a/package.json runs postinstall during an install." }).success, true);
    assert.equal(EnvironmentPreview.safeParse({ ...ready, status: "refused", code: "layout", message: "x" }).success, false);
  });

  it("starts as a run of its own, with upload consent and the spec in its context, and no model consent or brief", () => {
    const start = { clientRequestId: randomUUID(), workflowId: "environment", input: { repoPath: "/home/someone/repo", project: randomUUID(), target: "local", preview: FINGERPRINT }, context: { sharing: { cloudExecution: true }, spec: { filters: [] } } };
    assert.equal(StartRunParams.safeParse(start).success, true);
    assert.equal(StartRunParams.safeParse({ ...start, context: { sharing: { cloudExecution: true, modelContext: true }, spec: { filters: [] } } }).success, false);
    assert.equal(StartRunParams.safeParse({ ...start, input: { ...start.input, image: "img" } }).success, false, "the run names no image: it makes one");
  });

  it("is identified by its prepared image and bound to the Nebius project it was made in, by a hash that never holds the id", async () => {
    const prepared = { image: "a5019762", base: { tag: ENVIRONMENT_BASE.tag, image: "d6613a54", imported: true }, node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64", baseline: "b".repeat(40), inputsDigest: "c".repeat(64), spec: { filters: [] }, installArgs: ["--frozen-lockfile"], projectFingerprint: await projectFingerprint("project-e00one"), preparedAt: new Date().toISOString() };
    assert.equal(PreparedEnvironment.safeParse(prepared).success, true);
    const { projectFingerprint: _, ...unbound } = prepared;
    assert.equal(PreparedEnvironment.safeParse(unbound).success, false);
    const [one, again, other] = await Promise.all([projectFingerprint("project-e00one"), projectFingerprint("project-e00one"), projectFingerprint("project-e00two")]);
    assert.deepEqual([one === again, one === other, one.includes("e00one")], [true, false, false]);
    const report = { outcome: "prepared", stopped: null, prepared, install: { exitCode: 0, logTail: "Done in 7.7s" }, steps: [], cleanup: null, request: { runId: randomUUID(), clientRequestId: randomUUID() }, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    assert.equal(EnvironmentReport.safeParse(report).success, true);
    assert.equal(EnvironmentReport.safeParse({ ...report, stopped: { code: "something-else", step: null, message: "x" } }).success, false);
  });
});

describe("a brief's baseline selections and frozen files (D41)", () => {
  it("takes each selection with its exact output or a pattern, never both or neither, and a pattern that compiles", () => {
    assert.equal(TaskBrief.safeParse({ ...BRIEF, baseline: [SELECTION, PATTERN] }).success, true);
    const { expectedOutput: _, ...neither } = SELECTION;
    for (const wrong of [neither, { ...SELECTION, outputPattern: "x" }, { ...PATTERN, outputPattern: "(" }, { ...PATTERN, outputPattern: "x".repeat(501) }, { ...SELECTION, command: "a\0b" }]) {
      assert.equal(TaskBrief.safeParse({ ...BRIEF, baseline: [wrong] }).success, false, JSON.stringify(wrong).slice(0, 80));
    }
    assert.equal(TaskBrief.safeParse({ ...BRIEF, baseline: [SELECTION, PATTERN, SELECTION, PATTERN] }).success, false, "three selections at most");
  });

  it("matches a pattern against the whole output, never a part of it", () => {
    const pattern = baselinePattern("tests \\d+ passed \\d+ failed 0\\n|nothing");
    assert.deepEqual(["tests 4 passed 4 failed 0\n", "nothing", "x tests 4 passed 4 failed 0\n", "tests 4 passed 4 failed 0\nfailed\tone\n", "nothing more"].map((output) => pattern.test(output)), [true, true, false, false, false]);
    assert.equal(baselinePattern("a.b").test("a\nb"), true, "a dot matches a line break, so a pattern can span lines");
  });

  it("takes frozen files as paths inside the folder, each once", () => {
    assert.equal(TaskBrief.safeParse({ ...BRIEF, frozen: ["packages/data/tests/r.test.ts", "packages/data/vitest.config.ts"] }).success, true);
    for (const wrong of [["/etc/passwd"], ["../outside.ts"], ["a//b.ts"], ["./a.ts"], ["a.ts", "a.ts"], [""]]) assert.equal(TaskBrief.safeParse({ ...BRIEF, frozen: wrong }).success, false, wrong.join(","));
    assert.equal(TaskBrief.safeParse({ ...BRIEF, frozen: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }).success, false, "twenty at most");
  });

  it("digests a brief without them as before, and binds every selection and frozen path when it has them", async () => {
    const before = await taskBriefDigest(BRIEF);
    assert.equal(await taskBriefDigest({ ...BRIEF, baseline: [], frozen: [] }), before, "empty is the same brief as before D41");
    const withThem = await taskBriefDigest({ ...BRIEF, baseline: [SELECTION], frozen: ["a.ts"] });
    const changed = await Promise.all(
      [
        { ...BRIEF, baseline: [{ ...SELECTION, expectedExitCode: 1 }], frozen: ["a.ts"] },
        { ...BRIEF, baseline: [{ ...SELECTION, expectedOutput: "failed\tAssertionError\tone" }], frozen: ["a.ts"] },
        { ...BRIEF, baseline: [SELECTION], frozen: ["b.ts"] },
        { ...BRIEF, baseline: [SELECTION], frozen: [] },
        { ...BRIEF, baseline: [], frozen: ["a.ts"] },
      ].map(taskBriefDigest),
    );
    assert.equal(new Set([before, withThem, ...changed]).size, 7);
  });

  it("binds a run to its environment, and reads a report kept from before D41 as one with none", () => {
    const input = { repoPath: "/r", project: randomUUID(), target: "local", preview: FINGERPRINT, taskId: randomUUID(), briefVersion: 1, briefDigest: FINGERPRINT };
    const environment = { image: "a5019762", inputsDigest: "c".repeat(64), projectFingerprint: "d".repeat(64), node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64" };
    assert.equal(TaskInput.safeParse({ ...input, environment }).success, true);
    assert.equal(TaskInput.safeParse({ ...input, environment: { ...environment, tag: "node:22" } }).success, false, "a tag is never part of the binding");
    const kept = TaskReport.parse({
      outcome: "refused",
      stopped: { code: "baseline", step: "baseline", message: "x" },
      task: { taskId: randomUUID(), attemptId: randomUUID(), briefVersion: 1, briefDigest: FINGERPRINT },
      snapshot: null,
      toolchain: [],
      worker: null,
      checks: [],
      verified: false,
      steps: [],
      proposal: null,
      reportSha256: null,
      cleanup: null,
      route: null,
      request: { runId: randomUUID(), clientRequestId: randomUUID() },
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    });
    assert.deepEqual([kept.environment, kept.baseline, kept.frozen], [null, [], []]);
  });
});
