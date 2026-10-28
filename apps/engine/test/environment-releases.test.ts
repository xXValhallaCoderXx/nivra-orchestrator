import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RELEASE_DATA } from "../src/environment/release-data.ts";
import { corepackBundled, releaseIndexOf, RELEASES, standing } from "../src/environment/releases.ts";
import { expandBraces, globMatcher, npmLockFacts, pnpmLockFacts, simpleYaml, unreadGlob, versionFileValue, workspaceMembers } from "../src/environment/node-files.ts";
import { compareVersions, versionParts } from "../src/environment/versions.ts";

/**
 * Nivra's release index and the Node file readers (NIV-55): the shipped data is ordered, exact and attributed, and each
 * reader takes the shapes projects really write, saying what it couldn't read.
 */

describe("the release index Nivra ships", () => {
  it("holds exact stable versions, newest first, with where and when it came from", () => {
    assert.equal(RELEASE_DATA.sources.length, 3);
    for (const source of RELEASE_DATA.sources) assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!Number.isNaN(Date.parse(RELEASE_DATA.fetchedAt)));
    for (const [name, rows] of [["node", RELEASE_DATA.node], ["npm", RELEASE_DATA.npm], ["pnpm", RELEASE_DATA.pnpm]] as const) {
      assert.ok(rows.length > 50, `${name} has releases`);
      const versions = rows.map((row) => row[0]);
      assert.ok(versions.every((version) => versionParts(version) !== null), `${name}: every version is exact`);
      const sorted = [...versions].sort((a, b) => compareVersions(b, a));
      assert.deepEqual(versions.slice(0, 5), sorted.slice(0, 5), `${name}: newest first`);
      assert.equal(new Set(versions).size, versions.length, `${name}: no duplicates`);
    }
    assert.ok(RELEASES.node.some((release) => release.lts !== null), "LTS lines are named");
  });

  it("says where a version stands: listed, newer than the index, older than it, or not a release", () => {
    const list = [{ version: "24.21.0" }, { version: "24.20.0" }, { version: "22.23.4" }];
    assert.deepEqual(["24.21.0", "24.22.0", "26.0.0", "22.24.1", "22.20.0", "20.19.0", "23.1.0"].map((version) => standing(list, version)), ["listed", "newer", "newer", "newer", "missing", "older", "missing"]);
  });

  it("knows which Node releases bundle corepack", () => {
    assert.deepEqual(["14.18.3", "14.19.0", "16.8.0", "16.9.0", "22.23.4", "24.21.0", "25.0.0", "26.12.1"].map(corepackBundled), [false, true, false, true, true, true, false, false]);
  });
});

