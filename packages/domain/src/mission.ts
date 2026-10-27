import { z } from "zod";
import { MISSION_COUNCIL, SpecialistRef } from "./specialists.ts";

/**
 * Missions (NIV-52): what a piece of work is for, saved in versions, with a backlog of native tasks. A mission needs no
 * repository and no tracker. The council reviews a mission and up to five of its tasks (Track B); the task readiness
 * coach can be given a task's mission and findings about it (Track C, NIV-53).
 *
 * Both tracks bind what they send the same way, so a result is never applied to context that has changed since:
 * - a task by its brief version, which is immutable, and by its title as sent, which lives outside the brief, so a
 *   rename makes no new version;
 * - its mission by version, and the task's membership of it;
 * - findings by their review and id; profiles by version.
 *
 * The host's validator (`validateBinding`) checks a binding against the records inside the transaction that would act
 * on the result, and names each change. A stale result stays readable and is never applied automatically.
 */

const nonBlank = (text: string) => text.trim().length > 0;
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const Version = z.number().int().positive();

/** What one mission version may hold: small enough that a mission and its tasks fit one review (D30's text limit). */
export const MISSION_LIMITS = {
  nameChars: 120,
  intendedUsersChars: 1_000,
  outcomeChars: 2_000,
  items: 10,
  itemChars: 300,
  /** Tasks in one mission's backlog. */
  tasks: 50,
} as const;

const Items = z.array(z.string().min(1).max(MISSION_LIMITS.itemChars).refine(nonBlank, "A list item can't be blank.")).max(MISSION_LIMITS.items);

/**
 * A mission, as one immutable version: who it is for, what is true once it's done and how that shows, what bounds it,
 * and what it deliberately leaves out. Only the name and the outcome are needed: a small project shouldn't need more.
 * Exactly as saved, with no defaults or transforms, so its sha256 covers what the person wrote.
 */
export const MissionContent = z.strictObject({
  name: z.string().min(1).max(MISSION_LIMITS.nameChars).refine(nonBlank, "A mission needs a name."),
  intendedUsers: z.string().max(MISSION_LIMITS.intendedUsersChars),
  outcome: z.string().min(1).max(MISSION_LIMITS.outcomeChars).refine(nonBlank, "A mission needs its outcome: what is true once it's done."),
  successCriteria: Items,
  constraints: Items,
  nonGoals: Items,
});
export type MissionContent = z.infer<typeof MissionContent>;

/** One mission version, by id: its mission, its own id and number, and the sha256 of its content as stored. */
export const MissionRef = z.strictObject({ missionId: z.uuid(), versionId: z.uuid(), version: Version, sha256: Sha256Hex });
export type MissionRef = z.infer<typeof MissionRef>;

/** One brief version of a task: the brief artifact's id, its number in the task's lineage and its stored sha256. */
export const TaskBriefRef = z.strictObject({ taskId: z.uuid(), briefId: z.uuid(), briefVersion: Version, briefSha256: Sha256Hex });
export type TaskBriefRef = z.infer<typeof TaskBriefRef>;

/** What a review or a coach may send for one task (NIV-52): its title and these parts of one brief version. */
export const MISSION_REVIEW_LIMITS = {
  /** Tasks one review is sent. */
  tasks: 5,
  /** The rendered packet: the review text limit plans have (D30), so a mission review fits a plan review's budget. */
  textChars: 20_000,
  titleChars: 200,
  textFieldChars: 4_000,
  contextChars: 20_000,
  items: 20,
  itemChars: 1_000,
  caseNames: 4,
  caseNameChars: 200,
} as const;

/** A task as bound: its brief version, and its title exactly as it was sent. */
export const BoundTask = z.strictObject({ ...TaskBriefRef.shape, title: z.string().min(1).max(MISSION_REVIEW_LIMITS.titleChars) });
export type BoundTask = z.infer<typeof BoundTask>;

/** One finding of a stored review, by the review's id and the id the engine gave the finding. */
export const FindingRef = z.strictObject({ reviewId: z.uuid(), findingId: z.string().regex(/^(arch|risk|single)-[1-9][0-9]?$/) });
export type FindingRef = z.infer<typeof FindingRef>;

/** The most findings one binding carries. */
export const CONTEXT_FINDINGS = 20;

const distinct = (keys: readonly string[]) => new Set(keys).size === keys.length;

/**
 * What a result was made from (NIV-52, NIV-53): the tasks it was sent, in the order sent; their mission, when one was
 * sent (each bound task was its member); the findings it was sent; and the profiles that made it.
 */
