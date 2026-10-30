import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { attempt, BRIEF, FIX, FIXTURE, labels, type Call } from "./task-fixtures.ts";
import { clock } from "./fake-sandboxes.ts";
import { cleanUp } from "./workspace-fixtures.ts";

after(cleanUp);
describe("NIV-60 precise editing and termination", () => {
  it("splices a larger executable file preserving CRLF, Unicode and trailing newlines", async () => {
    const text = `# café 👩🏽‍💻\r\n${"# unchanged padding\r\n".repeat(2300)}${FIXTURE["greet.sh"]}\n\n`;
    const run = await attempt({ files: { ...FIXTURE, "greet.sh": { executable: text } }, calls: [["edit_file", FIX]] });
    assert.equal(run.core!.verified, true);
    assert.equal(run.core!.worker.tools.writes, 1);
    const change = run.result.proposal!.binding.paths.find((file) => file.path === "greet.sh")!;
    assert.equal(change.after!.mode, "100755");
    const write = run.guest.ran.find((operation) => operation.label === "nivra-write")!;
    assert.equal(write.args.join(" ").length < 32768, true);
    const patch = new TextDecoder().decode(run.result.proposal!.patch);
    assert.equal(patch.includes('"${1:-world}"'), true);
  });

  it("uses no writes for no-op edits and permits the next useful edit", async () => {
    const run = await attempt({ calls: [["edit_file", { ...FIX, new_text: FIX.old_text }], ["edit_file", FIX]] });
    assert.equal(run.core!.worker.tools.refused, 1);
    assert.equal(run.core!.worker.tools.writes, 1);
    assert.equal(labels(run.guest).filter((label) => label === "nivra-write").length, 1);
    assert.equal(run.core!.verified, true);
  });

  it("does not execute work after submit in the same response", async () => {
    const run = await attempt({ calls: [[["submit", { summary: "Handing in unchanged." }], ["edit_file", FIX]]] });
    assert.equal(run.core!.worker.handedIn, true);
    assert.equal(run.core!.worker.tools.writes, 0);
    assert.equal(run.core!.worker.tools.refused, 1);
    assert.equal(labels(run.guest).includes("nivra-write"), false);
  });

  it("finalises after three identical failed edits against unchanged state", async () => {
    const run = await attempt({ calls: Array.from({ length: 7 }, () => ["edit_file", { ...FIX, old_text: "missing span" }]), handInWhenAsked: true });
    assert.equal(run.requests(), 4);
    assert.equal(run.core!.worker.handInDue, "no-progress");
    assert.equal(run.core!.worker.tools.writes, 0);
    assert.equal(run.core!.worker.handedIn, true);
    assert.equal(run.core!.checks.length, 2);
  });

  it("reports an early model completion without submission accurately", async () => {
    const run = await attempt({ calls: [["(ended)", {}]] });
    assert.equal(run.requests(), 1);
    assert.equal(run.core!.worker.ended, "model-ended");
    assert.equal(run.core!.worker.handedIn, false);
    assert.equal(run.core!.checks.length, 2);
  });

  it("finalises repeated failed checks but permits reads between them", async () => {
    const calls = Array.from({ length: 3 }, (): Call[] => [["run_case", { number: 1 }], ["read_file", { path: "greet.sh" }]]).flat();
    const run = await attempt({ calls, handInWhenAsked: true });
    assert.equal(run.core!.worker.handInDue, "no-progress");
    assert.equal(run.core!.worker.tools.runs, 3);
    assert.equal(run.core!.worker.handedIn, true);
    assert.equal(run.core!.verified, false);
    assert.equal(run.core!.checks.length, 2);
  });

  it("starts counting repeated failures afresh after a verified workspace change", async () => {
    const missing = { ...FIX, old_text: "missing span" };
    const run = await attempt({ calls: [["edit_file", missing], ["edit_file", missing], ["edit_file", FIX], ["edit_file", { ...FIX, old_text: FIX.new_text, new_text: FIX.old_text }], ["edit_file", missing]] });
    assert.equal(run.requests(), 6);
    assert.equal(run.core!.worker.handInDue, null);
    assert.equal(run.core!.worker.tools.refused, 3);
    assert.equal(run.core!.worker.tools.writes, 2);
  });

  it("uses only one reserved hand-in even when the model does not submit", async () => {
    const time = clock();
    const run = await attempt({ journal: true, time, calls: Array.from({ length: 23 }, () => ["read_file", { path: "greet.sh" }]), beforeRequest: () => void time.sleep(60_000) });
    assert.equal(run.outputCaps().filter((value) => value === 1500).length, 1);
    assert.equal(run.core!.worker.handInDue, "time");
    assert.equal(run.core!.worker.handedIn, false);
    assert.equal(run.core!.worker.ended, "model-ended");
  });

  it("does not classify repeated successful reads as no progress", async () => {
    const run = await attempt({ calls: Array.from({ length: 6 }, () => ["read_file", { path: "greet.sh" }]) });
    assert.equal(run.requests(), 7);
    assert.equal(run.core!.worker.handInDue, null);
  });

  it("refuses a stale remote preimage without overwriting it or proposing a change", async () => {
    const run = await attempt({ calls: [["edit_file", FIX]], setup: (guest) => {
      const intercept = guest.intercept;
      guest.intercept = (operation, folder) => {
        if (operation.label === "nivra-write") writeFileSync(join(folder, "workspace", "greet.sh"), "# changed outside the worker\n");
        return intercept(operation, folder);
      };
    } });
    assert.equal(run.result.proposal, null);
    assert.equal(run.result.outcome, "failed");
    assert.equal(run.core!.worker.written.length, 0);
  });
});
