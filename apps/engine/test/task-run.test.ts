import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { PATCH_SHOWN_BYTES, TASK_MODEL, taskBriefDigest, TaskReport, TaskStopCode, type EnvironmentContext, type TaskContext, type WorkflowId } from "@nivra/domain";
import { Database } from "../src/db/database.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import type { ExecutionBackend, ExecutionSession } from "../src/exec/backend.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { runPrescribed, type PrescribedRun } from "../src/exec/prescribed.ts";
import type { Proposal } from "../src/exec/proposal.ts";
import { createModelClient } from "../src/providers/model.ts";
import { RunScheduler, type RunHandle, type WorkflowEntry } from "../src/runs/scheduler.ts";
import { RunStore } from "../src/runs/store.ts";
import { TASK_LIMITS } from "../src/task/limits.ts";
import { holdsValue, proposalView, REPORT_BYTES, TASK_STOP_MESSAGES, taskReport, taskStopWords } from "../src/task/report.ts";
import { operationsForBrief } from "../src/task/worker.ts";
import { createTaskWorkflow, type TaskDeps } from "../src/workflows/task.ts";
import { buildFixture, fixtureRecipe } from "../scripts/sandbox-fixture.ts";
import { FIXED_GREET, TASK_BRIEF, TASK_FIX, TASK_FIXTURE } from "../scripts/task-fixture.ts";
import { FakeGuest } from "./fake-guest.ts";
import { clock } from "./fake-sandboxes.ts";
import { removeDir, tempDir, waitFor } from "./helpers.ts";
import { RealGuest } from "./real-guest.ts";
import { attempt } from "./task-fixtures.ts";
import { cleanUp, GIT, localSession, repoWith, scratch, snap } from "./workspace-fixtures.ts";

/**
 * A task run's parts, in process (NIV-7, D39): the run's one deadline on the prescribed path, its slot in the
 * scheduler, its proposal as the store keeps it, its report's words, and the workflow's own backstops. The run over
 * stdio is `task-engine.test.ts`. Nothing reaches a network or a real model.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});
const KEY = "nivra-task-run-key-0123456789";
const PROJECT = "project-e00taskruntest00";

/** A session whose `close` is seen: when, on the run's clock, and with what budget. */
function watched(backend: ExecutionBackend, now: () => number, seen: { open: Array<{ at: number; budgetMs?: number }>; close: Array<{ at: number; budgetMs?: number }> }, onClose?: () => Promise<void>): ExecutionBackend {
  return {
    ...backend,
    open: async (spec) => {
      seen.open.push({ at: now(), ...(spec.budgetMs !== undefined ? { budgetMs: spec.budgetMs } : {}) });
      const session = await backend.open(spec);
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === "close")
            return async (options?: Parameters<ExecutionSession["close"]>[0]) => {
              seen.close.push({ at: now(), ...(options?.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}) });
              const report = await target.close(options);
              await onClose?.();
              return report;
            };
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
}

