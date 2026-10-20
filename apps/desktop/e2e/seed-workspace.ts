import { randomUUID } from "node:crypto";
import type { ChatResult } from "@nivra/domain";
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
