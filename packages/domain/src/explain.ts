import { z } from "zod";

/**
 * What an explain run produced (NIV-6, NIV-9, D22), as stored in the owning engine's `nivra.db`. Every citation says
 * whether its lines were shown to the model before it answered; that is never proof the claim is right. The result
 * describes the checkout as it was read: "HEAD at run start" plus whatever tracked files held on disk, which may
 * include uncommitted edits. Preference differences name preferences by id and revision only.
 */

export const CitationProblem = z.enum(["file not read", "lines not shown", "file changed during the run", "not a repository path"]);
export type CitationProblem = z.infer<typeof CitationProblem>;

export const CheckedCitation = z.strictObject({
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  checked: z.boolean(),
  problem: CitationProblem.nullable(),
});
export type CheckedCitation = z.infer<typeof CheckedCitation>;

export const ExplainResult = z.strictObject({
  question: z.string(),
  headAtStart: z.string().nullable(),
  /** Different from `headAtStart` when HEAD moved during the run. */
  headAtEnd: z.string().nullable(),
  summary: z.string(),
  findings: z.array(z.strictObject({ statement: z.string(), citations: z.array(CheckedCitation) })),
  preferenceDifferences: z.array(
    z.strictObject({ preferenceId: z.uuid(), revision: z.number().int().positive(), repositoryConvention: z.string(), citations: z.array(CheckedCitation) }),
  ),
  gaps: z.array(z.string()),
  /** What was delivered to the model: never content, only paths, line ranges and hashes. */
  context: z.strictObject({
    map: z.array(z.strictObject({ path: z.string(), sha256: z.string() })),
    reads: z.array(z.strictObject({ path: z.string(), ranges: z.array(z.tuple([z.number().int(), z.number().int()])), sha256: z.array(z.string()) })),
    searches: z.number().int().nonnegative(),
    searchHits: z.number().int().nonnegative(),
    chars: z.number().int().nonnegative(),
    changedFiles: z.array(z.string()),
  }),
  checks: z.strictObject({ citations: z.number().int().nonnegative(), checked: z.number().int().nonnegative() }),
  answeredAtStep: z.number().int().nonnegative(),
  finishedAt: z.iso.datetime(),
});
export type ExplainResult = z.infer<typeof ExplainResult>;
