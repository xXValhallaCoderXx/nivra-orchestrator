import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  MISSION_COUNCIL,
  missionPacketDigest,
  packetDigest,
  preferencesDigest,
  renderMissionPacket,
  ReviewOutcome,
  ReviewPanel,
  specialistRef,
  type Mask,
  type MissionReviewPacket,
  type ReviewContext,
  type ReviewReport,
  type RunRoute,
  type RunUsage,
} from "@nivra/domain";
import { z } from "zod";
import { createModelClient, failure, ModelFailure, type BudgetBinding, type Endpoint, type ModelClient } from "../providers/model.ts";
import { policyFor } from "../providers/policy.ts";
import type { RunLimits } from "../providers/run-budget.ts";
import { isNvidiaModel, pickNemotron } from "../providers/tokenfactory.ts";
import { renderMissionMessage } from "../review/mission-prompt.ts";
import { incompleteFailure, runReview } from "../review/run.ts";
import { ReviewUnreadable, type ReviewTask } from "../review/task.ts";
import type { ExplainRecorder } from "./explain.ts";
import { guard } from "./guard.ts";
import { describePreferences } from "./preferences-record.ts";

export const REVIEW_WORKFLOW_ID = "review";

/**
 * A review of a saved plan version (NIV-38, D30). It reaches no repository and changes nothing: it has no execution
 * backend, no git and no path, only the packet the host froze and sent in the run's context. Mastra gets the panel and
 * ids alone; the plan's text and the preferences stay in memory (D21), and the report is saved by the engine's store.
 */
export interface ReviewDeps {
  recorder: ExplainRecorder;
  /** What the host sent with the run, held in memory by the scheduler (D21). */
  context: (runId: string) => ReviewContext | null;
  /** The plan's id and version, the panel and the fingerprints, from the run store. */
  task: (runId: string) => ReviewTask | null;
  /** The request id the host sent the run with. */
  requestId: (runId: string) => string | null;
  /** Required for mission reviews; held in scheduler memory and the operation journal only. */
  budget?: (runId: string) => BudgetBinding | null;
  apiKey: () => string | null;
  endpoint: Endpoint;
  mask: Mask;
  setMeta: (runId: string, meta: { usage?: RunUsage; route?: RunRoute }) => void;
  saveResult: (runId: string, report: ReviewReport) => void;
  /** Tests only, in-process: a client over a mock model, and other limits. */
  modelClient?: (apiKey: string, endpoint: Endpoint) => ModelClient;
  limits?: RunLimits;
  requestMs?: number;
}

const Input = z.strictObject({ panel: ReviewPanel });

const isMission = (packet: ReviewContext["packet"]): packet is MissionReviewPacket => "kind" in packet && packet.kind === "mission";

/**
 * The model a review may use: the one the listing gives (D22), or, when a mission packet names one, exactly that model,
 * found in the listing (NIV-52). Candidates must also be permitted by the run's grant when present. Any other is
 * refused here, before any inference request: a listing isn't one.
 */
export function reviewModel(packet: ReviewContext["packet"], listed: readonly string[], granted?: readonly string[]): string {
  const candidates = granted ? listed.filter((id) => granted.some((candidate) => candidate.toLowerCase() === id.toLowerCase())) : listed;
  if (isMission(packet) && packet.model !== null) {
    const named = packet.model;
    const match = isNvidiaModel(named) ? candidates.find((id) => id === named) : undefined;
    if (!match) throw failure("model-unavailable", `this review may use only ${named}, and this key's listing ${listed.length ? "doesn't include it" : "is empty"}, so nothing was sent`);
    return match;
  }
  const model = pickNemotron(candidates);
  if (!model) throw failure("model-unavailable", "no NVIDIA model is listed for this key");
  return model;
}
const Prepared = z.strictObject({ model: z.string(), contextLength: z.number().nullable() });
const Reviewed = z.strictObject({ outcome: ReviewOutcome, findings: z.number().int().nonnegative() });

