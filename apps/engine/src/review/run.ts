import { createTool } from "@mastra/core/tools";
import {
  MISSION_COUNCIL,
  preferencesDigest,
  renderMissionPacket,
  REVIEW_TOOLS,
  SPECIALISTS,
  type JsonObject,
  type Mask,
  type MissionReviewPacket,
  type ModelFailureKind,
  type ReviewContext,
  type ReviewPacket,
  type ReviewPanel,
  type ReviewReport,
  type ReviewRole,
  type ReviewStage,
  type ReviewerReport,
  type RunRoute,
} from "@nivra/domain";
import { z } from "zod";
import { failure, InternalFailure, ModelFailure, type ModelClient, type StepRecord } from "../providers/model.ts";
import { ANSWER_TOKENS, requestBudget, type ModelPolicy } from "../providers/policy.ts";
import { RunBudget, type Hold, type RunLimits } from "../providers/run-budget.ts";
import { usageOf } from "../explain/reading.ts";
import { CHARS_PER_TOKEN } from "../explain/budget.ts";
import { toolDefinitionChars } from "../explain/tools.ts";
import { largestReport, normaliseReview, normaliseSynthesis, REVIEW_TOOL_DESCRIPTION, ReviewAnswer, SYNTHESIS_TOOL_DESCRIPTION, SynthesisAnswer } from "./answers.ts";
import { MissionReviewAnswer, normaliseMissionReview, rejectedProblems, rejectedReason } from "./mission-answers.ts";
import { MISSION_CHAIR_INSTRUCTIONS, missionReviewerInstructions, renderMissionChairMessage, renderMissionMessage } from "./mission-prompt.ts";
import { CHAIR_INSTRUCTIONS, renderChairMessage, renderPacket, reviewerInstructions } from "./prompt.ts";
import type { ReviewTask } from "./task.ts";

/**
 * One review of one plan version (NIV-38, D30). The whole budget is reserved before anything is sent: both reviewers,
 * and the chair at its largest. The reviewers then run together, each on its own agent and request, and settle on their
 * own: a fast failure neither ends the review nor stops the other. The chair runs only when both reports are in. Each
 * stage gets one request: no repair call, no retry. The report is saved when the review starts and after every stage,
 * so what finished is kept whatever happens next.
 */

/** The hard limits and the estimated input budget of each panel (D30). The council's two reviewers run together, then the chair. */
export const REVIEW_LIMITS: Readonly<Record<ReviewPanel, RunLimits>> = {
  council: { requests: 3, totalMs: 330_000, outputTokensPerRequest: ANSWER_TOKENS, estimatedInputTokens: 120_000 },
  single: { requests: 1, totalMs: 180_000, outputTokensPerRequest: ANSWER_TOKENS, estimatedInputTokens: 60_000 },
};
/** Each request's own deadline. */
export const REVIEW_REQUEST_MS = 150_000;
/** What a request's messages add beyond their text, as a chat template wraps them: an allowance, in tokens. */
const MESSAGE_ALLOWANCE_TOKENS = 64;

const TOOL_SPECS = {
  reviewer: { [REVIEW_TOOLS.reviewer]: { description: REVIEW_TOOL_DESCRIPTION, inputSchema: ReviewAnswer } },
  chair: { [REVIEW_TOOLS.chair]: { description: SYNTHESIS_TOOL_DESCRIPTION, inputSchema: SynthesisAnswer } },
  /** A mission reviewer's: the same form, its fields described for a mission (NIV-52). */
  "mission-reviewer": { [REVIEW_TOOLS.reviewer]: { description: REVIEW_TOOL_DESCRIPTION, inputSchema: MissionReviewAnswer } },
};

/**
 * The tools a mission review's stages are given (NIV-52), as JSON: what the model reads besides the instructions. A test
 * pins its hash to the profiles' version, and the live recipe binds it.
 */
export function missionToolDefinitions(): string {
  return JSON.stringify(
    [TOOL_SPECS["mission-reviewer"], TOOL_SPECS.chair].flatMap((specs) =>
      Object.entries(specs).map(([name, spec]) => ({ name, description: spec.description, parameters: z.toJSONSchema(spec.inputSchema, { target: "draft-7", io: "input", unrepresentable: "any" }) })),
    ),
  );
}

