import { StoredMissionReviewComposition, taskRef, type MissionReviewComposition, type BoundTask, type ContextBinding, type ContextChange, type FindingRef, type MissionContent, type MissionRef, type PacketTask, type ReviewFinding } from "@nivra/domain";
import type { BriefContent } from "../shared/ipc.ts";
import { getMission, latestMissionVersion, missionOfTask, missionRefOf } from "./mission-store.ts";
import { getArtifact, getReview, getTask, reviewsOf, versionsOf, type ArtifactRecord } from "./workspace.ts";
import type { WorkspaceDb } from "./workspace-db.ts";

/**
 * The context check both planning tracks share (NIV-52, NIV-53): whether what a result was made from is still what the
 * records hold. A mission review uses it for its stale lines and before it starts; the task readiness coach runs it
 * inside the transaction that would save an accepted suggestion, beside the brief's own version check, so nothing made
 * from context that has changed since is applied. Ordinary editing never depends on it. Plain functions, no Electron
 * (D12); synchronous, so they run inside `workspace.tx`.
 */

/** What a mission's review plan holds (NIV-52): written by Nivra from a mission and its selected tasks, never from an answer. */
export interface MissionPlanContent {
  kind: "mission";
  /** The text the reviewers read, as rendered when the review started. */
  text: string;
  conversationId: string;
  mission: MissionReviewComposition;
}

/**
 * One task as a mission review sends it (NIV-52): its title, and the parts of its brief version the reviewers read.
 * Acceptance cases go by name only; their commands and expected outputs, baseline checks, frozen files, sources and the
 * execution policy stay with the task.
 */
export function packetTaskOf(title: string, brief: Pick<BriefContent, "goal" | "acceptanceCriteria" | "scope" | "exclusions" | "assumptions" | "checks" | "context" | "acceptanceCases">): PacketTask {
  return {
    title,
    goal: brief.goal,
    acceptanceCriteria: brief.acceptanceCriteria,
    scope: brief.scope,
    exclusions: brief.exclusions,
    assumptions: brief.assumptions,
    checks: brief.checks,
    context: brief.context,
    acceptanceCaseNames: brief.acceptanceCases.map((acceptanceCase) => acceptanceCase.name),
  };
}

/** A mission review plan's content: the composition, the text the reviewers read, and the mission's conversation. */
export const missionPlanContent = (composition: MissionReviewComposition, conversationId: string): MissionPlanContent => ({ kind: "mission", text: composition.text, conversationId, mission: composition });

/**
 * A plan version's mission composition, or null for a plan made from an answer (or one that doesn't read as a
 * composition). Read back as it was stored, without the checks made when it was composed, so an old report stays
 * readable after a later version renders or checks differently.
 */
export function compositionOf(plan: ArtifactRecord): MissionReviewComposition | null {
  const content = plan.content as Partial<MissionPlanContent> | null;
  if (plan.kind !== "plan" || content?.kind !== "mission") return null;
  const parsed = StoredMissionReviewComposition.safeParse(content.mission);
  return parsed.success ? parsed.data : null;
}

/**
 * What changed since `binding` was made, in the order checked; empty when nothing has. Any change makes a result
 * stale: it stays readable, and nothing made from it is applied.
 * - The mission: deleted, or at a later version.
 * - Each task: deleted; its brief at another version; its title changed (a rename makes no brief version); or, when a
 *   mission is bound and still there, no longer in that mission's backlog.
 * - Each finding: its review, or the finding in its report, gone.
 */
