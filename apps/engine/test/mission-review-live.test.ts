import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { type MissionReviewPacket, type ParamsOf, type ReviewReport, type RpcClient, type RunSummary } from "@nivra/domain";
import { collectMissionReview } from "../scripts/mission-review-collect.ts";
import { httpError, startStub, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * The mission review's live check (NIV-52), offline: its recipe and digest, a run against a loopback stub that ends
 * complete with the approved model held, and the refusals that keep a live run to the approved recipe: another digest,
 * an approval already claimed (one approval is one run, claimed atomically, kept after an interruption), an engine home
 * it must never use, and a listing without the approved model, which sends no inference request at all. The model is
 * held only when every answer named it. Each check runs with a home of its own, so no claim lands in the real one.
 */

const SCRIPT = fileURLToPath(new URL("../scripts/mission-review-live.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/mission-review/live.json", import.meta.url));
const dirs: string[] = [];
const stubs: Stub[] = [];
after(async () => {
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "nivra mission live "));
  dirs.push(dir);
  return dir;
};

type Ran = { code: number | null; stdout: string; stderr: string; pid: number };
function launch(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const ended = new Promise<Ran>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr, pid: child.pid! })));
  return { child, ended };
}
/** Runs the script with its own home, so its claims never land in the real one. */
const run = (args: string[], home = folder()): Promise<Ran> => launch(args, { ...process.env, HOME: home }).ended;
const claimsIn = (home: string) => join(home, "nivra-acceptance", "claims", "mission-review");
const digestIn = (text: string) => /Approval digest: ([0-9a-f]{64})/.exec(text)?.[1] ?? null;

type Role = "architecture" | "risks" | "chair";
const roleOf = (request: StubRequest): Role | null => (/Nivra review role: (architecture|risks|chair)/.exec(JSON.stringify(request.body?.messages ?? []))?.[1] as Role | undefined) ?? null;
const COUNCIL: Record<Role, Reply> = {
  architecture: toolCall("submit_review", { summary: "Nothing stores runs before the total needs them.", findings: [{ title: "No task stores runs", detail: "T1 assumes stored runs.", recommendation: "Add a task.", severity: "high", refs: ["T1", "backlog"] }], assumptions: [], gaps: [] }),
  risks: toolCall("submit_review", { summary: "One criterion can't be tested.", findings: [{ title: "'It works well' can't be checked", detail: "T3's second criterion.", recommendation: "Say what is checked.", severity: "medium", refs: ["T3"] }], assumptions: [], gaps: [] }),
  chair: toolCall("submit_synthesis", { summary: "Store runs first; make T3 testable.", priorities: ["arch-1", "risk-1"], agreements: [], dissent: [], gaps: [] }),
};
const LIVE_MODEL = "nvidia/Nemotron-3.5-Super-VL";
/** A reply as a provider serving `model` sends it back. */
const servedBy = (reply: Reply, model: string): Reply => ({ ...reply, body: { ...(reply.body as Record<string, unknown>), model } });
/** A reply that names no model at all. */
const unnamed = (reply: Reply): Reply => {
  const { model: _model, ...body } = reply.body as Record<string, unknown>;
  return { ...reply, body };
};

