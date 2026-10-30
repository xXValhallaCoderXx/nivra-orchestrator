import { randomUUID } from "node:crypto";
import { TASK_MODEL, type BudgetGrant } from "@nivra/domain";
const grants = new Map<string, BudgetGrant>();
export function codingGrant(requestId: string): BudgetGrant {
  let grant = grants.get(requestId);
  if (!grant) {
    grant = { id: randomUUID(), requestId, catalogueVersion: "test", models: [TASK_MODEL], modelListings: 1, rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: 23, outputTokens: 8000 }, finalisation: { requests: 1, outputTokens: 1500 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } };
    grants.set(requestId, grant);
  }
  return grant;
}
