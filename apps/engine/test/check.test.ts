import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { SandboxReport, SandboxStopCode } from "@nivra/domain";
import { BoundaryUnavailableError, type ExecutionBackend } from "../src/exec/backend.ts";
import { CHECK_IMAGE, checkRecipe, checkReport, previewOf, PROBE_SCRIPT, safeUnresolved, STOP_MESSAGES, stopWords } from "../src/exec/check.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { NEBIUS_CAPABILITIES } from "../src/exec/nebius/session.ts";
import { runPrescribed, type PrescribedResult } from "../src/exec/prescribed.ts";
import { IMAGE } from "../scripts/sandbox-fixture.ts";
import { changedSince, cleanUp, folderState, GIT, put, repoWith, scratch, snap } from "./workspace-fixtures.ts";

/**
 * The sandbox check's own parts (NIV-44, D36): its probe, run with this machine's tools; its one-step recipe; the words
 * a stopped check says, by code; what of cleanup's record may leave the engine; and a run bound to its preview.
 */
after(cleanUp);

describe("the sandbox check's recipe (NIV-44)", () => {
  it("probes with this machine's own tools, printing what the workspace holds and writing nothing", () => {
    const folder = scratch("probe");
    put(folder, "a.txt", "a\n");
    put(folder, "src/b.ts", "b\n");
    put(folder, "link", { link: "a.txt" });
    const before = folderState(folder);
    const ran = spawnSync("/bin/sh", ["-c", PROBE_SCRIPT, "nivra-probe", folder, ""], { encoding: "utf8" });
    assert.deepEqual([ran.status, ran.stdout.replace(/^(files|links): +/gm, "$1: ")], [0, "busybox: \nfiles: 2\nlinks: 1\n"]);
    assert.deepEqual(changedSince(before, folder), [], "the probe wrote something");
  });

  it("is one step the engine owns, keeping nothing, on the image D28's runs and B3's check used", () => {
    const [probe, ...rest] = checkRecipe();
    assert.deepEqual([rest.length, probe?.label, probe?.keeps, probe?.argv.slice(0, 2), probe?.argv[2] === PROBE_SCRIPT, probe?.argv.slice(3)], [0, "probe", false, ["/bin/sh", "-c"], true, ["nivra-probe", "/workspace", "/bin/busybox"]]);
    assert.deepEqual([CHECK_IMAGE.uuid, CHECK_IMAGE.tag], [IMAGE.uuid, IMAGE.tag]);
  });
});

