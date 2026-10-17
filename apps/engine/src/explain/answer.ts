import { z } from "zod";

/**
 * The shape of an explanation, as the model submits it through the `submit_answer` tool (D22). Citations are
 * structured, an exact repository-relative path and a line range, so the engine can check each one against what it
 * actually delivered, instead of parsing prose. The provider check submits to the same schema, so a successful probe
 * says something about the real answer, not just a toy tool.
 */

export const ANSWER_LIMITS = {
  summaryChars: 4_000,
  statementChars: 1_000,
  conventionChars: 500,
  gapChars: 300,
  findings: 20,
  citations: 8,
  preferenceDifferences: 10,
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

export const AnswerInput = z.object({
  summary: z.string().min(1).max(ANSWER_LIMITS.summaryChars).describe("A short explanation that answers the question, in plain text"),
  findings: z
    .array(
      z.object({
        statement: z.string().min(1).max(ANSWER_LIMITS.statementChars).describe("One fact about the repository"),
        citations: z.array(Citation).max(ANSWER_LIMITS.citations).describe("The lines you read that show it"),
      }),
    )
    .max(ANSWER_LIMITS.findings),
  preferenceDifferences: z
    .array(
      z.object({
        preferenceId: z.uuid().describe("The id of one of the engineer's preferences, exactly as given"),
        repositoryConvention: z.string().min(1).max(ANSWER_LIMITS.conventionChars).describe("What this repository does instead, which wins here"),
        citations: z.array(Citation).max(ANSWER_LIMITS.citations),
      }),
    )
    .max(ANSWER_LIMITS.preferenceDifferences)
    .default([])
    .describe("Where the repository's own conventions differ from the engineer's preferences"),
  gaps: z
    .array(z.string().min(1).max(ANSWER_LIMITS.gapChars))
    .max(ANSWER_LIMITS.gaps)
    .default([])
    .describe("What you could not establish from what you read"),
});
export type AnswerInput = z.infer<typeof AnswerInput>;

export const ANSWER_TOOL_DESCRIPTION =
  "Submit your answer. Call this once, when you have read enough. Cite only lines read_file or search_code showed you in an earlier step: an answer citing other lines is turned down while there is time to read them. The first accepted answer is final.";