/** A whole request's estimated input: instructions, message, every tool definition, and the template's allowance (D30). */
export function estimateRequest(instructions: string, message: string, tools: keyof typeof TOOL_SPECS): number {
  return Math.ceil((instructions.length + message.length + toolDefinitionChars(TOOL_SPECS[tools])) / CHARS_PER_TOKEN) + MESSAGE_ALLOWANCE_TOKENS;
}

const ROLE_LABEL: Readonly<Record<ReviewRole | "chair", string>> = { architecture: "Architecture review", risks: "Risks review", single: "Review", chair: "The chair" };
/** Each stage as a sentence names it, so a stage's message stands alone, in the report and in a run's failure. */
const ROLE_NOUN: Readonly<Record<ReviewRole | "chair", string>> = { architecture: "The architecture review", risks: "The risks review", single: "The review", chair: "The chair's synthesis" };

const [ARCHITECT, RISK, CHAIR] = MISSION_COUNCIL.map((id) => SPECIALISTS[id].name);
/** A mission review's stages, named by the profiles that play them (NIV-52). */
const MISSION_LABEL: Readonly<Record<ReviewRole | "chair", string>> = { architecture: ARCHITECT!, risks: RISK!, single: "Review", chair: CHAIR! };
const MISSION_NOUN: Readonly<Record<ReviewRole | "chair", string>> = { architecture: "The product architect's review", risks: "The risk and testability review", single: "The review", chair: "The council chair's synthesis" };

/**
 * What differs between a review of a saved plan (D30) and one of a mission and its selected tasks (NIV-52): what the
 * reviewers read, the instructions each role gets, what a reference may name, what the stages are called and what the
 * report counts. Everything else, the budget, the requests and how stages end, is the same run.
 */
interface ReviewMode {
  /** What every reviewer reads, byte for byte. */
  message: string;
  instructions: (role: ReviewRole) => string;
  chairInstructions: string;
  chairMessage: (reports: readonly ReviewerReport[], mask: Mask) => string;
  /** The form a reviewer hands in, and the tools its request's estimate counts. */
  answer: typeof ReviewAnswer | typeof MissionReviewAnswer;
  tools: "reviewer" | "mission-reviewer";
  /** The report the engine keeps of an answer, or why the stage can't use it, in Nivra's words. */
  normalise: (role: ReviewRole, answer: ReviewAnswer) => { report: ReviewerReport } | { unusable: string; problems: string[] };
  label: Readonly<Record<ReviewRole | "chair", string>>;
  noun: Readonly<Record<ReviewRole | "chair", string>>;
  packet: ReviewReport["packet"];
  /** The timeline's line when the reviewers start. */
  reading: string;
}

const isMission = (packet: ReviewContext["packet"]): packet is MissionReviewPacket => "kind" in packet && packet.kind === "mission";

function planMode(packet: ReviewPacket, context: ReviewContext, task: ReviewTask, mask: Mask): ReviewMode {
  const message = renderPacket(packet, context.preferences, mask);
  return {
    message,
    instructions: reviewerInstructions,
    chairInstructions: CHAIR_INSTRUCTIONS,
    chairMessage: (reports, chairMask) => renderChairMessage(message, reports, chairMask),
    answer: ReviewAnswer,
    tools: "reviewer",
    normalise: (role, answer) => {
      const kept = normaliseReview(role, answer, packet, context.preferences, mask);
      return kept ? { report: kept } : { unusable: "it handed in an empty review", problems: [] };
    },
    label: ROLE_LABEL,
    noun: ROLE_NOUN,
    packet: { textChars: packet.text.length, assumptions: packet.assumptions.length, references: packet.references.length },
    reading: task.panel === "council" ? `Two reviewers are reading plan v${task.planVersion}` : `One reviewer is reading plan v${task.planVersion}`,
  };
}

