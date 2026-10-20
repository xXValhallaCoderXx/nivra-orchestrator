import type { Mask } from "@nivra/domain";
import { ChatUnreadable } from "../chat/task.ts";
import { BOUNDARY_UNAVAILABLE_MESSAGE, EXEC_REFUSED_MESSAGE, Refusal, safeClass } from "../diagnostics.ts";
import { BoundaryUnavailableError, ExecRefusedError } from "../exec/backend.ts";
import { TaskUnreadable } from "../explain/task.ts";
import { failure, ModelFailure } from "../providers/model.ts";
import { RepoCancelled } from "../repo/git.ts";
import { RepoError } from "../repo/paths.ts";
import { ReviewUnreadable } from "../review/task.ts";

/**
 * What a workflow step may throw (NIV-27): a failure in Nivra's own words. Mastra stores a step's error as it is, so
 * this is the last point where an error's own text can be kept out of `mastra.db`, the run store and the app. A failure
 * Nivra wrote keeps its message, masked once more; an execution boundary's error, whose text can quote a spawn error or
 * a path, becomes a fixed refusal; anything else becomes `internal`, named at most by an allowlisted class, with the
 * facts a diagnostic needs.
 */
export function publicError(error: unknown, stage: string, mask: Mask): Error {
  if (
    error instanceof ModelFailure ||
    error instanceof TaskUnreadable ||
    error instanceof ChatUnreadable ||
    error instanceof ReviewUnreadable ||
    error instanceof Refusal ||
    error instanceof RepoError ||
    error instanceof RepoCancelled
  ) {
    error.message = mask(error.message);
    return error;
  }
  if (error instanceof ExecRefusedError) return new Refusal("exec-refused", EXEC_REFUSED_MESSAGE);
  if (error instanceof BoundaryUnavailableError) return new Refusal("boundary-unavailable", BOUNDARY_UNAVAILABLE_MESSAGE);
  return failure("internal", safeClass(error) ?? "").because("unexpected-error", stage, error);
}

/** Runs a step's body, making whatever it throws public as `publicError` says. `stage` names the step in a diagnostic. */
export async function guard<R>(stage: string, mask: Mask, body: () => Promise<R>): Promise<R> {
  try {
    return await body();
  } catch (error) {
    throw publicError(error, stage, mask);
  }
}
