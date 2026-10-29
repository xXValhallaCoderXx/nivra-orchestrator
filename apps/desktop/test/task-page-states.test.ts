import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskView } from "../src/shared/ipc.ts";
import { readinessOf, type ReadinessInput } from "../src/shared/task-readiness.ts";
import { environmentStepOf, latestHolds, stripItemsOf, type StripInput } from "../src/shared/task-strip.ts";
import { verdictText } from "../src/shared/task-verdict.ts";
import { preparedOf } from "./fixtures/environment-recipe.ts";

/**
 * What the task page says before, during and after a run (NIV-56, G3), worked out from the task's own data: the
 * verdict's sentence, the progress strip's seven steps, and readiness. Each states only what the data shows.
 */
const PREPARED = await preparedOf("image-1");

describe("the verdict's sentence (D39, D41, NIV-55)", () => {
  const frozen = [{ path: "test/a.test.ts", unchanged: true }] as never;
  it("keeps today's sentences for a verified change, a frozen file, and the cases", () => {
    assert.match(verdictText({ verified: true, frozen, setup: { unchanged: true, changed: [] } }), /^Every acceptance case passed, and every frozen file is unchanged: the change is verified\./);
    assert.match(verdictText({ verified: false, frozen: [{ path: "a", unchanged: false }] as never, setup: null }), /^A frozen file isn't shown to be unchanged/);
    assert.match(verdictText({ verified: false, frozen, setup: { unchanged: true, changed: [] } }), /^Not every acceptance case was shown to pass/);
  });

  it("says a run that changed a setup file isn't verified for that reason, naming the files, not the cases'", () => {
    const said = verdictText({ verified: false, frozen, setup: { unchanged: false, changed: ["package.json", "pnpm-lock.yaml", "packages/a/package.json", "packages/b/package.json"] } });
    assert.match(said, /^The run changed a setup file the environment was prepared from \(package\.json, pnpm-lock\.yaml, packages\/a\/package\.json and 1 more\), so its checks don't count/);
    assert.match(said, /Request a revision that leaves the setup files as they are\./);
    assert.match(verdictText({ verified: false, frozen, setup: { unchanged: null, changed: [] } }), /^Nivra couldn't tell whether the setup files/);
    // A run with no environment has no setup check: the cases' reason stands.
    assert.match(verdictText({ verified: false, frozen: [], setup: undefined }), /^Not every acceptance case/);
  });
});

const attempt = (over: Partial<TaskView["attempts"][number]> = {}): TaskView["attempts"][number] => ({ id: "a1", briefVersion: 1, status: "answered", note: null, outcome: "proposed", verified: true, decision: null, apply: null, acceptedAt: null, createdAt: "2026-10-28T10:00:00.000Z", settledAt: null, ...over });
const strip = (input: Partial<StripInput>) => Object.fromEntries(stripItemsOf({ task: { state: "ready", briefVersion: 1 }, needed: 0, environment: { kind: "none" }, latest: null, ...input }).map((item) => [item.step, `${item.state} ${item.sub}`]));

describe("the progress strip's seven steps (NIV-56)", () => {
  it("gives seven steps in order, and a new task's brief is the current one", () => {
    const items = stripItemsOf({ task: null, needed: null, environment: null, latest: null });
    assert.deepEqual(items.map((item) => item.step), ["brief", "readiness", "environment", "run", "review", "apply", "accept"]);
    assert.deepEqual([items[0]!.state, items[0]!.sub, items[1]!.state], ["now", "Writing v1", "next"]);
  });

  it("follows a task from readiness to an accepted change", () => {
    assert.equal(strip({ task: { state: "draft", briefVersion: 2 }, needed: 2 }).readiness, "attention 2 needed");
    assert.equal(strip({ task: { state: "draft", briefVersion: 2 }, needed: 2 }).brief, "done v2 saved");
    assert.deepEqual([strip({ latest: attempt({ status: "running", outcome: null }) }).run, strip({ latest: attempt({ status: "running", outcome: null }) }).readiness], ["now Running", "done All met"]);
    assert.equal(strip({ latest: attempt() }).review, "now Your decision");
    assert.equal(strip({ latest: attempt({ verified: false }) }).review, "attention Not verified");
    assert.equal(strip({ latest: attempt({ outcome: "unchanged" }) }).review, "next No change");
    const applied = attempt({ decision: "approved", apply: { status: "applied", resolution: null } });
    assert.deepEqual([strip({ latest: applied }).apply, strip({ latest: applied }).accept], ["done Applied", "now Waiting"]);
    const accepted = attempt({ decision: "approved", apply: { status: "applied", resolution: "accepted" }, acceptedAt: "2026-10-28T11:00:00.000Z" });
    assert.equal(strip({ task: { state: "completed", briefVersion: 1 }, latest: accepted }).accept, "done Accepted");
  });

  it("never claims an environment is needed: none is optional, and only a prepared one's state is said", () => {
    assert.deepEqual([strip({ environment: { kind: "none" } }).environment, strip({ environment: { kind: "ready" } }).environment, strip({ environment: { kind: "attention", sub: "Prepare again" } }).environment, strip({ environment: null }).environment], ["optional None", "done Prepared", "attention Prepare again", "next Not checked"]);
    assert.deepEqual([strip({ latest: attempt({ status: "interrupted", outcome: "interrupted" }) }).run, strip({ latest: attempt({ status: "cancelled", outcome: "cancelled" }) }).run], ["attention Interrupted", "done Stopped"]);
  });
});

const task = (over: { state?: TaskView["summary"]["state"]; cases?: number; runBlocked?: string | null; projectId?: string | null } = {}): ReadinessInput["task"] => ({
  summary: { id: "t1", title: "Add CSV export", state: over.state ?? "ready", projectId: over.projectId === undefined ? "p1" : over.projectId, projectLabel: "billing-service", projectPresent: true, briefVersion: 1, updatedAt: "2026-10-28T10:00:00.000Z" } as never,
  brief: { id: "b1", version: 1, sha256: "s", createdAt: "2026-10-28T10:00:00.000Z", content: { goal: "Export invoices", acceptanceCriteria: ["Opens", "Totals"], scope: "", exclusions: "", context: "", assumptions: [], checks: ["pnpm typecheck"], acceptanceCases: Array.from({ length: over.cases ?? 1 }, (_, i) => ({ name: `case ${i}`, command: "true", expectedOutput: "", expectedExitCode: 0 })), baseline: [], frozen: ["test/a.test.ts"], sources: [], revalidate: [] } } as never,
  runBlocked: over.runBlocked === undefined ? null : over.runBlocked,
});
const project = { id: "p1", label: "billing-service", targetLabel: "Ubuntu · WSL", sharing: { modelContext: false, cloudExecution: true } };
const ids = (rows: Array<{ id: string; action: string | null }>) => rows.map((row) => `${row.id}${row.action ? `:${row.action}` : ""}`);

describe("readiness, from what the window holds (NIV-56: P1c, RS3)", () => {
  it("lists what's needed with each one's next step, what the preview will ask, and what's met", () => {
    const shown = readinessOf({ task: task({ state: "draft", cases: 0, runBlocked: "Mark the task ready first: a run works from a ready task." }), project, settings: { nebiusKey: "none", nebiusProjectId: "none" }, environment: { prepared: null, ready: false, legacy: false, notice: null } });
    assert.deepEqual(ids(shown.needed), ["draft:mark-ready", "cases:edit-brief", "keys:add-keys"]);
    assert.deepEqual(ids(shown.asked), ["sharing"]);
    assert.deepEqual(ids(shown.met), ["repository", "uploads"]);
    assert.deepEqual(ids(shown.optional), ["environment:open-environment"]);
    assert.match(shown.optional[0]!.detail, /^Runs start from Nivra's own base image, with nothing installed\./);
  });

  it("shows the host's own reason when nothing else says it, and says nothing blocks only when the host says so", () => {
    const busy = readinessOf({ task: task({ runBlocked: "Another task's run is going: one task runs at a time." }), project, settings: { nebiusKey: "encrypted", nebiusProjectId: "set" }, environment: null });
    assert.deepEqual(busy.needed.map((row) => [row.id, row.detail]), [["blocked", "Another task's run is going: one task runs at a time."]]);
    assert.ok(!busy.met.some((row) => row.id === "nothing-blocks"));
    const clear = readinessOf({ task: task(), project: { ...project, sharing: { modelContext: true, cloudExecution: true } }, settings: { nebiusKey: "encrypted", nebiusProjectId: "set" }, environment: { prepared: PREPARED, ready: true, legacy: false, notice: null } });
    assert.deepEqual([ids(clear.needed), ids(clear.asked), ids(clear.met)], [[], [], ["brief", "repository", "keys", "sharing", "uploads", "environment", "nothing-blocks"]]);
    assert.match(clear.met.find((row) => row.id === "environment")!.detail, /^Its task runs start from it: node /);
  });

  it("asks to prepare again for an environment no run starts from, and says a completed task must be reopened, which the page offers beside its other state changes", () => {
    assert.deepEqual(ids(readinessOf({ task: task(), project, settings: null, environment: { prepared: null, ready: false, legacy: true, notice: null } }).needed), ["environment:open-environment"]);
    assert.deepEqual(ids(readinessOf({ task: task(), project, settings: null, environment: { prepared: PREPARED, ready: false, legacy: false, notice: null } }).needed), ["environment:open-environment"]);
    assert.deepEqual(ids(readinessOf({ task: task({ state: "completed" }), project, settings: null, environment: null }).needed), ["completed"]);
    assert.deepEqual(ids(readinessOf({ task: task({ projectId: null }), project: null, settings: null, environment: null }).needed), ["repository:change-repository"]);
  });
});

describe("what leads the task page (NIV-56)", () => {
  it("leads with the latest run while it goes or waits on the person, as the host's own rule decides", () => {
    assert.equal(latestHolds(null), false);
    assert.equal(latestHolds(attempt({ status: "running", outcome: null })), true);
    assert.equal(latestHolds(attempt()), true, "a proposed change to decide on");
    assert.equal(latestHolds(attempt({ outcome: "unchanged" })), false, "nothing to decide");
    assert.equal(latestHolds(attempt({ decision: "rejected" })), false);
    assert.equal(latestHolds(attempt({ decision: "approved", apply: { status: "writing", resolution: null } })), true, "an apply going");
    assert.equal(latestHolds(attempt({ decision: "approved", apply: { status: "applied", resolution: null } })), true, "an applied change to settle");
    assert.equal(latestHolds(attempt({ decision: "approved", apply: { status: "applied", resolution: "accepted" }, acceptedAt: "2026-10-28T11:00:00.000Z" })), false);
    assert.equal(latestHolds(attempt({ status: "failed", outcome: null })), false);
  });

  it("names the environment step only from what the environment shows", () => {
    assert.equal(environmentStepOf(null), null);
    assert.deepEqual(environmentStepOf({ prepared: null, ready: false, legacy: true, notice: null }), { kind: "attention", sub: "Prepare again" });
    assert.deepEqual(environmentStepOf({ prepared: null, ready: false, legacy: false, notice: null }), { kind: "none" });
    assert.deepEqual(environmentStepOf({ prepared: PREPARED, ready: false, legacy: false, notice: null }), { kind: "attention", sub: "Not ready" });
    assert.deepEqual(environmentStepOf({ prepared: PREPARED, ready: true, legacy: false, notice: "Made in another Nebius project." }), { kind: "attention", sub: "See its notice" });
    assert.deepEqual(environmentStepOf({ prepared: PREPARED, ready: true, legacy: false, notice: null }), { kind: "ready" });
  });
});
