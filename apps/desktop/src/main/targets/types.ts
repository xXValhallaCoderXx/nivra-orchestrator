/**
 * Execution targets (D1): where an engine runs. The host is always native; a target is either the host's own OS
 * (`local`) or a WSL2 distribution (`wsl:<distro>`). This folder and `supervisor.ts` import nothing from Electron
 * (D12), so `node --test` drives them on Windows, WSL and Linux before any window exists.
 */

export type TargetKind = "local" | "wsl";
export type EnginePlatform = "linux" | "win32" | "darwin";

export interface TargetDescriptor {
  /** "local", or "wsl:<distro>". */
  id: string;
  kind: TargetKind;
  /** What the person sees wherever work starts, e.g. "Ubuntu · WSL" (D1). */
  label: string;
  /** The engine's own operating system on this target. */
  platform: EnginePlatform;
  distro?: string;
}

export interface TargetProblem {
  code: string;
  /** A blocking problem stops the engine from starting; a warning is shown and the engine starts anyway. */
  severity: "blocking" | "warning";
  /** What happened and what to do, in words a person can act on. */
  message: string;
}

export interface TargetProbe {
  ok: boolean;
  problems: TargetProblem[];
  facts: Record<string, string | number | boolean | null>;
}

/** How to start an engine: a program and its arguments, never a shell command line (D9). */
export interface EngineLaunch {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  /** Where the engine keeps its data, in the target's own path form. */
  home: string;
  /** Removes anything left of this engine on the target once the process the host holds has gone (D4). */
  cleanup?: () => Promise<void>;
}

export interface LaunchRequest {
  instanceId: string;
  heartbeatMs: number;
  /** Install the runtime again even when one is there (after a protocol mismatch or a broken runtime). */
  reprovision?: boolean;
  onProgress?: (detail: string) => void;
}

export interface ExecutionTarget {
  readonly descriptor: TargetDescriptor;
  /** Checks whether the target can run an engine. Changes nothing. */
  probe(): Promise<TargetProbe>;
  /** Makes sure the target has this app's runtime (provisioning it if needed) and says how to start the engine. */
  prepare(request: LaunchRequest): Promise<EngineLaunch>;
}

/** The target cannot run an engine; `problems` says why. */
export class TargetUnavailableError extends Error {
  readonly problems: TargetProblem[];

  constructor(target: TargetDescriptor, problems: TargetProblem[]) {
    super(problems.filter((p) => p.severity === "blocking").map((p) => p.message).join(" ") || `${target.label} cannot run the engine.`);
    this.name = "TargetUnavailableError";
    this.problems = problems;
  }
}

/** Node flags every engine starts with: the OS's certificate store and the environment's proxy (B7). */
export const NODE_FLAGS = ["--use-system-ca", "--use-env-proxy"] as const;

/** The engine's own arguments (D3): configuration travels as arguments, never as environment variables. */
export function engineArgs(entry: string, home: string, request: Pick<LaunchRequest, "instanceId" | "heartbeatMs">): string[] {
  return [...NODE_FLAGS, entry, "--stdio", "--home", home, "--instance", request.instanceId, "--heartbeat-ms", String(request.heartbeatMs), "--nivra-engine"];
}

export const OS_LABEL: Record<EnginePlatform, string> = { win32: "Windows", linux: "Linux", darwin: "macOS" };
