import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { taskBriefDigest, taskVerificationManifest, type ApplyTaskBinding, type TaskAdmissionParams, type TaskBrief, type TaskCheck } from "@nivra/domain";
import { PATCH_POLICY } from "../src/exec/patch.ts";
import { canonicalJson, proposalHash, type Proposal } from "../src/exec/proposal.ts";
import { taskAdmission } from "../src/task/admission.ts";
import { TASK_BRIEF } from "../scripts/task-fixture.ts";

/** Engine-owned evidence only: no repository command, provider or mutable display report is involved. */
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const BRIEF: TaskBrief = TASK_BRIEF;
const resultOf = (kind: "case" | "check", number: number, commandSha256?: string): TaskCheck => ({ kind, number, ...(commandSha256 ? { commandSha256 } : {}), name: kind === "case" ? "acceptance" : "/bin/sh check.sh", verdict: "passed", reason: null, exitCode: 0, stdoutTail: "ok", stderrTail: "", difference: null, changedFiles: [], unclear: false, durationMs: 1 });

async function fixture(legacy = false) {
  const homeId = randomUUID();
  const task: ApplyTaskBinding = { attempt: { taskId: randomUUID(), attemptId: randomUUID(), runId: randomUUID() }, engine: { homeId }, brief: { version: 1, sha256: await taskBriefDigest(BRIEF) } };
  const manifest = await taskVerificationManifest(BRIEF, false);
  const checks = manifest.checks.map((check) => ({ ...resultOf(check.kind, check.number, legacy ? undefined : check.commandSha256), name: check.kind === "case" ? BRIEF.acceptanceCases[check.number - 1]!.name : BRIEF.checks[check.number - 1]! }));
  const core: Record<string, unknown> = {
    version: legacy ? 3 : 4, kind: "task", task: { taskId: task.attempt.taskId, attemptId: task.attempt.attemptId, runId: task.attempt.runId, briefVersion: task.brief.version, briefSha256: task.brief.sha256 },
    baseline: "a".repeat(40), prefix: "", environment: null, environmentRef: null, setup: null, frozen: [], checks, verified: true,
    ...(!legacy ? { manifest, beforeChecks: checks.filter((check) => check.kind === "check") } : {}),
  };
  const sign = (value: Record<string, unknown>): Proposal => {
    const report = new TextEncoder().encode(canonicalJson(value));
    const patch = new TextEncoder().encode("fixture patch");
    const postImage = new Uint8Array();
    const binding = { version: 2, project: "project", target: "local", destination: { root: "/fixture", prefix: "" }, objectFormat: "sha1" as const, baseline: "a".repeat(40), baseTree: "b".repeat(40), resultTree: "c".repeat(40), fingerprint: "d".repeat(64), policy: { ...PATCH_POLICY }, patchSha256: sha256(patch), reportSha256: sha256(report), paths: [], postImageSha256: sha256(postImage), task };
    return { binding, hash: proposalHash(binding), patch, report, postImage };
  };
  const proposal = sign(core);
  const params: TaskAdmissionParams = { runId: task.attempt.runId, approvedHash: proposal.hash, task, brief: BRIEF };
  const assess = (value = core, request: Partial<TaskAdmissionParams> = {}) => {
    const proposed = sign(value);
    return taskAdmission({ proposal: proposed, params: { ...params, approvedHash: proposed.hash, ...request }, homeId });
  };
  return { core, params, proposal, homeId, checks, manifest, assess };
}

describe("trusted proposal admission (NIV-67)", () => {
  it("admits a complete passing hash-bound report without relying on a display artifact", async () => {
    const run = await fixture();
    const admitted = await run.assess();
    assert.deepEqual([admitted.eligible, admitted.reason, admitted.proposalHash, admitted.reportSha256, admitted.legacy], [true, null, run.proposal.hash, run.proposal.binding.reportSha256, false]);
    const { brief: _brief, ...withoutBrief } = run.params;
    assert.equal((await taskAdmission({ proposal: run.proposal, params: withoutBrief, homeId: run.homeId })).eligible, true, "a new bound manifest is self-contained");
  });

  it("refuses false stored verdicts, failed or missing required finals, duplicate identities and missing current manifests", async () => {
    const run = await fixture();
    const failed = { ...run.checks[1]!, verdict: "failed", exitCode: 1 };
    const rows = [
      { ...run.core, verified: false },
      { ...run.core, checks: [run.checks[0], failed] },
      { ...run.core, checks: [run.checks[0]] },
      { ...run.core, checks: [run.checks[0], run.checks[0]] },
      { ...run.core, manifest: undefined },
      { ...run.core, beforeChecks: undefined },
      { ...run.core, beforeChecks: [] },
    ];
    for (const [index, core] of rows.entries()) assert.equal((await run.assess(core)).eligible, false, `invalid evidence ${index}`);
    for (const verdict of ["couldnt-run", "unknown", "not-run"]) assert.equal((await run.assess({ ...run.core, checks: [run.checks[0], { ...run.checks[1], verdict, exitCode: null }] })).eligible, false, verdict);
  });

  it("refuses altered bytes, wrong approval hashes, homes and embedded run identities", async () => {
    const run = await fixture();
    assert.equal((await taskAdmission({ proposal: { ...run.proposal, report: new TextEncoder().encode("{}") }, params: run.params, homeId: run.homeId })).eligible, false);
    assert.equal((await run.assess(run.core, { approvedHash: "0".repeat(64) })).eligible, false);
    assert.equal((await taskAdmission({ proposal: run.proposal, params: run.params, homeId: randomUUID() })).eligible, false);
    assert.equal((await run.assess({ ...run.core, task: { ...(run.core["task"] as object), runId: randomUUID() } })).eligible, false);
    assert.equal((await run.assess(run.core, { brief: { ...BRIEF, checks: [] } })).eligible, false);
  });

  it("matches setup and frozen requirements to the manifest and the original brief", async () => {
    const run = await fixture();
    assert.equal((await run.assess({ ...run.core, environment: { image: "prepared" } })).eligible, false);
    assert.equal((await run.assess({ ...run.core, manifest: { ...run.manifest, frozen: ["check.sh"] } })).eligible, false);
    assert.equal((await run.assess({ ...run.core, frozen: [{ path: "check.sh", unchanged: true }] })).eligible, false);
    assert.equal((await run.assess({ ...run.core, setup: { unchanged: false, changed: ["package.json"] } })).eligible, false);
  });

  it("admits complete passing legacy evidence only against the original brief, without manufacturing comparison results", async () => {
    const run = await fixture(true);
    const before = Buffer.from(run.proposal.report).toString("hex");
    const admitted = await run.assess();
    assert.deepEqual([admitted.eligible, admitted.legacy], [true, true]);
    assert.equal(Buffer.from(run.proposal.report).toString("hex"), before);
    const { brief: _brief, ...params } = run.params;
    assert.equal((await taskAdmission({ proposal: run.proposal, params, homeId: run.homeId })).eligible, false);
    assert.equal((await run.assess({ ...run.core, checks: [run.checks[0]] })).eligible, false);
    assert.equal((await run.assess({ ...run.core, verified: false })).eligible, false);
    assert.equal((await run.assess({ ...run.core, checks: [run.checks[0], { ...run.checks[1], verdict: "failed", exitCode: 1 }] })).eligible, false);
    assert.equal((await run.assess({ ...run.core, checks: [run.checks[0], { ...run.checks[1], name: "another command" }] })).eligible, false);
    assert.equal((await run.assess({ ...run.core, checks: [{ ...run.checks[0], exitCode: 99 }, run.checks[1]] })).eligible, false);
  });
});
