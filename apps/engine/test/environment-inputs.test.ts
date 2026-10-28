import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { EnvironmentPreview } from "@nivra/domain";
import { readTar } from "../src/exec/tar.ts";
import { configurationDigest, environmentInputs, EnvironmentRefusal, inputsArchive, inputsDigest, installArgsFor, satisfies, setupCheck, setupConfiguration } from "../src/environment/inputs.ts";
import { isNodeSetupPath } from "../src/environment/node-files.ts";
import { environmentPreviewOf } from "../src/environment/preview.ts";
import { cleanUp, repoWith, snap } from "./workspace-fixtures.ts";

/**
 * A project's environment inputs (NIV-49, D41), read from Nivra's own snapshot of the commit. Two layouts, with no
 * change to Nivra between them:
 * - a workspace laid out like an app monorepo (apps/* and packages/*);
 * - a small single-package repository with no workspace file.
 * Then the layouts it refuses, each naming why, and the Node ranges it reads.
 */
after(cleanUp);

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const MONOREPO = {
  "package.json": json({ name: "mono", private: true, packageManager: "pnpm@11.5.3", engines: { node: ">=22" }, scripts: { test: "pnpm -r test" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
  ".npmrc": "node-linker=hoisted\n",
  "apps/web/package.json": json({ name: "web", private: true, dependencies: { data: "workspace:*" } }),
  "apps/web/src/main.ts": "export const web = 1;\n",
  "packages/data/package.json": json({ name: "@mono/data", private: true, scripts: { test: "vitest run" } }),
  "packages/data/src/index.ts": "export const data = 1;\n",
  "packages/data/tests/data.test.ts": "import { data } from '../src/index.ts';\n",
  "README.md": "# Mono\n",
};
const SINGLE = {
  "package.json": json({ name: "tool", version: "1.0.0", packageManager: "pnpm@10.4.1+sha512.c753b6c3ad7afa13af388fa6d808035a008e30ea9993f58c6663e2bc5ff21679aa834db094987129aa4d488b86df57f7b634981b2f827cdcacc698cc0cfb88af", engines: { node: "^22.10.0" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "src/index.mjs": "export const tool = 1;\n",
  "test/index.test.mjs": "import { tool } from '../src/index.mjs';\n",
};

describe("an environment's inputs (NIV-49, D41)", () => {
  it("takes a workspace's manifests, lockfile and workspace file, never .npmrc, and binds them by one digest", async () => {
    const inputs = environmentInputs(await snap(repoWith(MONOREPO)));
    assert.deepEqual(inputs.files.map((file) => file.path).sort(), ["apps/web/package.json", "package.json", "packages/data/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
    assert.deepEqual([inputs.leftOut, inputs.packageManager, inputs.nodeRequirement, inputs.nodeAllowed], [[".npmrc"], "pnpm@11.5.3", ">=22", true]);
    assert.deepEqual(inputs.packages, [
      { name: "web", path: "apps/web" },
      { name: "@mono/data", path: "packages/data" },
    ]);
    // The archive holds exactly the inputs, byte for byte, and the same commit always gives the same bytes.
    const archive = inputsArchive(inputs.files);
    const entries = readTar(new Uint8Array(gunzipSync(archive)), { maxEntries: 100, maxBytes: 1 << 22, maxEntryBytes: 1 << 22, maxPathBytes: 1024 }).filter((entry) => entry.kind === "file");
    assert.deepEqual(entries.map((entry) => entry.path).sort(), inputs.files.map((file) => file.path).sort());
    assert.deepEqual(inputsArchive(inputs.files), archive);
    // A source change leaves the digest alone; a manifest change doesn't.
    const sourceOnly = environmentInputs(await snap(repoWith({ ...MONOREPO, "packages/data/src/index.ts": "export const data = 2;\n" })));
    const manifest = environmentInputs(await snap(repoWith({ ...MONOREPO, "packages/data/package.json": json({ name: "@mono/data", private: true, scripts: { test: "vitest run --reporter=dot" } }) })));
    assert.deepEqual([sourceOnly.digest === inputs.digest, manifest.digest === inputs.digest], [true, false]);
  });

  it("takes a single-package repository with no workspace file, its pnpm pin read without its integrity suffix", async () => {
    const inputs = environmentInputs(await snap(repoWith(SINGLE)));
    assert.deepEqual([inputs.files.map((file) => file.path).sort(), inputs.packageManager, inputs.nodeAllowed, inputs.packages], [["package.json", "pnpm-lock.yaml"], "pnpm@10.4.1", true, []]);
  });

  it("refuses a layout that needs the sources to install, or isn't pinned, naming why", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...MONOREPO, "packages/data/package.json": json({ name: "@mono/data", scripts: { postinstall: "node build.js" } }) }, /packages\/data\/package\.json runs postinstall during an install/],
      [{ ...MONOREPO, "package.json": json({ name: "mono", packageManager: "pnpm@11.5.3", scripts: { prepare: "husky" } }) }, /^package\.json runs prepare/],
      [{ ...MONOREPO, "package.json": json({ name: "mono", packageManager: "pnpm@11.5.3", scripts: { "pnpm:devPreinstall": "node setup.js" } }) }, /^package\.json runs pnpm:devPreinstall during an install/],
      [{ ...MONOREPO, ".pnpmfile.cjs": "module.exports = {};\n" }, /has \.pnpmfile\.cjs, which runs code from the repository/],
      [{ ...MONOREPO, "pnpm-workspace.yaml": "packages:\n  - packages/*\npatchedDependencies:\n  left-pad: patches/left-pad.patch\n" }, /patches its dependencies/],
      [{ ...MONOREPO, "package.json": json({ name: "mono", packageManager: "pnpm@11.5.3", pnpm: { patchedDependencies: { a: "p.patch" } } }) }, /patches its dependencies/],
      [{ ...MONOREPO, "package.json": json({ name: "mono", packageManager: "npm@10.0.0" }) }, /doesn't pin pnpm to an exact version/],
      [{ ...MONOREPO, "package.json": json({ name: "mono", packageManager: "pnpm@11" }) }, /doesn't pin pnpm to an exact version/],
      [{ ...MONOREPO, "package.json": json({ name: "mono", packageManager: "pnpm@11.5.3", engines: { node: ">=24" } }) }, /needs Node >=24, and Nivra's environment has Node v22\.23\.4/],
      [{ ...MONOREPO, "packages/data/package.json": "{ not json\n" }, /packages\/data\/package\.json isn't a JSON object/],
      [Object.fromEntries(Object.entries(MONOREPO).filter(([path]) => path !== "pnpm-lock.yaml")), /no pnpm-lock\.yaml/],
      [{ "README.md": "# Not a Node project\n" }, /no package\.json at its top/],
    ];
    for (const [files, pattern] of cases) {
      const snapshot = await snap(repoWith(files));
      assert.throws(() => environmentInputs(snapshot), (error: unknown) => error instanceof EnvironmentRefusal && pattern.test(error.message), String(pattern));
    }
  });

  it("previews what preparation sends and runs, bound by a fingerprint that changes with the spec", async () => {
    const snapshot = await snap(repoWith(MONOREPO));
    const all = environmentPreviewOf(snapshot, { filters: [] });
    const data = environmentPreviewOf(snapshot, { filters: ["@mono/data..."] });
    assert.equal(EnvironmentPreview.safeParse(data).success, true);
    assert.deepEqual([all.installArgs, data.installArgs], [["--frozen-lockfile"], ["--frozen-lockfile", "--filter", "@mono/data..."]]);
    assert.notEqual(all.fingerprint, data.fingerprint);
    assert.equal(environmentPreviewOf(snapshot, { filters: ["@mono/data..."] }).fingerprint, data.fingerprint);
    assert.deepEqual(installArgsFor({ filters: ["a", "b..."] }), ["--frozen-lockfile", "--filter", "a", "--filter", "b..."]);
  });
});

describe("a Node range as package.json's engines write it", () => {
  it("reads the common forms, and says when it can't", () => {
    const yes = [">=22", ">=22.23.4", "^22", "^22.10.0", "~22.23", "22", "22.x", "22.23.x", ">=20 <23", "<23", "<=22", ">21", "*", "", "^18 || ^22", "v22", "x", "20 - 22", ">= 22", ">=  22 <  23"];
    const no = [">=24", "^20", "~22.22", "21", "<22", ">22", "22.23.5", ">=22.24", "^18 || ^20", "18 - 21", "> 22"];
    for (const range of yes) assert.equal(satisfies("22.23.4", range), true, range);
    for (const range of no) assert.equal(satisfies("22.23.4", range), false, range);
    for (const range of ["lts", ">=22.0.0-rc.1", "latest", "~> 22"]) assert.equal(satisfies("22.23.4", range), null, range);
  });

  it("reads hyphen ranges and partial versions as npm documents them (NIV-55)", () => {
    // From npm's semver documentation: a partial version on either side of a hyphen range.
    const cases: Array<[string, string, boolean]> = [
      ["1.2.3 - 2.3.4", "1.2.3", true],
      ["1.2.3 - 2.3.4", "2.3.4", true],
      ["1.2.3 - 2.3.4", "2.3.5", false],
      ["1.2 - 2.3.4", "1.2.0", true],
      ["1.2 - 2.3.4", "1.1.9", false],
      ["1.2.3 - 2.3", "2.3.9", true],
      ["1.2.3 - 2.3", "2.4.0", false],
      ["1.2.3 - 2", "2.9.9", true],
      ["1.2.3 - 2", "3.0.0", false],
      ["^0.2.3", "0.2.9", true],
      ["^0.2.3", "0.3.0", false],
      ["^0.0.3", "0.0.3", true],
      ["^0.0.3", "0.0.4", false],
      ["~1.2", "1.2.9", true],
      ["~1.2", "1.3.0", false],
      ["1.x", "1.9.9", true],
      ["^20.19.0 || >=22.12.0", "22.12.0", true],
      ["^20.19.0 || >=22.12.0", "21.0.0", false],
    ];
    for (const [range, version, expected] of cases) assert.equal(satisfies(version, range), expected, `${version} against ${range}`);
  });
});

describe("a setup configuration (NIV-55)", () => {
  it("binds only the files that decide the environment, so a version file counts and a source doesn't", async () => {
    const base = await snap(repoWith(SINGLE));
    const config = setupConfiguration(base, isNodeSetupPath);
    assert.deepEqual(config.files.map((file) => file.path), ["package.json", "pnpm-lock.yaml"]);
    const sources = setupConfiguration(await snap(repoWith({ ...SINGLE, "src/index.mjs": "export const tool = 2;\n" })), isNodeSetupPath);
    assert.equal(sources.digest, config.digest);
    const nvmrc = setupConfiguration(await snap(repoWith({ ...SINGLE, ".nvmrc": "22\n" })), isNodeSetupPath);
    assert.deepEqual([nvmrc.files.map((file) => file.path), nvmrc.digest === config.digest], [[".nvmrc", "package.json", "pnpm-lock.yaml"], false]);
    // Its digest has a version of its own: never the same as the D41 inputs digest of the same files.
    assert.notEqual(configurationDigest(config.files), inputsDigest(config.files));
  });

  it("follows each ecosystem's own rule for what is setup, with nothing Node-shaped in it", async () => {
    const toy = await snap(repoWith({ "toy.json": "{}\n", "toy.lock": "a\n", "src/main.toy": "print\n" }));
    const isToySetup = (path: string) => path === "toy.json" || path === "toy.lock";
    const before = setupConfiguration(toy, isToySetup);
    assert.deepEqual(before.files.map((file) => file.path), ["toy.json", "toy.lock"]);
    const after = setupConfiguration(await snap(repoWith({ "toy.json": "{}\n", "toy.lock": "b\n", "src/main.toy": "print\n" })), isToySetup);
    assert.notEqual(after.digest, before.digest);
  });
});

describe("the setup files after a task, against the commit's (NIV-55)", () => {
  const entries = (files: Record<string, string>) => Object.entries(files).map(([path, text]) => ({ path, kind: "file" as const, sha256: createHash("sha256").update(text).digest("hex") }));
  it("finds a setup file changed, added or removed, and never counts a source", async () => {
    const files = { "package.json": "{}\n", ".nvmrc": "24\n", "packages/a/package.json": "{}\n", "src/a.ts": "a\n" };
    const snapshot = await snap(repoWith(files));
    assert.deepEqual(setupCheck(snapshot, entries({ ...files, "src/a.ts": "edited\n", "src/b.ts": "new\n" }), isNodeSetupPath), { unchanged: true, changed: [] });
    const { ".nvmrc": _removed, ...rest } = files;
    assert.deepEqual(setupCheck(snapshot, entries({ ...rest, "package.json": '{ "edited": true }\n', "packages/b/package.json": "{}\n" }), isNodeSetupPath), { unchanged: false, changed: [".nvmrc", "package.json", "packages/b/package.json"] });
    // A setup file come back as a link is a change, even one whose target reads as the file's text did.
    assert.deepEqual(setupCheck(snapshot, [...entries(rest), { path: ".nvmrc", kind: "link" as const, target: "24\n" }], isNodeSetupPath), { unchanged: false, changed: [".nvmrc"] });
  });
});

describe("D41's preview of a commit that tracks build output (NIV-55)", () => {
  it("refuses it, naming the folder and a file, since its task runs leave the folder out and would refuse it", async () => {
    const files = { "package.json": `${JSON.stringify({ name: "app", private: true, packageManager: "pnpm@11.5.3" })}\n`, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "src/index.js": "export {};\n", "build/icon.png": "png" };
    const snapshot = await snap(repoWith(files));
    assert.throws(() => environmentPreviewOf(snapshot, { filters: [] }), (error: Error) => error instanceof EnvironmentRefusal && /^This commit tracks files in build, such as "build\/icon\.png", which this kind of environment leaves out of its task runs, so they would refuse it\./.test(error.message));
  });
});
