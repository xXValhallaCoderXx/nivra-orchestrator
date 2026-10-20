// Checks what the app does when a whole WSL distribution is terminated while it runs (NIV-5), from WSL, without CI
// (D14). The packaged Windows app (from `pnpm dev:win --no-launch`) and its observer both run on Windows, where the
// trace and the app's logs stay. It needs a dedicated test distribution with no work in it: that distribution is
// terminated from outside, with everything running in it. It refuses the distribution it runs in. The app's WSL engine
// runs in a home of this run's own there (D27), removed at the end.
//
//   pnpm --filter @nivra/desktop verify:interrupt --distro <test distribution>
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { REMOVE_TEST_HOME, STALE_TEST_HOMES, testWslHome } from "./test-homes.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { distro: { type: "string" } } });

const step = (text: string) => console.log(`\n▸ ${text}`);
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

if (process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe")) fail("Run this from WSL on a Windows machine: it starts Windows programs through interop.");
const distro = values.distro ?? fail("Name the test distribution with --distro <name>. It is terminated during the check, so use one with no work in it.");
if (distro.toLowerCase() === (process.env["WSL_DISTRO_NAME"] ?? "").toLowerCase()) {
  fail(`${distro} is the distribution this script runs in, and terminating it would stop the check. Use a dedicated test distribution (docs/development.md says how to make one).`);
}

/** Runs a Windows program through interop from a Windows folder, so it never sees a \\wsl.localhost working directory. */
function windows(exe: string, args: string[]): string {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) fail(`${exe} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
}
const WSL_EXE = "/mnt/c/Windows/System32/wsl.exe";
const inDistro = (args: string[]) => {
  const result = spawnSync(WSL_EXE, ["-d", distro, "--cd", "/", "--exec", ...args], { cwd: "/mnt/c", encoding: "utf8", env: { ...process.env, WSL_UTF8: "1" } });
  // wsl.exe's own messages can still arrive as UTF-16.
  return { code: result.status, stdout: result.stdout.replace(/\0/g, ""), stderr: result.stderr.replace(/\0/g, "") };
};

step(`Checking the test distribution ${distro}`);
const reached = inDistro(["/bin/true"]);
if (reached.code !== 0) fail(`${distro} didn't answer: ${(reached.stderr || reached.stdout).trim() || `exit ${String(reached.code)}`}. Make it first (docs/development.md).`);

inDistro(["/bin/sh", "-c", STALE_TEST_HOMES]);
const wslHome = testWslHome("interrupt");

const devWin = `${windows("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"])}\\nivra-dev`;
const exeWin = `${devWin}\\app\\Nivra.exe`;
if (!existsSync(windows("/usr/bin/wslpath", ["-u", exeWin]))) fail(`No Windows build at ${exeWin}: run pnpm dev:win --no-launch first.`);
const workWin = `${devWin}\\interrupt`;
const work = windows("/usr/bin/wslpath", ["-u", workWin]);
for (const leftover of ["user data", "engine", "repo ü%#", "trace.log"]) rmSync(join(work, leftover), { recursive: true, force: true });
mkdirSync(work, { recursive: true });

step("Making a repository on Windows and one inside the test distribution");
const GIT_EXE = "/mnt/c/Program Files/Git/cmd/git.exe";
if (!existsSync(GIT_EXE)) fail("Git for Windows isn't installed, so no Windows repository can be made. Install it, then run this again.");
mkdirSync(join(work, "repo ü%#"));
const nativeRepoWin = `${workWin}\\repo ü%#`;
windows(GIT_EXE, ["-C", nativeRepoWin, "init", "-q", "-b", "main"]);
windows(GIT_EXE, ["-C", nativeRepoWin, "-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
const made = inDistro(["/bin/sh", "-c", 'set -e; d="$HOME/repo $1"; rm -rf "$d"; mkdir -p "$d"; cd "$d"; git init -q -b main; git -c user.name=t -c user.email=t@nivra.invalid commit -q --allow-empty -m init; pwd', "sh", "ü%#"]);
const wslRepo = made.stdout.trim().split("\n").at(-1) ?? "";
if (made.code !== 0 || !wslRepo.startsWith("/")) fail(`Couldn't make a repository in ${distro}: ${made.stderr.trim()}. Is git installed there?`);
console.log(`  ${nativeRepoWin}\n  ${wslRepo} (in ${distro})`);

step("Bundling the observer, with Playwright beside it");
const verifyDir = join(desktop, "build", "verify");
await build({
  entryPoints: [join(desktop, "scripts", "interrupt-observer.ts")],
  outfile: join(verifyDir, "interrupt", "interrupt-observer.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Playwright reads its own files at run time, so it is copied as it is rather than bundled.
  external: ["@playwright/test"],
  logLevel: "warning",
});
/** Where a package is, as resolved from `fromDir` (pnpm keeps each package's own dependencies beside it). */
function packageRoot(name: string, fromDir: string): string {
  let dir = dirname(createRequire(join(fromDir, "noop.js")).resolve(name));
  while ((JSON.parse(existsSync(join(dir, "package.json")) ? readFileSync(join(dir, "package.json"), "utf8") : "{}") as { name?: string }).name !== name) {
    if (dirname(dir) === dir) fail(`Couldn't find ${name}'s folder.`);
    dir = dirname(dir);
  }
  return realpathSync(dir);
}
const playwrightTest = packageRoot("@playwright/test", desktop);
const playwright = packageRoot("playwright", playwrightTest);
const core = packageRoot("playwright-core", playwright);
const version = (JSON.parse(readFileSync(join(core, "package.json"), "utf8")) as { version: string }).version;
const modules = join(verifyDir, "interrupt", "node_modules");
rmSync(modules, { recursive: true, force: true });
for (const [name, dir] of [["@playwright/test", playwrightTest], ["playwright", playwright], ["playwright-core", core]] as const) {
  cpSync(dir, join(modules, name), { recursive: true, dereference: true, filter: (path) => !path.endsWith(".map") });
}

step("Copying it to Windows");
const copied = join(work, "node_modules", "playwright-core", "package.json");
if (!existsSync(copied) || (JSON.parse(readFileSync(copied, "utf8")) as { version: string }).version !== version) {
  // One archive and Windows' own tar beat copying thousands of small files across the WSL boundary.
  rmSync(join(work, "node_modules"), { recursive: true, force: true });
  const archive = join(work, "observer-modules.tar");
  const packed = spawnSync("tar", ["-cf", archive, "-C", join(verifyDir, "interrupt"), "node_modules"], { stdio: "inherit" });
  if (packed.status !== 0) fail("Packing Playwright failed.");
  windows("/mnt/c/Windows/System32/tar.exe", ["-xf", `${workWin}\\observer-modules.tar`, "-C", workWin]);
  rmSync(archive, { force: true });
}
cpSync(join(verifyDir, "interrupt", "interrupt-observer.mjs"), join(work, "interrupt-observer.mjs"));
const stagedNode = join(desktop, "build", "stage", "win-x64", "node", "node.exe");
if (!existsSync(stagedNode)) fail("No staged Windows runtime: run pnpm stage:runtime all first.");
const node = join(work, "node.exe");
if (!existsSync(node) || statSync(node).size !== statSync(stagedNode).size) cpSync(stagedNode, node);
console.log(`  ${workWin} (Playwright ${version})`);

step(`Running the observer on Windows: it terminates ${distro}, and only ${distro}`);
const observer = spawn(
  node,
  [`${workWin}\\interrupt-observer.mjs`, "--exe", exeWin, "--work", workWin, "--distro", distro, "--wsl-repo", wslRepo, "--native-repo", nativeRepoWin, "--wsl-exe", "C:\\Windows\\System32\\wsl.exe", "--wsl-home", wslHome],
  { cwd: "/mnt/c", stdio: "inherit" },
);
const code = await new Promise<number | null>((done) => observer.once("exit", (exit) => done(exit)));
const removed = inDistro(["/bin/sh", "-c", REMOVE_TEST_HOME, "sh", wslHome]);
console.log(`\nTrace: ${workWin}\\trace.log · app logs: ${workWin}\\user data\\logs`);
console.log(removed.code === 0 ? `This run's WSL home in ${distro}, ~/${wslHome}, is removed.` : `This run's WSL home in ${distro}, ~/${wslHome}, couldn't be removed: ${removed.stderr.trim()}`);
process.exit(code ?? 1);
