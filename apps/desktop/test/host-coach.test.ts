import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { COACH_TOOL, coachRoleMarker, type CoachReport, type SecretName } from "@nivra/domain";
import { insertCoaching, settleCoaching } from "../src/main/coach-store.ts";
import { Host } from "../src/main/host.ts";
import { HostStore, NO_SHARING } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import type { TargetFactory } from "../src/main/targets/registry.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";
import { briefFrom } from "../src/main/tasks.ts";
import { insertAttempt, insertTask, recordOutcome, versionsOf } from "../src/main/workspace.ts";
import { openWorkspace, type WorkspaceOpening } from "../src/main/workspace-db.ts";
import type { CoachSelection } from "../src/shared/coach.ts";
import type { BriefFields } from "../src/shared/ipc.ts";
import { startStub, toolCall, type Reply, type Stub, type StubRequest } from "../../engine/test/stub-token-factory.ts";
import { seedMission, seedMissionReview } from "../e2e/seed-workspace.ts";
import { CASE } from "./fixtures/briefs.ts";

/**
 * The task readiness coach through the host (NIV-53), against real engines run from source and a loopback stub of Token
 * Factory: a preview sends nothing; a start sends exactly what was previewed, once; only the person's ticked changes are
 * saved, as the next brief version, in one transaction; anything stale refuses the save and changes nothing; and the
 * coach never moves a task's state, its runs or what a run is judged by.
 */
const ENGINE = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url));
const GATED = fileURLToPath(new URL("./fixtures/gated-engine.mjs", import.meta.url));
const KEY = "test-key-0123456789";
const NONE: CoachSelection = { mission: false, findings: [] };
const dirs: string[] = [];
const hosts: Host[] = [];
const stubs: Stub[] = [];
after(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function waitFor<T>(check: () => T | null | false | Promise<T | null | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const localTarget = (home: string, extraArgs: readonly string[], entry = ENGINE) => new LocalTarget({ platform: "linux", runtime: { node: process.execPath, entry, runtimeHash: null }, home, extraArgs });
/** A target that says it is a WSL distribution, running its engine locally with its own home. */
const standInWsl = (inner: ExecutionTarget): ExecutionTarget => ({ descriptor: { id: "wsl:Test", kind: "wsl", label: "Test · WSL", platform: "linux", distro: "Test" }, probe: () => inner.probe(), prepare: (request) => inner.prepare(request) });

/** A host on the records under `root`, its engines reaching the stub: a second one is a restart. */
function hostAt(root: string, url: string, testHooks?: { coachApplying?(coachingId: string): void }, localEntry = ENGINE) {
  const extraArgs = ["--token-factory-url", url];
  const wsl = standInWsl(localTarget(join(root, "wsl home"), extraArgs));
  const targets: TargetFactory = {
    local: localTarget(join(root, "local home"), extraArgs, localEntry),
    discoverWsl: async () => ({ discovery: { status: "ready", wslExe: "wsl.exe", distros: [{ name: "Test", version: 2, isDefault: true, defaultUid: 1000, osVersion: null }], hidden: [] }, targets: [wsl] }),
  };
  const keys: { current: Partial<Record<SecretName, string>> } = { current: { NEBIUS_API_KEY: KEY } };
  const host = new Host({
    targets,
    store: new HostStore(join(root, "nivra.json")),
    workspacePath: join(root, "workspace.db"),
    logsDir: join(root, "logs"),
    client: { name: "host-coach-test", version: "0" },
    credentials: async () => keys.current,
    // As Windows, so a project on the WSL stand-in is one the host can reach (D17); a task with none runs on local.
    platform: "win32",
    realpath: (path) => path,
    supervisor: { heartbeatMs: 0, shutdownGraceMs: 300, eofGraceMs: 300 },
    log: () => undefined,
    ...(testHooks ? { testHooks } : {}),
  });
  host.init();
  hosts.push(host);
  return { host, keys };
}

/** A root with one project on the WSL stand-in, its sharing as given. */
function rootWithProject(sharing: boolean): { root: string; projectId: string } {
  const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
  dirs.push(root);
  const projectId = randomUUID();
  new HostStore(join(root, "nivra.json")).update((data) => ({
    ...data,
    projects: [{ id: projectId, targetId: "wsl:Test", nativePath: join(root, "repo"), label: "repo", addedAt: new Date().toISOString(), sharing: { ...NO_SHARING, modelContext: sharing } }],
  }));
  return { root, projectId };
}

const ANSWER = {
  summary: "The goal is clear. The criterion doesn't say what someone would see.",
  questions: [{ text: "Which unit should records use?", why: "The criterion needs one to check.", field: "acceptanceCriteria" }],
  changes: [
    { field: "goal", text: "Records compare finish times in one unit", reason: "Names the outcome.", refs: [] },
    { field: "acceptanceCriteria", reword: [{ item: 1, text: "A 5 km run logged in miles shows its record in kilometres" }], add: ["A run with no unit is left out"], reason: "Says what someone would see.", refs: ["G1", "C1"] },
    { field: "context", append: "Today, a run logged in miles is compared as if it were in kilometres.", reason: "Says what happens now.", refs: [] },
  ],
  suggestedChecks: [{ name: "Units", command: "pnpm --filter @sheetless/data test", expectedOutput: "", expectedExitCode: 0, reason: "Runs the suite." }],
  unknowns: ["Whether older runs store a unit."],
};
async function stubFor(reply: (request: StubRequest) => Reply = () => toolCall(COACH_TOOL, ANSWER)) {
  const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: reply });
  stubs.push(stub);
  return stub;
}
const coachRequests = (stub: Stub) => stub.chats().filter((chat) => JSON.stringify(chat.body?.messages ?? []).includes(coachRoleMarker()));
const listings = (stub: Stub) => stub.requests.filter((request) => request.path.endsWith("/models")).length;

