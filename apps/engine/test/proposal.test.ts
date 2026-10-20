import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildPatch, PATCH_POLICY } from "../src/exec/patch.ts";
import { buildReport, canonicalJson, makeProposal, proposalHash, verifyProposal, type Proposal, type ProposalExpectation, type StepRecord } from "../src/exec/proposal.ts";
import { cleanUp, collect, GIT, git, guestRun, localSession, put, refusal, repoWith, scratch, snap } from "./workspace-fixtures.ts";

/**
 * Proposals (NIV-42, D34, D15): a patch bound to its project, target, destination, baseline and report by one hash,
 * and a verifier that refuses a wrong baseline, destination or hash, or anything that isn't intact.
 */
after(cleanUp);

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const STEP: StepRecord = { label: "check", exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false, persisted: false, durationMs: 1_200, stdoutTail: "ok\n", stderrTail: "" };

/** A real proposal: a repository, its snapshot, a sandbox's edit simulated here, the patch, the report. */
async function realProposal() {
  const root = repoWith({ "README.md": "# Demo\n", "src/a.ts": "export const a = 1;\n", "old.txt": "going\n" });
  const snapshot = await snap(root);
  const collected = collect(
    guestRun(snapshot, (workspace) => {
      writeFileSync(join(workspace, "src/a.ts"), "export const a = 2;\n");
      put(workspace, "src/b.ts", "export const b = 1;\n");
      rmSync(join(workspace, "old.txt"));
    }),
  );
  const session = await localSession(root);
  const patch = await buildPatch({ snapshot, collected, session, git: GIT }).finally(() => session.close());
  const report = buildReport({ snapshot, patch, steps: [STEP] });
  const proposal = makeProposal({ project: "project-1", target: "local", snapshot, patch, report });
  const expected: ProposalExpectation = { project: "project-1", target: "local", destination: { root: snapshot.topLevel, prefix: "" }, head: snapshot.baseline, approvedHash: proposal.hash };
  return { root, snapshot, patch, report, proposal, expected };
}

