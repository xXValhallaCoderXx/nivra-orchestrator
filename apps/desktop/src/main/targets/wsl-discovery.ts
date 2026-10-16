import { existsSync } from "node:fs";
import { join } from "node:path";
import { engineEnv, runTool, wslErrorCode, type RunResult } from "./process.ts";

export interface WslDistro {
  name: string;
  /** 1 or 2, from the registry; null when the registry does not say. */
  version: 1 | 2 | null;
  isDefault: boolean;
  /** The distribution's default user; 0 means root, usually a distribution never opened. */
  defaultUid: number | null;
  osVersion: string | null;
}

export type WslDiscovery =
  | { status: "ready"; wslExe: string; distros: WslDistro[] }
  | { status: "missing" | "inbox-only" | "broken"; message: string; distros: [] };

/** Names from `wsl --list --quiet`: one per line, already decoded. */
export function parseListQuiet(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

interface LxssEntry {
  name: string | null;
  version: 1 | 2 | null;
  defaultUid: number | null;
  osVersion: string | null;
}

/**
 * Reads `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss /s`. Value names and types are never
 * translated, unlike `wsl --list --verbose` (D10).
 */
export function parseLxssRegistry(text: string): { defaultGuid: string | null; entries: Map<string, LxssEntry> } {
  const entries = new Map<string, LxssEntry>();
  let defaultGuid: string | null = null;
  let current: LxssEntry | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("HKEY_")) {
      const guid = /\\Lxss\\(\{[0-9a-fA-F-]+\})$/.exec(line)?.[1];
      current = guid ? { name: null, version: null, defaultUid: null, osVersion: null } : null;
      if (guid && current) entries.set(guid.toLowerCase(), current);
      continue;
    }
    const value = /^\s+(\S+)\s+(REG_SZ|REG_DWORD|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (!value) continue;
    const [, name, type, data] = value as unknown as [string, string, string, string];
    const number = type === "REG_DWORD" ? Number.parseInt(data, 16) : Number.NaN;
    if (!current) {
      if (name === "DefaultDistribution") defaultGuid = data.trim().toLowerCase();
      continue;
    }
    if (name === "DistributionName") current.name = data.trim();
    else if (name === "Version" && (number === 1 || number === 2)) current.version = number;
    else if (name === "DefaultUid" && Number.isFinite(number)) current.defaultUid = number;
    else if (name === "OsVersion") current.osVersion = data.trim() || null;
  }
  return { defaultGuid, entries };
}

/** Distributions Nivra never offers: Docker Desktop's own are not for people's work. */
export const isHiddenDistro = (name: string): boolean => /^docker-desktop/i.test(name);

export function mergeDistros(names: readonly string[], registry: ReturnType<typeof parseLxssRegistry>): WslDistro[] {
  const byName = new Map<string, { guid: string; entry: LxssEntry }>();
  for (const [guid, entry] of registry.entries) if (entry.name) byName.set(entry.name.toLowerCase(), { guid, entry });
  return names
    .filter((name) => !isHiddenDistro(name))
    .map((name) => {
      const found = byName.get(name.toLowerCase());
      return {
        name,
        version: found?.entry.version ?? null,
        isDefault: Boolean(found && found.guid === registry.defaultGuid),
        defaultUid: found?.entry.defaultUid ?? null,
        osVersion: found?.entry.osVersion ?? null,
      };
    });
}

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  run?: (command: string, args: readonly string[]) => Promise<RunResult>;
}

/**
 * Which WSL distributions this Windows host can run an engine in (D10). WSL counts as present only when the Store WSL
 * (`%ProgramFiles%\WSL\wsl.exe`) is installed and answers `--version`: the `System32` stub alone may offer to install
 * WSL instead of running anything.
 */
export async function discoverWsl(options: DiscoverOptions = {}): Promise<WslDiscovery> {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  const wslExe = join(programFiles, "WSL", "wsl.exe");
  const toolEnv = engineEnv(env, "win32", { WSL_UTF8: "1" });
  const run = options.run ?? ((command, args) => runTool(command, args, { env: toolEnv, timeoutMs: 15_000 }));

  if (!exists(wslExe)) {
    return exists(join(systemRoot, "System32", "wsl.exe"))
      ? { status: "inbox-only", message: "This Windows has only the old built-in WSL. Run `wsl --update` in a terminal, then open Nivra again.", distros: [] }
      : { status: "missing", message: "WSL isn't installed. Run `wsl --install` in an administrator terminal, restart Windows, then open Nivra again.", distros: [] };
  }
  const version = await run(wslExe, ["--version"]).catch((error: unknown) => ({ code: null, signal: null, stdout: "", stderr: String(error), timedOut: false }) as RunResult);
  if (version.code !== 0) {
    const code = wslErrorCode(`${version.stdout}\n${version.stderr}`);
    return { status: "broken", message: `WSL didn't answer${code ? ` (${code})` : ""}. Run \`wsl --update\` in a terminal, then try again.`, distros: [] };
  }
  const list = await run(wslExe, ["--list", "--quiet"]);
  if (list.code !== 0) {
    // No distributions makes `--list` fail with a code rather than print an empty list.
    return { status: "ready", wslExe, distros: [] };
  }
  const registry = await run(join(systemRoot, "System32", "reg.exe"), ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s"]).catch(
    () => ({ code: 1, signal: null, stdout: "", stderr: "", timedOut: false }) as RunResult,
  );
  return { status: "ready", wslExe, distros: mergeDistros(parseListQuiet(list.stdout), parseLxssRegistry(registry.code === 0 ? registry.stdout : "")) };
}