describe("the mission review's live check (NIV-52)", () => {
  it("rejects linked evidence directories and their ancestors without changing historical files", async () => {
    const dir = folder();
    const historical = join(dir, "historical"); mkdirSync(historical);
    const marker = join(historical, "result.json"); writeFileSync(marker, "Keep this evidence.\n");
    const linked = join(dir, "linked"); symlinkSync(historical, linked, "junction");
    for (const out of [linked, join(linked, "new-evidence")]) {
      const result = await run(["--token-factory-url", "http://127.0.0.1:9", "--out", out, "--home", join(dir, "home")], dir);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /directory or output path is linked/);
    }
    assert.equal(readFileSync(marker, "utf8"), "Keep this evidence.\n");
    assert.equal(existsSync(join(historical, "new-evidence")), false);
  });

  it("prints the recipe for approval, with its bounds, its one model and a digest, and sends nothing", async () => {
    const { code, stdout } = await run(["--plan"]);
    assert.match(stdout, /One approval is one run\. This one covers run 1 of this recipe at this revision\. The first launch that presents it claims it in ~\/nivra-acceptance\/claims\/mission-review\/ before the checkout is checked, the key is read or anything is sent/);
    assert.equal(code, 0);
    assert.match(stdout, /Model: nvidia\/Nemotron-3\.5-Super-VL only\. The engine refuses any other before the first inference request/);
    assert.match(stdout, /at most 3 requests \(two reviewers, then the chair\), 4,000 completion tokens each \(reasoning included\), 150 s each and 330 s in all/);
    assert.match(stdout, /Product architect v1, instructions [0-9a-f]{12}\./);
    assert.match(stdout, /The forms they hand in \(the tools' definitions\): [0-9a-f]{12}\./);
    assert.match(stdout, /The production host reserves all three inference slots in its isolated shared monthly allowance/);
    assert.match(stdout, /Approval digest: [0-9a-f]{64}\n/);
    const again = await run(["--plan"]);
    assert.equal(digestIn(again.stdout), digestIn(stdout), "the same recipe gives the same digest");
  });

  it("refuses a live run whose digest isn't the approved one, before reading the key or starting an engine", async () => {
    const dir = folder();
    const credentials = join(dir, "token-factory.env");
    writeFileSync(credentials, "NEBIUS_API_KEY=not-a-real-key-0123456789\n");
    chmodSync(credentials, 0o600);
    const { code, stderr } = await run(["--credentials", credentials, "--approved", "0".repeat(64), "--out", join(dir, "out")], dir);
    assert.equal(code, 2);
    assert.match(stderr, /not the one approved .* Nothing was sent\./);
    assert.equal(existsSync(claimsIn(dir)), false, "nothing was claimed");
  });

  it("lets exactly one of several simultaneous launches claim an approval; the others stop before reading a key", async () => {
    const home = folder();
    const env = { ...process.env, HOME: home };
    const digest = digestIn((await run(["--plan"], home)).stdout)!;
    // No key file: the one that claims stops there (or at a checkout with changes), having sent nothing.
    const runs = await Promise.all(Array.from({ length: 6 }, (_, index) => launch(["--credentials", join(home, "missing.env"), "--approved", digest, "--out", join(home, `out-${index}`)], env).ended));
    // The one that claimed it says it is now used; each other one lost the race to claim it, or found it claimed.
    const winners = runs.filter((ran) => /Nothing was sent\. This approval is now used: run --plan/.test(ran.stderr));
    const losers = runs.filter((ran) => /^(Another launch claimed this approval first \(|This approval was claimed by )run 1 on /.test(ran.stderr));
    assert.deepEqual([winners.length, losers.length, runs.map((ran) => ran.code)], [1, 5, [2, 2, 2, 2, 2, 2]]);
    assert.deepEqual(readdirSync(claimsIn(home)), [`${digest}.json`]);
    const claim = JSON.parse(readFileSync(join(claimsIn(home), `${digest}.json`), "utf8")) as { pid: number; run: number; digest: string };
    assert.deepEqual([claim.pid, claim.run, claim.digest], [winners[0]!.pid, 1, digest]);
    assert.deepEqual(runs.map((_, index) => existsSync(join(home, `out-${index}`))), [false, false, false, false, false, false], "no launch made evidence");
  });

  it("never runs a claimed approval again, even after its launch was killed, whatever --out or --home says; --plan moves on", async () => {
    const home = folder();
    const env = { ...process.env, HOME: home };
    const one = digestIn((await run(["--plan"], home)).stdout)!;
    // A key file that blocks whoever reads it: a launch that got that far is killed there, after claiming.
    const fifo = join(home, "blocking.env");
    assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0);
    const first = launch(["--credentials", fifo, "--approved", one, "--out", join(home, "first")], env);
    const claimFile = join(claimsIn(home), `${one}.json`);
    for (let waited = 0; !existsSync(claimFile) && waited < 20_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    first.child.kill("SIGKILL");
    await first.ended;
    assert.equal(existsSync(claimFile), true, "the claim outlives the launch");
    const again = await run(["--credentials", join(home, "missing.env"), "--approved", one, "--out", join(home, "second"), "--home", join(home, ".nivra-dev-niv52", "other")], home);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /^This approval was claimed by run 1 on \S+, with its evidence in .+first, so it can't run again: one approval is one run\. Nothing was sent\./);
    const next = await run(["--plan"], home);
    const two = digestIn(next.stdout);
    assert.ok(two && two !== one, "the next run's approval is a digest of its own");
    assert.match(next.stdout, /This one covers run 2 of this recipe at this revision/);
    assert.match(next.stdout, /The approval before this one was claimed by run 1 on /);
  });

  it("refuses an evidence folder that already holds evidence, before anything else happens", async () => {
    const dir = folder();
    const out = join(dir, "out");
    mkdirSync(out);
    writeFileSync(join(out, "result.json"), "{}\n");
    const { code, stderr } = await run(["--token-factory-url", "http://127.0.0.1:9", "--out", out, "--home", join(dir, "home")], dir);
    assert.equal(code, 2);
    assert.match(stderr, /already holds evidence\. Choose another --out\. Nothing was sent\./);
  });

  it("runs the council against a stub, keeps the evidence, and holds the approved model", async () => {
    const stub = await startStub({ models: [{ id: "nvidia/Nemotron-3_5-Lightning" }, { id: LIVE_MODEL }], chat: (request) => servedBy(COUNCIL[roleOf(request) ?? "chair"], LIVE_MODEL) });
    stubs.push(stub);
    const dir = folder();
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 0, stdout);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { status: string; outcome: string; modelHeld: boolean; served: Array<{ servedModel: string | null }>; findings: Array<{ refs: string[][] }> };
    assert.deepEqual([result.status, result.outcome, result.modelHeld, result.served.length], ["succeeded", "complete", true, 3]);
    assert.deepEqual(result.findings.map((reviewer) => reviewer.refs), [[["T1", "backlog"]], [["T3"]]]);
    assert.equal(stub.chats().length, 3);
    assert.equal(stub.requests.filter((request) => request.path.endsWith("/models")).length, 1, "listing isn't an inference request");
    const receipt = JSON.parse(readFileSync(join(dir, "out", "host", "receipt.json"), "utf8")) as { grants: Array<{ state: string; attribution_json: string }>; operations: Array<{ kind: string; seat: string }>; roles: Array<{ seat: string; part: string }> };
    assert.equal(receipt.grants.length, 1);
    assert.equal(receipt.grants[0]?.state, "settled");
    assert.equal(JSON.parse(receipt.grants[0]!.attribution_json).feature, "mission-review");
    assert.equal(receipt.operations.length, 4);
    assert.deepEqual(receipt.roles.map((row) => [row.seat, row.part]).sort(), [["architecture", "productive"], ["chair", "finalisation"], ["mission-review-listing", "productive"], ["risks", "productive"]]);
    for (const request of stub.chats()) {
      assert.equal(request.body?.model, LIVE_MODEL);
      assert.equal(request.body?.["max_completion_tokens"], 4_000);
      assert.equal(Object.hasOwn(request.body ?? {}, "max_tokens"), false);
      assert.deepEqual(request.body?.tool_choice, { type: "function", function: { name: roleOf(request) === "chair" ? "submit_synthesis" : "submit_review" } });
    }
    for (const file of ["recipe.json", "report.json", "result.json", "engine.log"]) {
      assert.equal(readFileSync(join(dir, "out", file), "utf8").includes("stub-key-0123456789"), false, `${file} contains no key`);
    }
  });

  it("keeps a failure receipt when the engine cannot initialise, without claiming a run started", async () => {
    const dir = folder();
    const home = join(dir, "not-a-directory");
    writeFileSync(home, "Keep this file.\n");
    const { code, stdout, stderr } = await run(["--token-factory-url", "http://127.0.0.1:9", "--out", join(dir, "out"), "--home", home], dir);
    assert.equal(code, 1);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8"));
    assert.deepEqual([result.runId, result.status, result.startRequested, result.usage], [null, null, false, null]);
    assert.match(result.problems[0], /Couldn't initialise the engine/);
    assert.equal(result.engineClose, "not-available");
    assert.equal(`${stdout}${stderr}`.includes("stub-key-0123456789"), false);
    assert.equal(readFileSync(home, "utf8"), "Keep this file.\n");
  });

  it("keeps an incomplete run after a provider failure, without retrying either reviewer or the chair", async () => {
    const stub = await startStub({ models: [{ id: LIVE_MODEL }], chat: (request) => roleOf(request) === "architecture" ? httpError(503) : servedBy(COUNCIL[roleOf(request) ?? "chair"], LIVE_MODEL) });
    stubs.push(stub);
    const dir = folder();
    const { code } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 1);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8"));
    assert.deepEqual([result.status, result.outcome, result.engineClose], ["failed", "incomplete", "returned"]);
    assert.ok(stub.chats().length <= 3);
    assert.equal(stub.chats().filter((request) => roleOf(request) === "architecture").length, 1);
    for (const role of ["architecture", "risks", "chair"]) assert.ok(stub.chats().filter((request) => roleOf(request) === role).length <= 1, `${role} was never retried`);
    assert.equal(existsSync(join(dir, "out", "report.json")), true);
  });

  it("refuses an unpinned or historical-model fixture before reading any key or making evidence", async () => {
    const dir = folder();
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    for (const model of [null, "nvidia/nemotron-3-super-120b-a12b"]) {
      const path = join(dir, "fixture.json");
      writeFileSync(path, JSON.stringify({ ...fixture, model }));
      const { code, stderr } = await run(["--fixture", path, "--credentials", join(dir, "missing.env"), "--out", join(dir, "out")], dir);
      assert.equal(code, 2);
      assert.match(stderr, /the live check takes only nvidia\/Nemotron-3\.5-Super-VL\. Nothing was sent\./);
      assert.equal(existsSync(claimsIn(dir)), false);
      assert.equal(existsSync(join(dir, "out")), false);
    }
  });

  it("fails its evidence when a request was served by another model, though the run completed", async () => {
    const stub = await startStub({ models: [{ id: LIVE_MODEL }], chat: (request) => servedBy(COUNCIL[roleOf(request) ?? "chair"], "nvidia/a-substitute") });
    stubs.push(stub);
    const dir = folder();
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 1);
    assert.match(stdout, /A request was served by a model other than nvidia\/Nemotron-3\.5-Super-VL: this run isn't the approved check\./);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { outcome: string; modelHeld: boolean };
    assert.deepEqual([result.outcome, result.modelHeld], ["complete", false]);
  });

  it("doesn't call the model held when the answers didn't name the model that served them", async () => {
    const stub = await startStub({ models: [{ id: LIVE_MODEL }], chat: (request) => unnamed(COUNCIL[roleOf(request) ?? "chair"]) });
    stubs.push(stub);
    const dir = folder();
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 1);
    assert.match(stdout, /3 of 3 answers didn't name the model that served them, so this run doesn't show nvidia\/Nemotron-3\.5-Super-VL held\./);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { outcome: string; modelHeld: boolean | null };
    assert.deepEqual([result.outcome, result.modelHeld], ["complete", null]);
  });

  it("refuses an engine home inside one it must never use, before reading the key or starting an engine", async () => {
    const home = folder();
    for (const forbidden of [".nivra", ".nivra-dev"]) {
      const inside = join(home, forbidden, "live");
      const { code, stderr } = await run(["--token-factory-url", "http://127.0.0.1:9", "--out", join(home, "out"), "--home", inside], home);
      assert.equal(code, 2);
      assert.match(stderr, /is in .+, an engine home this check must never use\. Nothing was sent\./);
      assert.equal(existsSync(join(home, forbidden)), false, "nothing was made there");
    }
  });

  it("sends no inference request when the listing lacks the approved model", async () => {
    const stub = await startStub({ models: [{ id: "nvidia/nemotron-3-super-120b-a12b" }], chat: (request) => COUNCIL[roleOf(request) ?? "chair"] });
    stubs.push(stub);
    const dir = folder();
    const { code } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 1);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { status: string; error: string | null; served: unknown[] };
    assert.deepEqual([result.status, result.served.length], ["failed", 0]);
    assert.match(result.error ?? "", /may use only nvidia\/Nemotron-3\.5-Super-VL/);
    assert.equal(stub.chats().length, 0, "no inference request was made");
  });
});