export function validateBinding(workspace: WorkspaceDb, binding: ContextBinding): ContextChange[] {
  const changes: ContextChange[] = [];
  const mission = binding.mission;
  let missionHere = false;
  if (mission) {
    const latest = getMission(workspace, mission.missionId) ? latestMissionVersion(workspace, mission.missionId) : null;
    if (!latest) changes.push({ kind: "mission-deleted", missionId: mission.missionId });
    else {
      missionHere = true;
      if (latest.id !== mission.versionId || latest.sha256 !== mission.sha256) changes.push({ kind: "mission-changed", missionId: mission.missionId, from: mission.version, to: latest.version });
    }
  }
  for (const task of binding.tasks) {
    const record = getTask(workspace, task.taskId);
    if (!record) {
      changes.push({ kind: "task-deleted", taskId: task.taskId, title: task.title });
      continue;
    }
    const brief = versionsOf(workspace, task.taskId).at(-1);
    if (!brief || brief.id !== task.briefId || brief.sha256 !== task.briefSha256) {
      changes.push({ kind: "brief-changed", taskId: task.taskId, title: record.title, from: task.briefVersion, to: brief?.version ?? task.briefVersion });
    }
    if (record.title !== task.title) changes.push({ kind: "title-changed", taskId: task.taskId, from: task.title, to: record.title });
    if (mission && missionHere && missionOfTask(workspace, task.taskId) !== mission.missionId) {
      changes.push({ kind: "membership-removed", taskId: task.taskId, title: record.title, missionId: mission.missionId });
    }
  }
  for (const finding of binding.findings) {
    const review = getReview(workspace, finding.reviewId);
    const kept = review?.report?.reviewers.some((reviewer) => reviewer.findings.some((candidate) => candidate.id === finding.findingId)) ?? false;
    if (!kept) changes.push({ kind: "finding-gone", reviewId: finding.reviewId, findingId: finding.findingId });
  }
  return changes;
}

/** What changed, in the person's words, one line each. */
export function changeText(change: ContextChange): string {
  switch (change.kind) {
    case "task-deleted":
      return `"${change.title}" was deleted.`;
    case "brief-changed":
      return change.to === change.from ? `"${change.title}" has a different brief from the one sent.` : `"${change.title}" is now at brief v${change.to}; v${change.from} was sent.`;
    case "title-changed":
      return `"${change.from}" is now called "${change.to}".`;
    case "mission-changed":
      return `The mission is now at v${change.to}; v${change.from} was sent.`;
    case "mission-deleted":
      return "The mission was deleted.";
    case "membership-removed":
      return `"${change.title}" is no longer in the mission's backlog.`;
    case "finding-gone":
      return `Finding ${change.findingId} is no longer in its review.`;
  }
}

/** A finding about one task, from one of its mission's reviews, with what it reviewed and what has changed since. */
export interface TaskFinding {
  ref: FindingRef;
  /** The task as the review was sent it: its brief version and its title then. */
  reviewed: BoundTask;
  /** The task's reference in that review: T1 for the first task it was sent. */
  taskRef: string;
  finding: ReviewFinding;
  reviewedAt: string;
  /** What changed since that review, for this task and its mission; empty when nothing has. */
  changes: ContextChange[];
}

/**
 * A task's mission, and what its mission's reviews found about it, for the coach's preview (NIV-53). The mission is the
 * one whose backlog holds the task now, at its latest version; the findings are those of that mission's completed or
 * partial reviews that name the task, newest review first. None of it is sent anywhere by this: the person picks.
 */
export function missionContextForTask(workspace: WorkspaceDb, taskId: string): { mission: { ref: MissionRef; content: MissionContent } | null; findings: TaskFinding[] } {
  const missionId = missionOfTask(workspace, taskId);
  const mission = missionId ? getMission(workspace, missionId) : null;
  const latest = mission ? latestMissionVersion(workspace, mission.id) : null;
  if (!mission || !latest) return { mission: null, findings: [] };
  const findings: TaskFinding[] = [];
  for (const review of reviewsOf(workspace, mission.conversationId).reverse()) {
    if (!review.report) continue;
    const plan = getArtifact(workspace, review.planId);
    const composition = plan ? compositionOf(plan) : null;
    const index = composition ? composition.binding.tasks.findIndex((task) => task.taskId === taskId) : -1;
    if (!composition || index < 0) continue;
    const reviewed = composition.binding.tasks[index]!;
    const ref = taskRef(index);
    const changes = validateBinding(workspace, { mission: composition.binding.mission, tasks: [reviewed], findings: [], specialists: composition.binding.specialists });
    for (const reviewer of review.report.reviewers) {
      for (const finding of reviewer.findings) {
        if (finding.refs.includes(ref)) findings.push({ ref: { reviewId: review.id, findingId: finding.id }, reviewed, taskRef: ref, finding, reviewedAt: review.reportedAt ?? review.createdAt, changes });
      }
    }
  }
  return { mission: { ref: missionRefOf(latest), content: latest.content }, findings };
}