function missionMode(packet: MissionReviewPacket, context: ReviewContext, task: ReviewTask, mask: Mask): ReviewMode {
  // The workflow refuses any other panel before a request; this keeps the runtime from ever trying one.
  if (task.panel !== "council") throw failure("internal", "a mission review needs the council").because("input-refused", "review.review");
  const message = renderMissionMessage(packet, context.preferences, mask);
  return {
    message,
    instructions: (role) => missionReviewerInstructions(role === "risks" ? "risks" : "architecture"),
    chairInstructions: MISSION_CHAIR_INSTRUCTIONS,
    chairMessage: (reports, chairMask) => renderMissionChairMessage(message, reports, chairMask),
    answer: MissionReviewAnswer,
    tools: "mission-reviewer",
    normalise: (role, answer) => {
      const kept = normaliseMissionReview(role, answer, packet, context.preferences, mask);
      if (kept.kind === "kept") return { report: kept.report };
      if (kept.kind === "rejected") return { unusable: rejectedReason(kept.setAside, kept.empty), problems: rejectedProblems(kept.setAside, kept.empty) };
      return { unusable: "it handed in an empty review", problems: [] };
    },
    label: MISSION_LABEL,
    noun: MISSION_NOUN,
    packet: { textChars: renderMissionPacket(packet).length, assumptions: 0, references: 0 },
    reading: `Two reviewers are reading the mission and ${packet.tasks.length} selected ${packet.tasks.length === 1 ? "task" : "tasks"}`,
  };
}

export interface ReviewRunOptions {
  runId: string;
  clientRequestId: string;
  task: ReviewTask;
  context: ReviewContext;
  client: ModelClient;
  model: string;
  contextLength: number | null;
  route: RunRoute;
  policy: ModelPolicy;
  mask: Mask;
  signal?: AbortSignal | undefined;
  /** Saves the report as it stands; called at the start, after every stage and at the end. */
  save: (report: ReviewReport) => void;
  /** A readable line for the run's timeline, with safe data. */
  progress: (message: string, data: JsonObject) => void;
  /** One model request, as the timeline records it. */
  modelCall: (message: string, data: JsonObject) => void;
  /** Tests only: other limits, and a clock. */
  limits?: RunLimits;
  requestMs?: number;
  now?: () => number;
}

const stage = (kind: ReviewStage["stage"], role: ReviewStage["role"]): ReviewStage => ({
  stage: kind,
  role,
  status: "pending",
  reason: null,
  kind: null,
  message: null,
  problems: [],
  requests: 0,
  estimatedInputTokens: null,
  inputTokens: null,
  outputTokens: null,
  elapsedMs: null,
  finishReason: null,
  servedModel: null,
});

/** Why a stage's answer couldn't be used, in Nivra's own words. */
function unusable(steps: readonly StepRecord[], schemaProblems: string[]): string {
  if (schemaProblems.length) return "its answer didn't match the review form";
  const last = steps.at(-1);
  if (last?.finishReason === "length") return "its answer was cut off at the output limit";
  if (last && !last.toolNames.length) return "it answered in plain text, not through the review form";
  return "it handed in nothing that could be used";
}

