import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { EnvironmentResolution, recipeDigest, type EnvironmentChoices, type EnvironmentResolution as Resolution } from "@nivra/domain";
import { resolveNodeEnvironment, type NodeResolveInput } from "../src/environment/node.ts";
import type { ReleaseIndex } from "../src/environment/releases.ts";
import { cleanUp, repoWith, snap, type Content } from "./workspace-fixtures.ts";

/**
 * Node's resolver (NIV-55, NIV-58), against a small fixed release index so every answer is known: exact pins honoured,
 * ranges resolved and recorded, a labelled default when nothing is declared, conflicts and unreadable declarations put
 * to the person, and the layouts that need the sources refused, each naming why. No repository here is special: each is
 * built from its files at run time.
 */
after(cleanUp);

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const PNPM_LOCK = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
const npmLock = (packages: Record<string, unknown> = {}) => json({ name: "app", lockfileVersion: 3, requires: true, packages: { "": { name: "app" }, ...packages } });

const INDEX: ReleaseIndex = {
  fetchedAt: "2026-10-28T00:00:00.000Z",
  node: [
    { version: "26.2.0", npm: "11.6.0", lts: null },
    { version: "24.21.0", npm: "11.19.0", lts: "Krypton" },
    { version: "24.20.0", npm: "11.18.0", lts: "Krypton" },
    { version: "22.23.4", npm: "10.9.9", lts: "Jod" },
    { version: "22.12.0", npm: "10.9.0", lts: "Jod" },
    { version: "20.19.0", npm: "10.8.2", lts: "Iron" },
  ],
  managers: {
    npm: [
      { version: "11.19.0", node: "^20.17.0 || >=22.9.0", deprecated: false },
      { version: "10.9.9", node: "^18.17.0 || >=20.5.0", deprecated: false },
      { version: "7.24.2", node: ">=10", deprecated: false },
    ],
    pnpm: [
      { version: "12.1.0", node: ">=22", deprecated: false },
      { version: "11.5.3", node: ">=22.13", deprecated: false },
      { version: "11.5.2", node: ">=22.13", deprecated: true },
      { version: "10.4.1", node: ">=18.12", deprecated: false },
      { version: "9.15.9", node: ">=18.12", deprecated: false },
      { version: "8.15.9", node: ">=16.14", deprecated: false },
    ],
  },
  advisories: [],
};

async function resolveIn(files: Record<string, Content>, extra: Omit<NodeResolveInput, "snapshot"> = {}): Promise<Resolution> {
  const result = resolveNodeEnvironment({ snapshot: await snap(repoWith(files)), releases: INDEX, ...extra });
  // Every answer is one the domain's schema takes, whatever its kind.
  const parsed = EnvironmentResolution.safeParse(result);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
  return result;
}
const ready = (result: Resolution) => {
  assert.equal(result.status, "ready", result.status === "refused" ? result.message : result.status === "needs-choice" ? result.choices[0]!.message : "");
  return result as Extract<Resolution, { status: "ready" }>;
};
const choice = (result: Resolution) => {
  assert.equal(result.status, "needs-choice", result.status === "refused" ? result.message : "");
  return (result as Extract<Resolution, { status: "needs-choice" }>).choices;
};
const refused = (result: Resolution, code: string, pattern: RegExp) => {
  assert.equal(result.status, "refused");
  const refusal = result as Extract<Resolution, { status: "refused" }>;
  assert.equal(refusal.code, code, refusal.message);
  assert.match(refusal.message, pattern);
};
const tool = (result: Extract<Resolution, { status: "ready" }>, name: string) => result.recipe.tools.find((item) => item.name === name)?.version;
const row = (result: Extract<Resolution, { status: "ready" }>, fact: string) => result.rows.find((item) => item.fact === fact)!;

const pnpmProject = (manifest: Record<string, unknown> = {}, extra: Record<string, Content> = {}) => ({ "package.json": json({ name: "app", private: true, packageManager: "pnpm@11.5.3", ...manifest }), "pnpm-lock.yaml": PNPM_LOCK, "src/index.js": "export {};\n", ...extra });
const npmProject = (manifest: Record<string, unknown> = {}, extra: Record<string, Content> = {}) => ({ "package.json": json({ name: "app", version: "1.0.0", ...manifest }), "package-lock.json": npmLock(), "src/index.js": "export {};\n", ...extra });

