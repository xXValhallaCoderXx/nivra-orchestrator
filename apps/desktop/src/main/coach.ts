import { createHash } from "node:crypto";
import {
  bindingDigest,
  COACH_PROFILE,
  COACH_RUN_LIMITS,
  CoachField,
  CoachPacket,
  coachEstimatedInputTokens,
  coachPacketDigest,
  preferencesDigest,
  renderCoachPacket,
  type CoachContext,
  type CoachInput,
  type CoachReport,
  type ContextBinding,
  type ContextChange,
  type FindingRef,
  type MissionContent,
  type MissionRef,
  type PreferenceSnapshot,
} from "@nivra/domain";
import { applyCoachChange, COACH_FIELD_LABELS, fieldValue, type CoachBriefFields, type CoachChangeView, type CoachPreview, type CoachSelection } from "../shared/coach.ts";
import { TASK_LIMITS, type BriefContent, type BriefFields } from "../shared/ipc.ts";
import { taskGuidance } from "../shared/task-guidance.ts";
import { changeText, packetTaskOf, type TaskFinding } from "./mission-context.ts";
import { refuseCredentials, type KnownSecrets } from "./protect.ts";
import { TOKEN_FACTORY_KEEPS } from "./tasks.ts";

/**
 * The task readiness coach in the host (NIV-53), as plain functions: the packet a task's brief sends, the fingerprint a
 * preview is bound by, the check that a report is the one a coaching asked for, the changes the window shows, and the
 * brief fields the person's ticked changes make. No Electron (D12). Nothing here saves anything: the host's own
 * validation and transaction do, in the order the plan gives.
 */

/** A task's mission, as the person ticked it in the preview: its name, its version and its labelled parts. */
export interface CoachMissionInput {
  name: string;
  version: number;
  parts: Array<{ label: string; text: string }>;
}

/** A finding about the task, as the person ticked it: its words, and the brief version its review read. */
export interface CoachFindingInput {
  title: string;
  detail: string;
  recommendation: string;
  reviewedBriefVersion: number | null;
}

/**
 * A task's mission as the coach is sent it, from its version as Track B keeps it: the name, and who it is for, its
 * outcome, how success shows, what bounds it and what it leaves out, as labelled parts. Lists read as one line each.
 */
export function coachMissionOf(ref: Pick<MissionRef, "version">, content: MissionContent): CoachMissionInput {
  const list = (items: readonly string[]) => items.join("; ");
  return {
    name: content.name,
    version: ref.version,
    parts: [
      { label: "Intended users", text: content.intendedUsers },
      { label: "Outcome", text: content.outcome },
      { label: "Success criteria", text: list(content.successCriteria) },
      { label: "Constraints", text: list(content.constraints) },
      { label: "Non-goals", text: list(content.nonGoals) },
    ],
  };
}

/** A finding about the task from one of its mission's reviews (Track B's), as the coach is sent it. */
export function coachFindingOf(found: Pick<TaskFinding, "finding" | "reviewed">): CoachFindingInput {
  return { title: found.finding.title, detail: found.finding.detail, recommendation: found.finding.recommendation, reviewedBriefVersion: found.reviewed.briefVersion };
}

/** What one packet is made from: the task's title, a brief version, its scope, and what the person ticked. */
export interface CoachPacketInput {
  title: string;
  brief: { version: number; content: BriefContent };
  scope: "general" | "project";
  mission: CoachMissionInput | null;
  findings: CoachFindingInput[];
}

const PARTS: Readonly<Record<string, string>> = {
  title: "title",
  goal: "goal",
  acceptanceCriteria: "acceptance criteria",
  scope: "scope",
  exclusions: "exclusions",
  context: "context",
  assumptions: "assumptions",
  checks: "checks",
  caseNames: "acceptance cases' names",
  gaps: "gaps Nivra found",
  mission: "mission",
  findings: "findings",
};

