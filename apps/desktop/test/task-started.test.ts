import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskReport } from "@nivra/domain";
import { startedFrom } from "../src/shared/task-started.ts";

/** What a task run's card says it started from (D41): only what an operation in the sandbox shows. */
describe("a task run's start, as its card says it (D41)", () => {
  const step = { label: "prepare", exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false, persisted: true, durationMs: 900, status: "SUCCESS", usage: null, stdoutTail: "", stderrTail: "" } as TaskReport["steps"][number];
  const environment = { image: "image-0123456789abcdef", inputsDigest: "a".repeat(64), projectFingerprint: "f".repeat(64), node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64" };
  it("names the environment or Nivra's base image once the sandbox ran something, and claims nothing when it ran nothing", () => {
    assert.deepEqual(
      [startedFrom({ environment, steps: [step] }), startedFrom({ environment: null, steps: [step] }), startedFrom({ environment: null, steps: [] }), startedFrom({ environment, steps: [] })],
      ["Started from the prepared environment: Node v22.23.4, pnpm 11.5.3, x86_64, image image-012345.", "Started from Nivra's own base image, with nothing installed.", null, null],
    );
  });
});
