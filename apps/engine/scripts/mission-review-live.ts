// The mission review's live check (NIV-52): one council review of a public, synthetic mission and three of its tasks,
// through a real engine and real Token Factory, with the one model the recipe names. Never part of `pnpm verify`. It
// runs only with Nate's approval of the recipe's digest, which binds the run, the revision, the fixture, the profiles,
// their instructions and the forms they hand in, the model and the limits, and only from a clean checkout. One approval
// is one run: the first launch that presents it claims it, atomically, in ~/nivra-acceptance/claims/mission-review/
// whatever --out or --home says, before anything else is checked or read, and the claim is never removed. A claimed
// approval never runs again, even when its launch stopped early; the next run needs the next digest --plan prints.
//
// Usage:
//   node scripts/mission-review-live.ts --plan                                         # the recipe for approval; no network
//   node scripts/mission-review-live.ts --credentials <file> --approved <digest>       # the live run: at most 3 requests
//   node scripts/mission-review-live.ts --token-factory-url <loopback url> --out <dir> # the same against a stub (tests)
//
// The credentials file holds a NEBIUS_API_KEY=… line, outside the repository, readable only by you (chmod 600). The key
// reaches the engine only through `initialize`, and is never printed or written. The engine's home is a fresh folder
// under ~/.nivra-dev-niv52, never ~/.nivra or ~/.nivra-dev. Evidence goes to ~/nivra-acceptance/mission-review-<UTC>-<rev>/
// (0700) unless --out says otherwise.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { isTerminal, MISSION_COUNCIL, MissionReviewPacket, missionPacketDigest, preferencesDigest, renderMissionPacket, SPECIALISTS, type ReviewReport, type RunSummary } from "@nivra/domain";
import { ANSWER_TOKENS } from "../src/providers/policy.ts";
import { MISSION_INSTRUCTIONS } from "../src/review/mission-prompt.ts";
import { missionToolDefinitions, REVIEW_LIMITS, REVIEW_REQUEST_MS } from "../src/review/run.ts";
import { startEngine } from "./council-eval/batch.ts";
import { canonical, readCredentials, REPOSITORY } from "./council-eval/files.ts";
import { claimApproval, claimOn, claimText, isDigest, nextRun } from "./research-check/claim.ts";

/** The one model the live run may use: the engine refuses any other before the first inference request. */
export const LIVE_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const FIXTURE = join(REPOSITORY, "apps/engine/test/fixtures/mission-review/live.json");
/** How long the run may take, as the engine bounds it, and the margin to see its end. */
const FOLLOW_MS = REVIEW_LIMITS.council.totalMs + 30_000;
/** Where this check's approvals are claimed: one folder for every run, apart from any run's evidence and engine home. */
const CLAIMS = join(homedir(), "nivra-acceptance", "claims", "mission-review");

const { values } = parseArgs({
  options: {
    plan: { type: "boolean", default: false },
    credentials: { type: "string" },
    approved: { type: "string" },
    "token-factory-url": { type: "string" },
    out: { type: "string" },
    fixture: { type: "string" },
    home: { type: "string" },
  },
  allowPositionals: false,
});

const refuse = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
const write = (path: string, value: unknown) => writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const git = (args: string[]) => spawnSync("git", args, { cwd: REPOSITORY, encoding: "utf8" });

const fixturePath = resolve(values.fixture ?? FIXTURE);
const raw = readFileSync(fixturePath);
const parsed = MissionReviewPacket.safeParse(JSON.parse(raw.toString("utf8")));
if (!parsed.success) refuse(`The fixture ${fixturePath} isn't a mission review's packet as this build reads one. Nothing was sent.`);
const packet = parsed.data!;
if (packet.model !== LIVE_MODEL) refuse(`The fixture names ${packet.model ?? "no model"}, and the live check takes only ${LIVE_MODEL}. Nothing was sent.`);

const commit = git(["rev-parse", "HEAD"]).stdout.trim() || null;
const dirty = git(["status", "--porcelain"]).stdout.trim().length > 0;
const packetDigest = await missionPacketDigest(packet);
/** The recipe for one run of this check at this revision: the first, the second, ... Each run is approved on its own. */
const recipeFor = (run: number) => ({
  check: "nivra.mission-review-live.v2",
  run,
  revision: commit,
  fixture: { path: relative(REPOSITORY, fixturePath), sha256: sha256(raw), packetDigest, chars: renderMissionPacket(packet).length, tasks: packet.tasks.length },
  profiles: MISSION_COUNCIL.map((id) => ({ id, version: SPECIALISTS[id].version, instructionsSha256: sha256(MISSION_INSTRUCTIONS[id]) })),
  /** The forms the stages hand in: the tools' definitions as the model reads them. */
  toolsSha256: sha256(missionToolDefinitions()),
  model: LIVE_MODEL,
  limits: {
    requests: REVIEW_LIMITS.council.requests,
    runMs: REVIEW_LIMITS.council.totalMs,
    requestMs: REVIEW_REQUEST_MS,
    outputTokensPerRequest: ANSWER_TOKENS,
    estimatedInputTokens: REVIEW_LIMITS.council.estimatedInputTokens,
  },
  endpoint: "Nebius Token Factory, the engine's default endpoint",
  preferences: "none",
  evidence: "~/nivra-acceptance/mission-review-UTC-REV7 (0700): the engine's masked report, the run's events by count, usage and the served model of each request",
  claims: "~/nivra-acceptance/claims/mission-review/, one file per approval, kept",
});
const digestFor = (run: number) => sha256(canonical(recipeFor(run)));
// The next run is the first whose approval no launch has claimed.
const run = nextRun(CLAIMS, digestFor);
const recipe = recipeFor(run);
const digest = digestFor(run);
const before = run > 1 ? claimOn(CLAIMS, digestFor(run - 1)) : null;

