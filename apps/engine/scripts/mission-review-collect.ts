import { isTerminal, type ParamsOf, type ReviewReport, type RpcClient, type RunSummary } from "@nivra/domain";

type ReviewRequest = Extract<ParamsOf<"runs.start">, { workflowId: "review" }>;
interface ReviewEngine {
  client: Pick<RpcClient, "call">;
  close(): Promise<void>;
}

/** One run, never replayed. A failed read still leaves the last observation and whatever report can be collected. */
export async function collectMissionReview(options: {
  start: () => Promise<ReviewEngine>;
  request: ReviewRequest;
  followMs: number;
  /** Tests advance a monotonic clock without waiting for a review's real deadline. */
  clock?: { now(): number; pause(ms: number): Promise<void> };
}) {
  const clock = options.clock ?? { now: () => performance.now(), pause: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  const started = clock.now();
  const problems: string[] = [];
  let engine: ReviewEngine | null = null;
  let summary: RunSummary | null = null;
  let report: ReviewReport | null = null;
  let startRequested = false;
  let unresolved: string | null = null;
  let cancellation: "not-requested" | "requested" | "failed" | "confirmed" = "not-requested";
  // The shared closer bounds shutdown, stdin.end and force. Its return alone isn't proof of a run's terminal state.
  let engineClose: "not-available" | "returned" | "failed" = "not-available";
  let phase = "initialise the engine";
  try {
    engine = await options.start();
    phase = "start the review";
    startRequested = true;
    const end = clock.now() + options.followMs;
    summary = await engine.client.call("runs.start", options.request);
    phase = "read the review's status";
    while (!isTerminal(summary.status) && clock.now() < end) {
      await clock.pause(Math.min(1_000, end - clock.now()));
      if (clock.now() >= end) break;
      summary = await engine.client.call("runs.get", { runId: summary.id }, { timeoutMs: Math.min(5_000, Math.max(1, end - clock.now())) });
    }
    if (!isTerminal(summary.status)) problems.push(`No terminal run state was observed within ${options.followMs / 1000} s; cancellation was requested.`);
  } catch {
    // RPC/transport errors can carry private data. Keep the failed operation, never the raw exception.
    problems.push(`Couldn't ${phase}. Keep this evidence and resolve the failure before requesting another run.`);
  } finally {
    if (engine) {
      if (startRequested && !summary) {
        // A lost start reply isn't evidence that nothing started. Find the original request; never send it again.
        try {
          summary = await engine.client.call("runs.find", { clientRequestId: options.request.clientRequestId }, { timeoutMs: 5_000 });
        } catch {
          problems.push("Couldn't find the original review after its start reply was lost.");
        }
        if (!summary) unresolved = "The start was requested, but no run id could be recovered; whether it started is unknown.";
      }
      if (summary && !isTerminal(summary.status)) {
        cancellation = "requested";
        try {
          await engine.client.call("runs.cancel", { runId: summary.id }, { timeoutMs: 5_000 });
        } catch {
          cancellation = "failed";
          problems.push("The cancellation request failed; this doesn't establish that the review stopped.");
        }
        try {
          summary = await engine.client.call("runs.get", { runId: summary.id }, { timeoutMs: 5_000 });
        } catch {
          problems.push("Couldn't read the review's status after requesting cancellation.");
        }
        if (summary.status === "cancelled") cancellation = "confirmed";
        if (!isTerminal(summary.status)) unresolved = "No terminal run state was observed after requesting cancellation; termination is unresolved.";
      }
      if (summary) {
        try {
          report = await engine.client.call("runs.review", { runId: summary.id }, { timeoutMs: 5_000 });
          if (!report) problems.push("The engine returned no review report; findings and usage are unavailable.");
        } catch {
          problems.push("Couldn't collect the review report; findings and usage are unavailable.");
        }
      }
      try {
        await engine.close();
        engineClose = "returned";
      } catch {
        engineClose = "failed";
        problems.push("Engine shutdown failed; check the isolated engine home before further work.");
      }
    }
  }
  return { summary, report, startRequested, unresolved, cancellation, engineClose, problems, elapsedMs: Math.round(clock.now() - started) };
}
