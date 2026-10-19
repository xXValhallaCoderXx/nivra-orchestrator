import type { FileRef, SandboxApi } from "./api.ts";
import { type Outcome, type Sandbox } from "./sandbox.ts";

/**
 * The Nebius Sandboxes probe (NIV-29): what it will do, in order, with its limits, and how its results are judged
 * against thresholds agreed before it runs. Stage 0 reads only (the account and the public images). Stage 1 runs at
 * most twelve small operations, one at a time, on a synthetic fixture, with networking off but for one approved
 * control. Two ways of running steps are measured: one operation per step (state carried by images), and one bounded
 * parent operation running each step as a subprocess. No model is called and nothing is installed.
 */

export const PROBE_LIMITS = {
  maxOperations: 12,
  maxTimeoutSeconds: 90,
  maxParentTimeoutSeconds: 180,
  overallMinutes: 20,
  requestTimeoutSeconds: 30,
  observeMarginSeconds: 60,
  maxUploadBytes: 2_048,
  maxDownloadBytes: 65_536,
} as const;

export const LATENCY = { adoptSeconds: 10, concernSeconds: 30 } as const;

export const RETENTION =
  "Images are retained for 180 days; after that, untagged and unreferenced images may be deleted. That is not a deletion guarantee, and there is no API to delete uploads, operation records or logs. Cancelling, or a disposable run, deletes nothing.";

const EDIT = `set -e; mkdir -p /base /work; cp /fixture/* /base/; cp /fixture/* /work/; sed -i 's/Hello, world/Hello, Nivra/' /work/greet.sh; echo "interfaces: $(ls /sys/class/net | tr '\\n' ' ')"`;
const NETCHECK = `grep -q Nivra /work/greet.sh && echo CONTINUED || echo NOT-CONTINUED; for target in "$DENY_1" "$DENY_2"; do [ -n "$target" ] || continue; if wget -q -T 5 -O /dev/null "$target" 2>/tmp/err; then echo "REACHED $target"; else echo "BLOCKED $target: $(head -c 200 /tmp/err)"; fi; done`;
const PATCH = `set -e; mkdir -p /out; sh /work/test.sh 'Hello, Nivra' > /out/report.txt; cd / && { diff -ruN base work > /out/patch.diff || true; }; sha256sum /out/report.txt /out/patch.diff`;
const PARENT = `set -e; mkdir -p /base /work; cp /fixture/* /base/; cp /fixture/* /work/; i=0; while [ ! -f /tmp/nivra-done ] && [ "$i" -lt 170 ]; do sleep 1; i=$((i+1)); done`;

export interface PlannedStep {
  id: string;
  pattern: "stage 0" | "A: one operation per step" | "B: a parent with subprocesses";
  what: string;
  /** Networking for the operation; subprocesses share their parent's. */
  network: "none" | "off" | "on (approved control)";
  timeoutSeconds: number | null;
  data: string;
}

