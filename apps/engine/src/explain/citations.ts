import type { Citation } from "./answer.ts";
import { mergeRanges, type LedgerEntry } from "./ledger.ts";
import { checkRelativePath } from "../repo/paths.ts";

/**
 * Checks an answer's citations against what the run delivered (D22), adapted from Hird's `projects/citations.ts` @
 * 45c0057: structured citations instead of prose, exact paths (no suffix matching), and only what was delivered
 * before the answer. A checked citation means the cited lines were shown to the model; it does not prove the claim.
 */

export type CitationProblem = "file not read" | "lines not shown" | "file changed during the run" | "not a repository path";

export interface CheckedCitation {
  path: string;
  startLine: number;
  endLine: number;
  checked: boolean;
  problem: CitationProblem | null;
}

export function checkCitation(citation: Citation, ledger: readonly LedgerEntry[], answerStep: number): CheckedCitation {
  const base = { startLine: citation.startLine, endLine: citation.endLine };
  let path: string;
  try {
    path = checkRelativePath(citation.path);
  } catch {
    return { path: citation.path, ...base, checked: false, problem: "not a repository path" };
  }
  const all = ledger.filter((entry) => entry.path === path);
  // A file seen with two different hashes changed while the run read it: no citation into it can be checked.
  if (new Set(all.map((entry) => entry.sha256)).size > 1) return { path, ...base, checked: false, problem: "file changed during the run" };
  // Lines count only when a read or a search hit delivered them, before the step that gave the answer.
  const shown = all.filter((entry) => entry.step < answerStep && (entry.kind === "read" || entry.kind === "search"));
  if (shown.length === 0) return { path, ...base, checked: false, problem: "file not read" };
  const covered = mergeRanges(shown.map((entry) => [entry.startLine, entry.endLine] as const));
  const inside = covered.some(([start, end]) => start <= citation.startLine && citation.endLine <= end);
  return { path, ...base, checked: inside, problem: inside ? null : "lines not shown" };
}
