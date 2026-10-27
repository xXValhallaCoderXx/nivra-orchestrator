import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { startStub, toolCall, type Reply, type Stub, type StubRequest } from "./stub-token-factory.ts";

/**
 * The mission review's live check (NIV-52), offline: its recipe and digest, a run against a loopback stub that ends
 * complete with the approved model held, and the refusals that keep a live run to the approved recipe: another digest,
 * and a listing without the approved model, which sends no inference request at all.
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

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

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

describe("the mission review's live check (NIV-52)", () => {
  it("prints the recipe for approval, with its bounds, its one model and a digest, and sends nothing", async () => {
    const { code, stdout } = await run(["--plan"]);
    assert.equal(code, 0);
    assert.match(stdout, /Model: nvidia\/nemotron-3-super-120b-a12b only\. The engine refuses any other before the first inference request/);
    assert.match(stdout, /at most 3 requests \(two reviewers, then the chair\), 4,000 output tokens each, 150 s each and 330 s in all/);
    assert.match(stdout, /Product architect v1, instructions [0-9a-f]{12}\./);
    assert.match(stdout, /Approval digest: [0-9a-f]{64}\n/);
    const again = await run(["--plan"]);
    assert.equal(/Approval digest: ([0-9a-f]{64})/.exec(again.stdout)?.[1], /Approval digest: ([0-9a-f]{64})/.exec(stdout)?.[1], "the same recipe gives the same digest");
  });

  it("refuses a live run whose digest isn't the approved one, before reading the key or starting an engine", async () => {
    const dir = folder();
    const credentials = join(dir, "token-factory.env");
    writeFileSync(credentials, "NEBIUS_API_KEY=not-a-real-key-0123456789\n");
    chmodSync(credentials, 0o600);
    const { code, stderr } = await run(["--credentials", credentials, "--approved", "0".repeat(64), "--out", join(dir, "out")]);
    assert.equal(code, 2);
    assert.match(stderr, /not the one approved .* Nothing was sent\./);
  });

  it("runs the council against a stub, keeps the evidence, and holds the approved model", async () => {
    const stub = await startStub({ chat: (request) => servedBy(COUNCIL[roleOf(request) ?? "chair"], LIVE_MODEL) });
    stubs.push(stub);
    const dir = folder();
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")]);
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
    const { code, stdout } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")]);
    assert.equal(code, 1);
    assert.match(stdout, /A request was served by a model other than nvidia\/nemotron-3-super-120b-a12b: this run isn't the approved check\./);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { outcome: string; modelHeld: boolean };
    assert.deepEqual([result.outcome, result.modelHeld], ["complete", false]);
  });

  it("sends no inference request when the listing lacks the approved model", async () => {
    const stub = await startStub({ models: [{ id: "nvidia/some-other-model" }], chat: (request) => COUNCIL[roleOf(request) ?? "chair"] });
    stubs.push(stub);
    const dir = folder();
    const { code } = await run(["--token-factory-url", stub.url, "--out", join(dir, "out"), "--home", join(dir, "home")]);
    assert.equal(code, 1);
    const result = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) as { status: string; error: string | null; served: unknown[] };
    assert.deepEqual([result.status, result.served.length], ["failed", 0]);
    assert.match(result.error ?? "", /may use only nvidia\/nemotron-3-super-120b-a12b/);
    assert.equal(stub.chats().length, 0, "no inference request was made");
  });
});
