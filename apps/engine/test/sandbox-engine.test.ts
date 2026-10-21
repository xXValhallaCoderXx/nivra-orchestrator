import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isTerminal, type RunSummary, type SandboxPreview, type SandboxReport, type SandboxStatus } from "@nivra/domain";
import { PROBE_SCRIPT, STOP_MESSAGES } from "../src/exec/check.ts";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { startSandboxStub, type SandboxStub } from "./stub-sandboxes.ts";
import { cleanUp, git, put, repoWith } from "./workspace-fixtures.ts";

/**
 * A sandbox check through a real engine over stdio (NIV-44, D36): the production adapter against a stand-in for Nebius
 * Sandboxes on this machine. Routing, consent, bounded results, cancellation, an uncertain submission, restart
 * reconciliation and unresolved cleanup, each seen from outside the engine. Nothing reaches the network.
 */
const KEY = "nivra-sandbox-engine-key-0123456789";
const PROJECT_ID = "project-e00sandboxenginetest";
const CREDENTIALS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };

const dirs: string[] = [];
const engines: EngineProcess[] = [];
const stubs: SandboxStub[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  for (const stub of stubs) await stub.close();
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});

function engineOn(stub: SandboxStub, home: string, env?: NodeJS.ProcessEnv): EngineProcess {
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--sandboxes-url", stub.url], ...(env ? { env } : {}) });
  engines.push(engine);
  return engine;
}

async function setup(options: { credentials?: boolean; env?: (root: string) => NodeJS.ProcessEnv } = {}) {
  const stub = await startSandboxStub();
  stubs.push(stub);
  const root = tempDir("nivra sandbox engine");
  dirs.push(root);
  const home = join(root, "home");
  const engine = engineOn(stub, home, options.env?.(root));
  await engine.initialize(options.credentials === false ? {} : CREDENTIALS);
  const repo = repoWith({ "README.md": "# A project\n", "src/app.ts": "export const app = 1;\n" });
  return { stub, engine, home, repo };
}

const project = randomUUID();
const preview = (engine: EngineProcess, repoPath: string): Promise<SandboxPreview> => engine.client.call("sandbox.preview", { repoPath });
const start = (engine: EngineProcess, repoPath: string, fingerprint: string, options: { consent?: boolean; requestId?: string } = {}): Promise<RunSummary> =>
  engine.client.call("runs.start", { clientRequestId: options.requestId ?? randomUUID(), workflowId: "sandbox", input: { repoPath, project, target: "local", preview: fingerprint }, context: { sharing: { cloudExecution: options.consent ?? true } } });
const ended = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
const report = async (engine: EngineProcess, runId: string): Promise<SandboxReport> => (await engine.client.call("runs.sandbox", { runId }))!;
const ready = (shown: SandboxPreview) => {
  assert.equal(shown.status, "ready", JSON.stringify(shown).slice(0, 300));
  return shown as Extract<SandboxPreview, { status: "ready" }>;
};
const spawns = (stub: SandboxStub) => stub.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances");
const probeSpawned = (stub: SandboxStub) => spawns(stub).some((request) => request.body.includes("nivra-probe"));

