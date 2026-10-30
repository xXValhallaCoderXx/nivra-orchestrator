// NIV-53's acceptance journey, shared by the offline window check and the explicit live runner.
import assert from "node:assert/strict";
import { COACH_RUN_LIMITS, type CoachField } from "@nivra/domain";
import { expect, type Page } from "@playwright/test";
import type { CoachPreview, CoachingView } from "../src/shared/coach.ts";
import type { BriefFields, TaskView } from "../src/shared/ipc.ts";
import { waitFor } from "./live-ui.ts";

export const COACH_DEMO = {
  title: "Personal records use one unit",
  fields: {
    goal: "Fix personal record detection so that runs logged in miles and in kilometres are compared correctly",
    acceptanceCriteria: ["It works", "Records show the right unit"],
    scope: "", exclusions: "Do not change stored workout history.", context: "", assumptions: [], checks: [], acceptanceCases: [],
  } satisfies BriefFields,
};
export const COACH_SELECTION = { mission: false, findings: [] };
export const COACH_FOLLOW_MS = 60_000 + COACH_RUN_LIMITS.totalMs + 30_000;

export const taskOf = (page: Page, id: string): Promise<TaskView> => page.evaluate(`window.nivra.getTask(${JSON.stringify(id)})`);
export const coachingsOf = (page: Page, id: string): Promise<CoachingView[]> => page.evaluate(`window.nivra.listCoachings(${JSON.stringify(id)})`);

export async function openCoachTask(page: Page, id: string): Promise<void> {
  await page.getByTestId("nav-tasks").click();
  await page.locator(`[data-testid="task-row"][data-task-id="${id}"]`).getByTestId("task-open").click();
  await page.getByTestId("task-tab-coach").click();
}

export async function createCoachTask(page: Page): Promise<TaskView> {
  const task: TaskView = await page.evaluate(`window.nivra.createTask(${JSON.stringify({ ...COACH_DEMO, projectId: null, planId: null })})`);
  await openCoachTask(page, task.summary.id);
  return task;
}

/** Reading the preview never presses Start. Both the visible text and its binding are checked. */
export async function coachPreview(page: Page, id: string, expected?: CoachPreview): Promise<CoachPreview> {
  await openCoachTask(page, id);
  await page.getByTestId("coach-ask").click();
  await expect(page.getByTestId("coach-preview-text")).toBeVisible();
  const preview: CoachPreview = await page.evaluate(`window.nivra.prepareCoach(${JSON.stringify(id)}, ${JSON.stringify(COACH_SELECTION)})`);
  assert.equal(preview.blocked, null, "the fixture's preview is blocked");
  assert.equal(preview.scope.kind, "general");
  assert.equal(preview.preferences.length, 0, "the fixture must not send personal context");
  assert.equal(preview.selection.mission, false);
  assert.equal(preview.selection.findings.length, 0);
  assert.equal(preview.limits.outputTokens, COACH_RUN_LIMITS.outputTokensPerRequest);
  assert.equal(preview.limits.budgetTokens, COACH_RUN_LIMITS.estimatedInputTokens);
  await expect(page.getByTestId("coach-preview-text")).toHaveText(preview.text);
  if (expected) {
    assert.equal(preview.expected, expected.expected, "the preview changed since the recipe was frozen");
    assert.equal(preview.text, expected.text, "the visible packet changed");
    assert.deepEqual(preview.profile, expected.profile);
    assert.deepEqual(preview.limits, expected.limits);
  }
  return preview;
}

export async function endedCoach(page: Page, id: string): Promise<CoachingView> {
  // Observe a cold engine too: 60 s for initialize, the engine's own full deadline, then 30 s to read its end.
  // This changes only the acceptance observer's wait, never the model or workflow's deadline.
  return waitFor(async () => {
    const [coaching] = await coachingsOf(page, id);
    return coaching && coaching.status !== "submitting" && coaching.status !== "running" ? coaching : null;
  }, COACH_FOLLOW_MS, "the one coaching to end");
}

export function checkCoachAnswer(coaching: CoachingView): void {
  assert.equal(coaching.status, "answered", coaching.note ?? "the coach did not answer");
  assert.ok(coaching.report, "no report was retained");
  assert.equal(coaching.report.outcome, "complete");
  assert.equal(coaching.report.stage.requests, 1);
  assert.ok(coaching.report.questions.length <= 3);
  assert.ok(coaching.changes.length >= 2, "a partial field selection needs at least two usable changes; record this answer as incomplete");
  assert.equal(coaching.stale.length, 0);
}

/** The reviewer chooses the fields after inspecting the actual answer; the helper never chooses for them. */
export async function saveCoachSelection(page: Page, before: TaskView, coaching: CoachingView, fields: CoachField[]): Promise<TaskView> {
  checkCoachAnswer(coaching);
  assert.ok(fields.length > 0 && fields.length < coaching.changes.length, "select some, but not all, proposed fields");
  assert.equal(new Set(fields).size, fields.length);
  await openCoachTask(page, before.summary.id);
  const expected = structuredClone(before.brief.content);
  for (const field of fields) {
    const change = coaching.changes.find((candidate) => candidate.field === field);
    assert.ok(change && !change.blocked, `the proposed ${field} change is unavailable`);
    Object.assign(expected, { [field]: change.after });
    await page.locator(`[data-testid="coach-change"][data-field="${field}"]`).getByTestId("coach-change-tick").check();
  }
  await page.getByTestId("coach-save").click();
  await expect(page.getByTestId("coach-applied")).toContainText(`Saved as v${before.brief.version + 1}`);
  const saved = await taskOf(page, before.summary.id);
  assert.equal(saved.brief.version, before.brief.version + 1);
  // Compare bounded individual fields, so a failure never dumps a large task/attempt history.
  for (const field of Object.keys(expected) as Array<keyof typeof expected>) assert.deepEqual(saved.brief.content[field], expected[field], `the saved ${field} differs from the reviewed selection`);
  assert.equal(saved.summary.state, before.summary.state);
  assert.equal(saved.attempts.length, before.attempts.length);
  const records = await coachingsOf(page, before.summary.id);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]!.applied?.fields, fields);
  return saved;
}
