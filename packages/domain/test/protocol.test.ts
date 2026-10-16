import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeMessage, ErrorCode, LineTooLongError, parseMessage } from "../src/protocol.ts";

const kindOf = (line: string) => {
  const parsed = parseMessage(line);
  return parsed.ok ? parsed.value.kind : `error:${parsed.error.code}`;
};

describe("parseMessage", () => {
  it("reads each JSON-RPC message kind", () => {
    assert.equal(kindOf('{"jsonrpc":"2.0","id":1,"method":"ping"}'), "request");
    assert.equal(kindOf('{"jsonrpc":"2.0","id":"a-1","method":"runs.start","params":{"kind":"hello"}}'), "request");
    assert.equal(kindOf('{"jsonrpc":"2.0","method":"run.event","params":{}}'), "notification");
    assert.equal(kindOf('{"jsonrpc":"2.0","id":1,"result":null}'), "result");
    assert.equal(kindOf('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"bad"}}'), "error");
  });

  it("answers text that is not JSON with a parse error and no id", () => {
    const parsed = parseMessage("not json");
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.error.code, ErrorCode.ParseError);
    assert.equal(parsed.id, null);
  });

  it("refuses batches, other versions and objects that are no message", () => {
    assert.equal(kindOf('[{"jsonrpc":"2.0","id":1,"method":"ping"}]'), `error:${ErrorCode.InvalidRequest}`);
    assert.equal(kindOf('{"jsonrpc":"1.0","id":1,"method":"ping"}'), `error:${ErrorCode.InvalidRequest}`);
    assert.equal(kindOf('{"jsonrpc":"2.0","id":1}'), `error:${ErrorCode.InvalidRequest}`);
    assert.equal(kindOf("42"), `error:${ErrorCode.InvalidRequest}`);
  });

  it("keeps a usable id so a malformed request can still be answered", () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","id":7,"method":""}');
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.id, 7);
  });

  it("refuses ids that are neither a non-negative integer nor a short string", () => {
    assert.equal(kindOf('{"jsonrpc":"2.0","id":-1,"method":"ping"}'), `error:${ErrorCode.InvalidRequest}`);
    assert.equal(kindOf('{"jsonrpc":"2.0","id":1.5,"method":"ping"}'), `error:${ErrorCode.InvalidRequest}`);
    assert.equal(kindOf(`{"jsonrpc":"2.0","id":"${"x".repeat(129)}","method":"ping"}`), `error:${ErrorCode.InvalidRequest}`);
  });
});

describe("encodeMessage", () => {
  it("writes exactly one line, even when strings hold newlines", () => {
    const line = encodeMessage({ jsonrpc: "2.0", id: 1, result: { text: "a\nb\r\nc" } });
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.slice(0, -1).includes("\n"), false);
    assert.equal(kindOf(line.slice(0, -1)), "result");
  });

  it("refuses a message longer than the limit", () => {
    assert.throws(() => encodeMessage({ jsonrpc: "2.0", id: 1, result: "x".repeat(100) }, 50), LineTooLongError);
  });
});
