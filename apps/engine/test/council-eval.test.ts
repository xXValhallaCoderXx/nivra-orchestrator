import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { preferencesDigest, ReviewPacket, REVIEW_TOOLS, type ReviewReport } from "@nivra/domain";
import { Journal, type JournalEntry } from "../scripts/council-eval/batch.ts";
import { EMPTY_PREFERENCES_DIGEST, FIXTURE_IDS, loadFrozen, planIdOf, readCredentials, REPOSITORY, requestFor, runOrder, type Arm, type FixtureId } from "../scripts/council-eval/files.ts";
import { defectMatches, matchedDefects } from "../scripts/council-eval/match.ts";
import { limitMismatches } from "../scripts/council-eval/plan.ts";
import { endpointFromDoctor, paidBatchRefusal, preflightProblem, samplingFor } from "../scripts/council-eval/preflight.ts";
import { armScores, buildSheet, decide, missingLabels, type ArmScores, type RunRecord, type SheetItem } from "../scripts/council-eval/score.ts";
import { isAlive, removeDir, tempDir, waitFor } from "./helpers.ts";
import { httpError, startStub, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * The council evaluation (NIV-40, D32), offline: its frozen inputs, the rubric's matching, the scoring and the decision
 * rule at every edge, the checks made before any inference request, and the batch itself on a real engine against a
 * loopback stub of Token Factory: the order, the request count, a reviewer's failure, a killed batch resumed, the
 * deadline, and a run that won't stop. Nothing here calls a real model.
 */
const CLI = fileURLToPath(new URL("../scripts/council-eval.ts", import.meta.url));
const STUCK = fileURLToPath(new URL("./fixtures/stuck-engine.mjs", import.meta.url));
const TOKEN_FACTORY_ENGINE = fileURLToPath(new URL("./fixtures/token-factory-engine.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/council-eval/", import.meta.url));
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const dirs: string[] = [];
const stubs: Stub[] = [];
after(async () => {
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});
const scratch = () => {
  const dir = tempDir("nivra council-eval ü%# ");
  dirs.push(dir);
  return dir;
};

type Role = "architecture" | "risks" | "single" | "chair";
const roleOf = (request: StubRequest): Role | null => (/Nivra review role: (architecture|risks|single|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1] as Role | undefined) ?? null;
/** Each fixture's plan is told apart by a phrase only it holds. */
const PHRASES: Record<FixtureId, string> = { f1: "users.fullname", f2: "handlePaymentWebhook", f3: "SearchLite", f4: "dates library", f5: "cache prune" };
const fixtureOf = (request: StubRequest): FixtureId | null => FIXTURE_IDS.find((id) => JSON.stringify(request.body?.messages ?? []).includes(PHRASES[id])) ?? null;
const armOfRole = (role: Role): Arm => (role === "single" ? "single" : "council");
const reviewBy = (role: string, fixture: string) =>
  toolCall(REVIEW_TOOLS.reviewer, {
    summary: `The ${role} reviewer's summary of ${fixture}.`,
    findings: [{ title: `A ${role} finding on ${fixture}`, detail: "Something the plan leaves open.", recommendation: "Say how it is handled.", severity: "low", refs: ["plan"] }],
    assumptions: [],
    gaps: [],
  });
const SYNTHESIS = toolCall(REVIEW_TOOLS.chair, { summary: "The chair's synthesis.", priorities: [], agreements: [], dissent: [], gaps: [] });
/** A stub that plays every role on every fixture; `special` changes one fixture's role. It lists `models`. */
async function stubFor(special: (fixture: FixtureId, role: Role) => Reply | null = () => null, models: string[] = [MODEL]) {
  const stub = await startStub({
    models: models.map((id) => ({ id, context_length: 131_072 })),
    chat: (request) => {
      const role = roleOf(request);
      const fixture = fixtureOf(request);
      if (!role || !fixture) return httpError(500, "not a review request");
      return special(fixture, role) ?? (role === "chair" ? SYNTHESIS : reviewBy(role, fixture));
    },
  });
  stubs.push(stub);
  return stub;
}
const requestsBy = (stub: Stub) => {
  const counts: Record<string, number> = {};
  for (const chat of stub.chats()) {
    const role = roleOf(chat);
    const key = `${fixtureOf(chat)}:${role ? armOfRole(role) : "?"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

/** Runs the evaluation's command; resolves with its exit code and output. */
function cli(args: string[], onStdout?: (text: string) => void): { done: Promise<{ code: number | null; stdout: string; stderr: string }>; kill(): void } {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    onStdout?.(stdout);
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return {
    done: new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr }))),
    kill: () => child.kill("SIGKILL"),
  };
}
const journalOf = (out: string): JournalEntry[] => new Journal(out).read();
const starts = (entries: JournalEntry[]) => entries.filter((entry): entry is Extract<JournalEntry, { type: "start" }> => entry.type === "start").map((entry) => `${entry.fixture}:${entry.arm}`);
const ORDER = runOrder().map(({ fixture, arm }) => `${fixture}:${arm}`);

describe("the council evaluation's frozen inputs (NIV-40)", () => {
  it("reads five synthetic plans, one of them the control, a rubric for them, and a protocol whose limits are the engine's", async () => {
    const frozen = await loadFrozen();
    assert.deepEqual(frozen.fixtures.map((fixture) => [fixture.id, fixture.control, fixture.packet.scope.kind, fixture.packet.references.length]), [
      ["f1", false, "general", 0],
      ["f2", false, "project", 3],
      ["f3", false, "general", 0],
      ["f4", false, "general", 0],
      ["f5", true, "general", 0],
    ]);
    for (const fixture of frozen.fixtures) assert.equal(ReviewPacket.safeParse(fixture.packet).success, true, fixture.id);
    assert.deepEqual(FIXTURE_IDS.map((id) => frozen.rubric.defects[id].length), [3, 3, 3, 3, 0]);
    assert.deepEqual(limitMismatches(frozen), []);
    assert.equal(EMPTY_PREFERENCES_DIGEST, await preferencesDigest([]));
    // Frozen: a change to any fixture, the rubric or the protocol moves this, and needs a new approval.
    assert.equal(frozen.approvalDigest, "8175cb17931dced6d3889a386ff7fa826feedb2ee4c4f33321018d1319175959");
    assert.deepEqual(ORDER, ["f1:single", "f1:council", "f2:council", "f2:single", "f3:single", "f3:council", "f4:council", "f4:single", "f5:single", "f5:council"]);
  });

  it("sends both arms the same packet for the same plan, with no preferences, no path and no repository", async () => {
    const frozen = await loadFrozen();
    for (const id of FIXTURE_IDS) {
      const [single, council] = (["single", "council"] as const).map((arm) => requestFor(frozen, id, arm, "00000000-0000-4000-8000-000000000000"));
      assert.deepEqual([single!.context, single!.input.planId, single!.input.packetDigest], [council!.context, council!.input.planId, council!.input.packetDigest]);
      assert.deepEqual([single!.input.panel, council!.input.panel, single!.context.preferences.records, single!.context.sharing.modelContext], ["single", "council", [], id === "f2"]);
      assert.match(single!.input.planId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(JSON.stringify(single).includes(REPOSITORY.slice(0, -1)), false);
    }
    assert.notEqual(planIdOf(frozen.packetDigests.f1), planIdOf(frozen.packetDigests.f2));
  });
});

describe("the rubric's automatic pass, and scoring that doesn't trust the model (NIV-40)", () => {
  it("matches every known defect's positive examples, none of its negatives, and nothing in the control's reviews", async () => {
    const { rubric } = await loadFrozen();
    const misses: string[] = [];
    for (const id of FIXTURE_IDS) {
      for (const defect of rubric.defects[id]) {
        for (const sentence of defect.positive) if (!defectMatches(sentence, defect)) misses.push(`${defect.id} misses: ${sentence}`);
        for (const sentence of defect.negative) if (defectMatches(sentence, defect)) misses.push(`${defect.id} matches a negative: ${sentence}`);
      }
    }
    const all = FIXTURE_IDS.flatMap((id) => rubric.defects[id]);
    for (const sentence of [...rubric.control.noIssues, ...rubric.control.nits]) {
      for (const defect of all) if (defectMatches(sentence, defect)) misses.push(`${defect.id} matches the control's: ${sentence}`);
    }
    assert.deepEqual(misses, []);
    // A finding's title, detail and recommendation are read together; a stem marked whole matches only the whole word.
    assert.deepEqual(matchedDefects({ title: "Old servers break", detail: "Release 40 servers query fullname after the rename.", recommendation: "Expand, then contract." }, rubric.defects.f1), ["f1-mixed-versions"]);
    assert.deepEqual(matchedDefects({ title: "Apply the patch", detail: "An approach for ISO dates.", recommendation: "" }, rubric.defects.f4), []);
  });

  /** A run's record with these reviewer findings, labelled as given. */
  const run = (fixture: FixtureId, arm: Arm, findings: Array<Partial<ReviewReport["reviewers"][number]["findings"][number]> & { role?: string }>, change: Partial<RunRecord> = {}): RunRecord => {
    const roles = arm === "single" ? ["single"] : ["architecture", "risks"];
    const reviewers = roles.map((role) => ({
      role: role as "architecture" | "risks" | "single",
      summary: `The ${role} review.`,
      findings: findings
        .filter((finding) => (finding.role ?? roles[0]) === role)
        .map((finding, index) => ({ id: `${role === "architecture" ? "arch" : role === "risks" ? "risk" : "single"}-${index + 1}`, title: "", detail: "", recommendation: "Do it.", severity: "low" as const, basis: "plan" as const, refs: ["plan"], relabelled: false, ...finding })),
      assumptions: [],
      gaps: [],
      adjusted: { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 },
    }));
    const report = { outcome: "complete", reviewers, usage: { inputTokens: 100, outputTokens: 10, calls: roles.length, reportedCalls: roles.length } } as unknown as ReviewReport;
    return { fixture, arm, clientRequestId: "c", runId: "r", status: "succeeded", failureKind: null, summary: { durationMs: arm === "single" ? 1000 : 2500 } as RunRecord["summary"], report, requests: arm === "single" ? 1 : 3, events: 0, note: null, ...change };
  };
  /** Labels every line as its automatic reading says, then applies `relabel` to the lines it names. */
  const labelled = (sheet: SheetItem[], relabel: (line: SheetItem) => Partial<SheetItem["label"]> = () => ({})) =>
    sheet.map((line) => ({
      ...line,
      label: {
        defects: line.kind === "finding" ? line.automatic.defects : null,
        novel: line.kind === "finding" && !line.automatic.defects?.length && line.fixture !== "f5" ? ("not-useful" as const) : null,
        novelKey: null,
        unsupported: line.kind === "finding" ? ("none" as const) : null,
        actionable: line.kind === "finding" ? true : null,
        material: line.fixture === "f5" && line.kind === "finding" ? line.automatic.material : null,
        substantive: line.kind === "summary" ? true : null,
        ...relabel(line),
      },
    }));

  it("counts a known defect once per fixture and arm, never counts it as novel, and gives agreement nothing", async () => {
    const frozen = await loadFrozen();
    const mixed = { title: "Old servers break mid-rollout", detail: "Servers still on release 40 query users.fullname after the rename lands.", recommendation: "Expand, then contract." };
    const records = [
      // Both council reviewers name the same defect: it counts once. A third finding names it again: still once.
      run("f1", "council", [{ ...mixed, role: "architecture" }, { ...mixed, role: "risks" }, { ...mixed, title: "The rollout breaks old servers", role: "risks" }]),
      run("f1", "single", [mixed, { title: "Back up the table first", detail: "Nothing says how to restore the data.", recommendation: "Take a backup." }]),
    ];
    const { sheet, key } = buildSheet(records, frozen);
    const novelty = labelled(sheet, (line) => (line.finding?.title === "Back up the table first" ? { novel: "useful", novelKey: "backup" } : line.finding?.title.startsWith("Old servers") ? { novel: "useful", novelKey: "would-be-double" } : {}));
    const council = armScores("council", records, novelty, key, frozen.rubric, "labelled");
    const single = armScores("single", records, novelty, key, frozen.rubric, "labelled");
    assert.deepEqual([council.knownByFixture.f1, council.known, council.usefulNovel, council.findings], [["f1-mixed-versions"], 1, 0, 3]);
    assert.deepEqual([single.knownByFixture.f1, single.known, single.usefulNovel], [["f1-mixed-versions"], 1, 1]);
    // The automatic reading can't judge novelty, U1 or U3: null, never 0.
    const automatic = armScores("single", records, novelty, key, frozen.rubric, "automatic");
    assert.deepEqual([automatic.known, automatic.usefulNovel, automatic.unsupported], [1, null, null]);
  });

  it("takes a substantive review that raises nothing material on the control as correct, never an empty or incomplete one", async () => {
    const frozen = await loadFrozen();
    const nit = { title: "Print the oldest entry", detail: "It would help.", recommendation: "Print it.", severity: "low" as const };
    const alarm = { title: "This needs a feature flag", detail: "Risky.", recommendation: "Add a flag.", severity: "high" as const };
    const cases: Array<[string, RunRecord, boolean | null]> = [
      ["a nit only", run("f5", "single", [nit]), true],
      ["a material finding", run("f5", "single", [alarm]), false],
      ["incomplete", run("f5", "single", [nit], { report: { ...run("f5", "single", [nit]).report!, outcome: "incomplete" } }), false],
      ["no report", run("f5", "single", [], { report: null, status: "failed" }), null],
    ];
    for (const [what, record, correct] of cases) {
      const { sheet, key } = buildSheet([record], frozen);
      assert.equal(armScores("single", [record], labelled(sheet), key, frozen.rubric, "labelled").controlCorrect, correct, what);
    }
    // The sheet can say a severe-sounding finding isn't material after all; then it is no false alarm.
    const record = run("f5", "single", [alarm]);
    const { sheet, key } = buildSheet([record], frozen);
    const relabelled = labelled(sheet, (line) => (line.kind === "finding" ? { material: false } : {}));
    assert.deepEqual([armScores("single", [record], relabelled, key, frozen.rubric, "labelled").falseAlarms, armScores("single", [record], relabelled, key, frozen.rubric, "automatic").falseAlarms], [0, 1]);
  });

  it("shuffles the sheet by the protocol's seed, keeps the arm off it, and won't score until every line is labelled", async () => {
    const frozen = await loadFrozen();
    const records = FIXTURE_IDS.flatMap((id) => [run(id, "single", [{ title: `Single on ${id}` }]), run(id, "council", [{ title: `Arch on ${id}`, role: "architecture" }, { title: `Risk on ${id}`, role: "risks" }])]);
    const first = buildSheet(records, frozen);
    assert.deepEqual(buildSheet(records, frozen), first, "the same seed, the same sheet");
    assert.equal(first.sheet.length, 15 + 3);
    const text = JSON.stringify(first.sheet);
    assert.deepEqual([/arch-\d|risk-\d|single-\d/.test(text), /"(council|single|architecture|risks)"/.test(text)], [false, false]);
    assert.deepEqual(new Set(Object.values(first.key).map((entry) => entry.arm)), new Set(["single", "council"]));
    assert.equal(missingLabels(first.sheet, frozen.rubric).length, first.sheet.length);
    assert.deepEqual(missingLabels(labelled(first.sheet), frozen.rubric), []);
  });

  /** Two arms' scores that clear every adopt rule, for testing one edge at a time. */
  const adoptable = (): { single: ArmScores; council: ArmScores } => {
    const base = (known: number): ArmScores => ({
      knownByFixture: { f1: [], f2: [], f3: [], f4: [], f5: [] },
      known,
      usefulNovel: 0,
      unsupported: 0,
      refsDropped: 0,
      falseAlarms: 0,
      controlCorrect: true,
      complete: 5,
      reported: [...FIXTURE_IDS],
      actionability: 0.8,
      latencyMs: { f1: 1000, f2: 1000, f3: 1000, f4: 1000, f5: 1000 },
      tokens: { f1: 100, f2: 100, f3: 100, f4: 100, f5: 100 },
      findings: 10,
    });
    const council = base(5);
    council.usefulNovel = 1;
    council.latencyMs = { f1: 3000, f2: 3000, f3: 3000, f4: 3000, f5: 3000 };
    council.tokens = { f1: 500, f2: 500, f3: 500, f4: 500, f5: 500 };
    return { single: base(3), council };
  };

  it("decides by the protocol at every edge: inconclusive, defer, adopt, otherwise simplify", async () => {
    const { protocol } = await loadFrozen();
    const outcome = (change: (scores: { single: ArmScores; council: ArmScores }) => void) => {
      const scores = adoptable();
      change(scores);
      return decide(scores.single, scores.council, protocol).decision;
    };
    assert.equal(outcome(() => undefined), "adopt", "every adopt rule exactly at its edge");
    assert.equal(outcome(({ council }) => (council.reported = ["f1", "f2", "f3"])), "inconclusive");
    assert.equal(outcome(({ council }) => (council.reported = ["f1", "f2", "f3", "f4"])), "adopt", "four fixtures from both arms are enough");
    // Defer, each rule at its edge and one step inside it.
    assert.equal(outcome(({ council }) => ((council.known = 3), (council.usefulNovel = 0))), "defer", "no more known plus novel");
    assert.equal(outcome(({ council }) => (council.unsupported = 3)), "defer");
    assert.equal(outcome(({ council }) => (council.unsupported = 2)), "simplify", "2 above isn't defer, but it is over adopt's 1");
    assert.equal(outcome(({ council }) => (council.falseAlarms = 2)), "defer");
    assert.equal(outcome(({ council }) => (council.falseAlarms = 1)), "simplify");
    assert.equal(outcome(({ council }) => (council.complete = 2)), "defer");
    assert.equal(outcome(({ council }) => (council.complete = 3)), "simplify");
    // Adopt, each rule just past its edge.
    assert.equal(outcome(({ council }) => ((council.known = 4), (council.usefulNovel = 2))), "simplify", "known only 1 above");
    assert.equal(outcome(({ council }) => (council.usefulNovel = 0)), "simplify", "known plus novel only 2 above");
    assert.equal(outcome(({ council }) => (council.unsupported = 1)), "adopt");
    assert.equal(outcome(({ council }) => (council.complete = 4)), "adopt");
    assert.equal(outcome(({ council }) => (council.latencyMs.f1 = council.latencyMs.f2 = council.latencyMs.f3 = 3010)), "simplify", "a median latency ratio of 3.01");
    assert.equal(outcome(({ council }) => (council.tokens.f1 = council.tokens.f2 = council.tokens.f3 = 501)), "simplify", "a median token ratio of 5.01");
    assert.equal(outcome(({ council }) => (council.tokens.f3 = null)), "adopt", "unknown tokens, said so");
    assert.equal(outcome(({ council }) => (council.actionability = 0.7)), "adopt", "0.10 below");
    assert.equal(outcome(({ council }) => (council.actionability = 0.69)), "simplify", "0.11 below");
    // Unknown usage stays unknown, and says so.
    const scores = adoptable();
    scores.single.tokens.f2 = null;
    const decided = decide(scores.single, scores.council, protocol);
    assert.deepEqual([decided.tokenRatio, decided.latencyRatio], ["unknown", 3]);
    assert.ok(decided.checks.some((check) => check.what.startsWith("Median token ratio: unknown (a run didn't report its tokens)")));
  });
});

