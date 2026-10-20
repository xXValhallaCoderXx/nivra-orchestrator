// Live check (NIV-29, D28): whether Nebius Token Factory Sandboxes can carry the first coding workflow. Never part of
// `pnpm verify`, and never run without your approval of the stage: stage 0 only reads; stage 1 runs at most twelve small
// operations on a synthetic fixture. No model is called and nothing is installed. Networking is off for every
// operation but one approved control.
//
// Usage:
//   pnpm probe:sandbox --plan
//   NEBIUS_API_KEY=… NEBIUS_PROJECT_ID=… pnpm probe:sandbox --stage 0
//   NEBIUS_API_KEY=… NEBIUS_PROJECT_ID=… pnpm probe:sandbox --stage 1 --image <uuid|tag:name> --deny <url> [--deny <url>] [--network-control <url>]
//   NEBIUS_API_KEY=… NEBIUS_PROJECT_ID=… pnpm probe:sandbox --recover <evidence folder>
//
// Set the variables in your own terminal; never paste them into a chat. They are removed from the environment when
// read, and never printed or written: evidence replaces them with placeholders. Evidence goes to
// ~/nivra-acceptance/sandbox-probe-<UTC>/ (0700): the journal, each step's outcome (outputs cut to 2 KB), the
// verdicts and a summary. The first Ctrl+C settles every operation the probe started (reconcile, cancel, confirm);
// --recover finishes that later from the journal.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fetchTransport, SandboxApi } from "../src/exec/nebius/api.ts";
import { evaluate, LATENCY, PROBE_LIMITS, probePlan, RETENTION, runStageOne } from "../src/exec/nebius/probe.ts";
import { Journal, Sandbox } from "../src/exec/nebius/sandbox.ts";

const FIXTURE = fileURLToPath(new URL("../test/fixtures/sandbox-probe/", import.meta.url));
const { values } = parseArgs({
  options: {
    plan: { type: "boolean", default: false },
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
  console.log(`Deadlines: ${PROBE_LIMITS.requestTimeoutSeconds} s per request; each operation's timeout plus ${PROBE_LIMITS.observeMarginSeconds} s to observe it; ${PROBE_LIMITS.overallMinutes} minutes in all.`);
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

const key = process.env["NEBIUS_API_KEY"]?.trim();
const project = process.env["NEBIUS_PROJECT_ID"]?.trim();
delete process.env["NEBIUS_API_KEY"];
delete process.env["NEBIUS_PROJECT_ID"];
if (!key || !project) {
  console.error("NEBIUS_API_KEY and NEBIUS_PROJECT_ID must both be set in your own terminal. Nothing was sent.");
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
const sandboxFor = (client: SandboxApi) =>
  new Sandbox(client, { journal: new Journal(join(folder, "journal.jsonl")), observeMarginMs: PROBE_LIMITS.observeMarginSeconds * 1000, maxTimeoutSeconds: PROBE_LIMITS.maxParentTimeoutSeconds });

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
  write(join(folder, "stage0.json"), { whoami, images });
  log(`Account: ${JSON.stringify(whoami)}`);
  const listed = Array.isArray(images) ? images : ((images as { images?: unknown[] } | null)?.images ?? []);
  const candidates = listed.filter((image) => /busybox|alpine/i.test(JSON.stringify(image)));
  log(`${listed.length} public image(s); busybox or alpine: ${candidates.map((image) => JSON.stringify(image)).join(", ") || "none"}`);
  log(`Evidence: ${folder}`);
  process.exit(0);
}

if (values.stage !== "1" || !values.image) {
  console.error("Choose --plan, --stage 0, --stage 1 --image <uuid|tag:name>, or --recover <folder>.");
  process.exit(2);
}

const client = api();
const sandbox = sandboxFor(client);
const deadline = { at: performance.now() + PROBE_LIMITS.overallMinutes * 60_000 };
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
    reconnect: () => sandboxFor(api()),
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
  const settled = await sandbox.cleanup();
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
