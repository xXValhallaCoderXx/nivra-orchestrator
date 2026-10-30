import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { BudgetPolicyDraft, CURRENT_PRICES, NO_SUBLIMITS, type GrantRequest } from "@nivra/domain";
import { companionRequestUsage, currentPolicy, ledgerState, markDispatching, releaseGrant, setPolicy, startNewHistory, writeGrant } from "../src/main/budget-store.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";

const roots: string[] = [], databases: WorkspaceDb[] = [];
after(() => { for (const db of databases) db.close(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const NOW = Date.parse("2026-10-30T00:00:00Z");
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "nivra-mission-budget-")); roots.push(root);
  const opened = openWorkspace(join(root, "workspace.db"));
  if (opened.state !== "ready") throw new Error(opened.reason);
  databases.push(opened.db); return opened.db;
}
const policy = (monthlyRequests: number, includeMissionReviews?: boolean, coding = false): BudgetPolicyDraft => ({ preset: "counts", currency: null, monthlyMicros: null, timezone: "UTC", thresholds: [], sublimits: NO_SUBLIMITS, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 }, researchCreditMicros: null, modelRequestLimits: [{ pool: coding ? "companion-planning-and-coding" : "companion-and-planning", monthlyRequests, ...(includeMissionReviews === undefined ? {} : { includeMissionReviews }) }] });
const review = (): GrantRequest => ({ requestId: randomUUID(), workflow: "review", targetId: "local", attribution: { feature: "mission-review", projectId: null, taskId: null, attemptId: null, queueId: null, queueItemId: null, profile: null }, models: ["nvidia/Nemotron-3.5-Super-VL"], productive: { requests: 2, outputTokens: 4000 }, finalisation: { requests: 1, outputTokens: 4000 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 }, extends: null, need: null });
const context = (db: WorkspaceDb) => ({ now: NOW, catalogue: CURRENT_PRICES, timezone: "UTC", verified: ledgerState(db) });

it("preserves historical policy bytes and counts earlier reviews exactly once only after explicit coverage", () => {
  const db = workspace(); const original = policy(7, undefined, true);
  assert.deepEqual(BudgetPolicyDraft.parse(original), original);
  setPolicy(db, original, NOW, CURRENT_PRICES);
  const firstPolicy = currentPolicy(db)!;
  const first = writeGrant(db, review(), context(db));
  if ("refused" in first) throw new Error(first.refused.message);
  assert.equal(companionRequestUsage(db).reserved, 0);
  assert.equal(companionRequestUsage(db).missionReviews.reserved, 3);
  assert.equal(companionRequestUsage(db).includeMissionReviews, false);
  setPolicy(db, policy(7, true, true), NOW, CURRENT_PRICES);
  assert.deepEqual([companionRequestUsage(db).reserved, companionRequestUsage(db).remaining, companionRequestUsage(db).coverage], [3, 4, "companion-planning-and-coding"]);
  assert.equal(firstPolicy.modelRequestLimits?.[0]?.includeMissionReviews, undefined);
  setPolicy(db, policy(7, false, true), NOW, CURRENT_PRICES);
  assert.deepEqual([companionRequestUsage(db).reserved, companionRequestUsage(db).missionReviews.reserved], [0, 3]);
});

it("requires all three council slots atomically and competes with other covered inference", () => {
  for (const slots of [0, 1, 2, 3]) {
    const db = workspace(); setPolicy(db, policy(slots, true), NOW, CURRENT_PRICES);
    const admitted = writeGrant(db, review(), context(db));
    assert.equal("grant" in admitted, slots === 3);
    if ("grant" in admitted) {
      assert.deepEqual([admitted.grant.productive.requests, admitted.grant.finalisation.requests, admitted.grant.modelListings], [2, 1, 1]);
      assert.equal("refused" in writeGrant(db, review(), context(db)), true);
      const competing = review(); competing.workflow = "companion"; competing.attribution.feature = "companion"; competing.productive.requests = 1; competing.finalisation.requests = 0;
      assert.equal("refused" in writeGrant(db, competing, context(db)), true);
      assert.equal(companionRequestUsage(db).reserved, 3);
    }
  }
});

it("keeps budget-off and excluded reviews finite, recorded and unpriced, releasing only a proven unsent grant", () => {
  for (const excluded of [false, true]) {
    const db = workspace(); if (excluded) setPolicy(db, policy(0), NOW, CURRENT_PRICES);
    const admitted = writeGrant(db, review(), context(db));
    if ("refused" in admitted) throw new Error(admitted.refused.message);
    assert.equal(admitted.grant.productiveMicros, null);
    assert.equal(companionRequestUsage(db).missionReviews.reserved, 3);
    assert.ok(releaseGrant(db, admitted.grant.id, NOW, ledgerState(db)));
    assert.equal(companionRequestUsage(db).missionReviews.reserved, 0);
  }
});

it("requires independent review recovery consent and keeps its charges after later coverage changes", () => {
  const db = workspace(); setPolicy(db, policy(100, undefined, true), NOW, CURRENT_PRICES);
  const before = ledgerState(db)!;
  startNewHistory(db, { recovery: { reason: "ledger-missing", detectedAt: new Date(NOW).toISOString(), ledger: null, guard: { ...before, month: "2026-10", at: new Date(NOW).toISOString() } }, remaining: { mode: "counts", micros: 0, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 }, modelRequestLimits: [{ pool: "companion-and-planning", monthlyRequests: 3 }] }, now: NOW, timezone: "UTC" });
  const revision = companionRequestUsage(db).missionReviewRecoveryRevision!;
  setPolicy(db, { ...policy(100, true, true), requestRecoveryRevision: revision }, NOW, CURRENT_PRICES);
  assert.equal("refused" in writeGrant(db, review(), context(db)), true, "coding consent cannot broaden mission-review recovery");
  setPolicy(db, { ...policy(100, true, true), requestRecoveryRevision: revision, missionReviewRecoveryRevision: revision }, NOW, CURRENT_PRICES);
  const admitted = writeGrant(db, review(), context(db));
  if ("refused" in admitted) throw new Error(admitted.refused.message);
  markDispatching(db, admitted.grant.id, "test-home", NOW, ledgerState(db));
  setPolicy(db, null, NOW, CURRENT_PRICES);
  const companion = review(); companion.workflow = "companion"; companion.attribution.feature = "companion"; companion.productive.requests = 1; companion.finalisation.requests = 0;
  assert.equal("refused" in writeGrant(db, companion, context(db)), true);
  assert.equal(companionRequestUsage(db).remaining, 0);
  assert.equal(companionRequestUsage(db).missionReviews.reserved, 3);
});
