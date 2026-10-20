import { realpath, stat } from "node:fs/promises";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { HelloInput, type JsonObject, type Mask, type RunContext } from "@nivra/domain";
import { z } from "zod";
import { installGitAdvice } from "../advice.ts";
import type { ExecResult, ExecutionBackend } from "../exec/backend.ts";
import { Refusal } from "../diagnostics.ts";
import { guard } from "./guard.ts";
import { describePreferences } from "./preferences-record.ts";

export const HELLO_WORKFLOW_ID = "hello";

/** Where steps put what they found: the run's timeline (D2's run events). Steps pass ids and facts, never secrets. */
export interface StepRecorder {
  output(runId: string, stepId: string, message: string, data?: JsonObject): void;
  command(runId: string, stepId: string, phase: "started" | "finished", message: string, data?: JsonObject): void;
}

export interface HelloDeps {
  backend: ExecutionBackend;
  recorder: StepRecorder;
  engineInfo: () => JsonObject;
  findGit: () => string | null;
  /** The engine's own platform, for the "install git" advice. */
  platform: NodeJS.Platform;
  /** What the host sent with the run, held in memory by the scheduler (D21); null once the run has ended. */
  context: (runId: string) => RunContext | null;
  /** Known keys and credential shapes, masked in anything a failure says (NIV-27). */
  mask: Mask;
}

const GIT_CONFIG = ["-c", "color.ui=never", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false"];
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

const Repo = z.strictObject({ repo: z.string(), holdMs: z.number().int().min(0) });
const RepoWithGit = Repo.extend({ git: z.string() });
const RepoStatus = RepoWithGit.extend({ branch: z.string().nullable(), changes: z.number().int().nonnegative() });
export const HelloOutput = z.strictObject({ repo: z.string(), branch: z.string().nullable(), changes: z.number().int().nonnegative() });

/** What `git status --porcelain=v2 --branch` says about the branch and how many entries changed. */
export function parseStatus(output: string): { branch: string | null; upstream: string | null; ahead: number; behind: number; changes: number } {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line && !line.startsWith("#")) {
      changes++;
    }
  }
  return { branch, upstream, ahead, behind, changes };
}

async function run(backend: ExecutionBackend, workspace: string, argv: readonly [string, ...string[]], options: { timeoutMs: number; signal: AbortSignal; env?: Record<string, string> }): Promise<ExecResult> {
  const session = await backend.open({ workspace });
  try {
    return await session.exec({ argv, cwd: workspace, timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024, signal: options.signal, ...(options.env ? { env: options.env } : {}) });
  } finally {
    await session.close();
  }
}

