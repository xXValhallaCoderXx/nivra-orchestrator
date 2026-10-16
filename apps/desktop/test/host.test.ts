import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { isTerminal, type RunEventsPage, type SecretName } from "@nivra/domain";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import type { TargetFactory } from "../src/main/targets/registry.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";
import type { WslDiscovery } from "../src/main/targets/wsl-discovery.ts";

/**
 * The host's engine pool (D17) against real engines run from source. A "WSL" target here is a stand-in: a target that
 * says it is `wsl:Test` and runs the engine locally with its own home, which is all the host can tell apart. The
 * stubborn fixture stands in for an engine that takes its time to stop.
 */
const ENGINE = fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url));
const STUBBORN = fileURLToPath(new URL("./fixtures/stubborn-engine.mjs", import.meta.url));
const dirs: string[] = [];
const hosts: Host[] = [];
after(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
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

function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return path;
}

const localTarget = (home: string, entry = ENGINE) => new LocalTarget({ platform: "linux", runtime: { node: process.execPath, entry, runtimeHash: null }, home });

/** A target that says it is a WSL distribution, running its engine locally with its own home. */
function standInWsl(distro: string, inner: ExecutionTarget): ExecutionTarget {
  return { descriptor: { id: `wsl:${distro}`, kind: "wsl", label: `${distro} · WSL`, platform: "linux", distro }, probe: () => inner.probe(), prepare: (request) => inner.prepare(request) };
}

const BROKEN: WslDiscovery = { status: "broken", code: "WSL_E_TEST", message: "WSL didn't answer (WSL_E_TEST). Run `wsl --update` in a terminal, then press Check again.", distros: [] };

function makeHost(options: { localEntry?: string; wsl?: "ready" | "broken"; projects?: Array<{ targetId: string; path: string }> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nivra host ü%# "));
  dirs.push(root);
  const ids = (options.projects ?? []).map(() => randomUUID());
  new HostStore(join(root, "nivra.json")).update((data) => ({
    ...data,
    projects: (options.projects ?? []).map((p, i) => ({ id: ids[i]!, targetId: p.targetId, nativePath: p.path, label: p.path.split("/").at(-1)!, addedAt: new Date().toISOString() })),
  }));
  return { ...hostAt(root, options), root, ids };
}

/** A host on the records and engine homes under `root`, as a desktop launch would make it: a second one is a restart. */
function hostAt(root: string, options: { localEntry?: string; wsl?: "ready" | "broken" } = {}) {
  const store = new HostStore(join(root, "nivra.json"));
  const wslTarget = standInWsl("Test", localTarget(join(root, "wsl home")));
  const discovery: WslDiscovery =
    options.wsl === "broken" ? BROKEN : { status: "ready", wslExe: "wsl.exe", distros: [{ name: "Test", version: 2, isDefault: true, defaultUid: 1000, osVersion: null }], hidden: [] };
  const targets: TargetFactory = { local: localTarget(join(root, "local home"), options.localEntry), discoverWsl: async () => ({ discovery, targets: discovery.status === "ready" ? [wslTarget] : [] }) };
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
