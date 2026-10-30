import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { BudgetGrant } from "@nivra/domain";
import { BudgetJournal } from "../src/budget/journal.ts";
import { Database } from "../src/db/database.ts";
import { CodingCapacity } from "../src/task/capacity.ts";
import { cleanUp, scratch } from "./workspace-fixtures.ts";

after(cleanUp);
function fixture() {
  const database = new Database(join(scratch("capacity"), "nivra.db"));
  const journal = new BudgetJournal(database, randomUUID());
  const runId = randomUUID();
  const root: BudgetGrant = { id: randomUUID(), requestId: randomUUID(), models: ["model"], catalogueVersion: "test", rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: 16, outputTokens: 8000 }, finalisation: { requests: 1, outputTokens: 1500 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } };
  journal.accept(root, { runId, providerDate: null });
  const capacity = new CodingCapacity(runId, root, { workingRequests: 64 }, journal);
  const grant = (): BudgetGrant => ({ ...root, id: randomUUID(), finalisation: { requests: 0, outputTokens: 0 } });
  return { database, journal, root, runId, capacity, grant };
}
const used = { requests: 16, toolCalls: 16, writes: 0, runs: 0 };
describe("NIV-60 capacity reply fencing", () => {
  for (const phase of ["cancelled", "submitted", "finalising"] as const) it(`a delayed reply after ${phase} cannot restart work`, async () => {
    const f = fixture();
    try {
      const waiting = f.capacity.ensure(used, undefined, 1000);
      const pending = f.capacity.pending()!;
      assert.equal(pending.need, 1);
      f.capacity.finish(phase);
      assert.equal(await waiting, false);
      assert.equal(f.capacity.reply(pending.need, f.grant(), null), false);
      assert.equal(f.capacity.pending(), null);
      assert.equal(f.capacity.limits().requests, 16);
      assert.equal(await f.capacity.ensure(used, undefined, 1000), false);
      assert.equal(f.database.open().prepare("SELECT count(*) n FROM budget_accepted").get()!["n"], 1);
    } finally { f.database.close(); }
  });

  it("admits one matching extension and seals every accepted grant with the terminal transition", async () => {
    const f = fixture();
    try {
      const waiting = f.capacity.ensure(used, undefined, 1000); const grant = f.grant();
      assert.equal(f.capacity.reply(2, grant, null), false);
      assert.equal(f.capacity.reply(1, grant, null), true);
      assert.equal(await waiting, true);
      assert.equal(f.capacity.reply(1, grant, null), false);
      assert.equal(f.capacity.limits().requests, 32);
      f.journal.endWith(f.root.id, () => true);
      assert.equal(f.database.open().prepare("SELECT count(*) n FROM budget_seals WHERE kind = 'complete'").get()!["n"], 2);
    } finally { f.database.close(); }
  });

  it("does not credit an old extension again for a new need", async () => {
    const f = fixture();
    try {
      const first = f.capacity.ensure(used, undefined, 1000); const grant = f.grant();
      assert.equal(f.capacity.reply(1, grant, null), true); assert.equal(await first, true);
      const second = f.capacity.ensure({ ...used, requests: 32 }, undefined, 1000);
      assert.throws(() => f.capacity.reply(2, grant, null), /already answered/);
      assert.equal(f.capacity.limits().requests, 32);
      f.capacity.finish("finalising"); assert.equal(await second, false);
    } finally { f.database.close(); }
  });

  it("cancellation while waiting fences a later reply", async () => {
    const f = fixture(); const cancel = new AbortController();
    try {
      const waiting = f.capacity.ensure(used, cancel.signal, 1000);
      cancel.abort(); assert.equal(await waiting, false);
      assert.equal(f.capacity.reply(1, f.grant(), null), false);
    } finally { f.database.close(); }
  });

  it("host loss leaves the final hand-in available and refuses a late extension", async () => {
    const f = fixture();
    try {
      assert.equal(await f.capacity.ensure(used, undefined, 5), false);
      assert.equal(f.capacity.reply(1, f.grant(), null), false);
      const opened = f.journal.open(f.root.id, { kind: "model-request", part: "finalisation", model: "model", seat: null, instructionsSha256: null, outputTokens: 1500, boundUnits: null });
      assert.equal("refused" in opened, false);
      assert.match(f.capacity.reason!, /host did not admit/);
    } finally { f.database.close(); }
  });
});
