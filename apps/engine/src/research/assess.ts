import { z } from "zod";
import { RESEARCH_LIMITS } from "./limits.ts";
import { plainText, type AssumptionId, type Page } from "./pages.ts";
import type { Passage } from "./passages.ts";

/**
 * The model's assessment, and Nivra's check of its citations (NIV-45). A quotation found in the passage it names
 * proves where the words came from, never that they support the conclusion: so the assessment stays the model's, and
 * the person judges it. Nivra adds three rules about the evidence, each shown with the model's own label and the
 * reason, never as a verdict on the truth:
 * - supported or contradicted needs a valid quotation of that stance;
 * - each version the assumption names (3.12, v15) must be named by a cited source: its title, address, heading or
 *   passage;
 * - the model's own valid quotations on both sides leave it unresolved.
 *
 * The schema is lenient, as review's is: every field defaults, and the engine clips, masks and counts. Every field the
 * model fills says what goes in it. An assessment counts only when it names an assumption that was asked about, by its
 * id or by its exact words, and no other assessment names the same one: never by its place in the answer, and never by
 * a likeness of words. What is set aside is counted, with a short, masked record of what it named and why.
 */

const text = (description: string) => z.string().default("").describe(description);
export const ResearchAnswer = z.object({
  assessments: z
    .array(
      z.object({
        assumption: text("The assumption's id exactly as listed: A1, A2 or A3. Not its words."),
        outcome: text('"supported", "contradicted" or "unresolved".'),
        reasoning: text("How the passages you cite bear on the assumption, in two to four sentences."),
        citations: z
          .array(
            z.object({
              passage: text('The id of one passage you were given, such as "S2.1".'),
              stance: text('"supports" or "contradicts".'),
              quote: text("Words copied exactly from that one passage."),
            }),
          )
          .default([])
          .describe("The passages that bear on the assumption, each with a quotation copied exactly from it."),
        applicability: z
          .object({
            plan: text("The version or environment the plan means."),
            source: text("The version or environment the cited source is about."),
            where: text('Where the source says so: "title", "address", "heading" or "passage".'),
          })
          .default({ plan: "", source: "", where: "" })
          .describe("Whether the cited sources are about the version or environment the plan means."),
        uncertainty: text("What the passages leave open."),
        amendment: text("For a contradicted assumption, one or two sentences correcting the assumption or the plan; otherwise empty."),
      }),
    )
    .default([])
    .describe("One assessment for each assumption listed, in any order, all in this one call."),
});
export type ResearchAnswer = z.infer<typeof ResearchAnswer>;

export type Conclusion = "supported" | "contradicted" | "unresolved";
export type DisplayRule = "no-valid-citation" | "version-not-named" | "both-sides" | "not-assessed";

export interface Citation {
  passage: string;
  stance: "supports" | "contradicts";
  quote: string;
  valid: boolean;
  problem: "unknown-passage" | "bad-stance" | "too-short" | "too-long" | "not-found" | null;
}

export interface Assessment {
  assumption: AssumptionId;
  model: Conclusion | null;
  shown: Conclusion;
  rule: DisplayRule | null;
  reasoning: string;
  applicability: { plan: string; source: string; where: "title" | "address" | "heading" | "passage" | "unknown" };
  uncertainty: string;
  citations: Citation[];
  version: string | null;
  amendment: { kind: "model" | "unverified"; text: string } | null;
}

/** Why an assessment the model handed in was set aside instead of being matched to an assumption. */
export type Rejection = "missing" | "unknown" | "ambiguous" | "conflicting" | "duplicate";

/** What the model handed in, and how much of it named an assumption that was asked about. */
export interface Attribution {
  handedIn: number;
  matched: number;
  rejected: number;
  /** At most ten of the assessments set aside: what each named, made plain, masked and clipped, and why. */
  entries: Array<{ label: string; reason: Rejection }>;
}

export interface Assessed {
  assessments: Assessment[];
  checks: { citations: number; valid: number; relabelled: number };
  /** Null until the model has handed in an answer that could be read. */
  attribution: Attribution | null;
}

