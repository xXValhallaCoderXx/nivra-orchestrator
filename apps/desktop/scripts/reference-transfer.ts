import { randomUUID } from "node:crypto";
import { ErrorCode, isTerminal, manifestPayload, PROTOCOL_VERSION, referenceHash, RpcCallError, VISUAL_MODEL, type BudgetGrant } from "@nivra/domain";
import { referenceFixture } from "../../engine/test/reference-fixture.ts";
import type { EngineSupervisor } from "../src/main/supervisor.ts";

/** An unpaid transport check: valid frozen bytes are admitted; changed bytes are refused before scheduling. */
export async function referenceTransfer(supervisor: EngineSupervisor): Promise<string> {
  const references = await referenceFixture("Windows/WSL reference transfer ü 中文");
  const image = references.attachments[0]!.image!;
  // A sizeable byte payload checks line buffering and base64 transport. No decoding or provider inference is claimed.
  image.base64 = Buffer.concat([Buffer.from(image.base64, "base64"), Buffer.alloc(512 * 1024, 0x41)]).toString("base64");
  references.manifest.attachments[0]!.preparedSha256 = await referenceHash(new Uint8Array(Buffer.from(image.base64, "base64")));
  references.digest = await referenceHash(manifestPayload(references.manifest));
  const requestId = randomUUID();
  const budget: BudgetGrant = { id: randomUUID(), requestId, catalogueVersion: "transport-check", models: [VISUAL_MODEL], modelListings: 1, rates: [], productiveMicros: null, finalisationMicros: null, productive: { requests: 1, outputTokens: 4000 }, finalisation: { requests: 0, outputTokens: 0 }, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 } };
  const request = { clientRequestId: requestId, workflowId: "companion" as const, input: { sessionId: randomUUID(), bindingDigest: references.digest }, budget, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false }, message: "Transport check only", snapshot: "{}", history: [], references } };
  const changed = structuredClone(request); changed.context.references.attachments[0]!.image!.base64 = image.base64.slice(4);
  try { await supervisor.call("runs.start", changed); throw new Error("Changed reference bytes were accepted."); }
  catch (error) { if (!(error instanceof RpcCallError) || error.code !== ErrorCode.InvalidParams) throw error; }
  const run = await supervisor.call("runs.start", request);
  const deadline = performance.now() + 15_000;
  for (;;) {
    const current = await supervisor.call("runs.get", { runId: run.id });
    if (isTerminal(current.status)) break;
    if (performance.now() > deadline) throw new Error("The unpaid reference transport check didn't end.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const journal = await supervisor.call("budget.journal", { grantId: budget.id, after: 0, limit: 200 });
  if (journal.rows.length !== 0 || journal.seal?.kind !== "complete") throw new Error("The transport check didn't finish without model requests.");
  return `protocol ${PROTOCOL_VERSION} admitted ${Buffer.byteLength(JSON.stringify(request))} bytes, rejected a changed image hash, and sent no provider requests`;
}