describe("a task run's one deadline (D39)", () => {
  const fixture = () => buildFixture(join(scratch("fixture"), "fixture repo"), GIT);
  async function prescribe(given: Partial<PrescribedRun> | ((time: ReturnType<typeof clock>) => Partial<PrescribedRun>), onClose?: (time: ReturnType<typeof clock>) => Promise<void>) {
    const { root, baseline } = fixture();
    const guest = new FakeGuest();
    const time = clock();
    const extra = typeof given === "function" ? given(time) : given;
    const seen = { open: [] as Array<{ at: number; budgetMs?: number }>, close: [] as Array<{ at: number; budgetMs?: number }> };
    const backend = createNebiusBackend({ credentials: () => ({ key: KEY, project: PROJECT }), baseImage: guest.baseImage, journalDir: join(scratch("journals"), "sandbox"), transport: () => guest.service.transport, now: time.now, sleep: time.sleep });
    const local = await localSession(root);
    try {
      // The recipe's prescribed stop fires on the fake clock, as the prescribed path's own tests have it.
      const timer = (ms: number, fire: () => void) => {
        let live = true;
        void time.sleep(ms).then(() => live && fire());
        return () => void (live = false);
      };
      const result = await runPrescribed({ project: "project-1", target: "local", folder: root, baseline, steps: fixtureRecipe(), backend: watched(backend, time.now, seen, onClose && (() => onClose(time))), local, git: GIT, budgetMs: 600_000, closeBudgetMs: 420_000, patchMs: 180_000, now: time.now, timer, ...extra });
      return { result, seen, guest };
    } finally {
      await local.close();
    }
  }

  it("gives the session its cap or the time left before what follows it, whichever is less, and closing its cap or the time left", async () => {
    // Plenty of time: every phase has its cap.
    const roomy = await prescribe({ deadline: 10_000_000, afterSessionMs: 600_000 });
    assert.deepEqual([roomy.result.outcome, roomy.seen.open[0]?.budgetMs, roomy.seen.close[0]?.budgetMs], ["proposed", 600_000, 420_000]);
    // A deadline that leaves the session less than its cap, and, after work that takes 100 s, closing less than its own.
    const tight = await prescribe((time) => ({ deadline: 450_000, afterSessionMs: 200_000, work: async () => (await time.sleep(100_000), { going: true }) }));
    const [opened, closed] = [tight.seen.open[0]!, tight.seen.close[0]!];
    assert.deepEqual([opened.budgetMs, closed.budgetMs], [Math.min(600_000, Math.floor(450_000 - opened.at - 200_000)), Math.min(420_000, Math.floor(450_000 - closed.at))]);
    assert.ok(opened.budgetMs! < 600_000 && closed.budgetMs! < 420_000, `the deadline didn't cut a phase short: ${JSON.stringify(tight.seen)}`);
    assert.equal(tight.result.outcome, "unchanged");
  });

  it("opens no session the deadline leaves too little time for, and sends nothing", async () => {
    const late = await prescribe({ deadline: 200_000, afterSessionMs: 100_000 });
    assert.deepEqual([late.result.outcome, late.result.stopped?.code, late.result.stopped?.step, late.seen.open.length, late.guest.service.spawns, late.guest.service.uploads.length], ["failed", "time", "open", 0, 0, 0]);
  });

  it("gives the patch its cap or the time left after closing: a deadline reached while closing ends the run without a proposal, after closing", async () => {
    // Closing takes the run to its deadline: the patch has no time left, and nothing is proposed.
    const squeezed = await prescribe({ deadline: 5_000_000, afterSessionMs: 600_000 }, async (time) => time.sleep(5_000_000 - time.now()));
    assert.deepEqual([squeezed.result.outcome, squeezed.result.stopped?.code, squeezed.result.stopped?.step, squeezed.result.proposal, squeezed.result.cleanup !== null], ["refused", "git", "patch", null, true]);
    assert.match(squeezed.result.stopped!.message, /^patch: Building the patch took longer than the time it's given, so it was stopped\.$/);
  });
});

describe("a task run's slot (D39)", () => {
  it("gives a preparation a slot of its own too: it starts while the shared slots and a task's are full, and waits only for another preparation (D41)", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const database = new Database(join(dir, "nivra.db"));
    database.open();
    const store = new RunStore({ database });
    const workflows = new Map<WorkflowId, WorkflowEntry>([
      ["hello", { id: "hello", title: () => "Hello" }],
      ["task", { id: "task", title: () => "Task" }],
      ["environment", { id: "environment", title: () => "Environment" }],
    ]);
    const scheduler = new RunScheduler({ store, workflows, instanceId: randomUUID(), log: { info: () => undefined, warn: () => undefined, error: () => undefined }, diagnose: () => undefined });
    const release = new Map<string, () => void>();
    scheduler.attach({ getWorkflow: () => ({ createRun: async ({ runId }) => ({ start: () => new Promise((resolve) => release.set(runId, () => resolve({ status: "success" }))), cancel: async () => undefined, watch: () => () => undefined }) }) });
    scheduler.recover();
    const hello = () => scheduler.submit({ clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: "/repo", holdMs: 0 }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } });
    const taskContext: TaskContext = { sharing: { modelContext: true, cloudExecution: true }, brief: TASK_BRIEF };
    const task = async () => scheduler.submit({ clientRequestId: randomUUID(), workflowId: "task", input: { repoPath: "/repo", project: randomUUID(), target: "local", preview: "f".repeat(64), taskId: randomUUID(), briefVersion: 1, briefDigest: await taskBriefDigest(TASK_BRIEF) }, context: taskContext });
    const environmentContext: EnvironmentContext = { sharing: { cloudExecution: true }, spec: { filters: [] } };
    const prepare = () => scheduler.submit({ clientRequestId: randomUUID(), workflowId: "environment", input: { repoPath: "/repo", project: randomUUID(), target: "local", preview: "e".repeat(64) }, context: environmentContext });
    const [h1, h2] = [hello(), hello()];
    const t1 = await task();
    const [e1, e2] = [prepare(), prepare()];
    const status = (runId: string) => store.status(runId);
    await waitFor(() => (release.has(t1) && release.has(e1)) || null, { what: "the task and the first preparation to start" });
    assert.deepEqual([h1, h2, t1, e1, e2].map(status), ["running", "running", "running", "running", "queued"]);
    release.get(t1)!();
    await waitFor(() => status(t1) === "succeeded" || null, { what: "the task to end" });
    assert.equal(status(e2), "queued", "a task's slot freeing up started a preparation");
    release.get(e1)!();
    await waitFor(() => status(e2) === "running" || null, { what: "the second preparation" });
    for (const runId of [h1, h2, e2]) release.get(runId)!();
    await waitFor(() => [h1, h2, e2].every((runId) => status(runId) === "succeeded") || null, { what: "every run to end" });
  });

  it("takes a slot of its own: it starts while the shared slots are full, and waits only for another task", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const database = new Database(join(dir, "nivra.db"));
    database.open();
    const store = new RunStore({ database });
    const workflows = new Map<WorkflowId, WorkflowEntry>([
      ["hello", { id: "hello", title: () => "Hello" }],
      ["task", { id: "task", title: () => "Task" }],
    ]);
    const scheduler = new RunScheduler({ store, workflows, instanceId: randomUUID(), log: { info: () => undefined, warn: () => undefined, error: () => undefined }, diagnose: () => undefined });
    // Each run holds until it is let go.
    const release = new Map<string, () => void>();
    const handleFor = (runId: string): RunHandle => ({
      start: () => new Promise((resolve) => release.set(runId, () => resolve({ status: "success" }))),
      cancel: async () => undefined,
      watch: () => () => undefined,
    });
    scheduler.attach({ getWorkflow: () => ({ createRun: async ({ runId }) => handleFor(runId) }) });
    scheduler.recover();
    const helloContext = { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } };
    const hello = () => scheduler.submit({ clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: "/repo", holdMs: 0 }, context: helloContext });
    const brief = TASK_BRIEF;
    const taskContext: TaskContext = { sharing: { modelContext: true, cloudExecution: true }, brief };
    const task = async () => scheduler.submit({ clientRequestId: randomUUID(), workflowId: "task", input: { repoPath: "/repo", project: randomUUID(), target: "local", preview: "f".repeat(64), taskId: randomUUID(), briefVersion: 1, briefDigest: await taskBriefDigest(brief) }, context: taskContext });
    const [h1, h2, h3] = [hello(), hello(), hello()];
    const [t1, t2] = [await task(), await task()];
    const status = (runId: string) => store.status(runId);
    await waitFor(() => release.has(t1) || null, { what: "the first task to start" });
    // Two shared runs and one task go at once; the third shared run and the second task each wait for their own kind.
    assert.deepEqual([h1, h2, h3, t1, t2].map(status), ["running", "running", "queued", "running", "queued"]);
    release.get(h1)!();
    await waitFor(() => status(h3) === "running" || null, { what: "the third shared run" });
    assert.equal(status(t2), "queued", "a shared slot freeing up started a task");
    release.get(t1)!();
    await waitFor(() => status(t2) === "running" || null, { what: "the second task" });
    for (const runId of [h2, h3, t2]) release.get(runId)!();
    await waitFor(() => [h1, h2, h3, t1, t2].every((runId) => status(runId) === "succeeded") || null, { what: "every run to end" });
    // The same request id with another task's input is another run's: refused, as a check's and research's are.
    const reused = randomUUID();
    const input = { repoPath: "/repo", project: randomUUID(), target: "local", preview: "f".repeat(64), taskId: randomUUID(), briefVersion: 1, briefDigest: await taskBriefDigest(brief) };
    scheduler.submit({ clientRequestId: reused, workflowId: "task", input, context: taskContext });
    assert.throws(() => scheduler.submit({ clientRequestId: reused, workflowId: "task", input: { ...input, briefVersion: 2 }, context: taskContext }), /already started another run, with other input/);
    database.close();
  });
});

