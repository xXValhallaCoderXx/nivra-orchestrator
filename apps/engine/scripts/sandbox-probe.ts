// Live check (NIV-29, D28): whether Nebius Token Factory Sandboxes can carry the first coding workflow. Never part of
// `pnpm verify`, and never run without your approval of the stage: stage 0 only reads; stage 1 runs at most twelve small
// operations on a synthetic fixture. No model is called and nothing is installed. Networking is off for every
// operation but one approved control.
//
// Usage:
//   pnpm probe:sandbox --plan
//   pnpm probe:sandbox --credentials <file> --stage 0
//   pnpm probe:sandbox --credentials <file> --stage 1 --image <uuid|tag:name> --deny <url> [--deny <url>] [--network-control <url>]
//   pnpm probe:sandbox --credentials <file> --recover <evidence folder>
//
// The key and project id come from a file only you can read, outside the repository, holding NEBIUS_API_KEY=… and
// NEBIUS_PROJECT_ID=… lines (or from those variables, set in your own terminal). Never paste them into a chat. They are
// read once, removed from the environment, and never printed or written: evidence replaces them with placeholders.
// Evidence goes to ~/nivra-acceptance/sandbox-probe-<UTC>/ (0700): the journal, each step's outcome (outputs cut to
// 2 KB), the verdicts and a summary. Stage 1 stops at its overall deadline, a hard limit; cleanup then has its own. The
// first Ctrl+C settles every operation the probe started (reconcile, cancel, confirm); --recover finishes that later
// from the journal.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { fetchTransport, SandboxApi } from "../src/exec/nebius/api.ts";
import { CLEANUP_MAX_SECONDS, evaluate, LATENCY, PROBE_LIMITS, probePlan, RETENTION, runStageOne, stageZeroSummary, tokenOutlasts } from "../src/exec/nebius/probe.ts";
import { Journal, Sandbox } from "../src/exec/nebius/sandbox.ts";

const FIXTURE = fileURLToPath(new URL("../test/fixtures/sandbox-probe/", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    plan: { type: "boolean", default: false },
    credentials: { type: "string" },
    stage: { type: "string" },
    image: { type: "string" },
    deny: { type: "string", multiple: true, default: [] },
    "network-control": { type: "string" },
    recover: { type: "string" },
    evidence: { type: "string" },
  },
  allowPositionals: false,
});

const fixture = readdirSync(FIXTURE)
  .sort()
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(FIXTURE, name))) }));
const fixtureBytes = fixture.reduce((sum, file) => sum + file.bytes.byteLength, 0);
if (fixtureBytes > PROBE_LIMITS.maxUploadBytes) {
  console.error(`The fixture is ${fixtureBytes} bytes, over the ${PROBE_LIMITS.maxUploadBytes} the probe uploads. Nothing was sent.`);
  process.exit(2);
}

if (values.plan) {
  const plan = probePlan(fixture.map((file) => ({ name: file.name, bytes: file.bytes.byteLength })));
  console.log("Nebius Sandboxes probe: the plan, as it would run. Nothing here touches the network.\n");
  for (const step of plan.steps) console.log(`${step.id.padStart(3)}  [${step.pattern}] network ${step.network}; timeout ${step.timeoutSeconds === null ? "n/a" : `${step.timeoutSeconds} s`}; data: ${step.data}\n     ${step.what}`);
  console.log(`\nOperations: ${plan.operations} (at most ${PROBE_LIMITS.maxOperations}, plus one image import only if no public image fits), one at a time.`);
  console.log(`Uploads: ${plan.uploads}. Downloads: at most ${PROBE_LIMITS.maxDownloadBytes} bytes.`);
  console.log(`Deadlines: ${PROBE_LIMITS.requestTimeoutSeconds} s per request; each operation's timeout plus ${PROBE_LIMITS.observeMarginSeconds} s to observe it.`);
  console.log(`  Stage 1 stops at ${PROBE_LIMITS.overallMinutes} minutes, a hard limit: no wait goes past it, no read is made after it, and nothing starts after it.`);
  console.log(`  Cleanup then takes at most ${Math.ceil(CLEANUP_MAX_SECONDS / 60)} minutes: two searches for a lost answer (${PROBE_LIMITS.searchSeconds} s each) and two cancels (a request, then ${PROBE_LIMITS.cancelWaitSeconds} s each).`);
  console.log(`  Before anything starts, stage 1 reads the account twice, 15 s apart (GET /v1/whoami). It starts only if the token is renewed with each request, or stays valid for ${Math.ceil((PROBE_LIMITS.overallMinutes * 60 + CLEANUP_MAX_SECONDS) / 60)} minutes.`);
  console.log("No model calls, no installs.");
  console.log("\nThresholds, agreed before the run. Each pattern is judged on its own evidence, its checks and its latency together:");
  console.log("  Critical, for each pattern (a failure defers that pattern; if neither qualifies, NIV-34 stays blocked and local containers");
  console.log("  are proposed instead, never Local):");
  console.log("    network denial shown by behaviour, against a positive control that worked (a failed control is inconclusive);");
  console.log("    state continues (A: through an image; B: between subprocesses in the parent);");
  console.log("    a cancel reaches CANCELLED within 60 s (B: and its running subprocess is reported ended);");
  console.log("    a failing command's exit code told apart; the patch and report retrieved with matching hashes.");
  console.log("  Critical, holding for both: reattaching observes the same operation with no second spawn; a timeout told apart from SUCCESS.");
  console.log(`  Latency, each pattern's own median per step: adopt at ${LATENCY.adoptSeconds} s or less, with concern up to ${LATENCY.concernSeconds} s, defer above.`);
  console.log("  The decision is the better pattern that qualifies.");
  console.log("  Recorded, not blocking: reconciling a lost answer; what an idle parent costs; the retention below.");
  console.log(`\nRetention: ${RETENTION}`);
  console.log("Cost: unknown in advance; the service's own figures are reported raw, never converted to money.");
  process.exit(0);
}

