import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECKS,
  CRITERIA,
  criteriaOutcomes,
  expectedReason,
  findLeaks,
  publicFiles,
  publicSummary,
  sessionVerdict,
  type AcceptanceRecord,
  type CheckEntry,
  type Criterion,
  type PrivateIdentifiers,
  type RunEntry,
} from "../scripts/acceptance-record.ts";

/** B's identifiers, as canaries: none may reach anything public. */
const B: PrivateIdentifiers = {
  paths: ["/home/odin/Dungeon/Private/canary-repo-b", "\\\\wsl.localhost\\Ubuntu\\home\\odin\\Dungeon\\Private\\canary-repo-b"],
  label: "canary-repo-b",
  name: "canary-repo-b",
  remote: "git@github.com:someone/canary-repo-b.git",
  head: "b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9",
};

const check = (id: CheckEntry["id"], outcome: CheckEntry["outcome"], fixture: CheckEntry["fixture"] = "A", attempt = 1, scenario?: CheckEntry["scenario"]): CheckEntry => ({
  id,
  outcome,
  attempt,
  fixture,
  ...(scenario ? { scenario } : {}),
  at: 1,
  detail: `checked at ${B.paths[0]} on ${B.label}, HEAD ${B.head}: "B names its components in kebab-case"`,
});

const run = (fixture: RunEntry["fixture"], extra: Partial<RunEntry> = {}): RunEntry => ({
  runId: "7f3e9c1a-0000-4000-8000-000000000001",
  fixture,
  purpose: "explain",
  attempt: 1,
  status: "succeeded",
  failureKind: null,
  model: "nvidia/nemotron-3-super-120b-a12b",
  endpoint: "token-factory",
  durationMs: 60_000,
  usage: { inputTokens: 50_000, outputTokens: 1_500, calls: 8, reportedCalls: 8 },
  citations: { total: 8, checked: 8 },
  conflicts: { repository: 1 },
  suggestions: 2,
  refusals: { citations: 1, conflicts: 0, schema: 0 },
  preferences: { count: 1, revision: 3 },
  ...extra,
});

function record(): AcceptanceRecord {
  return {
    platform: "linux",
    session: "live",
    startedAt: "2026-10-18T10:00:00.000Z",
    build: { version: "0.1.0", commit: "97fa0b6d71cc8aca522b47452be42d2fb11f7d62", clean: true, artefacts: [{ name: "Nivra-0.1.0-amd64.deb", sha256: "a".repeat(64) }], runtimes: [{ target: "linux-x64", contentHash: "f0f3baa2aafb1925" }] },
    harness: { commit: "c690f842657c0706310fbc0d6b755994f00cd81f", clean: true },
    machine: { distro: "Ubuntu 24.04.3 LTS", kernel: "6.18.33.1-microsoft-standard-WSL2", privateFolder: B.paths[0]! } as Record<string, string>,
    fixtures: {
      A: { name: "valhalla-fitness", head: "29c3a40a".padEnd(40, "0"), dirty: 3, tracked: 1268, conventions: { pascalTsx: 423, kebabTsx: 0, vitest: true, jest: false } },
      B: { name: B.name, head: B.head, dirty: 0, tracked: 730, conventions: { pascalTsx: 0, kebabTsx: 86, vitest: false, jest: true } },
    },
    checks: [check("a.checked-citations", "pass"), check("b.repository-governs", "pass", "B"), check("b.isolation", "pass", "B")],
    runs: [run("A"), { ...run("B"), statement: "B's convention is kebab-case", topic: B.label } as RunEntry],
    commands: ["pnpm accept:live --platform linux --fixture-a ~/Dungeon/Personal/valhalla-fitness --fixture-b-file <private>"],
  };
}

