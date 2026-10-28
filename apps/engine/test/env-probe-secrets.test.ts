import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanUp, git, repoWith, scratch } from "./workspace-fixtures.ts";

/**
 * The environment probe's run refuses to send a commit or a preparation input holding the Nebius key it reads, whatever
 * the key looks like (D34): an arbitrary-format synthetic key, with no shape a pattern knows, inside a line of other
 * text. It refuses before anything is sent, names the file, and never says the value. The project id only names the
 * account, so a commit naming it isn't refused. The script runs as itself, with a home of its own and an approval that
 * can never match, so a run that passes every check still stops before any request.
 */
after(cleanUp);

const SCRIPT = fileURLToPath(new URL("../scripts/env-probe.ts", import.meta.url));
const KEY = "q7Lm.synthetic+nebius/value=4f2c-09";
const PROJECT = "project-e00probesecrets";
const NEVER_APPROVED = "0".repeat(64);
const IMAGE = {
  tag: "node:22.23.4-alpine3.24",
  tagPrefix: "node:22",
  registryUrl: "docker://docker.io/library/node:22.23.4-alpine3.24",
  registryDigest: `sha256:${"a".repeat(64)}`,
  node: "v22.23.4",
};

/** A small pnpm project; `over` adds or replaces files. */
function project(over: Record<string, string>): { repo: string; baseline: string } {
  const repo = repoWith({
    "package.json": `${JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@11.5.3" })}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/a/package.json": `${JSON.stringify({ name: "a", private: true })}\n`,
    "config/app.ini": "[service]\nurl=https://example.invalid/v1\n",
    ...over,
  });
  return { repo, baseline: git(repo, ["rev-parse", "HEAD"]).trim() };
}

/** Runs the probe's --run against `repo` with its own home, and says how it stopped. */
function run(repo: string, baseline: string) {
  const root = scratch("env probe secrets");
  const home = join(root, "home");
  mkdirSync(home);
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      repository: repo,
      baseline,
      image: IMAGE,
      packageManager: "pnpm@11.5.3",
      installArgs: ["--frozen-lockfile", "--filter", "a..."],
      inputs: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/*/package.json"],
      dependencyFolders: ["node_modules"],
      selections: [{ name: "a", command: "echo ok", exitCode: 0, output: "ok\n" }],
      frozen: [],
    }),
  );
  const credentials = join(root, "credentials.env");
  writeFileSync(credentials, `NEBIUS_API_KEY=${KEY}\nNEBIUS_PROJECT_ID=${PROJECT}\n`);
  chmodSync(credentials, 0o600);
  const evidence = join(home, "evidence");
  const ran = spawnSync(process.execPath, [SCRIPT, "--config", config, "--credentials", credentials, "--run", "--approved", NEVER_APPROVED, "--evidence", evidence], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 60_000,
  });
  return { status: ran.status, said: `${ran.stdout}${ran.stderr}`, evidence };
}

const inLine = (value: string) => `[service]\nurl=https://example.invalid/v1?token=${value}&mode=1\n`;

describe("the environment probe's run and the key it reads (D34)", () => {
  it("refuses a commit holding the key in a tracked file, naming the file and never the value, before anything is sent", () => {
    const { repo, baseline } = project({ "config/app.ini": inLine(KEY) });
    const { status, said, evidence } = run(repo, baseline);
    assert.equal(status, 2);
    assert.match(said, /config\/app\.ini in this commit holds what looks like a value Nivra keeps as a secret, so Nivra won't upload it\..* Nothing was sent\./);
    assert.equal(said.includes(KEY), false, "the value is never said");
    assert.equal(existsSync(evidence), false, "no run folder was made");
  });

  it("refuses a preparation input holding the key, naming the input and never the value, before anything is sent", () => {
    const manifest = `${JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@11.5.3", description: `mirror at https://example.invalid/v1?token=${KEY}&mode=1` })}\n`;
    const { repo, baseline } = project({ "package.json": manifest });
    const { status, said } = run(repo, baseline);
    assert.equal(status, 2);
    assert.match(said, /The input package\.json holds what looks like a value Nivra keeps as a secret, so Nivra won't send it\..* Nothing was sent\./);
    assert.equal(said.includes(KEY), false);
  });

  it("passes a commit naming only the project id, and one with neither, to the checks after the scan, still sending nothing", () => {
    for (const ini of [inLine(PROJECT), "[service]\nurl=https://example.invalid/v1\n"]) {
      const { repo, baseline } = project({ "config/app.ini": ini });
      const { status, said, evidence } = run(repo, baseline);
      assert.equal(status, 2);
      assert.doesNotMatch(said, /holds what looks like/);
      assert.match(said, /Nothing was sent\./);
      assert.equal(existsSync(evidence), false);
    }
  });
});
