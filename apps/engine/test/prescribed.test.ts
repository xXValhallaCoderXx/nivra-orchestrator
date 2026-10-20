import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { checkRequirements, type ExecutionBackend, type SessionSpec } from "../src/exec/backend.ts";
import type { Transport, TransportRequest } from "../src/exec/nebius/api.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { createNebiusBackend, PREPARE_SCRIPT, reconcileJournals, scanJournals } from "../src/exec/nebius/session.ts";
import { runPrescribed, type PrescribedRun } from "../src/exec/prescribed.ts";
import { proposalHash, verifyProposal } from "../src/exec/proposal.ts";
import { APPROVED, applyFixedEdit, buildFixture, CHECK_SCRIPT, DENY, EDIT_SCRIPT, EXPECTED_CHANGE, FAIL_SCRIPT, fixtureRecipe, LONG_ADDED, NETWORK_SCRIPT, networkVerdict, type GuestNode } from "../scripts/sandbox-fixture.ts";
import { FakeGuest } from "./fake-guest.ts";
import { clock, holding, spawned } from "./fake-sandboxes.ts";
import { waitFor } from "./helpers.ts";
import { changedSince, cleanUp, collect, folderState, GIT, git, guestRun, localSession, scratch, sha, snap, track } from "./workspace-fixtures.ts";

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
    // The report the person approves holds what happened: every step as recorded, and every operation the session
    // ran, its own prepare step first, each with its status and usage.
    const bound = JSON.parse(decode(proposal.report)) as { steps: unknown; operations: Array<{ label: string; status: string; usage: unknown }> };
    assert.deepEqual(bound.steps, JSON.parse(JSON.stringify(result.steps)));
    assert.deepEqual(
      bound.operations.map((operation) => [operation.label, operation.status, operation.usage !== null]),
      [
        ["prepare", "SUCCESS", true],
        ["edit", "SUCCESS", true],
        ["network", "SUCCESS", true],
        ["check", "SUCCESS", true],
        ["failing check", "SUCCESS", true],
        ["timeout", "SUCCESS", true],
        ["stop", "CANCELLED", true],
        ["collect", "SUCCESS", true],
      ],
    );
    // The prescribed stop counted from when the command was seen running.
    assert.ok((byLabel.get("stop")!.durationMs ?? 0) >= 5_000, `the stop ended after ${byLabel.get("stop")!.durationMs} ms`);

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
    assert.deepEqual([result.outcome, result.stopped!.code, result.stopped!.step], ["failed", "sandbox-refused", "network"]);
    assert.match(result.stopped!.message, /^network: The sandbox no longer has this workspace's saved state \(HTTP 410\)/);
    // The step that stopped the run is there too, with what is known of it: no operation was made for it.
    assert.deepEqual(
      result.steps.map((step) => [step.label, step.status, step.exitCode, step.durationMs]),
      [
        ["edit", "SUCCESS", 0, result.steps[0]!.durationMs],
        ["network", null, null, null],
      ],
    );
    // The prepare step, the edit, and the network step's spawn, answered 410: nothing after it, nothing again.
    assert.deepEqual([h.guest.service.spawns, h.guest.service.uploads.length, result.proposal, result.cleanup!.unresolved.length], [3, 1, null, 0]);
  });

  it("stops at the person's cancel: the step under way is seen to stop, and nothing more runs", async () => {
    const h = harness();
    const controller = new AbortController();
    const isCheck = (request: TransportRequest) => request.method === "GET" && h.guest.service.operations.some((op) => request.path === `/v1/operations/${op.uuid}` && (op.body["args"] as string[])[1] === CHECK_SCRIPT);
    let heldOnce = false;
    const { transport, held } = holding(h.guest.service, (request) => !heldOnce && isCheck(request) && (heldOnce = true));
    h.guest.override = ({ args }) => (args[1] === CHECK_SCRIPT ? { waits: true } : undefined);
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
      if (args[1] !== CHECK_SCRIPT || lost) return undefined;
      lost = true;
      h.guest.service.dropNextSpawnAnswer = true;
      h.guest.service.hideNextSpawn = true;
      return { waits: true };
    };
    const result = await prescribe(h);
    assert.equal(result.outcome, "uncertain");
    assert.match(result.stopped!.message, /^check: It isn't known whether \/bin\/sh started/);
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
    assert.deepEqual([result.outcome, result.stopped!.code, result.stopped!.step], ["uncertain", "uncertain", "stop"]);
    assert.deepEqual([h.guest.service.spawns, result.cleanup!.unresolved.length, result.cleanup!.retained?.uploads], [7, 1, 1]);
    assert.ok((result.cleanup!.retained?.images ?? 0) >= 2, "the images the run left weren't counted");
    // All of it on the session's clock: the run's ten minutes, the stop's own allowance, then closing's seven.
    assert.ok(h.time.now() <= 600_000 + 92_000 + 420_000, `the run and its cleanup took ${h.time.now()} ms`);
  });

  it("refuses before anything is sent: a backend that isolates nothing, a commit holding a token, a checkout that has moved on", async () => {
    const local = harness();
    const refusedLocal = await prescribe(local, { backend: createLocalBackend({ baseEnv: process.env }) });
    assert.equal(refusedLocal.outcome, "refused");
    // Its first refusal is the network: "No isolation" can't block it, and isolates no files either.
    assert.match(refusedLocal.stopped!.message, /^open: "No isolation" can't block network access, so this run was not started\./);
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

/** The independent review of the first draft (`a074951`): each case here was reproduced against that commit. */
describe("the prescribed path, after the review", () => {
  it("asks the backend for file isolation and no network, and hands it closing's signal and budget for a failed open", async () => {
    const h = harness();
    const seen: SessionSpec[] = [];
    const closing = new AbortController();
    const unisolated: ExecutionBackend = {
      id: "openshell",
      label: "A backend that isolates no files",
      capabilities: { isolatesFilesystem: false, networkPolicy: "onOff", injectsCredentials: false, persistsBetweenExecs: true },
      open: async (spec) => {
        seen.push(spec);
        checkRequirements(unisolated, spec);
        throw new Error("opened a session it shouldn't have");
      },
    };
    const result = await prescribe(h, { backend: unisolated, closeBudgetMs: 1_234, closeSignal: closing.signal });
    assert.deepEqual([seen[0]?.requires, seen[0]?.network, seen[0]?.closing?.budgetMs, seen[0]?.closing?.signal === closing.signal], [{ isolatesFilesystem: true }, "deny", 1_234, true]);
    assert.deepEqual([result.outcome, result.stopped!.code, result.stopped!.step, result.cleanup], ["refused", "boundary", "open", null]);
    assert.match(result.stopped!.message, /can't keep commands away from this computer's files/);
  });

  it("ends a fault while reading the result back as an outcome, with cleanup's record, after the paid operations", async () => {
    const h = harness();
    // The service turns the archive's download down, after all eight operations ran.
    const transport: Transport = (request) => (request.path.endsWith("/download") ? Promise.resolve({ status: 403, headers: {}, body: new TextEncoder().encode('{"error":"forbidden"}') }) : h.guest.service.transport(request));
    const result = await prescribe(h, { backend: backendFor(h, transport) });
    assert.deepEqual([result.outcome, result.stopped!.code, result.stopped!.step, result.proposal], ["failed", "sandbox-failed", "collect", null]);
    assert.deepEqual([h.guest.service.spawns, result.cleanup?.unresolved.length], [8, 0]);
    assert.deepEqual(result.steps.at(-1)!.label, "collect");

    // The person's cancel while reading it back is a cancel, with cleanup's record too.
    const cancelled = harness();
    const controller = new AbortController();
    const cancelling: Transport = (request) => {
      if (request.path.endsWith("/download")) controller.abort();
      return cancelled.guest.service.transport(request);
    };
    const stopped = await prescribe(cancelled, { backend: backendFor(cancelled, cancelling), signal: controller.signal });
    assert.deepEqual([stopped.outcome, stopped.stopped!.code, stopped.stopped!.step, stopped.cleanup !== null], ["cancelled", "cancelled", "collect", true]);
  });

  it("tells a failed open apart: cancelled during the prepare step, or uncertain when its start isn't known", async () => {
    const h = harness();
    const controller = new AbortController();
    const isPrepare = (request: TransportRequest) => request.method === "GET" && h.guest.service.operations.some((op) => request.path === `/v1/operations/${op.uuid}` && (op.body["args"] as string[])[1] === PREPARE_SCRIPT);
    let heldOnce = false;
    const { transport, held } = holding(h.guest.service, (request) => !heldOnce && isPrepare(request) && (heldOnce = true));
    h.guest.override = ({ args }) => (args[1] === PREPARE_SCRIPT ? { waits: true } : undefined);
    const running = prescribe(h, { backend: backendFor(h, transport), signal: controller.signal });
    await waitFor(() => held.length > 0, { what: "the prepare step to be under way" });
    controller.abort();
    const cancelled = await running;
    assert.deepEqual([cancelled.outcome, cancelled.stopped!.code, cancelled.stopped!.step, cancelled.cleanup!.unresolved.length], ["cancelled", "cancelled", "open", 0]);

    const unknown = harness();
    let lost = false;
    unknown.guest.override = ({ args }) => {
      if (args[1] !== PREPARE_SCRIPT || lost) return undefined;
      lost = true;
      unknown.guest.service.dropNextSpawnAnswer = true;
      unknown.guest.service.hideNextSpawn = true;
      return { waits: true };
    };
    const uncertain = await prescribe(unknown);
    assert.deepEqual([uncertain.outcome, uncertain.stopped!.code, uncertain.cleanup!.unresolved.length], ["uncertain", "uncertain", 1]);
  });

  it("stops a failed open's own cleanup at closing's signal, as an engine shutting down needs", async () => {
    const h = harness();
    h.guest.service.ignoreCancels = true;
    const controller = new AbortController();
    const closing = new AbortController();
    closing.abort();
    const isPrepare = (request: TransportRequest) => request.method === "GET" && h.guest.service.operations.some((op) => request.path === `/v1/operations/${op.uuid}` && (op.body["args"] as string[])[1] === PREPARE_SCRIPT);
    let heldOnce = false;
    const { transport, held } = holding(h.guest.service, (request) => !heldOnce && isPrepare(request) && (heldOnce = true));
    h.guest.override = ({ args }) => (args[1] === PREPARE_SCRIPT ? { waits: true } : undefined);
    const running = prescribe(h, { backend: backendFor(h, transport), signal: controller.signal, closeSignal: closing.signal });
    await waitFor(() => held.length > 0, { what: "the prepare step to be under way" });
    controller.abort();
    const result = await running;
    // The stop's own cancel, and nothing from cleanup: its signal had already stopped it. At a074951, cleanup ran on.
    const deletes = h.guest.service.requests.filter((request) => request.method === "DELETE").length;
    assert.deepEqual([result.outcome, deletes, result.cleanup!.unresolved.length], ["uncertain", 1, 1]);
  });

  it("counts a prescribed stop from when the command is seen running, so one that never starts is never taken for stopped", async () => {
    const h = harness();
    h.guest.override = ({ program, args }) => (program === "/bin/sleep" && args[0] === "60" ? { statuses: ["PENDING"], waits: false } : undefined);
    const result = await prescribe(h);
    const stop = result.steps.find((step) => step.label === "stop")!;
    assert.deepEqual([result.outcome, result.stopped!.step, stop.cancelled, stop.status], ["uncertain", "stop", false, null]);
  });

  it("names the step whose operation failed, keeping the sandbox's own record of it", async () => {
    const h = harness();
    h.guest.override = ({ args }) => (args[1] === NETWORK_SCRIPT ? { statuses: ["PENDING", "FAILED"] } : undefined);
    const result = await prescribe(h);
    assert.deepEqual([result.outcome, result.stopped!.code, result.stopped!.step], ["failed", "sandbox-failed", "network"]);
    assert.match(result.stopped!.message, /^network: The sandbox couldn't run \/bin\/sh/);
    assert.deepEqual(
      result.steps.map((step) => [step.label, step.status]),
      [
        ["edit", "SUCCESS"],
        ["network", "FAILED"],
      ],
    );
  });
});

describe("the fixture's scripts on this machine's tools", () => {
  it("do what the fake guest does, from any folder: the check fails, the fixed edit makes exactly its change, then the check passes", async () => {
    const h = harness();
    const snapshot = await snap(h.root);
    // Run from somewhere else: the scripts go to the workspace they are given, whatever folder the service starts them in.
    const elsewhere = scratch("elsewhere");
    const sh = (script: string, workspace: string) => spawnSync("/bin/sh", ["-c", script, "nivra-step", workspace], { cwd: elsewhere, encoding: "utf8" });
    const files = guestRun(snapshot, (workspace) => {
      assert.deepEqual(
        [sh(CHECK_SCRIPT, workspace).status, sh(CHECK_SCRIPT, workspace).stdout],
        [1, "FAIL: Hello, world\n"],
      );
      const edited = sh(EDIT_SCRIPT, workspace);
      assert.equal(edited.status, 0, edited.stderr);
      assert.deepEqual(
        [sh(CHECK_SCRIPT, workspace).status, sh(CHECK_SCRIPT, workspace).stdout],
        [0, "PASS: Hello, Nivra\n"],
      );
      assert.deepEqual(
        [sh(FAIL_SCRIPT, workspace).status, sh(FAIL_SCRIPT, workspace).stdout],
        [1, "FAIL: this check fails on purpose\n"],
      );
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

  it("builds the approved fixture: its baseline, archive and listing are the ones pinned for the recipe", async () => {
    const h = harness();
    const snapshot = await snap(h.root);
    assert.deepEqual(
      { baseline: h.baseline, archiveSha256: snapshot.archive.sha256, listingDigest: snapshot.archive.listingDigest, archiveBytes: snapshot.archive.archive.byteLength },
      { ...APPROVED },
    );
  });

  it("passes the network step only with loopback alone and both attempts failing for want of a network", () => {
    // The script itself, under /bin/sh with stand-ins for ls, busybox and wget: nothing here reaches the network. Its
    // error file is unquoted in the script, as /tmp/nivra-network has no space, so this folder has none either.
    const work = track(mkdtempSync(join(tmpdir(), "nivra-network-")));
    const failures = join(work, "wget-said");
    const script = NETWORK_SCRIPT.replaceAll("/tmp/nivra-network", failures);
    const run = (name: string, interfaces: string, wget: string | null) => {
      const bin = join(work, name);
      mkdirSync(bin);
      for (const tool of ["tr", "head", "grep"]) symlinkSync(spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), join(bin, tool));
      writeFileSync(join(bin, "ls"), `#!/bin/sh\nprintf '${interfaces}'\n`, { mode: 0o755 });
      writeFileSync(join(bin, "busybox"), "#!/bin/sh\necho 'BusyBox v1.36.1 (a stand-in) multi-call binary.'\n", { mode: 0o755 });
      if (wget !== null) writeFileSync(join(bin, "wget"), wget, { mode: 0o755 });
      const ran = spawnSync("/bin/sh", ["-c", script, "nivra-network", DENY.byName, DENY.byIp], { cwd: work, env: { PATH: bin }, encoding: "utf8" });
      return { exitCode: ran.status, stdout: ran.stdout, verdict: networkVerdict(ran.status, ran.stdout) };
    };
    const denied = `#!/bin/sh\nfor a; do t=$a; done\ncase "$t" in *example.com*) echo "wget: bad address 'example.com'" >&2;; *) echo "wget: can't connect to remote host: Network unreachable" >&2;; esac\nexit 1\n`;
    const off = run("off", "lo\\n", denied);
    assert.deepEqual([off.exitCode, off.verdict.pass], [0, true], off.stdout);
    assert.match(off.stdout, /^cwd: .*\ninterfaces: lo \nbusybox: BusyBox v1\.36\.1/);
    // The review's cases, each a pass before: an interface besides loopback, an HTTP error from a host it reached, no wget.
    const cases: Array<[string, string, string | null]> = [
      ["another interface", "eth0\\nlo\\n", denied],
      ["an HTTP error", "lo\\n", `#!/bin/sh\necho "wget: server returned error: HTTP/1.1 403 Forbidden" >&2\nexit 1\n`],
      ["a refused connection", "lo\\n", `#!/bin/sh\necho "wget: can't connect to remote host: Connection refused" >&2\nexit 1\n`],
      ["no wget", "lo\\n", null],
      ["a target reached", "lo\\n", "#!/bin/sh\nexit 0\n"],
    ];
    for (const [name, interfaces, wget] of cases) {
      const outcome = run(name.replace(/\W+/g, "-"), interfaces, wget);
      assert.deepEqual([outcome.exitCode === 0, outcome.verdict.pass], [false, false], `${name}: ${outcome.stdout}`);
    }
  });
});
