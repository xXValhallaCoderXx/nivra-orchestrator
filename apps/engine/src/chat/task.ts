import { StoredChatInput } from "@nivra/domain";

/**
 * A conversation's turn as the engine reads it back from its store (D23, D26): the person's message and the
 * conversation's scope. The store keeps it masked, so only its shape is checked; a mask that leaves it unreadable means
 * there is no turn, never a default one.
 */
export type ChatTask = StoredChatInput;

export function readChatTask(input: unknown): ChatTask | null {
  const parsed = StoredChatInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** A stored message that can't be read back. Its message is Nivra's own, never the input or a parser's text. */
export class ChatUnreadable extends Error {
  readonly kind = "internal";

  constructor() {
    super(
      "Nivra couldn't read this message back from its store, so nothing was sent to the model. That happens when it holds text that looks like a key, which Nivra masks before storing it. Remove that text, then send it again.",
    );
    this.name = "ChatUnreadable";
  }
}
