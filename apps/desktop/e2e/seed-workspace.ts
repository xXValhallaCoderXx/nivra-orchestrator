import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatResult, MISSION_COUNCIL, MissionContent, MissionReviewComposition, MissionReviewPacket, renderMissionPacket, specialistRef, type ReviewReport } from "@nivra/domain";
import type { BriefFields } from "../src/shared/ipc.ts";
import { missionPlanContent, packetTaskOf } from "../src/main/mission-context.ts";
import { addMissionTask, getMission, insertMission, latestMissionVersion, missionRefOf, missionTaskIds } from "../src/main/mission-store.ts";
import { briefFrom, planFromAnswer } from "../src/main/tasks.ts";
import { getTask, insertArtifact, insertConversation, insertReview, insertTask, insertTurn, projectAnswer, settleReview, versionsOf } from "../src/main/workspace.ts";
import { openWorkspace } from "../src/main/workspace-db.ts";

/**
 * Seeds a profile's workspace (D26) with a general conversation whose one answer is saved as plan v1, through the
 * workspace's own functions, so a check of an app that can't reach a model (packaged, or the Windows build) has a plan to
 * review. It must run on the OS that owns the file (D7): the test's own Node, or the staged node.exe on Windows, which
 * runs this bundled (seed-workspace-cli.ts). The answer records no run: it was never an engine's.
 */
export function seedPlan(workspacePath: string, seed: { question: string; plan: string }): { conversationId: string; planId: string } {
  const opening = openWorkspace(workspacePath);
  if (opening.state !== "ready") throw new Error(opening.reason);
  const workspace = opening.db;
  try {
    const now = new Date().toISOString();
    const conversationId = randomUUID();
    insertConversation(workspace, { id: conversationId, kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "New conversation", createdAt: now, updatedAt: now });
    const turnId = randomUUID();
    insertTurn(workspace, { id: turnId, conversationId, sessionId: "seed", targetId: "local", preferences: [], history: null, createdAt: now }, { id: randomUUID(), text: seed.question });
    const history = { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "seed" };
    const reply: ChatResult = { kind: "general", text: seed.plan, cutOff: false, context: { preferences: { revision: 0, digest: "seed", records: [] }, history }, finishedAt: now };
    const messageId = randomUUID();
    if (!projectAnswer(workspace, turnId, { id: messageId, text: seed.plan, reply, createdAt: now })) throw new Error("The seeded answer wasn't kept.");
    const content = planFromAnswer(reply, { conversationId, messageId, runId: null, projectId: null });
    const plan = insertArtifact(workspace, { id: randomUUID(), kind: "plan", lineageId: randomUUID(), content, conversationId, taskId: null, messageId, runLinkId: turnId, derivedFrom: null, createdAt: now });
    if (!plan) throw new Error("The seeded plan wasn't kept.");
    return { conversationId, planId: plan.id };
  } finally {
    workspace.close();
  }
}

/** What a seeded project plan is made of, with the ids it is saved under, so its preview's fingerprint can be known. */
export interface ProjectSeed {
  /** The label of a project the app itself added, as nivra.json holds it. */
  projectLabel: string;
  question: string;
  answer: string;
  assumptions: string[];
  ids: { conversationId: string; turnId: string; messageId: string; planId: string; lineageId: string };
}

/**
 * Seeds a profile's workspace with a project conversation whose one answer, a repository reply checked against the
 * domain's schema, is saved as plan v1 with its assumptions (D37's demonstration in R3 of NIV-45). The project is read
 * from the profile's nivra.json, where the app put it when the folder was added, so the conversation runs on that
 * project's engine. The reply cites no lines and names no commit (headAtStart null). Like `seedPlan`, it runs on the OS
 * that owns the file (D7), with the app closed.
 */
