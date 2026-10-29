import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { BudgetGrant, CompanionResult } from "@nivra/domain";
import { CompanionHost, companionCaptureConflicts, type CompanionHostOptions } from "../src/main/companion-host.ts";
import type { ProjectRecord } from "../src/main/host-store.ts";
import { getKnowledge, listKnowledge } from "../src/main/knowledge-store.ts";
import { insertMission, insertMissionVersion } from "../src/main/mission-store.ts";
import type { EngineSupervisor } from "../src/main/supervisor.ts";
import { insertTask, updateTask } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceDb } from "../src/main/workspace-db.ts";
import { BRIEFS } from "./fixtures/briefs.ts";

const dirs: string[] = [];
const open: WorkspaceDb[] = [];
after(() => { for (const db of open) db.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const AT = "2026-10-29T10:00:00.000Z";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nivra-companion-host-"));
  dirs.push(root);
  const opening = openWorkspace(join(root, "workspace.db"));
  assert.equal(opening.state, "ready");
  if (opening.state !== "ready") throw new Error("The fixture workspace couldn't open.");
  const db = opening.db;
  open.push(db);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runs = new Map<string, string>();
  const projects: ProjectRecord[] = [];
  const preferences: Array<{ statement: string; scope: string; projectId: string | null }> = [];
  let preferenceRevision = 0;
  let budgetBlocked: string | null = null;
  let grants = 0;
  let result: CompanionResult = { reply: "A temporary answer.", actions: [], captures: [] };
  const connection = { state: { status: "online", info: { homeId: "test-home" } }, call: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "runs.start") { const id = randomUUID(); runs.set(String(params["clientRequestId"]), id); return { id, status: "succeeded" }; }
    if (method === "runs.get") return { id: params["runId"], status: "succeeded" };
    if (method === "runs.find") return { id: runs.get(String(params["clientRequestId"])), status: "succeeded" };
    if (method === "companion.result") return result;
    return { ok: true };
  } } as unknown as Pick<EngineSupervisor, "call" | "state">;
  const options: CompanionHostOptions = {
    workspace: () => db, projects: () => projects, preferences: () => ({ revision: preferenceRevision, records: [] }), preferenceRevision: () => preferenceRevision,
    sharingEpoch: () => 0, secrets: async () => [["NEBIUS_API_KEY", "fixture-provider-key-1234567890"]], connect: async () => connection,
    grant: () => { grants++; return {} as BudgetGrant; }, reconcileBudget: async () => undefined, budgetStatus: async () => ({ blocked: budgetBlocked }),
    settings: () => ({ hidden: false, invitationDismissed: false }), setSettings: (value) => ({ hidden: false, invitationDismissed: false, ...value }),
    createMission: async () => { throw new Error("unused"); }, createMissionTask: async () => { throw new Error("unused"); }, task: () => ({ runBlocked: "Mark the task ready first." }) as ReturnType<CompanionHostOptions["task"]>,
    addPreference: (input) => { preferences.push(input); preferenceRevision++; }, enabled: true,
  };
  const companion = new CompanionHost(options);
  const missionId = randomUUID();
  insertMission(db, { id: missionId, conversationId: randomUUID(), createdAt: AT }, { id: randomUUID(), content: { name: "Offline notes", outcome: "Save notes offline", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] } });
  return { db, companion, options, missionId, calls, projects, preferences, grants: () => grants, setBudget: (value: string | null) => { budgetBlocked = value; }, answer: (value: CompanionResult) => { result = value; } };
}

