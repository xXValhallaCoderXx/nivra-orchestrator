import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { isTerminal, PREPARED_FORMAT, projectFingerprint, recipeDigest, VerifiedToolRecord, verifiedDigest, type EnvironmentChoices, type EnvironmentPreviewV2, type EnvironmentReport, type RunSummary } from "@nivra/domain";
import { INSPECT_SCRIPT, READINESS_SCRIPT } from "../src/environment/scripts.ts";
import { ENV_PREPARE_SCRIPT } from "../src/exec/nebius/sandbox.ts";
import { readTar } from "../src/exec/tar.ts";
import { succeed, type Behaviour } from "./fake-sandboxes.ts";
import { removeDir, startEngine, tempDir, type EngineProcess } from "./helpers.ts";
import { RealGuest } from "./real-guest.ts";
import { startSandboxStub, type SandboxStub } from "./stub-sandboxes.ts";
import { cleanUp, repoWith } from "./workspace-fixtures.ts";

/**
 * A project-driven recipe's preparation through a real engine over stdio (NIV-55), against the stand-in for Nebius
 * Sandboxes on this machine. Nothing is installed here: the stand-in answers the inspect, preparation and readiness steps
 * as an image would, and adds the dependency folder an install leaves. Two projects with nothing in common but being
 * Node projects go through the same flow: a pnpm workspace on Node 24 and an npm project on Node 22.
 */
const KEY = "nivra-environment-recipe-key-0123456789";
const PROJECT_ID = "project-e00environmentrecipetest";
const CREDENTIALS = { NEBIUS_API_KEY: KEY, NEBIUS_PROJECT_ID: PROJECT_ID };