/** The key and project id: from a file only you can read, outside the repository, or from your own terminal. */
function credentials(): { key: string | undefined; project: string | undefined } {
  if (!values.credentials) return { key: process.env["NEBIUS_API_KEY"]?.trim(), project: process.env["NEBIUS_PROJECT_ID"]?.trim() };
  const path = resolve(values.credentials);
  const inside = relative(REPOSITORY, path);
  if (!inside.startsWith("..") && !isAbsolute(inside)) {
    console.error(`${path} is inside the repository, where it could be committed. Move it outside (for example to ~/.config/nivra/), then try again. Nothing was sent.`);
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`There's no file at ${path}. Create it with NEBIUS_API_KEY=… and NEBIUS_PROJECT_ID=… lines, run chmod 600 on it, then try again. Nothing was sent.`);
    process.exit(2);
  }
  const mode = statSync(path).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    console.error(`${path} can be read by others (mode ${mode.toString(8)}). Run chmod 600 on it, then try again. Nothing was sent.`);
    process.exit(2);
  }
  const parsed = parseEnv(readFileSync(path, "utf8"));
  return { key: parsed["NEBIUS_API_KEY"]?.trim(), project: parsed["NEBIUS_PROJECT_ID"]?.trim() };
}

const { key, project } = credentials();
delete process.env["NEBIUS_API_KEY"];
delete process.env["NEBIUS_PROJECT_ID"];
if (!key || !project) {
  console.error(`NEBIUS_API_KEY and NEBIUS_PROJECT_ID must both be set, ${values.credentials ? `in ${values.credentials}` : "in your own terminal, or in a file passed with --credentials"}. Nothing was sent.`);
  process.exit(2);
}
/** Text with the key and the project id taken out, for everything printed or written. */
const safe = (text: string) => text.split(key).join("[key]").split(project).join("[project]");
const write = (path: string, value: unknown) => writeFileSync(path, `${safe(JSON.stringify(value, null, 2))}\n`, { mode: 0o600 });

const folder =
  values.recover ?? join(values.evidence ?? join(homedir(), "nivra-acceptance"), `sandbox-probe-${new Date().toISOString().replace(/[:.]/g, "")}`);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const started = performance.now();
const log = (line: string) => console.log(`${String(Math.round(performance.now() - started)).padStart(8)} ms  ${safe(line)}`);
const transport = fetchTransport({ key, project });
const api = () => new SandboxApi(transport, { requestTimeoutMs: PROBE_LIMITS.requestTimeoutSeconds * 1000 });
/** A sandbox over the probe's file-backed journal. Stage 1's is capped by the overall deadline; cleanup's isn't. */
const sandboxFor = (client: SandboxApi, cap?: () => number) =>
  new Sandbox(client, {
    journal: new Journal(join(folder, "journal.jsonl")),
    observeMarginMs: PROBE_LIMITS.observeMarginSeconds * 1000,
    cancelWaitMs: PROBE_LIMITS.cancelWaitSeconds * 1000,
    search: { sinceMarginMs: 24 * 60 * 60 * 1000, pageSize: 100, maxPages: 10, maxCandidates: 50, withinMs: PROBE_LIMITS.searchSeconds * 1000 },
    maxTimeoutSeconds: PROBE_LIMITS.maxParentTimeoutSeconds,
    ...(cap ? { cap } : {}),
  });

if (values.recover) {
  const sandbox = sandboxFor(api());
  log(`Settling what ${folder} left open.`);
  const settled = await sandbox.cleanup();
  write(join(folder, `recover-${Date.now()}.json`), settled);
  log(`cancelled ${settled.cancelled.length}; unresolved ${settled.unresolved.length}${settled.unresolved.length ? `: ${settled.unresolved.join("; ")}` : ""}`);
  process.exit(settled.unresolved.length ? 1 : 0);
}

