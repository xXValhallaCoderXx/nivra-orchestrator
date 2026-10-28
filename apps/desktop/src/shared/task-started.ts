import type { TaskReport } from "@nivra/domain";

/**
 * What a task run's card says it started from (D41, NIV-55), claimed only from evidence: a run that ran no operation in
 * a sandbox, such as one refused before anything was sent, started from nothing, so the card says nothing about where.
 * A recipe's environment by the versions its preparation verified; D41's, from a report kept from before, by its own.
 * Pure, so it is tested without a window.
 */
export function startedFrom(report: Pick<TaskReport, "environment" | "environmentRef" | "steps">): string | null {
  if (report.steps.length === 0) return null;
  const recipe = report.environmentRef ?? null;
  if (recipe) return `Started from the prepared environment: ${recipe.tools.map((tool) => `${tool.name} ${tool.version}`).join(", ")}, ${recipe.platform.arch}, image ${recipe.image.slice(0, 12)}.`;
  const environment = report.environment;
  return environment
    ? `Started from the prepared environment: Node ${environment.node}, pnpm ${environment.pnpm}, ${environment.arch}, image ${environment.image.slice(0, 12)}.`
    : "Started from Nivra's own base image, with nothing installed.";
}
