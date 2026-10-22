import { StoredResearchInput, type ResearchReport } from "@nivra/domain";

/** What a research run reads back from its own store: the plan's id and version, and the packet's fingerprint. */
export type ResearchTask = StoredResearchInput;

export function readResearchTask(input: unknown): ResearchTask | null {
  const parsed = StoredResearchInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * A report as the engine reads it back once its run has ended (D37). One saved mid-run, by an engine that stopped,
 * reads as interrupted: a request it was sending may have been sent, so it ends `interrupted` with its credits unknown,
 * and nothing is resent. The stored copy is unchanged.
 */
export function asInterrupted(report: ResearchReport): ResearchReport {
  if (report.outcome !== "in-progress") return report;
  const requests = report.requests.map((request) =>
    request.state === "sending" ? { ...request, state: "failed" as const, failure: "interrupted" as const, credits: null } : request.state === "pending" ? { ...request, state: "skipped" as const } : request,
  );
  const sent = requests.filter((request) => request.kind !== "model" && (request.state === "answered" || (request.state === "failed" && request.failure !== "not-sent")));
  return {
    ...report,
    outcome: "interrupted",
    requests,
    usage: { ...report.usage, credits: sent.some((request) => request.credits === null) ? null : sent.reduce((sum, request) => sum + request.credits!, 0) },
  };
}
