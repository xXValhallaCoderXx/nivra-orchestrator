import { z } from "zod";
import { AnswerConflict, Citation } from "../explain/answer.ts";

/**
 * A repository conversation's reply, as the model submits it through `submit_reply` (D26). It keeps three things
 * apart: evidence (what the code does now, each statement citing lines read in this turn), proposals (changes or
 * options, never facts, each citing the current lines it builds on when there are any) and assumptions (what was taken
 * as true without checking). Lenient on purpose, like explain's answer (D23): only the reply itself is required and
 * every list defaults to empty, so a list the model leaves out never costs an answer step. The engine checks ids,
 * sources and citations itself.
 */

export const REPLY_LIMITS = {
  answerChars: 6_000,
  statementChars: 1_000,
  titleChars: 200,
  detailChars: 2_000,
  assumptionChars: 300,
  gapChars: 300,
  evidence: 20,
  proposals: 10,
  assumptions: 10,
  gaps: 10,
  citations: 8,
  conflicts: 10,
} as const;

export const ReplyInput = z.object({
  answer: z.string().min(1).max(REPLY_LIMITS.answerChars).describe("Your reply to the engineer, in plain text"),
  evidence: z
    .array(
      z.object({
        statement: z.string().min(1).max(REPLY_LIMITS.statementChars).describe("One fact about what the code does now"),
        citations: z.array(Citation).max(REPLY_LIMITS.citations).default([]).describe("The lines you read in this turn that show it"),
      }),
    )
    .max(REPLY_LIMITS.evidence)
    .default([])
    .describe("What the code does now, each statement citing lines you read in this turn"),
  proposals: z
    .array(
      z.object({
        title: z.string().min(1).max(REPLY_LIMITS.titleChars).describe("The change, or the option, in a few words"),
        detail: z.string().min(1).max(REPLY_LIMITS.detailChars).describe("What it involves and why, in plain text"),
        citations: z.array(Citation).max(REPLY_LIMITS.citations).default([]).describe("The current lines it builds on or would change, read in this turn"),
      }),
    )
    .max(REPLY_LIMITS.proposals)
    .default([])
    .describe("Changes you propose, or options to compare: never facts about the code"),
  assumptions: z
    .array(z.string().min(1).max(REPLY_LIMITS.assumptionChars))
    .max(REPLY_LIMITS.assumptions)
    .default([])
    .describe("What you took as true without checking it"),
  conflicts: z
    .array(AnswerConflict)
    .max(REPLY_LIMITS.conflicts)
    .default([])
    .describe("Where the repository and the engineer's preferences disagree, one topic each"),
  gaps: z
    .array(z.string().min(1).max(REPLY_LIMITS.gapChars))
    .max(REPLY_LIMITS.gaps)
    .default([])
    .describe("What you could not establish from what you read"),
});
export type ReplyInput = z.infer<typeof ReplyInput>;

export const REPLY_TOOL_DESCRIPTION =
  "Submit your reply. Call this once, when you have read enough. Keep evidence, proposals and assumptions apart. Evidence cites only lines read_file or search_code showed you in an earlier step of this turn; name only the preference ids you were given. A reply that doesn't is turned down while there is time to fix it. The first accepted reply is final.";
