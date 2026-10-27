import { createHash } from "node:crypto";
import {
  bindingDigest,
  MISSION_COUNCIL,
  MISSION_LIMITS,
  MISSION_REVIEW_LIMITS,
  MissionContent,
  MissionReviewComposition,
  MissionReviewPacket,
  missionPacketDigest,
  preferencesDigest,
  renderMissionPacket,
  specialistRef,
  taskRef,
  type BoundTask,
  type PacketTask,
  type PreferenceSnapshot,
} from "@nivra/domain";
import { packetTaskOf } from "./mission-context.ts";
import { latestMissionVersion, missionRefOf, missionTaskIds, type MissionRecord } from "./mission-store.ts";
import { refuseCredentials, type KnownSecrets } from "./protect.ts";
import { BriefContentSchema } from "./tasks.ts";
import { getTask, versionsOf } from "./workspace.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

/**
 * Mission reviews (NIV-52), as plain functions: what a review of a mission's selected tasks would send, the checks on
 * all of it before anything is stored or sent, and the fingerprint its preview is bound by. No Electron (D12).
 */

/** The most model calls a mission review makes: the council's two reviewers and its chair (D30). */
export const MISSION_REVIEW_REQUESTS = 3;

/** What a mission review never sends, in the person's words: the preview lists it. */
export const MISSION_REVIEW_NOT_SENT = [
  "The tasks you didn't select, beyond how many there are.",
  "Each task's acceptance case commands and expected outputs, baseline checks, frozen files, sources, state and history.",
  "Any repository, file or conversation.",
] as const;

const FIELD_WORDS: Readonly<Record<keyof PacketTask, string>> = {
  title: "title",
  goal: "goal",
  acceptanceCriteria: "acceptance criteria",
  scope: "scope",
  exclusions: "exclusions",
  assumptions: "assumptions",
  checks: "checks",
  context: "context",
  acceptanceCaseNames: "acceptance case names",
};

const MISSION_WORDS: Readonly<Record<keyof MissionContent, string>> = {
  name: "name",
  intendedUsers: "intended users",
  outcome: "outcome",
  successCriteria: "success criteria",
  constraints: "constraints",
  nonGoals: "non-goals",
};

const textOf = (value: string | readonly string[]) => (typeof value === "string" ? value : value.join("\n"));

/** Everything a review would send, checked as a whole: a credential anywhere refuses it, naming the part, never the value. */
export function refusePacketCredentials(packet: MissionReviewPacket, preferences: PreferenceSnapshot, known: KnownSecrets): void {
  for (const [key, words] of Object.entries(MISSION_WORDS) as Array<[keyof MissionContent, string]>) refuseCredentials(`The mission's ${words}`, textOf(packet.mission[key]), known, "preview");
  packet.tasks.forEach((task, index) => {
    for (const [key, words] of Object.entries(FIELD_WORDS) as Array<[keyof PacketTask, string]>) refuseCredentials(`${taskRef(index)}'s ${words}`, textOf(task[key]), known, "preview");
  });
  preferences.records.forEach((record, index) => refuseCredentials(`Your preference ${index + 1}`, record.statement, known, "preview"));
}

const sentChars = (task: PacketTask) => [task.title, task.goal, task.scope, task.exclusions, task.context, ...task.acceptanceCriteria, ...task.assumptions, ...task.checks, ...task.acceptanceCaseNames].reduce((sum, part) => sum + part.length, 0);

/**
 * What a review of `taskIds` from `mission`'s backlog would send (NIV-52), from the records as they are now: the
 * mission's latest version, and each task's title and latest brief, in the order selected. Refused in plain words, with
 * nothing stored or sent, when a task is missing, outside the backlog, selected twice or linked to a repository, when
 * more than five are selected, or when the whole is over the review text limit: it is never shortened.
 */
export function composeMissionReview(workspace: WorkspaceDb, mission: MissionRecord, taskIds: readonly string[], model: string | null): MissionReviewComposition {
  const latest = latestMissionVersion(workspace, mission.id);
  if (!latest) throw new Error("This mission is no longer here.");
  if (taskIds.length === 0) throw new Error("Select at least one task to review.");
  if (taskIds.length > MISSION_REVIEW_LIMITS.tasks) throw new Error(`A review takes at most ${MISSION_REVIEW_LIMITS.tasks} tasks, and ${taskIds.length} are selected. Leave some out, then preview again.`);
  if (new Set(taskIds).size !== taskIds.length) throw new Error("A task is selected twice. Select each task once, then preview again.");
  const backlog = missionTaskIds(workspace, mission.id);
  const sent = taskIds.map((taskId) => {
    const task = getTask(workspace, taskId);
    if (!task || !backlog.includes(taskId)) throw new Error("A selected task is no longer in this mission's backlog. Check the selection, then preview again.");
    if (task.projectId !== null) throw new Error(`"${task.title}" is linked to a repository, and mission reviews take only tasks that aren't, for now. Leave it out, then preview again.`);
    const brief = versionsOf(workspace, taskId).at(-1)!;
    const bound: BoundTask = { taskId, briefId: brief.id, briefVersion: brief.version, briefSha256: brief.sha256, title: task.title };
    return { bound, packet: packetTaskOf(task.title, BriefContentSchema.parse(brief.content)) };
  });
  const specialists = MISSION_COUNCIL.map(specialistRef);
  const candidate = { kind: "mission" as const, scope: { kind: "general" as const }, specialists, model, mission: latest.content, tasks: sent.map((task) => task.packet), othersInBacklog: backlog.length - sent.length };
  const parsed = MissionReviewPacket.safeParse(candidate);
  if (!parsed.success) {
    const chars = renderMissionPacket(candidate).length;
    if (chars > MISSION_REVIEW_LIMITS.textChars) {
      const sizes = candidate.tasks.map((task, index) => ({ ref: taskRef(index), chars: sentChars(task) })).sort((a, b) => b.chars - a.chars);
      const largest = sizes[0]!;
      throw new Error(
        `This review would send ${chars.toLocaleString("en")} characters, and a review can take ${MISSION_REVIEW_LIMITS.textChars.toLocaleString("en")}. Leave a task out, or shorten the longest (${largest.ref}, about ${largest.chars.toLocaleString("en")} characters), then preview again.`,
      );
    }
    throw new Error("This selection can't be sent for review as it is saved, so nothing was sent. Check each selected task's brief, then preview again.");
  }
  const packet = parsed.data;
  return MissionReviewComposition.parse({ binding: { mission: missionRefOf(latest), tasks: sent.map((task) => task.bound), findings: [], specialists }, packet, text: renderMissionPacket(packet) });
}

