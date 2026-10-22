import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { Mask, ReviewScope, RunRoute, RunUsage } from "@nivra/domain";
import { z } from "zod";
import { Refusal } from "../diagnostics.ts";
import { createModelClient, failure, ModelFailure, type Endpoint, type ModelClient } from "../providers/model.ts";
import { policyFor } from "../providers/policy.ts";
import { pickNemotron } from "../providers/tokenfactory.ts";
import type { AssumptionId } from "../research/pages.ts";
import type { Retrieval } from "../research/retrieval.ts";
import { RESEARCH_STOP_MESSAGES, runResearch, type ResearchReportShape, type ResearchStopCode } from "../research/run.ts";
import { createTavily } from "../research/tavily.ts";
import type { ExplainRecorder } from "./explain.ts";
import { guard } from "./guard.ts";

export const RESEARCH_WORKFLOW_ID = "research";

/**
 * Research of a saved plan's assumptions (NIV-45). It reaches no repository and changes nothing: it has no execution
 * backend, no git and no path, only the packet the host froze, with the queries the person approved, held in memory
 * (D21). Mastra gets nothing of it; the report is saved by the engine's store. Before anything is sent, the packet is
 * checked against its fingerprint, every query is checked again, and the permissions and keys are read: a refusal then
 * sends nothing.
 *
 * Not registered yet: research's integration window wires it into the engine, and replaces the domain contract's
 * functions passed in below with the domain's own exports.
 */

/** What the host sends with a research run: the shape of the domain contract's `ResearchContext`, as zod reads it. */
export interface ResearchContextShape {
  sharing: { modelContext: boolean; webResearch: boolean };
  deny: { terms: string[]; paths: string[] };
  packet: {
    scope: ReviewScope;
    planText: string;
    assumptions: Array<{ id: AssumptionId; text: string; origin: { kind: "plan"; index: number } | { kind: "typed" }; query: string }>;
    sites: { mode: "prefer" | "restrict"; hosts: string[] } | null;
  };
}

/** What a research run reads back from its store: the plan's id and version, and the packet's fingerprint. */
export interface ResearchTask {
  planId: string;
  planVersion: number;
  packetDigest: string;
}

export interface ResearchDeps {
  recorder: ExplainRecorder;
  context: (runId: string) => ResearchContextShape | null;
  task: (runId: string) => ResearchTask | null;
  requestId: (runId: string) => string | null;
  /** The Token Factory key, and the Tavily key, from the vault. */
  modelKey: () => string | null;
  tavilyKey: () => string | null;
  endpoint: Endpoint;
  mask: Mask;
  /** The vault's values. */
  knownValues: () => readonly string[];
  setMeta: (runId: string, meta: { usage?: RunUsage; route?: RunRoute }) => void;
  saveResult: (runId: string, report: ResearchReportShape) => void;
  /** The domain contract's fingerprint and query checks, until research's integration window exports them. */
  packetDigest: (packet: ResearchContextShape["packet"]) => Promise<string>;
  queryProblems: (query: string, deny: ResearchContextShape["deny"], knownValues: readonly string[]) => readonly string[];
  /** Where Tavily is: its own address, or a stub on the loopback in tests. */
  tavilyUrl?: string;
  /** Tests only, in process: a client over a mock model, and another retrieval. */
  modelClient?: (apiKey: string, endpoint: Endpoint) => ModelClient;
  retrieval?: (apiKey: string) => Retrieval;
}

/** A stop before anything is sent, as a public refusal in Nivra's words, chosen by its code. */
export function researchRefusal(code: ResearchStopCode): Refusal {
  return new Refusal(`research-${code}`, RESEARCH_STOP_MESSAGES[code]);
}

/**
 * Why the run must stop before anything is sent, once the packet is read: it isn't what the run was asked for, or a
 * query doesn't pass the checks the host ran. Null when it may go on.
 */
export async function contextRefusal(task: ResearchTask, context: ResearchContextShape, deps: Pick<ResearchDeps, "packetDigest" | "queryProblems">, knownValues: readonly string[]): Promise<ResearchStopCode | null> {
  if ((await deps.packetDigest(context.packet)) !== task.packetDigest) return "packet-changed";
  if (context.packet.assumptions.some((assumption) => deps.queryProblems(assumption.query, context.deny, knownValues).length > 0)) return "unsafe-query";
  return null;
}

/** Why the run can't send anything: research turned off, a project's plan without model sharing, or a key missing. */
export function permissionRefusal(context: ResearchContextShape, keys: { model: string | null; tavily: string | null }): ResearchStopCode | null {
  if (!context.sharing.webResearch) return "web-research-off";
  if (context.packet.scope.kind === "project" && !context.sharing.modelContext) return "model-sharing-off";
  if (!keys.tavily) return "tavily-key-missing";
  if (!keys.model) return "model-key-missing";
  return null;
}

const Input = z.strictObject({});
const Prepared = z.strictObject({ model: z.string() });
const Researched = z.strictObject({ outcome: z.enum(["complete"]), assessments: z.number().int().nonnegative() });

