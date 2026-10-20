// Live check (NIV-43, D35): the prescribed path, through the real adapter, on the synthetic fixture. Never part of
// `pnpm verify`, and never run without your approval of the recipe `--plan` prints: one approval covers the one bounded
// run it describes, its cleanup included, and nothing more. No model is called and nothing is installed. Networking is
// off for every operation, and the adapter can't turn it on.
//
// Usage (from the repository's top level):
//   node apps/engine/scripts/sandbox-check.ts --plan
//   node apps/engine/scripts/sandbox-check.ts --credentials <file> --run
//   node apps/engine/scripts/sandbox-check.ts --credentials <file> --recover <evidence folder>
//
// The key and project id come from a file only you can read, outside the repository, holding NEBIUS_API_KEY=… and
// NEBIUS_PROJECT_ID=… lines. They are read once, removed from the environment, and never printed or written: evidence
// replaces them with placeholders. Evidence goes to ~/nivra-acceptance/sandbox-check-<UTC>/ (0700). Close the Nivra app
// first: the check fails if the release engine home (~/.nivra) changed. The first Ctrl+C stops the run's work at once,
// then closing settles what it started on its own budget; a second stops cleanup, and --recover finishes it later.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { findGit } from "../src/exec/find-executable.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { fetchTransport, SandboxApi, type Transport } from "../src/exec/nebius/api.ts";
import { insideRepository, RETENTION, tokenOutlasts } from "../src/exec/nebius/probe.ts";
import { createNebiusBackend, NEBIUS_LIMITS, reconcileJournals, scanJournals } from "../src/exec/nebius/session.ts";
import { runPrescribed, type PrescribedResult } from "../src/exec/prescribed.ts";
import { canonicalJson, verifyProposal } from "../src/exec/proposal.ts";
import { takeSnapshot } from "../src/exec/snapshot.ts";
import { APPROVED, buildFixture, DENY, EXPECTED_CHANGE, FIXTURE, fixtureRecipe, IMAGE, networkVerdict } from "./sandbox-fixture.ts";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    plan: { type: "boolean", default: false },
    run: { type: "boolean", default: false },
    credentials: { type: "string" },
    recover: { type: "string" },
    evidence: { type: "string" },
  },
  allowPositionals: false,
});

/** The recipe's bounds, which the adapter itself enforces: its operations, each command's time, the run's, cleanup's. */
const CHECK = Object.freeze({ operations: 8, commandSeconds: 60, runMinutes: 10, cleanupMinutes: 7 });
const LIMITS = { ...NEBIUS_LIMITS, maxOperations: CHECK.operations, maxTimeoutSeconds: CHECK.commandSeconds, prepareTimeoutSeconds: CHECK.commandSeconds, sessionBudgetMs: CHECK.runMinutes * 60_000, cleanupBudgetMs: CHECK.cleanupMinutes * 60_000 };
/** How long stopping a command under way may take past the run's deadline: a cancel's request and its wait. */
const STOP_SECONDS = Math.round((NEBIUS_LIMITS.minWriteMs + NEBIUS_LIMITS.requestTimeoutMs + NEBIUS_LIMITS.cancelWaitMs) / 1000);
const git = findGit({ env: process.env });
if (!git) {
  console.error("git isn't installed here. Install it, then try again. Nothing was sent.");
  process.exit(2);
}
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** The fixture, built in a folder of its own, with its snapshot: the bytes that would be sent. Refused unless it is the approved one. */
async function fixtureAndSnapshot() {
  const parent = mkdtempSync(join(tmpdir(), "nivra-sandbox-check-"));
  const fixture = buildFixture(join(parent, "fixture"), git!);
  const local = await createLocalBackend({ baseEnv: process.env }).open({ workspace: fixture.root });
  let snapshot;
  try {
    snapshot = await takeSnapshot({ folder: fixture.root, session: local, git: git!, baseline: fixture.baseline });
  } finally {
    await local.close();
  }
  const built = { baseline: fixture.baseline, archiveSha256: snapshot.archive.sha256, listingDigest: snapshot.archive.listingDigest, archiveBytes: snapshot.archive.archive.byteLength };
  if (canonicalJson(built) !== canonicalJson(APPROVED)) {
    rmSync(parent, { recursive: true, force: true });
    console.error(`The fixture built here isn't the approved one (${JSON.stringify(built)}, against ${JSON.stringify(APPROVED)}), so nothing was sent. The recipe changed: print it with --plan and ask for its approval again.`);
    process.exit(2);
  }
  return { parent, fixture, snapshot };
}

