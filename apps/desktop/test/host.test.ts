import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { isTerminal, projectFingerprint, REF_FORMAT, taskBriefDigest, type EnvironmentRef, type RunEventsPage, type SecretName, type TaskBrief } from "@nivra/domain";
import { Host } from "../src/main/host.ts";
import { HostStore, NO_SHARING } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import { previewFingerprint } from "../src/main/reviews.ts";
import type { TargetFactory } from "../src/main/targets/registry.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";
import type { WslDiscovery } from "../src/main/targets/wsl-discovery.ts";
import { httpError, startStub, text, toolCall, type Reply, type StubRequest, type Stub } from "../../engine/test/stub-token-factory.ts";
import { startSandboxStub, type SandboxStub, type StubGuest } from "../../engine/test/stub-sandboxes.ts";
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyStub } from "../../engine/test/stub-tavily.ts";
import { researchFingerprint } from "../src/main/research.ts";
import type { ResearchSelection, ResearchView } from "../src/shared/research.ts";
import { CHECK_IMAGE, PROBE_SCRIPT } from "../../engine/src/exec/check.ts";
import { RealGuest } from "../../engine/test/real-guest.ts";
import { succeed } from "../../engine/test/fake-sandboxes.ts";
import { ENV_PREPARE_SCRIPT } from "../../engine/src/exec/nebius/sandbox.ts";
import { INSPECT_SCRIPT, READINESS_SCRIPT } from "../../engine/src/environment/scripts.ts";
import { readTar } from "../../engine/src/exec/tar.ts";
import { changedSince, folderState } from "../../engine/test/workspace-fixtures.ts";
import { TASK_FIX, TASK_FIXTURE } from "../../engine/scripts/task-fixture.ts";
import { briefFrom, NO_CASE, taskBriefOf, taskRunFingerprint } from "../src/main/tasks.ts";
import { insertTask } from "../src/main/workspace.ts";
import { openWorkspace } from "../src/main/workspace-db.ts";
import { seedMission, seedMissionReview } from "../e2e/seed-workspace.ts";
import type { BriefFields, TaskAttemptView } from "../src/shared/ipc.ts";

/**
 * The host's engine pool (D17) against real engines run from source. A "WSL" target here is a stand-in: a target that
 * says it is `wsl:Test` and runs the engine locally with its own home, which is all the host can tell apart. The
 * stubborn fixture stands in for an engine that takes its time to stop.
 */
const ENGINE = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url));
const STUBBORN = fileURLToPath(new URL("./fixtures/stubborn-engine.mjs", import.meta.url));
const GATED = fileURLToPath(new URL("./fixtures/gated-engine.mjs", import.meta.url));
const dirs: string[] = [];
const hosts: Host[] = [];
const stubs: Stub[] = [];
const sandboxStubs: SandboxStub[] = [];
const tavilyStubs: TavilyStub[] = [];
after(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  await Promise.all(stubs.map((stub) => stub.close()));
  await Promise.all(sandboxStubs.map((stub) => stub.close()));
  await Promise.all(tavilyStubs.map((stub) => stub.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor<T>(check: () => T | null | false | Promise<T | null | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Whether the engine has read the nth sandbox operation whose arguments name `name` (the first unless given). It reads
 * one only once the spawn's answer is in and journaled, so a stop after that read can't race the answer, as one after
 * the spawn alone can.
 */
const operationRead = (stub: SandboxStub<StubGuest>, name: string, nth = 1) =>
  (stub.guest.service.operations.filter((operation) => JSON.stringify(operation.body["args"] ?? []).includes(name))[nth - 1]?.reads ?? 0) > 0;

function makeRepo(path: string, files: Record<string, string> = {}): string {
  mkdirSync(path, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return path;
}

const localTarget = (home: string, entry = ENGINE, extraArgs: readonly string[] = []) =>
  new LocalTarget({ platform: "linux", runtime: { node: process.execPath, entry, runtimeHash: null }, home, extraArgs });

/** A target that says it is a WSL distribution, running its engine locally with its own home. */
function standInWsl(distro: string, inner: ExecutionTarget, beforePrepare?: () => Promise<void>): ExecutionTarget {
  return {
    descriptor: { id: `wsl:${distro}`, kind: "wsl", label: `${distro} · WSL`, platform: "linux", distro },
    probe: () => inner.probe(),
    prepare: async (request) => {
      await beforePrepare?.();
      return inner.prepare(request);
    },
  };
}

const BROKEN: WslDiscovery = { status: "broken", code: "WSL_E_TEST", message: "WSL didn't answer (WSL_E_TEST). Run `wsl --update` in a terminal, then press Check again.", distros: [] };

/**
 * Both engines reach `tokenFactoryUrl`, `sandboxesUrl` and `tavilyUrl` (loopback stubs) when they are set;
 * `beforeWslPrepare` can hold the WSL engine's start; `credentials` stands in for the saved keys, which are otherwise
 * `keys.current`.
 */
type HostOptions = {
  localEntry?: string;
  /** The WSL stand-in's engine: the real one unless given (a fixture, say). */
  wslEntry?: string;
  wsl?: "ready" | "broken";
  tokenFactoryUrl?: string;
  sandboxesUrl?: string;
  tavilyUrl?: string;
  beforeWslPrepare?: () => Promise<void>;
  testHooks?: { beforeProjection?(turnId: string): Promise<void> };
  credentials?: () => Promise<Partial<Record<SecretName, string>>>;
};

function makeHost(options: HostOptions & { projects?: Array<{ targetId: string; path: string }> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nivra host ü%# "));
  dirs.push(root);
  const ids = (options.projects ?? []).map(() => randomUUID());
  new HostStore(join(root, "nivra.json")).update((data) => ({
    ...data,
    projects: (options.projects ?? []).map((p, i) => ({ id: ids[i]!, targetId: p.targetId, nativePath: p.path, label: p.path.split("/").at(-1)!, addedAt: new Date().toISOString(), sharing: NO_SHARING })),
  }));
  return { ...hostAt(root, options), root, ids };
}

/** A host on the records and engine homes under `root`, as a desktop launch would make it: a second one is a restart. */
function hostAt(root: string, options: HostOptions = {}) {
  const store = new HostStore(join(root, "nivra.json"));
  const extraArgs = [
    ...(options.tokenFactoryUrl ? ["--token-factory-url", options.tokenFactoryUrl] : []),
    ...(options.sandboxesUrl ? ["--sandboxes-url", options.sandboxesUrl] : []),
    ...(options.tavilyUrl ? ["--tavily-url", options.tavilyUrl] : []),
  ];
  const wslTarget = standInWsl("Test", localTarget(join(root, "wsl home"), options.wslEntry ?? ENGINE, extraArgs), options.beforeWslPrepare);
  const discovery: WslDiscovery =
    options.wsl === "broken" ? BROKEN : { status: "ready", wslExe: "wsl.exe", distros: [{ name: "Test", version: 2, isDefault: true, defaultUid: 1000, osVersion: null }], hidden: [] };
  const targets: TargetFactory = { local: localTarget(join(root, "local home"), options.localEntry, extraArgs), discoverWsl: async () => ({ discovery, targets: discovery.status === "ready" ? [wslTarget] : [] }) };
  const keys: { current: Partial<Record<SecretName, string>> } = { current: {} };
  const host = new Host({
    targets,
    store,
    workspacePath: join(root, "workspace.db"),
    logsDir: join(root, "logs"),
    client: { name: "host-test", version: "0" },
    credentials: options.credentials ?? (async () => keys.current),
    platform: "win32",
    realpath: (path) => path,
    supervisor: { heartbeatMs: 0, shutdownGraceMs: 300, eofGraceMs: 300 },
    log: () => undefined,
    ...(options.testHooks ? { testHooks: options.testHooks } : {}),
  });
  host.init();
  hosts.push(host);
  return { host, keys };
}

/** What the engine recorded about the context it received, once the run has ended. */
async function received(host: Host, runId: string) {
  const page = await waitFor(async () => {
    const events = await host.runEvents(runId, 0);
    return isTerminal(events.status) ? events : null;
  }, "the run to end");
  assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));
  const data = page.events.find((e) => e.stepId === "context" && e.type === "step.output")?.data;
  return data as { revision: number; count: number; records: Array<{ id: string; scope: string; intent: string; revision: number }>; digest: string };
}

/** The fingerprint of these records, worked out here as D21 defines it, independently of the engine's code. */
const digestOf = (records: ReadonlyArray<{ id: string; scope: string; intent: string; revision: number; statement: string }>) =>
  createHash("sha256")
    .update(JSON.stringify([...records].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [r.id, r.scope, r.intent, r.revision, r.statement])))
    .digest("hex");

/** Files under `dir`, at any depth, whose bytes hold `text`. */
function filesHolding(dir: string, text: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name)).includes(text))
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

/** Runs in an engine's store, read once the engine has stopped and released it (D7). */
const storedRuns = (home: string) => {
  const db = new DatabaseSync(join(home, "nivra.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT workflow_id FROM runs").all() as Array<{ workflow_id: string }>).map((row) => row.workflow_id);
  } finally {
    db.close();
  }
};

const stateOf = (host: Host, targetId: string) => host.engines().find((e) => e.targetId === targetId)?.state;
const online = (host: Host, targetId: string) => waitFor(() => {
  const state = stateOf(host, targetId);
  return state?.status === "online" ? state.info : null;
}, `${targetId} to come online`);

describe("Host: one engine per target, chosen by each project's folder (D17)", () => {
  it("starts no engine until a project is opened, then only that project's", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids } = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }, { targetId: "wsl:Test", path: makeRepo(join(root, "linux")) }] });
    assert.deepEqual(host.engines().map((e) => [e.targetId, e.state.status]), [["local", "stopped"], ["wsl:Test", "stopped"]]);
    await host.open(ids[1]!);
    await online(host, "wsl:Test");
    assert.equal(stateOf(host, "local")?.status, "stopped");
  });

  it("routes every call to the engine of the project's folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const native = makeRepo(join(root, "native repo"));
    const linux = makeRepo(join(root, "linux repo"));
    const { host, ids, root: hostRoot } = makeHost({ projects: [{ targetId: "local", path: native }, { targetId: "wsl:Test", path: linux }] });
    await Promise.all(ids.map((id) => host.open(id)));
    const [localInfo, wslInfo] = [await online(host, "local"), await online(host, "wsl:Test")];
    assert.deepEqual([localInfo.home, wslInfo.home], [join(hostRoot, "local home"), join(hostRoot, "wsl home")]);
    const run = await host.startHello(ids[1]!, 0);
    const page = await waitFor(async () => {
      const events = await host.runEvents(run.id, 0);
      return events.status === "succeeded" || events.status === "failed" ? events : null;
    }, "the hello run to end");
    assert.equal(page.status, "succeeded");
    assert.ok(page.events.some((event) => event.message.includes(linux)), "the run read the WSL project's folder");
    await assert.rejects(host.runEvents(randomUUID(), 0), /no record of that run in this session/);
  });

  it("keeps a run on its own engine while another engine starts and restarts slowly (the review's race)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    // The local engine is the stubborn fixture: it ignores shutdown, so a restart waits out the whole quit order.
    const { host, ids } = makeHost({ localEntry: STUBBORN, projects: [{ targetId: "wsl:Test", path: makeRepo(join(root, "linux")) }, { targetId: "local", path: root }] });
    await host.open(ids[0]!);
    const wslInfo = await online(host, "wsl:Test");
    const run = await host.startHello(ids[0]!, 60_000);
    await waitFor(async () => (await host.runEvents(run.id, 0)).events.some((e) => e.message.includes("Holding a child process")), "the run to hold");

    await host.open(ids[1]!);
    const before = await online(host, "local");
    let restarted = false;
    const started = performance.now();
    const restarting = host.restart(ids[1]!).finally(() => (restarted = true));
    // For the whole slow restart of the other engine, every call about the run reaches the run's own engine.
    const seen: RunEventsPage["status"][] = [];
    while (!restarted) {
      seen.push((await host.runEvents(run.id, 0)).status);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await restarting;
    assert.ok(performance.now() - started >= 600, "the stubborn engine made the restart wait out the quit order");
    assert.ok(seen.length >= 5, `polled throughout the restart (${seen.length} times)`);
    assert.deepEqual([...new Set(seen)], ["running"]);
    assert.notEqual((await online(host, "local")).instanceId, before.instanceId, "the other engine did restart");

    await host.cancelRun(run.id);
    const ended = await waitFor(async () => {
      const page = await host.runEvents(run.id, 0);
      return page.status === "running" ? null : page;
    }, "the run to stop");
    assert.equal(ended.status, "cancelled");
    const after = await online(host, "wsl:Test");
    assert.equal(after.instanceId, wslInfo.instanceId, "the run's engine was never replaced");
  });

  it("never runs a folder whose distribution is gone anywhere else", async () => {
    const { host, ids } = makeHost({ projects: [{ targetId: "wsl:Gone", path: "/home/odin/repo" }] });
    const view = await host.open(ids[0]!);
    assert.equal(view.state.status, "failed");
    assert.match(view.state.status === "failed" ? view.state.reason : "", /Gone isn't a WSL distribution on this computer any more/);
    await assert.rejects(host.startHello(ids[0]!, 0), /Gone isn't a WSL distribution/);
    assert.equal(stateOf(host, "local"), undefined, "the local engine was not started instead");
  });

  it("keeps folders on Windows working when WSL is broken, and says what to do about WSL", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids } = makeHost({ wsl: "broken", projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }] });
    await host.open(ids[0]!);
    await online(host, "local");
    const wsl = await waitFor(() => (host.wsl()?.status === "checking" ? null : host.wsl()), "WSL to be checked");
    assert.deepEqual([wsl?.status, wsl?.code], ["broken", "WSL_E_TEST"]);
    assert.match(wsl?.message ?? "", /wsl --update/);
  });

  it("hands every engine a changed key, including one that was still starting (D8)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids, keys } = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }, { targetId: "wsl:Test", path: makeRepo(join(root, "linux")) }] });
    await host.open(ids[0]!);
    await online(host, "local");
    void host.open(ids[1]!);
    keys.current = { NEBIUS_API_KEY: "test-key-0123456789", NEBIUS_PROJECT_ID: "project-e00keystest" };
    await host.secretsChanged();
    await online(host, "wsl:Test");
    for (const id of ids) {
      const report = await host.doctor(id);
      assert.match(report.checks.find((check) => check.id === "boundaries")!.detail, /Nebius Sandboxes: key and project id set/);
    }
  });

  it("hands engines the latest keys when two changes overlap, never an older set after a newer one (D8)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    // The keys as they are when read, the first read held as a slow keychain would hold it.
    const saved: { current: Partial<Record<SecretName, string>>; gate: Promise<void> | null } = { current: {}, gate: null };
    const credentials = async () => {
      const read = { ...saved.current };
      const gate = saved.gate;
      saved.gate = null;
      await gate;
      return read;
    };
    const { host, ids } = makeHost({ credentials, projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }] });
    await host.open(ids[0]!);
    await online(host, "local");
    saved.current = { NEBIUS_API_KEY: "test-key-0123456789" };
    let release!: () => void;
    saved.gate = new Promise<void>((resolve) => (release = resolve));
    const older = host.secretsChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    saved.current = { NEBIUS_API_KEY: "test-key-0123456789", TAVILY_API_KEY: "tavily-test-key-0123456789" };
    const newer = host.secretsChanged();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([older, newer]);
    const research = (await host.doctor(ids[0]!)).checks.find((check) => check.id === "research");
    assert.equal(research?.detail, "A Tavily key is set; access not checked yet.");
  });

  it("stops every engine on shutdown, and starts none afterwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids } = makeHost({ localEntry: STUBBORN, projects: [{ targetId: "local", path: root }, { targetId: "wsl:Test", path: makeRepo(join(root, "linux")) }] });
    await Promise.all(ids.map((id) => host.open(id)));
    const pids = [(await online(host, "local")).pid, (await online(host, "wsl:Test")).pid];
    await host.shutdown();
    assert.deepEqual(pids.map(isAlive), [false, false]);
    await host.open(ids[1]!);
    assert.equal(stateOf(host, "wsl:Test")?.status, "stopped");
    await assert.rejects(host.startHello(ids[1]!, 0), /isn't running|quitting/);
  });

  it("sends each run the confirmed preferences for its project, on its own engine, and never another project's own (D21)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids, root: hostRoot } = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }, { targetId: "wsl:Test", path: makeRepo(join(root, "linux")) }] });
    const [native, linux] = ids as [string, string];
    const canary = `nivra-preference-canary-${randomUUID()}`;
    const personal = host.addPreference({ statement: `Prefer named exports, ü%#, ${canary}`, scope: "personal", projectId: null });
    const nativeOwn = host.addPreference({ statement: "Tests live in __tests__", scope: "project", projectId: native, intent: "override" });
    const linuxOwn = host.addPreference({ statement: "Tests sit next to the code", scope: "project", projectId: linux });
    const statements = new Map(host.preferences().records.map((r) => [r.id, r]));
    const expected = (...records: Array<{ id: string }>) => digestOf(records.map((r) => statements.get(r.id)!));

    await Promise.all(ids.map((id) => host.open(id)));
    await Promise.all([online(host, "local"), online(host, "wsl:Test")]);
    const onNative = await received(host, (await host.startHello(native, 0)).id);
    const onLinux = await received(host, (await host.startHello(linux, 0)).id);
    assert.deepEqual(onNative.records.map((r) => r.id), [personal.id, nativeOwn.id]);
    assert.deepEqual(onLinux.records.map((r) => r.id), [personal.id, linuxOwn.id]);
    assert.deepEqual([onNative.records.map((r) => r.intent), onLinux.records.map((r) => r.intent)], [["default", "override"], ["default", "default"]], "each record's intent arrived (D23)");
    assert.deepEqual([onNative.digest, onLinux.digest], [expected(personal, nativeOwn), expected(personal, linuxOwn)], "every value arrived at each engine");
    assert.deepEqual([onNative.revision, onLinux.revision], [3, 3]);

    await host.shutdown();
    for (const home of ["local home", "wsl home"]) assert.deepEqual(filesHolding(join(hostRoot, home), canary), [], `no preference text in ${home}`);
    assert.deepEqual(filesHolding(hostRoot, canary), ["nivra.json"], "only the host's own store keeps it");
  });

  it("sends the edited preference to the next run and none once deleted, and keeps them across a restart (D21)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids, root: hostRoot } = makeHost({ projects: [{ targetId: "wsl:Test", path: makeRepo(join(root, "linux")) }] });
    const linux = ids[0]!;
    const portable = host.addPreference({ statement: "Prefer named exports", scope: "personal", projectId: null });
    const own = host.addPreference({ statement: "Tests sit next to the code", scope: "project", projectId: linux });
    await host.open(linux);
    await online(host, "wsl:Test");
    const first = await received(host, (await host.startHello(linux, 0)).id);

    const edited = host.editPreference(portable.id, { statement: "Prefer default exports" });
    const afterEdit = await received(host, (await host.startHello(linux, 0)).id);
    assert.deepEqual([edited.revision, afterEdit.revision], [2, first.revision + 1]);
    assert.deepEqual(afterEdit.records.find((r) => r.id === portable.id)?.revision, 2);
    assert.equal(afterEdit.digest, digestOf([{ ...portable, statement: "Prefer default exports", revision: 2 }, own]));

    host.deletePreference(portable.id);
    const afterDelete = await received(host, (await host.startHello(linux, 0)).id);
    assert.deepEqual([afterDelete.records.map((r) => r.id), afterDelete.revision], [[own.id], first.revision + 2]);

    // A desktop restart: a new host on the same records and engine homes.
    await host.shutdown();
    const { host: restarted } = hostAt(hostRoot);
    assert.deepEqual(restarted.preferences().records.map((r) => [r.id, r.statement, r.revision]), [[own.id, "Tests sit next to the code", 1]]);
    await restarted.open(linux);
    await online(restarted, "wsl:Test");
    const afterRestart = await received(restarted, (await restarted.startHello(linux, 0)).id);
    assert.deepEqual([afterRestart.digest, afterRestart.revision], [afterDelete.digest, afterDelete.revision]);
  });

  it("sends only the replacement once a preference is replaced, and keeps the replaced one as history (D23)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids } = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }] });
    const first = host.addPreference({ statement: "Use Vitest when adding tests", scope: "project", projectId: ids[0]! });
    const replacement = host.supersedePreference(first.id, { statement: "Replace the Jest setup with Vitest", intent: "override" });
    await host.open(ids[0]!);
    await online(host, "local");
    const got = await received(host, (await host.startHello(ids[0]!, 0)).id);
    assert.deepEqual(got.records.map((r) => [r.id, r.intent, r.revision]), [[replacement.id, "override", 1]]);
    assert.equal(got.digest, digestOf([replacement]));
    assert.deepEqual(host.preferences().records.map((r) => [r.id, r.status, r.supersededBy, r.supersedes]), [
      [first.id, "superseded", replacement.id, null],
      [replacement.id, "confirmed", null, first.id],
    ]);
  });

  it("exports what the person chose without the saved key, and imports it into another profile as they choose (D23)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const { host, ids, keys } = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }] });
    keys.current = { NEBIUS_API_KEY: "test-key-0123456789" };
    const leaky = host.addPreference({ statement: "Call the API with test-key-0123456789", scope: "personal", projectId: null });
    await assert.rejects(host.exportPreferences({ personal: true, projectIds: [] }), /holds your saved Nebius key, so nothing was exported/);
    host.deletePreference(leaky.id);
    host.addPreference({ statement: "Prefer named exports", scope: "personal", projectId: null });
    host.addPreference({ statement: "Replace Jest with Vitest", scope: "project", projectId: ids[0]!, intent: "override" });
    const { text, count } = await host.exportPreferences({ personal: true, projectIds: [ids[0]!] });
    assert.equal(count, 2);

    // Another profile, with a project of the same name: the preview suggests it, and the person's choice decides.
    const other = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "elsewhere", "native")) }] });
    const earlier = other.host.previewImport(text);
    const preview = other.host.previewImport(text);
    assert.throws(() => other.host.importPreferences(earlier.previewId, { personal: true, projects: [{ source: "p1", project: other.ids[0]! }] }), /no longer waiting/, "a new preview releases the one before");
    assert.deepEqual(
      [preview.personal.map((e) => e.statement), preview.projects.map((s) => [s.key, s.label, s.matches.map((m) => m.label), s.suggested])],
      [["Prefer named exports"], [["p1", "native", ["native"], other.ids[0]]]],
    );
    assert.deepEqual(other.host.importPreferences(preview.previewId, { personal: true, projects: [{ source: "p1", project: other.ids[0]! }] }), { added: 2, alreadyHere: 0, leftOut: 0 });
    assert.deepEqual(other.host.preferences().records.map((r) => [r.statement, r.scope, r.intent, r.origin, r.projectId]), [
      ["Prefer named exports", "personal", "default", "imported", null],
      ["Replace Jest with Vitest", "project", "override", "imported", other.ids[0]],
    ]);
    assert.throws(() => other.host.importPreferences(preview.previewId, { personal: false, projects: [{ source: "p1", project: null }] }), /no longer waiting/);
  });

  it("imports a project's preferences without the file's personal ones, and another project's runs get what they got before (D23)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    const source = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "native")) }] });
    source.host.addPreference({ statement: "Prefer named exports", scope: "personal", projectId: null });
    source.host.addPreference({ statement: "Tests in __tests__", scope: "project", projectId: source.ids[0]! });
    const { text } = await source.host.exportPreferences({ personal: true, projectIds: [source.ids[0]!] });

    const { host, ids } = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(root, "elsewhere", "native")) }, { targetId: "local", path: makeRepo(join(root, "elsewhere", "tools")) }] });
    host.addPreference({ statement: "Keep functions small", scope: "personal", projectId: null });
    host.addPreference({ statement: "Run checks through pnpm scripts", scope: "project", projectId: ids[1]! });
    await host.open(ids[1]!);
    await online(host, "local");
    const before = await received(host, (await host.startHello(ids[1]!, 0)).id);
    const personal = () => host.preferences().records.filter((r) => r.scope === "personal");
    const personalBefore = personal();

    const preview = host.previewImport(text);
    assert.deepEqual(host.importPreferences(preview.previewId, { personal: false, projects: [{ source: "p1", project: ids[0]! }] }), { added: 1, alreadyHere: 0, leftOut: 1 });
    assert.deepEqual(personal(), personalBefore, "the file's personal preference stayed out");
    const after = await received(host, (await host.startHello(ids[1]!, 0)).id);
    assert.deepEqual([after.revision, after.count, after.digest, after.records], [before.revision + 1, before.count, before.digest, before.records], "the other project's runs get the same preferences");
    const statements = (records: Array<{ id: string }>) => records.map((r) => host.preferences().records.find((p) => p.id === r.id)?.statement).sort();
    assert.deepEqual(statements((await received(host, (await host.startHello(ids[0]!, 0)).id)).records), ["Keep functions small", "Tests in __tests__"]);
  });

  it("adds each picked folder for the engine that owns it, and refuses what can't run, saying why", async () => {
    const { host } = makeHost();
    const linux = await host.addPicked("\\\\wsl.localhost\\test\\home\\odin\\repo ü%#");
    assert.equal(linux.status, "added");
    assert.deepEqual(linux.status === "added" ? [linux.project.targetId, linux.project.displayPath, linux.project.targetLabel] : null, ["wsl:Test", "/home/odin/repo ü%#", "Test · WSL"]);
    const drive = await host.addPicked("C:\\Work\\Repo");
    assert.deepEqual(drive.status === "added" ? [drive.project.targetId, drive.project.targetLabel] : null, ["local", "Windows · Local"]);
    const again = await host.addPicked("c:\\work\\repo\\");
    assert.equal(again.status === "added" ? again.project.id : null, drive.status === "added" ? drive.project.id : "", "the same folder isn't added twice");
    const viaWsl = await host.addPicked("\\\\wsl.localhost\\Test\\mnt\\c\\Work\\Repo");
    assert.equal(viaWsl.status === "added" ? viaWsl.project.id : null, drive.status === "added" ? drive.project.id : "", "a drive seen through WSL is the same Windows folder");
    assert.match(viaWsl.status === "added" ? (viaWsl.warning ?? "") : "", /drive C:/);

    const refused = async (picked: string) => {
      const result = await host.addPicked(picked);
      return result.status === "refused" ? result.reason : `not refused: ${result.status}`;
    };
    assert.match(await refused("\\\\wsl.localhost\\docker-desktop\\tmp"), /Docker Desktop's own distribution/);
    assert.match(await refused("\\\\wsl.localhost\\Nope\\home"), /can't find a WSL distribution named Nope/);
    assert.match(await refused("\\\\server\\share\\repo"), /network share/);
    assert.equal(host.projects().length, 2);

    const broken = makeHost({ wsl: "broken" }).host;
    assert.match(await (async () => {
      const result = await broken.addPicked("\\\\wsl.localhost\\Test\\home\\odin\\repo");
      return result.status === "refused" ? result.reason : "";
    })(), /WSL didn't answer \(WSL_E_TEST\)/);
  });
});

describe("Host: explaining needs the project's consent, and withdrawing it stops the run (D20, D22)", () => {
  const KEY = "test-key-0123456789";
  const ANSWER = { summary: "A repository with a README.", findings: [{ statement: "It has a README.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }], gaps: [] };
  /** Reads the README, then answers: stateless, so runs on two engines can share one stub. */
  const readThenAnswer = (answer: () => Record<string, unknown>) => (request: StubRequest): Reply =>
    request.raw.includes('"role":"tool"') ? toolCall("submit_answer", answer(), { id: "c1" }) : toolCall("read_file", { path: "README.md" }, { id: "c0" });

  async function stubWith(chat: (request: StubRequest, index: number) => Reply) {
    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat });
    stubs.push(stub);
    return stub;
  }
  const reposRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    return root;
  };
  const headOf = (repo: string) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const ended = (host: Host, runId: string) =>
    waitFor(async () => {
      const page = await host.runEvents(runId, 0);
      return isTerminal(page.status) ? page : null;
    }, "the run to end");

  it("starts every project with sharing off, and refuses to explain before starting any engine", async () => {
    const stub = await stubWith(() => httpError(500, "unused"));
    const { host, ids } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    assert.deepEqual(host.projects().map((p) => p.sharing.modelContext), [false]);
    await assert.rejects(host.startExplain(ids[0]!, "", []), /doesn't allow sending its content to Token Factory/);
    assert.deepEqual([stateOf(host, "local")?.status, stub.requests.length], ["stopped", 0]);
  });

  it("never submits a run whose consent was withdrawn while its engine was starting", async () => {
    const stub = await stubWith(() => httpError(500, "unused"));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const preparing = new Promise<void>((resolve) => (entered = resolve));
    const { host, ids, keys, root } = makeHost({
      tokenFactoryUrl: stub.url,
      beforeWslPrepare: async () => {
        entered();
        await gate;
      },
      projects: [{ targetId: "wsl:Test", path: makeRepo(join(reposRoot(), "linux"), { "README.md": "# Linux\n" }) }],
    });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.setSharing(ids[0]!, true);
    const starting = host.startExplain(ids[0]!, "", []);
    await preparing;
    await host.setSharing(ids[0]!, false);
    release();
    await assert.rejects(starting, /turned off, so the run wasn't started/);
    await online(host, "wsl:Test");
    await host.shutdown();
    assert.deepEqual([storedRuns(join(root, "wsl home")), stub.requests.length], [[], 0]);
  });

  it("cancels a queued explanation when consent is withdrawn, before it sends anything", async () => {
    const stub = await stubWith(() => httpError(500, "unused"));
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.open(ids[0]!);
    await online(host, "local");
    // Both run slots are held, so the explanation waits in the queue.
    const holds = [await host.startHello(ids[0]!, 60_000), await host.startHello(ids[0]!, 60_000)];
    for (const hold of holds) await waitFor(async () => (await host.runEvents(hold.id, 0)).events.some((e) => e.message.includes("Holding a child process")), "the hello run to hold");
    await host.setSharing(ids[0]!, true);
    const run = await host.startExplain(ids[0]!, "", []);
    assert.equal(run.status, "queued");
    await host.setSharing(ids[0]!, false);
    assert.deepEqual([(await ended(host, run.id)).status, stub.requests.length], ["cancelled", 0]);
    for (const hold of holds) await host.cancelRun(hold.id);
  });

  it("stops a running explanation when consent is withdrawn after its first model call, and makes no further request", async () => {
    const stub = await stubWith((_request, index) => (index === 0 ? toolCall("read_file", { path: "README.md" }, { id: "c0" }) : { ...toolCall("submit_answer", ANSWER, { id: "c1" }), delayMs: 3_000 }));
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "wsl:Test", path: makeRepo(join(reposRoot(), "linux"), { "README.md": "# Linux\n" }) }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.open(ids[0]!);
    await online(host, "wsl:Test");
    await host.setSharing(ids[0]!, true);
    const run = await host.startExplain(ids[0]!, "", []);
    await waitFor(() => stub.chats().length === 2, "the second model call");
    await host.setSharing(ids[0]!, false);
    assert.equal((await ended(host, run.id)).status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal(stub.chats().length, 2);
  });

  it("stops a run whose project is removed while its submission is out, and keeps nothing of the project", async () => {
    const { host, ids, root } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    const home = join(root, "local home");
    const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter((method) => method.startsWith("runs.")) : []);
    await host.setSharing(ids[0]!, true);
    await host.open(ids[0]!);
    await online(host, "local");
    const starting = host.startExplain(ids[0]!, "", []);
    await waitFor(() => calls().includes("runs.start"), "the submission to reach the engine");
    await host.removeProject(ids[0]!);
    writeFileSync(join(home, "release"), "");
    await assert.rejects(starting, /removed while its explanation was starting, so the run was stopped/);
    assert.deepEqual([host.projects().length, calls()], [0, ["runs.start", "runs.cancel"]]);
  });

  it("keeps nothing for a project removed while the suggestion's result is being read (D23)", async () => {
    const { host, ids, root } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    const home = join(root, "local home");
    const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter((method) => method.startsWith("runs.")) : []);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "release"), "");
    writeFileSync(join(home, "hold-result"), "");
    await host.setSharing(ids[0]!, true);
    await host.open(ids[0]!);
    await online(host, "local");
    const run = await host.startExplain(ids[0]!, "", []);
    const keeping = host.keepSuggestion(ids[0]!, run.id, 0, "Name component files in PascalCase.");
    await waitFor(() => calls().includes("runs.result"), "the result to be asked for");
    await host.removeProject(ids[0]!);
    writeFileSync(join(home, "release-result"), "");
    await assert.rejects(keeping, /removed while the suggestion was being kept, so nothing was saved/);
    assert.deepEqual([host.projects().length, host.preferences().records.length], [0, 0]);
  });

  it("refuses a new explanation once removal has begun, while it waits for the project's runs to stop", async () => {
    const { host, ids, root } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    const home = join(root, "local home");
    const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter((method) => method.startsWith("runs.")) : []);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "release"), "");
    await host.setSharing(ids[0]!, true);
    await host.open(ids[0]!);
    await online(host, "local");
    await host.startExplain(ids[0]!, "", []);
    // Removal stops the first run, and the engine holds its answer: removal is waiting.
    writeFileSync(join(home, "hold-cancel"), "");
    const removing = host.removeProject(ids[0]!);
    await waitFor(() => calls().includes("runs.cancel"), "removal to ask for the run to stop");
    await assert.rejects(host.startExplain(ids[0]!, "", []), /being removed, so it can't be explained/);
    writeFileSync(join(home, "release-cancel"), "");
    await removing;
    assert.deepEqual([host.projects().length, calls()], [0, ["runs.start", "runs.cancel"]]);
  });

  it("keeps a project whose explanation can't be stopped, and says why", async () => {
    const { host, ids, root } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "release"), "");
    await host.setSharing(ids[0]!, true);
    await host.open(ids[0]!);
    await online(host, "local");
    await host.startExplain(ids[0]!, "", []);
    writeFileSync(join(home, "fail-cancel"), "");
    await assert.rejects(host.removeProject(ids[0]!), /couldn't stop an explain run \(the run couldn't be stopped\), so the project is still in the list/);
    assert.equal(host.projects().length, 1);
  });

  it("cancels a project's running explanation when the project is removed, and makes no further request", async () => {
    const stub = await stubWith((_request, index) => (index === 0 ? toolCall("read_file", { path: "README.md" }, { id: "c0" }) : { ...toolCall("submit_answer", ANSWER, { id: "c1" }), delayMs: 3_000 }));
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "wsl:Test", path: makeRepo(join(reposRoot(), "linux"), { "README.md": "# Linux\n" }) }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.open(ids[0]!);
    await online(host, "wsl:Test");
    await host.setSharing(ids[0]!, true);
    const run = await host.startExplain(ids[0]!, "", []);
    await waitFor(() => stub.chats().length === 2, "the second model call");
    await host.removeProject(ids[0]!);
    assert.equal((await ended(host, run.id)).status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.deepEqual([host.projects().length, stub.chats().length], [0, 2]);
  });

  it("explains each project on its own engine with its own files and preferences, never another project's", async () => {
    const [aFile, aPref, bFile, bPref, personal] = Array.from({ length: 5 }, () => `nivra-canary-${randomUUID()}`);
    const stub = await stubWith(readThenAnswer(() => ANSWER));
    const root = reposRoot();
    const a = makeRepo(join(root, "a"), { "README.md": `# A ${aFile}\n` });
    const b = makeRepo(join(root, "b"), { "README.md": `# B ${bFile}\n` });
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: a }, { targetId: "wsl:Test", path: b }] });
    const [projectA, projectB] = ids as [string, string];
    keys.current = { NEBIUS_API_KEY: KEY };
    host.addPreference({ statement: `Prefer named exports ${personal}`, scope: "personal", projectId: null });
    host.addPreference({ statement: `Tests live in __tests__ ${aPref}`, scope: "project", projectId: projectA });
    host.addPreference({ statement: `Tests sit next to the code ${bPref}`, scope: "project", projectId: projectB });
    for (const id of ids) await host.setSharing(id, true);
    await Promise.all(ids.map((id) => host.open(id)));
    await Promise.all([online(host, "local"), online(host, "wsl:Test")]);

    const sentDuring = async (projectId: string) => {
      const before = stub.chats().length;
      const run = await host.startExplain(projectId, "", []);
      assert.equal((await ended(host, run.id)).status, "succeeded");
      return { run, sent: stub.chats().slice(before).map((chat) => chat.raw).join("\n") };
    };
    const onB = await sentDuring(projectB);
    assert.deepEqual([onB.sent.includes(bFile), onB.sent.includes(bPref), onB.sent.includes(personal)], [true, true, true], "B's run sent B's file and preferences");
    assert.deepEqual([onB.sent.includes(aFile), onB.sent.includes(aPref)], [false, false], "and nothing of A's own");
    const onA = await sentDuring(projectA);
    assert.deepEqual([onA.sent.includes(aFile), onA.sent.includes(aPref), onA.sent.includes(bFile), onA.sent.includes(bPref)], [true, true, false, false]);

    // Each result comes from the engine that ran it.
    const [resultA, resultB] = [await host.runResult(onA.run.id), await host.runResult(onB.run.id)];
    assert.deepEqual([resultA.result?.headAtStart, resultB.result?.headAtStart], [headOf(a), headOf(b)]);
    assert.deepEqual([resultA.summary.route?.endpoint, resultB.summary.route?.endpoint], ["loopback-test", "loopback-test"]);
    await assert.rejects(host.runResult(randomUUID()), /no record of that run in this session/);
  });

  it("sends an edited preference to the next explanation and none once deleted; an old result keeps the revision it saw", async () => {
    const [first, edited] = [`nivra-canary-${randomUUID()}`, `nivra-canary-${randomUUID()}`];
    let differenceId = "";
    const stub = await stubWith(
      readThenAnswer(() => ({
        ...ANSWER,
        conflicts: differenceId ? [{ topic: "component file names", repositoryConvention: "kebab-case files", citations: [{ path: "README.md", startLine: 1, endLine: 1 }], preferenceIds: [differenceId] }] : [],
      })),
    );
    const repo = makeRepo(join(reposRoot(), "linux"), { "README.md": "# Linux, with kebab-case files\n" });
    const { host, ids, keys, root } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "wsl:Test", path: repo }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    const preference = host.addPreference({ statement: `Name component files in PascalCase ${first}`, scope: "project", projectId: ids[0]! });
    differenceId = preference.id;
    await host.setSharing(ids[0]!, true);
    await host.open(ids[0]!);
    await online(host, "wsl:Test");
    const explainOnce = async () => {
      const before = stub.chats().length;
      const run = await host.startExplain(ids[0]!, "", []);
      assert.equal((await ended(host, run.id)).status, "succeeded");
      return { run, sent: stub.chats().slice(before).map((chat) => chat.raw).join("\n") };
    };

    const original = await explainOnce();
    assert.equal(original.sent.includes(first), true);
    // Each explain run records what it was given; the fingerprint is worked out here independently (D21).
    const given = await received(host, original.run.id);
    assert.deepEqual([given.count, given.records.map((r) => [r.id, r.revision]), given.digest], [1, [[preference.id, 1]], digestOf([preference])]);
    const editedRecord = host.editPreference(preference.id, { statement: `Name component files in PascalCase, always ${edited}` });
    const afterEdit = await explainOnce();
    assert.deepEqual([afterEdit.sent.includes(edited), afterEdit.sent.includes(first)], [true, false]);
    assert.equal((await received(host, afterEdit.run.id)).digest, digestOf([editedRecord]));
    const { result } = await host.runResult(original.run.id);
    assert.deepEqual(result?.conflicts.map((c) => c.preferences.map((p) => [p.id, p.revision])), [[[preference.id, 1]]], "the old result keeps the revision it was given");
    assert.equal(host.preferences().records.find((r) => r.id === preference.id)?.revision, 2);

    host.deletePreference(preference.id);
    differenceId = "";
    const afterDelete = await explainOnce();
    assert.deepEqual([afterDelete.sent.includes(edited), afterDelete.sent.includes("no confirmed preferences")], [false, true]);
    assert.equal((await received(host, afterDelete.run.id)).count, 0);

    await host.shutdown();
    assert.deepEqual([filesHolding(root, first), filesHolding(root, edited)], [[], []], "no statement outlives its deletion, in any store or log");
  });

  it("keeps a suggestion from one of the project's runs as its own default, with the result's evidence, once, and never for another project (D23)", async () => {
    const statement = `Keep a README at the top of the repository ${randomUUID()}`;
    const stub = await stubWith(readThenAnswer(() => ({ ...ANSWER, suggestions: [{ statement: "Keep a README", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }] })));
    const root = reposRoot();
    const { host, ids, keys } = makeHost({
      tokenFactoryUrl: stub.url,
      projects: [{ targetId: "local", path: makeRepo(join(root, "a"), { "README.md": "# A\n" }) }, { targetId: "local", path: makeRepo(join(root, "b"), { "README.md": "# B\n" }) }],
    });
    const [projectA, projectB] = ids as [string, string];
    keys.current = { NEBIUS_API_KEY: KEY };
    for (const id of ids) await host.setSharing(id, true);
    await host.open(projectA);
    await online(host, "local");
    const explainOn = async (projectId: string) => {
      const before = stub.chats().length;
      const run = await host.startExplain(projectId, "", []);
      assert.equal((await ended(host, run.id)).status, "succeeded");
      return { run, sent: stub.chats().slice(before).map((chat) => chat.raw).join("\n") };
    };
    const { run } = await explainOn(projectA);

    await assert.rejects(host.keepSuggestion(projectB, run.id, 0, statement), /no record of for this project in this session/);
    await assert.rejects(host.keepSuggestion(projectA, run.id, 3, statement), /isn't in the run's result/);
    // A double click: two keeps at once save one record, in the wording the person confirmed.
    const [first, second] = await Promise.all([host.keepSuggestion(projectA, run.id, 0, `  ${statement} `), host.keepSuggestion(projectA, run.id, 0, statement)]);
    assert.equal(first.id, second.id);
    const kept = host.preferences().records.filter((r) => r.origin === "suggested");
    assert.deepEqual(
      kept.map((r) => [r.statement, r.scope, r.projectId, r.intent, r.status, r.evidence?.runId, r.evidence?.suggestion, r.evidence?.citations]),
      [[statement, "project", projectA, "default", "confirmed", run.id, 0, [{ path: "README.md", startLine: 1, endLine: 1 }]]],
    );

    // A's next run gets it; B's never does.
    assert.equal((await explainOn(projectA)).sent.includes(statement), true);
    assert.equal((await explainOn(projectB)).sent.includes(statement), false);

    // Nothing can be kept for a project being removed, or gone.
    const removing = host.removeProject(projectA);
    await assert.rejects(host.keepSuggestion(projectA, run.id, 0, statement), /being removed, so nothing can be kept/);
    await removing;
    await assert.rejects(host.keepSuggestion(projectA, run.id, 0, statement), /no longer in the list/);
  });

  it("sends a task's choices with that run only, and leaves the host's store byte-identical (D23)", async () => {
    const choice = `Keep Jest for this task ${randomUUID()}`;
    const stub = await stubWith(readThenAnswer(() => ANSWER));
    const { host, ids, keys, root } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    host.addPreference({ statement: "Use Vitest", scope: "personal", projectId: null });
    await host.setSharing(ids[0]!, true);
    await host.open(ids[0]!);
    await online(host, "local");
    const store = join(root, "nivra.json");
    const before = readFileSync(store);

    const run = await host.startExplain(ids[0]!, "", [`  ${choice}  `]);
    assert.equal((await ended(host, run.id)).status, "succeeded");
    assert.ok(stub.chats().some((chat) => chat.raw.includes(choice)), "the choice reached the model");
    assert.deepEqual((await host.runResult(run.id)).result?.choices, [{ id: "c1", text: choice }]);
    assert.equal(readFileSync(store).equals(before), true, "the run changed nothing in nivra.json");

    const sent = stub.chats().length;
    const next = await host.startExplain(ids[0]!, "", []);
    assert.equal((await ended(host, next.id)).status, "succeeded");
    assert.equal(stub.chats().slice(sent).some((chat) => chat.raw.includes(choice)), false, "the next run doesn't carry it");
    assert.equal(filesHolding(root, choice).includes("nivra.json"), false);
  });

  it("refuses choices it can't send, saying what to fix, before starting any engine", async () => {
    const stub = await stubWith(() => httpError(500, "unused"));
    const { host, ids } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    await host.setSharing(ids[0]!, true);
    const refusal = (choices: string[]) => host.startExplain(ids[0]!, "", choices).then(() => "started", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    const messages = [await refusal(["1", "2", "3", "4", "5", "6"]), await refusal(["Use pnpm", "  "]), await refusal(["x".repeat(301)]), await refusal(["Use pnpm", " Use pnpm "])];
    assert.match(messages[0]!, /at most 5 choices; this one has 6\. Remove some, then explain again\.$/);
    assert.match(messages[1]!, /^A choice needs some words/);
    assert.match(messages[2]!, /at most 300 characters; one has 301\. Shorten it/);
    assert.match(messages[3]!, /^The same choice is there twice/);
    assert.deepEqual([stateOf(host, "local")?.status, stub.requests.length], ["stopped", 0]);
  });
});

