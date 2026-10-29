import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkedFolder, npmLockFacts, pnpmLockFacts } from "../src/environment/node-files.ts";
import { filteredInstallProblem, regressedLockfileWriter } from "../src/environment/workspace.ts";

/**
 * Workspace packages chosen by folder (NIV-55, D52): which package manager releases Nivra offers them on, each range
 * checked against the releases' own notes, and what the lockfile readers record of the links an install follows.
 */
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("the releases chosen packages are offered on (D52)", () => {
  it("takes pnpm 9.5.0 to 9.15.9 and 10.0.0 to 10.34.9 with the isolated linker, and 11.28.6 to 11.28.9, and nothing else", () => {
    const takes = (version: string, hoisted = false) => filteredInstallProblem("pnpm", version, hoisted) === null;
    assert.deepEqual(
      ["9.4.9", "9.5.0", "9.15.9", "10.0.0", "10.34.9", "10.34.10", "11.0.0", "11.27.1", "11.28.0", "11.28.5", "11.28.6", "11.28.9", "11.28.10", "11.29.0", "12.0.0", "8.15.9", "7.33.0"].map((version) => [version, takes(version)]),
      [
        ["9.4.9", false],
        ["9.5.0", true],
        ["9.15.9", true],
        ["10.0.0", true],
        ["10.34.9", true],
        ["10.34.10", false],
        ["11.0.0", false],
        ["11.27.1", false],
        ["11.28.0", false],
        ["11.28.5", false],
        ["11.28.6", true],
        ["11.28.9", true],
        ["11.28.10", false],
        ["11.29.0", false],
        ["12.0.0", false],
        ["8.15.9", false],
        ["7.33.0", false],
      ],
    );
    assert.deepEqual([takes("9.15.9", true), takes("10.34.9", true), takes("11.28.6", true)], [false, false, true], "a hoisted node linker only from 11.28.6");
  });

  it("takes npm 9.7.2 to 9.9.4, 10.8.1 to 10.9.9, 11.0.0 to 11.13.0 and 11.15.0 to 11.21.1, and nothing else", () => {
    const takes = (version: string) => filteredInstallProblem("npm", version) === null;
    assert.deepEqual(
      ["8.19.4", "9.7.1", "9.7.2", "9.9.4", "10.0.0", "10.8.0", "10.8.1", "10.9.9", "11.0.0", "11.13.0", "11.14.0", "11.14.1", "11.15.0", "11.21.1", "11.21.2", "12.0.0"].map((version) => [version, takes(version)]),
      [
        ["8.19.4", false],
        ["9.7.1", false],
        ["9.7.2", true],
        ["9.9.4", true],
        ["10.0.0", false],
        ["10.8.0", false],
        ["10.8.1", true],
        ["10.9.9", true],
        ["11.0.0", true],
        ["11.13.0", true],
        ["11.14.0", false],
        ["11.14.1", false],
        ["11.15.0", true],
        ["11.21.1", true],
        ["11.21.2", false],
        ["12.0.0", false],
      ],
    );
  });

  it("says why, and what to do, in each case", () => {
    assert.match(filteredInstallProblem("pnpm", "9.4.9")!, /^pnpm 9\.4\.9 installs every workspace package when it's asked for some \(pnpm 9\.5\.0 and later install only those\)\. Nivra has checked pnpm 9\.5\.0 to 9\.15\.9/);
    assert.match(filteredInstallProblem("pnpm", "11.28.3")!, /^pnpm 11\.28\.3 can leave out a dependency that a package also declares as an optional peer, in the installs it makes and the lockfiles it writes \(fixed in pnpm 11\.28\.6\)\./);
    assert.match(filteredInstallProblem("pnpm", "12.16.1")!, /^Nivra hasn't checked how pnpm 12\.16\.1 installs chosen workspace packages\. .*pin one of those in package\.json's packageManager, or install the whole project\.$/);
    assert.match(filteredInstallProblem("pnpm", "10.4.1", true)!, /hoisted node linker .*Use the isolated linker, pin pnpm 11\.28\.6 or later, or install the whole project\.$/);
    assert.match(filteredInstallProblem("npm", "11.14.1")!, /^npm 11\.14\.1's ci .*npm\/cli 9357, fixed in npm 11\.15\.0/);
    assert.match(filteredInstallProblem("npm", "latest")!, /^Nivra can't tell which npm release "latest" is/);
    assert.deepEqual(["11.27.1", "11.28.0", "11.28.5", "11.28.6", null, "latest"].map((version) => regressedLockfileWriter(version)), [false, true, true, false, false, false]);
  });
});

describe("what the lockfile readers record of the links an install follows (D52)", () => {
  it("resolves a link from its folder, the top as the empty folder, and never past the top", () => {
    assert.deepEqual([linkedFolder("apps/web", "../../packages/data"), linkedFolder("packages/data", "../core"), linkedFolder("", "packages/lint"), linkedFolder("web", ".."), linkedFolder("web", "../..")], ["packages/data", "packages/core", "packages/lint", "", null]);
  });

  it("records pnpm's importer links in both YAML styles, the env document's pnpm, and links outside importers only as values", () => {
    const lock = [
      "---",
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    packageManagerDependencies:",
      "      pnpm: {specifier: 11.28.4, version: 11.28.4}",
      "",
      "---",
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      '@w/lint': {specifier: 'workspace:*', version: 'link:packages/lint'}",
      "",
      "  apps/web:",
      "    dependencies:",
      "      ui-kit:",
      "        specifier: workspace:@w/ui@*",
      "        version: link:../../packages/ui",
      "",
      "  packages/ui: {}",
      "",
      "  packages/lint: {}",
      "",
      "snapshots:",
      "",
      "  chalk@5.0.0:",
      "    dependencies:",
      "      terminal-link: 2.1.1",
      "",
    ].join("\n");
    const facts = pnpmLockFacts(lock);
    assert.deepEqual([facts.unreadable, facts.workspaces, [...facts.links.entries()], facts.writer, facts.deepLinks], [[], ["apps/web", "packages/lint", "packages/ui"], [["", ["packages/lint"]], ["apps/web", ["packages/ui"]], ["packages/ui", []], ["packages/lint", []]], "11.28.4", false]);
    for (const deep of ["      '@w/core': link:packages/core", "      dependencies: {'@w/core': 'link:packages/core'}"]) {
      assert.equal(pnpmLockFacts(lock.replace("      terminal-link: 2.1.1", deep)).deepLinks, true, deep);
    }
    assert.equal(pnpmLockFacts(lock.replace("version: link:../../packages/ui", "version: link:../../../outside")).local.length, 1, "a link out of the repository is a local folder, as before");
  });

  it("keeps npm's entries for resolving: workspaces, links, and each dependency as an install needs it", () => {
    const facts = npmLockFacts(
      json({
        name: "site",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "site", devDependencies: { "@w/lint": "*" } },
          "packages/ui": { name: "@w/ui", dependencies: { a: "^1" }, optionalDependencies: { b: "^1" }, peerDependencies: { react: "^18", vue: "^3" }, peerDependenciesMeta: { react: { optional: true } }, devDependencies: { c: "^1" } },
          "node_modules/@w/ui": { resolved: "packages/ui", link: true },
          "node_modules/x": { version: "1.0.0", resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz", dependencies: { a: "^1" }, devDependencies: { never: "^1" } },
        },
      }),
    )!;
    assert.deepEqual(facts.workspaces, ["packages/ui"]);
    const entry = (key: string) => facts.tree!.get(key)!;
    assert.deepEqual([entry("").requires, entry("packages/ui").requires, entry("packages/ui").optionalPeers, entry("node_modules/x").requires], [
      [{ name: "@w/lint", optional: false }],
      [
        { name: "a", optional: false },
        { name: "c", optional: false },
        { name: "b", optional: true },
        { name: "react", optional: true },
        { name: "vue", optional: true },
      ],
      ["react"],
      [{ name: "a", optional: false }],
    ]);
    assert.deepEqual([entry("node_modules/@w/ui").link, entry("node_modules/@w/ui").resolved], [true, "packages/ui"]);
  });
});
