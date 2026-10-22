// Verifies the Windows host paths on this machine, from WSL, without CI (D14). It stages both runtimes, copies the
// Windows runtime and a bundled harness to %LOCALAPPDATA%\nivra-dev\verify, and runs the harness with the staged
// node.exe: a real Windows parent that drives the native engine and a WSL engine as Electron's main process will. With
// --zip, it takes both runtimes from a release candidate's Windows zip instead, exactly as packaged (D25). The WSL engine
// runs in a home of this run's own, below ~/.nivra-test, and the release's ~/.nivra must be left as it was (D27). A
// stand-in for Nebius Sandboxes runs here, on loopback in this distribution, for the harness's sandbox checks through
// the WSL engine (D36); the harness changes and reads it through `@stub` lines on its stdout, answered on its stdin.
// Stand-ins for Tavily and Token Factory run beside it for the research checks (D37), asked through the same lines.
//
//   pnpm --filter @nivra/desktop verify:windows [--distro <name>] [--skip-stage | --zip <path to Nivra-<version>-win-x64.zip>]
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { startSandboxStub } from "../../engine/test/stub-sandboxes.ts";
import { startResearchStandIns } from "./research-stand-ins.ts";
import { answerResearch, answerStandIn } from "./stand-in.ts";
import { testWslHome } from "./test-homes.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = join(desktop, "build", "stage");
const { values } = parseArgs({ options: { distro: { type: "string" }, "skip-stage": { type: "boolean", default: false }, zip: { type: "string" } } });
const zip = values.zip ? resolve(values.zip) : null;

const step = (text: string) => console.log(`\n▸ ${text}`);
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

if (process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe")) fail("Run this from WSL on a Windows machine: it starts Windows programs through interop.");
if (zip && !existsSync(zip)) fail(`${zip} doesn't exist. Build a candidate with pnpm release:candidate, or pass the zip's path.`);
const contentHash = (manifest: string): string => (JSON.parse(readFileSync(manifest, "utf8")) as { contentHash: string }).contentHash;

/** Runs a Windows program through interop from a Windows folder, so it never sees a \\wsl.localhost working directory. */
function windows(exe: string, args: string[]): string {
  const result = spawnSync(exe, args, { cwd: "/mnt/c", encoding: "utf8" });
  if (result.status !== 0) fail(`${exe} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.replace(/\r/g, "").trim();
}

if (!values["skip-stage"] && !zip) {
  step("Staging both runtimes");
  const staged = spawnSync(process.execPath, [join(desktop, "scripts", "stage-runtime.ts"), "all"], { stdio: "inherit" });
  if (staged.status !== 0) fail("Staging failed.");
}

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
let runtimeWin: string;
let runtime: string;
let tarballWin: string;
let linuxHash: string;
if (zip) {
  // Windows' own tar extracts the zip as a person would; only the runtimes are needed.
  const candidate = join(work, "candidate");
  rmSync(candidate, { recursive: true, force: true });
  mkdirSync(candidate, { recursive: true });
  cpSync(zip, join(work, "candidate.zip"));
  windows("/mnt/c/Windows/System32/tar.exe", ["-xf", `${workWin}\\candidate.zip`, "-C", `${workWin}\\candidate`, "resources/runtime"]);
  rmSync(join(work, "candidate.zip"), { force: true });
  runtimeWin = `${workWin}\\candidate\\resources\\runtime\\win-x64`;
  runtime = join(candidate, "resources", "runtime", "win-x64");
  tarballWin = `${workWin}\\candidate\\resources\\runtime\\runtime-linux-x64.tar.gz`;
  linuxHash = contentHash(join(candidate, "resources", "runtime", "runtime-linux-x64.json"));
  console.log(`  ${basename(zip)}: runtimes win-x64 ${contentHash(join(runtime, "engine", "manifest.json"))} and linux-x64 ${linuxHash} → ${workWin}\\candidate`);
} else {
  linuxHash = contentHash(join(stageRoot, "runtime-linux-x64.json"));
  const windowsHash = contentHash(join(stageRoot, "win-x64", "engine", "manifest.json"));
  runtimeWin = `${workWin}\\runtime-win-x64`;
  runtime = join(work, "runtime-win-x64");
  const copiedHash = existsSync(join(runtime, "engine", "manifest.json")) ? contentHash(join(runtime, "engine", "manifest.json")) : null;
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
  tarballWin = `${workWin}\\runtime-linux-x64.tar.gz`;
}
cpSync(join(verifyDir, "harness.mjs"), join(work, "harness.mjs"));

step("Starting the stand-in for Nebius Sandboxes");
const sandboxes = await startSandboxStub();
const here = process.env["WSL_DISTRO_NAME"] ?? "";
console.log(`  ${sandboxes.url}, in ${here || "this distribution"}`);
step("Starting the stand-ins for Tavily and Token Factory");
const research = await startResearchStandIns();
console.log(`  ${research.tavily.url} and ${research.model.url}`);

step("Running the harness on Windows");
const node = join(runtime, "node", "node.exe");
const wslHome = testWslHome("verify");
const args = [
  `${workWin}\\harness.mjs`,
  "--runtime",
  runtimeWin,
  "--tarball",
  tarballWin,
  "--hash",
  linuxHash,
  "--work",
  workWin,
  "--wsl-home",
  wslHome,
  "--sandboxes-url",
  sandboxes.url,
  "--sandboxes-distro",
  here,
  "--tavily-url",
  research.tavily.url,
  "--token-factory-url",
  research.model.url,
  ...(values.distro ? ["--distro", values.distro] : []),
];
const harness = spawn(node, args, { cwd: "/mnt/c", stdio: ["pipe", "pipe", "inherit"] });
harness.stdin.on("error", () => undefined);
createInterface({ input: harness.stdout }).on("line", (line) => {
  if (line.startsWith("@stub research-")) harness.stdin.write(`${answerResearch(research, line.slice("@stub ".length))}\n`);
  else if (line.startsWith("@stub ")) harness.stdin.write(`${answerStandIn(sandboxes, line.slice("@stub ".length))}\n`);
  else console.log(line);
});
// "close", not "exit": every line the harness printed has been read by then.
const code = await new Promise<number | null>((done) => harness.once("close", (exit) => done(exit)));
await sandboxes.close();
await research.close();
process.exit(code ?? 1);
