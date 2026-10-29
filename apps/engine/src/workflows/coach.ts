import { createStep, createWorkflow } from "@mastra/core/workflows";
import { COACH_PROFILE, COACH_RUN_LIMITS, coachPacketDigest, preferencesDigest, knowledgeDigest, type CoachContext, type CoachReport, type Mask, type RunRoute, type RunUsage } from "@nivra/domain";
import { z } from "zod";
import { runCoach, type CoachRunOptions } from "../coach/run.ts";
import { coachUnreadable, type CoachTask } from "../coach/task.ts";
import { createModelClient, failure, ModelFailure, type Endpoint, type ModelClient } from "../providers/model.ts";
import { policyFor } from "../providers/policy.ts";
import { pickNemotron } from "../providers/tokenfactory.ts";
import type { ExplainRecorder } from "./explain.ts";
import { guard } from "./guard.ts";
import { describePreferences } from "./preferences-record.ts";

export const COACH_WORKFLOW_ID = "coach";

/**
 * A coaching of one task's brief (NIV-53). It reaches no repository and changes nothing: it has no execution backend,
 * no git and no path, only the packet the host froze, held in memory (D21). Mastra gets nothing of it; the report is
 * saved by the engine's store. Before anything is sent, the packet and the preferences are checked against the
 * fingerprints the run was asked for, the profile against the engine's own, and the consent and the key are read: a
 * refusal then sends nothing. One deadline covers the run from its first step, the model's listing included.
 */
export interface CoachDeps {
  recorder: ExplainRecorder;
  /** What the host sent with the run, held in memory by the scheduler (D21). */
  context: (runId: string) => CoachContext | null;
  /** The task's ids, the brief version, the fingerprints and the profile, from the run store. */
  task: (runId: string) => CoachTask | null;
  /** The request id the host sent the run with. */
  requestId: (runId: string) => string | null;
  apiKey: () => string | null;
  endpoint: Endpoint;
  mask: Mask;
  setMeta: (runId: string, meta: { usage?: RunUsage; route?: RunRoute }) => void;
  saveResult: (runId: string, report: CoachReport) => void;
  /** Tests only, in-process: a client over a mock model, and shorter limits. */
  modelClient?: (apiKey: string, endpoint: Endpoint) => ModelClient;
  limits?: CoachRunOptions["limits"];
}

const Input = z.strictObject({});
const Prepared = z.strictObject({ model: z.string(), contextLength: z.number().nullable() });
const Coached = z.strictObject({ outcome: z.enum(["complete"]), questions: z.number().int().nonnegative(), changes: z.number().int().nonnegative() });

