import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { TransportRequest } from "../src/exec/nebius/api.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { createNebiusBackend, reconcileJournals, scanJournals } from "../src/exec/nebius/session.ts";
import { runPrescribed, type PrescribedRun } from "../src/exec/prescribed.ts";
import { proposalHash, verifyProposal } from "../src/exec/proposal.ts";
import { applyFixedEdit, buildFixture, DENY, EDIT_SCRIPT, EXPECTED_CHANGE, fixtureRecipe, LONG_ADDED, type GuestNode } from "../scripts/sandbox-fixture.ts";
import { FakeGuest } from "./fake-guest.ts";
import { clock, holding, spawned } from "./fake-sandboxes.ts";
import { waitFor } from "./helpers.ts";
import { changedSince, cleanUp, collect, folderState, GIT, git, guestRun, localSession, scratch, sha, snap } from "./workspace-fixtures.ts";

/**
 * The prescribed path (NIV-43, D35) against the fake service and a fake guest, on the synthetic fixture: the one
 * composition the live check and the engine run. The fake guest does the recipe's commands in JavaScript, so these
 * tests check the orchestration; the scripts themselves run on this machine's tools below, and on busybox live.
 * Nothing here reaches the network. The run is never given an engine home, only a journal folder of its own.
 */
after(cleanUp);

const KEY = "nivra-prescribed-key-0123456789";
const PROJECT = "project-prescribed-0123";
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface Harness {
  guest: FakeGuest;
  time: ReturnType<typeof clock>;
  root: string;
  baseline: string;
  journalDir: string;
}

function harness(): Harness {
  const fixture = buildFixture(join(scratch("fixture"), "fixture repo"), GIT);
  return { guest: new FakeGuest(), time: clock(), root: fixture.root, baseline: fixture.baseline, journalDir: join(scratch("journals"), "sandbox") };
}

const backendFor = (h: Harness, transport = h.guest.service.transport) =>
  createNebiusBackend({ credentials: () => ({ key: KEY, project: PROJECT }), baseImage: h.guest.baseImage, journalDir: h.journalDir, transport: () => transport, now: h.time.now, sleep: h.time.sleep, wallNow: () => new Date("2026-10-21T12:00:00Z") });

/** A timer on the fake clock: a prescribed stop fires as soon as the clock is moved past it. */
const fakeTimer = (time: ReturnType<typeof clock>) => (ms: number, fire: () => void) => {
  let live = true;
  void time.sleep(ms).then(() => live && fire());
  return () => {
    live = false;
  };
};

async function prescribe(h: Harness, extra: Partial<PrescribedRun> = {}) {
  const local = await localSession(h.root);
  try {
    return await runPrescribed({ project: "project-1", target: "local", folder: h.root, baseline: h.baseline, steps: fixtureRecipe(), backend: backendFor(h), local, git: GIT, budgetMs: 600_000, closeBudgetMs: 420_000, timer: fakeTimer(h.time), ...extra });
  } finally {
    await local.close();
  }
}

/** The patch applied in a fresh clone of the fixture, from its top level: the tree it then holds. */
function treeAfterApplying(root: string, patch: Uint8Array): string {
  const clone = join(scratch("clone"), "fresh clone");
  git(dirname(clone), ["clone", "-q", "--no-hardlinks", root, clone]);
  const file = join(dirname(clone), "change.patch");
  writeFileSync(file, patch);
  git(clone, ["apply", "--check", file]);
  git(clone, ["apply", file]);
  git(clone, ["add", "-A"]);
  return git(clone, ["write-tree"]).trim();
}

