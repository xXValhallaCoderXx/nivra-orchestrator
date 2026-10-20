import { StoredReviewInput, type ReviewReport } from "@nivra/domain";

/** What a review run reads back from its own store: the panel, the plan's id and version, and the two fingerprints. */
export type ReviewTask = StoredReviewInput;

export function readReviewTask(input: unknown): ReviewTask | null {
  const parsed = StoredReviewInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** A stored review input that can't be read back. Its message is Nivra's own, never the input or a parser's text. */
export class ReviewUnreadable extends Error {
  readonly kind = "internal";

  constructor() {
    super("Nivra couldn't read this review's plan and fingerprints back from its store, so nothing was sent to the model. Start the review again.");
    this.name = "ReviewUnreadable";
  }
}

/**
 * A report as it reads once its run has ended (D30): one the engine saved mid-review, before it stopped, reads as
 * interrupted, its unfinished stages marked. A request that was out may have been sent. The stored copy is unchanged.
 */
export function asEnded(stored: ReviewReport): ReviewReport {
  if (stored.outcome !== "in-progress") return stored;
  return {
    ...stored,
    outcome: "interrupted",
    stages: stored.stages.map((entry) =>
      entry.status === "running"
        ? { ...entry, status: "failed", reason: "interrupted", message: "The engine stopped while this request was out: it may have been sent." }
        : entry.status === "pending"
          ? { ...entry, status: "skipped", reason: "interrupted", message: "The engine stopped before this request was sent." }
          : entry,
    ),
  };
}
