import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffFilesOf, fileSummaryOf, modeChangeOf } from "../src/shared/task-diff.ts";
import { initialRepositoryOf } from "../src/shared/task-form.ts";
import { decisionLead, failingReportedChecks, outcomeLookOf, unapprovableText } from "../src/shared/task-verdict.ts";

/**
 * What the review of a run's change shows (NIV-56, G3: P1i, RS1, RS5), worked out from the run's own data: the patch
 * file by file, the Outcome badge, why a change can't be approved, and the reported checks a verified change failed.
 */

const PATCH = [
  "diff --git a/greet.sh b/greet.sh",
  "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
  "--- a/greet.sh",
  "+++ b/greet.sh",
  "@@ -1,2 +1,2 @@",
  " greet() {",
  "-  printf 'Hello, %s\\n' \"$1\"",
  "+  printf 'Hello, %s\\n' \"${1:-world}\"",
  "\\ No newline at end of file",
  "diff --git a/notes/new.md b/notes/new.md",
  "new file mode 100644",
  "index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333",
  "--- /dev/null",
  "+++ b/notes/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+",
  "diff --git a/logo.png b/logo.png",
  "new file mode 100644",
  "index 0000000000000000000000000000000000000000..4444444444444444444444444444444444444444",
  "GIT binary patch",
  "literal 12",
  "zcmZ?wbhEHbRA2xC",
  "",
].join("\n");

