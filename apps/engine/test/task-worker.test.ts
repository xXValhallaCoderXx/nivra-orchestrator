import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { verifyProposal } from "../src/exec/proposal.ts";
import type { RealGuest } from "./real-guest.ts";
import { attempt, BRIEF, FIX, FIXTURE, KEY, labels, verdicts, type Call } from "./task-fixtures.ts";
import { cleanUp } from "./workspace-fixtures.ts";

/**
 * A task's worker (NIV-7, D39) on the production session and prescribed path, against the fake Nebius service with a
 * guest that really runs each command on this machine, and a model stand-in (`task-fixtures.ts`).
 */
after(cleanUp);

describe("a task's worker (NIV-7, D39)", () => {
  it("reads, fixes and checks the fixture in the sandbox, and proposes a verified change bound to the attempt, the checkout untouched", async () => {
    const run = await attempt();
    assert.deepEqual([run.result.outcome, run.result.stopped], ["proposed", null]);
    assert.deepEqual(run.changed, [], "the checkout changed");
    assert.deepEqual(verdicts(run.core), ["case 1 passed", "check 1 passed"]);
    assert.deepEqual([run.core!.verified, run.core!.worker.handedIn, run.core!.worker.ended, run.core!.worker.written], [true, true, "submitted", ["greet.sh"]]);
    // Each operation, in order: the workspace, the toolchain, the write, the worker's run, collect, the final checks.
    assert.deepEqual(labels(run.guest), ["nivra-prepare", "nivra-toolchain", "nivra-write", "command", "nivra-collect", "command", "command"]);
    assert.deepEqual(run.guest.ran.map((ran) => ran.disposable), [false, true, false, true, false, true, true]);
    const proposal = run.result.proposal!;
    assert.match(new TextDecoder().decode(proposal.patch), /^\+  printf 'Hello, %s\\n' "\$\{1:-world\}"$/m);
    assert.deepEqual(proposal.binding.paths.map((path) => [path.path, path.change]), [["greet.sh", "changed"]]);
    assert.equal(proposal.binding.task?.brief.sha256, "b".repeat(64));
    const report = JSON.parse(new TextDecoder().decode(proposal.report)) as { kind: string; verified: boolean; worker: { summary: string } };
    assert.deepEqual([report.kind, report.verified, report.worker.summary], ["task", true, "Defaulted the name to world."]);
    verifyProposal(proposal, { project: proposal.binding.project, target: "local", destination: proposal.binding.destination, head: proposal.binding.baseline, approvedHash: proposal.hash });
    assert.equal(run.result.cleanup?.unresolved.length, 0);
  });

  it("isn't fooled by a replaced repository check: the check passes, its change is shown, and the case still fails", async () => {
    const run = await attempt({ calls: [["edit_file", { path: "check.sh", old_text: FIXTURE["check.sh"], new_text: "exit 0\n" }]] });
    assert.deepEqual([run.result.outcome, verdicts(run.core), run.core!.verified], ["proposed", ["case 1 failed", "check 1 passed"], false]);
    const check = run.core!.checks.find((result) => result.kind === "check")!;
    assert.deepEqual(check.changedFiles, ["check.sh"]);
    assert.match(run.core!.checks[0]!.reason ?? "", /its output differs from the expected output/);
    assert.deepEqual(run.changed, []);
  });

  it("isn't fooled by an exit before the assertions: the case judges the output, which is empty", async () => {
    const run = await attempt({ calls: [["edit_file", { path: "greet.sh", old_text: "greet() {", new_text: "exit 0\ngreet() {" }]] });
    assert.deepEqual([run.result.outcome, verdicts(run.core), run.core!.verified], ["proposed", ["case 1 failed", "check 1 passed"], false]);
    assert.deepEqual(run.core!.checks[0]!.difference, { line: 1, expected: "Hello, Ada", got: "" });
  });

  it("stops before the model when a program the brief needs isn't in the image, and installs nothing", async () => {
    const brief = { ...BRIEF, acceptanceCases: [{ ...BRIEF.acceptanceCases[0]!, command: "nivra-no-such-tool --version" }] };
    const run = await attempt({ brief });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.requests()], ["refused", "toolchain", 0]);
    assert.match(run.result.stopped!.message, /^The sandbox image has no nivra-no-such-tool, which acceptance case 1 needs\. Nothing was installed, and nothing ran on your computer\.$/);
    assert.deepEqual(verdicts(run.core), ["case 1 couldnt-run", "check 1 not-run"]);
    assert.deepEqual(labels(run.guest), ["nivra-prepare", "nivra-toolchain"]);
    assert.equal(run.result.proposal, null);
  });

  it("calls a case that exits 127 on purpose failed, with its code, never missing", async () => {
    const brief = { ...BRIEF, acceptanceCases: [{ ...BRIEF.acceptanceCases[0]!, command: "/bin/sh -c 'exit 127'" }] };
    const run = await attempt({ brief, calls: [] });
    assert.deepEqual(verdicts(run.core), ["case 1 failed", "check 1 failed"]);
    assert.match(run.core!.checks[0]!.reason ?? "", /it exited 127, not 0/);
  });

  it("refuses writes outside the rules before anything is sent, and the run goes on", async () => {
    const run = await attempt({
      files: { ...FIXTURE, "docs/link": "unused" },
      calls: [
        ["create_file", { path: "../outside.txt", content: "x" }],
        ["create_file", { path: ".git/config", content: "x" }],
        ["create_file", { path: "node_modules/x.js", content: "x" }],
        ["create_file", { path: ".env", content: "A=1\n" }],
        ["create_file", { path: "greet.sh/inner", content: "x" }],
        ["create_file", { path: "ok.txt", content: `token ghp_${"a1B2".repeat(9)}\n` }],
        ["create_file", { path: "key.txt", content: `${KEY}\n` }],
        ["edit_file", { path: "greet.sh", old_text: "not there", new_text: "x" }],
        ["run_check", { number: 3 }],
        ["edit_file", FIX],
      ],
    });
    assert.equal(run.result.outcome, "proposed");
    assert.deepEqual(labels(run.guest).filter((label) => label === "nivra-write").length, 1, "a refused write was sent");
    assert.equal(run.core!.worker.tools.refused, 9);
    assert.deepEqual(run.core!.worker.written, ["greet.sh"]);
    assert.equal(run.core!.verified, true);
  });

  it("counts input that doesn't match a tool's schema, and never runs it", async () => {
    const run = await attempt({ calls: [["edit_file", { path: "greet.sh" }], ["edit_file", FIX]] });
    assert.deepEqual([run.result.outcome, run.core!.worker.tools.rejected, run.core!.verified], ["proposed", 1, true]);
  });

  it("stops writing after its writes are used, and running after its runs are used", async () => {
    const writes: Call[] = Array.from({ length: 9 }, (_, index) => ["create_file", { path: `n${index}.txt`, content: `${index}\n` }]);
    const runs: Call[] = Array.from({ length: 5 }, () => ["run_case", { number: 1 }]);
    const run = await attempt({ calls: [writes, runs] });
    assert.deepEqual([run.core!.worker.tools.writes, run.core!.worker.tools.runs, run.core!.worker.tools.refused], [8, 4, 2]);
    assert.deepEqual(run.core!.worker.written.length, 8);
  });

  it("goes on when a write doesn't take, and says the file is as it was", async () => {
    const run = await attempt({ setup: (guest) => void (guest.intercept = ({ label }) => (label === "nivra-write" ? { statuses: ["SUCCESS"], exitCode: 1 } : undefined)), calls: [["edit_file", FIX]] });
    assert.deepEqual([run.result.outcome, run.core!.worker.written, run.core!.worker.tools.refused], ["unchanged", [], 1]);
  });

  it("stops with no proposal when the sandbox holds something Nivra didn't write", async () => {
    const run = await attempt({ setup: (guest) => void (guest.alter = ({ label }, folder) => label === "nivra-write" && writeFileSync(join(folder, "workspace", "extra.txt"), "x\n")) });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.proposal], ["refused", "result", null]);
    assert.match(run.result.stopped!.message, /"extra\.txt" is in it, and Nivra didn't write it/);
  });

  it("stops with no proposal when a write's state is lost: the session is stale, and nothing more runs", async () => {
    const run = await attempt({ setup: (guest) => void (guest.override = ({ label }) => (label === "nivra-write" ? { timedOut: true } : undefined)) });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.proposal], ["failed", "edit-failed", null]);
    assert.ok(!labels(run.guest).includes("nivra-collect"), "it collected from a stale session");
  });

  it("never sends a write twice when its start isn't known, and proposes nothing", async () => {
    let writes = 0;
    const run = await attempt({
      wrap: (transport, guest) => (request) => {
        if (request.method === "POST" && request.path === "/v1/instances" && String(request.body).includes("nivra-write") && writes++ === 0) {
          guest.service.dropNextSpawnAnswer = true;
          guest.service.hideNextSpawn = true;
        }
        return transport(request);
      },
    });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.proposal], ["uncertain", "uncertain", null]);
    assert.equal(labels(run.guest).filter((label) => label === "nivra-write").length, 1);
  });

  it("stops the operation under way when the person cancels, collects nothing, and still cleans up", async () => {
    const cancel = new AbortController();
    const isWrite = (guest: RealGuest, id: string) => JSON.stringify(guest.service.operations.find((op) => op.uuid === id)?.body["args"] ?? []).includes("nivra-write");
    const run = await attempt({
      signal: cancel.signal,
      setup: (guest) => void (guest.override = ({ label }) => (label === "nivra-write" ? { waits: true } : undefined)),
      // Cancelled once the write is seen running: after its start was answered, while it runs.
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        const read = /^\/v1\/operations\/([^/]+)$/.exec(request.path);
        if (request.method === "GET" && read && isWrite(guest, read[1]!) && !cancel.signal.aborted) cancel.abort(new Error("the person cancelled"));
        return answer;
      },
    });
    assert.deepEqual([run.result.outcome, run.result.proposal], ["cancelled", null]);
    assert.ok(!labels(run.guest).includes("nivra-collect"));
    assert.ok(run.result.cleanup !== null, "cleanup's record is missing");
    assert.equal(run.guest.service.operations.find((op) => op.body["args"] && JSON.stringify(op.body["args"]).includes("nivra-write"))?.cancelled, true, "the write wasn't stopped");
  });
});
