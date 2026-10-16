// Stages the engine runtime for one or more targets (D5), ported from Hird's stage-engine.ts (provenance.md):
//   build/stage/<target>/node     Node itself, checked against nodejs.org's published checksums
//   build/stage/<target>/engine   main.mjs (the unbundled launcher), engine.mjs (esbuild bundle of our code), the
//                                  engine's production node_modules for the target, and manifest.json
//   build/stage/runtime-linux-x64.tar.gz   (linux-x64 only) the deterministic tarball streamed into WSL distributions
//
//   node scripts/stage-runtime.ts [linux-x64 | win-x64 | mac-arm64 | all] [--vc-runtime-from <dir>] [--skip-smoke]
//
// The Linux runtime is always staged on Linux: a tarball made on Windows loses the executable bit and folds names that
// differ only in case. win-x64 may be staged from Linux (WSL): nothing in it depends on file modes.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGzip, inflateRawSync } from "node:zlib";
import { build } from "esbuild";
import { EngineSelfCheck, LineSplitter, PROTOCOL_VERSION, RpcClient } from "@nivra/domain";
import { ENGINE_VERSION } from "../../engine/src/version.ts";

const NODE_VERSION = "24.21.0";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const engineDir = join(repo, "apps", "engine");
const STAGE_ROOT = join(desktop, "build", "stage");

type Target = { name: string; os: "linux" | "win" | "mac"; arch: "x64" | "arm64" };
const TARGETS: Record<string, Target> = {
  "linux-x64": { name: "linux-x64", os: "linux", arch: "x64" },
  "win-x64": { name: "win-x64", os: "win", arch: "x64" },
  "mac-arm64": { name: "mac-arm64", os: "mac", arch: "arm64" },
};
const hostTarget = (): string => `${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}-${process.arch}`;
/** Visual C++ runtime DLLs a native addon may import (D6). */
const VC_RUNTIME = ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "MSVCP140.dll"];
/** A long Windows install prefix: C:\Users\<name>\AppData\Local\Programs\Nivra\resources\runtime\win-x64\ */
const WINDOWS_PREFIX_CHARS = 100;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "vc-runtime-from": { type: "string" }, "skip-smoke": { type: "boolean", default: false } },
});
const requested = positionals[0] ?? hostTarget();
const names = requested === "all" ? ["linux-x64", "win-x64"] : [requested];
for (const name of names) if (!TARGETS[name]) throw new Error(`Unknown target "${name}" (choose one of ${Object.keys(TARGETS).join(", ")}, or all)`);
if (names.includes("linux-x64") && process.platform !== "linux") throw new Error("Stage linux-x64 on Linux (or WSL): a tarball made elsewhere loses Node's executable bit.");

const step = (text: string) => console.log(`\n▸ ${text}`);

