import { GIT_ENV, GIT_PINS } from "../repo/git.ts";
import type { ExecutionSession } from "./backend.ts";

/**
 * The engine's own git, for snapshots and patches (NIV-42, D34). It runs through a session on the target (AGENTS.md:
 * code that runs commands goes through one), with input and byte output. It never reaches a remote, never fetches a
 * missing object lazily, and never follows replace refs, so the commit it reads is the commit its id names.
 */
export const GIT_SAFE_ENV: Readonly<Record<string, string>> = { ...GIT_ENV, GIT_ALLOW_PROTOCOL: "none", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1" };

/** Something stopped a snapshot or a patch, in words a person can act on. Nothing was sent anywhere. */
export class WorkspaceRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRefusal";
  }
}

/** The work was cancelled while git was running. */
export class WorkspaceCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "WorkspaceCancelled";
  }
}

export interface GitTool {
  session: ExecutionSession;
  /** The absolute path git was found at, never looked up in a repository (AGENTS.md). */
  git: string;
  cwd: string;
  /** More of the environment, on top of `GIT_SAFE_ENV`: an isolated configuration, say. */
  env?: Readonly<Record<string, string>>;
  /** `-c name=value` pairs, after the pins. */
  config?: readonly string[];
  signal?: AbortSignal | undefined;
}

/** One git command, its output as bytes and text. A timeout, a cut-off output or an exit not in `okCodes` is a refusal. */
export async function runGitBytes(tool: GitTool, args: readonly string[], options: { stdin?: Uint8Array; timeoutMs?: number; maxBytes?: number; okCodes?: readonly number[] } = {}): Promise<{ bytes: Uint8Array; text: string; exitCode: number }> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const result = await tool.session.exec({
    argv: [tool.git, ...GIT_PINS, ...(tool.config ?? []), ...args],
    cwd: tool.cwd,
    env: { ...GIT_SAFE_ENV, ...tool.env },
    timeoutMs,
    maxOutputBytes: maxBytes,
    output: "bytes",
    label: `git ${args[0] ?? ""}`,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(tool.signal ? { signal: tool.signal } : {}),
  });
  const what = `git ${args[0] ?? ""}`;
  if (result.cancelled) throw new WorkspaceCancelled();
  if (result.timedOut) throw new WorkspaceRefusal(`${what} took longer than ${Math.round(timeoutMs / 1000)} s, so it was stopped.`);
  if (result.truncated) throw new WorkspaceRefusal(`${what} gave more than the ${maxBytes} bytes Nivra reads, so it was stopped.`);
  const exitCode = result.exitCode ?? -1;
  if (exitCode !== 0 && !(options.okCodes ?? []).includes(exitCode)) {
    const said = result.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? "";
    throw new WorkspaceRefusal(`${what} failed (exit ${String(result.exitCode)})${said ? `: ${said}` : ""}.`);
  }
  return { bytes: result.stdoutBytes ?? new Uint8Array(0), text: result.stdout, exitCode };
}
