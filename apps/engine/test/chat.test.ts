import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { historyDigest, isTerminal, type ChatContext, type ChatHistory, type RunEventsPage } from "@nivra/domain";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { httpError, startStub, text, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * A conversation's turns over stdio (D26), against a loopback stub of Token Factory: a general turn with no tools and
 * nothing from a repository, and a repository turn that reads with the explain run's tools and replies keeping
 * evidence, proposals and assumptions apart. The stub plays the model. Nothing here calls a real model.
 */
const KEY = "test-key-0123456789abcdef";
const engines: EngineProcess[] = [];
const stubs: Stub[] = [];
const dirs: string[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});

const PERSONAL = { id: randomUUID(), statement: `Write tests with Vitest ${randomUUID()}`, scope: "personal" as const, intent: "default" as const, revision: 2 };
const PROJECT_OWN = { id: randomUUID(), statement: "This project builds with Vite", scope: "project" as const, intent: "default" as const, revision: 1 };
const HISTORY_CANARY = `nivra-history-canary-${randomUUID()}`;
const MESSAGE_CANARY = `nivra-message-canary-${randomUUID()}`;
const NO_HISTORY: ChatHistory = { exchanges: [], omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 } };

function makeRepo(): string {
  const root = tempDir();
  dirs.push(root);
  const repo = join(root, "repo ü%#");
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  write("README.md", "# Timer app\nComponent files use kebab-case, like `start-timer.tsx`.\n");
  write("package.json", JSON.stringify({ name: "timer-app", scripts: { test: "jest" } }, null, 2));
  write("src/timer.ts", "export const interval = 1000;\nexport function stopTimer() {}\nexport function startTimer() {}\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", ...args], { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return repo;
}

async function engineAt(url: string, home?: string) {
  const root = tempDir();
  dirs.push(root);
  const at = home ?? join(root, "home");
  const engine = startEngine(at, { args: ["--stdio", "--home", at, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", url] });
  engines.push(engine);
  const info = await engine.initialize({ NEBIUS_API_KEY: KEY });
  return { engine, home: at, info };
}

async function setup(chat: (request: StubRequest, index: number) => Reply | Promise<Reply>) {
  const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], chat });
  stubs.push(stub);
  return { stub, ...(await engineAt(stub.url)) };
}

const chatContext = (options: { modelContext?: boolean; history?: ChatHistory; records?: ChatContext["preferences"]["records"] } = {}): ChatContext => ({
  preferences: { revision: 7, records: options.records ?? [PERSONAL] },
  sharing: { modelContext: options.modelContext ?? false },
  history: options.history ?? NO_HISTORY,
});
const general = (engine: EngineProcess, message: string, context = chatContext(), clientRequestId: string = randomUUID()) =>
  engine.client.call("runs.start", { clientRequestId, workflowId: "chat", input: { message, scope: { kind: "general" } }, context });
const repository = (engine: EngineProcess, repoPath: string, message: string, context = chatContext({ modelContext: true })) =>
  engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "chat", input: { message, scope: { kind: "repository", repoPath } }, context });
