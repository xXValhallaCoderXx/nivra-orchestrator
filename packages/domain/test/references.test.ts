import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { it } from "node:test";
import { checkReferences, commentPayload, FrozenReferenceContext, manifestPayload, referenceImageEstimate, referenceText, type ReferenceManifest } from "../src/references.ts";
import { StartRunParams } from "../src/methods.ts";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function packet() {
  const taskId = randomUUID();
  const comment = { id: randomUUID(), taskId, order: 1, author: "You" as const, createdAt: "2026-10-30T00:00:00.000Z", text: "Supporting evidence", sha256: "" }; comment.sha256 = hash(commentPayload(comment));
  const payload = JSON.stringify({ status: "failed", verified: false, apply: "partial" }), summary = { id: randomUUID(), payload, sha256: hash(payload) };
  const manifest: ReferenceManifest = { version: 1, taskId, comments: [{ id: comment.id, sha256: comment.sha256 }], attachments: [], summaries: [{ id: summary.id, sha256: summary.sha256 }] };
  return { manifest, digest: hash(manifestPayload(manifest)), comments: [comment], attachments: [], summaries: [summary] };
}
it("binds the exact supplied comment order, author and timestamp and the canonical summary's status and apply facts", async () => {
  const references = packet(); assert.equal(await checkReferences(references), true);
  for (const change of ["order", "author", "createdAt", "text"] as const) {
    const changed = structuredClone(references) as unknown as { comments: Array<Record<string, unknown>> };
    changed.comments[0]![change] = change === "order" ? 2 : "Different";
    assert.equal(await checkReferences(changed as unknown as FrozenReferenceContext), false, change);
  }
  const changed = structuredClone(references); changed.summaries[0]!.payload = JSON.stringify({ status: "succeeded", verified: true, apply: "complete" });
  assert.equal(await checkReferences(changed), false);
  assert.equal(referenceText(references).includes('"status":"failed"'), true);
  assert.equal(referenceImageEstimate(references), 0);
});
it("refuses oversized discussion and inconsistent image/text inclusion instead of truncating or omitting", () => {
  const references = packet();
  assert.equal(FrozenReferenceContext.safeParse({ ...references, comments: Array.from({ length: 4 }, () => ({ ...references.comments[0], text: "x".repeat(8000) })) }).success, false);
  assert.equal(FrozenReferenceContext.safeParse({ ...references, attachments: [{ id: randomUUID(), name: "missing.png", kind: "image", text: null, image: null }] }).success, false);
});
it("requires finite grants on new coding requests while historical stored records remain separate", () => {
  const request = { clientRequestId: randomUUID(), workflowId: "task", input: { repoPath: "/repo", project: randomUUID(), target: "local", preview: "a".repeat(64), taskId: randomUUID(), briefVersion: 1, briefDigest: "b".repeat(64), preferencesDigest: "c".repeat(64), choicesDigest: "d".repeat(64) }, context: { sharing: { modelContext: true, cloudExecution: true }, preferences: { revision: 0, records: [] }, choices: [], brief: { goal: "One change", acceptanceCriteria: ["One result"], scope: "", exclusions: "", context: "", checks: [], acceptanceCases: [{ name: "One case", command: "printf ok", expectedOutput: "ok", expectedExitCode: 0 }] } } };
  assert.equal(StartRunParams.safeParse(request).success, false);
  const budget = { id: randomUUID(), requestId: request.clientRequestId, catalogueVersion: "test", rates: [], models: ["nvidia/Nemotron-3.5-Super-VL"], productiveMicros: null, finalisationMicros: null, productive: { requests: 23, outputTokens: 8000 }, finalisation: { requests: 1, outputTokens: 1500 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } };
  assert.equal(StartRunParams.safeParse({ ...request, budget }).success, true);
});
