// Runs ON WINDOWS with the staged node.exe, started by verify-interrupt.ts from WSL (D14). It drives the packaged
// Windows app through its UI while a dedicated test distribution is terminated from outside (`wsl --terminate`), and
// writes what it saw to a trace on Windows. It terminates only the distribution it is given.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { RunEventsPage } from "@nivra/domain";
import type { EngineView, ProjectView } from "../src/shared/ipc.ts";

const { values } = parseArgs({
  options: {
    exe: { type: "string" },
    work: { type: "string" },
    distro: { type: "string" },
    "wsl-repo": { type: "string" },
    "native-repo": { type: "string" },
    "wsl-exe": { type: "string" },
  },
});
const exe = values.exe!;
const work = values.work!;
const distro = values.distro!;
const wslExe = values["wsl-exe"]!;
const trace = `${work}\\trace.log`;
const started = performance.now();
writeFileSync(trace, "");

const note = (line: string) => {
  const text = `${(performance.now() - started).toFixed(0).padStart(7)} ms  ${line}`;
  console.log(text);
  appendFileSync(trace, `${text}\n`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(check: () => T | Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value as NonNullable<T>;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, body: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await body();
    results.push({ name, ok: true, detail });
    note(`✓ ${name} — ${detail}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    note(`✗ ${name} — ${detail}`);
    return false;
  }
}

// Assigned by the launch; still unset if the launch itself failed.
let app!: ElectronApplication;
let page: Page;
// The bridge is called with string expressions: this script is compiled without the DOM's types.
const engines = () => page.evaluate("window.nivra.listEngines()") as Promise<EngineView[]>;
const projects = () => page.evaluate("window.nivra.listProjects()") as Promise<ProjectView[]>;
const events = (runId: string) => page.evaluate(`window.nivra.runEvents(${JSON.stringify(runId)}, 0)`) as Promise<RunEventsPage>;
const engineOf = async (targetId: string) => (await engines()).find((e) => e.targetId === targetId) ?? null;
const onlineInfo = async (targetId: string) => {
  const view = await engineOf(targetId);
  return view?.state.status === "online" ? view.state.info : null;
};

async function pick(path: string): Promise<void> {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByTestId("project-add").click();
}

async function choose(targetId: string): Promise<void> {
  const project = (await projects()).find((p) => p.targetId === targetId)!;
  const shown = page.getByTestId("project-target");
  // Choosing the project already chosen would deselect it (Mantine's Select allows that).
  if ((await shown.count()) && (await shown.textContent()) === project.targetLabel) return;
  await page.getByTestId("project-select").click();
  await page.getByRole("option", { name: new RegExp(project.targetLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await waitFor(async () => (await page.getByTestId("project-target").textContent()) === project.targetLabel, 10_000, `${project.targetLabel} to be chosen`);
}

const runIdShown = () => page.getByTestId("hello-status").getAttribute("data-run-id");
const statusShown = () => page.getByTestId("hello-status").textContent();

/** Starts a run held for 60 s from the UI and returns its id once its child process is holding. */
async function startHeld(): Promise<string> {
  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await page.getByTestId("hello-timeline").getByText("Holding a child process").waitFor({ timeout: 60_000 });
  return (await runIdShown())!;
}

async function main(): Promise<number> {
  note(`Nivra ${exe}; test distribution ${distro}; trace ${trace}`);
  app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${work}\\user data`, `--nivra-engine-home=${work}\\engine`],
    // Otherwise Playwright adds --no-sandbox, and the app (app.enableSandbox) refuses to start.
    chromiumSandbox: true,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  const wslTarget = `wsl:${distro}`;
  const held: { wslRun?: string; nativeRun?: string; wslInstance?: string; nativeInstance?: string; nativePid?: number } = {};

  const ready = await check(`${distro}: its folder runs in the distribution, and a 60 s run holds there`, async () => {
    await pick(`\\\\wsl.localhost\\${distro}${values["wsl-repo"]!.replace(/\//g, "\\")}`);
    const info = await waitFor(() => onlineInfo(wslTarget), 180_000, `the engine in ${distro}`);
    held.wslInstance = info.instanceId;
    held.wslRun = await startHeld();
    return `engine ${info.instanceId} (pid ${info.pid} in ${distro}); run ${held.wslRun} holding`;
  });
  const nativeReady = await check("native: a Windows folder runs on the native engine, and a 60 s run holds there", async () => {
    await pick(values["native-repo"]!);
    const info = await waitFor(() => onlineInfo("local"), 60_000, "the native engine");
    held.nativeInstance = info.instanceId;
    held.nativePid = info.pid;
    held.nativeRun = await startHeld();
    return `engine ${info.instanceId} (pid ${info.pid}); run ${held.nativeRun} holding`;
  });
  if (!ready || !nativeReady) return 1;

  note(`Terminating ${distro} from outside: ${wslExe} --terminate ${distro}`);
  const terminated = spawnSync(wslExe, ["--terminate", distro], { encoding: "utf8", env: { ...process.env, WSL_UTF8: "1" }, windowsHide: true });
  note(`wsl --terminate exited ${String(terminated.status)}`);

  await check(`${distro}: its engine is reported as failed, with a reason`, async () => {
    const view = await waitFor(async () => {
      const engine = await engineOf(wslTarget);
      return engine?.state.status === "failed" ? engine : null;
    }, 30_000, `the ${distro} engine to be reported`);
    return `"${view.state.status === "failed" ? view.state.reason : ""}"`;
  });
  await check("native: the app stays usable, and the native run keeps going on its own engine", async () => {
    // The page answers, and the native project's run is still the same one, holding on the same engine.
    await choose("local");
    const status = await statusShown();
    const runId = await runIdShown();
    const timeline = await events(held.nativeRun!);
    const info = await onlineInfo("local");
    if (status !== "running" || runId !== held.nativeRun || timeline.status !== "running") throw new Error(`native run shows ${status} (${runId}), engine says ${timeline.status}`);
    if (!info || info.instanceId !== held.nativeInstance) throw new Error(`the native engine changed: ${info?.instanceId ?? "offline"}`);
    return `run ${runId} running on engine ${info.instanceId}`;
  });
  await check(`${distro}: Restart in the UI brings up a fresh engine`, async () => {
    await choose(wslTarget);
    await page.getByTestId("engine-failed").waitFor({ timeout: 10_000 });
    await page.getByTestId("engine-restart").click();
    const info = await waitFor(() => onlineInfo(wslTarget), 180_000, `the engine in ${distro} again`);
    if (info.instanceId === held.wslInstance) throw new Error("the same engine instance answered");
    return `engine ${info.instanceId} (pid ${info.pid})`;
  });
  await check(`${distro}: the unfinished run ends interrupted, and is never started again`, async () => {
    const timeline = await waitFor(async () => {
      const current = await events(held.wslRun!);
      return current.status === "running" ? null : current;
    }, 30_000, "the old run to be reconciled");
    const starts = timeline.events.filter((e) => e.type === "run.started").length;
    const last = timeline.events.at(-1);
    if (timeline.status !== "failed" || last?.type !== "run.interrupted" || starts !== 1) throw new Error(`status ${timeline.status}, last event ${last?.type}, started ${starts} times`);
    await waitFor(async () => (await statusShown()) === "failed", 15_000, "the UI to show it failed");
    return `"${last.message}"; started once; the UI shows failed`;
  });
  await check(`${distro}: a new run started from the UI works`, async () => {
    await page.getByText("0 s", { exact: true }).click();
    await page.getByTestId("hello-start").click();
    const runId = await waitFor(async () => {
      const id = await runIdShown();
      return id && id !== held.wslRun ? id : null;
    }, 15_000, "the new run");
    await waitFor(async () => (await statusShown()) === "succeeded", 60_000, "the new run to succeed");
    return `run ${runId} succeeded`;
  });
  await check("native: the held run finishes on the engine that started it", async () => {
    await choose("local");
    const timeline = await waitFor(async () => {
      const current = await events(held.nativeRun!);
      return current.status === "running" ? null : current;
    }, 90_000, "the native run to finish");
    const info = await onlineInfo("local");
    if (timeline.status !== "succeeded") throw new Error(`it ended ${timeline.status}`);
    if (!info || info.instanceId !== held.nativeInstance) throw new Error(`the native engine changed: ${info?.instanceId ?? "offline"}`);
    return `run ${held.nativeRun} succeeded on engine ${info.instanceId}`;
  });
  await check("quitting leaves no engine on Windows or in the test distribution", async () => {
    const wslInstance = (await onlineInfo(wslTarget))?.instanceId;
    await app.close();
    await waitFor(() => {
      try {
        process.kill(held.nativePid!, 0);
        return false;
      } catch {
        return true;
      }
    }, 15_000, `native engine ${held.nativePid} to exit`);
    // The same pattern as instancePattern() in targets/wsl.ts: it never matches the pgrep that carries it.
    const pattern = `--instance [${wslInstance![0]}]${wslInstance!.slice(1)}`;
    await waitFor(() => spawnSync(wslExe, ["-d", distro, "--exec", "pgrep", "-af", "--", pattern], { windowsHide: true }).status === 1, 15_000, `the engine in ${distro} to exit`);
    return `native pid ${held.nativePid} gone; no engine ${wslInstance} in ${distro}`;
  });

  const failed = results.filter((r) => !r.ok);
  note(`${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}. App logs: ${work}\\user data\\logs`);
  return failed.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  note(`✗ the observer stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await (app as ElectronApplication | undefined)?.close().catch(() => undefined);
}
process.exit(code);