describe("the batch on a real engine, against the stub (NIV-40)", () => {
  it("prints the request for approval from the code that builds the requests, touching no network", async () => {
    const { code, stdout } = await cli(["--plan"]).done;
    const frozen = await loadFrozen();
    assert.equal(code, 0);
    for (const needle of [
      `Approval digest: ${frozen.approvalDigest}`,
      "at most 20 requests, no retries and no retakes",
      "0 preferences",
      "f2 council project plan (sent with consent: synthetic)",
      `f1 ${frozen.packetDigests.f1.slice(0, 16)}`,
      "Before each run, with no inference request",
      "gives it 30 s more to settle",
      "the batch takes 52.5 minutes",
      "Labelling: not chosen yet.",
    ]) {
      assert.ok(stdout.includes(needle), needle);
    }
  });

  it("runs the ten runs in the protocol's order, one at a time, with exactly 20 requests, and keeps every one", async () => {
    const stub = await stubFor();
    const out = join(scratch(), "evidence");
    const { code, stdout, stderr } = await cli(["--token-factory-url", stub.url, "--out", out]).done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.equal(stub.chats().length, 20);
    assert.deepEqual(requestsBy(stub), { "f1:single": 1, "f1:council": 3, "f2:council": 3, "f2:single": 1, "f3:single": 1, "f3:council": 3, "f4:council": 3, "f4:single": 1, "f5:single": 1, "f5:council": 3 });
    const journal = journalOf(out);
    assert.deepEqual(starts(journal), ORDER);
    // Each request was journalled before it was sent.
    for (const entry of journal.filter((e): e is Extract<JournalEntry, { type: "run" }> => e.type === "run")) {
      assert.ok(journal.findIndex((e) => e.type === "start" && e.clientRequestId === entry.clientRequestId) < journal.indexOf(entry));
    }
    const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf8")) as { stopped: string | null; runs: Array<{ status: string; outcome: string | null }> };
    assert.deepEqual([batch.stopped, batch.runs.map((r) => `${r.status}/${r.outcome}`)], [null, Array(10).fill("succeeded/complete")]);
    assert.deepEqual(readdirSync(join(out, "runs")).length, 10);
    const sheet = JSON.parse(readFileSync(join(out, "sheet.json"), "utf8")) as SheetItem[];
    assert.equal(sheet.length, 15 + 3, "every reviewer finding, and the control's three summaries");
    // The stub's key went only to the engine, through initialize: no file of the evidence holds it.
    const holding = readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name)).includes("stub-key-for-council-eval"));
    assert.deepEqual(holding, []);
    // Which arm and reviewer each line came from is written nowhere until the sheet is scored.
    assert.deepEqual(readdirSync(out).filter((name) => name.includes("key")), []);
    // Scoring waits for every label, then decides from the sheet alone, and only from the sheet these runs made.
    const unlabelled = await cli(["--score", out]).done;
    assert.deepEqual([unlabelled.code, unlabelled.stderr.startsWith(`${sheet.length} lines of the sheet still need a label`)], [2, true]);
    const labels = sheet.map((line) => ({
      ...line,
      label: { ...line.label, defects: line.kind === "finding" ? [] : null, novel: line.kind === "finding" && line.fixture !== "f5" ? "not-useful" : null, unsupported: line.kind === "finding" ? "none" : null, actionable: line.kind === "finding" ? true : null, material: line.kind === "finding" && line.fixture === "f5" ? false : null, substantive: line.kind === "summary" ? true : null },
    }));
    writeFileSync(join(out, "sheet.json"), JSON.stringify([labels[1], labels[0], ...labels.slice(2)]));
    const moved = await cli(["--score", out]).done;
    assert.deepEqual([moved.code, moved.stderr.trim()], [2, "The sheet isn't the one these runs made: a line was added, removed, moved or changed beyond its label. Label the sheet the batch wrote, then score again."]);
    writeFileSync(join(out, "sheet.json"), JSON.stringify(labels));
    const scored = await cli(["--score", out]).done;
    assert.equal(scored.code, 0, scored.stderr);
    assert.equal(readFileSync(join(out, "decision.md"), "utf8").split("\n")[0], "# Council evaluation: defer", "neither arm found anything, so the council adds nothing");
  });

  it("keeps a reviewer's failure as it was, with its partial report, and never retakes it", async () => {
    const stub = await stubFor((fixture, role) => (fixture === "f3" && role === "risks" ? httpError(500, "the risks reviewer is down") : null));
    const out = join(scratch(), "evidence");
    const { code, stdout, stderr } = await cli(["--token-factory-url", stub.url, "--out", out]).done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.deepEqual([stub.chats().length, requestsBy(stub)["f3:council"]], [19, 2]);
    assert.deepEqual(starts(journalOf(out)), ORDER, "each run started once");
    const record = JSON.parse(readFileSync(join(out, "runs", "f3-council.json"), "utf8")) as RunRecord;
    assert.deepEqual([record.status, record.report?.outcome, record.report?.reviewers.map((r) => r.role), record.requests], ["failed", "incomplete", ["architecture"], 2]);
  });

  it("resumes a batch killed while a review was out: the run is found by its request id and never sent again", async () => {
    let hold = true;
    const stub = await stubFor((fixture, role) => (hold && fixture === "f2" && role !== "chair" && role !== "single" ? { ...reviewBy(role, fixture), delayMs: 60_000 } : null));
    const out = join(scratch(), "evidence");
    const first = cli(["--token-factory-url", stub.url, "--out", out]);
    await waitFor(() => (requestsBy(stub)["f2:council"] ?? 0) >= 2, { timeoutMs: 60_000, what: "f2's council reviewers to be asked" });
    first.kill();
    await first.done;
    const session = journalOf(out).find((entry): entry is Extract<JournalEntry, { type: "session" }> => entry.type === "session")!;
    await waitFor(() => !isAlive(session.pid), { timeoutMs: 30_000, what: "the killed batch's engine to stop" });
    hold = false;
    const { code, stdout, stderr } = await cli(["--resume", out, "--token-factory-url", stub.url]).done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    const journal = journalOf(out);
    assert.deepEqual(starts(journal), ORDER, "f2's council run was started once, and the rest after it");
    const found = journal.find((entry): entry is Extract<JournalEntry, { type: "run" }> => entry.type === "run" && entry.fixture === "f2" && entry.arm === "council" && entry.how === "found");
    assert.ok(found, "found by its request id");
    assert.deepEqual([requestsBy(stub)["f2:council"], stub.chats().length], [2, 19], "the two reviewers out when it was killed, and no chair; nothing sent again");
    const record = JSON.parse(readFileSync(join(out, "runs", "f2-council.json"), "utf8")) as RunRecord;
    assert.ok(record.status === "cancelled" || record.status === "failed", record.status);
  });

  it("cancels a run still going at its deadline, keeps it, and goes on", async () => {
    const stub = await stubFor((_fixture, role) => (role === "single" ? { ...reviewBy(role, "f1"), delayMs: 60_000 } : null));
    const out = join(scratch(), "evidence");
    const { code, stdout, stderr } = await cli(["--token-factory-url", stub.url, "--out", out, "--only", "f1", "--deadline-ms", "1500"]).done;
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    const journal = journalOf(out);
    assert.deepEqual([starts(journal), journal.filter((entry) => entry.type === "cancel").map((entry) => (entry as { fixture: string; arm: string }).fixture + ":" + (entry as { arm: string }).arm)], [["f1:single", "f1:council"], ["f1:single"]]);
    const record = JSON.parse(readFileSync(join(out, "runs", "f1-single.json"), "utf8")) as RunRecord;
    assert.deepEqual([record.status, stub.chats().length], ["cancelled", 4]);
    // A run that couldn't end within the batch's 60 minutes, windows included, isn't started.
    const capped = join(scratch(), "evidence");
    const stopped = await cli(["--token-factory-url", stub.url, "--out", capped, "--only", "f1", "--deadline-ms", "3570001"]).done;
    assert.deepEqual(
      [stopped.code, stopped.stderr.trim(), starts(journalOf(capped)), stub.chats().length],
      [3, "The next run, with its windows to cancel and to settle, could not end within the batch's 60 minutes, so the batch stopped.", [], 4],
    );
  });

  it("refuses a paid batch that isn't approved, isn't labelled, isn't committed, or whose key file is inside the repository or readable by others, before anything starts", async () => {
    const dir = scratch();
    const file = join(dir, "token-factory.env");
    writeFileSync(file, "NEBIUS_API_KEY=not-a-real-key\n", { mode: 0o600 });
    // Through the command, only refusals that come before anything could start: a test never reaches a paid batch.
    const wrong = await cli(["--credentials", file, "--approved", "0".repeat(64), "--out", join(dir, "out")]).done;
    assert.deepEqual([wrong.code, wrong.stderr.startsWith("The approved digest isn't this protocol's"), existsSync(join(dir, "out"))], [2, true, false]);
    const frozen = await loadFrozen();
    const TESTS_ONLY = "--only, --deadline-ms, --reconcile-ms, --engine and --fixtures are for tests against a stub, never for the paid batch.";
    for (const option of [["--only", "f1"], ["--deadline-ms", "1"], ["--reconcile-ms", "1"], ["--engine", STUCK], ["--fixtures", FIXTURES]]) {
      const tests = await cli(["--credentials", file, "--approved", frozen.approvalDigest, "--out", join(dir, "out"), ...option]).done;
      assert.deepEqual([option[0], tests.code, tests.stderr.trim()], [option[0], 2, TESTS_ONLY]);
    }
    assert.equal(existsSync(join(dir, "out")), false);
    // The rest, as the command checks them in order, whoever the protocol file names as the labeller.
    const labelled = { ...frozen, protocol: { ...frozen.protocol, labelling: "nate" as const } };
    const clean = { approved: frozen.approvalDigest, commit: "1".repeat(40), dirty: false, testOptions: false };
    assert.equal(paidBatchRefusal(labelled, clean), null);
    assert.equal(paidBatchRefusal(labelled, { ...clean, dirty: true }), "The working tree has uncommitted changes, so the revision this batch runs wouldn't be exact. Commit them, then run it again. Nothing was sent.");
    assert.equal(paidBatchRefusal(labelled, { ...clean, commit: null }), "The working tree has uncommitted changes, so the revision this batch runs wouldn't be exact. Commit them, then run it again. Nothing was sent.");
    const pending = { ...frozen, protocol: { ...frozen.protocol, labelling: "pending" as const } };
    assert.equal(paidBatchRefusal(pending, clean), "The protocol doesn't say who labels the sheet yet. Choose it in protocol.json, then approve the new digest --plan shows.");
    // The file itself: outside the repository, the owner's alone, with a key in it. The key is never in a message.
    assert.equal(readCredentials(file), "not-a-real-key");
    chmodSync(file, 0o644);
    assert.throws(() => readCredentials(file), (error: Error) => error.message.endsWith("can be read by others (mode 644). Run chmod 600 on it, then try again. Nothing was sent.") && !error.message.includes("not-a-real-key"));
    const inside = join(REPOSITORY, "apps", "engine", "test", "fixtures", "council-eval", "protocol.json");
    assert.throws(() => readCredentials(inside), /is inside the repository/);
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "empty", "token-factory.env"), "OTHER=1\n", { mode: 0o600 });
    assert.throws(() => readCredentials(join(dir, "empty", "token-factory.env")), /has no NEBIUS_API_KEY line/);
  });
});

