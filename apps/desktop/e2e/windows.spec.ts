import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * The packaged Windows app, run on Windows from WSL through interop (D14: no CI), as copied by `pnpm dev:win`. It
 * drives both targets through the real UI: the native engine on a repository made by Git for Windows, then a switch to
 * the WSL distribution (provisioned from the shipped tarball), a folder picked as \\wsl.localhost\… and converted to a
 * Linux path, a hello run and a cancelled run there, and quitting with no engine left on either side.
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
const enginePids: { native: number | null; wslInstance: string | null } = { native: null, wslInstance: null };

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

const engineInfo = () =>
  page.evaluate(async () => {
    const view = await window.nivra.engineStatus();
    return view.state.status === "online" ? view.state.info : null;
  });

async function pick(path: string) {
  await app.evaluate(async ({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, path);
  await page.getByTestId("project-add").click();
}

test("a fresh profile starts on WSL's default distribution, provisions it, and runs hello on a \\\\wsl.localhost folder", async () => {
  await expect(page.getByTestId("target-select")).toHaveValue(`${distro} · WSL`);
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 120_000 });
  const info = (await engineInfo())!;
  expect(info.platform).toBe("linux");
  enginePids.wslInstance = info.instanceId;
  await pick(`\\\\wsl.localhost\\${distro}${wslRepo.replace(/\//g, "\\")}`);
  await expect(page.getByTestId("project-select")).toHaveValue("repo ü%#");
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-status")).toHaveText("succeeded");
  await expect(page.getByTestId("hello-timeline")).toContainText(wslRepo);

  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-timeline")).toContainText("Holding a child process");
  await page.getByTestId("hello-cancel").click();
  await expect(page.getByTestId("hello-status")).toHaveText("cancelled");
});

test("switching to Windows · Local in the middle of a run stops the WSL engine, and the native engine runs hello on a repository made by Git for Windows", async () => {
  // The review's case: a run still going when the target changes must not leave the page polling or blocked.
  await page.getByText("60 s", { exact: true }).click();
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-timeline")).toContainText("Holding a child process");
  await page.getByTestId("target-select").click();
  await page.getByRole("option", { name: "Windows · Local" }).click();
  await expect(page.getByTestId("target-select")).toHaveValue("Windows · Local");
  await expect(page.getByTestId("engine-badge")).toHaveText("Engine online", { timeout: 60_000 });
  const id = enginePids.wslInstance!;
  await expect.poll(() => spawnSync("pgrep", ["-af", "--", `--instance [${id[0]}]${id.slice(1)}`]).status, { timeout: 15_000 }).toBe(1);
  const info = (await engineInfo())!;
  expect(info.platform).toBe("win32");
  enginePids.native = info.pid;
  // Nothing of the WSL run is left: no status, no timeline, and the run button is not held back by it.
  await expect(page.getByTestId("hello-status")).toHaveCount(0);
  await expect(page.getByTestId("hello-timeline")).toHaveCount(0);
  await page.getByText("0 s", { exact: true }).click();
  await pick(nativeRepoWin);
  await expect(page.getByTestId("project-select")).toHaveValue("repo ü%#");
  await page.getByTestId("hello-start").click();
  await expect(page.getByTestId("hello-status")).toHaveText("succeeded");
  await expect(page.getByTestId("hello-timeline")).toContainText("on main");
});

test("quitting leaves no engine on Windows or in the distribution", async () => {
  await app.close();
  const nativeGone = () => !windows("/mnt/c/Windows/System32/tasklist.exe", ["/FI", `PID eq ${enginePids.native}`, "/NH"]).includes(String(enginePids.native));
  await expect.poll(nativeGone, { timeout: 15_000 }).toBe(true);
  const id = enginePids.wslInstance!;
  const wslGone = () => spawnSync("pgrep", ["-af", "--", `--instance [${id[0]}]${id.slice(1)}`]).status === 1;
  await expect.poll(wslGone, { timeout: 15_000 }).toBe(true);
});
