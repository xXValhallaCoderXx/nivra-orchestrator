import { StoredCoachInput, type CoachReport } from "@nivra/domain";
import { Refusal } from "../diagnostics.ts";

/** What a coach run reads back from its own store: the task, the brief version, the fingerprints and the profile. */
export type CoachTask = StoredCoachInput;

export function readCoachTask(input: unknown): CoachTask | null {
  const parsed = StoredCoachInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** A stored coach input that can't be read back, refused in Nivra's own words: never the input or a parser's text. */
export const coachUnreadable = (): Refusal =>
  new Refusal("input-unreadable", "Nivra couldn't read this coaching's task and fingerprints back from its store, so nothing was sent to the model. Ask the coach again.");

/**
 * A report as it reads once its run has ended (D30): one the engine saved mid-run, before it stopped, reads as
 * interrupted, its request marked. A request that was out may have been sent. The stored copy is unchanged.
 */
export function asEnded(stored: CoachReport): CoachReport {
  if (stored.outcome !== "in-progress") return stored;
  const { stage } = stored;
  return {
    ...stored,
    outcome: "interrupted",
    stage:
      stage.status === "running"
        ? { ...stage, status: "failed", reason: "interrupted", message: "The engine stopped while this request was out: it may have been sent." }
        : stage.status === "pending"
          ? { ...stage, status: "skipped", reason: "interrupted", message: "The engine stopped before this request was sent." }
          : stage,
  };
}
