// The research live check (NIV-45): one research run of the demonstration plan, in process, against Tavily and Token
// Factory. Never part of `pnpm verify`. It runs only with your approval of its digest, which binds the whole recipe: the
// committed revision, which run of the recipe it is, the plan, its assumptions, the queries exactly as sent, the sites,
// Tavily's request parameters, the model, its instructions and tool, and every limit. One approval is one run: the run
// claims it atomically before anything is sent, in a folder of its own whatever --out says, and a claimed approval never
// runs again, even when its run was interrupted. Nothing is retried and no request is added; a different recipe (for
// one, search_depth "advanced" in place of Extract) is a separate choice with its own approval, never a switch made here.
//
// Usage:
//   node scripts/research-check.ts --plan                         # the request for approval; no network
//   node scripts/research-check.ts --credentials <file> --tavily-credentials <file> --approved <digest>
//   node scripts/research-check.ts --tavily-url <loopback url> --token-factory-url <loopback url> --out <dir>
//
// The Token Factory file holds a NEBIUS_API_KEY=… line and the Tavily file a TAVILY_API_KEY=… line, each outside the
// repository and readable only by you (chmod 600). Never paste a key into a chat. The keys are never printed or written.
// Evidence goes to ~/nivra-acceptance/research-check-<UTC>-<revision>/ (0700) unless --out says otherwise.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { combinedMask, maskKnownValues, queryProblems, RESEARCH_LIMITS, ResearchPacket, researchPacketDigest, ResearchReport } from "@nivra/domain";
import { z } from "zod";
import { createModelClient, ModelFailure, type Endpoint } from "../src/providers/model.ts";
import { policyFor } from "../src/providers/policy.ts";
import { pickNemotron, TOKEN_FACTORY_BASE_URL } from "../src/providers/tokenfactory.ts";
import { ResearchAnswer } from "../src/research/assess.ts";
import { RESEARCH_INSTRUCTIONS } from "../src/research/prompt.ts";
import { RESEARCH_TOOL, RESEARCH_TOOL_DESCRIPTION, runResearch, type ResearchReportShape } from "../src/research/run.ts";
import { createTavily, EXTRACT_PARAMETERS, SEARCH_PARAMETERS, TAVILY_BASE_URL } from "../src/research/tavily.ts";
import { insideRepository, REPOSITORY } from "./council-eval/files.ts";
import { claimApproval, claimOn, claimsFolder, claimText, isDigest, nextRun } from "./research-check/claim.ts";

process.env["MASTRA_TELEMETRY_DISABLED"] = "1";
// Each key is passed explicitly; none is ever read from the environment (D8).
for (const name of ["NEBIUS_API_KEY", "TAVILY_API_KEY"]) delete process.env[name];

/** The demonstration plan, which the app's demonstration seeds too: a general plan, so each query is its assumption's words. */
const PLAN_ID = "5d0c1f2a-8b3e-4c7d-9a61-2e4f6b8d0a13";
const PLAN = "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils.";
const ASSUMPTIONS = [
  { text: "distutils is still in Python 3.12's standard library", expected: "contradicted: What's New In Python 3.12 and PEP 632 say distutils was removed" },
  { text: "Python 3.12 f-strings can reuse the enclosing quotes", expected: "supported: PEP 701, in What's New In Python 3.12" },
  { text: "venv still pre-installs setuptools", expected: "contradicted: What's New In Python 3.12 says new environments no longer get setuptools (gh-95299)" },
] as const;
const SITES = { mode: "prefer" as const, hosts: ["docs.python.org", "peps.python.org"] };
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
/** One credit a basic search, and at most one an Extract: five pages at most in all, one credit per five read. */
const MAX_CREDITS = RESEARCH_LIMITS.searches + RESEARCH_LIMITS.extracts;

const packet: ResearchPacket = ResearchPacket.parse({
  scope: { kind: "general" },
  planText: PLAN,
  assumptions: ASSUMPTIONS.map((assumption, index) => ({ id: `A${index + 1}`, text: assumption.text, origin: { kind: "typed" }, query: assumption.text })),
  sites: SITES,
});
const refuse = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};