describe("Node file readers", () => {
  it("reads a version file's first value, without comments, and .tool-versions' node line", () => {
    assert.equal(versionFileValue(".nvmrc", "# pinned\n\nv24.21.0 # the LTS\n"), "v24.21.0");
    assert.equal(versionFileValue(".tool-versions", "python 3.12.1\nnodejs 22.11.0 20.10.0\n"), "22.11.0");
    assert.equal(versionFileValue(".tool-versions", "python 3.12.1\n"), null);
  });

  it("reads pnpm-workspace.yaml's simple shapes, and lists what it can't read instead of guessing", () => {
    const { values, unreadable } = simpleYaml(
      [
        "# the workspace",
        "packages:",
        "  - 'apps/*'",
        "  - packages/**",
        "  - '!**/test/**'",
        "allowBuilds:",
        "  esbuild: true",
        "  '@swc/core': false",
        "strictDepBuilds: false",
        "onlyBuiltDependencies: [esbuild, sharp]",
        "catalogs:",
        "  default:",
        "    react: ^18",
        "nodeLinker: hoisted",
      ].join("\n"),
    );
    assert.deepEqual(values.get("packages"), ["apps/*", "packages/**", "!**/test/**"]);
    assert.deepEqual(values.get("allowBuilds"), { esbuild: true, "@swc/core": false });
    assert.deepEqual([values.get("strictDepBuilds"), values.get("onlyBuiltDependencies"), values.get("nodeLinker")], [false, ["esbuild", "sharp"], "hoisted"]);
    assert.deepEqual(unreadable, ["catalogs"]);
    // A byte-order mark, a comment straight after a key, and list items at the key's own column.
    assert.deepEqual(simpleYaml("\uFEFFpackages: # all of them\n- apps/*\n- 'tools/*'\nstrictDepBuilds: true # yes\n").values, new Map<string, unknown>([["packages", ["apps/*", "tools/*"]], ["strictDepBuilds", true]]));
  });

  it("matches workspace globs as package managers do, a negation removing what an include took", () => {
    const folders = ["apps/web", "apps/web/test/fixture", "packages/data", "packages/deep/inner", "tools"];
    // apps/** would take the fixture; the negation is what removes it.
    assert.deepEqual(workspaceMembers(["apps/**", "packages/**"], folders), ["apps/web", "apps/web/test/fixture", "packages/data", "packages/deep/inner"]);
    assert.deepEqual(workspaceMembers(["apps/**", "packages/**", "!**/test/**"], folders), ["apps/web", "packages/data", "packages/deep/inner"]);
    assert.deepEqual(workspaceMembers(["apps/*"], folders), ["apps/web"], "one star is one folder");
    assert.equal(globMatcher("./packages/*/").test("packages/x"), true);
  });

  it("keeps advisories apart from the generated rows, so a refresh never drops one", () => {
    assert.equal("advisories" in RELEASE_DATA, false);
    const index = releaseIndexOf(RELEASE_DATA, [{ tool: "node", version: "1.0.0", reason: "a test", replacement: "2.0.0" }]);
    assert.deepEqual(index.advisories.map((advisory) => advisory.version), ["1.0.0"]);
    assert.ok(Array.isArray(RELEASES.advisories));
  });

  it("reads a pnpm lockfile's format, tarball hosts, git resolutions and engines", () => {
    const facts = pnpmLockFacts(
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  '@scope/a@1.0.0':",
        "    resolution: {integrity: sha512-x, tarball: https://npm.example.com/@scope/a/-/a-1.0.0.tgz}",
        "    engines: {node: '>=18'}",
        "",
        "  b@2.0.0:",
        "    resolution: {commit: abc, repo: https://github.com/o/b.git, type: git}",
        "",
        "snapshots:",
        "",
        "  b@2.0.0: {}",
      ].join("\n"),
    );
    assert.deepEqual([facts.format, facts.hosts, facts.git, facts.engines], ["9.0", ["npm.example.com"], ["b"], [{ name: "@scope/a", range: ">=18" }]]);
  });
});