describe("a task run's proposal, as the engine keeps it (D39)", () => {
  const proposal = (): Proposal => ({
    binding: { version: 2, project: randomUUID(), target: "local", destination: { root: "/repo", prefix: "" }, objectFormat: "sha1", baseline: "b".repeat(40), baseTree: "c".repeat(40), resultTree: "d".repeat(40), fingerprint: "f".repeat(64), policy: { version: 1, maxFiles: 500, maxFileBytes: 2_097_152, maxTotalBytes: 8_388_608 } as never, patchSha256: "e".repeat(64), reportSha256: "a".repeat(64), paths: [{ path: "greet.sh", change: "changed", before: { mode: "100644", sha256: "1".repeat(64) }, after: { mode: "100644", sha256: "2".repeat(64) } }], postImageSha256: "3".repeat(64), task: { attempt: { taskId: randomUUID(), attemptId: randomUUID(), runId: randomUUID() }, engine: { homeId: randomUUID() }, brief: { version: 1, sha256: "4".repeat(64) } } },
    hash: "5".repeat(64),
    patch: new Uint8Array([0x2b, 0x0a, 0xff, 0x00, 0x7e]),
    report: new TextEncoder().encode('{"version":2}'),
    postImage: new Uint8Array(1_024).fill(7),
  });

  it("keeps its bytes exactly, once, and never changes them", () => {
    const dir = tempDir();
    dirs.push(dir);
    const database = new Database(join(dir, "nivra.db"));
    const db = database.open();
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.["user_version"]), MIGRATIONS.length);
    const store = new RunStore({ database, mask: (text) => text.replaceAll("greet", "[masked]") });
    const { id } = store.create({ workflowId: "task", title: "Task", input: {}, clientRequestId: randomUUID(), instanceId: randomUUID() });
    const kept = proposal();
    store.saveProposal(id, kept);
    const read = store.proposal(id)!;
    // Exact bytes, a NUL and a non-UTF-8 byte included, and the binding as it was: the store's mask never touches them.
    assert.deepEqual([read.hash, [...read.patch], [...read.report], read.postImage.byteLength, read.binding.paths[0]?.path], [kept.hash, [...kept.patch], [...kept.report], 1_024, "greet.sh"]);
    assert.deepEqual(read.binding, kept.binding);
    assert.throws(() => store.saveProposal(id, proposal()), /UNIQUE constraint failed|PRIMARY KEY/);
    assert.throws(() => db.prepare("UPDATE proposals SET hash = ? WHERE run_id = ?").run("6".repeat(64), id), /a proposal is kept as it was bound/);
    assert.equal(store.proposal(randomUUID()), null);
    database.close();
    // A home an older engine made (schema v3) gains the table as it opens, its runs kept.
    const older = join(dir, "older.db");
    const raw = new DatabaseSync(older);
    for (const [index, migration] of MIGRATIONS.slice(0, 3).entries()) raw.exec(`${migration}; PRAGMA user_version = ${index + 1};`);
    raw.prepare("INSERT INTO runs (id, workflow_id, title, status, input, created_at) VALUES (?, 'hello', 'Hello', 'succeeded', '{}', ?)").run("older-run", new Date().toISOString());
    raw.close();
    const reopened = new Database(older);
    const migrated = reopened.open();
    assert.deepEqual([Number(migrated.prepare("PRAGMA user_version").get()?.["user_version"]), Number(migrated.prepare("SELECT count(*) AS n FROM proposals").get()?.["n"]), migrated.prepare("SELECT id FROM runs").get()?.["id"]], [MIGRATIONS.length, 0, "older-run"]);
    reopened.close();
  });

  it("is found holding a vault value in any of its bytes or its binding, and only then", () => {
    const kept = proposal();
    assert.equal(holdsValue(kept, ["nivra-not-there-0123", ""]), false);
    assert.equal(holdsValue({ ...kept, report: new TextEncoder().encode(`{"x":"${KEY}"}`) }, [KEY]), true);
    assert.equal(holdsValue({ ...kept, postImage: new TextEncoder().encode(`id = ${PROJECT}\n`) }, [PROJECT]), true);
    assert.equal(holdsValue({ ...kept, binding: { ...kept.binding, destination: { root: `/home/${PROJECT}`, prefix: "" } } }, [PROJECT]), true);
  });

  it("is shown as text cut at its limit and masked, its stored bytes exact", () => {
    const big = new TextEncoder().encode(`+${KEY}\n${"x".repeat(PATCH_SHOWN_BYTES)}`);
    const shown = proposalView({ ...proposal(), patch: big }, (text) => text.replaceAll(KEY, "[secret:NEBIUS_API_KEY]"));
    assert.deepEqual([shown.truncated, shown.patchBytes, Buffer.byteLength(shown.patch) <= PATCH_SHOWN_BYTES + 32, shown.patch.startsWith("+[secret:NEBIUS_API_KEY]\n")], [true, big.byteLength, true, true]);
    assert.deepEqual(proposalView(proposal(), (text) => text).paths, proposal().binding.paths);
  });
});

