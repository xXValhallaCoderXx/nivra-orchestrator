// Verifies the Windows host paths on this machine, from WSL, without CI (D14). It stages both runtimes, copies the
// Windows runtime and a bundled harness to %LOCALAPPDATA%\nivra-dev\verify, and runs the harness with the staged
// node.exe: a real Windows parent that drives the native engine and a WSL engine as Electron's main process will.
//
//   pnpm --filter @nivra/desktop verify:windows [--distro <name>] [--skip-stage]
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = join(desktop, "build", "stage");
const { values } = parseArgs({ options: { distro: { type: "string" }, "skip-stage": { type: "boolean", default: false } } });

const step = (text: string) => console.log(`\n▸ ${text}`);
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

if (process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe")) fail("Run this from WSL on a Windows machine: it starts Windows programs through interop.");

/** Runs a Windows program through interop from a Windows folder, so it never sees a \\wsl.localhost working directory. */
function windows(exe: string, args: string[]): string {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) fail(`${exe} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
}

if (!values["skip-stage"]) {
  step("Staging both runtimes");
  const staged = spawnSync(process.execPath, [join(desktop, "scripts", "stage-runtime.ts"), "all"], { stdio: "inherit" });
  if (staged.status !== 0) fail("Staging failed.");
}
const linux = JSON.parse(readFileSync(join(stageRoot, "runtime-linux-x64.json"), "utf8")) as { contentHash: string };
const windowsHash = (JSON.parse(readFileSync(join(stageRoot, "win-x64", "engine", "manifest.json"), "utf8")) as { contentHash: string }).contentHash;

step("Bundling the harness");
const verifyDir = join(desktop, "build", "verify");
mkdirSync(verifyDir, { recursive: true });
await build({
  entryPoints: [join(desktop, "scripts", "windows-harness.ts")],
  outfile: join(verifyDir, "harness.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  logLevel: "warning",
});

step("Copying to Windows");
const localAppData = windows("/mnt/c/Windows/System32/cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"]);
const workWin = `${localAppData}\\nivra-dev\\verify`;
const work = windows("/usr/bin/wslpath", ["-u", workWin]);
mkdirSync(work, { recursive: true });
const runtimeWin = `${workWin}\\runtime-win-x64`;
const runtime = join(work, "runtime-win-x64");
const copiedHash = existsSync(join(runtime, "engine", "manifest.json"))
  ? (JSON.parse(readFileSync(join(runtime, "engine", "manifest.json"), "utf8")) as { contentHash: string }).contentHash
  : null;
if (copiedHash !== windowsHash) {
  // One archive and Windows' own tar beat copying thousands of small files across the WSL boundary.
  const archive = join(work, "runtime-win-x64.tar");
  const packed = spawnSync("tar", ["-cf", archive, "-C", join(stageRoot, "win-x64"), "."], { stdio: "inherit" });
  if (packed.status !== 0) fail("Packing the Windows runtime failed.");
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  windows("/mnt/c/Windows/System32/tar.exe", ["-xf", `${workWin}\\runtime-win-x64.tar`, "-C", runtimeWin]);
  rmSync(archive, { force: true });
  console.log(`  runtime ${windowsHash} → ${runtimeWin}`);
} else {
  console.log(`  runtime ${windowsHash} already there`);
}
cpSync(join(stageRoot, "runtime-linux-x64.tar.gz"), join(work, "runtime-linux-x64.tar.gz"));
cpSync(join(verifyDir, "harness.mjs"), join(work, "harness.mjs"));

step("Running the harness on Windows");
const node = join(runtime, "node", "node.exe");
const args = [
  `${workWin}\\harness.mjs`,
  "--runtime",
  runtimeWin,
  "--tarball",
  `${workWin}\\runtime-linux-x64.tar.gz`,
  "--hash",
  linux.contentHash,
  "--work",
  workWin,
  ...(values.distro ? ["--distro", values.distro] : []),
];
const harness = spawn(node, args, { cwd: "/mnt/c", stdio: "inherit" });
const code = await new Promise<number | null>((done) => harness.once("exit", (exit) => done(exit)));
process.exit(code ?? 1);
