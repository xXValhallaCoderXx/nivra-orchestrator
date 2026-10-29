import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { projectFingerprint, REF_FORMAT, type EnvironmentRef, type TaskEnvironment } from "@nivra/domain";
import { environmentInputs, setupConfiguration } from "../src/environment/inputs.ts";
import { isNodeSetupPath } from "../src/environment/node-files.ts";
import { ENV_PATH } from "../src/exec/nebius/sandbox.ts";
import { taskStopWords } from "../src/task/report.ts";
import type { ExecResult } from "../src/exec/backend.ts";
import { judgeBaseline } from "../src/task/harness.ts";
import { reserveMs, runNeedsMs, TASK_LIMITS } from "../src/task/limits.ts";
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

/** A fake clock a test can move on, as the timing tests' is. */
function movable() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms), advance: (ms: number) => void (now += ms), waits: [] as number[] };
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

describe("a baseline selection's judgement (D41)", () => {
  const ran = (stdout: string, exitCode: number | null = 0, extra: Partial<ExecResult> = {}) => ({ exitCode, stdout, stderr: "", stdoutExact: true, timedOut: false, cancelled: false, truncated: false, signal: null, durationMs: 5, persisted: false, ...extra }) as unknown as ExecResult;
  it("matches the exit code and the exact output, or the pattern over the whole output, and says why when it doesn't", () => {
    const pattern = { name: "p", command: "x", expectedExitCode: 1, outputPattern: "got: .*" };
    assert.deepEqual([judgeBaseline(1, REPRODUCED, ran("Hello, Ada\nHello, \n")).matched, judgeBaseline(1, pattern, ran("got: Hello\nHello, \n", 1)).matched], [true, true]);
    const cases: Array<[Parameters<typeof judgeBaseline>[1], ExecResult, string]> = [
      [REPRODUCED, ran("Hello, Ada\nHello, world\n"), "its output differs from the expected output at line 2"],
      [REPRODUCED, ran("Hello, Ada\nHello, \n", 2), "it exited 2, not 0"],
      [{ ...pattern, outputPattern: "got" }, ran("got: Hello\n", 1), "its output doesn't match the pattern"],
      [pattern, ran("x".repeat(20_000), 1), "its output is longer than Nivra matches a pattern against"],
      [REPRODUCED, ran("", null, { timedOut: true }), "it ran out of its 60 s"],
    ];
    for (const [given, result, reason] of cases) assert.deepEqual([judgeBaseline(1, given, result).matched, judgeBaseline(1, given, result).reason], [false, reason]);
    assert.equal(judgeBaseline(1, REPRODUCED, ran("", null, { cancelled: true })).matched, null, "a cancelled one didn't run to its end");
  });

  it("stops a pattern that backtracks without end at its time limit, and says so", () => {
    const started = performance.now();
    const judged = judgeBaseline(1, { name: "p", command: "x", expectedExitCode: 1, outputPattern: "(a+)+" }, ran(`${"a".repeat(40)}!`, 1));
    assert.deepEqual([judged.matched, judged.reason], [false, "matching its pattern took longer than 1 s, so it was stopped"]);
    assert.ok(performance.now() - started < 5_000, "the pattern wasn't stopped at its limit");
  });
});

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

  it("masks a baseline selection's output in the report bound into the proposal, as it masks every check's", async () => {
    const environment = await environmentFor(FILES, "base-image");
    // Prints a token's shape, made by the command so the brief never holds one.
    const printsToken = { name: "greets, then prints a token's shape", command: `. ./greet.sh; greet Ada; greet; printf 'ghp_%s\\n' "$(printf 'a1B2%.0s' 1 2 3 4 5 6 7 8 9)"`, expectedExitCode: 0, outputPattern: "Hello, Ada\\nHello, \\nghp_[A-Za-z0-9]{36}\\n" };
    const run = await attempt({ files: FILES, brief: { ...ENV_BRIEF, baseline: [printsToken] }, setup: prepared, extra: { environment, mask: (text: string) => text.replace(/ghp_[A-Za-z0-9]{36}/g, "[masked token]") } });
    assert.deepEqual([run.result.outcome, run.core!.baselineChecks.map((check) => check.matched)], ["proposed", [true]]);
    const report = new TextDecoder().decode(run.result.proposal!.report);
    assert.deepEqual([report.includes("ghp_a1B2"), report.includes("[masked token]")], [false, true], "the token's shape is in the proposal's report");
  });

  it("stops before the model when a baseline selection doesn't give what the brief expects, and says which and why", async () => {
    const environment = await environmentFor(FILES, "base-image");
    const wrong = { ...REPRODUCED, expectedOutput: "Hello, Ada\nHello, world\n" };
    const run = await attempt({ files: FILES, brief: { ...ENV_BRIEF, baseline: [wrong, CHECK_FAILS] }, setup: prepared, extra: { environment } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.requests()], ["refused", "baseline", 0]);
    assert.deepEqual(run.core!.baselineChecks.map((check) => [check.matched, check.reason]), [[false, "its output differs from the expected output at line 2"], [null, "the run stopped before it"]]);
    assert.equal(run.result.proposal, null);
  });

  it("keeps collect's and every final check's reserve when the baseline takes most of the session: the worker's window shrinks instead", async () => {
    const environment = await environmentFor(FILES, "base-image");
    const time = movable();
    let shown: Record<string, unknown> = {};
    let slowed = false;
    const run = await attempt({
      files: FILES,
      brief: ENV_BRIEF,
      setup: prepared,
      time,
      calls: [["edit_file", FIX]],
      extra: {
        environment,
        progress: (message, data) => {
          if (message.startsWith("Work window")) shown = data;
          // The first baseline selection has taken 300 s, with nothing under way between the two.
          if (message.startsWith("Baseline 1:")) {
            slowed = true;
            time.advance(300_000);
          }
        },
      },
    });
    assert.ok(slowed, "the baseline wasn't slowed");
    assert.deepEqual([run.result.outcome, run.core!.baselineChecks.map((check) => check.matched), verdicts(run.core), run.core!.verified], ["proposed", [true, true], ["case 1 passed", "check 1 passed"], true]);
    // The reserve is whole, and the baseline's time came out of the worker's window.
    const room = TASK_LIMITS.sessionMs - reserveMs(2);
    assert.equal(shown["reserveMs"], reserveMs(2));
    assert.ok(Number(shown["windowMs"]) <= room - 300_000 && Number(shown["windowMs"]) > room - 330_000, `a window of ${String(shown["windowMs"])} ms`);
  });

  it("stops before the model when the baseline leaves no time for its next selection outside the reserve, and says so", async () => {
    const environment = await environmentFor(FILES, "base-image");
    const time = movable();
    const run = await attempt({
      files: FILES,
      brief: ENV_BRIEF,
      setup: prepared,
      time,
      extra: {
        environment,
        // The first selection has taken all but a second less than an operation of the time before the reserve: what is
        // left can't hold another, however long the session is.
        progress: (message) => void (message.startsWith("Baseline 1:") && time.advance(TASK_LIMITS.sessionMs - reserveMs(2) - runNeedsMs() + 1_000)),
      },
    });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.stopped?.step, run.requests(), run.result.proposal], ["failed", "time", "baseline", 0, null]);
    assert.deepEqual(run.core!.baselineChecks.map((check) => [check.matched, check.reason]), [[true, null], [null, "there wasn't time left in the session for it"]]);
    assert.equal(run.guest.ran.filter((entry) => entry.label === "command").length, 1, "the second selection ran");
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

  it("refuses, before anything is sent, a commit that tracks files in a folder D41's sessions leave out, which a snapshot once left out without a word (NIV-55)", async () => {
    const files = { ...FILES, "dist/greet.js": "export const built = true;\n" };
    const run = await attempt({ files, brief: ENV_BRIEF, setup: prepared, extra: { environment: await environmentFor(files, "base-image") } });
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

/** A recipe's environment for a commit with these files (NIV-55), as its preparation would bind it. */
async function refFor(files: Record<string, string>, image: string): Promise<EnvironmentRef> {
  return {
    format: REF_FORMAT,
    recipe: "a".repeat(64),
    verified: "b".repeat(64),
    configuration: setupConfiguration(await snap(repoWith(files)), isNodeSetupPath).digest,
    image,
    projectFingerprint: await projectFingerprint(PROJECT),
    target: "local",
    tools: [
      { name: "node", version: "24.21.0" },
      { name: "pnpm", version: "11.5.3" },
    ],
    platform: { arch: "x86_64", libc: "musl" },
    env: { PATH: ENV_PATH, HOME: "/root", CI: "1", COREPACK_ENABLE_NETWORK: "0", pnpm_config_verify_deps_before_run: "false", pnpm_config_pm_on_fail: "ignore" },
    dependencyFolders: ["node_modules"],
    builds: null,
    preparedAt: "2026-10-28T10:00:00.000Z",
  };
}

describe("a task run from a recipe's environment (NIV-55)", () => {
  const spawns = (run: Awaited<ReturnType<typeof attempt>>) => run.guest.service.operations.map((operation) => operation.body);

  it("starts from its image with the recipe's task variables, leaves its dependency folders out, and proposes a verified change with the setup files unchanged", async () => {
    const environment = await refFor(FILES, "base-image");
    const run = await attempt({ files: FILES, brief: ENV_BRIEF, setup: prepared, extra: { environment } });
    assert.deepEqual([run.result.outcome, run.result.stopped], ["proposed", null]);
    assert.deepEqual([run.core!.environment, run.core!.environmentRef, run.core!.setup, run.core!.verified], [null, environment, { unchanged: true, changed: [] }, true]);
    // Every command the run sent carries the switches that stop installs and version changes.
    const commands = spawns(run).filter((body) => (body["args"] as string[] | undefined)?.[2] === undefined || !String((body["args"] as string[])[2]).startsWith("nivra-prepare"));
    assert.ok(commands.length > 2, "no commands were sent");
    assert.ok(
      commands.every((body) => (body["env"] as Record<string, string> | undefined)?.["COREPACK_ENABLE_NETWORK"] === "0"),
      "a command ran without the recipe's task variables",
    );
    assert.deepEqual((spawns(run)[0]!["args"] as string[]).slice(7), ["node_modules"], "the prepare step wasn't told to leave the dependency folder out");
    assert.deepEqual(run.result.proposal?.binding.paths.map((path) => path.path), ["greet.sh"]);
  });

  it("refuses the worker's writes to a setup file, a new one included, saying why", async () => {
    const environment = await refFor(FILES, "base-image");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["create_file", { path: "packages/extra/package.json", content: '{ "name": "extra" }\n' }],
      ["create_file", { path: ".nvmrc", content: "24.20.0\n" }],
      ["edit_file", { path: "package.json", old_text: '"private": true', new_text: '"private": false' }],
      ["edit_file", FIX],
      ["run_case", { number: 1 }],
    ];
    const run = await attempt({ files: FILES, brief: ENV_BRIEF, setup: prepared, extra: { environment }, calls });
    assert.deepEqual([run.result.outcome, run.core!.worker.tools.refused, run.core!.worker.written, run.core!.verified], ["proposed", 3, ["greet.sh"], true]);
    assert.ok(run.prompts().some((prompt) => prompt.includes("is one of the setup files the project's environment was prepared from, so a task can't create or change it")), "the refusal's words didn't reach the worker");
  });

  it("refuses, before anything is sent, a commit whose setup files aren't the ones its recipe was prepared from", async () => {
    const environment = await refFor(FILES, "base-image");
    const run = await attempt({ files: { ...FILES, ".nvmrc": "24.20.0\n" }, brief: ENV_BRIEF, setup: prepared, extra: { environment } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.guest.ran.length, run.requests()], ["refused", "environment", 0, 0]);
  });

  it("refuses, before anything is sent, a commit whose setup file is a link, though its setup digest matches the recipe's", async () => {
    // Nate's review of PR 36: a package.json holding {} and a package.json linking to a file named {} digest alike, and
    // the worker could then edit the effective manifest through the link's target, which isn't a setup file.
    const plain = { ...FILES, "package.json": "{}" };
    const linked = { ...FILES, "package.json": { link: "{}" }, "{}": json({ name: "greet", private: true, scripts: { postinstall: "node build.js" } }) };
    const environment = await refFor(plain, "base-image");
    assert.equal(setupConfiguration(await snap(repoWith(linked)), isNodeSetupPath).digest, environment.configuration, "the two commits' setup digests match");
    const run = await attempt({ files: linked, brief: ENV_BRIEF, setup: prepared, extra: { environment } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.guest.ran.length, run.requests()], ["refused", "environment", 0, 0]);
  });

  it("refuses, before anything is sent, a commit that tracks files in the recipe's dependency folders", async () => {
    const files = { ...FILES, "node_modules/left/index.js": "module.exports = 1;\n" };
    const run = await attempt({ files, brief: ENV_BRIEF, setup: prepared, extra: { environment: await refFor(files, "base-image") } });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.guest.ran.length, run.requests()], ["refused", "environment", 0, 0]);
  });

  it("lets the worker edit a tracked file under a folder named like build output, which the change then holds", async () => {
    const files = { ...FILES, "dist/greet.txt": "Hello, world\n" };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["edit_file", { path: "dist/greet.txt", old_text: "world", new_text: "everyone" }],
      ["edit_file", FIX],
      ["run_case", { number: 1 }],
    ];
    const run = await attempt({ files, brief: ENV_BRIEF, setup: prepared, extra: { environment: await refFor(files, "base-image") }, calls });
    assert.deepEqual([run.result.outcome, run.core!.worker.written, run.core!.verified], ["proposed", ["dist/greet.txt", "greet.sh"], true]);
    assert.deepEqual(run.result.proposal?.binding.paths.map((path) => path.path), ["dist/greet.txt", "greet.sh"]);
  });

  it("stops when the recipe's image is gone from Nebius, before the model, and says to prepare the environment again", async () => {
    const environment = await refFor(FILES, "base-image");
    const run = await attempt({
      files: FILES,
      brief: ENV_BRIEF,
      setup: (guest) => {
        prepared(guest);
        guest.service.expiredImages.add(guest.baseImage);
      },
      extra: { environment },
    });
    assert.deepEqual([run.result.outcome, run.result.stopped?.code, run.result.stopped?.step, run.requests(), run.result.proposal], ["failed", "environment-missing", "open", 0, null]);
    assert.match(taskStopWords("environment-missing", "open"), /^The project's prepared environment is no longer in your Nebius project, so the run stopped and nothing was proposed\. .*Prepare the environment again, then run the task again\.$/);
  });
});
