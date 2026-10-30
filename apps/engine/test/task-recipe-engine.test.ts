import { codingGrant } from "./coding-grant.ts";
import { choicesDigest, preferencesDigest } from "@nivra/domain";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isTerminal, projectFingerprint, REF_FORMAT, TASK_MODEL, taskBriefDigest, type EnvironmentRef, type RunSummary, type TaskBrief, type TaskPreview, type TaskReport } from "@nivra/domain";
import { setupConfiguration } from "../src/environment/inputs.ts";
import { isNodeSetupPath } from "../src/environment/node-files.ts";
import { CHECK_IMAGE } from "../src/exec/check.ts";
import { ENV_PATH } from "../src/exec/nebius/sandbox.ts";
import { TASK_BRIEF, TASK_FIX, TASK_FIXTURE } from "../scripts/task-fixture.ts";
import { removeDir, startEngine, tempDir, type EngineProcess } from "./helpers.ts";
import { RealGuest } from "./real-guest.ts";
import { startSandboxStub, type SandboxStub } from "./stub-sandboxes.ts";
import { startStub, toolCall, type Stub } from "./stub-token-factory.ts";
import { cleanUp, put, repoWith, scratch, snap } from "./workspace-fixtures.ts";

/**
 * A task run bound to a project-driven recipe's environment, through a real engine over stdio (NIV-55): the preview
 * checks the environment against the commit's setup files and the folders its sessions leave out, the run starts from
 * the environment's image with its task variables, and an environment prepared on another target is refused before
 * anything is sent. Nebius and Token Factory are stand-ins on this machine.
 */
