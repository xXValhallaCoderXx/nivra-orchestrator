import type { TaskSummary } from "../../../shared/ipc";
import type { Route, Scope, SettingsSection } from "../app/routes";

/**
 * The shell's pure route helpers (NIV-56): which sidebar link a route belongs to, where switching scope leaves you, and
 * the names drafts are kept under. Nothing here touches the window, so `node --test` runs it as it is.
 */

/** A scope as one string: "general", or "project:<id>". Draft keys and remembered places use it. */
export const scopeKey = (scope: Scope): string => (scope.kind === "general" ? "general" : `project:${scope.projectId}`);

export const sameScope = (a: Scope, b: Scope): boolean => scopeKey(a) === scopeKey(b);

/** The sidebar's links, one per place. */
export type Section = "home" | "tasks" | "conversations" | "environment" | "missions" | "settings";

/** The link a route lights up: a task page belongs to Tasks, Explain to the project's Home. */
export function sectionOf(route: Route): Section {
  switch (route.kind) {
    case "home":
    case "explain":
      return "home";
    case "tasks":
    case "task":
    case "new-task":
      return "tasks";
    case "conversations":
    case "conversation":
      return "conversations";
    case "environment":
      return "environment";
    case "missions":
    case "mission":
      return "missions";
    case "settings":
      return "settings";
  }
}

/** Places that exist only for a project: General has no environment and nothing to explain. */
export const projectOnly = (route: Route): boolean => route.kind === "environment" || route.kind === "explain";

/**
 * Where switching to `scope` leaves the window. The switcher changes what is in view, never a piece of work's own
 * project (D17): a list stays a list, a page that belongs to one piece of work goes back to its list, places everywhere
 * (Missions, Settings) stay as they are, and a project's own place falls back to General's Home.
 */
export function routeAfterSwitch(route: Route, scope: Scope): Route {
  switch (route.kind) {
    case "home":
    case "tasks":
    case "conversations":
    case "missions":
    case "mission":
    case "settings":
      return route;
    case "task":
    case "new-task":
      return { kind: "tasks" };
    case "conversation":
      return { kind: "conversations" };
    case "environment":
    case "explain":
      return scope.kind === "project" ? route : { kind: "home" };
  }
}

/** Settings' sections in this build, in reading order. Agents and council defaults come later: no tab yet. */
export const SETTINGS_TABS: ReadonlyArray<{ section: SettingsSection; label: string }> = [
  { section: "connections", label: "Connections" },
  { section: "sharing", label: "Sharing" },
  { section: "preferences", label: "Preferences" },
  { section: "budget", label: "Budget and usage" },
  { section: "diagnostics", label: "Advanced diagnostics" },
];

/** A section this build has no page for opens Connections instead. */
export const shownSection = (section: SettingsSection): SettingsSection => (SETTINGS_TABS.some((tab) => tab.section === section) ? section : "connections");

/** The Home composer's draft for a scope: the title typed there, before a task exists. */
export const composerDraftKey = (scope: Scope): string => `home-composer:${scopeKey(scope)}`;

/**
 * The draft of a new task's brief in a scope, which the new task page keeps (see DraftStore in routes.ts). A form the
 * Home composer started keeps its own (`:home`), so it never takes the place of a draft begun from New task.
 */
export const newTaskDraftKey = (scope: Scope, fromHome = false): string => `new-task:${scopeKey(scope)}${fromHome ? ":home" : ""}`;

function scopeOfKey(text: string): Scope | null {
  if (text === "general") return { kind: "general" };
  if (text.startsWith("project:") && text.length > "project:".length) return { kind: "project", projectId: text.slice("project:".length) };
  return null;
}

/** What a draft is, in a word for the sidebar, and where it is edited; null for a key this build doesn't know. */
export function placeOfDraft(key: string): { kind: string; scope: Scope | null; route: Route } | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (prefix === "home-composer") {
    const scope = scopeOfKey(rest);
    return scope ? { kind: "New task", scope, route: { kind: "home" } } : null;
  }
  if (prefix === "new-task") {
    const scope = scopeOfKey(rest.endsWith(":home") ? rest.slice(0, -":home".length) : rest);
    return scope ? { kind: "New task", scope, route: { kind: "new-task", draftKey: key, plan: null, title: "" } } : null;
  }
  if (prefix === "brief") {
    // brief:<taskId>:<version>; the task keeps its own project, so the scope stays as it is.
    const taskId = rest.slice(0, rest.lastIndexOf(":") > 0 ? rest.lastIndexOf(":") : rest.length);
    return taskId ? { kind: "Brief", scope: null, route: { kind: "task", id: taskId, tab: "brief" } } : null;
  }
  return null;
}

/** The scope's tasks that aren't completed: a project's own, or General's, which have no repository. */
export function openTaskCount(tasks: readonly Pick<TaskSummary, "projectId" | "state">[], scope: Scope): number {
  const projectId = scope.kind === "project" ? scope.projectId : null;
  return tasks.filter((task) => task.projectId === projectId && task.state !== "completed").length;
}

/** The projects whose name another project shares: the switcher shows their folder too, so they can be told apart. */
export function sharedNames(projects: readonly { id: string; label: string }[]): Set<string> {
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.label, (counts.get(project.label) ?? 0) + 1);
  return new Set(projects.filter((project) => (counts.get(project.label) ?? 0) > 1).map((project) => project.id));
}
