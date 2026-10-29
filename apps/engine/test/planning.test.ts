import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isTerminal, type BudgetGrant, type PlanningContext, type PlanningProposal } from "@nivra/domain";
import { makeRepo, removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { httpError, startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";
import { PlanningAuthorisation } from "../src/planning/authorisation.ts";

const MODEL = "nvidia/Nemotron-3.5-Super-VL";
const KEY = "test-planning-key-0123456789abcdef";
const dirs: string[] = [];
const engines: EngineProcess[] = [];
const stubs: Stub[] = [];
after(async () => { for (const engine of engines) engine.kill(); await Promise.all(engines.map((engine) => engine.exited)); await Promise.all(stubs.map((stub) => stub.close())); for (const dir of dirs) removeDir(dir); });
function files(root: string): string[] { return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]); }
async function open(url: string, home?: string) {
  const root = tempDir("nivra planning"); dirs.push(root);
  const at = home ?? join(root, "home");
  const engine = startEngine(at, { args: ["--stdio", "--home", at, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", url] }); engines.push(engine);
  await engine.initialize({ NEBIUS_API_KEY: KEY });
  return { engine, home: at, root };
}
async function setup(reply: (index: number, request: StubRequest) => Reply) {
  const stub = await startStub({ models: [{ id: MODEL, context_length: 131_072 }], chat: (request, index) => reply(index, request) }); stubs.push(stub);
  return { stub, ...await open(stub.url) };
}
function proposal(mark = "useful outcome"): PlanningProposal {
  return { summary: mark, challenges: [], decisions: [], uncertainties: [], questions: [], deferred: [], inspection: "greenfield", inspectionScope: "The explicit brief and permitted native records", gaps: [], impacts: [{ id: "impact1", area: "Record and reopen", effect: "The new flow needs durable local records", relationship: "direct", evidence: "inferred", citations: [], validation: ["Reopen the saved record"] }], items: [{ id: "task1", title: "Record and reopen", goal: "Retain the first record", scope: "One record", exclusions: "Sync", acceptanceCriteria: ["The record can be reopened"], impactIds: ["impact1"], prerequisites: [], overlapTaskIds: [], questions: [] }] };
}
function request(mark: string, repository: PlanningContext["repository"] = null, count = 1) {
  const operationId = randomUUID();
  const budget: BudgetGrant = { id: randomUUID(), requestId: operationId, models: [MODEL], modelListings: 1, catalogueVersion: "test-unpriced", rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: count - 1, outputTokens: 8_000 }, finalisation: { requests: 1, outputTokens: 8_000 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } };
  const context: PlanningContext = { brief: { title: "An idea", outcome: mark, intendedUsers: "Me", scope: "First useful increment", exclusions: "Sync", constraints: [], decisions: [], uncertainties: [], questions: [] }, snapshot: "{}", preferences: { revision: 0, records: [] }, repository, maxRequests: count };
  return { clientRequestId: operationId, workflowId: "planning" as const, input: { planningId: randomUUID(), operationId, revision: 1, bindingDigest: "a".repeat(64) }, context, budget };
}
const finished = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
async function permit(engine: EngineProcess, runId: string, operationId: string, expected: number, epoch: number) {
  const pending = await waitFor(async () => { const found = await engine.client.call("planning.pending", { runId, operationId }); return found.request === expected ? found : null; }, { what: `planning authorisation ${expected}` });
  assert.equal(pending.sharingEpoch, epoch);
  await engine.client.call("planning.authorize", { runId, operationId, request: expected, sharingEpoch: epoch });
}
function noStored(home: string, engine: EngineProcess, markers: string[]) {
  assert.equal(files(home).some((file) => markers.some((marker) => readFileSync(file).includes(marker))), false, "no transient planning text in databases, WALs or artifacts");
  assert.equal(markers.some((marker) => engine.stderr().includes(marker)), false, "no transient planning text in diagnostics");
}

describe("one-use repository planning authorisation", () => {
  it("binds the exact request and epoch, consumes the permit once, and rejects cancellation", async () => {
    const gate = new PlanningAuthorisation();
    const controller = new AbortController();
    const first = gate.wait("run", "operation", 1, 4, controller.signal);
    assert.equal(gate.authorize("run", "operation", 1, 5), false);
    assert.equal(gate.authorize("run", "operation", 2, 4), false);
    assert.equal(gate.authorize("run", "operation", 1, 4), true);
    await first;
    assert.equal(gate.authorize("run", "operation", 1, 4), false);
    const second = gate.wait("run", "operation", 2, 4, controller.signal);
    gate.end("operation");
    await assert.rejects(second);
    assert.equal(gate.pending("run", "operation").request, null);
  });
});

describe("planning over real engine stdio with mocked inference", () => {
  it("hands off only a validated structured result, accounts once, and retains no transient content", async () => {
    const prompt = `planning-brief-${randomUUID()}`;
    const response = `planning-result-${randomUUID()}`;
    const expected = proposal(response);
    const { engine, home, stub } = await setup(() => toolCall("submit_plan", expected));
    const given = request(prompt);
    const run = await engine.client.call("runs.start", given);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((event) => event.message).join(" | "));
    const result = await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId });
    assert.equal(result?.proposal.summary, response);
    assert.equal(result?.proposal.inspection, "greenfield");
    assert.equal(stub.chats().length, 1);
    const journal = await engine.client.call("budget.journal", { grantId: given.budget.id });
    assert.deepEqual([journal.seal?.kind, journal.rows.filter((row) => row.kind === "model-request").length], ["complete", 1]);
    assert.equal(journal.rows.find((row) => row.kind === "model-request")?.seat, "planning");
    // The grant has zero productive requests: success establishes that the answer used its protected final capacity.
    assert.equal(given.budget.productive.requests, 0);
    assert.equal((await engine.client.call("runs.start", given)).id, run.id);
    await engine.client.call("planning.ack", { runId: run.id, operationId: given.input.operationId });
    assert.equal(await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId }), null);
    assert.equal(JSON.stringify(page.events).includes(prompt), false);
    assert.equal(JSON.stringify(page.events).includes(response), false);
    await engine.client.call("shutdown", {}); await engine.exited;
    noStored(home, engine, [prompt, response]);
    const restarted = await open(stub.url, home);
    assert.equal(await restarted.engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId }), null);
    assert.equal(stub.chats().length, 1);
  });

  it("waits for a fresh epoch permit for each read and final request, binds hashes, and detects an uncommitted change", async () => {
    const root = tempDir("planning source"); dirs.push(root);
    const repo = makeRepo(root); mkdirSync(join(repo, "src"));
    const source = "export const shared = 1;\n"; writeFileSync(join(repo, "src/shared.ts"), source);
    assert.equal(spawnSync("git", ["add", "src/shared.ts"], { cwd: repo }).status, 0);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const expected = proposal(); expected.inspection = "assessed";
    expected.impacts[0] = { ...expected.impacts[0]!, evidence: "repository", citations: [{ path: "src/shared.ts", startLine: 1, endLine: 1, sha256: createHash("sha256").update(source).digest("hex"), revision }] };
    const { engine, stub } = await setup((index) => index === 0 ? toolCall("read_file", { path: "src/shared.ts" }) : toolCall("submit_plan", expected));
    const given = request("Inspect the shared flow", { repoPath: repo, projectId: randomUUID(), sharingEpoch: 7 }, 2);
    const run = await engine.client.call("runs.start", given);
    await permit(engine, run.id, given.input.operationId, 1, 7);
    await waitFor(() => stub.chats().length === 1);
    await waitFor(async () => (await engine.client.call("planning.pending", { runId: run.id, operationId: given.input.operationId })).request === 2);
    assert.equal(stub.chats().length, 1, "no second inference without its own permit");
    await assert.rejects(engine.client.call("planning.authorize", { runId: run.id, operationId: given.input.operationId, request: 2, sharingEpoch: 8 }));
    await permit(engine, run.id, given.input.operationId, 2, 7);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((event) => event.message).join(" | "));
    const result = await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId });
    assert.equal(result?.evidence.files.length, 1);
    assert.match(result?.exploration ?? "", /at most 2/);
    assert.equal((await engine.client.call("planning.validateEvidence", { repoPath: repo, evidence: result!.evidence })).current, true);
    writeFileSync(join(repo, "src/shared.ts"), "export const shared = 2;\n");
    assert.equal((await engine.client.call("planning.validateEvidence", { repoPath: repo, evidence: result!.evidence })).current, false);
    const journal = await engine.client.call("budget.journal", { grantId: given.budget.id });
    // Each grant part admits only one request. Two successful requests establish productive exploration plus the answer.
    assert.equal(journal.rows.filter((row) => row.kind === "model-request").length, 2);
    assert.deepEqual([given.budget.productive.requests, given.budget.finalisation.requests], [1, 1]);
  });

  it("uses the last available request for a provisional final answer and no repository exploration", async () => {
    const expected = proposal(); expected.inspection = "assessed";
    const { engine, stub } = await setup(() => toolCall("submit_plan", expected));
    const given = request("Use existing records only", { repoPath: "/unavailable", projectId: randomUUID(), sharingEpoch: 2 }, 1);
    const run = await engine.client.call("runs.start", given);
    await permit(engine, run.id, given.input.operationId, 1, 2);
    assert.equal((await finished(engine, run.id)).status, "succeeded");
    const result = await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId });
    assert.equal(result?.proposal.inspection, "not-assessed");
    assert.match(result?.exploration ?? "", /reduced.*1 AI request/);
    assert.equal(stub.chats().length, 1);
  });

  it("keeps prose accompanying read tools exploratory, then accepts a text proposal spanning consecutive reads", async () => {
    const root = tempDir("planning exploratory prose"); dirs.push(root);
    const repo = makeRepo(root);
    const source = "export const first = 1;\nexport const shared = 2;\nexport const next = 3;\nexport const last = 4;\n";
    writeFileSync(join(repo, "shared.ts"), source);
    assert.equal(spawnSync("git", ["add", "shared.ts"], { cwd: repo }).status, 0);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const expected = proposal("A final proposal after inspection"); expected.inspection = "assessed";
    expected.impacts[0] = { ...expected.impacts[0]!, evidence: "repository", citations: [{ path: "shared.ts", startLine: 2, endLine: 3, sha256: createHash("sha256").update(source).digest("hex"), revision }] };
    const exploratory = [
      ["list_files", {}],
      ["read_file", { path: "shared.ts", startLine: 1, endLine: 2 }],
      ["read_file", { path: "shared.ts", startLine: 3, endLine: 4 }],
      ["search_code", { query: "first", glob: "shared.ts" }],
    ] as const;
    const { engine, stub } = await setup((index) => {
      const call = exploratory[index];
      if (!call) return text(JSON.stringify(expected));
      const reply = toolCall(call[0], call[1]);
      const body = reply.body as { choices: Array<{ message: { content: string | null } }> };
      body.choices[0]!.message.content = "I'll inspect the files before proposing the change.";
      return reply;
    });
    const given = request("Inspect the shared flow", { repoPath: repo, projectId: randomUUID(), sharingEpoch: 9 }, 5);
    const run = await engine.client.call("runs.start", given);
    for (let n = 1; n <= 5; n++) await permit(engine, run.id, given.input.operationId, n, 9);
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((event) => event.message).join(" | "));
    const result = await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId });
    assert.equal(result?.proposal.summary, expected.summary);
    assert.equal(result?.evidence.files.length, 3);
    assert.equal(result?.evidence.inventory.length, 1);
    assert.equal(result?.evidence.searches.length, 1);
    assert.equal(stub.chats().length, 5);
    const finalPrompt = stub.chats().at(-1)!.raw;
    assert.equal(finalPrompt.includes("shared.ts"), true, "the final request includes the read observations");
  });

  it("rejects citations crossing an unread line between separate reads", async () => {
    const root = tempDir("planning unread gap"); dirs.push(root);
    const repo = makeRepo(root);
    const source = "first\nsecond\nunread\nlast\n";
    writeFileSync(join(repo, "shared.ts"), source);
    assert.equal(spawnSync("git", ["add", "shared.ts"], { cwd: repo }).status, 0);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const expected = proposal(); expected.inspection = "assessed";
    expected.impacts[0] = { ...expected.impacts[0]!, evidence: "repository", citations: [{ path: "shared.ts", startLine: 2, endLine: 4, sha256: createHash("sha256").update(source).digest("hex"), revision }] };
    const { engine, stub } = await setup((index) => index < 2 ? toolCall("read_file", { path: "shared.ts", startLine: index === 0 ? 1 : 4, endLine: index === 0 ? 2 : 4 }) : toolCall("submit_plan", expected));
    const given = request("Do not infer unread evidence", { repoPath: repo, projectId: randomUUID(), sharingEpoch: 10 }, 3);
    const run = await engine.client.call("runs.start", given);
    for (let n = 1; n <= 3; n++) await permit(engine, run.id, given.input.operationId, n, 10);
    assert.equal((await finished(engine, run.id)).status, "failed");
    assert.equal(await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId }), null);
    assert.equal(stub.chats().length, 3, "an invalid final citation is never repaired with another request");
  });

  it("stops after a useful first answer even when eight requests were granted", async () => {
    const root = tempDir("planning early answer"); dirs.push(root);
    const repo = makeRepo(root);
    const { engine, stub } = await setup(() => toolCall("submit_plan", proposal()));
    const given = request("A small change needing no source claim", { repoPath: repo, projectId: randomUUID(), sharingEpoch: 3 }, 8);
    const run = await engine.client.call("runs.start", given);
    await permit(engine, run.id, given.input.operationId, 1, 3);
    assert.equal((await finished(engine, run.id)).status, "succeeded");
    assert.equal(stub.chats().length, 1, "eight requests is a maximum, never a target");
    const journal = await engine.client.call("budget.journal", { grantId: given.budget.id });
    assert.deepEqual([journal.seal?.kind, journal.rows.filter((row) => row.kind === "model-request").length], ["complete", 1]);
  });

  it("preserves the next final answer when an exploring read fills the bounded context", async () => {
    const root = tempDir("planning full context"); dirs.push(root);
    const repo = makeRepo(root);
    writeFileSync(join(repo, "source.ts"), Array.from({ length: 400 }, (_, index) => `export const line${index} = '${"Readable planning source. ".repeat(10)}';`).join("\n"));
    assert.equal(spawnSync("git", ["add", "source.ts"], { cwd: repo }).status, 0);
    const { engine, stub } = await setup((_index, incoming) => {
      const choice = incoming.body?.tool_choice as { function?: { name?: string } } | undefined;
      return choice?.function?.name === "submit_plan" ? toolCall("submit_plan", proposal()) : toolCall("read_file", { path: "source.ts" });
    });
    const given = request("Assess the bounded source", { repoPath: repo, projectId: randomUUID(), sharingEpoch: 4 }, 8);
    const run = await engine.client.call("runs.start", given);
    const page = await waitFor(async () => {
      const pending = await engine.client.call("planning.pending", { runId: run.id, operationId: given.input.operationId });
      if (pending.request !== null) await engine.client.call("planning.authorize", { runId: run.id, operationId: given.input.operationId, request: pending.request, sharingEpoch: 4 });
      const current = await engine.client.call("runs.get", { runId: run.id });
      return isTerminal(current.status) ? current : null;
    }, { what: "the reserved final answer after the context fills", timeoutMs: 30_000 });
    assert.equal(page.status, "succeeded");
    assert.equal(stub.chats().length > 1 && stub.chats().length < 8, true, "context saturation ends exploration before the request cap");
    assert.notEqual(await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId }), null);
  });

  it("keeps project records distinct from greenfield planning without source inspection and still checks its epoch", async () => {
    const { engine, stub } = await setup(() => toolCall("submit_plan", proposal()));
    const given = request("Plan against saved project records");
    given.context.projectId = randomUUID();
    given.context.sharingEpoch = 6;
    const run = await engine.client.call("runs.start", given);
    await waitFor(async () => (await engine.client.call("planning.pending", { runId: run.id, operationId: given.input.operationId })).request === 1);
    assert.equal(stub.chats().length, 0);
    await permit(engine, run.id, given.input.operationId, 1, 6);
    assert.equal((await finished(engine, run.id)).status, "succeeded");
    const result = await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId });
    assert.equal(result?.proposal.inspection, "not-assessed");
    assert.equal(result?.proposal.gaps.includes("Repository impact not assessed"), true);
  });

  it("revokes a waiting operation without sending and rejects a late result during a sent call", async () => {
    const { engine, stub } = await setup(() => ({ ...toolCall("submit_plan", proposal()), delayMs: 500 }));
    const waiting = request("Do not send", { repoPath: "/unused", projectId: randomUUID(), sharingEpoch: 1 });
    const first = await engine.client.call("runs.start", waiting);
    await waitFor(async () => (await engine.client.call("planning.pending", { runId: first.id, operationId: waiting.input.operationId })).request === 1);
    await engine.client.call("planning.end", { operationId: waiting.input.operationId });
    assert.equal((await finished(engine, first.id)).status, "cancelled");
    assert.equal(stub.chats().length, 0);
    const going = request("Cancel the sent operation");
    const second = await engine.client.call("runs.start", going);
    await waitFor(() => stub.chats().length === 1);
    await engine.client.call("planning.end", { operationId: going.input.operationId });
    assert.equal((await finished(engine, second.id)).status, "cancelled");
    assert.equal(await engine.client.call("planning.result", { runId: second.id, operationId: going.input.operationId }), null);
    await assert.rejects(engine.client.call("runs.start", going));
  });

  it("rejects missing grants, malformed final output and unsupported citations without retries or transcript persistence", async () => {
    const marker = `planning-invalid-${randomUUID()}`;
    const { engine, home, stub } = await setup(() => text(marker));
    const given = request(marker);
    const { budget: _budget, ...withoutGrant } = given;
    await assert.rejects(engine.client.call("runs.start", withoutGrant as typeof given));
    const run = await engine.client.call("runs.start", given);
    assert.equal((await finished(engine, run.id)).status, "failed");
    assert.equal(stub.chats().length, 1);
    assert.equal(await engine.client.call("planning.result", { runId: run.id, operationId: given.input.operationId }), null);
    await engine.client.call("shutdown", {}); await engine.exited;
    noStored(home, engine, [marker]);
    const hostile = proposal(); hostile.impacts[0] = { ...hostile.impacts[0]!, evidence: "repository", citations: [{ path: "invented.ts", startLine: 1, endLine: 1, sha256: "a".repeat(64), revision: "fake" }] };
    const second = await setup(() => toolCall("submit_plan", hostile));
    const other = request("No repository");
    const failed = await second.engine.client.call("runs.start", other);
    assert.equal((await finished(second.engine, failed.id)).status, "failed");
    assert.equal(second.stub.chats().length, 1);
  });

  it("counts a failed inference conservatively and never repeats it after engine restart", async () => {
    const marker = `planning-provider-${randomUUID()}`;
    const { engine, home, stub } = await setup(() => httpError(500, marker));
    const given = request(marker);
    const run = await engine.client.call("runs.start", given);
    assert.equal((await finished(engine, run.id)).status, "failed");
    const journal = await engine.client.call("budget.journal", { grantId: given.budget.id });
    assert.equal(journal.rows.find((row) => row.kind === "model-request")?.state, "unknown");
    await engine.client.call("shutdown", {}); await engine.exited;
    noStored(home, engine, [marker]);
    const restarted = await open(stub.url, home);
    assert.equal((await restarted.engine.client.call("runs.start", given)).id, run.id);
    assert.equal(stub.chats().length, 1);
  });
});
