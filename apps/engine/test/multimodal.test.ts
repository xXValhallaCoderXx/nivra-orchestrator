import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { checkReferences, isTerminal, VISUAL_MODEL, type BudgetGrant, type CompanionContext, type PlanningContext } from "@nivra/domain";
import { BudgetJournal } from "../src/budget/journal.ts";
import { Database } from "../src/db/database.ts";
import { createModelClient } from "../src/providers/model.ts";
import { referenceModel, referencePrompt } from "../src/providers/reference-content.ts";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { referenceFixture } from "./reference-fixture.ts";
import { startStub, text, toolCall, type Stub, type StubRequest } from "./stub-token-factory.ts";
import { cleanUp, repoWith } from "./workspace-fixtures.ts";

const roots: string[] = [], engines: EngineProcess[] = [], stubs: Stub[] = [], databases: Database[] = [];
after(async () => { for (const engine of engines) engine.kill(); await Promise.all(engines.map((engine) => engine.exited)); await Promise.all(stubs.map((stub) => stub.close())); for (const db of databases) db.close(); for (const root of roots) removeDir(root); cleanUp(); });
function grant(requestId: string, productive = 2, finalCap = 1500): BudgetGrant { return { id: randomUUID(), requestId, catalogueVersion: "test", models: [VISUAL_MODEL], modelListings: 1, rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: productive, outputTokens: 8000 }, finalisation: { requests: 1, outputTokens: finalCap }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } }; }
function imageCount(request: StubRequest, expected: string): number {
  const messages = request.body?.messages as Array<{ content: string | Array<{ type: string; image_url?: { url: string } }> }>;
  return messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === "image_url" && part.image_url?.url === expected).length;
}
async function engineWith(stub: Stub) {
  const home = tempDir("nivra image engine"); roots.push(home);
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", stub.url] }); engines.push(engine);
  await engine.initialize({ NEBIUS_API_KEY: "test-nebius-key-1234567890" });
  return { engine, home };
}
function privateFiles(root: string): string[] { return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? privateFiles(join(root, entry.name)) : [join(root, entry.name)]); }
describe("actual image content through the installed Mastra and Nebius transport", () => {
  it("sends exact text/image HTTP parts on every tool round and finalisation, and reconciles reported totals once", async () => {
    const references = await referenceFixture(), image = `data:image/png;base64,${references.attachments[0]!.image!.base64}`;
    const stub = await startStub({ models: [{ id: VISUAL_MODEL }], chat: (_request, index) => index < 2 ? toolCall("read", {}) : text("Finished", { tokens: [77, 5] }) }); stubs.push(stub);
    const root = tempDir("nivra image journal"); roots.push(root); const db = new Database(join(root, "nivra.db")); databases.push(db);
    const journal = new BudgetJournal(db, randomUUID()), budget = grant(randomUUID()); journal.accept(budget, { runId: randomUUID(), providerDate: null });
    const client = createModelClient({ apiKey: "test", endpoint: { url: stub.url, kind: "loopback-test" }, budget: { journal, grantId: budget.id, models: budget.models, seat: "coding-worker" } });
    await client.listModels(); const tools = { read: createTool({ id: "read", description: "Read one fact", inputSchema: z.strictObject({}), execute: async () => ({ fact: "Read result" }) }) };
    const agent = client.agent({ id: "image", name: "Image content test", modelId: VISUAL_MODEL, instructions: "Use read twice, then hand in.", tools });
    await client.call(agent, referencePrompt("Requested task", references), { maxSteps: 3, maxOutputTokens: 8000, deadlines: { stepMs: 5000, totalMs: 15000 }, prepareStep: ({ stepNumber }) => stepNumber === 2 ? { maxOutputTokens: 1500, budgetPart: "finalisation", activeTools: [] } : undefined });
    assert.equal(stub.chats().length, 3);
    assert.deepEqual(stub.chats().map((request) => imageCount(request, image)), [1,1,1]);
    assert.deepEqual(stub.chats().map((request) => request.body?.["max_completion_tokens"]), [8000,8000,1500]);
    for (const request of stub.chats()) assert.equal(request.raw.includes(references.comments[0]!.text), true);
    const rows = journal.read(budget.id).rows.filter((row) => row.kind === "model-request");
    assert.deepEqual(db.open().prepare("SELECT part FROM budget_journal WHERE grant_id=? AND kind='model-request' ORDER BY seq").all(budget.id).map((row) => String(row["part"])), ["productive","productive","finalisation"]);
    assert.deepEqual(rows.map((row) => row.usage?.inputTokens), [20,20,77]);
    await assert.rejects(client.call(agent, referencePrompt("Again", references), { maxSteps: 1, maxOutputTokens: 1500, budgetPart: "finalisation", deadlines: { stepMs: 5000, totalMs: 5000 } }), /budget|grant|requests/i);
    assert.equal(stub.chats().length, 3);
  });
  it("refuses absent and uncovered visual routes without sending a substitute", async () => {
    const references = await referenceFixture();
    assert.throws(() => referenceModel(["nvidia/text"], ["nvidia/text"], references), /Selected images require/);
    assert.throws(() => referenceModel([VISUAL_MODEL], ["nvidia/text"], references), /Selected images require/);
    const stub = await startStub(); stubs.push(stub);
    const client = createModelClient({ apiKey: "test", endpoint: { url: stub.url, kind: "loopback-test" } });
    const agent = client.agent({ id: "text", name: "Text", modelId: "nvidia/text", instructions: "Text", tools: {} });
    await assert.rejects(client.call(agent, referencePrompt("Task", references), { maxSteps: 1, maxOutputTokens: 10, deadlines: { stepMs: 1000, totalMs: 1000 } }), /visual task model/);
    assert.equal(stub.requests.length, 0);
    const changed = structuredClone(references); changed.comments[0]!.text = "Changed"; assert.equal(await checkReferences(changed), false);
  });
  it("uses frozen image context in task Companion over real stdio without keeping source content in engine files", async () => {
    const references = await referenceFixture(`private-comment-${randomUUID()}`);
    const stub = await startStub({ models: [{ id: VISUAL_MODEL }], chat: () => text(JSON.stringify({ reply: "Review the supporting reference.", actions: [], captures: [] }), { tokens: null }) }); stubs.push(stub);
    const { engine, home } = await engineWith(stub), requestId = randomUUID();
    const budget = { ...grant(requestId, 1), productive: { requests: 1, outputTokens: 4000 }, finalisation: { requests: 0, outputTokens: 0 } };
    const context: CompanionContext = { preferences: { revision: 0, records: [] }, sharing: { modelContext: true }, snapshot: "Task scope", message: "Consider the reference image", history: [], references };
    const run = await engine.client.call("runs.start", { clientRequestId: requestId, workflowId: "companion", input: { sessionId: randomUUID(), bindingDigest: references.digest }, context, budget });
    await engine.waitForRun(run.id, (page) => isTerminal(page.status), 30_000);
    assert.equal((await engine.client.call("runs.get", { runId: run.id })).status, "succeeded");
    assert.equal(imageCount(stub.chats()[0]!, `data:image/png;base64,${references.attachments[0]!.image!.base64}`), 1);
    const journal = await engine.client.call("budget.journal", { grantId: budget.id, after: 0, limit: 200 });
    assert.equal(journal.seal?.kind, "complete"); assert.equal(journal.rows.find((row) => row.kind === "model-request")?.usage?.inputTokens ?? null, null);
    assert.equal(privateFiles(home).some((path) => readFileSync(path).includes(references.comments[0]!.text)), false);
    assert.equal(engine.stderr().includes(references.comments[0]!.text), false);
  });
  it("carries the selected image through repository planning passes and its reserved final answer", async () => {
    const references = await referenceFixture(), repository = repoWith({ "note.md": "A bounded source fact\n" });
    const proposal = { summary: "One planned task", challenges: [], decisions: [], uncertainties: [], questions: [], deferred: [], inspection: "provisional", inspectionScope: "One file", gaps: [], impacts: [], items: [] };
    const stub = await startStub({ models: [{ id: VISUAL_MODEL, context_length: 131072 }], chat: (_request, index) => index < 2 ? toolCall("read_file", { path: "note.md" }) : toolCall("submit_plan", proposal) }); stubs.push(stub);
    const { engine, home } = await engineWith(stub), requestId = randomUUID(), projectId = randomUUID(), operationId = requestId;
    const context: PlanningContext = { brief: { title: "Small plan", outcome: "Understand the file", intendedUsers: "Me", scope: "One file", exclusions: "", constraints: [], decisions: [], uncertainties: [], questions: [] }, snapshot: "{}", preferences: { revision: 0, records: [] }, projectId, sharingEpoch: 0, repository: { repoPath: repository, projectId, sharingEpoch: 0 }, references, maxRequests: 3 };
    const budget = grant(requestId, 2, 8000);
    const run = await engine.client.call("runs.start", { clientRequestId: requestId, workflowId: "planning", input: { planningId: randomUUID(), operationId, revision: 1, bindingDigest: references.digest }, context, budget });
    for (let request = 1; request <= 3; request++) {
      await waitFor(async () => (await engine.client.call("planning.pending", { runId: run.id, operationId })).request === request || null, { what: "planning authorisation" });
      await engine.client.call("planning.authorize", { runId: run.id, operationId, request, sharingEpoch: 0 });
    }
    await engine.waitForRun(run.id, (page) => isTerminal(page.status), 30_000);
    assert.equal((await engine.client.call("runs.get", { runId: run.id })).status, "succeeded");
    assert.equal(stub.chats().length, 3); assert.deepEqual(stub.chats().map((request) => imageCount(request, `data:image/png;base64,${references.attachments[0]!.image!.base64}`)), [1,1,1]);
    const journal = await engine.client.call("budget.journal", { grantId: budget.id, after: 0, limit: 200 }); assert.equal(journal.seal?.kind, "complete");
    engine.kill(); await engine.exited;
    const recorded = new Database(join(home, "nivra.db")); databases.push(recorded);
    assert.deepEqual(recorded.open().prepare("SELECT part FROM budget_journal WHERE grant_id=? AND kind='model-request' ORDER BY seq").all(budget.id).map((row) => String(row["part"])), ["productive","productive","finalisation"]);
  });
  it("rechecks frozen reference text against newly saved credentials before another planning request", async () => {
    const comment = `newly-saved-private-value-${randomUUID()}`, references = await referenceFixture(comment), repository = repoWith({ "note.md": "One source fact\n" });
    const stub = await startStub({ models: [{ id: VISUAL_MODEL, context_length: 131072 }], chat: () => toolCall("read_file", { path: "note.md" }) }); stubs.push(stub);
    const { engine } = await engineWith(stub), requestId = randomUUID(), projectId = randomUUID();
    const context: PlanningContext = { brief: { title: "Small plan", outcome: "Understand the file", intendedUsers: "Me", scope: "One file", exclusions: "", constraints: [], decisions: [], uncertainties: [], questions: [] }, snapshot: "{}", preferences: { revision: 0, records: [] }, projectId, sharingEpoch: 0, repository: { repoPath: repository, projectId, sharingEpoch: 0 }, references, maxRequests: 3 };
    const budget = grant(requestId, 2, 8000);
    const run = await engine.client.call("runs.start", { clientRequestId: requestId, workflowId: "planning", input: { planningId: randomUUID(), operationId: requestId, revision: 1, bindingDigest: references.digest }, context, budget });
    for (let request = 1; request <= 2; request++) {
      await waitFor(async () => (await engine.client.call("planning.pending", { runId: run.id, operationId: requestId })).request === request || null, { what: "planning credential recheck" });
      if (request === 2) await engine.client.call("secrets.update", { set: { TAVILY_API_KEY: comment }, remove: [] });
      await engine.client.call("planning.authorize", { runId: run.id, operationId: requestId, request, sharingEpoch: 0 });
    }
    await engine.waitForRun(run.id, (page) => isTerminal(page.status), 30_000);
    assert.equal((await engine.client.call("runs.get", { runId: run.id })).status, "failed");
    assert.equal(stub.chats().length, 1);
    const journal = await engine.client.call("budget.journal", { grantId: budget.id, after: 0, limit: 200 });
    assert.equal(journal.seal?.kind, "complete"); assert.equal(journal.rows.filter((row) => row.kind === "model-request").length, 1);
  });
});
