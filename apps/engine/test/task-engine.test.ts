import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isTerminal, taskBriefDigest, type ApplyParams, type ApplyView, type EngineInfo, type RunSummary, type SandboxStatus, type TaskBrief, type TaskPreview, type TaskReport } from "@nivra/domain";
import { CHECK_IMAGE } from "../src/exec/check.ts";
import { operationsFor } from "../src/task/limits.ts";
import { TASK_STOP_MESSAGES } from "../src/task/report.ts";
import { FIXED_GREET, TASK_BRIEF, TASK_FIX, TASK_FIXTURE } from "../scripts/task-fixture.ts";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { RealGuest } from "./real-guest.ts";
import { startSandboxStub, type SandboxStub } from "./stub-sandboxes.ts";
import { httpError, startStub, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";
import { changedSince, cleanUp, folderState, git, repoWith } from "./workspace-fixtures.ts";

/**
 * A task run through a real engine over stdio (NIV-7, D39): the production adapter against a stand-in for Nebius
 * Sandboxes whose guest really runs each command, and a stand-in for Token Factory whose model calls the worker's tools
 * in a set order. What a run is bound to and what goes where, the refusals that send nothing, one task at a time and
 * its own slot, a cancel, the recovery guard, a restart, and what is kept where. Nothing reaches the network, and no
 * real model is called.
 */
const KEY = "nivra-task-engine-key-0123456789";
const PROJECT_ID = "project-e00taskenginetest0";
const CREDENTIALS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };
const FILES: Record<string, string> = Object.fromEntries(TASK_FIXTURE.map((file) => [file.path, String(file.bytes)]));
const BRIEF: TaskBrief = TASK_BRIEF;
const TASK_ID = randomUUID();
const PROJECT = randomUUID();

type Call = [tool: string, input: Record<string, unknown>];
/** What the model stand-in does by default: read, fix, run the case, hand in. */
const WORK: Call[] = [["read_file", { path: "greet.sh" }], ["edit_file", TASK_FIX], ["run_case", { number: 1 }], ["submit", { summary: "Defaulted the name to world." }]];

const engines: EngineProcess[] = [];
const stubs: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});

interface Setup {
  sandbox: SandboxStub<RealGuest>;
  model: Stub;
  guest: RealGuest;
  engine: EngineProcess;
  info: EngineInfo;
  home: string;
  repo: string;
}

function engineAt(home: string, sandbox: SandboxStub<RealGuest>, model: Stub): EngineProcess {
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--sandboxes-url", sandbox.url, "--token-factory-url", model.url] });
  engines.push(engine);
  return engine;
}

async function setup(options: { credentials?: boolean; calls?: Call[]; files?: Record<string, string>; chat?: (request: StubRequest, index: number) => Reply } = {}): Promise<Setup> {
  const guest = new RealGuest(CHECK_IMAGE.uuid);
  guest.busybox = true;
  const sandbox = await startSandboxStub({ guest });
  const calls = options.calls ?? WORK;
  const model = await startStub({ chat: options.chat ?? ((_request, index) => toolCall(calls[Math.min(index, calls.length - 1)]![0], calls[Math.min(index, calls.length - 1)]![1], { id: `call_${index}` })) });
  stubs.push(sandbox, model);
  const root = tempDir("nivra task engine");
  dirs.push(root);
  const home = join(root, "home");
  const engine = engineAt(home, sandbox, model);
  const info = await engine.initialize(options.credentials === false ? {} : CREDENTIALS);
  return { sandbox, model, guest, engine, info, home, repo: repoWith(options.files ?? FILES) };
}

const preview = (engine: EngineProcess, repo: string, brief: TaskBrief = BRIEF): Promise<TaskPreview> => engine.client.call("task.preview", { repoPath: repo, brief });
const ready = (shown: TaskPreview) => {
  assert.equal(shown.status, "ready", JSON.stringify(shown).slice(0, 300));
  return shown as Extract<TaskPreview, { status: "ready" }>;
};
async function start(engine: EngineProcess, repo: string, fingerprint: string, options: { brief?: TaskBrief; sharing?: { modelContext: boolean; cloudExecution: boolean }; requestId?: string; briefDigest?: string } = {}): Promise<RunSummary> {
  const brief = options.brief ?? BRIEF;
  return engine.client.call("runs.start", {
    clientRequestId: options.requestId ?? randomUUID(),
    workflowId: "task",
    input: { repoPath: repo, project: PROJECT, target: "local", preview: fingerprint, taskId: TASK_ID, briefVersion: 2, briefDigest: options.briefDigest ?? (await taskBriefDigest(brief)) },
    context: { sharing: options.sharing ?? { modelContext: true, cloudExecution: true }, brief },
  });
}
const ended = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 60_000);
const report = async (engine: EngineProcess, runId: string): Promise<TaskReport> => (await engine.client.call("runs.task", { runId }))!;
const spawns = (stub: SandboxStub<RealGuest>) => stub.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances");
const spawned = (stub: SandboxStub<RealGuest>, name: string) => spawns(stub).filter((request) => request.body.includes(name)).length;
const verdicts = (shown: TaskReport) => shown.checks.map((check) => `${check.kind} ${check.number} ${check.verdict}`);

