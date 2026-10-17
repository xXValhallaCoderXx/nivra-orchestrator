import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engineEnv } from "./process.ts";
import { engineArgs, labelFor, TargetUnavailableError, type EngineLaunch, type EnginePlatform, type ExecutionTarget, type LaunchRequest, type TargetProbe } from "./types.ts";

/** Where a runtime's Node and engine entry are (D5): `<dir>/node/node.exe` or `<dir>/node/bin/node`, `<dir>/engine/main.mjs`. */
export interface RuntimeLayout {
  node: string;
  entry: string;
  /** The staged runtime's content hash; null when running the engine from source. */
  runtimeHash: string | null;
}

export function runtimeIn(dir: string, platform: NodeJS.Platform): RuntimeLayout {
  let runtimeHash: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "engine", "manifest.json"), "utf8")) as { contentHash?: unknown };
    runtimeHash = typeof manifest.contentHash === "string" ? manifest.contentHash : null;
  } catch {
    runtimeHash = null;
  }
  return {
    node: platform === "win32" ? join(dir, "node", "node.exe") : join(dir, "node", "bin", "node"),
    entry: join(dir, "engine", "main.mjs"),
    runtimeHash,
  };
}

export interface LocalTargetOptions {
  platform: EnginePlatform;
  runtime: RuntimeLayout;
  /** The engine's data folder (D7): `~/.nivra`, `%LOCALAPPDATA%\Nivra\engine`, or a development or test folder. */
  home: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** Tests only: more engine arguments, such as a loopback stub of Token Factory (D22). */
  extraArgs?: readonly string[];
}

/** The host's own OS as a target: the engine runs on the Node shipped with the app (D5). */
export class LocalTarget implements ExecutionTarget {
  readonly descriptor;
  readonly #options: LocalTargetOptions;

  constructor(options: LocalTargetOptions) {
    this.#options = options;
    this.descriptor = { id: "local", kind: "local" as const, label: labelFor("local", options.platform), platform: options.platform };
  }

  async probe(): Promise<TargetProbe> {
    const exists = this.#options.exists ?? existsSync;
    const { node, entry, runtimeHash } = this.#options.runtime;
    const missing = [node, entry].filter((path) => !exists(path));
    return {
      ok: missing.length === 0,
      problems: missing.length
        ? [{ code: "runtime-missing", severity: "blocking", message: `The engine runtime is missing from this installation (${missing.join(", ")}). Reinstall Nivra.` }]
        : [],
      facts: { node, entry, runtimeHash, home: this.#options.home },
    };
  }

  async prepare(request: LaunchRequest): Promise<EngineLaunch> {
    const probe = await this.probe();
    if (!probe.ok) throw new TargetUnavailableError(this.descriptor, probe.problems);
    const { home, runtime, platform } = this.#options;
    mkdirSync(home, { recursive: true });
    return {
      command: runtime.node,
      args: [...engineArgs(runtime.entry, home, request), ...(this.#options.extraArgs ?? [])],
      cwd: home,
      env: engineEnv(this.#options.env ?? process.env, platform),
      home,
    };
  }
}