describe("the acceptance record and its public summary (NIV-14)", () => {
  it("publishes only listed fields: of B, only numbers, booleans and fixed values", () => {
    const { json, markdown } = publicFiles(record(), B);
    assert.deepEqual(findLeaks(`${json}\n${markdown}`, B), []);
    for (const canary of ["canary-repo-b", "kebab-case\"", "Private", "privateFolder", "statement", "topic", B.head.slice(0, 7), "7f3e9c1a"]) {
      assert.equal(json.includes(canary) || markdown.includes(canary), false, `${canary} isn't published`);
    }
    const summary = publicSummary(record());
    assert.deepEqual(summary.fixtures.B, { dirty: 0, tracked: 730, conventions: { pascalTsx: 0, kebabTsx: 86, vitest: false, jest: true } });
    assert.deepEqual(Object.keys(summary.machine), ["distro", "kernel"]);
  });

  it("refuses to publish anything when one of B's identifiers slips into an allowed field", () => {
    for (const smuggle of [
      (r: AcceptanceRecord) => (r.machine["distro"] = `Ubuntu, with ${B.label}`),
      (r: AcceptanceRecord) => r.commands.push(`pnpm accept:live --fixture-a ${B.paths[0]}`),
      (r: AcceptanceRecord) => (r.fixtures.A!.name = B.name),
      (r: AcceptanceRecord) => (r.build!.commit = B.head),
    ]) {
      const leaky = record();
      smuggle(leaky);
      assert.throws(() => publicFiles(leaky, B), (error: unknown) => error instanceof Error && /nothing public was written/.test(error.message) && !error.message.includes(B.label));
    }
  });

  it("looks for B's paths with either slash and JSON-escaped, and its label only as a word", () => {
    assert.deepEqual(findLeaks(JSON.stringify({ at: B.paths[1] }), B), ["label", "name", "path"], "the UNC path, JSON-escaped, ends in B's name");
    assert.deepEqual(findLeaks("C:/x and /home/odin/Dungeon/Private/canary-repo-b/src", B), ["label", "name", "path"]);
    assert.deepEqual(findLeaks("the canary-repo-bx module", B), [], "a longer word isn't the label");
    assert.deepEqual(findLeaks("app.asar", { ...B, label: "app", name: "app" }), [], "short labels are left to the allowlist");
    assert.deepEqual(findLeaks(`HEAD ${B.head.slice(0, 12)}`, B), ["head"]);
  });

  it("gates each criterion: a strict failure fails it, a demonstration still missing leaves it incomplete, and retries are kept", () => {
    const checks: CheckEntry[] = [
      // Not observed, then observed on the targeted retry: a pass, with both attempts kept.
      check("a.checked-citations", "incomplete", "A", 1),
      check("a.checked-citations", "pass", "A", 2),
      check("a.explain", "pass"),
      // Still missing after the retry: incomplete, never a pass.
      check("b.repository-governs", "incomplete", "B", 1),
      check("b.repository-governs", "incomplete", "B", 2),
      check("b.isolation", "pass", "B"),
      check("choice.store-unchanged", "fail", "B"),
      check("choice.governs", "pass", "B"),
      // Optional wording never changes the outcome.
      check("life.edit", "pass", "B"),
      check("life.wording", "incomplete", "B"),
    ];
    const outcomes = criteriaOutcomes(checks);
    assert.deepEqual(
      [outcomes["evidence-a"], outcomes["contrast-b"], outcomes["task-choice"], outcomes.lifecycle, outcomes.freshness],
      ["pass", "incomplete", "fail", "pass", "not-run"],
    );
    const summary = publicSummary({ ...record(), checks, runs: [run("A"), run("A", { attempt: 2, status: "failed", failureKind: "rate-limit", usage: { inputTokens: 9_000, outputTokens: 0, calls: 1, reportedCalls: 1 } })] });
    assert.deepEqual(summary.criteria.find((c) => c.criterion === "evidence-a"), { criterion: "evidence-a", outcome: "pass", checks: 2, attempts: 3 });
    assert.deepEqual([summary.totals.attempts, summary.totals.inputTokens, summary.totals.calls], [2, 59_000, 9], "a failed attempt still counts");
  });

  it("keeps each scenario's checks apart, so a pass in one never hides a strict failure in another (the review's cases)", () => {
    // A passing retry of B's explanation (attempt 2), then the edit's run failing at attempt 1: attempt order.
    const attemptOrder = [check("handoff.snapshot", "pass", "B", 2, "explain"), check("handoff.snapshot", "fail", "B", 1, "edit")];
    // A failure, then a later pass at the same attempt in another scenario.
    const sameAttempt = [check("handoff.route", "fail", "B", 1, "explain"), check("handoff.route", "pass", "B", 1, "choice")];
    for (const checks of [attemptOrder, sameAttempt]) {
      assert.equal(criteriaOutcomes(checks).handoff, "fail");
      const summary = publicSummary({ ...record(), checks });
      assert.deepEqual(summary.criteria.find((c) => c.criterion === "handoff"), { criterion: "handoff", outcome: "fail", checks: 2, attempts: 2 });
      assert.deepEqual(summary.checks.map((c) => [c.scenario, c.outcome]), checks.map((c) => [c.scenario, c.outcome]));
      assert.match(publicFiles({ ...record(), checks }, B).markdown, /\| \*\*fail\*\* \| 2 \| 2 \|/);
    }
  });

  it("never lets a retry supersede a strict failure, even within one scenario or in a record kept before scenarios", () => {
    assert.equal(criteriaOutcomes([check("handoff.head", "fail", "B", 1, "explain"), check("handoff.head", "pass", "B", 2, "explain")]).handoff, "fail");
    assert.equal(criteriaOutcomes([check("handoff.snapshot", "pass", "B", 2), check("handoff.snapshot", "fail", "B", 1)]).handoff, "fail", "no scenario recorded");
    // Retries still collapse where they're meant to: a demonstration's targeted retry, and a missed window.
    assert.equal(criteriaOutcomes([check("b.repository-governs", "incomplete", "B", 1, "explain"), check("b.repository-governs", "pass", "B", 2, "explain"), check("b.isolation", "pass", "B", 1, "explain")])["contrast-b"], "pass");
    assert.equal(criteriaOutcomes([check("engine.kill-live", "incomplete", "A", 1, "kill"), check("engine.kill-live", "pass", "A", 2, "kill")])["engine-restart"], "pass");
  });

  it("exits non-zero when a required demonstration stays incomplete, and only for what the session must establish", () => {
    const criteria = Object.keys(CRITERIA) as Criterion[];
    /** One passing gating check for each criterion. */
    const passing = (only: readonly Criterion[] = criteria) =>
      only.map((criterion) => check(Object.entries(CHECKS).find(([, [c, kind]]) => c === criterion && kind !== "optional")![0] as CheckEntry["id"], "pass"));
    assert.deepEqual(sessionVerdict(passing(), "live"), { exitCode: 0, failed: [], incomplete: [] }, "every criterion passed");
    const missing = [...passing(), check("b.repository-governs", "incomplete", "B", 1, "explain"), check("b.repository-governs", "incomplete", "B", 2, "explain")];
    assert.deepEqual(sessionVerdict(missing, "live"), { exitCode: 2, failed: [], incomplete: ["contrast-b"] }, "a required demonstration still incomplete after its retry");
    const optional = [...passing(), check("life.wording", "incomplete", "B", 1, "edit"), check("provider.network", "incomplete", "fresh", 1, "network")];
    assert.deepEqual(sessionVerdict(optional, "live"), { exitCode: 0, failed: [], incomplete: [] }, "optional wording never gates");
    assert.deepEqual(sessionVerdict([...passing(), check("app.intact", "fail")], "live"), { exitCode: 1, failed: ["app-restart"], incomplete: [] });
    assert.deepEqual(sessionVerdict(passing(criteria.filter((c) => c !== "freshness")), "live"), { exitCode: 2, failed: [], incomplete: ["freshness"] }, "a live session must establish every criterion");
    const rehearsal: Criterion[] = ["identity", "handoff", "consent", "provider-failure", "cancel", "engine-restart", "app-restart", "cleanup"];
    assert.deepEqual(sessionVerdict(passing(rehearsal), "rehearsal"), { exitCode: 0, failed: [], incomplete: [] }, "a rehearsal never runs the journey");
    assert.deepEqual(sessionVerdict(passing(rehearsal.filter((c) => c !== "cleanup")), "rehearsal"), { exitCode: 2, failed: [], incomplete: ["cleanup"] });
  });

  it("totals a cost that wasn't reported as unknown, never as zero, and never publishes a model id outside nvidia/", () => {
    const summary = publicSummary({ ...record(), runs: [run("A", { usage: { inputTokens: null, outputTokens: null, calls: 2, reportedCalls: 1 }, model: "someone/else" })] });
    assert.deepEqual([summary.totals.inputTokens, summary.totals.reportedInputTokens, summary.totals.unreportedRuns, summary.runs[0]!.model], [null, 0, 1, "unrecognised"]);
  });

  it("works out a conflict's reason from its sides, independently of the engine", () => {
    const shown = [{ checked: true }];
    const personal = { id: "p", scope: "personal", intent: "default" };
    const decision = { id: "d", scope: "project", intent: "override" };
    assert.equal(expectedReason({ choices: [], preferences: [personal], repositoryConvention: "kebab-case", citations: shown }), "repository");
    assert.equal(expectedReason({ choices: [], preferences: [personal], repositoryConvention: "kebab-case", citations: [{ checked: false }] }), "personal-default");
    assert.equal(expectedReason({ choices: ["c1"], preferences: [decision], repositoryConvention: "Jest", citations: shown }), "choice");
    assert.equal(expectedReason({ choices: [], preferences: [decision], repositoryConvention: "Jest", citations: shown }), "override");
    assert.equal(expectedReason({ choices: ["c1", "c2"], preferences: [], repositoryConvention: null, citations: [] }), "unresolved");
  });
});
