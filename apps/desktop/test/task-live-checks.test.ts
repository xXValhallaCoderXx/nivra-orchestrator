import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { TASK_MODEL } from "@nivra/domain";
import { environmentRefOf } from "../src/main/host.ts";
import { taskRunFingerprint } from "../src/main/tasks.ts";
import { preparedOf } from "./fixtures/environment-recipe.ts";
import { hashRuntime } from "../scripts/runtime-files.ts";
import { claimApproval, claimOn } from "../../engine/scripts/research-check/claim.ts";
import { ENVIRONMENT_STOP_MESSAGES } from "../../engine/src/environment/report.ts";
import type { EnvironmentView } from "../src/shared/ipc.ts";
import { buildChanges, buildHashes, closedThen, liveFolders, previewProblems, stopProblems, type ApprovedRun, type ExpectedStop } from "../scripts/task-live-checks.ts";

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

describe("the folders a live run writes (NIV-55)", () => {
  // A home of the test's own, so nothing here comes near the real ~/nivra-acceptance.
  const home = mkdtempSync(join(tmpdir(), "nivra live home "));
  const repository = mkdtempSync(join(tmpdir(), "nivra live repository "));
  // Another checkout of Nivra's repository, as candidate 3's worktree is.
  const worktree = mkdtempSync(join(tmpdir(), "nivra live candidate worktree "));
  dirs.push(home, repository, worktree);
  const checkouts = [repository, worktree];
  const take = join(home, "nivra-acceptance", "task-live");
  const claims = join(home, "nivra-acceptance", "claims", "task-live");
  mkdirSync(take, { recursive: true });

  it("needs a state folder of its own, never candidate 3's take, the claims or any of Nivra's checkouts", () => {
    assert.throws(() => liveFolders(undefined, home, checkouts), /--state <folder> is required/);
    for (const folder of [take, join(take, "frozen-x"), join(home, "nivra-acceptance")]) assert.throws(() => liveFolders(folder, home, checkouts), /candidate 3's frozen take/, folder);
    for (const folder of [claims, join(claims, "x"), join(home, "nivra-acceptance", "claims")]) assert.throws(() => liveFolders(folder, home, checkouts), /the approvals' claims/, folder);
    for (const folder of [join(repository, "evidence"), join(worktree, "evidence"), worktree]) assert.throws(() => liveFolders(folder, home, checkouts), /one of Nivra's checkouts/, folder);
    // A link that leads into the take is the take.
    symlinkSync(take, join(home, "a link"));
    assert.throws(() => liveFolders(join(home, "a link", "x"), home, checkouts), /candidate 3's frozen take/);
    assert.deepEqual(liveFolders(join(home, "nivra-acceptance", "niv55-live"), home, checkouts), { state: join(home, "nivra-acceptance", "niv55-live"), claims });
  });

  it("refuses a child named like a parent (..state) inside every protected folder: it is inside, not above", () => {
    // Nate's review of PR 37: relative() gives "..state" for such a child, which isn't a way up.
    assert.throws(() => liveFolders(join(take, "..state"), home, checkouts), /candidate 3's frozen take/);
    assert.throws(() => liveFolders(join(claims, "..state"), home, checkouts), /the approvals' claims/);
    for (const root of checkouts) assert.throws(() => liveFolders(join(root, "..state"), home, checkouts), /one of Nivra's checkouts/, root);
    // A sibling whose name only starts with dots is outside them all.
    assert.equal(liveFolders(join(home, "nivra-acceptance", "..niv55-live"), home, checkouts).state, join(home, "nivra-acceptance", "..niv55-live"));
  });

  it("claims approvals in one folder for every state folder, so a digest claimed under one is refused under a second", () => {
    const first = liveFolders(join(home, "nivra-acceptance", "niv55-live"), home, checkouts);
    const second = liveFolders(join(home, "nivra-acceptance", "task-live-c4"), home, checkouts);
    assert.equal(first.claims, second.claims);
    const digest = "5".repeat(64);
    const claim = (state: string) => ({ digest, run: 1, revision: null, out: state, pid: process.pid, claimedAt: "2026-10-28T15:00:00.000Z" });
    assert.equal(claimApproval(first.claims, claim(first.state)).ok, true);
    assert.equal(claimApproval(second.claims, claim(second.state)).ok, false, "the same approval ran again under another state folder");
    assert.equal(claimOn(second.claims, digest).claimed, true);
  });
});

describe("a preparation the recipe expects to stop (NIV-55)", () => {
  const LOCKFILE = "The lockfile doesn't match package.json. Run npm install in the repository, commit the lockfile, then prepare again.";
  const expected: ExpectedStop = { code: "install", step: "install", detail: LOCKFILE };
  const report = (over: Record<string, unknown> = {}, stopped: Record<string, unknown> = {}) => ({
    outcome: "failed",
    stopped: { code: "install", step: "install", message: ENVIRONMENT_STOP_MESSAGES.install, detail: LOCKFILE, ...stopped },
    prepared: null,
    environment: null,
    install: { exitCode: 1, logTail: "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync." },
    ...over,
  });
  const view = (given: ReturnType<typeof report> | null, prepared: unknown = null) => ({ prepared, preparation: { status: "answered", report: given } }) as unknown as Pick<EnvironmentView, "prepared" | "preparation">;

  it("passes only on exactly the expected stop: its code and step, Nivra's words, the expected guidance, the install's log, nothing kept", () => {
    assert.deepEqual(stopProblems(expected, view(report())), []);
  });

  it("fails on another failure of the same step: each other install diagnosis, a time-out, or no guidance at all", () => {
    // Nate's review of PR 37: a registry time-out at the install passed as the lockfile's mismatch.
    const others = [
      "The install couldn't reach the package registry from the sandbox. Try again later; if it keeps happening, check Nebius's status.",
      "npm couldn't settle the dependencies' peer requirements. If the lockfile was made with legacy-peer-deps, for example set in an .npmrc, turn on that install option, then prepare again.",
      "The install ran past its limit of 600 s and was stopped.",
      null,
    ];
    for (const detail of others) assert.match(stopProblems(expected, view(report({}, { detail }))).join("; "), /its guidance is .*, not the expected "The lockfile doesn't match package\.json/, String(detail));
    // A stop that gives no guidance is expected as null, and then any guidance is another failure.
    assert.deepEqual(stopProblems({ ...expected, detail: null }, view(report({}, { detail: null }))), []);
    assert.match(stopProblems({ ...expected, detail: null }, view(report())).join("; "), /not the expected null/);
  });

  it("fails on any other ending: another stop code or step, a success, or a stop that keeps too little", () => {
    assert.match(stopProblems(expected, view(report({}, { code: "readiness", step: "readiness", message: ENVIRONMENT_STOP_MESSAGES.readiness }))).join("; "), /stopped at readiness \(step readiness\), not the expected install \(step install\)/);
    assert.match(stopProblems(expected, view(report({}, { step: "upload" }))).join("; "), /not the expected install \(step install\)/);
    const success = stopProblems(expected, view(report({ outcome: "prepared", stopped: null, environment: PREPARED }), PREPARED));
    assert.ok(success.includes("an environment was kept") && success.includes("the preparation succeeded"), success.join("; "));
    assert.match(stopProblems(expected, view(report({ install: { exitCode: 1, logTail: "" } }))).join("; "), /the end of the install's log wasn't kept/);
    assert.match(stopProblems(expected, view(report({}, { message: "Something else." }))).join("; "), /words aren't Nivra's/);
    assert.match(stopProblems(expected, view(null)).join("; "), /with no report/);
  });
});

describe("a rehearsal's homes, read once its app is closed (NIV-55)", () => {
  // Nate's review of PR 37: a rehearsal that ended early read the homes before its app was closed.
  const traced = () => {
    const order: string[] = [];
    return { order, close: async () => void order.push("close"), after: () => (order.push("after"), "checked") };
  };

  it("closes the app before reading the homes, when the body ends early and when it runs to its end", async () => {
    for (const early of [true, false]) {
      const { order, close, after } = traced();
      const result = await closedThen({}, close, async () => {
        order.push("body");
        if (early) return;
        order.push("rest");
      }, after);
      assert.deepEqual([result, order], ["checked", early ? ["body", "close", "after"] : ["body", "rest", "close", "after"]]);
    }
  });

  it("closes the app when the body fails, and reads nothing after a failure", async () => {
    const { order, close, after } = traced();
    await assert.rejects(closedThen({}, close, async () => {
      order.push("body");
      throw new Error("the preview wasn't the recipe's");
    }, after), /the preview wasn't the recipe's/);
    assert.deepEqual(order, ["body", "close"]);
  });
});

describe("the packages a live run's recipe installs (NIV-55)", () => {
  // task-live.ts reads its command line as it loads, so its recipe can't be imported here. --check reads the task file
  // and its checkout and writes nothing: it prints what a plan binds besides the build, from the same resolution the
  // approval's digest hashes with the task file's choices.
  const desktop = fileURLToPath(new URL("..", import.meta.url));
  const repository = mkdtempSync(join(tmpdir(), "nivra live scope repository "));
  const files = mkdtempSync(join(tmpdir(), "nivra live scope task "));
  dirs.push(repository, files);
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  for (const [path, text] of Object.entries({
    "package.json": json({ name: "live-mono", private: true, packageManager: "pnpm@11.28.9" }),
    ".nvmrc": "24.21.0\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/data/package.json": json({ name: "@live/data", private: true }),
    "packages/web/package.json": json({ name: "@live/web", private: true }),
  })) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  }
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "init");
  const baseline = git("rev-parse", "HEAD");
  /** What --check prints of the environment for these choices, read into its parts. */
  const checked = (name: string, environment: unknown) => {
    const task = join(files, `${name}.json`);
    // A run that expects its preparation to stop takes no brief, which this check doesn't need.
    writeFileSync(task, json({ repository, baseline, environment, task: { title: "Scope" }, expect: { preparation: { code: "install", step: "install", detail: null } } }));
    const result = spawnSync(process.execPath, ["scripts/task-live.ts", "--check", "--task", task], { cwd: desktop, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, (result.stderr || result.stdout).slice(0, 2_000));
    const line = result.stdout.split("\n").find((text) => text.startsWith("Environment: ")) ?? "";
    const parts = /^Environment: the project's own recipe ([0-9a-f]{64}), with (\S+): .*; (pnpm install [^;]*); builds: .*; preview ([0-9a-f]{64}); hosts /.exec(line);
    assert.ok(parts, line.slice(0, 600));
    return { recipe: parts[1]!, choices: parts[2]!, install: parts[3]!, preview: parts[4]! };
  };

  it("binds the packages the task file chooses: its choices, the install's filters, the recipe's digest and the preview's fingerprint all change with them", () => {
    const whole = checked("whole", {});
    const chosen = checked("chosen", { scope: { kind: "selected", selectors: ["@live/data...", "./packages/web"] } });
    assert.deepEqual([whole.choices, whole.install], ["{}", "pnpm install --frozen-lockfile"]);
    assert.deepEqual([chosen.choices, chosen.install], ['{"scope":{"kind":"selected","selectors":["@live/data...","./packages/web"]}}', "pnpm install --frozen-lockfile --fail-if-no-match --filter @live/data... --filter ./packages/web"]);
    assert.notEqual(chosen.recipe, whole.recipe);
    assert.notEqual(chosen.preview, whole.preview);
    // The same packages in another order are another install, so another recipe.
    const reordered = checked("reordered", { scope: { kind: "selected", selectors: ["./packages/web", "@live/data..."] } });
    assert.deepEqual([reordered.install === chosen.install, reordered.recipe === chosen.recipe], [false, false]);
  });
});
