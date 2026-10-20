// The Windows development loop, run from WSL (B5): builds the real Windows app (`electron-builder --win --dir`, with
// both staged runtimes), copies it to %LOCALAPPDATA%\nivra-dev\app and starts it there. Because it is a packaged
// build, the native and WSL targets run exactly as they will for people who install Nivra. It is built for the
// development channel (D27), so its engines keep to development homes, ~/.nivra-dev in a WSL distribution and
// %LOCALAPPDATA%\nivra-dev\engine natively, however it is started, and it is started with its own user data: an
// installed Nivra is never touched.
//
//   pnpm dev:win [--skip-stage] [--no-launch]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { "skip-stage": { type: "boolean", default: false }, "no-launch": { type: "boolean", default: false } } });
const step = (text: string) => console.log(`\n▸ ${text}`);
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};
const run = (command: string, args: string[], cwd = desktop) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
};
const windows = (exe: string, args: string[]): string => {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) fail(`${exe} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
};

if (process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe")) fail("Run this from WSL on a Windows machine.");

if (!values["skip-stage"]) {
  step("Staging both runtimes");
  run(process.execPath, [join(desktop, "scripts", "stage-runtime.ts"), "all"]);
}
step("Building the app, for the development channel");
run(join(desktop, "node_modules", ".bin", "electron-vite"), ["build", "--mode", "development"]);
step("Packaging for Windows (unpacked)");
run(join(desktop, "node_modules", ".bin", "electron-builder"), ["--win", "--dir", "--x64"]);
const unpacked = join(desktop, "release", "win-unpacked");
if (!existsSync(join(unpacked, "Nivra.exe"))) fail(`electron-builder left no ${join(unpacked, "Nivra.exe")}`);

step("Copying to Windows");
const localAppData = windows("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"]);
const devWin = `${localAppData}\\nivra-dev`;
const dev = windows("/usr/bin/wslpath", ["-u", devWin]);
const appDir = join(dev, "app");
mkdirSync(dev, { recursive: true });
// One archive and Windows' own tar beat copying thousands of files across the WSL boundary.
const archive = join(dev, "app.tar");
run("tar", ["-cf", archive, "-C", unpacked, "."]);
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
windows("/mnt/c/Windows/System32/tar.exe", ["-xf", `${devWin}\\app.tar`, "-C", `${devWin}\\app`]);
rmSync(archive, { force: true });
console.log(`  ${devWin}\\app\\Nivra.exe`);

if (!values["no-launch"]) {
  step("Starting Nivra on Windows");
  const child = spawn(join(appDir, "Nivra.exe"), [`--user-data-dir=${devWin}\\user data`, `--nivra-engine-home=${devWin}\\engine`], { cwd: "/mnt/c", detached: true, stdio: "ignore" });
  child.unref();
  console.log("  started; close the window to quit (the engine stops with it).");
}
