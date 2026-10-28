import type { PlanView } from "../../../shared/ipc";

/**
 * Where the window is (NIV-56, G3): a scope, General or one project, and a place in it. There is no router dependency:
 * the shell keeps a Route in state and draws the sidebar from it. A project's work keeps the project it was recorded
 * with; the scope only changes what is in view (D17).
 */
export type Scope = { kind: "general" } | { kind: "project"; projectId: string };

/** The side panel of a task page (Brief, Coach, Earlier runs). */
export type TaskTab = "brief" | "coach" | "runs";

/** Settings, split as approved at G1: one section shown at a time, each with its own tab. */
export type SettingsSection = "connections" | "sharing" | "preferences" | "budget" | "agents" | "diagnostics";

export type Route =
  | { kind: "home" }
  | { kind: "tasks" }
  /** A task page (Next A). `tab` picks its side panel; the shell keeps it so Back and Activity land where you were. */
  | { kind: "task"; id: string; tab: TaskTab }
  /**
   * The brief of a task not created yet (Next A). `draftKey` names its draft (see `DraftStore`), so typed text survives
   * navigation and restarts; `plan` and `title` are what it starts from, as today's NewTask takes them.
   */
  | { kind: "new-task"; draftKey: string; plan: PlanView | null; title: string }
  | { kind: "conversations" }
  | { kind: "conversation"; id: string }
  | { kind: "environment" }
  | { kind: "missions" }
  | { kind: "mission"; id: string }
  | { kind: "settings"; section: SettingsSection };

/** How a page moves the window. The shell passes it down; pages never keep their own idea of where they are. */
export type Navigate = (route: Route) => void;

/** The seven steps of a task's progress strip (G1: it explains where a task is and forces nothing). */
export type StripStep = "brief" | "readiness" | "environment" | "run" | "review" | "apply" | "accept";

/**
 * How one step looks: done, the current step, needing attention, still to come, or optional for this task (for
 * example an environment the task's commands don't need).
 */
export type StripState = "done" | "now" | "attention" | "next" | "optional";

/**
 * One step as the task page (Next A) works it out from the task's own data. `sub` is the short line under the step's
 * name: one or two words that never wrap mid-phrase ("v1 saved", "2 needed", "Prepared", "Ended").
 */
export interface StripItem {
  step: StripStep;
  state: StripState;
  sub: string;
}

/**
 * The strip slot: the shell owns how the strip looks and its accessibility (an ordered list, the current step marked
 * with aria-current="step"); the task page owns what it says. Exactly seven items, in StripStep's order.
 */
export interface TaskStripProps {
  items: readonly StripItem[];
  /** Names the task for screen readers, for example "Where Add CSV export for invoices is". */
  label?: string;
}

/**
 * Drafts kept across navigation and restarts (Nate, G2), on this computer only, never sent anywhere. A draft holding
 * what looks like a credential isn't kept, and neither is one this computer's storage refused: `reason` says which, so
 * the page can tell the person (shell/drafts: `DraftNotice`). `key` is a stable name such as `new-task:<scope>` or
 * `brief:<taskId>:<version>`.
 */
export type DraftWrite = { kept: true } | { kept: false; reason: "credential" | "storage" };

export interface DraftStore {
  read<T>(key: string): T | null;
  /** `label` is the line the sidebar's "Unsaved drafts" shows, such as the brief's title: the page knows it best. */
  write<T>(key: string, value: T, label: string): DraftWrite;
  discard(key: string): void;
  /** The drafts that exist, newest first, for the sidebar's "Unsaved drafts" list. */
  list(): ReadonlyArray<{ key: string; label: string; savedAt: string }>;
}

/**
 * Theme tokens the shell defines in theme.ts (light, and dark as approved in DK1), for pages to use by name instead of
 * literal colours. Each is a CSS variable set by the theme's cssVariablesResolver.
 */
export const THEME_TOKENS = {
  /** The border of an outlined control (default buttons, inputs, the switcher): 3.45:1 on white. */
  controlBorder: "--nivra-control-border",
  /** Rows of a diff: an added line and a removed one. The +/- sign carries the meaning too. */
  diffAdded: "--nivra-diff-added",
  diffRemoved: "--nivra-diff-removed",
  /** A light badge's background and text, by tone: `--nivra-badge-<tone>-bg` and `--nivra-badge-<tone>-fg`. */
  badgeTones: ["gray", "blue", "yellow", "green", "red", "indigo", "orange"],
} as const;
