import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * The packaged Windows app, run on Windows from WSL through interop (D14: no CI), as copied by `pnpm dev:win`. One
 * session drives both engines through the real UI, each chosen by its folder (D17): a folder picked as
 * \\wsl.localhost\… runs in the distribution (provisioned from the shipped tarball), a folder made by Git for Windows
 * runs on the native engine, a run held on WSL keeps going and cancels on its own engine while the native one starts and
 * works, and quitting leaves no engine on either side.
 */
test.skip(process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe"), "runs from WSL on a Windows machine");

const windows = (exe: string, args: string[]) => {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
};
const wslpath = (flag: "-u" | "-w", path: string) => windows("/usr/bin/wslpath", [flag, path]);
const GIT_EXE = "/mnt/c/Program Files/Git/cmd/git.exe";

let app: ElectronApplication;
let page: Page;
let devWin: string;
let nativeRepoWin: string;
let wslRepo: string;
let distro: string;
const engines: { native: number | null; wslInstance: string | null; wslRun: string | null } = { native: null, wslInstance: null, wslRun: null };

test.beforeAll(async () => {
  devWin = `${windows("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"])}\\nivra-dev`;
  const exe = `${wslpath("-u", devWin)}/app/Nivra.exe`;
  if (!existsSync(exe)) throw new Error(`No Windows build at ${exe}: run pnpm dev:win --no-launch first.`);
  const e2e = wslpath("-u", `${devWin}\\e2e`);
  rmSync(e2e, { recursive: true, force: true });
  mkdirSync(`${e2e}/repo ü%#`, { recursive: true });
  nativeRepoWin = `${devWin}\\e2e\\repo ü%#`;
  windows(GIT_EXE, ["-C", nativeRepoWin, "init", "-q", "-b", "main"]);
  windows(GIT_EXE, ["-C", nativeRepoWin, "-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);

  distro = process.env["WSL_DISTRO_NAME"] ?? "Ubuntu";
  const made = spawnSync("/bin/sh", ["-c", 'set -e; d="$HOME/.nivra-e2e/repo ü%#"; rm -rf "$d"; mkdir -p "$d"; cd "$d"; git init -q -b main; git -c user.name=t -c user.email=t@nivra.invalid commit -q --allow-empty -m init; pwd'], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(made.stderr);
  wslRepo = made.stdout.trim();

  // chromiumSandbox: otherwise Playwright adds --no-sandbox, and the app (app.enableSandbox) refuses to start (exit 5).
  app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${devWin}\\e2e\\user data`, `--nivra-engine-home=${devWin}\\e2e\\engine`], chromiumSandbox: true, timeout: 120_000 });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const engineInfo = (targetId: string) =>
  page.evaluate(async (id) => {
    const view = (await window.nivra.listEngines()).find((e) => e.targetId === id);
    return view?.state.status === "online" ? view.state.info : null;
  }, targetId);

const wslEngineAlive = (instanceId: string) => spawnSync("pgrep", ["-af", "--", `--instance [${instanceId[0]}]${instanceId.slice(1)}`]).status === 0;

async function pick(path: string) {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByTestId("project-add").click();
}

async function choose(targetLabel: string) {
  await page.getByTestId("project-select").click();
  await page.getByRole("option", { name: new RegExp(targetLabel) }).click();
  await expect(page.getByTestId("project-target")).toHaveText(targetLabel);
}

test("a fresh profile offers no target to choose, starts no engine, and has nothing to say about a working WSL", async () => {
  await expect(page.getByTestId("engine-badge")).toHaveText("No folder chosen");
  await expect(page.getByTestId("target-select")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await window.nivra.getWsl())?.status)).toBe("ready");
  await expect(page.getByTestId("wsl-guidance")).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.nivra.listEngines()).length)).toBe(0);
});

test("a \\\\wsl.localhost folder runs in its distribution, provisioned on first use", async () => {
  await pick(`\\\\wsl.localhost\\${distro}${wslRepo.replace(/\//g, "\\")}`);
  await expect(page.getByTestId("project-target")).toHaveText(`${distro} · WSL`);
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 120_000 });
  const info = (await engineInfo(`wsl:${distro}`))!;
  expect(info.platform).toBe("linux");
  engines.wslInstance = info.instanceId;
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-status")).toHaveText("succeeded");
  await expect(page.getByTestId("hello-timeline")).toContainText(wslRepo);
});

test("a run held on WSL keeps going on its own engine while a Windows folder starts and works on the native engine (the review's race)", async () => {
  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-timeline")).toContainText("Holding a child process");
  engines.wslRun = await page.getByTestId("hello-status").getAttribute("data-run-id");

  await pick(nativeRepoWin);
  await expect(page.getByTestId("project-target")).toHaveText("Windows · Local");
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 60_000 });
  const native = (await engineInfo("local"))!;
  expect(native.platform).toBe("win32");
  engines.native = native.pid;
  await page.getByText("0 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-status")).toHaveText("succeeded");
  await expect(page.getByTestId("hello-timeline")).toContainText("on main");

  // Back on the WSL folder: the same run, on the same engine, is still holding; Cancel reaches that engine.
  await choose(`${distro} · WSL`);
  await expect(page.getByTestId("hello-status")).toHaveText("running");
  await expect(page.getByTestId("hello-status")).toHaveAttribute("data-run-id", engines.wslRun!);
  expect((await engineInfo(`wsl:${distro}`))?.instanceId).toBe(engines.wslInstance);
  await page.getByTestId("hello-cancel").click();
  await expect(page.getByTestId("hello-status")).toHaveText("cancelled");
  expect((await engineInfo("local"))?.pid).toBe(engines.native);
});

test("the same Windows folder picked through WSL is the Windows project, with a note saying why", async () => {
  const throughWsl = `\\\\wsl.localhost\\${distro}\\mnt\\${nativeRepoWin[0]!.toLowerCase()}${nativeRepoWin.slice(2)}`;
  await pick(throughWsl);
  await expect(page.getByTestId("project-target")).toHaveText("Windows · Local");
  await expect(page.getByTestId("project-add-notice")).toContainText(`drive ${nativeRepoWin[0]!.toUpperCase()}:`);
  expect(await page.evaluate(async () => (await window.nivra.listProjects()).length)).toBe(2);
});

test("quitting leaves no engine on Windows or in the distribution", async () => {
  await app.close();
  const nativeGone = () => !windows("/mnt/c/Windows/System32/tasklist.exe", ["/FI", `PID eq ${engines.native}`, "/NH"]).includes(String(engines.native));
  await expect.poll(nativeGone, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => wslEngineAlive(engines.wslInstance!), { timeout: 15_000 }).toBe(false);
});
