import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testEngineArgs } from "../src/main/test-switches.ts";

describe("the local engine's test-only switches (D22, D36, D37, D40)", () => {
  const given = (switches: Record<string, string>) => (name: string) => switches[name] ?? "";
  const ALL = {
    "nivra-token-factory-url": "http://127.0.0.1:4100",
    "nivra-sandboxes-url": "http://127.0.0.1:4200",
    "nivra-tavily-url": "http://127.0.0.1:4300",
    "nivra-test-apply-hold": "/tmp/nivra hold/apply-hold",
  };

  it("passes each switch given to the local engine when unpackaged, the apply hold included, and nothing for one not given", () => {
    assert.deepEqual(testEngineArgs(false, given(ALL)), ["--token-factory-url", "http://127.0.0.1:4100", "--sandboxes-url", "http://127.0.0.1:4200", "--tavily-url", "http://127.0.0.1:4300", "--apply-hold", "/tmp/nivra hold/apply-hold"]);
    assert.deepEqual(testEngineArgs(false, given({ "nivra-test-apply-hold": "/tmp/apply-hold" })), ["--apply-hold", "/tmp/apply-hold"]);
    assert.deepEqual(testEngineArgs(false, given({})), []);
  });

  it("passes none of them when packaged, whatever the app was started with", () => {
    assert.deepEqual(testEngineArgs(true, given(ALL)), []);
    assert.deepEqual(testEngineArgs(true, given({ "nivra-test-apply-hold": "relative/apply-hold" })), [], "a packaged app doesn't even read it");
  });

  it("refuses an apply hold that isn't an absolute path, which the engine would resolve against its own folder", () => {
    assert.throws(() => testEngineArgs(false, given({ "nivra-test-apply-hold": "apply-hold" })), { message: '--nivra-test-apply-hold takes an absolute file path, not "apply-hold".' });
  });
});
