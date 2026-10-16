import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineSplitter } from "../src/lines.ts";
import { LineTooLongError } from "../src/protocol.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("LineSplitter", () => {
  it("returns every line a chunk completes", () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push(bytes("one\ntwo\nthr")), ["one", "two"]);
    assert.deepEqual(splitter.push(bytes("ee\n")), ["three"]);
    assert.equal(splitter.end(), null);
  });

  it("joins a line that arrives in many chunks", () => {
    const splitter = new LineSplitter();
    const pieces = ["{", '"a"', ":", "1", "}"];
    for (const piece of pieces) assert.deepEqual(splitter.push(bytes(piece)), []);
    assert.deepEqual(splitter.push(bytes("\n")), ['{"a":1}']);
  });

  it("accepts CRLF line endings", () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push(bytes("a\r\nb\r\n")), ["a", "b"]);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const splitter = new LineSplitter();
    const encoded = bytes("café ü\n");
    const cut = encoded.indexOf(0xc3) + 1; // between the two bytes of "é"
    assert.deepEqual(splitter.push(encoded.slice(0, cut)), []);
    assert.deepEqual(splitter.push(encoded.slice(cut)), ["café ü"]);
  });

  it("returns a last line that has no line ending when the stream ends", () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push(bytes("done\npartial")), ["done"]);
    assert.equal(splitter.end(), "partial");
  });

  it("refuses a line longer than its limit, complete or still arriving", () => {
    assert.throws(() => new LineSplitter(5).push(bytes("123456\n")), LineTooLongError);
    const splitter = new LineSplitter(5);
    splitter.push(bytes("123"));
    assert.throws(() => splitter.push(bytes("456")), LineTooLongError);
  });
});
