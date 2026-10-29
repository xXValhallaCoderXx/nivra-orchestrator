import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { CURRENT_PRICES, type BudgetOperation } from "@nivra/domain";
import { companionRequestUsage, ledgerState, markDispatching, recordJournal, writeGrant } from "../src/main/budget-store.ts";
import { openWorkspace } from "../src/main/workspace-db.ts";

function interruptedUsage(reserved: number, usage: BudgetOperation["usage"]) {
  const root = mkdtempSync(join(tmpdir(), "nivra interrupted token usage "));
  const opening = openWorkspace(join(root, "workspace.db"));
  assert.equal(opening.state, "ready");
  if (opening.state !== "ready") throw new Error("The fixture workspace could not open.");
  try {
    const now = Date.now();
    const written = writeGrant(opening.db, { requestId: randomUUID(), targetId: "local", workflow: "companion", attribution: { feature: "companion", projectId: null, taskId: null, attemptId: null, queueId: null, queueItemId: null, profile: null }, models: [CURRENT_PRICES.models[0]!.model], productive: { requests: reserved, outputTokens: 4_000 }, finalisation: { requests: 0, outputTokens: 0 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 }, extends: null, need: null }, { now, catalogue: CURRENT_PRICES, timezone: "UTC", verified: null });
    assert.ok("grant" in written);
    markDispatching(opening.db, written.grant.id, randomUUID(), now, ledgerState(opening.db));
    const row: BudgetOperation = { id: randomUUID(), grantId: written.grant.id, seq: 1, kind: "model-request", model: CURRENT_PRICES.models[0]!.model, seat: null, instructionsSha256: null, state: "unknown", boundMicros: null, usage, units: null, amountMicros: null };
    const settled = recordJournal(opening.db, written.grant.id, [row], { grantId: written.grant.id, kind: "interrupted", rows: 1, instanceId: randomUUID(), sealedAt: new Date(now).toISOString() }, now);
    assert.ok(!("refused" in settled));
    return companionRequestUsage(opening.db);
  } finally {
    opening.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

it("counts one uncertain inference's missing token usage once", () => {
  const usage = interruptedUsage(1, null);
  assert.deepEqual([usage.used, usage.reserved, usage.unknown, usage.unknownTokens], [1, 0, 1, 1]);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
});

it("keeps a reported subtotal while only the unresolved interrupted remainder has unknown tokens", () => {
  const usage = interruptedUsage(3, { inputTokens: 20, cachedInputTokens: null, outputTokens: 5 });
  assert.deepEqual([usage.used, usage.unknownTokens, usage.reportedInputTokens, usage.reportedOutputTokens], [3, 2, 20, 5]);
  assert.equal(usage.inputTokens, null);
});
