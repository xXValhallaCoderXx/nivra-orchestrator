import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_LIMITS, ChatContext, ChatHistory, ChatInput, historyDigest, StoredChatInput } from "../src/chat.ts";
import { StartRunParams } from "../src/methods.ts";

const omitted = { overLimit: 0, unanswered: 0, preferencesChanged: 0 };
const exchange = (person: string, nivra: string) => ({ person: { text: person, shortened: false }, nivra: { text: nivra, shortened: false } });

describe("a conversation's turn (D26)", () => {
  it("takes a trimmed message of 1 to 8,000 characters, and a general or repository scope", () => {
    assert.deepEqual(ChatInput.parse({ message: "  plan it  ", scope: { kind: "general" } }), { message: "plan it", scope: { kind: "general" } });
    assert.equal(ChatInput.safeParse({ message: "   ", scope: { kind: "general" } }).success, false);
    assert.equal(ChatInput.safeParse({ message: "x".repeat(CHAT_LIMITS.messageChars + 1), scope: { kind: "general" } }).success, false);
    assert.equal(ChatInput.safeParse({ message: "x", scope: { kind: "repository" } }).success, false, "a repository scope names its folder");
    assert.equal(ChatInput.safeParse({ message: "x", scope: { kind: "general", repoPath: "/r" } }).success, false, "a general scope reaches no folder");
  });

  it("reads a stored message back by its shape only, since masking can lengthen it (D23)", () => {
    assert.equal(StoredChatInput.safeParse({ message: "x".repeat(CHAT_LIMITS.messageChars + 50), scope: { kind: "general" } }).success, true);
    assert.equal(StoredChatInput.safeParse(null).success, false);
  });

  it("caps the history at ten exchanges and 25,000 characters, each message at 6,100, and the engine checks it again", () => {
    assert.equal(ChatHistory.safeParse({ exchanges: Array.from({ length: 10 }, () => exchange("q", "a")), omitted }).success, true);
    assert.equal(ChatHistory.safeParse({ exchanges: Array.from({ length: 11 }, () => exchange("q", "a")), omitted }).success, false);
    assert.equal(ChatHistory.safeParse({ exchanges: [exchange("q", "a".repeat(CHAT_LIMITS.historyTextMax + 1))], omitted }).success, false);
    const long = Array.from({ length: 5 }, () => exchange("q".repeat(6_000), "a".repeat(6_000)));
    assert.equal(ChatHistory.safeParse({ exchanges: long, omitted }).success, false, "60,000 characters is more than a turn can carry");
  });

  it("gives the same fingerprint for the same history, and a different one when anything in it changes or moves", async () => {
    const a = { exchanges: [exchange("first", "one"), exchange("second", "two")] };
    const same = await historyDigest(a);
    assert.equal(await historyDigest({ exchanges: [exchange("first", "one"), exchange("second", "two")] }), same);
    assert.notEqual(await historyDigest({ exchanges: [exchange("second", "two"), exchange("first", "one")] }), same);
    assert.notEqual(await historyDigest({ exchanges: [exchange("first", "one!"), exchange("second", "two")] }), same);
    assert.match(same, /^[0-9a-f]{64}$/);
  });

  it("starts a chat run only with a chat context, and hello and explain only with their own", () => {
    const preferences = { revision: 0, records: [] };
    const history = { exchanges: [], omitted };
    const chat = { clientRequestId: "11111111-1111-4111-8111-111111111111", workflowId: "chat", input: { message: "hi", scope: { kind: "general" } } };
    assert.equal(StartRunParams.safeParse({ ...chat, context: { preferences, sharing: { modelContext: false }, history } }).success, true);
    assert.equal(StartRunParams.safeParse({ ...chat, context: { preferences, sharing: { modelContext: false } } }).success, false, "a turn always says what history it carries");
    const hello = { clientRequestId: chat.clientRequestId, workflowId: "hello", input: { repoPath: "/r" } };
    assert.equal(StartRunParams.safeParse({ ...hello, context: { preferences, sharing: { modelContext: false }, history } }).success, false, "hello is never handed a conversation");
    assert.equal(ChatContext.safeParse({ preferences, sharing: { modelContext: true }, history }).success, true);
  });
});