if (values.plan) {
  const { parent, fixture, snapshot } = await fixtureAndSnapshot();
  rmSync(parent, { recursive: true, force: true });
  const recipe = fixtureRecipe();
  const out = (line = "") => console.log(line);
  out("Nebius sandbox check (NIV-43): the recipe, as it would run. Nothing here touches the network.\n");
  out(`Fixture: ${FIXTURE.length} entries, ${snapshot.files.reduce((sum, file) => sum + file.size, 0)} bytes, built at run time in a temporary folder:`);
  for (const file of snapshot.files) out(`  ${file.mode} ${String(file.size).padStart(4)} B  ${file.path}`);
  out(`Baseline: ${fixture.baseline} (a fixed author and time, so always this commit; the run is refused otherwise).`);
  out(`Sent: one upload, the snapshot's tar, ${snapshot.archive.archive.byteLength} bytes, sha256 ${snapshot.archive.sha256}. Nothing of yours.`);
  out(`Image: ${IMAGE.tag} (${IMAGE.uuid}), the public image D28 used.\n`);
  out(`Operations: ${CHECK.operations}, one at a time, networking off for every one:`);
  out(`  1. prepare: extract the snapshot, and print its listing's digest; it must be ${snapshot.archive.listingDigest} (timeout ${CHECK.commandSeconds} s)`);
  recipe.forEach((step, index) => out(`  ${index + 2}. ${step.label}: ${step.argv.slice(0, 2).join(" ")}${step.argv.length > 2 ? " …" : ""} (timeout ${step.timeoutMs / 1000} s${step.stopAfterMs ? `, stopped ${step.stopAfterMs / 1000} s after it is seen running` : ""}${step.keeps ? ", keeps its changes" : ", changes thrown away"})`));
  out(`  ${recipe.length + 2}. collect: archive and list the workspace; both downloaded (caps 16 MiB and 4 MiB) (timeout ${CHECK.commandSeconds} s)`);
  out(`The network step prints its folder, the interfaces and busybox's version, then tries ${DENY.byName} by name and ${DENY.byIp} by IP.`);
  out('It passes only with loopback as the one interface and each attempt failing for want of a network ("bad address",');
  out('"Network unreachable"); an HTTP error, a refused connection or a missing wget fails it. D28\'s positive control, the same');
  out("name reached with networking on through the probe on 20 October, is reused; no new control runs.");
  out(`\nBounds: the session's work stops at ${CHECK.runMinutes} minutes, a hard limit every request of it ends by, except stopping a command`);
  out(`already under way, which may take ${STOP_SECONDS} s more. Closing then has ${CHECK.cleanupMinutes} minutes of its own. The account reads before,`);
  out("and the local snapshot and patch, aren't counted in those minutes.");
  out(`The adapter refuses more than ${CHECK.operations} operations, and any command over ${CHECK.commandSeconds} s.`);
  out(`Caps: an 8 MiB upload, 16 MiB downloads, ${NEBIUS_LIMITS.maxOutputBytes / 1024} KiB of output a stream.`);
  out("Before it starts, the run reads the account twice, 15 s apart (GET /v1/whoami), and starts only if the token outlasts it and its cleanup.");
  out(`One approval covers this one run: its operations, upload, downloads, reads and polling, its cleanup, and a --recover pass`);
  out(`for it within ${CHECK.cleanupMinutes} minutes if cleanup is cut short. A rerun, more operations or a fresh network control need a new approval.`);
  out("\nCredentials: the file you pass with --credentials (mode 600, outside the repository). Never printed, never written.");
  out(`Retention: ${RETENTION}`);
  out("Cost: unknown in advance; the service's own usage figures are recorded raw, never converted to money.");
  out("Evidence: ~/nivra-acceptance/sandbox-check-<UTC>/ (0700): the result, the report, the patch, the proposal, cleanup, the checks, the journal.");
  out("Close the Nivra app first: the check fails if ~/.nivra changed.");
  process.exit(0);
}

