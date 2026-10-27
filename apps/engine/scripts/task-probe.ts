// Live toolchain probe (NIV-7, D39): five operations on Nebius, no model, the execution milestone's fixture only.
// Never part of `pnpm verify`, and never run without your approval of the recipe `--plan` prints: one approval covers
// the one bounded run it describes, its cleanup included, and nothing more. Nothing is installed. Networking is off for
// every operation, and the adapter can't turn it on.
//
// Usage (from the repository's top level):
//   node apps/engine/scripts/task-probe.ts --plan
//   node apps/engine/scripts/task-probe.ts --credentials <file> --run
//   node apps/engine/scripts/task-probe.ts --credentials <file> --recover <evidence folder>
//
// The key and project id come from a file only you can read, outside the repository, holding NEBIUS_API_KEY=… and
// NEBIUS_PROJECT_ID=… lines. They are read once, removed from the environment, and never printed or written: evidence
// replaces them with placeholders. Evidence goes to ~/nivra-acceptance/task-probe-<UTC>/ (0700). Close the Nivra app
// first: the probe fails if the release engine home (~/.nivra) changed. The first Ctrl+C stops the work at once, then
// closing settles what it started on its own budget; a second stops cleanup, and --recover finishes it later.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { findGit } from "../src/exec/find-executable.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { fetchTransport, SandboxApi, type Transport } from "../src/exec/nebius/api.ts";
import { insideRepository, RETENTION, tokenOutlasts } from "../src/exec/nebius/probe.ts";
import { createNebiusBackend, NEBIUS_LIMITS, reconcileJournals, scanJournals } from "../src/exec/nebius/session.ts";
import { canonicalJson } from "../src/exec/proposal.ts";
import { takeSnapshot } from "../src/exec/snapshot.ts";
import { IMAGE } from "./sandbox-fixture.ts";
import { buildTaskFixture, TASK_BRIEF, TASK_FIXTURE, trickyGreet } from "./task-fixture.ts";
import { runToolchainProbe, WRITE_MARKER } from "./task-probe-run.ts";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: { plan: { type: "boolean", default: false }, run: { type: "boolean", default: false }, credentials: { type: "string" }, recover: { type: "string" }, evidence: { type: "string" } },
  allowPositionals: false,
});

/** The probe's bounds, which the adapter itself enforces: its operations, each command's time, the session's, cleanup's. */
const PROBE = Object.freeze({ operations: 5, commandSeconds: 60, sessionMinutes: 15, cleanupMinutes: 7 });
const LIMITS = { ...NEBIUS_LIMITS, maxOperations: PROBE.operations, maxTimeoutSeconds: PROBE.commandSeconds, prepareTimeoutSeconds: PROBE.commandSeconds, sessionBudgetMs: PROBE.sessionMinutes * 60_000, cleanupBudgetMs: PROBE.cleanupMinutes * 60_000 };
const STOP_SECONDS = Math.round((NEBIUS_LIMITS.minWriteMs + NEBIUS_LIMITS.requestTimeoutMs + NEBIUS_LIMITS.cancelWaitMs) / 1000);

/** What the approved recipe sends, pinned: the run is refused if the fixture it builds isn't this one. */
export const TASK_PROBE_APPROVED = {
  baseline: "0af8b0072826a232d767ab7b72829541a6ec6506",
  archiveSha256: "3b1e43b1ec36b9cbdbbd187824009d1bdd585b51ae02a4e7620e933c6a2263a9",
  listingDigest: "071f4868084f47df1cf17b97cf80cafb133346b578ac34cadc196600185bcc01",
  archiveBytes: 3_072,
  writeSha256: "c1d588a0c382ac0968e284dbff87d1f2cee94345aedec1f27c45357844282003",
} as const;

const git = findGit({ env: process.env });
if (!git) {
  console.error("git isn't installed here. Install it, then try again. Nothing was sent.");
  process.exit(2);
}
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** The fixture, built in a folder of its own, with its snapshot; refused unless it is the approved one. */
async function fixtureAndSnapshot(strict: boolean) {
  const parent = mkdtempSync(join(tmpdir(), "nivra-task-probe-"));
  const fixture = buildTaskFixture(join(parent, "fixture"), git!);
  const local = await createLocalBackend({ baseEnv: process.env }).open({ workspace: fixture.root });
  let snapshot;
  try {
    snapshot = await takeSnapshot({ folder: fixture.root, session: local, git: git!, baseline: fixture.baseline });
  } finally {
    await local.close();
  }
  const built = { baseline: fixture.baseline, archiveSha256: snapshot.archive.sha256, listingDigest: snapshot.archive.listingDigest, archiveBytes: snapshot.archive.archive.byteLength, writeSha256: sha(trickyGreet()) };
  if (strict && canonicalJson(built) !== canonicalJson(TASK_PROBE_APPROVED)) {
    rmSync(parent, { recursive: true, force: true });
    console.error(`The fixture or write built here isn't the approved one (${JSON.stringify(built)}, against ${JSON.stringify(TASK_PROBE_APPROVED)}), so nothing was sent. Print the recipe with --plan and ask for its approval again.`);
    process.exit(2);
  }
  return { parent, fixture, snapshot, built };
}