export const ContextBinding = z.strictObject({
  mission: MissionRef.nullable(),
  tasks: z
    .array(BoundTask)
    .min(1)
    .max(MISSION_REVIEW_LIMITS.tasks)
    .refine((tasks) => distinct(tasks.map((task) => task.taskId)), "Each task appears once."),
  findings: z
    .array(FindingRef)
    .max(CONTEXT_FINDINGS)
    .refine((findings) => distinct(findings.map((finding) => `${finding.reviewId} ${finding.findingId}`)), "Each finding appears once."),
  specialists: z
    .array(SpecialistRef)
    .min(1)
    .max(4)
    .refine((refs) => distinct(refs.map((ref) => ref.id)), "Each profile appears once."),
});
export type ContextBinding = z.infer<typeof ContextBinding>;

const hex = async (canonical: unknown): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * A binding's fingerprint: SHA-256, in hex, of a fixed-order, versioned JSON array of everything it binds, titles
 * included. Both tracks use it as the selection's fingerprint, and a test pins it.
 */
export function bindingDigest(binding: ContextBinding): Promise<string> {
  return hex([
    "nivra.context-binding.v1",
    binding.mission ? [binding.mission.missionId, binding.mission.versionId, binding.mission.version, binding.mission.sha256] : null,
    binding.tasks.map((task) => [task.taskId, task.briefId, task.briefVersion, task.briefSha256, task.title]),
    binding.findings.map((finding) => [finding.reviewId, finding.findingId]),
    binding.specialists.map((ref) => [ref.id, ref.version]),
  ]);
}

/**
 * What changed since a binding was made, as the host's validator reports it. Any of these makes a result stale: it
 * stays readable, and nothing made from it is applied. A preference changed since, or a newer profile version, doesn't
 * make a result stale: the window says so on its own line. A finding bound with no mission still belongs to its review's
 * mission: a task that has left that mission's backlog is reported as `membership-removed` for it.
 */
export type ContextChange =
  | { kind: "task-deleted"; taskId: string; title: string }
  | { kind: "brief-changed"; taskId: string; title: string; from: number; to: number }
  | { kind: "title-changed"; taskId: string; from: string; to: string }
  | { kind: "mission-changed"; missionId: string; from: number; to: number }
  | { kind: "mission-deleted"; missionId: string }
  | { kind: "membership-removed"; taskId: string; title: string; missionId: string }
  | { kind: "finding-gone"; reviewId: string; findingId: string; reason?: "gone" | "not-about-task" };

/** One task as a mission review sends it: its title, and these parts of its brief version, exactly as stored. */
export const PacketTask = z.strictObject({
  title: z.string().min(1).max(MISSION_REVIEW_LIMITS.titleChars),
  goal: z.string().max(MISSION_REVIEW_LIMITS.textFieldChars),
  acceptanceCriteria: z.array(z.string().min(1).max(MISSION_REVIEW_LIMITS.itemChars)).max(MISSION_REVIEW_LIMITS.items),
  scope: z.string().max(MISSION_REVIEW_LIMITS.textFieldChars),
  exclusions: z.string().max(MISSION_REVIEW_LIMITS.textFieldChars),
  assumptions: z.array(z.string().min(1).max(MISSION_REVIEW_LIMITS.itemChars)).max(MISSION_REVIEW_LIMITS.items),
  checks: z.array(z.string().min(1).max(MISSION_REVIEW_LIMITS.itemChars)).max(MISSION_REVIEW_LIMITS.items),
  context: z.string().max(MISSION_REVIEW_LIMITS.contextChars),
  /** The acceptance cases' names only: their commands and expected outputs aren't sent. */
  acceptanceCaseNames: z.array(z.string().min(1).max(MISSION_REVIEW_LIMITS.caseNameChars)).max(MISSION_REVIEW_LIMITS.caseNames),
});
export type PacketTask = z.infer<typeof PacketTask>;

const PacketShape = z.strictObject({
  kind: z.literal("mission"),
  /** A mission review reads no repository. */
  scope: z.strictObject({ kind: z.literal("general") }),
  /** The council's profiles, in the order its stages run. */
  specialists: z.array(SpecialistRef).length(MISSION_COUNCIL.length),
  /** The only model the review may use, or null for the one the listing gives (D22). The engine refuses any other before a request. */
  model: z.string().min(1).max(200).nullable(),
  mission: MissionContent,
  /** T1, T2, ... in this order. */
  tasks: z.array(PacketTask).min(1).max(MISSION_REVIEW_LIMITS.tasks),
  /** How many other tasks the mission's backlog holds: counted, never sent. */
  othersInBacklog: count,
});

/**
 * What a mission review's reviewers read (NIV-52), exactly as sent: no defaults and no transforms, so its fingerprint
 * covers what was sent. Over the text limit, it is refused, never shortened.
 */