const RUNNING: RunSummary = { id: "6b2f8711-42e2-411d-83fe-bc2d3acebe87", workflowId: "review", title: "Review", status: "running", input: {}, createdAt: "2026-10-30T00:00:00.000Z", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: null, error: null, durationMs: null, usage: null, route: null };

/** Lost replies and deadlines without real waits, inference or a new CLI escape hatch. */
function collectionHarness() {
  const h = {
    now: 0,
    wakes: [] as number[],
    calls: [] as Array<{ method: string; timeoutMs: number | undefined }>,
    closes: 0,
    onCall: (_method: string) => undefined as unknown,
    onClose: () => undefined as void,
  };
  const request: Extract<ParamsOf<"runs.start">, { workflowId: "review" }> = {
    clientRequestId: "74caeaa2-71ef-4e9c-895a-b5aabf82456b", workflowId: "review",
    input: { panel: "council", planId: RUNNING.id, planVersion: 1, packetDigest: "a".repeat(64), preferencesDigest: "b".repeat(64) },
    context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false }, packet: JSON.parse(readFileSync(FIXTURE, "utf8")) as MissionReviewPacket },
  };
  const partial = { outcome: "incomplete", reviewers: [{ role: "architecture", findings: [{ refs: ["T1", "backlog"] }] }] } as unknown as ReviewReport;
  const client = { call: (async (method, _params, options) => {
    h.calls.push({ method, timeoutMs: options?.timeoutMs });
    const supplied = h.onCall(method);
    if (supplied !== undefined) return supplied;
    if (method === "runs.start" || method === "runs.get" || method === "runs.find") return { ...RUNNING };
    if (method === "runs.cancel") return { status: "running", wasTerminal: false };
    if (method === "runs.review") return partial;
    throw new Error(`Unexpected RPC ${method}`);
  }) as RpcClient["call"] };
  const collect = () => collectMissionReview({
    start: async () => ({ client, close: async () => { h.closes++; h.onClose(); } }),
    request, followMs: 10,
    clock: { now: () => h.now, pause: async (ms) => { h.now = h.wakes.shift() ?? h.now + ms; } },
  });
  return { h, collect };
}

