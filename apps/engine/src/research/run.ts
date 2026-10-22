import { createTool } from "@mastra/core/tools";
import type { ReviewScope, RunBudgetRecord, RunRoute, RunUsage } from "@nivra/domain";
import { CHARS_PER_TOKEN } from "../explain/budget.ts";
import { toolDefinitionChars } from "../explain/tools.ts";
import { failure, InternalFailure, ModelFailure, type ModelClient, type StepRecord } from "../providers/model.ts";
import type { ModelPolicy } from "../providers/policy.ts";
import { RunBudget } from "../providers/run-budget.ts";
import { assess, ResearchAnswer, type Assessed } from "./assess.ts";
import { RESEARCH_LIMITS } from "./limits.ts";
import { chooseExtractions, collectPages, type AssumptionId, type Page } from "./pages.ts";
import { passagesFrom, type Passage } from "./passages.ts";
import { RESEARCH_INSTRUCTIONS, researchMessage } from "./prompt.ts";
import type { ExtractedPage, RequestFailure, Retrieval, Retrieved, SearchHit } from "./retrieval.ts";

/**
 * One research run (NIV-45). The model's request, and its largest input, are held in the run's budget before anything
 * goes to Tavily (D30). One absolute deadline covers the run; retrieval stops by its cutoff, so the model can't be
 * starved by it, and the model then gets the smaller of its own limit and the time left. The searches go together, one
 * per assumption, then one Extract per assumption with pages chosen fairly; the model then makes one request, with no
 * repair and no retry. Nothing is retried, and nothing is sent that the person didn't approve: the queries are theirs,
 * and the addresses are Search's own results, checked.
 *
 * The report is saved before every request and after it, so a run cut off mid-request says which request may have been
 * sent. Its words are Nivra's, chosen by code; Tavily's and the provider's never pass.
 */

/** The tool the model hands its assessment in with. Mirrors the domain contract's `RESEARCH_TOOL`. */
export const RESEARCH_TOOL = "submit_research";
const TOOL_DESCRIPTION = "Hand in the assessment of every assumption, each with its citations. Call this once.";
const TOOL_SPECS = { [RESEARCH_TOOL]: { description: TOOL_DESCRIPTION, inputSchema: ResearchAnswer } };
/** What a request's messages add beyond their text, as a chat template wraps them: an allowance, in tokens. */
const MESSAGE_ALLOWANCE_TOKENS = 64;

export type ResearchStopCode =
  | "nothing-read"
  | "tavily-key-missing"
  | "model-key-missing"
  | "web-research-off"
  | "model-sharing-off"
  | "unsafe-query"
  | "packet-changed"
  | "model-failed"
  | "cancelled"
  | "deadline"
  | "internal";

/** Each stop in the person's words: what happened, and what to do. */
export const RESEARCH_STOP_MESSAGES: Readonly<Record<ResearchStopCode, string>> = {
  "nothing-read": "No page could be read for any assumption, so nothing was assessed. Try other queries or sites, then start again.",
  "tavily-key-missing": "Research needs a Tavily API key. Add one in Settings, then start again.",
  "model-key-missing": "Research needs your Token Factory key. Add it in Settings, then start again.",
  "web-research-off": "Research queries to Tavily are turned off. Turn them on in Settings, then start again.",
  "model-sharing-off": "This project's plan can't be sent to Token Factory, because sharing is off for the project. Allow it, then start again.",
  "unsafe-query": "A query didn't pass Nivra's checks, so nothing was sent. Edit it, then start again.",
  "packet-changed": "What this research would send changed since it was previewed, so nothing was sent. Open it again.",
  "model-failed": "The model's assessment couldn't be used. The pages and passages read are kept below.",
  cancelled: "Stopped. Requests already sent to Tavily can't be withdrawn.",
  deadline: "The research ran out of time before the model could assess the passages. The pages and passages read are kept below.",
  internal: "Something inside Nivra failed during the research.",
};

export interface ResearchRequestEntry {
  id: "search-A1" | "search-A2" | "search-A3" | "extract-A1" | "extract-A2" | "extract-A3" | "model";
  kind: "search" | "extract" | "model";
  assumption: AssumptionId | null;
  state: "pending" | "sending" | "answered" | "failed" | "skipped";
  failure: RequestFailure | null;
  status: number | null;
  requestId: string | null;
  credits: number | null;
  pages: number;
  elapsedMs: number | null;
}

