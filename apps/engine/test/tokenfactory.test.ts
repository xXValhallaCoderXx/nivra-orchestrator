import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { TASK_MODEL } from "@nivra/domain";
import { createModelClient, type CallOptions } from "../src/providers/model.ts";
import { capCompletionTokens, COMPLETION_CAP_FIELD, isNvidiaModel, listModels, pickNemotron, PREFERRED_NEMOTRON, TOKEN_FACTORY_BASE_URL, TokenFactoryError } from "../src/providers/tokenfactory.ts";
import { startStub, text, toolCall, type Reply, type StubRequest } from "./stub-token-factory.ts";

const respond = (status: number, body: unknown) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("listModels", () => {
  it("asks /models with the key as a bearer token and returns the ids", async () => {
    let seen: { url: string; authorization: string | null } | null = null;
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), authorization: new Headers(init?.headers).get("authorization") };
      return new Response(JSON.stringify({ data: [{ id: "nvidia/nemotron-3-super-120b-a12b", owned_by: "nvidia" }, { id: "Qwen/Qwen3-30B" }] }));
    }) as typeof fetch;

    const models = await listModels("test-key", { fetch: fetchStub });

    assert.deepEqual(seen, { url: `${TOKEN_FACTORY_BASE_URL}/models?verbose=true`, authorization: "Bearer test-key" });
    assert.deepEqual(models, [
      { id: "nvidia/nemotron-3-super-120b-a12b", ownedBy: "nvidia", contextLength: null },
      { id: "Qwen/Qwen3-30B", ownedBy: null, contextLength: null },
    ]);
  });

  it("reads a model's context length under the names providers use, and ignores one that isn't a count", async () => {
    const body = { data: [{ id: "a", context_length: 131072 }, { id: "b", max_model_len: 32768 }, { id: "c", context_window: "lots" }] };
    const models = await listModels("key", { fetch: respond(200, body) as typeof fetch });
    assert.deepEqual(models.map((m) => [m.id, m.contextLength]), [["a", 131072], ["b", 32768], ["c", null]]);
  });

  it("says the key was refused on 401, by status rather than by the body's words", async () => {
    await assert.rejects(listModels("bad", { fetch: respond(401, "anything at all") as typeof fetch }), (error: unknown) => {
      assert.ok(error instanceof TokenFactoryError);
      assert.equal(error.status, 401);
      assert.match(error.message, /refused the API key/);
      return true;
    });
  });

  it("refuses a body it does not recognise or can't parse, keeping the status", async () => {
    for (const body of [{ models: [] }, "this is not JSON"]) {
      await assert.rejects(listModels("key", { fetch: respond(200, body) as typeof fetch }), (error: unknown) => {
        assert.ok(error instanceof TokenFactoryError);
        assert.deepEqual([error.status, /does not recognise/.test(error.message)], [200, true]);
        return true;
      });
    }
  });
});

describe("pickNemotron", () => {
  it("prefers Nemotron 3.5 Super VL, whatever the case of the listed id, and no longer prefers Nemotron 3 Super (D50)", () => {
    assert.equal(pickNemotron(["nvidia/Nemotron-3_5-Lightning", "NVIDIA/NEMOTRON-3.5-SUPER-VL"]), "NVIDIA/NEMOTRON-3.5-SUPER-VL");
    assert.equal(pickNemotron(["nvidia/nemotron-3-super-120b-a12b", "nvidia/Nemotron-3_5-Lightning"]), "nvidia/Nemotron-3_5-Lightning");
  });

  it("puts the task model first, so explain, research and the coach use what a task run uses when the key offers it (D50)", () => {
    assert.deepEqual([PREFERRED_NEMOTRON[0], TASK_MODEL], ["nvidia/Nemotron-3.5-Super-VL", "nvidia/Nemotron-3.5-Super-VL"]);
  });

  it("falls back to any NVIDIA model, and to null when there is none", () => {
    assert.equal(pickNemotron(["Qwen/Qwen3-30B", "nvidia/some-new-model"]), "nvidia/some-new-model");
    assert.equal(pickNemotron(["Qwen/Qwen3-30B"]), null);
  });

  it("recognises NVIDIA models by their organisation prefix", () => {
    assert.equal(isNvidiaModel("nvidia/x"), true);
    assert.equal(isNvidiaModel("meta-llama/nvidia-tuned"), false);
  });
});

describe("the completion cap a request carries (D50)", () => {
  /** What Token Factory would receive: each chat request's cap fields, through the client's production adapter. */
  async function caps(replies: (index: number) => Reply, options: Partial<CallOptions>, tools: Record<string, unknown> = {}) {
    const stub = await startStub({ chat: (_request: StubRequest, index: number) => replies(index) });
    try {
      const client = createModelClient({ apiKey: "test-key-0123456789", endpoint: { url: stub.url, kind: "loopback-test" } });
      const agent = client.agent({ id: "cap", name: "Cap", modelId: "nvidia/Nemotron-3.5-Super-VL", instructions: "Answer briefly.", tools });
      await client.call(agent, "Hello", { maxSteps: 2, deadlines: { stepMs: 10_000, totalMs: 20_000 }, maxOutputTokens: 321, ...options });
      return stub.chats().map((chat) => [chat.body?.[COMPLETION_CAP_FIELD], chat.body ? Object.hasOwn(chat.body, "max_tokens") : null]);
    } finally {
      await stub.close();
    }
  }

  it("sends a call's cap as max_completion_tokens, and no max_tokens, as Token Factory receives the request", async () => {
    assert.deepEqual(await caps(() => text("Hello."), {}), [[321, false]]);
  });

  it("sends a step's own cap, set through prepareStep as the hand-in sets it, as that request's max_completion_tokens", async () => {
    const tools = { probe: createTool({ id: "probe", description: "Probe", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    const handIn = { prepareStep: ({ stepNumber }: { stepNumber: number }) => (stepNumber === 1 ? { maxOutputTokens: 150 } : undefined) };
    assert.deepEqual(await caps((index) => (index === 0 ? toolCall("probe", {}) : text("Done.")), handIn, tools), [[321, false], [150, false]]);
  });

  it("leaves a call without a cap as it is, and keeps the provider's other options beside the cap", () => {
    const model = capCompletionTokens({ doGenerate: (options: unknown) => options, doStream: (options: unknown) => options, name: () => "model" });
    assert.deepEqual(model.doGenerate({ prompt: [] }), { prompt: [] });
    assert.deepEqual(model.doStream({ maxOutputTokens: 9, providerOptions: { nebius: { user: "u" }, other: { x: 1 } } }), { providerOptions: { nebius: { user: "u", max_completion_tokens: 9 }, other: { x: 1 } } });
    assert.equal(model.name(), "model");
  });
});
