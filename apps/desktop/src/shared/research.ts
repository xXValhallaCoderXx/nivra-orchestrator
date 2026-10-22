import type { ResearchAssumptionId, ResearchConclusion, ResearchDisplayRule, ResearchRejection, ResearchReport, ResearchRequestFailure } from "@nivra/domain";
import type { TurnStatus } from "./ipc.ts";

/**
 * Research of a saved plan version's assumptions (NIV-45), as the window sees it: what the person picks, the preview
 * "Start research" is bound by, a research run and its report, and the words they are shown in. Main builds the views;
 * the window shows them. Pure, so both sides use it and tests read it without a window.
 *
 * The report's types are the domain contract's own (D37), imported as types only, as the window's must be.
 */

export type AssumptionId = ResearchAssumptionId;
export type Conclusion = ResearchConclusion;
export type DisplayRule = ResearchDisplayRule;
/** Who or what stopped research: the person, a permission turned off, the project removed, the conversation deleted. */
export type StopCause = "person" | "web-research" | "model-sharing" | "removal" | "deletion";

export interface ResearchSites {
  mode: "prefer" | "restrict";
  hosts: string[];
}

/** One assumption the person picked, from the plan's list by its place or typed, and the query they wrote for it. */
export interface ResearchPick {
  from: { kind: "plan"; index: number } | { kind: "typed"; text: string };
  query: string;
}

/** What the person chose: one to three assumptions, and the sites to prefer or keep to, if any. */
export interface ResearchSelection {
  assumptions: ResearchPick[];
  sites: ResearchSites | null;
}

/** What research of one plan version would send, and where, worked out from the records as they are now. Nothing is sent. */
export interface ResearchPreview {
  planId: string;
  planLineage: string;
  planVersion: number;
  latestVersion: number;
  /** Where the plan came from: a general conversation, or a project's, with its engine and whether it allows sharing. */
  scope: { kind: "general" } | { kind: "project"; projectLabel: string; targetLabel: string; headAtStart: string | null; sharing: boolean };
  /** What Tavily gets: each query exactly as it would be sent, with what keeps it from being sent; and the sites. */
  tavily: { queries: Array<{ assumption: AssumptionId; query: string; problems: string[] }>; sites: ResearchSites | null };
  /** What Token Factory gets besides the passages read: the plan's text, counted, and the assumptions in full. */
  model: { planChars: number; assumptions: Array<{ id: AssumptionId; text: string; fromPlan: number | null }> };
  /** The most one run can use. Credits are Tavily's; how Extract rounds them is confirmed by the live check. */
  limits: { searches: number; extracts: number; pages: number; credits: number; modelRequests: number; seconds: number };
  webResearch: boolean;
  /** Why it can't start now, in plain words; null when it can. */
  blocked: string | null;
  /** The fingerprint of what it would send: starting is refused when that changed since this preview. */
  expected: string;
}

/** A research run's report, as the engine saved it and the host masked it again: the domain contract's own (D37). */
export type ResearchReportView = ResearchReport;
export type ResearchAssessmentView = ResearchReportView["assessments"][number];
export type ResearchCitationView = ResearchAssessmentView["citations"][number];
export type ResearchPageView = ResearchReportView["pages"][number];
export type ResearchPassageView = ResearchReportView["passages"][number];
export type ResearchRequestView = ResearchReportView["requests"][number];
export type ResearchFailure = ResearchRequestFailure;
/** Why an assessment the model handed in was set aside instead of being matched to an assumption. */
export type Rejection = ResearchRejection;
/**
 * What the model handed in, how much of it named an assumption asked about, and how much of that gave an outcome: at
 * most ten set aside are listed, and every matched assessment without a recognised outcome.
 */
export type AttributionView = NonNullable<ResearchReportView["attribution"]>;

/**
 * Research of a plan version (NIV-45): what it was bound to, how its run went, the report its engine saved, kept when it
 * ended, and the version amended from it, if any. Nothing is ever resent: researching again makes a new run.
 */
