import { z } from "zod";
import { secretShapes } from "./credentials.ts";
import { RunBudgetRecord, RunRoute, RunUsage } from "./models.ts";
import { ReviewScope } from "./review.ts";

/**
 * Research of a saved plan's assumptions (NIV-45). A person picks one plan version and one to three of its
 * assumptions, and approves the exact queries that will leave the app. The engine sends only those queries, and the
 * addresses of pages Tavily's own search returned, to Tavily; it reads selected passages from those pages; and one model
 * request assesses each assumption against them. Nivra checks that each quotation the model gives is in the passage it
 * names: that proves where the words came from, not that they support the conclusion, so the assessment stays the
 * model's and the person judges it.
 *
 * The packet travels in the run's context, held in memory like the preference snapshot (D21); the run stores the plan's
 * id and version and the packet's fingerprint. The report holds the queries and passages on purpose, and the engine
 * keeps it; nothing else does.
 */

/**
 * The product's limits for one run, not Tavily's. Time runs on the monotonic clock: one absolute deadline covers the
 * whole run, retrieval stops at its cutoff, and the model request gets the smaller of its own limit and the time left.
 */
export const RESEARCH_LIMITS = {
  assumptions: 3,
  assumptionChars: 300,
  queryChars: 400,
  sites: 5,
  siteChars: 253,
  planChars: 20_000,
  searches: 3,
  resultsPerSearch: 5,
  extracts: 3,
  pageExtractions: 5,
  passagesPerExtraction: 3,
  passageChars: 1_000,
  passages: 15,
  pages: 15,
  addressChars: 2_048,
  titleChars: 300,
  headingChars: 200,
  quoteMinChars: 20,
  quoteMaxChars: 300,
  quoteMinWords: 4,
  citationsPerAssessment: 6,
  searchBodyBytes: 1_048_576,
  extractBodyBytes: 2_097_152,
  searchMs: 30_000,
  extractMs: 45_000,
  /** Sent to Tavily as Extract's own `timeout`, in seconds. */
  extractTimeoutSeconds: 40,
  retrievalCutoffMs: 90_000,
  modelMs: 150_000,
  runMs: 240_000,
  modelRequests: 1,
  outputTokens: 4_000,
  inputTokens: 60_000,
  reasoningChars: 1_500,
  uncertaintyChars: 600,
  applicabilityChars: 200,
  amendmentChars: 1_000,
} as const;

/** The tool the model hands its assessment in with, which stubs script against. */
export const RESEARCH_TOOL = "submit_research";

export const ResearchAssumptionId = z.enum(["A1", "A2", "A3"]);
export type ResearchAssumptionId = z.infer<typeof ResearchAssumptionId>;

/** Where an assumption came from: the plan's own list (by position), or typed by the person. */
export const AssumptionOrigin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan"), index: z.number().int().nonnegative().max(99) }),
  z.strictObject({ kind: z.literal("typed") }),
]);
export type AssumptionOrigin = z.infer<typeof AssumptionOrigin>;

const nonBlank = (text: string) => text.trim().length > 0;

/** One assumption to check, with the exact query the person approved for it. */
export const ResearchAssumption = z.strictObject({
  id: ResearchAssumptionId,
  text: z.string().min(1).max(RESEARCH_LIMITS.assumptionChars).refine(nonBlank, "The assumption is blank."),
  origin: AssumptionOrigin,
  query: z.string().min(1).max(RESEARCH_LIMITS.queryChars).refine(nonBlank, "The query is blank."),
});
export type ResearchAssumption = z.infer<typeof ResearchAssumption>;

/** Sites to favour (`prefer`) or keep to (`restrict`): public hostnames only, sent to Tavily as they are. */
export const ResearchSites = z.strictObject({
  mode: z.enum(["prefer", "restrict"]),
  hosts: z.array(z.string().min(1).max(RESEARCH_LIMITS.siteChars)).min(1).max(RESEARCH_LIMITS.sites),
});
export type ResearchSites = z.infer<typeof ResearchSites>;