export function createReviewWorkflow(deps: ReviewDeps) {
  const clientFor = (key: string, runId: string, seat: string) => {
    const binding = deps.budget?.(runId);
    if (isMission(given(runId).packet) && !binding) throw failure("budget-exhausted", "this mission review has no admitted host allowance; preview and start it again");
    return deps.modelClient ? deps.modelClient(key, deps.endpoint) : createModelClient({ apiKey: key, endpoint: deps.endpoint, ...(binding ? { budget: { ...binding, seat } } : {}) });
  };

  const given = (runId: string): ReviewContext => {
    const context = deps.context(runId);
    if (!context) throw failure("internal", "this run's context is missing").because("context-missing", "review.context");
    return context;
  };

  const taskOf = (runId: string): ReviewTask => {
    const task = deps.task(runId);
    if (!task) throw new ReviewUnreadable();
    return task;
  };

  /** A project's packet needs that project's consent, and every review a key: both checked before anything is sent. */
  const allowed = (runId: string): { context: ReviewContext; key: string } => {
    const context = given(runId);
    if (context.packet.scope.kind === "project" && !context.sharing.modelContext) throw failure("sharing-refused");
    const key = deps.apiKey();
    if (!key) throw failure("no-key");
    return { context, key };
  };

  // What the review was given, checked against what it was asked to review, and recorded as counts and fingerprints.
  const context = createStep({
    id: "context",
    description: "Check the packet and the preferences against the fingerprints the review was asked for",
    inputSchema: Input,
    outputSchema: Input,
    execute: async ({ inputData, runId }) => guard("review.context", deps.mask, async () => {
      const task = taskOf(runId);
      const sent = given(runId);
      const [packet, preferences] = await Promise.all([isMission(sent.packet) ? missionPacketDigest(sent.packet) : packetDigest(sent.packet), preferencesDigest(sent.preferences.records)]);
      if (packet !== task.packetDigest || preferences !== task.preferencesDigest) {
        throw failure("internal", "what was sent isn't what this review was asked for").because("input-refused", "review.context");
      }
      // A mission review is the council, with the profiles this engine holds, at their versions (NIV-52).
      if (isMission(sent.packet)) {
        if (task.panel !== "council") throw failure("internal", "a mission review needs the council").because("input-refused", "review.context");
        const expected = MISSION_COUNCIL.map(specialistRef);
        if (JSON.stringify(sent.packet.specialists) !== JSON.stringify(expected)) {
          throw failure("internal", "the review was asked for profile versions this engine doesn't hold").because("input-refused", "review.context");
        }
        // The reviewers read what the person previewed, never a redacted copy: text that masking would change is
        // refused here, before the listing. The host refuses it first, naming the part; this holds whoever sends.
        const message = renderMissionMessage(sent.packet, sent.preferences, (text) => text);
        if (deps.mask(message) !== message) {
          throw failure("internal", "the text to review holds what looks like a credential, so nothing was sent").because("input-refused", "review.context");
        }
      }
      // A general plan's review gets personal preferences only (D21).
      if (sent.packet.scope.kind === "general" && sent.preferences.records.some((record) => record.scope === "project")) {
        throw failure("internal", "a general plan's review was sent a project's own preference").because("input-refused", "review.context");
      }
      const described = await describePreferences(sent.preferences);
      if (isMission(sent.packet)) {
        const textChars = renderMissionPacket(sent.packet).length;
        deps.recorder.output(runId, "context", `Mission review: ${sent.packet.tasks.length} selected ${sent.packet.tasks.length === 1 ? "task" : "tasks"}, ${textChars.toLocaleString("en")} characters. ${described.message}`, {
          planVersion: task.planVersion,
          scope: sent.packet.scope.kind,
          tasks: sent.packet.tasks.length,
          othersInBacklog: sent.packet.othersInBacklog,
          textChars,
          model: sent.packet.model,
          specialists: sent.packet.specialists.map((ref) => `${ref.id}@${ref.version}`),
          packetDigest: packet,
          ...described.data,
        });
        return inputData;
      }
      deps.recorder.output(runId, "context", `Plan v${task.planVersion}: ${sent.packet.text.length.toLocaleString("en")} characters, ${sent.packet.assumptions.length} assumptions, ${sent.packet.references.length} historical references. ${described.message}`, {
        planVersion: task.planVersion,
        scope: sent.packet.scope.kind,
        textChars: sent.packet.text.length,
        assumptions: sent.packet.assumptions.length,
        references: sent.packet.references.length,
        packetDigest: packet,
        ...described.data,
      });
      return inputData;
    }),
  });

  const prepare = createStep({
    id: "prepare",
    description: "Check the key and consent, and pick the model",
    inputSchema: Input,
    outputSchema: Prepared,
    execute: async ({ runId, abortSignal }) => guard("review.prepare", deps.mask, async () => {
      const { context: sent, key } = allowed(runId);
      const client = clientFor(key, runId, "mission-review-listing");
      const models = await client.listModels({ signal: abortSignal, timeoutMs: 30_000 });
      const model = reviewModel(sent.packet, models.ids, deps.budget?.(runId)?.models);
      deps.setMeta(runId, { route: { provider: "nebius", endpoint: deps.endpoint.kind, model } });
      const contextLength = models.contextLengths.get(model) ?? null;
      deps.recorder.output(runId, "prepare", `Model ${model}`, { model, contextLength });
      return { model, contextLength };
    }),
  });

  const review = createStep({
    id: "review",
    description: "Two reviewers on their own, then a chair; or one reviewer alone",
    inputSchema: Prepared,
    outputSchema: Reviewed,
    execute: async ({ inputData, runId, abortSignal }) => guard("review.review", deps.mask, async () => {
      const task = taskOf(runId);
      const { context: sent, key } = allowed(runId);
      const final = await runReview({
        runId,
        clientRequestId: deps.requestId(runId) ?? runId,
        task,
        context: sent,
        client: clientFor(key, runId, "review"),
        clientForRole: (role) => clientFor(key, runId, role),
        model: inputData.model,
        contextLength: inputData.contextLength,
        route: { provider: "nebius", endpoint: deps.endpoint.kind, model: inputData.model },
        policy: policyFor(inputData.model),
        mask: deps.mask,
        signal: abortSignal,
        save: (report) => deps.saveResult(runId, report),
        progress: (message, data) => deps.recorder.output(runId, "review", message, data),
        modelCall: (message, data) => deps.recorder.event(runId, "model.call", "review", message, data),
        ...(deps.limits ? { limits: deps.limits } : {}),
        ...(deps.requestMs ? { requestMs: deps.requestMs } : {}),
      });
      deps.setMeta(runId, { usage: final.usage });
      if (final.outcome === "complete") return { outcome: final.outcome, findings: final.reviewers.reduce((sum, report) => sum + report.findings.length, 0) };
      if (final.outcome === "cancelled") throw new ModelFailure("cancelled", "Cancelled.");
      throw incompleteFailure(final, sent.packet);
    }),
  });

  return createWorkflow({
    id: REVIEW_WORKFLOW_ID,
    description: "Reviews one saved plan version: two independent reviewers and a chair, or one reviewer, within a shared budget",
    inputSchema: Input,
    outputSchema: Reviewed,
    // Recovery belongs to the run scheduler: a run interrupted by a restart is marked failed, never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(context)
    .then(prepare)
    .then(review)
    .commit();
}
