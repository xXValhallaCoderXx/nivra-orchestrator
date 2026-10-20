import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { RpcCallError } from "@nivra/domain";
import { runProviderCheck } from "../src/providers/tool-call.ts";
import { removeDir, startEngine, tempDir, type EngineProcess } from "./helpers.ts";
import { httpError, startStub, text, toolCall, type Stub } from "./stub-token-factory.ts";

const KEY = "test-key-0123456789abcdef";
const engines: EngineProcess[] = [];
const stubs: Stub[] = [];
const dirs: string[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});

const modelsFetch = (async () =>
  new Response(JSON.stringify({ data: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }, { id: "Qwen/Qwen3-30B" }] }))) as typeof fetch;

type Generated = { content: unknown[]; finishReason: string; usage: Record<string, number>; warnings: unknown[] };
const said = (words: string): Generated => ({ content: [{ type: "text", text: words }], finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }, warnings: [] });
const called = (toolName: string, input: unknown): Generated => ({
  content: [{ type: "tool-call", toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) }],
  finishReason: "tool-calls",
  usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  warnings: [],
});

const VALID_ANSWER = { summary: "A demo repository.", findings: [{ statement: "Build with pnpm build and test with pnpm test.", citations: [{ path: "README.md", startLine: 2, endLine: 3 }] }] };

describe("runProviderCheck, in-process (D22)", () => {
  it("reports tool calling, usage, the context length, and each probe: required, a forced choice of two tools, the real answer schema", async () => {
    const replies = [called("read_project_fact", { name: "build_command" }), said("The build command is pnpm verify."), called("note_ready", {}), called("note_busy", {}), called("submit_answer", VALID_ANSWER)];
    const model = new MastraLanguageModelV2Mock({ doGenerate: (async () => replies.shift()) as never });
    const result = await runProviderCheck({ apiKey: KEY, endpoint: { url: "http://127.0.0.1:9/v1", kind: "loopback-test" }, fetch: modelsFetch, agentModel: () => model });
    assert.deepEqual(
      [result.models.contextLength, result.call?.toolCalled, result.call?.inputTokens, result.call?.outputTokens, result.probes, result.problem],
      [131_072, true, 22, 6, { requiredToolChoice: "honoured", forcedToolChoice: "honoured", answerSchema: "valid" }, null],
    );
    const choices = model.doGenerateCalls.map((options) => (options as { toolChoice?: unknown }).toolChoice);
    assert.deepEqual(choices.slice(2), [{ type: "required" }, { type: "tool", toolName: "note_busy" }, { type: "tool", toolName: "submit_answer" }]);
  });

  it("reports a failure inside Nivra in its own words, and tells the diagnostic its facts, never the error's text (NIV-27)", async () => {
    const canary = `Private provider text ${randomUUID()}`;
    const model = new MastraLanguageModelV2Mock({
      doGenerate: (async () => {
        throw new RangeError(canary);
      }) as never,
    });
    const told: unknown[] = [];
    const result = await runProviderCheck({ apiKey: KEY, endpoint: { url: "http://127.0.0.1:9/v1", kind: "loopback-test" }, fetch: modelsFetch, agentModel: () => model, onDiagnostic: (facts) => told.push(facts) });
    assert.deepEqual([result.problemKind, result.call, /^The call to nvidia\/nemotron-3-super-120b-a12b failed\. Something inside Nivra failed \(RangeError\)\./.test(result.problem ?? "")], ["internal", null, true]);
    assert.deepEqual(told, [{ code: "unexpected-error", stage: "model.call", error: { classes: ["RangeError"], errno: null, causes: 0, messageChars: canary.length } }]);
    assert.equal(JSON.stringify([result, told]).includes(canary), false);
  });

  it("reports a forced choice the model ignored, and an answer that failed the schema", async () => {
    const badAnswer = { summary: "x", findings: [{ statement: "y", citations: [{ path: "README.md", startLine: 3, endLine: 2 }] }] };
    const replies = [called("read_project_fact", { name: "build_command" }), said("pnpm verify"), said("ready"), called("note_ready", {}), called("submit_answer", badAnswer)];
    const model = new MastraLanguageModelV2Mock({ doGenerate: (async () => replies.shift()) as never });
    const result = await runProviderCheck({ apiKey: KEY, endpoint: { url: "http://127.0.0.1:9/v1", kind: "loopback-test" }, fetch: modelsFetch, agentModel: () => model });
    assert.deepEqual(result.probes, { requiredToolChoice: "ignored", forcedToolChoice: "ignored", answerSchema: "invalid" });
  });

  it("reports a refused key as the call's problem, by kind, and probes nothing more", async () => {
    const model = new MastraLanguageModelV2Mock({
      doGenerate: (async () => {
        throw Object.assign(new Error("Unauthorized"), { name: "AI_APICallError", statusCode: 401, isRetryable: false });
      }) as never,
    });
    const result = await runProviderCheck({ apiKey: KEY, endpoint: { url: "http://127.0.0.1:9/v1", kind: "loopback-test" }, fetch: modelsFetch, agentModel: () => model });
    assert.deepEqual([result.call, result.probes, result.problemKind, model.doGenerateCalls.length], [null, null, "auth", 1]);
    assert.match(result.problem ?? "", /refused the API key/);
  });

  it("skips the probes rather than overrun its deadline", async () => {
    const replies = [called("read_project_fact", { name: "build_command" }), said("pnpm verify")];
    const model = new MastraLanguageModelV2Mock({ doGenerate: (async () => replies.shift() ?? said("extra")) as never });
    const result = await runProviderCheck({ apiKey: KEY, endpoint: { url: "http://127.0.0.1:9/v1", kind: "loopback-test" }, fetch: modelsFetch, agentModel: () => model, deadlineMs: 10_000 });
    assert.deepEqual(result.probes, { requiredToolChoice: "skipped", forcedToolChoice: "skipped", answerSchema: "skipped" });
    assert.equal(model.doGenerateCalls.length, 2);
  });
});

