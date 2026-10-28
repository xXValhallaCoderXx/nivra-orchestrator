import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { TASK_BRIEF_LIMITS } from "@nivra/domain";
import type { ExecutionSession } from "../src/exec/backend.ts";
import { NEBIUS_LIMITS } from "../src/exec/nebius/session.ts";
import { RESULT_ARCHIVE, RESULT_LISTING } from "../src/exec/patch.ts";
import { FETCH_HEADERS_MS } from "../src/providers/transport.ts";
import { AFTER_SESSION_MS, reserveMs, runNeedsMs, TASK_LIMITS, writeNeedsMs } from "../src/task/limits.ts";
import type { RealGuest } from "./real-guest.ts";
import { attempt, CUT_OFF, FIX, labels, verdicts, type Call } from "./task-fixtures.ts";
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
    assert.deepEqual([reserveMs(2), reserveMs(4)], [578_000, 882_000]);
    // The start request's allowance is the session's own.
    assert.equal(TASK_LIMITS.startRequestMs, NEBIUS_LIMITS.requestTimeoutMs);
  });

  it("keeps the reserve when every start request after the work takes its whole allowance and each operation ends at the end of its watch", async () => {
    const time = slowClock();
    let windowEnd = Number.NaN;
    const slowed = new Set<string>();
    let collecting = false;
    // Collect and the final checks, by what their operations run.
    const after = /nivra-collect|greet Ada|check\.sh/;
    const run = await attempt({
      time,
      calls: [["edit_file", FIX]],
      extra: { progress: (message, data) => void (message.startsWith("Work window") && (windowEnd = time.now() + Number(data["windowMs"]))) },
      // The worker hands in as its window ends: collect starts with only the reserve left.
      beforeRequest: (index) => void (index === 1 && time.advance(windowEnd - time.now() - 1_000)),
      wrap: (transport, guest) => async (request) => {
        if (request.method === "POST" && request.path === "/v1/instances" && after.test(String(request.body))) {
          collecting = true;
          time.advance(TASK_LIMITS.startRequestMs - 500);
        }
        const answer = await transport(request);
        const read = /^\/v1\/operations\/([^/]+)$/.exec(request.path);
        const op = read && request.method === "GET" ? guest.service.operations.find((candidate) => candidate.uuid === read[1]) : undefined;
        if (op && after.test(JSON.stringify(op.body["args"])) && !slowed.has(op.uuid)) {
          slowed.add(op.uuid);
          // Seen to end 5 s before its watch would have: its timeout, then 55 s of the minute's margin.
          time.advance(TASK_LIMITS.checks.timeoutMs + 55_000);
        }
        // Collect's two reads, each 5 s inside its allowance.
        if (collecting && /\/download$/.test(request.path)) time.advance(TASK_LIMITS.collect.downloadMs - 5_000);
        return answer;
      },
    });
    assert.equal(slowed.size, 3, "collect and both final checks weren't each slowed");
    assert.deepEqual([run.result.outcome, verdicts(run.core)], ["proposed", ["case 1 passed", "check 1 passed"]]);
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
  // show that, so here each request takes its whole time (NIV-35), and every operation, read and git command the most it
  // may: enough that the worker reaches the window's end, and a tool is refused for time.
  it("runs every final check when every operation, read and git command takes the most it may", async () => {
    const time = slowClock();
    const started = time.now();
    let collected = false;
    let windowEnd = Number.POSITIVE_INFINITY;
    const run = await attempt({
      time,
      calls: [["read_file", { path: "greet.sh" }], ["edit_file", FIX], ["run_case", { number: 1 }], ["run_check", { number: 1 }]],
      extra: { progress: (_message, data) => void (typeof data["windowMs"] === "number" && (windowEnd = time.now() + data["windowMs"])) },
      // Each request takes its whole time, or what is left of the window: Mastra's deadline ends it there.
      beforeRequest: () => time.advance(Math.max(0, Math.min(TASK_LIMITS.model.stepMs, windowEnd - time.now()))),
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
/**
 * A request's time (NIV-35): sized from its output cap, sent whole or not at all, with the hand-in's whole time kept
 * from the start, so nothing but a request's own deadline cuts it off and the last request can always be sent.
 */
describe("a task request's time (NIV-35)", () => {
  /** An attempt on the slow clock, with where its work window ends, read from the worker's own progress line. */
  const timed = (options: Omit<Parameters<typeof attempt>[0] & object, "time" | "beforeRequest">, before: (index: number, windowEnd: number, time: ReturnType<typeof slowClock>) => void) => {
    const time = slowClock();
    let windowEnd = Number.NaN;
    return attempt({
      ...options,
      time,
      extra: { ...options.extra, progress: (_message, data) => void (typeof data["windowMs"] === "number" && (windowEnd = time.now() + data["windowMs"])) },
      beforeRequest: (index) => before(index, windowEnd, time),
    });
  };

  it("gives every request the time its whole answer takes at the planned rate, under fetch's wait for headers, and says the caps", async () => {
    const { stepMs, outputTokensPerRequest, tokensPerSecond, handIn } = TASK_LIMITS.model;
    assert.deepEqual([stepMs, outputTokensPerRequest, handIn.stepMs, handIn.outputTokens, tokensPerSecond], [830_000, 8_000, 180_000, 1_500, 10]);
    for (const [ms, tokens] of [[stepMs, outputTokensPerRequest], [handIn.stepMs, handIn.outputTokens]] as const) {
      assert.equal(ms, 30_000 + (tokens / tokensPerSecond) * 1000, `${ms} ms isn't ${tokens} tokens' time at the planned rate, with its input's time`);
      assert.ok(ms < FETCH_HEADERS_MS, `a request's ${ms / 1000} s isn't under the ${FETCH_HEADERS_MS / 1000} s fetch waits for its reply's headers`);
    }
    // The whole run still fits its phases, and the window holds requests with tools besides the reserve.
    assert.ok(TASK_LIMITS.snapshotMs + TASK_LIMITS.sessionMs + AFTER_SESSION_MS <= TASK_LIMITS.runMs);
    // With the most final checks a brief may have, requests with tools can still start for ten minutes or more.
    assert.ok(TASK_LIMITS.sessionMs - reserveMs(TASK_BRIEF_LIMITS.finalChecks) - (stepMs + handIn.stepMs) >= 10 * 60_000, "the session leaves too little room for requests of their whole time");
    const run = await attempt();
    assert.equal(run.result.outcome, "proposed");
    assert.deepEqual(run.deadlines().map((given) => given.stepMs), [stepMs]);
    assert.deepEqual([run.outputCaps().length, [...new Set(run.outputCaps())]], [4, [outputTokensPerRequest]]);
    assert.ok(run.prompts()[0]!.includes("An answer may be at most 8,000 tokens long, and the hand-in's 1,500: a longer one is cut off before its tool call is made, and the attempt ends there, so make a large change as several smaller edit_file calls."), "the worker isn't told its answers' caps");
  });

  it("offers only the hand-in, with its own cap, once the window can't hold a request with tools and then the hand-in, each of its whole time", async () => {
    const { stepMs, handIn, outputTokensPerRequest } = TASK_LIMITS.model;
    // The first request answers with a second less than a request with tools and the hand-in need.
    const run = await timed({ handInWhenAsked: true, calls: [["read_file", { path: "greet.sh" }], ["edit_file", FIX]] }, (index, windowEnd, time) => void (index === 0 && time.advance(windowEnd - time.now() - stepMs - handIn.stepMs + 1_000)));
    assert.deepEqual(run.offered().map((tools) => (tools.includes("edit_file") ? "tools" : tools.join())), ["tools", "submit"]);
    assert.deepEqual(run.outputCaps(), [outputTokensPerRequest, handIn.outputTokens]);
    assert.deepEqual([run.core!.worker.ended, run.core!.worker.handedIn, run.core!.worker.handInDue, run.core!.worker.written], ["submitted", true, "time", []]);
    assert.ok(run.prompts()[1]!.includes("Your next request can only hand in"), "the worker wasn't told only handing in was left");
  });

  it("sends the hand-in in its own time, and nothing the window can't hold whole: below the hand-in's time, the attempt ends for time", async () => {
    const { stepMs, handIn } = TASK_LIMITS.model;
    // Less than a request with tools needs, but the hand-in's time: the hand-in is sent.
    const short = await timed({ handInWhenAsked: true, calls: [["read_file", { path: "greet.sh" }]] }, (index, windowEnd, time) => void (index === 0 && time.advance(windowEnd - time.now() - stepMs + 1_000)));
    assert.deepEqual([short.requests(), short.offered()[1], short.core!.worker.handedIn], [2, ["submit"], true]);
    // A second less than the hand-in's time: nothing more is sent.
    const shorter = await timed({ handInWhenAsked: true, calls: [["read_file", { path: "greet.sh" }]] }, (index, windowEnd, time) => void (index === 0 && time.advance(windowEnd - time.now() - handIn.stepMs + 1_000)));
    assert.deepEqual([shorter.requests(), shorter.core!.worker.ended, shorter.core!.worker.handedIn], [1, "time", false]);
    // The reserve still holds collect and every final check.
    assert.deepEqual([shorter.result.outcome, verdicts(shorter.core)], ["unchanged", ["case 1 failed", "check 1 failed"]]);
  });

  it("says an answer cut off at its output cap ended the attempt, never that requests ran out, and still runs every final check", async () => {
    const lines: string[] = [];
    const run = await attempt({ calls: [["read_file", { path: "greet.sh" }], CUT_OFF], extra: { progress: (message) => void lines.push(message) } });
    assert.deepEqual([run.requests(), run.core!.worker.ended, run.core!.worker.handedIn, run.result.outcome], [2, "output-cap", false, "unchanged"]);
    assert.ok(lines.includes("The worker stopped without handing in (output-cap): 0 files written."), lines.join(" | "));
    assert.deepEqual(verdicts(run.core), ["case 1 failed", "check 1 failed"]);
  });

  for (const [tool, input, needs] of [
    ["edit_file", FIX, writeNeedsMs()],
    ["run_case", { number: 1 }, runNeedsMs()],
  ] as const) {
    it(`keeps the hand-in's whole time from every operation: ${tool} is refused when it would take it, and the hand-in is sent`, async () => {
      const { handIn } = TASK_LIMITS.model;
      // The request answers with a second less than its operation and the hand-in need.
      const run = await timed({ handInWhenAsked: true, calls: [[tool, input]] }, (index, windowEnd, time) => void (index === 0 && time.advance(windowEnd - time.now() - handIn.stepMs - needs + 1_000)));
      assert.deepEqual([run.core!.worker.tools.refused, run.core!.worker.written, run.core!.worker.handedIn, run.offered()[1]], [1, [], true, ["submit"]]);
      assert.ok(!labels(run.guest).some((label) => label === "nivra-write" || label === "run"), `an operation was started: ${labels(run.guest).join(", ")}`);
      assert.ok(run.prompts()[1]!.includes(`there isn't time left in this attempt for another ${tool === "edit_file" ? "write" : "run"}`));
    });
  }

  it("says the time for tools is running out a request ahead when each request takes a long answer's time", async () => {
    const time = slowClock();
    // 200 s a request: 2,000 tokens at the slow rate.
    const run = await attempt({ time, handInWhenAsked: true, beforeRequest: () => time.advance(200_000), calls: Array.from({ length: 23 }, (): Call => ["search_files", { text: "greet", in: "names" }]) });
    const warned = run.prompts().findIndex((prompt) => /about \d+ seconds are left for tools/.test(prompt));
    const handIn = run.offered().findIndex((tools) => tools.length === 1 && tools[0] === "submit");
    assert.ok(warned > 0 && handIn > warned, `warned at ${warned}, only handing in from ${handIn}`);
    assert.deepEqual([run.core!.worker.handInDue, run.core!.worker.handedIn], ["time", true]);
  });

  it("starts the worker only when the window holds one request with tools and the hand-in, each of its whole time", async () => {
    const withTools = TASK_LIMITS.model.stepMs + TASK_LIMITS.model.handIn.stepMs;
    // The run's deadline leaves the session its reserve and a second less than that, then 5 s more than that.
    for (const [extraMs, requests, ended] of [[-1_000, 0, "no-time"], [5_000, 4, "submitted"]] as const) {
      const time = slowClock();
      const lines: string[] = [];
      const run = await attempt({ time, extra: { deadline: time.now() + AFTER_SESSION_MS + reserveMs(2) + withTools + extraMs, progress: (message) => void lines.push(message) } });
      assert.deepEqual([extraMs, run.requests(), run.core!.worker.ended], [extraMs, requests, ended]);
      if (ended === "no-time") assert.ok(lines.includes("Too little time was left in the session for a request with tools and then the hand-in, so the worker didn't start."), lines.join(" | "));
    }
  });
});

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