if (values.plan) {
  console.log("The mission review's live check (NIV-52): one council review, for Nate's approval.");
  console.log(`- Revision: ${commit ?? "unknown"}${dirty ? " (the checkout has changes: a live run is refused until it is clean)" : ""}.`);
  console.log(`- What is sent: ${recipe.fixture.path} (sha256 ${recipe.fixture.sha256.slice(0, 12)}), a public, synthetic mission and ${packet.tasks.length} tasks; ${recipe.fixture.chars.toLocaleString("en")} characters; packet ${packetDigest.slice(0, 12)}. No preferences, no repository.`);
  for (const profile of recipe.profiles) console.log(`- ${SPECIALISTS[profile.id].name} v${profile.version}, instructions ${profile.instructionsSha256.slice(0, 12)}.`);
  console.log(`- The forms they hand in (the tools' definitions): ${recipe.toolsSha256.slice(0, 12)}.`);
  console.log(`- Model: ${LIVE_MODEL} only. The engine refuses any other before the first inference request; a served model that differs fails the evidence.`);
  console.log(
    `- Bounds: at most ${recipe.limits.requests} requests (two reviewers, then the chair), ${recipe.limits.outputTokensPerRequest.toLocaleString("en")} output tokens each, ${recipe.limits.requestMs / 1000} s each and ${recipe.limits.runMs / 1000} s in all; an estimated input budget of ${recipe.limits.estimatedInputTokens.toLocaleString("en")} tokens, which is no ceiling. Nothing is retried.`,
  );
  console.log(`- Where: ${recipe.endpoint}, from a fresh engine home under ~/.nivra-dev-niv52.`);
  console.log(`- Evidence: ${recipe.evidence}.`);
  console.log(
    `- One approval is one run. This one covers run ${run} of this recipe at this revision. The first launch that presents it claims it in ~/nivra-acceptance/claims/mission-review/ before anything else is checked or read, whatever --out or --home says, and nothing runs under it again, even if that launch stops early.`,
  );
  if (before?.claimed) console.log(`- The approval before this one was claimed by ${claimText(before.record)}.`);
  console.log(`- Approval digest: ${digest}`);
  console.log(`Run it with: node apps/engine/scripts/mission-review-live.ts --credentials ~/.config/nivra/token-factory.env --approved ${digest}`);
  process.exit(0);
}