export function createCoachWorkflow(deps: CoachDeps) {
  const clientFor = (key: string) => (deps.modelClient ? deps.modelClient(key, deps.endpoint) : createModelClient({ apiKey: key, endpoint: deps.endpoint }));
  const totalMs = deps.limits?.totalMs ?? COACH_RUN_LIMITS.totalMs;
  /** Each run's start, on the monotonic clock: its one deadline counts from here, its checks and listing included. */
  const startedAt = new Map<string, number>();
  const timeLeft = (runId: string) => (startedAt.get(runId) ?? performance.now()) + totalMs - performance.now();

  const given = (runId: string): CoachContext => {
    const context = deps.context(runId);
    if (!context) throw failure("internal", "this run's context is missing").because("context-missing", "coach.context");
    return context;
  };
  const taskOf = (runId: string): CoachTask => {
    const task = deps.task(runId);
    if (!task) throw coachUnreadable();
    return task;
  };
  /** A project's packet needs that project's consent, and every coaching a key: both checked before anything is sent. */
  const allowed = (runId: string): { context: CoachContext; key: string } => {
    const context = given(runId);
    if (context.packet.scope.kind === "project" && !context.sharing.modelContext) throw failure("sharing-refused");
    const key = deps.apiKey();
    if (!key) throw failure("no-key");
    return { context, key };
  };

  // What the coaching was given, checked against what it was asked for, and recorded as counts and fingerprints.
  const context = createStep({
    id: "context",
    description: "Check the packet, the preferences and the profile against what the coaching was asked for",
    inputSchema: Input,
    outputSchema: Input,
    execute: async ({ inputData, runId }) =>
      guard("coach.context", deps.mask, async () => {
        startedAt.set(runId, performance.now());
        try {
          const task = taskOf(runId);
          const sent = given(runId);
          if (task.profile.id !== COACH_PROFILE.id || task.profile.version !== COACH_PROFILE.version) {
            throw failure("internal", "this coaching asked for a coach this engine doesn't have").because("input-refused", "coach.context");
          }
          const [packet, preferences] = await Promise.all([coachPacketDigest(sent.packet), preferencesDigest(sent.preferences.records)]);
          if (packet !== task.packetDigest || preferences !== task.preferencesDigest) {
            throw failure("internal", "what was sent isn't what this coaching was asked for").because("input-refused", "coach.context");
          }
          if ((sent.knowledge?.digest ?? undefined) !== task.knowledgeDigest || (sent.knowledge && await knowledgeDigest(sent.knowledge.records) !== sent.knowledge.digest)) {
            throw failure("internal", "the retained knowledge isn't what this coaching was asked for").because("input-refused", "coach.context");
          }
          if (sent.packet.task.briefVersion !== task.briefVersion) {
            throw failure("internal", "the packet holds another brief version than this coaching was asked for").because("input-refused", "coach.context");
          }
          // A task with no repository gets personal preferences only (D21).
          if (sent.packet.scope.kind === "general" && sent.preferences.records.some((record) => record.scope === "project")) {
            throw failure("internal", "a coaching of a task with no repository was sent a project's own preference").because("input-refused", "coach.context");
          }
          if (sent.packet.scope.kind === "general" && sent.knowledge?.records.some((record) => record.projectId !== null || record.scope.kind === "project")) {
            throw failure("internal", "a coaching of a task with no repository was sent a project's retained knowledge").because("input-refused", "coach.context");
          }
          const described = await describePreferences(sent.preferences);
          const counts = sent.packet;
          deps.recorder.output(
            runId,
            "context",
            `Brief v${task.briefVersion}: ${counts.task.acceptanceCriteria.length} criteria, ${counts.task.assumptions.length} assumptions, ${counts.gaps.length} gaps found by Nivra's rules${counts.mission ? ", the mission" : ""}${counts.findings.length ? `, ${counts.findings.length} findings` : ""}. ${described.message}`,
            {
              briefVersion: task.briefVersion,
              scope: counts.scope.kind,
              criteria: counts.task.acceptanceCriteria.length,
              assumptions: counts.task.assumptions.length,
              gaps: counts.gaps.length,
              mission: counts.mission !== null,
              findings: counts.findings.length,
              packetDigest: packet,
              ...(sent.knowledge ? { knowledgeDigest: sent.knowledge.digest, knowledge: sent.knowledge.records.map(({ id, revision }) => ({ id, revision })) } : {}),
              ...described.data,
            },
          );
          return inputData;
        } catch (error) {
          // A run stopped here never reaches the coach, which would forget its start.
          startedAt.delete(runId);
          throw error;
        }
      }),
  });

  const prepare = createStep({
    id: "prepare",
    description: "Check the key and consent, and pick the model",
    inputSchema: Input,
    outputSchema: Prepared,
    execute: async ({ runId, abortSignal }) =>
      guard("coach.prepare", deps.mask, async () => {
        try {
          const { key } = allowed(runId);
          // The listing has its own limit, and no more than the run's time left.
          const left = Math.floor(timeLeft(runId));
          if (left <= 0) throw new ModelFailure("timeout", "The coaching ran out of time before its request could be sent, so nothing was sent. Ask the coach again.");
          const models = await clientFor(key).listModels({ signal: abortSignal, timeoutMs: Math.min(COACH_RUN_LIMITS.listMs, left) });
          const model = pickNemotron(models.ids);
          if (!model) throw failure("model-unavailable", "no NVIDIA model is listed for this key");
          deps.setMeta(runId, { route: { provider: "nebius", endpoint: deps.endpoint.kind, model } });
          const contextLength = models.contextLengths.get(model) ?? null;
          deps.recorder.output(runId, "prepare", `Model ${model}`, { model, contextLength });
          return { model, contextLength };
        } catch (error) {
          startedAt.delete(runId);
          throw error;
        }
      }),
  });

  const coach = createStep({
    id: "coach",
    description: "One request to the task readiness coach",
    inputSchema: Prepared,
    outputSchema: Coached,
    execute: async ({ inputData, runId, abortSignal }) =>
      guard("coach.coach", deps.mask, async () => {
        // What the run used is kept with it however it ends: the last report saved says.
        let saved: CoachReport | null = null;
        try {
          const task = taskOf(runId);
          const { context: sent, key } = allowed(runId);
          const final = await runCoach({
            runId,
            clientRequestId: deps.requestId(runId) ?? runId,
            task,
            context: sent,
            client: clientFor(key),
            model: inputData.model,
            contextLength: inputData.contextLength,
            route: { provider: "nebius", endpoint: deps.endpoint.kind, model: inputData.model },
            policy: policyFor(inputData.model),
            mask: deps.mask,
            signal: abortSignal,
            save: (report) => {
              saved = report;
              deps.saveResult(runId, report);
            },
            progress: (message, data) => deps.recorder.output(runId, "coach", message, data),
            modelCall: (message, data) => deps.recorder.event(runId, "model.call", "coach", message, data),
            ...(startedAt.has(runId) ? { startedAt: startedAt.get(runId)! } : {}),
            ...(deps.limits ? { limits: deps.limits } : {}),
          });
          return { outcome: "complete" as const, questions: final.questions.length, changes: final.changes.length };
        } finally {
          if (saved) deps.setMeta(runId, { usage: (saved as CoachReport).usage });
          startedAt.delete(runId);
        }
      }),
  });

  return createWorkflow({
    id: COACH_WORKFLOW_ID,
    description: "One bounded request to the task readiness coach about one task's brief",
    inputSchema: Input,
    outputSchema: Coached,
    // Recovery belongs to the run scheduler: a run interrupted by a restart is marked failed, never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(context)
    .then(prepare)
    .then(coach)
    .commit();
}