/** A finished run's proposal, and the approval of it the host would send: bound to the attempt, this engine and the brief. */
async function proposedRun(setup: Setup): Promise<{ run: RunSummary; done: TaskReport; params: ApplyParams }> {
  const shown = ready(await preview(setup.engine, setup.repo));
  const run = await start(setup.engine, setup.repo, shown.snapshot.fingerprint);
  await ended(setup.engine, run.id);
  const done = await report(setup.engine, run.id);
  assert.equal(done.outcome, "proposed", done.stopped?.message ?? "");
  const task = { attempt: { taskId: TASK_ID, attemptId: done.request.clientRequestId, runId: run.id }, engine: { homeId: setup.info.homeId }, brief: { version: 2, sha256: await taskBriefDigest(BRIEF) } };
  return { run, done, params: { requestId: randomUUID(), runId: run.id, approvedHash: done.proposal!.hash, repoPath: setup.repo, project: PROJECT, target: "local", task } };
}
const apply = (engine: EngineProcess, params: ApplyParams): Promise<ApplyView> => engine.client.call("task.apply", params);

describe("applying a task's proposal through a real engine (NIV-8, D40)", () => {
  it("applies the approved proposal on its own engine: checked again, written unstaged, kept by its request id, settled as accepted, never applied twice", async () => {
    const setup_ = await setup();
    const { engine, repo } = setup_;
    const { params } = await proposedRun(setup_);
    const applied = await apply(engine, params);
    assert.deepEqual([applied.status, applied.paths.map((one) => `${one.path} ${one.change} ${one.place}`), applied.refusal, applied.recovery], ["applied", ["greet.sh changed post"], null, `nivra-apply/${applied.applyId}`]);
    assert.deepEqual([readFileSync(join(repo, "greet.sh"), "utf8"), git(repo, ["diff", "--cached", "--name-only"]), git(repo, ["status", "--porcelain"])], [FIXED_GREET, "", " M greet.sh\n"]);
    // The same request again: the same apply, and nothing written twice. Read back by its request id, as after a restart.
    const before = folderState(repo);
    assert.equal((await apply(engine, params)).applyId, applied.applyId);
    assert.equal((await engine.client.call("task.applyStatus", { requestId: params.requestId }))?.status, "applied");
    assert.equal(await engine.client.call("task.applyStatus", { requestId: randomUUID() }), null);
    // Another approval of the same proposal is refused, in Nivra's words, and kept as such.
    const twice = await apply(engine, { ...params, requestId: randomUUID() });
    assert.deepEqual([twice.status, twice.refusal?.code, twice.refusal?.message.includes(repo)], ["refused", "duplicate", false]);
    assert.deepEqual(changedSince(before, repo), []);
    // Accepted: the folder is free and the change stays. Every copy is kept, the original among them.
    const accepted = await engine.client.call("task.dismiss", { applyId: applied.applyId, as: "accepted" });
    const recovery = join(repo, ".git", "nivra-apply", applied.applyId);
    assert.deepEqual([accepted.resolution, readdirSync(recovery), existsSync(join(repo, ".git", "nivra-apply", "lock")), readFileSync(join(repo, "greet.sh"), "utf8")], ["accepted", ["new-0", "orig-0"], false, FIXED_GREET]);
    assert.equal(readFileSync(join(recovery, "orig-0"), "utf8"), FILES["greet.sh"]);
  });

  it("refuses an apply that isn't the approved proposal, or whose checkout moved or was edited, writing nothing, in Nivra's words", async () => {
    const setup_ = await setup();
    const { engine, repo } = setup_;
    const { params } = await proposedRun(setup_);
    const before = folderState(repo);
    const wrongHash = await apply(engine, { ...params, requestId: randomUUID(), approvedHash: "0".repeat(64) });
    const otherEngine = await apply(engine, { ...params, requestId: randomUUID(), task: { ...params.task, engine: { homeId: randomUUID() } } });
    assert.deepEqual([wrongHash.refusal?.code, otherEngine.refusal?.code], ["proposal", "proposal"]);
    writeFileSync(join(repo, "greet.sh"), "edited\n");
    const edited = await apply(engine, { ...params, requestId: randomUUID() });
    assert.deepEqual([edited.status, edited.refusal?.code], ["refused", "uncommitted"]);
    git(repo, ["checkout", "--", "greet.sh"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "moved"]);
    const moved = await apply(engine, { ...params, requestId: randomUUID() });
    assert.deepEqual([moved.status, moved.refusal?.code], ["refused", "baseline-moved"]);
    for (const refused of [wrongHash, otherEngine, edited, moved]) assert.ok(!refused.refusal!.message.includes("/"), refused.refusal!.message);
    // Only greet.sh's edit and its checkout, and the new commit, ever touched the repository: nothing of an apply did.
    assert.equal(readFileSync(join(repo, "greet.sh"), "utf8"), FILES["greet.sh"]);
    assert.ok(!existsSync(join(repo, ".git", "nivra-apply")), "an apply made something in the git folder");
    assert.ok(changedSince(before, repo).every((name) => name === "." || name === "greet.sh" || name.startsWith(".git")), changedSince(before, repo).join(", "));
  });
});