export function createHelloWorkflow(deps: HelloDeps) {
  const { backend, recorder } = deps;

  const engineInfo = createStep({
    id: "engine-info",
    description: "Report where the engine runs",
    inputSchema: HelloInput,
    outputSchema: HelloInput,
    execute: async ({ inputData, runId }) => guard("hello.engine-info", deps.mask, async () => {
      const info = deps.engineInfo();
      recorder.output(runId, "engine-info", `Engine ${String(info["engineVersion"])} on ${String(info["platform"])}/${String(info["arch"])}, Node ${String(info["node"])}`, info);
      return inputData;
    }),
  });

  // The context never passes through Mastra: steps read it by run id, and only ids and a fingerprint are recorded.
  const context = createStep({
    id: "context",
    description: "Report the context the app sent with the run, without its text",
    inputSchema: HelloInput,
    outputSchema: HelloInput,
    execute: async ({ inputData, runId }) => guard("hello.context", deps.mask, async () => {
      const given = deps.context(runId);
      if (!given) throw new Refusal("context-missing", "This run's context is missing, so it stopped. Start it again.");
      const { message, data } = await describePreferences(given.preferences);
      recorder.output(runId, "context", message, data);
      return inputData;
    }),
  });

  const repository = createStep({
    id: "repository",
    description: "Resolve the repository folder on this target",
    inputSchema: HelloInput,
    outputSchema: Repo,
    execute: async ({ inputData, runId }) => guard("hello.repository", deps.mask, async () => {
      let resolved: string;
      try {
        resolved = await realpath(inputData.repoPath);
      } catch {
        // A failure says what happened in Nivra's own words, never with the path (NIV-27): the app knows the project.
        throw new Refusal("folder-missing", "The project's folder doesn't exist on this target. Check it is still there, or remove the project and add it again.");
      }
      if (!(await stat(resolved)).isDirectory()) throw new Refusal("not-a-folder", "The project's path isn't a folder on this target. Remove the project and add its folder again.");
      recorder.output(runId, "repository", `Repository folder: ${resolved}`, { requested: inputData.repoPath, resolved, engineCwd: process.cwd() });
      return { repo: resolved, holdMs: inputData.holdMs };
    }),
  });

  const gitVersion = createStep({
    id: "git-version",
    description: "Find git and read its version",
    inputSchema: Repo,
    outputSchema: RepoWithGit,
    execute: async ({ inputData, runId, abortSignal }) => guard("hello.git-version", deps.mask, async () => {
      const git = deps.findGit();
      if (!git) throw new Refusal("git-missing", `Git isn't installed on this target, or isn't on its PATH. ${installGitAdvice(deps.platform)}`);
      const result = await run(backend, inputData.repo, [git, "--version"], { timeoutMs: 10_000, signal: abortSignal });
      if (result.cancelled) throw new Refusal("cancelled", "Cancelled");
      if (result.exitCode !== 0) throw new Refusal("git-failed", `git --version failed (exit ${String(result.exitCode)}). Check the Git installation on this target, then try again.`);
      const version = result.stdout.trim();
      recorder.output(runId, "git-version", version, { path: git, version });
      return { ...inputData, git };
    }),
  });

  const gitStatus = createStep({
    id: "git-status",
    description: "Read the repository's branch and changes",
    inputSchema: RepoWithGit,
    outputSchema: RepoStatus,
    execute: async ({ inputData, runId, abortSignal }) => guard("hello.git-status", deps.mask, async () => {
      const { git, repo } = inputData;
      // Git's exit code decides, never its words: 0 inside a work tree, 128 outside one.
      const top = await run(backend, repo, [git, ...GIT_CONFIG, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000, signal: abortSignal, env: GIT_ENV });
      if (top.cancelled) throw new Refusal("cancelled", "Cancelled");
      if (top.exitCode !== 0) throw new Refusal("not-a-repository", "The project's folder is not inside a git repository. Run git init there, or add a folder that is a repository.");
      const status = await run(backend, repo, [git, ...GIT_CONFIG, "status", "--porcelain=v2", "--branch"], { timeoutMs: 30_000, signal: abortSignal, env: GIT_ENV });
      if (status.cancelled) throw new Refusal("cancelled", "Cancelled");
      if (status.exitCode !== 0) throw new Refusal("git-failed", `git status failed (exit ${String(status.exitCode)}). Run git status in the project's folder to see what's wrong, then try again.`);
      const parsed = parseStatus(status.stdout);
      const where = parsed.branch ? `on ${parsed.branch}` : "with a detached HEAD";
      recorder.output(runId, "git-status", `${where}, ${parsed.changes} changed ${parsed.changes === 1 ? "entry" : "entries"}`, {
        topLevel: top.stdout.trim(),
        ...parsed,
        truncated: status.truncated,
      });
      return { ...inputData, branch: parsed.branch, changes: parsed.changes };
    }),
  });

  const hold = createStep({
    id: "hold",
    description: "Hold a child process, so cancellation can be seen to stop it",
    inputSchema: RepoStatus,
    outputSchema: HelloOutput,
    execute: async ({ inputData, runId, abortSignal }) => guard("hello.hold", deps.mask, async () => {
      const result = { repo: inputData.repo, branch: inputData.branch, changes: inputData.changes };
      if (inputData.holdMs === 0) return result;
      const argv = [process.execPath, "-e", "setTimeout(() => {}, Number(process.argv[1]))", String(inputData.holdMs), "--nivra-hold"] as const;
      const session = await backend.open({ workspace: inputData.repo });
      try {
        const outcome = await session.exec({
          argv,
          cwd: inputData.repo,
          timeoutMs: inputData.holdMs + 10_000,
          maxOutputBytes: 4_096,
          signal: abortSignal,
          onStart: ({ pid }) => recorder.command(runId, "hold", "started", `Holding a child process for ${inputData.holdMs} ms`, { pid, holdMs: inputData.holdMs }),
        });
        recorder.command(runId, "hold", "finished", outcome.cancelled ? "The child process was stopped" : `The child process exited (${String(outcome.exitCode)})`, {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          cancelled: outcome.cancelled,
          durationMs: outcome.durationMs,
        });
        if (outcome.cancelled) throw new Refusal("cancelled", "Cancelled");
      } finally {
        await session.close();
      }
      return result;
    }),
  });

  return createWorkflow({
    id: HELLO_WORKFLOW_ID,
    description: "Reports the engine, the repository and git, without changing anything",
    inputSchema: HelloInput,
    outputSchema: HelloOutput,
    // Recovery belongs to the run scheduler: a run interrupted by a restart is marked failed, never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(engineInfo)
    .then(context)
    .then(repository)
    .then(gitVersion)
    .then(gitStatus)
    .then(hold)
    .commit();
}