/** The key and project id, from a file only you can read, outside the repository. */
function credentials(): { key: string; project: string } {
  if (!values.credentials) {
    console.error("Pass --credentials <file>: a file only you can read, outside the repository, with NEBIUS_API_KEY=… and NEBIUS_PROJECT_ID=… lines. Nothing was sent.");
    process.exit(2);
  }
  const path = resolve(values.credentials);
  if (insideRepository(path, REPOSITORY)) {
    console.error(`${path} is inside the repository, where it could be committed. Move it outside (for example to ~/.config/nivra/), then try again. Nothing was sent.`);
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`There's no file at ${path}. Create it with NEBIUS_API_KEY=… and NEBIUS_PROJECT_ID=… lines, run chmod 600 on it, then try again. Nothing was sent.`);
    process.exit(2);
  }
  const real = realpathSync.native(path);
  const mode = statSync(real).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.error(`${path} can be read by others (mode ${mode.toString(8)}). Run chmod 600 on it, then try again. Nothing was sent.`);
    process.exit(2);
  }
  const parsed = parseEnv(readFileSync(real, "utf8"));
  const key = parsed["NEBIUS_API_KEY"]?.trim();
  const project = parsed["NEBIUS_PROJECT_ID"]?.trim();
  if (!key || !project) {
    console.error(`NEBIUS_API_KEY and NEBIUS_PROJECT_ID must both be set in ${path}. Nothing was sent.`);
    process.exit(2);
  }
  return { key, project };
}

if (!values.run && !values.recover) {
  console.error("Choose --plan, --run, or --recover <folder>.");
  process.exit(2);
}
const evidenceRoot = resolve(values.evidence ?? join(homedir(), "nivra-acceptance"));
if (insideRepository(evidenceRoot, REPOSITORY)) {
  console.error(`${evidenceRoot} is inside the repository, where evidence could be committed. Choose a folder outside it. Nothing was sent.`);
  process.exit(2);
}
const keys = credentials();
delete process.env["NEBIUS_API_KEY"];
delete process.env["NEBIUS_PROJECT_ID"];
/** Text with the key and the project id taken out, for everything printed or written. */
const safe = (text: string) => text.split(keys.key).join("[key]").split(keys.project).join("[project]");
const write = (path: string, value: unknown) => writeFileSync(path, `${safe(typeof value === "string" ? value : JSON.stringify(value, null, 2))}\n`, { mode: 0o600 });
const started = performance.now();
const log = (line: string) => console.log(`${String(Math.round(performance.now() - started)).padStart(8)} ms  ${safe(line)}`);

if (values.recover) {
  const folder = resolve(values.recover);
  const settling = new AbortController();
  process.on("SIGINT", () => {
    if (settling.signal.aborted) process.exit(130);
    settling.abort();
    log("Stopping: what is still open stays in the journal for the next --recover.");
  });
  const scan = scanJournals(join(folder, "journals"));
  log(`Settling what ${folder} left open (${scan.open.length} journal${scan.open.length === 1 ? "" : "s"}), within ${CHECK.cleanupMinutes} minutes.`);
  const passes = await reconcileJournals(scan.open, { credentials: keys, budgetMs: CHECK.cleanupMinutes * 60_000, signal: settling.signal, limits: LIMITS });
  write(join(folder, `recover-${Date.now()}.json`), passes);
  const unresolved = passes.flatMap((pass) => pass.unresolved);
  log(`stopped ${passes.flatMap((pass) => pass.stopped).length}; already ended ${passes.flatMap((pass) => pass.alreadyEnded).length}; unresolved ${unresolved.length}${unresolved.length ? `: ${unresolved.join("; ")}` : ""}`);
  process.exit(unresolved.length ? 1 : 0);
}

/** A folder's names, kinds, modes, sizes, times and, unless `light`, bytes: equal states mean nothing changed. */
function folderState(root: string, light = false): Map<string, string> | null {
  if (!existsSync(root)) return null;
  const state = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path, { bigint: true });
      const bytes = light || info.isDirectory() ? "" : sha(info.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
      state.set(relative(root, path), `${info.mode} ${info.size} ${info.mtimeNs} ${bytes}`);
      if (info.isDirectory()) walk(path);
    }
  };
  walk(root);
  return state;
}
const changed = (before: Map<string, string> | null, after: Map<string, string> | null) =>
  before === null || after === null ? (before === after ? [] : ["(the folder appeared or went)"]) : [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));