const git = (args: string[]) => spawnSync("git", args, { cwd: REPOSITORY, encoding: "utf8" });
const commit = git(["rev-parse", "HEAD"]).stdout.trim() || null;
const dirty = git(["status", "--porcelain"]).stdout.trim().length > 0;

const packetDigest = await researchPacketDigest(packet);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const forced = policyFor(MODEL).forceAnswer;
/** The approval of one run of this recipe at this revision: each run's digest is its own. */
const digestFor = (run: number) =>
  sha256(
    JSON.stringify([
      "nivra.research-check.v3",
      commit,
      run,
      PLAN_ID,
      packetDigest,
      Object.entries(RESEARCH_LIMITS),
      sha256(RESEARCH_INSTRUCTIONS),
      RESEARCH_TOOL,
      sha256(`${RESEARCH_TOOL_DESCRIPTION}\n${JSON.stringify(z.toJSONSchema(ResearchAnswer))}`),
      forced,
      TAVILY_BASE_URL,
      SEARCH_PARAMETERS,
      EXTRACT_PARAMETERS,
      TOKEN_FACTORY_BASE_URL,
      MODEL,
      MAX_CREDITS,
    ]),
  );
// The next run is the first whose approval no run has claimed.
const claims = claimsFolder();
const run = nextRun(claims, digestFor);
const approvalDigest = digestFor(run);
const before = run > 1 ? claimOn(claims, digestFor(run - 1)) : null;

const n = (value: number) => value.toLocaleString("en");
const json = (value: unknown) => JSON.stringify(value).replace(/,/g, ", ").replace(/:/g, ": ");

function approvalRequest(): string[] {
  const L = RESEARCH_LIMITS;
  return [
    "Research live check (NIV-45): the request for approval. Nothing here touches the network.",
    "",
    `Revision: ${commit ?? "unknown"}${dirty ? " (the working tree has uncommitted changes: this digest can't be approved, and the live check refuses to run, until they are committed)" : ""}`,
    `Approval digest: ${approvalDigest}`,
    `  It covers run ${run} of this recipe at this revision: the revision, the plan, its assumptions, the queries exactly as sent, the sites,`,
    "  Tavily's request parameters, the model, its instructions and tool, and every limit. A change to any of them changes it.",
    "  One approval is one run: the run claims it in ~/nivra-acceptance/claims/research-check/ before anything is sent, and a claimed",
    "  approval never runs again, whatever --out says, even when its run was interrupted. Once it is claimed, --plan prints the next run's digest.",
    ...(before?.claimed ? [`  The approval before this one was claimed by ${claimText(before.record)}.`] : []),
    "",
    `The plan, a general plan as the demonstration seeds it: "${PLAN}"`,
    "Assumptions, each searched with its own words: a general plan's query starts as its assumption's words, and nothing rewrites it.",
    ...ASSUMPTIONS.map((assumption, index) => `  A${index + 1} query "${assumption.text}"\n     expected ${assumption.expected}`),
    `Sites: prefer ${SITES.hosts.join(" and ")} (include_domains with include_domains_mode "prefer": other sites can still appear).`,
    `Packet fingerprint: ${packetDigest}`,
    "",
    `Sent to Tavily (${TAVILY_BASE_URL}), the key only in the Authorization header, never the plan's text:`,
    `  - ${L.searches} searches at most, POST /search, one an assumption, together: the query, ${json(SEARCH_PARAMETERS)}, and the sites.`,
    `  - ${L.extracts} extracts at most, POST /extract, one an assumption, together, over ${L.pageExtractions} pages at most in all, taken from each assumption's results in turn by rank:`,
    `    the addresses its own search returned, the same approved query, ${json(EXTRACT_PARAMETERS)}.`,
    `  - At most ${MAX_CREDITS} credits: ${L.searches} basic searches at 1 credit each, and at most 1 an extract (1 credit per 5 pages read). This check records`,
    "    what each extract asked for, what came back and the credits Tavily reported for it: one run's charges, not Tavily's billing policy.",
    "",
    `Sent to Token Factory (${TOKEN_FACTORY_BASE_URL}), model ${MODEL}:`,
    "  - first the model listing (GET /models, no inference): if the engine wouldn't pick that model, nothing else is sent;",
    `  - then exactly ${L.modelRequests} request, ${forced ? "a forced" : "an offered"} ${RESEARCH_TOOL} tool call holding every assessment, each naming its assumption by id, at most`,
    `    ${n(L.outputTokens)} output tokens and an estimated ${n(L.inputTokens)} input tokens at most:`,
    `    the plan's text, the assumptions and the passages read (at most ${L.passages}, ${n(L.passageChars)} characters each). None if nothing could be read.`,
    "",
    "Limits:",
    `  - one deadline, ${L.runMs / 1000} s from the start, covering the listing, searching, reading and the model;`,
    `  - searching and reading stop ${L.retrievalCutoffMs / 1000} s in; each search at most ${L.searchMs / 1000} s, each extract at most ${L.extractMs / 1000} s;`,
    `  - the model gets at most ${L.modelMs / 1000} s, and never past the deadline;`,
    `  - answers at most ${L.searchBodyBytes / 1_048_576} MiB (search) and ${L.extractBodyBytes / 1_048_576} MiB (extract); a redirect isn't followed;`,
    "  - nothing is retried: a 429, 432, 433 or 500 ends that request.",
    "",
    "Evidence, in ~/nivra-acceptance/research-check-<UTC>-<revision>/ (0700, files 0600):",
    "  - recipe.txt: this request;",
    "  - report.json: the run's report, saved before and after every request: the queries, each request's state, Tavily's request id and",
    "    credits as reported, the pages, the passages, the model's assessments and the checks of their quotations;",
    "  - check.json: the revision, the digests, the model, the outcome, credits and tokens as reported, the time, and each extract's pages.",
    "  Never a key: both files are masked as the engine's store masks. The report holds the queries, the addresses and the passages, on purpose.",
    "",
    "Stops: Ctrl-C cancels the run; requests already sent can't be withdrawn. Nothing that failed or was refused is sent again.",
    'Not part of this recipe: if Extract adds nothing over a search\'s own chunks, search_depth "advanced" with chunks_per_source 3 could be proposed',
    "(2 credits a search, no addresses sent back). It is never switched to here: it would be its own recipe, with its own approval.",
    "",
    "To run it once approved, from this revision:",
    `  node scripts/research-check.ts --credentials ~/.config/nivra/token-factory.env --tavily-credentials <file> --approved ${approvalDigest}`,
  ];
}

