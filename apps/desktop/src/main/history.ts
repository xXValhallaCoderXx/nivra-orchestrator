import { CHAT_LIMITS, historyDigest, type ChatExchange, type ChatHistory, type ChatResult, type HistoryOmitted, type HistoryRecord, type PreferenceSnapshot } from "@nivra/domain";
import type { MessageRecord, TurnRecord } from "./workspace.ts";

/**
 * The conversation so far, as the host chooses it for a new turn (D26). Only answered exchanges go, a question with its
 * answer, and only those whose preferences are all still what they were (D20, D21): an answer given under a preference
 * since edited, replaced or deleted could repeat what it said, so it stays out. The newest that fit within the limits
 * are sent, oldest first, and the window has no gaps but those. What is left out is counted, by reason.
 */

const MARKER = (left: number) => `\n[… ${left} characters left out …]\n`;

/** A message too long for the history keeps its start and its end, and says how much was left out. */
export function shorten(text: string): { text: string; shortened: boolean } {
  if (text.length <= CHAT_LIMITS.historyMessageChars) return { text, shortened: false };
  const left = text.length - CHAT_LIMITS.shortenedHead - CHAT_LIMITS.shortenedTail;
  return { text: `${text.slice(0, CHAT_LIMITS.shortenedHead)}${MARKER(left)}${text.slice(-CHAT_LIMITS.shortenedTail)}`, shortened: true };
}

/**
 * How an earlier answer reads in the history. A repository reply gives its answer, then what it found, proposed and
 * assumed, without citations: its evidence is labelled as checked in that turn only, never as verified now.
 */
export function answerText(reply: ChatResult | null, stored: string): string {
  if (!reply) return stored;
  if (reply.kind === "general") return reply.cutOff ? `${reply.text}\n[This answer was cut off at the length limit.]` : reply.text;
  const parts = [reply.answer];
  if (reply.evidence.length) parts.push(`Earlier evidence (checked in that turn, not re-verified now):\n${reply.evidence.map((item) => `- ${item.statement}`).join("\n")}`);
  if (reply.proposals.length) parts.push(`Proposed:\n${reply.proposals.map((item) => `- ${item.title}`).join("\n")}`);
  if (reply.assumptions.length) parts.push(`Assumed:\n${reply.assumptions.map((item) => `- ${item}`).join("\n")}`);
  return parts.join("\n\n");
}

/** The history for the next turn of a conversation, with what the turn records about it. */
export async function selectHistory(turns: readonly TurnRecord[], messages: readonly MessageRecord[], current: PreferenceSnapshot): Promise<{ history: ChatHistory; record: HistoryRecord }> {
  const revisions = new Map(current.records.map((record) => [record.id, record.revision]));
  const omitted: HistoryOmitted = { overLimit: 0, unanswered: 0, preferencesChanged: 0 };
  const byTurn = new Map(turns.map((turn) => [turn.id, turn]));
  const answers = new Map(messages.filter((m) => m.role === "assistant" && m.turnId).map((m) => [m.turnId!, m]));
  const eligible: ChatExchange[] = [];
  // In the order the person asked.
  for (const question of messages.filter((m) => m.role === "person")) {
    const turn = question.turnId ? byTurn.get(question.turnId) : undefined;
    const answer = question.turnId ? answers.get(question.turnId) : undefined;
    if (!turn || turn.status !== "answered" || !answer) {
      omitted.unanswered++;
      continue;
    }
    if (turn.preferences.some((given) => revisions.get(given.id) !== given.revision)) {
      omitted.preferencesChanged++;
      continue;
    }
    eligible.push({ person: shorten(question.text), nivra: shorten(answerText(answer.reply, answer.text)) });
  }
  const chosen: ChatExchange[] = [];
  let chars = 0;
  for (let index = eligible.length - 1; index >= 0; index--) {
    const exchange = eligible[index]!;
    const size = exchange.person.text.length + exchange.nivra.text.length;
    if (chosen.length >= CHAT_LIMITS.historyExchanges || chars + size > CHAT_LIMITS.historyChars) {
      omitted.overLimit += index + 1;
      break;
    }
    chosen.unshift(exchange);
    chars += size;
  }
  const history: ChatHistory = { exchanges: chosen, omitted };
  const shortened = chosen.reduce((sum, exchange) => sum + (exchange.person.shortened ? 1 : 0) + (exchange.nivra.shortened ? 1 : 0), 0);
  return { history, record: { exchanges: chosen.length, chars, shortened, omitted, digest: await historyDigest(history) } };
}
