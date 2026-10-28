import type { Advisory } from "./releases.ts";

/**
 * Versions Nivra withdraws for a named compatibility or security reason (NIV-55), each with what to use instead. Kept by
 * hand, apart from the generated release data, so refreshing the index never loses one. A project whose environment
 * was prepared with a withdrawn version is told so, with the replacement, and asked to prepare again.
 */
export const ADVISORIES: readonly Advisory[] = [];
