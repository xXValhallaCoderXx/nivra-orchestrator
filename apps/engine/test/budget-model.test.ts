import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { priceUsage, requestBound, type BudgetGrant, type ModelRate } from "@nivra/domain";
import { BudgetJournal } from "../src/budget/journal.ts";
import { Database } from "../src/db/database.ts";
import { createModelClient, ModelFailure, type CallOptions } from "../src/providers/model.ts";
import { startStub, text } from "./stub-token-factory.ts";

/**
 * ModelClient under a budget grant (NIV-66): every request is journalled at its real send point, with the output cap
 * it actually carries; one its grant has no room for is never sent and fails in Nivra's words; and each row is closed
 * from the usage that came back, or unknown at its bound when none did. Nothing is ever sent again (D22).
 */

const dirs: string[] = [];
const open: Database[] = [];
after(() => {
  for (const database of open) database.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const RATE: ModelRate = {
  model: SUPER,
  inputMicrosPerMillion: 300_000,
  cachedInputMicrosPerMillion: 60_000,
  outputMicrosPerMillion: 900_000,
  bounds: { inputTokens: 128_000, outputCappedByMaxTokens: true, source: "test", establishedOn: "2026-10-28" },
};
const CAP = 200;
const BOUND = requestBound(RATE, CAP)!.micros;

type Generated = { content: unknown[]; finishReason: string; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }; warnings: unknown[] };
const answer = (usage: Generated["usage"]): Generated => ({ content: [{ type: "text", text: "Done." }], finishReason: "stop", usage, warnings: [] });
const apiError = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { name: "AI_APICallError", statusCode, isRetryable: true });

function harness(over: Partial<BudgetGrant>, doGenerate: (options: unknown) => Promise<Generated>) {
  const dir = mkdtempSync(join(tmpdir(), "nivra budget model ü "));
  dirs.push(dir);
  const database = new Database(join(dir, "nivra.db"));
  open.push(database);
  const journal = new BudgetJournal(database, randomUUID());
  const grant: BudgetGrant = {
    id: randomUUID(),
    requestId: randomUUID(),
    catalogueVersion: "test-established-1",
    rates: [RATE],
    models: [SUPER],
    productiveMicros: 2 * BOUND,
    finalisationMicros: requestBound(RATE, 100)!.micros,
    productive: { requests: 2, outputTokens: CAP },
    finalisation: { requests: 1, outputTokens: 100 },
    allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 },
    ...over,
  };
  journal.accept(grant, { runId: randomUUID(), providerDate: null });
  const model = new MastraLanguageModelV2Mock({ modelId: SUPER, doGenerate: doGenerate as never });
  const client = createModelClient({ apiKey: "test-key-0123456789", model: () => model, budget: { journal, grantId: grant.id, seat: "worker" } });
  const agent = client.agent({ id: "test", name: "Test", modelId: SUPER, instructions: "Answer briefly.", tools: {} });
  const call = (options: Partial<CallOptions> = {}) => client.call(agent, "Hello", { maxSteps: 3, deadlines: { stepMs: 5_000, totalMs: 10_000 }, maxOutputTokens: CAP, ...options });
  const parts = () => database.open().prepare("SELECT part FROM budget_journal WHERE grant_id = ? ORDER BY seq").all(grant.id).map((row) => String(row["part"]));
  return { model, call, journal, grant, parts };
}