export const MissionReviewPacket = PacketShape.refine(
  (packet) => packet.specialists.every((ref, index) => ref.id === MISSION_COUNCIL[index]),
  "A mission review is sent the council's three profiles, in the order they run.",
).refine((packet) => renderMissionPacket(packet).length <= MISSION_REVIEW_LIMITS.textChars, `A mission review can send at most ${MISSION_REVIEW_LIMITS.textChars.toLocaleString("en")} characters.`);
export type MissionReviewPacket = z.infer<typeof MissionReviewPacket>;

const NONE = "(none written)";
const line = (text: string) => (nonBlank(text) ? text : NONE);
const list = (items: readonly string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : NONE);

/** A selected task's reference in a mission review: T1 for the first. */
export const taskRef = (index: number): string => `T${index + 1}`;

/**
 * The text a mission review's reviewers read about the mission and its tasks: the one rendering both the host's
 * preview and the engine's message use, so the preview shows exactly what is sent. Empty parts say so.
 */
export function renderMissionPacket(packet: z.infer<typeof PacketShape>): string {
  const { mission, tasks, othersInBacklog } = packet;
  const parts = [
    [
      "The mission (mission):",
      `Name: ${mission.name}`,
      `Intended users: ${line(mission.intendedUsers)}`,
      `Outcome: ${mission.outcome}`,
      `Success criteria:\n${list(mission.successCriteria)}`,
      `Constraints:\n${list(mission.constraints)}`,
      `Non-goals:\n${list(mission.nonGoals)}`,
    ].join("\n"),
    `The selected tasks: ${tasks.length === 1 ? "T1" : `T1 to ${taskRef(tasks.length - 1)}`}. ${
      othersInBacklog === 0 ? "The backlog holds no other tasks." : `The backlog holds ${othersInBacklog} other ${othersInBacklog === 1 ? "task, which wasn't" : "tasks, which weren't"} sent.`
    }`,
    ...tasks.map((task, index) =>
      [
        `${taskRef(index)}. ${task.title}`,
        `Goal: ${line(task.goal)}`,
        `Acceptance criteria:\n${list(task.acceptanceCriteria)}`,
        `Scope: ${line(task.scope)}`,
        `Exclusions: ${line(task.exclusions)}`,
        `Assumptions:\n${list(task.assumptions)}`,
        `Checks:\n${list(task.checks)}`,
        `Acceptance cases, by name: ${task.acceptanceCaseNames.length ? task.acceptanceCaseNames.join("; ") : NONE}`,
        `Context: ${line(task.context)}`,
      ].join("\n"),
    ),
  ];
  return parts.join("\n\n");
}

/**
 * A mission packet's fingerprint: SHA-256, in hex, of a fixed-order, versioned JSON array of its content. The host and
 * the engine each work it out, so a report shows it reviewed exactly what was sent while nothing stores the text twice.
 */
export function missionPacketDigest(packet: MissionReviewPacket): Promise<string> {
  const { mission } = packet;
  return hex([
    "nivra.mission-review-packet.v1",
    packet.scope.kind,
    packet.specialists.map((ref) => [ref.id, ref.version]),
    packet.model,
    [mission.name, mission.intendedUsers, mission.outcome, mission.successCriteria, mission.constraints, mission.nonGoals],
    packet.tasks.map((task) => [task.title, task.goal, task.acceptanceCriteria, task.scope, task.exclusions, task.assumptions, task.checks, task.context, task.acceptanceCaseNames]),
    packet.othersInBacklog,
  ]);
}

/**
 * What a mission review keeps as its review plan (NIV-52): what it is bound to, what it sent, and the text the reviewers
 * read, as rendered then. Readable after its tasks change or go, so an old report still says what it reviewed.
 */
export const MissionReviewComposition = z
  .strictObject({
    binding: ContextBinding,
    packet: MissionReviewPacket,
    text: z.string().min(1).max(MISSION_REVIEW_LIMITS.textChars),
  })
  .refine((composition) => composition.binding.mission !== null, "A mission review is bound to a mission version.")
  .refine(
    (composition) =>
      composition.binding.tasks.length === composition.packet.tasks.length && composition.binding.tasks.every((task, index) => task.title === composition.packet.tasks[index]!.title),
    "A mission review's binding names the tasks it sent, in the order sent, with their titles as sent.",
  )
  .refine((composition) => JSON.stringify(composition.binding.specialists) === JSON.stringify(composition.packet.specialists), "A mission review's binding names the profiles its packet was sent to.");
export type MissionReviewComposition = z.infer<typeof MissionReviewComposition>;

/**
 * A stored composition as it is read back (NIV-52): the shape it was kept in, without the checks made when it was
 * composed (the rendered length, the profiles' order, the binding's agreement with the packet). Those held then; a
 * later version that renders or checks differently must still read an old report.
 */
export const StoredMissionReviewComposition = z.object({ binding: ContextBinding, packet: PacketShape, text: z.string() });