/** The plan `--plan` prints, and the approval request quotes: every step, with the data it carries and its limits. */
export function probePlan(fixture: ReadonlyArray<{ name: string; bytes: number }>): { steps: PlannedStep[]; uploads: string; operations: number } {
  const files = fixture.map((file) => `${file.name} (${file.bytes} B)`).join(", ");
  const total = fixture.reduce((sum, file) => sum + file.bytes, 0);
  const steps: PlannedStep[] = [
    { id: "0a", pattern: "stage 0", what: "GET /v1/whoami: permissions, effective limits (maximum timeout, concurrency), token expiry", network: "none", timeoutSeconds: null, data: "none" },
    { id: "0b", pattern: "stage 0", what: "GET /v1/images: choose a public busybox or alpine image", network: "none", timeoutSeconds: null, data: "none" },
    { id: "up", pattern: "A: one operation per step", what: "Upload the fixture (POST /v1/files, one file each)", network: "none", timeoutSeconds: null, data: `${files}; ${total} B in all` },
    { id: "1", pattern: "A: one operation per step", what: "Edit: copy the fixture to /base and /work, change the greeting with sed, list /sys/class/net (only lo expected). Saves image A.", network: "off", timeoutSeconds: 60, data: "the fixture" },
    { id: "2", pattern: "A: one operation per step", what: "From A, disposable: check the edit is there, then wget the approved destination by name and by IP; each must fail with a network error.", network: "off", timeoutSeconds: 60, data: "none" },
    { id: "3", pattern: "A: one operation per step", what: "Positive control (required, through networkControl only): the public base image, no fixture data, one fixed wget of the approved URL, disposable. Must succeed, or the network result is inconclusive.", network: "on (approved control)", timeoutSeconds: 30, data: "none" },
    { id: "4", pattern: "A: one operation per step", what: "From A: the test with the old expectation. Expect SUCCESS with exit 1, classed as a failed check.", network: "off", timeoutSeconds: 60, data: "none" },
    { id: "5", pattern: "A: one operation per step", what: "From A: the passing test, then a report and a diff -ruN patch with their sha256. Saves image D; both files downloaded, bounded, hashes compared.", network: "off", timeoutSeconds: 60, data: "none" },
    { id: "6", pattern: "A: one operation per step", what: "sleep 30 with timeout 5: recorded as timed out.", network: "off", timeoutSeconds: 5, data: "none" },
    { id: "7", pattern: "A: one operation per step", what: "sleep 60; once executing, DELETE it, then poll to CANCELLED (within 60 s). No result image.", network: "off", timeoutSeconds: 90, data: "none" },
    { id: "8", pattern: "A: one operation per step", what: "sleep 10; the client's state is dropped after the first poll and a fresh client reattaches from the journal. One POST.", network: "off", timeoutSeconds: 60, data: "none" },
    { id: "9", pattern: "A: one operation per step", what: "A spawn whose answer is thrown away on purpose, then found by its correlation id. Nothing resubmitted.", network: "off", timeoutSeconds: 60, data: "none" },
    { id: "10", pattern: "B: a parent with subprocesses", what: "A parent waiting for /tmp/nivra-done (its own deadline), not disposable. Subprocesses one at a time: edit, inspect, a network attempt (must fail), the failing test, the passing test, report and patch, then touch /tmp/nivra-done. Result image downloaded, hashes compared.", network: "off", timeoutSeconds: 180, data: "the fixture" },
    { id: "11", pattern: "B: a parent with subprocesses", what: "A parent with a sleeping subprocess, cancelled: the parent reaches CANCELLED and the subprocess stops.", network: "off", timeoutSeconds: 180, data: "the fixture" },
  ];
  return { steps, uploads: `${files}; ${total} B in all`, operations: steps.filter((step) => step.timeoutSeconds !== null).length };
}

export interface StepResult {
  id: string;
  label: string;
  operationId: string | null;
  outcome: Outcome | null;
  /** From the spawn to the end, on the monotonic clock. */
  seconds: number | null;
  note: string;
}

export interface SubprocessResult {
  label: string;
  exitCode: number | null;
  seconds: number | null;
  stdout: string;
}

export interface ProbeResults {
  steps: StepResult[];
  subprocesses: SubprocessResult[];
  downloads: Array<{ step: string; path: string; bytes: number; sha256: string; matched: boolean }>;
  reattach: { sameOperation: boolean; spawns: number } | null;
  lostAnswer: { found: boolean; spawns: number; detail: string } | null;
  cancel: { reachedTerminal: boolean; seconds: number | null } | null;
  parentCancel: { parent: string | null; subprocessStopped: boolean | null } | null;
  errors: string[];
}

export interface StageOneContext {
  sandbox: Sandbox;
  api: SandboxApi;
  /** A fresh sandbox over a fresh client and the journal as written: the reconnect step. */
  reconnect: () => Sandbox;
  baseImage: string;
  fixture: ReadonlyArray<{ name: string; bytes: Uint8Array }>;
  deny: readonly string[];
  networkControl: string | null;
  now: () => number;
  /** The overall deadline, on the same monotonic clock. */
  deadline: number;
  log: (line: string) => void;
}

