import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { after, describe, it } from "node:test";
import { hashRuntime, misplacedVcRuntime, PACKAGER_SKIPS, placeVcRuntime, renameDllImport, vcRuntimeAddons, vcRuntimeNames } from "../scripts/runtime-files.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Bytes standing in for a binary that names these DLLs, as an import table holds them. */
const binary = (...names: string[]) => Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), ...names.map((name) => Buffer.from(`\0${name}\0`, "latin1")), Buffer.from([0xff, 0xfe])]);
const LIBSQL = "engine/node_modules/@libsql/win32-x64-msvc";
const OTHER = "engine/node_modules/other/build";

/** A Windows runtime as staging leaves it before the DLLs are placed, and a System32 to take them from. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nivra runtime ü%# "));
  dirs.push(root);
  const stage = join(root, "win-x64");
  const system32 = join(root, "System32");
  for (const dir of ["node", LIBSQL, OTHER]) mkdirSync(join(stage, dir), { recursive: true });
  mkdirSync(system32);
  writeFileSync(join(stage, "node", "node.exe"), binary("KERNEL32.dll", "WS2_32.dll"));
  writeFileSync(join(stage, LIBSQL, "index.node"), binary("VCRUNTIME140.dll", "api-ms-win-crt-heap-l1-1-0.dll", "KERNEL32.dll"));
  writeFileSync(join(stage, OTHER, "addon.node"), binary("MSVCP140.dll", "KERNEL32.dll"));
  writeFileSync(join(system32, "vcruntime140.dll"), binary("VCRUNTIME140.dll", "KERNEL32.dll"));
  writeFileSync(join(system32, "MSVCP140.dll"), binary("MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll"));
  writeFileSync(join(system32, "VCRUNTIME140_1.dll"), binary("VCRUNTIME140_1.dll", "VCRUNTIME140.dll"));
  chmodSync(join(system32, "vcruntime140.dll"), 0o444);
  return { stage, system32 };
}

describe("what the packager skips in the runtime (NIV-35)", () => {
  it("is exactly what electron-builder's own walk skips when it copies extra resources, at any depth", async () => {
    // undici 7.29.1 ships an empty lib/llhttp/.gitkeep, which electron-builder left out of candidate 3's first build.
    const fromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder"));
    const { walk } = fromBuilder("builder-util") as { walk: (dir: string) => Promise<string[]> };
    const root = mkdtempSync(join(tmpdir(), "nivra packager skips "));
    try {
      const names = [".gitkeep", ".DS_Store", ".npmignore", ".eslintrc", ".travis.yml", "index.js", "README.md", "llhttp.wasm"];
      for (const folder of ["lib", ".github"]) mkdirSync(join(root, "pkg", folder), { recursive: true });
      for (const name of names) writeFileSync(join(root, "pkg", name), "");
      writeFileSync(join(root, "pkg", "lib", ".gitkeep"), "");
      writeFileSync(join(root, "pkg", ".github", "ci.yml"), "");
      const all = [...names.map((name) => `pkg/${name}`), "pkg/lib/.gitkeep", "pkg/.github/ci.yml"];
      const copied = (await walk(root)).map((path) => relative(root, path).split(sep).join("/")).sort();
      assert.deepEqual(copied, all.filter((path) => !PACKAGER_SKIPS.has(path.split("/").at(-1)!)).sort());
      assert.deepEqual([...PACKAGER_SKIPS].sort(), [".DS_Store", ".gitkeep"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the Visual C++ runtime beside native addons (D25)", () => {
  it("finds the runtime DLLs a binary names, in any case, telling vcruntime140.dll from vcruntime140_1.dll", () => {
    assert.deepEqual(vcRuntimeNames(binary("VCRUNTIME140_1.dll", "KERNEL32.dll", "msvcp140.DLL")), ["msvcp140.dll", "vcruntime140_1.dll"]);
    assert.deepEqual(vcRuntimeNames(binary("VCRUNTIME140.dll", "VCRUNTIME140.dll")), ["vcruntime140.dll"]);
    assert.deepEqual(vcRuntimeNames(binary("KERNEL32.dll", "api-ms-win-crt-heap-l1-1-0.dll")), []);
  });

  it("copies each DLL an addon needs into the addon's own folder, with the ones those need, byte for byte and writable", () => {
    const { stage, system32 } = setup();
    assert.equal(vcRuntimeAddons(stage).length, 2);
    const { placed, missing } = placeVcRuntime(stage, system32);
    assert.deepEqual(missing, []);
    assert.deepEqual(placed, [`${LIBSQL}/vcruntime140.dll`, `${OTHER}/msvcp140.dll`, `${OTHER}/vcruntime140.dll`, `${OTHER}/vcruntime140_1.dll`]);
    assert.equal(existsSync(join(stage, "node", "vcruntime140.dll")), false);
    assert.ok(readFileSync(join(stage, LIBSQL, "vcruntime140.dll")).equals(readFileSync(join(system32, "vcruntime140.dll"))));
    assert.equal(statSync(join(stage, LIBSQL, "vcruntime140.dll")).mode & 0o777, 0o644);
    assert.deepEqual(misplacedVcRuntime(stage), []);
  });

  it("reports the names the source folder lacks, and places the rest", () => {
    const { stage, system32 } = setup();
    rmSync(join(system32, "MSVCP140.dll"));
    const { placed, missing } = placeVcRuntime(stage, system32);
    assert.deepEqual(missing, ["msvcp140.dll"]);
    assert.deepEqual(placed, [`${LIBSQL}/vcruntime140.dll`]);
    assert.deepEqual(misplacedVcRuntime(stage), [`${OTHER}/addon.node needs msvcp140.dll beside it`]);
  });

  it("finds v0.1.0's layout, with the DLL next to node.exe instead, misplaced", () => {
    const { stage, system32 } = setup();
    rmSync(join(stage, "engine", "node_modules", "other"), { recursive: true });
    writeFileSync(join(stage, "node", "vcruntime140.dll"), readFileSync(join(system32, "vcruntime140.dll")));
    assert.deepEqual(misplacedVcRuntime(stage), [`${LIBSQL}/index.node needs vcruntime140.dll beside it`]);
  });

  it("counts the placed DLLs in the runtime's content hash, which leaves out only the manifest", () => {
    const { stage, system32 } = setup();
    const before = hashRuntime(stage);
    placeVcRuntime(stage, system32);
    const placed = hashRuntime(stage);
    assert.equal(placed.files, before.files + 4);
    assert.notEqual(placed.sha256, before.sha256);
    writeFileSync(join(stage, "engine", "manifest.json"), "{}\n");
    assert.equal(hashRuntime(stage).sha256, placed.sha256);
  });

  it("hashes by path and content exactly as before, so an unchanged runtime keeps its name in WSL (D5)", () => {
    const root = mkdtempSync(join(tmpdir(), "nivra runtime hash "));
    dirs.push(root);
    mkdirSync(join(root, "engine"));
    mkdirSync(join(root, "node"));
    writeFileSync(join(root, "engine", "a.txt"), "a");
    writeFileSync(join(root, "node", "b"), "bb");
    writeFileSync(join(root, "engine", "manifest.json"), "{}\n");
    assert.deepEqual(hashRuntime(root), { contentHash: "9bb3ba207459b38a", sha256: "9bb3ba207459b38aea4244852073b83b92e4a2f627f00ad4551c9de751c97589", files: 2 });
  });

  it("renames a DLL import to a name as long, everywhere and in any case, in a copy of the bytes", () => {
    const bytes = binary("VCRUNTIME140.dll", "vcruntime140.dll", "VCRUNTIME140_1.dll");
    const renamed = renameDllImport(bytes, "vcruntime140.dll", "nivr0time140.dll");
    assert.equal(renamed.length, bytes.length);
    assert.deepEqual(vcRuntimeNames(renamed), ["vcruntime140_1.dll"]);
    assert.equal(renamed.toString("latin1").split("nivr0time140.dll").length - 1, 2);
    assert.deepEqual(vcRuntimeNames(bytes), ["vcruntime140.dll", "vcruntime140_1.dll"]);
    assert.throws(() => renameDllImport(bytes, "vcruntime140.dll", "short.dll"), /isn't as long/);
    assert.throws(() => renameDllImport(bytes, "msvcp140.dll", "nivr0140.dll"), /isn't named/);
  });
});
