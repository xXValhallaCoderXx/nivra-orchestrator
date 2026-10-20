import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { StartRunParams } from "../src/methods.ts";
import { packetDigest, REVIEW_PACKET_LIMITS, ReviewPacket, ReviewReport, type ReviewPacket as Packet } from "../src/review.ts";

/** The review contract (NIV-38, D30): what a review run takes, what it never takes, and how its packet is fingerprinted. */
const PACKET: Packet = {
  scope: { kind: "project", headAtStart: "29c3a40a" },
  text: "Add a CSV export of a user's workout history.",
  assumptions: ["A query can return every session."],
  references: [{ path: "src/history.ts", startLine: 341, endLine: 347 }],
};
const DIGEST = "a".repeat(64);
const request = (overrides: { input?: Record<string, unknown>; packet?: unknown } = {}) => ({
  clientRequestId: randomUUID(),
  workflowId: "review",
  input: { planId: randomUUID(), planVersion: 2, packetDigest: DIGEST, preferencesDigest: DIGEST, ...overrides.input },
  context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: true }, packet: overrides.packet ?? PACKET },
});

describe("a review run's request (NIV-38)", () => {
  it("takes a plan version, its fingerprints and its packet, with the council as the default panel", () => {
    const parsed = StartRunParams.parse(request());
    assert.equal(parsed.workflowId, "review");
    assert.deepEqual(parsed.workflowId === "review" ? [parsed.input.panel, parsed.input.planVersion] : null, ["council", 2]);
    assert.equal(StartRunParams.safeParse(request({ input: { panel: "single" } })).success, true);
  });

  it("refuses a path or a project id in the packet, references for a general plan, blank or oversized parts, and fingerprints that aren't one", () => {
    const refused = [
      request({ packet: { ...PACKET, scope: { kind: "project", headAtStart: null, repoPath: "/repo" } } }),
      request({ packet: { ...PACKET, scope: { kind: "project", headAtStart: null, projectId: randomUUID() } } }),
      request({ packet: { ...PACKET, scope: { kind: "general" } } }),
      request({ packet: { ...PACKET, text: "  \n " } }),
      request({ packet: { ...PACKET, text: "x".repeat(REVIEW_PACKET_LIMITS.textChars + 1) } }),
      request({ packet: { ...PACKET, assumptions: Array.from({ length: REVIEW_PACKET_LIMITS.assumptions + 1 }, () => "a") } }),
      request({ packet: { ...PACKET, references: Array.from({ length: REVIEW_PACKET_LIMITS.references + 1 }, () => PACKET.references[0]) } }),
      request({ packet: { ...PACKET, references: [{ path: "a.ts", startLine: 9, endLine: 3 }] } }),
      request({ input: { packetDigest: "not a digest" } }),
      request({ input: { panel: "debate" } }),
      { ...request(), input: { ...request().input, repoPath: "/repo" } },
    ];
    assert.deepEqual(
      refused.map((params) => StartRunParams.safeParse(params).success),
      refused.map(() => false),
    );
    assert.equal(ReviewPacket.safeParse({ ...PACKET, scope: { kind: "general" }, references: [] }).success, true, "a general plan without references is fine");
  });
});

describe("packetDigest (NIV-38)", () => {
  it("is pinned to its canonical form, which anyone can work out", async () => {
    const digest = await packetDigest(PACKET);
    assert.equal(digest, "2972a73bca663b0c94910b483e9955bd6d395268cc73b2c03e8f89851edc8597");
    const independent = createHash("sha256")
      .update(JSON.stringify(["nivra.review-packet.v1", "project", "29c3a40a", PACKET.text, PACKET.assumptions, [["src/history.ts", 341, 347]]]))
      .digest("hex");
    assert.equal(digest, independent);
  });

  it("changes with any part of the packet, and with their order", async () => {
    const variants: Packet[] = [
      { ...PACKET, text: `${PACKET.text} ` },
      { ...PACKET, assumptions: [...PACKET.assumptions, "Another."] },
      { ...PACKET, assumptions: ["Another.", ...PACKET.assumptions] },
      { ...PACKET, references: [{ ...PACKET.references[0]!, endLine: 348 }] },
      { ...PACKET, scope: { kind: "project", headAtStart: null } },
      { ...PACKET, scope: { kind: "general" }, references: [] },
    ];
    const digests = await Promise.all([PACKET, ...variants].map((packet) => packetDigest(packet)));
    assert.equal(new Set(digests).size, digests.length);
    assert.equal(await packetDigest(structuredClone(PACKET)), digests[0], "the same content gives the same fingerprint");
  });
});

describe("ReviewReport (NIV-38)", () => {
  it("has no verdict to read as approval, and gives each finding an id the engine assigned", () => {
    const report = {
      panel: "council",
      planId: randomUUID(),
      planVersion: 1,
      packetDigest: DIGEST,
      preferencesDigest: DIGEST,
      outcome: "complete",
      scope: { kind: "general" },
      packet: { textChars: 10, assumptions: 0, references: 0 },
      request: { runId: randomUUID(), clientRequestId: randomUUID() },
      route: null,
      sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" },
      preferences: { revision: 0, digest: DIGEST, records: [] },
      reviewers: [],
      synthesis: null,
      stages: [],
      usage: { inputTokens: null, outputTokens: null, calls: 0, reportedCalls: 0 },
      budget: {
        limits: { requests: 3, totalMs: 330_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 120_000 },
        used: { requests: 0, elapsedMs: 0, inputTokens: 0, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: 0, overrunTokens: 0 },
        stopped: null,
      },
      elapsedMs: 0,
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    };
    assert.equal(ReviewReport.safeParse(report).success, true);
    assert.equal(ReviewReport.safeParse({ ...report, verdict: "approved" }).success, false);
    const finding = { id: "arch-1", title: "t", detail: "d", recommendation: "r", severity: null, basis: "plan", refs: ["plan"], relabelled: false };
    const reviewer = { role: "architecture", summary: "s", findings: [finding], assumptions: [], gaps: [], adjusted: { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 } };
    assert.equal(ReviewReport.safeParse({ ...report, reviewers: [reviewer] }).success, true);
    assert.equal(ReviewReport.safeParse({ ...report, reviewers: [{ ...reviewer, findings: [{ ...finding, id: "approved" }] }] }).success, false);
    assert.equal(ReviewReport.safeParse({ ...report, reviewers: [{ ...reviewer, findings: [{ ...finding, basis: "evidence" }] }] }).success, false, "a historical reference is never evidence");
  });
});