export async function runReview(options: ReviewRunOptions): Promise<ReviewReport> {
  const { task, context, client, mask } = options;
  const panel = task.panel;
  const limits = options.limits ?? REVIEW_LIMITS[panel];
  const requestMs = options.requestMs ?? REVIEW_REQUEST_MS;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const roles: ReviewRole[] = panel === "council" ? ["architecture", "risks"] : ["single"];
  const mode = isMission(context.packet) ? missionMode(context.packet, context, task, mask) : planMode(context.packet, context, task, mask);
  const packetMessage = mode.message;
  const instructions = new Map(roles.map((role) => [role, mode.instructions(role)] as const));
  const reviewerAsk = roles.map((role) => ({ inputTokens: estimateRequest(instructions.get(role)!, packetMessage, mode.tools), ms: requestMs }));
  // The chair's room is reserved at its largest: the packet and both reports as large as the engine lets them be.
  const chairAsk = { inputTokens: estimateRequest(mode.chairInstructions, mode.chairMessage(roles.map(largestReport), (text) => text), "chair"), ms: requestMs };

  // A request larger than the model's window is never sent (D23): say which, and how large.
  const window = requestBudget(options.contextLength);
  const largest = Math.max(...reviewerAsk.map((ask) => ask.inputTokens), panel === "council" ? chairAsk.inputTokens : 0);
  if (largest > window) {
    throw failure(
      "context-too-small",
      `about ${largest.toLocaleString("en")} tokens are needed for ${panel === "council" && chairAsk.inputTokens === largest ? "the chair's request, with both reports" : "a reviewer's request"}, and ${Math.max(0, window).toLocaleString("en")} are available once ${ANSWER_TOKENS.toLocaleString("en")} are held back for the answer`,
    );
  }

  const budget = new RunBudget(limits, { signal: options.signal, now });
  const reserved = budget.reserve(panel === "council" ? [reviewerAsk, [chairAsk]] : [reviewerAsk]);
  if (!reserved.ok) {
    const { needed, available, reason } = reserved.refusal;
    if (reason === "cancelled") throw new ModelFailure("cancelled", "Cancelled.");
    throw failure("budget-exhausted", `a review needs about ${needed.toLocaleString("en")} ${reason === "time" ? "ms" : reason === "requests" ? "requests" : "tokens"}, and ${available.toLocaleString("en")} are available`);
  }
  const holds = reserved.holds;

  const stages: ReviewStage[] = [...roles.map((role) => stage("reviewer", role)), stage("chair", "chair")];
  const chairStage = stages[stages.length - 1]!;
  if (panel === "single") Object.assign(chairStage, { status: "skipped", reason: "single-panel" });
  const reports = new Map<ReviewRole, ReviewerReport>();
  let synthesis: ReviewReport["synthesis"] = null;
  const steps: StepRecord[] = [];
  const preferences = {
    revision: context.preferences.revision,
    digest: await preferencesDigest(context.preferences.records),
    records: context.preferences.records.map(({ id, scope, intent, revision }) => ({ id, scope, intent, revision })),
  };

  const report = (outcome: ReviewReport["outcome"], finished: boolean): ReviewReport => ({
    panel,
    planId: task.planId,
    planVersion: task.planVersion,
    packetDigest: task.packetDigest,
    preferencesDigest: task.preferencesDigest,
    outcome,
    scope: context.packet.scope,
    packet: mode.packet,
    request: { runId: options.runId, clientRequestId: options.clientRequestId },
    route: options.route,
    sampling: { temperature: null, topP: null, maxOutputTokens: limits.outputTokensPerRequest, toolChoice: options.policy.forceAnswer ? "forced" : "auto" },
    preferences,
    reviewers: roles.flatMap((role) => (reports.has(role) ? [reports.get(role)!] : [])),
    synthesis,
    stages: stages.map((entry) => ({ ...entry, problems: [...entry.problems] })),
    usage: usageOf(steps),
    budget: budget.record(),
    elapsedMs: Math.round(now() - started),
    updatedAt: new Date().toISOString(),
    finishedAt: finished ? new Date().toISOString() : null,
  });
  const save = () => options.save(report("in-progress", false));
  save();

  /** One stage's request. Never throws: every way it can end is written into its stage. */
  const request = async <A>(
    entry: ReviewStage,
    hold: Hold,
    spec: { role: ReviewRole | "chair"; instructions: string; message: string; tool: string; description: string; schema: typeof ReviewAnswer | typeof MissionReviewAnswer | typeof SynthesisAnswer; estimated: number },
  ): Promise<A | null> => {
    const admitted = hold.admit();
    if (!admitted.ok) {
      hold.release();
      const reason = admitted.refusal.reason === "cancelled" ? "cancelled" : admitted.refusal.reason === "deadline" || admitted.refusal.reason === "time" ? "deadline" : "budget";
      Object.assign(entry, { status: "skipped", reason, message: reason === "cancelled" ? "Cancelled before its request was sent." : "There was no time or budget left to send its request." });
      save();
      return null;
    }
    Object.assign(entry, { status: "running", requests: 1, estimatedInputTokens: spec.estimated });
    save();
    let handedIn: unknown = null;
    const tool = createTool({
      id: spec.tool,
      description: spec.description,
      inputSchema: spec.schema,
      execute: async (input) => {
        handedIn ??= input;
        return { accepted: true };
      },
    });
    const internal = new InternalFailure();
    const agent = client.agent({ id: `nivra-review-${spec.role}`, name: `Nivra ${mode.label[spec.role].toLowerCase()}`, modelId: options.model, instructions: spec.instructions, tools: { [spec.tool]: tool } });
    const own: StepRecord[] = [];
    try {
      await client.call(agent, spec.message, {
        maxSteps: 1,
        deadlines: { stepMs: admitted.ms, totalMs: admitted.ms },
        maxOutputTokens: limits.outputTokensPerRequest,
        toolChoice: options.policy.forceAnswer ? { type: "tool", toolName: spec.tool } : "auto",
        internal,
        ...(options.signal ? { signal: options.signal } : {}),
        onStep: (step) => own.push(step),
      });
    } catch (error) {
      const failed = error instanceof ModelFailure ? error : failure("internal", "");
      if (failed.failedStep) own.push(failed.failedStep);
      Object.assign(
        entry,
        failed.kind === "cancelled"
          ? { status: "failed", kind: "cancelled", reason: "cancelled", message: "Cancelled while its request was out." }
          : { status: "failed", kind: failed.kind, message: `${mode.noun[spec.role]} failed: ${failed.message}`.slice(0, 400) },
      );
    }
    for (const step of own) {
      steps.push(step);
      const tokens = step.inputTokens !== null && step.outputTokens !== null ? `${step.inputTokens} in / ${step.outputTokens} out tokens` : "tokens not reported";
      options.modelCall(`${mode.label[spec.role]}: ${tokens}, ${(step.elapsedMs / 1000).toFixed(1)} s`, {
        stage: entry.stage,
        role: spec.role,
        model: options.model,
        elapsedMs: step.elapsedMs,
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        finishReason: step.finishReason,
        tools: step.toolNames,
      });
    }
    hold.settle(own);
    const last = own.at(-1);
    Object.assign(entry, {
      inputTokens: own.length && own.every((step) => step.inputTokens !== null) ? own.reduce((sum, step) => sum + step.inputTokens!, 0) : null,
      outputTokens: own.length && own.every((step) => step.outputTokens !== null) ? own.reduce((sum, step) => sum + step.outputTokens!, 0) : null,
      elapsedMs: own.length ? Math.round(own.reduce((sum, step) => sum + step.elapsedMs, 0)) : null,
      finishReason: last?.finishReason ?? null,
      servedModel: last?.servedModel ?? null,
    });
    if (entry.status === "failed") return null;
    if (handedIn === null) {
      const problems = own.flatMap((step) => step.rejectedTools.filter((rejected) => rejected.tool === spec.tool).flatMap((rejected) => rejected.problems));
      Object.assign(entry, { status: "failed", kind: "malformed", message: `${mode.noun[spec.role]} couldn't be used: ${unusable(own, problems)}.`, problems: problems.slice(0, 10) });
      return null;
    }
    return handedIn as A;
  };

  options.progress(mode.reading, {
    stage: "reviewer",
    phase: "started",
    panel,
    requests: roles.length + (panel === "council" ? 1 : 0),
    heldInputTokens: reviewerAsk.reduce((sum, ask) => sum + ask.inputTokens, 0) + (panel === "council" ? chairAsk.inputTokens : 0),
  });

  // The reviewers settle on their own: neither's failure ends the review while the other is still out (D30).
  await Promise.allSettled(
    roles.map(async (role, index) => {
      const entry = stages[index]!;
      const answer = await request<ReviewAnswer>(entry, holds[0]![index]!, {
        role,
        instructions: instructions.get(role)!,
        message: packetMessage,
        tool: REVIEW_TOOLS.reviewer,
        description: REVIEW_TOOL_DESCRIPTION,
        schema: mode.answer,
        estimated: reviewerAsk[index]!.inputTokens,
      });
      if (answer) {
        const kept = mode.normalise(role, answer);
        if ("report" in kept) {
          reports.set(role, kept.report);
          entry.status = "answered";
        } else {
          Object.assign(entry, { status: "failed", kind: "malformed", message: `${mode.noun[role]} couldn't be used: ${kept.unusable}.`, problems: kept.problems });
        }
      }
      options.progress(
        entry.status === "answered" ? `${mode.label[role]}: ${reports.get(role)!.findings.length} ${reports.get(role)!.findings.length === 1 ? "finding" : "findings"}` : `${mode.label[role]} didn't finish: ${entry.message ?? entry.status}`,
        { stage: "reviewer", role, phase: "ended", status: entry.status, kind: entry.kind, findings: reports.get(role)?.findings.length ?? 0 },
      );
      save();
    }),
  );

  if (panel === "council") {
    const chairHold = holds[1]![0]!;
    if (roles.every((role) => reports.has(role))) {
      const chairMessage = mode.chairMessage(roles.map((role) => reports.get(role)!), mask);
      options.progress("The chair is reading both reports", { stage: "chair", role: "chair", phase: "started" });
      const answer = await request<SynthesisAnswer>(chairStage, chairHold, {
        role: "chair",
        instructions: mode.chairInstructions,
        message: chairMessage,
        tool: REVIEW_TOOLS.chair,
        description: SYNTHESIS_TOOL_DESCRIPTION,
        schema: SynthesisAnswer,
        estimated: estimateRequest(mode.chairInstructions, chairMessage, "chair"),
      });
      if (answer) {
        synthesis = normaliseSynthesis(answer, roles.map((role) => reports.get(role)!), mask);
        if (synthesis) chairStage.status = "answered";
        else Object.assign(chairStage, { status: "failed", kind: "malformed", message: "The chair's synthesis couldn't be used: it handed in an empty one." });
      }
      options.progress(chairStage.status === "answered" ? "The chair's synthesis is in" : `The chair didn't finish: ${chairStage.message ?? chairStage.status}`, {
        stage: "chair",
        role: "chair",
        phase: "ended",
        status: chairStage.status,
        kind: chairStage.kind,
      });
    } else {
      // Never a synthesis of one view: with a report missing, the chair isn't asked (D30).
      chairHold.release();
      Object.assign(chairStage, { status: "skipped", reason: options.signal?.aborted ? "cancelled" : "reviewer-missing", message: options.signal?.aborted ? "Cancelled before its request was sent." : "Not asked: a reviewer's report is missing." });
      options.progress("The chair didn't run: a reviewer's report is missing", { stage: "chair", role: "chair", phase: "skipped", status: chairStage.status, kind: null });
    }
  }

  const outcome: ReviewReport["outcome"] = stages.every((entry) => entry.status === "answered" || entry.reason === "single-panel")
    ? "complete"
    : options.signal?.aborted
      ? "cancelled"
      : reports.size === 0
        ? "failed"
        : "incomplete";
  const final = report(outcome, true);
  options.save(final);
  return final;
}

/**
 * The failure a review that didn't complete ends the run with, after its report is saved: Nivra's words, and which
 * stage, named as its mode names it.
 */
export function incompleteFailure(final: ReviewReport, packet?: ReviewContext["packet"]): ModelFailure {
  const failed = final.stages.find((entry) => entry.status === "failed") ?? final.stages.find((entry) => entry.status === "skipped" && entry.reason !== "single-panel");
  const kind: ModelFailureKind = failed?.kind ?? (failed?.reason === "budget" ? "budget-exhausted" : failed?.reason === "deadline" ? "timeout" : "malformed");
  const kept = final.reviewers.length ? `What ${final.reviewers.length === 1 ? "the other reviewer" : "the reviewers"} found is kept. ` : "";
  const noun = packet && isMission(packet) ? MISSION_NOUN : ROLE_NOUN;
  const what = failed?.message ?? `${failed ? noun[failed.role] : "A stage"} didn't finish.`;
  const error = new ModelFailure(kind, `This review is incomplete. ${what} ${kept}Start a new review to try again.`.replace(/\s+/g, " ").trim());
  (error as ModelFailure & { stage?: string }).stage = failed?.stage === "chair" ? "chair" : failed?.role ?? "review";
  return error;
}