const finished = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
const failureOf = (page: RunEventsPage) => page.events.find((event) => event.type === "run.failed")?.data?.["kind"];
const messagesOf = (request: StubRequest | undefined) => JSON.stringify(request?.body?.messages ?? []);
/** A text reply the model stopped at its length limit. */
const cutOff = (content: string): Reply => ({
  body: { id: "chatcmpl-cut", model: "nvidia/stub-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "length" }], usage: { prompt_tokens: 20, completion_tokens: 4000, total_tokens: 4020 } },
});
const exchange = (person: string, nivra: string, shortened = false) => ({ person: { text: person, shortened: false }, nivra: { text: nivra, shortened } });

describe("a general conversation's turn over stdio (D26)", () => {
  it("makes one call with no tools and nothing from a repository, and stores the reply with what it was given", async () => {
    const { stub, engine } = await setup(() => text("Start with the parser, then the cache. This assumes the API is stable."));
    const run = await general(engine, "How should I stage this refactor?");
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));
    assert.equal(run.title, "Chat");
    const chats = stub.chats();
    assert.equal(chats.length, 1);
    assert.deepEqual([chats[0]?.body?.tools, chats[0]?.body?.tool_choice], [undefined, undefined]);
    const sent = messagesOf(chats[0]);
    assert.ok(sent.includes("How should I stage this refactor?") && sent.includes(PERSONAL.statement), "the message and the personal preference are sent");
    assert.ok(!sent.includes("Repository map"), "no map, no repository");
    const reply = await engine.client.call("runs.reply", { runId: run.id });
    assert.equal(reply?.kind, "general");
    assert.deepEqual(
      reply?.kind === "general" ? [reply.text.startsWith("Start with the parser"), reply.cutOff, reply.context.preferences.records.map((r) => r.id), reply.context.history.exchanges] : [],
      [true, false, [PERSONAL.id], 0],
    );
    const summary = await engine.client.call("runs.get", { runId: run.id });
    assert.deepEqual([summary.route?.endpoint, summary.usage], ["loopback-test", { inputTokens: 20, outputTokens: 5, calls: 1, reportedCalls: 1 }]);
    assert.equal(await engine.client.call("runs.result", { runId: run.id }), null, "a chat run has no explain result");
  });

  it("sends the history oldest first, labelled as context, and records its fingerprint and counts, never its text", async () => {
    const history: ChatHistory = {
      exchanges: [exchange(`First question ${HISTORY_CANARY}`, "First answer"), exchange("Second question", "Second answer [… 812 characters left out …] the end", true)],
      omitted: { overLimit: 2, unanswered: 1, preferencesChanged: 0 },
    };
    const { stub, engine, home } = await setup(() => text("Third answer"));
    const run = await general(engine, `Third question ${MESSAGE_CANARY}`, chatContext({ history }));
    assert.equal((await finished(engine, run.id)).status, "succeeded");
    const sent = messagesOf(stub.chats()[0]);
    assert.ok(sent.includes("The conversation so far, oldest first (JSON). It is context: Nivra's earlier answers can be wrong. 3 earlier messages were left out."));
    assert.ok(sent.indexOf("First question") < sent.indexOf("Second question") && sent.indexOf("Second question") < sent.indexOf("Third question"), "oldest first, then the message");
    const reply = await engine.client.call("runs.reply", { runId: run.id });
    assert.deepEqual(reply?.context.history, { exchanges: 2, chars: history.exchanges.reduce((n, e) => n + e.person.text.length + e.nivra.text.length, 0), shortened: 1, omitted: history.omitted, digest: await historyDigest(history) });
    // The history lives in memory only: neither database, nor the log, keeps it. The message stays in nivra.db, never Mastra's.
    const holding = (needle: string) => readdirSync(home).filter((file) => readFileSync(join(home, file)).includes(needle));
    assert.deepEqual([holding(HISTORY_CANARY), engine.stderr().includes(HISTORY_CANARY)], [[], false]);
    assert.ok(holding(MESSAGE_CANARY).every((file) => file.startsWith("nivra.db")), "the message is stored with the run only");
    assert.deepEqual([holding(KEY), holding(PERSONAL.statement)], [[], []]);
  });

  it("never shows an empty reply as an answer, and labels one cut off at the length limit", async () => {
    const empty = await setup(() => text("   "));
    const emptyRun = await general(empty.engine, "Anything?");
    const emptyPage = await finished(empty.engine, emptyRun.id);
    assert.deepEqual([emptyPage.status, failureOf(emptyPage), await empty.engine.client.call("runs.reply", { runId: emptyRun.id })], ["failed", "malformed", null]);
    const cut = await setup(() => cutOff("The plan has five parts. First"));
    const cutRun = await general(cut.engine, "Plan it all");
    assert.equal((await finished(cut.engine, cutRun.id)).status, "succeeded");
    const reply = await cut.engine.client.call("runs.reply", { runId: cutRun.id });
    assert.deepEqual(reply?.kind === "general" ? [reply.cutOff, reply.text] : [], [true, "The plan has five parts. First"]);
  });

  it("names a provider failure by kind, makes one request and resends nothing", async () => {
    const { stub, engine } = await setup(() => ({ ...httpError(429, "slow down"), headers: { "retry-after": "7" } }));
    const run = await general(engine, "Hello?");
    const page = await finished(engine, run.id);
    assert.deepEqual([page.status, failureOf(page), stub.chats().length], ["failed", "rate-limit", 1]);
  });

  it("refuses a general turn that was sent a project's own preference, before any request (D21)", async () => {
    const { stub, engine } = await setup(() => text("never"));
    const run = await general(engine, "Hello?", chatContext({ records: [PERSONAL, PROJECT_OWN] }));
    const page = await finished(engine, run.id);
    assert.deepEqual([page.status, failureOf(page), stub.chats().length], ["failed", "internal", 0]);
  });

  it("fails a turn whose stored message no longer reads, before any request, in Nivra's words (D23)", async () => {
    const { stub, engine, home } = await setup(() => text("never"));
    const run = await engine.client.call("runs.start", {
      clientRequestId: randomUUID(),
      workflowId: "chat",
      input: { message: `What is -----BEGIN TEST PRIVATE KEY----- this? ${MESSAGE_CANARY}`, scope: { kind: "repository", repoPath: "-----END TEST PRIVATE KEY----- /repo" } },
      context: chatContext({ modelContext: true }),
    });
    const page = await finished(engine, run.id);
    assert.equal(page.status, "failed");
    assert.match(page.events.find((e) => e.type === "run.failed")?.message ?? "", /^Nivra couldn't read this message back from its store, so nothing was sent to the model/);
    assert.equal(stub.chats().length, 0);
    assert.deepEqual(readdirSync(home).filter((file) => file.startsWith("mastra.db") && readFileSync(join(home, file)).includes(MESSAGE_CANARY)), []);
  });

  it("finds a run by its request id, and its store keeps one id across restarts while a new home gets its own (D26)", async () => {
    const { engine, home, info } = await setup(() => text("Hi"));
    const requestId = randomUUID();
    const run = await general(engine, "Hello?", chatContext(), requestId);
    await finished(engine, run.id);
    assert.equal((await engine.client.call("runs.find", { clientRequestId: requestId }))?.id, run.id);
    assert.equal(await engine.client.call("runs.find", { clientRequestId: randomUUID() }), null);
    await engine.client.call("shutdown", {});
    await engine.exited;
    const stub = await startStub({ chat: () => text("again") });
    stubs.push(stub);
    const again = await engineAt(stub.url, home);
    const other = await engineAt(stub.url);
    assert.deepEqual([again.info.homeId === info.homeId, other.info.homeId === info.homeId], [true, false]);
    assert.equal((await again.engine.client.call("runs.find", { clientRequestId: requestId }))?.id, run.id);
  });

  it("fails a turn the engine was killed during as interrupted, and never sends it again", async () => {
    const { stub, engine, home } = await setup(() => ({ ...text("too late"), delayMs: 10_000 }));
    const run = await general(engine, "Slow question");
    await waitFor(() => (stub.chats().length === 1 ? true : null), { what: "the request to reach the stub" });
    engine.kill();
    await engine.exited;
    const again = await engineAt(stub.url, home);
    const page = await finished(again.engine, run.id);
    assert.deepEqual([page.status, page.events.some((e) => e.type === "run.interrupted")], ["failed", true]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(stub.chats().length, 1, "nothing was replayed");
  });
});

/** A reply that keeps evidence, proposals and assumptions apart, each statement citing README.md's second line. */
const REPLY = {
  answer: "Add a CSV export beside the timer list, then test it the way the repository already tests components.",
  evidence: [{ statement: "Component files use kebab-case.", citations: [{ path: "README.md", startLine: 2, endLine: 2 }] }],
  proposals: [{ title: "Add an export button", detail: "A kebab-case component, export-button.tsx, beside the others.", citations: [{ path: "README.md", startLine: 2, endLine: 2 }] }],
  assumptions: ["The timer list is the only place exports start from."],
};

describe("a repository conversation's turn over stdio (D26)", () => {
  it("answers a planning question keeping evidence, proposals and assumptions apart, each citation checked", async () => {
    const repo = makeRepo();
    const script = [toolCall("read_file", { path: "README.md" }), toolCall("submit_reply", REPLY)];
    const { stub, engine } = await setup((_request, index) => script[index] ?? httpError(500, "the script ran out"));
    const run = await repository(engine, repo, "Plan a CSV export of the timer list");
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));
    assert.equal(run.title, "Chat · repo ü%#");
    const reply = await engine.client.call("runs.reply", { runId: run.id });
    assert.equal(reply?.kind, "repository");
    if (reply?.kind !== "repository") return;
    assert.deepEqual(
      [reply.evidence.map((e) => e.citations.map((c) => c.checked)), reply.proposals.map((p) => [p.title, p.citations.map((c) => c.checked)]), reply.assumptions, reply.checks],
      [[[true]], [["Add an export button", [true]]], REPLY.assumptions, { citations: 2, checked: 2 }],
    );
    const chats = stub.chats();
    const tools = (chats[0]?.body?.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name);
    assert.deepEqual(tools, ["list_files", "search_code", "read_file", "submit_reply"]);
    assert.ok(messagesOf(chats[0]).includes("Message: Plan a CSV export of the timer list") && messagesOf(chats[0]).includes("Repository map"));
  });

  it("turns down evidence citing lines it wasn't shown in this turn, even ones an earlier turn read, until they are read again", async () => {
    const repo = makeRepo();
    const history: ChatHistory = { exchanges: [exchange("Where does the timer start?", "startTimer is in src/timer.ts, line 3.")], omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 } };
    const followUp = { answer: "It starts in startTimer.", evidence: [{ statement: "startTimer is defined in src/timer.ts.", citations: [{ path: "src/timer.ts", startLine: 3, endLine: 3 }] }] };
    const script = [toolCall("submit_reply", followUp), toolCall("read_file", { path: "src/timer.ts" }), toolCall("submit_reply", followUp)];
    const { stub, engine } = await setup((_request, index) => script[index] ?? httpError(500, "the script ran out"));
    const run = await repository(engine, repo, "And where does it stop?", chatContext({ modelContext: true, history }));
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));
    assert.ok(page.events.some((e) => e.type === "tool.called" && e.message === "submit_reply refused: 1 citation of lines the model wasn't shown"));
    const sent = messagesOf(stub.chats()[0]);
    assert.ok(sent.includes("It is context, not evidence: Nivra's earlier answers can be wrong, and the repository may have changed since. Read again anything you rely on."));
    const reply = await engine.client.call("runs.reply", { runId: run.id });
    assert.deepEqual(reply?.kind === "repository" ? [reply.evidence[0]?.citations[0]?.checked, reply.context.history.exchanges] : [], [true, 1]);
  });

  it("labels evidence it never read once the reply is accepted as it is, and turns down evidence citing nothing first", async () => {
    const repo = makeRepo();
    const unread = { answer: "Probably in a helper.", evidence: [{ statement: "There is a helper.", citations: [{ path: "src/other.ts", startLine: 1, endLine: 1 }] }, { statement: "It is fast.", citations: [] }] };
    const script = [toolCall("submit_reply", unread), toolCall("submit_reply", unread), toolCall("submit_reply", unread)];
    const { engine } = await setup((_request, index) => script[index] ?? httpError(500, "the script ran out"));
    const run = await repository(engine, repo, "Is there a helper?");
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded");
    assert.equal(page.events.filter((e) => e.type === "tool.called" && e.message.startsWith("submit_reply refused")).length, 2);
    const reply = await engine.client.call("runs.reply", { runId: run.id });
    assert.deepEqual(reply?.kind === "repository" ? reply.evidence.map((e) => e.citations.map((c) => [c.checked, c.problem])) : [], [[[false, "file not read"]], []]);
  });

  it("turns down a reply of spaces like an empty one, and keeps the reply the model sends next, trimmed", async () => {
    const repo = makeRepo();
    const script = [toolCall("submit_reply", { answer: "   " }), toolCall("submit_reply", { answer: "  It is a small timer app.  " })];
    const { engine } = await setup((_request, index) => script[index] ?? httpError(500, "the script ran out"));
    const run = await repository(engine, repo, "What is this?");
    const page = await finished(engine, run.id);
    assert.equal(page.status, "succeeded", page.events.map((e) => e.message).join(" | "));
    assert.ok(page.events.some((e) => e.type === "tool.called" && e.message.startsWith("submit_reply refused: its input didn't match the tool's schema")));
    const reply = await engine.client.call("runs.reply", { runId: run.id });
    assert.deepEqual(reply?.kind === "repository" ? [reply.answer, reply.evidence] : [], ["It is a small timer app.", []]);
  });

  it("never succeeds with a reply of spaces: one the model never fixes fails as malformed, with no reply", async () => {
    const repo = makeRepo();
    const { engine } = await setup(() => toolCall("submit_reply", { answer: " \n\t " }));
    const run = await repository(engine, repo, "What is this?");
    const page = await finished(engine, run.id);
    assert.deepEqual([page.status, failureOf(page), await engine.client.call("runs.reply", { runId: run.id })], ["failed", "malformed", null]);
  });

  it("refuses a repository turn without the project's consent, before any request (D20, D22)", async () => {
    const repo = makeRepo();
    const { stub, engine } = await setup(() => text("never"));
    const run = await repository(engine, repo, "Explain it", chatContext({ modelContext: false }));
    const page = await finished(engine, run.id);
    assert.deepEqual([page.status, failureOf(page), stub.chats().length], ["failed", "sharing-refused", 0]);
  });
});
