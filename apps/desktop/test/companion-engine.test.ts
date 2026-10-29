import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import { httpError, startStub, text, type Stub } from "../../engine/test/stub-token-factory.ts";

const roots: string[] = [];
const hosts: Host[] = [];
const stubs: Stub[] = [];
after(async () => {
  await Promise.all(hosts.map((host) => host.shutdown()));
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function open(root: string, stub: Stub, enabled = true) {
  const host = new Host({
    store: new HostStore(join(root, "settings.json")), workspacePath: join(root, "workspace.db"), logsDir: join(root, "logs"),
    targets: { local: new LocalTarget({ platform: "linux", runtime: { node: process.execPath, entry: fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url)), runtimeHash: null }, home: join(root, "engine"), extraArgs: ["--token-factory-url", stub.url] }), discoverWsl: async () => null },
    client: { name: "companion-contract-test", version: "0" }, platform: "linux", credentials: async () => ({ NEBIUS_API_KEY: "companion-test-key-only" }),
    log: () => undefined, companionEnabled: enabled, supervisor: { heartbeatMs: 0 },
  });
  host.init(); hosts.push(host); return host;
}
function root() { const value = mkdtempSync(join(tmpdir(), "nivra companion host ")); roots.push(value); return value; }
async function finished(host: Host, sessionId: string, requestId: string) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const result = await host.getCompanionTurn(sessionId, requestId);
    if (result.status !== "running" && result.status !== "unknown") return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("The companion did not reach a terminal state.");
}
function absent(at: string, markers: string[]) {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) absent(path, markers);
    else {
      const bytes = readFileSync(path);
      assert.equal(markers.some((marker) => bytes.includes(Buffer.from(marker))), false, `A temporary marker reached ${entry.name}`);
    }
  }
}

it("counts a real companion request once through the host grant lifecycle and retains no transcript across restart", async () => {
  const prompt = `private-question-${randomUUID()}`, reply = `private-answer-${randomUUID()}`;
  const stub = await startStub({ models: [{ id: "nvidia/Nemotron-3.5-Super-VL", context_length: 131_072 }], chat: () => text(JSON.stringify({ reply, actions: [], captures: [] })) }); stubs.push(stub);
  const at = root(), host = open(at, stub), sessionId = randomUUID(), clientRequestId = randomUUID();
  await host.setCompanionLimit(1);
  const request = { sessionId, clientRequestId, hint: {}, message: prompt };
  await host.sendCompanionTurn(request);
  const result = await finished(host, sessionId, clientRequestId);
  assert.equal(result.status, "answered"); assert.equal(result.reply, reply);
  await host.sendCompanionTurn(request); assert.equal(stub.chats().length, 1);
  const usage = await host.getCompanionUsage();
  assert.deepEqual([usage.used, usage.reserved, usage.remaining], [1, 0, 0]);
  assert.ok(usage.reportedInputTokens > 0);
  await assert.rejects(host.sendCompanionTurn({ ...request, sessionId: randomUUID(), clientRequestId: randomUUID() }), /allowance|requests|exhausted/);
  assert.equal(host.conversations().conversations.length, 0);
  await host.shutdown(); absent(at, [prompt, reply]);
  const restarted = open(at, stub);
  assert.equal((await restarted.getCompanionTurn(sessionId, clientRequestId)).status, "interrupted");
  assert.equal((await restarted.getCompanionUsage()).used, 1);
  assert.equal(stub.chats().length, 1);
  await restarted.shutdown(); absent(at, [prompt, reply]);
});

it("counts failed dispatched requests, preserves unknown tokens, and never persists provider-echoed content", async () => {
  const marker = `private-provider-error-${randomUUID()}`;
  const stub = await startStub({ models: [{ id: "nvidia/Nemotron-3.5-Super-VL", context_length: 131_072 }], chat: () => httpError(500, marker) }); stubs.push(stub);
  const at = root(), host = open(at, stub), sessionId = randomUUID(), clientRequestId = randomUUID();
  await host.setCompanionLimit(2);
  await host.sendCompanionTurn({ sessionId, clientRequestId, hint: {}, message: marker });
  assert.equal((await finished(host, sessionId, clientRequestId)).status, "failed");
  const usage = await host.getCompanionUsage();
  assert.deepEqual([usage.used, usage.reserved, usage.remaining, usage.inputTokens], [1, 0, 1, null]);
  assert.equal(stub.chats().length, 1);
  await host.shutdown(); absent(at, [marker]);
});

it("keeps production dispatch gated while manual planning and local context remain usable", async () => {
  const stub = await startStub(); stubs.push(stub);
  const host = open(root(), stub, false);
  assert.equal((await host.getCompanionContext({})).canAsk, false);
  await assert.rejects(host.sendCompanionTurn({ sessionId: randomUUID(), clientRequestId: randomUUID(), hint: {}, message: "Help plan a task" }), /verification/);
  const mission = await host.createMission({ name: "Manual idea", outcome: "Keep planning without inference", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] });
  assert.equal(mission.latest.version, 1); assert.equal(stub.chats().length, 0);
});

it("retains a scoped selected outcome, then excludes forgotten knowledge and old dialogue from the next request", async () => {
  const promptMarker = `private-selected-question-${randomUUID()}`, replyMarker = `private-selected-answer-${randomUUID()}`;
  const statement = "This must work offline.";
  const prompt = `Can you help with ${promptMarker}? ${statement}`;
  const stub = await startStub({ models: [{ id: "nvidia/Nemotron-3.5-Super-VL", context_length: 131_072 }], chat: (_request, index) => text(JSON.stringify({ reply: index ? "Continue with the current brief." : replyMarker, actions: [], captures: index ? [] : [{ kind: "constraint", statement, quote: statement, start: prompt.indexOf(statement), end: prompt.length }] })) }); stubs.push(stub);
  const at = root(), host = open(at, stub), sessionId = randomUUID(), clientRequestId = randomUUID();
  await host.setCompanionLimit(3);
  const task = await host.createTask({ title: "Field notes", projectId: null, planId: null, fields: { goal: "Retain a field note", scope: "One note", acceptanceCriteria: [], exclusions: "", assumptions: [], context: "", checks: [], acceptanceCases: [] } });
  await host.sendCompanionTurn({ sessionId, clientRequestId, hint: { taskId: task.summary.id }, message: prompt });
  assert.equal((await finished(host, sessionId, clientRequestId)).status, "answered");
  const knowledge = await host.listKnowledge({ kind: "task", taskId: task.summary.id });
  assert.equal(knowledge.length, 1); assert.equal(knowledge[0]!.statement, statement);
  const other = await host.createTask({ title: "Unrelated task", projectId: null, planId: null, fields: { goal: "Another goal", scope: "", acceptanceCriteria: [], exclusions: "", assumptions: [], context: "", checks: [], acceptanceCases: [] } });
  assert.equal((await host.getCompanionContext({ taskId: other.summary.id })).knowledge.length, 0);
  await host.forgetKnowledge(knowledge[0]!.id, knowledge[0]!.revision);
  const secondId = randomUUID();
  await host.sendCompanionTurn({ sessionId, clientRequestId: secondId, hint: { taskId: task.summary.id }, message: "What is the next useful step?" });
  assert.equal((await finished(host, sessionId, secondId)).status, "answered");
  assert.equal(JSON.stringify(stub.chats()[1]!.body).includes(statement), false);
  assert.equal((await host.listKnowledge({ kind: "task", taskId: task.summary.id })).length, 0);
  await host.shutdown(); absent(at, [promptMarker, replyMarker]);
});