const write = (path: string, value: unknown) => writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

/** Every string in `value` masked, wherever it sits, so no mask can span two fields. */
function maskedDeep<T>(value: T, mask: (text: string) => string): T {
  if (typeof value === "string") return mask(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => maskedDeep(item, mask)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskedDeep(item, mask)])) as T;
  return value;
}

/** A key from a file holding a NAME=… line, outside the repository and readable by its owner only; never printed. */
function keyFrom(file: string, name: string): string {
  const path = resolve(file);
  if (insideRepository(path)) refuse(`${path} is inside the repository. Keep the credentials file outside it, then try again. Nothing was sent.`);
  let real = "";
  try {
    real = realpathSync.native(path);
  } catch {
    refuse(`${path} can't be read. Check the path, then try again. Nothing was sent.`);
  }
  const mode = statSync(real).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) refuse(`${path} can be read by others (mode ${mode.toString(8)}). Run chmod 600 on it, then try again. Nothing was sent.`);
  const key = parseEnv(readFileSync(real, "utf8"))[name]?.trim();
  return key ? key : refuse(`${path} has no ${name} line. Add one, then try again. Nothing was sent.`);
}

const { values } = parseArgs({
  options: {
    plan: { type: "boolean", default: false },
    credentials: { type: "string" },
    "tavily-credentials": { type: "string" },
    approved: { type: "string" },
    "tavily-url": { type: "string" },
    "token-factory-url": { type: "string" },
    out: { type: "string" },
  },
  allowPositionals: false,
});

if (values.plan) {
  for (const line of approvalRequest()) console.log(line);
  process.exit(0);
}