describe("proposals", () => {
  it("writes canonical JSON: keys sorted at every depth, no spaces, nothing undefined, and refuses what JSON can't hold", () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: true, c: null }, "x"], e: undefined }), '{"a":[{"c":null,"d":true},"x"],"b":1}');
    assert.equal(canonicalJson({ "é": 1, z: 2, A: 3 }), '{"A":3,"z":2,"é":1}');
    assert.throws(() => canonicalJson({ n: Number.NaN }), TypeError);
    assert.throws(() => canonicalJson({ f: () => 1 }), TypeError);
  });

  it("binds the patch to its project, target, destination, baseline, trees, fingerprint, policy and report, and hashes the binding", async () => {
    const { snapshot, patch, report, proposal } = await realProposal();
    assert.deepEqual(proposal.binding, {
      version: 1,
      project: "project-1",
      target: "local",
      destination: { root: snapshot.topLevel, prefix: "" },
      objectFormat: "sha1",
      baseline: snapshot.baseline,
      baseTree: patch.baseTree,
      resultTree: patch.resultTree,
      fingerprint: snapshot.fingerprint,
      policy: { ...PATCH_POLICY },
      patchSha256: sha(patch.bytes),
      reportSha256: sha(report),
    });
    assert.equal(proposal.hash, sha(canonicalJson(proposal.binding)));
    // Every field counts: changing any one gives another hash.
    const fields: Array<Partial<Proposal["binding"]>> = [
      { version: 2 },
      { project: "project-2" },
      { target: "wsl:Ubuntu" },
      { destination: { root: snapshot.topLevel, prefix: "src" } },
      { destination: { root: `${snapshot.topLevel}-other`, prefix: "" } },
      { objectFormat: "sha256" },
      { baseline: "0".repeat(40) },
      { baseTree: "0".repeat(40) },
      { resultTree: "0".repeat(40) },
      { fingerprint: "0".repeat(64) },
      { policy: { ...PATCH_POLICY, version: 2 } },
      { policy: { ...PATCH_POLICY, maxChangedFiles: 501 } },
      { patchSha256: "0".repeat(64) },
      { reportSha256: "0".repeat(64) },
    ];
    const hashes = new Set([proposal.hash, ...fields.map((field) => proposalHash({ ...proposal.binding, ...field }))]);
    assert.equal(hashes.size, fields.length + 1);
  });

  it("lists deletions first in its report, then additions and changes, with no file content", async () => {
    const { report } = await realProposal();
    const parsed = JSON.parse(new TextDecoder().decode(report)) as { changes: Array<{ change: string; path: string }>; steps: StepRecord[] };
    assert.deepEqual(
      parsed.changes.map((change) => [change.change, change.path]),
      [
        ["deleted", "old.txt"],
        ["added", "src/b.ts"],
        ["changed", "src/a.ts"],
      ],
    );
    assert.deepEqual(
      parsed.steps.map((step) => [step.label, step.exitCode]),
      [["check", 0]],
    );
    assert.ok(!new TextDecoder().decode(report).includes("export const"), "the report holds file content");
    const long = buildReport({ ...(await realProposal()), steps: [{ ...STEP, stdoutTail: "x".repeat(5_000) }] });
    assert.ok(long.byteLength < 5_000, "a step's output wasn't bounded");
  });

  it("passes the proposal approved for this destination and commit, and refuses a wrong hash, destination, project, target or baseline", async () => {
    const { root, snapshot, proposal, expected } = await realProposal();
    verifyProposal(proposal, expected);
    assert.throws(() => verifyProposal(proposal, { ...expected, approvedHash: "0".repeat(64) }), refusal(/^This isn't the proposal you approved \(its hash is [0-9a-f]{12}, not 000000000000\), so it wasn't applied\.$/));
    assert.throws(() => verifyProposal(proposal, { ...expected, destination: { root: snapshot.topLevel, prefix: "src" } }), refusal(/^This proposal was made for another folder, so it can't be applied here\.$/));
    assert.throws(() => verifyProposal(proposal, { ...expected, destination: { root: scratch("elsewhere"), prefix: "" } }), refusal(/made for another folder/));
    assert.throws(() => verifyProposal(proposal, { ...expected, project: "project-2" }), refusal(/made for another project, or on another target/));
    assert.throws(() => verifyProposal(proposal, { ...expected, target: "wsl:Ubuntu" }), refusal(/made for another project, or on another target/));
    // The checkout moved on: the patch was made from another commit.
    writeFileSync(join(root, "README.md"), "# Moved on\n");
    git(root, ["commit", "-q", "-am", "moved on"]);
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    assert.throws(() => verifyProposal(proposal, { ...expected, head }), refusal(new RegExp(`^Your checkout has moved to another commit \\(HEAD is ${head.slice(0, 12)}, and the proposal was made from ${snapshot.baseline.slice(0, 12)}\\)\\. Run the task again from the commit it is on now\\.$`)));
  });

  it("binds the rules its patch was made under, taken from the patch, and refuses one made under other rules", async () => {
    const root = repoWith({ "a.txt": "a\n" });
    const snapshot = await snap(root);
    const collected = collect(guestRun(snapshot, (workspace) => writeFileSync(join(workspace, "a.txt"), "b\n")));
    const proposalUnder = async (policy: Partial<typeof PATCH_POLICY>) => {
      const session = await localSession(root);
      const patch = await buildPatch({ snapshot, collected, session, git: GIT, policy }).finally(() => session.close());
      const proposal = makeProposal({ project: "p", target: "t", snapshot, patch, report: buildReport({ snapshot, patch, steps: [] }) });
      return { proposal, expected: { project: "p", target: "t", destination: { root: snapshot.topLevel, prefix: "" }, head: snapshot.baseline, approvedHash: proposal.hash } };
    };
    const relaxed = await proposalUnder({ maxChangedFiles: 10_000 });
    assert.deepEqual(relaxed.proposal.binding.policy, { ...PATCH_POLICY, maxChangedFiles: 10_000 });
    const RULES = /^This proposal was checked under other rules than the ones Nivra applies now, so it can't be applied\. Run the task again\.$/;
    assert.throws(() => verifyProposal(relaxed.proposal, relaxed.expected), refusal(RULES));
    verifyProposal(relaxed.proposal, { ...relaxed.expected, policy: relaxed.proposal.binding.policy });
    // The review's case: a patch made under version 7 used to be bound as version 1, and passed.
    const later = await proposalUnder({ version: 7 });
    assert.equal(later.proposal.binding.policy.version, 7);
    assert.throws(() => verifyProposal(later.proposal, later.expected), refusal(RULES));
  });

  it("refuses a proposal that isn't intact: its patch, its report or its binding changed after hashing", async () => {
    const { proposal, expected } = await realProposal();
    const flipped = (bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes);
      copy[0] = copy[0]! ^ 1;
      return copy;
    };
    const INTACT = /^This proposal isn't intact: its patch, its report or what it binds no longer matches its hash, so it can't be applied\. Run the task again\.$/;
    assert.throws(() => verifyProposal({ ...proposal, patch: flipped(proposal.patch) }, expected), refusal(INTACT));
    assert.throws(() => verifyProposal({ ...proposal, report: flipped(proposal.report) }, expected), refusal(INTACT));
    assert.throws(() => verifyProposal({ ...proposal, binding: { ...proposal.binding, baseline: "0".repeat(40) } }, expected), refusal(INTACT));
    // A binding changed and hashed again is intact, but it isn't what was approved.
    const rebound = { ...proposal.binding, destination: { ...proposal.binding.destination, prefix: "src" } };
    assert.throws(() => verifyProposal({ ...proposal, binding: rebound, hash: proposalHash(rebound) }, expected), refusal(/^This isn't the proposal you approved/));
    assert.throws(() => verifyProposal({ ...proposal, binding: { ...proposal.binding, version: 2 }, hash: proposalHash({ ...proposal.binding, version: 2 }) }, expected), refusal(/another version of Nivra's rules/));
  });
});
