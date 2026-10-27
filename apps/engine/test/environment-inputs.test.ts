import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { EnvironmentPreview } from "@nivra/domain";
import { readTar } from "../src/exec/tar.ts";
import { environmentInputs, EnvironmentRefusal, inputsArchive, installArgsFor, satisfies } from "../src/environment/inputs.ts";
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
    const yes = [">=22", ">=22.23.4", "^22", "^22.10.0", "~22.23", "22", "22.x", "22.23.x", ">=20 <23", "<23", "<=22", ">21", "*", "", "^18 || ^22", "v22", "x"];
    const no = [">=24", "^20", "~22.22", "21", "<22", ">22", "22.23.5", ">=22.24", "^18 || ^20"];
    for (const range of yes) assert.equal(satisfies("22.23.4", range), true, range);
    for (const range of no) assert.equal(satisfies("22.23.4", range), false, range);
    for (const range of ["20 - 22", "lts", ">=22.0.0-rc.1"]) assert.equal(satisfies("22.23.4", range), null, range);
  });
});