describe("Node's runtime, from the project's own declarations (NIV-58)", () => {
  it("honours an exact pin exactly, from a version file", async () => {
    const result = ready(await resolveIn(pnpmProject({}, { ".nvmrc": "v24.20.0\n" })));
    assert.deepEqual([tool(result, "node"), row(result, "runtime").source], [{ kind: "exact", version: "24.20.0" }, "declared"]);
    assert.equal(result.recipe.image.tag, "node:24.20.0-alpine");
  });

  it("resolves a release line or a range to the newest LTS release that meets it, and records the exact version", async () => {
    const line = ready(await resolveIn(pnpmProject({ engines: { node: ">=22" } }, { ".node-version": "22\n" })));
    assert.deepEqual([tool(line, "node"), row(line, "runtime").source], [{ kind: "exact", version: "22.23.4" }, "resolved"]);
    const range = ready(await resolveIn(pnpmProject({ engines: { node: ">=22" } })));
    assert.deepEqual(tool(range, "node"), { kind: "exact", version: "24.21.0" }, "26.2.0 isn't LTS");
    const spaced = ready(await resolveIn(pnpmProject({ engines: { node: ">= 22.12 < 23" } })));
    assert.deepEqual(tool(spaced, "node"), { kind: "exact", version: "22.23.4" });
  });

  it("takes the recommended default, labelled and changeable, when nothing says which Node", async () => {
    const result = ready(await resolveIn(pnpmProject()));
    assert.deepEqual([tool(result, "node"), row(result, "runtime").source], [{ kind: "exact", version: "24.21.0" }, "default"]);
    assert.match(row(result, "runtime").note!, /recommended default/);
    const changed = ready(await resolveIn(pnpmProject(), { choices: { runtime: "22.23.4" } }));
    assert.deepEqual([tool(changed, "node"), row(changed, "runtime").source], [{ kind: "exact", version: "22.23.4" }, "choice"]);
  });

  it("reads aliases within the index: an LTS line by name, the newest LTS, and the newest release", async () => {
    for (const [alias, expected] of [["lts/jod", "22.23.4"], ["lts/*", "24.21.0"], ["node", "26.2.0"]] as const) {
      assert.deepEqual(tool(ready(await resolveIn(pnpmProject({}, { ".nvmrc": `${alias}\n` }))), "node"), { kind: "exact", version: expected }, alias);
    }
    const unknown = choice(await resolveIn(pnpmProject({}, { ".nvmrc": "lts/hydrogen\n" })));
    assert.deepEqual([unknown[0]!.id, unknown[0]!.why], ["runtime", "unreadable"]);
  });

  it("puts pins that disagree to the person, never picking one, and takes their answer", async () => {
    const files = pnpmProject({}, { ".nvmrc": "24.21.0\n", ".node-version": "22.23.4\n" });
    const [needed] = choice(await resolveIn(files));
    assert.deepEqual([needed!.id, needed!.why, needed!.options.map((option) => option.value)], ["runtime", "conflict", ["24.21.0", "22.23.4"]]);
    assert.deepEqual(needed!.declarations.map((item) => item.file), [".nvmrc", ".node-version"]);
    const answered = ready(await resolveIn(files, { choices: { runtime: "22.23.4" } }));
    assert.deepEqual([tool(answered, "node"), row(answered, "runtime").source], [{ kind: "exact", version: "22.23.4" }, "choice"]);
    // An answer that isn't one of the options doesn't settle it.
    assert.equal((await resolveIn(files, { choices: { runtime: "26.2.0" } })).status, "needs-choice");
  });

  it("puts a pin outside a range the project also declares to the person, with both options", async () => {
    const [needed] = choice(await resolveIn(pnpmProject({ engines: { node: ">=22" } }, { ".nvmrc": "20.19.0\n" })));
    assert.deepEqual([needed!.why, needed!.options.map((option) => option.value)], ["conflict", ["20.19.0", "24.21.0"]]);
  });

  it("shows a range it can't read as written and asks for an exact version, never counting it as met", async () => {
    const [needed] = choice(await resolveIn(pnpmProject({ engines: { node: ">=22.0.0-beta" } })));
    assert.equal(needed!.why, "unreadable");
    assert.match(needed!.message, />=22\.0\.0-beta/);
  });

  it("reads every workspace package's range, and asks when no release meets them all", async () => {
    const workspace = {
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/app/package.json": json({ name: "@w/app", engines: { node: ">=22 <24" } }),
      "packages/lib/package.json": json({ name: "@w/lib", engines: { node: ">=20" } }),
    };
    assert.deepEqual(tool(ready(await resolveIn(pnpmProject({}, workspace))), "node"), { kind: "exact", version: "22.23.4" });
    const [needed] = choice(await resolveIn(pnpmProject({}, { ...workspace, "packages/old/package.json": json({ name: "@w/old", engines: { node: "<20" } }) })));
    assert.equal(needed!.why, "conflict");
    // A package.json outside the workspace (a test fixture, say) isn't installed, so its range doesn't count.
    assert.equal((await resolveIn(pnpmProject({}, { ...workspace, "test/fixtures/old/package.json": json({ name: "old", engines: { node: "<20" } }) }))).status, "ready");
  });

  it("prefers a release every dependency's engines admit, and warns about the ones that don't", async () => {
    const lock = npmLock({ "node_modules/vite": { version: "7.0.0", engines: { node: "^22.12.0" } } });
    const result = ready(await resolveIn(npmProject({ engines: { node: ">=20" } }, { "package-lock.json": lock })));
    assert.deepEqual(tool(result, "node"), { kind: "exact", version: "22.23.4" }, "not 24.21.0, which vite doesn't admit");
    const pinned = ready(await resolveIn(npmProject({}, { "package-lock.json": lock, ".nvmrc": "24.21.0\n" })));
    assert.deepEqual(pinned.warnings.map((warning) => warning.code), ["dependency-engines"]);
  });

  it("writes a pin newer than the index as the rule preparation answers, never a guessed value", async () => {
    const result = ready(await resolveIn(npmProject({}, { ".nvmrc": "24.30.0\n" })));
    assert.deepEqual(tool(result, "node"), { kind: "exact", version: "24.30.0" });
    assert.deepEqual(tool(result, "npm"), { kind: "bundled", with: "node" });
    assert.match(row(result, "runtime").note!, /checked when preparing/);
    const pnpm = ready(await resolveIn(pnpmProject({}, { ".nvmrc": "24.30.0\n" })));
    assert.equal(pnpm.recipe.bootstrap[0]!.via, "corepack-else-npm-global");
  });

  it("offers real releases for a pin that doesn't exist, and refuses one older than the index", async () => {
    const [needed] = choice(await resolveIn(pnpmProject({}, { ".nvmrc": "22.20.0\n" })));
    assert.deepEqual([needed!.why, needed!.options.map((option) => option.value)], ["unavailable", ["22.23.4", "22.12.0"]]);
    refused(await resolveIn(pnpmProject({}, { ".nvmrc": "12.22.12\n" })), "unsupported-runtime", /older than any release/);
  });

  it("keeps the last preparation's version while the setup configuration is unchanged, so a newer index changes nothing", async () => {
    const files = pnpmProject({ engines: { node: ">=22" } });
    const older: ReleaseIndex = { ...INDEX, node: INDEX.node.filter((release) => release.version !== "24.21.0") };
    const first = ready(resolveNodeEnvironment({ snapshot: await snap(repoWith(files)), releases: older }));
    assert.deepEqual(tool(first, "node"), { kind: "exact", version: "24.20.0" });
    const previous = { configuration: first.recipe.configuration.digest, runtime: "24.20.0", manager: "pnpm", managerVersion: "11.5.3" };
    const again = ready(resolveNodeEnvironment({ snapshot: await snap(repoWith(files)), releases: INDEX, previous }));
    assert.deepEqual(tool(again, "node"), { kind: "exact", version: "24.20.0" });
    assert.equal(await recipeDigest(again.recipe), await recipeDigest(first.recipe), "refreshing the index invalidates nothing");
    const changed = ready(resolveNodeEnvironment({ snapshot: await snap(repoWith({ ...files, ".nvmrc": "24\n" })), releases: INDEX, previous }));
    assert.deepEqual(tool(changed, "node"), { kind: "exact", version: "24.21.0" }, "a changed setup resolves again");
  });
});