describe("the host's transient companion", () => {
  it("makes no model call from context; retains selected knowledge without storing canary dialogue; forgetting clears later history", async () => {
    const f = fixture();
    const hint = { missionId: f.missionId };
    await f.companion.context(hint);
    assert.equal(f.calls.length, 0);
    assert.equal(f.grants(), 0);
    const sessionId = randomUUID();
    const clientRequestId = randomUUID();
    const marker = `prompt-canary-${randomUUID()}`;
    const replyMarker = `reply-canary-${randomUUID()}`;
    const quote = "This app must work offline.";
    const message = `${marker}\n${quote}`;
    f.answer({ reply: replyMarker, actions: [], captures: [{ kind: "constraint", statement: quote, quote, start: message.indexOf(quote), end: message.length }] });
    await f.companion.send({ sessionId, clientRequestId, hint, message });
    const view = await f.companion.turn(sessionId, clientRequestId);
    assert.equal(view.status, "answered");
    assert.equal(view.reply, replyMarker);
    assert.equal(view.retained?.length, 1);
    assert.equal(view.dialogueEpoch, (await f.companion.context(hint)).dialogueEpoch);
    const saved = listKnowledge(f.db, { kind: "mission", id: f.missionId })[0]!;
    assert.equal(saved.statement, quote);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.["n"], 0);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM run_links").get()?.["n"], 0);
    await f.companion.forget(saved.id, saved.revision);
    assert.equal(getKnowledge(f.db, saved.id)?.statement, null);
    const next = randomUUID();
    f.answer({ reply: "Fresh context.", actions: [], captures: [] });
    await f.companion.send({ sessionId, clientRequestId: next, hint, message: "What next?" });
    const start = f.calls.filter((one) => one.method === "runs.start").at(-1)!;
    assert.equal((start.params["context"] as { history: unknown[] }).history.length, 0);
    await f.companion.turn(sessionId, next);
    await f.companion.end(sessionId);
    f.db.checkpoint();
    const bytes = readFileSync(f.db.path);
    assert.equal(bytes.includes(Buffer.from(marker)), false);
    assert.equal(bytes.includes(Buffer.from(replyMarker)), false);
    const restarted = new CompanionHost(f.options);
    assert.equal((await restarted.turn(sessionId, clientRequestId)).status, "interrupted");
    assert.equal(f.grants(), 2);
  });

  it("keeps ordinary saved-state changes out of the dialogue epoch and marks their action proposals stale", async () => {
    const f = fixture();
    const taskId = randomUUID();
    insertTask(f.db, { id: taskId, title: "Draft", projectId: null, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: BRIEFS.vague, derivedFrom: null });
    const hint = { taskId };
    const before = await f.companion.context(hint);
    const sessionId = randomUUID();
    const clientRequestId = randomUUID();
    f.answer({ reply: "Advice for the old task title.", actions: [{ kind: "draft-task", title: "First step", goal: "A small result", scope: "", acceptance: [] }], captures: [] });
    await f.companion.send({ sessionId, clientRequestId, hint, message: "Help plan this task." });
    updateTask(f.db, taskId, 1, { title: "Renamed" }, AT);
    const after = await f.companion.context(hint);
    assert.equal(after.dialogueEpoch, before.dialogueEpoch);
    assert.notEqual(after.fingerprint, before.fingerprint);
    const answer = await f.companion.turn(sessionId, clientRequestId);
    assert.equal(answer.status, "answered");
    assert.equal(answer.actions?.length, 0);
    assert.match(answer.message ?? "", /earlier version/);
    await f.companion.send({ sessionId, clientRequestId: randomUUID(), hint, message: "Use the current title." });
    const context = f.calls.filter((one) => one.method === "runs.start").at(-1)!.params["context"] as { history: unknown[] };
    assert.equal(context.history.length, 2);
  });

  it("blocks inference for the exhausted allowance while local planning stays usable, and deduplicates request ids", async () => {
    const f = fixture();
    f.setBudget("The monthly allowance is exhausted.");
    const hint = { missionId: f.missionId };
    const view = await f.companion.context(hint);
    assert.equal(view.canAsk, false);
    assert.match(view.askBlocked ?? "", /exhausted/);
    const input = { sessionId: randomUUID(), clientRequestId: randomUUID(), hint, message: "Help" };
    await assert.rejects(f.companion.send(input), /exhausted/);
    assert.equal(f.grants(), 0);
    f.setBudget(null);
    const first = await f.companion.send(input);
    assert.equal((await f.companion.send(input)).runId, first.runId);
    assert.equal(f.grants(), 1);
    assert.equal(f.calls.filter((one) => one.method === "runs.start").length, 1);
  });

  it("reserves submission before asynchronous setup and refuses conflicting concurrent request ids", async () => {
    const f = fixture();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const secrets = f.options.secrets;
    f.options.secrets = async () => { await hold; return secrets(); };
    const input = { sessionId: randomUUID(), clientRequestId: randomUUID(), hint: { missionId: f.missionId }, message: "Help plan this idea." };
    const first = f.companion.send(input);
    const duplicate = f.companion.send(input);
    await assert.rejects(f.companion.send({ ...input, message: "A changed message." }), /already used/);
    await assert.rejects(f.companion.send({ ...input, clientRequestId: randomUUID() }), /already being prepared/);
    release();
    const [one, two] = await Promise.all([first, duplicate]);
    assert.equal(one.runId, two.runId);
    assert.equal(f.grants(), 1);
    assert.equal(f.calls.filter((call) => call.method === "runs.start").length, 1);
    await f.companion.turn(input.sessionId, input.clientRequestId);
    await assert.rejects(f.companion.send({ ...input, message: "Changed after reply." }), /already used/);
  });

  it("retains explicit global preferences without a native scope and leaves ambiguous/conflicting captures as proposals", async () => {
    const f = fixture();
    const message = "I prefer small pull requests for all my projects.";
    const sessionId = randomUUID();
    const clientRequestId = randomUUID();
    f.answer({ reply: "Understood.", actions: [], captures: [{ kind: "constraint", statement: message, quote: message, start: 0, end: message.length }] });
    await f.companion.send({ sessionId, clientRequestId, hint: {}, message });
    await f.companion.turn(sessionId, clientRequestId);
    assert.equal(f.preferences.length, 1);
    assert.equal(f.preferences[0]?.scope, "personal");
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM knowledge").get()?.["n"], 0);
    assert.equal(companionCaptureConflicts("Use npm.", ["This project must use pnpm."]), true);
    assert.equal(companionCaptureConflicts("This app must not work offline.", ["This app must work offline."]), true);
    assert.equal(companionCaptureConflicts("This app must work offline.", ["This app must work offline."]), false);
  });

  it("revalidates ordinary source revisions inside a draft's native save after a credential wait", async () => {
    const f = fixture();
    const sessionId = randomUUID();
    const requestId = randomUUID();
    f.answer({ reply: "Here is a small task.", actions: [{ kind: "draft-task", title: "First step", goal: "A small result", scope: "One screen", acceptance: ["It saves a note"] }], captures: [] });
    await f.companion.send({ sessionId, clientRequestId: requestId, hint: { missionId: f.missionId }, message: "Propose my first task." });
    const view = await f.companion.turn(sessionId, requestId);
    const action = view.actions?.[0];
    assert.equal(action?.kind, "draft-task");
    assert.equal(typeof action?.fingerprint, "string");
    if (!action?.fingerprint || !action.draft) throw new Error("The task proposal must carry a bound draft.");
    let release!: () => void;
    let entered!: () => void;
    let writes = 0;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.options.createMissionTask = async (_missionId, _title, _fields, _actionId, validate) => { entered(); await hold; validate(); writes++; throw new Error("The stale save should never write."); };
    const saving = f.companion.saveDraft({ sessionId, requestId, actionId: action.id, fingerprint: action.fingerprint, draft: action.draft });
    await started;
    insertMissionVersion(f.db, f.missionId, { id: randomUUID(), content: { name: "Changed mission", outcome: "A different result", intendedUsers: "", successCriteria: [], constraints: [], nonGoals: [] }, createdAt: AT }, 1);
    release();
    await assert.rejects(saving, /changed while this draft/);
    assert.equal(writes, 0);
  });
});
