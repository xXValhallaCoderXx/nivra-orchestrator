import { createStep, createWorkflow } from "@mastra/core/workflows";
import { PlanningInput } from "@nivra/domain";
import { z } from "zod";
import { runPlanning, type PlanningDeps } from "../planning/run.ts";
import { guard } from "./guard.ts";

export const PLANNING_WORKFLOW_ID = "planning";
/** IDs and status only: the selected planning outcome is handed off through bounded process memory. */
export function createPlanningWorkflow(deps: PlanningDeps) {
  const Output = z.strictObject({ proposed: z.boolean() });
  const plan = createStep({ id: "plan", inputSchema: PlanningInput, outputSchema: Output, execute: async ({ inputData, runId, abortSignal }) => guard("planning.plan", deps.mask, async () => {
    await runPlanning(deps, runId, inputData, abortSignal);
    return { proposed: true };
  }) });
  return createWorkflow({ id: PLANNING_WORKFLOW_ID, inputSchema: PlanningInput, outputSchema: Output, options: { autoRestartActiveRuns: false } }).then(plan).commit();
}
