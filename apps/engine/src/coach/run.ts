import { createTool } from "@mastra/core/tools";
import {
  COACH_RUN_LIMITS,
  COACH_TOOL,
  preferencesDigest,
  renderCoachPacket,
  type CoachContext,
  type CoachReport,
  type CoachStage,
  type JsonObject,
  type Mask,
  type RunRoute,
} from "@nivra/domain";
import { CHARS_PER_TOKEN } from "../explain/budget.ts";
import { usageOf } from "../explain/reading.ts";
import { toolDefinitionChars } from "../explain/tools.ts";
import { failure, InternalFailure, ModelFailure, type ModelClient, type StepRecord } from "../providers/model.ts";
import { requestBudget, type ModelPolicy } from "../providers/policy.ts";
import { RunBudget } from "../providers/run-budget.ts";
import { CoachAnswer, COACH_TOOL_DESCRIPTION, normaliseCoaching, type NormalisedCoaching } from "./answers.ts";
import { COACH_INSTRUCTIONS, COACH_INSTRUCTIONS_SHA256, coachMessage } from "./prompt.ts";
import type { CoachTask } from "./task.ts";

/**
 * One coaching of one task's brief (NIV-53): one request, after one listing of the models, and nothing else. One
 * deadline covers the run, counted from its first step, so the listing's time is the request's too: the request gets
 * the smaller of its own limit and the time left (D30). Its answer is forced through the coach's form, and only a model
 * a check has seen honour that may answer: any other is refused before any inference request. No repair call, no
 * retry. The report is saved when the run starts, again just before the request may go out, and at the end, so a run
 * cut off mid-request says that its request may have been sent.
 */

const TOOL_SPECS = { [COACH_TOOL]: { description: COACH_TOOL_DESCRIPTION, inputSchema: CoachAnswer } };
/** What a request's messages add beyond their text, as a chat template wraps them: an allowance, in tokens. */
const MESSAGE_ALLOWANCE_TOKENS = 64;

/** A whole request's estimated input: instructions, message, the tool's definition and the template's allowance (D30). */
export function estimateCoachRequest(message: string): number {
  return Math.ceil((COACH_INSTRUCTIONS.length + message.length + toolDefinitionChars(TOOL_SPECS)) / CHARS_PER_TOKEN) + MESSAGE_ALLOWANCE_TOKENS;
}

/** The characters the coach's own text adds to a request: its instructions and its tool's definition. */
export function coachFixedChars(): number {
  return COACH_INSTRUCTIONS.length + toolDefinitionChars(TOOL_SPECS);
}

export interface CoachRunOptions {
  runId: string;
  clientRequestId: string;
  task: CoachTask;
  context: CoachContext;
  client: ModelClient;
  /** The listing's pick (D22), refused before any request unless the policy forces its answer and, when the run names one, it is that model. */
  model: string;
  contextLength: number | null;
  route: RunRoute;
  policy: ModelPolicy;
  mask: Mask;
  signal?: AbortSignal | undefined;
  /** Saves the report as it stands: at the start, just before the request, and at the end. */
  save: (report: CoachReport) => void;
  /** A readable line for the run's timeline, with safe data. */
  progress: (message: string, data: JsonObject) => void;
  /** The one model request, as the timeline records it. */
  modelCall: (message: string, data: JsonObject) => void;
  /** When the run started, on the monotonic clock: its one deadline counts from here. Defaults to now. */
  startedAt?: number;
  /** Tests only: shorter limits, and a clock. */
  limits?: Partial<Record<"totalMs" | "requestMs" | "estimatedInputTokens", number>>;
  now?: () => number;
}

const UNCHANGED = "Nothing was proposed, and your brief is unchanged.";
const n = (value: number) => value.toLocaleString("en");

/** The coach's own words for each way a coaching ends without an answer: what happened, and what to do. */
export const COACH_WORDS = {
  notChecked: (model: string) =>
    `The coach can't use ${model}: Nivra hasn't checked that it hands in an answer through a form, which the coach needs, so nothing was sent. Check Token Factory in Settings to see which models the key can use.`,
  notNamed: (allowed: string, offered: string) => `This coaching may use ${allowed} only, and the key's listing offers ${offered}, so nothing was sent. Check Token Factory in Settings to see which models the key can use.`,
  tooSmall: (needed: number, available: number) =>
    `The model's context is too small for this coaching: about ${n(needed)} tokens are needed, and ${n(Math.max(0, available))} are available once ${n(COACH_RUN_LIMITS.outputTokensPerRequest)} are held back for the answer, so nothing was sent. Shorten the brief, starting with its longest part, then ask the coach again.`,
  overBudget: (needed: number, available: number) => `The coach's request needs about ${n(needed)} tokens, more than the ${n(available)} its estimated budget allows, so nothing was sent. Shorten the brief, starting with its longest part, then ask the coach again.`,
  noTime: "The coaching ran out of time before its request could be sent, so nothing was sent. Ask the coach again.",
  late: (seconds: number) => `The coach didn't answer within the ${seconds} s this coaching had left. ${UNCHANGED} Ask the coach again.`,
  unreadable: (why: string) => `The coach's answer couldn't be used: ${why}. ${UNCHANGED} Ask the coach again if you want another try.`,
  unusable: (parts: number) => `The coach's answer couldn't be used: Nivra set aside all ${parts} ${parts === 1 ? "part" : "parts"} it handed in, and kept none. ${UNCHANGED} Ask the coach again if you want another try.`,
  empty: `The coach handed in an empty answer. ${UNCHANGED} Ask the coach again if you want another try.`,
} as const;