export interface ResearchView {
  id: string;
  conversationId: string;
  planId: string;
  planLineage: string;
  planVersion: number;
  /** The latest version of its plan now: an amended version can be saved only while this is still the researched one. */
  latestVersion: number;
  status: TurnStatus;
  /** What happened, in Nivra's words, when it ended without a complete report; null while it goes, and once complete. */
  note: string | null;
  /** Why its engine can't be reached to check it, while that lasts. */
  unresolved: string | null;
  runId: string | null;
  cancelRequested: boolean;
  /** The newest stop on record, by cause. */
  stopCause: StopCause | null;
  /** Why the last stop couldn't be carried out, while the research goes on and no newer stop is asked for. */
  stopFailed: string | null;
  /** The queries the person approved. Whether each was sent is the report's to say. */
  queries: Array<{ assumption: AssumptionId; text: string; query: string }>;
  /** The sites the person chose; null for none. */
  sites: ResearchSites | null;
  packetDigest: string;
  /** The version saved from this research, once; null until then. */
  amended: { planId: string; version: number } | null;
  report: ResearchReportView | null;
  createdAt: string;
  settledAt: string | null;
}

/**
 * A query's first value: a general plan's assumption, which the person wrote, as its own words; nothing for a project's
 * plan, whose assumptions came from repository work, until the person chooses to use the assumption's words.
 */
export const initialQuery = (scope: "general" | "project", assumption: string): string => (scope === "general" ? assumption.trim() : "");

/** What the card says under every assessment: the check is of provenance, and the judgement is the person's. */
export const RESEARCH_CAVEAT = "Nivra checked that each quotation is in the page it names. Whether it supports the conclusion is for you to judge.";

/** What the retention copy says in the permission, the delete dialog and the decision. */
export const RESEARCH_RETENTION =
  "Tavily keeps what it receives, under its own terms. Nivra's engine keeps each research report, with its queries, addresses and passages, and can't delete it yet. What was already sent can't be withdrawn.";

export const CONCLUSION_LABEL: Readonly<Record<Conclusion, string>> = { supported: "Supported", contradicted: "Contradicted", unresolved: "Unresolved" };

/**
 * Why an assessment is shown other than as the model gave it, in words about the evidence, never about the truth;
 * null when it is shown as given.
 */
export function ruleText(assessment: Pick<ResearchAssessmentView, "rule" | "model" | "version">): string | null {
  const said = assessment.model ? `The model said ${assessment.model}` : "The model gave no assessment";
  switch (assessment.rule) {
    case "no-valid-citation":
      return `${said}, but none of its quotations of that kind was found in the pages read, so this is shown as unresolved.`;
    case "version-not-named":
      return `${said}, but the sources it quoted don't say they are about version ${assessment.version ?? "the plan names"}, so this is shown as unresolved.`;
    case "both-sides":
      return `${said}, but it quoted passages on both sides, so this is shown as unresolved. Both are below.`;
    case "not-assessed":
      return "The model gave no usable assessment of this assumption.";
    default:
      return null;
  }
}

/** Why a quotation was left out, in plain words. */
export const CITATION_PROBLEM: Readonly<Record<NonNullable<ResearchCitationView["problem"]>, string>> = {
  "unknown-passage": "names a passage the model wasn't given",
  "bad-stance": "doesn't say whether it supports or contradicts",
  "too-short": "is too short to check (under 20 characters or 4 words)",
  "too-long": "is longer than 300 characters",
  "not-found": "isn't in the passage it names",
};