/**
 * The packet a coaching of this brief version sends (NIV-53): the title; the brief's goal, criteria, scope, exclusions,
 * context, assumptions and checks; its acceptance cases' names, never their commands or output; how many baseline
 * checks and frozen files it has; the gaps Nivra's own rules find (the ones shown); and the mission and findings the
 * person ticked. Everything in it is checked for credentials, as everything outgoing is, and a hit is refused in words
 * that name the part, never the value. A part over the coach's limits is refused in words that say which.
 */
export function coachPacketFor(input: CoachPacketInput, known: KnownSecrets): CoachPacket {
  const { content } = input.brief;
  refuseCredentials("The title", input.title, known, "send");
  refuseCredentials("The goal", content.goal, known, "send");
  content.acceptanceCriteria.forEach((criterion, index) => refuseCredentials(`Acceptance criterion ${index + 1}`, criterion, known, "send"));
  refuseCredentials("The scope", content.scope, known, "send");
  refuseCredentials("The exclusions", content.exclusions, known, "send");
  refuseCredentials("The context", content.context, known, "send");
  content.assumptions.forEach((assumption, index) => refuseCredentials(`Assumption ${index + 1}`, assumption, known, "send"));
  content.checks.forEach((check, index) => refuseCredentials(`Check ${index + 1}`, check, known, "send"));
  content.acceptanceCases.forEach((given, index) => refuseCredentials(`Acceptance case ${index + 1}'s name`, given.name, known, "send"));
  if (input.mission) {
    refuseCredentials("The mission's name", input.mission.name, known, "send");
    for (const part of input.mission.parts) refuseCredentials(`The mission's ${part.label.toLowerCase()}`, part.text, known, "send");
  }
  input.findings.forEach((finding, index) => {
    refuseCredentials(`Finding ${index + 1}'s title`, finding.title, known, "send");
    refuseCredentials(`Finding ${index + 1}'s detail`, finding.detail, known, "send");
    refuseCredentials(`Finding ${index + 1}'s recommendation`, finding.recommendation, known, "send");
  });
  const guidance = taskGuidance(content);
  // The task's parts exactly as a mission review sends them (Track B's packetTaskOf), so both specialists read one task alike.
  const sent = packetTaskOf(input.title, content);
  const parsed = CoachPacket.safeParse({
    scope: { kind: input.scope },
    task: {
      title: sent.title,
      briefVersion: input.brief.version,
      goal: sent.goal,
      acceptanceCriteria: sent.acceptanceCriteria,
      scope: sent.scope,
      exclusions: sent.exclusions,
      context: sent.context,
      assumptions: sent.assumptions,
      checks: sent.checks,
      caseNames: sent.acceptanceCaseNames,
      baselineChecks: content.baseline.length,
      frozenFiles: content.frozen.length,
    },
    gaps: guidance.items.map(({ code, tier, field, item, missing }) => ({ code, tier, field, item, missing })),
    mission: input.mission,
    findings: input.findings,
  });
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    const key = String(path[0] === "task" ? path[1] : path[0]);
    if (key === "mission") throw new Error("The mission can't be sent to the coach as it is, so nothing was sent. Shorten it, or untick it, then ask the coach again.");
    if (key === "findings") throw new Error("The findings you ticked can't be sent to the coach as they are, so nothing was sent. Untick some, then ask the coach again.");
    throw new Error(`This task's ${PARTS[key] ?? "contents"} can't be sent to the coach as saved, so nothing was sent. Shorten it, then ask the coach again.`);
  }
  return parsed.data;
}

/**
 * What a preview is bound by: the context binding's fingerprint (the task, its brief version and title, the mission and
 * findings ticked, and the coach's profile), the packet's and the preferences' fingerprints, the project's sharing, the
 * profile, and the model a live recipe allows. Starting works it out again from the records as they are then, and
 * refuses when it differs, so a coaching sends exactly what the person saw.
 */