describe("a sandbox check through a real engine (NIV-44)", () => {
  it("previews what a check would send with no network, and refuses a commit holding the vault's own key, naming the file", async () => {
    const { stub, engine, repo } = await setup();
    const shown = ready(await preview(engine, repo));
    assert.deepEqual([shown.files, shown.prefix, shown.baseline, shown.leftOut.secret.count], [2, "", git(repo, ["rev-parse", "HEAD"]).trim(), 0]);
    assert.match(shown.fingerprint, /^[0-9a-f]{64}$/);
    assert.match(shown.retention, /^Images are retained for 180 days/);
    const leaky = repoWith({ "README.md": "# r\n", "deploy/secret.yaml": `data:\n  token: ${Buffer.from(KEY).toString("base64")}\n` });
    const refused = await preview(engine, leaky);
    assert.deepEqual(refused.status === "refused" ? [refused.code, /^deploy\/secret\.yaml in this commit holds what looks like a value Nivra keeps as a secret/.test(refused.message), refused.message.includes(KEY)] : null, ["content", true, false]);
    // The project id only names where uploads go, so a commit naming it, as infrastructure code does, isn't refused.
    const named = repoWith({ "README.md": "# r\n", "infra/main.tf": `resource "nebius_compute_v1_instance" "vm" {\n  parent_id = "${PROJECT_ID}"\n}\n` });
    assert.equal((await preview(engine, named)).status, "ready");
    assert.equal(stub.requests.length, 0, "a preview sends nothing");
  });

  it("runs a check on the production adapter: one upload, networking off throughout, the credentials in headers only, and a report bound to the preview", async () => {
    const { stub, engine, home, repo } = await setup();
    const shown = ready(await preview(engine, repo));
    const run = await start(engine, repo, shown.fingerprint);
    const page = await ended(engine, run.id);
    assert.equal(page.status, "succeeded", JSON.stringify(page.events.map((event) => event.message)).slice(0, 600));
    const checked = await report(engine, run.id);
    assert.deepEqual([checked.outcome, checked.stopped, checked.steps.map((step) => step.label), checked.snapshot?.fingerprint === shown.fingerprint], ["unchanged", null, ["probe", "collect"], true]);
    assert.match(checked.steps[0]?.stdoutTail ?? "", /^busybox: BusyBox v1\.36\.1 \(the fake guest\)\nfiles: 2\nlinks: 0\n$/);
    assert.deepEqual([checked.cleanup?.unresolved, checked.cleanup?.retained?.uploads, checked.proposal], [[], 1, null]);
    // What reached the service: one upload, three operations with networking off, the credentials in headers only.
    assert.deepEqual([stub.requests.filter((request) => request.path === "/v1/files").length, spawns(stub).length], [1, 3]);
    assert.ok(spawns(stub).every((request) => (JSON.parse(request.body) as { networking: { enabled: boolean } }).networking.enabled === false), "every operation runs with networking off");
    assert.ok(stub.requests.every((request) => request.authorization === `Bearer ${KEY}` && request.project === PROJECT_ID), "each request carries the vault's key and project id");
    assert.ok(!stub.requests.some((request) => request.body.includes(KEY) || request.body.includes(PROJECT_ID) || request.body.includes(home)), "no body carries a credential or the engine's home");
    // Nothing of the key in the run's record, and the session's journal moved aside, with nothing open.
    assert.ok(!JSON.stringify(page.events).includes(KEY));
    assert.deepEqual([readdirSync(join(home, "sandbox")).filter((name) => name.endsWith(".jsonl")).length, readdirSync(join(home, "sandbox", "settled")).length], [0, 1]);
  });

  it("refuses without upload consent, or without the key and project id, sending nothing; model-context consent never stands in", async () => {
    const { stub, engine, repo } = await setup();
    const shown = ready(await preview(engine, repo));
    const refused = await start(engine, repo, shown.fingerprint, { consent: false });
    assert.equal((await ended(engine, refused.id)).status, "failed");
    assert.equal((await engine.client.call("runs.get", { runId: refused.id })).error, STOP_MESSAGES.consent);
    assert.deepEqual((await report(engine, refused.id)).stopped, { code: "consent", step: "check", message: STOP_MESSAGES.consent });
    // The protocol itself refuses it, on either side: the same schema checks it before it is sent and when it arrives.
    await assert.rejects(
      engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "sandbox", input: { repoPath: repo, project, target: "local", preview: shown.fingerprint }, context: { sharing: { modelContext: true } } } as never),
      /Parameters for runs\.start do not match the protocol/,
    );
    const none = await setup({ credentials: false });
    const shownToo = ready(await preview(none.engine, none.repo));
    const unkeyed = await start(none.engine, none.repo, shownToo.fingerprint);
    assert.equal((await ended(none.engine, unkeyed.id)).status, "failed");
    assert.equal((await report(none.engine, unkeyed.id)).stopped?.code, "credentials");
    assert.deepEqual([stub.requests.length, none.stub.requests.length], [0, 0]);
  });

  it("refuses a commit that changed since its preview before anything is uploaded, and the same request id with another preview", async () => {
    const { stub, engine, repo } = await setup();
    const shown = ready(await preview(engine, repo));
    put(repo, "src/more.ts", "export const more = 2;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "more"]);
    const requestId = randomUUID();
    const moved = await start(engine, repo, shown.fingerprint, { requestId });
    assert.equal((await ended(engine, moved.id)).status, "failed");
    assert.deepEqual([(await report(engine, moved.id)).stopped?.code, stub.requests.length], ["preview", 0]);
    await assert.rejects(start(engine, repo, "e".repeat(64), { requestId }), /already started another run/);
  });

  it("runs one check of a project at a time: a second is refused and never recorded, and a repeated request still gets its run", async () => {
    const { stub, engine, repo } = await setup();
    stub.guest.override = ({ args }) => (args[1] === PROBE_SCRIPT ? { waits: true } : undefined);
    const fingerprint = ready(await preview(engine, repo)).fingerprint;
    const requestId = randomUUID();
    const first = await start(engine, repo, fingerprint, { requestId });
    const second = randomUUID();
    await assert.rejects(start(engine, repo, fingerprint, { requestId: second }), /A sandbox check of this project is already going on its engine\. Wait for it to end, or cancel it/);
    assert.equal(await engine.client.call("runs.find", { clientRequestId: second }), null);
    assert.equal((await start(engine, repo, fingerprint, { requestId })).id, first.id, "a repeated request gets the run it started");
    await waitFor(() => probeSpawned(stub), { timeoutMs: 20_000, what: "the probe's spawn" });
    await engine.client.call("runs.cancel", { runId: first.id });
    assert.equal((await ended(engine, first.id)).status, "cancelled");
    // Once it has ended, the project can be checked again.
    stub.guest.override = () => undefined;
    const next = await start(engine, repo, fingerprint);
    assert.deepEqual([(await ended(engine, next.id)).status, stub.requests.filter((request) => request.path === "/v1/files").length], ["succeeded", 2]);
  });

  it("ends a check that fails before its session with a report saying so, never one that reads as interrupted", async () => {
    // No git on this engine's PATH: the check is accepted, and its run step stops before anything is sent.
    const { stub, engine, repo } = await setup({ env: (root) => ({ ...process.env, PATH: join(root, "no tools") }) });
    const run = await start(engine, repo, "a".repeat(64));
    assert.equal((await ended(engine, run.id)).status, "failed");
    const checked = await report(engine, run.id);
    assert.deepEqual([checked.outcome, checked.stopped, checked.finishedAt !== null, stub.requests.length], ["failed", { code: "git", step: "run", message: STOP_MESSAGES.git }, true, 0]);
  });

  it("never looks again at a journal its pass settled while a check was going, and reports nothing it didn't see", async () => {
    const { stub, engine, home, repo } = await setup();
    const { service } = stub.guest;
    let armed = false;
    // An uncertain probe leaves a journal open, as in the test above.
    stub.guest.override = ({ args }) => {
      if (args[1] !== PROBE_SCRIPT || armed) return undefined;
      armed = true;
      service.dropNextSpawnAnswer = true;
      service.hideNextSpawn = true;
      return { waits: true };
    };
    const lost = await start(engine, repo, ready(await preview(engine, repo)).fingerprint);
    assert.equal((await ended(engine, lost.id)).status, "failed");
    assert.equal((await report(engine, lost.id)).outcome, "uncertain");
    await engine.client.call("shutdown", {});
    await engine.exited;
    const later = engineOn(stub, home);
    await later.initialize({});
    service.hidden.clear();
    // The pass's stop is held while a check starts, so the pass ends with the check going.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stub.before = (request) => (request.method === "DELETE" ? held : undefined);
    await later.client.call("secrets.update", { set: CREDENTIALS, remove: [] });
    await waitFor(() => stub.requests.some((request) => request.method === "DELETE"), { timeoutMs: 20_000, what: "the pass's stop" });
    stub.guest.override = ({ args }) => (args[1] === PROBE_SCRIPT ? { waits: true } : undefined);
    const going = await later.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "sandbox", input: { repoPath: repo, project: randomUUID(), target: "local", preview: ready(await preview(later, repo)).fingerprint }, context: { sharing: { cloudExecution: true } } });
    await waitFor(() => spawns(stub).filter((request) => request.body.includes("nivra-probe")).length === 2, { timeoutMs: 20_000, what: "the second probe's spawn" });
    stub.before = () => undefined;
    release();
    const status = (): Promise<SandboxStatus> => later.client.call("sandbox.status", {});
    const done = await waitFor(async () => {
      const now = await status();
      return now.pass.state === "done" ? now : null;
    }, { timeoutMs: 30_000, what: "the recovery pass" });
    assert.deepEqual([done.pass.stopped, done.pass.unresolved, done.open.length], [1, [], 0]);
    // The key saved again while the check goes: nothing is left to look at, so no pass runs on what was settled.
    await later.client.call("secrets.update", { set: CREDENTIALS, remove: [] });
    const again = await status();
    assert.deepEqual([again.pass.startedAt, again.pass.unresolved, again.open.length], [done.pass.startedAt, [], 0]);
    await later.client.call("runs.cancel", { runId: going.id });
    assert.equal((await ended(later, going.id)).status, "cancelled");
    assert.deepEqual([(await status()).pass.unresolved, (await status()).open.length], [[], 0]);
  });

  it("cancels a check under way: the operation is stopped, the run ends cancelled, and cleanup's record says so", async () => {
    const { stub, engine, repo } = await setup();
    stub.guest.override = ({ args }) => (args[1] === PROBE_SCRIPT ? { waits: true } : undefined);
    const run = await start(engine, repo, ready(await preview(engine, repo)).fingerprint);
    await waitFor(() => probeSpawned(stub), { timeoutMs: 20_000, what: "the probe's spawn" });
    await engine.client.call("runs.cancel", { runId: run.id });
    assert.equal((await ended(engine, run.id)).status, "cancelled");
    const checked = await report(engine, run.id);
    assert.deepEqual([checked.outcome, checked.cleanup?.stopped, checked.cleanup?.unresolved, spawns(stub).length], ["cancelled", 1, [], 2]);
    assert.ok(stub.requests.some((request) => request.method === "DELETE"), "the probe's operation was asked to stop");
  });

  it("never sends an uncertain submission again: it is left open and visible, and a later engine's pass settles it once it has the credentials", async () => {
    const { stub, engine, home, repo } = await setup();
    const { service } = stub.guest;
    let armed = false;
    // The probe's operation is made, its answer is lost, and it is beyond the search window for now.
    stub.guest.override = ({ args }) => {
      if (args[1] !== PROBE_SCRIPT || armed) return undefined;
      armed = true;
      service.dropNextSpawnAnswer = true;
      service.hideNextSpawn = true;
      return { waits: true };
    };
    const run = await start(engine, repo, ready(await preview(engine, repo)).fingerprint);
    assert.equal((await ended(engine, run.id)).status, "failed");
    const checked = await report(engine, run.id);
    assert.deepEqual([checked.outcome, checked.stopped?.code, checked.cleanup?.unresolved.length], ["uncertain", "uncertain", 1]);
    assert.match(checked.cleanup?.unresolved[0] ?? "", /^It isn't known whether "probe" started \(correlation [0-9a-f-]{36}\); it may still be running\.$/);
    assert.equal(spawns(stub).length, 2, "the probe was never sent again, and nothing ran after it");
    const left: SandboxStatus = await engine.client.call("sandbox.status", {});
    assert.deepEqual(left.open.map((journal) => [journal.operations, journal.uncertain]), [[0, 1]]);

    // A later engine on the same home, with no credentials yet: it finds the journal with no network, and waits.
    await engine.client.call("shutdown", {});
    await engine.exited;
    const later = engineOn(stub, home);
    await later.initialize({});
    const before = stub.requests.length;
    const waiting: SandboxStatus = await later.client.call("sandbox.status", {});
    assert.deepEqual([waiting.open.length, waiting.pass.state, stub.requests.length - before], [1, "waiting-for-credentials", 0]);
    // Once the service lists the operation again and the credentials arrive, one pass finds it and stops it.
    service.hidden.clear();
    await later.client.call("secrets.update", { set: CREDENTIALS, remove: [] });
    const done = await waitFor(async () => {
      const status: SandboxStatus = await later.client.call("sandbox.status", {});
      return status.pass.state === "done" ? status : null;
    }, { timeoutMs: 30_000, what: "the recovery pass" });
    assert.deepEqual([done.pass.stopped, done.pass.unresolved, done.open.length], [1, [], 0]);
    assert.equal(service.operations.find((operation) => (operation.body["args"] as string[])[1] === PROBE_SCRIPT)?.cancelled, true);
    assert.equal(spawns(stub).length, 2, "recovery replays nothing");
  });

  it("reads a check its engine died during as interrupted, and the next engine's pass stops what it left running", async () => {
    const { stub, engine, home, repo } = await setup();
    stub.guest.override = ({ args }) => (args[1] === PROBE_SCRIPT ? { waits: true } : undefined);
    const run = await start(engine, repo, ready(await preview(engine, repo)).fingerprint);
    await waitFor(() => probeSpawned(stub), { timeoutMs: 20_000, what: "the probe's spawn" });
    engine.kill();
    await engine.exited;
    const later = engineOn(stub, home);
    await later.initialize(CREDENTIALS);
    assert.equal((await later.client.call("runs.get", { runId: run.id })).status, "failed");
    assert.equal((await report(later, run.id)).outcome, "interrupted");
    const done = await waitFor(async () => {
      const status: SandboxStatus = await later.client.call("sandbox.status", {});
      return status.pass.state === "done" ? status : null;
    }, { timeoutMs: 30_000, what: "the recovery pass" });
    assert.deepEqual([done.pass.stopped, done.open.length], [1, 0]);
    assert.ok(existsSync(join(home, "sandbox", "settled")), "the settled journal is kept, as the record of what was sent");
  });
});
