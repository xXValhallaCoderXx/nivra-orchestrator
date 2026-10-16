import { LocalTarget, type RuntimeLayout } from "./local.ts";
import type { EnginePlatform, ExecutionTarget } from "./types.ts";
import { discoverWsl, type WslDiscovery } from "./wsl-discovery.ts";
import { WslTarget, type WslRuntime } from "./wsl.ts";

export interface TargetSources {
  platform: EnginePlatform;
  env?: NodeJS.ProcessEnv;
  /** The runtime for the host's own OS, and the engine home it uses. */
  local: { runtime: RuntimeLayout; home: string };
  /** The Linux runtime streamed into WSL distributions (Windows hosts only). */
  wslRuntime: WslRuntime | null;
  discover?: () => Promise<WslDiscovery>;
}

export interface TargetList {
  targets: ExecutionTarget[];
  /** What WSL discovery found on a Windows host; null elsewhere. */
  wsl: WslDiscovery | null;
  /** The target to preselect: WSL's default distribution when there is one, else the host itself. */
  preferred: string;
}

/** Every target this host offers: itself, plus each usable WSL distribution on Windows (D1, D10). */
export async function listTargets(sources: TargetSources): Promise<TargetList> {
  const local = new LocalTarget({ platform: sources.platform, runtime: sources.local.runtime, home: sources.local.home, ...(sources.env ? { env: sources.env } : {}) });
  if (sources.platform !== "win32") return { targets: [local], wsl: null, preferred: local.descriptor.id };
  const wsl = await (sources.discover ?? (() => discoverWsl(sources.env ? { env: sources.env } : {})))();
  const targets: ExecutionTarget[] = [local];
  let preferred = local.descriptor.id;
  if (wsl.status === "ready") {
    for (const distro of wsl.distros) {
      const target = new WslTarget({ distro, wslExe: wsl.wslExe, runtime: sources.wslRuntime, ...(sources.env ? { env: sources.env } : {}) });
      targets.push(target);
      if (distro.isDefault && distro.version !== 1) preferred = target.descriptor.id;
    }
  }
  return { targets, wsl, preferred };
}
