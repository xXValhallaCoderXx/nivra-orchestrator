import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { InitializeParams, Methods, StartRunParams } from "../src/methods.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { WorkflowId } from "../src/runs.ts";
import { SandboxPreview, SandboxReport, SandboxStopCode } from "../src/sandbox.ts";

/** The sandbox check's contract (NIV-44, D36): what a check takes, what it never takes, and what it gives back. */
const FINGERPRINT = "f".repeat(64);
const request = (overrides: { input?: Record<string, unknown>; context?: unknown } = {}) => ({
  clientRequestId: randomUUID(),
  workflowId: "sandbox",
  input: { repoPath: "/home/someone/repo", project: randomUUID(), target: "local", preview: FINGERPRINT, ...overrides.input },
  context: overrides.context ?? { sharing: { cloudExecution: true } },
});

describe("a sandbox check's request (NIV-44)", () => {
  it("takes a checkout, the project and target it is bound to, and the preview's fingerprint, with upload consent in its context", () => {
    const parsed = StartRunParams.parse(request());
    assert.equal(parsed.workflowId, "sandbox");
    assert.equal(StartRunParams.safeParse(request({ input: { target: "wsl:Ubuntu-24.04" } })).success, true);
    assert.equal(WorkflowId.parse("sandbox"), "sandbox");
    assert.equal(PROTOCOL_VERSION, 19);
  });

  it("never reads model-context consent as upload consent, and takes no command, no key and no other workflow's context", () => {
    const refused = [
      request({ context: { sharing: { modelContext: true } } }),
      request({ context: { sharing: { cloudExecution: true, modelContext: true } } }),
      request({ context: { preferences: { revision: 0, records: [] }, sharing: { cloudExecution: true } } }),
      request({ context: {} }),
      request({ input: { argv: ["/bin/sh", "-c", "curl example.com"] } }),
      request({ input: { key: "a-key-from-the-renderer" } }),
      request({ input: { preview: "not a fingerprint" } }),
      request({ input: { project: "not-a-uuid" } }),
      request({ input: { target: "elsewhere" } }),
      request({ input: { target: "wsl:" } }),
      request({ input: { target: "wsl:two words" } }),
      request({ input: { repoPath: "" } }),
    ];
    assert.deepEqual(
      refused.map((params) => StartRunParams.safeParse(params).success),
      refused.map(() => false),
    );
  });

  it("takes the project id as a secret beside the key, and gives the check its own methods", () => {
    assert.equal(InitializeParams.safeParse({ protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, secrets: { NEBIUS_API_KEY: "k".repeat(20), NEBIUS_PROJECT_ID: "project-e00example" } }).success, true);
    assert.deepEqual(
      ["runs.sandbox", "sandbox.preview", "sandbox.status", "sandbox.recover"].map((name) => Object.hasOwn(Methods, name)),
      [true, true, true, true],
    );
  });
});

describe("what a sandbox check gives back (NIV-44)", () => {
  it("previews either what it would send or why it can't, never both", () => {
    const counted = { count: 0, sample: [] };
    const ready = {
      status: "ready",
      baseline: "b".repeat(40),
      prefix: "",
      files: 3,
      bytes: 10_240,
      leftOut: { secret: { count: 1, sample: [".env"] }, output: counted, submodule: counted, excluded: counted },
      untracked: counted,
      lfsPointers: 0,
      fingerprint: FINGERPRINT,
      retention: "Images are retained for 180 days.",
    };
    assert.equal(SandboxPreview.safeParse(ready).success, true);
    assert.equal(SandboxPreview.safeParse({ ...ready, baseline: "c".repeat(64) }).success, true, "a SHA-256 repository's commit");
    assert.equal(SandboxPreview.safeParse({ status: "refused", code: "content", message: "src/a.ts in this commit holds what looks like a private key." }).success, true);
    assert.equal(SandboxPreview.safeParse({ ...ready, status: "refused", code: "content", message: "x" }).success, false);
    assert.equal(SandboxPreview.safeParse({ ...ready, leftOut: { ...ready.leftOut, secret: { count: 9, sample: Array.from({ length: 6 }, () => "a") } } }).success, false, "at most five names a reason");
  });

  it("reports by a closed set of stop codes, with cleanup's own record", () => {
    const report = {
      outcome: "unchanged",
      stopped: null,
      snapshot: { baseline: "b".repeat(40), prefix: "", fingerprint: FINGERPRINT, files: 3, archiveSha256: "a".repeat(64) },
      steps: [],
      reportSha256: "d".repeat(64),
      proposal: null,
      cleanup: { stopped: 0, alreadyEnded: 0, unresolved: [], retained: { uploads: 1, images: 3, operations: 3, note: "Images are retained for 180 days." } },
      request: { runId: randomUUID(), clientRequestId: randomUUID() },
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    assert.equal(SandboxReport.safeParse(report).success, true);
    assert.equal(SandboxReport.safeParse({ ...report, outcome: "refused", stopped: { code: "consent", step: "check", message: "Uploads aren't allowed for this project." } }).success, true);
    assert.equal(SandboxReport.safeParse({ ...report, outcome: "refused", stopped: { code: "something-else", step: null, message: "x" } }).success, false);
    // Every refusal code the workspace rules give, the session's and the check's own.
    assert.equal(SandboxStopCode.options.length, 26);
  });
});