const KEY = "nivra-task-recipe-key-0123456789";
const PROJECT_ID = "project-e00taskrecipetest00";
const CREDENTIALS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const FILES: Record<string, string> = { ...Object.fromEntries(TASK_FIXTURE.map((file) => [file.path, String(file.bytes)])), "package.json": json({ name: "greet", private: true, packageManager: "pnpm@11.5.3" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" };
const BRIEF: TaskBrief = TASK_BRIEF;
const TASK_ID = randomUUID();
const PROJECT = randomUUID();
const IMAGE = "img-recipe-prepared";
type Call = [tool: string, input: Record<string, unknown>];
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

/** A recipe's environment for these files, prepared as `IMAGE` on `target`. */
async function refFor(files: Record<string, string>, target = "local"): Promise<EnvironmentRef> {
  return {
    format: REF_FORMAT,
    recipe: "a".repeat(64),
    verified: "b".repeat(64),
    configuration: setupConfiguration(await snap(repoWith(files)), isNodeSetupPath).digest,
    image: IMAGE,
    projectFingerprint: await projectFingerprint(PROJECT_ID),
    target,
    tools: [
      { name: "node", version: "24.21.0" },
      { name: "pnpm", version: "11.5.3" },
    ],
    platform: { arch: "x86_64", libc: "musl" },
    env: { PATH: ENV_PATH, HOME: "/root", CI: "1", COREPACK_ENABLE_NETWORK: "0", pnpm_config_verify_deps_before_run: "false", pnpm_config_pm_on_fail: "ignore" },
    dependencyFolders: ["node_modules"],
    builds: null,
    preparedAt: "2026-10-28T10:00:00.000Z",
  };
}

async function setup(files: Record<string, string> = FILES): Promise<{ sandbox: SandboxStub<RealGuest>; model: Stub; engine: EngineProcess; repo: string }> {
  const guest = new RealGuest(CHECK_IMAGE.uuid);
  guest.busybox = true;
  // The environment's image: its workspace holds the setup files and what the install wrote.
  const image = scratch("recipe image");
  for (const path of ["package.json", "pnpm-lock.yaml"]) put(join(image, "workspace"), path, files[path]!);
  put(join(image, "workspace"), "node_modules/dep/index.js", "module.exports = 1;\n");
  guest.images.set(IMAGE, image);
  const sandbox = await startSandboxStub({ guest });
  const model = await startStub({ models: [{ id: TASK_MODEL }], chat: (_request, index) => toolCall(WORK[Math.min(index, WORK.length - 1)]![0], WORK[Math.min(index, WORK.length - 1)]![1], { id: `call_${index}` }) });
  stubs.push(sandbox, model);
  const root = tempDir("nivra task recipe engine");
  dirs.push(root);
  const home = join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--sandboxes-url", sandbox.url, "--token-factory-url", model.url] });
  engines.push(engine);
  await engine.initialize(CREDENTIALS);
  return { sandbox, model, engine, repo: repoWith(files) };
}

const preview = (engine: EngineProcess, repo: string, environment: EnvironmentRef): Promise<TaskPreview> => engine.client.call("task.preview", { repoPath: repo, brief: BRIEF, environment });
const refused = (shown: TaskPreview) => {
  assert.equal(shown.status, "refused", JSON.stringify(shown).slice(0, 300));
  return shown as Extract<TaskPreview, { status: "refused" }>;
};
async function start(engine: EngineProcess, repo: string, fingerprint: string, environment: EnvironmentRef): Promise<RunSummary> {
  const requestId = randomUUID();
  return engine.client.call("runs.start", {
    clientRequestId: requestId, budget: codingGrant(requestId),
    workflowId: "task",
    input: { repoPath: repo, project: PROJECT, target: "local", preview: fingerprint, taskId: TASK_ID, briefVersion: 2, preferencesDigest: await preferencesDigest([]), choicesDigest: await choicesDigest([]), briefDigest: await taskBriefDigest(BRIEF), environment },
    context: { sharing: { modelContext: true, cloudExecution: true }, brief: BRIEF, preferences: { revision: 0, records: [] }, choices: [] },
  });
}
const ended = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 60_000);
const report = async (engine: EngineProcess, runId: string): Promise<TaskReport> => (await engine.client.call("runs.task", { runId }))!;
const spawns = (stub: SandboxStub<RealGuest>) => stub.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances").map((request) => JSON.parse(request.body) as { image: string; args?: string[]; env?: Record<string, string> });

describe("a task run from a recipe's environment, through a real engine (NIV-55)", () => {
  it("previews the run with the environment in its own field, and refuses one that doesn't fit the commit, saying why", async () => {
    const { engine, repo } = await setup();
    const environment = await refFor(FILES);
    const shown = await preview(engine, repo, environment);
    assert.equal(shown.status, "ready", JSON.stringify(shown).slice(0, 300));
    const ready = shown as Extract<TaskPreview, { status: "ready" }>;
    assert.deepEqual([ready.environment, ready.environmentRef], [null, environment]);
    // Another .nvmrc: the setup files aren't the ones the environment was prepared from.
    const moved = refused(await preview(engine, repoWith({ ...FILES, ".nvmrc": "24.20.0\n" }), environment));
    assert.deepEqual([moved.code, moved.message.startsWith("This commit's setup files"), moved.message.endsWith("Prepare the environment again, then preview the run.")], ["environment", true, true]);
    // A tracked file where the environment keeps what it installed.
    const tracked = { ...FILES, "node_modules/left/index.js": "module.exports = 1;\n" };
    const mixed = refused(await preview(engine, repoWith(tracked), await refFor(tracked)));
    assert.deepEqual([mixed.code, mixed.message], ["environment", 'This commit tracks files in node_modules, such as "node_modules/left/index.js", where the project\'s environment keeps what it installed, so a run would mix the two. Stop tracking node_modules, commit, then preview the run.']);
  });

  it("refuses a commit whose setup file is a link, though its setup digest matches the environment's", async () => {
    // Nate's review of PR 36: a package.json holding {} and a package.json linking to a file named {} digest alike.
    const plain = { ...FILES, "package.json": "{}" };
    const linked = { ...FILES, "package.json": { link: "{}" }, "{}": json({ name: "greet", private: true, scripts: { postinstall: "node build.js" } }) };
    const { engine } = await setup(plain);
    const environment = await refFor(plain);
    assert.equal(setupConfiguration(await snap(repoWith(linked)), isNodeSetupPath).digest, environment.configuration, "the two commits' setup digests match");
    const shown = refused(await preview(engine, repoWith(linked), environment));
    assert.deepEqual([shown.code, shown.message], ["environment", 'This commit\'s "package.json" is a link. Nivra reads a project\'s setup files only as files, so a run can\'t be bound to its environment: commit the file itself, then preview the run.']);
  });

  it("starts from the environment's image with its task variables and dependency folders, and proposes the fix", async () => {
    const { sandbox, engine, repo } = await setup();
    const environment = await refFor(FILES);
    const shown = await preview(engine, repo, environment);
    assert.equal(shown.status, "ready");
    const run = await start(engine, repo, (shown as Extract<TaskPreview, { status: "ready" }>).snapshot.fingerprint, environment);
    await ended(engine, run.id);
    const done = await report(engine, run.id);
    assert.equal(done.outcome, "proposed", done.stopped?.message ?? "");
    assert.deepEqual([done.environment, done.environmentRef, done.setup, done.verified], [null, environment, { unchanged: true, changed: [] }, true]);
    const sent = spawns(sandbox);
    assert.deepEqual([sent[0]?.image, sent[0]?.args?.slice(7)], [IMAGE, ["node_modules"]], "the session didn't start from the environment's image, leaving its dependency folder out");
    assert.ok(sent.slice(1).every((body) => body.env?.["COREPACK_ENABLE_NETWORK"] === "0" && body.env?.["pnpm_config_verify_deps_before_run"] === "false"), "a command ran without the recipe's task variables");
  });

  it("sends nothing for a run whose environment's task variables carry a key the vault keeps", async () => {
    const { sandbox, model, engine, repo } = await setup();
    const environment = { ...(await refFor(FILES)), env: { ...(await refFor(FILES)).env, LEAK: KEY } };
    const shown = await preview(engine, repo, environment);
    assert.equal(shown.status, "ready");
    const run = await start(engine, repo, (shown as Extract<TaskPreview, { status: "ready" }>).snapshot.fingerprint, environment);
    // The engine keeps the request masked, so the value can't be read back as an environment, and the run stops there;
    // the run's own environment check would refuse it next. Either way, nothing reaches Nebius or Token Factory.
    const summary = await ended(engine, run.id);
    assert.deepEqual([summary.status, await report(engine, run.id), spawns(sandbox).length, model.requests.filter((request) => request.path.endsWith("/chat/completions")).length], ["failed", null, 0, 0]);
  });

  it("refuses, before anything is sent, a run bound to an environment prepared on another target", async () => {
    const { sandbox, model, engine, repo } = await setup();
    const environment = await refFor(FILES, "wsl:Ubuntu");
    const shown = await preview(engine, repo, environment);
    assert.equal(shown.status, "ready");
    const run = await start(engine, repo, (shown as Extract<TaskPreview, { status: "ready" }>).snapshot.fingerprint, environment);
    await ended(engine, run.id);
    const done = await report(engine, run.id);
    assert.deepEqual([done.outcome, done.stopped?.code, spawns(sandbox).length, model.requests.filter((request) => request.path.endsWith("/chat/completions")).length], ["refused", "environment", 0, 0]);
  });
});
