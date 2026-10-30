import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExecutionBackend } from "../src/exec/backend.ts";
import type { Transport } from "../src/exec/nebius/api.ts";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { verifyProposal } from "../src/exec/proposal.ts";
import { operationsForBrief } from "../src/task/worker.ts";
import { clock } from "./fake-sandboxes.ts";
import type { RealGuest } from "./real-guest.ts";
import { attempt, BRIEF, FIX, FIXTURE, KEY, labels, PROJECT, verdicts, type Call } from "./task-fixtures.ts";
import { cleanUp, scratch } from "./workspace-fixtures.ts";

/**
 * A task's worker (NIV-7, D39) on the production session and prescribed path, against the fake Nebius service with a
 * guest that really runs each command on this machine, and a model stand-in (`task-fixtures.ts`).
 */
after(cleanUp);

describe("a task's worker (NIV-7, D39)", () => {
  it("stops before another model request when a frozen preference becomes a saved credential", async () => {
    const privateText = "private-value-that-becomes-a-key"; let saved = false;
    const run = await attempt({
      extra: { preferences: { revision: 1, records: [{ id: randomUUID(), statement: privateText, scope: "personal", intent: "default", revision: 1 }] }, choices: [], mask: (text) => saved ? text.replaceAll(privateText, "[redacted]") : text },
      beforeRequest: () => { saved = true; },
    });
    assert.equal(run.requests(), 1);
    assert.equal(run.result.outcome, "failed");
    assert.equal(JSON.stringify(run.core).includes(privateText), false);
    assert.match(run.result.stopped?.message ?? "", /credential/);
  });

  it("carries labelled preference intent and run choices through every model request including hand-in", async () => {
    const preferences = { revision: 4, records: [
      { id: randomUUID(), statement: "Personal default canary", scope: "personal" as const, intent: "default" as const, revision: 1 },
      { id: randomUUID(), statement: "Project decision canary", scope: "project" as const, intent: "override" as const, revision: 2 },
    ] };
    const run = await attempt({ extra: { preferences, choices: ["Run-only choice canary"] } });
    assert.equal(run.requests(), 4);
    for (const prompt of run.prompts()) {
      for (const marker of ["Personal default canary", "Project decision canary", "Run-only choice canary", "Precedence, highest first", "scope", "intent", "cannot waive task acceptance", "required checks"]) assert.equal(prompt.includes(marker), true, marker);
    }
    assert.equal(run.core!.verified, true);
    assert.equal(run.offered().at(-1)!.includes("submit"), true);
  });

  it("reads, fixes and checks the fixture in the sandbox, and proposes a verified change bound to the attempt, the checkout untouched", async () => {
    const run = await attempt();
    assert.deepEqual([run.result.outcome, run.result.stopped], ["proposed", null]);
    assert.deepEqual(run.changed, [], "the checkout changed");
    assert.deepEqual(verdicts(run.core), ["case 1 passed", "check 1 passed"]);
    // The case sources greet.sh, which the fix changes: named beside it, as a case judges only what it prints.
    assert.deepEqual(run.core!.checks.map((check) => check.changedFiles), [["greet.sh"], []]);
    assert.deepEqual([run.core!.verified, run.core!.worker.handedIn, run.core!.worker.ended, run.core!.worker.written], [true, true, "submitted", ["greet.sh"]]);
    // Each operation: the workspace, toolchain, before check, write, worker's run, collect, final checks.
    assert.deepEqual(labels(run.guest), ["nivra-prepare", "nivra-toolchain", "command", "nivra-write", "command", "nivra-collect", "command", "command"]);
    assert.deepEqual(run.guest.ran.map((ran) => ran.disposable), [false, true, true, false, true, false, true, true]);
    assert.deepEqual(run.core!.beforeChecks.map((check) => [check.number, check.verdict]), [[1, "failed"]]);
    assert.equal(run.core!.beforeChecks[0]!.commandSha256, run.core!.checks[1]!.commandSha256);
    const proposal = run.result.proposal!;
    assert.match(new TextDecoder().decode(proposal.patch), /^\+  printf 'Hello, %s\\n' "\$\{1:-world\}"$/m);
    assert.deepEqual(proposal.binding.paths.map((path) => [path.path, path.change]), [["greet.sh", "changed"]]);
    assert.equal(proposal.binding.task?.brief.sha256, "b".repeat(64));
    const report = JSON.parse(new TextDecoder().decode(proposal.report)) as { kind: string; verified: boolean; worker: { summary: string } };
    assert.deepEqual([report.kind, report.verified, report.worker.summary], ["task", true, "Defaulted the name to world."]);
    const expected = { project: proposal.binding.project, target: "local", destination: proposal.binding.destination, head: proposal.binding.baseline, approvedHash: proposal.hash };
    verifyProposal(proposal, expected);
    verifyProposal(proposal, { ...expected, task: proposal.binding.task! });
    // Another attempt, another engine's records or another brief version: refused, whatever else matches.
    for (const task of [
      { ...proposal.binding.task!, attempt: { ...proposal.binding.task!.attempt, attemptId: "another" } },
      { ...proposal.binding.task!, engine: { homeId: "another" } },
      { ...proposal.binding.task!, brief: { ...proposal.binding.task!.brief, version: 2 } },
    ]) {
      assert.throws(() => verifyProposal(proposal, { ...expected, task }), /made by another run, on another engine's records, or from another version of the brief/);
    }
    assert.equal(run.result.cleanup?.unresolved.length, 0);
  });

  it("names a script a case runs that the worker rewrote, beside the case's pass: the case judges only what it prints", async () => {
    const brief = { ...BRIEF, checks: [], acceptanceCases: [{ name: "check passes", command: "/bin/sh check.sh", expectedOutput: "ok\n", expectedExitCode: 0 }] };
    const run = await attempt({ brief, calls: [["edit_file", { path: "check.sh", old_text: FIXTURE["check.sh"], new_text: "echo ok\n" }]] });
    assert.deepEqual([run.result.outcome, verdicts(run.core), run.core!.checks[0]!.changedFiles], ["proposed", ["case 1 passed"], ["check.sh"]]);
  });

  it("names a script a case runs by its quoted name that the worker rewrote, so the warning isn't lost", async () => {
    const brief = { ...BRIEF, checks: [], acceptanceCases: [{ name: "check passes", command: "/bin/sh 'check.sh'", expectedOutput: "ok\n", expectedExitCode: 0 }] };
    const run = await attempt({ brief, calls: [["edit_file", { path: "check.sh", old_text: FIXTURE["check.sh"], new_text: "echo ok\n" }]] });
    const check = run.core!.checks[0]!;
    assert.deepEqual([run.result.outcome, run.core!.verified, verdicts(run.core), check.changedFiles, check.unclear], ["proposed", true, ["case 1 passed"], ["check.sh"], false]);
  });

  it("says a case or check whose command it can't read may run what the worker changed, and says it only once the worker changed something", async () => {
    const unreadable = '/bin/sh -c "$(cat check.sh)"';
    const brief = { ...BRIEF, checks: [unreadable], acceptanceCases: [{ name: "check passes", command: unreadable, expectedOutput: "ok\n", expectedExitCode: 0 }] };
    const run = await attempt({ brief, calls: [["edit_file", { path: "check.sh", old_text: FIXTURE["check.sh"], new_text: "echo ok\n" }]] });
    assert.deepEqual([run.result.outcome, verdicts(run.core)], ["proposed", ["case 1 passed", "check 1 passed"]]);
    assert.deepEqual(run.core!.checks.map((check) => [check.changedFiles, check.unclear]), [[[], true], [[], true]]);
    const idle = await attempt({ brief, calls: [["read_file", { path: "check.sh" }]] });
    assert.deepEqual([idle.result.outcome, idle.core!.worker.written, idle.core!.checks.map((check) => check.unclear)], ["unchanged", [], [false, false]]);
  });

  it("passes on no refusal's own words: a damaged journal's path never reaches the model, the run's events or its report", async () => {
    const journalDir = scratch("journal path");
    const time = clock();
    let guest: RealGuest | null = null;
    let damaged = false;
    const progress: string[] = [];
    // Once the toolchain probe has ended, a line of the session's journal is damaged (a disk fault, say).
    const backend: ExecutionBackend = createNebiusBackend({
      credentials: () => ({ key: KEY, project: PROJECT }),
      baseImage: "base-image",
      journalDir,
      transport: (): Transport => async (request) => {
        const answer = await guest!.service.transport(request);
        const read = /^\/v1\/operations\/([^/]+)$/.exec(request.path);
        const operation = read && request.method === "GET" ? guest!.service.operations.find((candidate) => candidate.uuid === read[1]) : undefined;
        if (!damaged && operation && JSON.stringify(operation.body["args"]).includes("nivra-toolchain") && operation.status === "SUCCESS") {
          damaged = true;
          for (const name of readdirSync(journalDir).filter((file) => file.endsWith(".jsonl"))) appendFileSync(join(journalDir, name), "not json\n");
        }
        return answer;
      },
      applets: "",
      limits: { maxOperations: operationsForBrief(BRIEF), maxTimeoutSeconds: 60, prepareTimeoutSeconds: 60, pollMs: 10 },
      now: time.now,
      sleep: time.sleep,
    });
    const run = await attempt({ time, setup: (given) => void (guest = given), extra: { backend, progress: (message) => void progress.push(message) } });
    const sent = JSON.stringify((run.model as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls);
    assert.equal(damaged, true);
    assert.deepEqual([progress.filter((line) => line.includes(journalDir)), sent.includes(journalDir), JSON.stringify(run.core).includes(journalDir)], [[], false, false]);
    assert.equal(run.requests(), 0, "a refused before-change check still started the worker");
    assert.equal(run.core!.beforeChecks[0]!.reason, "it wasn't sent: the sandbox session refused it");
    assert.equal(run.result.proposal, null);
  });

  it("stops where the person's cancel lands during the final checks: the checks left read as not run, and nothing is proposed", async () => {
    const cancel = new AbortController();
    // The worker fixes greet.sh and hands in; the case's final run is read back, and then the person cancels.
    const run = await attempt({
      calls: [["edit_file", FIX]],
      signal: cancel.signal,
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        const read = /^\/v1\/operations\/([^/]+)$/.exec(request.path);
        const operation = read && request.method === "GET" ? guest.service.operations.find((candidate) => candidate.uuid === read[1]) : undefined;
        if (operation && JSON.stringify(operation.body["args"]).includes("greet Ada") && operation.status === "SUCCESS" && !cancel.signal.aborted) cancel.abort(new Error("the person cancelled"));
        return answer;
      },
    });
    // It stops where the cancel landed, and no patch is begun after it.
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.stopped?.step, run.result.proposal, run.result.cleanup?.unresolved.length], ["cancelled", "cancelled", "verify", null, 0]);
    assert.deepEqual(run.core!.checks.map((check) => `${check.kind} ${check.number} ${check.verdict}`), ["case 1 passed", "check 1 not-run"]);
    assert.equal(run.core!.checks[1]!.reason, "the run was cancelled before it ran");
  });

  it("calls a case whose output the sandbox didn't report unknown, never a pass on empty output", async () => {
    const brief = { ...BRIEF, checks: [], acceptanceCases: [{ name: "prints nothing", command: "true", expectedOutput: "", expectedExitCode: 0 }] };
    // The service answers the case's operation with no stdout stream at all.
    const run = await attempt({
      brief,
      calls: [],
      wrap: (transport, guest) => async (request) => {
        const answer = await transport(request);
        const read = /^\/v1\/operations\/([^/]+)$/.exec(request.path);
        const operation = read && request.method === "GET" ? guest.service.operations.find((candidate) => candidate.uuid === read[1]) : undefined;
        if (!operation || (operation.body["args"] as string[])[1] !== "true") return answer;
        const body = JSON.parse(new TextDecoder().decode(answer.body)) as { metadata?: { result?: { stdout?: unknown } | null } };
        if (body.metadata?.result) delete body.metadata.result.stdout;
        return { ...answer, body: new TextEncoder().encode(JSON.stringify(body)) };
      },
    });
    assert.deepEqual(run.core!.checks.map((check) => [check.verdict, check.reason]), [["unknown", "the sandbox didn't report what it printed as text, so it couldn't be compared"]]);
    assert.equal(run.core!.verified, false);
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

  it("refuses a tool call past its calls, leaves the worker only handing in, and counts it", async () => {
    const listing: Call[] = Array.from({ length: 49 }, () => ["list_files", {}]);
    const run = await attempt({ calls: [listing] });
    assert.deepEqual([run.core!.worker.tools.calls, run.core!.worker.tools.refused, run.core!.worker.handInDue, run.core!.worker.handedIn, run.core!.worker.ended], [50, 1, "tool-calls", true, "submitted"]);
  });

  it("offers only handing in on its last request, and stops at its requests when the worker never hands in", async () => {
    const listing: Call[] = Array.from({ length: 25 }, () => ["list_files", {}]);
    const run = await attempt({ calls: listing });
    assert.deepEqual([run.requests(), run.core!.worker.usage.calls, run.core!.worker.handInDue, run.core!.worker.handedIn, run.core!.worker.ended], [24, 24, "last-request", false, "requests"]);
    // The run still collects and checks: the worker's limits end its loop, never the run.
    assert.deepEqual([run.result.outcome, verdicts(run.core)], ["unchanged", ["case 1 failed", "check 1 failed"]]);
  });

  it("finds with search_files what it then reads, edits and checks, and proposes the verified change (NIV-35)", async () => {
    const run = await attempt({ calls: [["search_files", { text: "GREET()", in: "content" }], ["read_file", { path: "greet.sh" }], ["edit_file", FIX], ["run_case", { number: 1 }]] });
    assert.deepEqual([run.result.outcome, run.core!.verified, verdicts(run.core), run.core!.worker.written], ["proposed", true, ["case 1 passed", "check 1 passed"], ["greet.sh"]]);
    // The search's answer, as the next request carried it: the line where greet is defined, found ignoring case, and
    // what the attempt has left once that first request is answered.
    assert.ok(run.prompts()[1]!.includes('"matches":[{"path":"greet.sh","line":1,"text":"greet() {"}],"total":1,"truncated":false'), run.prompts()[1]!.slice(-600));
    assert.match(run.prompts()[1]!, /"left":\{"modelRequests":23,"toolCalls":47,"writes":8,"runs":4,"seconds":\d+,"estimatedInputTokens":\d+\}/);
    // After the write and the run, what is left counts them.
    assert.match(run.prompts()[4]!, /"left":\{"modelRequests":20,"toolCalls":44,"writes":7,"runs":3,"seconds":\d+,"estimatedInputTokens":\d+\}/);
    assert.ok(!run.prompts().some((prompt) => prompt.includes("near its end")), "no end note in a short attempt");
  });

  it("says what is left with every answer, and before its last request that handing in unchanged is fair; it never makes the worker write (NIV-35)", async () => {
    const searching: Call[] = Array.from({ length: 23 }, () => ["search_files", { text: "greet", in: "names" }]);
    const run = await attempt({ calls: searching });
    const note = "This attempt is near its end: 4 model requests are left, the last of them only for handing in. If you have a change you can justify, write it and run its case now. If you don't, hand in and say what you found: handing in unchanged is a fair result.";
    // The note comes with the answers once 4 requests are left after the one under way, never before, and its advice
    // follows what can still be done: one request with tools, then only handing in.
    assert.deepEqual([run.prompts()[19]!.includes("near its end"), run.prompts()[20]!.includes(note)], [false, true]);
    assert.ok(run.prompts()[22]!.includes("2 model requests are left, the last of them only for handing in. There is room for one more request with tools: use it for a change you can justify, or hand in now. Handing in unchanged is a fair result."), run.prompts()[22]!.slice(-800));
    assert.ok(run.prompts()[23]!.includes("1 model request is left, the last of them only for handing in. Your next request can only hand in: say what you changed, or what you found. Handing in unchanged is a fair result."), run.prompts()[23]!.slice(-800));
    // The last request offers only handing in; the worker hands in with nothing written, and nothing was written for it.
    assert.deepEqual([run.offered()[22]!.length, run.offered()[23]], [8, ["submit"]]);
    assert.deepEqual([run.requests(), run.core!.worker.handInDue, run.core!.worker.handedIn, run.core!.worker.ended, run.core!.worker.tools.writes, run.core!.worker.written], [24, "last-request", true, "submitted", 0, []]);
    assert.ok(!labels(run.guest).includes("nivra-write"), "a write was sent");
    assert.deepEqual([run.result.outcome, verdicts(run.core)], ["unchanged", ["case 1 failed", "check 1 failed"]]);
  });

  it("names the tool calls in the end note when they are what is running out (NIV-35)", async () => {
    const listing: Call[] = Array.from({ length: 43 }, () => ["list_files", {}]);
    const run = await attempt({ calls: [listing] });
    assert.ok(run.prompts()[1]!.includes("This attempt is near its end: 5 tool calls are left. If you have a change you can justify"), run.prompts()[1]!.slice(-700));
  });

  it("says the time for tools is running out before only handing in is left, then offers only handing in (NIV-35)", async () => {
    const time = clock();
    // Each request takes a minute of the work window, so its time, not its requests, ends the attempt.
    const run = await attempt({ time, handInWhenAsked: true, beforeRequest: () => void time.sleep(60_000), calls: Array.from({ length: 23 }, (): Call => ["search_files", { text: "greet", in: "names" }]) });
    const warned = run.prompts().findIndex((prompt) => /about \d+ seconds are left for tools/.test(prompt));
    const handIn = run.offered().findIndex((tools) => tools.length === 1 && tools[0] === "submit");
    assert.ok(warned > 0 && handIn > warned, `warned at ${warned}, only handing in from ${handIn}`);
    assert.deepEqual([run.core!.worker.handInDue, run.core!.worker.handedIn, run.core!.worker.tools.writes, run.requests() < 24], ["time", true, 0, true]);
  });

  it("offers only handing in, said beforehand, once the run's input budget holds no more than the hand-in (NIV-35)", async () => {
    const lines: string[] = [];
    const big = Array.from({ length: 160 }, () => "x".repeat(99)).join("\n");
    const files = { ...FIXTURE, ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`big/f${index}.txt`, big])) };
    // Eight 16 KB reads fill each request's context to about 45,000 tokens; small searches then keep it there.
    const calls: Call[] = [...Array.from({ length: 8 }, (_, index): Call => ["read_file", { path: `big/f${index}.txt` }]), ...Array.from({ length: 15 }, (): Call => ["search_files", { text: "greet", in: "names" }])];
    const run = await attempt({ files, calls, handInWhenAsked: true, usageFromPrompt: true, extra: { progress: (message) => void lines.push(message) } });
    const handIn = run.offered().findIndex((tools) => tools.length === 1 && tools[0] === "submit");
    assert.ok(handIn > 8 && handIn < 23, `only handing in from request ${handIn}`);
    assert.ok(run.prompts()[handIn - 1]!.includes("the run's input budget has room for about"), run.prompts()[handIn - 1]!.slice(-700));
    assert.ok(lines.includes("Only handing in is left: the run's input budget, or this request's context, has room for the hand-in and no more."), lines.join(" | "));
    assert.deepEqual([run.core!.worker.handInDue, run.core!.worker.handedIn, run.core!.worker.ended, run.core!.worker.tools.writes], ["last-request", true, "submitted", 0]);
  });

  it("keeps every request within its context's room: reads are cut, then refused, and only handing in is left (NIV-35)", async () => {
    const big = Array.from({ length: 160 }, () => "x".repeat(99)).join("\n");
    const files = { ...FIXTURE, ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`big/f${index}.txt`, big])) };
    const calls: Call[] = Array.from({ length: 23 }, (_, index): Call => ["read_file", { path: `big/f${index % 16}.txt` }]);
    const run = await attempt({ files, calls, handInWhenAsked: true, usageFromPrompt: true });
    // No request carried more than the per-request cap (D22), at three characters a token.
    const largest = Math.max(...run.prompts().map((prompt) => prompt.length));
    assert.ok(largest / 3 <= 64_000, `a request carried about ${Math.round(largest / 3)} tokens`);
    assert.ok(run.prompts().some((prompt) => prompt.includes("this request's context is nearly full, so nothing more is shown")));
    assert.deepEqual([run.core!.worker.handInDue, run.core!.worker.handedIn, run.core!.worker.tools.writes], ["last-request", true, 0]);
  });

  it("masks what a search finds before the model is given it (NIV-35)", async () => {
    const files = { ...FIXTURE, "notes.txt": "the passphrase is tango-hotel-42\n" };
    const run = await attempt({ files, calls: [["search_files", { text: "passphrase", in: "content" }]], extra: { mask: (text: string) => text.replaceAll("tango-hotel-42", "[masked]") } });
    assert.ok(run.prompts()[1]!.includes('"text":"the passphrase is [masked]"'), run.prompts()[1]!.slice(-500));
    assert.ok(!run.prompts()[1]!.includes("tango-hotel-42"));
  });

  it("searches only the workspace it was given, within its bounds: a folder outside it is refused, and a long result is cut and counted (NIV-35)", async () => {
    const files = { ...FIXTURE, "notes/many.txt": Array.from({ length: 50 }, (_, index) => `hit ${index}`).join("\n") };
    const run = await attempt({ files, calls: [["search_files", { text: "hit", in: "content", folder: "../outside" }], ["search_files", { text: "hit", in: "content", folder: "notes" }], ["search_files", { text: "/etc/passwd", in: "names" }]] });
    assert.ok(run.prompts()[1]!.includes('"refused":"folder must be one inside the repository, as list_files shows it, e.g. packages/domain"'), run.prompts()[1]!.slice(-600));
    const results = (JSON.parse(run.prompts()[2]!) as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content as Array<{ output: { value: unknown } }>)
      .map((part) => part.output.value);
    const found = results[1] as { matches: Array<{ path: string; line: number; text: string }>; total: number; truncated: boolean } | undefined;
    assert.deepEqual([found?.matches.length, found?.total, found?.truncated, found?.matches[0], found?.matches.at(-1)?.line], [40, 50, true, { path: "notes/many.txt", line: 1, text: "hit 0" }, 40]);
    // A path the workspace doesn't hold is simply not found: nothing outside the copy is read.
    assert.ok(run.prompts()[3]!.includes('"matches":[],"total":0,"truncated":false'), run.prompts()[3]!.slice(-600));
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

  it("never sends a final check twice when its start isn't known: the checks after it aren't run, and nothing is proposed", async () => {
    let lost = false;
    const run = await attempt({
      calls: [["edit_file", FIX]],
      wrap: (transport, guest) => (request) => {
        // The case's final run: its start's answer is lost, and the service doesn't list it.
        if (request.method === "POST" && request.path === "/v1/instances" && String(request.body).includes("greet Ada") && !lost) {
          lost = true;
          guest.service.dropNextSpawnAnswer = true;
          guest.service.hideNextSpawn = true;
        }
        return transport(request);
      },
    });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.stopped?.step, run.result.proposal], ["uncertain", "uncertain", "verify", null]);
    assert.deepEqual(run.core!.checks.map((check) => [check.kind, check.verdict, check.reason]), [
      ["case", "unknown", "it isn't known whether it started, so it wasn't sent again"],
      ["check", "not-run", "an earlier check's start wasn't settled, so nothing more ran in the session"],
    ]);
    assert.deepEqual([run.core!.verified, run.guest.ran.filter((ran) => ran.script?.includes("greet Ada")).length, labels(run.guest).includes("command")], [false, 1, true]);
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