// The first Ctrl+C stops the run's work, from the account reads on; the second stops cleanup; a third quits.
const work = new AbortController();
const settling = new AbortController();
let interrupts = 0;
let folder: string | null = null;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts === 1) {
    work.abort(new Error("Interrupted"));
    log(`Interrupted: the run's work stops at once, and closing settles what it started, within ${CHECK.cleanupMinutes} minutes. Press Ctrl+C again to stop that and leave it to --recover.`);
  } else if (interrupts === 2) {
    settling.abort();
    log(`Stopping cleanup: what is still open is in the journal.${folder ? ` Run --recover ${folder}.` : ""}`);
  } else process.exit(130);
});

// The token must outlast the run and its cleanup: two readings, 15 s apart, as the probe takes them (D28).
const reads = new SandboxApi(fetchTransport(keys), { requestTimeoutMs: 30_000, signal: work.signal });
const soon = () => ({ until: performance.now() + 120_000 });
const needed = (CHECK.runMinutes + CHECK.cleanupMinutes) * 60 + STOP_SECONDS;
let token;
try {
  const first = { whoami: await reads.whoami(soon()), atMs: Date.now() };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 15_000);
    work.signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("Interrupted"))), { once: true });
  });
  token = tokenOutlasts(first, { whoami: await reads.whoami(soon()), atMs: Date.now() }, needed);
} catch (error) {
  console.error(`${work.signal.aborted ? "Interrupted while reading the account" : `Reading the account failed (${safe(error instanceof Error ? error.message : String(error))})`}, before anything was started. Nothing was sent but the reads.`);
  process.exit(work.signal.aborted ? 130 : 2);
}
if (!token.ok) {
  console.error(`Your token ${token.expiresAt ? `expires at ${token.expiresAt}` : "didn't say when it expires"}, and the run with its cleanup can take ${Math.ceil(needed / 60)} minutes. Create a key that stays valid for at least an hour, put it in the credentials file, then try again. Nothing was started.`);
  process.exit(2);
}