/** Why an answer couldn't be read, in Nivra's own words. */
function unusable(steps: readonly StepRecord[], schemaProblems: readonly string[]): string {
  if (schemaProblems.length) return "its answer didn't match the coach's form";
  const last = steps.at(-1);
  if (last?.finishReason === "length") return "its answer was cut off at the output limit";
  if (last && !last.toolNames.length) return "it answered in plain text, not through the coach's form";
  return "it handed in nothing that could be used";
}

/**
 * A report saved as its request goes out: its budget counts that request as the budget counts one let go (D30), with
 * its input estimated and nothing reported, since it may be sent from here on.
 */
function goingOut(report: CoachReport, inputTokens: number): CoachReport {
  const { used } = report.budget;
  return {
    ...report,
    budget: { ...report.budget, used: { ...used, requests: used.requests + 1, inputTokens: used.inputTokens + inputTokens, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: used.unreportedRequests + 1 } },
  };
}

const EMPTY: Pick<NormalisedCoaching, "summary" | "questions" | "changes" | "suggestedChecks" | "unknowns" | "dropped"> = {
  summary: "",
  questions: [],
  changes: [],
  suggestedChecks: [],
  unknowns: [],
  dropped: { questions: 0, changes: 0, items: 0, refs: 0, checks: 0, unknowns: 0 },
};

/**
 * Runs the coaching, and returns its report when it is complete. Any other end saves the report first, then throws
 * the failure the run ends with, in Nivra's words: a refusal before the request, the request's own failure, or an
 * answer that couldn't be used.
 */
