import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { packetDigest, REVIEW_PACKET_LIMITS, type ReviewReport } from "@nivra/domain";
import { historicalReferences, packetFor, previewFingerprint, reportMatches, reviewNoteFor } from "../src/main/reviews.ts";
import type { PlanContent } from "../src/main/tasks.ts";
import type { ArtifactRecord, ConversationRecord, ReviewRecord, TurnRecord } from "../src/main/workspace.ts";

const AT = "2026-10-20T10:00:00.000Z";
const KEY = "test-key-0123456789";
const KNOWN = [["NEBIUS_API_KEY", KEY]] as const;
const general: ConversationRecord = { id: randomUUID(), kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "t", createdAt: AT, updatedAt: AT };
const project: ConversationRecord = { ...general, id: randomUUID(), kind: "project", projectId: randomUUID(), projectLabel: "shop", targetId: "wsl:Ubuntu" };
const content = (change: Partial<PlanContent> = {}): PlanContent => ({
  text: "Add the new column, backfill it, then switch reads.",
  conversationId: project.id,
  messageId: randomUUID(),
  runId: null,
  projectId: project.projectId,
  kind: "repository",
  headAtStart: "29c3a40a1b2c3d4e5f60718293a4b5c6d7e8f901",
  citations: [
    { path: "src/db.ts", startLine: 10, endLine: 20 },
    { path: "src/app.ts", startLine: 1, endLine: 4 },
    { path: "src/db.ts", startLine: 10, endLine: 20 },
  ],
  assumptions: ["Deploys are rolling."],
  ...change,
});
const planOf = (plan: PlanContent): ArtifactRecord => ({ id: randomUUID(), kind: "plan", lineageId: randomUUID(), version: 2, content: plan, sha256: "s", conversationId: plan.conversationId, taskId: null, messageId: plan.messageId, runLinkId: null, derivedFrom: null, createdAt: AT });
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

describe("the packet a plan version sends for review (D31)", () => {
  it("sends a project's plan with its commit and each place its answer looked once, in order, and a general plan with no references", async () => {
    const packet = packetFor(planOf(content()), project, KNOWN);
    assert.deepEqual(packet, {
      scope: { kind: "project", headAtStart: "29c3a40a1b2c3d4e5f60718293a4b5c6d7e8f901" },
      text: "Add the new column, backfill it, then switch reads.",
      assumptions: ["Deploys are rolling."],
      references: [
        { path: "src/db.ts", startLine: 10, endLine: 20 },
        { path: "src/app.ts", startLine: 1, endLine: 4 },
      ],
    });
    assert.deepEqual(historicalReferences(content()), packet.references, "the window numbers them as the packet does");
    const fromGeneral = packetFor(planOf(content({ kind: "general", headAtStart: null })), general, KNOWN);
    assert.deepEqual([fromGeneral.scope, fromGeneral.references], [{ kind: "general" }, []]);
    // The same version gives the same fingerprint each time it is worked out.
    assert.equal(await packetDigest(packetFor(planOf(content()), project, KNOWN)), await packetDigest(packet));
  });

  it("refuses a plan version too long to review, or whose text holds a credential, saying what to do; masks what came from the engine", () => {
    const max = REVIEW_PACKET_LIMITS.textChars;
    assert.equal(
      refusal(() => packetFor(planOf(content({ text: "x".repeat(max + 1) })), project, KNOWN)),
      `This plan version is ${(max + 1).toLocaleString("en")} characters long, and a review can take ${max.toLocaleString("en")}. Edit the plan to shorten it, then review the new version.`,
    );
    assert.equal(packetFor(planOf(content({ text: "x".repeat(max) })), project, KNOWN).text.length, max);
    assert.equal(
      refusal(() => packetFor(planOf(content({ text: `Use ${KEY} for now.` })), project, KNOWN)),
      "This plan version holds your saved Token Factory key, so nothing was sent. Edit the plan to remove it, then review the new version.",
    );
    assert.equal(
      refusal(() => packetFor(planOf(content({ text: `Use ghp_${"z".repeat(36)} for now.` })), project, KNOWN)),
      "This plan version looks like it holds a GitHub token, so nothing was sent. Edit the plan to remove it, then review the new version.",
    );
    const masked = packetFor(planOf(content({ assumptions: [`The key ${KEY} still works.`], citations: [{ path: `config/${KEY}.json`, startLine: 1, endLine: 1 }] })), project, KNOWN);
    assert.deepEqual([masked.assumptions, masked.references.map((r) => r.path)], [["The key [secret:NEBIUS_API_KEY] still works."], ["config/[secret:NEBIUS_API_KEY].json"]]);
    assert.equal(
      refusal(() => packetFor(planOf(content({ assumptions: Array.from({ length: 21 }, (_, i) => `Assumption ${i}`) })), project, KNOWN)),
      "This plan version's assumptions can't be sent for review as saved, so nothing was sent. Save the answer it came from as a new plan, then review that.",
    );
  });
});