folder = join(evidenceRoot, `sandbox-check-${new Date().toISOString().replace(/[:.]/g, "")}`);
mkdirSync(join(folder, "journals"), { recursive: true, mode: 0o700 });
const { parent, fixture } = await fixtureAndSnapshot();
const checkoutBefore = folderState(fixture.root);
const home = join(homedir(), ".nivra");
const homeBefore = folderState(home, true);
// Every spawn's request, as sent: what it asked of the network.
const spawns: Array<{ networking: boolean }> = [];
const watched = (inner: Transport): Transport => async (request) => {
  if (request.method === "POST" && request.path === "/v1/instances") spawns.push({ networking: (JSON.parse(String(request.body)) as { networking?: { enabled?: boolean } }).networking?.enabled === true });
  return inner(request);
};
const backend = createNebiusBackend({ credentials: () => keys, baseImage: IMAGE.uuid, journalDir: join(folder, "journals"), limits: LIMITS, transport: (given) => watched(fetchTransport(given)) });
const local = await createLocalBackend({ baseEnv: process.env }).open({ workspace: fixture.root });
log(`Fixture at ${fixture.root}, baseline ${fixture.baseline}. Running the recipe on ${IMAGE.tag} (${IMAGE.uuid}).`);
let result: PrescribedResult;
try {
  result = await runPrescribed({
    project: "sandbox-check",
    target: "local",
    folder: fixture.root,
    baseline: fixture.baseline,
    steps: fixtureRecipe(),
    backend,
    local,
    git,
    budgetMs: CHECK.runMinutes * 60_000,
    closeBudgetMs: CHECK.cleanupMinutes * 60_000,
    collectTimeoutMs: CHECK.commandSeconds * 1000,
    signal: work.signal,
    closeSignal: settling.signal,
    onStep: (step) => log(`${step.label}: ${step.cancelled ? "cancelled" : step.timedOut ? "timed out" : `exit ${String(step.exitCode)}`}${step.signal ? `, ${step.signal}` : ""}; ${step.status ?? "no status"}; ${String(step.durationMs)} ms`),
  });
} catch (error) {
  // Only something before the session could throw here; what the journal holds is the record of anything sent.
  write(join(folder, "result.json"), { outcome: "fault", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  log(`The run stopped with a fault before its session (${error instanceof Error ? error.message : String(error)}). Evidence: ${folder}`);
  process.exit(1);
} finally {
  await local.close();
}

// What the run left, checked: each check is named with what it looked at.
const checks: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ check: name, pass, detail });
const step = (label: string) => result.steps.find((entry) => entry.label === label);
const shown = (label: string, fields: readonly string[]) => {
  const entry = step(label) as Record<string, unknown> | undefined;
  return entry ? JSON.stringify(Object.fromEntries(fields.map((field) => [field, entry[field]]))) : "the step didn't run";
};
check("the run proposed a change", result.outcome === "proposed", `${result.outcome}${result.stopped ? `: ${result.stopped.code}, ${result.stopped.message}` : ""}`);
check("the prepare step's listing matched the snapshot's", result.cleanup !== null && result.steps.length > 0, "the session opens only when the digests match");
check("the edit kept its changes", step("edit")?.exitCode === 0 && step("edit")?.persisted === true, shown("edit", ["exitCode", "persisted", "status"]));
const network = step("network");
const verdict = networkVerdict(network?.exitCode ?? null, network?.stdoutTail ?? "");
check("network denied by behaviour: loopback alone, and both attempts failing for want of a network", verdict.pass, verdict.detail);
check("busybox's version recorded", /^busybox: BusyBox v/m.test(network?.stdoutTail ?? ""), /^busybox: .*$/m.exec(network?.stdoutTail ?? "")?.[0] ?? "not printed");
check("the passing check passed", step("check")?.exitCode === 0 && step("check")?.stdoutTail === "PASS: Hello, Nivra\n", JSON.stringify(step("check")?.stdoutTail ?? null));
check("the failing check failed, told apart from the operation", step("failing check")?.exitCode === 1 && step("failing check")?.status === "SUCCESS", shown("failing check", ["exitCode", "status"]));
check("a timeout told apart from success", step("timeout")?.timedOut === true, shown("timeout", ["timedOut", "exitCode", "signal", "status"]));
check("a prescribed stop, once seen running, seen to stop", step("stop")?.cancelled === true && step("stop")?.status === "CANCELLED" && (step("stop")?.durationMs ?? 0) >= 5_000, shown("stop", ["cancelled", "status", "durationMs"]));
check("the collect step's listing matched its archive", step("collect")?.exitCode === 0 && result.outcome === "proposed", "the result is taken only when they match");
check("networking off for every spawn", spawns.length > 0 && spawns.every((spawn) => !spawn.networking), `${spawns.length} spawns, ${spawns.filter((spawn) => spawn.networking).length} with networking on`);
check("each operation sent once", spawns.length === CHECK.operations, `${spawns.length} spawns for ${CHECK.operations} operations`);
const cwd = /^cwd: (.*)$/m.exec(network?.stdoutTail ?? "")?.[1] ?? null;
const recorded = [`the service's folder for a step: ${cwd ?? "not printed"} (asked for /workspace)`];
if (result.proposal) {
  const proposal = result.proposal;
  let verified = "verified";
  try {
    verifyProposal(proposal, { project: "sandbox-check", target: "local", destination: { root: realpathSync.native(fixture.root), prefix: "" }, head: fixture.baseline, approvedHash: proposal.hash });
  } catch (error) {
    verified = error instanceof Error ? error.message : String(error);
  }
  check("the proposal is bound to the fixture's folder and commit", verified === "verified", verified);
  const report = JSON.parse(new TextDecoder().decode(proposal.report)) as { changes: Array<{ change: string; path: string; mode?: string; sha256?: string }>; steps: unknown[]; operations: Array<{ label: string }> };
  const expected = [["deleted", "old.txt", null, null], ...EXPECTED_CHANGE.added.map((change) => ["added", change.path, change.mode, sha(change.bytes)]), ...EXPECTED_CHANGE.changed.map((change) => ["changed", change.path, change.mode, sha(change.bytes)])];
  const got = report.changes.map((change) => [change.change, change.path, change.mode ?? null, change.sha256 ?? null]);
  check("the patch holds exactly the fixed edit", canonicalJson(got) === canonicalJson(expected), JSON.stringify(got));
  // The report the person approves says what happened: the same steps, and every operation the session ran.
  const reportSteps = canonicalJson(report.steps) === canonicalJson(JSON.parse(JSON.stringify(result.steps)));
  const operations = report.operations.map((operation) => operation.label);
  check("the bound report holds what happened", reportSteps && operations.length === CHECK.operations && operations[0] === "prepare", `steps ${reportSteps ? "as run" : "differ"}; operations ${operations.join(", ")}`);
  const clone = join(parent, "fresh clone");
  const run = (args: string[], cwd: string) => spawnSync(git, args, { cwd, encoding: "utf8" });
  const cloned = run(["clone", "-q", "--no-hardlinks", fixture.root, clone], parent);
  writeFileSync(join(parent, "change.patch"), proposal.patch);
  const applyCheck = cloned.status === 0 ? run(["apply", "--check", join(parent, "change.patch")], clone) : cloned;
  check("git apply --check passes on a fresh clone", applyCheck.status === 0, applyCheck.stderr.trim() || "exit 0");
  const applied = applyCheck.status === 0 ? run(["apply", join(parent, "change.patch")], clone) : applyCheck;
  const tree = applied.status === 0 && run(["add", "-A"], clone).status === 0 ? run(["write-tree"], clone).stdout.trim() : "";
  check("the applied patch gives the bound result tree", tree === proposal.binding.resultTree, `${tree || "not applied"} against ${proposal.binding.resultTree}`);
  write(join(folder, "change.patch"), new TextDecoder().decode(proposal.patch));
  write(join(folder, "proposal.json"), { hash: proposal.hash, binding: proposal.binding });
  write(join(folder, "report.json"), report);
}
check("the fixture's checkout is unchanged", changed(checkoutBefore, folderState(fixture.root)).length === 0, changed(checkoutBefore, folderState(fixture.root)).join(", ") || "every name, mode, size, time and byte");
check("the release engine home (~/.nivra) is unchanged", changed(homeBefore, folderState(home, true)).length === 0, changed(homeBefore, folderState(home, true)).slice(0, 5).join(", ") || "every name, mode, size and time");
const cleanup = result.cleanup;
check("cleanup left nothing unresolved", cleanup !== null && cleanup.unresolved.length === 0, cleanup ? `stopped ${cleanup.stopped.length}, already ended ${cleanup.alreadyEnded.length}, unresolved ${cleanup.unresolved.length}${cleanup.unresolved.length ? `: ${cleanup.unresolved.join("; ")}` : ""}` : "no session was opened");