describe("Host: the workspace keeps conversations, and starting one starts no engine (D26)", () => {
  it("keeps general and project conversations, each on its own engine, and still has them after a restart", async () => {
    const { host, root, ids } = makeHost({ projects: [{ targetId: "local", path: "/repos/app" }] });
    const empty = host.conversations();
    assert.deepEqual([empty.workspace.state, empty.conversations.length], ["ready", 0]);
    const general = host.createConversation({ kind: "general" });
    const about = host.createConversation({ kind: "project", projectId: ids[0]! });
    assert.deepEqual(
      [general.kind, general.projectId, general.targetId, general.projectPresent, about.kind, about.projectId, about.projectLabel, about.targetId, about.projectPresent],
      ["general", null, "local", null, "project", ids[0], "app", "local", true],
    );
    // Starting a conversation reaches no engine.
    assert.deepEqual(host.engines().map((e) => e.state.status), ["stopped"]);
    await host.shutdown();
    const again = hostAt(root).host;
    assert.deepEqual(
      again.conversations().conversations.map((c) => c.id).sort(),
      [general.id, about.id].sort(),
    );
  });

  it("keeps a project conversation's scope and label after its project is removed, and starts none for a removed project", async () => {
    const { host, ids } = makeHost({ projects: [{ targetId: "local", path: "/repos/app" }] });
    const about = host.createConversation({ kind: "project", projectId: ids[0]! });
    await host.removeProject(ids[0]!);
    const kept = host.conversations().conversations.find((c) => c.id === about.id)!;
    assert.deepEqual([kept.projectId, kept.projectLabel, kept.projectPresent], [ids[0], "app", false]);
    assert.throws(() => host.createConversation({ kind: "project", projectId: ids[0]! }), /That project is no longer in the list/);
  });

  it("says why its workspace can't be used while another Nivra holds it, and everything else still works", () => {
    const { host, root } = makeHost({ projects: [{ targetId: "local", path: "/repos/app" }] });
    host.createConversation({ kind: "general" });
    const second = hostAt(root).host;
    const view = second.conversations();
    assert.equal(view.workspace.state, "unavailable");
    assert.match(view.workspace.state === "unavailable" ? view.workspace.reason : "", /^Another copy of Nivra is using your history/);
    assert.throws(() => second.createConversation({ kind: "general" }), /^Error: Another copy of Nivra is using your history/);
    assert.equal(second.projects().length, 1);
  });
});

describe("Host: conversations follow each turn to its end, and never resend one (D26)", () => {
  const KEY = "test-key-0123456789";
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function stubWith(chat: (request: StubRequest, index: number) => Reply) {
    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat });
    stubs.push(stub);
    return stub;
  }
  const reposRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "nivra conversation repos "));
    dirs.push(root);
    return root;
  };
  /** The conversation once its last turn has ended. */
  const settled = (host: Host, conversationId: string) =>
    waitFor(() => {
      const view = host.conversation(conversationId);
      const turn = view.turns.at(-1);
      return turn && turn.status !== "submitting" && turn.status !== "running" ? { view, turn } : null;
    }, "the turn to end");
  const calls = (home: string) => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
  /** A repository turn's reply: reads the README, then hands in evidence citing it. */
  const readThenReply = (request: StubRequest): Reply =>
    request.raw.includes('"role":"tool"')
      ? toolCall("submit_reply", { answer: "It is a small repository.", evidence: [{ statement: "It has a README.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }] }, { id: "r1" })
      : toolCall("read_file", { path: "README.md" }, { id: "r0" });

  it("answers a general turn with no tools, carries it into the next as history, and keeps both across a restart", async () => {
    const stub = await stubWith((_request, index) => text(index === 0 ? "First answer." : "Second answer."));
    const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "How should I stage this?");
    const first = await settled(host, conversation.id);
    assert.equal(first.turn.status, "answered", first.turn.note ?? "");
    assert.deepEqual(first.view.messages.map((m) => [m.role, m.text]), [["person", "How should I stage this?"], ["assistant", "First answer."]]);
    assert.equal(first.view.summary.title, "How should I stage this?");
    await host.sendMessage(conversation.id, "And then?");
    const second = await settled(host, conversation.id);
    assert.deepEqual([second.turn.status, second.turn.given.history?.exchanges], ["answered", 1]);
    const chats = stub.chats();
    assert.deepEqual([chats.length, chats[0]?.body?.tools, chats[1]?.body?.tools], [2, undefined, undefined]);
    const sent = JSON.stringify(chats[1]?.body?.messages);
    assert.ok(sent.indexOf("How should I stage this?") < sent.indexOf("First answer.") && sent.indexOf("First answer.") < sent.indexOf("And then?"), "the history, oldest first, before the message");
    await host.shutdown();
    const again = hostAt(root, { tokenFactoryUrl: stub.url }).host;
    const reopened = await again.openConversation(conversation.id);
    assert.deepEqual(reopened.messages.map((m) => m.text), ["How should I stage this?", "First answer.", "And then?", "Second answer."]);
    assert.deepEqual([stub.chats().length, again.engines()], [2, []], "reopening sends nothing and starts no engine");
  });

  it("reads only a repository conversation's own project, and sends a general one no path and no project preference, whatever is opened meanwhile", async () => {
    const stub = await stubWith((request) => (request.body?.tools ? readThenReply(request) : text("General advice.")));
    const root = reposRoot();
    const alpha = makeRepo(join(root, "alpha"), { "README.md": "# Alpha\n" });
    const beta = makeRepo(join(root, "beta"), { "README.md": "# Beta\n" });
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: alpha }, { targetId: "local", path: beta }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.setSharing(ids[0]!, true);
    const personal = host.addPreference({ statement: "Write tests with Vitest", scope: "personal", projectId: null, intent: "default" });
    const alphaOwn = host.addPreference({ statement: `Alpha builds with Vite ${randomUUID()}`, scope: "project", projectId: ids[0]!, intent: "default" });
    const betaOwn = host.addPreference({ statement: `Beta builds with webpack ${randomUUID()}`, scope: "project", projectId: ids[1]!, intent: "default" });
    const aboutAlpha = host.createConversation({ kind: "project", projectId: ids[0]! });
    const general = host.createConversation({ kind: "general" });
    await host.open(ids[1]!);
    await host.sendMessage(aboutAlpha.id, "What is this?");
    const repo = await settled(host, aboutAlpha.id);
    assert.equal(repo.turn.status, "answered", repo.turn.note ?? "");
    assert.equal(repo.view.messages.at(-1)?.reply?.kind, "repository");
    await host.sendMessage(general.id, "Any advice?");
    const asked = await settled(host, general.id);
    assert.deepEqual([asked.turn.status, asked.turn.given.preferences, repo.turn.given.preferences], ["answered", 1, 2]);
    const repoSent = JSON.stringify(stub.chats().filter((c) => c.body?.tools).map((c) => c.body?.messages));
    assert.ok(repoSent.includes("# Alpha") && !repoSent.includes("# Beta"), "Alpha's files only");
    assert.deepEqual([repoSent.includes(alphaOwn.statement), repoSent.includes(personal.statement), repoSent.includes(betaOwn.statement)], [true, true, false]);
    const generalSent = JSON.stringify(stub.chats().filter((c) => !c.body?.tools).map((c) => c.body?.messages));
    assert.deepEqual(
      [generalSent.includes(personal.statement), generalSent.includes(alphaOwn.statement), generalSent.includes(betaOwn.statement), generalSent.includes(alpha), generalSent.includes("Repository map")],
      [true, false, false, false, false],
    );
  });

  it("reports a turn cut off by a graceful quit as interrupted after a restart, and sends nothing again", async () => {
    const stub = await stubWith(() => ({ ...text("Too late."), delayMs: 15_000 }));
    const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Slow?");
    await waitFor(() => stub.chats().length === 1, "the request to reach the stub");
    await host.shutdown();
    const again = hostAt(root, { tokenFactoryUrl: stub.url }).host;
    await again.openConversation(conversation.id);
    const { turn } = await settled(again, conversation.id);
    assert.deepEqual([turn.status, turn.note], ["interrupted", "Interrupted: Nivra or its engine stopped before the answer arrived. Nothing was resent."]);
    await pause(300);
    assert.equal(stub.chats().length, 1, "nothing was sent again");
  });

  it("reports a turn whose engine was killed as interrupted after a restart, and sends nothing again", async () => {
    const stub = await stubWith(() => ({ ...text("Too late."), delayMs: 15_000 }));
    const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Slow?");
    await waitFor(() => stub.chats().length === 1, "the request to reach the stub");
    const { pid } = await online(host, "local");
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid), "the engine to die");
    await host.shutdown();
    const again = hostAt(root, { tokenFactoryUrl: stub.url }).host;
    await again.openConversation(conversation.id);
    const { turn } = await settled(again, conversation.id);
    assert.equal(turn.status, "interrupted", turn.note ?? "");
    await pause(300);
    assert.equal(stub.chats().length, 1, "nothing was sent again");
  });

  it("restarts a general conversation's stopped engine: the turn it cut off is interrupted, nothing is resent, and the next turn is answered", async () => {
    const stub = await stubWith((_request, index) => (index === 0 ? { ...text("Too late."), delayMs: 15_000 } : text("Answered.")));
    const { host, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Slow?");
    await waitFor(() => host.conversation(conversation.id).turns[0]?.runId && stub.chats().length === 1, "the request to reach the stub");
    const { pid } = await online(host, "local");
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) && stateOf(host, "local")?.status !== "online", "the engine to stop");
    const waiting = host.conversation(conversation.id).turns[0]!;
    assert.deepEqual([waiting.status, waiting.unresolved !== null], ["running", true], "it waits, unresolved, while its engine is away");
    const restarted = await host.restartConversationEngine(conversation.id);
    assert.equal(restarted.engine.state.status, "online");
    const { turn } = await settled(host, conversation.id);
    assert.deepEqual([turn.status, turn.note], ["interrupted", "Interrupted: Nivra or its engine stopped before the answer arrived. Nothing was resent."]);
    await host.sendMessage(conversation.id, "Slow?");
    const next = await settled(host, conversation.id);
    assert.deepEqual([next.turn.status, next.view.turns.length, stub.chats().length], ["answered", 2, 2], "only the new turn was sent");
    await assert.rejects(host.restartConversationEngine(randomUUID()), { message: "That conversation is no longer in the list." });
  });

  it("finds a send whose answer was lost: adopted from the same store, not sent when that store has no record, unknown from another store", async () => {
    async function lost(options: { accept: boolean; replaceStore?: boolean }) {
      const { host, root, keys } = makeHost({ localEntry: GATED });
      keys.current = { NEBIUS_API_KEY: KEY };
      const home = join(root, "local home");
      mkdirSync(home, { recursive: true });
      if (options.accept) writeFileSync(join(home, "accept"), "");
      const conversation = host.createConversation({ kind: "general" });
      await host.sendMessage(conversation.id, "Lost?");
      await waitFor(() => calls(home).includes("runs.start"), "the request to reach the engine");
      // Nivra quits before runs.start answers.
      await host.shutdown();
      if (options.replaceStore) rmSync(join(home, "home-id"));
      const again = hostAt(root, { localEntry: GATED }).host;
      await again.openConversation(conversation.id);
      const { turn, view } = await settled(again, conversation.id);
      return { turn, view, starts: calls(home).filter((call) => call === "runs.start").length };
    }
    const adopted = await lost({ accept: true });
    assert.deepEqual([adopted.turn.status, adopted.view.messages.at(-1)?.text, adopted.starts], ["answered", "A gated reply.", 1]);
    const never = await lost({ accept: false });
    assert.deepEqual([never.turn.status, never.turn.note, never.starts], ["not-sent", "Its engine has no record of this message, so it never ran and nothing reached the model.", 1]);
    const elsewhere = await lost({ accept: true, replaceStore: true });
    assert.deepEqual([elsewhere.turn.status, elsewhere.starts], ["unknown", 1]);
    assert.match(elsewhere.turn.note ?? "", /^Nivra can't tell whether this message reached the model: it went to an engine whose records aren't here/);
  });

  it("adopts a run its engine accepted before answering with an error, and sends it only once", async () => {
    const { host, root, keys } = makeHost({ localEntry: GATED });
    keys.current = { NEBIUS_API_KEY: KEY };
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const file of ["accept", "error-start", "release"]) writeFileSync(join(home, file), "");
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Accepted, then an error?");
    const { turn, view } = await settled(host, conversation.id);
    assert.deepEqual([turn.status, view.messages.at(-1)?.text], ["answered", "A gated reply."]);
    assert.deepEqual([calls(home).filter((call) => call === "runs.start").length, calls(home).includes("runs.find")], [1, true]);
  });

  it("cancels a turn asked to stop while it was being sent, as soon as its engine answers", async () => {
    const { host, root, keys } = makeHost({ localEntry: GATED });
    keys.current = { NEBIUS_API_KEY: KEY };
    const home = join(root, "local home");
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Stop me.");
    await waitFor(() => calls(home).includes("runs.start"), "the request to reach the engine");
    const asked = await host.cancelTurn(conversation.id, host.conversation(conversation.id).turns[0]!.id);
    assert.deepEqual([asked.turns[0]?.status, asked.turns[0]?.cancelRequested], ["submitting", true]);
    writeFileSync(join(home, "release"), "");
    const { turn } = await settled(host, conversation.id);
    assert.deepEqual([turn.status, turn.note], ["cancelled", "Cancelled. Nothing was resent."]);
    assert.deepEqual([calls(home).filter((call) => call === "runs.start").length, calls(home).filter((call) => call === "runs.cancel").length], [1, 1]);
  });

  it("deletes a conversation while a turn is being sent, and stops the run when the engine answers", async () => {
    const { host, root, keys } = makeHost({ localEntry: GATED });
    keys.current = { NEBIUS_API_KEY: KEY };
    const home = join(root, "local home");
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Delete me.");
    await waitFor(() => calls(home).includes("runs.start"), "the request to reach the engine");
    await host.deleteConversation(conversation.id);
    assert.throws(() => host.conversation(conversation.id), /no longer in the list/);
    writeFileSync(join(home, "release"), "");
    await waitFor(() => calls(home).includes("runs.cancel"), "the late run to be stopped");
    assert.equal(host.conversations().conversations.length, 0);
  });

  it("stops the run of a conversation deleted while its turn was out, when the engine made the run but answered with an error", async () => {
    const { host, root, keys } = makeHost({ localEntry: GATED });
    keys.current = { NEBIUS_API_KEY: KEY };
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const file of ["accept", "error-start"]) writeFileSync(join(home, file), "");
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Delete me while you answer.");
    await waitFor(() => calls(home).includes("runs.start"), "the request to reach the engine");
    await host.deleteConversation(conversation.id);
    assert.throws(() => host.conversation(conversation.id), /no longer in the list/);
    writeFileSync(join(home, "release"), "");
    await waitFor(() => existsSync(join(home, "cancelled.log")), "the deleted conversation's run to be stopped");
    const made = readFileSync(join(home, "accepted.log"), "utf8").trim().split(" ")[1];
    assert.deepEqual([calls(home).filter((call) => call === "runs.find").length, readFileSync(join(home, "cancelled.log"), "utf8").trim().split("\n")], [1, [made]]);
    assert.deepEqual([host.conversations().conversations.length, calls(home).filter((call) => call === "runs.start").length], [0, 1]);
  });

  it("stops the run of a conversation deleted while its lost answer was still being looked for", async () => {
    const { host, root, keys } = makeHost({ localEntry: GATED });
    keys.current = { NEBIUS_API_KEY: KEY };
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const file of ["accept", "error-start", "release", "hold-find"]) writeFileSync(join(home, file), "");
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "Lose my answer, then delete me.");
    await waitFor(() => calls(home).includes("runs.find"), "the lost answer to be looked for");
    await host.deleteConversation(conversation.id);
    writeFileSync(join(home, "release-find"), "");
    await waitFor(() => existsSync(join(home, "cancelled.log")), "the deleted conversation's run to be stopped");
    const made = readFileSync(join(home, "accepted.log"), "utf8").trim().split(" ")[1];
    assert.deepEqual(readFileSync(join(home, "cancelled.log"), "utf8").trim().split("\n"), [made]);
    assert.equal(host.conversations().conversations.length, 0);
  });

  it("deletes a conversation while its answer is being projected, and the answer goes nowhere", async () => {
    const stub = await stubWith(() => text("An answer nobody keeps."));
    let host: Host | undefined;
    let conversationId = "";
    const deleted: string[] = [];
    const made = makeHost({
      tokenFactoryUrl: stub.url,
      testHooks: {
        beforeProjection: async (turnId) => {
          await host!.deleteConversation(conversationId);
          deleted.push(turnId);
        },
      },
    });
    host = made.host;
    made.keys.current = { NEBIUS_API_KEY: KEY };
    conversationId = host.createConversation({ kind: "general" }).id;
    await host.sendMessage(conversationId, "Answer me.");
    await waitFor(() => deleted.length === 1, "the deletion inside the projection");
    await pause(200);
    assert.equal(host.conversations().conversations.length, 0);
    await host.shutdown();
    const workspace = new DatabaseSync(join(made.root, "workspace.db"), { readOnly: true });
    try {
      const count = (table: string) => Number(workspace.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
      assert.deepEqual([count("messages"), count("run_links"), count("conversations")], [0, 0, 0]);
    } finally {
      workspace.close();
    }
    assert.deepEqual(filesHolding(made.root, "An answer nobody keeps.").filter((file) => file.startsWith("workspace.db")), []);
  });

  it("reads without starting an engine or asking one, and leaves a turn whose engine can't be reached unresolved, never failed", async () => {
    const stub = await stubWith(() => ({ ...toolCall("read_file", { path: "README.md" }), delayMs: 15_000 }));
    const repo = makeRepo(join(reposRoot(), "in wsl"), { "README.md": "# In WSL\n" });
    const { host, root, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "wsl:Test", path: repo }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.setSharing(ids[0]!, true);
    const conversation = host.createConversation({ kind: "project", projectId: ids[0]! });
    await host.sendMessage(conversation.id, "What is it?");
    await waitFor(() => stub.chats().length === 1, "the request to reach the stub");
    await host.shutdown();
    const again = hostAt(root, { tokenFactoryUrl: stub.url, wsl: "broken" }).host;
    const requests = stub.requests.length;
    const read = again.conversation(conversation.id);
    again.conversations();
    assert.deepEqual([read.turns[0]?.status, again.engines().map((e) => e.state.status), stub.requests.length], ["running", ["stopped"], requests]);
    const opened = await again.openConversation(conversation.id);
    assert.equal(opened.turns[0]?.status, "running");
    assert.match(opened.turns[0]?.unresolved ?? "", /WSL didn't answer/);
  });

  it("stops a repository turn when sharing is turned off, saying so, and refuses the next", async () => {
    const stub = await stubWith(() => ({ ...toolCall("read_file", { path: "README.md" }), delayMs: 15_000 }));
    const repo = makeRepo(join(reposRoot(), "shared"), { "README.md": "# Shared\n" });
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: repo }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.setSharing(ids[0]!, true);
    const conversation = host.createConversation({ kind: "project", projectId: ids[0]! });
    await host.sendMessage(conversation.id, "What is it?");
    await waitFor(() => stub.chats().length === 1, "the request to reach the stub");
    await host.setSharing(ids[0]!, false);
    const { turn } = await settled(host, conversation.id);
    assert.deepEqual([turn.status, turn.note], ["cancelled", "Stopped: sharing for this project was turned off. Nothing was resent."]);
    await assert.rejects(host.sendMessage(conversation.id, "Again?"), /doesn't allow sending its content to Token Factory/);
  });

  it("refuses a message holding a credential, masks one in an answer, and leaves no key anywhere it writes", async () => {
    const token = `ghp_${"z".repeat(36)}`;
    const stub = await stubWith(() => text(`Here is ${KEY} and ${token}.`));
    const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    await assert.rejects(host.sendMessage(conversation.id, `my key is ${KEY}`), /^Error: Your message holds your saved Token Factory key, so nothing was sent/);
    await assert.rejects(host.sendMessage(conversation.id, `token ${token}`), /^Error: Your message looks like it holds a GitHub token, so nothing was sent/);
    assert.deepEqual([host.conversation(conversation.id).messages.length, stub.chats().length], [0, 0]);
    await host.sendMessage(conversation.id, "Echo something?");
    const { view } = await settled(host, conversation.id);
    assert.equal(view.messages.at(-1)?.text, "Here is [secret:NEBIUS_API_KEY] and [redacted].");
    await host.shutdown();
    assert.deepEqual([filesHolding(root, KEY), filesHolding(root, token)], [[], []]);
  });
});

