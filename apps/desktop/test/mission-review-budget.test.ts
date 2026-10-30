import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";
import { MissionReviewPacket } from "@nivra/domain";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import { EngineSupervisor } from "../src/main/supervisor.ts";
import { BudgetGuard } from "../src/main/budget-guard.ts";
import { collectHostMissionReview } from "../scripts/mission-review-host.ts";
import type { ResultOf } from "@nivra/domain";
import { startStub, toolCall, type Reply, type StubRequest, type Stub } from "../../engine/test/stub-token-factory.ts";

const packet = MissionReviewPacket.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../engine/test/fixtures/mission-review/live.json", import.meta.url)), "utf8")));
const MODEL = packet.model!;
const roots: string[] = [], hosts: Host[] = [], stubs: Stub[] = [];
after(async () => { await Promise.all(hosts.map((host) => host.shutdown())); await Promise.all(stubs.map((stub) => stub.close())); for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
const roleOf = (request: StubRequest) => /Nivra review role: (architecture|risks|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1];
function answer(request: StubRequest): Reply { return roleOf(request) === "chair" ? toolCall("submit_synthesis", { summary: "The review is complete.", priorities: [], agreements: [], dissent: [] }) : toolCall("submit_review", { summary: "The selected tasks have been reviewed.", findings: [], assumptions: [], gaps: [] }); }
async function setup(chat = answer, at?: string, entry = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url)), listingDelayMs = 0) {
  const models = [{ id: MODEL, context_length: 131072 }];
  const stub = await startStub({ models, ...(listingDelayMs ? { modelsReply: { delayMs: listingDelayMs, body: { data: models } } } : {}), chat }); stubs.push(stub);
  const root = at ?? mkdtempSync(join(tmpdir(), "nivra-mission-review-host-")); if (!at) roots.push(root);
  const host = new Host({
    store: new HostStore(join(root, "nivra.json")), workspacePath: join(root, "workspace.db"), logsDir: join(root, "logs"),
    targets: { local: new LocalTarget({ platform: "linux", runtime: { node: process.execPath, entry, runtimeHash: null }, home: join(root, "engine"), extraArgs: ["--token-factory-url", stub.url] }), discoverWsl: async () => null },
    platform: "linux", client: { name: "mission-review-budget-test", version: "0" }, credentials: async () => ({ NEBIUS_API_KEY: "synthetic-mission-test-key-only" }), supervisor: { heartbeatMs: 0 }, log: () => undefined,
  });
  host.init(); hosts.push(host); return { host, root, stub };
}
async function mission(host: Host) {
  let view = await host.createMission(packet.mission);
  for (const task of packet.tasks) {
    const { title, acceptanceCaseNames: _cases, ...fields } = task;
    view = await host.createMissionTask(view.id, title, { ...fields, acceptanceCases: [] });
  }
  return { id: view.id, tasks: view.backlog.map((entry) => entry.task.id) };
}
async function finish(host: Host, id: string) {
  const end = performance.now() + 30_000;
  for (;;) {
    const view = host.mission(id), review = view.reviews[0];
    if (review && !view.reviewing) return review;
    if (performance.now() >= end) throw new Error("The host did not record the review's terminal state.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function start(host: Host, selected: { id: string; tasks: string[] }) { const preview = await host.prepareMissionReview(selected.id, selected.tasks, { requiredModel: MODEL }); return host.startMissionReview(selected.id, selected.tasks, preview.expected, { requiredModel: MODEL }); }

async function waitFor<T>(probe: () => T | Promise<T>, message: string): Promise<NonNullable<T>> {
  const end = performance.now() + 20_000;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (performance.now() >= end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The review reproduction: deleting during the listing leaves its complete zero-inference seal for a cold host. */
async function deletedReview() {
  const { host, root, stub } = await setup(answer, undefined, undefined, 1000);
  await host.setCompanionLimit(3, false, null, true);
  const selected = await mission(host); await start(host, selected);
  await waitFor(() => stub.requests.some((request) => request.path.endsWith("/models")), "The listing did not start.");
  const runId = await waitFor(() => host.mission(selected.id).reviews[0]?.runId, "The host did not record the run id.");
  await host.deleteMission(selected.id);
  await waitFor(async () => ["failed", "cancelled", "succeeded"].includes((await host.runResult(runId)).summary.status), "The deleted review did not stop.");
  await host.shutdown();
  assert.equal(stub.chats().length, 0);
  const engine = new DatabaseSync(join(root, "engine", "nivra.db"), { readOnly: true });
  try {
    const seals = engine.prepare("SELECT kind, rows FROM budget_seals").all();
    assert.equal(seals.length, 1);
    assert.deepEqual([seals[0]?.kind, seals[0]?.rows], ["complete", 1]);
  } finally { engine.close(); }
  return root;
}

it("reconnects deleted reviews' grants after relaunch and never releases their capacity twice", async () => {
  const root = await deletedReview();
  const { host, stub } = await setup(answer, root);
  const selected = await mission(host);
  const preview = await host.prepareMissionReview(selected.id, selected.tasks);
  assert.deepEqual([preview.blocked, preview.allowance.remaining], [null, 3]);
  const first = await host.getCompanionUsage();
  assert.deepEqual([first.used, first.reserved, first.remaining, first.reconciliationNotes.length], [0, 0, 3, 0]);
  const revision = new BudgetGuard(join(root, "budget-guard.log")).last()?.revision;
  const repeated = await Promise.all([host.getCompanionUsage(), host.getCompanionUsage(), host.budgetSummary()]);
  assert.equal(repeated[0].remaining, 3); assert.equal(repeated[1].remaining, 3);
  assert.equal(new BudgetGuard(join(root, "budget-guard.log")).last()?.revision, revision);
  await host.shutdown();
  const db = new DatabaseSync(join(root, "workspace.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM budget_operations").get()?.n, 1);
    assert.equal(db.prepare("SELECT state FROM budget_grants").get()?.state, "settled");
  } finally { db.close(); }
  assert.equal(stub.requests.length, 0, "reconnection reads metadata without replaying provider calls");
});

it("retains the reservation when reconnecting its engine fails, explains why, and settles after recovery", async () => {
  const root = await deletedReview();
  const missing = await setup(answer, root, join(root, "missing-engine.mjs"));
  const first = await missing.host.getCompanionUsage(), repeated = await missing.host.getCompanionUsage();
  assert.deepEqual([first.remaining, first.missionReviews.reserved, repeated.remaining], [0, 3, 0]);
  assert.match(first.reconciliationNotes.join(" "), /couldn't be reconnected.*remains reserved/);
  const selected = await mission(missing.host);
  assert.match((await missing.host.prepareMissionReview(selected.id, selected.tasks)).blocked ?? "", /couldn't be reconnected/);
  assert.equal(missing.stub.requests.length, 0);
  await missing.host.shutdown();
  const restored = await setup(answer, root);
  const usage = await restored.host.getCompanionUsage();
  assert.deepEqual([usage.remaining, usage.reserved, usage.reconciliationNotes.length], [3, 0, 0]);
  assert.equal(restored.stub.requests.length, 0);
});

it("retains a grant when its complete seal fails validation and settles it once valid evidence returns", async (t) => {
  const root = await deletedReview();
  const original = EngineSupervisor.prototype.call;
  const changed = t.mock.method(EngineSupervisor.prototype, "call", async function (this: EngineSupervisor, method: Parameters<typeof original>[0], params: never) {
    const result = await original.call(this, method, params);
    if (method !== "budget.journal") return result;
    const page = result as ResultOf<"budget.journal">;
    return { ...page, seal: page.seal ? { ...page.seal, rows: page.seal.rows + 1 } : null };
  });
  const { host, stub } = await setup(answer, root);
  const held = await host.getCompanionUsage();
  assert.deepEqual([held.remaining, held.used + held.reserved], [0, 3]);
  assert.match(held.reconciliationNotes.join(" "), /couldn't validate.*remains reserved/);
  changed.mock.restore();
  const settled = await host.getCompanionUsage(), repeated = await host.getCompanionUsage();
  assert.deepEqual([settled.remaining, settled.used + settled.reserved, repeated.remaining, settled.reconciliationNotes.length], [3, 0, 3, 0]);
  assert.equal(stub.requests.length, 0);
});

for (const shutdownFails of [false, true]) it(`always shuts down after reconciliation fails${shutdownFails ? " and reports both failures" : ""}`, async (t) => {
  const { root, stub, host: unused } = await setup((request) => { const reply = answer(request); return { ...reply, body: { ...(reply.body as object), model: MODEL } }; });
  await unused.shutdown();
  const originalShutdown = Host.prototype.shutdown;
  let calls = 0, shutdownCalls = 0;
  t.mock.method(Host.prototype, "getCompanionUsage", async function () {
    calls++;
    throw new Error("Private reconciliation error synthetic-mission-test-key-only");
  });
  t.mock.method(Host.prototype, "shutdown", async function (this: Host) {
    shutdownCalls++;
    await originalShutdown.call(this);
    if (shutdownFails) throw new Error("Private shutdown error synthetic-mission-test-key-only");
  });
  const result = await collectHostMissionReview({ packet, root: join(root, "collector"), home: join(root, "collector-engine"), logPath: join(root, "collector.log"), apiKey: "synthetic-mission-test-key-only", tokenFactoryUrl: stub.url, followMs: 20_000 });
  assert.equal(shutdownCalls, 1);
  assert.equal(result.summary?.status, "succeeded");
  assert.equal(result.engineClose, shutdownFails ? "failed" : "returned");
  assert.equal(calls, 1);
  assert.ok(result.problems.some((message) => message.startsWith("Budget reconciliation failed")));
  assert.equal(result.problems.some((message) => message.startsWith("Host shutdown failed")), shutdownFails);
  assert.equal(JSON.stringify(result).includes("Private"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-mission-test-key-only"), false);
});

it("settles a real host council once, then admits the next review without opening Settings", async () => {
  const { host, root, stub } = await setup(); await host.setCompanionLimit(6, true, null, true);
  const selected = await mission(host);
  const preview = await host.prepareMissionReview(selected.id, selected.tasks, { requiredModel: MODEL });
  assert.deepEqual([preview.model, preview.allowance.monthly, preview.allowance.remaining], [MODEL, true, 6]);
  await host.startMissionReview(selected.id, selected.tasks, preview.expected, { requiredModel: MODEL });
  assert.equal((await finish(host, selected.id)).status, "answered");
  const again = await host.prepareMissionReview(selected.id, selected.tasks, { requiredModel: MODEL });
  assert.deepEqual([again.blocked, again.allowance.remaining], [null, 3]);
  await host.startMissionReview(selected.id, selected.tasks, again.expected, { requiredModel: MODEL });
  assert.equal((await finish(host, selected.id)).status, "answered");
  const usage = await host.getCompanionUsage(); assert.deepEqual([usage.used, usage.reserved, usage.remaining, usage.missionReviews.used], [6, 0, 0, 6]);
  assert.equal(stub.chats().length, 6);
  assert.equal(host.tasks().tasks.every((task) => task.state === "draft"), true);
  await host.shutdown();
  const db = new DatabaseSync(join(root, "engine", "nivra.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT seat, part FROM budget_journal WHERE kind = 'model-request' ORDER BY rowid").all();
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.filter((row) => row.seat === "chair").map((row) => row.part), ["finalisation", "finalisation"]);
  } finally { db.close(); }
  const reopened = await setup(answer, root);
  assert.equal((await reopened.host.openMission(selected.id)).reviews.length, 2);
  assert.equal((await reopened.host.getCompanionUsage()).used, 6);
  assert.equal(reopened.stub.requests.length, 0);
});

it("refuses zero/two-slot allowances and stale policies before listing, and atomically admits only one competing council", async () => {
  const { host, stub } = await setup(); const a = await mission(host), b = await mission(host);
  for (const cap of [0, 2]) {
    await host.setCompanionLimit(cap, false, null, true);
    const preview = await host.prepareMissionReview(a.id, a.tasks);
    assert.match(preview.blocked ?? "", /needs three/);
    await assert.rejects(host.startMissionReview(a.id, a.tasks, preview.expected), /needs three/);
  }
  await host.setCompanionLimit(3, false, null, true);
  const stale = await host.prepareMissionReview(a.id, a.tasks);
  await host.setCompanionLimit(4, false, null, true);
  await assert.rejects(host.startMissionReview(a.id, a.tasks, stale.expected), /changed/);
  assert.equal(stub.requests.length, 0);
  await host.setCompanionLimit(3, false, null, true);
  const [pa, pb] = await Promise.all([host.prepareMissionReview(a.id, a.tasks), host.prepareMissionReview(b.id, b.tasks)]);
  const results = await Promise.allSettled([host.startMissionReview(a.id, a.tasks, pa.expected), host.startMissionReview(b.id, b.tasks, pb.expected)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const running = host.mission(a.id).reviewing ? a.id : b.id;
  await finish(host, running);
  assert.equal(stub.requests.filter((request) => request.path.endsWith("/models")).length, 1);
  assert.equal(stub.chats().length, 3);
});

it("releases the unused chair after cancellation and retains unknown usage without reporting zero", async () => {
  let delay = true;
  const { host, stub } = await setup((request) => ({ ...answer(request), ...(delay && roleOf(request) === "risks" ? { delayMs: 3000 } : {}) }));
  await host.setCompanionLimit(5, false, null, true);
  const selected = await mission(host); await start(host, selected);
  const until = performance.now() + 20_000;
  while (stub.chats().length < 2 && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stub.chats().length, 2);
  await host.cancelMissionReview(selected.id, host.mission(selected.id).reviews[0]!.id);
  assert.equal((await finish(host, selected.id)).status, "cancelled");
  const next = await host.prepareMissionReview(selected.id, selected.tasks);
  assert.deepEqual([next.blocked, next.allowance.remaining], [null, 3]);
  delay = false; await host.startMissionReview(selected.id, selected.tasks, next.expected); await finish(host, selected.id);
  const usage = await host.getCompanionUsage();
  assert.deepEqual([usage.used, usage.reserved, usage.remaining], [5, 0, 0]);
  assert.ok(usage.unknown >= 1); assert.equal(usage.inputTokens, null);
});

it("refuses a failed durable guard before any provider request", async () => {
  const { host, root, stub } = await setup(); await host.setCompanionLimit(3, false, null, true);
  const selected = await mission(host); const preview = await host.prepareMissionReview(selected.id, selected.tasks);
  const path = join(root, "budget-guard.log"); renameSync(path, `${path}.kept`); mkdirSync(path);
  await assert.rejects(host.startMissionReview(selected.id, selected.tasks, preview.expected), /guard/);
  assert.equal(stub.requests.length, 0);
});

it("finds a lost Start reply by its original id, never resends it, and holds a reservation without a journal seal", async () => {
  const entry = fileURLToPath(new URL("./fixtures/gated-engine.mjs", import.meta.url));
  const { host, root, stub } = await setup(answer, undefined, entry);
  mkdirSync(join(root, "engine"));
  for (const name of ["accept", "release", "error-start"]) writeFileSync(join(root, "engine", name), "");
  await host.setCompanionLimit(3, false, null, true);
  const selected = await mission(host); await start(host, selected);
  const result = await finish(host, selected.id);
  assert.ok(result.runId);
  const calls = readFileSync(join(root, "engine", "calls.log"), "utf8").trim().split("\n");
  assert.equal(calls.filter((name) => name === "runs.start").length, 1);
  assert.ok(calls.includes("runs.find"));
  const usage = await host.getCompanionUsage();
  assert.deepEqual([usage.remaining, usage.used + usage.reserved, usage.inputTokens], [0, 3, null]);
  assert.equal(stub.requests.length, 0);
  await host.shutdown();
  const again = await setup(answer, root, entry);
  await again.host.openMission(selected.id);
  assert.equal((await again.host.getCompanionUsage()).remaining, 0);
  assert.equal(readFileSync(join(root, "engine", "calls.log"), "utf8").split("\n").filter((name) => name === "runs.start").length, 1);
});

it("keeps the whole uncertain council after a real engine crash and reconciles its interrupted seal idempotently", async () => {
  const { host, root, stub } = await setup((request) => ({ ...answer(request), delayMs: 4000 }));
  await host.setCompanionLimit(3, false, null, true);
  const selected = await mission(host); await start(host, selected);
  const until = performance.now() + 20_000;
  while (stub.chats().length < 2 && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stub.chats().length, 2);
  const state = host.engines()[0]?.state;
  assert.equal(state?.status, "online");
  if (state?.status !== "online") throw new Error("The disposable engine is not online.");
  process.kill(state.info.pid, "SIGKILL");
  await host.shutdown();
  const again = await setup(answer, root);
  await again.host.openMission(selected.id);
  await finish(again.host, selected.id);
  const first = await again.host.getCompanionUsage(), second = await again.host.getCompanionUsage();
  assert.deepEqual([first.remaining, first.used, first.reserved, first.unknown, first.inputTokens], [0, 3, 0, 3, null]);
  assert.deepEqual([second.remaining, second.used, second.unknown], [0, 3, 3]);
  assert.equal(again.stub.requests.length, 0, "the interrupted review is never replayed");
});
