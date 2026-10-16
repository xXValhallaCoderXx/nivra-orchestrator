import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { RpcCallError, RpcClient, RpcClosedError, RpcTimeoutError } from "../src/client.ts";
import { ErrorCode } from "../src/protocol.ts";

function harness(defaultTimeoutMs = 1_000) {
  const sent: Array<{ id: number; method: string; params: unknown }> = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const client = new RpcClient({
    send: (line) => sent.push(JSON.parse(line)),
    onProtocolError: (problem) => problems.push(problem),
    onNotification: (method) => notes.push(method),
    defaultTimeoutMs,
  });
  return { client, sent, problems, notes };
}

describe("RpcClient", () => {
  it("sends checked parameters and resolves with the checked result", async () => {
    const { client, sent } = harness();
    const instanceId = randomUUID();
    const pong = client.call("ping", {});
    assert.equal(sent[0]?.method, "ping");
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[0]!.id, result: { instanceId } }));
    assert.deepEqual(await pong, { instanceId });
  });

  it("refuses parameters outside the protocol before sending anything", async () => {
    const { client, sent } = harness();
    await assert.rejects(client.call("runs.get", { runId: "not-a-uuid" }), TypeError);
    assert.equal(sent.length, 0);
  });

  it("rejects with the engine's error code", async () => {
    const { client, sent } = harness();
    const call = client.call("runs.list", {});
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[0]!.id, error: { code: ErrorCode.NotInitialized, message: "Call initialize first." } }));
    await assert.rejects(call, (error: unknown) => error instanceof RpcCallError && error.code === ErrorCode.NotInitialized);
  });

  it("rejects a result that does not match the protocol", async () => {
    const { client, sent } = harness();
    const call = client.call("ping", {});
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[0]!.id, result: { instanceId: 42 } }));
    await assert.rejects(call, (error: unknown) => error instanceof RpcCallError && error.code === ErrorCode.InternalError);
  });

  it("times out, and fails every waiting call when the connection closes", async () => {
    const { client } = harness(30);
    await assert.rejects(client.call("ping", {}), RpcTimeoutError);
    const { client: other } = harness(10_000);
    const waiting = other.call("ping", {});
    other.close("The engine exited.");
    await assert.rejects(waiting, RpcClosedError);
    await assert.rejects(other.call("ping", {}), RpcClosedError);
  });

  it("reports lines that break the protocol, and passes notifications on", () => {
    const { client, problems, notes } = harness();
    client.receive("not json");
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 404, result: null }));
    client.receive(JSON.stringify({ jsonrpc: "2.0", method: "engine.fatal", params: { code: "locked", message: "x" } }));
    assert.equal(problems.length, 2);
    assert.deepEqual(notes, ["engine.fatal"]);
  });
});