write(join(folder, "result.json"), { outcome: result.outcome, stopped: result.stopped, snapshot: result.snapshot, steps: result.steps, cleanup: result.cleanup });
write(join(folder, "checks.json"), { checks, recorded });
const failed = checks.filter((entry) => !entry.pass);
const summary = [
  `# Nebius sandbox check, ${new Date().toISOString()}`,
  "",
  `Outcome: **${result.outcome}**. Checks: ${checks.length - failed.length} of ${checks.length} passed.`,
  "",
  ...checks.map((entry) => `- ${entry.check}: **${entry.pass ? "pass" : "fail"}** (${entry.detail})`),
  "",
  "## Recorded, not judged",
  "",
  ...recorded.map((line) => `- ${line}`),
  "",
  "## Steps",
  "",
  ...result.steps.map((entry) => `- ${entry.label}: exit ${String(entry.exitCode)}, signal ${entry.signal ?? "none"}${entry.timedOut ? ", timed out" : ""}${entry.cancelled ? ", cancelled" : ""}; ${entry.status ?? "no status"}; ${String(entry.durationMs)} ms; usage ${JSON.stringify(entry.usage)}`),
  "",
  `Retention: ${RETENTION}`,
  cleanup?.retained ? `Kept by the provider, from the journal: ${cleanup.retained.uploads} upload(s), ${cleanup.retained.images} image(s), ${cleanup.retained.operations} operation record(s).` : "",
];
write(join(folder, "summary.md"), summary.join("\n"));
rmSync(parent, { recursive: true, force: true });
log(`${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `; failed: ${failed.map((entry) => entry.check).join("; ")}` : ""}. Evidence: ${folder}`);
process.exit(interrupts ? 130 : failed.length ? 1 : 0);
