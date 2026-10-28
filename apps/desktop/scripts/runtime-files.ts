// What a staged engine runtime holds (D5, D25): the content hash that names it, and the Visual C++ runtime DLLs its
// Windows native addons need beside them. Shared by staging, the release candidate and the Windows harness.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

/**
 * The names electron-builder never copies into extra resources, where the runtime goes: builder-util's own walk skips
 * them at every depth (26.15.3). Its longer lists for the app's own files (`excludedNames`, `excludedExts`) don't apply
 * there. Staging leaves out the same, so the runtime staged is the runtime packaged, file for file, as the release
 * candidate checks (NIV-35: undici 7.29.1 ships an empty `lib/llhttp/.gitkeep`). A test copies a folder through the
 * packager's own walk to keep this so.
 */
export const PACKAGER_SKIPS: ReadonlySet<string> = new Set([".DS_Store", ".gitkeep"]);

/** A DLL of the Visual C++ 2015–2022 runtime, by file name. */
export const VC_RUNTIME_DLL = /^(?:vcruntime|msvcp|concrt|vcomp|vccorlib)140[a-z0-9_]*\.dll$/i;
const VC_RUNTIME_NAME = /(?:vcruntime|msvcp|concrt|vcomp|vccorlib)140[a-z0-9_]*\.dll/gi;

/** Every file under `dir`, as absolute paths, in no particular order. */
export function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]));
}

const posix = (root: string, path: string) => relative(root, path).split(sep).join("/");

/** A hash of every file but the manifest, by path and content: names the runtime's folder in WSL (D5). */
export function hashRuntime(root: string): { contentHash: string; sha256: string; files: number } {
  const hash = createHash("sha256");
  let files = 0;
  for (const path of filesIn(root).map((file) => posix(root, file)).sort()) {
    if (path === "engine/manifest.json") continue;
    const bytes = readFileSync(join(root, path));
    hash.update(`${path}\0${bytes.length}\0`);
    hash.update(bytes);
    files++;
  }
  const sha256 = hash.digest("hex");
  return { contentHash: sha256.slice(0, 16), sha256, files };
}

/**
 * The Visual C++ runtime DLLs a binary names, lower-cased and sorted. A name anywhere in the file counts, so this may
 * over-count: shipping a DLL nothing loads costs only its size.
 */
export function vcRuntimeNames(bytes: Buffer): string[] {
  return [...new Set(bytes.toString("latin1").match(VC_RUNTIME_NAME)?.map((name) => name.toLowerCase()) ?? [])].sort();
}

/** Each native addon under `root` that names a Visual C++ runtime DLL, with the names. */
export function vcRuntimeAddons(root: string): Array<{ addon: string; names: string[] }> {
  return filesIn(root)
    .filter((path) => path.endsWith(".node"))
    .map((addon) => ({ addon, names: vcRuntimeNames(readFileSync(addon)) }))
    .filter((entry) => entry.names.length > 0);
}

/**
 * Copies each Visual C++ runtime DLL a native addon names into the addon's own folder, with the ones those DLLs name in
 * turn, byte for byte from `from` (D25). That folder is where Windows looks: Node loads an addon with
 * LOAD_WITH_ALTERED_SEARCH_PATH, which searches the addon's folder, the system folders, the working directory and
 * `Path`, never node.exe's folder. Returns the DLLs beside addons, relative to `root`, and the names `from` lacks.
 */
export function placeVcRuntime(root: string, from: string): { placed: string[]; missing: string[] } {
  const available = new Map((existsSync(from) ? readdirSync(from) : []).map((file) => [file.toLowerCase(), file] as const));
  const placed = new Set<string>();
  const missing = new Set<string>();
  for (const { addon, names } of vcRuntimeAddons(root)) {
    const needed = new Set(names);
    for (const name of needed) {
      const file = available.get(name);
      if (!file) {
        missing.add(name);
        continue;
      }
      for (const more of vcRuntimeNames(readFileSync(join(from, file)))) needed.add(more);
      const copy = join(dirname(addon), name);
      if (!existsSync(copy)) {
        cpSync(join(from, file), copy);
        // System32 copies arrive read-only; an installer must be able to replace them.
        chmodSync(copy, 0o644);
      }
      placed.add(posix(root, copy));
    }
  }
  return { placed: [...placed].sort(), missing: [...missing].sort() };
}

/**
 * Native addons, and Visual C++ runtime DLLs, that name a Visual C++ runtime DLL their own folder lacks. A copy anywhere
 * else in the runtime doesn't count: Windows wouldn't look there (see placeVcRuntime).
 */
export function misplacedVcRuntime(root: string): string[] {
  const problems: string[] = [];
  for (const path of filesIn(root)) {
    const file = basename(path).toLowerCase();
    if (!file.endsWith(".node") && !VC_RUNTIME_DLL.test(file)) continue;
    const beside = new Set(readdirSync(dirname(path)).map((entry) => entry.toLowerCase()));
    for (const name of vcRuntimeNames(readFileSync(path))) {
      if (name !== file && !beside.has(name)) problems.push(`${posix(root, path)} needs ${name} beside it`);
    }
  }
  return problems.sort();
}

/**
 * `bytes` with every occurrence of the DLL name `from`, in any case, replaced by `to`, which must be as long. Only for
 * the Windows harness's controlled check on a copy of a runtime: shipped files are never changed.
 */
export function renameDllImport(bytes: Buffer, from: string, to: string): Buffer {
  if (to.length !== from.length) throw new Error(`${to} isn't as long as ${from}`);
  const text = bytes.toString("latin1").toLowerCase();
  const needle = from.toLowerCase();
  const renamed = Buffer.from(bytes);
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    renamed.write(to, at, "latin1");
    count++;
  }
  if (count === 0) throw new Error(`${from} isn't named in this file`);
  return renamed;
}
