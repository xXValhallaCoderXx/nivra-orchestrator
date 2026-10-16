// Runs ON WINDOWS, as a real Windows process (the staged node.exe), started by verify-windows.ts from WSL (D14). It
// drives the native Windows engine and a WSL engine through the same target and supervisor modules Electron's main
// process uses, and checks what CI would have: start, hello, cancel, a clean stop, and that an engine dies with its
// parent when the parent is killed (libuv's kill-on-close job object, D4).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isTerminal, preferencesDigest, type RunContext, type RunEvent, type RunEventsPage } from "@nivra/domain";
import { findGit } from "../../engine/src/exec/find-executable.ts";
import { EngineSupervisor } from "../src/main/supervisor.ts";
import { LocalTarget, runtimeIn } from "../src/main/targets/local.ts";
import { runTool } from "../src/main/targets/process.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";
import { discoverWsl, type WslDistro } from "../src/main/targets/wsl-discovery.ts";
import { instancePattern, WslTarget } from "../src/main/targets/wsl.ts";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    tarball: { type: "string" },
    hash: { type: "string" },
    work: { type: "string" },
    distro: { type: "string" },
    // Child mode: start one engine, print its pid and instance, then wait to be killed.
    "hold-engine": { type: "string" },
  },
});
const runtimeDir = values.runtime!;
const work = values.work!;
const tarball = values.tarball!;
const linuxHash = values.hash!;
const AWKWARD = "ü%#";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(check: () => T | Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value as NonNullable<T>;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function nativeTarget(home: string): LocalTarget {
  return new LocalTarget({ platform: "win32", runtime: runtimeIn(runtimeDir, "win32"), home });
}

async function wslTarget(): Promise<{ target: WslTarget; distro: WslDistro; wslExe: string }> {
  const discovery = await discoverWsl();
  if (discovery.status !== "ready") throw new Error(`WSL: ${discovery.message}`);
  const distro = values.distro ? discovery.distros.find((d) => d.name === values.distro) : (discovery.distros.find((d) => d.isDefault) ?? discovery.distros[0]);
  if (!distro) throw new Error(`No usable WSL distribution${values.distro ? ` named ${values.distro}` : ""} (found: ${discovery.distros.map((d) => d.name).join(", ") || "none"})`);
  return { target: new WslTarget({ distro, wslExe: discovery.wslExe, runtime: { tarball, contentHash: linuxHash } }), distro, wslExe: discovery.wslExe };
}

function supervisorFor(target: ExecutionTarget, name: string): EngineSupervisor {
  return new EngineSupervisor({
    target,
    logsDir: join(work, "logs", name),
    client: { name: "windows-harness", version: "0" },
    credentials: async () => ({}),
    heartbeatMs: 30_000,
    log: (line) => console.log(`    ${line}`),
  });
}

// ---- child mode -----------------------------------------------------------------------------------------------------

if (values["hold-engine"]) {
  const kind = values["hold-engine"];
  const target = kind === "native" ? nativeTarget(join(work, `home orphan ${AWKWARD}`)) : (await wslTarget()).target;
  const supervisor = supervisorFor(target, `orphan-${kind}`);
  const info = await supervisor.start();
  console.log(JSON.stringify({ pid: info.pid, instanceId: info.instanceId }));
  setInterval(() => undefined, 1_000);
} else {
  await main();
}

// ---- checks ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = async (name: string, body: () => Promise<string>): Promise<boolean> => {
    const started = performance.now();
    try {
      const detail = await body();
      results.push({ name, ok: true, detail });
      console.log(`  ✓ ${name} (${Math.round(performance.now() - started)} ms) — ${detail}`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail });
      console.log(`  ✗ ${name} — ${detail}`);
      return false;
    }
  };

  // A real, non-empty snapshot with awkward text, sent with every run as the app does (D21).
  const context: RunContext = {
    preferences: {
      revision: 3,
      records: [
        { id: randomUUID(), statement: `Prefer named exports, “quoted”, ${AWKWARD}, 日本語`, scope: "personal", revision: 2 },
        { id: randomUUID(), statement: "Keep tests next to the code they test", scope: "project", revision: 1 },
      ],
    },
  };
  const runHello = async (supervisor: EngineSupervisor, repoPath: string, holdMs = 0) =>
    supervisor.call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath, holdMs }, context });
  /** What the engine recorded about the context it received, checked against what was sent. */
  const contextArrived = async (page: RunEventsPage): Promise<string> => {
    const received = page.events.find((e) => e.stepId === "context" && e.type === "step.output");
    const sent = await preferencesDigest(context.preferences.records);
    if (received?.data?.["digest"] !== sent) throw new Error(`the engine received other preferences: ${received?.message ?? "no context step"}`);
    return `${context.preferences.records.length} preferences arrived intact (fingerprint ${sent.slice(0, 12)})`;
  };
  const waitRun = (supervisor: EngineSupervisor, runId: string, until: (page: RunEventsPage) => boolean, timeoutMs = 60_000) =>
    waitFor(async () => {
      const page = await supervisor.call("runs.events", { runId, after: 0, limit: 500 });
      return until(page) ? page : null;
    }, timeoutMs, `run ${runId}`);
  const holdPid = (events: readonly RunEvent[]): number | null => {
    const pid = events.find((event) => event.type === "command.started")?.data?.["pid"];
    return typeof pid === "number" ? pid : null;
  };

  // ---- native Windows ----
  console.log("\nNative Windows engine");
  const nativeHome = join(work, `home native ${AWKWARD}`);
  rmSync(nativeHome, { recursive: true, force: true });
  const native = supervisorFor(nativeTarget(nativeHome), "native");
  const windowsHash = (JSON.parse(readFileSync(join(runtimeDir, "engine", "manifest.json"), "utf8")) as { contentHash: string }).contentHash;
  let nativePid = 0;
  const nativeUp = await check("native: engine starts on the staged node.exe", async () => {
    const info = await native.start();
    nativePid = info.pid;
    if (info.platform !== "win32") throw new Error(`the engine says it runs on ${info.platform}`);
    if (info.runtimeHash !== windowsHash) throw new Error(`runtime ${String(info.runtimeHash)}, expected ${windowsHash}`);
    return `engine ${info.engineVersion}, Node ${info.node}, pid ${info.pid}, home ${info.home}`;
  });
  if (nativeUp) {
    await check("native: doctor", async () => {
      const report = await native.call("doctor", {});
      return report.checks.map((c) => `${c.id}=${c.status}`).join(", ");
    });
    const git = findGit();
    const repo = join(work, `repo ${AWKWARD}`);
    if (git) {
      rmSync(repo, { recursive: true, force: true });
      mkdirSync(repo, { recursive: true });
      await runTool(git, ["init", "-q", "-b", "main"], { cwd: repo, timeoutMs: 30_000 });
      await runTool(git, ["-c", "user.name=Nivra Test", "-c", "user.email=test@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, timeoutMs: 30_000 });
    }
    await check("native: hello on a repository whose path has ü, % and #, with the preferences sent along", async () => {
      if (!git) throw new Error("Git for Windows isn't installed, so no repository could be made");
      const run = await runHello(native, repo);
      const page = await waitRun(native, run.id, (p) => isTerminal(p.status));
      if (page.status !== "succeeded") throw new Error(page.events.map((e) => e.message).join(" | "));
      const status = page.events.find((e) => e.stepId === "git-status" && e.type === "step.output");
      return `${status?.message ?? "?"}; ${await contextArrived(page)}`;
    });
    await check("native: cancel stops the process the run started", async () => {
      const run = await runHello(native, git ? repo : work, 60_000);
      const holding = await waitRun(native, run.id, (p) => holdPid(p.events) !== null || isTerminal(p.status));
      const pid = holdPid(holding.events);
      if (!pid) throw new Error(`the run never held a process: ${holding.events.map((e) => e.message).join(" | ")}`);
      await native.call("runs.cancel", { runId: run.id });
      const page = await waitRun(native, run.id, (p) => isTerminal(p.status), 15_000);
      if (page.status !== "cancelled") throw new Error(`run ended ${page.status}`);
      await waitFor(() => !isAlive(pid), 10_000, `process ${pid} to stop`);
      return `held process ${pid} stopped`;
    });
    await check("native: stop leaves no engine behind", async () => {
      await native.stop();
      await waitFor(() => !isAlive(nativePid), 10_000, `engine ${nativePid} to exit`);
      return `engine ${nativePid} exited`;
    });
    // An engine ended from outside (Task Manager, an antivirus) is reported as stopped, never mislabelled, and Restart
    // brings a fresh one up.
    await check("native: an engine killed from outside is reported as stopped, and Restart starts it again", async () => {
      const info = await native.start();
      process.kill(info.pid);
      await waitFor(() => native.state.status === "failed" || null, 15_000, "the supervisor to notice");
      const reason = native.state.status === "failed" ? native.state.reason : "";
      if (!/stopped unexpectedly/.test(reason)) throw new Error(`unexpected state: ${reason}`);
      const again = await native.restart();
      if (again.instanceId === info.instanceId) throw new Error("the same engine instance answered");
      await native.stop();
      return `engine ${info.pid} killed; "${reason}"; Restart started pid ${again.pid}`;
    });
  }
  await check("native: an engine dies with its parent (job object)", () => orphanCheck("native"));

  // ---- WSL ----
  console.log("\nWSL engine");
  let wsl: Awaited<ReturnType<typeof wslTarget>> | null = null;
  await check("wsl: discovery", async () => {
    wsl = await wslTarget();
    return `using ${wsl.distro.name} (WSL ${String(wsl.distro.version)}, default user ${String(wsl.distro.defaultUid)})`;
  });
  if (wsl) {
    const { target, distro, wslExe } = wsl as Awaited<ReturnType<typeof wslTarget>>;
    const inDistro = (args: string[], timeoutMs = 60_000) => runTool(wslExe, ["-d", distro.name, "--cd", "/", "--exec", ...args], { env: { ...process.env, WSL_UTF8: "1" } as Record<string, string>, timeoutMs });
    await check("wsl: probe", async () => {
      const probe = await target.probe();
      const facts = probe.facts;
      if (!probe.ok) throw new Error(probe.problems.map((p) => p.message).join(" "));
      return `${String(facts["arch"])}, ${String(facts["libc"])}, home ${String(facts["home"])}, runtime ${String(facts["runtime"])}${probe.problems.length ? `; warnings: ${probe.problems.map((p) => p.code).join(", ")}` : ""}`;
    });
    const supervisor = supervisorFor(target, "wsl");
    let wslInfo: { pid: number; instanceId: string } | null = null;
    const up = await check("wsl: engine starts from Windows, provisioning the runtime when needed", async () => {
      const info = await supervisor.start();
      wslInfo = info;
      if (info.platform !== "linux") throw new Error(`the engine says it runs on ${info.platform}`);
      if (info.runtimeHash !== linuxHash) throw new Error(`runtime ${String(info.runtimeHash)}, expected ${linuxHash}`);
      return `engine ${info.engineVersion} on ${info.platform}/${info.arch}, pid ${info.pid} (in ${distro.name}), home ${info.home}`;
    });
    if (up) {
      await check("wsl: doctor", async () => (await supervisor.call("doctor", {})).checks.map((c) => `${c.id}=${c.status}`).join(", "));
      const made = await inDistro(["/bin/sh", "-c", 'set -e; d="$HOME/.nivra-verify/repo $1"; rm -rf "$d"; mkdir -p "$d"; cd "$d"; git init -q -b main; git -c user.name=t -c user.email=t@nivra.invalid commit -q --allow-empty -m init; pwd', "sh", AWKWARD]);
      const repo = made.stdout.trim().split("\n").at(-1) ?? "";
      await check("wsl: hello on a repository inside the distribution, path with ü, % and #, with the preferences sent along", async () => {
        if (made.code !== 0 || !repo.startsWith("/")) throw new Error(`could not make the repository: ${made.stderr}`);
        const run = await runHello(supervisor, repo);
        const page = await waitRun(supervisor, run.id, (p) => isTerminal(p.status));
        if (page.status !== "succeeded") throw new Error(page.events.map((e) => e.message).join(" | "));
        return `${page.events.find((e) => e.stepId === "git-status" && e.type === "step.output")?.message ?? "?"} (${repo}); ${await contextArrived(page)}`;
      });
      await check("wsl: cancel stops the process the run started", async () => {
        const run = await runHello(supervisor, repo || "/", 60_000);
        const holding = await waitRun(supervisor, run.id, (p) => holdPid(p.events) !== null || isTerminal(p.status));
        const pid = holdPid(holding.events);
        if (!pid) throw new Error(`the run never held a process: ${holding.events.map((e) => e.message).join(" | ")}`);
        await supervisor.call("runs.cancel", { runId: run.id });
        const page = await waitRun(supervisor, run.id, (p) => isTerminal(p.status), 15_000);
        if (page.status !== "cancelled") throw new Error(`run ended ${page.status}`);
        await waitFor(async () => (await inDistro(["kill", "-0", String(pid)], 15_000)).code !== 0, 10_000, `process ${pid} to stop`);
        return `held process ${pid} stopped inside ${distro.name}`;
      });
      await check("wsl: stop leaves no engine behind in the distribution", async () => {
        const instance = wslInfo!.instanceId;
        await supervisor.stop();
        await waitFor(async () => (await inDistro(["pgrep", "-af", "--", instancePattern(instance)], 15_000)).code === 1, 15_000, "the engine to leave");
        return `no process with instance ${instance} in ${distro.name}`;
      });
      await check("wsl: a second start reuses the installed runtime", async () => {
        const started = performance.now();
        const info = await supervisor.start();
        const ms = Math.round(performance.now() - started);
        await supervisor.stop();
        return `started in ${ms} ms on runtime ${String(info.runtimeHash)}`;
      });
      // Killed inside the distribution: the same failure the host shows for any unexpected exit (it doesn't guess at a
      // cause), and Restart starts a fresh engine. Terminating the whole distribution isn't checked here: this harness
      // is started from inside it.
      await check("wsl: an engine killed inside the distribution is reported as stopped, and Restart starts it again", async () => {
        const info = await supervisor.start();
        const killed = await inDistro(["pkill", "-KILL", "-f", "--", instancePattern(info.instanceId)], 15_000);
        if (killed.code !== 0) throw new Error(`pkill found no engine to stop (exit ${String(killed.code)})`);
        await waitFor(() => supervisor.state.status === "failed" || null, 15_000, "the supervisor to notice");
        const reason = supervisor.state.status === "failed" ? supervisor.state.reason : "";
        if (!/stopped unexpectedly/.test(reason)) throw new Error(`unexpected state: ${reason}`);
        const again = await supervisor.restart();
        if (again.instanceId === info.instanceId) throw new Error("the same engine instance answered");
        await supervisor.stop();
        return `engine ${info.pid} killed in ${distro.name}; "${reason}"; Restart started pid ${again.pid}`;
      });
    }
    await check("wsl: an engine dies with its parent (job object, then EOF)", () => orphanCheck("wsl", inDistro));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed on Windows${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}.`);
  process.exit(failed.length ? 1 : 0);
}

/**
 * Starts a child harness that starts an engine, kills the child without a tree kill (as a crash would), and checks the
 * engine goes too: libuv put it (or wsl.exe) in the child's kill-on-close job object (D4).
 */
async function orphanCheck(kind: "native" | "wsl", inDistro?: (args: string[], timeoutMs?: number) => Promise<{ code: number | null }>): Promise<string> {
  const child = spawn(process.execPath, [process.argv[1]!, "--hold-engine", kind, ...process.argv.slice(2)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", () => undefined);
  const held = await waitFor(() => {
    const line = out.split("\n").find((l) => l.startsWith("{"));
    return line ? (JSON.parse(line) as { pid: number; instanceId: string }) : null;
  }, 120_000, "the child to start its engine");
  child.kill("SIGKILL"); // TerminateProcess on the child alone; no tree kill
  if (kind === "native") {
    await waitFor(() => !isAlive(held.pid), 10_000, `engine ${held.pid} to die with its parent`);
    return `engine ${held.pid} died with its parent`;
  }
  await waitFor(async () => (await inDistro!(["pgrep", "-af", "--", instancePattern(held.instanceId)], 15_000)).code === 1, 20_000, "the WSL engine to see EOF and leave");
  return `the WSL engine (pid ${held.pid} in the distribution) left after its parent died`;
}