const shaLines = (stdout: string) => new Map([...stdout.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)].map((match) => [match[2]!, match[1]!]));

/** Runs stage 1. Each step's failure is recorded and the next goes on; the deadline stops it; cleanup is the caller's. */
export async function runStageOne(ctx: StageOneContext): Promise<ProbeResults> {
  const results: ProbeResults = { steps: [], subprocesses: [], downloads: [], reattach: null, lostAnswer: null, cancel: null, parentCancel: null, errors: [] };
  const { sandbox } = ctx;
  const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; seconds: number }> => {
    const started = ctx.now();
    const value = await work();
    return { value, seconds: (ctx.now() - started) / 1000 };
  };
  const step = async (id: string, label: string, body: () => Promise<{ operationId: string | null; outcome: Outcome | null; note?: string }>) => {
    if (ctx.now() > ctx.deadline) {
      results.steps.push({ id, label, operationId: null, outcome: null, seconds: null, note: "not run: the probe's overall deadline had passed" });
      return null;
    }
    ctx.log(`step ${id}: ${label}`);
    try {
      const { value, seconds } = await timed(body);
      results.steps.push({ id, label, operationId: value.operationId, outcome: value.outcome, seconds, note: value.note ?? "" });
      return value.outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.errors.push(`${id} ${label}: ${message}`);
      results.steps.push({ id, label, operationId: null, outcome: null, seconds: null, note: `failed: ${message}` });
      return null;
    }
  };
  const run = async (spec: Parameters<Sandbox["submit"]>[0]) => {
    const submitted = await sandbox.submit(spec);
    if ("uncertain" in submitted) throw new Error("its spawn's answer was lost; it is left for cleanup to settle");
    return { operationId: submitted.operationId, outcome: await sandbox.observe(submitted.operationId, spec.timeoutSeconds) };
  };

  const files: Record<string, FileRef> = {};
  for (const file of ctx.fixture) files[`/fixture/${file.name}`] = { uuid: (await ctx.api.upload(file.bytes)).uuid };

  const edit = await step("1", "edit", () => run({ label: "edit", command: "/bin/sh", args: ["-c", EDIT], image: ctx.baseImage, files, disposable: false, timeoutSeconds: 60 }));
  const imageA = edit?.resultImage ?? null;
  if (imageA) {
    const deny = { DENY_1: ctx.deny[0] ?? "", DENY_2: ctx.deny[1] ?? "" };
    await step("2", "network denied", () => run({ label: "network denied", command: "/bin/sh", args: ["-c", NETCHECK], image: imageA, env: deny, disposable: true, timeoutSeconds: 60 }));
  } else {
    results.steps.push({ id: "2", label: "network denied", operationId: null, outcome: null, seconds: null, note: "not run: step 1 left no image" });
  }
  if (ctx.networkControl) {
    await step("3", "network control", async () => {
      const submitted = await sandbox.networkControl({ approvedUrl: ctx.networkControl, url: ctx.networkControl!, image: ctx.baseImage, baseImage: ctx.baseImage });
      if ("uncertain" in submitted) throw new Error("its spawn's answer was lost; it is left for cleanup to settle");
      return { operationId: submitted.operationId, outcome: await sandbox.observe(submitted.operationId, 30) };
    });
  } else {
    results.steps.push({ id: "3", label: "network control", operationId: null, outcome: null, seconds: null, note: "not run: no approved --network-control URL" });
  }
  if (imageA) {
    await step("4", "failing test", () => run({ label: "failing test", command: "/bin/sh", args: ["/work/test.sh", "Hello, world"], image: imageA, disposable: true, timeoutSeconds: 60 }));
    const patch = await step("5", "patch", () => run({ label: "patch", command: "/bin/sh", args: ["-c", PATCH], image: imageA, disposable: false, timeoutSeconds: 60 }));
    if (patch?.resultImage) await fetchFiles(ctx, results, "5", patch.resultImage, shaLines(patch.stdout));
  }
  await step("6", "timeout", () => run({ label: "timeout", command: "/bin/sleep", args: ["30"], image: ctx.baseImage, disposable: true, timeoutSeconds: 5 }));
  await step("7", "cancel", async () => {
    const submitted = await sandbox.submit({ label: "cancel", command: "/bin/sleep", args: ["60"], image: ctx.baseImage, disposable: true, timeoutSeconds: 90 });
    if ("uncertain" in submitted) throw new Error("its spawn's answer was lost; it is left for cleanup to settle");
    await sandbox.waitFor(submitted.operationId, ["EXECUTING"], 30_000);
    const { value: outcome, seconds } = await timed(() => sandbox.cancel(submitted.operationId));
    results.cancel = { reachedTerminal: outcome !== null, seconds: outcome ? seconds : null };
    return { operationId: submitted.operationId, outcome, note: outcome ? `ended ${outcome.status} ${seconds.toFixed(1)} s after the cancel` : "no terminal state within the wait" };
  });
  await step("8", "reconnect", async () => {
    const submitted = await sandbox.submit({ label: "reconnect", command: "/bin/sh", args: ["-c", "sleep 10; echo done"], image: ctx.baseImage, disposable: true, timeoutSeconds: 60 });
    if ("uncertain" in submitted) throw new Error("its spawn's answer was lost; it is left for cleanup to settle");
    await ctx.api.operation(submitted.operationId);
    // Everything in memory is dropped; a fresh client reattaches from what the journal holds.
    const fresh = ctx.reconnect();
    const known = fresh.journal.open().operations;
    const outcome = await fresh.observe(known[0] ?? submitted.operationId, 60);
    results.reattach = { sameOperation: known.length === 1 && known[0] === submitted.operationId, spawns: fresh.journal.spawnsOf("reconnect") };
    return { operationId: submitted.operationId, outcome };
  });
  await step("9", "lost answer", async () => {
    const submitted = await sandbox.submit({ label: "lost answer", command: "/bin/sh", args: ["-c", "echo lost-and-found"], image: ctx.baseImage, disposable: true, timeoutSeconds: 60 }, { discardAnswer: true });
    if (!("uncertain" in submitted)) throw new Error("the answer was meant to be discarded");
    const found = await sandbox.reconcile(submitted.uncertain);
    results.lostAnswer = { found: "operationId" in found, spawns: sandbox.journal.spawnsOf("lost answer"), detail: "operationId" in found ? "adopted" : found.unknown };
    if (!("operationId" in found)) return { operationId: null, outcome: null, note: found.unknown };
    return { operationId: found.operationId, outcome: await sandbox.observe(found.operationId, 60) };
  });
  await step("10", "parent", async () => {
    const submitted = await sandbox.submit({ label: "parent", command: "/bin/sh", args: ["-c", PARENT], image: ctx.baseImage, files, disposable: false, timeoutSeconds: 180 });
    if ("uncertain" in submitted) throw new Error("its spawn's answer was lost; it is left for cleanup to settle");
    await sandbox.waitFor(submitted.operationId, ["EXECUTING"], 60_000);
    let printed = new Map<string, string>();
    const inside: Array<[string, string[], Record<string, string>?]> = [
      ["edit", ["/bin/sh", "-c", "sed -i 's/Hello, world/Hello, Nivra/' /work/greet.sh"]],
      ["inspect", ["/bin/sh", "-c", "cat /work/greet.sh"]],
      ["network attempt", ["/bin/sh", "-c", NETCHECK], { DENY_1: ctx.deny[0] ?? "", DENY_2: "" }],
      ["failing test", ["/bin/sh", "/work/test.sh", "Hello, world"]],
      ["passing test", ["/bin/sh", "/work/test.sh", "Hello, Nivra"]],
      ["patch", ["/bin/sh", "-c", PATCH]],
      ["done", ["/bin/touch", "/tmp/nivra-done"]],
    ];
    for (const [label, [command, ...args], env] of inside) {
      const started = ctx.now();
      const spawned = await sandbox.subprocess(submitted.operationId, { label, command: command!, args, ...(env ? { env } : {}) });
      const result = "spid" in spawned ? await sandbox.subprocessResult(submitted.operationId, spawned.spid, 60_000) : null;
      results.subprocesses.push({ label, exitCode: result?.exitCode ?? null, seconds: result ? (ctx.now() - started) / 1000 : null, stdout: (result?.stdout ?? ("uncertain" in spawned ? spawned.uncertain : "")).slice(0, 2_000) });
      if (label === "patch" && result) printed = shaLines(result.stdout);
    }
    const outcome = await sandbox.observe(submitted.operationId, 180);
    if (outcome.resultImage) await fetchFiles(ctx, results, "10", outcome.resultImage, printed);
    return { operationId: submitted.operationId, outcome };
  });
  await step("11", "parent cancel", async () => {
    const submitted = await sandbox.submit({ label: "parent cancel", command: "/bin/sh", args: ["-c", PARENT], image: ctx.baseImage, files, disposable: true, timeoutSeconds: 180 });
    if ("uncertain" in submitted) throw new Error("its spawn's answer was lost; it is left for cleanup to settle");
    await sandbox.waitFor(submitted.operationId, ["EXECUTING"], 60_000);
    const spawned = await sandbox.subprocess(submitted.operationId, { label: "sleeper", command: "/bin/sleep", args: ["60"] });
    const outcome = await sandbox.cancel(submitted.operationId);
    let stopped: boolean | null = null;
    if ("spid" in spawned) stopped = await sandbox.subprocessResult(submitted.operationId, spawned.spid, 5_000).then((result) => result !== null, () => true);
    results.parentCancel = { parent: outcome?.status ?? null, subprocessStopped: stopped };
    return { operationId: submitted.operationId, outcome };
  });
  return results;
}