/** The fingerprints a mission review is bound by: its binding, its packet and its preferences. */
export async function missionDigests(composition: MissionReviewComposition, preferences: PreferenceSnapshot): Promise<{ binding: string; packet: string; preferences: string }> {
  const [binding, packet, given] = await Promise.all([bindingDigest(composition.binding), missionPacketDigest(composition.packet), preferencesDigest(preferences.records)]);
  return { binding, packet, preferences: given };
}

/**
 * What a mission review's preview is bound by (NIV-52): the binding (the mission version, each task's brief version
 * and title, the profiles), the packet and the preferences. Starting works it out again from the records as they are
 * then and refuses when it differs, so a review sends exactly what the person saw.
 */
export function missionPreviewFingerprint(digests: { binding: string; packet: string; preferences: string }): string {
  return createHash("sha256").update(JSON.stringify(["nivra.mission-review-preview.v1", digests.binding, digests.packet, digests.preferences, "council"])).digest("hex");
}

/** Why a repository-linked task can't be selected for a review in this increment (NIV-52, D42). */
export const MISSION_REPOSITORY_TASK = "Mission reviews take only tasks that aren't linked to a repository, for now, and this one is.";

const items = (list: readonly string[]) => list.map((item) => item.trim()).filter((item) => item.length > 0);

/**
 * A mission version from what the person wrote (NIV-52): each part trimmed, empty list items left out, and checked
 * against the limits, refused in plain words naming the part and the limit.
 */
export function missionContentOf(input: MissionContent): MissionContent {
  const content = {
    name: input.name.trim(),
    intendedUsers: input.intendedUsers.trim(),
    outcome: input.outcome.trim(),
    successCriteria: items(input.successCriteria),
    constraints: items(input.constraints),
    nonGoals: items(input.nonGoals),
  };
  if (!content.name) throw new Error("A mission needs a name. Write one, then save it.");
  if (!content.outcome) throw new Error("A mission needs its outcome: what is true once it's done. Write it, then save it.");
  const long = (words: string, text: string, max: number) => {
    if (text.length > max) throw new Error(`The mission's ${words} is ${text.length.toLocaleString("en")} characters long, and it can hold ${max.toLocaleString("en")}. Shorten it, then save it again.`);
  };
  long("name", content.name, MISSION_LIMITS.nameChars);
  long("intended users", content.intendedUsers, MISSION_LIMITS.intendedUsersChars);
  long("outcome", content.outcome, MISSION_LIMITS.outcomeChars);
  for (const key of ["successCriteria", "constraints", "nonGoals"] as const) {
    const words = MISSION_WORDS[key];
    if (content[key].length > MISSION_LIMITS.items) throw new Error(`The mission's ${words} can hold ${MISSION_LIMITS.items} items, and this has ${content[key].length}. Combine or remove some, then save it again.`);
    for (const item of content[key]) long(`${words} item`, item, MISSION_LIMITS.itemChars);
  }
  return MissionContent.parse(content);
}

/** Refuses a mission whose words hold a saved key or a recognised credential, naming the part, never the value. */
export function refuseMissionCredentials(content: MissionContent, known: KnownSecrets): void {
  for (const [key, words] of Object.entries(MISSION_WORDS) as Array<[keyof MissionContent, string]>) refuseCredentials(`The mission's ${words}`, textOf(content[key]), known);
}

/** Why a task couldn't join a backlog, in the person's words. */
export function addedText(added: "in-another-mission" | "backlog-full" | "gone"): string {
  switch (added) {
    case "in-another-mission":
      return "That task is in another mission's backlog. Take it out there first, then add it here.";
    case "backlog-full":
      return `A mission's backlog holds at most ${MISSION_LIMITS.tasks} tasks. Take one out, then add this one.`;
    case "gone":
      return "That task, or this mission, is no longer here.";
  }
}