describe("a task run through a real engine (NIV-7)", () => {
  it("goes on to collect and judge when the provider fails partway, and never sends the failed request again", async () => {
    // The worker reads and fixes greet.sh; Token Factory then answers its third request with an error.
    const { sandbox, model, engine, repo } = await setup({ chat: (_request, index) => (index < 2 ? toolCall(WORK[index]![0], WORK[index]![1], { id: `call_${index}` }) : httpError(500, "the provider is down")) });
    const shown = ready(await preview(engine, repo));
    const run = await start(engine, repo, shown.snapshot.fingerprint);
    const page = await ended(engine, run.id);
    const done = await report(engine, run.id);
    assert.deepEqual([page.status, done.outcome, done.worker?.ended, done.worker?.handedIn, done.worker?.failure, done.worker?.written], ["succeeded", "proposed", "model-failed", false, "provider", ["greet.sh"]]);
    // Nivra's own checks of the change, apart from the worker's failure.
    assert.deepEqual([verdicts(done), done.verified, spawned(sandbox, "nivra-collect")], [["case 1 passed", "check 1 passed"], true, 1]);
    // The bounds it ran under, beside what it used: a brief of one case, one check and no baseline (D41).
    assert.deepEqual([done.limits?.operations, done.limits?.baselineChecks, done.environment, done.baseline], [17, 0, null, []]);
    assert.equal(model.chats().length, 3, "the request that failed was sent again");
  });

  it("previews what a run would send with no network, the programs it looks for and its bounds, and refuses a commit holding the vault's key", async () => {
    const { sandbox, model, engine, repo } = await setup();
    const shown = ready(await preview(engine, repo));
    assert.deepEqual([shown.snapshot.files, shown.programs, shown.unprobed, shown.caseFiles], [2, [".", "/bin/sh"], 0, [{ number: 1, files: ["greet.sh"], unclear: false }]]);
    assert.deepEqual([shown.limits.operations, shown.limits.sessionMinutes, shown.limits.runMinutes, shown.limits.writes, shown.limits.writeBytes], [operationsFor(2), 20, 33, 8, 32_768]);
    assert.match(shown.snapshot.retention, /^Images are retained for 180 days/);
    // A first word that isn't a plain program is never guessed: it runs, and isn't looked for.
    const quoted = ready(await preview(engine, repo, { ...BRIEF, checks: ['"./check.sh"'] }));
    assert.deepEqual([quoted.programs, quoted.unprobed], [["."], 1]);
    // A case's script named in quotes is named as written; a case whose command can't be read is said to be unclear.
    const cases = [{ ...BRIEF.acceptanceCases[0]!, command: "/bin/sh 'check.sh'" }, { ...BRIEF.acceptanceCases[0]!, name: "unclear", command: '/bin/sh -c "$(cat check.sh)"' }];
    const warned = ready(await preview(engine, repo, { ...BRIEF, acceptanceCases: cases }));
    assert.deepEqual(warned.caseFiles, [{ number: 1, files: ["check.sh"], unclear: false }, { number: 2, files: [], unclear: true }]);
    const leaky = repoWith({ ...FILES, "deploy/token.txt": `${KEY}\n` });
    const refused = await preview(engine, leaky);
    assert.deepEqual(refused.status === "refused" ? [refused.code, refused.message.includes(KEY)] : null, ["content", false]);
    assert.deepEqual([sandbox.requests.length, model.requests.length], [0, 0], "a preview sends nothing anywhere");
  });

  it("runs the worker on the production adapter: it fixes the fixture, Nivra judges every case and check, and the change is proposed and kept exactly, the checkout untouched", async () => {
    const { sandbox, model, engine, home, repo } = await setup();
    const before = folderState(repo);
    const shown = ready(await preview(engine, repo));
    const run = await start(engine, repo, shown.snapshot.fingerprint);
    const page = await ended(engine, run.id);
    assert.equal(page.status, "succeeded", JSON.stringify(page.events.map((event) => event.message)).slice(0, 800));
    const done = await report(engine, run.id);
    assert.deepEqual([done.outcome, done.stopped, done.verified, verdicts(done)], ["proposed", null, true, ["case 1 passed", "check 1 passed"]]);
    assert.deepEqual([done.worker?.handedIn, done.worker?.summary, done.worker?.written, done.worker?.tools.writes], [true, "Defaulted the name to world.", ["greet.sh"], 1]);
    assert.deepEqual(done.toolchain, [{ program: ".", finding: "present" }, { program: "/bin/sh", finding: "present" }]);
    assert.deepEqual([done.task.taskId, done.task.attemptId, done.task.briefVersion, done.snapshot?.fingerprint], [TASK_ID, done.request.clientRequestId, 2, shown.snapshot.fingerprint]);
    assert.deepEqual([done.route?.endpoint, done.cleanup?.unresolved, done.cleanup?.retained?.uploads], ["loopback-test", [], 1]);
    // The proposal, as the person reads it, and as it was kept.
    const proposal = (await engine.client.call("runs.proposal", { runId: run.id }))!;
    assert.deepEqual([proposal.hash, proposal.paths.map((path) => `${path.change} ${path.path} ${path.after?.mode}`), proposal.truncated], [done.proposal?.hash, ["changed greet.sh 100644"], false]);
    assert.match(proposal.patch, /^\+ {2}printf 'Hello, %s\\n' "\$\{1:-world\}"$/m);
    assert.equal(proposal.patchBytes, done.proposal?.patchBytes);
    // The checkout, every name, mode, size, time and byte of it, .git included, is as it was.
    assert.deepEqual(changedSince(before, repo), []);
    // What reached Nebius: one upload, every operation with networking off, the credentials in headers only.
    assert.equal(sandbox.requests.filter((request) => request.path === "/v1/files").length, 1);
    assert.ok(spawns(sandbox).every((request) => (JSON.parse(request.body) as { networking: { enabled: boolean } }).networking.enabled === false), "every operation runs with networking off");
    assert.ok(sandbox.requests.every((request) => request.authorization === `Bearer ${KEY}` && request.project === PROJECT_ID), "each request carries the vault's key and project id");
    assert.ok(!sandbox.requests.some((request) => request.body.includes(KEY) || request.body.includes(PROJECT_ID) || request.body.includes(home)), "no body carries a credential or the engine's home");
    // What reached Token Factory: the worker's four requests with the vault's key, the brief in the first, and the
    // file the worker read in the second; never the key in a body.
    const chats = model.chats();
    assert.deepEqual([chats.length, chats.every((chat) => chat.authorization === `Bearer ${KEY}`), chats.some((chat) => chat.raw.includes(KEY))], [4, true, false]);
    assert.match(chats[0]!.raw, /greet with no name says Hello, world/);
    assert.match(chats[1]!.raw, /printf 'Hello, %s/);
    assert.deepEqual(((chats[0]!.body?.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort(), ["create_file", "edit_file", "list_files", "read_file", "run_case", "run_check", "submit"]);
    // Nothing of the key in the run's record, and the session's journal moved aside, with nothing open.
    assert.ok(!JSON.stringify(page.events).includes(KEY));
    assert.deepEqual([readdirSync(join(home, "sandbox")).filter((name) => name.endsWith(".jsonl")).length, readdirSync(join(home, "sandbox", "settled")).length], [0, 1]);
  });

  it("refuses without model sharing, without uploads, without the key and project id, for a brief that isn't the one named, and for a commit changed since its preview, sending nothing", async () => {
    const { sandbox, model, engine, repo } = await setup();
    const fingerprint = ready(await preview(engine, repo)).snapshot.fingerprint;
    const stopped = async (run: RunSummary) => {
      assert.equal((await ended(engine, run.id)).status, "failed");
      const shown = await report(engine, run.id);
      assert.equal((await engine.client.call("runs.get", { runId: run.id })).error, shown.stopped?.message);
      return [shown.outcome, shown.stopped?.code, shown.stopped?.step];
    };
    assert.deepEqual(await stopped(await start(engine, repo, fingerprint, { sharing: { modelContext: false, cloudExecution: true } })), ["refused", "model-sharing", "check"]);
    assert.deepEqual(await stopped(await start(engine, repo, fingerprint, { sharing: { modelContext: true, cloudExecution: false } })), ["refused", "consent", "check"]);
    assert.deepEqual(await stopped(await start(engine, repo, fingerprint, { briefDigest: "d".repeat(64) })), ["refused", "brief", "check"]);
    assert.deepEqual([sandbox.requests.length, model.requests.length], [0, 0], "a refused run sends nothing anywhere");
    // A commit changed since it was previewed is refused once the snapshot is taken, before the upload: only the model
    // list was asked for, which sends the key and nothing of the repository.
    const moved = await start(engine, repo, "e".repeat(64));
    assert.deepEqual(await stopped(moved), ["refused", "preview", "snapshot"]);
    assert.deepEqual([sandbox.requests.length, model.chats().length, (await report(engine, moved.id)).stopped?.message], [0, 0, TASK_STOP_MESSAGES.preview]);
    const none = await setup({ credentials: false });
    const unkeyed = await start(none.engine, none.repo, ready(await preview(none.engine, none.repo)).snapshot.fingerprint);
    assert.equal((await ended(none.engine, unkeyed.id)).status, "failed");
    assert.deepEqual([(await report(none.engine, unkeyed.id)).stopped?.code, none.sandbox.requests.length, none.model.requests.length], ["credentials", 0, 0]);
  });

  it("runs one task at a time on its own slot: a second is refused and never recorded, a repeated request gets its run, and other runs still start", async () => {
    const { sandbox, guest, engine, repo } = await setup();
    guest.override = ({ label }) => (label === "nivra-toolchain" ? { waits: true } : undefined);
    const fingerprint = ready(await preview(engine, repo)).snapshot.fingerprint;
    const requestId = randomUUID();
    const first = await start(engine, repo, fingerprint, { requestId });
    await waitFor(() => spawned(sandbox, "nivra-toolchain") === 1, { timeoutMs: 30_000, what: "the toolchain probe's spawn" });
    const second = randomUUID();
    await assert.rejects(start(engine, repo, fingerprint, { requestId: second }), /A task is already running on this engine, so another wasn't started\. Wait for it to end, or cancel it, then run this one again\./);
    assert.equal(await engine.client.call("runs.find", { clientRequestId: second }), null);
    assert.equal((await start(engine, repo, fingerprint, { requestId })).id, first.id, "a repeated request gets the run it started");
    // The task holds its own slot, not the two shared ones: two runs that hold a child process start beside it.
    const hello = () => engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: repo, holdMs: 20_000 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } });
    const helloes = [await hello(), await hello()];
    await waitFor(async () => (await Promise.all(helloes.map((run) => engine.client.call("runs.get", { runId: run.id })))).every((run) => run.status === "running"), { timeoutMs: 20_000, what: "both shared runs to start" });
    assert.equal((await engine.client.call("runs.get", { runId: first.id })).status, "running");
    for (const run of [first, ...helloes]) await engine.client.call("runs.cancel", { runId: run.id });
    assert.deepEqual(await Promise.all([first, ...helloes].map(async (run) => (await ended(engine, run.id)).status)), ["cancelled", "cancelled", "cancelled"]);
    const stopped = await report(engine, first.id);
    assert.deepEqual([stopped.outcome, stopped.proposal, stopped.cleanup?.stopped, stopped.cleanup?.unresolved], ["cancelled", null, 1, []]);
    assert.equal(await engine.client.call("runs.proposal", { runId: first.id }), null);
  });

  it("starts no recovery pass over the journal of a task under way when the key is saved, and refuses one asked for", async () => {
    const { sandbox, guest, engine, repo } = await setup();
    guest.override = ({ label }) => (label === "nivra-write" ? { waits: true } : undefined);
    const run = await start(engine, repo, ready(await preview(engine, repo)).snapshot.fingerprint);
    await waitFor(() => spawned(sandbox, "nivra-write") === 1, { timeoutMs: 30_000, what: "the write's spawn" });
    const status = (): Promise<SandboxStatus> => engine.client.call("sandbox.status", {});
    assert.deepEqual([(await status()).open.length, (await status()).pass.state], [0, "idle"], "the task's own journal reads as open work");
    await engine.client.call("secrets.update", { set: CREDENTIALS, remove: [] });
    assert.deepEqual([(await status()).pass.state, sandbox.requests.filter((request) => request.method === "DELETE").length], ["idle", 0]);
    await assert.rejects(engine.client.call("sandbox.recover", {}), /A sandbox check or a task is going on this engine\. Let it end, then try again\./);
    // The write under way is stopped by the person's cancel, never by a pass.
    await engine.client.call("runs.cancel", { runId: run.id });
    assert.equal((await ended(engine, run.id)).status, "cancelled");
    assert.equal(guest.service.operations.find((op) => JSON.stringify(op.body["args"] ?? []).includes("nivra-write"))?.cancelled, true);
    assert.deepEqual([(await status()).open.length, (await report(engine, run.id)).outcome], [0, "cancelled"]);
  });

  it("keeps a proposal across a restart, reads a run its engine died during as interrupted, and replays nothing", async () => {
    const { sandbox, model, guest, engine, home, repo } = await setup();
    const fingerprint = ready(await preview(engine, repo)).snapshot.fingerprint;
    const proposed = await start(engine, repo, fingerprint);
    assert.equal((await ended(engine, proposed.id)).status, "succeeded");
    const hash = (await report(engine, proposed.id)).proposal?.hash;
    guest.override = ({ label }) => (label === "nivra-toolchain" ? { waits: true } : undefined);
    const dying = await start(engine, repo, fingerprint);
    await waitFor(() => spawned(sandbox, "nivra-toolchain") === 2, { timeoutMs: 30_000, what: "the second run's probe" });
    engine.kill();
    await engine.exited;
    const sent = spawns(sandbox).length;
    const later = engineAt(home, sandbox, model);
    await later.initialize(CREDENTIALS);
    assert.deepEqual([(await later.client.call("runs.proposal", { runId: proposed.id }))?.hash, (await report(later, proposed.id)).outcome], [hash, "proposed"]);
    assert.deepEqual([(await later.client.call("runs.get", { runId: dying.id })).status, (await report(later, dying.id)).outcome], ["failed", "interrupted"]);
    const done = await waitFor(async () => {
      const status: SandboxStatus = await later.client.call("sandbox.status", {});
      return status.pass.state === "done" ? status : null;
    }, { timeoutMs: 30_000, what: "the recovery pass" });
    assert.deepEqual([done.pass.stopped, done.open.length, spawns(sandbox).length], [1, 0, sent], "the pass stops what was left running, and sends nothing again");
  });

  it("never sends a write that holds the sandbox's project id: the worker is told, the run goes on, and nothing of it reaches Nebius", async () => {
    // The project id names the account, so a commit may name it as infrastructure code does (D36), but a command
    // that holds it is never sent (D33): Nebius keeps every operation's arguments. The worker is told, and can go on.
    const naming = { ...TASK_FIX, new_text: `"\${1:-world}" # ${PROJECT_ID}` };
    const { sandbox, engine, repo } = await setup({ calls: [["edit_file", naming], ["submit", { summary: "Named the account." }]] });
    const run = await start(engine, repo, ready(await preview(engine, repo)).snapshot.fingerprint);
    assert.equal((await ended(engine, run.id)).status, "succeeded");
    const shown = await report(engine, run.id);
    assert.deepEqual([shown.outcome, shown.proposal, shown.worker?.written, shown.worker?.tools.refused, verdicts(shown)], ["unchanged", null, [], 1, ["case 1 failed", "check 1 failed"]]);
    // A write that was never sent is no step of the run's.
    assert.deepEqual(shown.steps.map((step) => step.label), ["toolchain", "collect", "final check", "final check"]);
    assert.ok(!sandbox.requests.some((request) => request.body.includes(PROJECT_ID)), "a request carried the project id");
    assert.equal(spawned(sandbox, "nivra-write"), 0);
  });
});
