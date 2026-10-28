import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REF_FORMAT, type EnvironmentRef, type TaskReport } from "@nivra/domain";
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

  it("names a recipe's environment by the versions its preparation verified, and a report kept from before by D41's (NIV-55)", () => {
    const environmentRef = { format: REF_FORMAT, recipe: "1".repeat(64), verified: "2".repeat(64), configuration: "3".repeat(64), image: "image-recipe-0123456789", projectFingerprint: "f".repeat(64), target: "wsl:Ubuntu", tools: [{ name: "node", version: "24.21.0" }, { name: "npm", version: "11.19.0" }, { name: "pnpm", version: "11.5.3" }], platform: { arch: "x86_64", libc: "musl" }, env: {}, dependencyFolders: ["node_modules"], builds: null, preparedAt: "2026-10-28T10:00:00.000Z" } satisfies EnvironmentRef;
    assert.deepEqual(
      [startedFrom({ environment: null, environmentRef, steps: [step] }), startedFrom({ environment: null, environmentRef, steps: [] }), startedFrom({ environment, steps: [step] })],
      ["Started from the prepared environment: node 24.21.0, npm 11.19.0, pnpm 11.5.3, x86_64, image image-recipe.", null, "Started from the prepared environment: Node v22.23.4, pnpm 11.5.3, x86_64, image image-012345."],
    );
  });
});