describe("the mission live check's partial evidence", () => {
  it("doesn't call an acknowledged cancellation confirmed until a terminal state was observed", async () => {
    const { h, collect } = collectionHarness();
    const result = await collect();
    assert.equal(result.cancellation, "requested");
    assert.equal(result.summary?.status, "running");
    assert.match(result.unresolved ?? "", /No terminal run state was observed/);
    assert.match(result.problems[0] ?? "", /No terminal run state was observed within/);
    assert.equal(result.report?.outcome, "incomplete");
    assert.equal(result.report?.reviewers[0]?.findings.length, 1);
    assert.equal(result.engineClose, "returned");
    assert.equal(h.closes, 1);
    assert.deepEqual(h.calls.map((call) => call.method), ["runs.start", "runs.cancel", "runs.get", "runs.review"]);
    assert.ok(h.calls.slice(1).every((call) => call.timeoutMs === 5_000), "collection calls are bounded");
  });

  it("keeps the confirmed cancellation and partial report when polling fails", async () => {
    const { h, collect } = collectionHarness();
    let cancelled = false;
    h.wakes = [1];
    h.onCall = (method) => {
      if (method === "runs.cancel") cancelled = true;
      if (method === "runs.get") {
        if (!cancelled) throw new Error("private-transport-key");
        return { ...RUNNING, status: "cancelled" };
      }
      return undefined;
    };
    const result = await collect();
    assert.equal(result.cancellation, "confirmed");
    assert.equal(result.summary?.status, "cancelled");
    assert.equal(result.unresolved, null);
    assert.equal(result.report?.reviewers[0]?.findings.length, 1);
    assert.match(result.problems[0] ?? "", /Couldn't read the review's status/);
    assert.equal(JSON.stringify(result).includes("private-transport-key"), false);
    assert.equal(h.closes, 1);
  });

  it("finds an uncertain start once and cancels that run, never replaying the request", async () => {
    const { h, collect } = collectionHarness();
    h.onCall = (method) => {
      if (method === "runs.start") throw new Error("private-start-key");
      if (method === "runs.get") return { ...RUNNING, status: "cancelled" };
      return undefined;
    };
    const result = await collect();
    assert.equal(result.startRequested, true);
    assert.equal(result.summary?.id, RUNNING.id);
    assert.equal(result.cancellation, "confirmed");
    assert.equal(result.report?.outcome, "incomplete");
    assert.deepEqual(h.calls.map((call) => call.method), ["runs.start", "runs.find", "runs.cancel", "runs.get", "runs.review"]);
    assert.equal(JSON.stringify(result).includes("private-start-key"), false);
    assert.equal(h.closes, 1);
  });

  it("leaves an uncertain start unknown when finding it fails, and still shuts down", async () => {
    const { h, collect } = collectionHarness();
    h.onCall = (method) => {
      if (method === "runs.start" || method === "runs.find") throw new Error("private-start-key");
      return undefined;
    };
    const result = await collect();
    assert.equal(result.summary, null);
    assert.equal(result.report, null);
    assert.match(result.unresolved ?? "", /whether it started is unknown/);
    assert.deepEqual(h.calls.map((call) => call.method), ["runs.start", "runs.find"]);
    assert.equal(result.engineClose, "returned");
    assert.equal(h.closes, 1);
  });

  it("records cancellation, collection and shutdown failures without leaking raw exceptions", async () => {
    const { h, collect } = collectionHarness();
    h.onCall = (method) => {
      if (["runs.cancel", "runs.get", "runs.review"].includes(method)) throw new Error("private-failure-key");
      return undefined;
    };
    h.onClose = () => { throw new Error("private-shutdown-key"); };
    const result = await collect();
    assert.equal(result.cancellation, "failed");
    assert.equal(result.engineClose, "failed");
    assert.equal(result.summary?.status, "running");
    assert.equal(result.report, null);
    assert.match(result.unresolved ?? "", /termination is unresolved/);
    assert.equal(result.problems.length, 5);
    assert.equal(JSON.stringify(result).includes("private-"), false);
    assert.equal(h.closes, 1);
  });

  it("keeps a completed summary when report collection fails, without requesting cancellation", async () => {
    const { h, collect } = collectionHarness();
    h.onCall = (method) => {
      if (method === "runs.start") return { ...RUNNING, status: "succeeded" };
      if (method === "runs.review") throw new Error("private-report-key");
      return undefined;
    };
    const result = await collect();
    assert.equal(result.summary?.status, "succeeded");
    assert.equal(result.report, null);
    assert.equal(result.cancellation, "not-requested");
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0]!, /Couldn't collect the review report/);
    assert.deepEqual(h.calls.map((call) => call.method), ["runs.start", "runs.review"]);
    assert.equal(h.closes, 1);
  });
});
