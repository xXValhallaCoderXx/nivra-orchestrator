import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLimitLines } from "../src/renderer/src/shell/run-limits.ts";

/** A task run's bounds that no brief changes, in words (NIV-56, Settings › Budget and usage). */
describe("the per-run limits, in words (NIV-56)", () => {
  const limits = { modelRequests: 24, requestSeconds: 830, outputTokensPerRequest: 8_000, estimatedInputTokens: 480_000, toolCalls: 48, writes: 8, runs: 4, checkSeconds: 60, sessionMinutes: 45, runMinutes: 58 };

  it("words each bound as the run preview does, with what each one is and isn't", () => {
    assert.deepEqual(runLimitLines(limits), [
      {
        key: "requests",
        label: "Model requests",
        text: "At most 24 model requests in a run, each of up to 830 s and 8,000 output tokens. 830 s bounds a request; it isn't how long one takes. The output cap counts the model's reasoning tokens too.",
      },
      { key: "input", label: "Input", text: "Admitted against an estimated 480,000 input tokens: an estimated admission budget, not a cap." },
      { key: "tools", label: "Tool calls", text: "48 tool calls, of which 8 writes and 4 runs of a case or check, each command up to 60 s." },
      { key: "time", label: "Time", text: "The sandbox for 45 minutes, and the whole run for 58 minutes." },
    ]);
  });

  it("says one in the singular, and never states a cost", () => {
    const one = runLimitLines({ ...limits, modelRequests: 1, toolCalls: 1, writes: 1, runs: 1, sessionMinutes: 1, runMinutes: 1 }).map((line) => line.text);
    assert.equal(one[0]!.startsWith("At most 1 model request in a run"), true);
    assert.equal(one[2], "1 tool call, of which 1 write and 1 run of a case or check, each command up to 60 s.");
    assert.equal(one[3], "The sandbox for 1 minute, and the whole run for 1 minute.");
    assert.equal(runLimitLines(limits).some((line) => /\$|US\$|cost|price/i.test(line.text)), false);
  });
});
