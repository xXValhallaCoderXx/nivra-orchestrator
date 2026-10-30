import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalJson, ENVIRONMENT_BASE, ENVIRONMENT_FILTER, ENVIRONMENT_LIMITS, EnvironmentPreview, EnvironmentRecipe, EnvironmentRef, EnvironmentReport, EnvironmentResolution, EnvironmentSetup, EnvironmentSpec, InstallScope, InvalidationReason, PreparedEnvironment, projectFingerprint, RECIPE_FORMAT, recipeDigest, REF_FORMAT, SETUP_FORMAT, VERIFIED_FORMAT, verifiedDigest, VerifiedToolRecord, WORKSPACE_FOLDER, WORKSPACE_NAME, WorkspaceFacts, type EnvironmentRecipe as Recipe, type InstallSelection } from "../src/environment.ts";
import { StartRunParams } from "../src/methods.ts";
import { baselinePattern, TaskBrief, taskBriefDigest, TaskInput, TaskReport, type TaskBrief as Brief } from "../src/task.ts";

/**
 * A project's environment and what a brief gains with it (NIV-49, D41): which packages to install and nothing that is a
 * command, the binding a task run checks, the baseline selections that run before the model, and the frozen files.
 */
const FINGERPRINT = "f".repeat(64);
const BRIEF: Brief = {
  goal: "Normalise historical units before finish-time PR detection",
  acceptanceCriteria: ["Prior sets are compared in the finishing workout's units"],
  scope: "packages/data",
  exclusions: "",
  context: "",
  checks: [],
  acceptanceCases: [{ name: "The data suite", command: "pnpm --filter data exec vitest run", expectedOutput: "tests 5 passed 5\n", expectedExitCode: 0 }],
};
const SELECTION = { name: "The regression alone fails for the bug", command: "pnpm --filter data exec vitest run tests/r.test.ts", expectedExitCode: 0, expectedOutput: "failed\tAssertionError\tone\n" };
const PATTERN = { name: "The other tests pass", command: "pnpm --filter data exec vitest run --exclude tests/r.test.ts", expectedExitCode: 0, outputPattern: "^tests \\d+ passed \\d+ failed 0\\n$" };

