import { GIT_ENV, GIT_PINS } from "../repo/git.ts";
import type { ExecutionSession } from "./backend.ts";

/**
 * The engine's own git, for snapshots and patches (NIV-42, D34). It runs through a session on the target (AGENTS.md:
 * code that runs commands goes through one), with input and byte output. It never reaches a remote, never fetches a
 * missing object lazily, and never follows replace refs, so the commit it reads is the commit its id names.
 */
export const GIT_SAFE_ENV: Readonly<Record<string, string>> = { ...GIT_ENV, GIT_ALLOW_PROTOCOL: "none", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1" };

/**
 * What kind of thing stopped a snapshot, a patch or a proposal. What leaves the engine is chosen by this code, from
 * Nivra's own words, never by a refusal's message, which can name paths in the repository.
 */
export type RefusalCode =
  /** git failed, ran out of time, or said more than Nivra reads. */
  | "git"
  | "git-version"
  /** A repository Nivra can't read safely: a partial clone, a split index, a filter it can't switch off. */
  | "repository"
  | "no-commits"
  | "baseline-moved"
  /** Tracked changes, or files git is told not to look at. */
  | "uncommitted"
  | "engine-home"
  /** A path Nivra won't send or write. */
  | "path"
  /** What looks like a credential. */
  | "content"
  | "nothing-to-send"
  | "limit"
  /** The collect step failed, or its files couldn't be read back. */
  | "collect"
  /** The sandbox's result isn't what it wrote, or can't be taken. */
  | "result"
  /** The change breaks a rule. */
  | "change"
  /** The patch couldn't be made or checked. */
  | "patch"
  /** A proposal that isn't intact, isn't the one approved, or isn't for here. */
  | "proposal";

/** Something stopped a snapshot or a patch, in words a person can act on. Nothing was sent anywhere. */
export class WorkspaceRefusal extends Error {
  readonly code: RefusalCode;
  /** What git or the sandbox printed, for the engine's own tests and checks. It never leaves the engine. */
  readonly detail: string | null;
  constructor(message: string, code: RefusalCode, detail: string | null = null) {
    super(message);
    this.name = "WorkspaceRefusal";
    this.code = code;
    this.detail = detail;
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
  /**
   * One deadline for a whole phase's git commands (a snapshot, a patch), on the monotonic clock unless `now` is given:
   * each command gets its own limit or the time left, whichever is less, so the phase never runs past it.
   */
  deadline?: PhaseDeadline | undefined;
}

export interface PhaseDeadline {
  at: number;
  /** The phase, for a refusal's words: "Building the patch". */
  what: string;
  now?: () => number;
}

/**
 * One git command, its output as bytes and text. A timeout, a cut-off output (refused with `tooBig` when given) or an
 * exit not in `okCodes` is a refusal. git's own words go in the refusal's `detail`, never its message.
 */
export async function runGitBytes(tool: GitTool, args: readonly string[], options: { stdin?: Uint8Array; timeoutMs?: number; maxBytes?: number; okCodes?: readonly number[]; tooBig?: { message: string; code: RefusalCode } } = {}): Promise<{ bytes: Uint8Array; text: string; exitCode: number }> {
  const own = options.timeoutMs ?? 60_000;
  const left = tool.deadline ? Math.floor(tool.deadline.at - (tool.deadline.now ?? (() => performance.now()))()) : Number.POSITIVE_INFINITY;
  const outOfTime = () => new WorkspaceRefusal(`${tool.deadline!.what} took longer than the time it's given, so it was stopped.`, "git");
  if (left < 1) throw outOfTime();
  const timeoutMs = Math.min(own, left);
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
  if (result.timedOut) throw timeoutMs < own ? outOfTime() : new WorkspaceRefusal(`${what} took longer than ${Math.round(timeoutMs / 1000)} s, so it was stopped.`, "git");
  if (result.truncated) throw options.tooBig ? new WorkspaceRefusal(options.tooBig.message, options.tooBig.code) : new WorkspaceRefusal(`${what} gave more than the ${maxBytes} bytes Nivra reads, so it was stopped.`, "git");
  const exitCode = result.exitCode ?? -1;
  if (exitCode !== 0 && !(options.okCodes ?? []).includes(exitCode)) {
    throw new WorkspaceRefusal(`${what} failed (exit ${String(result.exitCode)}).`, "git", result.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? null);
  }
  return { bytes: result.stdoutBytes ?? new Uint8Array(0), text: result.stdout, exitCode };
}