describe("what a task run's report says (D39)", () => {
  it("says nothing was sent only of a stop before the upload, and has words for every stop", () => {
    assert.deepEqual(
      TaskStopCode.options.filter((code) => !TASK_STOP_MESSAGES[code]),
      [],
    );
    for (const code of TaskStopCode.options) {
      // "run" is the worker's own run of a case or check, inside the session; the workflow's start before the
      // prescribed path is "start".
      for (const step of ["toolchain", "worker", "write", "run", "collect", "final check", "patch", "proposal"]) {
        assert.ok(!taskStopWords(code, step).includes("nothing was sent"), `${code} at ${step} says nothing was sent`);
      }
      for (const step of ["check", "prepare", "start", "snapshot", "open", null]) assert.equal(taskStopWords(code, step), TASK_STOP_MESSAGES[code]);
    }
    assert.match(taskStopWords("git", "patch"), /^Git failed while Nivra checked what came back from the sandbox, so nothing was proposed\. Your commit was uploaded/);
  });

  it("fits the store at the most a run can give it: masked, control characters made U+FFFD, cut, and tails shortened until it fits", async () => {
    const run = await attempt();
    const SECRET = "nivra-report-secret-0123456789";
    // Three bytes a character, the most a code unit costs once a control character or a lone surrogate is replaced.
    const wide = (chars: number) => "\u20ac".repeat(chars);
    const noisy = (chars: number) => `${SECRET}${"\u0001\ud800".repeat(chars / 2)}${SECRET}`;
    // Every file the worker may write, each at the longest path a tool takes, and every check naming them all.
    const paths = Array.from({ length: TASK_LIMITS.tools.writes }, (_, at) => `${at}${wide(1_100)}`);
    const core = {
      ...run.core!,
      toolchain: Array.from({ length: 4 }, (_, at) => ({ program: `${at}${wide(200)}`, finding: "present" as const })),
      // Emoji cut between their halves: at the summary's end, and at the start of a tail.
      worker: { ...run.core!.worker, summary: `x${"\u{1F600}".repeat(3_000)}${noisy(100)}`, model: wide(300), written: paths },
      beforeChecks: Array.from({ length: 3 }, (_, at) => ({ ...run.core!.beforeChecks[0]!, number: at + 1, name: wide(1_200), reason: noisy(800), stdoutTail: noisy(10_000), stderrTail: noisy(10_000) })),
      checks: Array.from({ length: 4 }, (_, at) => ({ ...run.core!.checks[0]!, number: at + 1, name: wide(1_200), reason: noisy(800), stdoutTail: at ? noisy(10_000) : `${"\u{1F600}".repeat(5_000)}x`, stderrTail: noisy(10_000), difference: { line: 1, expected: wide(300), got: noisy(300) }, changedFiles: paths })),
    };
    const result = { ...run.result, steps: Array.from({ length: 30 }, () => ({ ...run.result.steps[0]!, label: wide(100), stdoutTail: noisy(10_000), stderrTail: noisy(10_000) })), cleanup: { ...run.result.cleanup!, unresolved: Array.from({ length: 80 }, (_, at) => `operation ${at}: ${wide(500)}`) } };
    const report = taskReport({ result, core, task: { taskId: "task", attemptId: "attempt", briefVersion: 1, briefDigest: "d".repeat(64) }, request: { runId: randomUUID(), clientRequestId: randomUUID() }, route: null, now: new Date(), mask: (text) => text.replaceAll(SECRET, "[secret]") });
    const json = JSON.stringify(report);
    assert.ok(Buffer.byteLength(json) <= REPORT_BYTES, `${Buffer.byteLength(json)} bytes`);
    assert.deepEqual([json.includes(SECRET), /\\u00[01]|\\ud[89a-f]/i.test(json), report.checks.map((check) => check.changedFiles.length)], [false, false, [8, 8, 8, 8]]);
    assert.deepEqual([report.beforeChecks?.length, report.checks.length, report.steps.length, report.manifest], [3, 4, 24, core.manifest]);
    TaskReport.parse(report);
  });
});