const live = values.credentials !== undefined || values["tavily-credentials"] !== undefined || values.approved !== undefined;
const stubbed = values["tavily-url"] !== undefined || values["token-factory-url"] !== undefined;
if (live === stubbed) refuse("Give --credentials, --tavily-credentials and --approved for the live check, or --tavily-url and --token-factory-url for stubs. Run --plan to see the request for approval.");
if (live) {
  if (!values.credentials || !values["tavily-credentials"] || !values.approved) refuse("The live check needs --credentials (the Token Factory key file), --tavily-credentials (the Tavily key file) and --approved (the digest --plan prints). Nothing was sent.");
  if (!isDigest(values.approved!)) refuse("--approved isn't a digest: 64 lowercase hexadecimal characters, as --plan prints them. Nothing was sent.");
  // A claimed approval is refused first, whatever else is the matter: it never runs again.
  const earlier = claimOn(claims, values.approved!);
  if (earlier.claimed) refuse(`This approval was claimed by ${claimText(earlier.record)}, so it can't run again: one approval is one run. Run --plan, and approve the digest it prints for the next run. Nothing was sent.`);
  if (values.approved !== approvalDigest) refuse(`--approved isn't this recipe's digest: the recipe changed since it was approved, or the digest was mistyped. Run --plan, and approve the digest it prints. Nothing was sent.`);
  if (!commit || dirty) refuse("The live check runs only from a committed revision with no uncommitted changes, so its evidence names exactly what ran. Commit, then run it again. Nothing was sent.");
} else {
  for (const url of [values["tavily-url"], values["token-factory-url"]]) {
    if (!url) refuse("Give both --tavily-url and --token-factory-url for stubs. Nothing was sent.");
    if (!["127.0.0.1", "[::1]", "localhost"].includes(new URL(url!).hostname)) refuse("A stub must be on this computer (127.0.0.1, [::1] or localhost). Nothing was sent.");
  }
}

const keys = live ? { model: keyFrom(values.credentials!, "NEBIUS_API_KEY"), tavily: keyFrom(values["tavily-credentials"]!, "TAVILY_API_KEY") } : { model: "stub-model-key-for-research-check", tavily: "tvly-stub-key-for-research-check" };
const knownValues = [keys.model, keys.tavily];
// The engine checks every query again before anything is sent; so does this check.
if (packet.assumptions.some((assumption) => queryProblems(assumption.query, { terms: [], paths: [] }, knownValues).length > 0)) refuse("A query didn't pass the checks, so nothing was sent.");

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out = resolve(values.out ?? join(homedir(), "nivra-acceptance", `research-check-${stamp}-${(commit ?? "unknown").slice(0, 7)}`));
if (existsSync(out) && readdirSync(out).length) refuse(`${out} already holds evidence. Choose another --out. Nothing was sent.`);
if (live) {
  // The last step before anything leaves this computer: of several launches with this approval, one claims it.
  const claimed = claimApproval(claims, { digest: approvalDigest, run, revision: commit, out, pid: process.pid, claimedAt: new Date().toISOString() });
  if (!claimed.ok) refuse(`Another run claimed this approval first (${claimText(claimed.record)}), so this one stopped before sending anything. One approval is one run: run --plan, and approve the digest it prints for the next run.`);
}
mkdirSync(out, { recursive: true, mode: 0o700 });
write(join(out, "recipe.txt"), `${approvalRequest().join("\n")}\n`);

const endpoint: Endpoint = live ? { url: TOKEN_FACTORY_BASE_URL, kind: "token-factory" } : { url: values["token-factory-url"]!, kind: "loopback-test" };
const client = createModelClient({ apiKey: keys.model, endpoint });
const controller = new AbortController();
process.once("SIGINT", () => {
  console.log("Cancelling. Requests already sent can't be withdrawn.");
  controller.abort();
});

// The run's one deadline counts from here: the listing is part of it.
const startedAt = performance.now();
const started = new Date().toISOString();
console.log(`Research check, ${live ? `live, run ${run} of this recipe` : "against stubs"}: evidence in ${out}`);
let model: string | null = null;
let contextLength: number | null = null;
try {
  const listed = await client.listModels({ signal: controller.signal, timeoutMs: 30_000 });
  model = pickNemotron(listed.ids);
  contextLength = model ? (listed.contextLengths.get(model) ?? null) : null;
} catch (error) {
  refuse(`The model listing failed (${error instanceof ModelFailure ? error.kind : "internal"}), so no search or model call was made.`, 1);
}
if (model !== MODEL) refuse(`The engine would pick ${model ?? "no NVIDIA model"}, not ${MODEL}, so no search or model call was made. A recipe for that model needs its own approval.`, 1);