const dirs: string[] = [];
const engines: EngineProcess[] = [];
const stubs: SandboxStub<RealGuest>[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  for (const stub of stubs) await stub.close();
  for (const dir of dirs) removeDir(dir);
  cleanUp();
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const PNPM = {
  "package.json": json({ name: "mono", private: true, packageManager: "pnpm@11.5.3" }),
  ".nvmrc": "24.21.0\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n",
  "packages/data/package.json": json({ name: "@mono/data", private: true }),
  "packages/data/src/index.ts": "export const data = 1;\n",
};
const NPM = {
  "package.json": json({ name: "site", version: "1.0.0", scripts: { test: "node --test" } }),
  ".node-version": "22.23.4\n",
  "package-lock.json": json({ name: "site", lockfileVersion: 3, requires: true, packages: { "": { name: "site" }, "node_modules/esbuild": { version: "0.25.0", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.25.0.tgz", hasInstallScript: true } } }),
  "src/index.js": "export {};\n",
};

/** How the stand-in's image answers: what it holds, how the install goes, and what readiness sees. */
interface Image {
  node: string;
  npm: string;
  /** The pnpm the preparation activates, as it prints it: 11.5.3, the project's pin, unless said. */
  pnpm?: string;
  corepack?: string | null;
  libc?: string;
  install?: "ok" | "fails" | "bootstrap-fails";
  /** What a failing install prints. */
  installLog?: string;
  /** What the preparation script prints after a passed install, such as its unmatched-filter marker. */
  afterInstall?: string;
  builds?: string;
  /** What readiness sees: the tools, pnpm's settings, and files the install left besides the setup files and node_modules. */
  readiness?: { tools?: string; settings?: string; extraFiles?: string[] };
}

/** Each intercepted step ends at its first read: the engine reads an operation every 5 s, and a recipe runs four. */
const done = (extra: Partial<Behaviour> = {}): Behaviour => succeed({ statuses: ["SUCCESS"], ...extra });

async function setup(image: Image) {
  const guest = new RealGuest();
  guest.images.set("img-imported", tempDir("nivra recipe imported image"));
  dirs.push(guest.images.get("img-imported")!);
  const received: { inputs: string[] | null; prepareEnv: Record<string, string> | null } = { inputs: null, prepareEnv: null };
  guest.intercept = ({ args, body }, folder): Behaviour | undefined => {
    const pnpm = args.includes("pnpm");
    if (args[1] === INSPECT_SCRIPT) {
      return done({ stdout: `node v${image.node}\nnpm ${image.npm}\ncorepack ${image.corepack === null ? "none" : (image.corepack ?? "0.34.0")}\narch x86_64\nos Alpine Linux v3.22\nlibc ${image.libc ?? "musl"}\n` });
    }
    if (args[1] === ENV_PREPARE_SCRIPT) {
      received.prepareEnv = body["env"] as Record<string, string>;
      if (image.install === "bootstrap-fails") return done({ exitCode: 71, stdout: "ERR_PNPM_NO_SUCH_VERSION\nbootstrap-failed pnpm\n" });
      const reference = (body["files"] as Record<string, { uuid: string }>)["/nivra/env-inputs.tar.gz"]!;
      const entries = readTar(new Uint8Array(gunzipSync(guest.service.uploadsById.get(reference.uuid)!)), { maxEntries: 100, maxBytes: 1 << 22, maxEntryBytes: 1 << 22, maxPathBytes: 1024 });
      received.inputs = entries.flatMap((entry) => (entry.kind === "file" ? [entry.path] : [])).sort();
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        mkdirSync(dirname(join(folder, "workspace", entry.path)), { recursive: true });
        writeFileSync(join(folder, "workspace", entry.path), entry.bytes);
      }
      mkdirSync(join(folder, "workspace", "node_modules", "dep"), { recursive: true });
      writeFileSync(join(folder, "workspace", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
      const versions = `${pnpm ? "via corepack\n" : ""}node v${image.node}\nnpm ${image.npm}\n${pnpm ? `pnpm ${image.pnpm ?? "11.5.3"}\n` : ""}arch x86_64\n`;
      if (image.install === "fails") return done({ exitCode: 1, stdout: `${versions}${image.installLog ?? "npm error code ERESOLVE\n"}` });
      const builds = pnpm ? `builds-begin\nAutomatically ignored builds during installation:\n${image.builds ?? "  None"}\nbuilds-end\n` : "";
      return done({ stdout: `${versions}added 12 packages in 3s\ninstalled\n${image.afterInstall ?? ""}${builds}` });
    }
    if (args[1] === READINESS_SCRIPT) {
      const tools = image.readiness?.tools ?? ["sh", "tar", "find", "sha256sum", "gzip", "sort"].map((tool) => `tool ${tool} ok`).join("\n");
      const settings = image.readiness?.settings ?? "setting verify-deps-before-run false\nsetting pm-on-fail ignore";
      // As the step lists the workspace: the setup files the preparation was sent, and what the install left besides.
      const listed = [...(received.inputs ?? []), ...(image.readiness?.extraFiles ?? [])].sort().map((path) => `file ./${path}`).join("\n");
      return done({ stdout: `node v${image.node}\nnpm ${image.npm}\n${pnpm ? `pnpm ${image.pnpm ?? "11.5.3"}\n` : ""}${tools}\n${pnpm ? settings : ""}\n${listed}\nlisted\n` });
    }
    return undefined;
  };
  const stub = await startSandboxStub({ guest });
  stubs.push(stub);
  const root = tempDir("nivra recipe engine");
  dirs.push(root);
  const home = join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--sandboxes-url", stub.url] });
  engines.push(engine);
  await engine.initialize(CREDENTIALS);
  return { stub, guest, engine, received };
}

const project = randomUUID();
const resolve = (engine: EngineProcess, repoPath: string, choices: EnvironmentChoices = {}): Promise<EnvironmentPreviewV2> => engine.client.call("environment.resolve", { repoPath, choices, previous: null });
const ready = (shown: EnvironmentPreviewV2) => {
  assert.equal(shown.status, "ready", JSON.stringify(shown).slice(0, 400));
  return shown as Extract<EnvironmentPreviewV2, { status: "ready" }>;
};
const start = (engine: EngineProcess, repoPath: string, fingerprint: string, choices: EnvironmentChoices = {}): Promise<RunSummary> =>
  engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "environment", input: { repoPath, project, target: "local", preview: fingerprint }, context: { sharing: { cloudExecution: true }, choices, previous: null } });
const ended = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 60_000);
const report = async (engine: EngineProcess, runId: string): Promise<EnvironmentReport> => (await engine.client.call("runs.environment", { runId }))!;
const spawns = (stub: SandboxStub<RealGuest>) => stub.requests.filter((request) => request.method === "POST" && request.path === "/v1/instances").map((request) => JSON.parse(request.body) as { networking: { enabled: boolean }; image: string; env: Record<string, string>; args: string[] });
const uploads = (stub: SandboxStub<RealGuest>) => stub.guest.service.uploadsById.size;

describe("a project-driven recipe's preparation through a real engine (NIV-55)", () => {
  it("prepares a pnpm workspace on the Node its .nvmrc pins, and writes what it verified beside the recipe", async () => {
    const { stub, engine, received } = await setup({ node: "24.21.0", npm: "11.19.0" });
    const repo = repoWith(PNPM);
    const shown = ready(await resolve(engine, repo));
    assert.deepEqual([shown.recipe.image.tag, shown.recipe.install.args, shown.recipeDigest], ["node:24.21.0-alpine", ["install", "--frozen-lockfile"], await recipeDigest(shown.recipe)]);
    const run = await start(engine, repo, shown.fingerprint);
    assert.equal((await ended(engine, run.id)).status, "succeeded");
    const done = await report(engine, run.id);
    assert.equal(done.outcome, "prepared", JSON.stringify(done.stopped));
    // D41's field stays empty, so a reader that knows only D41 never takes a recipe's environment for its own.
    assert.equal(done.prepared, null);
    const prepared = done.environment!;
    assert.deepEqual([prepared.format, prepared.recipeDigest, prepared.verified.recipe], [PREPARED_FORMAT, shown.recipeDigest, shown.recipeDigest]);
    assert.deepEqual(prepared.verified.tools, [{ name: "node", version: "24.21.0" }, { name: "npm", version: "11.19.0" }, { name: "pnpm", version: "11.5.3" }, { name: "corepack", version: "0.34.0" }]);
    assert.deepEqual([prepared.verified.platform, prepared.verified.builds, prepared.verified.images.imported], [{ os: "linux", arch: "x86_64", libc: "musl", release: "Alpine Linux v3.22" }, { state: "complete", missing: [] }, true]);
    assert.equal(prepared.verifiedDigest, await verifiedDigest(VerifiedToolRecord.parse(prepared.verified)));
    assert.equal(prepared.projectFingerprint, await projectFingerprint(PROJECT_ID));
    assert.deepEqual(received.inputs, [".nvmrc", "package.json", "packages/data/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], "the preparation was sent something besides the setup configuration");
    // Networking only for the preparation; the inspect and readiness steps are offline and thrown away.
    assert.deepEqual(spawns(stub).map((spawn) => spawn.networking.enabled), [false, true, false]);
    assert.deepEqual(done.steps.map((step) => step.label), ["image import", "image inspect", "preparation", "readiness"]);
    assert.equal(received.prepareEnv?.["COREPACK_ENABLE_STRICT"], "0");
    assert.ok(!Object.keys(received.prepareEnv ?? {}).some((key) => /registry|proxy/i.test(key)), "the preparation was given a variable that could steer it elsewhere");
    assert.deepEqual(spawns(stub).at(-1)!.env["pnpm_config_verify_deps_before_run"], "false", "readiness runs with the task operations' own variables");
  });

  it("prepares an npm project on another Node with the npm its image bundles, and records the builds ignore-scripts skips", async () => {
    const { engine } = await setup({ node: "22.23.4", npm: "10.9.9" });
    const repo = repoWith(NPM);
    const shown = ready(await resolve(engine, repo));
    assert.deepEqual([shown.recipe.image.tag, shown.recipe.tools.find((tool) => tool.name === "npm")?.version], ["node:22.23.4-alpine", { kind: "bundled", with: "node" }]);
    const plain = await start(engine, repo, shown.fingerprint);
    await ended(engine, plain.id);
    const prepared = (await report(engine, plain.id)).environment!;
    assert.deepEqual([prepared.verified.tools.find((tool) => tool.name === "npm"), prepared.verified.builds.state], [{ name: "npm", version: "10.9.9" }, "complete"]);
    const ignore = ready(await resolve(engine, repo, { options: { "ignore-scripts": true } }));
    const skipped = await start(engine, repo, ignore.fingerprint, { options: { "ignore-scripts": true } });
    await ended(engine, skipped.id);
    assert.deepEqual((await report(engine, skipped.id)).environment?.verified.builds, { state: "missing", missing: ["esbuild"] });
  });

  it("stops before anything is uploaded when the image doesn't hold what the recipe asks for, saying what it found", async () => {
    const { stub, engine } = await setup({ node: "24.20.0", npm: "11.19.0", libc: "glibc" });
    const repo = repoWith(PNPM);
    const run = await start(engine, repo, ready(await resolve(engine, repo)).fingerprint);
    assert.equal((await ended(engine, run.id)).status, "failed");
    const done = await report(engine, run.id);
    assert.deepEqual([done.outcome, done.stopped?.code, done.stopped?.step], ["failed", "inspect", "inspect"]);
    assert.match(done.stopped!.detail!, /Node 24\.20\.0, not 24\.21\.0/);
    assert.match(done.stopped!.detail!, /glibc libc, not musl/);
    assert.equal(uploads(stub), 0, "the setup configuration was uploaded to an image that doesn't match");
  });

  it("keeps nothing when readiness fails offline, or pnpm doesn't read the switch that stops it installing before a run", async () => {
    for (const readiness of [{ tools: "tool sh ok\ntool tar missing" }, { settings: "setting verify-deps-before-run install\nsetting pm-on-fail ignore" }]) {
      const { engine } = await setup({ node: "24.21.0", npm: "11.19.0", readiness });
      const repo = repoWith(PNPM);
      const run = await start(engine, repo, ready(await resolve(engine, repo)).fingerprint);
      await ended(engine, run.id);
      const done = await report(engine, run.id);
      assert.deepEqual([done.outcome, done.stopped?.code, done.prepared, done.environment], ["failed", "readiness", null, null]);
      assert.match(done.stopped!.detail!, readiness.tools ? /tar is missing/ : /verify-deps-before-run as "install", not false/);
    }
  });

  it("records the builds pnpm says it didn't run, and says when pnpm couldn't be activated", async () => {
    const missing = await setup({ node: "24.21.0", npm: "11.19.0", builds: "  core-js\n  sharp" });
    const repo = repoWith(PNPM);
    const run = await start(missing.engine, repo, ready(await resolve(missing.engine, repo)).fingerprint);
    await ended(missing.engine, run.id);
    assert.deepEqual((await report(missing.engine, run.id)).environment?.verified.builds, { state: "missing", missing: ["core-js", "sharp"] });
    const broken = await setup({ node: "24.21.0", npm: "11.19.0", install: "bootstrap-fails" });
    const again = await start(broken.engine, repo, ready(await resolve(broken.engine, repo)).fingerprint);
    await ended(broken.engine, again.id);
    const done = await report(broken.engine, again.id);
    assert.deepEqual([done.stopped?.code, done.install?.exitCode], ["bootstrap", 71]);
  });

  it("stops on a failed install with the end of its log, and says what to change when the failure is a known one", async () => {
    const cases = [
      { files: NPM, log: "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve\n", words: /turn on that install option/ },
      { files: PNPM, log: "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"\n", words: /Run pnpm install in the repository, commit pnpm-lock\.yaml/ },
      { files: NPM, log: "npm error something Nivra has never seen\n", words: null },
    ];
    for (const { files, log, words } of cases) {
      const { stub, engine } = await setup({ node: files === PNPM ? "24.21.0" : "22.23.4", npm: files === PNPM ? "11.19.0" : "10.9.9", install: "fails", installLog: log });
      const repo = repoWith(files);
      const run = await start(engine, repo, ready(await resolve(engine, repo)).fingerprint);
      assert.equal((await ended(engine, run.id)).status, "failed");
      const done = await report(engine, run.id);
      assert.deepEqual([done.outcome, done.stopped?.code, done.stopped?.step, done.install?.exitCode, done.prepared, done.environment], ["failed", "install", "install", 1, null, null]);
      assert.ok(done.install!.logTail.includes(log.trim().split("\n")[0]!), "the end of the install's log isn't kept");
      if (words) assert.match(done.stopped!.detail ?? "", words);
      else assert.equal(done.stopped!.detail, null, "a failure Nivra doesn't recognise was given a diagnosis");
      // The install's own words are kept as its log, never as Nivra's diagnosis.
      assert.ok(!(done.stopped!.detail ?? "").includes("frozen-lockfile") && !(done.stopped!.detail ?? "").includes("could not resolve"));
      // Readiness never ran on a failed install.
      assert.deepEqual(spawns(stub).map((spawn) => spawn.networking.enabled), [false, true]);
    }
  });

  it("keeps no environment when pnpm reports an empty selection, and asks the person to correct it", async () => {
    // Selectors are offered only on a pnpm release whose filtered installs were checked (D52): 11.28.9 here.
    const { stub, engine } = await setup({ node: "24.21.0", npm: "11.19.0", pnpm: "11.28.9", install: "fails", installLog: 'No projects matched the filters in "/workspace"\n' });
    const repo = repoWith({ ...PNPM, "package.json": json({ name: "mono", private: true, packageManager: "pnpm@11.28.9" }) });
    const choices: EnvironmentChoices = { scope: { kind: "selected", selectors: ["@mono/missing"] } };
    const shown = ready(await resolve(engine, repo, choices));
    assert.deepEqual(shown.recipe.install.args, ["install", "--frozen-lockfile", "--fail-if-no-match", "--filter", "@mono/missing"]);
    const run = await start(engine, repo, shown.fingerprint, choices);
    assert.equal((await ended(engine, run.id)).status, "failed");
    const result = await report(engine, run.id);
    assert.deepEqual([result.outcome, result.stopped?.code, result.stopped?.step, result.install?.exitCode, result.prepared, result.environment], ["failed", "install", "install", 1, null, null]);
    assert.match(result.stopped?.detail ?? "", /None of the workspace packages matched what was chosen.*Check the packages or selectors under What to install/);
    const operations = spawns(stub);
    assert.equal(operations.length, 2, "a failed selection must not run readiness");
    assert.deepEqual(operations[1]!.args.slice(5), ["pnpm", "11.28.9", "corepack-else-npm-global", "none", ...shown.recipe.install.args]);
  });

  it("refuses a run whose recipe isn't the one previewed, on the same commit, before anything is sent", async () => {
    // The same commit, other choices: only the recipe's digest tells the two apart.
    const { stub, engine } = await setup({ node: "22.23.4", npm: "10.9.9" });
    const repo = repoWith(NPM);
    const shown = ready(await resolve(engine, repo));
    const run = await start(engine, repo, shown.fingerprint, { options: { "ignore-scripts": true } });
    await ended(engine, run.id);
    const done = await report(engine, run.id);
    assert.deepEqual([done.outcome, done.stopped?.code], ["refused", "preview"]);
    assert.equal(spawns(stub).length, 0);
  });

  it("keeps nothing when the install left files outside node_modules, which every task's session would refuse, and names one", async () => {
    const { engine } = await setup({ node: "24.21.0", npm: "11.19.0", readiness: { extraFiles: [".pnp.cjs"] } });
    const repo = repoWith(PNPM);
    const run = await start(engine, repo, ready(await resolve(engine, repo)).fingerprint);
    await ended(engine, run.id);
    const done = await report(engine, run.id);
    assert.deepEqual([done.outcome, done.stopped?.code, done.environment], ["failed", "readiness", null]);
    assert.match(done.stopped!.detail!, /the install left 1 file outside node_modules, such as "\.pnp\.cjs", which a task's session would read as the commit's own/);
  });

  it("says when a rule for what task runs send stops a preparation, after the file it names, though preparing sends only the setup files", async () => {
    const { stub, engine } = await setup({ node: "24.21.0", npm: "11.19.0" });
    const stage = (shown: EnvironmentPreviewV2, code: string) => {
      assert.equal(shown.status, "refused");
      const refusal = shown as Extract<EnvironmentPreviewV2, { status: "refused" }>;
      assert.equal(refusal.code, code, refusal.message);
      assert.ok(refusal.message.startsWith("Task runs send the whole commit, and this one can't be sent: "), refusal.message);
      assert.ok(refusal.message.endsWith(" Preparing the environment would upload only its setup files, but no task run could start from this commit, so Nivra doesn't prepare it either."), refusal.message);
      return refusal.message;
    };
    // Built here, so this file holds no credential-shaped text of its own.
    const token = `ghp_${"a".repeat(36)}`;
    assert.match(stage(await resolve(engine, repoWith({ ...PNPM, "test/fixture.ts": `export const TOKEN = "${token}";\n` })), "content"), /test\/fixture\.ts in this commit holds what looks like a GitHub token/);
    assert.match(stage(await resolve(engine, repoWith({ ...PNPM, "assets/big.bin": new Uint8Array(2_200_000) })), "limit"), /assets\/big\.bin is 2200000 bytes, over the 2097152 Nivra sends for one file/);
    assert.equal(uploads(stub), 0);
  });

  it("answers a resolution that needs the person's choice, and one it refuses, through the same method", async () => {
    const { engine } = await setup({ node: "24.21.0", npm: "11.19.0" });
    const both = await resolve(engine, repoWith({ ...PNPM, ".node-version": "22.23.4\n" }));
    assert.equal(both.status, "needs-choice");
    const yarn = await resolve(engine, repoWith({ "package.json": json({ name: "x", packageManager: "yarn@4.1.0" }), "yarn.lock": "# yarn\n" }));
    assert.deepEqual([yarn.status, yarn.status === "refused" ? yarn.code : null], ["refused", "unsupported-manager"]);
  });
});

describe("chosen workspace packages prepared through a real engine (NIV-55, D52)", () => {
  /** A pnpm workspace on a checked pnpm: web links data, the root links lint, and other is linked from nothing. */
  const LINKED = {
    "package.json": json({ name: "mono", private: true, packageManager: "pnpm@11.28.9", devDependencies: { "@mono/lint": "workspace:*" } }),
    ".nvmrc": "24.21.0\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      '@mono/lint':",
      "        specifier: workspace:*",
      "        version: link:packages/lint",
      "",
      "  packages/data: {}",
      "",
      "  packages/lint: {}",
      "",
      "  packages/other: {}",
      "",
      "  packages/web:",
      "    dependencies:",
      "      '@mono/data':",
      "        specifier: workspace:*",
      "        version: link:../data",
      "",
    ].join("\n"),
    "packages/data/package.json": json({ name: "@mono/data", private: true }),
    "packages/lint/package.json": json({ name: "@mono/lint", private: true }),
    "packages/other/package.json": json({ name: "@mono/other", private: true }),
    "packages/web/package.json": json({ name: "@mono/web", private: true, dependencies: { "@mono/data": "*" } }),
  };
  /** The same for npm, with the npm Node 24.21.0 bundles. */
  const SITE = {
    "package.json": json({ name: "site", version: "1.0.0", private: true, workspaces: ["packages/*"], devDependencies: { "@site/lint": "*" } }),
    ".nvmrc": "24.21.0\n",
    "package-lock.json": json({
      name: "site",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "site", version: "1.0.0", workspaces: ["packages/*"], devDependencies: { "@site/lint": "*" } },
        "packages/data": { name: "@site/data", version: "1.0.0" },
        "packages/lint": { name: "@site/lint", version: "1.0.0" },
        "packages/web": { name: "@site/web", version: "1.0.0", dependencies: { "@site/data": "*" } },
        "node_modules/@site/data": { resolved: "packages/data", link: true },
        "node_modules/@site/lint": { resolved: "packages/lint", link: true },
        "node_modules/@site/web": { resolved: "packages/web", link: true },
      },
    }),
    "packages/data/package.json": json({ name: "@site/data", version: "1.0.0" }),
    "packages/lint/package.json": json({ name: "@site/lint", version: "1.0.0" }),
    "packages/web/package.json": json({ name: "@site/web", version: "1.0.0", dependencies: { "@site/data": "*" } }),
  };
  const web = (root: boolean): EnvironmentChoices => ({ scope: { kind: "packages", packages: ["packages/web"], root } });

  it("prepares chosen pnpm packages with exactly the filters previewed, and keeps the scope and the selection", async () => {
    const { stub, engine } = await setup({ node: "24.21.0", npm: "11.19.0", pnpm: "11.28.9" });
    const repo = repoWith(LINKED);
    const shown = ready(await resolve(engine, repo, web(true)));
    assert.deepEqual(shown.recipe.install.args, ["install", "--frozen-lockfile", "--fail-if-no-match", "--filter", "@mono/data", "--filter", "@mono/lint", "--filter", "@mono/web"]);
    assert.deepEqual(shown.recipe.selection?.packages.map((item) => [item.folder, item.chosen]), [["packages/data", false], ["packages/lint", false], ["packages/web", true]]);
    const run = await start(engine, repo, shown.fingerprint, web(true));
    assert.equal((await ended(engine, run.id)).status, "succeeded");
    const done = await report(engine, run.id);
    assert.equal(done.outcome, "prepared", JSON.stringify(done.stopped));
    assert.deepEqual([done.environment?.recipe.scope, done.environment?.recipe.selection, done.environment?.recipeDigest], [web(true).scope, shown.recipe.selection, shown.recipeDigest]);
    assert.deepEqual(spawns(stub)[1]!.args.slice(5), ["pnpm", "11.28.9", "corepack-else-npm-global", "none", ...shown.recipe.install.args]);
  });

  it("keeps no environment when pnpm passed over a chosen package's filter, and says so", async () => {
    const { stub, engine } = await setup({ node: "24.21.0", npm: "11.19.0", pnpm: "11.28.9", afterInstall: "filters-unmatched\n" });
    const repo = repoWith(LINKED);
    const shown = ready(await resolve(engine, repo, web(true)));
    const run = await start(engine, repo, shown.fingerprint, web(true));
    await ended(engine, run.id);
    const result = await report(engine, run.id);
    assert.deepEqual([result.outcome, result.stopped?.code, result.stopped?.step, result.environment], ["failed", "install", "install", null]);
    assert.match(result.stopped?.detail ?? "", /^pnpm didn't find every chosen workspace package in the workspace/);
    assert.equal(spawns(stub).length, 2, "readiness never ran");
  });

  it("prepares a chosen npm workspace with ./FOLDER for each package and the root's switch, and stops before upload on an npm not checked", async () => {
    const repo = repoWith(SITE);
    for (const root of [false, true]) {
      const { stub, engine } = await setup({ node: "24.21.0", npm: "11.19.0" });
      const shown = ready(await resolve(engine, repo, web(root)));
      const expected = ["ci", "--no-audit", "--no-fund", "--workspace=./packages/data", ...(root ? ["--workspace=./packages/lint"] : []), "--workspace=./packages/web", root ? "--include-workspace-root" : "--include-workspace-root=false"];
      assert.deepEqual(shown.recipe.install.args, expected);
      const run = await start(engine, repo, shown.fingerprint, web(root));
      assert.equal((await ended(engine, run.id)).status, "succeeded");
      const done = await report(engine, run.id);
      assert.deepEqual([done.outcome, done.environment?.recipe.selection?.root], ["prepared", root]);
      assert.deepEqual(spawns(stub)[1]!.args.slice(5), ["npm", "bundled", "none", "none", ...expected]);
    }
    // The index says Node 24.21.0 comes with npm 11.19.0; an image holding 11.14.0 is caught before anything is sent.
    const { stub, engine } = await setup({ node: "24.21.0", npm: "11.14.0" });
    const shown = ready(await resolve(engine, repo, web(false)));
    const run = await start(engine, repo, shown.fingerprint, web(false));
    await ended(engine, run.id);
    const result = await report(engine, run.id);
    assert.deepEqual([result.outcome, result.stopped?.code, uploads(stub)], ["failed", "inspect", 0]);
    assert.match(result.stopped?.detail ?? "", /holds npm 11\.14\.0\. npm 11\.14\.0's ci/);
  });
});