/** The Nivra revision this script runs from, and whether its checkout is clean. */
function revision(): { head: string; clean: boolean } {
  const head = spawnSync(git!, ["rev-parse", "HEAD"], { cwd: REPOSITORY, encoding: "utf8" }).stdout.trim();
  const status = spawnSync(git!, ["status", "--porcelain"], { cwd: REPOSITORY, encoding: "utf8" }).stdout.trim();
  return { head, clean: status === "" };
}

if (values.plan) {
  const { parent, snapshot, built } = await fixtureAndSnapshot(false);
  rmSync(parent, { recursive: true, force: true });
  const content = trickyGreet();
  const at = revision();
  const out = (line = "") => console.log(line);
  out("Nebius toolchain probe (NIV-7): the recipe, as it would run. Nothing here touches the network.\n");
  out(`Revision: ${at.head}${at.clean ? "" : " (the checkout has uncommitted changes)"}.`);
  out(`Fixture: ${TASK_FIXTURE.length} files, ${snapshot.files.reduce((sum, file) => sum + file.size, 0)} bytes, built at run time in a temporary folder:`);
  for (const file of snapshot.files) out(`  ${file.mode} ${String(file.size).padStart(4)} B  ${file.path}`);
  out(`Baseline: ${built.baseline} (a fixed author and time, so always this commit).`);
  out(`Sent: one upload, the snapshot's tar, ${built.archiveBytes} bytes, sha256 ${built.archiveSha256}. Nothing of yours.`);
  out(`Image: ${IMAGE.tag} (${IMAGE.uuid}), the public image D28 and B3 used.\n`);
  out(`Operations: ${PROBE.operations}, one at a time, networking off for every one:`);
  out(`  1. prepare: extract the snapshot; its listing's digest must be ${built.listingDigest} (timeout ${PROBE.commandSeconds} s)`);
  out("  2. applets: /bin/busybox --list, its changes thrown away (timeout 30 s): which tools the image has");
  out(`  3. write: Nivra's write script puts greet.sh, fixed, with comment lines of tricky text, ${Buffer.byteLength(content)} bytes, sha256 ${built.writeSha256},`);
  out("     as one argument; kept (timeout 30 s). Then greet.sh is read back (cap 33 KiB, 30 s) and compared byte for byte,");
  out(`     and the write's operation record is read once, to see whether it keeps the content (it looks for "${WRITE_MARKER}")`);
  out(`  4. case: /bin/sh -c '${TASK_BRIEF.acceptanceCases[0]!.command}', its changes thrown away (timeout 60 s); it must print exactly`);
  out(`     ${JSON.stringify(TASK_BRIEF.acceptanceCases[0]!.expectedOutput)} and exit 0, seeing the write`);
  out(`  5. collect: archive and list the workspace; both read back (caps 16 MiB and 4 MiB, 60 s each) (timeout ${PROBE.commandSeconds} s);`);
  out("     the result must be exactly the fixture plus the write");
  out(`\nBounds: the session's work stops at ${PROBE.sessionMinutes} minutes, a hard limit every request of it ends by, except stopping a command`);
  out(`already under way, which may take ${STOP_SECONDS} s more. Closing then has ${PROBE.cleanupMinutes} minutes of its own.`);
  out(`The adapter refuses more than ${PROBE.operations} operations, and any command over ${PROBE.commandSeconds} s.`);
  out("Before it starts, the run reads the account twice, 15 s apart (GET /v1/whoami), and starts only if the token outlasts it and its cleanup.");
  out("One approval covers this one run: its operations, upload, reads and polling, its cleanup, and a --recover pass for it within");
  out(`${PROBE.cleanupMinutes} minutes if cleanup is cut short. A rerun or more operations need a new approval.`);
  out("\nCredentials: the file you pass with --credentials (mode 600, outside the repository). Never printed, never written.");
  out(`Retention: ${RETENTION} The write's operation record may keep its arguments, the fixture's text and the tricky comment lines; the probe records whether it does.`);
  out("No model is called, so no tokens are used. Cost: unknown in advance; the service's own usage figures are recorded raw, never converted to money.");
  out("Evidence: ~/nivra-acceptance/task-probe-<UTC>/ (0700): the result, the applet list, the checks, the journal.");
  out("Close the Nivra app first: the probe fails if ~/.nivra changed.");
  process.exit(0);
}

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
  log(`Settling what ${folder} left open (${scan.open.length} journal${scan.open.length === 1 ? "" : "s"}), within ${PROBE.cleanupMinutes} minutes.`);
  const passes = await reconcileJournals(scan.open, { credentials: keys, budgetMs: PROBE.cleanupMinutes * 60_000, signal: settling.signal, limits: LIMITS });
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
      const bytes = light || info.isDirectory() || info.isSymbolicLink() ? "" : sha(readFileSync(path));
      state.set(relative(root, path), `${info.mode} ${info.size} ${info.mtimeNs} ${bytes}`);
      if (info.isDirectory()) walk(path);
    }
  };
  walk(root);
  return state;
}
const changed = (before: Map<string, string> | null, after: Map<string, string> | null) =>
  before === null || after === null ? (before === after ? [] : ["(the folder appeared or went)"]) : [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));

