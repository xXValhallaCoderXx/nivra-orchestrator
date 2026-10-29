import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isTerminal, type BudgetGrant, type CompanionContext, type CompanionResult } from "@nivra/domain";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { httpError, startStub, text, toolCall, type Reply, type Stub } from "./stub-token-factory.ts";

const MODEL = "nvidia/Nemotron-3.5-Super-VL";
const KEY = "test-key-0123456789abcdef";
const dirs: string[] = [];
const engines: EngineProcess[] = [];
const stubs: Stub[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all(engines.map((engine) => engine.exited));
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}
async function open(url: string, home?: string) {
  const root = tempDir("nivra companion"); dirs.push(root);
  const at = home ?? join(root, "home");
  const engine = startEngine(at, { args: ["--stdio", "--home", at, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", url] });
  engines.push(engine);
  await engine.initialize({ NEBIUS_API_KEY: KEY });
  return { engine, home: at };
}
async function setup(reply: () => Reply) {
  const stub = await startStub({ models: [{ id: MODEL, context_length: 131_072 }], chat: reply }); stubs.push(stub);
  return { stub, ...await open(stub.url) };
}
function request(mark: string, sessionId = randomUUID()) {
  const clientRequestId = randomUUID();
  const budget: BudgetGrant = { id: randomUUID(), requestId: clientRequestId, models: [MODEL], modelListings: 1, catalogueVersion: "test-unpriced", rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: 1, outputTokens: 4_000 }, finalisation: { requests: 0, outputTokens: 0 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } };
  const context: CompanionContext = { preferences: { revision: 0, records: [] }, sharing: { modelContext: false }, message: `Help me plan ${mark}`, history: [{ role: "user", text: `Previous ${mark}` }, { role: "assistant", text: `Earlier reply ${mark}` }], snapshot: JSON.stringify({ mission: { outcome: `My idea ${mark}` } }) };
  return { clientRequestId, workflowId: "companion" as const, input: { sessionId, bindingDigest: "a".repeat(64) }, context, budget };
}
const finished = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
function noStoredText(home: string, engine: EngineProcess, markers: string[]) {
  const leaked = files(home).filter((file) => markers.some((marker) => readFileSync(file).includes(marker))).map((file) => file.slice(home.length));
  assert.deepEqual(leaked, [], "no companion content in SQLite, WAL, Mastra, artefacts or engine files");
  assert.equal(markers.some((marker) => engine.stderr().includes(marker)), false, "no companion text in logs");
}

describe("temporary companion over real stdio", () => {
  it("returns one bounded structured reply, acknowledges it, and persists no transcript", async () => {
    const prompt = `companion-prompt-${randomUUID()}`;
    const response = `companion-reply-${randomUUID()}`;
    const outcome: CompanionResult = { reply: `Save a brief first ${response}`, actions: [{ kind: "draft-mission", title: "Timer", outcome: "Keep time" }], captures: [] };
    const { engine, home, stub } = await setup(() => text(JSON.stringify(outcome)));
    const inspected = await engine.client.call("repository.inspect", { repoPath: join(home, "absent") });
    assert.equal(inspected.folder, "missing");
    assert.equal(stub.chats().length, 0);
    const given = request(prompt);
    const run = await engine.client.call("runs.start", given);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((event) => event.message).join(" | "));
    assert.equal(stub.chats().length, 1);
    assert.equal(JSON.stringify(stub.chats()[0]?.body?.messages).includes(prompt), true);
    assert.deepEqual(await engine.client.call("companion.result", { runId: run.id, sessionId: given.input.sessionId }), outcome);
    await assert.rejects(engine.client.call("companion.result", { runId: run.id, sessionId: randomUUID() }));
    const journal = await engine.client.call("budget.journal", { grantId: given.budget.id });
    assert.deepEqual([journal.seal?.kind, journal.rows.filter((row) => row.kind === "model-request").length], ["complete", 1]);
    assert.equal(journal.rows.filter((row) => row.kind === "model-listing").length, 1);
    await engine.client.call("companion.ack", { runId: run.id, sessionId: given.input.sessionId });
    assert.equal(await engine.client.call("companion.result", { runId: run.id, sessionId: given.input.sessionId }), null);
    assert.equal((await engine.client.call("runs.start", given)).id, run.id);
    assert.equal(stub.chats().length, 1);
    assert.equal(JSON.stringify(page.events).includes(prompt), false);
    assert.equal(JSON.stringify(page.events).includes(response), false);
    await engine.client.call("shutdown", {}); await engine.exited;
    noStoredText(home, engine, [prompt, response]);
    const restarted = await open(stub.url, home);
    assert.equal(await restarted.engine.client.call("companion.result", { runId: run.id, sessionId: given.input.sessionId }), null);
    assert.equal(stub.chats().length, 1);
  });

  it("drops provider error text, does not retry, and still accounts for its attempted inference", async () => {
    const marker = `companion-error-${randomUUID()}`;
    const { engine, home, stub } = await setup(() => httpError(500, marker));
    const given = request(marker);
    const run = await engine.client.call("runs.start", given);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "failed");
    assert.equal(stub.chats().length, 1);
    const journal = await engine.client.call("budget.journal", { grantId: given.budget.id });
    const rows = journal.rows.filter((row) => row.kind === "model-request");
    assert.deepEqual([journal.seal?.kind, rows.length, rows[0]?.state], ["complete", 1, "unknown"]);
    assert.equal(await engine.client.call("companion.result", { runId: run.id, sessionId: given.input.sessionId }), null);
    await engine.client.call("shutdown", {}); await engine.exited;
    noStoredText(home, engine, [marker]);
  });

  it("refuses a missing grant and a malformed reply without persisting text or retrying", async () => {
    const marker = `companion-malformed-${randomUUID()}`;
    const { engine, home, stub } = await setup(() => text(marker));
    const given = request(marker);
    const { budget: _budget, ...noGrant } = given;
    await assert.rejects(engine.client.call("runs.start", noGrant as typeof given));
    assert.equal((await engine.client.call("runs.list", { limit: 10 })).runs.length, 0);
    assert.equal(stub.chats().length, 0);
    const run = await engine.client.call("runs.start", given);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "failed");
    assert.equal(stub.chats().length, 1);
    assert.equal(await engine.client.call("companion.result", { runId: run.id, sessionId: given.input.sessionId }), null);
    await engine.client.call("shutdown", {}); await engine.exited;
    noStoredText(home, engine, [marker]);
  });

  it("does not retain a hostile model's transcript-shaped tool name", async () => {
    const marker = `companion-tool-${randomUUID()}`;
    const { engine, home, stub } = await setup(() => toolCall(marker, { content: marker }));
    const given = request(marker);
    const run = await engine.client.call("runs.start", given);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "failed");
    assert.equal(stub.chats().length, 1);
    assert.equal(JSON.stringify(page.events).includes(marker), false);
    await engine.client.call("shutdown", {}); await engine.exited;
    noStoredText(home, engine, [marker]);
  });

  it("ends a session during a call, clears late output and never reuses that session", async () => {
    const marker = `companion-cancel-${randomUUID()}`;
    const { engine, home, stub } = await setup(() => ({ ...text(JSON.stringify({ reply: marker, actions: [], captures: [] })), delayMs: 1_000 }));
    const given = request(marker);
    const run = await engine.client.call("runs.start", given);
    await waitFor(() => stub.chats().length === 1, { what: "the requested inference" });
    await engine.client.call("companion.end", { sessionId: given.input.sessionId });
    const page = await finished(engine, run.id);
    assert.equal(page.status, "cancelled");
    assert.equal(await engine.client.call("companion.result", { runId: run.id, sessionId: given.input.sessionId }), null);
    await assert.rejects(engine.client.call("runs.start", request(marker, given.input.sessionId)));
    assert.equal(stub.chats().length, 1);
    await engine.client.call("shutdown", {}); await engine.exited;
    noStoredText(home, engine, [marker]);
  });

  it("interrupts a killed turn, retains its bound, and never replays paid work", async () => {
    const marker = `companion-crash-${randomUUID()}`;
    const { engine, home, stub } = await setup(() => ({ ...text(JSON.stringify({ reply: marker, actions: [], captures: [] })), delayMs: 1_000 }));
    const given = request(marker);
    const run = await engine.client.call("runs.start", given);
    await waitFor(() => stub.chats().length === 1, { what: "the requested inference" });
    engine.kill(); await engine.exited;
    const restarted = await open(stub.url, home);
    const found = await restarted.engine.client.call("runs.find", { clientRequestId: given.clientRequestId });
    assert.deepEqual([found?.id, found?.status], [run.id, "failed"]);
    const journal = await restarted.engine.client.call("budget.journal", { grantId: given.budget.id });
    assert.equal(journal.seal?.kind, "interrupted");
    assert.equal(journal.rows.filter((row) => row.kind === "model-request")[0]?.state, "unknown");
    assert.equal((await restarted.engine.client.call("runs.start", given)).id, run.id);
    assert.equal(stub.chats().length, 1);
    assert.equal(await restarted.engine.client.call("companion.result", { runId: run.id, sessionId: given.input.sessionId }), null);
    await restarted.engine.client.call("shutdown", {}); await restarted.engine.exited;
    noStoredText(home, restarted.engine, [marker]);
  });
});
