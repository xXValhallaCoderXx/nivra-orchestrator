import { z } from "zod";
import { PreferenceIntent, PreferenceScope } from "./context.ts";

/**
 * What an explain run produced (NIV-6, NIV-9, D22), as stored in the owning engine's `nivra.db`. Every citation says
 * whether its lines were shown to the model before it answered; that is never proof the claim is right. The result
 * describes the checkout as it was read: "HEAD at run start" plus whatever tracked files held on disk, which may
 * include uncommitted edits. Conflicts name preferences by id and revision only (D23). Every field added after
 * protocol 3 has a default, so results stored before it still read.
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

/**
 * Where one side of a conflict comes from, highest rank first (D23): this task's choices, a project's decisions to
 * change its conventions, the repository's own conventions (only with lines shown to the model), a project's
 * defaults, then personal defaults.
 */
export const ConflictSource = z.enum(["choice", "override", "repository", "project-default", "personal-default"]);
export type ConflictSource = z.infer<typeof ConflictSource>;

/** Why a conflict came out as it did: the governing source's kind, or `unresolved` when two sources tie at the top. */
export const ConflictOutcome = z.enum([...ConflictSource.options, "unresolved"]);
export type ConflictOutcome = z.infer<typeof ConflictOutcome>;

/**
 * One conflict the model reported, ranked by the engine (D23). `repositoryConvention` is what the code does now, as the
 * model reported it; it counts as a source only when one of its citations was shown to the model. `governs` decides
 * the task's intended work, never what the code is said to do.
 */
export const ExplainConflict = z.strictObject({
  topic: z.string(),
  repositoryConvention: z.string().nullable(),
  citations: z.array(CheckedCitation),
  preferences: z.array(z.strictObject({ id: z.uuid(), revision: z.number().int().positive(), scope: PreferenceScope, intent: PreferenceIntent })),
  /** Choice ids, `c1` to `c5`. */
  choices: z.array(z.string()),
  /** The source that governs, with its preference or choice id (null for the repository); null when unresolved. */
  governs: z.strictObject({ source: ConflictSource, id: z.string().nullable() }).nullable(),
  reason: ConflictOutcome,
});
export type ExplainConflict = z.infer<typeof ExplainConflict>;

export const ExplainResult = z.strictObject({
  question: z.string(),
  /** The task's choices as the run read them, with the ids the model and the conflicts use. */
  choices: z.array(z.strictObject({ id: z.string(), text: z.string() })).default([]),
  headAtStart: z.string().nullable(),
  /** Different from `headAtStart` when HEAD moved during the run. */
  headAtEnd: z.string().nullable(),
  summary: z.string(),
  findings: z.array(z.strictObject({ statement: z.string(), citations: z.array(CheckedCitation) })),
  conflicts: z.array(ExplainConflict).default([]),
  /** Conventions the model proposes as preferences, each kept only with lines shown to it. Never saved by the engine. */
  suggestions: z.array(z.strictObject({ statement: z.string(), citations: z.array(CheckedCitation) })).default([]),
  /** Protocol 3's differences from preferences; new results leave it empty and report conflicts instead. */
  preferenceDifferences: z
    .array(z.strictObject({ preferenceId: z.uuid(), revision: z.number().int().positive(), repositoryConvention: z.string(), citations: z.array(CheckedCitation) }))
    .default([]),
  gaps: z.array(z.string()),
  /** What was delivered to the model: never content, only paths, line ranges and hashes. */
  context: z.strictObject({
    map: z.array(z.strictObject({ path: z.string(), sha256: z.string() })),
    reads: z.array(z.strictObject({ path: z.string(), ranges: z.array(z.tuple([z.number().int(), z.number().int()])), sha256: z.array(z.string()) })),
    /** The lines search results showed, by file: results stored before these were kept read as none. */
    hits: z.array(z.strictObject({ path: z.string(), ranges: z.array(z.tuple([z.number().int(), z.number().int()])), sha256: z.array(z.string()) })).default([]),
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
