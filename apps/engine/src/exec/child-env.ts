import { release } from "node:os";
import { PROVIDER_ENV_VARS } from "../secrets/vault.ts";

/** Windows needs these in a child's environment; networking and temp files break without some of them. */
export const WINDOWS_ESSENTIALS = ["SystemRoot", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ComSpec", "PATHEXT"] as const;

export interface ChildEnvOptions {
  platform?: NodeJS.Platform;
  /** Drop `/mnt/<drive>/…` entries from PATH: Windows programs leaking into WSL's PATH must not run as tools. */
  stripWindowsPaths?: boolean;
}

/** Whether this process runs inside WSL. */
export function insideWsl(env: NodeJS.ProcessEnv = process.env, kernelRelease: string = release()): boolean {
  return Boolean(env["WSL_DISTRO_NAME"] || env["WSL_INTEROP"]) || /microsoft/i.test(kernelRelease);
}

/**
 * The environment a command starts with (D9): the engine's own, without provider keys, Electron's variables or
 * NODE_OPTIONS; exactly one PATH key (`Path` on Windows, `PATH` elsewhere); Windows' essentials never removed.
 */
export function childEnv(base: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>> = {}, options: ChildEnvOptions = {}): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const env: Record<string, string> = {};
  let path: string | undefined;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "path") {
      path ??= value || undefined;
      continue;
    }
    if (key === "NODE_OPTIONS" || key.startsWith("ELECTRON_") || (PROVIDER_ENV_VARS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key.toLowerCase() === "path") path = value;
    else env[key] = value;
  }
  if (path !== undefined) {
    const separator = platform === "win32" ? ";" : ":";
    const entries = path.split(separator).filter((entry) => entry && !(options.stripWindowsPaths && /^\/mnt\/[a-z](\/|$)/i.test(entry)));
    env[platform === "win32" ? "Path" : "PATH"] = entries.join(separator);
  }
  return env;
}
