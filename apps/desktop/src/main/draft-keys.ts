import type { SecretName } from "@nivra/domain";
import type { KeyState } from "./secret-store.ts";

/**
 * Whether a draft holds one of the API keys Nivra keeps (NIV-56; Nate, 29 Oct): the window's drafts are checked against
 * them before they are kept on this computer, on top of the recognised credential formats it checks itself. Plain Node,
 * so node --test drives it.
 */

/** The saved API keys a draft is checked against. Not the Nebius project ID: it isn't a key. */
export const DRAFT_KEY_NAMES: readonly SecretName[] = ["NEBIUS_API_KEY", "TAVILY_API_KEY"];

/** A saved key as the store has it: its state, and its value when there is one to read. */
export interface SavedKey {
  state: KeyState;
  value: string | null;
}

/** Fixed words, holding neither a draft nor a key, for a check that couldn't be made. */
export const DRAFT_CHECK_FAILED = "Nivra couldn't read one of your saved keys, so the draft wasn't checked against them.";

/**
 * True only when `text` holds a whole saved key's value, anywhere, with other text around it or not. A part of a key
 * never matches, and an empty one is ignored. A key that can't be read makes the check fail (it throws): a draft is
 * then unchecked, never taken as clean. Only the answer leaves: never a key, a fragment or where it was.
 */
export function containsSavedKey(text: string, keys: readonly SavedKey[]): boolean {
  if (keys.some((key) => key.state === "unreadable")) throw new Error(DRAFT_CHECK_FAILED);
  return keys.some((key) => key.value !== null && key.value.length > 0 && text.includes(key.value));
}