/** The report, in the shape of the domain contract's `ResearchReport`, which a test checks it against. */
export interface ResearchReportShape {
  planId: string;
  planVersion: number;
  packetDigest: string;
  outcome: "in-progress" | "complete" | "failed" | "cancelled" | "interrupted";
  scope: ReviewScope;
  request: { runId: string; clientRequestId: string };
  route: RunRoute | null;
  queries: Array<{ assumption: AssumptionId; text: string; query: string }>;
  sites: { mode: "prefer" | "restrict"; hosts: string[] } | null;
  requests: ResearchRequestEntry[];
  pages: Page[];
  passages: Passage[];
  assessments: Assessed["assessments"];
  checks: Assessed["checks"];
  stop: { code: ResearchStopCode; message: string } | null;
  usage: { credits: number | null; model: RunUsage };
  budget: RunBudgetRecord | null;
  elapsedMs: number;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ResearchRunOptions {
  binding: { planId: string; planVersion: number; packetDigest: string; scope: ReviewScope; request: { runId: string; clientRequestId: string } };
  packet: {
    planText: string;
    assumptions: ReadonlyArray<{ id: AssumptionId; text: string; query: string }>;
    sites: { mode: "prefer" | "restrict"; hosts: readonly string[] } | null;
  };
  retrieval: Retrieval;
  client: ModelClient;
  model: string;
  route: RunRoute | null;
  policy: ModelPolicy;
  /** The vault's values, then the credential shapes. */
  mask: (text: string) => string;
  /** The vault's values, for checking addresses. */
  knownValues: readonly string[];
  /** Saves the report, as it stands: at the start, before and after every request, and at the end. */
  save: (report: ResearchReportShape) => void | Promise<void>;
  /** Progress, as counts and ids only. */
  progress?: (message: string, data: Record<string, string | number | null>) => void;
  /** One line per model step, as counts only. */
  modelCall?: (message: string, data: Record<string, string | number | null | string[]>) => void;
  /** The person's stop, or the run's. */
  signal?: AbortSignal;
  /**
   * When the run started, on the monotonic clock: its one deadline counts from here, so the steps before research
   * (checks, the model's listing) use the same time. Defaults to now.
   */
  startedAt?: number;
  /** Tests only: shorter times than the product's. */
  timing?: Partial<Record<"runMs" | "retrievalCutoffMs" | "searchMs" | "extractMs" | "modelMs", number>>;
  now?: () => number;
  clock?: () => Date;
}

/** A whole request's estimated input at its largest: every page and passage the limits allow, and the tool. */
function largestInputTokens(packet: ResearchRunOptions["packet"]): number {
  const L = RESEARCH_LIMITS;
  const pages = L.pages * (L.addressChars * 2 + L.titleChars + L.siteChars + 80);
  const passages = L.passages * (L.passageChars + 120);
  const assumptions = packet.assumptions.reduce((sum, assumption) => sum + assumption.text.length + 8, 0);
  const chars = RESEARCH_INSTRUCTIONS.length + packet.planText.length + assumptions + pages + passages + 400 + toolDefinitionChars(TOOL_SPECS);
  return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_ALLOWANCE_TOKENS;
}

/** A request's estimated input as sent (D30). */
function estimateRequest(message: string): number {
  return Math.ceil((RESEARCH_INSTRUCTIONS.length + message.length + toolDefinitionChars(TOOL_SPECS)) / CHARS_PER_TOKEN) + MESSAGE_ALLOWANCE_TOKENS;
}

/** Why a model answer couldn't be used, in Nivra's words. */
function unusable(steps: readonly StepRecord[], schemaProblems: number): string {
  if (schemaProblems) return "its answer didn't match the assessment form";
  const last = steps.at(-1);
  if (last?.finishReason === "length") return "its answer was cut off at the output limit";
  if (last && !last.toolNames.length) return "it answered in plain text, not through the assessment form";
  return "it handed in no assessment";
}

export async function runResearch(options: ResearchRunOptions): Promise<ResearchReportShape> {
  const L: Omit<typeof RESEARCH_LIMITS, "runMs" | "retrievalCutoffMs" | "searchMs" | "extractMs" | "modelMs"> & Record<"runMs" | "retrievalCutoffMs" | "searchMs" | "extractMs" | "modelMs", number> = { ...RESEARCH_LIMITS, ...options.timing };
  const now = options.now ?? (() => performance.now());
  const clock = options.clock ?? (() => new Date());
  const started = options.startedAt ?? now();
  const cutoffAt = started + L.retrievalCutoffMs;
  const { packet, signal } = options;
  const order = packet.assumptions.map((assumption) => assumption.id);
  const entry = (id: ResearchRequestEntry["id"], kind: ResearchRequestEntry["kind"], assumption: AssumptionId | null): ResearchRequestEntry => ({
    id,
    kind,
    assumption,
    state: "pending",
    failure: null,
    status: null,
    requestId: null,
    credits: null,
    pages: 0,
    elapsedMs: null,
  });
  const requests: ResearchRequestEntry[] = [
    ...order.map((id) => entry(`search-${id}`, "search", id)),
    ...order.map((id) => entry(`extract-${id}`, "extract", id)),
    entry("model", "model", null),
  ];
  const request = (id: ResearchRequestEntry["id"]) => requests.find((candidate) => candidate.id === id)!;
  let pages: Page[] = [];
  const passages: Passage[] = [];
  let assessed: Assessed = { assessments: [], checks: { citations: 0, valid: 0, relabelled: 0 } };
  let outcome: ResearchReportShape["outcome"] = "in-progress";
  let stop: ResearchReportShape["stop"] = null;
  let finishedAt: string | null = null;
  const steps: StepRecord[] = [];
  // The run's whole time is the budget's, counted from the run's start: the model's request gets the smaller of its own
  // limit and what is left (D30).
  const budget = new RunBudget(
    { requests: L.modelRequests, totalMs: Math.max(0, Math.floor(started + L.runMs - now())), outputTokensPerRequest: L.outputTokens, estimatedInputTokens: L.inputTokens },
    { ...(signal ? { signal } : {}), now },
  );

  /** Credits as reported, over every request that was sent; null as soon as one of them didn't say. */
  const credits = (): number | null => {
    const sent = requests.filter((candidate) => candidate.kind !== "model" && (candidate.state === "answered" || (candidate.state === "failed" && candidate.failure !== "not-sent")));
    if (sent.some((candidate) => candidate.credits === null)) return null;
    return sent.reduce((sum, candidate) => sum + candidate.credits!, 0);
  };
  const report = (): ResearchReportShape => ({
    planId: options.binding.planId,
    planVersion: options.binding.planVersion,
    packetDigest: options.binding.packetDigest,
    outcome,
    scope: options.binding.scope,
    request: options.binding.request,
    route: options.route,
    queries: packet.assumptions.map((assumption) => ({ assumption: assumption.id, text: assumption.text, query: assumption.query })),
    sites: packet.sites ? { mode: packet.sites.mode, hosts: [...packet.sites.hosts] } : null,
    requests: requests.map((candidate) => ({ ...candidate })),
    pages: pages.map((page) => ({ ...page, foundBy: page.foundBy.map((found) => ({ ...found })), extractedFor: [...page.extractedFor] })),
    passages: passages.map((passage) => ({ ...passage })),
    assessments: assessed.assessments,
    checks: { ...assessed.checks },
    stop,
    usage: {
      credits: credits(),
      model: {
        inputTokens: steps.length && steps.every((step) => step.inputTokens !== null) ? steps.reduce((sum, step) => sum + step.inputTokens!, 0) : null,
        outputTokens: steps.length && steps.every((step) => step.outputTokens !== null) ? steps.reduce((sum, step) => sum + step.outputTokens!, 0) : null,
        calls: steps.length,
        reportedCalls: steps.filter((step) => step.inputTokens !== null && step.outputTokens !== null).length,
      },
    },
    budget: budget.record(),
    elapsedMs: Math.max(0, Math.round(now() - started)),
    updatedAt: clock().toISOString(),
    finishedAt,
  });
  let saving: Promise<void> = Promise.resolve();
  /** Saves the report as it stands now, after every earlier save. */
  const save = (): Promise<void> => {
    const snapshot = report();
    saving = saving.then(() => options.save(snapshot));
    return saving;
  };
  const settle = (target: ResearchRequestEntry, result: Retrieved<object>) => {
    Object.assign(target, {
      state: result.ok ? "answered" : "failed",
      failure: result.ok ? null : result.failure,
      status: result.end.status,
      requestId: result.end.requestId,
      credits: result.end.credits,
      elapsedMs: result.end.elapsedMs,
    });
  };
  const finish = async (code: ResearchStopCode | null, ended: ResearchReportShape["outcome"], message?: string): Promise<ResearchReportShape> => {
    for (const candidate of requests) if (candidate.state === "pending") candidate.state = "skipped";
    stop = code ? { code, message: (message ?? RESEARCH_STOP_MESSAGES[code]).slice(0, 400) } : null;
    outcome = ended;
    finishedAt = clock().toISOString();
    await save();
    return report();
  };

  // The model's whole request is held before anything goes to Tavily, for its own limit or the time left, whichever is
  // less (the clock is read once). With no time left, or stopped already, nothing is sent; any other refusal is Nivra's.
  const held = budget.hold({ inputTokens: largestInputTokens(packet), ms: L.modelMs }, { upTo: true });
  if (!("admit" in held)) return finish(held.reason === "cancelled" ? "cancelled" : held.reason === "deadline" ? "deadline" : "internal", held.reason === "cancelled" ? "cancelled" : "failed");
  const hold = held;
  await save();

  // Search: one request per assumption, together, each ending by its own limit or the cutoff.
  options.progress?.(`Searching for ${order.length} ${order.length === 1 ? "assumption" : "assumptions"}`, { searches: order.length });
  const found = await Promise.all(
    packet.assumptions.map(async (assumption): Promise<{ assumption: AssumptionId; hits: SearchHit[] }> => {
      const target = request(`search-${assumption.id}`);
      target.state = "sending";
      await save();
      const result = await options.retrieval.search({ query: assumption.query, sites: packet.sites, deadlineAt: now() + L.searchMs, cutoffAt, ...(signal ? { signal } : {}) });
      settle(target, result);
      await save();
      return { assumption: assumption.id, hits: result.ok ? result.hits : [] };
    }),
  );
  pages = collectPages(found, options.knownValues);
  options.progress?.(`Search found ${pages.length} ${pages.length === 1 ? "page" : "pages"}`, { pages: pages.length, refused: pages.filter((page) => page.status === "refused").length });
  if (signal?.aborted) {
    hold.release();
    return finish("cancelled", "cancelled");
  }

  // Extract: one request per assumption that has pages, with its own query, together.
  const chosen = chooseExtractions(pages, order);
  const extracted = await Promise.all(
    packet.assumptions.map(async (assumption): Promise<{ assumption: AssumptionId; pages: ExtractedPage[] }> => {
      const target = request(`extract-${assumption.id}`);
      const mine = chosen.get(assumption.id) ?? [];
      if (!mine.length) {
        target.state = "skipped";
        return { assumption: assumption.id, pages: [] };
      }
      target.pages = mine.length;
      for (const page of mine) if (!page.extractedFor.includes(assumption.id)) page.extractedFor.push(assumption.id);
      target.state = "sending";
      await save();
      const result = await options.retrieval.extract({ query: assumption.query, addresses: mine.map((page) => page.address), deadlineAt: now() + L.extractMs, cutoffAt, ...(signal ? { signal } : {}) });
      settle(target, result);
      await save();
      return { assumption: assumption.id, pages: result.ok ? result.pages : [] };
    }),
  );
  // In assumption order, so a passage's id doesn't depend on which answer came first.
  const retrievedAt = clock().toISOString();
  for (const extraction of extracted) passages.push(...passagesFrom(extraction, pages, passages, { mask: options.mask, retrievedAt }));
  for (const page of pages) {
    if (page.status === "refused") continue;
    page.status = passages.some((passage) => passage.page === page.id) ? "read" : page.extractedFor.length ? "failed" : "not-read";
  }
  options.progress?.(`Read ${passages.length} ${passages.length === 1 ? "passage" : "passages"} from ${pages.filter((page) => page.status === "read").length} pages`, { passages: passages.length });
  if (signal?.aborted) {
    hold.release();
    return finish("cancelled", "cancelled");
  }
  if (!passages.length) {
    hold.release();
    return finish("nothing-read", "failed");
  }

  // The model: one request, admitted now with the smaller of its own limit and the time left.
  const admitted = hold.admit();
  if (!admitted.ok) {
    hold.release();
    return admitted.refusal.reason === "cancelled" ? finish("cancelled", "cancelled") : finish("deadline", "failed");
  }
  const target = request("model");
  target.state = "sending";
  await save();
  const message = researchMessage({ planVersion: options.binding.planVersion, planText: packet.planText, assumptions: packet.assumptions, pages, passages });
  let handedIn: unknown = null;
  const tool = createTool({
    id: RESEARCH_TOOL,
    description: TOOL_DESCRIPTION,
    inputSchema: ResearchAnswer,
    execute: async (input) => {
      handedIn ??= input;
      return { accepted: true };
    },
  });
  const agent = options.client.agent({ id: "nivra-research", name: "Nivra research", modelId: options.model, instructions: RESEARCH_INSTRUCTIONS, tools: { [RESEARCH_TOOL]: tool } });
  let failed: ModelFailure | null = null;
  try {
    await options.client.call(agent, message, {
      maxSteps: 1,
      deadlines: { stepMs: admitted.ms, totalMs: admitted.ms },
      maxOutputTokens: L.outputTokens,
      toolChoice: options.policy.forceAnswer ? { type: "tool", toolName: RESEARCH_TOOL } : "auto",
      internal: new InternalFailure(),
      ...(signal ? { signal } : {}),
      onStep: (step) => steps.push(step),
    });
  } catch (error) {
    failed = error instanceof ModelFailure ? error : failure("internal", "");
    if (failed.failedStep) steps.push(failed.failedStep);
  }
  hold.settle(steps);
  for (const step of steps) {
    const tokens = step.inputTokens !== null && step.outputTokens !== null ? `${step.inputTokens} in / ${step.outputTokens} out tokens` : "tokens not reported";
    options.modelCall?.(`Research assessment: ${tokens}, ${(step.elapsedMs / 1000).toFixed(1)} s`, {
      model: options.model,
      elapsedMs: step.elapsedMs,
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      finishReason: step.finishReason,
      tools: step.toolNames,
      estimatedInputTokens: estimateRequest(message),
    });
  }
  target.elapsedMs = steps.length ? Math.round(steps.reduce((sum, step) => sum + step.elapsedMs, 0)) : null;
  if (failed) {
    Object.assign(target, { state: "failed", failure: failed.kind === "cancelled" ? "cancelled" : "model" });
    return failed.kind === "cancelled" ? finish("cancelled", "cancelled") : finish("model-failed", "failed", `${RESEARCH_STOP_MESSAGES["model-failed"]} ${failed.message}`);
  }
  const parsed = handedIn === null ? null : ResearchAnswer.safeParse(handedIn);
  if (!parsed?.success || parsed.data.assessments.length === 0) {
    const problems = steps.flatMap((step) => step.rejectedTools.filter((rejected) => rejected.tool === RESEARCH_TOOL)).length;
    Object.assign(target, { state: "failed", failure: "model" });
    return finish("model-failed", "failed", `The model's assessment couldn't be used: ${unusable(steps, problems)}. The pages and passages read are kept below.`);
  }
  target.state = "answered";
  assessed = assess(parsed.data, packet.assumptions, passages, pages, options.mask);
  options.progress?.(`Assessed ${assessed.assessments.length} ${assessed.assessments.length === 1 ? "assumption" : "assumptions"}`, {
    citations: assessed.checks.citations,
    valid: assessed.checks.valid,
    relabelled: assessed.checks.relabelled,
  });
  return finish(null, "complete");
}

/**
 * A report as the engine reads it back once its run has ended. One saved mid-run, by an engine that stopped, reads as
 * interrupted: a request it was sending may have been sent, so its credits are unknown, and nothing is resent.
 */
export function asInterrupted(report: ResearchReportShape): ResearchReportShape {
  if (report.outcome !== "in-progress") return report;
  const requests = report.requests.map((request) =>
    request.state === "sending" ? { ...request, state: "failed" as const, failure: "no-answer" as const, credits: null } : request.state === "pending" ? { ...request, state: "skipped" as const } : request,
  );
  const sent = requests.filter((request) => request.kind !== "model" && (request.state === "answered" || (request.state === "failed" && request.failure !== "not-sent")));
  return {
    ...report,
    outcome: "interrupted",
    requests,
    usage: { ...report.usage, credits: sent.some((request) => request.credits === null) ? null : sent.reduce((sum, request) => sum + request.credits!, 0) },
  };
}
