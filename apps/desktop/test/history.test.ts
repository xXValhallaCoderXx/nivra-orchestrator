import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { CHAT_LIMITS, historyDigest, type ChatResult, type PreferenceSnapshot } from "@nivra/domain";
import { answerText, selectHistory, shorten } from "../src/main/history.ts";
import type { MessageRecord, TurnRecord, TurnStatus } from "../src/main/workspace.ts";

const AT = "2026-10-20T10:00:00.000Z";
const PREF = { id: randomUUID(), statement: "Use Vitest", scope: "personal" as const, intent: "default" as const, revision: 2 };
const current: PreferenceSnapshot = { revision: 5, records: [PREF] };

/** A conversation built from [question, answer or null, status, preferences given], in the order asked. */
function conversation(entries: Array<{ q: string; a: string | null; status?: TurnStatus; given?: TurnRecord["preferences"]; reply?: ChatResult }>) {
  const turns: TurnRecord[] = [];
  const messages: MessageRecord[] = [];
  let seq = 0;
  for (const entry of entries) {
    const id = randomUUID();
    turns.push({
      id,
      conversationId: "c",
      sessionId: "s",
      targetId: "local",
      homeId: "h",
      runId: randomUUID(),
      status: entry.status ?? (entry.a === null ? "failed" : "answered"),
      cancelRequested: false,
      cancelReason: null,
      errorKind: null,
      errorMessage: null,
      preferences: entry.given ?? [{ id: PREF.id, revision: PREF.revision }],
      history: null,
      createdAt: AT,
      settledAt: AT,
    });
    messages.push({ id: randomUUID(), conversationId: "c", seq: ++seq, role: "person", text: entry.q, reply: null, turnId: id, createdAt: AT });
    if (entry.a !== null) messages.push({ id: randomUUID(), conversationId: "c", seq: ++seq, role: "assistant", text: entry.a, reply: entry.reply ?? null, turnId: id, createdAt: AT });
  }
  return { turns, messages };
}

describe("the history a turn carries (D26)", () => {
  it("sends answered exchanges, oldest first, each question with its answer", async () => {
    const { turns, messages } = conversation([{ q: "one?", a: "One." }, { q: "two?", a: "Two." }]);
    const { history, record } = await selectHistory(turns, messages, current);
    assert.deepEqual(history.exchanges.map((e) => [e.person.text, e.nivra.text]), [["one?", "One."], ["two?", "Two."]]);
    assert.deepEqual([record.exchanges, record.chars, record.shortened, record.omitted], [2, 16, 0, { overLimit: 0, unanswered: 0, preferencesChanged: 0 }]);
    assert.equal(record.digest, await historyDigest(history));
  });

  it("leaves out unanswered questions, and answers given with a preference since edited or deleted, counting each", async () => {
    const { turns, messages } = conversation([
      { q: "edited since?", a: "Old.", given: [{ id: PREF.id, revision: 1 }] },
      { q: "deleted since?", a: "Gone.", given: [{ id: randomUUID(), revision: 1 }] },
      { q: "failed?", a: null },
      { q: "interrupted?", a: null, status: "interrupted" },
      { q: "kept?", a: "Kept." },
      { q: "no preferences then?", a: "Also kept.", given: [] },
    ]);
    const { history, record } = await selectHistory(turns, messages, current);
    assert.deepEqual(history.exchanges.map((e) => e.person.text), ["kept?", "no preferences then?"]);
    assert.deepEqual(record.omitted, { overLimit: 0, unanswered: 2, preferencesChanged: 2 });
  });

  it("shortens a long message to its start and end, saying how much was left out", () => {
    const text = `${"a".repeat(5_000)}${"b".repeat(3_000)}`;
    const short = shorten(text);
    assert.equal(short.shortened, true);
    assert.ok(short.text.startsWith("a".repeat(CHAT_LIMITS.shortenedHead)) && short.text.endsWith("b".repeat(CHAT_LIMITS.shortenedTail)));
    assert.match(short.text, /\[… 2500 characters left out …\]/);
    assert.ok(short.text.length <= CHAT_LIMITS.historyTextMax);
    assert.deepEqual(shorten("fits"), { text: "fits", shortened: false });
  });

  it("keeps the newest exchanges that fit, at most ten and 24,000 characters, with no gap, counting the rest", async () => {
    const many = conversation(Array.from({ length: 13 }, (_, i) => ({ q: `q${i}`, a: `a${i}` })));
    const ten = await selectHistory(many.turns, many.messages, current);
    assert.deepEqual([ten.history.exchanges.length, ten.history.exchanges[0]?.person.text, ten.history.exchanges.at(-1)?.person.text, ten.record.omitted.overLimit], [10, "q3", "q12", 3]);
    // Each long answer shortens to about 5,540 characters, so four exchanges fit and the oldest goes.
    const long = conversation(Array.from({ length: 5 }, (_, i) => ({ q: `long ${i}`, a: "x".repeat(9_000) })));
    const fitted = await selectHistory(long.turns, long.messages, current);
    assert.deepEqual([fitted.history.exchanges.map((e) => e.person.text), fitted.record.omitted.overLimit, fitted.record.shortened], [["long 1", "long 2", "long 3", "long 4"], 1, 4]);
    assert.ok(fitted.record.chars <= CHAT_LIMITS.historyChars);
  });

  it("gives a repository answer's evidence as checked in its own turn only, without citations", () => {
    const reply = {
      kind: "repository",
      answer: "Add a button.",
      evidence: [{ statement: "Components are kebab-case.", citations: [{ path: "README.md", startLine: 2, endLine: 2, checked: true, problem: null }] }],
      proposals: [{ title: "Add export-button.tsx", detail: "…", citations: [] }],
      assumptions: ["Exports start from the list."],
    } as unknown as ChatResult;
    const text = answerText(reply, "Add a button.");
    assert.equal(text, "Add a button.\n\nEarlier evidence (checked in that turn, not re-verified now):\n- Components are kebab-case.\n\nProposed:\n- Add export-button.tsx\n\nAssumed:\n- Exports start from the list.");
    assert.ok(!text.includes("README.md"));
    assert.equal(answerText({ kind: "general", text: "Partial", cutOff: true } as unknown as ChatResult, "Partial"), "Partial\n[This answer was cut off at the length limit.]");
  });
});
