import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { startStub, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * The mission review's live check (NIV-52), offline: its recipe and digest, a run against a loopback stub that ends
 * complete with the approved model held, and the refusals that keep a live run to the approved recipe: another digest,
 * an approval already claimed (one approval is one run, claimed atomically, kept after an interruption), an engine home
 * it must never use, and a listing without the approved model, which sends no inference request at all. The model is
 * held only when every answer named it. Each check runs with a home of its own, so no claim lands in the real one.
 */

const SCRIPT = fileURLToPath(new URL("../scripts/mission-review-live.ts", import.meta.url));
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
const LIVE_MODEL = "nvidia/nemotron-3-super-120b-a12b";
/** A reply as a provider serving `model` sends it back. */
const servedBy = (reply: Reply, model: string): Reply => ({ ...reply, body: { ...(reply.body as Record<string, unknown>), model } });
/** A reply that names no model at all. */
const unnamed = (reply: Reply): Reply => {
  const { model: _model, ...body } = reply.body as Record<string, unknown>;
  return { ...reply, body };
};

describe("the mission review's live check (NIV-52)", () => {
  it("prints the recipe for approval, with its bounds, its one model and a digest, and sends nothing", async () => {
    const { code, stdout } = await run(["--plan"]);
    assert.match(stdout, /One approval is one run\. This one covers run 1 of this recipe at this revision\. The first launch that presents it claims it in ~\/nivra-acceptance\/claims\/mission-review\//);
    assert.equal(code, 0);
    assert.match(stdout, /Model: nvidia\/nemotron-3-super-120b-a12b only\. The engine refuses any other before the first inference request/);
    assert.match(stdout, /at most 3 requests \(two reviewers, then the chair\), 4,000 output tokens each, 150 s each and 330 s in all/);
    assert.match(stdout, /Product architect v1, instructions [0-9a-f]{12}\./);
    assert.match(stdout, /The forms they hand in \(the tools' definitions\): [0-9a-f]{12}\./);
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
    const stub = await startStub({ chat: (request) => servedBy(COUNCIL[roleOf(request) ?? "chair"], LIVE_MODEL) });
    stubs.push(stub);
    const dir = folder();
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 0, stdout);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { status: string; outcome: string; modelHeld: boolean; served: Array<{ servedModel: string | null }>; findings: Array<{ refs: string[][] }> };
    assert.deepEqual([result.status, result.outcome, result.modelHeld, result.served.length], ["succeeded", "complete", true, 3]);
    assert.deepEqual(result.findings.map((reviewer) => reviewer.refs), [[["T1", "backlog"]], [["T3"]]]);
    assert.equal(stub.chats().length, 3);
  });

  it("fails its evidence when a request was served by another model, though the run completed", async () => {
    const stub = await startStub({ chat: (request) => servedBy(COUNCIL[roleOf(request) ?? "chair"], "nvidia/a-substitute") });
    stubs.push(stub);
    const dir = folder();
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 1);
    assert.match(stdout, /A request was served by a model other than nvidia\/nemotron-3-super-120b-a12b: this run isn't the approved check\./);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { outcome: string; modelHeld: boolean };
    assert.deepEqual([result.outcome, result.modelHeld], ["complete", false]);
  });

  it("doesn't call the model held when the answers didn't name the model that served them", async () => {
    const stub = await startStub({ chat: (request) => unnamed(COUNCIL[roleOf(request) ?? "chair"]) });
    stubs.push(stub);
    const dir = folder();
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 1);
    assert.match(stdout, /3 of 3 answers didn't name the model that served them, so this run doesn't show nvidia\/nemotron-3-super-120b-a12b held\./);
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
    const stub = await startStub({ models: [{ id: "nvidia/some-other-model" }], chat: (request) => COUNCIL[roleOf(request) ?? "chair"] });
    stubs.push(stub);
    const dir = folder();
    const { code } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")], dir);
    assert.equal(code, 1);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { status: string; error: string | null; served: unknown[] };
    assert.deepEqual([result.status, result.served.length], ["failed", 0]);
    assert.match(result.error ?? "", /may use only nvidia\/nemotron-3-super-120b-a12b/);
    assert.equal(stub.chats().length, 0, "no inference request was made");
  });
});
