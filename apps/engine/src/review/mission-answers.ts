import { REVIEW_REPORT_LIMITS, taskRef, type Mask, type MissionReviewPacket, type PreferenceSnapshot, type ReviewFinding, type ReviewRole, type ReviewerReport } from "@nivra/domain";
import { z } from "zod";
import { Changes, items, PREFIX, severityOf } from "./answers.ts";

/**
 * What the engine keeps of a mission reviewer's answer (NIV-52). The answer's shape is the plan review's (D30), its
 * fields described for a mission; what a reference may name differs. A finding names the selected tasks it concerns
 * (T1 to Tn), the mission, or a gap in the backlog, and may cite preferences; anything else is dropped and counted. A
 * finding left naming no task, the mission or the backlog is set aside and counted, never linked to anything, and so is
 * one with neither a title nor a detail. A reviewer none of whose findings could be kept handed in nothing usable: that
 * is never read as a review that found no problems.
 */

const List = z.union([z.array(z.string()), z.string()]).default([]);

/**
 * What a mission reviewer hands in: the plan review's form field for field, so the same lenient reading applies, with
 * each field described for a mission and its selected tasks. The model reads these descriptions with the instructions,
 * so they ask for what this mode keeps; a test pins the definition's hash to the profiles' version.
 */
export const MissionReviewAnswer = z.object({
  summary: z.string().default("").describe("Your review in a few sentences: what matters most for the mission. If the selected tasks serve it with no material problems, say why. At most 1,500 characters"),
  findings: z
    .array(
      z.object({
        title: z.string().default("").describe("The finding in a few words"),
        detail: z.string().default("").describe("What the problem is and why it matters for the mission, in a short paragraph"),
        recommendation: z.string().default("").describe("What to change or decide, specifically enough to act on"),
        severity: z.string().nullable().default(null).describe("high, medium or low"),
        basis: z.string().nullable().default(null).describe('"plan" when it follows from what the mission and the selected tasks say; "assumption" when it relies on anything else'),
        refs: List.describe("What it is about: T1, T2, ... for the selected tasks it concerns, mission, backlog for something the selected work needs that no selected task covers, or a preference's id. At least one task, the mission or the backlog"),
      }),
    )
    .default([])
    .describe("Material findings only, at most 8; none when the selected tasks serve the mission soundly"),
  assumptions: List.describe("What you had to take as true"),
  gaps: List.describe("What you couldn't establish"),
});
export type MissionReviewAnswer = z.infer<typeof MissionReviewAnswer>;

type Kind = "task" | "mission" | "backlog" | "preference";

/** What a reference may name in this packet, normalised, or null when it names nothing in it. */
export function missionRefChecker(packet: MissionReviewPacket, preferences: PreferenceSnapshot) {
  const ids = new Set(preferences.records.map((record) => record.id));
  return (ref: string): { ref: string; kind: Kind } | null => {
    const value = ref.replace(/^\[|\]$/g, "");
    const task = /^T([1-9]\d{0,2})$/i.exec(value);
    if (task && Number(task[1]) <= packet.tasks.length) return { ref: taskRef(Number(task[1]) - 1), kind: "task" };
    if (/^mission$/i.test(value)) return { ref: "mission", kind: "mission" };
    if (/^backlog$/i.test(value)) return { ref: "backlog", kind: "backlog" };
    if (ids.has(value.toLowerCase())) return { ref: value.toLowerCase(), kind: "preference" };
    return null;
  };
}

/**
 * A mission reviewer's report as the engine keeps it; or `empty`, when it holds no summary and no findings; or
 * `rejected`, when it handed in findings and none could be kept: each named nothing in the selection (`setAside`) or
 * had neither a title nor a detail (`empty`).
 */
export type MissionReviewKept = { kind: "kept"; report: ReviewerReport } | { kind: "empty" } | { kind: "rejected"; setAside: number; empty: number };

export function normaliseMissionReview(role: ReviewRole, answer: MissionReviewAnswer, packet: MissionReviewPacket, preferences: PreferenceSnapshot, mask: Mask): MissionReviewKept {
  const changes = new Changes();
  const check = missionRefChecker(packet, preferences);
  const L = REVIEW_REPORT_LIMITS;
  let unanchored = 0;
  let empty = 0;
  const summary = changes.clip(answer.summary, L.summaryChars, mask);
  const findings: ReviewFinding[] = [];
  for (const raw of answer.findings) {
    const title = changes.clip(raw.title, L.titleChars, mask);
    const detail = changes.clip(raw.detail, L.detailChars, mask);
    // Nothing to show: counted apart from the limit's drops, so a form filled in wrongly never reads as a clean review.
    if (!title && !detail) {
      empty++;
      continue;
    }
    if (findings.length >= L.findings) {
      changes.dropped++;
      continue;
    }
    const refs: string[] = [];
    const kinds = new Set<Kind>();
    for (const ref of items(raw.refs)) {
      const checked = check(ref);
      if (!checked || refs.includes(checked.ref) || refs.length >= L.refs) {
        changes.refsDropped++;
        continue;
      }
      refs.push(checked.ref);
      kinds.add(checked.kind);
    }
    // Linked to nothing in the selection: set aside, never attached to a task it didn't name.
    if (!kinds.has("task") && !kinds.has("mission") && !kinds.has("backlog")) {
      unanchored++;
      continue;
    }
    // What it rests on: what was sent, unless the reviewer said otherwise. A label that is neither makes it an
    // assumption, so the engine never claims more for a finding than its reviewer did.
    const given = raw.basis?.trim().toLowerCase() || null;
    const derived = given === null || given === "plan" ? "plan" : "assumption";
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
  if (findings.length === 0 && unanchored + empty > 0) return { kind: "rejected", setAside: unanchored, empty };
  if (!summary && findings.length === 0) return { kind: "empty" };
  const notes = (value: string | string[]) => {
    const all = items(Array.isArray(value) ? value : [value]).map((note) => changes.clip(note, L.noteChars, mask)).filter(Boolean);
    if (all.length > L.notes) changes.dropped += all.length - L.notes;
    return all.slice(0, L.notes);
  };
  return { kind: "kept", report: { role, summary, findings, assumptions: notes(answer.assumptions), gaps: notes(answer.gaps), adjusted: { ...changes.record, unanchored, empty } } };
}

/** Why a reviewer none of whose findings could be kept can't be used, in Nivra's words: counts only, never the model's references. */
export function rejectedReason(setAside: number, empty = 0): string {
  if (setAside > 0 && empty > 0) return `of its ${setAside + empty} findings, ${setAside} named nothing in the selection and ${empty} had no title or detail, so none could be kept`;
  if (empty > 0) return empty === 1 ? "its one finding had no title or detail, so it couldn't be kept" : `its ${empty} findings had no title or detail, so none could be kept`;
  return setAside === 1 ? "its one finding named nothing in the selection, so it couldn't be kept" : `its ${setAside} findings named nothing in the selection, so none could be kept`;
}

/** The same, as the stage's problems: one line for each reason, with its count. */
export function rejectedProblems(setAside: number, empty = 0): string[] {
  return [setAside > 0 ? `findings: ${setAside} named no selected task, the mission or the backlog` : "", empty > 0 ? `findings: ${empty} had no title or detail` : ""].filter(Boolean);
}
