import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { TASK_MODEL } from "@nivra/domain";
import { environmentRefOf } from "../src/main/host.ts";
import { taskRunFingerprint } from "../src/main/tasks.ts";
import { preparedOf } from "./fixtures/environment-recipe.ts";
import { hashRuntime } from "../scripts/runtime-files.ts";
import { buildChanges, buildHashes, previewProblems, type ApprovedRun } from "../scripts/task-live-checks.ts";

/**
 * What the live run's script checks before it trusts a frozen build or presses Start (NIV-35): every file of the build
 * hashed again, never taken from its manifest, and the run's preview compared with what the recipe approved.
 */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** An unpacked build with a staged runtime whose manifest names its files, as staging writes it. */
function build(): string {
  const folder = mkdtempSync(join(tmpdir(), "nivra live build "));
  dirs.push(folder);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  };
  write("nivra", "the executable");
  write("resources/app.asar", "the app");
  write("locales/en-US.pak", "strings");
  write("resources/runtime/linux-x64/engine/main.mjs", "the engine");
  write("resources/runtime/linux-x64/node/bin/node", "node");
  const runtime = join(folder, "resources", "runtime", "linux-x64");
  const { sha256, files, contentHash } = hashRuntime(runtime);
  write("resources/runtime/linux-x64/engine/manifest.json", JSON.stringify({ contentHash, sha256, files }));
  return folder;
}

describe("the live run's frozen build (NIV-35)", () => {
  it("refuses a runtime whose files changed while its manifest didn't", () => {
    const folder = build();
    buildHashes(folder);
    writeFileSync(join(folder, "resources", "runtime", "linux-x64", "engine", "main.mjs"), "the engine, changed");
    assert.throws(() => buildHashes(folder), /runtime files hash to [0-9a-f]{16} \(2 files\), not what its manifest names/);
  });

  it("names each part that changed since the build was frozen: the runtime with its manifest, or any other file", () => {
    const folder = build();
    const frozen = buildHashes(folder);
    assert.deepEqual(buildChanges(frozen, buildHashes(folder)), []);
    writeFileSync(join(folder, "locales", "en-US.pak"), "strings, changed");
    assert.deepEqual(buildChanges(frozen, buildHashes(folder)), ["treeSha256"]);
    // A runtime file and its manifest changed together still differ from what was frozen.
    const runtime = join(folder, "resources", "runtime", "linux-x64");
    writeFileSync(join(runtime, "engine", "main.mjs"), "the engine, changed");
    const { sha256, files, contentHash } = hashRuntime(runtime);
    writeFileSync(join(runtime, "engine", "manifest.json"), JSON.stringify({ contentHash, sha256, files }));
    assert.deepEqual(buildChanges(frozen, buildHashes(folder)), ["runtimeContentHash", "runtimeSha256", "runtimeManifestSha256", "treeSha256"]);
  });
});

/** A recipe's environment, as a preparation that ended prepared leaves it (NIV-55). */
const PREPARED = await preparedOf("image-1");