async function fetchFiles(ctx: StageOneContext, results: ProbeResults, step: string, image: string, printed: Map<string, string>): Promise<void> {
  let left = PROBE_LIMITS.maxDownloadBytes;
  for (const path of ["/out/patch.diff", "/out/report.txt"]) {
    try {
      const expected = printed.get(path) ?? null;
      const { bytes, sha256 } = await ctx.sandbox.download(image, path, left, expected);
      left -= bytes.byteLength;
      results.downloads.push({ step, path, bytes: bytes.byteLength, sha256, matched: expected !== null && expected === sha256 });
    } catch (error) {
      results.errors.push(`${step} download ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface Verdict {
  id: string;
  criterion: string;
  critical: boolean;
  outcome: "pass" | "fail" | "inconclusive" | "not-run";
  detail: string;
}

const median = (values: readonly number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * Judges the results against the thresholds agreed before the run. A failed critical criterion means defer; an
 * inconclusive one (a positive control that didn't work, say) means no adoption can be claimed. Latency is judged on
 * the better of the two patterns, by the median per step.
 */
export function evaluate(results: ProbeResults): { verdicts: Verdict[]; latency: { perOperation: number | null; perSubprocess: number | null; better: number | null; outcome: "adopt" | "concern" | "defer" | "not-run" }; decision: "adopt" | "adopt with concern" | "defer" | "inconclusive" } {
  const of = (id: string) => results.steps.find((step) => step.id === id) ?? null;
  const out = (id: string) => of(id)?.outcome ?? null;
  const verdicts: Verdict[] = [];
  const add = (id: string, criterion: string, critical: boolean, outcome: Verdict["outcome"], detail: string) => verdicts.push({ id, criterion, critical, outcome, detail });

  const edit = out("1");
  const denied = out("2");
  const control = out("3");
  const onlyLoopback = edit ? /interfaces: lo\s*$/.test(edit.stdout.trim()) : null;
  const reached = denied ? /^REACHED /m.test(denied.stdout) : null;
  const blocked = denied ? (denied.stdout.match(/^BLOCKED /gm) ?? []).length : 0;
  if (!edit || !denied) add("network", "Network denial shown by behaviour, against a working positive control", true, "not-run", "the edit or the denied check didn't run");
  else if (reached || onlyLoopback === false) add("network", "Network denial shown by behaviour, against a working positive control", true, "fail", reached ? "a connection got through with networking off" : "a network interface other than lo exists with networking off");
  else if (!control || control.verdict !== "passed") add("network", "Network denial shown by behaviour, against a working positive control", true, "inconclusive", control ? `the positive control didn't connect (${control.verdict}), so the failed attempts prove nothing` : "the positive control didn't run");
  else add("network", "Network denial shown by behaviour, against a working positive control", true, blocked >= 1 ? "pass" : "inconclusive", `${blocked} attempt(s) blocked; only lo present; the control connected`);

  const continued = (denied && /CONTINUED/.test(denied.stdout) && !/NOT-CONTINUED/.test(denied.stdout)) || results.subprocesses.some((s) => s.label === "inspect" && /Hello, Nivra/.test(s.stdout));
  add("continuation", "State continues through an image, or inside a parent", true, continued ? "pass" : edit ? "fail" : "not-run", continued ? "the edit was there in a later step" : "no later step saw the edit");

  add("cancel", "A cancel reaches a terminal state within 60 s", true, !results.cancel ? "not-run" : results.cancel.reachedTerminal && (results.cancel.seconds ?? Infinity) <= 60 ? "pass" : "fail", results.cancel ? `terminal: ${results.cancel.reachedTerminal}, after ${results.cancel.seconds ?? "?"} s` : "step 7 didn't run");

  add("reattach", "Reattaching observes the same operation, with no second spawn", true, !results.reattach ? "not-run" : results.reattach.sameOperation && results.reattach.spawns === 1 ? "pass" : "fail", results.reattach ? `same operation: ${results.reattach.sameOperation}, spawns: ${results.reattach.spawns}` : "step 8 didn't run");

  const failing = out("4");
  const timeout = out("6");
  const exitOk = failing?.status === "SUCCESS" && failing.verdict === "command-failed";
  const timeoutOk = timeout?.verdict === "timed-out";
  add("exit", "The exit code and a timeout are told apart from SUCCESS", true, !failing || !timeout ? "not-run" : exitOk && timeoutOk ? "pass" : "fail", `failing test: ${failing?.status ?? "?"}/${failing?.verdict ?? "?"}; timeout: ${timeout?.status ?? "?"}/${timeout?.verdict ?? "?"}`);

  const matched = results.downloads.filter((d) => d.matched);
  add("patch", "The patch and report are retrieved, with matching hashes", true, matched.some((d) => d.path.endsWith("patch.diff")) && matched.some((d) => d.path.endsWith("report.txt")) ? "pass" : results.downloads.length ? "fail" : "not-run", `${matched.length} of ${results.downloads.length} download(s) matched`);

  add("lost-answer", "A spawn whose answer was lost is found by its correlation id", false, !results.lostAnswer ? "not-run" : results.lostAnswer.found && results.lostAnswer.spawns === 1 ? "pass" : "fail", results.lostAnswer?.detail ?? "step 9 didn't run");

  const perOperation = median(results.steps.filter((s) => ["1", "2", "4", "5", "8", "9"].includes(s.id) && s.outcome && s.seconds !== null).map((s) => s.seconds!));
  const perSubprocess = median(results.subprocesses.filter((s) => s.seconds !== null).map((s) => s.seconds!));
  const candidates = [perOperation, perSubprocess].filter((value): value is number => value !== null);
  const better = candidates.length ? Math.min(...candidates) : null;
  const latency = better === null ? "not-run" : better <= LATENCY.adoptSeconds ? "adopt" : better <= LATENCY.concernSeconds ? "concern" : "defer";

  const critical = verdicts.filter((v) => v.critical);
  const decision = critical.some((v) => v.outcome === "fail") || latency === "defer" ? "defer" : critical.some((v) => v.outcome !== "pass") || latency === "not-run" ? "inconclusive" : latency === "concern" ? "adopt with concern" : "adopt";
  return { verdicts, latency: { perOperation, perSubprocess, better, outcome: latency }, decision };
}