/** What a research run is bound to, exactly as frozen: no defaults and no transforms, so its fingerprint covers it. */
export const ResearchPacket = z
  .strictObject({
    scope: ReviewScope,
    planText: z.string().min(1).max(RESEARCH_LIMITS.planChars).refine(nonBlank, "The plan's text is blank."),
    assumptions: z.array(ResearchAssumption).min(1).max(RESEARCH_LIMITS.assumptions),
    sites: ResearchSites.nullable(),
  })
  .refine((packet) => packet.assumptions.every((assumption, index) => assumption.id === `A${index + 1}`), "Assumptions are numbered A1 to A3, in order.")
  .refine((packet) => {
    const indexes = packet.assumptions.flatMap((assumption) => (assumption.origin.kind === "plan" ? [assumption.origin.index] : []));
    return new Set(indexes).size === indexes.length;
  }, "An assumption of the plan is picked at most once.")
  .refine((packet) => (packet.sites?.hosts ?? []).every((host) => siteProblem(host) === null), "A site isn't a public hostname.");
export type ResearchPacket = z.infer<typeof ResearchPacket>;

/**
 * What no query may name, worked out by the host: every project's label and folder name (a folder name can be 255
 * characters; a thousand projects fit), and the paths the plan cites (as many as a plan's references). The engine
 * checks the queries against them again before anything is sent.
 */
export const ResearchDeny = z.strictObject({
  terms: z.array(z.string().min(1).max(255)).max(2_000),
  paths: z.array(z.string().min(1).max(500)).max(240),
});
export type ResearchDeny = z.infer<typeof ResearchDeny>;

/** What a research run gets besides its input (D21): held in the engine's memory for the run, never stored. */
export const ResearchContext = z.strictObject({
  sharing: z.strictObject({ modelContext: z.boolean(), webResearch: z.boolean() }),
  deny: ResearchDeny,
  packet: ResearchPacket,
});
export type ResearchContext = z.infer<typeof ResearchContext>;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A research run's input, stored with the run (masked): which plan version, and the fingerprint of what was frozen. */
export const ResearchInput = z.strictObject({
  planId: z.uuid(),
  planVersion: z.number().int().positive(),
  packetDigest: Sha256Hex,
});
export type ResearchInput = z.infer<typeof ResearchInput>;

/** A research run's input as the engine reads it back from its store: masked, so only its shape is checked. */
export const StoredResearchInput = z.object({
  planId: z.string().min(1),
  planVersion: z.number().int().positive(),
  packetDigest: z.string(),
});
export type StoredResearchInput = z.infer<typeof StoredResearchInput>;

/**
 * A packet's fingerprint: SHA-256, in hex, of a fixed-order, versioned JSON array of everything frozen, the limits
 * included, so a run is bound to the limits it was previewed with. The host and the engine each work it out.
 */