describe("Host: native tasks, made directly or from a plan, with versioned briefs (D26, NIV-32)", () => {
  const KEY = "test-key-0123456789";
  const empty = { goal: "", acceptanceCriteria: [] as string[], scope: "", exclusions: "", context: "", assumptions: [] as string[], checks: [] as string[], acceptanceCases: [] as Array<{ name: string; command: string; expectedOutput: string; expectedExitCode: number }> };
  async function stubWith(chat: (request: StubRequest, index: number) => Reply) {
    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat });
    stubs.push(stub);
    return stub;
  }
  const answered = (host: Host, conversationId: string) =>
    waitFor(() => {
      const view = host.conversation(conversationId);
      return view.turns.at(-1)?.status === "answered" ? view.messages.find((m) => m.role === "assistant")! : null;
    }, "the answer");

  it("gives a direct task and one from a plan the same brief, keeps a brief from v1 while the plan moves on, and keeps it when the conversation goes", async () => {
    const stub = await stubWith(() => text("Stage it: the parser first, then the cache."));
    const { host, keys, root } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    await host.sendMessage(conversation.id, "How do I stage the refactor?");
    const answer = await answered(host, conversation.id);
    const plan = await host.savePlan(conversation.id, answer.id);
    assert.deepEqual([plan.version, plan.text, plan.latest, plan.projectId, plan.assumptions], [1, "Stage it: the parser first, then the cache.", 1, null, []]);
    const fields = { ...empty, goal: "Stage the refactor", acceptanceCriteria: ["The parser's tests pass"] };
    const direct = await host.createTask({ title: "Refactor, written directly", fields, projectId: null, planId: null });
    const planned = await host.createTask({ title: "Refactor, from the plan", fields: { ...fields, context: plan.text }, projectId: null, planId: plan.id });
    assert.deepEqual(Object.keys(direct.brief.content).sort(), Object.keys(planned.brief.content).sort());
    assert.deepEqual(
      [direct.summary.state, direct.brief.version, direct.brief.content.sources, planned.brief.content.sources.map((source) => [source.planVersion, source.conversationId, source.projectId])],
      ["draft", 1, [], [[1, conversation.id, null]]],
    );
    assert.deepEqual([direct.runBlocked, direct.attempts], ["Mark the task ready first: a run needs a goal and at least one acceptance criterion.", []]);
    const v2 = await host.revisePlan(plan.id, "Stage it: the cache first, then the parser.");
    assert.deepEqual([v2.version, v2.latest, host.plans(conversation.id).map((p) => p.version)], [2, 2, [1, 2]]);
    const marked = host.task(planned.summary.id);
    assert.deepEqual(
      [marked.brief.version, marked.brief.content.context, marked.sourcePlans],
      [1, plan.text, [{ planLineage: plan.lineageId, usedVersion: 1, latestVersion: 2, latestPlanId: v2.id, conversationId: conversation.id }]],
    );
    const refreshed = host.refreshBriefFromPlan(planned.summary.id, marked.revision, v2.id);
    assert.deepEqual([refreshed.brief.version, refreshed.brief.content.context, refreshed.brief.content.sources[0]?.planVersion], [2, "Stage it: the cache first, then the parser.", 2]);
    const listed = host.tasks();
    assert.deepEqual([listed.workspace.state, listed.tasks.map((t) => t.title)], ["ready", ["Refactor, from the plan", "Refactor, written directly"]], "the most recently changed first");
    await host.deleteConversation(conversation.id);
    const kept = host.task(planned.summary.id);
    assert.deepEqual([kept.brief.content.context, kept.sourcePlans[0]?.latestVersion, kept.sourcePlans[0]?.latestPlanId, kept.versions.length], ["Stage it: the cache first, then the parser.", null, null, 2]);
    // In the file itself: the question lived only in the conversation, so no copy is left; the brief's text stays with the task.
    await host.shutdown();
    const workspaceFiles = (needle: string) => filesHolding(root, needle).filter((file) => file.startsWith("workspace.db"));
    assert.deepEqual([workspaceFiles("How do I stage the refactor?"), workspaceFiles("Stage it: the cache first, then the parser.").length > 0], [[], true]);
  });

  it("moves a task through its states only as its brief allows, and refuses a change made from an older view", async () => {
    const { host } = makeHost({});
    const task = await host.createTask({ title: "Tidy the README", fields: empty, projectId: null, planId: null });
    assert.throws(() => host.setTaskState(task.summary.id, task.revision, "ready"), /has a goal and at least one acceptance criterion/);
    const written = await host.reviseBrief(task.summary.id, task.revision, { ...empty, goal: "Tidy it", acceptanceCriteria: ["Every heading is sentence case"] });
    assert.equal(written.brief.version, 2);
    assert.throws(() => host.setTaskState(task.summary.id, task.revision, "ready"), /changed since you opened it/);
    const ready = host.setTaskState(task.summary.id, written.revision, "ready");
    assert.throws(() => host.setTaskState(task.summary.id, ready.revision, "active"), /^Error: A task can't be marked active by hand\.$/);
    const emptied = await host.reviseBrief(task.summary.id, ready.revision, { ...empty, goal: "Tidy it" });
    assert.equal(emptied.summary.state, "draft", "a ready task whose brief lost its criteria is a draft again");
    const again = await host.reviseBrief(task.summary.id, emptied.revision, { ...empty, goal: "Tidy it", acceptanceCriteria: ["Every heading is sentence case"] });
    const done = host.setTaskState(task.summary.id, host.setTaskState(task.summary.id, again.revision, "ready").revision, "completed");
    assert.equal(done.summary.state, "completed");
    await assert.rejects(host.reviseBrief(task.summary.id, done.revision, { ...empty, goal: "More" }), /Reopen it to change its brief/);
    assert.equal(host.setTaskState(task.summary.id, done.revision, "draft").summary.state, "draft");
  });

  it("clears what a brief took from one project's conversation when the task is made for, or moved to, another repository", async () => {
    const stub = await stubWith((request) =>
      request.raw.includes('"role":"tool"')
        ? toolCall("submit_reply", { answer: "Add the export beside the list.", evidence: [{ statement: "It has a README.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }], assumptions: ["Alpha uses Vite"] })
        : toolCall("read_file", { path: "README.md" }),
    );
    const root = mkdtempSync(join(tmpdir(), "nivra task repos "));
    dirs.push(root);
    const alpha = makeRepo(join(root, "alpha"), { "README.md": "# Alpha\n" });
    const beta = makeRepo(join(root, "beta"), { "README.md": "# Beta\n" });
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: alpha }, { targetId: "local", path: beta }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.setSharing(ids[0]!, true);
    const conversation = host.createConversation({ kind: "project", projectId: ids[0]! });
    await host.sendMessage(conversation.id, "Plan a CSV export");
    const answer = await answered(host, conversation.id);
    const plan = await host.savePlan(conversation.id, answer.id);
    assert.match(plan.text, /^Add the export beside the list\.\n\nAssumed:\n- Alpha uses Vite$/);
    assert.deepEqual([plan.projectId, plan.assumptions], [ids[0], ["Alpha uses Vite"]], "what a task made from it starts with");
    const task = await host.createTask({ title: "CSV export", fields: { ...empty, goal: "Export the list", context: plan.text, assumptions: ["Alpha uses Vite"] }, projectId: ids[0]!, planId: plan.id });
    assert.deepEqual([task.brief.content.sources[0]?.projectId, task.brief.content.sources[0]?.citations], [ids[0], [{ path: "README.md", startLine: 1, endLine: 1 }]]);
    // Made from alpha's plan for beta, or for no repository yet: the same rule as moving a task.
    for (const projectId of [ids[1]!, null]) {
      const elsewhere = await host.createTask({ title: "CSV export elsewhere", fields: { ...empty, goal: "Export the list", context: plan.text, assumptions: ["Alpha uses Vite"] }, projectId, planId: plan.id });
      assert.deepEqual(
        [elsewhere.summary.projectId, elsewhere.brief.version, elsewhere.brief.content.sources, elsewhere.brief.content.context, elsewhere.brief.content.assumptions, elsewhere.brief.content.revalidate, elsewhere.brief.content.goal, elsewhere.sourcePlans],
        [projectId, 1, [], "", [], ["context", "assumptions"], "Export the list", []],
      );
    }
    const moved = host.setTaskProject(task.summary.id, task.revision, ids[1]!);
    assert.deepEqual(
      [moved.summary.projectId, moved.brief.version, moved.brief.content.sources, moved.brief.content.context, moved.brief.content.assumptions, moved.brief.content.revalidate, moved.brief.content.goal],
      [ids[1], 2, [], "", [], ["context", "assumptions"], "Export the list"],
    );
    const rewritten = await host.reviseBrief(task.summary.id, moved.revision, { ...empty, goal: "Export the list", context: "Beta's own context." });
    assert.deepEqual([rewritten.brief.content.revalidate, rewritten.versions.map((v) => v.version)], [["assumptions"], [1, 2, 3]]);
  });

  it("refuses an oversized brief in words that name the field, its size and the limit, and keeps what fits, trimmed", async () => {
    const { host } = makeHost({});
    const cases: Array<[Partial<typeof empty>, string]> = [
      [{ goal: "g".repeat(4_001) }, "The goal is 4001 characters long, and it can hold 4000. Shorten it, then save it again."],
      [{ context: ` ${"c".repeat(20_001)} ` }, "The context is 20001 characters long, and it can hold 20000. Shorten it, then save it again."],
      [{ acceptanceCriteria: Array.from({ length: 21 }, (_, i) => `Criterion ${i + 1}`) }, "There are 21 acceptance criteria, and a brief can hold 20. Remove some, then save it again."],
      [{ checks: ["Lint", "", "k".repeat(1_001)] }, "Check 3 is 1001 characters long, and each can hold 1000. Shorten it, then save it again."],
    ];
    for (const [fields, message] of cases) {
      await assert.rejects(host.createTask({ title: "Sized", fields: { ...empty, ...fields }, projectId: null, planId: null }), { message });
    }
    assert.equal(host.tasks().tasks.length, 0);
    // Padding doesn't count against a limit, and empty rows are dropped.
    const fits = await host.createTask({ title: "Sized", fields: { ...empty, goal: `  ${"g".repeat(4_000)}  `, acceptanceCriteria: ["", "  Done  ", " "] }, projectId: null, planId: null });
    assert.deepEqual([fits.brief.content.goal.length, fits.brief.content.acceptanceCriteria], [4_000, ["Done"]]);
    await assert.rejects(host.reviseBrief(fits.summary.id, fits.revision, { ...empty, assumptions: ["a".repeat(1_001)] }), { message: "Assumption 1 is 1001 characters long, and each can hold 1000. Shorten it, then save it again." });
    assert.equal(host.task(fits.summary.id).versions.length, 1);
  });

  it("refuses a credential in any field the person types into, saying which, and saves nothing", async () => {
    const { host, keys } = makeHost({});
    keys.current = { NEBIUS_API_KEY: KEY };
    const token = `ghp_${"y".repeat(36)}`;
    const base = { ...empty, goal: "Goal", acceptanceCriteria: ["Done"] };
    const cases: Array<[string, typeof base, string]> = [
      ["The title", base, `Title ${token}`],
      ["The goal", { ...base, goal: `Goal ${KEY}` }, "T"],
      ["An acceptance criterion", { ...base, acceptanceCriteria: [`Done ${token}`] }, "T"],
      ["The context", { ...base, context: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }, "T"],
      ["A check", { ...base, checks: [`run it with ${KEY}`] }, "T"],
    ];
    for (const [field, fields, title] of cases) {
      await assert.rejects(host.createTask({ title, fields, projectId: null, planId: null }), new RegExp(`^Error: ${field} (holds your saved Token Factory key|looks like it holds)`));
    }
    assert.equal(host.tasks().tasks.length, 0);
  });

  it("keeps a brief's baseline checks and frozen files across versions, reads one saved before them as having neither, and refuses what a run couldn't take, in plain words (D41)", async () => {
    const { host, keys } = makeHost({});
    keys.current = { NEBIUS_API_KEY: KEY };
    const CASE = { name: "Exports the header", command: "sh export.sh", expectedOutput: "id,name\n1,Ada\n", expectedExitCode: 0 };
    const REPRODUCED = { name: "The header is missing", command: "sh export.sh", expectedExitCode: 0, expectedOutput: "1,Ada\n" };
    const FAILS = { name: "The export test fails for it", command: "sh test.sh", expectedExitCode: 1, outputPattern: "FAIL export" };
    const fields = { ...empty, goal: "Export the header", acceptanceCriteria: ["The header comes first"], acceptanceCases: [CASE], baseline: [REPRODUCED, FAILS], frozen: [" tests/export.test.sh ", "", "tests/support/stub.sh"] };
    const task = await host.createTask({ title: "Header", fields, projectId: null, planId: null });
    assert.deepEqual([task.brief.content.baseline, task.brief.content.frozen], [[REPRODUCED, FAILS], ["tests/export.test.sh", "tests/support/stub.sh"]]);
    // An edit keeps them as the window sends them; a brief saved without them has none.
    const edited = await host.reviseBrief(task.summary.id, task.revision, { ...fields, context: "Seen in production." });
    assert.deepEqual([edited.brief.version, edited.brief.content.baseline, edited.brief.content.frozen.length], [2, [REPRODUCED, FAILS], 2]);
    const cleared = await host.reviseBrief(task.summary.id, edited.revision, { ...empty, goal: "Export the header", acceptanceCases: [CASE] });
    assert.deepEqual([cleared.brief.version, cleared.brief.content.baseline, cleared.brief.content.frozen], [3, [], []]);
    // What a run couldn't take is refused in words that say what to change, and nothing is saved.
    const refusals: Array<[Partial<BriefFields>, string | RegExp]> = [
      [{ baseline: [{ ...FAILS, expectedOutput: "FAIL export\n" }] }, "Baseline check 1 gives both its exact output and a pattern. Keep one of them, then save it again."],
      [{ baseline: [{ name: "Runs", command: "sh test.sh", expectedExitCode: 0 }] }, "Baseline check 1 needs the exact output it must print, or a pattern for it. Add one, then save it again."],
      [{ baseline: [REPRODUCED, { ...FAILS, outputPattern: "(unclosed" }] }, /^Error: Baseline check 2's pattern isn't a regular expression Nivra can read \(.+\)\. Correct it, then save it again\.$/],
      [{ baseline: [REPRODUCED, { ...FAILS, outputPattern: "" }] }, "Baseline check 2 needs a pattern for what it prints. Write one, or give its exact output instead, then save it again."],
      [{ baseline: [{ ...REPRODUCED, expectedExitCode: 256 }] }, "Baseline check 1's exit code must be a whole number from 0 to 255. Change it, then save it again."],
      [{ baseline: [{ ...REPRODUCED, command: "  " }] }, "Baseline check 1 needs a command to run. Add one, then save it again."],
      [{ baseline: [REPRODUCED, FAILS, REPRODUCED, FAILS] }, "There are 4 baseline checks, and a brief can hold 3. Remove some, then save it again."],
      [{ frozen: ["../outside.sh"] }, "Frozen file 1, ../outside.sh, isn't a path inside the folder. Write it as Git names it from the folder, such as tests/regression.test.ts, then save it again."],
      [{ frozen: ["tests/a.sh", "/etc/hosts"] }, "Frozen file 2, /etc/hosts, isn't a path inside the folder. Write it as Git names it from the folder, such as tests/regression.test.ts, then save it again."],
      [{ frozen: ["a.sh", "", "a.sh"] }, "Frozen file 3, a.sh, is in the list already. Remove one of them, then save it again."],
      [{ frozen: Array.from({ length: 21 }, (_, index) => `tests/${index}.sh`) }, "There are 21 frozen files, and a brief can hold 20. Remove some, then save it again."],
    ];
    for (const [change, message] of refusals) {
      await assert.rejects(host.createTask({ title: "Refused", fields: { ...fields, ...change }, projectId: null, planId: null }), typeof message === "string" ? { message } : message);
    }
    // A credential in a baseline check or a frozen file's name is refused as in any field.
    await assert.rejects(host.createTask({ title: "Key", fields: { ...fields, baseline: [{ ...REPRODUCED, command: `NEBIUS=${KEY} sh export.sh` }] }, projectId: null, planId: null }), /^Error: A baseline check's command (holds your saved Token Factory key|looks like it holds)/);
    await assert.rejects(host.createTask({ title: "Key", fields: { ...fields, frozen: [`tests/${KEY}.sh`] }, projectId: null, planId: null }), /^Error: A frozen file (holds your saved Token Factory key|looks like it holds)/);
    assert.deepEqual(host.tasks().tasks.map((one) => one.title), ["Header"]);

    // A brief an older Nivra saved, before baseline checks and frozen files, reads as having neither.
    const root = mkdtempSync(join(tmpdir(), "nivra host ü%# "));
    dirs.push(root);
    const opening = openWorkspace(join(root, "workspace.db"));
    assert.equal(opening.state, "ready");
    const { baseline: _baseline, frozen: _frozen, ...older } = briefFrom({ ...empty, goal: "Older", acceptanceCriteria: ["Done"], acceptanceCases: [CASE] });
    const olderId = randomUUID();
    if (opening.state === "ready") {
      insertTask(opening.db, { id: olderId, title: "Older", projectId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { id: randomUUID(), content: older, derivedFrom: null });
      opening.db.close();
    }
    const reopened = hostAt(root).host.task(olderId);
    assert.deepEqual([reopened.brief.content.goal, reopened.brief.content.baseline, reopened.brief.content.frozen], ["Older", [], []]);
  });
});

describe("Host: reviews of saved plan versions, bound to what their preview showed (D31)", () => {
  const KEY = "test-key-0123456789";
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const PLAN = "Rename users.fullname to display_name in place during a rolling deploy, then roll back by redeploying release 40.";
  type Role = "architecture" | "risks" | "single" | "chair";
  const roleOf = (request: StubRequest): Role | null => (/Nivra review role: (architecture|risks|single|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1] as Role | undefined) ?? null;
  const userMessage = (request: StubRequest | undefined) => JSON.stringify(((request?.body?.messages ?? []) as Array<{ role: string; content: unknown }>).find((m) => m.role === "user")?.content ?? null);
  const reviewBy = (role: string, summary = `The ${role} reviewer's summary.`) =>
    toolCall("submit_review", {
      summary,
      findings: [{ title: `${role}: old servers break mid-rollout`, detail: "Servers on the old release still read the old column.", recommendation: "Expand, then contract.", severity: "high", refs: ["plan"] }],
      assumptions: [],
      gaps: [],
    });
  const SYNTHESIS = toolCall("submit_synthesis", { summary: "Both say the rename breaks a rolling deploy.", priorities: ["arch-1", "risk-1"], agreements: [{ statement: "Old servers break mid-rollout.", findingIds: ["arch-1", "risk-1"] }], dissent: [], gaps: [] });
  const SLOW = { ...reviewBy("slow"), delayMs: 15_000 };
  /** A stub that answers a conversation's turns with `answer`, and plays each reviewer and the chair as `script` says. */
  async function stubFor(script: Partial<Record<Role, Reply>> & { answer?: (request: StubRequest) => Reply } = {}) {
    const council: Partial<Record<Role, Reply>> = { architecture: reviewBy("architecture"), risks: reviewBy("risks"), single: reviewBy("single"), chair: SYNTHESIS, ...script };
    const stub = await startStub({
      models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }],
      chat: (request) => {
        const role = roleOf(request);
        if (!role) return script.answer ? script.answer(request) : text("Rename it in place, then redeploy.");
        return council[role] ?? httpError(500, `no script for ${role}`);
      },
    });
    stubs.push(stub);
    return stub;
  }
  const reviewRequests = (stub: Stub) => stub.chats().filter((chat) => roleOf(chat) !== null);
  const reposRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "nivra review repos "));
    dirs.push(root);
    return root;
  };
  const calls = (home: string) => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
  /** The latest answer in a conversation, once its last turn is answered. */
  const answered = (host: Host, conversationId: string) =>
    waitFor(() => {
      const view = host.conversation(conversationId);
      return view.turns.at(-1)?.status === "answered" ? view.messages.filter((m) => m.role === "assistant").at(-1)! : null;
    }, "the answer");
  /** A plan saved from the conversation's next answer, with `text` as its text (the answer's own when undefined). */
  async function planIn(host: Host, conversationId: string, text: string | undefined = PLAN) {
    await host.sendMessage(conversationId, "How do I rename the column?");
    const answer = await answered(host, conversationId);
    return host.savePlan(conversationId, answer.id, text);
  }
  /** The conversation's latest review, once it has ended. */
  const ended = (host: Host, conversationId: string) =>
    waitFor(() => {
      const last = host.reviews(conversationId).at(-1);
      return last && last.status !== "submitting" && last.status !== "running" ? last : null;
    }, "the review to end", 30_000);
  const start = async (host: Host, planId: string) => host.startReview(planId, "council", (await host.prepareReview(planId, "council")).expected);
  const CHANGED = /^Error: What this review would send has changed since you opened it\. Check the new preview, then start again\.$/;

  it("previews what a review sends, sends exactly that once, keeps the report bound to its version, and changes nothing else", async () => {
    const stub = await stubFor();
    const { host, root, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: "/nowhere/other" }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    const personal = host.addPreference({ statement: `Prefer reversible changes ${randomUUID()}`, scope: "personal", projectId: null, intent: "default" });
    const elsewhere = host.addPreference({ statement: `Another project's own ${randomUUID()}`, scope: "project", projectId: ids[0]!, intent: "default" });
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    const preview = await host.prepareReview(plan.id, "council");
    assert.deepEqual(
      [preview.planVersion, preview.latestVersion, preview.scope, preview.sends, preview.requests, preview.blocked],
      [1, 1, { kind: "general" }, { textChars: PLAN.length, assumptions: 0, references: 0, preferences: [{ statement: personal.statement, scope: "personal", intent: "default" }] }, 3, null],
    );
    assert.equal(stub.chats().length, 1, "a preview sends nothing");
    const store = readFileSync(join(root, "nivra.json"), "utf8");
    const started = await host.startReview(plan.id, "council", preview.expected);
    assert.deepEqual([started.status, started.planVersion, host.conversation(conversation.id).openReview, host.conversation(conversation.id).turns.length], ["submitting", 1, started.id, 1]);
    const review = await ended(host, conversation.id);
    assert.equal(review.status, "answered", review.note ?? "");
    const report = review.report!;
    assert.deepEqual(
      [report.outcome, report.planId, report.planVersion, report.panel, report.request.clientRequestId, report.reviewers.map((r) => r.role), report.synthesis?.agreements.length, review.note],
      ["complete", plan.id, 1, "council", review.id, ["architecture", "risks"], 1, null],
    );
    // What was kept, and what the engine checked it received, are what the preview was bound by.
    assert.equal(previewFingerprint({ planId: plan.id, planVersion: 1, packetDigest: review.packetDigest, preferencesDigest: review.preferencesDigest, sharing: null, panel: "council" }), preview.expected);
    assert.deepEqual([report.packetDigest, report.preferencesDigest, review.given.preferences], [review.packetDigest, review.preferencesDigest, 1]);
    const sent = reviewRequests(stub);
    assert.deepEqual(sent.map(roleOf).sort(), ["architecture", "chair", "risks"]);
    const all = JSON.stringify(sent.map((chat) => chat.body?.messages));
    assert.deepEqual([userMessage(sent[0]).includes(PLAN), all.includes(personal.statement), all.includes(elsewhere.statement), all.includes("How do I rename the column?")], [true, true, false, false]);
    // A review writes nothing else: not the store, not the plan; a task made from the plan is ready without one.
    assert.equal(readFileSync(join(root, "nivra.json"), "utf8"), store);
    assert.deepEqual(host.plans(conversation.id).map((p) => [p.version, p.text]), [[1, PLAN]]);
    const fields = { goal: "Rename the column", acceptanceCriteria: ["Old servers keep working"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
    const task = await host.createTask({ title: "Rename", fields, projectId: null, planId: plan.id });
    assert.equal(host.setTaskState(task.summary.id, task.revision, "ready").summary.state, "ready");
    // The plan moves on: v1's review stays as it was, and says so; reviewing v2 makes a new review.
    const kept = JSON.stringify(report);
    const v2 = await host.revisePlan(plan.id, `${PLAN} Add the new column first.`);
    const [first] = host.reviews(conversation.id);
    assert.deepEqual([first?.planVersion, first?.latestVersion, JSON.stringify(first?.report)], [1, 2, kept]);
    await start(host, v2.id);
    const second = await ended(host, conversation.id);
    assert.deepEqual([second.status, second.planVersion, host.reviews(conversation.id).length, reviewRequests(stub).length], ["answered", 2, 2, 6]);
    assert.equal(JSON.stringify(host.reviews(conversation.id)[0]?.report), kept);
  });

  it("refuses to start when what it would send changed since the preview, sends nothing, and the next preview shows the change", async () => {
    const readThenReply = (request: StubRequest): Reply =>
      request.raw.includes('"role":"tool"')
        ? toolCall("submit_reply", { answer: "Rename it in place.", evidence: [{ statement: "It has a README.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }] }, { id: "r1" })
        : toolCall("read_file", { path: "README.md" }, { id: "r0" });
    const stub = await stubFor({ answer: readThenReply });
    const repo = makeRepo(join(reposRoot(), "shop"), { "README.md": "# Shop\n" });
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: repo }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    await host.setSharing(ids[0]!, true);
    const own = host.addPreference({ statement: "Ship behind a flag", scope: "project", projectId: ids[0]!, intent: "default" });
    const decision = host.addPreference({ statement: "Replace Jest with Vitest", scope: "project", projectId: ids[0]!, intent: "override" });
    const conversation = host.createConversation({ kind: "project", projectId: ids[0]! });
    const plan = await planIn(host, conversation.id);
    const first = await host.prepareReview(plan.id, "council");
    assert.deepEqual(
      [first.scope, first.sends.references, first.sends.preferences.map((p) => [p.statement, p.scope, p.intent])],
      [{ kind: "project", projectLabel: "shop", targetLabel: first.scope.kind === "project" ? first.scope.targetLabel : "", headAtStart: head, sharing: true }, 1, [["Ship behind a flag", "project", "default"], ["Replace Jest with Vitest", "project", "override"]]],
    );
    host.editPreference(own.id, { statement: "Ship behind a feature flag", intent: "default" });
    await assert.rejects(host.startReview(plan.id, "council", first.expected), CHANGED, "a preference edited");
    const edited = await host.prepareReview(plan.id, "council");
    assert.deepEqual(edited.sends.preferences.map((p) => p.statement), ["Ship behind a feature flag", "Replace Jest with Vitest"]);
    host.deletePreference(decision.id);
    await assert.rejects(host.startReview(plan.id, "council", edited.expected), CHANGED, "a preference deleted");
    const deleted = await host.prepareReview(plan.id, "council");
    assert.deepEqual(deleted.sends.preferences.map((p) => p.statement), ["Ship behind a feature flag"]);
    await host.setSharing(ids[0]!, false);
    await assert.rejects(host.startReview(plan.id, "council", deleted.expected), /^Error: This project doesn't allow sending its content to Token Factory\. Allow sharing for it, then start the review\.$/);
    const off = await host.prepareReview(plan.id, "council");
    assert.deepEqual([off.scope.kind === "project" && off.scope.sharing, off.blocked !== null, off.expected === deleted.expected], [false, true, false]);
    await host.setSharing(ids[0]!, true);
    await assert.rejects(host.startReview(plan.id, "council", "0".repeat(64)), CHANGED, "a fingerprint no preview gave");
    assert.deepEqual([reviewRequests(stub).length, host.reviews(conversation.id).length], [0, 0], "nothing was sent or stored");
    // Nothing changed since this preview: it starts, and sends what it showed, bound to the project's commit.
    const fresh = await host.prepareReview(plan.id, "council");
    await host.startReview(plan.id, "council", fresh.expected);
    const review = await ended(host, conversation.id);
    assert.equal(review.status, "answered", review.note ?? "");
    assert.deepEqual([review.scope, review.references], [{ kind: "project", projectLabel: "shop", headAtStart: head }, [{ path: "README.md", startLine: 1, endLine: 1 }]]);
    const sent = JSON.stringify(reviewRequests(stub).map((chat) => chat.body?.messages));
    assert.deepEqual([sent.includes("Ship behind a feature flag"), sent.includes("Replace Jest with Vitest"), sent.includes("README.md"), sent.includes(repo)], [true, false, true, false]);
    // Its project removed: refused before anything is worked out.
    await host.removeProject(ids[0]!);
    await assert.rejects(host.prepareReview(plan.id, "council"), /^Error: This plan's project was removed, so it can't be reviewed\. Its history stays here until you delete it\.$/);
    await assert.rejects(host.startReview(plan.id, "council", fresh.expected), /^Error: This plan's project was removed/);
    assert.equal(reviewRequests(stub).length, 3);
  });

  it("keeps the report of the reviewer that answered when the other fails, skips the chair, and sends nothing again", async () => {
    const stub = await stubFor({ architecture: httpError(500, "the architecture reviewer is down") });
    const { host, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    await start(host, plan.id);
    const review = await ended(host, conversation.id);
    assert.deepEqual(
      [review.status, review.report?.outcome, review.report?.stages.map((s) => [s.role, s.status]), review.report?.reviewers.map((r) => r.role)],
      ["failed", "incomplete", [["architecture", "failed"], ["risks", "answered"], ["chair", "skipped"]], ["risks"]],
    );
    assert.match(review.note ?? "", /^This review is incomplete\. The architecture review failed: Token Factory had a problem answering \(HTTP 500\)\..* Nothing was resent\.$/);
    await pause(300);
    assert.equal(reviewRequests(stub).length, 2);
  });

  it("holds the conversation while a review runs, cancels it on request with what it saved, and then takes a message again", async () => {
    const stub = await stubFor({ architecture: SLOW, risks: SLOW });
    const { host, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    const started = await start(host, plan.id);
    await waitFor(() => reviewRequests(stub).length === 2, "both reviewers to be asked");
    assert.equal(host.conversation(conversation.id).openReview, started.id);
    await assert.rejects(host.sendMessage(conversation.id, "Meanwhile?"), /^Error: A review of a plan is running in this conversation\. Wait for it, or cancel it, then send again\.$/);
    assert.equal((await host.prepareReview(plan.id, "council")).blocked, "A review of a plan is running in this conversation. Wait for it, or cancel it, then start the review.");
    await assert.rejects(host.cancelTurn(conversation.id, started.id), /^Error: That message is no longer in this conversation\.$/, "a review isn't a message");
    await host.cancelReview(conversation.id, started.id);
    const review = await ended(host, conversation.id);
    assert.deepEqual([review.status, review.note, review.report?.outcome, host.conversation(conversation.id).openReview], ["cancelled", "Cancelled. Nothing was resent.", "cancelled", null]);
    await host.sendMessage(conversation.id, "And now?");
    await answered(host, conversation.id);
    assert.deepEqual([reviewRequests(stub).length, host.conversation(conversation.id).turns.length], [2, 2], "nothing was sent again");
  });

  it("stops a review asked to stop while it was being sent, by the person or by consent withdrawn, as soon as its engine answers", async () => {
    for (const how of ["person", "sharing"] as const) {
      const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
      keys.current = { NEBIUS_API_KEY: KEY };
      const home = join(root, "local home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "release"), "");
      await host.setSharing(ids[0]!, true);
      const conversation = host.createConversation({ kind: "project", projectId: ids[0]! });
      const plan = await planIn(host, conversation.id, undefined);
      rmSync(join(home, "release"));
      const started = await start(host, plan.id);
      await waitFor(() => calls(home).filter((call) => call === "runs.start").length === 2, "the review's request to reach the engine");
      if (how === "person") await host.cancelReview(conversation.id, started.id);
      else await host.setSharing(ids[0]!, false);
      assert.deepEqual([how, host.reviews(conversation.id)[0]?.status, host.reviews(conversation.id)[0]?.cancelRequested], [how, "submitting", true]);
      writeFileSync(join(home, "release"), "");
      const review = await ended(host, conversation.id);
      // Its run is cancelled once (turning sharing off also cancels the conversation's earlier run, long finished).
      const cancelled = readFileSync(join(home, "cancelled.log"), "utf8").split("\n").filter((runId) => runId === review.runId);
      assert.deepEqual(
        [how, review.status, review.note, cancelled.length],
        [how, "cancelled", how === "person" ? "Cancelled. Nothing was resent." : "Stopped: sharing for this project was turned off. Nothing was resent.", 1],
      );
    }
  });

  it("reports a review cut off by a quit or a killed engine as interrupted after a restart, keeps what it saved, and sends nothing again", async () => {
    for (const how of ["quit", "kill"] as const) {
      const stub = await stubFor({ architecture: SLOW, risks: SLOW });
      const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
      keys.current = { NEBIUS_API_KEY: KEY };
      const conversation = host.createConversation({ kind: "general" });
      const plan = await planIn(host, conversation.id);
      await start(host, plan.id);
      await waitFor(() => reviewRequests(stub).length === 2, "both reviewers to be asked");
      if (how === "kill") {
        const { pid } = await online(host, "local");
        process.kill(pid, "SIGKILL");
        await waitFor(() => !isAlive(pid), "the engine to die");
      }
      await host.shutdown();
      const again = hostAt(root, { tokenFactoryUrl: stub.url }).host;
      await again.openConversation(conversation.id);
      const review = await ended(again, conversation.id);
      assert.deepEqual([how, review.status, review.note], [how, "interrupted", "Interrupted: Nivra or its engine stopped before the review finished. Nothing was resent."]);
      // A killed engine saved nothing after the reviewers were asked, so its report reads as interrupted. A quit lets the
      // engine cancel the review and save that, unless the host stops it first.
      const outcome = review.report?.outcome;
      assert.ok(how === "kill" ? outcome === "interrupted" : outcome === "cancelled" || outcome === "interrupted", `${how}: ${outcome}`);
      assert.deepEqual([how, review.report?.reviewers.length, review.report?.stages.map((s) => s.status)], [how, 0, ["failed", "failed", "skipped"]]);
      await pause(300);
      assert.equal(reviewRequests(stub).length, 2, `${how}: nothing was sent again`);
    }
  });

  it("finds a review whose answer was lost by its request id and keeps its report, sent once; keeps nothing of a report bound to something else", async () => {
    for (const how of ["lost", "wrong"] as const) {
      const { host, root, keys } = makeHost({ localEntry: GATED });
      keys.current = { NEBIUS_API_KEY: KEY };
      const home = join(root, "local home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "release"), "");
      const conversation = host.createConversation({ kind: "general" });
      const plan = await planIn(host, conversation.id, undefined);
      let review;
      if (how === "lost") {
        rmSync(join(home, "release"));
        writeFileSync(join(home, "accept"), "");
        await start(host, plan.id);
        await waitFor(() => calls(home).filter((call) => call === "runs.start").length === 2, "the review's request to reach the engine");
        await host.shutdown();
        const again = hostAt(root, { localEntry: GATED }).host;
        await again.openConversation(conversation.id);
        review = await ended(again, conversation.id);
        assert.deepEqual([review.status, review.report?.reviewers[0]?.summary, calls(home).includes("runs.find")], ["answered", "A gated review.", true]);
      } else {
        writeFileSync(join(home, "wrong-report"), "");
        await start(host, plan.id);
        review = await ended(host, conversation.id);
        assert.deepEqual(
          [review.status, review.report, review.note],
          ["unknown", null, "Nivra can't tell whether this review reached the model: its engine's report is about something other than what this review sent, so none of it was kept. Nothing was resent."],
        );
      }
      assert.equal(calls(home).filter((call) => call === "runs.start").length, 2, `${how}: the review was sent once`);
    }
  });

  it("deletes a conversation while its review runs: the run stops, and the workspace keeps nothing of the review", async () => {
    const stub = await stubFor({ architecture: SLOW, risks: SLOW });
    const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const canary = `nivra-review-plan-canary-${randomUUID()}`;
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id, `${PLAN} ${canary}`);
    await start(host, plan.id);
    await waitFor(() => reviewRequests(stub).length === 2, "both reviewers to be asked");
    const runId = await waitFor(() => host.reviews(conversation.id)[0]?.runId ?? null, "the review's run");
    await host.deleteConversation(conversation.id);
    assert.throws(() => host.reviews(conversation.id), /no longer in the list/);
    await waitFor(async () => (await host.runEvents(runId, 0)).status === "cancelled", "the review's run to stop");
    await host.shutdown();
    const workspace = new DatabaseSync(join(root, "workspace.db"), { readOnly: true });
    try {
      const count = (table: string) => Number(workspace.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
      assert.deepEqual([count("reviews"), count("run_links"), count("artifacts")], [0, 0, 0]);
    } finally {
      workspace.close();
    }
    assert.deepEqual(filesHolding(root, canary).filter((file) => file.startsWith("workspace.db")), []);
  });

  it("refuses a plan version holding the saved key before anything is stored, and keeps no key anywhere a review writes", async () => {
    const stub = await stubFor({ architecture: reviewBy("architecture", `The key ${KEY} works.`) });
    const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
    const later = `later-key-${randomUUID()}`;
    keys.current = { NEBIUS_API_KEY: KEY };
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id, `${PLAN} Use ${later} until the switch.`);
    keys.current = { NEBIUS_API_KEY: later };
    await assert.rejects(host.prepareReview(plan.id, "council"), /^Error: This plan version holds your saved Token Factory key, so nothing was sent\. Edit the plan to remove it, then review the new version\.$/);
    keys.current = { NEBIUS_API_KEY: KEY };
    const clean = await host.revisePlan(plan.id, PLAN);
    await start(host, clean.id);
    const review = await ended(host, conversation.id);
    assert.equal(review.status, "answered", review.note ?? "");
    assert.equal(review.report?.reviewers.find((r) => r.role === "architecture")?.summary, "The key [secret:NEBIUS_API_KEY] works.");
    await host.shutdown();
    assert.deepEqual(filesHolding(root, KEY), []);
  });
});

describe("Host: sandbox checks, with upload consent of their own (D36)", () => {
  const KEY = "test-key-0123456789";
  const PROJECT_ID = "project-e00hostcheck01";
  const SECRETS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };
  const UPLOADS_OFF = /doesn't allow uploading its commit to Nebius Sandboxes/;
  const STOPPED = /^Uploads for this project were turned off, so its sandbox check is being stopped\. Anything it uploaded stays with Nebius/;
  const FINISHED = ["succeeded", "failed", "cancelled"];
  const reposRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "nivra repos "));
    dirs.push(root);
    return root;
  };
  const sandboxStub = async () => {
    const stub = await startSandboxStub();
    sandboxStubs.push(stub);
    return stub;
  };
  const checkEnded = (host: Host, projectId: string) =>
    waitFor(async () => {
      const view = await host.sandboxCheck(projectId);
      return view && FINISHED.includes(view.status) ? view : null;
    }, "the check to end", 30_000);
  const fingerprintOf = async (host: Host, projectId: string) => {
    const preview = await host.previewSandboxCheck(projectId);
    assert.equal(preview.status, "ready", JSON.stringify(preview).slice(0, 300));
    return preview.status === "ready" ? preview.fingerprint : "";
  };
  const calls = (home: string) => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
  const logged = (home: string, file: string) => (existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").split("\n").filter(Boolean) : []);
  const uploads = (stub: SandboxStub) => stub.requests.filter((request) => request.path === "/v1/files").length;

  it("keeps the two opt-ins apart in all four combinations: a check needs upload consent, an explanation model-context consent", async () => {
    const sandboxes = await sandboxStub();
    const models = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: () => httpError(503, "unused") });
    stubs.push(models);
    const { host, ids, keys, root } = makeHost({ tokenFactoryUrl: models.url, sandboxesUrl: sandboxes.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    keys.current = SECRETS;
    const id = ids[0]!;
    assert.deepEqual(host.projects()[0]?.sharing, { modelContext: false, cloudExecution: false }, "both start off");
    const seen: unknown[] = [];
    for (const [modelContext, cloudExecution] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      await host.setSharing(id, modelContext);
      await host.setCloudExecution(id, cloudExecution);
      const before = uploads(sandboxes);
      const fingerprint = await fingerprintOf(host, id);
      const check = await host.startSandboxCheck(id, fingerprint).then(() => "started", (error: Error) => (UPLOADS_OFF.test(error.message) ? "refused" : error.message));
      const explain = await host.startExplain(id, "", []).then(() => "started", (error: Error) => (/doesn't allow sending its content to Token Factory/.test(error.message) ? "refused" : error.message));
      const outcome = check === "started" ? (await checkEnded(host, id)).report?.outcome : null;
      seen.push([modelContext, cloudExecution, check, outcome, explain, uploads(sandboxes) - before]);
    }
    assert.deepEqual(seen, [
      [false, false, "refused", null, "refused", 0],
      [true, false, "refused", null, "started", 0],
      [false, true, "started", "unchanged", "refused", 1],
      [true, true, "started", "unchanged", "started", 1],
    ]);
    // The key and project id went to the engine in memory and to Nebius in headers: nothing on disk holds either.
    assert.ok(sandboxes.requests.every((request) => request.authorization === `Bearer ${KEY}` && request.project === PROJECT_ID));
    await host.shutdown();
    assert.deepEqual([filesHolding(root, KEY), filesHolding(root, PROJECT_ID)], [[], []]);
  });

  it("refuses a check while uploads are off before starting any engine, and never sends one withdrawn while its engine starts", async () => {
    const sandboxes = await sandboxStub();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const preparing = new Promise<void>((resolve) => (entered = resolve));
    const { host, ids, keys, root } = makeHost({
      sandboxesUrl: sandboxes.url,
      beforeWslPrepare: async () => {
        entered();
        await gate;
      },
      projects: [{ targetId: "wsl:Test", path: makeRepo(join(reposRoot(), "linux"), { "README.md": "# Linux\n" }) }],
    });
    keys.current = SECRETS;
    await assert.rejects(host.startSandboxCheck(ids[0]!, "a".repeat(64)), UPLOADS_OFF);
    assert.equal(stateOf(host, "wsl:Test")?.status, "stopped");
    await host.setCloudExecution(ids[0]!, true);
    const starting = host.startSandboxCheck(ids[0]!, "a".repeat(64));
    await preparing;
    await host.setCloudExecution(ids[0]!, false);
    release();
    await assert.rejects(starting, /turned off, so the check wasn't started/);
    await online(host, "wsl:Test");
    assert.equal(sandboxes.requests.length, 0, "nothing reached Nebius");
    await host.shutdown();
    // The engine's own store, read once it has stopped: the check never reached it, so it never ran at all.
    assert.deepEqual(storedRuns(join(root, "wsl home")), []);
    assert.equal(existsSync(join(root, "wsl home", "sandbox")), false, "no session was ever opened");
  });

  it("starts one check of a project at a time: a second start is refused, and turning uploads off stops the one that went", async () => {
    const sandboxes = await sandboxStub();
    sandboxes.guest.override = ({ args }) => (args[1] === PROBE_SCRIPT ? { waits: true } : undefined);
    const { host, ids, keys } = makeHost({ sandboxesUrl: sandboxes.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    keys.current = SECRETS;
    await host.setCloudExecution(ids[0]!, true);
    const fingerprint = await fingerprintOf(host, ids[0]!);
    // Two presses at once, as a double click gives: the second is refused before the first has waited for anything.
    const [first, second] = await Promise.allSettled([host.startSandboxCheck(ids[0]!, fingerprint), host.startSandboxCheck(ids[0]!, fingerprint)]);
    assert.deepEqual([first.status, second.status === "rejected" ? String(second.reason) : second.status], ["fulfilled", "Error: A sandbox check of this project is already being started."]);
    const probes = () => sandboxes.guest.service.operations.filter((operation) => (operation.body["args"] as string[] | undefined)?.[1] === PROBE_SCRIPT);
    await waitFor(() => operationRead(sandboxes, "nivra-probe"), "the engine's first read of the probe's operation");
    await assert.rejects(host.startSandboxCheck(ids[0]!, fingerprint), /is still going/);
    assert.match((await host.setCloudExecution(ids[0]!, false)).notice ?? "", STOPPED);
    const view = await checkEnded(host, ids[0]!);
    assert.deepEqual(
      [view.status, uploads(sandboxes), probes().map((operation) => operation.cancelled), sandboxes.requests.filter((request) => request.method === "DELETE").length],
      ["cancelled", 1, [true], 1],
    );
  });

  it("stops a check whose consent is withdrawn while its start is out, as soon as its engine answers", async () => {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = SECRETS;
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "accept"), "");
    await host.setCloudExecution(ids[0]!, true);
    const starting = host.startSandboxCheck(ids[0]!, "a".repeat(64));
    await waitFor(() => calls(home).includes("runs.start"), "the check's request to reach the engine");
    await host.setCloudExecution(ids[0]!, false);
    writeFileSync(join(home, "release"), "");
    const view = await starting;
    const runId = logged(home, "accepted.log")[0]?.split(" ")[1];
    assert.deepEqual([view.runId === runId, view.status, STOPPED.test(view.note ?? ""), logged(home, "cancelled.log")], [true, "cancelled", true, [runId]]);
    assert.match(host.projects()[0]?.notice ?? "", STOPPED);
  });

  it("says a check whose late answer can't be stopped couldn't be, in its note and the project's notice", async () => {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = SECRETS;
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["accept", "running", "fail-cancel"]) writeFileSync(join(home, flag), "");
    await host.setCloudExecution(ids[0]!, true);
    const starting = host.startSandboxCheck(ids[0]!, "a".repeat(64));
    await waitFor(() => calls(home).includes("runs.start"), "the check's request to reach the engine");
    // Withdrawn while the start is out: nothing is stopped yet, so the notice says it is being stopped.
    assert.match((await host.setCloudExecution(ids[0]!, false)).notice ?? "", STOPPED);
    writeFileSync(join(home, "release"), "");
    const failed = "Nivra couldn't stop the sandbox check (the run couldn't be stopped). Restart the project's engine to stop it.";
    await assert.rejects(starting, { message: failed });
    const view = await host.sandboxCheck(ids[0]!);
    assert.deepEqual([host.projects()[0]?.notice, view?.status, view?.note], [`Uploads for this project were turned off. ${failed}`, "running", failed]);
  });

  it("finds a check whose start's answer was lost by its request id, never sends it again, and stops it once found when consent was withdrawn", async () => {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = SECRETS;
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["accept", "error-start", "hold-find", "release"]) writeFileSync(join(home, flag), "");
    await host.setCloudExecution(ids[0]!, true);
    const lost = await host.startSandboxCheck(ids[0]!, "a".repeat(64));
    assert.deepEqual([lost.status, lost.runId], ["looking", null]);
    await waitFor(() => calls(home).includes("runs.find"), "the search by request id");
    await host.setCloudExecution(ids[0]!, false);
    writeFileSync(join(home, "release-find"), "");
    const runId = logged(home, "accepted.log")[0]?.split(" ")[1];
    await waitFor(() => logged(home, "cancelled.log").includes(runId!), "the found check to be stopped");
    const found = await host.sandboxCheck(ids[0]!);
    assert.deepEqual([found?.runId === runId, found?.status, calls(home).filter((call) => call === "runs.start").length], [true, "cancelled", 1]);
  });

  it("says a check its engine answered with an error and has no record of was never sent, in the engine's own words", async () => {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = SECRETS;
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["error-start", "release"]) writeFileSync(join(home, flag), "");
    await host.setCloudExecution(ids[0]!, true);
    await host.startSandboxCheck(ids[0]!, "a".repeat(64));
    const view = await waitFor(async () => {
      const check = await host.sandboxCheck(ids[0]!);
      return check?.status === "not-sent" ? check : null;
    }, "the search to find no record");
    assert.deepEqual([view.runId, view.note, calls(home).filter((call) => call === "runs.start").length], [null, "The engine didn't start the check, so nothing was sent. The engine refused the run.", 1]);
  });

  it("keeps a found check known when stopping it fails: it says so, never takes the check for lost, and a later cancel reaches it", async () => {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = SECRETS;
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["accept", "error-start", "hold-find", "release", "fail-cancel"]) writeFileSync(join(home, flag), "");
    await host.setCloudExecution(ids[0]!, true);
    const lost = await host.startSandboxCheck(ids[0]!, "a".repeat(64));
    assert.deepEqual([lost.status, lost.runId], ["looking", null]);
    await waitFor(() => calls(home).includes("runs.find"), "the search by request id");
    await host.setCloudExecution(ids[0]!, false);
    writeFileSync(join(home, "release-find"), "");
    const runId = logged(home, "accepted.log")[0]?.split(" ")[1];
    const view = await waitFor(async () => {
      const check = await host.sandboxCheck(ids[0]!);
      return /^Nivra couldn't stop the sandbox check/.test(check?.note ?? "") ? check : null;
    }, "the failed stop to be reported");
    assert.deepEqual([view.runId === runId, ["runs.find", "runs.cancel"].map((method) => calls(home).filter((call) => call === method).length)], [true, [1, 1]]);
    assert.equal(host.projects()[0]?.notice, `Uploads for this project were turned off. ${view.note}`);
    rmSync(join(home, "fail-cancel"));
    const stopped = await host.cancelSandboxCheck(ids[0]!);
    assert.deepEqual([logged(home, "cancelled.log"), stopped.note, STOPPED.test(host.projects()[0]?.notice ?? "")], [[runId], null, true]);
  });

  it("treats a check it can't read as going: the window reads it as unknown, and turning uploads off still stops it", async () => {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = SECRETS;
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["accept", "release"]) writeFileSync(join(home, flag), "");
    await host.setCloudExecution(ids[0]!, true);
    const started = await host.startSandboxCheck(ids[0]!, "a".repeat(64));
    writeFileSync(join(home, "fail-get"), "");
    const unread = await host.sandboxCheck(ids[0]!);
    assert.deepEqual([unread?.runId === started.runId, unread?.status, unread?.note], [true, "unknown", "Nivra can't read the check from its engine now (the run couldn't be read)."]);
    // Another start is refused, saying the check can't be read, never that it is still going.
    await assert.rejects(host.startSandboxCheck(ids[0]!, "a".repeat(64)), /^Error: Nivra can't read this project's last sandbox check from its engine now \(the run couldn't be read\), so it didn't start another\./);
    assert.match((await host.setCloudExecution(ids[0]!, false)).notice ?? "", STOPPED);
    assert.deepEqual([logged(home, "cancelled.log"), calls(home).filter((call) => call === "runs.start").length], [[started.runId], 1]);
  });

  it("says a check couldn't be stopped when its stop fails, never that it is being stopped: turning uploads off, and removing the project", async () => {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = SECRETS;
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["accept", "release", "running"]) writeFileSync(join(home, flag), "");
    await host.setCloudExecution(ids[0]!, true);
    const started = await host.startSandboxCheck(ids[0]!, "a".repeat(64));
    writeFileSync(join(home, "fail-cancel"), "");
    const failed = "Nivra couldn't stop the sandbox check (the run couldn't be stopped). Restart the project's engine to stop it.";
    await assert.rejects(host.setCloudExecution(ids[0]!, false), { message: failed });
    const view = await host.sandboxCheck(ids[0]!);
    assert.deepEqual([host.projects()[0]?.notice, view?.status, view?.note], [`Uploads for this project were turned off. ${failed}`, "running", failed]);
    await assert.rejects(host.removeProject(ids[0]!), /^Error: Nivra couldn't stop the project's sandbox check \(the run couldn't be stopped\), so the project is still in the list\. Restart its engine, then remove it again\./);
    assert.deepEqual([host.projects().length, (await host.sandboxCheck(ids[0]!))?.note], [1, failed]);
    // A stop accepted on the next try takes back what said it couldn't be stopped; then the project goes.
    rmSync(join(home, "fail-cancel"));
    const stopped = await host.cancelSandboxCheck(ids[0]!);
    assert.deepEqual([stopped.status, stopped.note, STOPPED.test(host.projects()[0]?.notice ?? "")], ["cancelled", null, true]);
    await host.removeProject(ids[0]!);
    assert.deepEqual([host.projects().length, logged(home, "cancelled.log")], [0, [started.runId]]);
  });

  it("stops a running check when uploads are turned off, says what stays with Nebius, and the engine stops its operation", async () => {
    const sandboxes = await sandboxStub();
    sandboxes.guest.override = ({ args }) => (args[1] === PROBE_SCRIPT ? { waits: true } : undefined);
    const { host, ids, keys } = makeHost({ sandboxesUrl: sandboxes.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    keys.current = SECRETS;
    await host.setCloudExecution(ids[0]!, true);
    await host.startSandboxCheck(ids[0]!, await fingerprintOf(host, ids[0]!));
    await waitFor(() => operationRead(sandboxes, "nivra-probe"), "the engine's first read of the probe's operation");
    const project = await host.setCloudExecution(ids[0]!, false);
    assert.match(project.notice ?? "", STOPPED);
    const view = await checkEnded(host, ids[0]!);
    assert.deepEqual([view.status, view.report?.outcome, view.report?.cleanup?.stopped, STOPPED.test(view.note ?? "")], ["cancelled", "cancelled", 1, true]);
    assert.match(view.report?.cleanup?.retained?.note ?? "", /^Images are retained for 180 days/);
    assert.ok(sandboxes.requests.some((request) => request.method === "DELETE"), "the probe's operation was asked to stop");
  });

  it("stops a project's check when the project is removed", async () => {
    const sandboxes = await sandboxStub();
    sandboxes.guest.override = ({ args }) => (args[1] === PROBE_SCRIPT ? { waits: true } : undefined);
    const { host, ids, keys } = makeHost({ sandboxesUrl: sandboxes.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    keys.current = SECRETS;
    await host.setCloudExecution(ids[0]!, true);
    const view = await host.startSandboxCheck(ids[0]!, await fingerprintOf(host, ids[0]!));
    await waitFor(() => operationRead(sandboxes, "nivra-probe"), "the engine's first read of the probe's operation");
    await host.removeProject(ids[0]!);
    assert.equal(host.projects().length, 0);
    // The run is still reachable by its id on the engine that ran it: it ends cancelled, its operation asked to stop.
    const page = await waitFor(async () => {
      const events = await host.runEvents(view.runId!, 0);
      return isTerminal(events.status) ? events : null;
    }, "the check to end", 30_000);
    assert.deepEqual([page.status, sandboxes.requests.some((request) => request.method === "DELETE")], ["cancelled", true]);
  });
});

describe("Host: research of saved plan versions' assumptions, bound to what its preview showed (D37)", () => {
  const KEY = "test-key-0123456789";
  const TAVILY = `tvly-dev-host-research-${"t".repeat(16)}`;
  const PLAN = "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils.";
  const ASSUMPTION = "distutils is still in Python 3.12's standard library.";
  const QUERY = "Python 3.12 distutils standard library";
  const WHATSNEW = "https://docs.python.org/3/whatsnew/3.12.html";
  const SENT = "What was already sent can't be withdrawn, and nothing was resent.";
  const ANSWER = {
    assessments: [
      {
        assumption: "A1",
        outcome: "contradicted",
        reasoning: "The 3.12 release notes say distutils was removed.",
        citations: [{ passage: "S1.1", stance: "contradicts", quote: "has been removed from the standard library" }],
        applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
        uncertainty: "",
        amendment: "Install setuptools in the 3.12 image before switching.",
      },
    ],
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const selection = (query = QUERY): ResearchSelection => ({ assumptions: [{ from: { kind: "typed", text: ASSUMPTION }, query }], sites: null });
  const isResearch = (request: StubRequest) => JSON.stringify(request.body?.tools ?? []).includes("submit_research");
  /** A promise the test resolves: Tavily's searches wait on it, so a run that went on after a stop would be seen. */
  const gate = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    return { held, release };
  };
  /**
   * Token Factory, answering research with its assessment and the conversation's turns with the plan: a repository's
   * turn reads its README first. Tavily, holding its searches until `search` settles, or its extracts for a while.
   */
  async function stubsFor(hold: { search?: Promise<void>; extractMs?: number } = {}) {
    const turn = (request: StubRequest): Reply => {
      if (!JSON.stringify(request.body?.tools ?? []).includes("read_file")) return text(PLAN);
      return request.raw.includes('"role":"tool"')
        ? toolCall("submit_reply", { answer: PLAN, evidence: [{ statement: "It has a README.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }] }, { id: "r1" })
        : toolCall("read_file", { path: "README.md" }, { id: "r0" });
    };
    const model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: (request) => (isResearch(request) ? toolCall("submit_research", ANSWER) : turn(request)) });
    stubs.push(model);
    const tavily = await startTavilyStub(async (call) => {
      if (call.path === "/search") {
        await hold.search;
        return { body: searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12" }]) };
      }
      if (call.path === "/extract") return { body: extractAnswer([{ url: WHATSNEW, chunks: ["## Removed\nThe distutils package has been removed from the standard library."] }]), ...(hold.extractMs ? { delayMs: hold.extractMs } : {}) };
      return { status: 404, body: {} };
    });
    tavilyStubs.push(tavily);
    return { model, tavily };
  }
  const researchRequests = (stub: Stub) => stub.chats().filter(isResearch);
  const searches = (tavily: TavilyStub) => tavily.calls.filter((call) => call.path === "/search");
  const reposRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "nivra research repos "));
    dirs.push(root);
    return root;
  };
  const calls = (home: string) => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
  const starts = (home: string) => calls(home).filter((call) => call === "runs.start").length;
  /** The latest answer in a conversation, once its last turn is answered. */
  const answered = (host: Host, conversationId: string) =>
    waitFor(() => {
      const view = host.conversation(conversationId);
      return view.turns.at(-1)?.status === "answered" ? view.messages.filter((m) => m.role === "assistant").at(-1)! : null;
    }, "the answer");
  /** A plan saved from the conversation's next answer, with `text` as its text (the answer's own when undefined). */
  async function planIn(host: Host, conversationId: string, text: string | undefined = PLAN) {
    await host.sendMessage(conversationId, "How do I move the image to 3.12?");
    const answer = await answered(host, conversationId);
    return host.savePlan(conversationId, answer.id, text);
  }
  /** The conversation's latest research, once it has ended. */
  const ended = (host: Host, conversationId: string): Promise<ResearchView> =>
    waitFor(() => {
      const last = host.research(conversationId).at(-1);
      return last && last.status !== "submitting" && last.status !== "running" ? last : null;
    }, "the research to end", 30_000);
  const start = async (host: Host, planId: string, picks = selection()) => host.startResearch(planId, picks, (await host.prepareResearch(planId, picks)).expected);
  /** A host whose local engine is the gated stand-in, research on, both keys saved and a plan already made. */
  async function gated(scope: "general" | "project") {
    const { host, root, ids, keys } = makeHost({ localEntry: GATED, projects: [{ targetId: "local", path: "/nowhere/gated" }] });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const home = join(root, "local home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "release"), "");
    if (scope === "project") await host.setSharing(ids[0]!, true);
    const conversation = host.createConversation(scope === "project" ? { kind: "project", projectId: ids[0]! } : { kind: "general" });
    const plan = await planIn(host, conversation.id, undefined);
    return { host, root, ids, home, conversation, plan };
  }

  it("previews what research sends, sends exactly the approved query once, keeps the report bound to its version, and changes nothing else", async () => {
    const { model, tavily } = await stubsFor();
    const { host, root, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    const preview = await host.prepareResearch(plan.id, selection());
    assert.deepEqual(
      [preview.planVersion, preview.latestVersion, preview.scope, preview.tavily, preview.model.assumptions, preview.webResearch, preview.blocked],
      [1, 1, { kind: "general" }, { queries: [{ assumption: "A1", query: QUERY, problems: [] }], sites: null }, [{ id: "A1", text: ASSUMPTION, fromPlan: null }], true, null],
    );
    assert.deepEqual([tavily.calls.length, researchRequests(model).length], [0, 0], "a preview sends nothing");
    const store = readFileSync(join(root, "nivra.json"), "utf8");
    const started = await host.startResearch(plan.id, selection(), preview.expected);
    assert.deepEqual([started.status, host.conversation(conversation.id).openResearch], ["submitting", started.id]);
    const research = await ended(host, conversation.id);
    assert.equal(research.status, "answered", research.note ?? "");
    const report = research.report!;
    assert.deepEqual(
      [report.outcome, report.planId, report.planVersion, report.request.clientRequestId, report.assessments.map((a) => [a.assumption, a.model, a.shown]), research.note, research.stopCause],
      ["complete", plan.id, 1, research.id, [["A1", "contradicted", "contradicted"]], null, null],
    );
    // What was kept is what the preview was bound by.
    assert.equal(researchFingerprint({ planId: plan.id, planVersion: 1, packetDigest: research.packetDigest, webResearch: true, modelSharing: null }), preview.expected);
    assert.deepEqual([report.packetDigest, research.queries], [research.packetDigest, [{ assumption: "A1", text: ASSUMPTION, query: QUERY }]]);
    // Tavily got the approved query, once, with its own key, and never the plan; the model got one request.
    assert.deepEqual(searches(tavily).map((call) => [call.body?.["query"], call.authorization]), [[QUERY, `Bearer ${TAVILY}`]]);
    assert.equal(tavily.calls.some((call) => call.raw.includes(PLAN) || call.raw.includes(KEY)), false);
    assert.equal(researchRequests(model).length, 1);
    // Research writes nothing else: not the store, not the plan.
    assert.equal(readFileSync(join(root, "nivra.json"), "utf8"), store);
    assert.deepEqual(host.plans(conversation.id).map((p) => [p.version, p.text]), [[1, PLAN]]);
    assert.equal(host.conversation(conversation.id).openResearch, null);
  });

  it("refuses to start, sending nothing, when a query fails its checks, research is off, Tavily's key is missing, the project doesn't allow sharing, or the plan moved on", async () => {
    const { model, tavily } = await stubsFor();
    const repo = makeRepo(join(reposRoot(), "shop"), { "README.md": "# Shop\n" });
    const { host, ids, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url, projects: [{ targetId: "local", path: repo }] });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const general = host.createConversation({ kind: "general" });
    const plan = await planIn(host, general.id);
    /** The preview says why research can't start, and starting is refused with the same words. */
    const refused = async (planId: string, picks = selection()) => {
      const preview = await host.prepareResearch(planId, picks);
      await assert.rejects(host.startResearch(planId, picks, preview.expected), (error: Error) => error.message === preview.blocked);
      return preview.blocked;
    };
    assert.equal(await refused(plan.id, selection(`${QUERY} https://docs.python.org/3/whatsnew`)), "A1's query holds a web address, so nothing can be sent. Edit it, then preview again.");
    assert.equal(await refused(plan.id, selection("shop distutils")), "A1's query names one of your projects or its folder, so nothing can be sent. Edit it, then preview again.");
    await host.setWebResearch(false);
    assert.equal(await refused(plan.id), "Research queries to Tavily are turned off. Turn them on, then start again.");
    await host.setWebResearch(true);
    keys.current = { NEBIUS_API_KEY: KEY };
    assert.equal(await refused(plan.id), "Nivra has no Tavily API key. Add one in Settings, then start again.");
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    // A project's plan, made while sharing was on; then sharing is turned off.
    await host.setSharing(ids[0]!, true);
    const project = host.createConversation({ kind: "project", projectId: ids[0]! });
    const projectPlan = await planIn(host, project.id);
    await host.setSharing(ids[0]!, false);
    assert.equal(await refused(projectPlan.id), "This project doesn't allow sending its content to Token Factory. Allow sharing for it, then start research.");
    // The plan moved on since its preview: only the latest version can be researched.
    const preview = await host.prepareResearch(plan.id, selection());
    await host.revisePlan(plan.id, `${PLAN} Pin setuptools first.`);
    await assert.rejects(host.startResearch(plan.id, selection(), preview.expected), /^Error: This is v1 of the plan, and v2 is the latest\./);
    assert.deepEqual([tavily.calls.length, researchRequests(model).length, host.research(general.id).length, host.research(project.id).length], [0, 0, 0, 0], "nothing was stored or sent");
  });

  it("holds the conversation while research runs, cancels it on request with what it read, and then takes a message again", async () => {
    const search = gate();
    const { model, tavily } = await stubsFor({ search: search.held });
    const { host, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    const started = await start(host, plan.id);
    await waitFor(() => searches(tavily).length === 1, "the search to reach Tavily");
    assert.equal(host.conversation(conversation.id).openResearch, started.id);
    await assert.rejects(host.sendMessage(conversation.id, "Meanwhile?"), /^Error: Research of a plan's assumptions is running in this conversation\. Wait for it, or cancel it, then send again\.$/);
    assert.equal((await host.prepareReview(plan.id, "council")).blocked, "Research of a plan's assumptions is running in this conversation. Wait for it, or cancel it, then start the review.");
    await assert.rejects(host.cancelTurn(conversation.id, started.id), /^Error: That message is no longer in this conversation\.$/, "research isn't a message");
    await host.cancelResearch(conversation.id, started.id);
    const research = await ended(host, conversation.id);
    assert.deepEqual(
      [research.status, research.stopCause, research.note, research.report?.outcome, host.conversation(conversation.id).openResearch],
      ["cancelled", "person", `Cancelled. ${SENT}`, "cancelled", null],
    );
    // The search Tavily held is answered now: a run that went on would read its pages next.
    search.release();
    await host.sendMessage(conversation.id, "And now?");
    await answered(host, conversation.id);
    await pause(300);
    assert.deepEqual([searches(tavily).length, tavily.calls.filter((call) => call.path === "/extract").length, researchRequests(model).length], [1, 0, 0], "nothing more was sent");
  });

  it("stops research turned off during Search: nothing more is sent, and it says why", async () => {
    const search = gate();
    const { model, tavily } = await stubsFor({ search: search.held });
    const { host, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    await start(host, plan.id);
    await waitFor(() => searches(tavily).length === 1, "the search to reach Tavily");
    await host.setWebResearch(false);
    const research = await ended(host, conversation.id);
    assert.deepEqual(
      [research.status, research.stopCause, research.note, research.report?.requests.find((request) => request.id === "search-A1")?.failure],
      ["cancelled", "web-research", `Stopped: research queries to Tavily were turned off. ${SENT}`, "cancelled"],
    );
    search.release();
    await pause(300);
    assert.deepEqual([tavily.calls.filter((call) => call.path === "/extract").length, researchRequests(model).length], [0, 0]);
  });

  it("stops research asked to stop while it was being sent, by the person or a permission withdrawn, each with its own cause, once its engine answers", async () => {
    const NOTES = {
      person: `Cancelled. ${SENT}`,
      "web-research": `Stopped: research queries to Tavily were turned off. ${SENT}`,
      "model-sharing": `Stopped: sharing for this project was turned off. ${SENT}`,
    } as const;
    for (const how of ["person", "web-research", "model-sharing"] as const) {
      const { host, ids, home, conversation, plan } = await gated("project");
      rmSync(join(home, "release"));
      const started = await start(host, plan.id);
      await waitFor(() => starts(home) === 2, "the research's request to reach the engine");
      if (how === "person") await host.cancelResearch(conversation.id, started.id);
      else if (how === "web-research") await host.setWebResearch(false);
      else await host.setSharing(ids[0]!, false);
      const asked = host.research(conversation.id)[0]!;
      assert.deepEqual([how, asked.status, asked.stopCause, asked.cancelRequested], [how, "submitting", how, true]);
      writeFileSync(join(home, "release"), "");
      const research = await ended(host, conversation.id);
      const cancelled = readFileSync(join(home, "cancelled.log"), "utf8").split("\n").filter((runId) => runId === research.runId);
      assert.deepEqual([how, research.status, research.note, cancelled.length, starts(home)], [how, "cancelled", NOTES[how], 1, 2]);
    }
  });

  it("names the newest stop's own cause when both permissions are turned off, in either order, while it is being sent", async () => {
    for (const order of [["web-research", "model-sharing"], ["model-sharing", "web-research"]] as const) {
      const { host, ids, home, conversation, plan } = await gated("project");
      rmSync(join(home, "release"));
      await start(host, plan.id);
      await waitFor(() => starts(home) === 2, "the research's request to reach the engine");
      for (const permission of order) {
        if (permission === "web-research") await host.setWebResearch(false);
        else await host.setSharing(ids[0]!, false);
      }
      writeFileSync(join(home, "release"), "");
      const research = await ended(host, conversation.id);
      assert.deepEqual([order.join(" then "), research.status, research.stopCause], [order.join(" then "), "cancelled", order[1]]);
    }
  });

  it("stops research its engine had queued when its answer was lost, once it is found by its request id, and sends it once", async () => {
    const { host, home, conversation, plan } = await gated("general");
    rmSync(join(home, "release"));
    writeFileSync(join(home, "accept"), "");
    await start(host, plan.id);
    await waitFor(() => starts(home) === 2, "the research's request to reach the engine");
    await host.setWebResearch(false);
    writeFileSync(join(home, "error-start"), "");
    writeFileSync(join(home, "release"), "");
    const research = await ended(host, conversation.id);
    assert.deepEqual([research.status, research.stopCause, calls(home).includes("runs.find"), starts(home)], ["cancelled", "web-research", true, 2]);
    // The same, with the cancel its engine turns down once the run is found: that stop is taken back, the card says
    // why, and Cancel works again.
    const refused = await gated("general");
    rmSync(join(refused.home, "release"));
    writeFileSync(join(refused.home, "accept"), "");
    writeFileSync(join(refused.home, "running"), "");
    await start(refused.host, refused.plan.id);
    await waitFor(() => starts(refused.home) === 2, "the research's request to reach the engine");
    await refused.host.setWebResearch(false);
    writeFileSync(join(refused.home, "fail-cancel-once"), "");
    writeFileSync(join(refused.home, "error-start"), "");
    writeFileSync(join(refused.home, "release"), "");
    const shown = await waitFor(() => refused.host.research(refused.conversation.id).find((view) => view.stopFailed) ?? null, "the failed stop to be shown");
    const cancels = () => calls(refused.home).filter((call) => call === "runs.cancel").length;
    assert.deepEqual(
      [shown.status, shown.cancelRequested, shown.stopCause, shown.stopFailed, cancels()],
      ["running", false, null, "Research queries to Tavily are off, but Nivra couldn't stop this research (the run couldn't be stopped). Press Cancel to try again, or restart its engine to stop it.", 1],
    );
    await pause(500);
    assert.deepEqual([refused.host.research(refused.conversation.id)[0]!.status, cancels()], ["running", 1], "it goes on, and no cancel is sent again by itself");
    await refused.host.cancelResearch(refused.conversation.id, shown.id);
    assert.equal(refused.host.research(refused.conversation.id)[0]!.stopFailed, null, "a newer stop leaves the failure off the card");
    const stopped = await ended(refused.host, refused.conversation.id);
    assert.deepEqual([stopped.status, stopped.stopCause, stopped.stopFailed, cancels(), starts(refused.home)], ["cancelled", "person", null, 2, 2]);
  });

  it("says research its engine has no record of was never sent anywhere, in research's words, once Nivra starts again", async () => {
    const { host, root, home, conversation, plan } = await gated("general");
    rmSync(join(home, "release"));
    await start(host, plan.id);
    await waitFor(() => starts(home) === 2, "the research's request to reach the engine");
    // Nivra quits before runs.start answers, and the engine never recorded the run.
    await host.shutdown();
    const again = hostAt(root, { localEntry: GATED }).host;
    await again.openConversation(conversation.id);
    const research = await ended(again, conversation.id);
    assert.deepEqual(
      [research.status, research.note, calls(home).includes("runs.find"), starts(home)],
      ["not-sent", "Its engine has no record of this research, so it never ran and nothing reached Tavily or Token Factory.", true, 2],
    );
  });

  it("takes back a stop its engine couldn't carry out, and never a newer stop", async () => {
    // A stop that fails is withdrawn: the research goes on, and the person is told.
    const first = await gated("general");
    writeFileSync(join(first.home, "running"), "");
    const started = await start(first.host, first.plan.id);
    await waitFor(() => first.host.research(first.conversation.id)[0]?.runId ?? null, "the research's run");
    writeFileSync(join(first.home, "fail-cancel"), "");
    await assert.rejects(first.host.cancelResearch(first.conversation.id, started.id), /couldn't be stopped/);
    const going = first.host.research(first.conversation.id)[0]!;
    assert.deepEqual([going.status, going.stopCause, going.cancelRequested], ["running", null, false]);
    rmSync(join(first.home, "fail-cancel"));
    rmSync(join(first.home, "running"));
    assert.equal((await ended(first.host, first.conversation.id)).status, "answered");
    // A newer stop made while a failing one was out is kept: only the failing one is taken back.
    const second = await gated("general");
    writeFileSync(join(second.home, "running"), "");
    const out = await start(second.host, second.plan.id);
    await waitFor(() => second.host.research(second.conversation.id)[0]?.runId ?? null, "the research's run");
    writeFileSync(join(second.home, "hold-cancel"), "");
    writeFileSync(join(second.home, "fail-cancel-once"), "");
    const person = second.host.cancelResearch(second.conversation.id, out.id).then(
      () => "stopped",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await waitFor(() => calls(second.home).filter((call) => call === "runs.cancel").length === 1, "the person's stop to reach the engine");
    const off = second.host.setWebResearch(false);
    await waitFor(() => calls(second.home).filter((call) => call === "runs.cancel").length === 2, "research's stop to reach the engine");
    writeFileSync(join(second.home, "release-cancel"), "");
    assert.match(await person, /couldn't be stopped/);
    await off;
    const research = await ended(second.host, second.conversation.id);
    assert.deepEqual([research.status, research.stopCause, research.note], ["cancelled", "web-research", `Stopped: research queries to Tavily were turned off. ${SENT}`]);
    // Turning research off when its engine can't stop a run says so, and takes that stop back; research stays off.
    const third = await gated("general");
    writeFileSync(join(third.home, "running"), "");
    await start(third.host, third.plan.id);
    await waitFor(() => third.host.research(third.conversation.id)[0]?.runId ?? null, "the research's run");
    writeFileSync(join(third.home, "fail-cancel"), "");
    await assert.rejects(third.host.setWebResearch(false), /^Error: Research queries to Tavily are off, but Nivra couldn't stop a research run \(.+\)\. Restart its engine to stop it\.$/);
    const unstopped = third.host.research(third.conversation.id)[0]!;
    assert.deepEqual([third.host.webResearch(), unstopped.status, unstopped.stopCause, unstopped.cancelRequested], [false, "running", null, false]);
  });

  it("keeps a project's research stops that worked when another of its runs can't be stopped, and names only what couldn't", async () => {
    const cancelled = (home: string) => readFileSync(join(home, "cancelled.log"), "utf8").split("\n");
    // Sharing turned off while research runs: the project's other run (the turn that made the plan) is cancelled first,
    // and its engine turns that down once. The research's own stop worked, so it stays, with its cause.
    const known = await gated("project");
    writeFileSync(join(known.home, "running"), "");
    await start(known.host, known.plan.id);
    const runId = await waitFor(() => known.host.research(known.conversation.id)[0]?.runId ?? null, "the research's run");
    writeFileSync(join(known.home, "fail-cancel-once"), "");
    await assert.rejects(known.host.setSharing(known.ids[0]!, false), /^Error: Sharing for this project is off, but Nivra couldn't stop an explain run \(.+\)\. Restart the project's engine to stop it\.$/);
    const stopped = await ended(known.host, known.conversation.id);
    assert.deepEqual(
      [stopped.status, stopped.stopCause, stopped.note, cancelled(known.home).includes(runId)],
      ["cancelled", "model-sharing", `Stopped: sharing for this project was turned off. ${SENT}`, true],
    );
    // Its run not known yet, its answer lost: the stop stays, and the run is cancelled once it is found.
    const lost = await gated("project");
    writeFileSync(join(lost.home, "running"), "");
    rmSync(join(lost.home, "release"));
    writeFileSync(join(lost.home, "accept"), "");
    await start(lost.host, lost.plan.id);
    await waitFor(() => starts(lost.home) === 2, "the research's request to reach the engine");
    writeFileSync(join(lost.home, "hold-find"), "");
    writeFileSync(join(lost.home, "error-start"), "");
    writeFileSync(join(lost.home, "release"), "");
    await waitFor(() => calls(lost.home).includes("runs.find"), "the research to be looked for by its request id");
    writeFileSync(join(lost.home, "fail-cancel-once"), "");
    await assert.rejects(lost.host.setSharing(lost.ids[0]!, false), /^Error: Sharing for this project is off, but Nivra couldn't stop an explain run /);
    const looking = lost.host.research(lost.conversation.id)[0]!;
    assert.deepEqual([looking.status, looking.runId, looking.stopCause], ["submitting", null, "model-sharing"]);
    writeFileSync(join(lost.home, "release-find"), "");
    const found = await ended(lost.host, lost.conversation.id);
    assert.deepEqual([found.status, found.stopCause, cancelled(lost.home).includes(found.runId!), starts(lost.home)], ["cancelled", "model-sharing", true, 2]);
    // A removal refused because another run couldn't be stopped: the project stays, and the research's note claims only
    // that a removal was under way.
    const refused = await gated("project");
    writeFileSync(join(refused.home, "running"), "");
    await start(refused.host, refused.plan.id);
    await waitFor(() => refused.host.research(refused.conversation.id)[0]?.runId ?? null, "the research's run");
    writeFileSync(join(refused.home, "fail-cancel-once"), "");
    await assert.rejects(refused.host.removeProject(refused.ids[0]!), /^Error: Nivra couldn't stop an explain run \(.+\), so the project is still in the list\. Restart its engine, then remove it again\.$/);
    const kept = await ended(refused.host, refused.conversation.id);
    assert.deepEqual([refused.host.projects().length, kept.status, kept.stopCause, kept.note], [1, "cancelled", "removal", `Stopped: the project was being removed. ${SENT}`]);
    // A removal that goes through stops its research the same way.
    const removed = await gated("project");
    writeFileSync(join(removed.home, "running"), "");
    await start(removed.host, removed.plan.id);
    await waitFor(() => removed.host.research(removed.conversation.id)[0]?.runId ?? null, "the research's run");
    await removed.host.removeProject(removed.ids[0]!);
    const gone = await ended(removed.host, removed.conversation.id);
    assert.deepEqual([removed.host.projects().length, gone.status, gone.stopCause, gone.note], [0, "cancelled", "removal", `Stopped: the project was being removed. ${SENT}`]);
  });

  it("reports research cut off by a killed engine as interrupted after a restart, keeps the report it saved, and sends nothing again", async () => {
    const { model, tavily } = await stubsFor({ extractMs: 60_000 });
    const { host, root, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    await start(host, plan.id);
    await waitFor(() => tavily.calls.some((call) => call.path === "/extract"), "the extract to reach Tavily");
    const { pid } = await online(host, "local");
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid), "the engine to die");
    await host.shutdown();
    const sent = tavily.calls.length;
    const again = hostAt(root, { tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    again.keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await again.host.openConversation(conversation.id);
    const research = await ended(again.host, conversation.id);
    assert.deepEqual(
      [research.status, research.note, research.report?.outcome],
      ["interrupted", "Interrupted: Nivra or its engine stopped before the research finished. A request it was making may have been sent, and its credits are unknown. Nothing was resent.", "interrupted"],
    );
    assert.deepEqual(
      research.report?.requests.map((request) => [request.id, request.state, request.failure]),
      [
        ["search-A1", "answered", null],
        ["extract-A1", "failed", "interrupted"],
        ["model", "skipped", null],
      ],
    );
    assert.deepEqual([research.report?.pages.length, research.report?.usage.credits], [1, null], "what Search found is kept, and the credits are unknown");
    await pause(300);
    assert.deepEqual([tavily.calls.length, researchRequests(model).length], [sent, 0], "nothing was sent again");
  });

  it("deletes a conversation while its research runs: the run stops, and the workspace keeps nothing of it", async () => {
    const search = gate();
    const { model, tavily } = await stubsFor({ search: search.held });
    const { host, root, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const canary = `nivra-research-plan-canary-${randomUUID()}`;
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id, `${PLAN} ${canary}`);
    await start(host, plan.id);
    await waitFor(() => searches(tavily).length === 1, "the search to reach Tavily");
    const runId = await waitFor(() => host.research(conversation.id)[0]?.runId ?? null, "the research's run");
    await host.deleteConversation(conversation.id);
    assert.throws(() => host.research(conversation.id), /no longer in the list/);
    await waitFor(async () => (await host.runEvents(runId, 0)).status === "cancelled", "the research's run to stop");
    search.release();
    await pause(300);
    assert.deepEqual([tavily.calls.filter((call) => call.path === "/extract").length, researchRequests(model).length], [0, 0], "nothing more was sent");
    await host.shutdown();
    const workspace = new DatabaseSync(join(root, "workspace.db"), { readOnly: true });
    try {
      const count = (table: string) => Number(workspace.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
      assert.deepEqual([count("research"), count("run_links"), count("artifacts")], [0, 0, 0]);
    } finally {
      workspace.close();
    }
    assert.deepEqual(filesHolding(root, canary).filter((file) => file.startsWith("workspace.db")), []);
    assert.equal(researchRequests(model).length, 0);
  });

  it("saves one amended version from research, in one transaction: derived from the researched version, recorded, and never twice", async () => {
    const { model, tavily } = await stubsFor();
    const { host, root, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    await start(host, plan.id);
    const research = await ended(host, conversation.id);
    assert.equal(research.status, "answered", research.note ?? "");
    const AMENDED = `${PLAN} Install setuptools in the 3.12 image first.`;
    // Two saves at once: exactly one lands, and the other says why.
    const [first, second] = await Promise.allSettled([host.saveAmendedPlan(research.id, AMENDED, ["setuptools still provides distutils"]), host.saveAmendedPlan(research.id, `${AMENDED} Twice.`, [])]);
    assert.deepEqual([first.status, second.status], ["fulfilled", "rejected"]);
    assert.match(String((second as PromiseRejectedResult).reason), /^Error: A version amended from this research was saved already, so nothing new was saved\./);
    const amended = (first as PromiseFulfilledResult<Awaited<ReturnType<Host["saveAmendedPlan"]>>>).value;
    assert.deepEqual([amended.version, amended.text, amended.assumptions, amended.latest], [2, AMENDED, ["setuptools still provides distutils"], 2]);
    assert.deepEqual([host.plans(conversation.id).map((p) => p.version), host.research(conversation.id)[0]?.amended], [[1, 2], { planId: amended.id, version: 2 }]);
    // One after the other: refused as well, and nothing new is saved.
    await assert.rejects(host.saveAmendedPlan(research.id, AMENDED, []), /^Error: A version amended from this research was saved already/);
    assert.equal(host.plans(conversation.id).length, 2);
    // A later edit is a plain next version: the research still names the version it led to, and nothing more.
    const v3 = await host.revisePlan(amended.id, `${AMENDED} And test it.`);
    assert.deepEqual([v3.version, host.research(conversation.id)[0]?.amended?.version], [3, 2]);
    await host.shutdown();
    const workspace = new DatabaseSync(join(root, "workspace.db"), { readOnly: true });
    try {
      const rows = workspace.prepare("SELECT version, derived_from, content_json FROM artifacts ORDER BY version").all();
      assert.deepEqual(rows.map((row) => [row["version"], row["derived_from"]]), [[1, null], [2, plan.id], [3, amended.id]], "each version derives from the one before");
      assert.equal(rows.some((row) => /research/i.test(String(row["content_json"]))), false, "no version's content says anything of the research");
    } finally {
      workspace.close();
    }
  });

  it("saves no amended version once the plan has moved on since its research, or when it holds a credential", async () => {
    const { model, tavily } = await stubsFor();
    const { host, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    await start(host, plan.id);
    const research = await ended(host, conversation.id);
    await assert.rejects(host.saveAmendedPlan(research.id, `${PLAN} Use ${KEY} to pull.`, []), /^Error: The plan holds your saved Token Factory key, so nothing was saved\./);
    await host.revisePlan(plan.id, `${PLAN} Pin setuptools first.`);
    await assert.rejects(
      host.saveAmendedPlan(research.id, `${PLAN} Install setuptools first.`, []),
      /^Error: This plan moved on since it was researched: v1 isn't its latest version any more, so nothing was saved\. Research the latest version, then save an amended one from that\.$/,
    );
    assert.deepEqual([host.plans(conversation.id).map((p) => p.version), host.research(conversation.id)[0]?.amended], [[1, 2], null]);
  });

  it("fails research cleanly when Tavily can't be reached, asks the model nothing, and the conversation goes on", async () => {
    const { model, tavily } = await stubsFor();
    await tavily.close();
    const { host, keys } = makeHost({ tokenFactoryUrl: model.url, tavilyUrl: tavily.url });
    keys.current = { NEBIUS_API_KEY: KEY, TAVILY_API_KEY: TAVILY };
    await host.setWebResearch(true);
    const conversation = host.createConversation({ kind: "general" });
    const plan = await planIn(host, conversation.id);
    await start(host, plan.id);
    const research = await ended(host, conversation.id);
    assert.deepEqual([research.status, research.report?.stop?.code, researchRequests(model).length], ["failed", "tavily-unavailable", 0], research.note ?? "");
    await host.sendMessage(conversation.id, "And without research?");
    await answered(host, conversation.id);
  });
});

describe("Host: task runs, on a project's engine, bound to the preview the person saw (D39)", () => {
  const KEY = "test-key-0123456789";
  const PROJECT_ID = "project-e00hosttask0001";
  const SECRETS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };
  const FILES = Object.fromEntries(TASK_FIXTURE.map((file) => [file.path, String(file.bytes)]));
  const CASE = { name: "greet with and without a name", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 };
  const FIELDS = { goal: "greet with no name says Hello, world", acceptanceCriteria: ["check.sh passes"], scope: "", exclusions: "", context: "", assumptions: [], checks: ["/bin/sh check.sh"], acceptanceCases: [CASE] };
  const WORK: Array<[string, Record<string, unknown>]> = [["read_file", { path: "greet.sh" }], ["edit_file", TASK_FIX], ["run_case", { number: 1 }], ["submit", { summary: "Defaulted the name to world." }]];
  const RUNNING = "A task is already running. Wait for it to end, or cancel it, then run this one.";
  const local: Array<{ close(): Promise<void> }> = [];
  after(async () => {
    await Promise.all(local.map((stub) => stub.close()));
  });
  const reposRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "nivra task repos "));
    dirs.push(root);
    return root;
  };
  /** Stand-ins for Nebius, its guest running each command with this machine's tools, and for Token Factory, its model doing `calls`. */
  async function standIns(calls = WORK) {
    const guest = new RealGuest(CHECK_IMAGE.uuid);
    guest.busybox = true;
    const sandbox = await startSandboxStub({ guest });
    const model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: (_request, index) => toolCall(calls[Math.min(index, calls.length - 1)]![0], calls[Math.min(index, calls.length - 1)]![1], { id: `call_${index}` }) });
    local.push(sandbox, model);
    return { sandbox, model, guest };
  }
  /** A host whose one project is a WSL repository holding the fixture, both consents given, the keys saved. */
  async function taskHost(options: { calls?: Array<[string, Record<string, unknown>]>; consents?: boolean } = {}) {
    const { sandbox, model, guest } = await standIns(options.calls);
    const repo = makeRepo(join(reposRoot(), "greet"), FILES);
    const made = makeHost({ tokenFactoryUrl: model.url, sandboxesUrl: sandbox.url, projects: [{ targetId: "wsl:Test", path: repo }] });
    made.keys.current = SECRETS;
    if (options.consents !== false) {
      await made.host.setSharing(made.ids[0]!, true);
      await made.host.setCloudExecution(made.ids[0]!, true);
    }
    return { ...made, sandbox, model, guest, repo };
  }
  async function readyTask(host: Host, projectId: string, fields = FIELDS, title = "Greet the world") {
    const task = await host.createTask({ title, fields, projectId, planId: null });
    return host.setTaskState(task.summary.id, task.revision, "ready");
  }
  const ended = (host: Host, taskId: string, attemptId: string, what = "the run to end") =>
    waitFor(async () => {
      const view = await host.taskAttempt(taskId, attemptId);
      return view.status !== "submitting" && view.status !== "running" ? view : null;
    }, what, 60_000);
  const uploads = (stub: SandboxStub<RealGuest>) => stub.requests.filter((request) => request.path === "/v1/files").length;

  it("runs a ready task's brief on its project's engine, previewed and bound, and reads back its report and change, the checkout untouched", async () => {
    const { host, ids, sandbox, model, repo } = await taskHost();
    const task = await readyTask(host, ids[0]!);
    assert.equal(task.runBlocked, null);
    const before = folderState(repo);
    const preview = await host.previewTaskRun(task.summary.id);
    assert.deepEqual([preview.blocked, preview.snapshot?.files, preview.programs, preview.unprobed, preview.cases.map((c) => [c.number, c.name]), preview.checks, preview.caseFiles, preview.consents, preview.project.targetLabel], [
      null,
      2,
      [".", "/bin/sh"],
      0,
      [[1, CASE.name]],
      [{ number: 1, command: "/bin/sh check.sh" }],
      [{ number: 1, files: ["greet.sh"], unclear: false }],
      { modelContext: true, cloudExecution: true },
      "Test · WSL",
    ]);
    assert.match(preview.keeps.nebius ?? "", /^Images are retained for 180 days.* Nebius keeps each operation's arguments in its records, so what the worker writes stays there too\.$/);
    // The one model the run may use is named before Start, so starting it approves that model (NIV-35).
    assert.equal(preview.sends.tokenFactory.at(-1), "All of it to one model, nvidia/nemotron-3-super-120b-a12b. If Token Factory doesn't offer your key that model, the run stops before any request to a model; no other model stands in.");
    assert.deepEqual([sandbox.requests.length, model.chats().length], [0, 0], "a preview sends nothing");
    const started = await host.startTaskRun(task.summary.id, preview.expected, preview.snapshotFingerprint!);
    assert.ok(["submitting", "running"].includes(started.status));
    const done = await ended(host, task.summary.id, started.id);
    assert.equal(done.status, "answered", done.note ?? done.unresolved ?? "");
    assert.deepEqual([done.report?.outcome, done.report?.verified, done.report?.checks.map((check) => check.verdict), done.proposal?.paths.map((path) => path.path), done.note], ["proposed", true, ["passed", "passed"], ["greet.sh"], null]);
    // The case sources greet.sh, which the change changes; the check runs check.sh, which it doesn't.
    assert.deepEqual(done.report?.checks.map((check) => [check.changedFiles, check.unclear]), [[["greet.sh"], false], [[], false]]);
    assert.match(done.proposal?.patch ?? "", /^\+ {2}printf 'Hello, %s\\n' "\$\{1:-world\}"$/m);
    assert.ok(done.progress.some((line) => line === "Final checks: case 1 passed, check 1 passed"), done.progress.join(" | "));
    assert.deepEqual(changedSince(before, repo), []);
    assert.deepEqual([uploads(sandbox), model.chats().length], [1, 4]);
    assert.deepEqual(host.task(task.summary.id).attempts.map((attempt) => [attempt.status, attempt.briefVersion, attempt.note]), [["answered", 1, null]]);
  });

  it("previews what keeps a run from starting, refuses a start whose preview changed, and starts nothing on Windows itself", async () => {
    const { host, ids, sandbox, model, keys } = await taskHost({ consents: false });
    // No acceptance case: nothing to judge the run by, so it isn't previewed past that, and no engine starts.
    const caseless = await readyTask(host, ids[0]!, { ...FIELDS, acceptanceCases: [] }, "No case yet");
    assert.equal(caseless.runBlocked, NO_CASE);
    const early = await host.previewTaskRun(caseless.summary.id);
    assert.deepEqual([early.blocked, early.snapshot, early.expected, stateOf(host, "wsl:Test")?.status ?? "stopped"], [NO_CASE, null, "", "stopped"]);
    // Both consents off, then each alone, then the keys: the snapshot is previewed, and the start refused.
    const task = await readyTask(host, ids[0]!);
    const blocked = async () => (await host.previewTaskRun(task.summary.id)).blocked;
    assert.match((await blocked()) ?? "", /^This project doesn't allow sending its content to Token Factory/);
    await host.setSharing(ids[0]!, true);
    assert.match((await blocked()) ?? "", /^This project doesn't allow uploading its commit to Nebius Sandboxes/);
    await host.setCloudExecution(ids[0]!, true);
    keys.current = { NEBIUS_API_KEY: KEY };
    assert.match((await blocked()) ?? "", /^A task run needs your Nebius key and project id/);
    keys.current = SECRETS;
    const preview = await host.previewTaskRun(task.summary.id);
    assert.equal(preview.blocked, null);
    // The brief changed after the preview: what the run would send isn't what was shown.
    const revised = await host.reviseBrief(task.summary.id, host.task(task.summary.id).revision, { ...FIELDS, context: "Keep it in POSIX sh." });
    await assert.rejects(host.startTaskRun(task.summary.id, preview.expected, preview.snapshotFingerprint!), /^Error: What this run would send has changed since you previewed it\. Preview it again, then start\.$/);
    assert.equal(revised.brief.version, 2);
    // A preview made while a consent was off doesn't start a run once it is on.
    await host.setCloudExecution(ids[0]!, false);
    const offPreview = await host.previewTaskRun(task.summary.id);
    await host.setCloudExecution(ids[0]!, true);
    await assert.rejects(host.startTaskRun(task.summary.id, offPreview.expected || "a".repeat(64), offPreview.snapshotFingerprint ?? "b".repeat(64)), /changed since you previewed it/);
    assert.deepEqual([uploads(sandbox), model.chats().length, host.task(task.summary.id).attempts], [0, 0, []]);
    // A repository on Windows itself: no run, whatever else holds.
    const windows = makeHost({ projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), FILES) }] });
    windows.keys.current = SECRETS;
    await windows.host.setSharing(windows.ids[0]!, true);
    await windows.host.setCloudExecution(windows.ids[0]!, true);
    const native = await readyTask(windows.host, windows.ids[0]!);
    assert.equal(native.runBlocked, "Running tasks on Windows itself isn't available yet. Add the repository from a WSL distribution, then run the task there.");
    await assert.rejects(windows.host.startTaskRun(native.summary.id, "a".repeat(64), "b".repeat(64)), /Running tasks on Windows itself isn't available yet/);
  });

  it("runs one task at a time, won't delete a task while its run goes, and stops a run when uploads are turned off or its project is removed", async () => {
    const { host, ids, guest, sandbox } = await taskHost();
    guest.override = ({ label }) => (label === "nivra-toolchain" ? { waits: true } : undefined);
    const first = await readyTask(host, ids[0]!, FIELDS, "First");
    const second = await readyTask(host, ids[0]!, FIELDS, "Second");
    const start = async (taskId: string) => {
      const preview = await host.previewTaskRun(taskId);
      return host.startTaskRun(taskId, preview.expected, preview.snapshotFingerprint!);
    };
    const run = await start(first.summary.id);
    await waitFor(() => operationRead(sandbox, "nivra-toolchain"), "the engine's first read of the toolchain probe's operation", 30_000);
    assert.equal(host.task(second.summary.id).runBlocked, RUNNING);
    await assert.rejects(host.startTaskRun(second.summary.id, "a".repeat(64), "b".repeat(64)), new RegExp(RUNNING.replace(/[.]/g, "\\.")));
    assert.throws(() => host.deleteTask(first.summary.id), /^Error: This task's run is still going\. Cancel it, and wait for it to end, then delete the task\.$/);
    // Uploads turned off: the run stops, and says why.
    await host.setCloudExecution(ids[0]!, false);
    const stopped = await ended(host, first.summary.id, run.id);
    assert.deepEqual([stopped.status, stopped.note, stopped.report?.outcome], ["cancelled", "Stopped: this project's sharing or uploads were turned off. What it had sent stays where it went; its report says what that was.", "cancelled"]);
    // The next run starts once that one has ended, and removing the project stops it.
    await host.setCloudExecution(ids[0]!, true);
    const next = await start(second.summary.id);
    await waitFor(() => operationRead(sandbox, "nivra-toolchain", 2), "the engine's first read of the next toolchain probe's operation", 30_000);
    await host.removeProject(ids[0]!);
    const removed = await ended(host, second.summary.id, next.id);
    assert.deepEqual([removed.status, removed.note], ["cancelled", "Stopped: the project was removed. What it had sent stays where it went."]);
    host.deleteTask(first.summary.id);
    assert.deepEqual(host.tasks().tasks.map((t) => t.title), ["Second"]);
  });

  it("finds a run whose start's answer was lost by its request id and never sends it again, and stops one whose consent went while its start was out", async () => {
    const made = makeHost({ wslEntry: GATED, projects: [{ targetId: "wsl:Test", path: "/nowhere/gated" }] });
    const { host, ids, keys, root } = made;
    keys.current = SECRETS;
    await host.setSharing(ids[0]!, true);
    await host.setCloudExecution(ids[0]!, true);
    const home = join(root, "wsl home");
    mkdirSync(home, { recursive: true });
    const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
    const logged = (file: string) => (existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").split("\n").filter(Boolean) : []);
    // The gated engine takes no preview: the start is bound to a snapshot fingerprint the test gives, as the window would.
    const task = await readyTask(host, ids[0]!);
    const view = host.task(task.summary.id);
    const packet = (taskBriefOf(view.brief.content) as { brief: TaskBrief }).brief;
    const expected = async (snapshot: string) =>
      taskRunFingerprint({ taskId: task.summary.id, briefId: view.brief.id, briefVersion: view.brief.version, briefDigest: await taskBriefDigest(packet), projectId: ids[0]!, targetId: "wsl:Test", sharing: { modelContext: true, cloudExecution: true }, snapshot });
    const snapshot = "c".repeat(64);
    // Accepted, then answered with an error: the run is found by its request id, and recorded as it ended.
    writeFileSync(join(home, "accept"), "");
    writeFileSync(join(home, "error-start"), "");
    writeFileSync(join(home, "release"), "");
    const lost = await host.startTaskRun(task.summary.id, await expected(snapshot), snapshot);
    const found = await ended(host, task.summary.id, lost.id, "the lost run to be found");
    assert.deepEqual([found.status, found.runId === logged("accepted.log")[0]?.split(" ")[1], calls().filter((call) => call === "runs.start").length], ["answered", true, 1]);
    // Refused with an error and never recorded: not sent, in the engine's own words.
    rmSync(join(home, "accept"));
    const refused = await host.startTaskRun(task.summary.id, await expected(snapshot), snapshot);
    const notSent = await ended(host, task.summary.id, refused.id, "the refused run to settle");
    assert.deepEqual([notSent.status, notSent.note], ["not-sent", "The engine didn't start the run, so nothing was uploaded and nothing reached the model. The engine refused the run."]);
    // Model sharing turned off while the start is out: the run the engine made is stopped as soon as it answers, and a
    // stop its engine turns down is sent again until it is taken.
    rmSync(join(home, "error-start"));
    rmSync(join(home, "release"));
    writeFileSync(join(home, "accept"), "");
    const before = calls().filter((call) => call === "runs.start").length;
    const late = await host.startTaskRun(task.summary.id, await expected(snapshot), snapshot);
    await waitFor(() => calls().filter((call) => call === "runs.start").length === before + 1, "the run's request to reach the engine");
    await host.setSharing(ids[0]!, false);
    // Running until it is stopped, and every stop turned down for now.
    writeFileSync(join(home, "running"), "");
    writeFileSync(join(home, "fail-cancel"), "");
    const cancels = calls().filter((call) => call === "runs.cancel").length;
    writeFileSync(join(home, "release"), "");
    await waitFor(() => calls().filter((call) => call === "runs.cancel").length >= cancels + 3, "the stop to be turned down and sent again");
    rmSync(join(home, "fail-cancel"));
    const withdrawn: TaskAttemptView = await ended(host, task.summary.id, late.id, "the withdrawn run to stop");
    assert.deepEqual([withdrawn.status, logged("cancelled.log").includes(withdrawn.runId ?? "none")], ["cancelled", true]);
    assert.match(withdrawn.note ?? "", /^Stopped: this project's sharing or uploads were turned off/);
  });

  it("stops a task run when uploads are turned off though the project's check couldn't be stopped, and the check though the run couldn't", async () => {
    const made = makeHost({ wslEntry: GATED, projects: [{ targetId: "wsl:Test", path: "/nowhere/gated" }] });
    const { host, ids, keys, root } = made;
    keys.current = SECRETS;
    await host.setSharing(ids[0]!, true);
    await host.setCloudExecution(ids[0]!, true);
    const home = join(root, "wsl home");
    mkdirSync(home, { recursive: true });
    const cancelled = () => (existsSync(join(home, "cancelled.log")) ? readFileSync(join(home, "cancelled.log"), "utf8").split("\n").filter(Boolean) : []);
    for (const flag of ["accept", "release", "running"]) writeFileSync(join(home, flag), "");
    const task = await readyTask(host, ids[0]!);
    const view = host.task(task.summary.id);
    const packet = (taskBriefOf(view.brief.content) as { brief: TaskBrief }).brief;
    const snapshot = "c".repeat(64);
    const expected = taskRunFingerprint({ taskId: task.summary.id, briefId: view.brief.id, briefVersion: view.brief.version, briefDigest: await taskBriefDigest(packet), projectId: ids[0]!, targetId: "wsl:Test", sharing: { modelContext: true, cloudExecution: true }, snapshot });
    const going = async () => {
      const started = await host.startTaskRun(task.summary.id, expected, snapshot);
      const running = await waitFor(async () => {
        const seen = await host.taskAttempt(task.summary.id, started.id);
        return seen.status === "running" && seen.runId ? seen : null;
      }, "the task's run to be going");
      return { id: started.id, runId: running.runId! };
    };
    // The project's sandbox check and a task's run, both going; the engine turns the check's stop down.
    const check = await host.startSandboxCheck(ids[0]!, "a".repeat(64));
    const first = await going();
    writeFileSync(join(home, "fail-cancel-for"), check.runId!);
    await assert.rejects(host.setCloudExecution(ids[0]!, false), /^Error: Nivra couldn't stop the sandbox check \(the run couldn't be stopped\)\./);
    assert.equal(host.projects()[0]?.sharing.cloudExecution, false);
    const stopped = await ended(host, task.summary.id, first.id, "the task's run to stop");
    assert.deepEqual([stopped.status, cancelled()], ["cancelled", [first.runId]]);
    // The other way round: the run's stop is turned down, the check is stopped, and the run isn't said to be stopping.
    await host.setCloudExecution(ids[0]!, true);
    const second = await going();
    writeFileSync(join(home, "fail-cancel-for"), second.runId);
    await assert.rejects(host.setCloudExecution(ids[0]!, false), /^Error: Uploads for this project are off, but Nivra couldn't stop its task run \(the run couldn't be stopped\)\. Restart the project's engine to stop it\.$/);
    const left = await host.taskAttempt(task.summary.id, second.id);
    assert.deepEqual([left.status, left.cancelRequested, cancelled()], ["running", false, [first.runId, check.runId]]);
    rmSync(join(home, "fail-cancel-for"));
    await host.cancelTaskRun(task.summary.id, second.id);
    assert.equal((await ended(host, task.summary.id, second.id, "the second run to stop")).status, "cancelled");
  });

  it("stops a task run when sharing is turned off though the project's explanation couldn't be stopped, and says so", async () => {
    const made = makeHost({ wslEntry: GATED, projects: [{ targetId: "wsl:Test", path: "/nowhere/gated" }] });
    const { host, ids, keys, root } = made;
    keys.current = SECRETS;
    await host.setSharing(ids[0]!, true);
    await host.setCloudExecution(ids[0]!, true);
    const home = join(root, "wsl home");
    mkdirSync(home, { recursive: true });
    const cancelled = () => (existsSync(join(home, "cancelled.log")) ? readFileSync(join(home, "cancelled.log"), "utf8").split("\n").filter(Boolean) : []);
    for (const flag of ["accept", "release", "running"]) writeFileSync(join(home, flag), "");
    const explain = await host.startExplain(ids[0]!, "", []);
    const task = await readyTask(host, ids[0]!);
    const view = host.task(task.summary.id);
    const packet = (taskBriefOf(view.brief.content) as { brief: TaskBrief }).brief;
    const snapshot = "c".repeat(64);
    const expected = taskRunFingerprint({ taskId: task.summary.id, briefId: view.brief.id, briefVersion: view.brief.version, briefDigest: await taskBriefDigest(packet), projectId: ids[0]!, targetId: "wsl:Test", sharing: { modelContext: true, cloudExecution: true }, snapshot });
    const started = await host.startTaskRun(task.summary.id, expected, snapshot);
    const running = await waitFor(async () => {
      const seen = await host.taskAttempt(task.summary.id, started.id);
      return seen.status === "running" && seen.runId ? seen : null;
    }, "the task's run to be going");
    writeFileSync(join(home, "fail-cancel-for"), explain.id);
    await assert.rejects(host.setSharing(ids[0]!, false), /^Error: Sharing for this project is off, but Nivra couldn't stop an explain run \(the run couldn't be stopped\)\./);
    const stopped = await ended(host, task.summary.id, started.id, "the task's run to stop");
    assert.deepEqual([stopped.status, cancelled()], ["cancelled", [running.runId]]);
    assert.match(stopped.note ?? "", /^Stopped: this project's sharing or uploads were turned off/);
  });

  it("removes a project whose task run's engine has stopped: the run's stop is recorded, and nothing is sent", async () => {
    const made = makeHost({ wslEntry: GATED, projects: [{ targetId: "wsl:Test", path: "/nowhere/gated" }] });
    const { host, ids, keys, root } = made;
    keys.current = SECRETS;
    await host.setSharing(ids[0]!, true);
    await host.setCloudExecution(ids[0]!, true);
    const home = join(root, "wsl home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["accept", "release", "running"]) writeFileSync(join(home, flag), "");
    const task = await readyTask(host, ids[0]!);
    const view = host.task(task.summary.id);
    const packet = (taskBriefOf(view.brief.content) as { brief: TaskBrief }).brief;
    const snapshot = "c".repeat(64);
    const expected = taskRunFingerprint({ taskId: task.summary.id, briefId: view.brief.id, briefVersion: view.brief.version, briefDigest: await taskBriefDigest(packet), projectId: ids[0]!, targetId: "wsl:Test", sharing: { modelContext: true, cloudExecution: true }, snapshot });
    const started = await host.startTaskRun(task.summary.id, expected, snapshot);
    await waitFor(async () => (await host.taskAttempt(task.summary.id, started.id)).runId, "the task's run to be going");
    const { pid } = await online(host, "wsl:Test");
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid) && stateOf(host, "wsl:Test")?.status !== "online", "the engine to stop");
    await host.removeProject(ids[0]!);
    const left = await host.taskAttempt(task.summary.id, started.id);
    assert.deepEqual([host.projects().length, left.cancelRequested, readFileSync(join(home, "calls.log"), "utf8").includes("runs.cancel")], [0, true, false]);
  });
});

describe("Host: deciding on a task's change and applying it on its run's engine (D40)", () => {
  const KEY = "test-key-0123456789";
  const PROJECT_ID = "project-e00hostapply001";
  const SECRETS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };
  const FILES = Object.fromEntries(TASK_FIXTURE.map((file) => [file.path, String(file.bytes)]));
  const CASE = { name: "greet with and without a name", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 };
  const FIELDS = { goal: "greet with no name says Hello, world", acceptanceCriteria: ["check.sh passes"], scope: "", exclusions: "", context: "", assumptions: [], checks: ["/bin/sh check.sh"], acceptanceCases: [CASE] };
  const WORK: Array<[string, Record<string, unknown>]> = [["edit_file", TASK_FIX], ["submit", { summary: "Defaulted the name to world." }]];
  /** A change that runs but doesn't do what the case asks: not every case passes. */
  const WRONG: Array<[string, Record<string, unknown>]> = [["edit_file", { path: "greet.sh", old_text: '"$1"', new_text: '"${1:-everyone}"' }], ["submit", { summary: "Defaulted the name." }]];
  const DECIDE = "Decide on the last run's change first: approve it, reject it, or ask for a revision.";
  const GATED_HASH = "5".repeat(64);
  const local: Array<{ close(): Promise<void> }> = [];
  after(async () => {
    await Promise.all(local.map((stub) => stub.close()));
  });
  const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;
  /** A host whose one project is a WSL repository holding the fixture, both consents given, the keys saved, its model doing `calls`. */
  async function applyHost(calls = WORK) {
    const guest = new RealGuest(CHECK_IMAGE.uuid);
    guest.busybox = true;
    const sandbox = await startSandboxStub({ guest });
    // The script starts again with each run: its step is how many answers the request already holds.
    const step = (request: StubRequest) => Math.min((request.body?.messages ?? []).filter((message) => (message as { role?: string }).role === "assistant").length, calls.length - 1);
    const model = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat: (request, index) => toolCall(calls[step(request)]![0], calls[step(request)]![1], { id: `call_${index}` }) });
    local.push(sandbox, model);
    const parent = mkdtempSync(join(tmpdir(), "nivra apply repos "));
    dirs.push(parent);
    const repo = makeRepo(join(parent, "greet"), FILES);
    const made = makeHost({ tokenFactoryUrl: model.url, sandboxesUrl: sandbox.url, projects: [{ targetId: "wsl:Test", path: repo }] });
    made.keys.current = SECRETS;
    await made.host.setSharing(made.ids[0]!, true);
    await made.host.setCloudExecution(made.ids[0]!, true);
    return { ...made, repo };
  }
  async function readyTask(host: Host, projectId: string, title = "Greet the world") {
    const task = await host.createTask({ title, fields: FIELDS, projectId, planId: null });
    return host.setTaskState(task.summary.id, task.revision, "ready");
  }
  const ended = (host: Host, taskId: string, attemptId: string, what = "the run to end") =>
    waitFor(async () => {
      const view = await host.taskAttempt(taskId, attemptId);
      return view.status !== "submitting" && view.status !== "running" ? view : null;
    }, what, 60_000);
  /** A ready task's run to its end on the stand-ins. */
  async function ranTask(host: Host, projectId: string, taskId?: string) {
    const id = taskId ?? (await readyTask(host, projectId)).summary.id;
    const preview = await host.previewTaskRun(id);
    assert.equal(preview.blocked, null);
    const started = await host.startTaskRun(id, preview.expected, preview.snapshotFingerprint!);
    return { taskId: id, attemptId: started.id, done: await ended(host, id, started.id) };
  }
  /** A gated engine standing in for the project's: task runs proposing `GATED_HASH`, verified, and applies it records. */
  async function gatedHost() {
    const made = makeHost({ wslEntry: GATED, projects: [{ targetId: "wsl:Test", path: "/nowhere/gated" }] });
    made.keys.current = SECRETS;
    await made.host.setSharing(made.ids[0]!, true);
    await made.host.setCloudExecution(made.ids[0]!, true);
    const home = join(made.root, "wsl home");
    mkdirSync(home, { recursive: true });
    for (const flag of ["accept", "release", "task-report"]) writeFileSync(join(home, flag), "");
    const calls = () => (existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
    return { ...made, home, calls };
  }
  /** A gated task run to its end: the start bound to a snapshot fingerprint the test gives, as the window would. */
  async function gatedRun(host: Host, projectId: string, title = "Greet the world") {
    const task = await readyTask(host, projectId, title);
    const view = host.task(task.summary.id);
    const packet = (taskBriefOf(view.brief.content) as { brief: TaskBrief }).brief;
    const snapshot = "c".repeat(64);
    const expected = taskRunFingerprint({ taskId: task.summary.id, briefId: view.brief.id, briefVersion: view.brief.version, briefDigest: await taskBriefDigest(packet), projectId, targetId: "wsl:Test", sharing: { modelContext: true, cloudExecution: true }, snapshot });
    const started = await host.startTaskRun(task.summary.id, expected, snapshot);
    return { taskId: task.summary.id, attemptId: started.id, done: await ended(host, task.summary.id, started.id) };
  }

  it("applies a verified change approved by its hash on its run's engine: written unstaged, accepted, the task completed and the original kept", async () => {
    const { host, ids, repo } = await applyHost();
    const { taskId, attemptId, done } = await ranTask(host, ids[0]!);
    assert.deepEqual([done.status, done.report?.verified, done.actions, done.decision, done.apply], ["answered", true, ["approve", "reject", "revise"], null, null]);
    const waiting = host.task(taskId);
    assert.deepEqual([waiting.summary.state, waiting.runBlocked], ["review", DECIDE]);
    // Another hash than the one shown is refused, and nothing is recorded.
    await assert.rejects(host.approveTaskChange(taskId, attemptId, "0".repeat(64)), /^Error: This isn't the change you were shown/);
    assert.equal((await host.taskAttempt(taskId, attemptId)).decision, null);
    const approved = await host.approveTaskChange(taskId, attemptId, done.proposal!.hash);
    assert.deepEqual([approved.decision, approved.apply?.status, approved.apply?.paths.map((one) => `${one.path} ${one.place}`), approved.apply?.unresolved, approved.actions], ["approved", "applied", ["greet.sh post"], null, ["accept"]]);
    assert.match(readFileSync(join(repo, "greet.sh"), "utf8"), /\$\{1:-world\}/);
    assert.deepEqual([git(repo, ["diff", "--cached", "--name-only"]), git(repo, ["status", "--porcelain"])], ["", " M greet.sh\n"]);
    const recovery = join(repo, ".git", approved.apply!.recovery!);
    assert.equal(existsSync(recovery), true);
    assert.deepEqual([host.task(taskId).summary.state, host.task(taskId).runBlocked], ["review", "Settle the last run's change first: accept it, keep or restore what was applied, or dismiss it."]);
    await assert.rejects(host.approveTaskChange(taskId, attemptId, done.proposal!.hash), /A decision on this change is already recorded/);
    const accepted = await host.settleTaskChange(taskId, attemptId, "accepted");
    assert.deepEqual([accepted.apply?.resolution, accepted.acceptedAt !== null, accepted.actions, host.task(taskId).summary.state], ["accepted", true, [], "completed"]);
    // Every copy stays in the recovery folder, the original among them, in case a program that had it open saves into it.
    assert.deepEqual([readdirSync(recovery).sort(), git(repo, ["status", "--porcelain"])], [["new-0", "orig-0"], " M greet.sh\n"]);
  });

  it("rejects a change without sending anything, and asks for a revision in a new brief version that the next run takes", async () => {
    const { host, ids, repo } = await applyHost();
    const first = await ranTask(host, ids[0]!);
    const before = folderState(repo);
    const rejected = await host.rejectTaskChange(first.taskId, first.attemptId);
    assert.deepEqual([rejected.decision, rejected.apply, rejected.actions], ["rejected", null, []]);
    assert.deepEqual([changedSince(before, repo), existsSync(join(repo, ".git", "nivra-apply"))], [[], false]);
    assert.deepEqual([host.task(first.taskId).summary.state, host.task(first.taskId).runBlocked], ["ready", null]);
    // The next run, the person's, and a revision asked of it: an empty note is refused, and a note goes into the brief.
    const second = await ranTask(host, ids[0]!, first.taskId);
    await assert.rejects(host.requestTaskRevision(first.taskId, second.attemptId, "   "), /^Error: Write what the next run should do differently/);
    const revised = await host.requestTaskRevision(first.taskId, second.attemptId, "  Keep the greeting in one printf.  ");
    assert.deepEqual([revised.decision, revised.revisionNote, revised.actions], ["revision", "Keep the greeting in one printf.", []]);
    const task = host.task(first.taskId);
    assert.deepEqual([task.brief.version, task.brief.content.context, task.runBlocked, task.summary.state], [2, "Keep the greeting in one printf.", null, "ready"]);
    // A note holding a saved key is refused before anything is recorded.
    const third = await ranTask(host, ids[0]!, first.taskId);
    await assert.rejects(host.requestTaskRevision(first.taskId, third.attemptId, `Use ${KEY} there.`), /note/);
    assert.equal((await host.taskAttempt(first.taskId, third.attemptId)).decision, null);
    assert.deepEqual(changedSince(before, repo), []);
  });

  it("won't approve a change not every case passed; shows the engine's refusal of an apply whose checkout was edited, and lets it be decided on again once dismissed", async () => {
    const wrong = await applyHost(WRONG);
    const unverified = await ranTask(wrong.host, wrong.ids[0]!);
    assert.deepEqual([unverified.done.report?.verified, unverified.done.actions], [false, ["reject", "revise"]]);
    await assert.rejects(wrong.host.approveTaskChange(unverified.taskId, unverified.attemptId, unverified.done.proposal!.hash), /^Error: Not every acceptance case was shown to pass/);

    const { host, ids, repo } = await applyHost();
    const { taskId, attemptId, done } = await ranTask(host, ids[0]!);
    writeFileSync(join(repo, "greet.sh"), "edited by hand\n");
    const refused = await host.approveTaskChange(taskId, attemptId, done.proposal!.hash);
    assert.deepEqual([refused.decision, refused.apply?.status, refused.apply?.refusal?.code, refused.actions], ["approved", "refused", "uncommitted", ["dismiss"]]);
    assert.match(refused.apply!.refusal!.message, /^Your checkout has uncommitted changes/);
    assert.deepEqual([readFileSync(join(repo, "greet.sh"), "utf8"), host.task(taskId).summary.state], ["edited by hand\n", "review"]);
    git(repo, ["checkout", "--", "greet.sh"]);
    const dismissed = await host.settleTaskChange(taskId, attemptId, "dismissed");
    assert.deepEqual([dismissed.decision, dismissed.apply?.resolution, dismissed.actions], [null, "dismissed", ["approve", "reject", "revise"]]);
    const again = await host.approveTaskChange(taskId, attemptId, done.proposal!.hash);
    assert.deepEqual([again.apply?.status, again.actions], ["applied", ["accept"]]);
    assert.match(readFileSync(join(repo, "greet.sh"), "utf8"), /\$\{1:-world\}/);
  });

  it("asks for an apply whose answer was lost by its request id, never sending it again; one its engine never recorded can be approved again", async () => {
    const { host, ids, home, calls } = await gatedHost();
    const { taskId, attemptId, done } = await gatedRun(host, ids[0]!);
    assert.deepEqual([done.status, done.report?.verified, done.actions], ["answered", true, ["approve", "reject", "revise"]]);
    // The engine applied it, and its answer was an error: found by the request id.
    writeFileSync(join(home, "error-apply"), "");
    await host.approveTaskChange(taskId, attemptId, GATED_HASH);
    const found = await waitFor(async () => {
      const view = await host.taskAttempt(taskId, attemptId);
      return view.apply?.status === "applied" ? view : null;
    }, "the apply to be found by its request id");
    assert.deepEqual([found.actions, calls().filter((call) => call === "task.apply").length, calls().includes("task.applyStatus")], [["accept"], 1, true]);

    // Another run whose approval the engine turned down before recording anything: its words are shown, and the change
    // can be approved again.
    await host.settleTaskChange(taskId, attemptId, "accepted");
    rmSync(join(home, "error-apply"));
    writeFileSync(join(home, "refuse-apply"), "");
    const second = await gatedRun(host, ids[0]!, "Greet again");
    await host.approveTaskChange(second.taskId, second.attemptId, GATED_HASH);
    const withdrawn = await waitFor(async () => {
      const view = await host.taskAttempt(second.taskId, second.attemptId);
      return view.decision === null && view.apply?.unresolved ? view : null;
    }, "the approval to be taken back");
    assert.match(withdrawn.apply!.unresolved!, /^The engine didn't apply the change, so nothing was written: This engine has no proposal for that run/);
    assert.deepEqual([withdrawn.apply?.status, withdrawn.actions, calls().filter((call) => call === "task.apply").length], [null, ["approve", "reject", "revise"], 2]);
  });

  it("reads an apply back after a restart by its request id, and never sends it again", async () => {
    const { host, ids, home, root, calls } = await gatedHost();
    const { taskId, attemptId } = await gatedRun(host, ids[0]!);
    // The answer is held, and Nivra stops while the apply is out.
    writeFileSync(join(home, "hold-apply"), "");
    const out = host.approveTaskChange(taskId, attemptId, GATED_HASH).catch(() => null);
    await waitFor(() => calls().includes("task.apply"), "the apply to reach the engine");
    await host.shutdown();
    await out;
    rmSync(join(home, "hold-apply"));
    const again = hostAt(root, { wslEntry: GATED });
    again.keys.current = SECRETS;
    const read = await waitFor(async () => {
      const view = await again.host.taskAttempt(taskId, attemptId);
      return view.apply?.status === "applied" ? view : null;
    }, "the apply to be read back after the restart");
    assert.deepEqual([read.decision, read.actions, calls().filter((call) => call === "task.apply").length], ["approved", ["accept"], 1]);
  });

  it("reads a settle back by its request id when its answer is lost, never leaving the run stuck: accepted once, the task completed", async () => {
    const { host, ids, home, calls } = await gatedHost();
    const { taskId, attemptId } = await gatedRun(host, ids[0]!);
    const applied = await host.approveTaskChange(taskId, attemptId, GATED_HASH);
    assert.deepEqual([applied.apply?.status, applied.actions], ["applied", ["accept"]]);
    // The engine accepts it, then its answer is an error: nothing is offered while Nivra reads it back.
    writeFileSync(join(home, "error-settle"), "");
    const lost = await host.settleTaskChange(taskId, attemptId, "accepted");
    assert.deepEqual([lost.actions, lost.apply?.unresolved], [[], "Nivra didn't hear back from the engine about settling this change, so it is asking how that went."]);
    const settled = await waitFor(async () => {
      const view = await host.taskAttempt(taskId, attemptId);
      return view.apply?.resolution === "accepted" && view.apply.unresolved === null ? view : null;
    }, "the settle to be read back");
    assert.deepEqual([settled.actions, settled.acceptedAt !== null, host.task(taskId).summary.state, calls().filter((call) => call === "task.dismiss").length], [[], true, "completed", 1]);
    rmSync(join(home, "error-settle"));
    // Settled, the task can go.
    host.deleteTask(taskId);
  });

  it("reads a settle back after a restart once its engine is online, and never sends it again: accepted, the task completed", async () => {
    const { host, ids, home, root, calls } = await gatedHost();
    const { taskId, attemptId } = await gatedRun(host, ids[0]!);
    await host.approveTaskChange(taskId, attemptId, GATED_HASH);
    // The engine records the acceptance and holds its answer, and Nivra stops meanwhile.
    writeFileSync(join(home, "hold-settle"), "");
    const out = host.settleTaskChange(taskId, attemptId, "accepted").catch(() => null);
    await waitFor(() => calls().includes("task.dismiss"), "the settle to reach the engine");
    await host.shutdown();
    await out;
    rmSync(join(home, "hold-settle"));
    const again = hostAt(root, { wslEntry: GATED });
    again.keys.current = SECRETS;
    // Before its engine is online, the saved settling holds the task, and nothing about the change is offered.
    const waiting = again.host.task(taskId);
    assert.deepEqual([waiting.summary.state, waiting.runBlocked], ["active", "The last run's change is being applied or settled. Wait for it to finish, then try again."]);
    await assert.rejects(again.host.reviseBrief(taskId, waiting.revision, { ...FIELDS, context: "More." }), /^Error: This task's change is still being applied or settled, so its brief can't change/);
    // Its engine coming online is enough: nothing asks for the run.
    await again.host.open(ids[0]!);
    await waitFor(() => again.host.task(taskId).summary.state === "completed", "the settle to be read back after the restart");
    const read = await again.host.taskAttempt(taskId, attemptId);
    assert.deepEqual(
      [read.apply?.resolution, read.apply?.unresolved, read.acceptedAt !== null, read.acceptNote, read.actions, calls().filter((call) => call === "task.dismiss").length],
      ["accepted", null, true, null, [], 1],
    );
  });

  it("reads an unsettled apply again whenever its engine comes online, so one settled elsewhere meanwhile is followed", async () => {
    const { host, ids, home, calls } = await gatedHost();
    const { taskId, attemptId } = await gatedRun(host, ids[0]!);
    const applied = await host.approveTaskChange(taskId, attemptId, GATED_HASH);
    assert.deepEqual([applied.apply?.status, applied.actions], ["applied", ["accept"]]);
    // The engine dismisses it without this Nivra hearing of it, as another tool could, and then restarts.
    const log = join(home, "applies.log");
    writeFileSync(log, readFileSync(log, "utf8").replace('"resolution":null', '"resolution":"dismissed"'));
    await host.restart(ids[0]!);
    await waitFor(() => host.task(taskId).attempts[0]?.apply?.resolution === "dismissed", "the apply to be read again");
    const read = await host.taskAttempt(taskId, attemptId);
    assert.deepEqual([read.decision, read.apply?.resolution, read.actions, calls().filter((call) => call === "task.dismiss").length], [null, "dismissed", ["approve", "reject", "revise"], 0]);
  });

  it("refuses changing a task's brief, or moving it to another repository, while its change isn't settled", async () => {
    const { host, ids } = await gatedHost();
    const { taskId, attemptId } = await gatedRun(host, ids[0]!);
    const applied = await host.approveTaskChange(taskId, attemptId, GATED_HASH);
    assert.deepEqual([applied.apply?.status, applied.actions], ["applied", ["accept"]]);
    // Applied and not yet accepted: the brief it ran stays the task's, and so does its repository.
    const task = host.task(taskId);
    await assert.rejects(
      host.reviseBrief(taskId, task.revision, { ...FIELDS, context: "More." }),
      /^Error: This task's change needs settling first, so its brief can't change: accept it, keep or restore what was applied, or dismiss it\. Then try again\.$/,
    );
    assert.throws(() => host.setTaskProject(taskId, task.revision, null), /^Error: This task's change needs settling first, so it can't move to another repository: accept it/);
    const accepted = await host.settleTaskChange(taskId, attemptId, "accepted");
    const after = host.task(taskId);
    assert.deepEqual([accepted.apply?.resolution, accepted.acceptNote, after.summary.state, after.brief.version, after.summary.projectId], ["accepted", null, "completed", 1, ids[0]]);
  });

  it("settles a change made for an older brief when it is accepted, but doesn't complete the task, and says why", async () => {
    const { host, ids } = await gatedHost();
    const { taskId, attemptId } = await gatedRun(host, ids[0]!);
    // The brief moves on while the run waits on a decision; then the older run's change is approved and accepted.
    await host.reviseBrief(taskId, host.task(taskId).revision, { ...FIELDS, context: "Greet in French too." });
    assert.equal(host.task(taskId).brief.version, 2);
    const applied = await host.approveTaskChange(taskId, attemptId, GATED_HASH);
    assert.deepEqual([applied.apply?.status, applied.actions], ["applied", ["accept"]]);
    const accepted = await host.settleTaskChange(taskId, attemptId, "accepted");
    assert.deepEqual(
      [accepted.apply?.resolution, accepted.acceptedAt !== null, accepted.actions, accepted.acceptNote],
      ["accepted", true, [], "The task isn't completed: its brief changed after this run. Run it on the new brief, or complete the task yourself."],
    );
    const after = host.task(taskId);
    assert.deepEqual([after.summary.state, after.runBlocked, after.attempts[0]?.acceptedAt !== null], ["ready", null, true]);
  });

  it("doesn't offer keeping a partial apply as it is while a file is moved aside, and refuses deleting a task whose applied change isn't settled", async () => {
    const { host, ids, home } = await gatedHost();
    writeFileSync(join(home, "partial-apply"), "");
    writeFileSync(join(home, "aside-apply"), "");
    const first = await gatedRun(host, ids[0]!);
    const partial = await host.approveTaskChange(first.taskId, first.attemptId, GATED_HASH);
    assert.deepEqual([partial.apply?.status, partial.apply?.paths.map((one) => `${one.path} ${one.place}`), partial.actions], ["partial", ["greet.sh post", "README.md aside"], ["restore"]]);
    await assert.rejects(host.settleTaskChange(first.taskId, first.attemptId, "kept"), /^Error: A file the change replaces is missing from your checkout, its original kept aside/);
    const restored = await host.restoreTaskChange(first.taskId, first.attemptId);
    assert.deepEqual([restored.apply?.status, restored.actions], ["not-applied", ["dismiss"]]);
    // Not applied, and not yet dismissed: the engine keeps a record of it, so the task stays until it is settled.
    assert.throws(() => host.deleteTask(first.taskId), /^Error: Settle this task's change first/);
    await host.settleTaskChange(first.taskId, first.attemptId, "dismissed");
    host.deleteTask(first.taskId);

    rmSync(join(home, "partial-apply"));
    rmSync(join(home, "aside-apply"));
    const second = await gatedRun(host, ids[0]!, "Greet again");
    await host.approveTaskChange(second.taskId, second.attemptId, GATED_HASH);
    assert.throws(() => host.deleteTask(second.taskId), /^Error: Settle this task's change first/);
    await host.settleTaskChange(second.taskId, second.attemptId, "accepted");
    host.deleteTask(second.taskId);
  });

  it("keeps a partial apply as it is, or restores its originals and then dismisses it, and refuses deleting or revising its task meanwhile", async () => {
    const { host, ids, home } = await gatedHost();
    writeFileSync(join(home, "partial-apply"), "");
    const first = await gatedRun(host, ids[0]!);
    const partial = await host.approveTaskChange(first.taskId, first.attemptId, GATED_HASH);
    assert.deepEqual([partial.apply?.status, partial.actions, host.task(first.taskId).summary.state], ["partial", ["restore", "keep"], "review"]);
    assert.throws(() => host.deleteTask(first.taskId), /^Error: This task's change is being applied, or what was applied needs settling/);
    const task = host.task(first.taskId);
    await assert.rejects(host.reviseBrief(first.taskId, task.revision, { ...FIELDS, context: "More." }), /needs settling/);
    await assert.rejects(host.settleTaskChange(first.taskId, first.attemptId, "accepted"), /Only a change that was applied can be accepted/);
    const kept = await host.settleTaskChange(first.taskId, first.attemptId, "kept");
    assert.deepEqual([kept.apply?.resolution, kept.actions, host.task(first.taskId).summary.state, host.task(first.taskId).runBlocked], ["kept", [], "ready", null]);

    const second = await gatedRun(host, ids[0]!, "Greet again");
    await host.approveTaskChange(second.taskId, second.attemptId, GATED_HASH);
    const restored = await host.restoreTaskChange(second.taskId, second.attemptId);
    assert.deepEqual([restored.apply?.status, restored.apply?.paths.map((one) => one.place), restored.actions], ["not-applied", ["pre"], ["dismiss"]]);
    const dismissed = await host.settleTaskChange(second.taskId, second.attemptId, "dismissed");
    assert.deepEqual([dismissed.decision, dismissed.actions], [null, ["approve", "reject", "revise"]]);
    host.deleteTask(second.taskId);
  });
});

describe("Host: a project's environment, prepared in Nebius from its own recipe and bound to its task runs (D41, NIV-55)", () => {
  const KEY = "test-key-0123456789";
  const PROJECT_ID = "project-e00hostenviron01";
  const SECRETS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };
  const CHOICES = {};
  const UPLOADS_OFF = "This project doesn't allow uploading to Nebius Sandboxes, where its environment is prepared. Allow uploads for it, then prepare the environment again.";
  const KEYS_MISSING = "Preparing an environment needs your Nebius key and project id, and they aren't both set. Add them in Settings, then prepare it again.";
  const NATIVE = "Preparing an environment on Windows itself isn't available yet. Add the repository from a WSL distribution, then prepare it there.";
  const CHANGED = "What preparing this environment would send has changed since you previewed it. Check the new preview, then prepare it again.";
  const GOING = "This project's environment is being prepared. Wait for it to end, or cancel it, then prepare it again.";
  const LEGACY = "Prepared by an earlier version of Nivra. Prepare it again to use it.";
  const BUILDS_MISSING = "Some dependency builds didn't run when this environment was prepared, so task runs won't start from it yet. Change the project's build policy and prepare it again, or accept the environment without them.";
  const lines = (home: string, file: string) => (existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").split("\n").filter(Boolean) : []);
  const calls = (home: string, method: string) => lines(home, "calls.log").filter((call) => call === method).length;
  /** A `<id> <json>` log line's JSON. */
  const after_ = (line: string) => JSON.parse(line.slice(line.indexOf(" ") + 1));
  const closing: Array<{ close(): Promise<void> }> = [];
  after(async () => {
    await Promise.all(closing.map((stub) => stub.close()));
  });

  /** A host whose one project is a WSL repository on the gated engine, uploads allowed and the keys saved, with its flags. */
  async function gatedHost(flags: string[] = ["accept", "release"]) {
    const made = makeHost({ wslEntry: GATED, projects: [{ targetId: "wsl:Test", path: "/nowhere/gated" }] });
    made.keys.current = SECRETS;
    await made.host.setCloudExecution(made.ids[0]!, true);
    const home = join(made.root, "wsl home");
    mkdirSync(home, { recursive: true });
    for (const flag of flags) writeFileSync(join(home, flag), "");
    return { ...made, home };
  }
  const fingerprintOf = async (host: Host, projectId: string, choices = CHOICES) => {
    const preview = await host.resolveEnvironment(projectId, choices);
    assert.equal(preview.status, "ready", JSON.stringify(preview).slice(0, 300));
    return preview.status === "ready" ? preview.fingerprint : "";
  };
  const ended = (host: Host, projectId: string, what = "the preparation to end") =>
    waitFor(
      async () => {
        const view = await host.environment(projectId);
        const status = view.preparation?.status;
        return status && status !== "submitting" && status !== "running" ? view : null;
      },
      what,
      30_000,
    );
  const going = (host: Host, projectId: string) =>
    waitFor(async () => {
      const view = await host.environment(projectId);
      return view.preparation?.status === "running" && view.preparation.runId ? view : null;
    }, "the preparation to be going");
  const imageOf = (view: { prepared: { verified: { images: { prepared: string } } } | null }) => view.prepared?.verified.images.prepared;

  it("refuses a preparation while uploads are off, without both keys, or on Windows itself, before any engine starts, and the view says why", async () => {
    const { host, ids, keys } = makeHost({ wslEntry: GATED, projects: [{ targetId: "wsl:Test", path: "/nowhere/gated" }, { targetId: "local", path: "/nowhere/native" }] });
    const [linux, native] = [ids[0]!, ids[1]!];
    const fingerprint = "e".repeat(64);
    await assert.rejects(host.prepareEnvironment(linux, CHOICES, fingerprint), { message: UPLOADS_OFF });
    await host.setCloudExecution(linux, true);
    await assert.rejects(host.prepareEnvironment(linux, CHOICES, fingerprint), { message: KEYS_MISSING });
    keys.current = { NEBIUS_API_KEY: KEY };
    await assert.rejects(host.prepareEnvironment(linux, CHOICES, fingerprint), { message: KEYS_MISSING });
    const waiting = await host.environment(linux);
    assert.deepEqual([waiting.choices, waiting.prepared, waiting.ready, waiting.legacy, waiting.preparation, waiting.blocked, waiting.notice], [null, null, false, false, null, KEYS_MISSING, null]);
    keys.current = SECRETS;
    assert.equal((await host.environment(linux)).blocked, null);
    // A folder on Windows itself: refused whatever else holds.
    await host.setCloudExecution(native, true);
    await assert.rejects(host.prepareEnvironment(native, CHOICES, fingerprint), { message: NATIVE });
    assert.equal((await host.environment(native)).blocked, NATIVE);
    // Choices the domain wouldn't take are refused in words, before any engine starts.
    const WRONG = /^Error: Those choices can't be sent as they are: a version is exact, such as 24\.21\.0, and an option is one the preview offers\. Preview the environment again\.$/;
    await assert.rejects(host.prepareEnvironment(linux, { runtime: "24; rm -rf /" }, fingerprint), WRONG);
    await assert.rejects(host.resolveEnvironment(linux, { runtime: "latest" }), WRONG);
    assert.deepEqual([stateOf(host, "wsl:Test")?.status, stateOf(host, "local")?.status], ["stopped", "stopped"]);
  });

  it("prepares on the project's own engine exactly the recipe its preview showed, refuses a start whose preview changed, keeps the environment only when it ends prepared, and keeps its versions for the next resolution", async () => {
    const { host, ids, home, keys } = await gatedHost();
    const id = ids[0]!;
    const fingerprint = await fingerprintOf(host, id);
    assert.deepEqual(JSON.parse(lines(home, "env-resolves.log")[0]!), { repoPath: "/nowhere/gated", choices: CHOICES, previous: null }, "the recipe was resolved on the project's own engine, with nothing kept from before");
    // The commit changed after the preview, or another version was chosen: what it would send isn't what was shown.
    writeFileSync(join(home, "env-changed"), "");
    await assert.rejects(host.prepareEnvironment(id, CHOICES, fingerprint), { message: CHANGED });
    rmSync(join(home, "env-changed"));
    await assert.rejects(host.prepareEnvironment(id, { runtime: "22.23.4" }, fingerprint), { message: CHANGED });
    assert.deepEqual([calls(home, "runs.start"), (await host.environment(id)).choices], [0, null], "nothing was sent, and no choices were kept");
    // An install that fails keeps no environment, even one its report holds.
    writeFileSync(join(home, "environment-outcome"), "failed");
    writeFileSync(join(home, "environment-prepared-anyway"), "");
    const started = await host.prepareEnvironment(id, CHOICES, fingerprint);
    assert.deepEqual([started.choices, started.preparation?.choices, started.blocked], [CHOICES, CHOICES, GOING]);
    const failed = await ended(host, id);
    assert.deepEqual([failed.preparation?.status, failed.preparation?.report?.outcome, failed.preparation?.report?.stopped?.code, failed.prepared, failed.blocked], ["failed", "failed", "install", null, null]);
    assert.match(failed.preparation?.report?.install?.logTail ?? "", /ERR_PNPM_OUTDATED_LOCKFILE/);
    // A run that succeeded with a report that isn't prepared keeps none either.
    writeFileSync(join(home, "environment-run-succeeds"), "");
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    const unprepared = await ended(host, id);
    assert.deepEqual([unprepared.preparation?.status, unprepared.preparation?.report?.outcome, unprepared.prepared], ["answered", "failed", null]);
    // Prepared: kept, bound to what was sent, and ready, every build having run.
    rmSync(join(home, "environment-outcome"));
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    const prepared = await ended(host, id);
    const runId = prepared.preparation!.runId!;
    assert.deepEqual([prepared.preparation?.status, imageOf(prepared), prepared.ready, prepared.legacy, prepared.blocked, prepared.notice], ["answered", `image-${runId.slice(0, 8)}`, true, false, null, null]);
    const sent = after_(lines(home, "environments.log").at(-1)!);
    assert.deepEqual([sent.clientRequestId, sent.input, sent.context], [prepared.preparation?.id, { repoPath: "/nowhere/gated", project: id, target: "wsl:Test", preview: fingerprint }, { sharing: { cloudExecution: true }, choices: CHOICES, previous: null }]);
    // The next resolution keeps the versions this one settled on, none of them chosen.
    await fingerprintOf(host, id);
    assert.deepEqual(JSON.parse(lines(home, "env-resolves.log").at(-1)!).previous, { configuration: "2".repeat(64), runtime: "24.21.0", manager: "pnpm", managerVersion: "11.5.3", chosen: { runtime: false, managerVersion: false } });
    // Made in one Nebius project, it can't be used from another: the view says so.
    keys.current = { ...SECRETS, NEBIUS_PROJECT_ID: "project-e00another00001" };
    assert.match((await host.environment(id)).notice ?? "", /^This environment was prepared in another Nebius project than the one in Settings/);
    keys.current = SECRETS;
    // A later preparation that fails leaves the prepared one as it was.
    writeFileSync(join(home, "environment-outcome"), "failed");
    rmSync(join(home, "environment-run-succeeds"));
    await host.prepareEnvironment(id, CHOICES, await fingerprintOf(host, id));
    const kept = await ended(host, id);
    assert.deepEqual([kept.preparation?.status, imageOf(kept), calls(home, "runs.start")], ["failed", `image-${runId.slice(0, 8)}`, 4]);
  });

  it("reads a preparation back after a restart by its request and run ids, keeps what it prepared, and sends nothing again", async () => {
    const { host, ids, home, root } = await gatedHost(["accept", "release", "running"]);
    const id = ids[0]!;
    await host.prepareEnvironment(id, CHOICES, await fingerprintOf(host, id));
    const before = await going(host, id);
    assert.deepEqual([before.preparation?.report?.outcome, before.blocked, before.prepared], ["in-progress", GOING, null]);
    // Nivra quits while it goes; its engine goes with it, and its records stay.
    await host.shutdown();
    rmSync(join(home, "running"));
    const again = hostAt(root, { wslEntry: GATED });
    again.keys.current = SECRETS;
    const read = await ended(again.host, id, "the preparation to be read back");
    const runId = before.preparation!.runId!;
    assert.deepEqual([read.choices, read.preparation?.id, read.preparation?.runId, read.preparation?.status, imageOf(read)], [CHOICES, before.preparation?.id, runId, "answered", `image-${runId.slice(0, 8)}`]);
    assert.equal(calls(home, "runs.start"), 1);
  });

  it("finds a preparation whose start's answer was lost by its request id and sends it once; one its engine never recorded wasn't sent, in its own words", async () => {
    const { host, ids, home } = await gatedHost(["accept", "release", "error-start"]);
    const id = ids[0]!;
    const fingerprint = await fingerprintOf(host, id);
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    const found = await ended(host, id, "the lost preparation to be found");
    assert.deepEqual([found.preparation?.status, found.preparation?.runId === lines(home, "accepted.log")[0]?.split(" ")[1], found.ready, calls(home, "runs.start")], ["answered", true, true, 1]);
    rmSync(join(home, "accept"));
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    const notSent = await ended(host, id, "the refused preparation to settle");
    assert.deepEqual([notSent.preparation?.status, notSent.preparation?.note, imageOf(notSent)], ["not-sent", "The engine didn't start the preparation, so nothing was uploaded. The engine refused the run.", imageOf(found)]);
  });

  it("stops a preparation under way when uploads are turned off and says so, says when it couldn't, and stops one when its project is removed", async () => {
    const { host, ids, home } = await gatedHost(["accept", "release", "running"]);
    const id = ids[0]!;
    const fingerprint = await fingerprintOf(host, id);
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    const first = (await going(host, id)).preparation!;
    await host.setCloudExecution(id, false);
    const stopped = await ended(host, id, "the preparation to stop");
    assert.deepEqual(
      [stopped.preparation?.status, stopped.preparation?.note, stopped.preparation?.report?.outcome, lines(home, "cancelled.log")],
      ["cancelled", "Stopped: uploads for this project were turned off. What it had sent stays with Nebius; its report says what that was.", "cancelled", [first.runId]],
    );
    // A stop its engine turns down is reported, never passed over, and a later cancel reaches it.
    await host.setCloudExecution(id, true);
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    const second = (await going(host, id)).preparation!;
    writeFileSync(join(home, "fail-cancel"), "");
    await assert.rejects(host.setCloudExecution(id, false), {
      message: "Uploads for this project are off, but Nivra couldn't stop the preparation of its environment (the run couldn't be stopped). Restart the project's engine to stop it.",
    });
    const left = await host.environment(id);
    assert.deepEqual([left.preparation?.status, left.preparation?.cancelRequested, host.projects()[0]?.sharing.cloudExecution], ["running", false, false]);
    await assert.rejects(host.cancelPreparation(id), { message: "Nivra couldn't stop the preparation (the run couldn't be stopped). Restart the project's engine to stop it." });
    rmSync(join(home, "fail-cancel"));
    await host.cancelPreparation(id);
    const cancelled = await ended(host, id, "the second preparation to stop");
    assert.deepEqual([cancelled.preparation?.status, cancelled.preparation?.note], ["cancelled", "Cancelled. What it had sent stays with Nebius; its report says what that was."]);
    await assert.rejects(host.cancelPreparation(id), { message: "No preparation of this project's environment is going." });
    // Removing the project stops its preparation too.
    await host.setCloudExecution(id, true);
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    const third = (await going(host, id)).preparation!;
    await host.removeProject(id);
    assert.deepEqual([host.projects().length, lines(home, "cancelled.log")], [0, [first.runId, second.runId, third.runId]]);
  });

  it("stops a preparation whose uploads were turned off while its start was out, as soon as its engine answers", async () => {
    const { host, ids, home } = await gatedHost(["accept"]);
    const id = ids[0]!;
    const fingerprint = await fingerprintOf(host, id);
    await host.prepareEnvironment(id, CHOICES, fingerprint);
    await waitFor(() => calls(home, "runs.start") === 1, "the preparation's request to reach the engine");
    await host.setCloudExecution(id, false);
    writeFileSync(join(home, "release"), "");
    const runId = lines(home, "accepted.log")[0]?.split(" ")[1];
    const stopped = await ended(host, id, "the preparation to stop");
    assert.deepEqual(
      [stopped.preparation?.runId === runId, stopped.preparation?.status, stopped.preparation?.note, lines(home, "cancelled.log"), stopped.prepared],
      [true, "cancelled", "Stopped: uploads for this project were turned off. What it had sent stays with Nebius; its report says what that was.", [runId], null],
    );
  });

  it("asks for the person's choice when the project's declarations conflict, and refuses what it can't prepare, in the engine's words", async () => {
    const { host, ids, home } = await gatedHost();
    const id = ids[0]!;
    writeFileSync(join(home, "env-needs-choice"), "");
    const asked = await host.resolveEnvironment(id, CHOICES);
    assert.deepEqual([asked.status, asked.status === "needs-choice" ? asked.choices.map((choice) => [choice.id, choice.options.map((option) => option.value)]) : null], ["needs-choice", [["runtime", ["24.21.0", "22.23.4"]]]]);
    // Choosing one makes the recipe ready, on the Node chosen.
    const chosen = await host.resolveEnvironment(id, { runtime: "22.23.4" });
    assert.deepEqual([chosen.status, chosen.status === "ready" ? chosen.recipe.image.tag : null], ["ready", "node:22.23.4-alpine"]);
    writeFileSync(join(home, "env-refused"), "");
    const refused = await host.resolveEnvironment(id, CHOICES);
    assert.deepEqual([refused.status, refused.status === "refused" ? refused.code : null], ["refused", "unsupported-manager"]);
    assert.equal(calls(home, "runs.start"), 0);
  });

  it("binds a task run to the prepared environment: its preview carries it to the engine, its start sends it, and its fingerprint is v1 without one and v3 with a recipe's", async () => {
    const { host, ids, home } = await gatedHost(["accept", "release", "task-report"]);
    const id = ids[0]!;
    await host.setSharing(id, true);
    const CASE = { name: "greet with and without a name", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 };
    const REPRODUCED = { name: "greet with no name says Hello, and nothing more", command: ". ./greet.sh; greet Ada; greet", expectedExitCode: 0, expectedOutput: "Hello, Ada\nHello, \n" };
    const fields = { goal: "greet with no name says Hello, world", acceptanceCriteria: ["check.sh passes"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [CASE], baseline: [REPRODUCED], frozen: ["check.sh"] };
    const created = await host.createTask({ title: "Greet the world", fields, projectId: id, planId: null });
    const task = host.setTaskState(created.summary.id, created.revision, "ready");
    const packet = (taskBriefOf(task.brief.content) as { brief: TaskBrief }).brief;
    const parts = { taskId: task.summary.id, briefId: task.brief.id, briefVersion: task.brief.version, briefDigest: await taskBriefDigest(packet), projectId: id, targetId: "wsl:Test", sharing: { modelContext: true, cloudExecution: true }, snapshot: "c".repeat(64) };
    const asked = () => JSON.parse(lines(home, "task-previews.log").at(-1)!) as { environment?: unknown; brief: TaskBrief };
    // No environment yet: the run would start from Nivra's own image, bound as before.
    const plain = await host.previewTaskRun(task.summary.id);
    assert.deepEqual([plain.blocked, plain.environment, plain.expected, "environment" in asked()], [null, null, taskRunFingerprint(parts), false]);
    assert.deepEqual(
      [plain.baseline, plain.frozen, plain.limits?.baselineChecks, asked().brief.baseline, asked().brief.frozen],
      [[{ number: 1, ...REPRODUCED }], [{ path: "check.sh", sha256: createHash("sha256").update("check.sh").digest("hex") }], 1, [REPRODUCED], ["check.sh"]],
    );
    // Prepared: the preview carries it to the engine, which checks it, and the run is bound to it.
    await host.prepareEnvironment(id, CHOICES, await fingerprintOf(host, id));
    const prepared = (await ended(host, id)).prepared!;
    const ref: EnvironmentRef = {
      format: REF_FORMAT,
      recipe: prepared.recipeDigest,
      verified: prepared.verifiedDigest,
      configuration: prepared.recipe.configuration.digest,
      image: prepared.verified.images.prepared,
      projectFingerprint: prepared.projectFingerprint,
      target: "wsl:Test",
      tools: prepared.verified.tools,
      platform: { arch: "x86_64", libc: "musl" },
      env: prepared.recipe.env.task,
      dependencyFolders: ["node_modules"],
      builds: null,
      preparedAt: prepared.preparedAt,
    };
    const withIt = await host.previewTaskRun(task.summary.id);
    assert.deepEqual([withIt.blocked, asked().environment, withIt.environment, withIt.expected], [null, ref, ref, taskRunFingerprint({ ...parts, environment: ref })]);
    assert.notEqual(withIt.expected, plain.expected);
    // A preview made before it was prepared no longer starts a run; this one does, and sends it.
    await assert.rejects(host.startTaskRun(task.summary.id, plain.expected, plain.snapshotFingerprint!), /^Error: What this run would send has changed since you previewed it\. Preview it again, then start\.$/);
    const started = await host.startTaskRun(task.summary.id, withIt.expected, withIt.snapshotFingerprint!);
    await waitFor(() => lines(home, "tasks.log").length === 1, "the run to reach the engine");
    const sent = after_(lines(home, "tasks.log")[0]!);
    assert.deepEqual([sent.clientRequestId, sent.input.environment], [started.id, ref]);
  });

  it("starts no task run from an environment whose builds didn't all run until the person accepts it without them, for that environment only", async () => {
    const { host, ids, home } = await gatedHost(["accept", "release", "environment-builds-missing"]);
    const id = ids[0]!;
    await host.setSharing(id, true);
    const CASE = { name: "greet", command: ". ./greet.sh; greet Ada", expectedOutput: "Hello, Ada\n", expectedExitCode: 0 };
    const created = await host.createTask({ title: "Greet", fields: { goal: "greet", acceptanceCriteria: ["it greets"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [CASE] }, projectId: id, planId: null });
    const task = host.setTaskState(created.summary.id, created.revision, "ready");
    await host.prepareEnvironment(id, CHOICES, await fingerprintOf(host, id));
    const view = await ended(host, id);
    assert.deepEqual([view.ready, view.notice, view.prepared?.verified.builds], [false, BUILDS_MISSING, { state: "missing", missing: ["esbuild"] }]);
    // Not ready: the preview says why, and nothing reaches the engine; never a run from Nivra's own image instead.
    const blocked = await host.previewTaskRun(task.summary.id);
    assert.deepEqual([blocked.blocked, blocked.expected, lines(home, "task-previews.log").length], [BUILDS_MISSING, "", 0]);
    // An acceptance for another environment is refused; for this one, it makes the environment ready.
    await assert.rejects(host.acceptMissingBuilds(id, "0".repeat(64)), { message: "This environment was prepared again since you looked at its builds, so nothing was accepted. Look at them again." });
    const accepted = await host.acceptMissingBuilds(id, view.prepared!.verifiedDigest);
    assert.deepEqual([accepted.ready, accepted.notice, accepted.builds?.missing], [true, null, ["esbuild"]]);
    const shown = await host.previewTaskRun(task.summary.id);
    assert.deepEqual([shown.blocked, shown.environment?.builds?.missing], [null, ["esbuild"]]);
    // Prepared again: the acceptance was for the one before, and ends with it.
    await host.prepareEnvironment(id, CHOICES, await fingerprintOf(host, id));
    const again = await ended(host, id);
    assert.deepEqual([again.ready, again.builds], [false, null]);
    rmSync(join(home, "environment-builds-missing"));
    await host.prepareEnvironment(id, CHOICES, await fingerprintOf(host, id));
    await assert.rejects(host.acceptMissingBuilds(id, (await ended(host, id)).prepared!.verifiedDigest), { message: "Every dependency build ran when this environment was prepared, so there is nothing to accept." });
  });

  it("reads an environment an earlier version of Nivra prepared as one to prepare again, and starts no task run from it", async () => {
    // A workspace written before NIV-55: D41's spec and prepared environment, as its tables held them.
    const root = mkdtempSync(join(tmpdir(), "nivra host legacy "));
    dirs.push(root);
    const id = randomUUID();
    new HostStore(join(root, "nivra.json")).update((data) => ({ ...data, projects: [{ id, targetId: "wsl:Test", nativePath: "/nowhere/gated", label: "gated", addedAt: new Date().toISOString(), sharing: { ...NO_SHARING, modelContext: true, cloudExecution: true } }] }));
    const opening = openWorkspace(join(root, "workspace.db"));
    assert.equal(opening.state, "ready");
    if (opening.state !== "ready") return;
    const at = new Date().toISOString();
    const preparation = randomUUID();
    const d41 = JSON.stringify({ image: "img-d41", base: { tag: "node:22.23.4-alpine3.24", image: "img-imported", imported: true }, node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64", baseline: "a".repeat(40), inputsDigest: "b".repeat(64), spec: { filters: [] }, installArgs: ["--frozen-lockfile"], projectFingerprint: "f".repeat(64), preparedAt: at });
    opening.db.db.prepare("INSERT INTO preparations (id, project_id, session_id, target_id, status, spec_json, preview, report_json, reported_at, created_at, settled_at) VALUES (?, ?, 's', 'wsl:Test', 'answered', '{\"filters\":[]}', 'x', '{}', ?, ?, ?)").run(preparation, id, at, at, at);
    opening.db.db.prepare("INSERT INTO environments (project_id, spec_json, prepared_json, prepared_by, updated_at) VALUES (?, '{\"filters\":[]}', ?, ?, ?)").run(id, d41, preparation, at);
    opening.db.close();
    const { host, keys } = hostAt(root, { wslEntry: GATED });
    keys.current = SECRETS;
    const view = await host.environment(id);
    assert.deepEqual([view.legacy, view.prepared, view.ready, view.choices, view.notice], [true, null, false, null, LEGACY]);
    const created = await host.createTask({ title: "Greet", fields: { goal: "greet", acceptanceCriteria: ["it greets"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [{ name: "greet", command: "true", expectedOutput: "", expectedExitCode: 0 }] }, projectId: id, planId: null });
    const task = host.setTaskState(created.summary.id, created.revision, "ready");
    assert.equal((await host.previewTaskRun(task.summary.id)).blocked, LEGACY);
    await assert.rejects(host.startTaskRun(task.summary.id, "e".repeat(64), "c".repeat(64)), { message: LEGACY });
  });

  it("prepares through a real engine against the stand-in for Nebius: .npmrc stays here, the environment is kept, and task previews are bound to it until a setup file changes", async () => {
    // The stand-in's guest answers the inspect, preparation and readiness steps as an image would, and adds what an
    // install leaves: nothing is installed on this machine (the engine's own recipe test does the same).
    const guest = new RealGuest();
    const imported = mkdtempSync(join(tmpdir(), "nivra imported image "));
    dirs.push(imported);
    guest.images.set("img-imported", imported);
    const received: string[][] = [];
    const done = (stdout: string) => ({ ...succeed({ stdout }), statuses: ["SUCCESS" as const] });
    guest.intercept = ({ args, body }, folder) => {
      if (args[1] === INSPECT_SCRIPT) return done("node v24.21.0\nnpm 11.19.0\ncorepack 0.34.0\narch x86_64\nos Alpine Linux v3.22\nlibc musl\n");
      // Readiness lists the workspace as the step does: the setup files the preparation was sent, and nothing else.
      if (args[1] === READINESS_SCRIPT) return done(`node v24.21.0\nnpm 11.19.0\npnpm 11.5.3\n${["sh", "tar", "find", "sha256sum", "gzip", "sort"].map((tool) => `tool ${tool} ok`).join("\n")}\nsetting verify-deps-before-run false\nsetting pm-on-fail ignore\n${(received.at(-1) ?? []).map((path) => `file ./${path}`).join("\n")}\nlisted\n`);
      if (args[1] !== ENV_PREPARE_SCRIPT) return undefined;
      const reference = (body["files"] as Record<string, { uuid: string }>)["/nivra/env-inputs.tar.gz"]!;
      const entries = readTar(new Uint8Array(gunzipSync(guest.service.uploadsById.get(reference.uuid)!)), { maxEntries: 100, maxBytes: 1 << 22, maxEntryBytes: 1 << 22, maxPathBytes: 1024 });
      received.push(entries.flatMap((entry) => (entry.kind === "file" ? [entry.path] : [])).sort());
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        mkdirSync(dirname(join(folder, "workspace", entry.path)), { recursive: true });
        writeFileSync(join(folder, "workspace", entry.path), entry.bytes);
      }
      mkdirSync(join(folder, "workspace", "node_modules", "dep"), { recursive: true });
      writeFileSync(join(folder, "workspace", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
      return done("via corepack\nnode v24.21.0\nnpm 11.19.0\npnpm 11.5.3\narch x86_64\nDone in 7.7s using pnpm v11.5.3\ninstalled\nbuilds-begin\nAutomatically ignored builds during installation:\n  None\nbuilds-end\n");
    };
    const sandbox = await startSandboxStub({ guest });
    closing.push(sandbox);
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const parent = mkdtempSync(join(tmpdir(), "nivra environment repos "));
    dirs.push(parent);
    const repo = join(parent, "mono");
    for (const [path, content] of Object.entries({
      "package.json": json({ name: "mono", private: true, packageManager: "pnpm@11.5.3" }),
      ".nvmrc": "24.21.0\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      ".npmrc": "node-linker=hoisted\n",
      "packages/data/package.json": json({ name: "@mono/data", private: true }),
      "packages/data/src/index.ts": "export const data = 1;\n",
    })) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    makeRepo(repo);
    const { host, ids, keys } = makeHost({ sandboxesUrl: sandbox.url, projects: [{ targetId: "wsl:Test", path: repo }] });
    keys.current = SECRETS;
    const id = ids[0]!;
    await host.setSharing(id, true);
    await host.setCloudExecution(id, true);
    const shown = await host.resolveEnvironment(id, CHOICES);
    assert.equal(shown.status, "ready", JSON.stringify(shown).slice(0, 300));
    if (shown.status !== "ready") return;
    assert.deepEqual([shown.recipe.image.tag, shown.recipe.install.args, shown.leftOut], ["node:24.21.0-alpine", ["install", "--frozen-lockfile"], [".npmrc"]]);
    await host.prepareEnvironment(id, CHOICES, shown.fingerprint);
    const finished = await waitFor(
      async () => {
        const view = await host.environment(id);
        const status = view.preparation?.status;
        return status && status !== "submitting" && status !== "running" ? view : null;
      },
      "the real preparation to end",
      90_000,
    );
    assert.deepEqual([finished.preparation?.status, finished.preparation?.report?.outcome, finished.preparation?.note], ["answered", "prepared", null], JSON.stringify(finished.preparation?.report?.stopped));
    assert.deepEqual(received, [[".nvmrc", "package.json", "packages/data/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]], "the preparation was sent something besides the setup files");
    const prepared = finished.prepared!;
    assert.deepEqual([prepared.recipeDigest, prepared.verified.tools.map((tool) => `${tool.name} ${tool.version}`), prepared.projectFingerprint, finished.ready], [shown.recipeDigest, ["node 24.21.0", "npm 11.19.0", "pnpm 11.5.3", "corepack 0.34.0"], await projectFingerprint(PROJECT_ID), true]);
    // A task run of this commit is previewed from the prepared environment, which its engine checked.
    const CASE = { name: "the package is private", command: "grep -c private package.json", expectedOutput: "1\n", expectedExitCode: 0 };
    const created = await host.createTask({ title: "Mono", fields: { goal: "Keep it private", acceptanceCriteria: ["It stays private"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [CASE] }, projectId: id, planId: null });
    const task = host.setTaskState(created.summary.id, created.revision, "ready");
    const bound = await host.previewTaskRun(task.summary.id);
    assert.deepEqual([bound.blocked, bound.environment?.image, bound.environment?.verified, bound.environment?.preparedAt], [null, prepared.verified.images.prepared, prepared.verifiedDigest, prepared.preparedAt]);
    // A setup file committed since: the engine refuses the environment, in its own words, and nothing is sent.
    writeFileSync(join(repo, ".nvmrc"), "24.20.0\n");
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-qam", "change the Node pin"], { cwd: repo });
    const refused = await host.previewTaskRun(task.summary.id);
    assert.deepEqual([refused.environment, refused.expected], [null, ""]);
    assert.match(refused.blocked ?? "", /aren't the ones the project's environment was prepared from\. Prepare the environment again, then preview the run\.$/);
  });
});

describe("Host: a mission's own conversation and review plans stay out of the conversation and plan calls (NIV-52)", () => {
  it("lists no mission's conversation, and refuses it, and its review plans, everywhere a conversation or a plan is named", async () => {
    const root = mkdtempSync(join(tmpdir(), "nivra mission host "));
    dirs.push(root);
    const seeded = seedMission(join(root, "workspace.db"), { mission: { name: "Runner's log", intendedUsers: "", outcome: "A runner sees the week's distance.", successCriteria: [], constraints: [], nonGoals: [] }, tasks: [{ title: "Store runs", goal: "g", acceptanceCriteria: ["c"] }] });
    const { reviewId, planId } = seedMissionReview(join(root, "workspace.db"), { missionId: seeded.missionId, taskIds: seeded.taskIds, findings: [] });
    const { host } = hostAt(root);
    const conversationId = seeded.conversationId;
    const taskId = seeded.taskIds[0]!;
    assert.deepEqual(host.conversations().conversations, []);
    const fields: BriefFields = { goal: "g", acceptanceCriteria: ["c"], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
    const calls: Array<[string, () => unknown]> = [
      ["conversation", () => host.conversation(conversationId)],
      ["openConversation", () => host.openConversation(conversationId)],
      ["sendMessage", () => host.sendMessage(conversationId, "hello")],
      ["deleteConversation", () => host.deleteConversation(conversationId)],
      ["savePlan", () => host.savePlan(conversationId, randomUUID())],
      ["plans", () => host.plans(conversationId)],
      ["reviews", () => host.reviews(conversationId)],
      ["cancelReview", () => host.cancelReview(conversationId, reviewId)],
      ["research", () => host.research(conversationId)],
      ["restartConversationEngine", () => host.restartConversationEngine(conversationId)],
      ["revisePlan", () => host.revisePlan(planId, "edited")],
      ["prepareReview", () => host.prepareReview(planId, "council")],
      ["startReview", () => host.startReview(planId, "council", "a".repeat(64))],
      ["prepareResearch", () => host.prepareResearch(planId, { assumptions: [], sites: null })],
      ["createTask", () => host.createTask({ title: "From the review plan", fields, projectId: null, planId })],
      ["refreshBriefFromPlan", () => host.refreshBriefFromPlan(taskId, 1, planId)],
    ];
    const outcomes = await Promise.all(
      calls.map(async ([name, call]) => {
        try {
          await call();
          return [name, "allowed"];
        } catch (error) {
          return [name, error instanceof Error ? error.message : String(error)];
        }
      }),
    );
    const NO_CONVERSATION = "That conversation is no longer in the list.";
    const NO_PLAN = "That plan is no longer here.";
    assert.deepEqual(outcomes, [
      ["conversation", NO_CONVERSATION],
      ["openConversation", NO_CONVERSATION],
      ["sendMessage", NO_CONVERSATION],
      ["deleteConversation", NO_CONVERSATION],
      ["savePlan", NO_CONVERSATION],
      ["plans", NO_CONVERSATION],
      ["reviews", NO_CONVERSATION],
      ["cancelReview", "That review is no longer in this conversation."],
      ["research", NO_CONVERSATION],
      ["restartConversationEngine", NO_CONVERSATION],
      ["revisePlan", NO_PLAN],
      ["prepareReview", NO_PLAN],
      ["startReview", NO_PLAN],
      ["prepareResearch", NO_PLAN],
      ["createTask", NO_PLAN],
      ["refreshBriefFromPlan", NO_PLAN],
    ]);
    // Nothing was written: the task still has one brief version, and no task was made from the review plan.
    assert.deepEqual([host.task(taskId).versions.length, host.tasks().tasks.length], [1, 1]);
    assert.deepEqual(host.engines().filter((engine) => engine.state.status !== "stopped").map((engine) => engine.targetId), [], "no engine started");
  });
});

describe("Host: missions and their council reviews, with no repository (NIV-52)", () => {
  const KEY = "test-key-0123456789";
  const MISSION = { name: "Runner's log", intendedUsers: "Club runners.", outcome: "A runner sees this week's distance against their plan.", successCriteria: ["Shows within a second."], constraints: [], nonGoals: [] };
  type Role = "architecture" | "risks" | "chair";
  const roleOf = (request: StubRequest): Role | null => (/Nivra review role: (architecture|risks|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1] as Role | undefined) ?? null;
  const review = (summary: string, findings: Array<{ title: string; refs: string[] }>) =>
    toolCall("submit_review", { summary, findings: findings.map((f) => ({ ...f, detail: `${f.title}.`, recommendation: "Change it.", severity: "medium" })), assumptions: [], gaps: [] });
  const COUNCIL: Record<Role, Reply> = {
    architecture: review("The total comes before the runs it counts.", [{ title: "Weekly total needs stored runs first", refs: ["T2", "T1"] }]),
    risks: review("No task covers sync.", [{ title: "Nothing covers sync", refs: ["backlog"] }]),
    chair: toolCall("submit_synthesis", { summary: "Store runs first.", priorities: ["arch-1"], agreements: [], dissent: [], gaps: [] }),
  };
  async function stubFor(script: Partial<Record<Role, Reply>> = {}, models?: Array<{ id: string }>) {
    const stub = await startStub({ ...(models ? { models } : {}), chat: (request) => ({ ...COUNCIL, ...script })[roleOf(request) ?? "chair"] });
    stubs.push(stub);
    return stub;
  }
  const done = (host: Host, missionId: string) =>
    waitFor(() => {
      const last = host.mission(missionId).reviews[0];
      return last && last.status !== "submitting" && last.status !== "running" ? last : null;
    }, "the mission review to end", 30_000);
  const refusal = async (run: () => unknown) => {
    try {
      await run();
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  async function missionWith(host: Host, titles: string[]) {
    let view = await host.createMission(MISSION);
    for (const title of titles) view = await host.createMissionTask(view.id, title);
    return view;
  }

  it("saves a mission in versions, keeps it out of the conversations, and keeps a backlog without changing its tasks", async () => {
    const { host, keys } = makeHost();
    keys.current = { NEBIUS_API_KEY: KEY };
    const view = await missionWith(host, ["Store runs", "Weekly total"]);
    assert.deepEqual([view.latest.version, view.backlog.map((entry) => [entry.task.title, entry.task.state, entry.unreviewable])], [
      1,
      [
        ["Store runs", "draft", null],
        ["Weekly total", "draft", null],
      ],
    ]);
    assert.deepEqual(host.conversations().conversations, []);
    const v2 = await host.reviseMission(view.id, 1, { ...MISSION, nonGoals: ["Social features"] });
    assert.equal(v2.latest.version, 2);
    assert.equal(await refusal(() => host.reviseMission(view.id, 1, MISSION)), "This mission changed since you opened it. Open it again, then make your edit.");
    assert.match(await refusal(() => host.createMission({ ...MISSION, outcome: `Ship with ${KEY}` })), /^The mission's outcome holds your saved Token Factory key, so nothing was saved\./);
    const other = await host.createMission({ ...MISSION, name: "Other" });
    assert.equal(await refusal(() => host.addMissionTask(other.id, view.backlog[0]!.task.id)), "That task is in another mission's backlog. Take it out there first, then add it here.");
    const removed = host.removeMissionTask(view.id, view.backlog[0]!.task.id);
    assert.deepEqual([removed.backlog.length, removed.available.map((task) => task.title)], [1, ["Store runs"]]);
    assert.deepEqual(host.missions().missions.map((mission) => [mission.name, mission.version, mission.tasks]).sort(), [
      ["Other", 1, 0],
      ["Runner's log", 2, 1],
    ]);
  });

  it("previews exactly what a review sends, sending nothing, and refuses a repository-linked task", async () => {
    const stub = await stubFor();
    const { host, keys, ids } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: "/nowhere/linked" }] });
    keys.current = { NEBIUS_API_KEY: KEY };
    const view = await missionWith(host, ["Store runs", "Weekly total", "Sync"]);
    const [store, total] = view.backlog.map((entry) => entry.task.id) as [string, string];
    const preview = await host.prepareMissionReview(view.id, [total, store]);
    assert.deepEqual(
      [preview.missionVersion, preview.tasks.map((task) => [task.ref, task.title]), preview.othersInBacklog, preview.requests, preview.model, preview.blocked, preview.specialists.map((s) => `${s.name} v${s.version}`)],
      [
        1,
        [
          ["T1", "Weekly total"],
          ["T2", "Store runs"],
        ],
        1,
        3,
        null,
        null,
        ["Product architect v1", "Risk and testability reviewer v1", "Council chair v1"],
      ],
    );
    assert.match(preview.text, /The selected tasks: T1 to T2\. The backlog holds 1 other task, which wasn't sent\./);
    assert.equal(preview.chars, preview.text.length);
    assert.equal(stub.chats().length, 0, "a preview sends nothing");
    const linked = await host.createTask({ title: "Import old runs", fields: { goal: "", acceptanceCriteria: [], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] }, projectId: ids[0]!, planId: null });
    const withLinked = host.addMissionTask(view.id, linked.summary.id);
    assert.equal(withLinked.backlog.find((entry) => entry.task.id === linked.summary.id)?.unreviewable, "Mission reviews take only tasks that aren't linked to a repository, for now, and this one is.");
    assert.equal(
      await refusal(() => host.prepareMissionReview(view.id, [linked.summary.id])),
      `"Import old runs" is linked to a repository, and mission reviews take only tasks that aren't, for now. Leave it out, then preview again.`,
    );
  });

  it("starts only as previewed, sends the council's three requests, keeps a report whose findings name the tasks, and says what changed since", async () => {
    const stub = await stubFor();
    const { host, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const view = await missionWith(host, ["Store runs", "Weekly total"]);
    const [store, total] = view.backlog.map((entry) => entry.task.id) as [string, string];
    const preview = await host.prepareMissionReview(view.id, [store, total]);
    await host.renameTask(total, host.task(total).revision, "Weekly total on the home screen");
    assert.equal(await refusal(() => host.startMissionReview(view.id, [store, total], preview.expected)), "What this review would send has changed since you opened it. Check the new preview, then start again.");
    assert.equal(stub.chats().length, 0, "a refused start sends nothing");
    const fresh = await host.prepareMissionReview(view.id, [store, total]);
    const started = await host.startMissionReview(view.id, [store, total], fresh.expected);
    assert.equal(started.reviewing, true);
    assert.equal(await refusal(() => host.startMissionReview(view.id, [store, total], fresh.expected)), "A review of this mission is still going. Wait for it, or cancel it, then start again.");
    const ended = await done(host, view.id);
    assert.deepEqual([ended.status, ended.report?.outcome, ended.stale, ended.preferencesChanged], ["answered", "complete", [], false]);
    assert.deepEqual(ended.tasks.map((task) => [task.ref, task.title, task.present]), [
      ["T1", "Store runs", true],
      ["T2", "Weekly total on the home screen", true],
    ]);
    assert.deepEqual(ended.report?.reviewers.map((reviewer) => reviewer.findings.map((finding) => finding.refs)), [[["T2", "T1"]], [["backlog"]]]);
    assert.deepEqual(stub.chats().map(roleOf).sort(), ["architecture", "chair", "risks"]);
    assert.ok(stub.chats().every((request) => !request.raw.includes(KEY)), "the key is never in a request body");
    // A brief edit and a rename later, the report stays as it was, and says what changed.
    await host.reviseBrief(store, host.task(store).revision, { goal: "Store each run.", acceptanceCriteria: ["It's there after a restart."], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] });
    await host.renameTask(total, host.task(total).revision, "Weekly total");
    const stale = host.mission(view.id).reviews[0]!;
    assert.deepEqual(stale.stale, [`"Store runs" is now at brief v2; v1 was sent.`, `"Weekly total on the home screen" is now called "Weekly total".`]);
    assert.deepEqual(stale.report?.reviewers.map((reviewer) => reviewer.findings.length), [1, 1]);
    // Nothing about the tasks changed but what the person did: no state moved, no run started.
    assert.deepEqual(host.tasks().tasks.map((task) => task.state), ["draft", "draft"]);
  });

  it("refuses a start when a task changes while the review is being prepared, inside the transaction that would store it", async () => {
    const stub = await stubFor();
    // The keys are read while a start is prepared, after the composition and before its transaction: rename there.
    let during: (() => Promise<unknown>) | null = null;
    const { host } = makeHost({
      tokenFactoryUrl: stub.url,
      credentials: async () => {
        const run = during;
        during = null;
        if (run) await run();
        return { NEBIUS_API_KEY: KEY };
      },
    });
    const view = await missionWith(host, ["Store runs"]);
    const ids = view.backlog.map((entry) => entry.task.id);
    const preview = await host.prepareMissionReview(view.id, ids);
    during = () => host.renameTask(ids[0]!, host.task(ids[0]!).revision, "Store runs on the phone");
    assert.equal(
      await refusal(() => host.startMissionReview(view.id, ids, preview.expected)),
      `What this review would send has changed since you opened it: "Store runs" is now called "Store runs on the phone". Check the new preview, then start again.`,
    );
    assert.deepEqual([host.mission(view.id).reviews, stub.chats().length], [[], 0], "nothing was stored or sent");
  });

  it("shows rejected output as an incomplete review with the count, never as nothing raised", async () => {
    const stub = await stubFor({ architecture: review("Two problems.", [{ title: "About T7", refs: ["T7"] }, { title: "About E1", refs: ["E1", "plan"] }]) });
    const { host, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const view = await missionWith(host, ["Store runs"]);
    const ids = view.backlog.map((entry) => entry.task.id);
    await host.startMissionReview(view.id, ids, (await host.prepareMissionReview(view.id, ids)).expected);
    const ended = await done(host, view.id);
    assert.deepEqual([ended.status, ended.report?.outcome], ["failed", "incomplete"]);
    const architecture = ended.report?.stages.find((stage) => stage.role === "architecture");
    assert.deepEqual([architecture?.status, architecture?.kind], ["failed", "malformed"]);
    assert.match(architecture?.message ?? "", /2 findings named nothing in the selection/);
    assert.doesNotMatch(JSON.stringify(ended.report?.stages ?? []), /T7|E1/, "the model's own refs are never repeated");
    assert.deepEqual(ended.report?.reviewers.map((reviewer) => reviewer.role), ["risks"]);
  });

  it("sends nothing when the mission's text or a task's holds a saved key, and deletes a mission while leaving its tasks", async () => {
    const stub = await stubFor();
    const { host, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const view = await missionWith(host, ["Store runs"]);
    const [store] = view.backlog.map((entry) => entry.task.id) as [string];
    // A key saved after the brief was written: the brief then holds it, and the whole packet is checked at preview.
    await host.reviseBrief(store, host.task(store).revision, { goal: "Store runs.", acceptanceCriteria: [], scope: "", exclusions: "", context: "old-key-0123456789-abcdef", assumptions: [], checks: [], acceptanceCases: [] });
    keys.current = { NEBIUS_API_KEY: "old-key-0123456789-abcdef" };
    assert.match(await refusal(() => host.prepareMissionReview(view.id, [store])), /^T1's context holds your saved Token Factory key, so nothing was sent\. Remove it, then preview again\.$/);
    assert.equal(stub.chats().length, 0);
    await host.deleteMission(view.id);
    assert.deepEqual([host.missions().missions, host.tasks().tasks.map((task) => task.title)], [[], ["Store runs"]]);
  });

  it("keeps a mission's reviews across a restart, and reads them without sending anything again", async () => {
    const stub = await stubFor();
    const { host, root, keys } = makeHost({ tokenFactoryUrl: stub.url });
    keys.current = { NEBIUS_API_KEY: KEY };
    const view = await missionWith(host, ["Store runs"]);
    const ids = view.backlog.map((entry) => entry.task.id);
    await host.startMissionReview(view.id, ids, (await host.prepareMissionReview(view.id, ids)).expected);
    await done(host, view.id);
    await host.shutdown();
    const again = hostAt(root, { tokenFactoryUrl: stub.url }).host;
    const reopened = await again.openMission(view.id);
    assert.deepEqual([reopened.reviews.length, reopened.reviews[0]?.status, reopened.reviews[0]?.report?.outcome], [1, "answered", "complete"]);
    assert.equal(stub.chats().length, 3, "nothing was sent again");
  });
});
