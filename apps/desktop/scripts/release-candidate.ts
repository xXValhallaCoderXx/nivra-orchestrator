// Builds a release candidate that can be traced to its commit (NIV-14, NIV-16): from a clean tree, after `pnpm verify`,
// it stages both runtimes once, builds the app once, packages the Linux deb and the Windows zip, checks that what was
// packaged is what was staged, and writes release/build-info.json and release/SHA256SUMS. A candidate is identified by
// its commit and its hashes, and a release publishes the accepted files unchanged; a published version's files are
// never replaced, so a candidate after a release carries a new version (D25). The AppImage isn't built: it doesn't
// start on a stock Ubuntu 24.04 (D10). Run it from WSL (D14).
//
//   pnpm release:candidate [--skip-verify]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashRuntime, misplacedVcRuntime } from "./runtime-files.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const release = join(desktop, "release");
const stage = join(desktop, "build", "stage");
const bin = (name: string) => join(desktop, "node_modules", ".bin", name);
const { values } = parseArgs({ options: { "skip-verify": { type: "boolean", default: false } } });

const step = (text: string) => console.log(`\n▸ ${text}`);
const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};
const run = (command: string, args: string[], cwd = desktop) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
};
const output = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string => {
  const result = spawnSync(command, args, { cwd: options.cwd ?? repo, env: options.env ?? process.env, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

if (process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe")) fail("Run this from WSL on a Windows machine (D14).");
if (process.versions.node !== "24.21.0") fail(`Node ${process.versions.node} is running; this repository needs 24.21.0 (nvm use).`);
const pnpmVersion = output("pnpm", ["--version"]);
if (pnpmVersion !== "10.4.1") fail(`pnpm ${pnpmVersion} is running; this repository needs 10.4.1 (corepack enable).`);
const dirty = output("git", ["status", "--porcelain"]);
if (dirty) fail("The working tree has changes. Commit or stash them first: a candidate is built from a commit.");
const commit = output("git", ["rev-parse", "HEAD"]);
const branch = output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const pushed = output("git", ["branch", "-r", "--contains", commit]) !== "";

step(`Candidate from ${commit.slice(0, 12)} on ${branch}${pushed ? "" : " (not pushed yet)"}`);
run("pnpm", ["install", "--frozen-lockfile"], repo);
if (values["skip-verify"]) console.log("  pnpm verify skipped (recorded in build-info.json)");
else run("pnpm", ["verify"], repo);

step("Staging both runtimes, once");
rmSync(release, { recursive: true, force: true });
rmSync(join(desktop, "out"), { recursive: true, force: true });
run(process.execPath, [join(desktop, "scripts", "stage-runtime.ts"), "all"]);
step("Building the app, once");
run(bin("electron-vite"), ["build"]);
step("Packaging the Linux deb");
run(bin("electron-builder"), ["--linux", "deb", "--x64", "--publish", "never"]);
step("Packaging the Windows zip");
run(bin("electron-builder"), ["--win", "zip", "--x64", "--publish", "never"]);

step("Checking that what was packaged is what was staged");
type Manifest = { contentHash: string; sha256: string; files: number; engineVersion: string; protocolVersion: number; node: string; vcRuntime?: unknown };
const runtimes = (["linux-x64", "win-x64"] as const).map((target) => {
  const staged = json<Manifest>(join(stage, target, "engine", "manifest.json"));
  const packagedDir = join(release, target === "linux-x64" ? "linux-unpacked" : "win-unpacked", "resources", "runtime", target);
  const packaged = json<Manifest>(join(packagedDir, "engine", "manifest.json"));
  if (packaged.contentHash !== staged.contentHash || packaged.sha256 !== staged.sha256) fail(`The packaged ${target} runtime (${packaged.contentHash}) isn't the staged one (${staged.contentHash}).`);
  // A manifest can be right while a file isn't: hash every packaged file, as staging did.
  const contents = hashRuntime(packagedDir);
  if (contents.sha256 !== staged.sha256 || contents.files !== staged.files) fail(`The packaged ${target} runtime's files hash to ${contents.contentHash} (${contents.files} files), not ${staged.contentHash} (${staged.files} files).`);
  const misplaced = target === "win-x64" ? misplacedVcRuntime(packagedDir) : [];
  if (misplaced.length) fail(`A native addon in the packaged ${target} runtime would not find its Visual C++ runtime:\n${misplaced.map((problem) => `  ✗ ${problem}`).join("\n")}`);
  return { target, contentHash: staged.contentHash, sha256: staged.sha256, files: staged.files, engineVersion: staged.engineVersion, protocolVersion: staged.protocolVersion, node: staged.node, ...(staged.vcRuntime ? { vcRuntime: staged.vcRuntime } : {}) };
});
const tarball = join(release, "win-unpacked", "resources", "runtime", "runtime-linux-x64.tar.gz");
const tarballHash = await sha256(tarball);
if (tarballHash !== (await sha256(join(stage, "runtime-linux-x64.tar.gz")))) fail("The WSL runtime tarball in the Windows build isn't the staged one.");
const wslRuntime = json<{ contentHash: string }>(join(release, "win-unpacked", "resources", "runtime", "runtime-linux-x64.json"));
if (wslRuntime.contentHash !== runtimes[0]!.contentHash) fail(`The Windows build would install WSL runtime ${wslRuntime.contentHash}, not ${runtimes[0]!.contentHash}.`);
const apps = [
  { target: "linux-x64", asarSha256: await sha256(join(release, "linux-unpacked", "resources", "app.asar")) },
  { target: "win-x64", asarSha256: await sha256(join(release, "win-unpacked", "resources", "app.asar")) },
];

const desktopPackage = json<{ version: string; devDependencies: Record<string, string> }>(join(desktop, "package.json"));
// The dev Electron prints the versions the packaged one carries; the variable is set here, never as a script prefix (D3).
const electron = JSON.parse(output(bin("electron"), ["-p", "JSON.stringify(process.versions)"], { cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })) as Record<string, string>;
const artefactNames = readdirSync(release).filter((name) => name.endsWith(".deb") || name.endsWith(".zip")).sort();
if (artefactNames.length !== 2) fail(`Expected one deb and one zip in ${release}, found: ${artefactNames.join(", ") || "none"}.`);
const artefacts = [];
for (const name of artefactNames) artefacts.push({ name, size: statSync(join(release, name)).size, sha256: await sha256(join(release, name)) });

const info = {
  version: desktopPackage.version,
  commit,
  branch,
  clean: true,
  pushed,
  verify: values["skip-verify"] ? "skipped" : "passed",
  toolchain: { node: process.versions.node, pnpm: pnpmVersion, electron: desktopPackage.devDependencies["electron"], electronBuilder: desktopPackage.devDependencies["electron-builder"], electronVite: desktopPackage.devDependencies["electron-vite"] },
  electron: { electron: electron["electron"], chrome: electron["chrome"], node: electron["node"], v8: electron["v8"] },
  runtimes,
  wslTarball: { contentHash: wslRuntime.contentHash, sha256: tarballHash },
  apps,
  artefacts,
};
writeFileSync(join(release, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
const sums = [...artefacts.map((a) => `${a.sha256}  ${a.name}`), `${await sha256(join(release, "build-info.json"))}  build-info.json`];
writeFileSync(join(release, "SHA256SUMS"), `${sums.join("\n")}\n`);

step("Release candidate");
for (const artefact of artefacts) console.log(`  ${artefact.name}  ${(artefact.size / 1_048_576).toFixed(0)} MB  sha256 ${artefact.sha256}`);
console.log(`  runtimes: ${runtimes.map((r) => `${r.target} ${r.contentHash}`).join(", ")}`);
console.log(`  ${join(release, "build-info.json")} and SHA256SUMS written for ${commit.slice(0, 12)}.`);
