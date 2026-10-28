import type { EnvironmentView, TaskState, TaskView, TurnStatus } from "./ipc";

/**
 * A task's progress strip (NIV-56, G3): seven steps the task page works out from the task's own data, which the
 * shell's TaskStrip draws. These types are the shell's (`app/routes.ts`), repeated here until it lands on main:
 * the same shape, so the shell takes these items as they are. Nothing here is guessed: a step says only what the
 * task's data shows, and a step the data can't settle says it's still to come.
 */
export type StripStep = "brief" | "readiness" | "environment" | "run" | "review" | "apply" | "accept";
export type StripState = "done" | "now" | "attention" | "next" | "optional";
export interface StripItem {
  step: StripStep;
  state: StripState;
  sub: string;
}

type Attempt = TaskView["attempts"][number];

export interface StripInput {
  /** The task as saved, or null for a brief that isn't saved yet (a new task). */
  task: { state: TaskState; briefVersion: number } | null;
  /** How many things readiness says are needed before a run; null while that isn't known. */
  needed: number | null;
  /** The project's environment: ready, needing attention (with its short reason), none prepared, or not known. */
  environment: { kind: "ready" } | { kind: "attention"; sub: string } | { kind: "none" } | null;
  /** The task's latest run, as the workspace keeps it; null before any. */
  latest: Attempt | null;
}

const open = (status: TurnStatus) => status === "submitting" || status === "running";

const RUN_ENDED: Record<Exclude<TurnStatus, "submitting" | "running">, { state: StripState; sub: string }> = {
  answered: { state: "done", sub: "Ended" },
  cancelled: { state: "done", sub: "Stopped" },
  failed: { state: "attention", sub: "Failed" },
  interrupted: { state: "attention", sub: "Interrupted" },
  "not-sent": { state: "attention", sub: "Not sent" },
  unknown: { state: "attention", sub: "Unknown" },
};

function reviewOf(latest: Attempt | null): { state: StripState; sub: string } {
  if (latest === null || open(latest.status)) return { state: "next", sub: "Nothing yet" };
  if (latest.outcome !== "proposed") return { state: "next", sub: "No change" };
  if (latest.decision === "approved") return { state: "done", sub: "Approved" };
  if (latest.decision === "rejected") return { state: "done", sub: "Rejected" };
  if (latest.decision === "revision") return { state: "done", sub: "Revision" };
  return latest.verified ? { state: "now", sub: "Your decision" } : { state: "attention", sub: "Not verified" };
}

function applyOf(latest: Attempt | null): { state: StripState; sub: string } {
  const apply = latest?.apply ?? null;
  if (apply === null) return { state: "next", sub: "Not yet" };
  if (apply.resolution === "dismissed") return { state: "done", sub: "Dismissed" };
  if (apply.resolution === "kept") return { state: "done", sub: "Kept" };
  switch (apply.status) {
    case null:
    case "claimed":
    case "writing":
      return { state: "now", sub: "Applying" };
    case "applied":
      return { state: "done", sub: "Applied" };
    case "partial":
      return { state: "attention", sub: "In part" };
    case "refused":
    case "not-applied":
      return { state: "attention", sub: "Not applied" };
    case "unknown":
      return { state: "attention", sub: "Unknown" };
  }
}

function acceptOf(task: StripInput["task"], latest: Attempt | null): { state: StripState; sub: string } {
  if (task?.state === "completed") return latest?.acceptedAt || latest?.apply?.resolution === "accepted" ? { state: "done", sub: "Accepted" } : { state: "done", sub: "Completed" };
  if (latest?.apply?.status === "applied" && latest.apply.resolution === null) return { state: "now", sub: "Waiting" };
  return { state: "next", sub: "Not yet" };
}

/** The environment step from the project's environment as the window holds it; null while that isn't known. */
export function environmentStepOf(environment: Pick<EnvironmentView, "prepared" | "ready" | "legacy" | "notice"> | null): StripInput["environment"] {
  if (environment === null) return null;
  if (environment.legacy) return { kind: "attention", sub: "Prepare again" };
  if (environment.prepared === null) return { kind: "none" };
  if (!environment.ready) return { kind: "attention", sub: "Not ready" };
  if (environment.notice) return { kind: "attention", sub: "See its notice" };
  return { kind: "ready" };
}

/**
 * Whether the task's latest run is going or waits on the person, as the host decides it (`#waitingOn`): its change to
 * decide on, or an approved change still being applied or to settle. Its card then leads the page, and readiness waits.
 */
export function latestHolds(latest: Attempt | null): boolean {
  if (latest === null) return false;
  if (open(latest.status)) return true;
  if (latest.status !== "answered" || latest.acceptedAt !== null) return false;
  if (latest.decision === null) return latest.outcome === "proposed";
  return latest.decision === "approved" && latest.apply !== null && latest.apply.resolution === null;
}

/** The seven steps, in their order, from the task's own data. */
export function stripItemsOf(input: StripInput): StripItem[] {
  const { task, latest } = input;
  const began = latest !== null;
  const brief: StripItem = task === null ? { step: "brief", state: "now", sub: "Writing v1" } : { step: "brief", state: "done", sub: `v${task.briefVersion} saved` };
  const readiness: StripItem =
    task === null
      ? { step: "readiness", state: "next", sub: "Not yet" }
      : began || task.state === "completed" || input.needed === 0
        ? { step: "readiness", state: "done", sub: "All met" }
        : input.needed === null
          ? { step: "readiness", state: "next", sub: "Not checked" }
          : { step: "readiness", state: "attention", sub: `${input.needed} needed` };
  const environment: StripItem =
    input.environment === null
      ? { step: "environment", state: "next", sub: "Not checked" }
      : input.environment.kind === "ready"
        ? { step: "environment", state: "done", sub: "Prepared" }
        : input.environment.kind === "attention"
          ? { step: "environment", state: "attention", sub: input.environment.sub }
          : { step: "environment", state: "optional", sub: "None" };
  const run: StripItem = latest === null ? { step: "run", state: "next", sub: "Not started" } : open(latest.status) ? { step: "run", state: "now", sub: "Running" } : { step: "run", ...RUN_ENDED[latest.status as keyof typeof RUN_ENDED] };
  return [brief, readiness, environment, run, { step: "review", ...reviewOf(latest) }, { step: "apply", ...applyOf(latest) }, { step: "accept", ...acceptOf(task, latest) }];
}
