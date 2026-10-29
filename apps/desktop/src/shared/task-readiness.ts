import type { EnvironmentView, ProjectView, SettingsView, TaskView } from "./ipc";

/**
 * A task's readiness before a run (NIV-56, G3: P1c, RS3), worked out from what the window already holds: the task, its
 * project, the saved settings and the project's environment. Every row states a fact the data shows; anything it
 * can't settle is left to the run's preview, which checks everything again and sends nothing. The host's own reason
 * (`runBlocked`) is shown as it is, whenever no row here already says it.
 */

/** Reopen isn't one: the page offers it once, beside the task's other state changes. */
export type ReadinessAction = "mark-ready" | "edit-brief" | "change-repository" | "add-keys" | "open-environment";

export interface ReadinessRow {
  id: string;
  title: string;
  detail: string;
  /** The next step this row offers, or null when there's nothing to do here. */
  action: ReadinessAction | null;
}

export interface Readiness {
  /** What keeps a run from starting, each with its next step. */
  needed: ReadinessRow[];
  /** What the run's preview asks for, after it shows what would be sent. */
  asked: ReadinessRow[];
  /** What's already in place. */
  met: ReadinessRow[];
  /** What a run doesn't need, said as it is. */
  optional: ReadinessRow[];
}

export interface ReadinessInput {
  task: Pick<TaskView, "summary" | "brief" | "runBlocked">;
  /** The task's project as listed, or null when it has none or it's no longer listed. */
  project: Pick<ProjectView, "id" | "label" | "targetLabel" | "sharing"> | null;
  /** The saved settings, or null while they're being read. */
  settings: Pick<SettingsView, "nebiusKey" | "nebiusProjectId"> | null;
  /** The project's environment, or null while it's being read or the task has no project. */
  environment: Pick<EnvironmentView, "prepared" | "ready" | "legacy" | "notice"> | null;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The project's environment as one line (D41, NIV-55): what its task runs start from, or why they can't start from it
 * yet, which needs the person; none prepared is said as it is, since a run doesn't need one. Null while it isn't known.
 */
export function environmentRowOf(named: string, environment: ReadinessInput["environment"]): { kind: "needed" | "met" | "optional"; row: ReadinessRow } | null {
  if (environment === null) return null;
  if (environment.legacy) {
    return { kind: "needed", row: { id: "environment", title: `${named}'s environment was prepared by an earlier version of Nivra`, detail: "Task runs don't start from it. Prepare it again to use it.", action: "open-environment" } };
  }
  if (environment.prepared === null) {
    return { kind: "optional", row: { id: "environment", title: `${named} has no environment`, detail: "Runs start from Nivra's own base image, with nothing installed. Prepare one if the brief's commands need the project's dependencies.", action: "open-environment" } };
  }
  if (!environment.ready) {
    return { kind: "needed", row: { id: "environment", title: `${named}'s environment isn't ready`, detail: "Some dependency builds didn't run when it was prepared, so task runs won't start from it yet.", action: "open-environment" } };
  }
  if (environment.notice) return { kind: "needed", row: { id: "environment", title: `${named}'s environment`, detail: environment.notice, action: "open-environment" } };
  const tools = environment.prepared.verified.tools.map((tool) => `${tool.name} ${tool.version}`).join(", ");
  return { kind: "met", row: { id: "environment", title: `${named}'s environment is prepared`, detail: `Its task runs start from it: ${tools}.`, action: null } };
}

export function readinessOf({ task, project, settings, environment }: ReadinessInput): Readiness {
  const { summary, brief, runBlocked } = task;
  const content = brief.content;
  const needed: ReadinessRow[] = [];
  const asked: ReadinessRow[] = [];
  const met: ReadinessRow[] = [];
  const optional: ReadinessRow[] = [];
  const named = project?.label ?? "the project";

  if (summary.state === "completed") {
    needed.push({ id: "completed", title: "The task is completed", detail: "A completed task doesn't run again. Reopen it, then mark it ready, to run it again.", action: null });
  } else if (summary.state === "draft") {
    needed.push({ id: "draft", title: "The task isn't marked ready", detail: "Mark it ready when its brief says what it's for and how a run is checked.", action: "mark-ready" });
  }
  if (content.acceptanceCases.length === 0) {
    needed.push({ id: "cases", title: "The brief has no acceptance case", detail: "A run needs at least one, so Nivra can check the result itself: a command, and exactly what it must print and the exit code it must give.", action: "edit-brief" });
  }
  if (summary.projectId === null) {
    needed.push({ id: "repository", title: "No repository yet", detail: "A run works from a repository's commit. Choose the repository the task's work runs in.", action: "change-repository" });
  } else if (project === null || summary.projectPresent === false) {
    needed.push({ id: "repository", title: "Its repository isn't in the list any more", detail: "Choose a repository for the task, or add its folder again.", action: "change-repository" });
  }
  if (settings !== null && (settings.nebiusKey === "none" || settings.nebiusKey === "unreadable" || settings.nebiusProjectId === "none")) {
    const missing = settings.nebiusKey === "unreadable" ? "Your saved key can't be read on this computer: add it again." : settings.nebiusKey === "none" && settings.nebiusProjectId === "none" ? "Not added yet." : settings.nebiusKey === "none" ? "The key isn't added yet." : "The project ID isn't added yet.";
    needed.push({
      id: "keys",
      title: "Your Nebius key and project ID",
      detail: `${missing} The worker reaches Token Factory with the key, and the run happens in Nebius Sandboxes in your project, so the key needs access to that project.`,
      action: "add-keys",
    });
  }
  const ofEnvironment = project !== null ? environmentRowOf(named, environment) : null;
  if (ofEnvironment?.kind === "needed") needed.push(ofEnvironment.row);
  // The host's own reason, when nothing above says it already: it is the one runs check, and it's shown as it is.
  if (runBlocked !== null && needed.length === 0) needed.push({ id: "blocked", title: "Why it can't run now", detail: runBlocked, action: null });

  if (project !== null) {
    if (!project.sharing.modelContext) {
      asked.push({ id: "sharing", title: `Sharing with Token Factory: off for ${named}`, detail: "A run sends the brief and the files the worker reads. The run preview says what kinds of content would be sent, then asks.", action: null });
    }
    if (!project.sharing.cloudExecution) {
      asked.push({ id: "uploads", title: `Uploads to Nebius Sandboxes: off for ${named}`, detail: "A run uploads one snapshot of the commit, and the worker changes a copy of it with networking off. Asked when you prepare the environment or preview the run.", action: null });
    }
  }

  if (summary.state !== "draft" && summary.state !== "completed" && content.acceptanceCases.length > 0) {
    met.push({
      id: "brief",
      title: "The brief is ready",
      detail: `${content.goal.trim() ? "A goal, " : ""}${count(content.acceptanceCriteria.length, "acceptance criterion", "acceptance criteria")}, ${count(content.acceptanceCases.length, "acceptance case")} and ${count(content.checks.length, "check")} (a run takes one to four in all), ${count(content.baseline.length, "baseline check")} and ${count(content.frozen.length, "frozen file")} the worker can't change.`,
      action: null,
    });
  }
  if (project !== null) met.push({ id: "repository", title: `${project.label} · ${project.targetLabel}`, detail: "A run works from this repository's commit.", action: null });
  if (settings !== null && (settings.nebiusKey === "encrypted" || settings.nebiusKey === "unencrypted") && settings.nebiusProjectId === "set") {
    met.push({ id: "keys", title: "Your Nebius key and project ID are saved", detail: settings.nebiusKey === "encrypted" ? "The key is kept encrypted on this computer." : "The key is kept on this computer, unencrypted.", action: null });
  }
  if (project?.sharing.modelContext) met.push({ id: "sharing", title: `Sharing with Token Factory: on for ${named}`, detail: "A run's preview still shows what would be sent before you start.", action: null });
  if (project?.sharing.cloudExecution) met.push({ id: "uploads", title: `Uploads to Nebius Sandboxes: on for ${named}`, detail: "A run's preview still shows what would be uploaded before you start.", action: null });
  if (ofEnvironment?.kind === "met") met.push(ofEnvironment.row);
  if (runBlocked === null) met.push({ id: "nothing-blocks", title: "Nothing keeps it from running now", detail: "Nivra checks everything again when you preview the run.", action: null });

  if (ofEnvironment?.kind === "optional") optional.push(ofEnvironment.row);
  return { needed, asked, met, optional };
}
