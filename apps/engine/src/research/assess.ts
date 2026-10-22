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
 * - a version the assumption names (3.12, v15) must be named by a cited source: its title, address, heading or passage;
 * - the model's own valid quotations on both sides leave it unresolved.
 *
 * The schema is lenient, as review's is: every field defaults, and the engine clips, masks and counts.
 */

const text = z.string().default("");
export const ResearchAnswer = z.object({
  assessments: z
    .array(
      z.object({
        assumption: text,
        outcome: text,
        reasoning: text,
        citations: z.array(z.object({ passage: text, stance: text, quote: text })).default([]),
        applicability: z.object({ plan: text, source: text, where: text }).default({ plan: "", source: "", where: "" }),
        uncertainty: text,
        amendment: text,
      }),
    )
    .default([]),
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

export interface Assessed {
  assessments: Assessment[];
  checks: { citations: number; valid: number; relabelled: number };
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

/** The version an assumption names, written with a dot (3.12, 18.18.0) or a v (v15); null when it names none. */
export function versionIn(assumption: string): string | null {
  const dotted = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)*)(?![\w.]*\d)/i.exec(assumption);
  if (dotted) return dotted[1]!;
  const prefixed = /(?<![\w.])v(\d+)(?![\d.])/i.exec(assumption);
  return prefixed ? prefixed[1]! : null;
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
 * Each assumption's assessment, as the model gave it and as it is shown, with every citation checked. Assessments for
 * assumptions that weren't asked about are ignored; an assumption the model left out is shown unresolved.
 */
export function assess(answer: ResearchAnswer, assumptions: ReadonlyArray<{ id: AssumptionId; text: string }>, passages: readonly Passage[], pages: readonly Page[], mask: (text: string) => string): Assessed {
  let given = 0;
  let valid = 0;
  const assessments = assumptions.map(({ id, text: assumptionText }): Assessment => {
    const raw = answer.assessments.find((candidate) => candidate.assumption.trim().toUpperCase() === id);
    const version = versionIn(assumptionText);
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
      } else if (version) {
        const named = backing.some((citation) => {
          const passage = passages.find((candidate) => candidate.id === citation.passage)!;
          const page = pages.find((candidate) => candidate.id === passage.page);
          return [passage.text, passage.heading ?? "", page?.title ?? "", page?.address ?? ""].some((where) => namesVersion(where, version));
        });
        if (!named) {
          shown = "unresolved";
          rule = "version-not-named";
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
  return { assessments, checks: { citations: given, valid, relabelled: assessments.filter((assessment) => assessment.rule !== null).length } };
}
