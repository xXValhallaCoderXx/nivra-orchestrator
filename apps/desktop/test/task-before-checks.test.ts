import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { build } from "esbuild";
import { TaskReport, type TaskCheck } from "@nivra/domain";
import type { BriefContent, TaskAttemptView } from "../src/shared/ipc.ts";

// Render the real review cards: a before-only report must not disappear just because no final checks exist.
const folder = mkdtempSync(join(tmpdir(), "nivra before checks render "));
const entry = join(folder, "render.cjs");
after(() => rmSync(folder, { recursive: true, force: true }));
await build({
  stdin: {
    contents: `import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { RunReview } from "./src/renderer/src/features/task-run.tsx";
export const render = (value, content) => renderToStaticMarkup(createElement(MantineProvider, { forceColorScheme: "light" }, createElement(RunReview, { value, content, number: 1, task: { label: "Ready", color: "blue" } })));`,
    resolveDir: join(dirname(fileURLToPath(import.meta.url)), ".."),
    loader: "tsx",
  },
  outfile: entry,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  bundle: true,
  logLevel: "silent",
});
const { render } = createRequire(import.meta.url)(entry) as { render(value: TaskAttemptView, content: BriefContent | null): string };

const digest = "a".repeat(64);
const secondDigest = "b".repeat(64);
const at = "2026-10-30T00:00:00.000Z";
const request = { runId: "8d260ac1-97ec-45eb-a458-f06138448c0c", clientRequestId: "c10c0e30-b36f-48f1-8aa8-2f4eb82a4c3c" };
const check = (over: Partial<TaskCheck> = {}): TaskCheck => ({ kind: "check", number: 1, commandSha256: digest, name: "recorded check label", verdict: "failed", reason: "the command exited with code 1", exitCode: 1, stdoutTail: "before stdout", stderrTail: "before stderr", difference: null, changedFiles: [], unclear: false, durationMs: 123, ...over });
const content: BriefContent = { goal: "Keep evidence", acceptanceCriteria: ["It stays visible"], scope: "", exclusions: "", context: "", assumptions: [], executionPolicy: { concurrency: 1, network: "off", approval: "required" }, sources: [], revalidate: [], baseline: [], frozen: [], checks: ["printf original-check", "printf second-check"], acceptanceCases: [{ name: "Acceptance", command: "true", expectedOutput: "", expectedExitCode: 0 }] };

function report(over: Partial<TaskReport> = {}): TaskReport {
  return TaskReport.parse({ version: 4, manifest: { policy: "required-checks-v1", checks: [{ kind: "case", number: 1, commandSha256: "d".repeat(64) }, { kind: "check", number: 1, commandSha256: digest }, { kind: "check", number: 2, commandSha256: secondDigest }], frozen: [], setupRequired: false }, beforeChecks: [check()], outcome: "cancelled", stopped: { code: "cancelled", step: "before check", message: "The run was cancelled before final verification." }, task: { taskId: "task", attemptId: "attempt", briefVersion: 1, briefDigest: digest }, snapshot: null, toolchain: [], baseline: [], frozen: [], worker: null, checks: [], verified: false, steps: [], proposal: null, reportSha256: null, cleanup: null, route: null, request, updatedAt: at, finishedAt: at, ...over });
}

function view(report: TaskReport): TaskAttemptView {
  return { id: request.clientRequestId, taskId: "task", briefVersion: 1, status: report.outcome === "cancelled" ? "cancelled" : report.outcome === "uncertain" ? "unknown" : "failed", note: null, runId: request.runId, cancelRequested: false, report, admission: null, proposal: null, progress: [], unresolved: null, decision: null, decidedAt: null, revisionNote: null, apply: null, acceptedAt: null, acceptNote: null, actions: [], createdAt: at, settledAt: at };
}

const count = (html: string, testId: string) => html.split(`data-testid="${testId}"`).length - 1;

describe("retained before-change observations in the review", () => {
  it("renders command, reason and both output streams with no final rows, without calling stopped runs verified", () => {
    const scenarios: Array<{ outcome: TaskReport["outcome"]; code: "cancelled" | "time" | "uncertain"; before: TaskCheck }> = [
      { outcome: "cancelled", code: "cancelled", before: check({ verdict: "unknown", reason: "cancelled while it ran" }) },
      { outcome: "failed", code: "time", before: check({ verdict: "not-run", reason: "there was no time left", exitCode: null, stdoutTail: "", stderrTail: "" }) },
      { outcome: "uncertain", code: "uncertain", before: check({ verdict: "unknown", reason: "dispatch was uncertain" }) },
    ];
    for (const scenario of scenarios) {
      const shown = report({ outcome: scenario.outcome, stopped: { code: scenario.code, step: "before check", message: `${scenario.code} before final verification` }, beforeChecks: [scenario.before] });
      const html = render(view(shown), content);
      assert.equal(count(html, "task-attempt-before-check"), 1);
      assert.equal(count(html, "task-attempt-check"), 0);
      for (const text of ["printf original-check", scenario.before.reason!, scenario.before.stdoutTail, scenario.before.stderrTail, "comparison unavailable"].filter(Boolean)) assert.equal(html.includes(text), true, text);
      assert.equal(html.includes('data-verified="false"'), true);
      assert.equal(html.includes("Verified change"), false);
      assert.equal(html.includes("Before-change check 1"), true);
      assert.equal(html.includes("These are the results Nivra recorded"), true);
    }
  });

  it("keeps recorded identity and evidence when the original command can't be shown", () => {
    for (const original of [null, content]) {
      const shown = report({ beforeChecks: [check({ commandSha256: "c".repeat(64) })] });
      const html = render(view(shown), original);
      assert.equal(count(html, "task-attempt-before-check"), 1);
      for (const text of ["Recorded label: recorded check label", "Original command unavailable", "before stdout", "before stderr"]) assert.equal(html.includes(text), true, text);
      assert.equal(html.includes("printf original-check"), false);
    }
  });

  it("renders each observation once and keeps unmatched or ambiguous comparisons unavailable", () => {
    const before = check({ verdict: "passed", stdoutTail: "first evidence", stderrTail: "" });
    const orphan = check({ number: 2, commandSha256: secondDigest, stdoutTail: "orphan evidence" });
    const final = check({ verdict: "passed", stdoutTail: "", stderrTail: "" });
    const paired = report({ beforeChecks: [before, orphan], checks: [final, check({ number: 2, commandSha256: "c".repeat(64) })] });
    const html = render(view(paired), content);
    assert.equal(count(html, "task-attempt-before-check"), 2);
    assert.equal(html.split("first evidence").length - 1, 1);
    assert.equal(html.split("orphan evidence").length - 1, 1);
    assert.equal(html.includes('data-comparison="Passed before and after"'), true);
    assert.equal(html.includes('data-comparison="Comparison unavailable"'), true);
    const ambiguous = render(view(report({ beforeChecks: [before, { ...before, stdoutTail: "duplicate evidence" }], checks: [final] })), content);
    assert.equal(count(ambiguous, "task-attempt-before-check"), 2);
    assert.equal(ambiguous.includes("duplicate evidence"), true);
    assert.equal(ambiguous.includes('data-comparison="Comparison unavailable"'), true);
  });
});