const mask = combinedMask((text) =>
  maskKnownValues(text, [
    ["NEBIUS_API_KEY", keys.model],
    ["TAVILY_API_KEY", keys.tavily],
  ]),
);
const report: ResearchReportShape = await runResearch({
  binding: { planId: PLAN_ID, planVersion: 1, packetDigest, scope: packet.scope, request: { runId: randomUUID(), clientRequestId: randomUUID() } },
  packet,
  retrieval: createTavily({ apiKey: keys.tavily, ...(live ? {} : { base: values["tavily-url"]! }) }),
  client,
  model: MODEL,
  route: { provider: "nebius", endpoint: endpoint.kind, model: MODEL },
  policy: policyFor(MODEL),
  mask,
  contextLength,
  save: (snapshot) => write(join(out, "report.json"), maskedDeep(snapshot, mask)),
  progress: (message) => console.log(`  ${message}`),
  modelCall: (message) => console.log(`  ${message}`),
  signal: controller.signal,
  startedAt,
});

const parsed = ResearchReport.safeParse(report);
const extracts = report.requests.filter((request) => request.kind === "extract" && request.state !== "skipped").map((request) => ({ assumption: request.assumption, asked: request.pages, returned: request.returned, credits: request.credits }));
write(join(out, "check.json"), maskedDeep({
  mode: live ? "live" : "stub",
  revision: commit,
  dirty,
  run,
  approvalDigest,
  packetDigest,
  model: MODEL,
  started,
  outcome: report.outcome,
  stop: report.stop,
  elapsedMs: report.elapsedMs,
  requests: report.requests.map(({ id, state, failure, status, requestId, credits, pages, returned, elapsedMs }) => ({ id, state, failure, status, requestId, credits, pages, returned, elapsedMs })),
  extracts,
  credits: report.usage.credits,
  tokens: report.usage.model,
  assessments: report.assessments.map((assessment) => ({
    assumption: assessment.assumption,
    model: assessment.model,
    shown: assessment.shown,
    rule: assessment.rule,
    citations: assessment.citations.length,
    valid: assessment.citations.filter((citation) => citation.valid).length,
  })),
  checks: report.checks,
  attribution: report.attribution,
  reportFitsContract: parsed.success,
}, mask));

console.log(`Outcome: ${report.outcome}${report.stop ? ` (${report.stop.message})` : ""} in ${(report.elapsedMs / 1000).toFixed(1)} s.`);
if (report.attribution) {
  const { handedIn, matched, usable, rejected, entries, unusable } = report.attribution;
  console.log(
    `  The model handed in ${handedIn} assessments: ${matched} matched an assumption, ${usable} of them with a recognised outcome; ${rejected} set aside${rejected ? ` (${entries.map((entry) => entry.reason).join(", ")})` : ""}${unusable.length ? `; no recognised outcome for ${unusable.map((item) => item.assumption).join(", ")}` : ""}.`,
  );
}
for (const assessment of report.assessments) {
  const valid = assessment.citations.filter((citation) => citation.valid).length;
  console.log(`  ${assessment.assumption}: shown ${assessment.shown}${assessment.model !== assessment.shown ? ` (the model said ${assessment.model ?? "nothing"}; ${assessment.rule})` : ""}, ${valid} of ${assessment.citations.length} quotations found.`);
}
for (const extract of extracts) console.log(`  Extract for ${extract.assumption}: ${extract.asked} pages asked, ${extract.returned ?? "no answer"} came back, ${extract.credits ?? "credits not reported"}${extract.credits === null ? "" : " credits"}.`);
console.log(
  `Tavily credits: ${report.usage.credits ?? "not reported"}. Tokens: ${report.usage.model.inputTokens ?? "not reported"} in, ${report.usage.model.outputTokens ?? "not reported"} out. The report ${parsed.success ? "fits" : "doesn't fit"} the domain's contract.`,
);
process.exit(report.outcome === "complete" && parsed.success ? 0 : 1);
