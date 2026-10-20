import { z } from "zod";

/**
 * The shape of an explanation, as the model submits it through the `submit_answer` tool (D22). Citations are
 * structured, an exact repository-relative path and a line range, so the engine can check each one against what it
 * actually delivered, instead of parsing prose. The provider check submits to the same schema, so a successful probe
 * says something about the real answer, not just a toy tool.
 *
 * Conflicts and suggestions (D23) are flat and lenient on purpose. Whatever the schema refuses never reaches Nivra, so
 * it can't be dropped from an answer that is due, and it costs one of the answer steps. So ids are plain strings and
 * citations default to none; the engine checks ids, sources and citations itself.
 */

export const ANSWER_LIMITS = {
  summaryChars: 4_000,
  statementChars: 1_000,
  topicChars: 200,
  conventionChars: 500,
  /** A preference's own limit, so a kept suggestion always fits. */
  suggestionChars: 500,
  gapChars: 300,
  idChars: 64,
  findings: 20,
  citations: 8,
  conflicts: 10,
  /** Preference ids, and choice ids, per conflict. */
  conflictIds: 5,
  suggestions: 5,
  gaps: 10,
  pathChars: 500,
} as const;

export const Citation = z
  .object({
    path: z.string().min(1).max(ANSWER_LIMITS.pathChars).describe("The file's path, exactly as the tools showed it, relative to the repository"),
    startLine: z.number().int().min(1).describe("The first cited line, as numbered in what you read"),
    endLine: z.number().int().min(1).describe("The last cited line; the same as startLine for one line"),
  })
  .refine((citation) => citation.endLine >= citation.startLine, "endLine must not come before startLine.");
export type Citation = z.infer<typeof Citation>;

const Ids = (description: string) => z.array(z.string().min(1).max(ANSWER_LIMITS.idChars)).max(ANSWER_LIMITS.conflictIds).default([]).describe(description);

export const AnswerConflict = z.object({
  topic: z.string().min(1).max(ANSWER_LIMITS.topicChars).describe('What the sources disagree about, in a few words, such as "test runner"'),
  repositoryConvention: z
    .string()
    .max(ANSWER_LIMITS.conventionChars)
    .nullable()
    .default(null)
    .describe("What this repository does now, from lines you read; null when it has no convention on this"),
  citations: z.array(Citation).max(ANSWER_LIMITS.citations).default([]).describe("The lines you read that show the repository's convention"),
  preferenceIds: Ids("The ids of the engineer's preferences on this topic, exactly as given"),
  choiceIds: Ids("The ids of this task's choices on this topic, such as c1"),
});
export type AnswerConflict = z.infer<typeof AnswerConflict>;

export const AnswerInput = z.object({
  summary: z.string().trim().min(1).max(ANSWER_LIMITS.summaryChars).describe("A short explanation that answers the question, in plain text"),
  // A missing list defaults to none, so the answer reaches the gate, which asks for findings once (NIV-26): refused by
  // the schema instead, an answer that is due would be lost, and with it its conflicts and suggestions.
  findings: z
    .array(
      z.object({
        statement: z.string().trim().min(1).max(ANSWER_LIMITS.statementChars).describe("One fact about the repository"),
        citations: z.array(Citation).max(ANSWER_LIMITS.citations).describe("The lines you read that show it"),
      }),
    )
    .max(ANSWER_LIMITS.findings)
    .default([])
    .describe("Each fact you established from what you read, with the lines that show it. Leave it empty only when what you read established nothing, and say why in gaps"),
  conflicts: z
    .array(AnswerConflict)
    .max(ANSWER_LIMITS.conflicts)
    .default([])
    .describe("Where the repository, the engineer's preferences and this task's choices disagree, one topic each"),
  suggestions: z
    .array(
      z.object({
        statement: z.string().min(1).max(ANSWER_LIMITS.suggestionChars).describe("A convention this repository follows, worded as a preference the engineer could keep"),
        citations: z.array(Citation).max(ANSWER_LIMITS.citations).default([]).describe("The lines you read that show it"),
      }),
    )
    .max(ANSWER_LIMITS.suggestions)
    .default([])
    .describe("Each convention your findings show this repository follows, worded as a preference the engineer could keep for this project, with the lines that show it"),
  gaps: z
    .array(z.string().min(1).max(ANSWER_LIMITS.gapChars))
    .max(ANSWER_LIMITS.gaps)
    .default([])
    .describe("What you could not establish from what you read"),
});
export type AnswerInput = z.infer<typeof AnswerInput>;

export const ANSWER_TOOL_DESCRIPTION =
  "Submit your answer. Call this once, when you have read enough. Cite only lines read_file or search_code showed you in an earlier step, and name only the preference and choice ids you were given: an answer that doesn't is turned down while there is time to fix it, and so, once, is an answer with no findings. The first accepted answer is final.";

/**
 * What an answer with no findings is told, once (NIV-26): the shape a finding takes, and that inventing one is worse
 * than saying nothing was established.
 */
export const NO_FINDINGS =
  'findings: your answer has none. Give each fact you established as {"statement": "<one fact about the repository>", "citations": [{"path": "<the path as the tools showed it>", "startLine": <first line>, "endLine": <last line>}]}, citing only lines read_file or search_code showed you, then submit the whole answer again. Don\'t invent one: if what you read established nothing, submit it again with findings: [] and say why in gaps.';