describe("a project's environment (NIV-49, D41)", () => {
  it("is chosen as pnpm filters only: workspace selectors, never anything a shell would read", () => {
    assert.equal(EnvironmentSpec.safeParse({ filters: [] }).success, true);
    assert.equal(EnvironmentSpec.safeParse({ filters: ["@sheetless/data...", "./packages/domain", "!web", "^app"] }).success, true);
    // A leading dash would read as an option to pnpm.
    for (const filter of ["a b", "a;b", "$(x)", "`x`", "a|b", "", "x".repeat(201), "-x", "--frozen-lockfile"]) assert.equal(EnvironmentSpec.safeParse({ filters: [filter] }).success, false, filter);
    assert.equal(EnvironmentSpec.safeParse({ filters: Array.from({ length: 9 }, (_, i) => `p${i}`) }).success, false, "eight filters at most");
    assert.equal(EnvironmentSpec.safeParse({ filters: [], command: "pnpm install" }).success, false, "no command");
  });

  it("previews what preparation sends and runs, or why it can't, never both", () => {
    const ready = {
      status: "ready",
      baseline: "b".repeat(40),
      packageManager: "pnpm@11.5.3",
      nodeRequirement: ">=22",
      packages: [{ name: "@sheetless/data", path: "packages/data" }],
      inputs: [{ path: "package.json", bytes: 300, sha256: "a".repeat(64) }],
      inputsDigest: "c".repeat(64),
      sentBytes: 2_000,
      leftOut: [".npmrc"],
      base: { tag: ENVIRONMENT_BASE.tag, registryUrl: ENVIRONMENT_BASE.registryUrl, node: ENVIRONMENT_BASE.node },
      installArgs: ["--frozen-lockfile", "--filter", "@sheetless/data..."],
      network: "On for the preparation only.",
      retention: "Images are retained for 180 days.",
      limits: { importSeconds: 900, prepareSeconds: 600, operations: 1 },
      fingerprint: FINGERPRINT,
    };
    assert.equal(EnvironmentPreview.safeParse(ready).success, true);
    assert.equal(EnvironmentPreview.safeParse({ status: "refused", code: "layout", message: "packages/a/package.json runs postinstall during an install." }).success, true);
    assert.equal(EnvironmentPreview.safeParse({ ...ready, status: "refused", code: "layout", message: "x" }).success, false);
  });

  it("starts as a run of its own, with upload consent and the spec in its context, and no model consent or brief", () => {
    const start = { clientRequestId: randomUUID(), workflowId: "environment", input: { repoPath: "/home/someone/repo", project: randomUUID(), target: "local", preview: FINGERPRINT }, context: { sharing: { cloudExecution: true }, spec: { filters: [] } } };
    assert.equal(StartRunParams.safeParse(start).success, true);
    assert.equal(StartRunParams.safeParse({ ...start, context: { sharing: { cloudExecution: true, modelContext: true }, spec: { filters: [] } } }).success, false);
    assert.equal(StartRunParams.safeParse({ ...start, input: { ...start.input, image: "img" } }).success, false, "the run names no image: it makes one");
  });

  it("is identified by its prepared image and bound to the Nebius project it was made in, by a hash that never holds the id", async () => {
    const prepared = { image: "a5019762", base: { tag: ENVIRONMENT_BASE.tag, image: "d6613a54", imported: true }, node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64", baseline: "b".repeat(40), inputsDigest: "c".repeat(64), spec: { filters: [] }, installArgs: ["--frozen-lockfile"], projectFingerprint: await projectFingerprint("project-e00one"), preparedAt: new Date().toISOString() };
    assert.equal(PreparedEnvironment.safeParse(prepared).success, true);
    const { projectFingerprint: _, ...unbound } = prepared;
    assert.equal(PreparedEnvironment.safeParse(unbound).success, false);
    const [one, again, other] = await Promise.all([projectFingerprint("project-e00one"), projectFingerprint("project-e00one"), projectFingerprint("project-e00two")]);
    assert.deepEqual([one === again, one === other, one.includes("e00one")], [true, false, false]);
    const report = { outcome: "prepared", stopped: null, prepared, install: { exitCode: 0, logTail: "Done in 7.7s" }, steps: [], cleanup: null, request: { runId: randomUUID(), clientRequestId: randomUUID() }, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    assert.equal(EnvironmentReport.safeParse(report).success, true);
    assert.equal(EnvironmentReport.safeParse({ ...report, stopped: { code: "something-else", step: null, message: "x" } }).success, false);
  });
});

describe("a brief's baseline selections and frozen files (D41)", () => {
  it("takes each selection with its exact output or a pattern, never both or neither, and a pattern that compiles", () => {
    assert.equal(TaskBrief.safeParse({ ...BRIEF, baseline: [SELECTION, PATTERN] }).success, true);
    const { expectedOutput: _, ...neither } = SELECTION;
    for (const wrong of [neither, { ...SELECTION, outputPattern: "x" }, { ...PATTERN, outputPattern: "(" }, { ...PATTERN, outputPattern: "x".repeat(501) }, { ...SELECTION, command: "a\0b" }]) {
      assert.equal(TaskBrief.safeParse({ ...BRIEF, baseline: [wrong] }).success, false, JSON.stringify(wrong).slice(0, 80));
    }
    assert.equal(TaskBrief.safeParse({ ...BRIEF, baseline: [SELECTION, PATTERN, SELECTION, PATTERN] }).success, false, "three selections at most");
  });

  it("matches a pattern against the whole output, never a part of it", () => {
    const pattern = baselinePattern("tests \\d+ passed \\d+ failed 0\\n|nothing");
    assert.deepEqual(["tests 4 passed 4 failed 0\n", "nothing", "x tests 4 passed 4 failed 0\n", "tests 4 passed 4 failed 0\nfailed\tone\n", "nothing more"].map((output) => pattern.test(output)), [true, true, false, false, false]);
    assert.equal(baselinePattern("a.b").test("a\nb"), true, "a dot matches a line break, so a pattern can span lines");
    // A pattern that is a regular expression only once wrapped would close the anchoring group: refused.
    assert.throws(() => baselinePattern("x)|(?:y"));
    assert.equal(TaskBrief.safeParse({ ...BRIEF, baseline: [{ ...PATTERN, outputPattern: "x)|(?:y" }] }).success, false);
  });

  it("takes frozen files as paths inside the folder, each once", () => {
    assert.equal(TaskBrief.safeParse({ ...BRIEF, frozen: ["packages/data/tests/r.test.ts", "packages/data/vitest.config.ts"] }).success, true);
    for (const wrong of [["/etc/passwd"], ["../outside.ts"], ["a//b.ts"], ["./a.ts"], ["a.ts", "a.ts"], [""]]) assert.equal(TaskBrief.safeParse({ ...BRIEF, frozen: wrong }).success, false, wrong.join(","));
    assert.equal(TaskBrief.safeParse({ ...BRIEF, frozen: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }).success, false, "twenty at most");
  });

  it("digests a brief without them as before, and binds every selection and frozen path when it has them", async () => {
    const before = await taskBriefDigest(BRIEF);
    assert.equal(await taskBriefDigest({ ...BRIEF, baseline: [], frozen: [] }), before, "empty is the same brief as before D41");
    const withThem = await taskBriefDigest({ ...BRIEF, baseline: [SELECTION], frozen: ["a.ts"] });
    const changed = await Promise.all(
      [
        { ...BRIEF, baseline: [{ ...SELECTION, expectedExitCode: 1 }], frozen: ["a.ts"] },
        { ...BRIEF, baseline: [{ ...SELECTION, expectedOutput: "failed\tAssertionError\tone" }], frozen: ["a.ts"] },
        { ...BRIEF, baseline: [SELECTION], frozen: ["b.ts"] },
        { ...BRIEF, baseline: [SELECTION], frozen: [] },
        { ...BRIEF, baseline: [], frozen: ["a.ts"] },
      ].map(taskBriefDigest),
    );
    assert.equal(new Set([before, withThem, ...changed]).size, 7);
  });

  it("binds a run to its environment, and reads a report kept from before D41 as one with none", () => {
    const input = { repoPath: "/r", project: randomUUID(), target: "local", preview: FINGERPRINT, taskId: randomUUID(), briefVersion: 1, briefDigest: FINGERPRINT, preferencesDigest: FINGERPRINT, choicesDigest: FINGERPRINT };
    const environment = { image: "a5019762", inputsDigest: "c".repeat(64), projectFingerprint: "d".repeat(64), node: "v22.23.4", pnpm: "11.5.3", arch: "x86_64" };
    assert.equal(TaskInput.safeParse({ ...input, environment }).success, true);
    assert.equal(TaskInput.safeParse({ ...input, environment: { ...environment, tag: "node:22" } }).success, false, "a tag is never part of the binding");
    const kept = TaskReport.parse({
      outcome: "refused",
      stopped: { code: "baseline", step: "baseline", message: "x" },
      task: { taskId: randomUUID(), attemptId: randomUUID(), briefVersion: 1, briefDigest: FINGERPRINT },
      snapshot: null,
      toolchain: [],
      worker: null,
      checks: [],
      verified: false,
      steps: [],
      proposal: null,
      reportSha256: null,
      cleanup: null,
      route: null,
      request: { runId: randomUUID(), clientRequestId: randomUUID() },
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    });
    assert.deepEqual([kept.environment, kept.baseline, kept.frozen], [null, [], []]);
  });
});

describe("a project-driven environment's contract (NIV-55)", () => {
  const configuration = { mode: "manifests" as const, files: [{ path: "toy.lock", bytes: 12, sha256: "1".repeat(64) }], digest: "2".repeat(64) };
  /** A recipe for an ecosystem that isn't Node at all: nothing in the contract is shaped like one. */
  const toy: Recipe = {
    format: RECIPE_FORMAT,
    profile: "toy",
    platform: { os: "linux", arch: "x86_64", libc: "glibc" },
    image: { registryUrl: "docker://docker.io/library/toylang:3.1.4-slim", tag: "toylang:3.1.4-slim" },
    tools: [
      { name: "toyc", version: { kind: "exact", version: "3.1.4" }, from: "image" },
      { name: "toypkg", version: { kind: "bundled", with: "toyc" }, from: "image" },
    ],
    bootstrap: [],
    install: { tool: "toypkg", args: ["fetch", "--locked"], options: { offline: false } },
    scope: { kind: "whole" },
    builds: { tool: "toypkg", runs: "all", allowed: [], denied: [], strict: null, source: null, notes: [] },
    configuration,
    systemPackages: ["pkg-config"],
    workdir: "/workspace",
    env: { preparation: { TOY_HOME: "/root/.toy" }, task: { TOY_OFFLINE: "1" } },
    artifacts: { dependency: ["target"], caches: ["/root/.toy"] },
    network: { preparation: "on", tasks: "off", hosts: ["registry.toylang.org"], imageRegistry: "docker.io" },
    probes: ["tool-versions"],
    limits: { importSeconds: 900, prepareSeconds: 600, probeSeconds: 120 },
  };

  it("takes a recipe for any ecosystem, strictly, with arguments free of spaces, quotes and shell operators", () => {
    // The sandbox passes arguments to a fixed script one by one, never through a shell; `*`, `~` and `!` stay plain text.
    assert.equal(EnvironmentRecipe.safeParse(toy).success, true);
    assert.equal(EnvironmentRecipe.safeParse({ ...toy, extra: 1 }).success, false, "nothing beyond the contract");
    for (const name of ["Toy", "toy c", "-toy", ""]) assert.equal(EnvironmentRecipe.safeParse({ ...toy, tools: [{ ...toy.tools[0]!, name }] }).success, false, name);
    for (const arg of ["a b", "$(x)", "a;b", "`x`", "a|b", "'x'", ""]) assert.equal(EnvironmentRecipe.safeParse({ ...toy, install: { ...toy.install, args: [arg] } }).success, false, arg);
    for (const version of ["latest", "3.1", "^3.1.4", "3.1.4-rc.1"]) assert.equal(EnvironmentRecipe.safeParse({ ...toy, tools: [{ ...toy.tools[0]!, version: { kind: "exact", version } }] }).success, false, version);
    assert.equal(EnvironmentRecipe.safeParse({ ...toy, network: { ...toy.network, tasks: "on" } }).success, false, "task runs are offline");
    assert.equal(EnvironmentRecipe.safeParse({ ...toy, env: { preparation: { TOKEN: "a b" }, task: {} } }).success, false, "no free text in variables");
  });

  it("digests a recipe the same whatever order its keys were written in, and differently for any change", async () => {
    const reordered = JSON.parse(canonicalJson(toy)) as Recipe;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as Recipe;
    assert.equal(await recipeDigest(shuffled), await recipeDigest(toy));
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
    assert.notEqual(await recipeDigest({ ...toy, configuration: { ...configuration, digest: "3".repeat(64) } }), await recipeDigest(toy));
  });

  it("keeps what preparation found apart from what the person approved, and binds both to a run", async () => {
    const record = {
      format: VERIFIED_FORMAT,
      recipe: await recipeDigest(toy),
      tools: [{ name: "toyc", version: "3.1.4" }, { name: "toypkg", version: "1.9.0" }],
      platform: { os: "linux", arch: "x86_64", libc: "glibc", release: "Debian GNU/Linux 12" },
      images: { base: "img-base", prepared: "img-prepared", imported: true },
      builds: { state: "missing", missing: ["native-thing"] },
      generated: null,
      probes: [{ name: "tool-versions", durationMs: 812 }],
      verifiedAt: new Date().toISOString(),
    };
    assert.equal(VerifiedToolRecord.safeParse(record).success, true);
    assert.equal(VerifiedToolRecord.safeParse({ ...record, tools: [{ name: "toyc", version: "latest" }] }).success, false, "verified versions are exact");
    const verified = await verifiedDigest(VerifiedToolRecord.parse(record));
    assert.notEqual(verified, record.recipe);
    const ref = {
      format: REF_FORMAT,
      recipe: record.recipe,
      verified,
      configuration: configuration.digest,
      image: "img-prepared",
      projectFingerprint: await projectFingerprint("project-e00one"),
      target: "wsl:Ubuntu",
      tools: record.tools,
      platform: { arch: "x86_64", libc: "glibc" },
      env: { TOY_OFFLINE: "1" },
      dependencyFolders: ["target"],
      builds: { verified, missing: ["native-thing"], acceptedAt: new Date().toISOString() },
      preparedAt: new Date().toISOString(),
    };
    assert.equal(EnvironmentRef.safeParse(ref).success, true);
    const { verified: _, ...unbound } = ref;
    assert.equal(EnvironmentRef.safeParse(unbound).success, false, "a run is bound to what was verified, not only to what was asked for");
    const { env: __, ...bare } = ref;
    assert.equal(EnvironmentRef.safeParse(bare).success, false, "a run carries the task operations' own variables");
    assert.equal(EnvironmentRef.safeParse({ ...ref, env: { TOKEN: "a b" } }).success, false, "no free text in a task variable");
    for (const folder of [".", "..", "a/b", ""]) assert.equal(EnvironmentRef.safeParse({ ...ref, dependencyFolders: [folder] }).success, false, `a dependency folder is a plain name, never ${JSON.stringify(folder)}`);
  });

  it("keeps what a preparation was started with as the person's choices, the versions kept and the recipe's digest, and nothing else", () => {
    const setup = { format: SETUP_FORMAT, choices: { runtime: "24.21.0" }, previous: null, recipeDigest: "a".repeat(64) };
    assert.equal(EnvironmentSetup.safeParse(setup).success, true);
    assert.equal(EnvironmentSetup.safeParse({ ...setup, spec: { filters: [] } }).success, false, "nothing beyond the contract");
    assert.equal(EnvironmentSetup.safeParse({ filters: [] }).success, false, "D41's spec is no recipe's setup");
    assert.equal(EnvironmentSetup.safeParse({ ...setup, choices: { runtime: "24" } }).success, false, "a chosen version is exact");
  });

  it("never lists a release-index refresh as a reason to prepare again", () => {
    assert.deepEqual(InvalidationReason.options, ["inputs-changed", "recipe-changed", "advisory", "project-changed", "target-changed", "image-missing", "legacy"]);
  });
});

describe("workspace packages chosen by folder (NIV-55)", () => {
  const configuration = { mode: "manifests" as const, files: [{ path: "pnpm-lock.yaml", bytes: 12, sha256: "1".repeat(64) }], digest: "2".repeat(64) };
  /** The same toy recipe as the contract's: chosen packages are no more Node-shaped than the rest of it. */
  const toy: Recipe = {
    format: RECIPE_FORMAT,
    profile: "toy",
    platform: { os: "linux", arch: "x86_64", libc: "glibc" },
    image: { registryUrl: "docker://docker.io/library/toylang:3.1.4-slim", tag: "toylang:3.1.4-slim" },
    tools: [
      { name: "toyc", version: { kind: "exact", version: "3.1.4" }, from: "image" },
      { name: "toypkg", version: { kind: "bundled", with: "toyc" }, from: "image" },
    ],
    bootstrap: [],
    install: { tool: "toypkg", args: ["fetch", "--locked"], options: { offline: false } },
    scope: { kind: "whole" },
    builds: { tool: "toypkg", runs: "all", allowed: [], denied: [], strict: null, source: null, notes: [] },
    configuration: { ...configuration, files: [{ path: "toy.lock", bytes: 12, sha256: "1".repeat(64) }] },
    systemPackages: ["pkg-config"],
    workdir: "/workspace",
    env: { preparation: { TOY_HOME: "/root/.toy" }, task: { TOY_OFFLINE: "1" } },
    artifacts: { dependency: ["target"], caches: ["/root/.toy"] },
    network: { preparation: "on", tasks: "off", hosts: ["registry.toylang.org"], imageRegistry: "docker.io" },
    probes: ["tool-versions"],
    limits: { importSeconds: 900, prepareSeconds: 600, probeSeconds: 120 },
  };
  const packages = (list: string[], root = true): InstallScope => ({ kind: "packages", packages: list, root });
  const selection = (chosen: string[], reached: string[] = [], root = true): InstallSelection => ({
    packages: [...chosen.map((folder) => ({ folder, name: `@w/${folder.split("/").at(-1)}`, chosen: true })), ...reached.map((folder) => ({ folder, name: null, chosen: false }))].sort((a, b) => (a.folder < b.folder ? -1 : 1)),
    root,
  });
  const chosenRecipe = (scope: InstallScope, picked: InstallSelection | undefined): unknown => ({ ...toy, scope, ...(picked ? { selection: picked } : {}) });
  const issues = (value: unknown) => {
    const parsed = EnvironmentRecipe.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };

  it("takes 1 to 20 folders, each once and in order, of plain segments a package manager reads literally, and the root's switch", () => {
    assert.equal(InstallScope.safeParse(packages(["apps/web", "packages/@scope/data", "packages/data"])).success, true);
    assert.equal(InstallScope.safeParse(packages(["apps/web"], false)).success, true, "the root's own dependencies can be left out");
    const many = Array.from({ length: ENVIRONMENT_LIMITS.packages + 1 }, (_, index) => `packages/p${String(index).padStart(2, "0")}`);
    assert.equal(ENVIRONMENT_LIMITS.packages, 20);
    assert.equal(InstallScope.safeParse(packages(many.slice(0, 20))).success, true);
    for (const [list, why] of [
      [[], "none"],
      [many, "21"],
      [["packages/web", "apps/web"], "out of order"],
      [["apps/web", "apps/web"], "twice"],
      [["../web"], "a way up"],
      [["apps/../web"], "a way up inside"],
      [["/apps/web"], "absolute"],
      [["apps/web/"], "a trailing slash"],
      [["apps/my web"], "a space"],
      [["apps/*"], "a glob"],
      [[".github/action"], "a hidden folder"],
      [["apps/.hidden"], "a hidden segment"],
      [["-web"], "a leading hyphen"],
      [[""], "empty"],
    ] as const) assert.equal(InstallScope.safeParse(packages([...list])).success, false, why);
    assert.equal(InstallScope.safeParse({ kind: "packages", packages: ["apps/web"] }).success, false, "the root's switch is always said");
    assert.equal(InstallScope.safeParse({ ...packages(["apps/web"]), selectors: ["x"] }).success, false, "nothing beyond the contract");
  });

  it("bounds a folder at 186 characters and a name at 200, so the arguments built from them keep the 200-character rule", () => {
    const folder = (length: number) => `p/${"f".repeat(length - 2)}`;
    assert.deepEqual([WORKSPACE_FOLDER.test(folder(186)), WORKSPACE_FOLDER.test(folder(187))], [true, false]);
    // npm's argument for the longest folder is exactly as long as an argument may be; one more is refused.
    const install = (arg: string) => EnvironmentRecipe.safeParse({ ...toy, install: { ...toy.install, args: ["ci", arg] } }).success;
    assert.deepEqual([`--workspace=./${folder(186)}`.length, install(`--workspace=./${folder(186)}`), install(`--workspace=./${folder(187)}`)], [200, true, false]);
    const name = (length: number) => `@s/${"n".repeat(length - 3)}`;
    assert.deepEqual([WORKSPACE_NAME.test(name(200)), WORKSPACE_NAME.test(name(201)), install(name(200)), install(name(201))], [true, false, true, false]);
    for (const good of ["web", "@scope/web", "web-app_2.v~x", "Web"]) assert.equal(WORKSPACE_NAME.test(good), true, good);
    for (const bad of ["@scope", "a/b", "@a/b/c", "web.", "web...", "*", "web*", "web?", "!web", "{web}", "[web]", "^web", ".web", "_web", "-web", "we b", ""]) assert.equal(WORKSPACE_NAME.test(bad), false, bad);
    // Every name it takes is one pnpm filter, as the sandbox already checks a filter.
    for (const good of ["web", "@scope/web", "web-app_2.v~x", name(200)]) assert.equal(ENVIRONMENT_FILTER.test(good), true, good);
  });

  it("requires a chosen install's selection, with its root and exactly its chosen packages, and allows none anywhere else", () => {
    const scope = packages(["apps/web", "packages/data"]);
    assert.deepEqual(issues(chosenRecipe(scope, selection(["apps/web", "packages/data"], ["packages/tokens"]))), []);
    for (const [value, why] of [
      [chosenRecipe(scope, undefined), "no selection"],
      [chosenRecipe(scope, selection(["apps/web", "packages/data"], [], false)), "another root"],
      [chosenRecipe(scope, selection(["apps/web"], ["packages/data"])), "a chosen package marked reached"],
      [chosenRecipe(packages(["apps/web"]), selection(["apps/web", "packages/data"])), "a package marked chosen that wasn't"],
      [chosenRecipe(scope, { ...selection(["apps/web", "packages/data"]), packages: [...selection(["apps/web", "packages/data"]).packages].reverse() }), "out of order"],
      [chosenRecipe(packages(["apps/web"]), { packages: [{ folder: "apps/web", name: "web", chosen: true }, { folder: "apps/web", name: "web", chosen: false }], root: true }), "twice"],
      [chosenRecipe({ kind: "whole" }, selection(["apps/web"])), "a whole project with one"],
      [chosenRecipe({ kind: "selected", selectors: ["@w/web"] }, selection(["apps/web"])), "selectors with one"],
    ] as const) {
      const found = issues(value);
      assert.equal(found.length, 1, `${why}: ${found.join("; ")}`);
      assert.match(found[0]!, /^selection: /, why);
    }
    const many = Array.from({ length: 21 }, (_, index) => ({ folder: `p/${String(index).padStart(2, "0")}`, name: null, chosen: index === 0 }));
    assert.notDeepEqual(issues(chosenRecipe(packages(["p/00"]), { packages: many, root: true })), [], "at most 20 packages installed");
  });

  it("keeps every recipe written before chosen packages: it parses, and digests exactly as it did", async () => {
    // Pinned on main c2c1bb2, before chosen packages: neither recipe carries a selection, so their digests can't move.
    const selected: Recipe = { ...toy, install: { ...toy.install, args: ["install", "--frozen-lockfile", "--filter", "@w/data..."] }, scope: { kind: "selected", selectors: ["@w/data..."] } };
    for (const recipe of [toy, selected]) assert.equal(EnvironmentRecipe.safeParse(recipe).success, true);
    assert.deepEqual(
      [await recipeDigest(toy), await recipeDigest(selected)],
      ["0b25ab9bb12661351b09c692a8a1c9fe29eff7857eed39a77c7c06b81e9e2ba0", "d4969de5bcd28f3de8001f5baa7b3de20a53fe80e8d5b10678a000c787a838cc"],
    );
  });

  it("carries the workspace's facts with every answer that read the workspace, and with a refusal of the scope chosen", () => {
    const facts: WorkspaceFacts = {
      packages: [
        { folder: "apps/web", name: "@w/web", unavailable: null },
        { folder: "apps/no name", name: null, unavailable: "Its folder's name has a space, which Nivra doesn't pass to a package manager." },
      ],
      more: 0,
      root: { dependencies: 3, examples: ["eslint", "typescript", "vitest"], optional: false, reason: "pnpm installs the workspace root's own dependencies whenever it installs chosen packages." },
      modes: [
        { mode: "whole", available: true, reason: null },
        { mode: "packages", available: true, reason: null },
        { mode: "selectors", available: false, reason: "pnpm selectors are pnpm's own syntax, and this project installs with npm." },
      ],
    };
    assert.equal(WorkspaceFacts.safeParse(facts).success, true);
    assert.equal(WorkspaceFacts.safeParse({ ...facts, modes: [...facts.modes, facts.modes[0]] }).success, false, "one row per mode");
    assert.equal(WorkspaceFacts.safeParse({ ...facts, packages: Array.from({ length: 501 }, (_, index) => ({ folder: `p/${index}`, name: null, unavailable: null })) }).success, false, "a bounded list");
    const ready = { status: "ready", rows: [], recipe: toy, warnings: [], limitations: [], workspace: facts };
    const choice = { status: "needs-choice", rows: [], choices: [{ id: "runtime", why: "conflict", message: "Choose.", declarations: [], options: [{ value: "24.21.0", label: "Node 24.21.0", note: null }] }], warnings: [], limitations: [], workspace: facts };
    for (const answer of [ready, { ...ready, workspace: null }, choice, { ...choice, workspace: null }]) assert.equal(EnvironmentResolution.safeParse(answer).success, true, answer.status);
    const { workspace: _, ...unsaid } = ready;
    assert.equal(EnvironmentResolution.safeParse(unsaid).success, false, "a ready answer always says whether it read a workspace");
    const refused = { status: "refused", code: "scope", message: "apps/old isn't one of this workspace's packages.", rows: [] };
    assert.deepEqual([EnvironmentResolution.safeParse(refused).success, EnvironmentResolution.safeParse({ ...refused, workspace: facts }).success], [true, true]);
  });
});
