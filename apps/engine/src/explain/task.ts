import { StoredExplainInput } from "@nivra/domain";

/**
 * An explain run's task as the engine reads it back from its store (D23): the question, and the person's choices with
 * the ids the model and the result use (`c1` to `c5`, in the order given). The store keeps the input masked as one
 * text, which also catches a key split across two fields (D22). Masking can lengthen text or make two choices the
 * same, so only the shape is checked here; a mask that spans fields can leave text that no longer reads, and then
 * there is no task, never a default one.
 */
export interface ExplainTask {
  repoPath: string;
  question: string;
  choices: Array<{ id: string; text: string }>;
}

export function readTask(input: unknown): ExplainTask | null {
  const parsed = StoredExplainInput.safeParse(input);
  if (!parsed.success) return null;
  return { repoPath: parsed.data.repoPath, question: parsed.data.question, choices: parsed.data.choices.map((text, index) => ({ id: `c${index + 1}`, text })) };
}

/**
 * A stored task that can't be read back. Its message is Nivra's own, never the input or a parser's text: Mastra keeps
 * step errors as they are. The scheduler records its kind with the failure.
 */
export class TaskUnreadable extends Error {
  readonly kind = "internal";

  constructor() {
    super(
      "Nivra couldn't read this run's question and choices back from its store, so it didn't start. That happens when they hold text that looks like a key, which Nivra masks before storing it. Remove that text, then explain again.",
    );
    this.name = "TaskUnreadable";
  }
}