describe("the package manager and its version (NIV-58)", () => {
  it("takes packageManager's exact pin, activated through corepack where the image has it, as preparation finds", async () => {
    const result = ready(await resolveIn(pnpmProject({}, { ".nvmrc": "24.21.0\n" })));
    assert.deepEqual([result.recipe.install.tool, tool(result, "pnpm"), result.recipe.bootstrap], ["pnpm", { kind: "exact", version: "11.5.3" }, [{ tool: "pnpm", version: "11.5.3", via: "corepack-else-npm-global" }]]);
    assert.deepEqual(result.recipe.install.args, ["install", "--frozen-lockfile"]);
  });

  it("infers the manager from the one lockfile there is, and defaults its version from what runs on that Node", async () => {
    const pnpm = ready(await resolveIn({ "package.json": json({ name: "app" }), "pnpm-lock.yaml": PNPM_LOCK }));
    assert.deepEqual([pnpm.recipe.install.tool, tool(pnpm, "pnpm"), row(pnpm, "manager").source, row(pnpm, "manager-version").source], ["pnpm", { kind: "exact", version: "11.5.3" }, "resolved", "default"]);
    const npm = ready(await resolveIn(npmProject()));
    assert.deepEqual([npm.recipe.install.tool, tool(npm, "npm"), npm.recipe.bootstrap], ["npm", { kind: "bundled", with: "node" }, []], "the image's own npm, which preparation records");
    assert.match(row(npm, "manager-version").note!, /npm 11\.19\.0/, "what the index says is shown, not written into the recipe");
    assert.deepEqual(npm.recipe.install.args, ["ci", "--no-audit", "--no-fund"]);
  });

  it("asks which manager when both lockfiles are committed and nothing says, and takes the answer", async () => {
    const files = { ...npmProject(), "pnpm-lock.yaml": PNPM_LOCK };
    const [needed] = choice(await resolveIn(files));
    assert.deepEqual([needed!.id, needed!.why, needed!.options.map((option) => option.value)], ["manager", "ambiguous", ["npm", "pnpm"]]);
    assert.equal(ready(await resolveIn(files, { choices: { manager: "npm" } })).recipe.install.tool, "npm");
  });

  it("asks when packageManager names a manager whose lockfile is missing while another's is committed", async () => {
    const files = { "package.json": json({ name: "app", packageManager: "pnpm@11.5.3" }), "package-lock.json": npmLock() };
    const [needed] = choice(await resolveIn(files));
    assert.deepEqual([needed!.why, needed!.options.map((option) => option.value)], ["conflict", ["npm", "pnpm"]], "alphabetical, so neither is offered first");
    assert.equal(ready(await resolveIn(files, { choices: { manager: "npm" } })).recipe.install.tool, "npm");
    assert.equal((await resolveIn(files, { choices: { manager: "pnpm" } })).status, "needs-choice", "pnpm still has no lockfile");
  });

  it("asks when declarations about the manager disagree", async () => {
    const [devEngines] = choice(await resolveIn(pnpmProject({ devEngines: { packageManager: { name: "npm" } } }, { "package-lock.json": npmLock() })));
    assert.deepEqual([devEngines!.id, devEngines!.why], ["manager", "conflict"]);
    const [range] = choice(await resolveIn(pnpmProject({ engines: { pnpm: ">=12" } })));
    assert.deepEqual([range!.id, range!.why], ["manager-version", "conflict"]);
    const [volta] = choice(await resolveIn(pnpmProject({ volta: { pnpm: "10.4.1" } })));
    assert.deepEqual([volta!.why, volta!.options.map((option) => option.value)], ["conflict", ["11.5.3", "10.4.1"]]);
  });

  it("asks when the manager can't run on the project's Node or read its lockfile, offering versions that can", async () => {
    const [node] = choice(await resolveIn(pnpmProject({}, { ".nvmrc": "20.19.0\n" })));
    assert.deepEqual([node!.id, node!.why], ["manager-version", "conflict"]);
    assert.deepEqual(node!.options.map((option) => option.value), ["10.4.1", "9.15.9"]);
    const [lock] = choice(await resolveIn(pnpmProject({ packageManager: "pnpm@8.15.9" })));
    assert.match(lock!.message, /format 9\.0/);
  });

  it("says when it can't know yet whether a manager reads the lockfile, rather than guessing", async () => {
    const result = ready(await resolveIn(pnpmProject({ packageManager: "pnpm@12.1.0" })));
    assert.match(row(result, "manager-version").note!, /checked when preparing/);
  });

  it("installs an exact npm pin, whatever the image bundles", async () => {
    const result = ready(await resolveIn(npmProject({ packageManager: "npm@10.9.9" }, { ".nvmrc": "24.21.0\n" })));
    assert.deepEqual([tool(result, "npm"), result.recipe.bootstrap], [{ kind: "exact", version: "10.9.9" }, [{ tool: "npm", version: "10.9.9", via: "npm-global" }]]);
  });

  it("refuses what it can't prepare, naming it, and converts nothing", async () => {
    refused(await resolveIn({ "package.json": json({ name: "app", packageManager: "yarn@4.1.0" }), "yarn.lock": "# yarn\n" }), "unsupported-manager", /yarn/);
    refused(await resolveIn({ "package.json": json({ name: "app" }), "yarn.lock": "# yarn\n" }), "unsupported-manager", /yarn/);
    refused(await resolveIn({ "package.json": json({ name: "app" }) }), "no-lockfile", /committed lockfile/);
    refused(await resolveIn({ "package.json": json({ name: "app", packageManager: "pnpm@^9" }), "pnpm-lock.yaml": PNPM_LOCK }), "layout", /exact version/);
    refused(await resolveIn({ "package.json": json({ name: "app" }), "package-lock.json": json({ lockfileVersion: 1, dependencies: {} }) }), "layout", /format 1/);
    refused(await resolveIn(pnpmProject({ packageManager: "pnpm@6.35.1" })), "unsupported-manager", /older/);
    refused(await resolveIn({ "src/index.js": "export {};\n" }), "no-project", /no package\.json/);
  });
});

