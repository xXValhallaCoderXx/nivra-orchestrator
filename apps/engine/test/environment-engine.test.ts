import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { isTerminal, projectFingerprint, type EnvironmentPreview, type EnvironmentReport, type RunSummary } from "@nivra/domain";
import { ENV_PREPARE_SCRIPT } from "../src/exec/nebius/sandbox.ts";
import { readTar } from "../src/exec/tar.ts";
import { succeed, type Behaviour } from "./fake-sandboxes.ts";
import { RealGuest } from "./real-guest.ts";
import { removeDir, startEngine, tempDir, type EngineProcess } from "./helpers.ts";
import { startSandboxStub, type SandboxStub } from "./stub-sandboxes.ts";
import { cleanUp, repoWith } from "./workspace-fixtures.ts";

/**
 * An environment's preparation through a real engine over stdio (NIV-49, D41): the production adapter against the
 * stand-in for Nebius Sandboxes on this machine. The preparation never runs here. The stand-in extracts the inputs it
 * was sent and adds the dependency folders an install would leave, so nothing is installed on this machine.
 */
const KEY = "nivra-environment-engine-key-0123456789";
const PROJECT_ID = "project-e00environmentenginetest";
const CREDENTIALS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };

const dirs: string[] = [];
const engines: EngineProcess[] = [];
const stubs: SandboxStub<RealGuest>[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  for (const stub of stubs) await stub.close();
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const FILES = {
  "package.json": json({ name: "mono", private: true, packageManager: "pnpm@11.5.3", engines: { node: ">=22" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  ".npmrc": "node-linker=hoisted\n",
  "packages/data/package.json": json({ name: "@mono/data", private: true }),
  "packages/data/src/index.ts": "export const data = 1;\n",
};

/** How the stand-in's install goes: as it should, failing, printing other versions, or never ending on its own. */
type Install = "ok" | "fails" | "other-versions" | "waits";

async function setup(options: { install?: Install } = {}) {
  const guest = new RealGuest();
  guest.images.set("img-imported", tempDir("nivra imported image"));
  dirs.push(guest.images.get("img-imported")!);
  const received: { inputs: string[] | null } = { inputs: null };
  guest.intercept = ({ args, body }, folder): Behaviour | undefined => {
    if (args[1] !== ENV_PREPARE_SCRIPT) return undefined;
    const reference = (body["files"] as Record<string, { uuid: string }>)["/nivra/env-inputs.tar.gz"]!;
    const entries = readTar(new Uint8Array(gunzipSync(guest.service.uploadsById.get(reference.uuid)!)), { maxEntries: 100, maxBytes: 1 << 22, maxEntryBytes: 1 << 22, maxPathBytes: 1024 });
    received.inputs = entries.flatMap((entry) => (entry.kind === "file" ? [entry.path] : [])).sort();
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      mkdirSync(dirname(join(folder, "workspace", entry.path)), { recursive: true });
      writeFileSync(join(folder, "workspace", entry.path), entry.bytes);
    }
    mkdirSync(join(folder, "workspace", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(folder, "workspace", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const install = options.install ?? "ok";
    if (install === "waits") return { ...succeed(), waits: true };
    if (install === "fails") return succeed({ exitCode: 1, stdout: "node v22.23.4\npnpm 11.5.3\narch x86_64\nERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"\n" });
    return succeed({ stdout: `node ${install === "other-versions" ? "v22.0.0" : "v22.23.4"}\npnpm 11.5.3\narch x86_64\nDone in 7.7s using pnpm v11.5.3\ninstalled\n` });
  };
  const stub = await startSandboxStub({ guest });
  stubs.push(stub);
  const root = tempDir("nivra environment engine");
  dirs.push(root);
  const home = join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--sandboxes-url", stub.url] });
  engines.push(engine);
  await engine.initialize(CREDENTIALS);
  return { stub, guest, engine, home, repo: repoWith(FILES), received };
}

const project = randomUUID();
const spec = { filters: ["@mono/data..."] };
const preview = (engine: EngineProcess, repoPath: string, given = spec): Promise<EnvironmentPreview> => engine.client.call("environment.preview", { repoPath, spec: given });
const ready = (shown: EnvironmentPreview) => {
  assert.equal(shown.status, "ready", JSON.stringify(shown).slice(0, 300));
  return shown as Extract<EnvironmentPreview, { status: "ready" }>;
};
const start = (engine: EngineProcess, repoPath: string, fingerprint: string, options: { consent?: boolean; spec?: typeof spec } = {}): Promise<RunSummary> =>
  engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "environment", input: { repoPath, project, target: "local", preview: fingerprint }, context: { sharing: { cloudExecution: options.consent ?? true }, spec: options.spec ?? spec } });
const ended = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
const report = async (engine: EngineProcess, runId: string): Promise<EnvironmentReport> => (await engine.client.call("runs.environment", { runId }))!;
const spawns = (stub: SandboxStub<RealGuest>) => stub.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances").map((request) => JSON.parse(request.body) as { networking: { enabled: boolean }; image: string });

describe("an environment's preparation through a real engine (NIV-49, D41)", () => {
  it("imports the pinned image, prepares it from the manifests alone with networking on for that alone, and keeps it bound to the project", async () => {
    const { stub, engine, repo, received } = await setup();
    const shown = ready(await preview(engine, repo));
    assert.deepEqual([shown.leftOut, shown.installArgs, shown.packageManager], [[".npmrc"], ["--frozen-lockfile", "--filter", "@mono/data..."], "pnpm@11.5.3"]);
    const run = await start(engine, repo, shown.fingerprint);
    assert.equal((await ended(engine, run.id)).status, "succeeded");
    const done = await report(engine, run.id);
    assert.equal(done.outcome, "prepared", JSON.stringify(done.stopped));
    assert.deepEqual(received.inputs, ["package.json", "packages/data/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], "the preparation was sent something besides the manifests");
    assert.deepEqual([done.prepared?.base, done.prepared?.node, done.prepared?.pnpm, done.prepared?.arch, done.prepared?.inputsDigest], [{ tag: "node:22.23.4-alpine3.24", image: "img-imported", imported: true }, "v22.23.4", "11.5.3", "x86_64", shown.inputsDigest]);
    assert.equal(done.prepared?.projectFingerprint, await projectFingerprint(PROJECT_ID));
    assert.ok(done.prepared?.image && done.prepared.image !== "img-imported");
    assert.deepEqual(spawns(stub).map((spawn) => [spawn.networking.enabled, spawn.image]), [[true, "img-imported"]], "networking was on for something other than the one preparation");
    assert.deepEqual([done.steps.map((step) => step.label), done.cleanup?.unresolved, done.cleanup?.retained?.uploads], [["image import", "preparation"], [], 1]);
    assert.ok(!JSON.stringify(stub.requests.map((request) => request.body)).includes(PROJECT_ID), "the project id went in a body");
  });

  it("sends nothing without upload consent, or when what it would send changed since the preview", async () => {
    const { stub, engine, repo } = await setup();
    const shown = ready(await preview(engine, repo));
    const refused = await start(engine, repo, shown.fingerprint, { consent: false });
    await ended(engine, refused.id);
    const other = await start(engine, repo, shown.fingerprint, { spec: { filters: [] } });
    await ended(engine, other.id);
    assert.deepEqual([(await report(engine, refused.id)).stopped?.code, (await report(engine, other.id)).stopped?.code], ["consent", "preview"]);
    assert.equal(stub.requests.length, 0);
  });

  it("keeps no environment when the install fails or its versions aren't the pinned ones, and says why", async () => {
    for (const [install, code] of [["fails", "install"], ["other-versions", "versions"]] as const) {
      const { engine, repo } = await setup({ install });
      const run = await start(engine, repo, ready(await preview(engine, repo)).fingerprint);
      assert.equal((await ended(engine, run.id)).status, "failed");
      const done = await report(engine, run.id);
      assert.deepEqual([done.outcome, done.stopped?.code, done.prepared], ["failed", code, null]);
      if (install === "fails") assert.match(done.install?.logTail ?? "", /ERR_PNPM_OUTDATED_LOCKFILE/);
    }
  });

  it("cancels a preparation under way: its operation is stopped, and cleanup's record says so", async () => {
    const { stub, engine, repo } = await setup({ install: "waits" });
    const run = await start(engine, repo, ready(await preview(engine, repo)).fingerprint);
    await engine.waitForRun(run.id, () => stub.guest.service.operations.some((operation) => (operation.body["args"] as string[] | undefined)?.[1] === ENV_PREPARE_SCRIPT && operation.reads > 0), 20_000);
    await engine.client.call("runs.cancel", { runId: run.id });
    assert.equal((await ended(engine, run.id)).status, "cancelled");
    const done = await report(engine, run.id);
    assert.deepEqual([done.outcome, done.cleanup?.stopped, done.cleanup?.unresolved, done.prepared], ["cancelled", 1, [], null]);
  });
});
