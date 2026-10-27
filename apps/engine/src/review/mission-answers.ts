import { REVIEW_REPORT_LIMITS, taskRef, type Mask, type MissionReviewPacket, type PreferenceSnapshot, type ReviewFinding, type ReviewRole, type ReviewerReport } from "@nivra/domain";
import { Changes, items, PREFIX, severityOf, type ReviewAnswer } from "./answers.ts";

/**
 * What the engine keeps of a mission reviewer's answer (NIV-52). The answer's form is the plan review's (D30); what a
 * reference may name differs. A finding names the selected tasks it concerns (T1 to Tn), the mission, or a gap in the
 * backlog, and may cite preferences; anything else is dropped and counted. A finding left naming no task, the mission
 * or the backlog is set aside and counted, never linked to anything. A reviewer whose every finding was set aside handed
 * in nothing usable: that is never read as a review that found no problems.
 */

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
 * `rejected`, when it handed in findings and every one was set aside for naming nothing in the selection.
 */
export type MissionReviewKept = { kind: "kept"; report: ReviewerReport } | { kind: "empty" } | { kind: "rejected"; setAside: number };

export function normaliseMissionReview(role: ReviewRole, answer: ReviewAnswer, packet: MissionReviewPacket, preferences: PreferenceSnapshot, mask: Mask): MissionReviewKept {
  const changes = new Changes();
  const check = missionRefChecker(packet, preferences);
  const L = REVIEW_REPORT_LIMITS;
  let unanchored = 0;
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
    // What it rests on: what the message says, unless the reviewer said it was an assumption.
    const given = raw.basis?.trim().toLowerCase() ?? null;
    const derived = given === "assumption" ? "assumption" : "plan";
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
  if (findings.length === 0 && unanchored > 0) return { kind: "rejected", setAside: unanchored };
  if (!summary && findings.length === 0) return { kind: "empty" };
  const notes = (value: string | string[]) => {
    const all = items(Array.isArray(value) ? value : [value]).map((note) => changes.clip(note, L.noteChars, mask)).filter(Boolean);
    if (all.length > L.notes) changes.dropped += all.length - L.notes;
    return all.slice(0, L.notes);
  };
  return { kind: "kept", report: { role, summary, findings, assumptions: notes(answer.assumptions), gaps: notes(answer.gaps), adjusted: { ...changes.record, unanchored } } };
}

/** Why a reviewer whose every finding was set aside can't be used, in Nivra's words: counts only, never the model's references. */
export function rejectedReason(setAside: number): string {
  return setAside === 1 ? "its one finding named nothing in the selection, so it couldn't be kept" : `its ${setAside} findings named nothing in the selection, so none could be kept`;
}