const work = new AbortController();
const settling = new AbortController();
let interrupts = 0;
let folder: string | null = null;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts === 1) {
    work.abort(new Error("Interrupted"));
    log(`Interrupted: the work stops at once, and closing settles what it started, within ${PROBE.cleanupMinutes} minutes. Press Ctrl+C again to stop that and leave it to --recover.`);
  } else if (interrupts === 2) {
    settling.abort();
    log(`Stopping cleanup: what is still open is in the journal.${folder ? ` Run --recover ${folder}.` : ""}`);
  } else process.exit(130);
});

const at = revision();
const reads = new SandboxApi(fetchTransport(keys), { requestTimeoutMs: 30_000, signal: work.signal });
const soon = () => ({ until: performance.now() + 120_000 });
const needed = (PROBE.sessionMinutes + PROBE.cleanupMinutes) * 60 + STOP_SECONDS;
let token;
try {
  const first = { whoami: await reads.whoami(soon()), atMs: Date.now() };
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(done, 15_000);
    work.signal.addEventListener("abort", () => (clearTimeout(timer), fail(new Error("Interrupted"))), { once: true });
  });
  token = tokenOutlasts(first, { whoami: await reads.whoami(soon()), atMs: Date.now() }, needed);
} catch (error) {
  console.error(`${work.signal.aborted ? "Interrupted while reading the account" : `Reading the account failed (${safe(error instanceof Error ? error.message : String(error))})`}, before anything was started. Nothing was sent but the reads.`);
  process.exit(work.signal.aborted ? 130 : 2);
}
if (!token.ok) {
  console.error(`Your token ${token.expiresAt ? `expires at ${token.expiresAt}` : "didn't say when it expires"}, and the probe with its cleanup can take ${Math.ceil(needed / 60)} minutes. Create a key that stays valid for at least an hour, put it in the credentials file, then try again. Nothing was started.`);
  process.exit(2);
}

folder = join(evidenceRoot, `task-probe-${new Date().toISOString().replace(/[:.]/g, "")}`);
mkdirSync(join(folder, "journals"), { recursive: true, mode: 0o700 });
const { parent, fixture, snapshot } = await fixtureAndSnapshot(true);
const checkoutBefore = folderState(fixture.root);
const home = join(homedir(), ".nivra");
const homeBefore = folderState(home, true);
const spawns: Array<{ networking: boolean }> = [];
const watched = (inner: Transport): Transport => async (request) => {
  if (request.method === "POST" && request.path === "/v1/instances") spawns.push({ networking: (JSON.parse(String(request.body)) as { networking?: { enabled?: boolean } }).networking?.enabled === true });
  return inner(request);
};
const backend = createNebiusBackend({ credentials: () => keys, baseImage: IMAGE.uuid, journalDir: join(folder, "journals"), limits: LIMITS, transport: (given) => watched(fetchTransport(given)) });
log(`Revision ${at.head}${at.clean ? "" : " (uncommitted changes)"}. Fixture at ${fixture.root}, baseline ${fixture.baseline}. Probing ${IMAGE.tag} (${IMAGE.uuid}).`);
const outcome = await runToolchainProbe({ backend, snapshot, transport: fetchTransport(keys), budgetMs: PROBE.sessionMinutes * 60_000, closeBudgetMs: PROBE.cleanupMinutes * 60_000, signal: work.signal, closeSignal: settling.signal, log });