export function createResearchWorkflow(deps: ResearchDeps) {
  const clientFor = (key: string) => (deps.modelClient ? deps.modelClient(key, deps.endpoint) : createModelClient({ apiKey: key, endpoint: deps.endpoint }));
  const retrievalFor = (key: string) => (deps.retrieval ? deps.retrieval(key) : createTavily({ apiKey: key, ...(deps.tavilyUrl ? { base: deps.tavilyUrl } : {}) }));
  /** Each run's start, on the monotonic clock: its one deadline counts from here, its checks included. */
  const startedAt = new Map<string, number>();

  const given = (runId: string): ResearchContextShape => {
    const context = deps.context(runId);
    if (!context) throw failure("internal", "this run's context is missing").because("context-missing", "research.context");
    return context;
  };
  const taskOf = (runId: string): ResearchTask => {
    const task = deps.task(runId);
    if (!task) throw failure("internal", "this run's plan and fingerprint can't be read back").because("input-unreadable", "research.context");
    return task;
  };
  const allowed = (runId: string): { context: ResearchContextShape; modelKey: string; tavilyKey: string } => {
    const context = given(runId);
    const keys = { model: deps.modelKey(), tavily: deps.tavilyKey() };
    const refused = permissionRefusal(context, keys);
    if (refused) throw researchRefusal(refused);
    return { context, modelKey: keys.model!, tavilyKey: keys.tavily! };
  };

  const context = createStep({
    id: "context",
    description: "Check the packet against its fingerprint, and every query again",
    inputSchema: Input,
    outputSchema: Input,
    execute: async ({ inputData, runId }) =>
      guard("research.context", deps.mask, async () => {
        startedAt.set(runId, performance.now());
        try {
          const task = taskOf(runId);
          const sent = given(runId);
          const refused = await contextRefusal(task, sent, deps, deps.knownValues());
          if (refused) throw researchRefusal(refused);
          deps.recorder.output(runId, "context", `Plan v${task.planVersion}: ${sent.packet.assumptions.length} ${sent.packet.assumptions.length === 1 ? "assumption" : "assumptions"} to check`, {
            planVersion: task.planVersion,
            scope: sent.packet.scope.kind,
            assumptions: sent.packet.assumptions.length,
            sites: sent.packet.sites?.hosts.length ?? 0,
            packetDigest: task.packetDigest,
          });
          return inputData;
        } catch (error) {
          // A run stopped here never reaches research, which would forget its start.
          startedAt.delete(runId);
          throw error;
        }
      }),
  });

  const prepare = createStep({
    id: "prepare",
    description: "Check the permissions and the keys, and pick the model",
    inputSchema: Input,
    outputSchema: Prepared,
    execute: async ({ runId, abortSignal }) =>
      guard("research.prepare", deps.mask, async () => {
        try {
          const { modelKey } = allowed(runId);
          const models = await clientFor(modelKey).listModels({ signal: abortSignal, timeoutMs: 30_000 });
          const model = pickNemotron(models.ids);
          if (!model) throw failure("model-unavailable", "no NVIDIA model is listed for this key");
          deps.setMeta(runId, { route: { provider: "nebius", endpoint: deps.endpoint.kind, model } });
          deps.recorder.output(runId, "prepare", `Model ${model}`, { model });
          return { model };
        } catch (error) {
          // A run stopped here never reaches research, which would forget its start.
          startedAt.delete(runId);
          throw error;
        }
      }),
  });

  const research = createStep({
    id: "research",
    description: "Search, read passages, and assess each assumption with checked citations",
    inputSchema: Prepared,
    outputSchema: Researched,
    execute: async ({ inputData, runId, abortSignal }) =>
      guard("research.research", deps.mask, async () => {
        const task = taskOf(runId);
        const { context: sent, modelKey, tavilyKey } = allowed(runId);
        try {
          const final = await runResearch({
            binding: { planId: task.planId, planVersion: task.planVersion, packetDigest: task.packetDigest, scope: sent.packet.scope, request: { runId, clientRequestId: deps.requestId(runId) ?? runId } },
            packet: sent.packet,
            retrieval: retrievalFor(tavilyKey),
            client: clientFor(modelKey),
            model: inputData.model,
            route: { provider: "nebius", endpoint: deps.endpoint.kind, model: inputData.model },
            policy: policyFor(inputData.model),
            mask: deps.mask,
            knownValues: deps.knownValues(),
            save: (report) => deps.saveResult(runId, report),
            progress: (message, data) => deps.recorder.output(runId, "research", message, data),
            modelCall: (message, data) => deps.recorder.event(runId, "model.call", "research", message, data),
            signal: abortSignal,
            ...(startedAt.has(runId) ? { startedAt: startedAt.get(runId)! } : {}),
          });
          deps.setMeta(runId, { usage: final.usage.model });
          if (final.outcome === "complete") return { outcome: "complete" as const, assessments: final.assessments.length };
          if (final.outcome === "cancelled") throw new ModelFailure("cancelled", "Cancelled.");
          throw new Refusal(`research-${final.stop?.code ?? "internal"}`, final.stop?.message ?? RESEARCH_STOP_MESSAGES.internal);
        } finally {
          startedAt.delete(runId);
        }
      }),
  });

  return createWorkflow({
    id: RESEARCH_WORKFLOW_ID,
    description: "Checks a saved plan's assumptions against public documentation, with the queries the person approved",
    inputSchema: Input,
    outputSchema: Researched,
    // Recovery belongs to the run scheduler: a run interrupted by a restart is marked failed, never re-driven.
    options: { autoRestartActiveRuns: false },
  })
    .then(context)
    .then(prepare)
    .then(research)
    .commit();
}