const live = values.credentials !== undefined;
if (live === (values["token-factory-url"] !== undefined)) refuse("Give either --credentials and --approved for the live run, or --token-factory-url for a stub. Run --plan to see the recipe for approval.");
if (live) {
  // One approval is one run: a claimed one never runs again, whatever --out or --home says.
  const presented = values.approved ?? "";
  const earlier = isDigest(presented) ? claimOn(CLAIMS, presented) : { claimed: false as const };
  if (earlier.claimed) refuse(`This approval was claimed by ${claimText(earlier.record)}, so it can't run again: one approval is one run. Nothing was sent. Run --plan, and ask for approval of the digest it prints for the next run.`);
  if (presented !== digest) refuse(`This recipe's digest is ${digest}, not the one approved (${values.approved ?? "none given"}). Nothing was sent. Run --plan, and ask for approval of what it prints.`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "").replace(/-/g, "");
const out = resolve(values.out ?? join(homedir(), "nivra-acceptance", `mission-review-${stamp}-${(commit ?? "unknown").slice(0, 7)}`));
const home = resolve(values.home ?? join(homedir(), ".nivra-dev-niv52", `live-${stamp}`));
/** Whether `path` is `folder` or inside it, by `relative()`, never by its text. */
const within = (path: string, folder: string) => {
  const rest = relative(folder, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};
for (const forbidden of [join(homedir(), ".nivra"), join(homedir(), ".nivra-dev")]) {
  if (within(home, forbidden)) refuse(`${home} is in ${forbidden}, an engine home this check must never use. Nothing was sent.`);
}
if (live && !within(home, join(homedir(), ".nivra-dev-niv52"))) refuse(`A live run's engine home is a folder under ~/.nivra-dev-niv52, and ${home} isn't one. Nothing was sent.`);
if (existsSync(out) && readdirSync(out).length) refuse(`${out} already holds evidence. Choose another --out. Nothing was sent.`);
/** A refusal after the claim: the approval stays used, so the words say how to go on. */
const used = (message: string): never => refuse(`${message} This approval is now used: run --plan, and ask for approval of the digest it prints for the next run.`);
if (live) {
  // Claimed before anything else is checked or read: of several launches presenting this approval, exactly one claims
  // it, and the claim is kept whatever happens next, so a retry always needs the next run's approval.
  const claimed = claimApproval(CLAIMS, { digest, run, revision: commit, out, pid: process.pid, claimedAt: new Date().toISOString() });
  if (!claimed.ok) refuse(`Another launch claimed this approval first (${claimText(claimed.record)}), so this one stopped before sending anything. One approval is one run: run --plan, and ask for approval of the digest it prints for the next run.`);
  if (dirty) used("The checkout has changes, so this isn't the approved revision's code. Nothing was sent.");
}
const apiKey = live ? (() => {
  try {
    return readCredentials(values.credentials!);
  } catch (error) {
    return used(error instanceof Error ? error.message : String(error));
  }
})() : "stub-key-0123456789";

mkdirSync(out, { recursive: true, mode: 0o700 });
write(join(out, "recipe.json"), { ...recipe, digest, mode: live ? "live" : "stub" });

const engine = await startEngine(home, { tokenFactoryUrl: live ? null : values["token-factory-url"]!, apiKey, logPath: join(out, "engine.log") });
const clientRequestId = randomUUID();
const preferences = { revision: 0, records: [] };
let summary: RunSummary | null = null;
let report: ReviewReport | null = null;
let unresolved: string | null = null;
const started = performance.now();
try {
  summary = await engine.client.call("runs.start", {
    clientRequestId,
    workflowId: "review",
    input: { panel: "council", planId: randomUUID(), planVersion: 1, packetDigest, preferencesDigest: await preferencesDigest(preferences.records) },
    context: { preferences, sharing: { modelContext: false }, packet },
  });
  while (!isTerminal(summary.status) && performance.now() - started < FOLLOW_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    summary = await engine.client.call("runs.get", { runId: summary.id });
  }
  if (!isTerminal(summary.status)) {
    unresolved = `The run didn't end within ${FOLLOW_MS / 1000} s, so it was cancelled.`;
    await engine.client.call("runs.cancel", { runId: summary.id }).catch(() => undefined);
  }
  report = await engine.client.call("runs.review", { runId: summary.id }).catch(() => null);
} finally {
  await engine.close();
}

const served = (report?.stages ?? []).filter((stage) => stage.requests > 0).map((stage) => ({ role: stage.role, servedModel: stage.servedModel }));
const wrongModel = served.filter((stage) => stage.servedModel !== null && stage.servedModel !== LIVE_MODEL);
const unnamed = served.filter((stage) => stage.servedModel === null);
// Held only when every answer named the approved model: one that named none shows nothing either way (unknown, null).
const modelHeld = wrongModel.length > 0 ? false : served.length > 0 && unnamed.length === 0 ? true : null;
const result = {
  digest,
  run,
  mode: live ? "live" : "stub",
  runId: summary?.id ?? null,
  status: summary?.status ?? null,
  error: summary?.error ?? null,
  unresolved,
  outcome: report?.outcome ?? null,
  findings: (report?.reviewers ?? []).map((reviewer) => ({ role: reviewer.role, findings: reviewer.findings.length, refs: reviewer.findings.map((finding) => finding.refs), adjusted: reviewer.adjusted })),
  synthesis: report?.synthesis ? { priorities: report.synthesis.priorities, agreements: report.synthesis.agreements.length, dissent: report.synthesis.dissent.length, unaddressed: report.synthesis.unaddressed } : null,
  usage: report?.usage ?? null,
  route: report?.route ?? null,
  served,
  modelHeld,
  elapsedMs: Math.round(performance.now() - started),
};
if (report) write(join(out, "report.json"), report);
write(join(out, "result.json"), result);
console.log(
  `${result.mode === "live" ? "Live" : "Stub"} mission review ${result.runId ?? "(not started)"}: ${result.status ?? "unknown"}, outcome ${result.outcome ?? "none"}; ${served.length} requests answered by ${[...new Set(served.map((stage) => stage.servedModel ?? "unknown"))].join(", ") || "none"}.`,
);
if (wrongModel.length) console.log(`A request was served by a model other than ${LIVE_MODEL}: this run isn't the approved check.`);
else if (unnamed.length) console.log(`${unnamed.length} of ${served.length} answers didn't name the model that served them, so this run doesn't show ${LIVE_MODEL} held.`);
console.log(`Evidence: ${out}`);
process.exit(result.status === "succeeded" && result.outcome === "complete" && result.modelHeld === true ? 0 : 1);