describe("providers.check over stdio, against a loopback stub of Token Factory (D22)", () => {
  async function setup(chat: NonNullable<Parameters<typeof startStub>[0]>["chat"]) {
    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b", context_length: 131_072 }], ...(chat ? { chat } : {}) });
    stubs.push(stub);
    const root = tempDir();
    dirs.push(root);
    const engine = startEngine(join(root, "home"), { args: ["--stdio", "--home", join(root, "home"), "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", stub.url] });
    engines.push(engine);
    await engine.initialize({ NEBIUS_API_KEY: KEY });
    return { stub, engine };
  }

  it("makes real requests: the key only in Authorization, verbose model metadata, the tool choices as OpenAI expects, usage and rate-limit values read", async () => {
    // The remaining-tokens value stays high: below 2,000, Mastra sleeps 10 s after the step.
    const limits = { "x-ratelimit-remaining-tokens": "999999", "x-ratelimit-reset-tokens": "0.5", "x-ratelimit-limit-requests": "100" };
    const script = [
      toolCall("read_project_fact", { name: "build_command" }),
      text("The build command is pnpm verify.", { headers: limits }),
      toolCall("note_ready", {}),
      toolCall("note_busy", {}),
      toolCall("submit_answer", VALID_ANSWER),
    ];
    const { stub, engine } = await setup((_request, index) => script[index] ?? httpError(500, "unexpected request"));
    const result = await engine.client.call("providers.check", {}, { timeoutMs: 60_000 });
    assert.deepEqual(
      [result.endpoint, result.models.contextLength, result.call?.toolCalled, result.call?.inputTokens, result.call?.outputTokens, result.probes, result.problem],
      ["loopback-test", 131_072, true, 40, 10, { requiredToolChoice: "honoured", forcedToolChoice: "honoured", answerSchema: "valid" }, null],
    );
    assert.deepEqual(result.call?.rateLimit, { remainingTokens: 999_999, resetTokensSeconds: 0.5, belowPauseThreshold: false });
    assert.deepEqual(stub.requests.filter((r) => r.path.endsWith("/models")).map((r) => r.query), ["?verbose=true"]);
    const chats = stub.chats();
    assert.equal(chats.length, 5);
    assert.deepEqual([...new Set(stub.requests.map((r) => r.authorization))], [`Bearer ${KEY}`]);
    assert.deepEqual(stub.requests.filter((r) => r.raw.includes(KEY)).map((r) => r.path), [], "the key is never in a request body");
    assert.deepEqual(
      chats.slice(2).map((chat) => chat.body?.tool_choice),
      ["required", { type: "function", function: { name: "note_busy" } }, { type: "function", function: { name: "submit_answer" } }],
    );
  });

  it("reports a 429 with when to try again, after one request, and never retries", async () => {
    const { stub, engine } = await setup(() => ({ ...httpError(429, "slow down"), headers: { "retry-after": "7" } }));
    const result = await engine.client.call("providers.check", {}, { timeoutMs: 60_000 });
    assert.deepEqual([result.problemKind, result.retryAfterSeconds, stub.chats().length], ["rate-limit", 7, 1]);
    assert.match(result.problem ?? "", /Try again in 7 s/);
  });

  it("reports a refused key by kind after exactly one chat request, and never retries", async () => {
    const { stub, engine } = await setup(() => httpError(401, "invalid key"));
    const result = await engine.client.call("providers.check", {}, { timeoutMs: 60_000 });
    assert.deepEqual([result.call, result.probes, result.problemKind, stub.chats().length], [null, null, "auth", 1]);
  });

  it("says in Doctor that model requests go to a test endpoint, not Token Factory", async () => {
    const { engine } = await setup(undefined);
    const report = await engine.client.call("doctor", {});
    const models = report.checks.find((check) => check.id === "models");
    assert.equal(models?.status, "warn");
    assert.match(models?.detail ?? "", /test endpoint on this machine/);
  });

  it("refuses a test endpoint that isn't on this machine, by an engine.fatal code", async () => {
    const root = tempDir();
    dirs.push(root);
    const engine = startEngine(join(root, "home"), { args: ["--stdio", "--home", join(root, "home"), "--token-factory-url", "https://example.com/v1"] });
    engines.push(engine);
    const { code } = await engine.exited;
    assert.equal(code, 4);
    assert.equal((engine.notifications[0]?.params as { code?: string } | undefined)?.code, "bad-arguments");
  });

  it("refuses providers.check without a key, before any request", async () => {
    const stub = await startStub();
    stubs.push(stub);
    const root = tempDir();
    dirs.push(root);
    const engine = startEngine(join(root, "home"), { args: ["--stdio", "--home", join(root, "home"), "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", stub.url] });
    engines.push(engine);
    await engine.initialize();
    await assert.rejects(engine.client.call("providers.check", {}), (error: unknown) => error instanceof RpcCallError && /No Nebius key/.test(error.message));
    assert.equal(stub.requests.length, 0);
  });
});
