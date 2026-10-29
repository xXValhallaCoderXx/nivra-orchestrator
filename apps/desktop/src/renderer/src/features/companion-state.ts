import type { BriefFields, CompanionHint, CompanionScope } from "../../../shared/ipc";
import type { Route, Scope } from "../app/routes";

/** A work page supplies its own identity. The host resolves its project; the switcher cannot lend it another one. */
export function companionHint(route: Route, scope: Scope): CompanionHint {
  if (route.kind === "task") return { taskId: route.id };
  if (route.kind === "mission") return { missionId: route.id };
  return scope.kind === "project" ? { projectId: scope.projectId } : {};
}

export const hintKey = (hint: CompanionHint): string => hint.taskId ? `task:${hint.taskId}` : hint.missionId ? `mission:${hint.missionId}` : hint.projectId ? `project:${hint.projectId}` : "general";
export const knowledgeScopeKey = (scope: CompanionScope): string => scope.kind === "general" ? "general" : scope.kind === "project" ? `project:${scope.projectId}` : scope.kind === "task" ? `task:${scope.taskId}` : `mission:${scope.missionId}`;

export const separateLines = (value: string): string[] => value.split("\n").map((line) => line.trim()).filter(Boolean);

/** Guided tasks are drafts. Human acceptance wording never becomes an executable command. */
export function guidedBrief(goal: string, scope: string, acceptance: string): BriefFields {
  return { goal: goal.trim(), scope: scope.trim(), acceptanceCriteria: separateLines(acceptance), exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
}

export interface CompanionLine { role: "user" | "assistant"; text: string }
/** Bounded presentation history only: neither this buffer nor its composer goes through draft recovery. */
export function appendDialogue(lines: readonly CompanionLine[], line: CompanionLine): CompanionLine[] {
  const next = [...lines, { ...line, text: line.text.slice(0, 16_000) }].slice(-12);
  while (next.length > 1 && next.reduce((total, item) => total + item.text.length, 0) > 32_000) next.shift();
  return next;
}

export interface SetupReturn { scope: Scope; route: Route; hint: CompanionHint; projectId?: string | null }
/** Return never silently uses another project after the original was removed. Work IDs are checked by the host too. */
export function returnProjectPresent(destination: SetupReturn, projectIds: readonly string[]): boolean {
  const projectId = destination.projectId !== undefined ? destination.projectId : destination.scope.kind === "project" ? destination.scope.projectId : null;
  return (projectId === null || projectIds.includes(projectId)) && (destination.scope.kind !== "project" || projectIds.includes(destination.scope.projectId));
}
