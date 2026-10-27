import { randomUUID } from "node:crypto";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import type { ExecutionSession } from "../src/exec/backend.ts";
import type { Transport } from "../src/exec/nebius/api.ts";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { createModelClient } from "../src/providers/model.ts";
import { policyFor } from "../src/providers/policy.ts";
import { operationsForBrief, runWorker, type TaskBrief, type WorkerRun } from "../src/task/worker.ts";
import { TASK_BRIEF, TASK_FIX, TASK_FIXTURE } from "../scripts/task-fixture.ts";
import { clock } from "./fake-sandboxes.ts";
import { RealGuest } from "./real-guest.ts";
import { changedSince, folderState, GIT, localSession, repoWith, scratch, snap } from "./workspace-fixtures.ts";

/**
 * A task attempt for the worker's tests (NIV-7, D39): the fixture repository, the production session and prescribed
 * path against the fake Nebius service with a guest that really runs each command, and a model stand-in that calls the
 * worker's tools in a set order. Nothing here reaches a network or a real model.
 */

export const KEY = "nebius-test-key-0123456789";
export const PROJECT = "project-e00test0000000000";
export const MODEL = "nvidia/nemotron-3-super-120b-a12b";

/** The fixture (`scripts/task-fixture.ts`): greet with no name prints "Hello, " instead of "Hello, world". */
export const FIXTURE: Record<string, string> = Object.fromEntries(TASK_FIXTURE.map((file) => [file.path, String(file.bytes)]));
export const BRIEF: TaskBrief = TASK_BRIEF;
export const FIX = TASK_FIX;

export type Call = [tool: string, input: Record<string, unknown>];
/** One model response: one tool call, or several in one step. */
export type Step = Call | Call[];
type Generated = { content: unknown[]; finishReason: string; usage: Record<string, number>; warnings: unknown[] };
const calling = (step: Step, index: number): Generated => ({
  content: (typeof step[0] === "string" ? [step as Call] : (step as Call[])).map(([tool, input], at) => ({ type: "tool-call", toolCallId: `call-${index}-${at}`, toolName: tool, input: JSON.stringify(input) })),
  finishReason: "tool-calls",
  usage: { inputTokens: 3_000, outputTokens: 200, totalTokens: 3_200 },
  warnings: [],
});

export interface Attempt {
  calls?: Step[];
  /** Wraps the fake service's transport, to watch or change requests. */
  wrap?: (transport: Transport, guest: RealGuest) => Transport;
  brief?: TaskBrief;
  files?: Record<string, string>;
  setup?: (guest: RealGuest) => void;
  extra?: Partial<WorkerRun>;
  signal?: AbortSignal;
  /** Runs before each model request, with the request's index. */
  beforeRequest?: (index: number) => void;
  /** The clock the session and the worker read; a new one unless given. */
  time?: ReturnType<typeof clock>;
  /** Wraps the engine's own session on the checkout, for its git. */
  wrapLocal?: (session: ExecutionSession) => ExecutionSession;
}

export async function attempt(options: Attempt = {}) {
  const root = repoWith(options.files ?? FIXTURE);
  const guest = new RealGuest();
  guest.quick = true;
  options.setup?.(guest);
  const time = options.time ?? clock();
  const brief = options.brief ?? BRIEF;
  const backend = createNebiusBackend({ credentials: () => ({ key: KEY, project: PROJECT }), baseImage: guest.baseImage, journalDir: scratch("journals"), transport: () => (options.wrap ? options.wrap(guest.service.transport, guest) : guest.service.transport), applets: "", limits: { maxOperations: operationsForBrief(brief), maxTimeoutSeconds: 60, prepareTimeoutSeconds: 60, pollMs: 10 }, now: time.now, sleep: time.sleep });
  const script = [...(options.calls ?? [["read_file", { path: "greet.sh" }], ["edit_file", FIX], ["run_case", { number: 1 }]]), ["submit", { summary: "Defaulted the name to world." }]] as Step[];
  let requests = 0;
  // What each request carried, and the tools it offered: what the worker was told, as the model would read it.
  const prompts: string[] = [];
  const offered: string[][] = [];
  const model = new MastraLanguageModelV2Mock({
    doGenerate: (async (call: { prompt: unknown; tools?: Array<{ name: string }> }) => {
      const index = requests++;
      prompts.push(JSON.stringify(call.prompt));
      offered.push((call.tools ?? []).map((tool) => tool.name).sort());
      options.beforeRequest?.(index);
      return calling(script[Math.min(index, script.length - 1)]!, index);
    }) as never,
  });
  const before = folderState(root);
  const opened = await localSession(root);
  const local = options.wrapLocal ? options.wrapLocal(opened) : opened;
  const preview = await previewOf(root);
  try {
    const outcome = await runWorker({
      binding: { project: randomUUID(), target: "local", taskId: randomUUID(), attemptId: randomUUID(), runId: randomUUID(), briefVersion: 1, briefSha256: "b".repeat(64), homeId: randomUUID() },
      folder: root,
      preview,
      brief,
      backend,
      local,
      git: GIT,
      client: createModelClient({ apiKey: "test-key-0123456789", model: () => model }),
      model: MODEL,
      policy: policyFor(MODEL),
      contextLength: null,
      mask: (text) => text,
      knownValues: [KEY],
      exclude: [],
      applets: "",
      now: time.now,
      ...(options.signal ? { signal: options.signal } : {}),
      ...options.extra,
    });
    return { ...outcome, guest, model, root, changed: changedSince(before, root), requests: () => requests, prompts: () => prompts, offered: () => offered };
  } finally {
    await opened.close();
  }
}

/** The fingerprint the person would have been shown: the snapshot's own. */
async function previewOf(root: string): Promise<string> {
  return (await snap(root)).fingerprint;
}

export const labels = (guest: RealGuest) => guest.ran.map((run) => run.label);
export const verdicts = (core: { checks: Array<{ kind: string; number: number; verdict: string }> } | null) => core?.checks.map((check) => `${check.kind} ${check.number} ${check.verdict}`) ?? [];

