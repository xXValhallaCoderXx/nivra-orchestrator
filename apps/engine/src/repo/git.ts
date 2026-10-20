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

/** The git subcommands Nivra runs, which a refusal may name; any other reads as "command". */
const SUBCOMMANDS: ReadonlySet<string> = new Set(["ls-files", "grep", "rev-parse"]);

/**
 * Runs git read-only. A failure is refused in Nivra's own words (NIV-27): git's stderr can quote paths, remotes or
 * configuration, which masking known keys doesn't catch, so it is never kept; `hint` is fixed text that says what to try.
 */
export async function runGit(
  call: GitCall,
  args: readonly string[],
  options: { maxBytes?: number; timeoutMs?: number; okCodes?: readonly number[]; hint?: string } = {},
): Promise<{ stdout: string; truncated: boolean }> {
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
  const subcommand = SUBCOMMANDS.has(args[0] ?? "") ? args[0]! : "command";
  if (result.timedOut) throw new RepoError("git-timeout", `git ${subcommand} took longer than ${Math.round(timeoutMs / 1000)} s, so it was stopped.`);
  if (result.exitCode !== 0 && !(options.okCodes ?? []).includes(result.exitCode ?? -1)) {
    const exit = typeof result.exitCode === "number" ? `exit ${result.exitCode}` : "no exit code";
    throw new RepoError("git-failed", `git ${subcommand} failed (${exit}). ${options.hint ?? "Run git status in the project's folder to see what's wrong, then try again."}`);
  }
  return { stdout: result.stdout, truncated: result.truncated };
}