export async function researchPacketDigest(packet: ResearchPacket): Promise<string> {
  const canonical = [
    "nivra.research-packet.v1",
    packet.scope.kind,
    packet.scope.kind === "project" ? packet.scope.headAtStart : null,
    packet.planText,
    packet.assumptions.map((assumption) => [assumption.id, assumption.text, assumption.origin.kind, assumption.origin.kind === "plan" ? assumption.origin.index : null, assumption.query]),
    packet.sites ? [packet.sites.mode, packet.sites.hosts] : null,
    Object.entries(RESEARCH_LIMITS),
  ];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Why a query can't be sent, by kind: never the words that tripped it. */
export const QueryProblem = z.enum(["blank", "too-long", "saved-key", "credential", "url", "path", "cited-path", "project", "email", "private-address"]);
export type QueryProblem = z.infer<typeof QueryProblem>;

/** Each problem in the person's terms, for a refusal. */
export const QUERY_PROBLEM_WORDS: Readonly<Record<QueryProblem, string>> = {
  blank: "is empty",
  "too-long": `is longer than ${RESEARCH_LIMITS.queryChars} characters`,
  "saved-key": "holds one of your saved keys",
  credential: "looks like it holds a credential",
  url: "holds a web address",
  path: "holds a file path",
  "cited-path": "names a path the plan cites",
  project: "names one of your projects or its folder",
  email: "holds an email address",
  "private-address": "holds a private network address or host name",
};

/** Host names that only resolve inside a network, never on the public web. */
const PRIVATE_SUFFIXES = ["internal", "local", "localhost", "lan", "corp", "home", "intranet", "private", "test", "example", "invalid"];
const BEFORE = String.raw`(?:^|[\s"'(\[=,;])`;
const URL_PATTERNS = [/\b[a-z][a-z0-9+.-]*:\/\/\S/i, /\bwww\.[a-z0-9-]+\.[a-z]/i];
const PATH_PATTERNS = [
  new RegExp(`${BEFORE}/[\\w.-]+`),
  /\b[A-Za-z]:[\\/]/,
  new RegExp(`${BEFORE}\\\\\\\\[\\w.-]+`),
  new RegExp(`${BEFORE}~[\\\\/]`),
  new RegExp(`${BEFORE}\\.{1,2}[\\\\/]`),
  /%USERPROFILE%|\$HOME\b/i,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const PRIVATE_IPV6 = /(?:^|[^0-9a-f:])(?:::1|fe80:[0-9a-f:]*|f[cd][0-9a-f]{2}:[0-9a-f:]*)(?![0-9a-f:])/i;
/** A host name under a private suffix: at least one label before it, so ordinary words ("test", "local") pass. */
const PRIVATE_HOST = new RegExp(`(?:^|[^\\w.-])(?:[\\w-]+\\.)+(?:${PRIVATE_SUFFIXES.join("|")})(?![\\w.-])`, "i");

function privateIpv4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function hasPrivateAddress(text: string): boolean {
  for (const match of text.matchAll(IPV4)) {
    const parts = match.slice(1, 5).map(Number);
    if (parts.every((part) => part <= 255) && privateIpv4(parts[0]!, parts[1]!)) return true;
  }
  return PRIVATE_IPV6.test(text) || PRIVATE_HOST.test(text);
}

/**
 * A project's label or folder name matched as a whole word, ignoring case. Names under four characters that are only
 * letters aren't checked, because they match ordinary words ("api"); a name with a digit or a mark always is.
 */
function namesTerm(query: string, term: string): boolean {
  const name = term.trim();
  if (!name || (name.length < 4 && /^\p{L}+$/u.test(name))) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(query);
}

/**
 * Why `query` can't be sent to Tavily; empty when it can. The checks look for what a plan's query shouldn't carry: saved
 * keys and credential shapes, web addresses, file paths, the paths the plan cites, any project's name, email addresses
 * and private addresses. They are best-effort: passing them doesn't prove a query is safe to send.
 */
export function queryProblems(query: string, deny: ResearchDeny, knownValues: readonly string[] = []): QueryProblem[] {
  const found = new Set<QueryProblem>();
  if (!nonBlank(query)) found.add("blank");
  if (query.length > RESEARCH_LIMITS.queryChars) found.add("too-long");
  if (knownValues.some((value) => value.length >= 8 && query.includes(value))) found.add("saved-key");
  if (secretShapes(query).length > 0) found.add("credential");
  if (URL_PATTERNS.some((pattern) => pattern.test(query))) found.add("url");
  if (PATH_PATTERNS.some((pattern) => pattern.test(query))) found.add("path");
  if (deny.paths.some((path) => path.split(/[\\/]/).filter(Boolean).length > 1 && query.includes(path))) found.add("cited-path");
  if (deny.terms.some((term) => namesTerm(query, term))) found.add("project");
  if (EMAIL.test(query)) found.add("email");
  if (hasPrivateAddress(query)) found.add("private-address");
  return QueryProblem.options.filter((problem) => found.has(problem));
}

/** Why `host` can't be a preferred site; null when it is a public hostname: no scheme, path, port or address. */
export function siteProblem(host: string): "not-a-hostname" | "private" | null {
  if (host.length > RESEARCH_LIMITS.siteChars || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return "not-a-hostname";
  const labels = host.split(".");
  if (labels.some((label) => label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return "not-a-hostname";
  const top = labels.at(-1)!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(top)) return "not-a-hostname";
  if (PRIVATE_SUFFIXES.includes(top) || labels.includes("localhost")) return "private";
  return null;
}

const count = z.number().int().nonnegative();
const text = (max: number) => z.string().max(max);
const PageId = z.string().regex(/^S(?:[1-9]|1[0-5])$/);
const PassageId = z.string().regex(/^S(?:[1-9]|1[0-5])\.[1-9]$/);

/**
 * Why one request ended without an answer, in the engine's terms: never Tavily's or the provider's own words. `cutoff`
 * is retrieval's deadline, `no-answer` a request that was sent and whose answer never came, `not-sent` one established
 * as never sent.
 */
export const ResearchRequestFailure = z.enum([
  "auth",
  "rate-limit",
  "plan-limit",
  "rejected",
  "server",
  "redirect",
  "deadline",
  "cutoff",
  "too-large",
  "malformed",
  "network",
  "not-sent",
  "no-answer",
  "cancelled",
  "model",
]);
export type ResearchRequestFailure = z.infer<typeof ResearchRequestFailure>;

/**
 * One request of the run, saved before it is sent and after it ends. A report saved while a request was `sending` reads,
 * after a restart, as "may have been sent; credits unknown".
 */
export const ResearchRequest = z.strictObject({
  id: z.enum(["search-A1", "search-A2", "search-A3", "extract-A1", "extract-A2", "extract-A3", "model"]),
  kind: z.enum(["search", "extract", "model"]),
  assumption: ResearchAssumptionId.nullable(),
  state: z.enum(["pending", "sending", "answered", "failed", "skipped"]),
  failure: ResearchRequestFailure.nullable(),
  /** The HTTP status Tavily answered with, when it answered. */
  status: z.number().int().min(100).max(599).nullable(),
  /** Tavily's own request id, for its support; null when none came back. */
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable(),
  /** Credits as Tavily reported them; null when it didn't say. Never converted to money. */
  credits: z.number().nonnegative().nullable(),
  /** For an Extract, how many pages it asked for. */
  pages: count,
  /** For an Extract, how many of them came back with content (what Tavily bills by); null otherwise, or without an answer. */
  returned: count.nullable(),
  elapsedMs: count.nullable(),
});
export type ResearchRequest = z.infer<typeof ResearchRequest>;

/** A page Tavily's search returned, with every assumption whose search found it. */
export const ResearchPage = z.strictObject({
  id: PageId,
  address: text(RESEARCH_LIMITS.addressChars),
  /** The hostname as sent, in punycode, shown beside the title so a lookalike name can't pass for another. */
  host: text(RESEARCH_LIMITS.siteChars),
  title: text(RESEARCH_LIMITS.titleChars),
  foundBy: z.array(z.strictObject({ assumption: ResearchAssumptionId, rank: z.number().int().min(1).max(RESEARCH_LIMITS.resultsPerSearch) })).min(1).max(3),
  /** Whose queries Extract read it under. */
  extractedFor: z.array(ResearchAssumptionId).max(3),
  status: z.enum(["read", "not-read", "failed", "refused"]),
});
export type ResearchPage = z.infer<typeof ResearchPage>;

/** One chunk Extract returned for a page under one assumption's query: the only text the model may cite. */
export const ResearchPassage = z.strictObject({
  id: PassageId,
  page: PageId,
  assumption: ResearchAssumptionId,
  chunk: z.number().int().min(1).max(RESEARCH_LIMITS.passagesPerExtraction),
  heading: text(RESEARCH_LIMITS.headingChars).nullable(),
  text: text(RESEARCH_LIMITS.passageChars),
  clipped: z.boolean(),
  retrievedAt: z.iso.datetime(),
});
export type ResearchPassage = z.infer<typeof ResearchPassage>;

/**
 * A citation the model gave, and whether Nivra found its quotation in the passage it names. Valid means the words are
 * there; it says nothing about whether they support the conclusion.
 */
export const ResearchCitation = z.strictObject({
  passage: z.string().max(16),
  stance: z.enum(["supports", "contradicts"]),
  quote: text(RESEARCH_LIMITS.quoteMaxChars),
  valid: z.boolean(),
  problem: z.enum(["unknown-passage", "bad-stance", "too-short", "too-long", "not-found"]).nullable(),
});
export type ResearchCitation = z.infer<typeof ResearchCitation>;

export const ResearchConclusion = z.enum(["supported", "contradicted", "unresolved"]);
export type ResearchConclusion = z.infer<typeof ResearchConclusion>;

/**
 * Why an assessment is shown other than as the model gave it. Each is a rule about the evidence, not about the truth:
 * no valid quotation for its stance, a version the assumption names that no cited source names, the model's own valid
 * citations on both sides, or no assessment at all.
 */
export const ResearchDisplayRule = z.enum(["no-valid-citation", "version-not-named", "both-sides", "not-assessed"]);
export type ResearchDisplayRule = z.infer<typeof ResearchDisplayRule>;

/** One assumption's assessment: the model's, with the citations Nivra checked and how it is shown. */
export const ResearchAssessment = z.strictObject({
  assumption: ResearchAssumptionId,
  /** What the model concluded; null when it gave nothing for this assumption. */
  model: ResearchConclusion.nullable(),
  shown: ResearchConclusion,
  rule: ResearchDisplayRule.nullable(),
  reasoning: text(RESEARCH_LIMITS.reasoningChars),
  applicability: z.strictObject({
    plan: text(RESEARCH_LIMITS.applicabilityChars),
    source: text(RESEARCH_LIMITS.applicabilityChars),
    where: z.enum(["title", "address", "heading", "passage", "unknown"]),
  }),
  uncertainty: text(RESEARCH_LIMITS.uncertaintyChars),
  citations: z.array(ResearchCitation).max(RESEARCH_LIMITS.citationsPerAssessment),
  /** The version the assumption names, if any ("3.12"), which a cited source must name too. */
  version: text(40).nullable(),
  /**
   * What may be offered for the plan: the model's suggestion, for a contradiction shown with valid citations, or the
   * engine's fixed "unverified" note, for an unresolved one. None for a supported one.
   */
  amendment: z.strictObject({ kind: z.enum(["model", "unverified"]), text: text(RESEARCH_LIMITS.amendmentChars) }).nullable(),
});
export type ResearchAssessment = z.infer<typeof ResearchAssessment>;

/** Why a run ended without assessments, in Nivra's words chosen by code. */
export const ResearchStop = z.enum(["nothing-read", "tavily-key-missing", "model-key-missing", "web-research-off", "model-sharing-off", "unsafe-query", "packet-changed", "model-failed", "cancelled", "deadline", "internal"]);
export type ResearchStop = z.infer<typeof ResearchStop>;

/** How far a run got: never whether the plan is right. */
export const ResearchOutcome = z.enum(["in-progress", "complete", "failed", "cancelled", "interrupted"]);
export type ResearchOutcome = z.infer<typeof ResearchOutcome>;

/**
 * A research run's report, stored by the engine (masked) and copied by the host into the plan's conversation. It holds
 * the queries, the pages and the passages on purpose; it repeats what it was bound to, so the host can check it.
 */
export const ResearchReport = z.strictObject({
  planId: z.string(),
  planVersion: z.number().int().positive(),
  packetDigest: z.string(),
  outcome: ResearchOutcome,
  scope: ReviewScope,
  request: z.strictObject({ runId: z.uuid(), clientRequestId: z.uuid() }),
  route: RunRoute.nullable(),
  queries: z.array(z.strictObject({ assumption: ResearchAssumptionId, text: text(RESEARCH_LIMITS.assumptionChars), query: text(RESEARCH_LIMITS.queryChars) })).max(RESEARCH_LIMITS.assumptions),
  sites: ResearchSites.nullable(),
  requests: z.array(ResearchRequest).max(RESEARCH_LIMITS.searches + RESEARCH_LIMITS.extracts + RESEARCH_LIMITS.modelRequests),
  pages: z.array(ResearchPage).max(RESEARCH_LIMITS.pages),
  passages: z.array(ResearchPassage).max(RESEARCH_LIMITS.passages),
  assessments: z.array(ResearchAssessment).max(RESEARCH_LIMITS.assumptions),
  /** The citations the model gave, the ones Nivra found, and how many assessments are shown other than as given. */
  checks: z.strictObject({ citations: count, valid: count, relabelled: count }),
  stop: z.strictObject({ code: ResearchStop, message: text(400) }).nullable(),
  /** Credits as reported, null once any request didn't say; the model's tokens as reported. */
  usage: z.strictObject({ credits: z.number().nonnegative().nullable(), model: RunUsage }),
  budget: RunBudgetRecord.nullable(),
  elapsedMs: count,
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ResearchReport = z.infer<typeof ResearchReport>;