const checks: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ check: name, pass, detail });
check("the probe ran all five operations", outcome.opened && outcome.stopped === null, outcome.stopped ?? "prepare, applets, write, case, collect");
check("busybox listed its applets", outcome.applets?.exitCode === 0 && (outcome.applets?.list.length ?? 0) > 0, `${outcome.applets?.list.length ?? 0} applets, exit ${String(outcome.applets?.exitCode ?? null)}`);
check("the write came back byte for byte", outcome.write?.exact === true, outcome.write ? `${outcome.write.bytes} bytes, sha256 ${outcome.write.sha256}, read back ${outcome.write.readBack ?? "nothing"}` : "the write didn't run");
check("the acceptance case saw the write across operations", outcome.kase?.verdict === "passed", outcome.kase ? `${outcome.kase.verdict}${outcome.kase.reason ? `: ${outcome.kase.reason}` : ""}` : "the case didn't run");
check("collect gave exactly the fixture plus the write", outcome.collect?.integrity === null && outcome.collect !== null, outcome.collect?.integrity ?? (outcome.collect ? `${outcome.collect.entries} entries` : "collect didn't run"));
check("networking off for every spawn", spawns.length > 0 && spawns.every((spawn) => !spawn.networking), `${spawns.length} spawns, ${spawns.filter((spawn) => spawn.networking).length} with networking on`);
check("each operation sent once", spawns.length === PROBE.operations, `${spawns.length} spawns for ${PROBE.operations} operations`);
check("the fixture's checkout is unchanged", changed(checkoutBefore, folderState(fixture.root)).length === 0, changed(checkoutBefore, folderState(fixture.root)).join(", ") || "every name, mode, size, time and byte");
check("the release engine home (~/.nivra) is unchanged", changed(homeBefore, folderState(home, true)).length === 0, changed(homeBefore, folderState(home, true)).slice(0, 5).join(", ") || "every name, mode, size and time");
check("cleanup left nothing unresolved", outcome.cleanup !== null && outcome.cleanup.unresolved.length === 0, outcome.cleanup ? `stopped ${outcome.cleanup.stopped.length}, already ended ${outcome.cleanup.alreadyEnded.length}, unresolved ${outcome.cleanup.unresolved.length}${outcome.cleanup.unresolved.length ? `: ${outcome.cleanup.unresolved.join("; ")}` : ""}` : "no session was opened");
const wanted = ["sh", "printf", "mkdir", "chmod", "sha256sum", "tar", "find", "sort", "cut", "wc", "readlink", "dd", "rm", "git", "node", "python3", "sed", "awk", "diff"];
const list = new Set(outcome.applets?.list ?? []);
const recorded = [
  `tools as busybox applets: ${wanted.map((tool) => `${tool} ${list.has(tool) ? "yes" : "no"}`).join(", ")} (a tool outside busybox isn't in this list)`,
  `the write's operation record: ${outcome.record ? (outcome.record.read ? (outcome.record.holdsContent ? `keeps the content, in ${outcome.record.fields.join(", ")}` : "doesn't hold the content") : "couldn't be read") : "not read"}`,
];

write(join(folder, "result.json"), outcome);
write(join(folder, "applets.txt"), (outcome.applets?.list ?? []).join("\n"));
write(join(folder, "checks.json"), { revision: at, checks, recorded });
const failed = checks.filter((entry) => !entry.pass);
write(
  join(folder, "summary.md"),
  [
    `# Nebius toolchain probe, ${new Date().toISOString()}`,
    "",
    `Revision ${at.head}${at.clean ? "" : " (uncommitted changes)"}. Checks: ${checks.length - failed.length} of ${checks.length} passed.`,
    "",
    ...checks.map((entry) => `- ${entry.check}: **${entry.pass ? "pass" : "fail"}** (${entry.detail})`),
    "",
    "## Recorded, not judged",
    "",
    ...recorded.map((line) => `- ${line}`),
    "",
    "## Operations",
    "",
    ...outcome.steps.map((entry) => `- ${entry.label}: ${entry.status}, ${entry.verdict}${entry.persisted ? ", kept" : ""}; ${String(entry.durationMs)} ms; usage ${JSON.stringify(entry.usage)}`),
    "",
    `Retention: ${RETENTION}`,
    outcome.cleanup?.retained ? `Kept by the provider, from the journal: ${outcome.cleanup.retained.uploads} upload(s), ${outcome.cleanup.retained.images} image(s), ${outcome.cleanup.retained.operations} operation record(s).` : "",
  ].join("\n"),
);
rmSync(parent, { recursive: true, force: true });
log(`${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `; failed: ${failed.map((entry) => entry.check).join("; ")}` : ""}. Evidence: ${folder}`);
process.exit(interrupts ? 130 : failed.length ? 1 : 0);