describe("ModelClient under a budget grant", () => {
  it("journals a request at its send point with the cap it carried and the instructions' digest, and closes it from its usage", async () => {
    const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: 4 };
    const { call, journal, grant, model } = harness({}, async () => answer(usage));
    await call();
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(model.doGenerateCalls[0]!.maxOutputTokens, CAP);
    const [row] = journal.read(grant.id).rows;
    assert.deepEqual([row!.state, row!.model, row!.seat, row!.boundMicros], ["reported", SUPER, "worker", BOUND]);
    assert.equal(row!.amountMicros, priceUsage(RATE, { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 })!.micros);
    assert.match(row!.instructionsSha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("closes an answer whose cached input wasn't reported as partial, and one with no output count as unknown at its bound", async () => {
    let n = 0;
    const { call, journal, grant } = harness({}, async () => (n++ === 0 ? answer({ inputTokens: 10, outputTokens: 3, totalTokens: 13 }) : answer({ inputTokens: 10 })));
    await call();
    await call().catch(() => undefined);
    assert.deepEqual(journal.read(grant.id).rows.map((row) => [row.state, row.amountMicros]), [
      ["partial", priceUsage(RATE, { inputTokens: 10, cachedInputTokens: null, outputTokens: 3 })!.micros],
      ["unknown", BOUND],
    ]);
  });

  it("counts reasoning inside the output it was billed in, once, and keeps the whole bound when the counts contradict each other", async () => {
    // A reasoning model's answer: 600 output tokens, 400 of them reasoning, as an OpenAI-compatible provider reports them.
    let n = 0;
    const { call, journal, grant } = harness({}, async () =>
      n++ === 0
        ? answer({ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 600, reasoningTokens: 400, totalTokens: 1_600 })
        : answer({ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 200, reasoningTokens: 400, totalTokens: 1_200 }),
    );
    await call();
    await call().catch(() => undefined);
    const rows = journal.read(grant.id).rows;
    assert.deepEqual(rows.map((row) => [row.state, row.usage?.outputTokens ?? null]), [["reported", 600], ["unknown", null]]);
    // Exactly what the host's ledger will work out again from the row: 1,000 input and 600 output, nothing more or less.
    assert.equal(rows[0]!.amountMicros, priceUsage(RATE, { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 600 })!.micros);
    assert.equal(rows[0]!.amountMicros, 300 + 540);
    assert.equal(rows[1]!.amountMicros, BOUND);
  });

  it("never sends a request its grant has no room for, and fails the call in Nivra's words", async () => {
    const { call, journal, grant, model } = harness({ productiveMicros: BOUND - 1 }, async () => answer({ inputTokens: 10, outputTokens: 3 }));
    await assert.rejects(call(), (error: unknown) => error instanceof ModelFailure && error.kind === "budget-exhausted" && /budget grant has no room/.test(error.message));
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(journal.read(grant.id).rows.length, 0);
  });

  it("closes a request that failed with no usage as unknown at its bound, and never sends it again", async () => {
    const { call, journal, grant, model } = harness({}, async () => {
      throw apiError(503);
    });
    await assert.rejects(call(), ModelFailure);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.deepEqual(journal.read(grant.id).rows.map((row) => [row.state, row.amountMicros]), [["unknown", BOUND]]);
  });

  it("draws a step on the part it names, its own cap included, and keeps the part from Mastra", async () => {
    const { call, journal, grant, parts, model } = harness({}, async () => answer({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 }));
    await call({ prepareStep: () => ({ budgetPart: "finalisation", maxOutputTokens: 100 }) });
    assert.deepEqual(parts(), ["finalisation"]);
    assert.equal(model.doGenerateCalls[0]!.maxOutputTokens, 100);
    assert.equal(journal.read(grant.id).rows[0]!.boundMicros, requestBound(RATE, 100)!.micros);
    await call({ budgetPart: "finalisation" }).catch(() => undefined);
    assert.equal(journal.read(grant.id).rows.length, 1, "the finalisation part allows one request");
  });
});


describe("unpriced finite request grant", () => {
  it("refuses a larger cap before the transport is called", async () => {
    const { call, model, journal, grant } = harness({ productiveMicros: null, finalisationMicros: null, rates: [] }, async () => answer({ inputTokens: 5, outputTokens: 2 }));
    await assert.rejects(call({ maxOutputTokens: CAP + 1 }), (error: unknown) => error instanceof ModelFailure && error.kind === "budget-exhausted");
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(journal.read(grant.id).rows.length, 0);
    await call();
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(journal.read(grant.id).rows[0]?.usage?.inputTokens, 5);
  });
});


describe("model listings under a finite grant", () => {
  it("journals the listing, keeps provider time, and refuses a second listing before transport", async () => {
    const { journal, grant } = harness({ productiveMicros: null, finalisationMicros: null, rates: [], modelListings: 1 }, async () => answer({ inputTokens: 1, outputTokens: 1 }));
    let requests = 0;
    const client = createModelClient({ apiKey: "test-key-0123456789", budget: { journal, grantId: grant.id, seat: "companion" }, fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ data: [{ id: SUPER }] }), { headers: { date: "Wed, 28 Oct 2026 01:00:00 GMT" } });
    } });
    const models = await client.listModels();
    assert.equal(models.ids.length, 1);
    assert.equal(requests, 1);
    const rows = journal.read(grant.id).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]?.kind, rows[0]?.state], ["model-listing", "unknown"]);
    assert.equal(journal.providerDate(grant.id), "Wed, 28 Oct 2026 01:00:00 GMT");
    await assert.rejects(client.listModels(), (error: unknown) => error instanceof ModelFailure && error.kind === "budget-exhausted");
    assert.equal(requests, 1);
  });
});


describe("real provider usage shape at the journal send point", () => {
  it("keeps nested provider token totals, cached input and reasoning counted once", async () => {
    const reply = text("Done.", { tokens: [20, 7] });
    const body = reply.body as { usage: Record<string, unknown> };
    body.usage["prompt_tokens_details"] = { cached_tokens: 4 };
    body.usage["completion_tokens_details"] = { reasoning_tokens: 3 };
    const stub = await startStub({ chat: () => reply });
    try {
      const { journal, grant } = harness({}, async () => answer({}));
      const client = createModelClient({ apiKey: "test-key-0123456789", endpoint: { url: stub.url, kind: "loopback-test" }, budget: { journal, grantId: grant.id, seat: "companion" } });
      const agent = client.agent({ id: "test-provider", name: "Provider accounting test", modelId: SUPER, instructions: "Answer briefly.", tools: {} });
      await client.call(agent, "Hello", { maxSteps: 1, maxOutputTokens: CAP, deadlines: { stepMs: 5_000, totalMs: 10_000 } });
      assert.equal(stub.chats().length, 1);
      const rows = journal.read(grant.id).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]?.usage, { inputTokens: 20, cachedInputTokens: 4, outputTokens: 7 });
      assert.equal(rows[0]?.amountMicros, priceUsage(RATE, { inputTokens: 20, cachedInputTokens: 4, outputTokens: 7 })!.micros);
    } finally { await stub.close(); }
  });
});