function run(command: string, args: string[], options: { cwd: string }): void {
  const result = spawnSync(command, args, { cwd: options.cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

const walk = (dir: string, visit: (path: string, isDir: boolean) => boolean | void): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const isDir = entry.isDirectory();
    if (visit(path, isDir) === false) continue;
    if (isDir) walk(path, visit);
  }
};

// ---- 1. the engine bundle (the same for every target) ---------------------------------------------------------------

step("Bundling the engine with esbuild");
const engineManifest = JSON.parse(readFileSync(join(engineDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
const prodDeps = Object.keys(engineManifest.dependencies ?? {});
const bundleDir = mkdtempSync(join(tmpdir(), "nivra-bundle-"));
const bundled = await build({
  entryPoints: [join(engineDir, "src", "engine.ts")],
  outfile: join(bundleDir, "engine.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Exactly the engine's production dependencies stay outside the bundle (one zod), shipped as node_modules;
  // @nivra/domain is inlined, since Node will not strip types from TypeScript under node_modules.
  external: [...prodDeps, ...prodDeps.map((name) => `${name}/*`)],
  metafile: true,
  logLevel: "warning",
  legalComments: "none",
});
const bundleText = readFileSync(join(bundleDir, "engine.mjs"), "utf8");
const bundleProblems: string[] = [];
if (bundleText.includes(repo)) bundleProblems.push(`engine.mjs contains a path into the repository (${repo})`);
if (/(?:from\s*|import\s*\(\s*)["']@nivra\//.test(bundleText)) bundleProblems.push("engine.mjs imports @nivra/domain, which should be inlined");
const bundleImports = new Set(
  Object.values(bundled.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external && !entry.path.startsWith("node:"))
    .map((entry) => (entry.path.startsWith("@") ? entry.path.split("/").slice(0, 2).join("/") : entry.path.split("/")[0]!)),
);
if (bundleProblems.length) throw new Error(`The engine bundle is wrong:\n${bundleProblems.map((p) => `  ✗ ${p}`).join("\n")}`);

for (const name of names) await stageTarget(TARGETS[name]!);
rmSync(bundleDir, { recursive: true, force: true });

// ---- per target ---------------------------------------------------------------------------------------------------

async function stageTarget(target: Target): Promise<void> {
  const stage = join(STAGE_ROOT, target.name);
  const engine = join(stage, "engine");
  const modules = join(engine, "node_modules");
  const npmOs = { linux: "linux", win: "win32", mac: "darwin" }[target.os];
  console.log(`\n━━ ${target.name} ━━`);

  step("Installing the engine's production dependencies from the lockfile (flat layout)");
  const workspace = mkdtempSync(join(tmpdir(), "nivra-stage-"));
  try {
    const rootManifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { pnpm?: Record<string, unknown> };
    rootManifest.pnpm = { ...rootManifest.pnpm, supportedArchitectures: { os: [npmOs], cpu: [target.arch], ...(target.os === "linux" ? { libc: ["glibc"] } : {}) } };
    writeFileSync(join(workspace, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
    for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) cpSync(join(repo, file), join(workspace, file));
    writeFileSync(join(workspace, ".npmrc"), "node-linker=hoisted\n");
    for (const group of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(repo, group))) {
        const manifest = join(repo, group, pkg, "package.json");
        if (!existsSync(manifest)) continue;
        mkdirSync(join(workspace, group, pkg), { recursive: true });
        cpSync(manifest, join(workspace, group, pkg, "package.json"));
      }
    }
    run("pnpm", ["install", "--frozen-lockfile", "--prod", "--ignore-scripts", "--filter", "@nivra/engine..."], { cwd: workspace });

    step(`Assembling ${relative(desktop, stage)}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(engine, { recursive: true });
    cpSync(join(bundleDir, "engine.mjs"), join(engine, "engine.mjs"));
    cpSync(join(engineDir, "src", "main.mjs"), join(engine, "main.mjs"));
    writeFileSync(join(engine, "package.json"), `${JSON.stringify({ name: "@nivra/engine-runtime", private: true, type: "module" }, null, 2)}\n`);
    cpSync(join(workspace, "node_modules"), modules, { recursive: true, verbatimSymlinks: true });
    const nested = join(workspace, "apps", "engine", "node_modules");
    if (existsSync(nested)) cpSync(nested, modules, { recursive: true, verbatimSymlinks: true, force: false });
    rmSync(join(modules, "@nivra"), { recursive: true, force: true });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  step("Pruning");
  rmSync(join(modules, ".bin"), { recursive: true, force: true });
  // pnpm's own bookkeeping holds timestamps and the temporary workspace's path: never part of a runtime.
  for (const entry of readdirSync(modules)) {
    if (entry === ".pnpm" || entry === ".modules.yaml" || entry.startsWith(".pnpm-workspace-state")) rmSync(join(modules, entry), { recursive: true, force: true });
  }
  walk(modules, (path, isDir) => {
    if (!isDir && /\.(map|d\.ts|d\.mts|d\.cts|ts|mts|cts)$/.test(path)) rmSync(path, { force: true });
  });
  if (target.os === "linux") {
    // The shipped Node is a glibc build, so musl variants are never loaded.
    for (const scope of readdirSync(modules).filter((entry) => entry.startsWith("@"))) {
      for (const pkg of readdirSync(join(modules, scope))) if (pkg.endsWith("-musl")) rmSync(join(modules, scope, pkg), { recursive: true, force: true });
    }
  }

  step("Checking that everything the bundle imports is installed");
  const missing = [...bundleImports].filter((pkg) => !existsSync(join(modules, pkg, "package.json")));
  if (missing.length) throw new Error(`The bundle imports packages that are not installed: ${missing.join(", ")}`);

  step("Checking that no build-machine path is left in the runtime");
  const leaks: string[] = [];
  walk(engine, (path, isDir) => {
    if (isDir || statSync(path).size > 2_000_000) return;
    const text = readFileSync(path, "latin1");
    if (text.includes(workspace) || text.includes(repo)) leaks.push(relative(stage, path));
  });
  if (leaks.length) throw new Error(`The runtime holds paths from this machine: ${leaks.slice(0, 10).join(", ")}`);

  step(`Adding Node ${NODE_VERSION} for ${target.name}`);
  const nodeDir = join(stage, "node");
  await addNode(target, nodeDir);

  if (target.os === "win") {
    step("Adding the Visual C++ runtime DLLs the native addons import (D6)");
    addVcRuntime(modules, nodeDir);
    step("Checking path lengths against Windows' MAX_PATH");
    let longest = "";
    walk(stage, (path) => {
      const rel = relative(stage, path);
      if (rel.length > longest.length) longest = rel;
    });
    if (WINDOWS_PREFIX_CHARS + longest.length > 259) throw new Error(`A staged path is too long for Windows once installed (${longest.length} + ${WINDOWS_PREFIX_CHARS} > 259): ${longest}`);
    console.log(`  longest path: ${longest.length} characters (+${WINDOWS_PREFIX_CHARS} for the install folder)`);
  }

  step("Writing the manifest");
  const { contentHash, sha256, files } = hashRuntime(stage);
  writeFileSync(
    join(engine, "manifest.json"),
    `${JSON.stringify({ contentHash, sha256, target: target.name, engineVersion: ENGINE_VERSION, protocolVersion: PROTOCOL_VERSION, node: NODE_VERSION, files }, null, 2)}\n`,
  );
  console.log(`  content hash ${contentHash} (${files} files)`);

  if (target.name === "linux-x64") {
    step("Packing the WSL tarball (deterministic)");
    const tarball = join(STAGE_ROOT, "runtime-linux-x64.tar.gz");
    await packTarball(stage, tarball);
    writeFileSync(join(STAGE_ROOT, "runtime-linux-x64.json"), `${JSON.stringify({ contentHash, tarball: "runtime-linux-x64.tar.gz" }, null, 2)}\n`);
    console.log(`  ${relative(repo, tarball)}: ${(statSync(tarball).size / 1_000_000).toFixed(1)} MB`);
  }

  if (target.name === hostTarget() && !values["skip-smoke"]) {
    step("Smoke test: self-check, then initialize and shut down over stdio");
    await smokeTest(stage, contentHash);
  } else if (target.name !== hostTarget()) {
    console.log(`\n(${target.name} is not this machine's target: verify it there, e.g. pnpm --filter @nivra/desktop verify:windows from WSL.)`);
  }
  console.log(`\n✓ Staged ${relative(repo, stage)}: engine ${size(engine)}, node ${size(nodeDir)}`);
}

// ---- helpers -----------------------------------------------------------------------------------------------------

async function addNode(target: Target, nodeDir: string): Promise<void> {
  const cache = join(homedir(), ".cache", "nivra-build");
  mkdirSync(cache, { recursive: true });
  const dist = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const nodeOs = { linux: "linux", win: "win", mac: "darwin" }[target.os];
  const archive = target.os === "win" ? `node-v${NODE_VERSION}-win-${target.arch}.zip` : `node-v${NODE_VERSION}-${nodeOs}-${target.arch}.tar.gz`;
  const sums = await download(`${dist}/SHASUMS256.txt`, join(cache, `SHASUMS256-${NODE_VERSION}.txt`));
  const expected = readFileSync(sums, "utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(/\s+/)[0];
  if (!expected) throw new Error(`${archive} is not listed in Node's SHASUMS256.txt`);
  const archivePath = await download(`${dist}/${archive}`, join(cache, archive));
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== expected) {
    rmSync(archivePath, { force: true });
    throw new Error(`${archive} does not match its published checksum (expected ${expected}, got ${actual})`);
  }
  mkdirSync(nodeDir, { recursive: true });
  const top = archive.replace(/\.(zip|tar\.gz)$/, "");
  if (target.os === "win") {
    const entries = unzip(readFileSync(archivePath), [`${top}/node.exe`, `${top}/LICENSE`]);
    writeFileSync(join(nodeDir, "node.exe"), entries.get(`${top}/node.exe`)!);
    writeFileSync(join(nodeDir, "LICENSE"), entries.get(`${top}/LICENSE`)!);
  } else {
    const unpack = mkdtempSync(join(tmpdir(), "nivra-node-"));
    try {
      run("tar", ["-xzf", archivePath, "-C", unpack, `${top}/bin/node`, `${top}/LICENSE`], { cwd: unpack });
      mkdirSync(join(nodeDir, "bin"), { recursive: true });
      cpSync(join(unpack, top, "bin", "node"), join(nodeDir, "bin", "node"));
      cpSync(join(unpack, top, "LICENSE"), join(nodeDir, "LICENSE"));
    } finally {
      rmSync(unpack, { recursive: true, force: true });
    }
  }
}

function addVcRuntime(modules: string, nodeDir: string): void {
  const needed = new Set<string>();
  walk(modules, (path, isDir) => {
    if (isDir || !path.endsWith(".node")) return;
    const text = readFileSync(path).toString("latin1").toLowerCase();
    for (const dll of VC_RUNTIME) if (text.includes(dll.toLowerCase())) needed.add(dll);
  });
  if (needed.size === 0) {
    console.log("  no native addon imports the Visual C++ runtime");
    return;
  }
  const from = values["vc-runtime-from"] ?? (process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32") : "/mnt/c/Windows/System32");
  const available = existsSync(from) ? readdirSync(from) : [];
  for (const dll of needed) {
    const found = available.find((file) => file.toLowerCase() === dll.toLowerCase());
    if (!found) {
      console.warn(`  ⚠ ${dll} is needed but not in ${from}: machines without the Visual C++ Redistributable will not load the storage driver.`);
      continue;
    }
    cpSync(join(from, found), join(nodeDir, dll.toLowerCase()));
    // System32 copies arrive read-only; an installer must be able to replace them.
    chmodSync(join(nodeDir, dll.toLowerCase()), 0o644);
    console.log(`  ${dll.toLowerCase()} (from ${from})`);
  }
}

/** A hash of every staged file but the manifest, by path and content: names the runtime's folder in WSL (D5). */
function hashRuntime(stage: string): { contentHash: string; sha256: string; files: number } {
  const paths: string[] = [];
  walk(stage, (path, isDir) => {
    if (!isDir) paths.push(path);
  });
  const hash = createHash("sha256");
  let files = 0;
  for (const path of paths.map((p) => relative(stage, p).split(sep).join("/")).sort()) {
    if (path === "engine/manifest.json") continue;
    const bytes = readFileSync(join(stage, path));
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
    files++;
  }
  const sha256 = hash.digest("hex");
  return { contentHash: sha256.slice(0, 16), sha256, files };
}

/** GNU tar with fixed order, times and owners, gzipped without a timestamp: the same files give the same bytes. */
async function packTarball(stage: string, tarball: string): Promise<void> {
  const tar = spawn("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "-", "-C", stage, "node", "engine"], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number | null>((done) => tar.once("exit", (code) => done(code)));
  await pipeline(tar.stdout, createGzip({ level: 9 }), createWriteStream(tarball));
  if ((await exited) !== 0) throw new Error("tar failed while packing the WSL runtime");
}

async function download(url: string, path: string): Promise<string> {
  if (existsSync(path)) return path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  writeFileSync(`${path}.part`, Buffer.from(await response.arrayBuffer()));
  cpSync(`${path}.part`, path);
  rmSync(`${path}.part`, { force: true });
  return path;
}

/** Reads the named entries of a zip archive (stored or deflated), from its central directory (from Hird). */
function unzip(zip: Buffer, wanted: readonly string[]): Map<string, Buffer> {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip archive");
  let at = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  const found = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    if (wanted.includes(name)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compressed);
      found.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  for (const name of wanted) if (!found.has(name)) throw new Error(`${name} is not in the archive`);
  return found;
}

function size(dir: string): string {
  let bytes = 0;
  walk(dir, (path, isDir) => {
    if (!isDir) bytes += statSync(path).size;
  });
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

async function smokeTest(stage: string, contentHash: string): Promise<void> {
  const node = process.platform === "win32" ? join(stage, "node", "node.exe") : join(stage, "node", "bin", "node");
  const entry = join(stage, "engine", "main.mjs");
  const check = spawnSync(node, [entry, "--self-check"], { encoding: "utf8", timeout: 60_000 });
  const line = check.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = EngineSelfCheck.safeParse((JSON.parse(line || "{}") as { params?: unknown }).params);
  if (check.status !== 0 || !parsed.success || parsed.data.runtimeHash !== contentHash) {
    throw new Error(`The staged engine failed its self-check (exit ${String(check.status)}):\n${check.stdout}\n${check.stderr}`);
  }
  console.log(`  self-check: Node ${parsed.data.node}, runtime ${parsed.data.runtimeHash}`);

  const home = mkdtempSync(join(tmpdir(), "nivra stage home ü%# "));
  const child = spawn(node, [entry, "--stdio", "--home", home, "--heartbeat-ms", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new RpcClient({ send: (text) => void child.stdin.write(text), defaultTimeoutMs: 60_000 });
  const splitter = new LineSplitter();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const text of splitter.push(chunk)) client.receive(text);
  });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  try {
    const info = await client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "stage-runtime", version: ENGINE_VERSION } });
    if (info.runtimeHash !== contentHash) throw new Error(`The engine reports runtime ${String(info.runtimeHash)}, not ${contentHash}`);
    console.log(`  initialize: engine ${info.engineVersion} on ${info.platform}/${info.arch}, home ${info.home}`);
    await client.call("shutdown", {});
    const code = await Promise.race([exited, new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 20_000))]);
    if (code !== 0) throw new Error(`The engine did not stop cleanly (${String(code)}):\n${stderr.slice(-2_000)}`);
    console.log("  stopped cleanly (exit 0)");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}