describe("a task run's workflow, in process (D39)", () => {
  const FILES = Object.fromEntries(TASK_FIXTURE.map((file) => [file.path, String(file.bytes)]));
  const MODEL = TASK_MODEL;
  type Call = [string, Record<string, unknown>];

  async function workflow(options: { platform?: NodeJS.Platform; vaultValues?: string[]; calls?: Call[]; files?: Record<string, string>; keep?: (proposal: Proposal) => void } = {}) {
    const root = repoWith(options.files ?? FILES);
    const guest = new RealGuest();
    guest.busybox = true;
    guest.quick = true;
    const brief = TASK_BRIEF;
    const runId = randomUUID();
    const requestId = randomUUID();
    const input = { repoPath: root, project: randomUUID(), target: "local", preview: (await snap(root)).fingerprint, taskId: randomUUID(), briefVersion: 1, briefDigest: await taskBriefDigest(brief) };
    const context: TaskContext = { sharing: { modelContext: true, cloudExecution: true }, brief };
    const calls = options.calls ?? [["edit_file", TASK_FIX], ["submit", { summary: "Defaulted the name to world." }]];
    let requests = 0;
    const model = new MastraLanguageModelV2Mock({
      doGenerate: (async () => {
        const [tool, args] = calls[Math.min(requests, calls.length - 1)]!;
        return { content: [{ type: "tool-call", toolCallId: `call-${requests++}`, toolName: tool, input: JSON.stringify(args) }], finishReason: "tool-calls", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, warnings: [] };
      }) as never,
    });
    const listing = (async () => new Response(JSON.stringify({ object: "list", data: [{ id: MODEL }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const reports: TaskReport[] = [];
    const proposals: Proposal[] = [];
    // What was saved, in order: each report by its outcome, and the proposal.
    const saves: string[] = [];
    let opened = 0;
    const deps: TaskDeps = {
      recorder: { output: () => undefined, event: () => undefined },
      context: () => context,
      task: () => input,
      requestId: () => requestId,
      homeId: randomUUID(),
      credentials: () => ({ key: KEY, project: PROJECT }),
      sandbox: (operations) => {
        opened++;
        return createNebiusBackend({ credentials: () => ({ key: KEY, project: PROJECT }), baseImage: guest.baseImage, journalDir: join(scratch("journals"), "sandbox"), transport: () => guest.service.transport, limits: { maxOperations: operations, maxTimeoutSeconds: 60, prepareTimeoutSeconds: 60, pollMs: 10 } });
      },
      local: createLocalBackend({ baseEnv: process.env }),
      findGit: () => GIT,
      platform: options.platform ?? "linux",
      exclude: [],
      knownValues: () => [KEY],
      vaultValues: () => options.vaultValues ?? [KEY, PROJECT],
      shutdown: new AbortController().signal,
      endpoint: { url: "http://127.0.0.1:9/v1", kind: "loopback-test" },
      mask: (text) => text,
      setMeta: () => undefined,
      saveReport: (_runId, report) => {
        reports.push(TaskReport.parse(report));
        saves.push(`report ${report.outcome}`);
      },
      saveProposal: (_runId, proposal) => {
        options.keep?.(proposal);
        proposals.push(proposal);
        saves.push("proposal");
      },
      modelClient: (key, endpoint) => createModelClient({ apiKey: key, endpoint, model: () => model, fetch: listing }),
    };
    const run = await createTaskWorkflow(deps).createRun({ runId });
    const result = (await run.start({ inputData: {} })) as { status: string; error?: { message?: string } };
    return { result, reports, proposals, saves, opened, requests: () => requests, guest, operations: operationsForBrief(brief) };
  }

  it("proposes a verified change, keeping the proposal and a report the protocol takes", async () => {
    const done = await workflow();
    assert.equal(done.result.status, "success", done.result.error?.message);
    const final = done.reports.at(-1)!;
    assert.deepEqual([final.outcome, final.verified, done.proposals.length, done.proposals[0]?.hash === final.proposal?.hash, done.reports[0]?.outcome], ["proposed", true, 1, true, "in-progress"]);
    // The report that describes the proposal is kept first.
    assert.deepEqual(done.saves, ["report in-progress", "report proposed", "proposal"]);
  });

  it("says nothing was proposed when the proposal can't be kept, replacing the report that described it", async () => {
    const done = await workflow({
      keep: () => {
        throw new Error("disk I/O error");
      },
    });
    const final = done.reports.at(-1)!;
    assert.deepEqual([done.result.status, done.saves, done.proposals.length], ["failed", ["report in-progress", "report proposed", "report failed"], 0]);
    assert.deepEqual([final.outcome, final.stopped?.code, final.stopped?.step, final.proposal, final.stopped?.message], ["failed", "fault", "proposal", null, TASK_STOP_MESSAGES.fault]);
  });

  it("calls nothing verified when nothing changed, though every case passed: there is no change to verify", async () => {
    const done = await workflow({ files: { ...FILES, "greet.sh": FIXED_GREET }, calls: [["submit", { summary: "It already works." }]] });
    assert.equal(done.result.status, "success", done.result.error?.message);
    const final = done.reports.at(-1)!;
    assert.deepEqual([final.outcome, final.checks.map((check) => check.verdict), final.verified, final.proposal, done.proposals.length], ["unchanged", ["passed", "passed"], false, null, 0]);
  });

  it("refuses on Windows itself before anything is opened, saying so, as a backstop to the engine's own refusal", async () => {
    const done = await workflow({ platform: "win32" });
    assert.deepEqual([done.result.status, done.result.error?.message, done.opened, done.requests(), done.reports.map((report) => [report.outcome, report.stopped?.code, report.stopped?.step])], ["failed", TASK_STOP_MESSAGES["native-windows"], 0, 0, [["refused", "native-windows", "check"]]]);
  });

  it("keeps no proposal that holds a value the vault keeps, even one the change's own rules missed", async () => {
    // A value only the vault knows, in the fix's new text: nothing before the store catches it, and the store refuses it.
    const done = await workflow({ vaultValues: [KEY, PROJECT, "${1:-world}"] });
    assert.equal(done.result.status, "failed");
    const final = done.reports.at(-1)!;
    assert.deepEqual([final.outcome, final.stopped?.code, final.stopped?.step, final.proposal, final.reportSha256, done.proposals.length], ["refused", "change", "proposal", null, null, 0]);
    assert.equal(final.stopped?.message, taskStopWords("change", "proposal"));
  });
});