describe("what binds a review to its preview and its report (D31)", () => {
  const parts = { planId: randomUUID(), planVersion: 2, packetDigest: "a".repeat(64), preferencesDigest: "b".repeat(64), sharing: true, panel: "council" as const };

  it("moves the preview's fingerprint with every part it binds, and only with them", () => {
    const base = previewFingerprint(parts);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(previewFingerprint({ ...parts }), base);
    const changed = [
      { planId: randomUUID() },
      { planVersion: 3 },
      { packetDigest: "c".repeat(64) },
      { preferencesDigest: "d".repeat(64) },
      { sharing: false },
      { sharing: null },
      { panel: "single" as const },
    ].map((change) => previewFingerprint({ ...parts, ...change }));
    assert.equal(new Set([base, ...changed]).size, 8);
  });

  it("accepts a report only for its own plan version, fingerprints, panel, request and run", () => {
    const runId = randomUUID();
    const review = { id: randomUUID(), planId: parts.planId, planVersion: 2, packetDigest: parts.packetDigest, preferencesDigest: parts.preferencesDigest, panel: "council" } as ReviewRecord;
    const report = { planId: review.planId, planVersion: 2, packetDigest: review.packetDigest, preferencesDigest: review.preferencesDigest, panel: "council", request: { runId, clientRequestId: review.id } } as ReviewReport;
    assert.equal(reportMatches(report, review, runId), true);
    const wrong: Array<Partial<ReviewReport>> = [
      { planId: randomUUID() },
      { planVersion: 1 },
      { packetDigest: "c".repeat(64) },
      { preferencesDigest: "d".repeat(64) },
      { panel: "single" },
      { request: { runId, clientRequestId: randomUUID() } },
      { request: { runId: randomUUID(), clientRequestId: review.id } },
    ];
    assert.deepEqual(wrong.map((change) => reportMatches({ ...report, ...change }, review, runId)), wrong.map(() => false));
  });

  it("says how a review ended without a complete report, and that nothing was resent", () => {
    const link = (change: Partial<TurnRecord>) => ({ status: "failed", cancelReason: null, errorMessage: null, ...change }) as TurnRecord;
    assert.deepEqual(
      [
        reviewNoteFor(link({ status: "running" })),
        reviewNoteFor(link({ status: "answered" })),
        reviewNoteFor(link({ errorMessage: "The risks review couldn't be used: it answered in plain text." })),
        reviewNoteFor(link({ status: "cancelled", cancelReason: "person" })),
        reviewNoteFor(link({ status: "cancelled", cancelReason: "sharing" })),
        reviewNoteFor(link({ status: "interrupted" })),
        reviewNoteFor(link({ status: "unknown", errorMessage: "its engine's report is about something other than what this review sent, so none of it was kept" })),
      ],
      [
        null,
        null,
        "The risks review couldn't be used: it answered in plain text. Nothing was resent.",
        "Cancelled. Nothing was resent.",
        "Stopped: sharing for this project was turned off. Nothing was resent.",
        "Interrupted: Nivra or its engine stopped before the review finished. Nothing was resent.",
        "Nivra can't tell whether this review reached the model: its engine's report is about something other than what this review sent, so none of it was kept. Nothing was resent.",
      ],
    );
  });
});
