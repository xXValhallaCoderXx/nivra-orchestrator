import type { CoachChange, CoachField, CoachQuestionField, CoachReport, PreferenceIntent, PreferenceScope } from "@nivra/domain";
import type { BriefContent, TurnStatus } from "./ipc.ts";

/**
 * The task readiness coach (NIV-53), as the window sees it: what the person ticks, the preview "Ask the coach" is
 * bound by, a coaching and its report, and how one proposed change turns a field's value into another. Main builds the
 * views; the window shows them. Pure, so both sides use it and tests read it without a window. The report's types are
 * the domain contract's own, imported as types only, as the window's must be.
 */

/** The six fields the coach may propose changes to, as the person reads their names. */
/**
 * The most findings that go with one coaching: the domain's COACH_PACKET_LIMITS.findings, copied because the window
 * can't load the domain at run time (its checks trip the CSP). A test keeps the two equal.
 */
export const COACH_FINDINGS_LIMIT = 3;

export const COACH_FIELD_LABELS: Readonly<Record<CoachQuestionField, string>> = {
  goal: "Goal",
  acceptanceCriteria: "Acceptance criteria",
  scope: "Scope",
  exclusions: "Exclusions",
  context: "Context",
  assumptions: "Assumptions",
  checks: "Checks",
  acceptanceCases: "Acceptance cases",
};

/** What the person ticked in a preview: the task's mission and findings about it, by id. Nothing is ticked by default. */
export interface CoachSelection {
  mission: boolean;
  findings: Array<{ reviewId: string; findingId: string }>;
}

/** What a coaching of one task would send (NIV-53), worked out from the records as they are now. Nothing is sent. */
export interface CoachPreview {
  taskId: string;
  briefVersion: number;
  /** A task with no repository, or one linked to a project, with its engine and whether it allows sharing with the model. */
  scope: { kind: "general" } | { kind: "project"; projectLabel: string; targetLabel: string; sharing: boolean };
  /** Exactly what the coach reads: the packet as one text. */
  text: string;
  /** The task's mission and the findings about it that the person may tick; none when the task has none. */
  options: {
    mission: { name: string; version: number } | null;
    findings: Array<{ reviewId: string; findingId: string; title: string; reviewedBriefVersion: number | null }>;
  };
  selection: CoachSelection;
  /** The confirmed preferences it sends, in full: personal ones, and the project's for a task linked to one. */
  preferences: Array<{ statement: string; scope: PreferenceScope; intent: PreferenceIntent }>;
  profile: { id: string; version: number; name: string };
  /** Its bounds: one listing of the models and one model request, the time limits, the output cap, and the input estimate. */
  limits: { requests: number; totalSeconds: number; requestSeconds: number; outputTokens: number; estimatedInputTokens: number; budgetTokens: number };
  /** What goes to Token Factory, what doesn't, and what Token Factory keeps, in plain words. */
  sends: string[];
  notSent: string[];
  keeps: string;
  /** Why it can't start now, in plain words; null when it can. */
  blocked: string | null;
  /** The fingerprint of what it would send: starting is refused when that changed since this preview. */
  expected: string;
}

/** One proposed field change as the window shows it: the field's value before and after it, and whether it may be ticked. */
export interface CoachChangeView {
  field: CoachField;
  change: CoachChange;
  before: string | string[];
  after: string | string[];
  /** Why it can't be ticked now (its words were masked, or the coaching is stale or saved already); null when it can. */
  blocked: string | null;
}

/**
 * A coaching of a task (NIV-53): what it was bound to, how its run went, the report its engine saved, and what became
 * of it. `not-sent` and `unknown` mean what they mean for a turn. Nothing is ever resent: asking again makes a new one.
 */
export interface CoachingView {
  id: string;
  taskId: string;
  /** The brief version the coach read, and the latest one now. */
  briefVersion: number;
  latestVersion: number;
  status: TurnStatus;
  /** What happened, in Nivra's words, when it ended without a complete report; null while it goes, and once complete. */
  note: string | null;
  /** Why its engine can't be reached to check it, while that lasts. */
  unresolved: string | null;
  runId: string | null;
  cancelRequested: boolean;
  profile: { id: string; version: number };
  /** What it was sent besides the brief, as it was. */
  sent: { mission: { name: string; version: number } | null; findings: number; preferences: number };
  report: CoachReport | null;
  changes: CoachChangeView[];
  /** Why its changes can't be saved now, one line each; empty when they can. */
  stale: string[];
  /** What changed since that doesn't stop a save, such as the preferences. */
  notes: string[];
  /** The brief version its saved changes made, and which fields; null until then. */
  applied: { briefVersion: number; fields: CoachField[]; at: string } | null;
  createdAt: string;
  settledAt: string | null;
}

/** The six fields a coach's change can touch, as a brief holds them. */
export type CoachBriefFields = Pick<BriefContent, CoachField>;

/** A field's value in a brief: text for the goal, scope, exclusions and context; a list for the criteria and assumptions. */
export function fieldValue(brief: CoachBriefFields, field: CoachField): string | string[] {
  return field === "acceptanceCriteria" || field === "assumptions" ? [...brief[field]] : brief[field];
}

/**
 * The field's value once a proposed change is made to it: a new goal, scope or exclusions; words added to the end of
 * the context, after a blank line; or, in the criteria or the assumptions, items reworded by their number and then new
 * items added at the end. Nothing is deleted. A reword of an item the brief doesn't have is refused: a change is only
 * ever made to the version it was proposed for.
 */
export function applyCoachChange(brief: CoachBriefFields, change: CoachChange): CoachBriefFields {
  switch (change.field) {
    case "goal":
    case "scope":
    case "exclusions":
      return { ...brief, [change.field]: change.text };
    case "context": {
      const before = brief.context.replace(/\s+$/, "");
      return { ...brief, context: before ? `${before}\n\n${change.append}` : change.append };
    }
    case "acceptanceCriteria":
    case "assumptions": {
      const items = [...brief[change.field]];
      for (const { item, text } of change.reword) {
        if (item < 1 || item > items.length) throw new Error(`The coach's change rewords item ${item}, and this brief has ${items.length}.`);
        items[item - 1] = text;
      }
      return { ...brief, [change.field]: [...items, ...change.add] };
    }
  }
}
