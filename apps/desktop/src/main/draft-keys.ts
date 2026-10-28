import type { SecretName } from "@nivra/domain";

/**
 * Whether a draft holds one of the API keys Nivra keeps (NIV-56; Nate, 29 Oct): the window's drafts are checked against
 * them before they are kept on this computer, on top of the recognised credential formats it checks itself. The values
 * come from the secret store's strict read (`draftCheckValues`), which throws when a key or the file can't be read: a
 * draft is then unchecked, never taken as clean. Plain Node, so node --test drives it.
 */

/** The saved API keys a draft is checked against. Not the Nebius project ID: it isn't a key. */
export const DRAFT_KEY_NAMES: readonly SecretName[] = ["NEBIUS_API_KEY", "TAVILY_API_KEY"];

/** Fixed words, holding neither a draft nor a key, for a check that couldn't be made. */
export const DRAFT_CHECK_FAILED = "Nivra couldn't read one of your saved keys, so the draft wasn't checked against them.";

/**
 * True only when `text` holds a whole saved key's value, anywhere, with other text around it or not. A part of a key
 * never matches, and an empty one is ignored. Only the answer leaves: never a key, a fragment or where it was.
 */
export function containsSavedKey(text: string, values: readonly string[]): boolean {
  return values.some((value) => value.length > 0 && text.includes(value));
}
