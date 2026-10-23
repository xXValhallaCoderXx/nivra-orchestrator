import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { ExecutionSession } from "../src/exec/backend.ts";
import { RESULT_ARCHIVE, RESULT_LISTING } from "../src/exec/patch.ts";
import { reserveMs, TASK_LIMITS } from "../src/task/limits.ts";
import type { RealGuest } from "./real-guest.ts";
import { attempt, FIX, labels, verdicts } from "./task-fixtures.ts";
import { cleanUp } from "./workspace-fixtures.ts";

/**
 * A task run's time (NIV-7, D39), on a fake clock: the work window ends where the reserve begins, so collect, its reads
 * and the final checks are never short of time; a slow read or a slow patch uses only its own allowance; the model's
 * deadline never stops an operation under way, and the person's cancel does.
 */
after(cleanUp);

/** A fake clock whose waits also yield a real millisecond, so work that waits in real time sees it move slowly. */
function slowClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number): Promise<undefined> => {
      now += ms;
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    advance: (ms: number) => void (now += ms),
    waits: [] as number[],
  };
}

const opOf = (guest: RealGuest, label: string) => guest.service.operations.find((op) => JSON.stringify(op.body["args"] ?? []).includes(label));

describe("a task run's time (NIV-7, D39)", () => {
  it("keeps the reserve: the caps after the session fit in the run's deadline, and the reserve holds collect, its reads and every final check", () => {
    const after = TASK_LIMITS.closeMs + TASK_LIMITS.patchMs + TASK_LIMITS.reportMs;
    assert.ok(TASK_LIMITS.snapshotMs + TASK_LIMITS.sessionMs + after <= TASK_LIMITS.runMs, "the phases' caps don't fit in the run's deadline");
    assert.deepEqual([reserveMs(2), reserveMs(4)], [488_000, 732_000]);
  });

  it("lets a write under way finish when the model's time ends, then collects and runs every final check", async () => {
    const time = slowClock();
    const run = await attempt({
      time,
      calls: [["edit_file", FIX], ["run_case", { number: 1 }]],
      extra: { maxModelMs: 300 },
      setup: (guest) => {
        guest.override = ({ label }) => {
          if (label !== "nivra-write") return undefined;
          // Held running well past the model's deadline, then let finish.
          setTimeout(() => void (opOf(guest, "nivra-write")!.finishedBySubprocess = true), 900);
          return { waits: true };
        };
      },
    });
    assert.deepEqual([run.result.outcome, run.core!.worker.ended, run.core!.worker.handedIn, run.core!.worker.written], ["proposed", "time", false, ["greet.sh"]]);
    assert.equal(opOf(run.guest, "nivra-write")!.cancelled, false, "the model's deadline stopped the write");
    assert.deepEqual([verdicts(run.core), run.core!.verified], [["case 1 passed", "check 1 passed"], true]);
  });

  it("stops a check under way when the person cancels, and collects nothing", async () => {
    const cancel = new AbortController();
    const run = await attempt({
      signal: cancel.signal,
      calls: [["edit_file", FIX], ["run_case", { number: 1 }]],
      setup: (guest) => void (guest.override = ({ label }) => (label === "command" ? { waits: true } : undefined)),
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        const read = /^\/v1\/operations\/([^/]+)$/.exec(request.path);
        const op = read ? guest.service.operations.find((candidate) => candidate.uuid === read[1]) : undefined;
        if (request.method === "GET" && op && JSON.stringify(op.body["args"]).includes("greet Ada") && !cancel.signal.aborted) cancel.abort(new Error("the person cancelled"));
        return answer;
      },
    });
    assert.deepEqual([run.result.outcome, run.result.proposal], ["cancelled", null]);
    assert.ok(!labels(run.guest).includes("nivra-collect"));
    assert.equal(run.guest.service.operations.at(-1)?.cancelled, true, "the check wasn't stopped");
  });

  it("stops at once when the person cancels during a model request, and collects nothing", async () => {
    const cancel = new AbortController();
    const run = await attempt({ signal: cancel.signal, calls: [["edit_file", FIX], ["run_case", { number: 1 }]], beforeRequest: (index) => index === 1 && cancel.abort(new Error("the person cancelled")) });
    assert.deepEqual([run.result.outcome, run.result.proposal, run.requests()], ["cancelled", null, 2]);
    assert.ok(!labels(run.guest).includes("nivra-collect"));
  });

  // A model request can't outlast the window: Mastra's own deadline, on the real clock, ends it there. A fake clock can't
  // show that, so here each request takes 60 s, and every operation, read and git command the most it may: enough that
  // the worker reaches the window's end, and a tool is refused for time.
  it("runs every final check when every operation, read and git command takes the most it may", async () => {
    const time = slowClock();
    const started = time.now();
    let collected = false;
    let windowEnd = Number.POSITIVE_INFINITY;
    const run = await attempt({
      time,
      calls: [["read_file", { path: "greet.sh" }], ["edit_file", FIX], ["run_case", { number: 1 }], ["run_check", { number: 1 }]],
      extra: { progress: (_message, data) => void (typeof data["windowMs"] === "number" && (windowEnd = time.now() + data["windowMs"])) },
      // Each request takes 60 s, or what is left of the window: Mastra's deadline ends it there.
      beforeRequest: () => time.advance(Math.max(0, Math.min(60_000, windowEnd - time.now()))),
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        const read = /^\/v1\/operations\/([^/]+)$/.exec(request.path);
        const op = read && request.method === "GET" ? guest.service.operations.find((candidate) => candidate.uuid === read[1]) : undefined;
        // Each operation ends at the last moment the session still watches it: its timeout and most of the margin.
        if (op && ["SUCCESS", "FAILED", "CANCELLED"].includes(op.status) && !(op as { slowed?: boolean }).slowed) {
          (op as { slowed?: boolean }).slowed = true;
          time.advance(Number(op.body["timeout"]) * 1000 + 59_000);
          if (JSON.stringify(op.body["args"]).includes("nivra-collect")) collected = true;
        }
        const download = /\/download$/.test(request.path) ? request.query?.["path"] : undefined;
        if (download) time.advance(download === RESULT_ARCHIVE || download === RESULT_LISTING ? TASK_LIMITS.collect.downloadMs - 1_000 : TASK_LIMITS.write.downloadMs - 1_000);
        return answer;
      },
      // Patch construction, after collect, takes nearly its whole cap.
      wrapLocal: (session) => slowed(session, () => collected, () => time.advance(19_000)),
    });
    assert.deepEqual([run.result.outcome, run.result.stopped], ["proposed", null]);
    assert.ok(run.core!.worker.tools.refused >= 1 || run.core!.worker.ended === "time" || run.core!.worker.handInDue === "time", `the worker never reached the window's end, so the reserve wasn't tested: ${JSON.stringify(run.core!.worker)}`);
    assert.deepEqual(verdicts(run.core), ["case 1 passed", "check 1 passed"]);
    assert.ok(time.now() - started <= TASK_LIMITS.runMs, `the run took ${Math.round((time.now() - started) / 1000)} s of a ${TASK_LIMITS.runMs / 1000} s deadline`);
  });

  it("stops collect when a read of its result is slower than its own deadline, and proposes nothing", async () => {
    const time = slowClock();
    const run = await attempt({
      time,
      wrap: (transport) => async (request) => {
        if (/\/download$/.test(request.path) && request.query?.["path"] === RESULT_ARCHIVE) time.advance(TASK_LIMITS.collect.downloadMs + 1_000);
        return transport(request);
      },
    });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.stopped?.step, run.result.proposal], ["refused", "collect", "collect", null]);
    assert.deepEqual(verdicts(run.core), [], "final checks ran on a result that wasn't read back");
  });

  it("ends the run without a proposal, after closing, when patch construction runs past its cap", async () => {
    const time = slowClock();
    let collected = false;
    const run = await attempt({
      time,
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        if (guest.service.operations.some((op) => JSON.stringify(op.body["args"] ?? []).includes("nivra-collect") && op.status === "SUCCESS")) collected = true;
        return answer;
      },
      wrapLocal: (session) => slowed(session, () => collected, () => time.advance(61_000)),
    });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.stopped?.step, run.result.proposal], ["refused", "git", "patch", null]);
    assert.match(run.result.stopped!.message, /Building the patch took longer than the time it's given/);
    assert.ok(run.result.cleanup !== null && run.result.cleanup.unresolved.length === 0, "the session wasn't closed cleanly before the patch");
    assert.deepEqual(verdicts(run.core), ["case 1 passed", "check 1 passed"]);
  });
});

/** The engine's own session, each command taking `slow` once `when` holds. */
function slowed(session: ExecutionSession, when: () => boolean, slow: () => void): ExecutionSession {
  return {
    capabilities: session.capabilities,
    exec: async (request) => {
      if (when()) slow();
      return session.exec(request);
    },
    close: (options) => session.close(options),
  };
}
