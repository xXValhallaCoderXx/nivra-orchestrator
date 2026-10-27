import type { TaskReport } from "@nivra/domain";

/**
 * What a task run's card says it started from (D41), claimed only from evidence: a run that ran no operation in a
 * sandbox, such as one refused before anything was sent, started from nothing, so the card says nothing about where.
 * Pure, so it is tested without a window.
 */
export function startedFrom(report: Pick<TaskReport, "environment" | "steps">): string | null {
  if (report.steps.length === 0) return null;
  const environment = report.environment;
  return environment
    ? `Started from the prepared environment: Node ${environment.node}, pnpm ${environment.pnpm}, ${environment.arch}, image ${environment.image.slice(0, 12)}.`
    : "Started from Nivra's own base image, with nothing installed.";
}