const VAGUE: BriefFields = { goal: "Fix the PR detection bug", acceptanceCriteria: ["It works"], scope: "", exclusions: "", context: "", assumptions: [], checks: ["sh test.sh"], acceptanceCases: [CASE], frozen: ["tests/units.test.ts"] };
const ended = (host: Host, taskId: string) =>
  waitFor(() => {
    const [latest] = host.coachings(taskId);
    return latest && latest.status !== "submitting" && latest.status !== "running" ? latest : null;
  }, "the coaching to end", 30_000);
const ask = async (host: Host, taskId: string, selection: CoachSelection = NONE) => host.startCoach(taskId, selection, (await host.prepareCoach(taskId, selection)).expected);
const CHANGED = /^Error: What the coach would read has changed since you opened it\. Check the new preview, then ask the coach again\.$/;

describe("Host: the task readiness coach (NIV-53)", () => {
  it("previews what it sends without sending it, sends that once, and saves exactly the ticked changes as the next version", async () => {
    const stub = await stubFor();
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const { host } = hostAt(root, stub.url);
    const personal = host.addPreference({ statement: `Prefer reversible changes ${randomUUID()}`, scope: "personal", projectId: null, intent: "default" });
    const task = await host.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    const preview = await host.prepareCoach(taskId, NONE);
    assert.deepEqual([preview.briefVersion, preview.scope, preview.blocked, preview.preferences.map((p) => p.statement)], [1, { kind: "general" }, null, [personal.statement]]);
    assert.match(preview.text, /C1\. It works/);
    assert.equal(/sh export\.sh|id,title/.test(preview.text), false, "an acceptance case's command and output aren't sent");
    assert.deepEqual([stub.requests.length], [0], "a preview sends nothing, and lists no model");

    const started = await host.startCoach(taskId, NONE, preview.expected);
    assert.equal(started.status, "submitting");
    const coaching = await ended(host, taskId);
    assert.equal(coaching.status, "answered", coaching.note ?? "");
    assert.deepEqual([listings(stub), coachRequests(stub).length, coaching.briefVersion, coaching.report?.outcome, coaching.changes.map((change) => change.field)], [1, 1, 1, "complete", ["goal", "acceptanceCriteria", "context"]]);
    const criteria = coaching.changes.find((change) => change.field === "acceptanceCriteria")!;
    assert.deepEqual([criteria.before, criteria.after, criteria.blocked], [["It works"], ["A 5 km run logged in miles shows its record in kilometres", "A run with no unit is left out"], null]);
    assert.ok(JSON.stringify(coachRequests(stub)[0]?.body?.messages).includes(personal.statement));

    const before = host.task(taskId);
    const after = await host.acceptCoachChanges(taskId, before.revision, coaching.id, ["acceptanceCriteria", "context"]);
    assert.equal(after.brief.version, 2);
    const kept = (content: typeof after.brief.content) => JSON.stringify([content.checks, content.acceptanceCases, content.baseline, content.frozen, content.sources, content.executionPolicy]);
    assert.deepEqual(
      [after.brief.content.goal, after.brief.content.acceptanceCriteria, after.brief.content.context, kept(after.brief.content), after.summary.state, after.attempts.length],
      [VAGUE.goal, ["A 5 km run logged in miles shows its record in kilometres", "A run with no unit is left out"], "Today, a run logged in miles is compared as if it were in kilometres.", kept(before.brief.content), "draft", 0],
      "only the ticked fields changed; what a run is judged by, the state and the runs didn't",
    );
    const [saved] = host.coachings(taskId);
    assert.deepEqual([saved?.applied, saved?.stale], [{ briefVersion: 2, fields: ["acceptanceCriteria", "context"], at: saved?.applied?.at }, []]);
    assert.ok(saved?.changes.every((change) => change.blocked === "Changes from this answer were saved already."));
    await assert.rejects(host.acceptCoachChanges(taskId, after.revision, coaching.id, ["goal"]), /saved already/);
    assert.deepEqual([host.task(taskId).versions.length, coachRequests(stub).length], [2, 1], "one new version, and no model call for saving");
  });

  it("refuses to start once the brief, the title or the preferences changed since the preview, and sends nothing", async () => {
    const stub = await stubFor();
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const { host } = hostAt(root, stub.url);
    const task = await host.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    let preview = await host.prepareCoach(taskId, NONE);
    await host.renameTask(taskId, host.task(taskId).revision, "Records use one unit");
    await assert.rejects(host.startCoach(taskId, NONE, preview.expected), CHANGED);
    preview = await host.prepareCoach(taskId, NONE);
    host.addPreference({ statement: "Prefer small PRs", scope: "personal", projectId: null, intent: "default" });
    await assert.rejects(host.startCoach(taskId, NONE, preview.expected), CHANGED);
    preview = await host.prepareCoach(taskId, NONE);
    await host.reviseBrief(taskId, host.task(taskId).revision, { ...VAGUE, scope: "The records page" });
    await assert.rejects(host.startCoach(taskId, NONE, preview.expected), CHANGED);
    assert.deepEqual([stub.requests.length, host.coachings(taskId).length], [0, 0]);
  });

  it("needs a project's sharing, refuses a removed project, and refuses a credential anywhere in what it would send", async () => {
    const stub = await stubFor();
    const { root, projectId } = rootWithProject(false);
    const { host, keys } = hostAt(root, stub.url);
    const task = await host.createTask({ title: "Personal records use one unit", fields: { ...VAGUE, context: "The token is plain-secret-value-0123456789" }, projectId, planId: null });
    const taskId = task.summary.id;
    const off = await host.prepareCoach(taskId, NONE);
    assert.match(off.blocked ?? "", /doesn't allow sending its content to Token Factory/);
    await assert.rejects(host.startCoach(taskId, NONE, off.expected), /doesn't allow sending its content/);
    // A value that is now a saved key, already in the brief: refused by name of the part, never quoted.
    keys.current = { NEBIUS_API_KEY: "plain-secret-value-0123456789" };
    await assert.rejects(host.prepareCoach(taskId, NONE), (error: Error) => /context/i.test(error.message) && !error.message.includes("plain-secret-value"));
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.removeProject(projectId);
    await assert.rejects(host.prepareCoach(taskId, NONE), /repository was removed/);
    assert.equal(stub.requests.length, 0);
  });

  it("refuses a stale save with the brief unchanged (a rename, a move to another repository) and after a manual save, changing nothing", async () => {
    const stub = await stubFor();
    const { root, projectId } = rootWithProject(true);
    const { host } = hostAt(root, stub.url);
    const task = await host.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    // A rename: the title was sent, and no brief version is made.
    await ask(host, taskId);
    const renamed = await ended(host, taskId);
    await host.renameTask(taskId, host.task(taskId).revision, "Records use one unit");
    assert.ok(host.coachings(taskId)[0]?.stale.some((line) => line.includes("is now called")));
    await assert.rejects(host.acceptCoachChanges(taskId, host.task(taskId).revision, renamed.id, ["goal"]), /is now called/);
    // A move to a repository that clears nothing makes no brief version either.
    await ask(host, taskId);
    const moved = await ended(host, taskId);
    host.setTaskProject(taskId, host.task(taskId).revision, projectId);
    await assert.rejects(host.acceptCoachChanges(taskId, host.task(taskId).revision, moved.id, ["goal"]), /repository changed since the coach read it/);
    // A manual save after the answer.
    host.setTaskProject(taskId, host.task(taskId).revision, null);
    await ask(host, taskId);
    const manual = await ended(host, taskId);
    await host.reviseBrief(taskId, host.task(taskId).revision, { ...VAGUE, scope: "The records page" });
    await assert.rejects(host.acceptCoachChanges(taskId, host.task(taskId).revision, manual.id, ["goal"]), /^Error: Your brief changed since the coach read it: it read v1, and the brief is now at v2\. Nothing was changed\./);
    assert.deepEqual([host.task(taskId).brief.version, host.task(taskId).brief.content.goal], [2, VAGUE.goal], "nothing the coach proposed was saved");
  });

  it("leaves neither the version nor the applied mark when the save fails between them, then saves once it can", async () => {
    const stub = await stubFor();
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    let fail = true;
    const { host } = hostAt(root, stub.url, {
      coachApplying: () => {
        if (fail) throw new Error("A fault between the new version and the applied mark.");
      },
    });
    const task = await host.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    await ask(host, taskId);
    const coaching = await ended(host, taskId);
    const revision = host.task(taskId).revision;
    await assert.rejects(host.acceptCoachChanges(taskId, revision, coaching.id, ["goal"]), /A fault between/);
    assert.deepEqual([host.task(taskId).versions.length, host.task(taskId).revision, host.coachings(taskId)[0]?.applied], [1, revision, null], "both or neither");
    fail = false;
    const saved = await host.acceptCoachChanges(taskId, revision, coaching.id, ["goal"]);
    assert.deepEqual([saved.brief.version, saved.brief.content.goal], [2, "Records compare finish times in one unit"]);
  });

  it("keeps the saving transaction free of any await, for the coach's save and the editor's alike", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/main/host.ts", import.meta.url)), "utf8");
    for (const method of ["async acceptCoachChanges(", "async reviseBrief("]) {
      const start = source.indexOf(method);
      const body = source.slice(source.indexOf("workspace.tx(() => {", start), source.indexOf("\n    });", start));
      assert.ok(body.length > 0 && !/\bawait\b|\.then\(/.test(body), `${method} awaits inside its transaction`);
    }
  });

  it("can't save a change whose words were masked, and keeps a ready task ready", async () => {
    const stub = await stubFor(() => toolCall(COACH_TOOL, { ...ANSWER, changes: [{ field: "scope", text: `Use the key ${KEY} for the records page`, reason: "", refs: [] }, ANSWER.changes[0]] }));
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const { host } = hostAt(root, stub.url);
    const task = await host.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    host.setTaskState(taskId, host.task(taskId).revision, "ready");
    await ask(host, taskId);
    const coaching = await ended(host, taskId);
    const scope = coaching.changes.find((change) => change.field === "scope");
    assert.deepEqual([scope?.change.usable, scope?.blocked?.startsWith("Some of its words looked like a credential")], [false, true]);
    assert.equal(JSON.stringify(coaching).includes(KEY), false, "the key is kept nowhere");
    await assert.rejects(host.acceptCoachChanges(taskId, host.task(taskId).revision, coaching.id, ["scope"]), /masked as a possible credential/);
    const saved = await host.acceptCoachChanges(taskId, host.task(taskId).revision, coaching.id, ["goal"]);
    assert.deepEqual([saved.summary.state, saved.brief.version], ["ready", 2], "the coach never moves the task's state");
  });

  it("refuses moving or deleting a task while the coach answers, and stops the coaching when sharing goes off; nothing is sent again", async () => {
    const stub = await stubFor(() => ({ ...toolCall(COACH_TOOL, ANSWER), delayMs: 15_000 }));
    const { root, projectId } = rootWithProject(true);
    const { host } = hostAt(root, stub.url);
    const task = await host.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId, planId: null });
    const taskId = task.summary.id;
    await ask(host, taskId);
    await waitFor(() => coachRequests(stub).length === 1, "the coach's request").catch((error: Error) => {
      throw new Error(`${error.message}: ${JSON.stringify(host.coachings(taskId).map((one) => [one.status, one.note, one.unresolved]))}`);
    });
    assert.throws(() => host.deleteTask(taskId), /The coach is still answering about this task\. Cancel it/);
    assert.throws(() => host.setTaskProject(taskId, host.task(taskId).revision, null), /The coach is still answering about this task\. Wait for it/);
    await assert.rejects(ask(host, taskId), /The coach is still answering about this task/);
    await host.setSharing(projectId, false);
    const stopped = await ended(host, taskId);
    assert.deepEqual([stopped.status, stopped.note], ["cancelled", "Stopped: sharing for this task's project was turned off. Nothing was resent, and your brief is unchanged."]);
    assert.equal(coachRequests(stub).length, 1);
    host.deleteTask(taskId);
  });

  it("refuses a finding ticked twice before anything is worked out, stored or sent, and sends one ticked once", async () => {
    const stub = await stubFor();
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const seeded = seedMission(join(root, "workspace.db"), {
      mission: { name: "Trustworthy records", intendedUsers: "Runners", outcome: "Records compare like with like.", successCriteria: [], constraints: [], nonGoals: [] },
      tasks: [{ title: "Personal records use one unit", goal: "Fix the PR detection bug", acceptanceCriteria: ["It works"] }],
    });
    const { reviewId } = seedMissionReview(join(root, "workspace.db"), {
      missionId: seeded.missionId,
      taskIds: seeded.taskIds,
      findings: [{ role: "architecture", title: "Units aren't stored", detail: "Older runs have no unit.", recommendation: "Say what happens to them.", refs: ["T1"] }],
    });
    const { host } = hostAt(root, stub.url);
    const taskId = seeded.taskIds[0]!;
    const ref = { reviewId, findingId: "arch-1" };
    for (const call of [() => host.prepareCoach(taskId, { mission: false, findings: [ref, ref] }), () => host.startCoach(taskId, { mission: false, findings: [ref, ref] }, "a".repeat(64))]) {
      await assert.rejects(call(), /^Error: Tick each finding once, then ask the coach\.$/);
    }
    assert.deepEqual([host.coachings(taskId).length, stub.requests.length], [0, 0]);
    const once = await host.prepareCoach(taskId, { mission: true, findings: [ref] });
    assert.deepEqual([once.options.findings.map((finding) => finding.findingId), once.text.includes("F1"), once.text.includes("F2"), once.text.includes("Mission (M), v1: Trustworthy records")], [["arch-1"], true, false, true]);
    await host.startCoach(taskId, { mission: true, findings: [ref] }, once.expected);
    const coaching = await ended(host, taskId);
    assert.deepEqual([coaching.status, coaching.sent.findings, coaching.sent.mission?.name, coaching.stale], ["answered", 1, "Trustworthy records", []]);
  });

  it("stops a coaching when its task's project is removed, says why, and sends nothing again", async () => {
    const stub = await stubFor(() => ({ ...toolCall(COACH_TOOL, ANSWER), delayMs: 15_000 }));
    const { root, projectId } = rootWithProject(true);
    const { host } = hostAt(root, stub.url);
    const task = await host.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId, planId: null });
    const taskId = task.summary.id;
    await ask(host, taskId);
    await waitFor(() => coachRequests(stub).length === 1, "the coach's request");
    await host.removeProject(projectId);
    const stopped = await ended(host, taskId);
    assert.deepEqual([stopped.status, stopped.note], ["cancelled", "Stopped: the task's project was removed. Nothing was resent, and your brief is unchanged."]);
    assert.equal(coachRequests(stub).length, 1);
  });

  it("reads a coaching left open by a quit as interrupted after a restart, keeps the brief, and sends nothing again", async () => {
    const stub = await stubFor(() => ({ ...toolCall(COACH_TOOL, ANSWER), delayMs: 30_000 }));
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const first = hostAt(root, stub.url).host;
    const task = await first.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    await ask(first, taskId);
    await waitFor(() => coachRequests(stub).length === 1, "the coach's request");
    await first.shutdown();
    const second = hostAt(root, stub.url).host;
    const ended2 = await ended(second, taskId);
    assert.deepEqual([ended2.status, ended2.note?.startsWith("Interrupted: Nivra or its engine stopped before the coach answered."), second.task(taskId).brief.version], ["interrupted", true, 1]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(coachRequests(stub).length, 1, "nothing was sent again");
  });

  it("finds a coaching whose start answer was lost by its request id after a restart, keeps its report, and sends it once", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    // The gated engine records the run when it is asked to (`accept`) and holds its answer (no `release`): the answer is lost.
    writeFileSync(join(home, "accept"), "");
    const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
    const first = hostAt(root, "http://127.0.0.1:9/v1", undefined, GATED).host;
    const task = await first.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    await ask(first, taskId);
    await waitFor(() => calls().includes("runs.start"), "the coaching's request to reach the engine");
    await first.shutdown();
    const second = hostAt(root, "http://127.0.0.1:9/v1", undefined, GATED).host;
    const coaching = await ended(second, taskId);
    assert.deepEqual([coaching.status, coaching.report?.summary, calls().includes("runs.find"), calls().filter((call) => call === "runs.start").length], ["answered", "A gated coaching.", true, 1]);
    const saved = await second.acceptCoachChanges(taskId, second.task(taskId).revision, coaching.id, ["goal"]);
    assert.equal(saved.brief.content.goal, "A gated goal");
  });

  it("keeps its report after a restart, still savable, and the applied mark after another", async () => {
    const stub = await stubFor();
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const first = hostAt(root, stub.url).host;
    const task = await first.createTask({ title: "Personal records use one unit", fields: VAGUE, projectId: null, planId: null });
    const taskId = task.summary.id;
    await ask(first, taskId);
    const coaching = await ended(first, taskId);
    await first.shutdown();
    const second = hostAt(root, stub.url).host;
    const [again] = second.coachings(taskId);
    assert.deepEqual([again?.status, again?.report?.outcome, again?.changes.length, again?.stale], ["answered", "complete", 3, []]);
    await second.acceptCoachChanges(taskId, second.task(taskId).revision, coaching.id, ["goal"]);
    await second.shutdown();
    const third = hostAt(root, stub.url).host;
    assert.deepEqual(third.coachings(taskId)[0]?.applied?.fields, ["goal"]);
    assert.equal(coachRequests(stub).length, 1, "nothing was sent again");
  });

  it("refuses to save an answer from another version of the coach, and says so", async () => {
    const stub = await stubFor();
    const root = mkdtempSync(join(tmpdir(), "nivra coach ü%# "));
    dirs.push(root);
    const opening = openWorkspace(join(root, "workspace.db")) as Extract<WorkspaceOpening, { state: "ready" }>;
    const taskId = randomUUID();
    const AT = "2026-10-28T01:00:00.000Z";
    insertTask(opening.db, { id: taskId, title: "Personal records use one unit", projectId: null, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: briefFrom(VAGUE), derivedFrom: null });
    const brief = versionsOf(opening.db, taskId).at(-1)!;
    const coachingId = randomUUID();
    const older = { id: "task-readiness-coach" as const, version: 2 };
    const binding = { mission: null, tasks: [{ taskId, briefId: brief.id, briefVersion: 1, briefSha256: brief.sha256, title: "Personal records use one unit" }], findings: [], specialists: [older] };
    insertCoaching(
      opening.db,
      { id: coachingId, taskId, briefId: brief.id, briefVersion: 1, briefSha256: brief.sha256, title: "Personal records use one unit", projectId: null, binding, bindingDigest: "b".repeat(64), packetDigest: "c".repeat(64), preferencesDigest: "d".repeat(64), profile: older, mission: null, findings: 0, preferences: 0, createdAt: AT },
      { sessionId: "s", targetId: "local", preferences: [] },
    );
    const report = reportFor({ profile: older, taskId, changes: [{ field: "goal", text: "Records compare finish times in one unit", reason: "", refs: [], usable: true }] });
    settleCoaching(opening.db, coachingId, { status: "answered" }, report, AT);
    opening.db.close();
    const { host } = hostAt(root, stub.url);
    assert.ok(host.coachings(taskId)[0]?.stale.includes("This answer came from an earlier version of the coach. Nothing was changed. Ask the coach again for an answer from this one."));
    await assert.rejects(host.acceptCoachChanges(taskId, host.task(taskId).revision, coachingId, ["goal"]), /earlier version of the coach/);
    assert.equal(host.task(taskId).brief.version, 1);
  });

  it("never stands in for a task's run: an undecided proposal still shows Review and blocks a run, beside a newer coaching", async () => {
    const stub = await stubFor();
    const { root, projectId } = rootWithProject(true);
    // A task whose run proposed a change the person hasn't decided on, and a coaching after it, written as the app would.
    const opening = openWorkspace(join(root, "workspace.db")) as Extract<WorkspaceOpening, { state: "ready" }>;
    const taskId = randomUUID();
    const AT = "2026-10-28T01:00:00.000Z";
    insertTask(opening.db, { id: taskId, title: "Personal records use one unit", projectId, createdAt: AT, updatedAt: AT }, { id: randomUUID(), content: briefFrom(VAGUE), derivedFrom: null });
    opening.db.db.prepare("UPDATE tasks SET state = 'ready' WHERE id = ?").run(taskId);
    const brief = versionsOf(opening.db, taskId).at(-1)!;
    const attempt = randomUUID();
    insertAttempt(opening.db, { id: attempt, taskId, briefId: brief.id, sessionId: "s", targetId: "wsl:Test", status: "answered", createdAt: AT });
    recordOutcome(opening.db, attempt, { outcome: "proposed", verified: true, proposalHash: "5".repeat(64), baseline: "a".repeat(40) }, AT);
    const coachingId = randomUUID();
    const binding = { mission: null, tasks: [{ taskId, briefId: brief.id, briefVersion: 1, briefSha256: brief.sha256, title: "Personal records use one unit" }], findings: [], specialists: [{ id: "task-readiness-coach" as const, version: 1 }] };
    const LATER = "2026-10-28T02:00:00.000Z";
    insertCoaching(
      opening.db,
      { id: coachingId, taskId, briefId: brief.id, briefVersion: 1, briefSha256: brief.sha256, title: "Personal records use one unit", projectId, binding, bindingDigest: "b".repeat(64), packetDigest: "c".repeat(64), preferencesDigest: "d".repeat(64), profile: { id: "task-readiness-coach", version: 1 }, mission: null, findings: 0, preferences: 0, createdAt: LATER },
      { sessionId: "s", targetId: "wsl:Test", preferences: [] },
    );
    settleCoaching(opening.db, coachingId, { status: "answered" }, null, LATER);
    opening.db.close();
    const { host } = hostAt(root, stub.url);
    const view = host.task(taskId);
    assert.deepEqual([view.summary.state, view.runBlocked, view.attempts.map((one) => one.id)], ["review", "Decide on the last run's change first: approve it, reject it, or ask for a revision.", [attempt]]);
    assert.equal(host.coachings(taskId).length, 1);
  });
});