/** For matching a quotation: one case, single spaces, straight quotes and plain dashes, no invisible marks. */
export function forMatching(value: string): string {
  return plainText(value)
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The longest version kept: longer runs of numbers and dots (an OID) aren't versions. */
const VERSION_CHARS = 40;

/**
 * The versions an assumption names, each once, in the order it names them: written with a dot (3.12, 18.18.0) or a v
 * (v15), at most three. A version written as a bare number ("Postgres 16") isn't recognised.
 */
export function versionsIn(assumption: string): string[] {
  const found = [
    ...[...assumption.matchAll(/(?<![\w.])v?(\d+\.\d+(?:\.\d+)*)(?![\w.]*\d)/gi)].map((match) => ({ at: match.index, version: match[1]! })),
    ...[...assumption.matchAll(/(?<![\w.])v(\d+)(?![\d.])/gi)].map((match) => ({ at: match.index, version: match[1]! })),
  ]
    .filter((match) => match.version.length <= VERSION_CHARS)
    .sort((a, b) => a.at - b.at)
    .map((match) => match.version);
  return [...new Set(found)].slice(0, 3);
}

/** The first version an assumption names; null when it names none. */
export function versionIn(assumption: string): string | null {
  return versionsIn(assumption)[0] ?? null;
}

/** Whether `where` names `version`: as itself or a later part of it (3.12 in 3.12.1), never as part of another (3.120). */
export function namesVersion(where: string, version: string): boolean {
  const escaped = version.replace(/\./g, "\\.");
  return new RegExp(`(?<![\\d.])${escaped}(?!\\d)`).test(where);
}

function clip(value: string, max: number, mask: (text: string) => string): string {
  const cleaned = mask(plainText(value)).trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/** How many of the assessments set aside are listed, and how much of what each named is kept. */
const LISTED = 10;
const LABEL_CHARS = 80;

/**
 * An assumption named by its id: "A1", in any case, optionally in brackets or after the word "assumption", and
 * optionally followed by a separator and words. Nothing else is read as an id.
 */
const BY_ID = /^(?:assumption\s*)?[(\[]?\s*a(\d{1,2})\s*[)\]]?(?:$|[\s:.,;\u2013\u2014-]+(.*)$)/isu;
/** Another id inside the words after one. */
const ID_TOKEN = /(?<![\p{L}\p{N}])a\d{1,2}(?![\p{L}\p{N}])/iu;

/** Words as matching reads them: plain, in one case, with single spaces and straight quotes, and no wrapping quotes or closing stop. */
const wording = (value: string) =>
  forMatching(value)
    .replace(/^["']+|["']+$/g, "")
    .replace(/[.!?]+$/, "")
    .trim();

/**
 * Which assumption an assessment names, or why it names none Nivra can be sure of. By id: the id must be one asked
 * about, and words after it must not be another assumption's exact words or name another id. By words: they must be
 * exactly one assumption's words, as matching reads them.
 */
function named(value: string, assumptions: ReadonlyArray<{ id: AssumptionId; text: string }>): { ok: true; id: AssumptionId } | { ok: false; reason: Rejection } {
  const plain = plainText(value).normalize("NFKC").trim();
  if (!plain) return { ok: false, reason: "missing" };
  const byId = BY_ID.exec(plain);
  if (byId) {
    const asked = assumptions.find((assumption) => assumption.id === `A${Number(byId[1])}`);
    if (!asked) return { ok: false, reason: "unknown" };
    const rest = wording(byId[2] ?? "");
    if (!rest || rest === wording(asked.text)) return { ok: true, id: asked.id };
    if (assumptions.some((assumption) => assumption.id !== asked.id && wording(assumption.text) === rest)) return { ok: false, reason: "conflicting" };
    if (ID_TOKEN.test(rest)) return { ok: false, reason: "ambiguous" };
    return { ok: true, id: asked.id };
  }
  const words = wording(plain);
  const same = assumptions.filter((assumption) => wording(assumption.text) === words);
  if (same.length === 1) return { ok: true, id: same[0]!.id };
  return { ok: false, reason: same.length > 1 ? "ambiguous" : "unknown" };
}

const OUTCOMES = new Set<Conclusion>(["supported", "contradicted", "unresolved"]);
const STANCE_OF: Record<"supported" | "contradicted", "supports" | "contradicts"> = { supported: "supports", contradicted: "contradicts" };
const WHERE = new Set(["title", "address", "heading", "passage"]);

/** Checks one citation against the passages the message held. */
function checkCitation(raw: { passage: string; stance: string; quote: string }, passages: readonly Passage[], mask: (text: string) => string): Citation {
  const id = raw.passage.trim().toUpperCase();
  const stance = raw.stance.trim().toLowerCase();
  const quote = clip(raw.quote, RESEARCH_LIMITS.quoteMaxChars + 1, mask);
  const shown = quote.length > RESEARCH_LIMITS.quoteMaxChars ? `${quote.slice(0, RESEARCH_LIMITS.quoteMaxChars - 1)}…` : quote;
  const base = { passage: id.slice(0, 16), stance: (stance === "contradicts" ? "contradicts" : "supports") as Citation["stance"], quote: shown };
  const passage = passages.find((candidate) => candidate.id === id);
  if (!passage) return { ...base, valid: false, problem: "unknown-passage" };
  if (stance !== "supports" && stance !== "contradicts") return { ...base, valid: false, problem: "bad-stance" };
  const words = quote.split(/\s+/).filter(Boolean).length;
  if (quote.length < RESEARCH_LIMITS.quoteMinChars || words < RESEARCH_LIMITS.quoteMinWords) return { ...base, valid: false, problem: "too-short" };
  if (quote.length > RESEARCH_LIMITS.quoteMaxChars) return { ...base, valid: false, problem: "too-long" };
  if (!forMatching(passage.text).includes(forMatching(quote))) return { ...base, valid: false, problem: "not-found" };
  return { ...base, valid: true, problem: null };
}

/**
 * Each assumption's assessment, as the model gave it and as it is shown, with every citation checked. An assessment is
 * used only when it names one assumption asked about and no other assessment names the same one; the rest are set
 * aside and counted. An assumption with no assessment used is shown unresolved, as not assessed.
 */
export function assess(answer: ResearchAnswer, assumptions: ReadonlyArray<{ id: AssumptionId; text: string }>, passages: readonly Passage[], pages: readonly Page[], mask: (text: string) => string): Assessed {
  let given = 0;
  let valid = 0;
  const resolved = answer.assessments.map((entry) => ({ entry, result: named(entry.assumption, assumptions) }));
  const answers = new Map<AssumptionId, number>();
  for (const { result } of resolved) if (result.ok) answers.set(result.id, (answers.get(result.id) ?? 0) + 1);
  const used = new Map<AssumptionId, ResearchAnswer["assessments"][number]>();
  const rejected: Attribution["entries"] = [];
  for (const { entry, result } of resolved) {
    // Two answers for one assumption: neither is used, since nothing says which one the model meant.
    if (result.ok && answers.get(result.id) === 1) used.set(result.id, entry);
    else rejected.push({ label: clip(entry.assumption, LABEL_CHARS, mask), reason: result.ok ? "duplicate" : result.reason });
  }
  const attribution: Attribution = { handedIn: resolved.length, matched: used.size, rejected: rejected.length, entries: rejected.slice(0, LISTED) };
  const assessments = assumptions.map(({ id, text: assumptionText }): Assessment => {
    const raw = used.get(id);
    const versions = versionsIn(assumptionText);
    let version = versions[0] ?? null;
    const unverified = { kind: "unverified" as const, text: `Unverified: "${assumptionText}". Research found no quotation that settles it.` };
    if (!raw) {
      return { assumption: id, model: null, shown: "unresolved", rule: "not-assessed", reasoning: "", applicability: { plan: "", source: "", where: "unknown" }, uncertainty: "", citations: [], version, amendment: unverified };
    }
    given += raw.citations.length;
    const citations = raw.citations.slice(0, RESEARCH_LIMITS.citationsPerAssessment).map((citation) => checkCitation(citation, passages, mask));
    valid += citations.filter((citation) => citation.valid).length;
    const outcome = raw.outcome.trim().toLowerCase();
    const model = OUTCOMES.has(outcome as Conclusion) ? (outcome as Conclusion) : null;
    const stances = new Set(citations.filter((citation) => citation.valid).map((citation) => citation.stance));
    let shown: Conclusion = model ?? "unresolved";
    let rule: DisplayRule | null = model ? null : "not-assessed";
    if (model === "supported" || model === "contradicted") {
      const backing = citations.filter((citation) => citation.valid && citation.stance === STANCE_OF[model]);
      if (stances.size > 1) {
        shown = "unresolved";
        rule = "both-sides";
      } else if (!backing.length) {
        shown = "unresolved";
        rule = "no-valid-citation";
      } else {
        // Every version the assumption names must be named where a backing quotation came from: its passage, the
        // passage's heading, or its page's title or address. The first one no source names is the one shown.
        const missing = versions.find(
          (named) =>
            !backing.some((citation) => {
              const passage = passages.find((candidate) => candidate.id === citation.passage)!;
              const page = pages.find((candidate) => candidate.id === passage.page);
              return [passage.text, passage.heading ?? "", page?.title ?? "", page?.address ?? ""].some((where) => namesVersion(where, named));
            }),
        );
        if (missing) {
          shown = "unresolved";
          rule = "version-not-named";
          version = missing;
        }
      }
    }
    const where = raw.applicability.where.trim().toLowerCase();
    const suggestion = clip(raw.amendment, RESEARCH_LIMITS.amendmentChars, mask);
    const amendment = shown === "contradicted" ? (suggestion ? { kind: "model" as const, text: suggestion } : null) : shown === "unresolved" ? unverified : null;
    return {
      assumption: id,
      model,
      shown,
      rule,
      reasoning: clip(raw.reasoning, RESEARCH_LIMITS.reasoningChars, mask),
      applicability: {
        plan: clip(raw.applicability.plan, RESEARCH_LIMITS.applicabilityChars, mask),
        source: clip(raw.applicability.source, RESEARCH_LIMITS.applicabilityChars, mask),
        where: (WHERE.has(where) ? where : "unknown") as Assessment["applicability"]["where"],
      },
      uncertainty: clip(raw.uncertainty, RESEARCH_LIMITS.uncertaintyChars, mask),
      citations,
      version,
      amendment,
    };
  });
  return { assessments, checks: { citations: given, valid, relabelled: assessments.filter((assessment) => assessment.rule !== null).length }, attribution };
}