if (values.stage === "0") {
  const client = api();
  const [whoami, images] = await Promise.all([client.whoami(), client.images()]);
  // The full answers go to the private evidence file; the terminal gets only what the proof needs.
  write(join(folder, "stage0.json"), { whoami, images });
  const summary = stageZeroSummary(whoami, images);
  for (const line of summary.lines) log(line);
  log(summary.ready ? "Stage 1 could run on this account." : "Stage 1 couldn't run as planned on this account: see above.");
  log(`Evidence: ${folder}`);
  process.exit(summary.ready ? 0 : 1);
}

if (values.stage !== "1" || !values.image) {
  console.error("Choose --plan, --stage 0, --stage 1 --image <uuid|tag:name>, or --recover <folder>.");
  process.exit(2);
}

const client = api();
// A token that expires partway would leave the probe unable to read or cancel its own operations: check it first, with
// two readings 15 s apart, since a token renewed with each request reports an expiry minutes after that request.
const needed = PROBE_LIMITS.overallMinutes * 60 + CLEANUP_MAX_SECONDS;
const first = { whoami: await client.whoami(), atMs: Date.now() };
await new Promise((resolve) => setTimeout(resolve, 15_000));
const token = tokenOutlasts(first, { whoami: await client.whoami(), atMs: Date.now() }, needed);
if (token.renewed) log(`The token is renewed with each request (it now expires at ${token.expiresAt}), so your key's own lifetime is what counts.`);
if (!token.ok) {
  console.error(`Your token ${token.expiresAt ? `expires at ${token.expiresAt}` : "didn't say when it expires"}, and stage 1 with its cleanup can take ${Math.ceil(needed / 60)} minutes. Create a key that stays valid for at least an hour, put it in the credentials file, then try again. Nothing was started.`);
  process.exit(2);
}
const deadline = { at: performance.now() + PROBE_LIMITS.overallMinutes * 60_000 };
const sandbox = sandboxFor(client, () => deadline.at);
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  deadline.at = 0;
  log("Interrupted: settling every operation the probe started, then stopping. Press Ctrl+C again to leave it to --recover.");
});

let results: Awaited<ReturnType<typeof runStageOne>> | null = null;
try {
  results = await runStageOne({
    sandbox,
    api: client,
    reconnect: () => sandboxFor(api(), () => deadline.at),
    baseImage: values.image,
    fixture,
    deny: values.deny ?? [],
    networkControl: values["network-control"] ?? null,
    now: () => performance.now(),
    get deadline() {
      return deadline.at;
    },
    log,
  });
} finally {
  // Cleanup runs past the overall deadline, with its own bounds, on the same journal.
  const settled = await sandboxFor(api()).cleanup();
  write(join(folder, "cleanup.json"), settled);
  log(`Cleanup: cancelled ${settled.cancelled.length}; unresolved ${settled.unresolved.length}${settled.unresolved.length ? ` (run --recover ${folder})` : ""}`);
}
const judged = evaluate(results);
write(join(folder, "results.json"), { ...results, steps: results.steps.map((step) => ({ ...step, outcome: step.outcome ? { ...step.outcome, stdout: step.outcome.stdout.slice(0, 2_000), stderr: step.outcome.stderr.slice(0, 2_000) } : null })) });
write(join(folder, "verdicts.json"), judged);
const chosen = judged.patterns.find((p) => p.pattern === judged.pattern);
const report = [
  `# Nebius Sandboxes probe, ${new Date().toISOString()}`,
  "",
  `Decision: **${judged.decision}**${chosen ? `, on pattern ${chosen.pattern} (${chosen.name})` : ""}.`,
  ...judged.patterns.flatMap((p) => [
    "",
    `## Pattern ${p.pattern}, ${p.name}: ${p.outcome}`,
    "",
    ...p.verdicts.map((v) => `- ${v.criterion}: **${v.outcome}** (${v.detail})`),
    `- Latency, the median per step: ${p.latency.median?.toFixed(1) ?? "n/a"} s: **${p.latency.outcome}**`,
  ]),
  "",
  "## Recorded, not blocking",
  "",
  ...judged.recorded.map((v) => `- ${v.criterion}: **${v.outcome}** (${v.detail})`),
  "",
  `Retention: ${RETENTION}`,
  "",
  `Errors: ${results.errors.length ? results.errors.join("; ") : "none"}`,
];
writeFileSync(join(folder, "report.md"), `${safe(report.join("\n"))}\n`, { mode: 0o600 });
log(`Decision: ${judged.decision}${chosen ? `, on pattern ${chosen.pattern}` : ""}. Evidence: ${folder}`);
process.exit(interrupted ? 130 : 0);