describe("layouts that need the sources, or tools the image hasn't got (NIV-58)", () => {
  it("refuses the project's own install hooks in any installed manifest, naming the file", async () => {
    refused(await resolveIn(npmProject({ scripts: { prepare: "husky" } })), "needs-sources", /package\.json runs prepare/);
    const workspace = { "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "packages/db/package.json": json({ name: "db", scripts: { postinstall: "prisma generate" } }) };
    refused(await resolveIn(pnpmProject({}, workspace)), "needs-sources", /packages\/db\/package\.json runs postinstall/);
    // A manifest no install reads (a fixture) doesn't count.
    assert.equal((await resolveIn(npmProject({}, { "test/fixture/package.json": json({ scripts: { prepare: "x" } }) }))).status, "ready");
  });

  it("refuses patches, pnpmfiles, config dependencies and local file dependencies", async () => {
    refused(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": "packages: []\npatchedDependencies:\n  lodash@4.17.21: patches/lodash.patch\n" })), "needs-sources", /patches/);
    refused(await resolveIn(pnpmProject({}, { ".pnpmfile.cjs": "module.exports = {};\n" })), "needs-sources", /\.pnpmfile\.cjs/);
    refused(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": "configDependencies:\n  my-config: 1.0.0+sha512-abc\n" })), "layout", /config dependencies/);
    refused(await resolveIn(npmProject({ dependencies: { vendored: "file:vendor/vendored" } })), "needs-sources", /local file or folder/);
  });

  it("refuses git dependencies, private registries and tracked node_modules", async () => {
    refused(await resolveIn(npmProject({}, { "package-lock.json": npmLock({ "node_modules/x": { version: "1.0.0", resolved: "git+ssh://git@github.com/o/x.git#abc" } }) })), "needs-git", /git repository/);
    refused(await resolveIn(npmProject({}, { "package-lock.json": npmLock({ "node_modules/x": { version: "1.0.0", resolved: "https://npm.example.com/x/-/x-1.0.0.tgz" } }) })), "private-registry", /npm\.example\.com/);
    refused(await resolveIn(npmProject({}, { "node_modules/left-pad/index.js": "module.exports = 1;\n" })), "tracked-dependencies", /node_modules/);
    // The public registry, and its public mirror, are fine.
    const lock = npmLock({ "node_modules/x": { version: "1.0.0", resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" } });
    assert.deepEqual(ready(await resolveIn(npmProject({}, { "package-lock.json": lock }))).recipe.network.hosts, ["registry.npmjs.org"]);
  });

  it("refuses a setup file that is a link, or a manifest that isn't JSON", async () => {
    refused(await resolveIn(npmProject({}, { "versions/node": "24.21.0\n", ".nvmrc": { link: "versions/node" } })), "layout", /\.nvmrc is a link/);
    refused(await resolveIn({ "package.json": "{ not json", "package-lock.json": npmLock() }), "layout", /isn't a JSON object/);
  });
});

describe("install options, build policies and what task operations get (NIV-55)", () => {
  it("passes npm's options as its own flags, in a fixed order, and refuses ones it doesn't know", async () => {
    const result = ready(await resolveIn(npmProject(), { choices: { options: { omit: ["dev"], "legacy-peer-deps": true, "install-links": false } } }));
    assert.deepEqual(result.recipe.install.args, ["ci", "--no-audit", "--no-fund", "--install-links=false", "--legacy-peer-deps", "--omit=dev"], "off is said too: it can matter");
    assert.deepEqual(result.recipe.install.options, { "install-links": false, "legacy-peer-deps": true, omit: ["dev"] });
    refused(await resolveIn(npmProject(), { choices: { options: { registry: "x" } } }), "options", /registry/);
    refused(await resolveIn(npmProject(), { choices: { options: { "install-strategy": "flat" } } }), "options", /install-strategy/);
  });

  it("gives pnpm 10 its options through the variables it reads, and tells pnpm 11 to set them in pnpm-workspace.yaml", async () => {
    const ten = ready(await resolveIn(pnpmProject({ packageManager: "pnpm@10.4.1" }), { choices: { options: { "node-linker": "hoisted", "auto-install-peers": false } } }));
    assert.deepEqual([ten.recipe.env.preparation["npm_config_node_linker"], ten.recipe.env.preparation["npm_config_auto_install_peers"]], ["hoisted", "false"], "false reaches pnpm, whose default is true");
    refused(await resolveIn(pnpmProject(), { choices: { options: { "node-linker": "hoisted" } } }), "options", /reads nodeLinker from pnpm-workspace\.yaml/);
    refused(await resolveIn(pnpmProject({ packageManager: "pnpm@12.1.0" }), { choices: { options: { "node-linker": "hoisted" } } }), "options", /doesn't know how pnpm 12\.1\.0 takes install options/);
  });

  it("records each pnpm version's own build rules, and never widens them", async () => {
    const eleven = ready(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": "allowBuilds:\n  esbuild: true\n  sharp: false\nonlyBuiltDependencies:\n  - core-js\n" })));
    assert.deepEqual(eleven.recipe.builds, { tool: "pnpm", runs: "allowed", allowed: ["esbuild"], denied: ["sharp"], strict: true, source: "pnpm-workspace.yaml", notes: ["pnpm 11.5.3 no longer reads onlyBuiltDependencies; it uses allowBuilds."] });
    assert.deepEqual(eleven.warnings.map((warning) => warning.code), ["ignored-setting"]);
    const ten = ready(await resolveIn(pnpmProject({ packageManager: "pnpm@10.4.1", pnpm: { onlyBuiltDependencies: ["esbuild"] } })));
    assert.deepEqual([ten.recipe.builds.runs, ten.recipe.builds.allowed, ten.recipe.builds.strict, ten.recipe.builds.source], ["allowed", ["esbuild"], false, "package.json"]);
    assert.equal(ready(await resolveIn(pnpmProject({ packageManager: "pnpm@10.4.1" }))).recipe.builds.runs, "none", "pnpm 10 runs no build it wasn't allowed");
    assert.equal(ready(await resolveIn(pnpmProject({ packageManager: "pnpm@9.15.9" }))).recipe.builds.runs, "all", "pnpm 9 runs every build");
    const npm = ready(await resolveIn(npmProject(), { choices: { options: { "ignore-scripts": true } } }));
    assert.deepEqual([npm.recipe.builds.runs, npm.recipe.install.args.includes("--ignore-scripts")], ["none", true]);
  });

  it("gives every task operation variables that stop installs, downloads and version switches", async () => {
    const env = async (files: Record<string, Content>) => ready(await resolveIn(files)).recipe.env.task;
    const eleven = await env(pnpmProject());
    assert.deepEqual([eleven["pnpm_config_verify_deps_before_run"], eleven["pnpm_config_pm_on_fail"], eleven["COREPACK_ENABLE_NETWORK"], "npm_config_verify_deps_before_run" in eleven], ["false", "ignore", "0", false]);
    const ten = await env(pnpmProject({ packageManager: "pnpm@10.4.1" }));
    assert.deepEqual([ten["npm_config_verify_deps_before_run"], ten["npm_config_manage_package_manager_versions"], "pnpm_config_verify_deps_before_run" in ten], ["false", "false", false]);
    const twelve = await env(pnpmProject({ packageManager: "pnpm@12.1.0" }));
    assert.deepEqual([twelve["npm_config_verify_deps_before_run"], twelve["pnpm_config_verify_deps_before_run"]], ["false", "false"], "a major Nivra doesn't know gets both");
    const npm = await env(npmProject());
    assert.deepEqual([npm["COREPACK_ENABLE_NETWORK"], "pnpm_config_verify_deps_before_run" in npm], ["0", false]);
  });

  it("installs the pnpm packages a filter selects, and checks only their Node requirements", async () => {
    const files = pnpmProject({}, {
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/data/package.json": json({ name: "@w/data", engines: { node: ">=22" }, dependencies: { "@w/core": "workspace:*" } }),
      "packages/core/package.json": json({ name: "@w/core", engines: { node: ">=20" } }),
      "packages/legacy/package.json": json({ name: "@w/legacy", engines: { node: "<20" } }),
    });
    assert.equal((await resolveIn(files)).status, "needs-choice", "the whole workspace can't agree");
    const scoped = ready(await resolveIn(files, { choices: { scope: { kind: "selected", selectors: ["@w/data..."] } } }));
    assert.deepEqual(scoped.recipe.install.args, ["install", "--frozen-lockfile", "--filter", "@w/data..."]);
    refused(await resolveIn(npmProject(), { choices: { scope: { kind: "selected", selectors: ["app"] } } }), "scope", /npm workspaces/);
  });
});

describe("the recipe as a contract (NIV-55)", () => {
  const choices: EnvironmentChoices = {};
  it("is the same recipe, by digest, for the same setup, whatever else the commit holds", async () => {
    const base = pnpmProject({ engines: { node: ">=22" } });
    const one = ready(await resolveIn(base, { choices }));
    const sources = ready(await resolveIn({ ...base, "src/index.js": "export const changed = 1;\n", "README.md": "# app\n" }, { choices }));
    assert.equal(await recipeDigest(sources.recipe), await recipeDigest(one.recipe));
    const nvmrc = ready(await resolveIn({ ...base, ".nvmrc": "24\n" }, { choices }));
    assert.notEqual(nvmrc.recipe.configuration.digest, one.recipe.configuration.digest, "an .nvmrc-only change is a setup change");
    assert.deepEqual(one.recipe.configuration.files.map((file) => file.path), ["package.json", "pnpm-lock.yaml"]);
  });

  it("declares its platform, image, network and dependency folders, and never names a secret", async () => {
    const result = ready(await resolveIn(pnpmProject({}, { ".npmrc": "//registry.npmjs.org/:_authToken=x\n" })));
    assert.deepEqual([result.recipe.platform, result.recipe.network.preparation, result.recipe.network.tasks, result.recipe.artifacts.dependency], [{ os: "linux", arch: "x86_64", libc: "musl" }, "on", "off", ["node_modules"]]);
    assert.ok(result.limitations.some((line) => /\.npmrc isn't read or sent/.test(line)));
    assert.ok(!JSON.stringify(result).includes("_authToken"));
  });
});

describe("the independent review's findings, each kept fixed (NIV-55)", () => {
  it("doesn't change a recipe when a refreshed index learns a version the project pinned before it was listed", async () => {
    const files = pnpmProject({}, { ".nvmrc": "24.30.0\n" });
    const before = ready(await resolveIn(files));
    const learnt: ReleaseIndex = { ...INDEX, node: [{ version: "24.30.0", npm: "11.21.0", lts: "Krypton" }, ...INDEX.node] };
    const after = ready(await resolveIn(files, { releases: learnt }));
    assert.equal(await recipeDigest(after.recipe), await recipeDigest(before.recipe));
    const npm = npmProject({ packageManager: "npm@11.19.0" }, { ".nvmrc": "24.30.0\n" });
    assert.equal(await recipeDigest(ready(await resolveIn(npm, { releases: learnt })).recipe), await recipeDigest(ready(await resolveIn(npm)).recipe), "an npm pin is installed whatever the image bundles");
  });

  it("reads a workspace file with a byte-order mark, a comment after a key, and list items at the key's own column", async () => {
    const hook = { "packages/db/package.json": json({ name: "db", scripts: { postinstall: "prisma generate" } }) };
    for (const yaml of ["﻿packages:\n  - packages/*\n", "packages: # every package\n  - packages/*\n", "packages:\n- packages/*\n"]) {
      refused(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": yaml, ...hook })), "needs-sources", /packages\/db\/package\.json runs postinstall/);
    }
    refused(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": "packages:\n  - &all packages/*\n  - name: x\n" })), "layout", /couldn't read the packages list/);
  });

  it("records each pnpm major's build rules as pnpm applies them, and says when it can't know", async () => {
    const policy = async (manifest: Record<string, unknown>, extra: Record<string, Content> = {}) => ready(await resolveIn(pnpmProject(manifest, extra))).recipe.builds;
    assert.equal((await policy({ packageManager: "pnpm@9.15.9", pnpm: { onlyBuiltDependencies: [] } })).runs, "none", "an empty list allows none");
    assert.equal((await policy({ packageManager: "pnpm@9.15.9" }, { "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n" })).runs, "unknown", "pnpm 9 reads package.json, not the workspace file");
    const deny = await policy({ packageManager: "pnpm@10.4.1", pnpm: { neverBuiltDependencies: ["fsevents"] } });
    assert.deepEqual([deny.runs, deny.denied], ["all", ["fsevents"]], "naming only builds to deny lets the rest run");
    assert.equal((await policy({ packageManager: "pnpm@10.4.1", pnpm: { onlyBuiltDependenciesFile: "allowed.json" } })).runs, "unknown");
    assert.equal((await policy({ packageManager: "pnpm@12.1.0" })).runs, "unknown", "a major Nivra doesn't know isn't guessed");
    assert.equal((await policy({}, { "pnpm-workspace.yaml": "allowBuilds:\n  esbuild:\n    - nested\n" })).runs, "unknown", "an unreadable policy isn't read as none");
    const ranged = await policy({}, { "pnpm-workspace.yaml": "allowBuilds:\n  'nx@21.6.4 || 21.6.5': true\n" });
    assert.deepEqual([ranged.runs, ranged.allowed], ["allowed", ["nx@21.6.4 || 21.6.5"]]);
  });

  it("reads every lockfile entry, so a git dependency or a private host past the first thousands is still refused", async () => {
    const many = (extra: Record<string, unknown>) => npmLock({ ...Object.fromEntries(Array.from({ length: 6_000 }, (_, i) => [`node_modules/p${i}`, { version: "1.0.0", resolved: `https://registry.npmjs.org/p${i}/-/p${i}-1.0.0.tgz` }])), ...extra });
    refused(await resolveIn(npmProject({}, { "package-lock.json": many({ "node_modules/late": { version: "1.0.0", resolved: "git+https://github.com/o/late.git#abc" } }) })), "needs-git", /late/);
    refused(await resolveIn(npmProject({}, { "package-lock.json": many({ "node_modules/late": { version: "1.0.0", resolved: "https://npm.example.com/late.tgz" } }) })), "private-registry", /npm\.example\.com/);
  });

  it("refuses local dependencies however they are written, and links that leave the repository", async () => {
    refused(await resolveIn(npmProject({ dependencies: { shared: "../shared" } })), "needs-sources", /\.\.\/shared/);
    refused(await resolveIn(npmProject({}, { "package-lock.json": npmLock({ "node_modules/shared": { resolved: "../shared", link: true }, "../shared": { version: "1.0.0" } }) })), "needs-sources", /local file or folder/);
    const importer = `${PNPM_LOCK}\nimporters:\n\n  .:\n    dependencies:\n      shared:\n        specifier: link:../shared\n        version: link:../shared\n`;
    refused(await resolveIn({ "package.json": json({ name: "app", packageManager: "pnpm@11.5.3" }), "pnpm-lock.yaml": importer }), "needs-sources", /link:\.\.\/shared/);
  });

  it("stays within the contract's bounds for a workspace of many packages", async () => {
    const packages = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`packages/p${i}/package.json`, json({ name: `@w/p${i}`, engines: { node: ">=20" } })]));
    const result = ready(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": "packages:\n  - packages/*\n", ...packages })));
    assert.equal(row(result, "runtime").declarations.length, 40);
    assert.match(row(result, "runtime").note!, /5 more declarations aren't shown/, "45 declarations, 40 shown");
  });

  it("keeps the last preparation's version only when it wasn't the person's choice, isn't withdrawn and still fits", async () => {
    const files = pnpmProject({ engines: { node: ">=22" } });
    const configuration = ready(await resolveIn(files)).recipe.configuration.digest;
    const previous = { configuration, runtime: "22.23.4", manager: "pnpm", managerVersion: "11.5.3" };
    assert.deepEqual(tool(ready(await resolveIn(files, { previous })), "node"), { kind: "exact", version: "22.23.4" });
    assert.deepEqual(tool(ready(await resolveIn(files, { previous: { ...previous, chosen: { runtime: true } } })), "node"), { kind: "exact", version: "24.21.0" }, "a choice the person stopped making isn't kept");
    const withdrawn: ReleaseIndex = { ...INDEX, advisories: [{ tool: "node", version: "22.23.4", reason: "a security release replaces it", replacement: "22.24.0" }] };
    assert.deepEqual(tool(ready(await resolveIn(files, { previous, releases: withdrawn })), "node"), { kind: "exact", version: "24.21.0" }, "a withdrawn version isn't kept");
  });

  it("puts a withdrawn pin to the person, and refuses a pin it can offer nothing in place of", async () => {
    const withdrawn: ReleaseIndex = { ...INDEX, advisories: [{ tool: "node", version: "24.21.0", reason: "a security release replaces it", replacement: "24.22.0" }] };
    const [needed] = choice(await resolveIn(pnpmProject({}, { ".nvmrc": "24.21.0\n" }), { releases: withdrawn }));
    assert.deepEqual([needed!.why, needed!.options.map((option) => option.value)], ["unavailable", ["24.20.0"]]);
    assert.match(needed!.message, /withdrawn: a security release replaces it/);
    refused(await resolveIn(pnpmProject({}, { ".nvmrc": "25.1.0\n" })), "unavailable", /Pin an exact Node version/);
  });

  it("checks a choice against aliases as well as ranges, and says why it isn't used", async () => {
    const result = ready(await resolveIn(pnpmProject({}, { ".nvmrc": "lts/jod\n" }), { choices: { runtime: "26.2.0" } }));
    assert.deepEqual(tool(result, "node"), { kind: "exact", version: "22.23.4" });
    assert.match(result.warnings.find((warning) => warning.code === "choice-ignored")!.message, /doesn't meet the project's declarations/);
    const [both] = choice(await resolveIn(pnpmProject({}, { ".nvmrc": "lts/iron\n", ".node-version": "lts/jod\n" })));
    assert.deepEqual([both!.why, both!.options.map((option) => option.value)], ["conflict", ["20.19.0", "22.23.4"]], "two LTS lines disagree; neither is unknown");
  });

  it("says when a declaration about the manager can't be read, and offers versions instead of nothing", async () => {
    const [needed] = choice(await resolveIn(pnpmProject({ packageManager: undefined, engines: { pnpm: ">=9.0.0-rc.0" } })));
    assert.equal(needed!.why, "unreadable");
    assert.ok(needed!.options.length > 0);
    const volta = ready(await resolveIn(pnpmProject({ volta: { pnpm: "^10" } })));
    assert.ok(volta.warnings.some((warning) => warning.code === "unread-declaration"), "a volta pin that isn't exact is said, not dropped");
  });

  it("offers the runtime side of a manager conflict, unless the project pins its Node", async () => {
    const files = pnpmProject({ engines: { node: ">=20" } });
    const configuration = ready(await resolveIn(files)).recipe.configuration.digest;
    const needed = choice(await resolveIn(files, { previous: { configuration, runtime: "20.19.0", manager: "pnpm", managerVersion: "11.5.3" } }));
    assert.deepEqual(needed.map((item) => item.id), ["runtime", "manager-version"]);
    const answered = ready(await resolveIn(files, { previous: { configuration, runtime: "20.19.0", manager: "pnpm", managerVersion: "11.5.3" }, choices: { runtime: needed[0]!.options[0]!.value } }));
    assert.deepEqual(tool(answered, "node"), { kind: "exact", version: "24.21.0" });
    const pinned = choice(await resolveIn(pnpmProject({}, { ".nvmrc": "20.19.0\n" })));
    assert.deepEqual(pinned.map((item) => item.id), ["manager-version"], "a pin always wins over a choice, so no Node is offered");
  });

  it("reads pnpm's filter syntax: exclusions alone, and a package's dependencies only", async () => {
    // data's range keeps Node below 24, so a scope that leaves data out would resolve to 24.21.0 instead.
    const files = pnpmProject({}, {
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/data/package.json": json({ name: "@w/data", engines: { node: ">=22 <24" }, dependencies: { "@w/core": "workspace:*" } }),
      "packages/core/package.json": json({ name: "@w/core", engines: { node: ">=20" } }),
      "packages/legacy/package.json": json({ name: "@w/legacy", engines: { node: "<20" } }),
    });
    const node = async (selectors: string[]) => tool(ready(await resolveIn(files, { choices: { scope: { kind: "selected", selectors } } })), "node");
    assert.deepEqual(await node(["!@w/legacy"]), { kind: "exact", version: "22.23.4" }, "every package but legacy");
    assert.deepEqual(await node(["@w/data^..."]), { kind: "exact", version: "22.23.4" }, "data's dependencies, counted with data");
    assert.deepEqual(await node(["...@w/core"]), { kind: "exact", version: "22.23.4" }, "core's dependents are data, not legacy");
    assert.deepEqual(await node(["@w/core"]), { kind: "exact", version: "24.21.0" }, "core alone");
    refused(await resolveIn(npmProject(), { choices: { scope: { kind: "selected", selectors: ["app"] } } }), "scope", /Choose the whole project/);
  });

  it("keeps corepack and pnpm from switching versions during preparation as well as tasks", async () => {
    const eleven = ready(await resolveIn(pnpmProject())).recipe.env;
    assert.deepEqual([eleven.preparation["COREPACK_ENABLE_STRICT"], eleven.preparation["pnpm_config_pm_on_fail"], eleven.task["pnpm_config_pm_on_fail"]], ["0", "ignore", "ignore"]);
    const ten = ready(await resolveIn(pnpmProject({ packageManager: "pnpm@10.4.1" }))).recipe.env.preparation;
    assert.equal(ten["npm_config_manage_package_manager_versions"], "false");
  });
});

describe("Nate's review of PR 31, each finding kept fixed (NIV-55)", () => {
  it("1. reads brace lists in workspace patterns, so their packages' requirements and hooks count, and refuses syntax it can't read", async () => {
    const members = {
      "packages/a/package.json": json({ name: "a", engines: { node: "<24" } }),
      "packages/b/package.json": json({ name: "b", scripts: { postinstall: "node build.js" } }),
    };
    refused(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": "packages:\n  - 'packages/{a,b}'\n", ...members })), "needs-sources", /packages\/b\/package\.json runs postinstall/);
    refused(await resolveIn(npmProject({ workspaces: ["packages/{a,b}"] }, members)), "needs-sources", /packages\/b\/package\.json runs postinstall/);
    const a = ready(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": "packages:\n  - packages/{a,c}\n", "packages/a/package.json": members["packages/a/package.json"] })));
    assert.deepEqual([tool(a, "node"), row(a, "workspace").value], [{ kind: "exact", version: "22.23.4" }, "pnpm workspace, 1 package"], "a's range counts");
    for (const pattern of ["packages/[ab]", "packages/@(a|b)", "packages/{1..3}"]) {
      refused(await resolveIn(pnpmProject({}, { "pnpm-workspace.yaml": `packages:\n  - '${pattern}'\n`, ...members })), "layout", /can't read the workspace pattern .* Nivra reads \*, \*\*, \? and lists such as \{a,b\}/);
    }
  });

  it("2. checks a chosen pnpm version against the project's Node and lockfile, as it checks a pin", async () => {
    const files = pnpmProject({ engines: { pnpm: "^10" } }, { ".nvmrc": "20.19.0\n" });
    const [conflict] = choice(await resolveIn(files));
    assert.deepEqual(conflict!.options.map((option) => option.value), ["11.5.3", "10.4.1"]);
    assert.match(conflict!.options[0]!.note!, /^The pin\. It needs Node >=22\.13, and this project's Node is 20\.19\.0\.$/);
    const again = choice(await resolveIn(files, { choices: { managerVersion: "11.5.3" } }));
    assert.deepEqual(again.map((item) => [item.id, item.options.map((option) => option.value)]), [["manager-version", ["10.4.1"]]], "not ready; a pinned Node offers no runtime side");
    assert.match(again[0]!.message, /^You chose pnpm 11\.5\.3, which needs Node >=22\.13, and this project's Node is 20\.19\.0\./);
    assert.deepEqual(tool(ready(await resolveIn(files, { choices: { managerVersion: "10.4.1" } })), "pnpm"), { kind: "exact", version: "10.4.1" });
    // With a Node the person may change, the other side is offered, and choosing both is ready.
    const ranged = pnpmProject({ engines: { pnpm: "^10", node: ">=20" } });
    const configuration = ready(await resolveIn(ranged, { choices: { managerVersion: "10.4.1" } })).recipe.configuration.digest;
    const previous = { configuration, runtime: "20.19.0", manager: "pnpm", managerVersion: "10.4.1" };
    const sides = choice(await resolveIn(ranged, { previous, choices: { managerVersion: "11.5.3" } }));
    assert.deepEqual(sides.map((item) => item.id), ["runtime", "manager-version"]);
    const both = ready(await resolveIn(ranged, { previous, choices: { managerVersion: "11.5.3", runtime: sides[0]!.options[0]!.value } }));
    assert.deepEqual([tool(both, "node"), tool(both, "pnpm")], [{ kind: "exact", version: "24.21.0" }, { kind: "exact", version: "11.5.3" }]);
    // A chosen version that can't read the lockfile is put to the person again too.
    const six = pnpmProject({ engines: { pnpm: "^8" } }, { "pnpm-lock.yaml": "lockfileVersion: '6.0'\n" });
    assert.match(choice(await resolveIn(six))[0]!.options[0]!.note!, /^The pin\. It can't read the lockfile's format 6\.0\.$/);
    const relock = choice(await resolveIn(six, { choices: { managerVersion: "11.5.3" } }));
    assert.deepEqual(relock.map((item) => item.options.map((option) => option.value)), [["8.15.9"]]);
    assert.match(relock[0]!.message, /^You chose pnpm 11\.5\.3, which can't install pnpm-lock\.yaml \(format 6\.0\) without changing it\./);
    // Where nothing in the index fits, a choice that doesn't run is refused, saying what to do instead.
    const none = pnpmProject({ packageManager: undefined, engines: { pnpm: ">=11" } }, { ".nvmrc": "20.19.0\n" });
    assert.deepEqual(choice(await resolveIn(none))[0]!.options.map((option) => option.value), ["12.1.0", "11.5.3"]);
    refused(await resolveIn(none, { choices: { managerVersion: "11.5.3" } }), "unavailable", /^You chose pnpm 11\.5\.3, which needs Node >=22\.13, and this project's Node is 20\.19\.0\. Pin an exact pnpm version/);
  });

  it("2. offers only Node releases an environment can use when declarations disagree", async () => {
    const files = pnpmProject({}, { ".nvmrc": "18.20.0\n", ".node-version": "22.23.4\n" });
    const [conflict] = choice(await resolveIn(files));
    assert.deepEqual(conflict!.options.map((option) => option.value), ["22.23.4"], "18.20.0 is older than any release Nivra's environments use");
    assert.equal((await resolveIn(files, { choices: { runtime: "18.20.0" } })).status, "needs-choice", "so choosing it settles nothing");
  });

  it("3. reads block-style lockfile entries, so a private registry or a dependency's engines can't hide in one", async () => {
    const lock = (body: string) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n${body}`;
    const hidden = "  a@1.0.0:\n    resolution:\n      integrity: sha512-x\n      tarball: https://npm.example.com/a/-/a-1.0.0.tgz\n";
    refused(await resolveIn(pnpmProject({}, { "pnpm-lock.yaml": lock(hidden) })), "private-registry", /npm\.example\.com/);
    const engines = ready(await resolveIn(pnpmProject({ packageManager: "pnpm@10.4.1", engines: { node: ">=20" } }, { "pnpm-lock.yaml": lock("  a@1.0.0:\n    resolution:\n      integrity: sha512-x\n    engines:\n      node: '<22'\n") })));
    assert.deepEqual(tool(engines, "node"), { kind: "exact", version: "20.19.0" }, "the dependency's engines are preferred");
    refused(await resolveIn(pnpmProject({}, { "pnpm-lock.yaml": lock("  a@1.0.0:\n    resolution: *shared\n") })), "layout", /couldn't read "?a@1\.0\.0 \(resolution\)"? in pnpm-lock\.yaml, so it can't tell where the install fetches from\. pnpm writes this file itself/);
    refused(await resolveIn(npmProject({}, { "package-lock.json": npmLock({ "node_modules/a": { version: "1.0.0", resolved: { url: "https://npm.example.com/a.tgz" } } }) })), "layout", /couldn't read "?node_modules\/a \(resolved\)"? in package-lock\.json/);
  });

  it("4. counts each pnpm build setting only from the version that reads it, and only where it reads it", async () => {
    const policy = async (version: string, manifest: Record<string, unknown>, yaml?: string) => ready(await resolveIn(pnpmProject({ packageManager: `pnpm@${version}`, ...manifest }, yaml ? { "pnpm-workspace.yaml": yaml } : {}))).recipe.builds;
    const early = await policy("10.4.1", {}, "allowBuilds:\n  esbuild: true\ndangerouslyAllowAllBuilds: true\nonlyBuiltDependencies:\n  - sharp\n");
    assert.deepEqual([early.runs, early.allowed], ["none", []], "10.4.1 reads none of them from pnpm-workspace.yaml");
    assert.deepEqual(early.notes.map((note) => /\((pnpm [\d.]+) and later do\)/.exec(note)?.[1]), ["pnpm 10.26", "pnpm 10.9", "pnpm 10.5"]);
    assert.equal((await policy("10.4.1", { pnpm: { dangerouslyAllowAllBuilds: true } })).runs, "none", "never read from package.json");
    assert.equal((await policy("10.9.0", {}, "dangerouslyAllowAllBuilds: true\n")).runs, "all");
    assert.deepEqual((await policy("10.9.0", {}, "allowBuilds:\n  esbuild: true\n")).runs, "none", "allowBuilds arrived in 10.26");
    const late = await policy("10.26.0", { pnpm: { onlyBuiltDependencies: ["core-js"] } }, "allowBuilds:\n  esbuild: true\n  sharp: false\n");
    assert.deepEqual([late.runs, late.allowed, late.denied, late.source], ["allowed", ["esbuild"], ["sharp"], "pnpm-workspace.yaml"], "the workspace file's list replaces package.json's");
    assert.deepEqual((await policy("10.5.0", {}, "onlyBuiltDependencies:\n  - esbuild\nstrictDepBuilds: true\n")).allowed, ["esbuild"]);
    assert.deepEqual([(await policy("10.5.0", {}, "onlyBuiltDependencies: []\nstrictDepBuilds: true\n")).strict, (await policy("10.6.0", {}, "onlyBuiltDependencies: []\nstrictDepBuilds: true\n")).strict], [false, true], "the workspace file holds strictDepBuilds from 10.6");
    const versioned = await policy("10.4.1", { pnpm: { onlyBuiltDependencies: ["esbuild@0.25.1", "sharp"] } });
    assert.deepEqual([versioned.runs, versioned.allowed], ["allowed", ["sharp"]], "before 10.19 a version in an entry names no package");
    assert.match(versioned.notes.join(" "), /esbuild@0\.25\.1 allows no build/);
  });
});
