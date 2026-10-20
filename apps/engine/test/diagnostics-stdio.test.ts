import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { isTerminal, RpcCallError, type RunContext, type RunEventsPage } from "@nivra/domain";
import { EXEC_REFUSED_MESSAGE } from "../src/diagnostics.ts";
import { impureLines, makeRepo, removeDir, startEngine, tempDir, type EngineProcess } from "./helpers.ts";
import { httpError, startStub, type Stub } from "./stub-token-factory.ts";

/**
 * Safe diagnostics through a real engine over stdio (NIV-27, D29). The original reproduction: a key holding a newline
 * makes `fetch` throw a TypeError whose message quotes the key. And text masking can't catch: private text in git's
 * stderr, and in the path of a git that can't start. Each failure leaves Nivra's own words in the run, the answer and
 * the stores, and one diagnostic line in the log that says what kind of failure it was, never what the error said.
 */
const engines: EngineProcess[] = [];
const stubs: Stub[] = [];
const dirs: string[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all(stubs.map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});

const context: RunContext = { preferences: { revision: 0, records: [] }, sharing: { modelContext: true } };
const failureOf = (page: RunEventsPage) => page.events.find((event) => event.type === "run.failed");
/** The diagnostic lines the engine wrote to its log, parsed. */
const diagnosticsOf = (engine: EngineProcess) =>
  engine
    .stderr()
    .split("\n")
    .filter((line) => line.includes(" diagnostic {"))
    .map((line) => JSON.parse(line.slice(line.indexOf("diagnostic {") + "diagnostic ".length)) as Record<string, unknown>);
/** Every file in the engine's home that holds `needle`, once it has shut down. */
const filesHolding = (home: string, needle: string) => readdirSync(home).filter((file) => readFileSync(join(home, file)).includes(needle));

async function startAt(root: string, url: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  const home = join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", url], ...options });
  engines.push(engine);
  return { engine, home };
}

async function explainFails(engine: EngineProcess, repo: string) {
  const clientRequestId = randomUUID();
  const run = await engine.client.call("runs.start", { clientRequestId, workflowId: "explain", input: { repoPath: repo, question: "", choices: [] }, context });
  const page = await engine.waitForRun(run.id, (events) => isTerminal(events.status), 30_000);
  return { run, page, clientRequestId, summary: await engine.client.call("runs.get", { runId: run.id }) };
}

describe("safe diagnostics through a real engine (NIV-27)", () => {
  it("answers the header reproduction in Nivra's words, logs two bounded diagnostics, and keeps the key out of every store", async () => {
    const root = tempDir();
    dirs.push(root);
    const repo = makeRepo(root);
    const head = `nivra-header-canary-${randomUUID()}`;
    const tail = `nivra-header-canary-tail-${randomUUID()}`;
    // About 4,000 characters with a newline in it: Node's Headers refuses it, quoting the whole value.
    const key = `${head}${"x".repeat(3_800)}\n${tail}`;
    const stub = await startStub({ chat: () => httpError(500, "never") });
    stubs.push(stub);
    const { engine, home } = await startAt(root, stub.url);
    await engine.initialize({ NEBIUS_API_KEY: key });

    const answered = await engine.client.call("providers.check", {}).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(answered instanceof RpcCallError, "providers.check fails");
    assert.deepEqual([answered.code, answered.data], [-32603, { kind: "internal" }]);
    assert.match(answered.message, /^Something inside Nivra failed \(TypeError\)\. Try again/);

    const { run, page, clientRequestId, summary } = await explainFails(engine, repo);
    assert.deepEqual([page.status, failureOf(page)?.data?.["kind"]], ["failed", "internal"]);
    assert.match(summary.error ?? "", /^Something inside Nivra failed \(TypeError\)\. Try again/);
    assert.equal(stub.requests.length, 0, "the request was never made");

    const diagnostics = diagnosticsOf(engine);
    assert.equal(diagnostics.length, 2, engine.stderr());
    const [check, explained] = diagnostics;
    assert.deepEqual(
      [check?.["code"], check?.["stage"], check?.["kind"], check?.["method"], typeof check?.["rpc"]],
      ["unexpected-error", "models.list", "internal", "providers.check", "number"],
    );
    assert.deepEqual(
      [explained?.["code"], explained?.["stage"], explained?.["run"], explained?.["request"], explained?.["workflow"], explained?.["step"]],
      ["unexpected-error", "models.list", run.id, clientRequestId, "explain", "prepare"],
    );
    for (const diagnostic of diagnostics) {
      const error = diagnostic["error"] as { classes: string[]; messageChars: number };
      assert.deepEqual([error.classes[0], error.messageChars > 3_800], ["TypeError", true], "the error is named by its class and measured, never quoted");
    }

    await engine.client.call("shutdown", {});
    await engine.exited;
    for (const needle of [head, tail]) {
      assert.deepEqual(filesHolding(home, needle), [], "no part of the key in any file of the home");
      assert.equal(engine.stderr().includes(needle), false, "nor in the log");
      assert.equal(JSON.stringify([answered.message, answered.data, summary, page]).includes(needle), false, "nor in the answer or the run's record");
    }
    assert.deepEqual([impureLines(engine.lines), engine.protocolErrors], [[], []], "stdout carried JSON-RPC alone");
  });

  it("keeps private text from git's stderr, and from the path of a git that can't start, out of the run, the stores and the log", async () => {
    const root = tempDir();
    dirs.push(root);
    const repo = makeRepo(root);
    const stub = await startStub({ chat: () => httpError(500, "never") });
    stubs.push(stub);
    const secretless = `Private repository text ${randomUUID()}`;

    // A git that fails as git does, saying private things on stderr: no key pattern and no known value, so masking keeps them.
    const failing = join(root, "failing-bin");
    mkdirSync(failing);
    writeFileSync(join(failing, "git"), `#!/bin/sh\necho "fatal: unable to read ${secretless}" >&2\nexit 128\n`, { mode: 0o755 });
    // A git that can't start at all, in a folder whose name is private: the spawn error quotes the path.
    const unstartable = join(root, `bin ${secretless}`);
    mkdirSync(unstartable);
    writeFileSync(join(unstartable, "git"), "#!/nonexistent/interpreter\n", { mode: 0o755 });

    const cases = [
      { bin: failing, message: /^git (ls-files|rev-parse) failed \(exit 128\)\. /, code: "git-failed" },
      { bin: unstartable, message: new RegExp(`^${EXEC_REFUSED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), code: "exec-refused" },
    ];
    for (const { bin, message, code } of cases) {
      const caseRoot = join(root, `case-${code}`);
      mkdirSync(caseRoot);
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` };
      const { engine, home } = await startAt(caseRoot, stub.url, { env });
      await engine.initialize({ NEBIUS_API_KEY: "test-key-0123456789abcdef" });
      const { page, summary } = await explainFails(engine, repo);
      assert.equal(page.status, "failed", page.events.map((e) => e.message).join(" | "));
      assert.match(summary.error ?? "", message);
      const diagnostics = diagnosticsOf(engine);
      assert.deepEqual(diagnostics.map((d) => [d["code"], d["workflow"]]), [[code, "explain"]], engine.stderr());

      await engine.client.call("shutdown", {});
      await engine.exited;
      assert.deepEqual(filesHolding(home, secretless), [], `${code}: nothing private in any file of the home`);
      assert.equal(engine.stderr().includes(secretless), false, `${code}: nor in the log`);
      assert.equal(JSON.stringify([summary, page]).includes(secretless), false, `${code}: nor in the run's record`);
    }
    assert.equal(stub.chats().length, 0);
  });
});