export function coachPreviewFingerprint(parts: {
  bindingDigest: string;
  packetDigest: string;
  preferencesDigest: string;
  sharing: boolean | null;
  profileId: string;
  profileVersion: number;
  model: string | null;
}): string {
  const canonical = ["nivra.coach-preview.v1", parts.bindingDigest, parts.packetDigest, parts.preferencesDigest, parts.sharing, parts.profileId, parts.profileVersion, parts.model];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The task's repository, as the host finds it now: none, removed (or being removed), or a project and its consent. */
export type CoachProject = { kind: "none" } | { kind: "removed" } | { kind: "project"; label: string; targetLabel: string; modelSharing: boolean };

/** A task to coach: its id, title, the brief version the person sees, and its repository. */
export interface CoachSubject {
  taskId: string;
  title: string;
  brief: { id: string; version: number; sha256: string; content: BriefContent };
  project: CoachProject;
}

/**
 * What a coaching is bound to (Track B's context binding): this task at the brief version and title it sends, the
 * mission version and findings the person ticked, and the coach's profile. A rename makes no brief version, so the
 * title is bound as sent.
 */
export function coachBindingFor(subject: Pick<CoachSubject, "taskId" | "title" | "brief">, mission: MissionRef | null, findings: readonly FindingRef[], profile: { version: number }): ContextBinding {
  return {
    mission,
    tasks: [{ taskId: subject.taskId, briefId: subject.brief.id, briefVersion: subject.brief.version, briefSha256: subject.brief.sha256, title: subject.title }],
    findings: [...findings],
    specialists: [{ id: COACH_PROFILE.id, version: profile.version }],
  };
}

/**
 * What the host knows besides the task: the secrets, the preferences that apply, the context binding, why the task
 * can't be coached now, what the person may tick and what they ticked, the profile, and a live recipe's one allowed
 * model.
 */
export interface CoachState {
  known: KnownSecrets;
  preferences: PreferenceSnapshot;
  /** What the coaching is bound to (`coachBindingFor`), whose fingerprint binds the preview and the run. */
  binding: ContextBinding;
  /** Why the task can't be coached now (a coaching still open, the task completed), in plain words; null when it can. */
  busy: string | null;
  options: CoachPreview["options"];
  selection: CoachSelection;
  mission: CoachMissionInput | null;
  findings: CoachFindingInput[];
  profile: { id: string; version: number; name: string };
  model?: string;
}

/** What a coaching sends to Token Factory, what it doesn't, in plain words. */
export const COACH_SENDS = [
  "The brief as saved: its title, goal, acceptance criteria, scope, exclusions, context, assumptions and checks, and the names of its acceptance cases.",
  "The gaps Nivra's own checks found in it, without a model.",
  "The mission and the findings you tick, only when you tick them.",
  "Your confirmed preferences that apply: your personal ones, and this project's for a task linked to one.",
  "Nivra's instructions to the coach, and the form it answers in.",
] as const;
export const COACH_NOT_SENT = [
  "The acceptance cases' commands and expected output, the baseline checks and the frozen files: only how many there are.",
  "The repository, its files and the task's runs: the coach reads no repository.",
  "The brief's sources, its execution policy and the task's state.",
  "Your keys.",
] as const;

const PART_WORDS = {
  goal: "the goal",
  acceptanceCriteria: "the acceptance criteria",
  scope: "the scope",
  exclusions: "the exclusions",
  context: "the context",
  assumptions: "the assumptions",
  checks: "the checks",
  mission: "the mission",
  findings: "the findings",
  preferences: "your preferences",
} as const;

/** The longest part of what a coaching sends, in the person's words: the one to shorten when it is too long. */
function longestPart(packet: CoachPacket, preferences: PreferenceSnapshot): string {
  const { task } = packet;
  const sum = (items: readonly string[]) => items.reduce((total, item) => total + item.length, 0);
  const sizes: Array<[keyof typeof PART_WORDS, number]> = [
    ["goal", task.goal.length],
    ["acceptanceCriteria", sum(task.acceptanceCriteria)],
    ["scope", task.scope.length],
    ["exclusions", task.exclusions.length],
    ["context", task.context.length],
    ["assumptions", sum(task.assumptions)],
    ["checks", sum(task.checks)],
    ["mission", packet.mission ? sum(packet.mission.parts.map((part) => part.text)) : 0],
    ["findings", sum(packet.findings.map((finding) => `${finding.title}${finding.detail}${finding.recommendation}`))],
    ["preferences", sum(preferences.records.map((record) => record.statement))],
  ];
  const [largest] = [...sizes].sort((a, b) => b[1] - a[1]);
  return PART_WORDS[largest![0]];
}

/**
 * Why a packet can't go in one request, naming its longest part to shorten; null when its estimate is within the
 * budget. A saved brief at every limit, with a mission, three findings and fifty preferences, is within it: this is a
 * backstop, and the estimate is an estimate (D30), never a count.
 */
export function sizeBlocked(packet: CoachPacket, preferences: PreferenceSnapshot, estimate: number, budget: number): string | null {
  if (estimate <= budget) return null;
  return `What the coach would read is too long for one request: an estimated ${estimate.toLocaleString("en")} tokens, and it takes ${budget.toLocaleString("en")}. Shorten ${longestPart(packet, preferences)}, the longest part, then ask the coach again.`;
}

/**
 * Everything a coaching of `subject` would be: the preview, the run's input (ids, versions and fingerprints only), and
 * its context (held in the engine's memory, never stored). A task whose project is gone is refused, never treated as
 * general, and a general task is sent personal preferences only. The preview's estimate counts the packet as rendered,
 * so a packet too long for one request is blocked before anything is sent, naming the longest part.
 */
export async function coachRequest(subject: CoachSubject, state: CoachState): Promise<{ preview: CoachPreview; input: CoachInput; context: CoachContext; packet: CoachPacket }> {
  const { project, brief } = subject;
  if (state.profile.id !== COACH_PROFILE.id || state.profile.version !== COACH_PROFILE.version) throw new Error("That isn't this version of the task readiness coach, so nothing was sent.");
  // The binding names exactly this task as it is sent, the mission and findings sent with it, and the coach.
  const [bound] = state.binding.tasks;
  if (
    state.binding.tasks.length !== 1 ||
    bound?.taskId !== subject.taskId ||
    bound.briefId !== brief.id ||
    bound.briefVersion !== brief.version ||
    bound.briefSha256 !== brief.sha256 ||
    bound.title !== subject.title ||
    JSON.stringify(state.binding.specialists) !== JSON.stringify([{ id: COACH_PROFILE.id, version: COACH_PROFILE.version }]) ||
    (state.binding.mission === null) !== (state.mission === null) ||
    (state.mission !== null && state.binding.mission?.version !== state.mission.version) ||
    state.binding.findings.length !== state.findings.length
  ) {
    throw new Error("What this coaching would be bound to isn't this task as it is now, so nothing was sent. Open the task again, then ask the coach again.");
  }
  if (project.kind === "removed") throw new Error("This task's repository was removed, so the coach can't read the task as it is. Choose another repository for it, or none, then ask the coach again.");
  if (project.kind === "none" && state.preferences.records.some((record) => record.scope === "project")) {
    throw new Error("A task with no repository is sent your personal preferences only, so nothing was sent. Open the task again, then ask the coach again.");
  }
  for (const record of state.preferences.records) refuseCredentials("A preference", record.statement, state.known, "send");
  const packet = coachPacketFor(
    { title: subject.title, brief: { version: subject.brief.version, content: subject.brief.content }, scope: project.kind === "project" ? "project" : "general", mission: state.mission, findings: state.findings },
    state.known,
  );
  const text = renderCoachPacket(packet);
  const [boundDigest, packetDigest, prefsDigest] = await Promise.all([bindingDigest(state.binding), coachPacketDigest(packet), preferencesDigest(state.preferences.records)]);
  const estimate = coachEstimatedInputTokens(text.length, state.preferences.records.map((record) => record.statement));
  const budget = COACH_RUN_LIMITS.estimatedInputTokens;
  const sharing = project.kind === "project" ? project.modelSharing : null;
  const blocked =
    state.busy ??
    (project.kind === "project" && !project.modelSharing ? "This task's project doesn't allow sending its content to Token Factory. Allow sharing for it, then ask the coach." : null) ??
    sizeBlocked(packet, state.preferences, estimate, budget);
  const profile = { id: state.profile.id, version: state.profile.version };
  const preview: CoachPreview = {
    taskId: subject.taskId,
    briefVersion: subject.brief.version,
    scope: project.kind === "project" ? { kind: "project", projectLabel: project.label, targetLabel: project.targetLabel, sharing: project.modelSharing } : { kind: "general" },
    text,
    options: state.options,
    selection: state.selection,
    preferences: state.preferences.records.map(({ statement, scope, intent }) => ({ statement, scope, intent })),
    profile: state.profile,
    limits: {
      requests: COACH_RUN_LIMITS.requests,
      totalSeconds: COACH_RUN_LIMITS.totalMs / 1000,
      requestSeconds: COACH_RUN_LIMITS.requestMs / 1000,
      outputTokens: COACH_RUN_LIMITS.outputTokensPerRequest,
      estimatedInputTokens: estimate,
      budgetTokens: budget,
    },
    sends: [...COACH_SENDS],
    notSent: [...COACH_NOT_SENT],
    keeps: TOKEN_FACTORY_KEEPS,
    blocked,
    expected: coachPreviewFingerprint({ bindingDigest: boundDigest, packetDigest, preferencesDigest: prefsDigest, sharing, profileId: profile.id, profileVersion: profile.version, model: state.model ?? null }),
  };
  const input: CoachInput = {
    taskId: subject.taskId,
    briefId: subject.brief.id,
    briefVersion: subject.brief.version,
    bindingDigest: boundDigest,
    packetDigest,
    preferencesDigest: prefsDigest,
    profile: { id: COACH_PROFILE.id, version: profile.version },
    ...(state.model ? { model: state.model } : {}),
  };
  return { preview, input, context: { preferences: state.preferences, sharing: { modelContext: sharing === true }, packet }, packet };
}

/** What a coaching was bound to, as the workspace keeps it, for `coachReportMatches`. */
export interface CoachBinding {
  taskId: string;
  briefVersion: number;
  bindingDigest: string;
  packetDigest: string;
  preferencesDigest: string;
  profile: { id: string; version: number };
}

/** Whether a report is the one this coaching asked for: its task and brief version, every fingerprint, the profile, the request and the run. */
export function coachReportMatches(report: CoachReport, coaching: CoachBinding, runId: string, requestId: string): boolean {
  return (
    report.taskId === coaching.taskId &&
    report.briefVersion === coaching.briefVersion &&
    report.bindingDigest === coaching.bindingDigest &&
    report.packetDigest === coaching.packetDigest &&
    report.preferencesDigest === coaching.preferencesDigest &&
    report.profile.id === coaching.profile.id &&
    report.profile.version === coaching.profile.version &&
    report.request.clientRequestId === requestId &&
    report.request.runId === runId
  );
}

/** Why a change whose words were masked can't be ticked. */
const MASKED = "Some of its words looked like a credential and were masked, so it can't be saved. Write the change yourself if you need it.";
/** Why a change that names an item the brief doesn't have can't be ticked. */
const OUT_OF_RANGE = "It rewords an item this brief doesn't have, so it can't be saved.";

/**
 * Each proposed change as the window shows it: its field before and after it, worked out from the brief version the
 * coach read, and why it can't be ticked, when it can't. Its own reason (masked words, an item the brief doesn't have)
 * comes first; otherwise the coaching's (stale, or saved already), or none.
 */
export function coachChangeViews(base: CoachBriefFields, report: CoachReport, blocked: string | null): CoachChangeView[] {
  return report.changes.map((change) => {
    const before = fieldValue(base, change.field);
    let after = before;
    let own: string | null = change.usable ? null : MASKED;
    try {
      after = fieldValue(applyCoachChange(base, change), change.field);
    } catch {
      own ??= OUT_OF_RANGE;
    }
    return { field: change.field, change, before, after, blocked: own ?? blocked };
  });
}

/**
 * The brief fields the ticked changes make, all or nothing: every field the person writes, from the brief version the
 * coach read, with each ticked change made to its own field, in a fixed order. A field ticked twice, a change the report
 * doesn't hold, a change whose words were masked, or a result past a brief's limits is refused in words that say which,
 * and nothing is returned. The host's own validation then checks the fields as it checks any edit.
 */
export function applySelected(base: BriefContent, report: CoachReport, fields: readonly CoachField[]): BriefFields {
  if (fields.length === 0) throw new Error("Tick at least one change, then save.");
  if (new Set(fields).size !== fields.length) throw new Error("Each change can be ticked once. Tick each one once, then save.");
  let next: CoachBriefFields = { goal: base.goal, acceptanceCriteria: base.acceptanceCriteria, scope: base.scope, exclusions: base.exclusions, context: base.context, assumptions: base.assumptions };
  for (const field of CoachField.options.filter((option) => fields.includes(option))) {
    const label = COACH_FIELD_LABELS[field].toLowerCase();
    const change = report.changes.find((candidate) => candidate.field === field);
    if (!change) throw new Error(`The coach proposed no change to the ${label}, so nothing was saved.`);
    if (!change.usable) throw new Error(`The coach's change to the ${label} had words masked as a possible credential, so nothing was saved. Untick it, then save, or write it yourself.`);
    next = applyCoachChange(next, change);
  }
  for (const [field, list] of [["acceptance criteria", next.acceptanceCriteria], ["assumptions", next.assumptions]] as const) {
    if (list.length > TASK_LIMITS.items) throw new Error(`With these changes the brief would have ${list.length} ${field}, and it can hold ${TASK_LIMITS.items}, so nothing was saved. Untick the change, or remove some ${field} from the brief first.`);
  }
  if (next.context.length > TASK_LIMITS.contextChars) {
    throw new Error(`With these changes the context would be ${next.context.length.toLocaleString("en")} characters long, and it can hold ${TASK_LIMITS.contextChars.toLocaleString("en")}, so nothing was saved. Untick the change, or shorten the context first.`);
  }
  return {
    goal: next.goal,
    acceptanceCriteria: next.acceptanceCriteria,
    scope: next.scope,
    exclusions: next.exclusions,
    context: next.context,
    assumptions: next.assumptions,
    checks: base.checks,
    acceptanceCases: base.acceptanceCases,
    baseline: base.baseline,
    frozen: base.frozen,
  };
}

/** What the coach's own checks find before a save, beside Track B's validator. */
export type CoachOwnChange = "project-changed" | "profile-changed" | "applied" | "not-complete";

/**
 * Why a coaching's changes can't be saved now, in the person's words, one line each. What Track B's validator reports
 * is said in its own words (`changeText`), led by one line the coach adds: for a brief that changed, which version the
 * coach read and which is the latest. Then the coach's own: its repository, its profile, a save already made, an answer
 * that wasn't usable. Empty when nothing stops a save.
 */
export function staleLines(changes: readonly ContextChange[], own: readonly CoachOwnChange[]): string[] {
  const lines: string[] = [];
  if (changes.length > 0) {
    const brief = changes.find((change) => change.kind === "brief-changed");
    lines.push(
      brief && brief.from !== brief.to
        ? `Your brief changed since the coach read it: it read v${brief.from}, and the brief is now at v${brief.to}. Nothing was changed. Ask the coach again for suggestions on this version.`
        : "What the coach read has changed since, so nothing was changed. Ask the coach again for suggestions on the task as it is now.",
    );
    for (const change of changes) lines.push(changeText(change));
  }
  for (const kind of own) {
    switch (kind) {
      case "project-changed":
        lines.push("The task's repository changed since the coach read it. Nothing was changed. Ask the coach again for the task as it is now.");
        break;
      case "profile-changed":
        lines.push("This answer came from an earlier version of the coach. Nothing was changed. Ask the coach again for an answer from this one.");
        break;
      case "applied":
        lines.push("Changes from this answer were saved already. Ask the coach again for more suggestions.");
        break;
      case "not-complete":
        lines.push("This coaching didn't end with a usable answer, so there is nothing to save. Ask the coach again if you want another answer.");
        break;
    }
  }
  return [...new Set(lines)];
}
