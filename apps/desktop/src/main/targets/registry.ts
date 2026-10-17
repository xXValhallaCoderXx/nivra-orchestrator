import { LocalTarget, type RuntimeLayout } from "./local.ts";
import type { EnginePlatform, ExecutionTarget } from "./types.ts";
import { discoverWsl, type WslDiscovery } from "./wsl-discovery.ts";
import { WslTarget, type WslRuntime } from "./wsl.ts";

export interface TargetSources {
  platform: EnginePlatform;
  env?: NodeJS.ProcessEnv;
  /** The runtime for the host's own OS, and the engine home it uses. */
  local: { runtime: RuntimeLayout; home: string; extraArgs?: readonly string[] };
  /** The Linux runtime streamed into WSL distributions (Windows hosts only). */
  wslRuntime: WslRuntime | null;
  discover?: () => Promise<WslDiscovery>;
}

/** What WSL discovery found, and a target for each distribution it lists. */
export interface WslTargets {
  discovery: WslDiscovery;
  targets: ExecutionTarget[];
}

/**
 * Where engines can run on this host (D17). There is no preferred target: a project's folder decides which one it
 * uses, so the factory only builds them. The host's own OS is always there; WSL's distributions are found on demand.
 */
export interface TargetFactory {
  readonly local: ExecutionTarget;
  /** WSL's distributions as targets, from a fresh discovery. Null off Windows; never rejects. */
  discoverWsl(): Promise<WslTargets | null>;
}

export function targetFactory(sources: TargetSources): TargetFactory {
  const env = sources.env ? { env: sources.env } : {};
  const local = new LocalTarget({
    platform: sources.platform,
    runtime: sources.local.runtime,
    home: sources.local.home,
    ...env,
    ...(sources.local.extraArgs ? { extraArgs: sources.local.extraArgs } : {}),
  });
  return {
    local,
    async discoverWsl() {
      if (sources.platform !== "win32") return null;
      let discovery: WslDiscovery;
      try {
        discovery = await (sources.discover ?? (() => discoverWsl(env)))();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        discovery = { status: "broken", code: null, message: `Nivra couldn't check WSL (${detail}). Press Check again; if it keeps failing, run \`wsl --update\` in a terminal.`, distros: [] };
      }
      if (discovery.status !== "ready") return { discovery, targets: [] };
      // WSL 1 distributions get a target too: its probe refuses them with the fix, rather than hiding them.
      const { wslExe } = discovery;
      return { discovery, targets: discovery.distros.map((distro) => new WslTarget({ distro, wslExe, runtime: sources.wslRuntime, ...env })) };
    },
  };
}
