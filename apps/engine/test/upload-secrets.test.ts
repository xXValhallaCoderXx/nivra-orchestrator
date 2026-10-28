import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { credentialKinds } from "../src/exec/snapshot.ts";
import { TASK_BRIEF, TASK_FIXTURE } from "../scripts/task-fixture.ts";
import { removeDir, startEngine, tempDir, type EngineProcess } from "./helpers.ts";
import { startSandboxStub, type SandboxStub } from "./stub-sandboxes.ts";
import { startStub, type Stub } from "./stub-token-factory.ts";
import { cleanUp, repoWith } from "./workspace-fixtures.ts";

/**
 * Every path that uploads a commit refuses one holding a key the vault keeps (D34, D36, D37), whatever the key looks
 * like: an arbitrary-format Nebius key and Tavily key, with no shape a pattern knows, each inside a line of other text.
 * The sandbox check's preview, the task's and the environment's resolution each refuse it, name the file, and never
 * say the value. The project id only names the account the upload goes to, so a commit naming it isn't refused.
 */

const NEBIUS_KEY = "q7Lm.synthetic+nebius/value=4f2c-09";
const TAVILY_KEY = "wv3R~synthetic_tavily:91d0|c6e2";
const PROJECT_ID = "project-e00uploadsecretstest";
const SECRETS = { NEBIUS_API_KEY: NEBIUS_KEY, NEBIUS_PROJECT_ID: PROJECT_ID, TAVILY_API_KEY: TAVILY_KEY };

const dirs: string[] = [];
const engines: EngineProcess[] = [];
const stubs: Array<SandboxStub | Stub> = [];
after(async () => {
  for (const engine of engines) engine.kill();
  for (const stub of stubs) await stub.close();
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});

async function engineWithSecrets(): Promise<EngineProcess> {
  const sandbox = await startSandboxStub();
  const model = await startStub();
  stubs.push(sandbox, model);
  const root = tempDir("nivra upload secrets");
  dirs.push(root);
  const home = join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--sandboxes-url", sandbox.url, "--token-factory-url", model.url] });
  engines.push(engine);
  await engine.initialize(SECRETS);
  return engine;
}

const fixture = Object.fromEntries(TASK_FIXTURE.map((file) => [file.path, String(file.bytes)]));
/** The task fixture's commit, with one more file holding `value` inside a line of other text. */
const holding = (value: string) => repoWith({ ...fixture, "config/app.ini": `[service]\nurl=https://example.invalid/v1?token=${value}&mode=1\n` });

/** Each upload path's own preview of a commit, as the host asks for it. */
const PATHS: Array<[string, (engine: EngineProcess, repoPath: string) => Promise<unknown>]> = [
  ["the sandbox check", (engine, repoPath) => engine.client.call("sandbox.preview", { repoPath })],
  ["the task run", (engine, repoPath) => engine.client.call("task.preview", { repoPath, brief: TASK_BRIEF })],
  ["the environment's preparation", (engine, repoPath) => engine.client.call("environment.resolve", { repoPath, choices: {}, previous: null })],
];

const REFUSAL = /config\/app\.ini in this commit holds what looks like a value Nivra keeps as a secret/;

describe("every upload path refuses a commit holding a key the vault keeps, whatever its shape (D34, D37)", () => {
  it("finds no shape in the synthetic keys, so only the vault's own values can catch them", () => {
    for (const value of [NEBIUS_KEY, TAVILY_KEY]) assert.deepEqual(credentialKinds(Buffer.from(`url=https://example.invalid/v1?token=${value}&mode=1\n`)), [], value);
  });

  for (const [name, value] of [["Nebius key", NEBIUS_KEY], ["Tavily key", TAVILY_KEY]] as const) {
    it(`refuses the saved ${name} inside other text on every upload path, naming the file and never the value`, async () => {
      const engine = await engineWithSecrets();
      const repo = holding(value);
      const seen: string[] = [];
      for (const [path, preview] of PATHS) {
        const answer = JSON.stringify(await preview(engine, repo));
        seen.push(`${path}: ${REFUSAL.test(answer) ? "refused" : "not refused"}${answer.includes(value) ? ", saying the value" : ""}`);
      }
      assert.deepEqual(seen, PATHS.map(([path]) => `${path}: refused`));
    });
  }

  it("doesn't refuse a commit for naming the project id, on any upload path", async () => {
    const engine = await engineWithSecrets();
    const repo = holding(PROJECT_ID);
    const seen: string[] = [];
    for (const [path, preview] of PATHS) seen.push(`${path}: ${REFUSAL.test(JSON.stringify(await preview(engine, repo))) ? "refused" : "not refused"}`);
    assert.deepEqual(seen, PATHS.map(([path]) => `${path}: not refused`));
  });
});