describe("before any inference request, and a run that won't stop (NIV-40)", () => {
  it("checks the engine's endpoint, the model it would pick and that model's sampling against the protocol, with the engine's own code", async () => {
    const frozen = await loadFrozen();
    for (const arm of ["single", "council"] as const) {
      assert.deepEqual(samplingFor(frozen.protocol.model, arm), frozen.protocol.sampling, arm);
      assert.equal(preflightProblem({ endpoint: "token-factory", model: frozen.protocol.model, arm }, frozen, "live"), null);
      assert.equal(preflightProblem({ endpoint: "loopback-test", model: frozen.protocol.model, arm }, frozen, "stub"), null);
    }
    const doctor = (status: "ok" | "warn" | "fail") => ({ checks: [{ id: "models", status, title: "Model endpoint", detail: "", fix: null }] });
    assert.deepEqual([endpointFromDoctor(doctor("ok")), endpointFromDoctor(doctor("warn")), endpointFromDoctor(doctor("fail")), endpointFromDoctor({ checks: [] })], ["token-factory", "loopback-test", null, null]);
    const seen = { endpoint: "token-factory" as const, model: frozen.protocol.model, arm: "council" as const };
    assert.deepEqual(
      [
        preflightProblem({ ...seen, endpoint: "loopback-test" }, frozen, "live"),
        preflightProblem(seen, frozen, "stub"),
        preflightProblem({ ...seen, endpoint: null }, frozen, "live"),
        preflightProblem({ ...seen, model: "nvidia/Nemotron-3_5-Lightning" }, frozen, "live"),
        preflightProblem({ ...seen, model: null }, frozen, "live"),
        preflightProblem(seen, { ...frozen, protocol: { ...frozen.protocol, sampling: { ...frozen.protocol.sampling, toolChoice: "auto" } } }, "live"),
      ],
      [
        "The engine would send its requests to a test endpoint, not Token Factory, so nothing was sent.",
        "The engine would send its requests to Token Factory, but this batch is against a stub, so nothing was sent.",
        "The engine didn't say where it sends its requests, so nothing was sent.",
        "The model listing would give these reviews nvidia/Nemotron-3_5-Lightning, not nvidia/nemotron-3-super-120b-a12b, so nothing was sent.",
        "The model listing would give these reviews no NVIDIA model, not nvidia/nemotron-3-super-120b-a12b, so nothing was sent.",
        "nvidia/nemotron-3-super-120b-a12b would be sent with forced tool choice, at most 4,000 output tokens, not the protocol's auto tool choice, at most 4,000 output tokens, so nothing was sent.",
      ],
    );
  });

  /** Runs a stub batch that the checks before any inference request must refuse; resolves with what it said. */
  async function refusedBefore(stub: Stub, args: string[], out = join(scratch(), "evidence")) {
    const { code, stdout, stderr } = await cli(["--token-factory-url", stub.url, "--out", out, ...args]).done;
    return { code, stdout, message: stderr.trim(), journal: journalOf(out), out };
  }

  it("refuses another model, another sampling, or another endpoint before any inference request: not one is made", async () => {
    // The listing gives another model: the engine would pick it, so nothing starts.
    const lightning = await stubFor(() => null, ["nvidia/Nemotron-3_5-Lightning"]);
    const model = await refusedBefore(lightning, []);
    assert.deepEqual([model.code, model.message, lightning.chats().length, starts(model.journal)], [3, "The model listing would give these reviews nvidia/Nemotron-3_5-Lightning, not nvidia/nemotron-3-super-120b-a12b, so nothing was sent.", 0, []]);
    assert.ok(lightning.requests.some((request) => request.method === "GET" && request.path.endsWith("/models")), "the listing was read");
    assert.equal(model.journal.at(-1)?.type, "stop");
    // A protocol whose sampling isn't what the engine gives the model.
    const changed = join(scratch(), "fixtures");
    cpSync(FIXTURES, changed, { recursive: true });
    const protocol = JSON.parse(readFileSync(join(changed, "protocol.json"), "utf8")) as { sampling: { toolChoice: string } };
    protocol.sampling.toolChoice = "auto";
    writeFileSync(join(changed, "protocol.json"), JSON.stringify(protocol));
    const stub = await stubFor();
    const sampling = await refusedBefore(stub, ["--fixtures", changed]);
    assert.deepEqual([sampling.code, sampling.message.startsWith("nvidia/nemotron-3-super-120b-a12b would be sent with forced tool choice"), starts(sampling.journal)], [3, true, []]);
    // An engine whose doctor says it would send its requests to Token Factory, in a batch against a stub.
    const route = await refusedBefore(stub, ["--engine", TOKEN_FACTORY_ENGINE]);
    assert.deepEqual([route.code, route.message, starts(route.journal)], [3, "The engine would send its requests to Token Factory, but this batch is against a stub, so nothing was sent.", []]);
    assert.deepEqual(readFileSync(join(route.out, "engine home", "calls.log"), "utf8").split("\n").filter(Boolean), ["initialize", "doctor", "shutdown"]);
    assert.equal(stub.chats().length, 0, "not one inference request");
  });

  it("stops within its bound when a run keeps running after it was cancelled, keeps it as unresolved, and never sends it again", async () => {
    const stub = await stubFor();
    const out = join(scratch(), "evidence");
    const started = performance.now();
    const { code, stderr } = await cli(["--token-factory-url", stub.url, "--out", out, "--engine", STUCK, "--only", "f1", "--deadline-ms", "1000", "--reconcile-ms", "1000"]).done;
    const tookMs = performance.now() - started;
    const note = "The f1 single run was still going 1 s after it was cancelled, so it is kept as unresolved, and the batch stopped. It is never sent again.";
    assert.deepEqual([code, stderr.trim()], [3, note]);
    assert.ok(tookMs < 20_000, `the batch took ${Math.round(tookMs)} ms`);
    const journal = journalOf(out);
    assert.deepEqual(journal.map((entry) => entry.type), ["session", "start", "run", "cancel", "end", "stop"]);
    const cancelled = Date.parse(journal[3]!.at);
    const end = journal[4] as Extract<JournalEntry, { type: "end" }>;
    assert.deepEqual([end.status, end.requests, end.note], ["unknown", null, note]);
    assert.ok(Date.parse(end.at) - cancelled < 5_000, "kept as unresolved within its window to settle, and the time to say so");
    const record = JSON.parse(readFileSync(join(out, "runs", "f1-single.json"), "utf8")) as RunRecord;
    assert.deepEqual([record.status, record.note, record.summary?.status], ["unknown", note, "running"]);
    // Resumed, it is never sent again: the batch stays stopped.
    const resumed = await cli(["--resume", out, "--token-factory-url", stub.url, "--engine", STUCK, "--only", "f1", "--deadline-ms", "1000", "--reconcile-ms", "1000"]).done;
    assert.deepEqual([resumed.code, resumed.stderr.trim(), starts(journalOf(out))], [3, note, ["f1:single"]]);
    assert.equal(readFileSync(join(out, "engine home", "calls.log"), "utf8").split("\n").filter((call) => call === "runs.start").length, 1);
    assert.equal(stub.chats().length, 0);
  });
});