export function seedProjectPlan(userData: string, seed: ProjectSeed): { conversationId: string; planId: string; targetId: string } {
  // Read here, not through HostStore, which moves a file it can't read aside: a seed leaves the profile as it found it.
  const projects = (JSON.parse(readFileSync(join(userData, "nivra.json"), "utf8")) as { projects?: Array<{ id: string; label: string; targetId: string }> }).projects ?? [];
  const project = projects.find((candidate) => candidate.label === seed.projectLabel);
  if (!project) throw new Error(`No project is labelled ${seed.projectLabel} in this profile. Add its folder in the app first.`);
  const opening = openWorkspace(join(userData, "workspace.db"));
  if (opening.state !== "ready") throw new Error(opening.reason);
  const workspace = opening.db;
  try {
    const now = new Date().toISOString();
    const { conversationId, turnId, messageId, planId, lineageId } = seed.ids;
    const at = { conversationId, projectId: project.id, projectLabel: project.label, targetId: project.targetId };
    insertConversation(workspace, { id: conversationId, kind: "project", projectId: at.projectId, projectLabel: at.projectLabel, targetId: at.targetId, title: "New conversation", createdAt: now, updatedAt: now });
    insertTurn(workspace, { id: turnId, conversationId, sessionId: "seed", targetId: at.targetId, preferences: [], history: null, createdAt: now }, { id: randomUUID(), text: seed.question });
    const history = { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "seed" };
    const reply = ChatResult.parse({
      kind: "repository",
      answer: seed.answer,
      evidence: [],
      proposals: [],
      assumptions: seed.assumptions,
      conflicts: [],
      gaps: [],
      headAtStart: null,
      headAtEnd: null,
      context: { map: [], reads: [], searches: 0, searchHits: 0, chars: 0, changedFiles: [], history },
      checks: { citations: 0, checked: 0 },
      answeredAtStep: 0,
      finishedAt: now,
    });
    if (!projectAnswer(workspace, turnId, { id: messageId, text: seed.answer, reply, createdAt: now })) throw new Error("The seeded answer wasn't kept.");
    const content = planFromAnswer(reply, { conversationId, messageId, runId: null, projectId: at.projectId });
    const plan = insertArtifact(workspace, { id: planId, kind: "plan", lineageId, content, conversationId, taskId: null, messageId, runLinkId: turnId, derivedFrom: null, createdAt: now });
    if (!plan) throw new Error("The seeded plan wasn't kept.");
    return { conversationId, planId: plan.id, targetId: at.targetId };
  } finally {
    workspace.close();
  }
}

/** A seeded mission (NIV-52): its content, and its backlog's tasks, each a direct task with a goal and its criteria. */
export interface MissionSeed {
  mission: MissionContent;
  tasks: Array<{ title: string; goal: string; acceptanceCriteria: string[] }>;
}

/**
 * Seeds a profile's workspace with a mission at v1 and its backlog, through the workspace's own functions, so a check
 * of an app that can't reach a model has a mission to show and preview, and Track C has a mission to give its coach.
 * Like `seedPlan`, it runs on the OS that owns the file (D7), with the app closed.
 */