/** A coach report as an engine would save it, for coachings written straight into a workspace. */
function reportFor(overrides: Partial<CoachReport> = {}): CoachReport {
  return {
    profile: { id: "task-readiness-coach", version: 1 },
    instructionsSha256: "a".repeat(64),
    taskId: randomUUID(),
    briefVersion: 1,
    bindingDigest: "b".repeat(64),
    packetDigest: "c".repeat(64),
    preferencesDigest: "d".repeat(64),
    outcome: "complete",
    scope: "general",
    packet: { chars: 100, criteria: 1, assumptions: 0, gaps: 0, mission: false, findings: 0 },
    summary: "",
    questions: [],
    changes: [],
    suggestedChecks: [],
    unknowns: [],
    dropped: { questions: 0, changes: 0, items: 0, refs: 0, checks: 0, unknowns: 0 },
    stage: { status: "answered", reason: null, kind: null, message: null, problems: [], requests: 1, estimatedInputTokens: 100, inputTokens: null, outputTokens: null, elapsedMs: 10, finishReason: null, servedModel: null },
    request: { runId: randomUUID(), clientRequestId: randomUUID() },
    route: null,
    sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" },
    preferences: { revision: 0, digest: "d".repeat(64), records: [] },
    usage: { inputTokens: null, outputTokens: null, calls: 1, reportedCalls: 0 },
    budget: { limits: { requests: 1, totalMs: 180_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 60_000 }, used: { requests: 1, elapsedMs: 10, inputTokens: 100, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: 1, overrunTokens: 0 }, stopped: null },
    elapsedMs: 10,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

