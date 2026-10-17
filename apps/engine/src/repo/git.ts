import type { ExecutionSession } from "../exec/backend.ts";
import { RepoError } from "./paths.ts";

/**
 * Git, for reading a repository, through the run's execution session (D9, D22). Every call pins the configuration a
 * repository or user could otherwise change: no colour, no quoting, no fsmonitor, no search outside the work tree,
 * paths relative to the picked folder (`grep.fullName=false`), and no descent into submodules (`submodule.recurse`).
 * Inherited `GIT_*` variables are already gone (`childEnv`).
 */
export const GIT_PINS: readonly string[] = [
  "-c",
  "color.ui=never",
  "-c",
  "core.quotePath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "grep.fallbackToNoIndex=false",
  "-c",
  "grep.fullName=false",
  "-c",
  "submodule.recurse=false",
];
export const GIT_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

/** The person cancelled while git was running. */
export class RepoCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "RepoCancelled";
  }
}

export interface GitCall {
  session: ExecutionSession;
  git: string;
  cwd: string;
  signal?: AbortSignal | undefined;
}

export async function runGit(call: GitCall, args: readonly string[], options: { maxBytes?: number; timeoutMs?: number; okCodes?: readonly number[] } = {}): Promise<{ stdout: string; truncated: boolean }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const result = await call.session.exec({
    argv: [call.git, ...GIT_PINS, ...args],
    cwd: call.cwd,
    env: GIT_ENV,
    timeoutMs,
    maxOutputBytes: options.maxBytes ?? 2_000_000,
    ...(call.signal ? { signal: call.signal } : {}),
  });
  if (result.cancelled) throw new RepoCancelled();
  if (result.timedOut) throw new RepoError(`git ${args[0] ?? ""} took longer than ${Math.round(timeoutMs / 1000)} s, so it was stopped.`);
  if (result.exitCode !== 0 && !(options.okCodes ?? []).includes(result.exitCode ?? -1)) {
    const said = result.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? "";
    throw new RepoError(`git ${args[0] ?? ""} failed (exit ${String(result.exitCode)})${said ? `: ${said}` : ""}.`);
  }
  return { stdout: result.stdout, truncated: result.truncated };
}
