import { z } from "zod";
import { PreferenceIntent, PreferenceScope, PreferenceSnapshot } from "./context.ts";
import { CheckedCitation, ExplainConflict, ExplainResult } from "./explain.ts";

/**
 * A conversation's turn (D26): one `chat` run. A general conversation reaches no repository; a repository one reads
 * its project's tracked files with the explain run's tools, and replies keeping what the code does now (evidence),
 * what it proposes and what it assumes apart. The person's message is stored with the run, masked, and never handed
 * to Mastra (D22). The conversation's history travels like the preference snapshot (D21): in the run's context, held
 * in the engine's memory while the run lasts and never stored. The run records counts and a fingerprint of it.
 */

/** The sizes one turn may carry. The host chooses the history within them; the engine checks them again. */
export const CHAT_LIMITS = {
  /** The person's message. */
  messageChars: 8_000,
  /** Exchanges sent, a question and its answer each. */
  historyExchanges: 10,
  /** Characters of history the host sends at most: about 8,000 tokens at the budget's 3 characters per token. */
  historyChars: 24_000,
  /** One message in the history; a longer one is shortened, keeping its start and its end. */
  historyMessageChars: 6_000,
  shortenedHead: 4_500,
  shortenedTail: 1_000,
  /** What the engine accepts for one message in the history, the shortening marker included, and for all of them. */
  historyTextMax: 6_100,
  historyTotalMax: 25_000,
} as const;

export const ChatScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("general") }),
  z.strictObject({ kind: z.literal("repository"), repoPath: z.string().min(1).max(4096) }),
]);
export type ChatScope = z.infer<typeof ChatScope>;

export const ChatInput = z.strictObject({
  message: z.string().trim().min(1).max(CHAT_LIMITS.messageChars),
  scope: ChatScope,
});
export type ChatInput = z.infer<typeof ChatInput>;

/**
 * A chat run's input as the engine reads it back from its store (D23): masked, so only its shape is checked. A mask
 * that leaves it unreadable makes the run fail before any request, never with a default message.
 */
export const StoredChatInput = z.object({
  message: z.string().min(1),
  scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("general") }), z.object({ kind: z.literal("repository"), repoPath: z.string().min(1) })]),
});
export type StoredChatInput = z.infer<typeof StoredChatInput>;

const count = z.number().int().nonnegative();

const HistoryText = z.strictObject({
  text: z.string().min(1).max(CHAT_LIMITS.historyTextMax),
  /** Whether the host shortened it to its start and end. */
  shortened: z.boolean(),
});

/** One earlier question and the answer Nivra gave it. A repository answer arrives as text, its citations left out. */
export const ChatExchange = z.strictObject({ person: HistoryText, nivra: HistoryText });
export type ChatExchange = z.infer<typeof ChatExchange>;

/** What the host left out of the history, and why: older than the window, never answered, or answered with preferences that have changed since. */
export const HistoryOmitted = z.strictObject({ overLimit: count, unanswered: count, preferencesChanged: count });
export type HistoryOmitted = z.infer<typeof HistoryOmitted>;

/** The conversation so far as the host sends it: the most recent exchanges that fit, oldest first. */
export const ChatHistory = z
  .strictObject({
    exchanges: z.array(ChatExchange).max(CHAT_LIMITS.historyExchanges),
    omitted: HistoryOmitted,
  })
  .refine((history) => historyChars(history) <= CHAT_LIMITS.historyTotalMax, "The history is longer than one turn can carry.");
export type ChatHistory = z.infer<typeof ChatHistory>;

export function historyChars(history: { exchanges: ReadonlyArray<{ person: { text: string }; nivra: { text: string } }> }): number {
  return history.exchanges.reduce((sum, exchange) => sum + exchange.person.text.length + exchange.nivra.text.length, 0);
}

/**
 * What a chat run gets besides its input (D21, D26). `sharing` is the project's consent for a repository turn; a
 * general turn carries `modelContext: false`, so nothing from a repository may go with it, and the engine never reads
 * one for it.
 */
export const ChatContext = z.strictObject({
  preferences: PreferenceSnapshot,
  sharing: z.strictObject({ modelContext: z.boolean() }),
  history: ChatHistory,
});
export type ChatContext = z.infer<typeof ChatContext>;

/**
 * A fingerprint of the history as sent: SHA-256, in hex, of the JSON array of `[person, nivra]` texts, oldest first.
 * The host and the engine each work it out, so a run can show the exact history arrived while storing none of it.
 */
export async function historyDigest(history: Pick<ChatHistory, "exchanges">): Promise<string> {
  const canonical = history.exchanges.map((exchange) => [exchange.person.text, exchange.nivra.text]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a run records about the history it was given: counts and the fingerprint, never text. */
export const HistoryRecord = z.strictObject({
  exchanges: count,
  chars: count,
  shortened: count,
  omitted: HistoryOmitted,
  digest: z.string(),
});
export type HistoryRecord = z.infer<typeof HistoryRecord>;

/** The preferences a run received, as recorded: ids, scopes, intents and revisions, the store's revision and the fingerprint. */
export const PreferencesReceived = z.strictObject({
  revision: count,
  digest: z.string(),
  records: z.array(z.strictObject({ id: z.uuid(), scope: PreferenceScope, intent: PreferenceIntent, revision: z.number().int().positive() })),
});
export type PreferencesReceived = z.infer<typeof PreferencesReceived>;

/** A general turn's reply: text only. `cutOff` says the model stopped at the length limit, so the text is incomplete. */
export const GeneralReply = z.strictObject({
  kind: z.literal("general"),
  text: z.string(),
  cutOff: z.boolean(),
  context: z.strictObject({ preferences: PreferencesReceived, history: HistoryRecord }),
  finishedAt: z.iso.datetime(),
});
export type GeneralReply = z.infer<typeof GeneralReply>;

/**
 * A repository turn's reply. Evidence is what the code does now, each statement citing lines; proposals are changes or
 * options, never facts, each citing the current lines it builds on; assumptions are what was taken as true without
 * checking. Every citation says whether its lines were shown to the model in this turn, never more. Conflicts are
 * ranked by the engine (D23). The context view is explain's, plus the history.
 */
export const RepositoryReply = z.strictObject({
  kind: z.literal("repository"),
  answer: z.string(),
  evidence: z.array(z.strictObject({ statement: z.string(), citations: z.array(CheckedCitation) })),
  proposals: z.array(z.strictObject({ title: z.string(), detail: z.string(), citations: z.array(CheckedCitation) })),
  assumptions: z.array(z.string()),
  conflicts: z.array(ExplainConflict),
  gaps: z.array(z.string()),
  headAtStart: z.string().nullable(),
  headAtEnd: z.string().nullable(),
  context: ExplainResult.shape.context.extend({ history: HistoryRecord }),
  checks: z.strictObject({ citations: count, checked: count }),
  answeredAtStep: count,
  finishedAt: z.iso.datetime(),
});
export type RepositoryReply = z.infer<typeof RepositoryReply>;

export const ChatResult = z.discriminatedUnion("kind", [GeneralReply, RepositoryReply]);
export type ChatResult = z.infer<typeof ChatResult>;