describe("the prescribed path", () => {
  it("runs the fixture's recipe: a proposal holding exactly the fixed edit, a report telling each step truthfully, each spawn sent once, the checkout unchanged", async () => {
    const h = harness();
    const before = folderState(h.root);
    const result = await prescribe(h);
    assert.equal(result.outcome, "proposed", result.stopped?.message);
    assert.deepEqual(
      result.steps.map((step) => [step.label, step.exitCode, step.timedOut, step.cancelled, step.persisted, step.status]),
      [
        ["edit", 0, false, false, true, "SUCCESS"],
        ["network", 0, false, false, false, "SUCCESS"],
        ["check", 0, false, false, false, "SUCCESS"],
        ["failing check", 1, false, false, false, "SUCCESS"],
        ["timeout", -1, true, false, false, "SUCCESS"],
        ["stop", null, false, true, false, "CANCELLED"],
        ["collect", 0, false, false, true, "SUCCESS"],
      ],
    );
    const byLabel = new Map(result.steps.map((step) => [step.label, step]));
    assert.equal(byLabel.get("check")!.stdoutTail, "PASS: Hello, Nivra\n");
    assert.equal(byLabel.get("failing check")!.stdoutTail, "FAIL: this check fails on purpose\n");
    assert.match(byLabel.get("network")!.stdoutTail, new RegExp(`^BLOCKED ${DENY.byName}: .*\\nBLOCKED ${DENY.byIp}: `, "m"));
    assert.ok(result.steps.every((step) => step.usage !== null), "a step's usage, which the service reported, was lost");

    // The proposal: bound to this checkout's folder and commit, holding exactly the fixed edit.
    const proposal = result.proposal!;
    const destination = { root: realpathSync.native(h.root), prefix: "" };
    assert.deepEqual([proposal.binding.destination, proposal.binding.baseline, proposal.binding.project, proposal.binding.target], [destination, h.baseline, "project-1", "local"]);
    assert.equal(proposal.hash, proposalHash(proposal.binding));
    verifyProposal(proposal, { project: "project-1", target: "local", destination, head: h.baseline, approvedHash: proposal.hash });
    const report = JSON.parse(decode(proposal.report)) as { changes: Array<{ change: string; path: string; mode?: string; sha256?: string }>; modeChanges: unknown[] };
    assert.deepEqual(
      report.changes.map((change) => [change.change, change.path, change.mode ?? null, change.sha256 ?? null]),
      [
        ["deleted", "old.txt", null, null],
        ...EXPECTED_CHANGE.added.map((change) => ["added", change.path, change.mode, sha(change.bytes)]),
        ...EXPECTED_CHANGE.changed.map((change) => ["changed", change.path, change.mode, sha(change.bytes)]),
      ],
    );
    assert.deepEqual(report.modeChanges, EXPECTED_CHANGE.modeChanges);
    assert.equal(sha(proposal.report), proposal.binding.reportSha256);
    assert.equal(treeAfterApplying(h.root, proposal.patch), proposal.binding.resultTree);

    // Each operation once, networking off for every one, one upload; cleanup's own record.
    const service = h.guest.service;
    assert.deepEqual([service.spawns, service.uploads.length], [8, 1]);
    assert.ok(spawned(service).every((body) => body.networking.enabled === false));
    const cleanup = result.cleanup!;
    assert.deepEqual([cleanup.unresolved.length, cleanup.stopped.length, cleanup.retained?.uploads], [0, 1, 1]);
    assert.deepEqual(changedSince(before, h.root), [], "the checkout changed");
  });

  it("tells a passing check from a failing one: without the edit, the check fails truthfully and nothing is proposed", async () => {
    const without = await prescribe(harness(), { steps: fixtureRecipe().filter((step) => step.label !== "edit") });
    assert.deepEqual([without.outcome, without.proposal], ["unchanged", null]);
    const failed = without.steps.find((step) => step.label === "check")!;
    assert.deepEqual([failed.exitCode, failed.stdoutTail], [1, "FAIL: Hello, world\n"]);
    const withEdit = await prescribe(harness());
    const passed = withEdit.steps.find((step) => step.label === "check")!;
    assert.deepEqual([passed.exitCode, passed.stdoutTail], [0, "PASS: Hello, Nivra\n"]);
    // Each report says what happened in its own run.
    const reports = [without, withEdit].map((result) => JSON.parse(decode(result.report!)) as { changes: unknown[]; steps: Array<{ label: string; exitCode: number | null }> });
    assert.deepEqual(
      reports.map((report) => [report.changes.length, report.steps.find((step) => step.label === "check")!.exitCode]),
      [
        [0, 1],
        [5, 0],
      ],
    );
  });

  it("finds a spawn whose answer was lost by its correlation id, and follows that operation, sending nothing twice", async () => {
    const h = harness();
    let lost = false;
    h.guest.override = ({ args }) => {
      if (args[1] === EDIT_SCRIPT && !lost) {
        lost = true;
        h.guest.service.dropNextSpawnAnswer = true;
      }
      return undefined;
    };
    const result = await prescribe(h);
    assert.deepEqual([lost, result.outcome, h.guest.service.spawns], [true, "proposed", 8]);
  });

  it("stops when the sandbox no longer has the workspace's state, with no second upload and no restart from the commit", async () => {
    const h = harness();
    h.guest.expiresAfter = (_program, args) => args[1] === EDIT_SCRIPT;
    const result = await prescribe(h);
    assert.equal(result.outcome, "failed");
    assert.match(result.stopped!.message, /^The sandbox no longer has this workspace's saved state \(HTTP 410\)/);
    assert.deepEqual(
      result.steps.map((step) => step.label),
      ["edit"],
    );
    // The prepare step, the edit, and the network step's spawn, answered 410: nothing after it, nothing again.
    assert.deepEqual([h.guest.service.spawns, h.guest.service.uploads.length, result.proposal, result.cleanup!.unresolved.length], [3, 1, null, 0]);
  });

  it("stops at the person's cancel: the step under way is seen to stop, and nothing more runs", async () => {
    const h = harness();
    const controller = new AbortController();
    const isCheck = (request: TransportRequest) => request.method === "GET" && h.guest.service.operations.some((op) => request.path === `/v1/operations/${op.uuid}` && (op.body["args"] as string[])[0] === "bin/check.sh");
    let heldOnce = false;
    const { transport, held } = holding(h.guest.service, (request) => !heldOnce && isCheck(request) && (heldOnce = true));
    h.guest.override = ({ args }) => (args[0] === "bin/check.sh" ? { waits: true } : undefined);
    const running = prescribe(h, { backend: backendFor(h, transport), signal: controller.signal });
    await waitFor(() => held.length > 0, { what: "the check to be under way" });
    controller.abort();
    const result = await running;
    assert.deepEqual([result.outcome, result.proposal, result.report], ["cancelled", null, null]);
    assert.deepEqual(
      result.steps.map((step) => [step.label, step.cancelled, step.status]),
      [
        ["edit", false, "SUCCESS"],
        ["network", false, "SUCCESS"],
        ["check", true, "CANCELLED"],
      ],
    );
    assert.deepEqual([h.guest.service.spawns, result.cleanup!.stopped.length, result.cleanup!.unresolved.length], [4, 1, 0]);
  });

  it("never sends again a step whose start is unknown, leaves it visible when closing can't find it, and lets the next engine settle it from the journal", async () => {
    const h = harness();
    let lost = false;
    h.guest.override = ({ args }) => {
      if (args[0] !== "bin/check.sh" || lost) return undefined;
      lost = true;
      h.guest.service.dropNextSpawnAnswer = true;
      h.guest.service.hideNextSpawn = true;
      return { waits: true };
    };
    const result = await prescribe(h);
    assert.equal(result.outcome, "uncertain");
    assert.match(result.stopped!.message, /^It isn't known whether \/bin\/sh started/);
    assert.deepEqual([h.guest.service.spawns, result.cleanup!.unresolved.length], [4, 1]);

    // The engine restarts: a local scan finds the journal still open, and one bounded pass settles it once the service
    // lists the operation again. Nothing is sent twice, and the journal moves aside.
    const scan = scanJournals(h.journalDir);
    assert.equal(scan.open.length, 1);
    h.guest.service.hidden.clear();
    const recovered = await reconcileJournals(scan.open, { credentials: { key: KEY, project: PROJECT }, budgetMs: 420_000, transport: () => h.guest.service.transport, now: h.time.now, sleep: h.time.sleep, wallNow: () => new Date("2026-10-21T12:30:00Z") });
    assert.deepEqual(
      recovered.map((pass) => [pass.stopped.length, pass.unresolved.length]),
      [[1, 0]],
    );
    assert.deepEqual([h.guest.service.spawns, scanJournals(h.journalDir).open.length], [4, 0]);
    assert.deepEqual(readdirSync(join(h.journalDir, "settled")).length, 1);
  });

  it("leaves an operation the sandbox never stops unresolved and visible, within closing's budget, with what the provider keeps", async () => {
    const h = harness();
    h.guest.service.ignoreCancels = true;
    const result = await prescribe(h);
    // The prescribed stop asked; the sandbox accepted, and never stopped it.
    assert.equal(result.outcome, "uncertain");
    assert.deepEqual([h.guest.service.spawns, result.cleanup!.unresolved.length, result.cleanup!.retained?.uploads], [7, 1, 1]);
    assert.ok((result.cleanup!.retained?.images ?? 0) >= 2, "the images the run left weren't counted");
  });

  it("refuses before anything is sent: a backend that isolates nothing, a commit holding a token, a checkout that has moved on", async () => {
    const local = harness();
    const refusedLocal = await prescribe(local, { backend: createLocalBackend({ baseEnv: process.env }) });
    assert.equal(refusedLocal.outcome, "refused");
    // Its first refusal is the network: "No isolation" can't block it, and isolates no files either.
    assert.match(refusedLocal.stopped!.message, /^"No isolation" can't block network access, so this run was not started\./);
    assert.deepEqual([refusedLocal.cleanup, local.guest.service.requests.length], [null, 0]);

    const unsafe = harness();
    writeFileSync(join(unsafe.root, "config.ts"), `export const token = "ghp_${"a".repeat(36)}";\n`);
    git(unsafe.root, ["add", "config.ts"]);
    git(unsafe.root, ["commit", "-q", "-m", "a token"]);
    const refusedUnsafe = await prescribe(unsafe, { baseline: undefined });
    assert.deepEqual([refusedUnsafe.outcome, refusedUnsafe.stopped!.code, unsafe.guest.service.requests.length], ["refused", "content", 0]);

    const moved = harness();
    writeFileSync(join(moved.root, "README.md"), "# Moved on\n");
    git(moved.root, ["commit", "-q", "-am", "moved on"]);
    const refusedMoved = await prescribe(moved);
    assert.deepEqual([refusedMoved.outcome, refusedMoved.stopped!.code, moved.guest.service.requests.length], ["refused", "baseline-moved", 0]);
  });
});

describe("the fixture's scripts on this machine's tools", () => {
  it("do what the fake guest does: the check fails, the fixed edit makes exactly its change, then the check passes", async () => {
    const h = harness();
    const snapshot = await snap(h.root);
    const sh = (workspace: string, args: string[]) => spawnSync("/bin/sh", args, { cwd: workspace, encoding: "utf8" });
    const files = guestRun(snapshot, (workspace) => {
      assert.deepEqual(
        [sh(workspace, ["bin/check.sh"]).status, sh(workspace, ["bin/check.sh"]).stdout],
        [1, "FAIL: Hello, world\n"],
      );
      const edited = sh(workspace, ["-c", EDIT_SCRIPT, "nivra-edit"]);
      assert.equal(edited.status, 0, edited.stderr);
      assert.deepEqual(
        [sh(workspace, ["bin/check.sh"]).status, sh(workspace, ["bin/check.sh"]).stdout],
        [0, "PASS: Hello, Nivra\n"],
      );
      assert.deepEqual([sh(workspace, ["bin/fail.sh"]).status], [1]);
    });
    const real = collect(files).entries.map((entry) => (entry.kind === "link" ? [entry.path, "link", entry.target] : [entry.path, entry.executable, entry.sha256]));
    const workspace = new Map<string, GuestNode>(snapshot.files.map((file) => [file.path, file.kind === "link" ? { kind: "link", target: decode(file.bytes) } : { kind: "file", bytes: file.bytes, executable: file.mode === "100755" }]));
    applyFixedEdit(workspace);
    const simulated = [...workspace.entries()]
      .sort(([a], [b]) => Buffer.compare(Buffer.from(`./${a}`), Buffer.from(`./${b}`)))
      .map(([path, node]) => (node.kind === "link" ? [path, "link", node.target] : [path, node.executable, sha(node.bytes)]));
    assert.deepEqual(real, simulated);
    assert.ok(real.some(([path]) => path === LONG_ADDED));
  });
});