describe("what a stopped check says, and what of cleanup leaves the engine (NIV-44, D29)", () => {
  it("gives every stop code Nivra's own words, short enough for the report", () => {
    assert.deepEqual(Object.keys(STOP_MESSAGES).sort(), [...SandboxStopCode.options].sort());
    assert.ok(Object.values(STOP_MESSAGES).every((words) => words.length > 0 && words.length <= 400 && !/[{}<>]/.test(words)), "a message is fixed text");
  });

  it("says nothing was sent only for a stop before the upload, whatever its code", () => {
    const codes = [...SandboxStopCode.options];
    for (const step of [null, "check", "run", "snapshot", "open"]) assert.deepEqual(codes.filter((code) => stopWords(code, step) !== STOP_MESSAGES[code]), [], `before the upload, at ${String(step)}`);
    for (const step of ["probe", "collect", "patch", "report"]) assert.deepEqual(codes.filter((code) => stopWords(code, step).includes("nothing was sent")), [], `after the upload, at ${step}`);
    // Git and the size limit check what comes back too, so they have words of their own after the upload.
    assert.match(stopWords("git", "patch"), /^Git failed while Nivra checked what came back from the sandbox, so nothing was proposed\. Your commit was uploaded/);
    assert.match(stopWords("limit", "patch"), /^What came back from the sandbox is larger than Nivra proposes at once/);
    assert.ok([...new Set(codes.map((code) => stopWords(code, "patch")))].every((words) => words.length <= 400 && !/[{}<>]/.test(words)), "a message is fixed text");
  });

  it("lets only cleanup's and recovery's own templates through, and gives fixed words for anything else", () => {
    const kept = [
      `It isn't known whether "probe" started (correlation ${randomUUID()}); it may still be running.`,
      "Operation 0d6b1f5e-7a8c-4d6e-9f1a-2b3c4d5e6f70 wasn't seen to end; it may still be running.",
      "Not looked at in this pass: it ran out of time. It stays for the next.",
    ];
    assert.deepEqual(kept.map(safeUnresolved), kept);
    const replaced = [
      "Closing the session failed (EACCES: permission denied, open '/home/someone/.nivra/sandbox/abc.jsonl'); what it started may still be running.",
      "This pass couldn't settle it (the token private-plain-text was refused). It stays for the next.",
      `It isn't known whether "probe" started (correlation /home/someone); it may still be running.`,
    ];
    const words = replaced.map(safeUnresolved);
    assert.ok(words.every((item) => item === words[0] && !/home|private/.test(item)), JSON.stringify(words));
  });

  it("reports a check from what the prescribed path gave: the code's words, cleanup's record made safe, and a proposal by its digests", () => {
    const result: PrescribedResult = {
      outcome: "uncertain",
      stopped: { code: "uncertain", message: "probe: /bin/sh wasn't seen to end (a private detail).", step: "probe", detail: "private-plain-text" },
      snapshot: { baseline: "b".repeat(40), prefix: "", fingerprint: "f".repeat(64), files: 2, archiveSha256: "a".repeat(64) },
      steps: [{ label: "probe", exitCode: null, signal: null, timedOut: false, cancelled: false, truncated: false, persisted: false, durationMs: null, status: null, usage: null, stdoutTail: "x".repeat(5_000), stderrTail: "" }],
      report: new TextEncoder().encode("{}"),
      proposal: { binding: {} as never, hash: "c".repeat(64), patch: new TextEncoder().encode("diff"), report: new TextEncoder().encode("{}") },
      cleanup: { steps: [], stopped: [], alreadyEnded: [], unresolved: ["Closing the session failed (private-plain-text)."], retained: { uploads: 1, images: 1, operations: 2, note: "Images are retained for 180 days." } },
    };
    const report = checkReport({ result, request: { runId: randomUUID(), clientRequestId: randomUUID() }, now: new Date("2026-10-21T08:00:00Z") });
    assert.equal(SandboxReport.safeParse(report).success, true);
    assert.deepEqual(report.stopped, { code: "uncertain", step: "probe", message: STOP_MESSAGES.uncertain });
    assert.deepEqual([report.steps[0]?.stdoutTail.length, report.proposal?.patchBytes, report.reportSha256], [2_000, 4, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"]);
    assert.ok(!JSON.stringify(report).includes("private-plain-text"), "nothing of an error's own words is reported");
  });
});

describe("a run bound to its preview (NIV-44, D36)", () => {
  it("goes no further than the snapshot when it isn't the one shown, and on to the session when it is", async () => {
    const repo = repoWith({ "README.md": "# r\n" });
    let opened = 0;
    const backend: ExecutionBackend = {
      id: "nebius-sandbox",
      label: "Nebius Sandboxes (a stand-in)",
      capabilities: NEBIUS_CAPABILITIES,
      open: async () => {
        opened++;
        throw new BoundaryUnavailableError("The stand-in opens no session.");
      },
    };
    const local = await createLocalBackend({ baseEnv: process.env }).open({ workspace: repo });
    try {
      const run = (expectedFingerprint: string) => runPrescribed({ project: randomUUID(), target: "local", folder: repo, expectedFingerprint, steps: checkRecipe(), backend, local, git: GIT });
      const moved = await run("0".repeat(64));
      assert.deepEqual([moved.outcome, moved.stopped?.code, moved.stopped?.step, opened], ["refused", "preview", "snapshot", 0]);
      const shown = previewOf(await snap(repo));
      const kept = await run(shown.status === "ready" ? shown.fingerprint : "");
      assert.deepEqual([kept.stopped?.code, opened], ["boundary", 1]);
    } finally {
      await local.close();
    }
  });
});