const FAILURE: Readonly<Record<ResearchFailure, string>> = {
  auth: "Tavily didn't accept the key",
  "rate-limit": "Tavily asked Nivra to slow down; not retried",
  "plan-limit": "the Tavily plan's limit was reached",
  rejected: "Tavily refused the request",
  server: "Tavily had an error; not retried",
  redirect: "Tavily answered with a redirect, which Nivra doesn't follow",
  deadline: "the run's time ran out",
  cutoff: "searching and reading stop 90 seconds into the run",
  "too-large": "the answer was larger than Nivra reads",
  malformed: "the answer wasn't in a form Nivra reads",
  network: "the connection failed",
  "not-sent": "not sent",
  "no-answer": "sent, and no answer came",
  cancelled: "cancelled",
  model: "the model's request failed",
  interrupted: "may have been sent; credits unknown",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** Whether a request may have reached Tavily or the model: anything but one never sent. */
const mayHaveGone = (request: ResearchRequestView) => request.state === "answered" || request.state === "sending" || (request.state === "failed" && request.failure !== "not-sent");
/** Whether a request was cut off by a stop of Nivra or its engine: it may have been sent, and what it used is unknown. */
const cutOff = (request: ResearchRequestView, outcome: ResearchReportView["outcome"]) => (request.state === "failed" && request.failure === "interrupted") || (request.state === "sending" && outcome !== "in-progress");

/**
 * One request of a run, in plain words: what it was, how it ended and the credits Tavily reported. A request cut off when
 * Nivra or its engine stopped may have been sent, and what it used is unknown; one never sent has no credits to report.
 */
export function requestText(request: ResearchRequestView, outcome: ResearchReportView["outcome"]): string {
  const what = request.kind === "search" ? `Search for ${request.assumption}` : request.kind === "extract" ? `Read ${plural(request.pages, "page")} for ${request.assumption}` : "The model's assessment";
  const unknown = request.kind === "model" ? "may have been sent; tokens unknown" : "may have been sent; credits unknown";
  const state = cutOff(request, outcome)
    ? unknown
    : request.state === "sending"
      ? "sending"
      : request.state === "failed"
        ? FAILURE[request.failure ?? "no-answer"]
        : request.state === "pending"
          ? "not sent"
          : request.state;
  const credits =
    request.kind === "model" || !mayHaveGone(request) || cutOff(request, outcome) || request.state === "sending"
      ? ""
      : request.credits !== null
        ? ` · ${plural(request.credits, "credit")}`
        : " · credits not reported";
  const time = request.elapsedMs !== null ? ` · ${(request.elapsedMs / 1000).toFixed(1)} s` : "";
  return `${what}: ${state}${credits}${time}`;
}

const REJECTION: Readonly<Record<Rejection, string>> = {
  missing: "named no assumption",
  unknown: "named no assumption that was asked about",
  ambiguous: "could mean more than one assumption",
  conflicting: "named one assumption by its id and another by its words",
  duplicate: "answered an assumption that another assessment answered too",
};

/**
 * What became of the model's assessments when some were set aside or gave no recognised outcome, in plain words: how
 * many it handed in, how many matched an assumption, which of those gave no outcome Nivra recognises and what they gave,
 * and why the rest were set aside. Null when every one matched with an outcome, or the model handed in nothing.
 */
export function attributionText(attribution: AttributionView | null): string | null {
  if (!attribution || (attribution.rejected === 0 && attribution.unusable.length === 0)) return null;
  const counts = new Map<Rejection, number>();
  for (const entry of attribution.entries) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  const unlisted = attribution.rejected - attribution.entries.length;
  const why = [...counts].map(([reason, n]) => `${n} ${REJECTION[reason]}`);
  if (unlisted > 0) why.push(`${unlisted} more not listed`);
  const gave = attribution.unusable.map((item) => `${item.assumption} ${item.outcome ? `gave “${item.outcome}”` : "gave none"}`);
  const matched = `${attribution.matched} matched an assumption asked about${gave.length ? `, and ${gave.length} of those gave no outcome Nivra recognises (${gave.join(", ")})` : ""}`;
  const rejected = attribution.rejected ? `; ${attribution.rejected} ${attribution.rejected === 1 ? "was" : "were"} set aside: ${why.join("; ")}` : "";
  return `The model handed in ${plural(attribution.handedIn, "assessment")}. ${matched}${rejected}.`;
}

/**
 * Tavily's credits as reported, never 0 for unknown, and "no Tavily requests" when none was sent; the model's tokens as
 * reported, "no model call" only when its request was never sent, and unknown when it was cut off.
 */
export function usageText(report: Pick<ResearchReportView, "usage" | "requests" | "outcome">): string {
  const tavily = report.requests.filter((request) => request.kind !== "model");
  const interrupted = tavily.some((request) => cutOff(request, report.outcome));
  const credits = !tavily.some(mayHaveGone)
    ? "no Tavily requests"
    : report.usage.credits !== null
      ? `${plural(report.usage.credits, "Tavily credit")}, as reported`
      : interrupted
        ? "Tavily credits unknown"
        : "Tavily credits not reported";
  const modelRequest = report.requests.find((request) => request.kind === "model");
  const { model } = report.usage;
  const tokens =
    !modelRequest || !mayHaveGone(modelRequest)
      ? "no model call"
      : cutOff(modelRequest, report.outcome)
        ? "tokens unknown"
        : model.inputTokens !== null && model.outputTokens !== null
          ? `${model.inputTokens.toLocaleString("en")} in / ${model.outputTokens.toLocaleString("en")} out tokens, as reported`
          : "tokens not reported";
  return `${credits} · ${tokens}`;
}

/**
 * The quotations an assessment gave that Nivra didn't find in the passage they name, each with why: shown as the
 * model's words, never as evidence.
 */
export function rejectedQuotes(assessment: Pick<ResearchAssessmentView, "citations">): Array<{ quote: string; passage: string; problem: string }> {
  return assessment.citations
    .filter((citation) => !citation.valid)
    .map((citation) => ({ quote: citation.quote, passage: citation.passage, problem: CITATION_PROBLEM[citation.problem ?? "not-found"] }));
}

/**
 * The model's assessments that couldn't be used, each in a sentence with why: set aside because they named no
 * assumption asked about (or could mean more than one), or matched with no outcome Nivra recognises. Empty when every
 * one could be used.
 */
export function unusableAssessments(attribution: AttributionView | null): string[] {
  if (!attribution) return [];
  const setAside = attribution.entries.map((entry) => `${entry.label ? `“${entry.label}”` : "An assessment"} ${REJECTION[entry.reason]}, so it was set aside.`);
  const unlisted = attribution.rejected - attribution.entries.length;
  if (unlisted > 0) setAside.push(`${plural(unlisted, "more assessment")} ${unlisted === 1 ? "was" : "were"} set aside, and ${unlisted === 1 ? "isn't" : "aren't"} listed.`);
  const noOutcome = attribution.unusable.map(
    (item) => `${item.assumption}'s assessment ${item.outcome ? `gave “${item.outcome}”` : "gave no outcome"}, not supported, contradicted or unresolved, so it can't be used.`,
  );
  return [...setAside, ...noOutcome];
}

/** A valid quotation with the passage and page it came from, as an assessment's evidence. */
export interface Evidence {
  quote: string;
  stance: "supports" | "contradicts";
  passage: ResearchPassageView;
  page: ResearchPageView;
}

/**
 * An assessment's evidence: its valid quotations, each with its passage and page, and how many it gave that were left
 * out. Only a valid quotation is shown: one Nivra couldn't find is model output, not evidence.
 */
export function evidenceFor(report: Pick<ResearchReportView, "passages" | "pages">, assessment: Pick<ResearchAssessmentView, "citations">): { shown: Evidence[]; left: number } {
  const passages = new Map(report.passages.map((passage) => [passage.id, passage]));
  const pages = new Map(report.pages.map((page) => [page.id, page]));
  const shown = assessment.citations.flatMap((citation) => {
    const passage = citation.valid ? passages.get(citation.passage) : undefined;
    const page = passage ? pages.get(passage.page) : undefined;
    return passage && page ? [{ quote: citation.quote, stance: citation.stance, passage, page }] : [];
  });
  return { shown, left: assessment.citations.length - shown.length };
}

/** An amendment the person can tick: the assumption, the words offered, and the sites its valid quotations came from. */
export interface AmendmentChoice {
  assumption: AssumptionId;
  text: string;
  amendment: { kind: "model" | "unverified"; text: string };
  hosts: string[];
}

/**
 * The amendments a report offers: the model's, labelled as from web research, for a contradiction shown with valid
 * citations; the engine's fixed note for an unresolved assessment; nothing for a supported one.
 */
export function amendmentChoices(report: Pick<ResearchReportView, "queries" | "assessments" | "passages" | "pages">): AmendmentChoice[] {
  return report.assessments.flatMap((assessment) => {
    const { amendment } = assessment;
    if (!amendment || assessment.shown !== (amendment.kind === "model" ? "contradicted" : "unresolved")) return [];
    const hosts = [...new Set(evidenceFor(report, assessment).shown.map((evidence) => evidence.page.host))];
    if (amendment.kind === "model" && hosts.length === 0) return [];
    const text = report.queries.find((query) => query.assumption === assessment.assumption)?.text ?? "";
    return [{ assumption: assessment.assumption, text, amendment, hosts: amendment.kind === "model" ? hosts : [] }];
  });
}

/**
 * The text "Save as vN+1" starts from: the researched version's text, then the amendments the person ticked, each naming
 * the sites its quotations came from. The person edits it before saving; the plan keeps nothing of the research but
 * these words, which are theirs to keep or change.
 */
export function amendmentDraft(planText: string, chosen: readonly AmendmentChoice[]): string {
  if (chosen.length === 0) return planText;
  const lines = chosen.map((choice) => (choice.amendment.kind === "model" ? `- ${choice.amendment.text} (from web research: ${choice.hosts.join(", ")})` : `- ${choice.amendment.text}`));
  return `${planText.trimEnd()}\n\nFrom web research:\n${lines.join("\n")}`;
}
