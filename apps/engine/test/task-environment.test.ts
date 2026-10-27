import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { projectFingerprint, type TaskEnvironment } from "@nivra/domain";
import { environmentInputs } from "../src/environment/inputs.ts";
import { attempt, BRIEF, FIX, FIXTURE, PROJECT, verdicts } from "./task-fixtures.ts";
import { cleanUp, repoWith, scratch, snap } from "./workspace-fixtures.ts";

/**
 * A task run bound to a prepared environment (NIV-49, D41), on the production session and prescribed path, against the
 * fake Nebius service with a guest that really runs each command. The prepared image already holds node_modules:
 * - the run starts from it;
 * - the baseline selections run before the model, the fixture's bug reproduced as the brief says;
 * - frozen files and the environment's manifests refuse the worker's writes, and frozen files are compared after
 *   collect;
 * - a commit or a brief that doesn't fit is refused before anything is sent.
 */
after(cleanUp);

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const FILES = { ...FIXTURE, "package.json": json({ name: "greet", private: true, packageManager: "pnpm@11.5.3" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" };
/** The fixture's bug, reproduced: greet with no name says "Hello, " until the fix. */
const REPRODUCED = { name: "greet with no name says Hello, and nothing more", command: ". ./greet.sh; greet Ada; greet", expectedExitCode: 0, expectedOutput: "Hello, Ada\nHello, \n" };
const CHECK_FAILS = { name: "check.sh fails for the bug", command: "/bin/sh check.sh", expectedExitCode: 1, outputPattern: "^got: Hello, Ada\\nHello, \\n$" };
const ENV_BRIEF = { ...BRIEF, baseline: [REPRODUCED, CHECK_FAILS], frozen: ["check.sh"] };

async function environmentFor(files: Record<string, string>, image: string): Promise<TaskEnvironment> {
  return { image, inputsDigest: environmentInputs(await snap(repoWith(files))).digest, projectFingerprint: await projectFingerprint(PROJECT), node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64" };
}

/** The guest's base image, prepared: its workspace holds the manifests and node_modules, as a preparation leaves it. */
function prepared(guest: { baseImage: string; images: Map<string, string> }): void {
  const folder = scratch("prepared image");
  mkdirSync(join(folder, "workspace", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(folder, "workspace", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(folder, "workspace", "package.json"), FILES["package.json"]);
  writeFileSync(join(folder, "workspace", "pnpm-lock.yaml"), FILES["pnpm-lock.yaml"]);
  guest.images.set(guest.baseImage, folder);
}

describe("a task run from a prepared environment (NIV-49, D41)", () => {
  it("starts from the prepared image, reproduces the bug as the baseline says before the model, and proposes a verified change with the frozen file unchanged", async () => {
    const environment = await environmentFor(FILES, "base-image");
    const run = await attempt({ files: FILES, brief: ENV_BRIEF, setup: prepared, extra: { environment } });
    assert.deepEqual([run.result.outcome, run.result.stopped], ["proposed", null]);
    assert.deepEqual(run.core!.baselineChecks.map((check) => [check.number, check.matched, check.reason]), [[1, true, null], [2, true, null]]);
    assert.deepEqual([run.core!.frozen, run.core!.environment, run.core!.verified, verdicts(run.core)], [[{ path: "check.sh", unchanged: true }], environment, true, ["case 1 passed", "check 1 passed"]]);
    // Both selections ran before the worker's first request: each before any write.
    const ran = run.guest.ran.map((entry) => entry.label);
    assert.deepEqual(ran.slice(0, 4), ["nivra-prepare", "nivra-toolchain", "command", "command"]);
    assert.ok(ran.indexOf("nivra-write") > 3, "a write came before the baseline");
    assert.deepEqual(run.result.proposal?.binding.paths.map((path) => path.path), ["greet.sh"], "node_modules or a manifest came back in the change");
  });

  it("stops before the model when a baseline selection doesn't give what the brief expects, and says which and why", async () => {
    const environment = await environmentFor(FILES, "base-image");
    const wrong = { ...REPRODUCED, expectedOutput: "Hello, Ada\nHello, world\n" };
    const run = await attempt({ files: FILES, brief: { ...ENV_BRIEF, baseline: [wrong, CHECK_FAILS] }, setup: prepared, extra: { environment } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.requests()], ["refused", "baseline", 0]);
    assert.deepEqual(run.core!.baselineChecks.map((check) => [check.matched, check.reason]), [[false, "its output differs from the expected output at line 2"], [null, "the run stopped before it"]]);
    assert.equal(run.result.proposal, null);
  });

  it("refuses the worker's writes to a frozen file and to a file the environment was prepared from, saying why", async () => {
    const environment = await environmentFor(FILES, "base-image");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["edit_file", { path: "check.sh", old_text: "exit 1", new_text: "exit 0" }],
      ["edit_file", { path: "package.json", old_text: '"private": true', new_text: '"private": false' }],
      ["edit_file", FIX],
      ["run_case", { number: 1 }],
    ];
    const run = await attempt({ files: FILES, brief: ENV_BRIEF, setup: prepared, extra: { environment }, calls });
    assert.deepEqual([run.result.outcome, run.core!.worker.tools.refused, run.core!.worker.written, run.core!.verified], ["proposed", 2, ["greet.sh"], true]);
  });

  it("refuses, before anything is sent, a commit whose manifests aren't the ones its environment was prepared from", async () => {
    const environment = await environmentFor({ ...FILES, "package.json": json({ name: "greet", private: true, packageManager: "pnpm@11.5.2" }) }, "base-image");
    const run = await attempt({ files: FILES, brief: ENV_BRIEF, setup: prepared, extra: { environment } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.guest.ran.length, run.requests()], ["refused", "environment", 0, 0]);
  });

  it("refuses, before anything is sent, a brief that freezes a file the commit doesn't hold", async () => {
    const run = await attempt({ files: FILES, brief: { ...ENV_BRIEF, frozen: ["tests/missing.test.ts"] }, setup: prepared, extra: { environment: await environmentFor(FILES, "base-image") } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.guest.ran.length], ["refused", "frozen", 0]);
  });

  it("never proposes a verified change when a frozen file comes back changed: what Nivra didn't write refuses the result", async () => {
    const environment = await environmentFor(FILES, "base-image");
    const run = await attempt({
      files: FILES,
      brief: ENV_BRIEF,
      setup: (guest) => {
        prepared(guest);
        // The sandbox changes the frozen check after the worker's write, as a test that rewrote itself would.
        guest.alter = ({ label }, folder) => {
          if (label === "nivra-write") writeFileSync(join(folder, "workspace", "check.sh"), "echo ok\n");
        };
      },
      extra: { environment },
    });
    assert.notEqual(run.result.outcome, "proposed");
    assert.equal(run.result.proposal, null);
  });
});
