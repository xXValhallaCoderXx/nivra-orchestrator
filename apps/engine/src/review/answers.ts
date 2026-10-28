import { REVIEW_REPORT_LIMITS, type ChairSynthesis, type Mask, type PreferenceSnapshot, type ReviewFinding, type ReviewPacket, type ReviewRole, type ReviewerReport } from "@nivra/domain";
import { z } from "zod";

/**
 * What reviewers and the chair hand in, and what the engine keeps of it (NIV-38, D30). Each gets one request, so the
 * schemas are as lenient as they can be: every field has a default, and lists may arrive as a string. Whatever the
 * schema refuses never reaches Nivra and costs the stage. The engine does the rest: it clips, gives findings their ids,
 * reads what each one rests on from its references, and counts every change it made.
 */

const List = z.union([z.array(z.string()), z.string()]).default([]);

export const ReviewAnswer = z.object({
  summary: z.string().default("").describe("Your review in a few sentences: what matters most. If the plan has no material problems, say why. At most 1,500 characters"),
  findings: z
    .array(
      z.object({
        title: z.string().default("").describe("The finding in a few words"),
        detail: z.string().default("").describe("What the problem is and why it matters, in a short paragraph"),
        recommendation: z.string().default("").describe("What to change or test, specifically enough to act on"),
        severity: z.string().nullable().default(null).describe("high, medium or low"),
        basis: z.string().nullable().default(null).describe('"plan" when it follows from what the plan says; "assumption" when it relies on anything else'),
        refs: List.describe("What in the message it rests on: plan, A1, E3, or a preference's id"),
      }),
    )
    .default([])
    .describe("Material findings only, at most 8; none for a sound plan"),
  assumptions: List.describe("What you had to take as true"),
  gaps: List.describe("What you couldn't establish"),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

export const SynthesisAnswer = z.object({
  summary: z.string().default("").describe("What the reports add up to, in a few sentences. At most 2,000 characters"),
  priorities: List.describe("The finding ids that matter most, first first"),
  agreements: z
    .array(z.object({ statement: z.string().default(""), findingIds: List }))
    .default([])
    .describe("Where the reviewers agree, each with the finding ids that say so. Agreement is not proof"),
  dissent: z
    .array(
      z.object({
        topic: z.string().default(""),
        positions: z.array(z.object({ position: z.string().default(""), findingIds: List })).default([]),
        note: z.string().default(""),
      }),
    )
    .default([])
    .describe("Where they disagree: each position as its reviewer gave it, with its finding ids"),
  gaps: List.describe("What is still unknown"),
});
export type SynthesisAnswer = z.infer<typeof SynthesisAnswer>;

export const REVIEW_TOOL_DESCRIPTION = "Hand in your review. Call this once. Name only what the message holds in refs.";
export const SYNTHESIS_TOOL_DESCRIPTION = "Hand in your synthesis of the reviewers' reports. Call this once. Name findings only by the ids shown.";

export const PREFIX: Readonly<Record<ReviewRole, string>> = { architecture: "arch", risks: "risk", single: "single" };
const ROLE_OF_PREFIX: Readonly<Record<string, ReviewRole>> = { arch: "architecture", risk: "risks", single: "single" };

/** A list a model may send as one string: split on commas, semicolons and white space. */
export const items = (value: string | string[]): string[] => (Array.isArray(value) ? value : value.split(/[,;\s]+/)).map((item) => item.trim()).filter(Boolean);

/** Counts what was changed while clipping and checking. */
export class Changes {
  dropped = 0;
  refsDropped = 0;
  relabelled = 0;
  shortened = 0;

  clip(text: string, max: number, mask: Mask): string {
    // Control characters other than line breaks and tabs never reach the report, and a lone surrogate becomes U+FFFD.
    const clean = mask(
      text
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"),
    ).trim();
    if (clean.length <= max) return clean;
    this.shortened++;
    return `${clean.slice(0, max - 1)}…`;
  }

  get record() {
    return { dropped: this.dropped, refsDropped: this.refsDropped, relabelled: this.relabelled, shortened: this.shortened };
  }
}

const SEVERITY: ReadonlyArray<[RegExp, "high" | "medium" | "low"]> = [
  [/^(critical|blocker|blocking|high|severe|major)$/i, "high"],
  [/^(medium|moderate|important)$/i, "medium"],
  [/^(low|minor|nit|trivial)$/i, "low"],
];
export const severityOf = (value: string | null): "high" | "medium" | "low" | null => (value === null ? null : (SEVERITY.find(([pattern]) => pattern.test(value.trim()))?.[1] ?? null));

/**
 * What a reference may name in this packet: the plan, one of its assumptions, one of its historical references, or one
 * of the preferences the run was given. Anything else is dropped and counted.
 */
function refChecker(packet: ReviewPacket, preferences: PreferenceSnapshot) {
  const ids = new Set(preferences.records.map((record) => record.id));
  return (ref: string): { ref: string; kind: "plan" | "assumption" | "reference" | "preference" } | null => {
    const value = ref.replace(/^\[|\]$/g, "");
    if (/^plan$/i.test(value)) return { ref: "plan", kind: "plan" };
    const assumption = /^A([1-9]\d{0,2})$/i.exec(value);
    if (assumption && Number(assumption[1]) <= packet.assumptions.length) return { ref: `A${Number(assumption[1])}`, kind: "assumption" };
    const reference = /^E([1-9]\d{0,2})$/i.exec(value);
    if (reference && Number(reference[1]) <= packet.references.length) return { ref: `E${Number(reference[1])}`, kind: "reference" };
    if (ids.has(value.toLowerCase())) return { ref: value.toLowerCase(), kind: "preference" };
    return null;
  };
}

/**
 * A reviewer's report as the engine keeps it, or null when it holds nothing at all: no summary and no findings. A
 * report with no findings and a summary is a valid "no material issues" review.
 */
export function normaliseReview(role: ReviewRole, answer: ReviewAnswer, packet: ReviewPacket, preferences: PreferenceSnapshot, mask: Mask): ReviewerReport | null {
  const changes = new Changes();
  const check = refChecker(packet, preferences);
  const L = REVIEW_REPORT_LIMITS;
  const summary = changes.clip(answer.summary, L.summaryChars, mask);
  const findings: ReviewFinding[] = [];
  for (const raw of answer.findings) {
    const title = changes.clip(raw.title, L.titleChars, mask);
    const detail = changes.clip(raw.detail, L.detailChars, mask);
    if (!title && !detail) {
      changes.dropped++;
      continue;
    }
    if (findings.length >= L.findings) {
      changes.dropped++;
      continue;
    }
    const refs: string[] = [];
    const kinds = new Set<string>();
    for (const ref of items(raw.refs)) {
      const checked = check(ref);
      if (!checked || refs.includes(checked.ref) || refs.length >= L.refs) {
        changes.refsDropped++;
        continue;
      }
      refs.push(checked.ref);
      kinds.add(checked.kind);
    }
    // What the finding rests on, read from its references: the plan, or an assumption. A historical reference is an
    // address, not what is there, so on its own it makes nothing more than an assumption.
    const given = raw.basis?.trim().toLowerCase() ?? null;
    const derived = given === "assumption" ? "assumption" : kinds.has("plan") || kinds.has("assumption") ? "plan" : "assumption";
    const relabelled = given !== null && given !== derived;
    if (relabelled) changes.relabelled++;
    findings.push({
      id: `${PREFIX[role]}-${findings.length + 1}`,
      title: title || detail.slice(0, L.titleChars),
      detail,
      recommendation: changes.clip(raw.recommendation, L.recommendationChars, mask),
      severity: severityOf(raw.severity),
      basis: derived,
      refs,
      relabelled,
    });
  }
  if (!summary && findings.length === 0) return null;
  const notes = (value: string | string[]) => {
    const all = items(Array.isArray(value) ? value : [value]).map((note) => changes.clip(note, L.noteChars, mask)).filter(Boolean);
    if (all.length > L.notes) changes.dropped += all.length - L.notes;
    return all.slice(0, L.notes);
  };
  return { role, summary, findings, assumptions: notes(answer.assumptions), gaps: notes(answer.gaps), adjusted: changes.record };
}

/**
 * The chair's synthesis as the engine keeps it, or null when it holds nothing. Finding ids are checked against the
 * reports; the roles behind each agreement and position come from its ids, so one backed by a single reviewer shows as
 * one-sided; and every finding named nowhere in what is kept is listed as unaddressed, so one named only in a part
 * dropped for the limits is listed too.
 */
export function normaliseSynthesis(answer: SynthesisAnswer, reports: readonly ReviewerReport[], mask: Mask): ChairSynthesis | null {
  const changes = new Changes();
  const L = REVIEW_REPORT_LIMITS;
  const known = new Set(reports.flatMap((report) => report.findings.map((finding) => finding.id)));
  const ids = (value: string | string[]) => {
    const kept: string[] = [];
    for (const id of items(value)) {
      const normal = id.toLowerCase();
      if (!known.has(normal) || kept.includes(normal) || kept.length >= L.ids) {
        changes.refsDropped++;
        continue;
      }
      kept.push(normal);
    }
    return kept;
  };
  const rolesOf = (findingIds: readonly string[]) => [...new Set(findingIds.map((id) => ROLE_OF_PREFIX[id.split("-")[0] ?? ""]).filter((role): role is ReviewRole => role !== undefined))];
  const summary = changes.clip(answer.summary, L.synthesisChars, mask);
  const priorities = ids(answer.priorities);
  const agreements: ChairSynthesis["agreements"] = [];
  for (const agreement of answer.agreements) {
    const statement = changes.clip(agreement.statement, L.statementChars, mask);
    const findingIds = ids(agreement.findingIds);
    if ((!statement && findingIds.length === 0) || agreements.length >= L.agreements) {
      changes.dropped++;
      continue;
    }
    agreements.push({ statement, findingIds, roles: rolesOf(findingIds) });
  }
  const dissent: ChairSynthesis["dissent"] = [];
  for (const entry of answer.dissent) {
    const topic = changes.clip(entry.topic, L.topicChars, mask);
    const positions: ChairSynthesis["dissent"][number]["positions"] = [];
    for (const position of entry.positions) {
      const text = changes.clip(position.position, L.statementChars, mask);
      const findingIds = ids(position.findingIds);
      if ((!text && findingIds.length === 0) || positions.length >= L.positions) {
        changes.dropped++;
        continue;
      }
      positions.push({ position: text, findingIds, roles: rolesOf(findingIds) });
    }
    if ((!topic && positions.length === 0) || dissent.length >= L.dissent) {
      changes.dropped++;
      continue;
    }
    dissent.push({ topic, positions, note: changes.clip(entry.note, L.statementChars, mask) });
  }
  const gaps = items(answer.gaps)
    .map((gap) => changes.clip(gap, L.noteChars, mask))
    .filter(Boolean)
    .slice(0, L.notes);
  if (!summary && priorities.length === 0 && agreements.length === 0 && dissent.length === 0) return null;
  const mentioned = new Set([...priorities, ...agreements.flatMap((agreement) => agreement.findingIds), ...dissent.flatMap((entry) => entry.positions.flatMap((position) => position.findingIds))]);
  const unaddressed = [...known].filter((id) => !mentioned.has(id)).slice(0, L.ids);
  return { summary, priorities, agreements, dissent, gaps, unaddressed, adjusted: changes.record };
}

/**
 * The largest report a reviewer can hand in once the engine has clipped it, for estimating the chair's whole input
 * before anything is sent: the chair's room is reserved at its largest.
 */
export function largestReport(role: ReviewRole): ReviewerReport {
  const L = REVIEW_REPORT_LIMITS;
  const fill = (n: number) => "x".repeat(n);
  return {
    role,
    summary: fill(L.summaryChars),
    findings: Array.from({ length: L.findings }, (_, index) => ({
      id: `${PREFIX[role]}-${index + 1}`,
      title: fill(L.titleChars),
      detail: fill(L.detailChars),
      recommendation: fill(L.recommendationChars),
      severity: "medium" as const,
      basis: "assumption" as const,
      refs: Array.from({ length: L.refs }, () => fill(36)),
      relabelled: false,
    })),
    assumptions: Array.from({ length: L.notes }, () => fill(L.noteChars)),
    gaps: Array.from({ length: L.notes }, () => fill(L.noteChars)),
    adjusted: { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 },
  };
}