describe("the live run's preview, before Start (NIV-35)", () => {
  const ids = { taskId: "task-1", briefId: "brief-1", briefVersion: 1, projectId: "project-1", targetId: "local" };
  const prepared = PREPARED;
  const approved: ApprovedRun = { baseline: "a".repeat(40), snapshotFingerprint: "b".repeat(64), briefDigest: "c".repeat(64), frozen: [{ path: "tests/she65.test.ts", sha256: "d".repeat(64) }], configuration: prepared.recipe.configuration.digest };
  const ref = environmentRefOf(prepared, null, ids.targetId);
  /** The fingerprint the host works out, from what the app holds. */
  const hostExpected = (parts: { briefDigest?: string; snapshot?: string; environment?: typeof ref | null }) =>
    taskRunFingerprint({ ...ids, briefDigest: parts.briefDigest ?? approved.briefDigest, sharing: { modelContext: true, cloudExecution: true }, snapshot: parts.snapshot ?? approved.snapshotFingerprint, environment: parts.environment === undefined ? ref : parts.environment });
  /** What the app's preview says goes to each service: the build's own words, the model among them. */
  const SENDS = { tokenFactory: ["The brief.", `All of it to one model, ${TASK_MODEL}. If Token Factory doesn't offer your key that model, the run stops before any request to a model; no other model stands in.`], nebius: ["The commit's files."] };
  const structured = (change: Partial<{ expected: string; snapshotFingerprint: string; baseline: string; frozen: Array<{ path: string; sha256: string | null }>; environment: Partial<typeof ref> | null; sends: typeof SENDS }> = {}) => ({
    expected: change.expected ?? hostExpected({}),
    snapshotFingerprint: change.snapshotFingerprint ?? approved.snapshotFingerprint,
    snapshot: { baseline: change.baseline ?? approved.baseline } as never,
    frozen: change.frozen ?? approved.frozen,
    environment: (change.environment === undefined ? ref : change.environment === null ? null : { ...ref, ...change.environment }) as never,
    sends: change.sends ?? SENDS,
  });
  const problems = (shownExpected: string, given: ReturnType<typeof structured>, environment: typeof prepared | null = prepared) => previewProblems({ approved, ids, prepared: environment, shownExpected, structured: given });

  it("takes the approved run: this brief, this commit's snapshot, the environment just prepared and the frozen files", () => {
    assert.deepEqual(problems(hostExpected({}), structured()), []);
    // The rehearsal's form: no environment prepared, so the run's fingerprint is v1.
    assert.deepEqual(problems(hostExpected({ environment: null }), structured({ expected: hostExpected({ environment: null }), environment: null }), null), []);
  });

  it("refuses a checkout moved to another clean commit after the approval, whatever else matches", () => {
    const moved = hostExpected({ snapshot: "9".repeat(64) });
    assert.deepEqual(problems(moved, structured({ expected: moved, snapshotFingerprint: "9".repeat(64), baseline: "8".repeat(40) })), [
      "the window's preview isn't bound to the approved brief, commit and environment",
      "the app's preview isn't bound to the approved brief, commit and environment",
      `the snapshot is ${"9".repeat(64)}, not the approved ${"b".repeat(64)}`,
      `the commit is ${"8".repeat(40)}, not the approved ${"a".repeat(40)}`,
    ]);
  });

  it("refuses another brief, other frozen hashes, another environment, and a window bound to something else", () => {
    const otherBrief = hostExpected({ briefDigest: "0".repeat(64) });
    assert.equal(problems(otherBrief, structured({ expected: otherBrief })).length, 2);
    assert.deepEqual(problems(hostExpected({}), structured({ frozen: [{ path: "tests/she65.test.ts", sha256: "1".repeat(64) }] })), ["the frozen files or their hashes aren't the approved ones"]);
    assert.deepEqual(problems(hostExpected({}), structured({ environment: { image: "image-2" } })), ["the run doesn't start from the environment just prepared"]);
    assert.deepEqual(problems(hostExpected({}), structured({ environment: { verified: "2".repeat(64) } })), ["the run doesn't start from the environment just prepared"]);
    assert.deepEqual(problems(hostExpected({}), structured({ environment: { configuration: "9".repeat(64) } })), ["the environment's setup files aren't the approved ones"]);
    assert.deepEqual(problems("3".repeat(64), structured()), ["the window's preview isn't bound to the approved brief, commit and environment"]);
  });

  it("refuses a build whose own preview doesn't name the one model the recipe allows: a build from before that rule would take whichever model the listing offered", () => {
    assert.deepEqual(problems(hostExpected({}), structured({ sends: { tokenFactory: ["The brief."], nebius: ["The commit's files."] } })), [`the app's preview doesn't name ${TASK_MODEL}, the one model the recipe allows`]);
  });
});