describe("a proposal's patch, file by file (P1i)", () => {
  it("splits it into its files, in order, with each one's lines and counts", () => {
    const files = diffFilesOf(PATCH, ["greet.sh", "notes/new.md", "logo.png"], false);
    assert.deepEqual(
      files.map((file) => [file.path, file.added, file.removed, file.binary, file.cut]),
      [
        ["greet.sh", 1, 1, false, false],
        ["notes/new.md", 2, 0, false, false],
        ["logo.png", 0, 0, true, false],
      ],
    );
    assert.deepEqual(files[0]!.lines.map((line) => line.kind), ["hunk", "context", "removed", "added", "note"]);
    assert.equal(files[0]!.lines[3]!.text, "  printf 'Hello, %s\\n' \"${1:-world}\"");
    assert.equal(files[2]!.lines.length, 0, "a binary patch's data isn't shown");
  });

  it("names a file from its side lines when the header isn't a known path, quoting undone", () => {
    const quoted = ['diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"', '--- "a/caf\\303\\251 \\"x\\".txt"', '+++ "b/caf\\303\\251 \\"x\\".txt"', "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    assert.equal(diffFilesOf(quoted, [], false)[0]!.path, 'café "x".txt');
  });

  it("keeps a mode-only change's modes, with no lines and no counts (Nate's final review)", () => {
    // What git diff-tree writes for chmod +x alone: the modes, and no index line, side lines or hunks.
    const files = diffFilesOf(["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join("\n"), ["run.sh"], false);
    assert.deepEqual(
      files.map((file) => [file.path, file.lines.length, file.added, file.removed, file.binary, file.modes]),
      [["run.sh", 0, 0, 0, false, { before: "100644", after: "100755" }]],
    );
  });

  it("keeps the modes of a change with content edits, of a new executable file and of a deleted file", () => {
    const patch = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1 +1 @@",
      "-echo a",
      "+echo b",
      "diff --git a/tool.sh b/tool.sh",
      "new file mode 100755",
      "index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333",
      "--- /dev/null",
      "+++ b/tool.sh",
      "@@ -0,0 +1 @@",
      "+echo tool",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 4444444444444444444444444444444444444444..0000000000000000000000000000000000000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");
    assert.deepEqual(
      diffFilesOf(patch, ["run.sh", "tool.sh", "old.txt"], false).map((file) => [file.path, file.added, file.removed, file.modes]),
      [
        ["run.sh", 1, 1, { before: "100644", after: "100755" }],
        ["tool.sh", 1, 0, { before: null, after: "100755" }],
        ["old.txt", 0, 1, { before: "100644", after: null }],
      ],
    );
  });

  it("says what a mode is when it's worth saying, and that the apply refuses a mode change, as the engine's rule does", () => {
    const at = (mode: string) => ({ mode });
    assert.deepEqual(modeChangeOf({ change: "changed", before: at("100644"), after: at("100755") }), { before: "100644", after: "100755", text: "Mode 100644 to 100755: made executable", applies: false });
    assert.deepEqual(modeChangeOf({ change: "changed", before: at("100755"), after: at("100644") }), { before: "100755", after: "100644", text: "Mode 100755 to 100644: no longer executable", applies: false });
    assert.deepEqual(modeChangeOf({ change: "added", before: null, after: at("100755") }), { before: null, after: "100755", text: "An executable file (mode 100755)", applies: true });
    assert.deepEqual(modeChangeOf({ change: "added", before: null, after: at("120000") }), { before: null, after: "120000", text: "A link (mode 120000)", applies: false });
    assert.equal(modeChangeOf({ change: "changed", before: at("100644"), after: at("100644") }), null);
    assert.equal(modeChangeOf({ change: "added", before: null, after: at("100644") }), null);
    assert.equal(modeChangeOf({ change: "deleted", before: at("100755"), after: null }), null);
  });

  it("says mode only, its content unchanged, only when the content hashes match and the modes differ (Nate's re-review)", () => {
    const same = "a".repeat(64);
    const mode = (mode: string, sha256 = same) => ({ mode, sha256 });
    const header = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"];
    // The true mode-only change: the same content, a new mode.
    const only = diffFilesOf([...header, ""].join("\n"), ["run.sh"], false)[0]!;
    assert.deepEqual(
      [fileSummaryOf({ change: "changed", before: mode("100644"), after: mode("100755") }, only)].map((it) => [it.counts, it.shown, it.mode?.text]),
      [["mode only", "unchanged", "Mode 100644 to 100755: made executable"]],
    );
    // A patch cut before this file's lines, with its content changed too: never mode only or unchanged, the cut said.
    const cut = diffFilesOf([...header, "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222", ""].join("\n"), ["run.sh"], true)[0]!;
    assert.deepEqual([cut.lines.length, cut.cut], [0, true]);
    const changed = { change: "changed" as const, before: mode("100644"), after: mode("100755", "b".repeat(64)) };
    assert.deepEqual([fileSummaryOf(changed, cut)].map((it) => [it.counts, it.shown, it.mode?.text]), [[null, "cut", "Mode 100644 to 100755: made executable"]]);
    // Past the cut altogether: its diff isn't shown, and nothing says it's unchanged.
    assert.deepEqual([fileSummaryOf(changed, null)].map((it) => [it.counts, it.shown]), [[null, "past-cut"]]);
  });

  it("never says mode only for a new executable file, empty or not", () => {
    const executable = { change: "added" as const, before: null, after: { mode: "100755", sha256: "c".repeat(64) } };
    const empty = diffFilesOf(["diff --git a/tool.sh b/tool.sh", "new file mode 100755", "index 0000000000000000000000000000000000000000..e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", ""].join("\n"), ["tool.sh"], false)[0]!;
    assert.deepEqual([fileSummaryOf(executable, empty)].map((it) => [it.counts, it.shown, it.mode?.text]), [[null, "no-lines", "An executable file (mode 100755)"]]);
    const written = diffFilesOf(["diff --git a/tool.sh b/tool.sh", "new file mode 100755", "--- /dev/null", "+++ b/tool.sh", "@@ -0,0 +1 @@", "+echo tool", ""].join("\n"), ["tool.sh"], false)[0]!;
    assert.deepEqual([fileSummaryOf(executable, written)].map((it) => [it.counts, it.shown]), [["+1 \u22120", "diff"]]);
  });

  it("marks the file the cut ends in, and claims nothing past it", () => {
    const cut = PATCH.split("\n").slice(0, 16).join("\n");
    const files = diffFilesOf(cut, ["greet.sh", "notes/new.md", "logo.png"], true);
    assert.deepEqual(files.map((file) => [file.path, file.added, file.cut]), [["greet.sh", 1, false], ["notes/new.md", 1, true]]);
  });
});

const check = (kind: "case" | "check", verdict: string) => ({ kind, number: 1, name: "n", verdict, reason: null, exitCode: 0, stdoutTail: "", stderrTail: "", difference: null, changedFiles: [], unclear: false, durationMs: null }) as never;

describe("the Outcome badge and the decision (RS1, RS5)", () => {
  it("tells a case that failed from one not shown to pass, and says how a run without a report ended", () => {
    assert.deepEqual(outcomeLookOf({ status: "answered", report: { outcome: "proposed", verified: true, checks: [] } }), { label: "Verified change", color: "green" });
    assert.deepEqual(outcomeLookOf({ status: "answered", report: { outcome: "proposed", verified: false, checks: [check("case", "failed")] } }), { label: "Checks failed", color: "red" });
    assert.deepEqual(outcomeLookOf({ status: "answered", report: { outcome: "proposed", verified: false, checks: [check("case", "unknown")] } }), { label: "Not verified", color: "yellow" });
    // A reported check that failed never makes a case's verdict.
    assert.deepEqual(outcomeLookOf({ status: "answered", report: { outcome: "proposed", verified: false, checks: [check("check", "failed")] } }), { label: "Not verified", color: "yellow" });
    assert.deepEqual(outcomeLookOf({ status: "answered", report: { outcome: "cancelled", verified: false, checks: [] } }), { label: "Stopped", color: "gray" });
    assert.deepEqual(outcomeLookOf({ status: "interrupted", report: null }), { label: "Interrupted", color: "yellow" });
    assert.deepEqual(outcomeLookOf({ status: "not-sent", report: null }), { label: "Not sent", color: "gray" });
  });

  it("gives the first reason a change can't be approved, the cases' sentence as it was", () => {
    assert.equal(unapprovableText({ frozen: [], setup: null }), "This change can't be approved: not every acceptance case was shown to pass. You can reject it, or ask for a revision.");
    assert.match(unapprovableText({ frozen: [{ path: "a", unchanged: false }] as never, setup: { unchanged: false, changed: ["package.json"] } }), /a frozen file isn't shown to be unchanged/);
    assert.match(unapprovableText({ frozen: [], setup: { unchanged: false, changed: ["package.json"] } }), /it changes a setup file the environment was prepared from \(package\.json\)\. You can reject it, or ask for a revision that leaves the setup files as they are\.$/);
    assert.match(unapprovableText({ frozen: [], setup: { unchanged: null, changed: [] } }), /couldn't tell whether the setup files are unchanged/);
  });

  it("finds a verified change's reported checks that didn't pass, and none for anything else", () => {
    assert.equal(failingReportedChecks({ outcome: "proposed", verified: true, checks: [check("case", "passed"), check("check", "failed"), check("check", "couldnt-run")] }).length, 2);
    assert.equal(failingReportedChecks({ outcome: "proposed", verified: false, checks: [check("check", "failed")] }).length, 0);
    assert.equal(failingReportedChecks(null).length, 0);
  });
});

describe("which decision leads (RS5)", () => {
  const verified = { outcome: "proposed" as const, verified: true };
  it("leads with Approve and apply for a verified change whose checks passed", () => {
    assert.deepEqual(decisionLead({ ...verified, checks: [check("case", "passed"), check("check", "passed")] }, true, true), { lead: "approve", approve: "Approve and apply" });
  });
  it("makes Request revision the primary when a reported check failed, and approving stays possible", () => {
    assert.deepEqual(decisionLead({ ...verified, checks: [check("case", "passed"), check("check", "failed")] }, true, true), { lead: "revise", approve: "Approve and apply anyway" });
  });
  it("offers no approval the host doesn't, or for a change it can't show", () => {
    assert.deepEqual(decisionLead({ outcome: "proposed", verified: false, checks: [check("case", "failed")] }, false, true), { lead: "revise", approve: null });
    assert.deepEqual(decisionLead({ ...verified, checks: [] }, true, false), { lead: "revise", approve: null });
  });
});

describe("the repository New task starts with (NIV-56)", () => {
  const listed = ["alpha", "beta"];
  it("preselects the project whose page opened the form, when there's no plan", () => {
    assert.equal(initialRepositoryOf(null, listed, "beta"), "beta");
    assert.equal(initialRepositoryOf(null, listed, null), null);
  });
  it("lets a plan's own project win, a general plan included, and never names a project that isn't listed", () => {
    assert.equal(initialRepositoryOf({ projectId: "alpha" }, listed, "beta"), "alpha");
    assert.equal(initialRepositoryOf({ projectId: null }, listed, "beta"), null);
    assert.equal(initialRepositoryOf({ projectId: "gone" }, listed, "beta"), null);
    assert.equal(initialRepositoryOf(null, listed, "gone"), null);
  });
});