export function seedMission(workspacePath: string, seed: MissionSeed): { missionId: string; conversationId: string; versionId: string; taskIds: string[] } {
  const opening = openWorkspace(workspacePath);
  if (opening.state !== "ready") throw new Error(opening.reason);
  const workspace = opening.db;
  try {
    const now = new Date().toISOString();
    const missionId = randomUUID();
    const conversationId = randomUUID();
    const version = insertMission(workspace, { id: missionId, conversationId, createdAt: now }, { id: randomUUID(), content: MissionContent.parse(seed.mission) });
    const taskIds = seed.tasks.map((task) => {
      const id = randomUUID();
      const fields = { goal: task.goal, acceptanceCriteria: task.acceptanceCriteria, scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
      insertTask(workspace, { id, title: task.title, projectId: null, createdAt: now, updatedAt: now }, { id: randomUUID(), content: briefFrom(fields), derivedFrom: null });
      if (addMissionTask(workspace, missionId, id, now) !== "added") throw new Error("The seeded task didn't join the mission.");
      return id;
    });
    return { missionId, conversationId, versionId: version.id, taskIds };
  } finally {
    workspace.close();
  }
}

/** A seeded mission review's findings: each a reviewer's, naming the selected tasks it is about (T1, ...), the mission or the backlog. */
export interface MissionReviewSeed {
  missionId: string;
  /** The tasks the review was sent, in order: T1 first. */
  taskIds: string[];
  findings: Array<{ role: "architecture" | "risks"; title: string; detail: string; recommendation: string; refs: string[] }>;
}

/**
 * Seeds a completed mission review (NIV-52) as one would be kept: its review plan made from the mission's latest version
 * and the tasks' latest briefs, the review bound to it, and a complete report holding the given findings. No model and
 * no engine: the run never happened, the report says nothing about usage, and its packet and preferences digests are
 * placeholders (the text's sha256), not what an engine would have worked out. For checks that need findings to show or
 * to pick (Track C) before a real review is possible.
 */
export function seedMissionReview(workspacePath: string, seed: MissionReviewSeed): { reviewId: string; planId: string } {
  const opening = openWorkspace(workspacePath);
  if (opening.state !== "ready") throw new Error(opening.reason);
  const workspace = opening.db;
  try {
    const now = new Date().toISOString();
    const mission = getMission(workspace, seed.missionId);
    const latest = mission ? latestMissionVersion(workspace, mission.id) : null;
    if (!mission || !latest) throw new Error("No such mission in this profile.");
    const backlog = missionTaskIds(workspace, mission.id);
    const sent = seed.taskIds.map((taskId) => {
      const task = getTask(workspace, taskId);
      const brief = versionsOf(workspace, taskId).at(-1);
      if (!task || !brief || !backlog.includes(taskId)) throw new Error("Each seeded review's task must be in the mission's backlog.");
      return { bound: { taskId, briefId: brief.id, briefVersion: brief.version, briefSha256: brief.sha256, title: task.title }, packet: packetTaskOf(task.title, briefFrom(brief.content as BriefFields)) };
    });
    const specialists = MISSION_COUNCIL.map(specialistRef);
    const packet = MissionReviewPacket.parse({ kind: "mission", scope: { kind: "general" }, specialists, model: null, mission: latest.content, tasks: sent.map((task) => task.packet), othersInBacklog: backlog.length - sent.length });
    const composition = MissionReviewComposition.parse({ binding: { mission: missionRefOf(latest), tasks: sent.map((task) => task.bound), findings: [], specialists }, packet, text: renderMissionPacket(packet) });
    const plan = insertArtifact(workspace, { id: randomUUID(), kind: "plan", lineageId: mission.id, content: missionPlanContent(composition, mission.conversationId), conversationId: mission.conversationId, taskId: null, messageId: null, runLinkId: null, derivedFrom: null, createdAt: now });
    if (!plan) throw new Error("The seeded review plan wasn't kept.");
    const reviewId = randomUUID();
    const digest = createHash("sha256").update(composition.text).digest("hex");
    const review = { id: reviewId, conversationId: mission.conversationId, planId: plan.id, planLineage: plan.lineageId, planVersion: plan.version, planSha256: plan.sha256, panel: "council" as const, packetDigest: digest, preferencesDigest: digest, scope: { kind: "general" as const }, createdAt: now };
    if (!insertReview(workspace, review, { sessionId: "seed", targetId: "local", preferences: [] })) throw new Error("The seeded review wasn't kept.");
    const adjusted = { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 };
    const reviewer = (role: "architecture" | "risks"): ReviewReport["reviewers"][number] => ({
      role,
      summary: `The ${role} reviewer's seeded summary.`,
      findings: seed.findings
        .filter((finding) => finding.role === role)
        .map((finding, index) => ({ id: `${role === "architecture" ? "arch" : "risk"}-${index + 1}`, title: finding.title, detail: finding.detail, recommendation: finding.recommendation, severity: "medium", basis: "plan", refs: finding.refs, relabelled: false })),
      assumptions: [],
      gaps: [],
      adjusted,
    });
    const report: ReviewReport = {
      panel: "council",
      planId: plan.id,
      planVersion: plan.version,
      packetDigest: digest,
      preferencesDigest: digest,
      outcome: "complete",
      scope: { kind: "general" },
      packet: { textChars: composition.text.length, assumptions: 0, references: 0 },
      request: { runId: randomUUID(), clientRequestId: reviewId },
      route: null,
      sampling: { temperature: null, topP: null, maxOutputTokens: 4_000, toolChoice: "forced" },
      preferences: { revision: 0, digest, records: [] },
      reviewers: [reviewer("architecture"), reviewer("risks")],
      synthesis: null,
      stages: [],
      usage: { inputTokens: null, outputTokens: null, calls: 0, reportedCalls: 0 },
      budget: {
        limits: { requests: 3, totalMs: 330_000, outputTokensPerRequest: 4_000, estimatedInputTokens: 120_000 },
        used: { requests: 0, elapsedMs: 0, inputTokens: 0, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: 0, overrunTokens: 0 },
        stopped: null,
      },
      elapsedMs: 0,
      updatedAt: now,
      finishedAt: now,
    };
    if (!settleReview(workspace, reviewId, { status: "answered" }, report, now)) throw new Error("The seeded report wasn't kept.");
    return { reviewId, planId: plan.id };
  } finally {
    workspace.close();
  }
}
