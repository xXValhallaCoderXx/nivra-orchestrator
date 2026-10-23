import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatResult } from "@nivra/domain";
import { planFromAnswer } from "../src/main/tasks.ts";
import { insertArtifact, insertConversation, insertTurn, projectAnswer } from "../src/main/workspace.ts";
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
