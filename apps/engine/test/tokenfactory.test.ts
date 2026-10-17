import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNvidiaModel, listModels, pickNemotron, TOKEN_FACTORY_BASE_URL, TokenFactoryError } from "../src/providers/tokenfactory.ts";

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
  it("prefers Nemotron 3 Super, whatever the case of the listed id", () => {
    assert.equal(pickNemotron(["nvidia/Nemotron-3_5-Lightning", "NVIDIA/NEMOTRON-3-SUPER-120B-A12B"]), "NVIDIA/NEMOTRON-3-SUPER-120B-A12B");
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
