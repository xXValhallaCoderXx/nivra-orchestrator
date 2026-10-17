import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { isTerminal, type RunEventsPage, type SecretName } from "@nivra/domain";
import { Host } from "../src/main/host.ts";
import { HostStore, NO_SHARING } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import type { TargetFactory } from "../src/main/targets/registry.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";
import type { WslDiscovery } from "../src/main/targets/wsl-discovery.ts";
import { httpError, startStub, toolCall, type Reply, type StubRequest, type Stub } from "../../engine/test/stub-token-factory.ts";

/**
 * The host's engine pool (D17) against real engines run from source. A "WSL" target here is a stand-in: a target that
 * says it is `wsl:Test` and runs the engine locally with its own home, which is all the host can tell apart. The
 * stubborn fixture stands in for an engine that takes its time to stop.
 */
const ENGINE = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url));
const STUBBORN = fileURLToPath(new URL("./fixtures/stubborn-engine.mjs", import.meta.url));
const dirs: string[] = [];
const hosts: Host[] = [];
const stubs: Stub[] = [];
after(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  await Promise.all(stubs.map((stub) => stub.close()));
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

/** Both engines reach `tokenFactoryUrl` (a loopback stub) when it is set; `beforeWslPrepare` can hold the WSL engine's start. */
type HostOptions = { localEntry?: string; wsl?: "ready" | "broken"; tokenFactoryUrl?: string; beforeWslPrepare?: () => Promise<void> };

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
  const extraArgs = options.tokenFactoryUrl ? ["--token-factory-url", options.tokenFactoryUrl] : [];
  const wslTarget = standInWsl("Test", localTarget(join(root, "wsl home"), ENGINE, extraArgs), options.beforeWslPrepare);
  const discovery: WslDiscovery =
    options.wsl === "broken" ? BROKEN : { status: "ready", wslExe: "wsl.exe", distros: [{ name: "Test", version: 2, isDefault: true, defaultUid: 1000, osVersion: null }], hidden: [] };
  const targets: TargetFactory = { local: localTarget(join(root, "local home"), options.localEntry, extraArgs), discoverWsl: async () => ({ discovery, targets: discovery.status === "ready" ? [wslTarget] : [] }) };
  const keys: { current: Partial<Record<SecretName, string>> } = { current: {} };
  const host = new Host({
    targets,
    store,
    logsDir: join(root, "logs"),
    client: { name: "host-test", version: "0" },
    credentials: async () => keys.current,
    platform: "win32",
    realpath: (path) => path,
    supervisor: { heartbeatMs: 0, shutdownGraceMs: 300, eofGraceMs: 300 },
    log: () => undefined,
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
  return data as { revision: number; count: number; records: Array<{ id: string; scope: string; revision: number }>; digest: string };
}

/** The fingerprint of these records, worked out here as D21 defines it, independently of the engine's code. */
const digestOf = (records: ReadonlyArray<{ id: string; scope: string; revision: number; statement: string }>) =>
  createHash("sha256")
    .update(JSON.stringify([...records].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [r.id, r.scope, r.revision, r.statement])))
    .digest("hex");

/** Files under `dir`, at any depth, whose bytes hold `text`. */
function filesHolding(dir: string, text: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name)).includes(text))
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

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
    keys.current = { NEBIUS_API_KEY: "test-key-0123456789" };
    await host.secretsChanged();
    await online(host, "wsl:Test");
    for (const id of ids) {
      const report = await host.doctor(id);
      assert.match(report.checks.find((check) => check.id === "boundaries")!.detail, /credentials set/);
    }
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
    const nativeOwn = host.addPreference({ statement: "Tests live in __tests__", scope: "project", projectId: native });
    const linuxOwn = host.addPreference({ statement: "Tests sit next to the code", scope: "project", projectId: linux });
    const statements = new Map(host.preferences().records.map((r) => [r.id, r]));
    const expected = (...records: Array<{ id: string }>) => digestOf(records.map((r) => statements.get(r.id)!));

    await Promise.all(ids.map((id) => host.open(id)));
    await Promise.all([online(host, "local"), online(host, "wsl:Test")]);
    const onNative = await received(host, (await host.startHello(native, 0)).id);
    const onLinux = await received(host, (await host.startHello(linux, 0)).id);
    assert.deepEqual(onNative.records.map((r) => r.id), [personal.id, nativeOwn.id]);
    assert.deepEqual(onLinux.records.map((r) => r.id), [personal.id, linuxOwn.id]);
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

    const edited = host.editPreference(portable.id, "Prefer default exports");
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
  const ANSWER = { summary: "A repository with a README.", findings: [{ statement: "It has a README.", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }], preferenceDifferences: [], gaps: [] };
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
  /** Runs in an engine's store, read once the engine has stopped and released it (D7). */
  const storedRuns = (home: string) => {
    const db = new DatabaseSync(join(home, "nivra.db"), { readOnly: true });
    try {
      return (db.prepare("SELECT workflow_id FROM runs").all() as Array<{ workflow_id: string }>).map((row) => row.workflow_id);
    } finally {
      db.close();
    }
  };

  it("starts every project with sharing off, and refuses to explain before starting any engine", async () => {
    const stub = await stubWith(() => httpError(500, "unused"));
    const { host, ids } = makeHost({ tokenFactoryUrl: stub.url, projects: [{ targetId: "local", path: makeRepo(join(reposRoot(), "native"), { "README.md": "# Native\n" }) }] });
    assert.deepEqual(host.projects().map((p) => p.sharing.modelContext), [false]);
    await assert.rejects(host.startExplain(ids[0]!, ""), /doesn't allow sending its content to Token Factory/);
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
    const starting = host.startExplain(ids[0]!, "");
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
    const run = await host.startExplain(ids[0]!, "");
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
    const run = await host.startExplain(ids[0]!, "");
    await waitFor(() => stub.chats().length === 2, "the second model call");
    await host.setSharing(ids[0]!, false);
    assert.equal((await ended(host, run.id)).status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal(stub.chats().length, 2);
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
      const run = await host.startExplain(projectId, "");
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
      readThenAnswer(() => ({ ...ANSWER, preferenceDifferences: differenceId ? [{ preferenceId: differenceId, repositoryConvention: "kebab-case files", citations: [{ path: "README.md", startLine: 1, endLine: 1 }] }] : [] })),
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
      const run = await host.startExplain(ids[0]!, "");
      assert.equal((await ended(host, run.id)).status, "succeeded");
      return { run, sent: stub.chats().slice(before).map((chat) => chat.raw).join("\n") };
    };

    const original = await explainOnce();
    assert.equal(original.sent.includes(first), true);
    // Each explain run records what it was given; the fingerprint is worked out here independently (D21).
    const given = await received(host, original.run.id);
    assert.deepEqual([given.count, given.records.map((r) => [r.id, r.revision]), given.digest], [1, [[preference.id, 1]], digestOf([preference])]);
    const editedRecord = host.editPreference(preference.id, `Name component files in PascalCase, always ${edited}`);
    const afterEdit = await explainOnce();
    assert.deepEqual([afterEdit.sent.includes(edited), afterEdit.sent.includes(first)], [true, false]);
    assert.equal((await received(host, afterEdit.run.id)).digest, digestOf([editedRecord]));
    const { result } = await host.runResult(original.run.id);
    assert.deepEqual(result?.preferenceDifferences.map((d) => [d.preferenceId, d.revision]), [[preference.id, 1]], "the old result keeps the revision it was given");
    assert.equal(host.preferences().records.find((r) => r.id === preference.id)?.revision, 2);

    host.deletePreference(preference.id);
    differenceId = "";
    const afterDelete = await explainOnce();
    assert.deepEqual([afterDelete.sent.includes(edited), afterDelete.sent.includes("no confirmed preferences")], [false, true]);
    assert.equal((await received(host, afterDelete.run.id)).count, 0);

    await host.shutdown();
    assert.deepEqual([filesHolding(root, first), filesHolding(root, edited)], [[], []], "no statement outlives its deletion, in any store or log");
  });
});