describe("Nate's review of PR 31: the readers, each finding kept fixed (NIV-55)", () => {
  it("expands brace lists and matches ? in workspace globs, and names the syntax it can't read", () => {
    const folders = ["packages/a", "packages/b", "packages/c", "apps/web", "apps/api", "tools/x1"];
    assert.deepEqual(workspaceMembers(["packages/{a,b}"], folders), ["packages/a", "packages/b"], "pnpm and npm include both");
    assert.deepEqual(workspaceMembers(["{apps,packages}/{web,a}"], folders), ["packages/a", "apps/web"]);
    assert.deepEqual(workspaceMembers(["packages/*", "!packages/{b,c}"], folders), ["packages/a"], "a negated list removes each");
    assert.deepEqual(workspaceMembers(["tools/x?"], folders), ["tools/x1"]);
    assert.deepEqual(expandBraces("a/{b,{c,d}}/e"), ["a/b/e", "a/c/e", "a/d/e"], "nested lists");
    assert.equal(globMatcher("packages/{a,b}").test("packages/{a,b}"), false, "never the braces as text");
    for (const glob of ["packages/[ab]", "packages/@(a|b)", "packages/{1..3}", "packages/{a}", "packages/{a,b", "packages/a\\*", `${"{a,b}".repeat(9)}`]) {
      assert.equal(unreadGlob(["apps/*", glob]), glob, glob);
    }
    assert.equal(unreadGlob(["apps/*", "!packages/{a,b}", "tools/x?"]), null);
  });

  it("reads a pnpm lockfile's resolution, engines and libc written as blocks, and lists what it can't read", () => {
    const facts = pnpmLockFacts(
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  a@1.0.0:",
        "    resolution:",
        "      integrity: sha512-x",
        "      tarball: https://npm.example.com/a/-/a-1.0.0.tgz",
        "    engines:",
        "      node: '>=18'",
        "    libc:",
        "    - musl",
        "  b@2.0.0:",
        "    resolution: {integrity: sha512-y,",
        "      tarball: 'https://other.example.com/b.tgz'}",
        "  c@3.0.0:",
        "    resolution:",
        "      type: git",
        "      repo: https://github.com/o/c.git",
        "      commit: abc",
        "  d@4.0.0:",
        "    resolution:",
        "      type: directory",
        "      directory: ../d",
      ].join("\n"),
    );
    assert.deepEqual([facts.hosts, facts.git, facts.local, facts.unreadable], [["npm.example.com", "other.example.com"], ["c"], ["d"], []]);
    assert.deepEqual([facts.engines, facts.libc], [[{ name: "a", range: ">=18" }], [{ name: "a", libc: ["musl"] }]]);
    // As pnpm 11 writes its own packages, through a formatter: a flow mapping beneath its key, across lines, in a second document.
    const formatted = pnpmLockFacts(['---', 'lockfileVersion: "9.0"', "packages:", '  "@pnpm/exe@11.5.3":', "    resolution:", "      {", "        integrity: sha512-x,", "        tarball: https://npm.example.com/exe.tgz,", "      }", "    libc:", "      [", "        musl,", "      ]", "---", "lockfileVersion: '9.0'", "packages:", "  b@1.0.0:", "    resolution: {integrity: sha512-y}"].join("\n"));
    assert.deepEqual([formatted.hosts, formatted.libc, formatted.unreadable], [["npm.example.com"], [{ name: "@pnpm/exe", libc: ["musl"] }], []]);
    const unread = (lines: string[]) => pnpmLockFacts(["lockfileVersion: '9.0'", ...lines].join("\n")).unreadable;
    assert.deepEqual(unread(["packages:", "  a@1.0.0:", "    resolution: &r {tarball: https://npm.example.com/a.tgz}"]), ["a@1.0.0 (resolution)"], "an anchor");
    assert.deepEqual(unread(["packages:", "  a@1.0.0:", "    resolution:", "      tarball: >-", "        https://npm.example.com/a.tgz"]), ["a@1.0.0 (resolution)"], "a block scalar");
    assert.deepEqual(unread(["packages:", "  a@1.0.0:", "    resolution: {type: binary, url: https://nodejs.org/x.tgz}"]), ["a@1.0.0 (resolution)"], "a kind Nivra doesn't know");
    assert.deepEqual(unread(["packages:", "  a@1.0.0:", "    resolution: {tarball: ftp://npm.example.com/a.tgz}"]), ["a@1.0.0 (resolution)"], "an address that isn't http");
    assert.deepEqual(unread(["packages:", "  a@1.0.0:", "    resolution: {integrity: x}", "    resolution: {tarball: https://npm.example.com/a.tgz}"]), ["a@1.0.0 (resolution)"], "a field given twice");
    assert.deepEqual(unread(["packages:", "  a@1.0.0:", "    engines:", "      node:", "        - '>=18'"]), ["a@1.0.0 (engines)"]);
    assert.deepEqual(unread(["packages: {a@1.0.0: {resolution: {tarball: https://npm.example.com/a.tgz}}}"]), ["the packages section"], "a section in flow style");
    assert.deepEqual(unread(["packages:", "    a@1.0.0:", "      resolution: {integrity: x}", "  b@1.0.0:", "      resolution: {integrity: y}"]), ["the packages section"], "an entry out of line");
    assert.deepEqual(unread(['"packages":', "  a@1.0.0:", "    resolution: {tarball: https://npm.example.com/a.tgz}"]), ["a line outside any section"]);
  });

  it("refuses an npm lockfile entry whose address it can't read", () => {
    const lock = (resolved: unknown) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.0.0", resolved } } });
    assert.deepEqual(npmLockFacts(lock(["https://npm.example.com/a.tgz"]))!.unreadable, ["node_modules/a (resolved)"]);
    assert.deepEqual(npmLockFacts(lock("ftp://npm.example.com/a.tgz"))!.unreadable, ["node_modules/a (resolved)"]);
    assert.deepEqual(npmLockFacts(lock("https://registry.npmjs.org/a/-/a-1.0.0.tgz"))!.unreadable, []);
  });
});