export async function runCoach(options: CoachRunOptions): Promise<CoachReport> {
  const { task, context, mask } = options;
  const now = options.now ?? (() => performance.now());
  const started = options.startedAt ?? now();
  const totalMs = options.limits?.totalMs ?? COACH_RUN_LIMITS.totalMs;
  const requestMs = options.limits?.requestMs ?? COACH_RUN_LIMITS.requestMs;
  const limits = {
    requests: COACH_RUN_LIMITS.requests,
    totalMs: Math.max(0, Math.floor(started + totalMs - now())),
    outputTokensPerRequest: COACH_RUN_LIMITS.outputTokensPerRequest,
    estimatedInputTokens: options.limits?.estimatedInputTokens ?? COACH_RUN_LIMITS.estimatedInputTokens,
  };
  const budget = new RunBudget(limits, { signal: options.signal, now });
  const message = coachMessage(context.packet, context.preferences, mask, context.knowledge);
  const estimated = estimateCoachRequest(message);
  const stage: CoachStage = {
    status: "pending",
    reason: null,
    kind: null,
    message: null,
    problems: [],
    requests: 0,
    estimatedInputTokens: estimated,
    inputTokens: null,
    outputTokens: null,
    elapsedMs: null,
    finishReason: null,
    servedModel: null,
  };
  let kept: Pick<NormalisedCoaching, "summary" | "questions" | "changes" | "suggestedChecks" | "unknowns" | "dropped"> = EMPTY;
  const steps: StepRecord[] = [];
  const preferences = {
    revision: context.preferences.revision,
    digest: await preferencesDigest(context.preferences.records),
    records: context.preferences.records.map(({ id, scope, intent, revision }) => ({ id, scope, intent, revision })),
  };
  const { packet } = context;
  const packetChars = renderCoachPacket(packet).length;
  const report = (outcome: CoachReport["outcome"], finished: boolean): CoachReport => ({
    profile: { id: task.profile.id, version: task.profile.version },
    instructionsSha256: COACH_INSTRUCTIONS_SHA256,
    taskId: task.taskId,
    briefVersion: task.briefVersion,
    bindingDigest: task.bindingDigest,
    packetDigest: task.packetDigest,
    preferencesDigest: task.preferencesDigest,
    ...(context.knowledge ? { knowledge: { digest: context.knowledge.digest, records: context.knowledge.records.map(({ id, revision }) => ({ id, revision })) } } : {}),
    outcome,
    scope: packet.scope.kind,
    packet: { chars: packetChars, criteria: packet.task.acceptanceCriteria.length, assumptions: packet.task.assumptions.length, gaps: packet.gaps.length, mission: packet.mission !== null, findings: packet.findings.length },
    summary: kept.summary,
    questions: kept.questions,
    changes: kept.changes,
    suggestedChecks: kept.suggestedChecks,
    unknowns: kept.unknowns,
    dropped: { ...kept.dropped },
    stage: { ...stage, problems: [...stage.problems] },
    request: { runId: options.runId, clientRequestId: options.clientRequestId },
    route: options.route,
    sampling: { temperature: null, topP: null, maxOutputTokens: limits.outputTokensPerRequest, toolChoice: "forced" },
    preferences,
    usage: usageOf(steps),
    budget: budget.record(),
    elapsedMs: Math.max(0, Math.round(now() - started)),
    updatedAt: new Date().toISOString(),
    finishedAt: finished ? new Date().toISOString() : null,
  });
  /** Ends the run without a request: the stage says why, and the report is kept. Returns the failure to throw. */
  const refuse = (reason: CoachStage["reason"], error: ModelFailure): ModelFailure => {
    Object.assign(stage, { status: "skipped", reason, kind: error.kind, message: error.message.slice(0, 400) });
    options.save(report(error.kind === "cancelled" ? "cancelled" : "failed", true));
    return error;
  };

  // Only a model a check has seen honour a forced answer may coach, and only the one the run names, when it names one:
  // checked before anything is sent (D22).
  if (!options.policy.forceAnswer) {
    throw refuse("model-not-allowed", new ModelFailure("model-unavailable", COACH_WORDS.notChecked(options.model)));
  }
  if (task.model !== undefined && task.model !== options.model) {
    throw refuse("model-not-allowed", new ModelFailure("model-unavailable", COACH_WORDS.notNamed(task.model, options.model)));
  }
  // A request larger than the model's window is never sent (D23).
  const window = requestBudget(options.contextLength, limits.outputTokensPerRequest);
  if (estimated > window) {
    throw refuse("budget", new ModelFailure("context-too-small", COACH_WORDS.tooSmall(estimated, window)));
  }
  // The request is held for its own limit or the time left, whichever is less (the clock is read once).
  const held = budget.hold({ inputTokens: estimated, ms: requestMs }, { upTo: true });
  if (!("admit" in held)) {
    if (held.reason === "cancelled") throw refuse("cancelled", new ModelFailure("cancelled", "Cancelled."));
    if (held.reason === "deadline" || held.reason === "time") throw refuse("deadline", new ModelFailure("timeout", COACH_WORDS.noTime));
    throw refuse("budget", new ModelFailure("budget-exhausted", COACH_WORDS.overBudget(held.needed, held.available)));
  }
  const hold = held;
  options.save(report("in-progress", false));

  let handedIn: unknown = null;
  const tool = createTool({
    id: COACH_TOOL,
    description: COACH_TOOL_DESCRIPTION,
    inputSchema: CoachAnswer,
    execute: async (input) => {
      handedIn ??= input;
      return { accepted: true };
    },
  });
  const agent = options.client.agent({ id: "nivra-coach", name: "Nivra task readiness coach", modelId: options.model, instructions: COACH_INSTRUCTIONS, tools: { [COACH_TOOL]: tool } });
  // Saved with the request counted as the budget counts one let go, before it is admitted: read back after its engine
  // stopped, the report then says it may have gone, and that what it used is unknown.
  Object.assign(stage, { status: "running", requests: 1 });
  options.save(goingOut(report("in-progress", false), estimated));
  const admitted = hold.admit();
  if (!admitted.ok) {
    hold.release();
    Object.assign(stage, { requests: 0 });
    const reason = admitted.refusal.reason === "cancelled" ? "cancelled" : "deadline";
    throw refuse(reason, reason === "cancelled" ? new ModelFailure("cancelled", "Cancelled.") : new ModelFailure("timeout", COACH_WORDS.noTime));
  }
  const { ms } = admitted;
  options.progress(`The coach is reading brief v${task.briefVersion}`, { stage: "coach", phase: "started", estimatedInputTokens: estimated, ms });

  // A guard ends the request at its time, whatever the client does.
  const timeUp = new AbortController();
  const timer = setTimeout(() => timeUp.abort(), ms);
  let failed: ModelFailure | null = null;
  try {
    await options.client.call(agent, message, {
      maxSteps: 1,
      deadlines: { stepMs: ms, totalMs: ms },
      maxOutputTokens: limits.outputTokensPerRequest,
      includeReasoningTokens: true,
      toolChoice: { type: "tool", toolName: COACH_TOOL },
      internal: new InternalFailure(),
      signal: options.signal ? AbortSignal.any([options.signal, timeUp.signal]) : timeUp.signal,
      onStep: (step) => steps.push(step),
    });
  } catch (error) {
    failed = error instanceof ModelFailure ? error : failure("internal", "");
    if (failed.failedStep) steps.push(failed.failedStep);
  } finally {
    clearTimeout(timer);
  }
  hold.settle(steps);
  for (const step of steps) {
    const tokens = step.inputTokens !== null && step.outputTokens !== null ? `${step.inputTokens} in / ${step.outputTokens} out tokens` : "tokens not reported";
    options.modelCall(`The coach: ${tokens}, ${(step.elapsedMs / 1000).toFixed(1)} s`, {
      stage: "coach",
      model: options.model,
      elapsedMs: step.elapsedMs,
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      // A reported subset of output, never added to the billed total. Missing remains unknown.
      reasoningTokens: step.reasoningTokens ?? null,
      finishReason: step.finishReason,
      tools: step.toolNames,
    });
  }
  const last = steps.at(-1);
  Object.assign(stage, {
    inputTokens: steps.length && steps.every((step) => step.inputTokens !== null) ? steps.reduce((sum, step) => sum + step.inputTokens!, 0) : null,
    outputTokens: steps.length && steps.every((step) => step.outputTokens !== null) ? steps.reduce((sum, step) => sum + step.outputTokens!, 0) : null,
    elapsedMs: steps.length ? Math.round(steps.reduce((sum, step) => sum + step.elapsedMs, 0)) : null,
    finishReason: last?.finishReason ?? null,
    servedModel: last?.servedModel ?? null,
  });
  /** Ends the run after its request: the stage says how, and the report is kept. Returns the failure to throw. */
  const fail = (error: ModelFailure, extra: Partial<CoachStage> = {}): ModelFailure => {
    Object.assign(stage, { status: "failed", kind: error.kind, message: error.message.slice(0, 400), ...extra });
    options.save(report(error.kind === "cancelled" ? "cancelled" : "failed", true));
    return error;
  };

  if (failed) {
    const stopped = failed.kind === "cancelled" && options.signal?.aborted === true;
    const outOfTime = failed.kind === "timeout" || (failed.kind === "cancelled" && !stopped && timeUp.signal.aborted);
    if (stopped) throw fail(new ModelFailure("cancelled", "Cancelled."), { reason: "cancelled", message: "Cancelled while its request was out." });
    if (outOfTime) throw fail(new ModelFailure("timeout", COACH_WORDS.late(Math.round(ms / 1000))), { reason: "deadline" });
    throw fail(failed);
  }
  if (handedIn === null) {
    const problems = steps.flatMap((step) => step.rejectedTools.filter((rejected) => rejected.tool === COACH_TOOL).flatMap((rejected) => rejected.problems));
    throw fail(new ModelFailure("malformed", COACH_WORDS.unreadable(unusable(steps, problems))), { problems: problems.slice(0, 10) });
  }
  const parsed = CoachAnswer.safeParse(handedIn);
  if (!parsed.success) throw fail(new ModelFailure("malformed", COACH_WORDS.unreadable("its answer didn't match the coach's form")), { problems: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "answer"}: ${issue.code}`) });
  const normal = normaliseCoaching(parsed.data, packet, mask, context.knowledge?.records.length ?? 0);
  kept = normal;
  stage.problems = normal.problems;
  const setAside = Object.values(normal.dropped).reduce((sum, n) => sum + n, 0);
  if (normal.outcome !== "complete") {
    Object.assign(stage, {
      status: "failed",
      kind: "malformed",
      message: normal.outcome === "unusable" ? COACH_WORDS.unusable(setAside) : COACH_WORDS.empty,
    });
    const final = report(normal.outcome, true);
    options.save(final);
    throw new ModelFailure("malformed", stage.message!);
  }
  stage.status = "answered";
  const final = report("complete", true);
  options.save(final);
  options.progress(
    `The coach handed in ${kept.questions.length} ${kept.questions.length === 1 ? "question" : "questions"} and ${kept.changes.length} proposed ${kept.changes.length === 1 ? "change" : "changes"}${setAside ? `; ${setAside} set aside` : ""}`,
    { stage: "coach", phase: "ended", questions: kept.questions.length, changes: kept.changes.length, checks: kept.suggestedChecks.length, setAside },
  );
  return final;
}
