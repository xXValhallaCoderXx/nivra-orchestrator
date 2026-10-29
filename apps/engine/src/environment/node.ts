import { EnvironmentResolution, RECIPE_FORMAT, RECIPE_LIMITS, type BootstrapStep, type BuildPolicy, type ChoiceNeeded, type ChoiceOption, type Declaration, type EnvironmentChoices, type EnvironmentRecipe, type InstallOptions, type InstallScope, type RecipeTool, type ResolutionRow, type ResolutionSource, type ResolutionWarning } from "@nivra/domain";
import { ENV_PATH } from "../exec/nebius/sandbox.ts";
import type { Snapshot, SnapshotFile } from "../exec/snapshot.ts";
import { satisfies, setupConfiguration } from "./inputs.ts";
import { dependencySpecs, INSTALL_HOOKS, isLocalSpec, isNodeSetupPath, LOCKFILES, npmLockFacts, objectAt, PNPMFILES, pnpmLockFacts, simpleYaml, stringAt, SUPPORTED_MANAGERS, textOf, unreadGlob, VERSION_FILES, versionFileValue, workspaceMembers, type LockfileFacts, type Manifest, type YamlValue } from "./node-files.ts";
import { advisoryFor, RELEASES, standing, type NodeRelease, type ReleaseIndex, type ToolRelease } from "./releases.ts";
import { versionParts } from "./versions.ts";

/**
 * Node's resolver (NIV-55, NIV-58): a project's declared setup, read from Nivra's own snapshot of the commit, settled into
 * a recipe that the person approves. It reads the project's version files, its package.json fields, its lockfile and its
 * workspace file, and nothing else; it runs nothing and reaches no network.
 *
 * - An exact pin is honoured exactly. A range resolves to an exact release in Nivra's index, and is kept from one
 *   preparation to the next while the setup is unchanged.
 * - With nothing declared, the recommended default is labelled as such and can be changed.
 * - Conflicting declarations, and ones Nivra can't read, wait for the person's choice. Nothing is chosen for them, and
 *   nothing is substituted.
 * - The recipe is built from the project's declarations, the person's choices and the versions kept, never from what
 *   the index happens to know: a fact only preparation can confirm (the npm a Node release bundles, whether it has
 *   corepack) is written as the rule preparation answers. So refreshing the index never changes a recipe.
 * - Layouts that need the project's sources to install are refused, naming the file, until preparing from the sources
 *   is built.
 */

/** What the project's last preparation settled on. A value the person chose then is kept only while they choose it. */
export interface PreviousSettlement {
  configuration: string;
  runtime: string;
  manager: string;
  managerVersion: string;
  chosen?: { runtime?: boolean; managerVersion?: boolean };
}

export interface NodeResolveInput {
  snapshot: Pick<Snapshot, "files" | "leftOutPaths">;
  choices?: EnvironmentChoices;
  previous?: PreviousSettlement | null;
  releases?: ReleaseIndex;
}

/** The hosts a public install fetches from: the npm registry, and its public mirror. */
const PUBLIC_REGISTRIES = ["registry.npmjs.org", "registry.yarnpkg.com"];
/** Which lockfile formats each pnpm major reads with a frozen install. A major not listed is checked when preparing. */
const PNPM_LOCKFILES: Readonly<Record<string, readonly number[]>> = { "5.4": [7], "6.0": [8], "6.1": [8], "9.0": [9, 10, 11] };
const NPM_LOCKFILES = ["2", "3"];
/** The pnpm majors whose rules Nivra knows: lockfile formats, build policy, settings and variables. */
const KNOWN_PNPM_MAJORS = [7, 8, 9, 10, 11];
const MIN_MANAGER_MAJOR = 7;
/** npm with no pin or range: the one the Node image bundles, which preparation records. */
const BUNDLED = "bundled";

type OptionRule = { values: "boolean" | readonly string[]; list?: boolean };
/** npm's install options, each passed as its own flag. */
const NPM_OPTIONS: Readonly<Record<string, OptionRule>> = {
  "legacy-peer-deps": { values: "boolean" },
  "install-links": { values: "boolean" },
  "strict-peer-deps": { values: "boolean" },
  "install-strategy": { values: ["hoisted", "nested", "shallow", "linked"] },
  omit: { values: ["dev", "optional", "peer"], list: true },
  include: { values: ["prod", "dev", "optional", "peer"], list: true },
  "engine-strict": { values: "boolean" },
  "ignore-scripts": { values: "boolean" },
};
/** pnpm 10 and older still read these from .npmrc, which Nivra never sends; pnpm 11 reads them only from pnpm-workspace.yaml. */
const PNPM_OPTIONS: Readonly<Record<string, OptionRule>> = {
  "node-linker": { values: ["isolated", "hoisted", "pnp"] },
  "shamefully-hoist": { values: "boolean" },
  "auto-install-peers": { values: "boolean" },
  "strict-peer-dependencies": { values: "boolean" },
};
const BUILD_KEYS = ["allowBuilds", "onlyBuiltDependencies", "onlyBuiltDependenciesFile", "neverBuiltDependencies", "ignoredBuiltDependencies", "dangerouslyAllowAllBuilds", "strictDepBuilds"];
type MinorVersion = readonly [number, number];
/**
 * Where pnpm 10 reads each build setting, and from which version (pnpm's changelog and its settings page): package.json's
 * pnpm field, and pnpm-workspace.yaml, which holds the pnpm field's settings from 10.5 and every other setting from 10.6.
 * Null where it never reads it. A setting where the project's pnpm doesn't read it is left out of the policy, and said.
 */
const BUILD_SETTINGS: Readonly<Record<string, { field: MinorVersion | null; workspace: MinorVersion | null }>> = {
  neverBuiltDependencies: { field: [5, 16], workspace: [10, 5] },
  onlyBuiltDependencies: { field: [6, 32], workspace: [10, 5] },
  onlyBuiltDependenciesFile: { field: [8, 9], workspace: [10, 5] },
  ignoredBuiltDependencies: { field: [10, 1], workspace: [10, 5] },
  allowBuilds: { field: [10, 26], workspace: [10, 26] },
  strictDepBuilds: { field: null, workspace: [10, 6] },
  dangerouslyAllowAllBuilds: { field: null, workspace: [10, 9] },
};
/** From pnpm 10.19 an onlyBuiltDependencies entry can name versions (esbuild@0.25.1); before, such an entry names no package. */
const VERSIONED_BUILDS: MinorVersion = [10, 19];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const quoted = (text: string) => clip(text, 200);
const majorOf = (version: string) => versionParts(version)?.[0] ?? -1;
/** Whether a version is at least a major and minor: settings arrive within a major. */
const atLeast = (version: string, [major, minor]: MinorVersion) => {
  const parts = versionParts(version);
  return parts !== null && (parts[0] > major || (parts[0] === major && parts[1] >= minor));
};
const decl = (file: string, field: string | null, value: string): Declaration => ({ file: clip(file, 1_024), field, value: quoted(value) });
const unique = <T>(items: readonly T[]) => [...new Set(items)];
const readable = (range: string) => satisfies("1.0.0", range) !== null;
const camel = (key: string) => key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const where = (declaration: Declaration) => (declaration.field ? `${declaration.file}'s ${declaration.field}` : declaration.file);
const WITHOUT = "a task for this project runs from Nivra's own base image, without its dependencies";
const PLANNED = `Preparing from a project's sources is planned. Until it's built, ${WITHOUT}.`;

class Refused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A package manager pin as package.json's packageManager writes it, any integrity suffix dropped. */
function managerPin(raw: string): { name: string; version: string } | null {
  const match = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)(\+[A-Za-z0-9.]+)?$/.exec(raw);
  return match ? { name: match[1]!, version: match[2]! } : null;
}

/** devEngines entries for one field: an object, or a list of them, each with a name and an optional version range. */
function devEngines(root: Record<string, unknown>, field: "runtime" | "packageManager"): Array<{ name: string; version: string | null }> {
  const value = objectAt(root["devEngines"])[field];
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.flatMap((entry) => {
    const item = objectAt(entry);
    const name = stringAt(item["name"]);
    return name ? [{ name, version: stringAt(item["version"]) }] : [];
  });
}

const stringList = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null);

/** A version file's or volta's value: an exact pin, a release line (a range), an alias, or something Nivra can't read. */
function classify(value: string): { pin: string } | { range: string } | { alias: string } | { unreadable: string } {
  const text = value.trim().replace(/^v(?=\d)/, "");
  if (/^\d+\.\d+\.\d+$/.test(text)) return { pin: text };
  if (/^\d+(\.(\d+|x))?(\.x)?$/.test(text)) return { range: text };
  if (/^(lts\/[A-Za-z*-]+|node|stable|latest|current)$/i.test(text)) return { alias: text.toLowerCase() };
  return { unreadable: value };
}

/** Aliases that ask for the newest release of all, LTS or not. */
const ANY_RELEASE = ["node", "stable", "latest", "current"];

/** The releases an alias names, from the whole index: an LTS line, every LTS release, or every release. Null for an LTS name the index doesn't know. */
function aliasReleases(releases: readonly NodeRelease[], alias: string): NodeRelease[] | null {
  if (alias === "lts/*") return releases.filter((release) => release.lts !== null);
  if (alias.startsWith("lts/")) {
    const line = releases.filter((release) => release.lts?.toLowerCase() === alias.slice(4));
    return line.length ? line : null;
  }
  return [...releases];
}

interface Settled {
  version: string;
  source: ResolutionSource;
  declarations: Declaration[];
  note: string | null;
  /** True when the version isn't in the index, so facts about it are checked when preparing. */
  unknown: boolean;
}

/** Either a settled value, or the choices to put to the person. */
type Outcome = { settled: Settled } | { choices: ChoiceNeeded[] };

/** A choice's answer, when the person gave one of its options. */
const answered = (choice: ChoiceNeeded, value: string | undefined) => (value !== undefined && choice.options.some((option) => option.value === value) ? value : null);

/** A choice the person can answer, or, when there is nothing to offer, a refusal that says what to do instead. */
function choiceOf(id: ChoiceNeeded["id"], why: ChoiceNeeded["why"], message: string, declarations: readonly Declaration[], options: readonly ChoiceOption[], instead: string): ChoiceNeeded {
  const offered = unique(options.map((option) => option.value)).map((value) => options.find((option) => option.value === value)!);
  // The message's closing "Choose …" sentence goes, a version's dots inside it included, since there is nothing to choose.
  if (offered.length === 0) throw new Refused(why === "unreadable" ? "unreadable" : "unavailable", clip(`${message.replace(/ Choose(?:[^.]|\.(?=\d))*\.( Or (?:[^.]|\.(?=\d))*\.)?$/, "")} ${instead}`, 2_000));
  return { id, why, message: clip(message, 1_000), declarations: declarations.slice(0, 40), options: offered.slice(0, 20) };
}

export function resolveNodeEnvironment(input: NodeResolveInput): EnvironmentResolution {
  let result: EnvironmentResolution;
  try {
    result = resolve(input);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    result = { status: "refused", code: error.code, message: clip(error.message, 2_000), rows: [] };
  }
  // Every answer is one the contract takes. One that isn't is Nivra's fault, said as such, never sent on.
  if (!EnvironmentResolution.safeParse(result).success) {
    return { status: "refused", code: "fault", message: "Nivra couldn't describe this project's setup within its own limits, so nothing can be prepared from it. Report it, with how the project is laid out.", rows: [] };
  }
  return result;
}

function resolve(input: NodeResolveInput): EnvironmentResolution {
  const releases = input.releases ?? RELEASES;
  const choices = input.choices ?? {};
  const warnings: ResolutionWarning[] = [];
  const limitations: string[] = [];
  const byPath = new Map(input.snapshot.files.map((file) => [file.path, file]));
  const present = (path: string) => byPath.get(path)?.kind === "file";

  // The setup configuration: every file that decides the environment, frozen during a task.
  const configuration = setupConfiguration(input.snapshot, isNodeSetupPath);
  const link = configuration.files.find((file) => file.kind !== "file");
  if (link) throw new Refused("layout", `${quoted(link.path)} is a link. Nivra reads a project's setup files only as files: commit the file itself, then try again.`);
  if (configuration.files.length > RECIPE_LIMITS.inputs) throw new Refused("layout", `This commit has ${configuration.files.length} setup files, more than the ${RECIPE_LIMITS.inputs} an environment is prepared from.`);
  const bytes = configuration.files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > RECIPE_LIMITS.inputBytes) throw new Refused("layout", `This commit's setup files come to ${bytes} bytes, more than the ${RECIPE_LIMITS.inputBytes} an environment is prepared from.`);

  if (!present("package.json")) throw new Refused("no-project", "This folder's commit has no package.json at its top, so there is no Node project to prepare. Add the project's own folder, then try again.");
  const manifests = configuration.files.filter((file) => file.path === "package.json" || file.path.endsWith("/package.json")).map(manifestOf);
  const root = manifests.find((manifest) => manifest.folder === "")!.json;

  const tracked = [...input.snapshot.files.map((file) => file.path), ...input.snapshot.leftOutPaths].find((path) => /(^|\/)node_modules\//i.test(path));
  if (tracked) throw new Refused("tracked-dependencies", `This commit tracks files inside node_modules, such as ${quoted(tracked)}. An environment installs dependencies there, where they would mix with tracked files. Stop tracking node_modules, commit, then try again.`);

  // The workspace file, read only as far as it can be read.
  const workspaceFile = byPath.get("pnpm-workspace.yaml");
  const workspace = workspaceFile?.kind === "file" ? simpleYaml(textOf(workspaceFile)) : null;
  if (workspace?.unreadable.includes("packages")) throw new Refused("layout", "Nivra couldn't read the packages list in pnpm-workspace.yaml, so it can't tell which packages the workspace holds. Write it as a plain list of paths, commit, then try again.");
  const npmGlobs = stringList(root["workspaces"]) ?? stringList(objectAt(root["workspaces"])["packages"]);
  const folders = manifests.map((manifest) => manifest.folder);

  // The package manager, then its lockfile.
  const manager = resolveManagerName(root, present, choices);
  if ("choices" in manager) return needsChoice(manager.choices);
  const managerName = manager.settled.version;
  const lockPath = LOCKFILES[managerName]!.find(present)!;
  const lock = lockFacts(managerName, lockPath, textOf(byPath.get(lockPath)!));

  const pnpmGlobs = workspace ? stringList(workspace.values.get("packages")) : null;
  const globs = managerName === "pnpm" ? pnpmGlobs : npmGlobs;
  // A pattern read as matching nothing would leave its packages' Node requirements and install hooks unchecked.
  const unread = globs ? unreadGlob(globs) : null;
  if (unread !== null) throw new Refused("layout", `Nivra can't read the workspace pattern ${quoted(unread)} in ${managerName === "pnpm" ? "pnpm-workspace.yaml" : "package.json's workspaces"}, so it can't tell which packages the workspace holds. Nivra reads *, **, ? and lists such as {a,b}: write the pattern with those, or list each package's folder, commit, then try again.`);
  const memberFolders = globs ? workspaceMembers(globs, folders) : [];
  const members = manifests.filter((manifest) => manifest.folder === "" || memberFolders.includes(manifest.folder));

  // The install scope: pnpm can install chosen packages; npm installs the whole project.
  const scope: InstallScope = choices.scope ?? { kind: "whole" };
  if (scope.kind === "selected" && (managerName !== "pnpm" || !pnpmGlobs)) {
    throw new Refused("scope", managerName === "pnpm" ? "This project isn't a pnpm workspace, so there are no packages to choose. Choose the whole project, then preview again." : "Choosing npm workspaces to install isn't available yet. Choose the whole project, then preview again.");
  }
  const inScope = scope.kind === "selected" ? scopedMembers(scope.selectors, members, warnings) : members;

  refuseSourceLayouts(root, members, workspace, present, lock);

  // The runtime, from every declaration in scope.
  const runtime = resolveRuntime({ releases, byPath, root, inScope, lock, choices, previous: input.previous ?? null, configuration: configuration.digest, warnings });
  if ("choices" in runtime) return needsChoice(runtime.choices);
  const node = runtime.settled;

  // The manager's version, and whether it works with this runtime and lockfile.
  const version = resolveManagerVersion({ releases, manager: managerName, root, node, nodeMeets: runtime.meets, lock, choices, previous: input.previous ?? null, configuration: configuration.digest, warnings });
  if ("choices" in version) return needsChoice(version.choices);
  const managerVersion = version.settled;

  const options = installOptions(managerName, managerVersion.version, choices.options ?? {});
  const builds = buildPolicy(managerName, managerVersion.version, root, workspace, options, warnings);
  const pnpmMajor = managerName === "pnpm" ? majorOf(managerVersion.version) : null;

  // Tools and their bootstrap: the rule where only preparation can confirm the fact, never what the index says.
  const bundled = { kind: "bundled" as const, with: "node" };
  const tools: RecipeTool[] = [{ name: "node", version: { kind: "exact", version: node.version }, from: "image" }];
  const bootstrap: BootstrapStep[] = [];
  if (managerName === "npm" && managerVersion.version !== BUNDLED) {
    tools.push({ name: "npm", version: { kind: "exact", version: managerVersion.version }, from: "bootstrap" });
    bootstrap.push({ tool: "npm", version: managerVersion.version, via: "npm-global" });
  } else {
    tools.push({ name: "npm", version: bundled, from: "image" });
  }
  if (managerName === "pnpm") {
    tools.push({ name: "pnpm", version: { kind: "exact", version: managerVersion.version }, from: "bootstrap" });
    // Inside the project, corepack runs the version packageManager pins whatever was activated: a different version,
    // the person's choice or an advisory's replacement, is installed with npm instead, where corepack doesn't reach it.
    const pinned = managerPin(stringAt(root["packageManager"]) ?? "");
    const corepackRunsIt = pinned === null || (pinned.name === "pnpm" && pinned.version === managerVersion.version);
    bootstrap.push({ tool: "pnpm", version: managerVersion.version, via: corepackRunsIt ? "corepack-else-npm-global" : "npm-global" });
  }

  const args = managerName === "npm" ? ["ci", "--no-audit", "--no-fund", ...npmFlags(options)] : ["install", "--frozen-lockfile", ...(scope.kind === "selected" ? ["--fail-if-no-match", ...scope.selectors.flatMap((selector) => ["--filter", selector])] : [])];
  const recipe: EnvironmentRecipe = {
    format: RECIPE_FORMAT,
    profile: "node",
    platform: { os: "linux", arch: "x86_64", libc: "musl" },
    image: { registryUrl: `docker://docker.io/library/node:${node.version}-alpine`, tag: `node:${node.version}-alpine` },
    tools,
    bootstrap,
    install: { tool: managerName, args, options },
    scope,
    builds,
    configuration: { mode: "manifests", files: configuration.files.map((file) => ({ path: file.path, bytes: file.size, sha256: file.sha256 })), digest: configuration.digest },
    systemPackages: [],
    workdir: "/workspace",
    env: { preparation: preparationEnv(managerName, pnpmMajor, options), task: taskEnv(managerName, pnpmMajor) },
    artifacts: { dependency: ["node_modules"], caches: ["/root/.cache", "/root/.local/share/pnpm", "/root/.npm"] },
    network: { preparation: "on", tasks: "off", hosts: unique(["registry.npmjs.org", ...lock.hosts]), imageRegistry: "docker.io" },
    probes: ["tool-versions", "session-tools", ...(managerName === "pnpm" ? ["manager-settings"] : [])],
    limits: { importSeconds: 900, prepareSeconds: 600, probeSeconds: 120 },
  };

  if (input.snapshot.leftOutPaths.some((path) => path === ".npmrc" || path.endsWith("/.npmrc"))) {
    limitations.push(".npmrc isn't read or sent, so settings in it don't apply. If it sets install options such as legacy-peer-deps or install-links, choose the same ones here.");
  }
  if (managerName === "npm" && npmGlobs) limitations.push("Choosing npm workspaces to install isn't available yet: the whole project is installed.");
  limitations.push("Environments run on x86_64 Linux with Alpine (musl) for now. A dependency that ships only glibc binaries, or builds natively, may fail to install.");
  limitations.push("Networking is on while the environment is prepared, and off for every task run and check that starts from it.");
  if (node.unknown || managerVersion.unknown) limitations.push(`Nivra's release index is from ${releases.fetchedAt.slice(0, 10)}, so facts about versions newer than it are checked when preparing.`);

  const bundledNote = releases.node.find((release) => release.version === node.version)?.npm;
  const rows: ResolutionRow[] = [
    row("runtime", "Node", node.version, node.source, node.declarations, node.note),
    row("manager", "Package manager", managerName, manager.settled.source, manager.settled.declarations, manager.settled.note),
    row(
      "manager-version",
      `${managerName} version`,
      managerVersion.version === BUNDLED ? `the one Node ${node.version} bundles` : managerVersion.version,
      managerVersion.source,
      managerVersion.declarations,
      managerVersion.version === BUNDLED ? `Preparation records the version it finds${bundledNote ? `; Nivra's release index says npm ${bundledNote}` : ""}.` : managerVersion.note,
    ),
    row("lockfile", "Lockfile", `${lockPath}, format ${lock.format}`, "declared", [decl(lockPath, "lockfileVersion", String(lock.format))], null),
    row(
      "workspace",
      "Workspace",
      globs ? `${managerName === "pnpm" ? "pnpm workspace" : "npm workspaces"}, ${memberFolders.length} package${memberFolders.length === 1 ? "" : "s"}` : "a single package",
      globs ? "declared" : "resolved",
      globs ? [decl(managerName === "pnpm" ? "pnpm-workspace.yaml" : "package.json", managerName === "pnpm" ? "packages" : "workspaces", globs.join(", "))] : [],
      scope.kind === "selected" ? `Installing ${scope.selectors.join(", ")}.` : null,
    ),
    row("install", "Install", `${managerName} ${args.join(" ")}`, "resolved", [], null),
    row("builds", "Dependency builds", buildsSummary(builds), builds.source ? "declared" : "default", builds.source ? [decl(builds.source, null, buildsSummary(builds))] : [], builds.notes.length ? builds.notes.join(" ") : null),
    row("platform", "Platform", "Linux x86_64, Alpine (musl)", "default", [], "A Debian (glibc) platform isn't available yet."),
    row("image", "Base image", recipe.image.tag, "resolved", [], "A tag doesn't pin bytes: preparation records the image it made and checks the versions in it."),
  ];
  return { status: "ready", rows, recipe, warnings: warnings.slice(0, 20), limitations };

  function needsChoice(needed: ChoiceNeeded[]): EnvironmentResolution {
    return { status: "needs-choice", rows: [], choices: needed.slice(0, 4), warnings: warnings.slice(0, 20), limitations };
  }
}

/** One row of the detected setup, within the contract's bounds. */
function row(fact: string, label: string, value: string, source: ResolutionSource, declarations: readonly Declaration[], note: string | null): ResolutionRow {
  const shown = declarations.slice(0, 40);
  const more = declarations.length - shown.length;
  const extra = more > 0 ? `${more} more declaration${more === 1 ? "" : "s"} aren't shown.` : null;
  const text = [note, extra].filter(Boolean).join(" ");
  return { fact, label, value: clip(value, 300), source, declarations: shown, note: text ? clip(text, 600) : null };
}

/** A manifest's JSON object, or a refusal naming the file. */
function manifestOf(file: SnapshotFile): Manifest {
  try {
    const value: unknown = JSON.parse(textOf(file));
    if (value && typeof value === "object" && !Array.isArray(value)) return { path: file.path, folder: file.path === "package.json" ? "" : file.path.slice(0, -"/package.json".length), json: value as Record<string, unknown> };
  } catch {
    // Said below, naming the file.
  }
  throw new Refused("layout", `${quoted(file.path)} isn't a JSON object, so Nivra can't read what it installs. Fix it, commit, then try again.`);
}

function resolveManagerName(root: Record<string, unknown>, present: (path: string) => boolean, choices: EnvironmentChoices): Outcome {
  const raw = stringAt(root["packageManager"]);
  const pin = raw === null ? null : managerPin(raw);
  if (raw !== null && pin === null) throw new Refused("layout", `package.json's packageManager is ${quoted(raw)}, which doesn't name an exact version (such as pnpm@11.5.3). Fix it, commit, then try again.`);
  const dev = devEngines(root, "packageManager");
  const withLock = Object.keys(LOCKFILES).filter((name) => LOCKFILES[name]!.some(present));
  // Alphabetical, so no manager is offered first.
  const supportedWithLock = withLock.filter((name) => (SUPPORTED_MANAGERS as readonly string[]).includes(name)).sort();
  const declarations: Declaration[] = [
    ...(raw ? [decl("package.json", "packageManager", raw)] : []),
    ...dev.map((entry) => decl("package.json", "devEngines.packageManager", entry.version ? `${entry.name} ${entry.version}` : entry.name)),
    ...withLock.flatMap((name) => LOCKFILES[name]!.filter(present).map((file) => decl(file, null, `${name} lockfile`))),
  ];
  const unsupported = (name: string) => !(SUPPORTED_MANAGERS as readonly string[]).includes(name);
  const option = (name: string): ChoiceOption => ({ value: name, label: name, note: LOCKFILES[name]!.some(present) ? null : `There is no ${LOCKFILES[name]!.join(" or ")} for it.` });
  const choose = (why: ChoiceNeeded["why"], message: string, names: string[]): Outcome => {
    const choice = choiceOf("manager", why, message, declarations, unique(names).filter((name) => !unsupported(name)).sort().map(option), "Make the declarations agree, commit, then try again.");
    const value = answered(choice, choices.manager);
    if (value !== null && LOCKFILES[value]!.some(present)) return { settled: { version: value, source: "choice", declarations, note: null, unknown: false } };
    return { choices: [choice] };
  };

  if (pin && unsupported(pin.name)) throw new Refused("unsupported-manager", `This project uses ${pin.name}: package.json's packageManager says ${quoted(raw!)}. Nivra prepares npm and pnpm projects, and doesn't convert a project to another package manager, so ${WITHOUT}.`);
  if (pin) {
    const others = unique(dev.filter((entry) => entry.name !== pin.name).map((entry) => entry.name));
    if (others.length) return choose("conflict", `package.json's packageManager names ${pin.name}, and its devEngines.packageManager names ${others.join(" and ")}. Choose which package manager prepares this project, or make them agree.`, [pin.name, ...others]);
  } else if (unique(dev.map((entry) => entry.name)).length > 1) {
    return choose("ambiguous", "package.json's devEngines.packageManager names more than one package manager. Choose which one prepares this project.", dev.map((entry) => entry.name));
  }
  const named = pin?.name ?? dev[0]?.name ?? null;
  if (named !== null) {
    if (unsupported(named)) throw new Refused("unsupported-manager", `This project uses ${named}. Nivra prepares npm and pnpm projects, and doesn't convert a project to another package manager, so ${WITHOUT}.`);
    if (LOCKFILES[named]!.some(present)) return { settled: { version: named, source: "declared", declarations, note: null, unknown: false } };
    if (supportedWithLock.length) {
      return choose("conflict", `package.json names ${named}, but this commit has no ${LOCKFILES[named]!.join(" or ")} for it, and it has ${supportedWithLock.map((name) => LOCKFILES[name]!.find(present)).join(" and ")}. Choose the package manager whose lockfile is committed, or commit ${named}'s lockfile.`, [named, ...supportedWithLock]);
    }
    throw new Refused("no-lockfile", `This commit has no ${LOCKFILES[named]!.join(" or ")}. An environment installs only from a committed lockfile: run ${named} install, commit the lockfile, then try again.`);
  }
  if (supportedWithLock.length === 1) return { settled: { version: supportedWithLock[0]!, source: "resolved", declarations, note: `From ${LOCKFILES[supportedWithLock[0]!]!.find(present)}.`, unknown: false } };
  if (supportedWithLock.length > 1) return choose("ambiguous", `This commit has lockfiles for ${supportedWithLock.join(" and ")}, and package.json doesn't say which package manager it uses. Choose one, or add packageManager to package.json.`, supportedWithLock);
  if (withLock.length) throw new Refused("unsupported-manager", `This project uses ${withLock.join(" and ")}, judging by its lockfile. Nivra prepares npm and pnpm projects, and doesn't convert a project to another package manager, so ${WITHOUT}.`);
  throw new Refused("no-lockfile", "This commit has no lockfile. An environment installs only from a committed lockfile: run npm install or pnpm install, commit the lockfile, then try again.");
}

function lockFacts(manager: string, path: string, text: string): LockfileFacts {
  // An entry Nivra can't read could fetch from anywhere, so the lockfile is refused rather than read without it.
  const readable = (facts: LockfileFacts) => {
    const more = facts.unreadable.length - 1;
    if (more >= 0) throw new Refused("layout", `Nivra couldn't read ${quoted(facts.unreadable[0]!)} in ${path}${more ? ` (and ${more} more)` : ""}, so it can't tell where the install fetches from. ${manager} writes this file itself: run ${manager} install in the repository, commit ${path}, then try again.`);
    return facts;
  };
  if (manager === "npm") {
    const facts = npmLockFacts(text);
    if (!facts) throw new Refused("layout", `${path} isn't a JSON object, so Nivra can't read what it installs. Fix it, commit, then try again.`);
    if (facts.format === "1") throw new Refused("layout", `${path} is lockfile format 1, from npm 6, which npm ci can't install exactly. Run npm install with npm 7 or later, commit the lockfile, then try again.`);
    if (!NPM_LOCKFILES.includes(String(facts.format))) throw new Refused("layout", `${path} says lockfileVersion ${quoted(String(facts.format))}, which Nivra can't read. Regenerate it with npm 7 or later, commit, then try again.`);
    return readable(facts);
  }
  const facts = pnpmLockFacts(text);
  if (facts.format === null) throw new Refused("layout", `${path} doesn't say its lockfileVersion, so Nivra can't tell which pnpm reads it. Regenerate it with pnpm, commit, then try again.`);
  return readable(facts);
}

/** The layouts that need the project's sources, or tools the image hasn't got, to install: refused, naming the file. */
function refuseSourceLayouts(root: Record<string, unknown>, members: readonly Manifest[], workspace: ReturnType<typeof simpleYaml> | null, present: (path: string) => boolean, lock: LockfileFacts): void {
  for (const manifest of members) {
    const scripts = Object.keys(objectAt(manifest.json["scripts"]));
    const hooks = INSTALL_HOOKS.filter((name) => scripts.includes(name));
    if (hooks.length) throw new Refused("needs-sources", `${quoted(manifest.path)} runs ${hooks.join(", ")} during an install, which needs the project's sources. ${PLANNED}`);
  }
  if ("patchedDependencies" in objectAt(root["pnpm"]) || workspace?.values.has("patchedDependencies") || workspace?.unreadable.includes("patchedDependencies")) throw new Refused("needs-sources", `This project patches its dependencies, and the patches are part of its sources. ${PLANNED}`);
  const pnpmfile = PNPMFILES.find(present) ?? (workspace ? stringAt(workspace.values.get("pnpmfile") ?? null) : null);
  if (pnpmfile) throw new Refused("needs-sources", `This project has ${quoted(pnpmfile)}, which runs code from the repository during an install. ${PLANNED}`);
  if (workspace?.values.has("configDependencies") || workspace?.unreadable.includes("configDependencies")) throw new Refused("layout", `This project uses pnpm config dependencies (configDependencies in pnpm-workspace.yaml), which Nivra can't prepare yet. Until it can, ${WITHOUT}.`);
  for (const manifest of members) {
    const local = dependencySpecs(manifest.json).find((dependency) => isLocalSpec(dependency.spec));
    if (local) throw new Refused("needs-sources", `${quoted(manifest.path)} installs ${quoted(local.name)} from ${quoted(local.spec)}, a local file or folder. ${PLANNED}`);
  }
  if (lock.local.length) throw new Refused("needs-sources", `The lockfile installs ${quoted(lock.local[0]!)} from a local file or folder. ${PLANNED}`);
  if (lock.git.length) throw new Refused("needs-git", `The lockfile installs ${quoted(lock.git[0]!)} from a git repository, and the environment's image has no git yet. Adding git to an environment is planned. Until then, ${WITHOUT}.`);
  const other = lock.hosts.find((host) => !PUBLIC_REGISTRIES.includes(host));
  if (other) throw new Refused("private-registry", `The lockfile installs packages from ${quoted(other)}. Nivra prepares from the public npm registry only, and can't use a private registry or its credentials yet. Until it can, ${WITHOUT}.`);
}

interface RuntimeInput {
  releases: ReleaseIndex;
  byPath: Map<string, SnapshotFile>;
  root: Record<string, unknown>;
  inScope: readonly Manifest[];
  lock: LockfileFacts;
  choices: EnvironmentChoices;
  previous: PreviousSettlement | null;
  configuration: string;
  warnings: ResolutionWarning[];
}

function resolveRuntime(input: RuntimeInput): Outcome & { meets: (version: string) => boolean } {
  const { releases, choices } = input;
  const pins: Array<{ version: string; declaration: Declaration }> = [];
  const ranges: Array<{ range: string; declaration: Declaration }> = [];
  const unreadableRanges: Array<{ range: string; declaration: Declaration }> = [];
  const aliases: Array<{ alias: string; declaration: Declaration; releases: NodeRelease[] | null }> = [];
  const unreadable: Declaration[] = [];
  const read = (value: string, declaration: Declaration) => {
    const kind = classify(value);
    if ("pin" in kind) pins.push({ version: kind.pin, declaration });
    else if ("range" in kind) ranges.push({ range: kind.range, declaration });
    else if ("alias" in kind) aliases.push({ alias: kind.alias, declaration, releases: aliasReleases(releases.node, kind.alias) });
    else unreadable.push(declaration);
  };
  for (const name of VERSION_FILES) {
    const file = input.byPath.get(name);
    if (file?.kind !== "file") continue;
    const value = versionFileValue(name, textOf(file));
    if (value !== null) read(value, decl(name, null, value));
  }
  const volta = stringAt(objectAt(input.root["volta"])["node"]);
  if (volta) read(volta, decl("package.json", "volta.node", volta));
  for (const manifest of input.inScope) {
    const engine = stringAt(objectAt(manifest.json["engines"])["node"]);
    if (engine) (readable(engine) ? ranges : unreadableRanges).push({ range: engine, declaration: decl(manifest.path, "engines.node", engine) });
  }
  for (const entry of devEngines(input.root, "runtime")) {
    if (entry.name !== "node" || !entry.version) continue;
    (readable(entry.version) ? ranges : unreadableRanges).push({ range: entry.version, declaration: decl("package.json", "devEngines.runtime", entry.version) });
  }
  const declarations = [...pins.map((pin) => pin.declaration), ...ranges.map((range) => range.declaration), ...aliases.map((alias) => alias.declaration), ...unreadable, ...unreadableRanges.map((range) => range.declaration)];
  const meetsRanges = (version: string) => ranges.every((range) => satisfies(version, range.range) === true);
  /**
   * Whether a version meets every declaration Nivra can read: ranges, and the releases each alias names. An alias the
   * index doesn't know is put to the person separately, so it doesn't count here.
   */
  const meets = (version: string) => meetsRanges(version) && aliases.every((alias) => alias.releases === null || ANY_RELEASE.includes(alias.alias) || alias.releases.some((release) => release.version === version));
  const withdrawn = (version: string) => advisoryFor(releases, "node", version) !== null;
  const usable = (version: string) => {
    const at = standing(releases.node, version);
    return (at === "listed" || at === "newer") && !withdrawn(version);
  };
  const dependencyRanges = input.lock.engines.filter((entry) => readable(entry.range));
  const admittedByDependencies = (version: string) => dependencyRanges.every((entry) => satisfies(version, entry.range) !== false);
  /**
   * The newest LTS among the given releases (or the newest of all, for an alias that asks for it), preferring ones every
   * dependency's engines admit; and whether that preference changed the answer.
   */
  const pick = (list: readonly NodeRelease[], newest = false): { release: NodeRelease; steered: boolean } | null => {
    const allowed = list.filter((release) => !withdrawn(release.version));
    const first = (pool: readonly NodeRelease[]) => (newest ? null : pool.find((release) => release.lts !== null)) ?? pool[0] ?? null;
    const preferred = allowed.filter((release) => admittedByDependencies(release.version));
    const chosen = first(preferred.length ? preferred : allowed);
    return chosen ? { release: chosen, steered: chosen !== first(allowed) } : null;
  };
  const option = (version: string, note: string | null = null): ChoiceOption => ({ value: version, label: `Node ${version}`, note });
  const choose = (why: ChoiceNeeded["why"], message: string, options: ChoiceOption[]): Outcome => {
    // Only a release an environment can use is offered: a choice settles which declaration to follow, never that.
    const choice = choiceOf("runtime", why, message, declarations, options.filter((item) => usable(item.value)), "Pin an exact Node version in .nvmrc, commit, then try again.");
    const value = answered(choice, choices.runtime);
    return value !== null ? { settled: settled(value, "choice", null) } : { choices: [choice] };
  };
  const settled = (version: string, source: ResolutionSource, note: string | null): Settled => {
    const known = standing(releases.node, version) === "listed";
    const unknownNote = known ? null : `Node ${version} is newer than Nivra's release index (from ${releases.fetchedAt.slice(0, 10)}), so the npm it bundles and whether it has corepack are checked when preparing.`;
    return { version, source, declarations, note: [note, unknownNote].filter(Boolean).join(" ") || null, unknown: !known };
  };
  const warnDependencies = (version: string) => {
    const against = dependencyRanges.filter((entry) => satisfies(version, entry.range) === false);
    if (against.length) input.warnings.push({ code: "dependency-engines", message: clip(`${against.length} dependenc${against.length === 1 ? "y asks" : "ies ask"} for a different Node than ${version}, such as ${quoted(against[0]!.name)} (${quoted(against[0]!.range)}). The install may warn about it.`, 600) });
  };
  const done = (outcome: Outcome) => ({ ...outcome, meets });
  const best = pick(releases.node.filter((release) => meets(release.version)));
  const bestOption = best ? [option(best.release.version, "The newest LTS release that meets the rest.")] : [];

  // Declarations Nivra can't read: shown as written, and never counted as met.
  if (unreadable.length || unreadableRanges.length) {
    const shown = [...unreadable, ...unreadableRanges.map((range) => range.declaration)].map((item) => `${where(item)} (${item.value})`);
    return done(choose("unreadable", `Nivra can't read ${shown.join(" and ")}, so it can't tell which Node this project needs. Confirm the Node version to use.`, [...pins.map((pin) => option(pin.version, `From ${pin.declaration.file}.`)), ...bestOption]));
  }
  const unknownAlias = aliases.find((alias) => alias.releases === null);
  if (unknownAlias) return done(choose("unreadable", `${unknownAlias.declaration.file} asks for ${quoted(unknownAlias.alias)}, and Nivra's release index has no Node line by that name. Choose a release, or correct the file and commit.`, bestOption));

  const distinct = unique(pins.map((pin) => pin.version));
  if (distinct.length > 1) {
    return done(choose("conflict", `This project pins more than one Node version: ${pins.map((pin) => `${pin.version} in ${where(pin.declaration)}`).join(", ")}. Choose one, or make them agree.`, distinct.map((version) => option(version, meets(version) ? null : "It doesn't meet every other declaration."))));
  }

  if (distinct.length === 1) {
    const version = distinct[0]!;
    const at = standing(releases.node, version);
    if (at === "older") throw new Refused("unsupported-runtime", `This project pins Node ${version}, older than any release Nivra's environments use (Node ${releases.node.at(-1)!.version} and later), so ${WITHOUT}.`);
    if (at === "missing" || withdrawn(version)) {
      const reason = withdrawn(version) ? `Node ${version} is withdrawn: ${advisoryFor(releases, "node", version)!.reason}` : `Node ${version} isn't a Node release.`;
      const near = releases.node.filter((release) => majorOf(release.version) === majorOf(version) && meets(release.version) && !withdrawn(release.version)).slice(0, 3);
      return done(choose("unavailable", `${reason} Choose a release to use instead, or correct the pin and commit.`, near.map((release) => option(release.version))));
    }
    const against = [...ranges.filter((range) => satisfies(version, range.range) === false).map((range) => `${where(range.declaration)} (${range.range})`), ...aliases.filter((alias) => !meets(version) && !ANY_RELEASE.includes(alias.alias)).map((alias) => `${alias.declaration.file} (${alias.alias})`)];
    if (against.length) {
      return done(choose("conflict", `This project pins Node ${version}, which ${against.join(" and ")} doesn't allow. Choose which to follow, or make them agree.`, [option(version, `The pin, from ${pins[0]!.declaration.file}.`), ...(best ? [option(best.release.version, "The newest LTS release every other declaration allows.")] : [])]));
    }
    if (choices.runtime && choices.runtime !== version) input.warnings.push({ code: "choice-ignored", message: `The project pins Node ${version}, so your earlier choice of ${choices.runtime} isn't used.` });
    warnDependencies(version);
    return done({ settled: settled(version, "declared", null) });
  }

  // No exact pin: a release line, an alias or engines ranges resolve within the index; nothing declared takes the default.
  const declared = ranges.length > 0 || aliases.length > 0;
  const newest = aliases.some((alias) => ANY_RELEASE.includes(alias.alias));
  const resolved = pick(releases.node.filter((release) => meets(release.version)), newest);
  if (declared && resolved === null) {
    const named = [...ranges.map((range) => `${where(range.declaration)} (${range.range})`), ...aliases.map((alias) => `${alias.declaration.file} (${alias.alias})`)];
    if (named.length > 1) {
      // The best release for each declaration on its own, so the person can choose which one to follow.
      const each = unique(
        [
          ...ranges.map((range) => pick(releases.node.filter((release) => satisfies(release.version, range.range) === true))?.release.version),
          ...aliases.map((alias) => pick(alias.releases ?? [], ANY_RELEASE.includes(alias.alias))?.release.version),
        ].filter((version): version is string => Boolean(version)),
      );
      return done(choose("conflict", `No Node release meets all of ${named.join(", ")}. Choose a release, or make them agree.`, each.map((version) => option(version))));
    }
    throw new Refused("unavailable-runtime", `No Node release in Nivra's index (from ${releases.fetchedAt.slice(0, 10)}) meets ${named[0]}. Pin an exact Node version in .nvmrc, commit, then try again.`);
  }
  const release = (resolved ?? pick(releases.node))!.release;
  const steered = Boolean(resolved?.steered);
  const fresh = declared
    ? settled(release.version, "resolved", `The newest${newest ? "" : " LTS"} release that meets ${declarations.length === 1 ? "the project's declaration" : "every declaration"}${steered ? ", and that every dependency's engines admit" : ""}.`)
    : settled(release.version, "default", `Nothing in the project says which Node it needs, so this is Nivra's recommended default: the newest LTS release${steered ? " that every dependency's engines admit" : ""}. You can change it.`);

  // The last preparation's version is kept while the setup configuration is unchanged, unless the person chose it then.
  const previous = input.previous;
  const keep = previous && previous.configuration === input.configuration && !previous.chosen?.runtime && meets(previous.runtime) && usable(previous.runtime) ? settled(previous.runtime, fresh.source, "Kept from the environment's last preparation, so a newer release in Nivra's index doesn't change it. Choose another version to change it.") : fresh;
  if (choices.runtime && choices.runtime !== keep.version) {
    const at = standing(releases.node, choices.runtime);
    if (meets(choices.runtime) && usable(choices.runtime)) {
      warnDependencies(choices.runtime);
      return done({ settled: settled(choices.runtime, "choice", null) });
    }
    const why = withdrawn(choices.runtime) ? "is withdrawn" : at === "missing" ? "isn't a Node release" : at === "older" ? "is older than Nivra's environments use" : "doesn't meet the project's declarations";
    input.warnings.push({ code: "choice-ignored", message: `Your earlier choice of Node ${choices.runtime} ${why}, so it isn't used.` });
  }
  warnDependencies(keep.version);
  return done({ settled: keep });
}

interface ManagerInput {
  releases: ReleaseIndex;
  manager: string;
  root: Record<string, unknown>;
  node: Settled;
  /** Whether a Node version meets the project's own declarations: for offering the runtime side of a conflict. */
  nodeMeets: (version: string) => boolean;
  lock: LockfileFacts;
  choices: EnvironmentChoices;
  previous: PreviousSettlement | null;
  configuration: string;
  warnings: ResolutionWarning[];
}

function resolveManagerVersion(input: ManagerInput): Outcome {
  const { releases, manager, node, lock, choices } = input;
  const known = releases.managers[manager] ?? [];
  const raw = stringAt(input.root["packageManager"]);
  const pin = raw ? managerPin(raw) : null;
  const pins: Array<{ version: string; declaration: Declaration }> = [];
  if (pin && pin.name === manager) pins.push({ version: pin.version, declaration: decl("package.json", "packageManager", raw!) });
  const volta = stringAt(objectAt(input.root["volta"])[manager]);
  if (volta !== null) {
    if (/^\d+\.\d+\.\d+$/.test(volta)) pins.push({ version: volta, declaration: decl("package.json", `volta.${manager}`, volta) });
    else input.warnings.push({ code: "unread-declaration", message: `package.json's volta.${manager} is ${quoted(volta)}, which isn't an exact version, so Nivra doesn't use it.` });
  }
  const ranges: Array<{ range: string; declaration: Declaration }> = [];
  const unreadableRanges: Declaration[] = [];
  const addRange = (range: string, declaration: Declaration) => (readable(range) ? ranges.push({ range, declaration }) : unreadableRanges.push(declaration));
  const engine = stringAt(objectAt(input.root["engines"])[manager]);
  if (engine) addRange(engine, decl("package.json", `engines.${manager}`, engine));
  for (const entry of devEngines(input.root, "packageManager")) {
    if (entry.name === manager && entry.version) addRange(entry.version, decl("package.json", "devEngines.packageManager", `${entry.name} ${entry.version}`));
  }
  const declarations = [...pins.map((item) => item.declaration), ...ranges.map((item) => item.declaration), ...unreadableRanges];
  const meetsRanges = (version: string) => ranges.every((range) => satisfies(version, range.range) === true);
  const release = (version: string) => known.find((item) => item.version === version);
  const runsOn = (item: ToolRelease | undefined) => (item?.node ? satisfies(node.version, item.node) : null);
  const readsLock = (version: string): boolean | null => {
    if (manager === "npm") return majorOf(version) >= MIN_MANAGER_MAJOR;
    if (!KNOWN_PNPM_MAJORS.includes(majorOf(version))) return null;
    const majors = PNPM_LOCKFILES[String(lock.format)];
    return majors ? majors.includes(majorOf(version)) : false;
  };
  const withdrawn = (version: string) => advisoryFor(releases, manager, version) !== null;
  const usable = (version: string) => {
    const at = standing(known, version);
    return (at === "listed" || at === "newer") && majorOf(version) >= MIN_MANAGER_MAJOR && !withdrawn(version);
  };
  const works = (version: string) => meetsRanges(version) && runsOn(release(version)) !== false && readsLock(version) !== false && !withdrawn(version);
  const option = (version: string, note: string | null = null): ChoiceOption => ({ value: version, label: `${manager} ${version}`, note });
  const alternatives = (limit = 3) => known.filter((item) => !item.deprecated && works(item.version) && readsLock(item.version) === true).slice(0, limit).map((item) => option(item.version));
  /** What would keep a version offered from working here as it stands: ranges it doesn't meet, the project's Node, or its lockfile. */
  const caveat = (version: string, lead: string | null = null, withRanges = false): string | null => {
    const item = release(version);
    const against = withRanges ? ranges.filter((range) => satisfies(version, range.range) === false) : [];
    const notes = [
      lead,
      against.length ? `It doesn't meet ${against.map((range) => `${range.declaration.field} (${range.range})`).join(" or ")}.` : null,
      runsOn(item) === false ? `It needs Node ${quoted(item!.node!)}, and this project's Node is ${node.version}.` : readsLock(version) === false ? `It can't read the lockfile's format ${lock.format}.` : null,
    ].filter(Boolean);
    return notes.length ? notes.join(" ") : null;
  };
  const settled = (version: string, source: ResolutionSource, note: string | null): Settled => {
    const at = standing(known, version);
    const extra = at === "listed" ? null : `${manager} ${version} is newer than Nivra's release index, so whether it runs on Node ${node.version} is checked when preparing.`;
    const lockNote = readsLock(version) === null ? `Whether ${manager} ${version} reads lockfile format ${lock.format} is checked when preparing.` : null;
    return { version, source, declarations, note: [note, extra, lockNote].filter(Boolean).join(" ") || null, unknown: at !== "listed" };
  };
  const instead = `Pin an exact ${manager} version in package.json's packageManager, commit, then try again.`;
  /** A choice offers only versions an environment can use: releases of a major Nivra supports that aren't withdrawn. */
  const choice = (why: ChoiceNeeded["why"], message: string, options: ChoiceOption[]) => choiceOf("manager-version", why, message, declarations, options.filter((item) => usable(item.value)), instead);
  /**
   * The runtime side of a conflict: Node releases that meet the project and that this manager version runs on. Never
   * offered when the project pins its Node exactly, since a pin always wins over a choice.
   */
  const runtimeSide = (item: ToolRelease | undefined, message: string): ChoiceNeeded[] => {
    if (!item?.node || node.source === "declared") return [];
    const fits = releases.node.filter((candidate) => input.nodeMeets(candidate.version) && satisfies(candidate.version, item.node!) === true && advisoryFor(releases, "node", candidate.version) === null);
    const chosen = fits.find((candidate) => candidate.lts !== null) ?? fits[0];
    return chosen ? [{ id: "runtime", why: "conflict", message: clip(message, 1_000), declarations: declarations.slice(0, 40), options: [{ value: chosen.version, label: `Node ${chosen.version}`, note: `The newest LTS release that meets the project and that ${manager} ${item.version} runs on.` }] }] : [];
  };
  /**
   * The person's answer, checked as the project's own pin is: a choice settles which declaration to follow, never whether
   * the version runs on the project's Node or reads its lockfile. One that doesn't is put to them again, with versions
   * that do, so nothing is ready that couldn't be prepared.
   */
  const answer = (needed: ChoiceNeeded[]): Outcome => {
    const value = needed.filter((item) => item.id === "manager-version").map((item) => answered(item, choices.managerVersion)).find((item) => item !== null) ?? null;
    if (value === null) return { choices: needed };
    const item = release(value);
    if (runsOn(item) === false) {
      const message = `You chose ${manager} ${value}, which needs Node ${quoted(item!.node!)}, and this project's Node is ${node.version}. Choose a ${manager} version that runs on it, or a Node that ${manager} ${value} runs on.`;
      return { choices: [...runtimeSide(item, message), choice("conflict", message, alternatives())] };
    }
    if (readsLock(value) === false) return { choices: [choice("conflict", `You chose ${manager} ${value}, which can't install ${manager === "pnpm" ? "pnpm-lock.yaml" : "the lockfile"} (format ${lock.format}) without changing it. Choose a ${manager} version that reads it.`, alternatives())] };
    return { settled: settled(value, "choice", null) };
  };

  if (unreadableRanges.length) {
    return answer([choice("unreadable", `Nivra can't read ${unreadableRanges.map((item) => `${where(item)} (${item.value})`).join(" and ")}, so it can't tell which ${manager} this project needs. Confirm the version to use.`, [...pins.map((item) => option(item.version, caveat(item.version, "The pin.", true))), ...alternatives()])]);
  }

  const distinct = unique(pins.map((item) => item.version));
  if (distinct.length > 1) return answer([choice("conflict", `This project pins more than one ${manager} version: ${pins.map((item) => `${item.version} in ${item.declaration.field}`).join(" and ")}. Choose one, or make them agree.`, distinct.map((version) => option(version, caveat(version, null, true))))]);
  if (distinct.length === 1) {
    const version = distinct[0]!;
    if (majorOf(version) < MIN_MANAGER_MAJOR) throw new Refused("unsupported-manager", `This project pins ${manager} ${version}, older than Nivra's environments support (${manager} ${MIN_MANAGER_MAJOR} and later), so ${WITHOUT}.`);
    const at = standing(known, version);
    if (at === "missing" || withdrawn(version)) {
      const reason = withdrawn(version) ? `${manager} ${version} is withdrawn: ${advisoryFor(releases, manager, version)!.reason}` : `${manager} ${version} isn't a ${manager} release.`;
      return answer([choice("unavailable", `${reason} Choose a version to use instead, or correct the pin and commit.`, alternatives())]);
    }
    const against = ranges.filter((range) => satisfies(version, range.range) === false);
    if (against.length) return answer([choice("conflict", `package.json pins ${manager} ${version}, which ${against.map((range) => `${range.declaration.field} (${range.range})`).join(" and ")} doesn't allow. Choose which to follow, or make them agree.`, [option(version, caveat(version, "The pin.")), ...alternatives()])]);
    const item = release(version);
    if (runsOn(item) === false) {
      const message = `${manager} ${version} needs Node ${quoted(item!.node!)}, and this project's Node is ${node.version}. Choose a ${manager} version that runs on it, or a Node that ${manager} ${version} runs on.`;
      return answer([...runtimeSide(item, message), choice("conflict", message, alternatives())]);
    }
    if (readsLock(version) === false) return answer([choice("conflict", `${manager} ${version} can't install ${manager === "pnpm" ? "pnpm-lock.yaml" : "the lockfile"} (format ${lock.format}) without changing it. Choose a ${manager} version that reads it, or regenerate the lockfile with ${manager} ${version} and commit.`, alternatives())]);
    if (choices.managerVersion && choices.managerVersion !== version) input.warnings.push({ code: "choice-ignored", message: `The project pins ${manager} ${version}, so your earlier choice of ${choices.managerVersion} isn't used.` });
    return { settled: settled(version, "declared", null) };
  }

  // No pin: the person's choice, then the last preparation's version, then a range or the default.
  if (choices.managerVersion) {
    if (works(choices.managerVersion) && usable(choices.managerVersion)) return { settled: settled(choices.managerVersion, "choice", null) };
    input.warnings.push({ code: "choice-ignored", message: `Your earlier choice of ${manager} ${choices.managerVersion} doesn't fit this project's ${manager} declarations, its Node or its lockfile, so it isn't used.` });
  }
  if (manager === "npm" && ranges.length === 0) {
    // npm with nothing declared is the one the Node image bundles: a rule preparation confirms, never kept or guessed.
    return { settled: { version: BUNDLED, source: "default", declarations, note: null, unknown: false } };
  }
  const previous = input.previous;
  if (previous && previous.configuration === input.configuration && previous.manager === manager && !previous.chosen?.managerVersion && works(previous.managerVersion) && usable(previous.managerVersion)) {
    return { settled: settled(previous.managerVersion, ranges.length ? "resolved" : "default", "Kept from the environment's last preparation, so a newer release in Nivra's index doesn't change it. Choose another version to change it.") };
  }
  const best = known.find((item) => !item.deprecated && works(item.version) && readsLock(item.version) === true) ?? null;
  if (best === null) {
    const any = known.filter((item) => !item.deprecated && meetsRanges(item.version)).slice(0, 3);
    return answer([choice("unavailable", `No ${manager} release in Nivra's index meets this project's declarations and runs on Node ${node.version} with its lockfile. Choose a version, or change the project's Node.`, any.map((item) => option(item.version, runsOn(item) === false ? `Needs Node ${item.node}.` : null)))]);
  }
  return { settled: settled(best.version, ranges.length ? "resolved" : "default", ranges.length ? "The newest release that meets the project's declarations." : `Nothing pins ${manager}, so this is Nivra's recommended default: the newest release that runs on Node ${node.version} and reads the lockfile. You can change it.`) };
}

/** Install options, checked against what this manager and version take. An option set to false is kept: it can matter. */
function installOptions(manager: string, version: string, options: InstallOptions): InstallOptions {
  const major = majorOf(version);
  const entries = Object.entries(options).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return {};
  let rules: Readonly<Record<string, OptionRule>>;
  if (manager === "npm") rules = NPM_OPTIONS;
  else if (KNOWN_PNPM_MAJORS.includes(major) && major <= 10) rules = PNPM_OPTIONS;
  else if (KNOWN_PNPM_MAJORS.includes(major)) {
    const [key] = entries[0]!;
    throw new Refused("options", `pnpm ${version} reads ${key in PNPM_OPTIONS ? camel(key) : "its settings"} from pnpm-workspace.yaml, which is already part of the setup, not as an install option. Set it there, commit, then preview again.`);
  } else throw new Refused("options", `Nivra doesn't know how pnpm ${version} takes install options yet. Remove them, then preview again.`);
  const out: InstallOptions = {};
  for (const [key, value] of entries) {
    const rule = rules[key];
    if (!rule) throw new Refused("options", `${quoted(key)} isn't an install option Nivra knows for ${manager}. Remove it, then preview again.`);
    const takes = rule.values === "boolean" ? "true or false" : rule.list ? `a list of ${rule.values.join(", ")}` : `one of ${rule.values.join(", ")}`;
    const ok = rule.values === "boolean" ? typeof value === "boolean" : rule.list ? Array.isArray(value) && value.every((item) => rule.values.includes(item)) : typeof value === "string" && rule.values.includes(value);
    if (!ok) throw new Refused("options", `${quoted(key)} takes ${takes}, not ${quoted(JSON.stringify(value))}. Change it, then preview again.`);
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** npm's flags for its options, in a fixed order: each said explicitly, off included. */
function npmFlags(options: InstallOptions): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === true) flags.push(`--${key}`);
    else if (value === false) flags.push(`--${key}=false`);
    else if (typeof value === "string") flags.push(`--${key}=${value}`);
    else for (const item of value) flags.push(`--${key}=${item}`);
  }
  return flags;
}

const baseEnv = (): Record<string, string> => ({ PATH: ENV_PATH, HOME: "/root", CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false" });
/** corepack's switch against taking a version from the project's packageManager, where its version reads it. */
const NO_PROJECT_SPEC = { COREPACK_ENABLE_PROJECT_SPEC: "0" };

/**
 * pnpm's switches against running a different version than the recipe's: pnpm 10 and older read npm_config_ variables,
 * pnpm 11 reads pnpm_config_ ones; a major Nivra doesn't know gets both.
 */
function pnpmSwitches(major: number | null, verifyBeforeRun: boolean): Record<string, string> {
  if (major === null) return {};
  const env: Record<string, string> = {};
  const old = major <= 10 || !KNOWN_PNPM_MAJORS.includes(major);
  const current = major >= 11;
  if (old) Object.assign(env, { npm_config_manage_package_manager_versions: "false", ...(verifyBeforeRun ? { npm_config_verify_deps_before_run: "false" } : {}) });
  if (current) Object.assign(env, { pnpm_config_pm_on_fail: "ignore", ...(verifyBeforeRun ? { pnpm_config_verify_deps_before_run: "false" } : {}) });
  return env;
}

/**
 * The preparation's variables. corepack and pnpm are kept from switching to another version than the recipe's, as a
 * person's choice of version can differ from the project's packageManager, and pnpm 10 gets its install options through
 * the variables it reads, since .npmrc is never sent.
 */
function preparationEnv(manager: string, pnpmMajor: number | null, options: InstallOptions): Record<string, string> {
  if (manager !== "pnpm") return baseEnv();
  const optionEnv = pnpmMajor !== null && pnpmMajor <= 10 ? Object.fromEntries(Object.entries(options).map(([key, value]) => [`npm_config_${key.replaceAll("-", "_")}`, String(value)])) : {};
  return { ...baseEnv(), COREPACK_ENABLE_STRICT: "0", ...NO_PROJECT_SPEC, ...pnpmSwitches(pnpmMajor, false), ...optionEnv };
}

/**
 * What every task operation gets: no downloads by corepack, and no install or version switch by the package manager when
 * a script runs (pnpm 11 installs before a run by default).
 */
function taskEnv(manager: string, pnpmMajor: number | null): Record<string, string> {
  const env: Record<string, string> = { ...baseEnv(), COREPACK_ENABLE_NETWORK: "0", npm_config_audit: "false", npm_config_fund: "false" };
  return manager === "pnpm" ? { ...env, COREPACK_ENABLE_STRICT: "0", ...NO_PROJECT_SPEC, ...pnpmSwitches(pnpmMajor, true) } : env;
}

/** A YAML value as a list of package names, or a map of names to whether their builds may run. */
const namesOf = (value: YamlValue | unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const allowMap = (value: YamlValue | unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * Which dependency builds this manager version runs, from the project's declared policy and that version's own rules.
 * Nivra records it and never widens it; where it can't know, it says so.
 * - npm runs every dependency's install scripts, unless ignore-scripts is on.
 * - pnpm 9 and older read build settings from package.json's pnpm field, and run every build unless a list narrows it.
 * - pnpm 10 reads them from package.json, and from pnpm-workspace.yaml from 10.5 (that file's wins, one setting at a
 *   time), each only from the version that brought it (BUILD_SETTINGS). It runs only builds the project allows, unless it
 *   names only builds to deny (then every other one runs). An install doesn't fail over an unreviewed build unless
 *   strictDepBuilds.
 * - pnpm 11 reads allowBuilds from pnpm-workspace.yaml only, and fails an install over an unreviewed build by default.
 */
function buildPolicy(manager: string, version: string, root: Record<string, unknown>, workspace: ReturnType<typeof simpleYaml> | null, options: InstallOptions, warnings: ResolutionWarning[]): BuildPolicy {
  const policy = (runs: BuildPolicy["runs"], allowed: string[], denied: string[], strict: boolean | null, source: string | null, notes: string[]): BuildPolicy => ({ tool: manager, runs, allowed: unique(allowed).slice(0, 500), denied: unique(denied).slice(0, 500), strict, source, notes: notes.slice(0, 10).map((note) => clip(note, 300)) });
  if (manager === "npm") return policy(options["ignore-scripts"] === true ? "none" : "all", [], [], null, null, options["ignore-scripts"] === true ? ["ignore-scripts is on, so no dependency's install scripts run: anything they would build will be missing."] : []);
  const major = majorOf(version);
  if (!KNOWN_PNPM_MAJORS.includes(major)) return policy("unknown", [], [], null, null, [`Nivra doesn't know pnpm ${version}'s build rules yet, so which dependency builds run is checked when preparing.`]);
  const yaml = workspace?.values ?? new Map<string, YamlValue>();
  const field = objectAt(root["pnpm"]);
  const unreadable = BUILD_KEYS.filter((key) => workspace?.unreadable.includes(key));
  if (unreadable.length) return policy("unknown", [], [], null, "pnpm-workspace.yaml", [`Nivra couldn't read ${unreadable.join(", ")} in pnpm-workspace.yaml, so which dependency builds run is checked when preparing.`]);

  if (major <= 9) {
    const inYaml = BUILD_KEYS.filter((key) => yaml.has(key));
    if (inYaml.length) return policy("unknown", [], [], null, "pnpm-workspace.yaml", [`pnpm ${version} reads build settings from package.json's pnpm field, so whether it uses ${inYaml.join(", ")} from pnpm-workspace.yaml is checked when preparing.`]);
    if ("onlyBuiltDependenciesFile" in field) return policy("unknown", [], [], null, "package.json", ["The allowed builds are listed in a file Nivra doesn't read, so which run is checked when preparing."]);
    const only = field["onlyBuiltDependencies"];
    const never = namesOf(field["neverBuiltDependencies"]);
    const source = "onlyBuiltDependencies" in field || "neverBuiltDependencies" in field ? "package.json" : null;
    if (Array.isArray(only)) return policy(namesOf(only).length ? "allowed" : "none", namesOf(only), never, null, source, []);
    return policy("all", [], never, null, source, []);
  }

  if (major === 10) {
    const notes: string[] = [];
    /** The settings one file gives, as this version reads them. allowBuilds adds to the same file's lists, as pnpm merges it. */
    const settingsIn = (where: "package.json" | "pnpm-workspace.yaml", values: ReadonlyMap<string, unknown>) => {
      const out = new Map<string, unknown>();
      for (const [key, value] of values) {
        const rule = BUILD_SETTINGS[key];
        if (!rule) continue;
        const since = where === "package.json" ? rule.field : rule.workspace;
        if (since !== null && atLeast(version, since)) {
          out.set(key, value);
          continue;
        }
        const message = since === null ? `pnpm reads ${key} from pnpm-workspace.yaml (from pnpm ${rule.workspace!.join(".")}), not package.json, so package.json's isn't counted.` : `pnpm ${version} doesn't read ${key} from ${where} (pnpm ${since.join(".")} and later do), so it isn't counted.`;
        notes.push(message);
        warnings.push({ code: "ignored-setting", message });
      }
      const builds = out.get("allowBuilds");
      if (builds !== undefined) {
        const map = allowMap(builds);
        out.set("onlyBuiltDependencies", [...namesOf(out.get("onlyBuiltDependencies")), ...Object.keys(map).filter((name) => map[name] === true)]);
        out.set("ignoredBuiltDependencies", [...namesOf(out.get("ignoredBuiltDependencies")), ...Object.keys(map).filter((name) => map[name] === false)]);
        out.delete("allowBuilds");
      }
      return out;
    };
    const fromField = settingsIn("package.json", new Map(Object.entries(field)));
    const fromWorkspace = settingsIn("pnpm-workspace.yaml", yaml);
    // pnpm-workspace.yaml's settings replace package.json's, one setting at a time.
    const read = (key: string): unknown => (fromWorkspace.has(key) ? fromWorkspace.get(key) : fromField.get(key));
    const declaredIn = fromWorkspace.size ? "pnpm-workspace.yaml" : fromField.size ? "package.json" : null;
    if (read("onlyBuiltDependenciesFile") !== undefined) return policy("unknown", [], [], null, declaredIn, [...notes, "The allowed builds are listed in a file Nivra doesn't read, so which run is checked when preparing."]);
    const strict = typeof read("strictDepBuilds") === "boolean" ? (read("strictDepBuilds") as boolean) : false;
    if (read("dangerouslyAllowAllBuilds") === true) return policy("all", [], [], strict, declaredIn, notes);
    const denied = [...namesOf(read("neverBuiltDependencies")), ...namesOf(read("ignoredBuiltDependencies"))];
    if (read("onlyBuiltDependencies") !== undefined) {
      let allowed = namesOf(read("onlyBuiltDependencies"));
      const versioned = atLeast(version, VERSIONED_BUILDS) ? [] : allowed.filter((entry) => /^(@[^/@]+\/)?[^@]+@/.test(entry));
      if (versioned.length) {
        notes.push(`pnpm ${version} reads onlyBuiltDependencies entries as package names (versions in them arrived in pnpm 10.19), so ${versioned.slice(0, 3).join(", ")} allow${versioned.length === 1 ? "s" : ""} no build.`);
        allowed = allowed.filter((entry) => !versioned.includes(entry));
      }
      return policy(allowed.length ? "allowed" : "none", allowed, denied, strict, declaredIn, notes);
    }
    // Naming only builds to deny lets every other one run.
    if (read("neverBuiltDependencies") !== undefined) return policy("all", [], denied, strict, declaredIn, notes);
    return policy("none", [], denied, strict, declaredIn, notes);
  }

  // pnpm 11.
  const notes: string[] = [];
  for (const key of ["onlyBuiltDependencies", "onlyBuiltDependenciesFile", "neverBuiltDependencies", "ignoredBuiltDependencies"]) {
    if (yaml.has(key) || key in field) {
      notes.push(`pnpm ${version} no longer reads ${key}; it uses allowBuilds.`);
      warnings.push({ code: "ignored-setting", message: `pnpm ${version} no longer reads ${key}, which this project sets; it uses allowBuilds instead.` });
    }
  }
  if (BUILD_KEYS.some((key) => key in field) && !notes.length) notes.push(`pnpm ${version} no longer reads package.json's pnpm field; it reads pnpm-workspace.yaml.`);
  const builds = allowMap(yaml.get("allowBuilds"));
  const allowed = Object.keys(builds).filter((name) => builds[name] === true);
  const denied = Object.keys(builds).filter((name) => builds[name] === false);
  const strict = typeof yaml.get("strictDepBuilds") === "boolean" ? (yaml.get("strictDepBuilds") as boolean) : true;
  const source = BUILD_KEYS.some((key) => yaml.has(key)) ? "pnpm-workspace.yaml" : null;
  return policy(yaml.get("dangerouslyAllowAllBuilds") === true ? "all" : allowed.length ? "allowed" : "none", allowed, denied, strict, source, notes);
}

function buildsSummary(policy: BuildPolicy): string {
  if (policy.runs === "unknown") return "Checked when preparing.";
  if (policy.tool === "npm") return policy.runs === "none" ? "No install scripts run (ignore-scripts)." : "npm runs dependencies' install scripts.";
  if (policy.runs === "all") return policy.denied.length ? `pnpm runs every dependency's build except ${policy.denied.slice(0, 5).join(", ")}${policy.denied.length > 5 ? ` and ${policy.denied.length - 5} more` : ""}.` : "pnpm runs every dependency's build.";
  if (policy.runs === "none") return `pnpm runs no dependency's build${policy.strict ? ", and stops the install if one needs review" : ""}.`;
  return `pnpm runs the builds of ${policy.allowed.slice(0, 5).join(", ")}${policy.allowed.length > 5 ? ` and ${policy.allowed.length - 5} more` : ""}.`;
}

/**
 * The workspace packages a pnpm filter installs, as a superset: those its selectors name, with their dependents when a
 * selector asks for them, and every workspace dependency of each, since installing a package installs those too. A
 * selector Nivra can't read counts every package, so every Node requirement is still checked.
 */
function scopedMembers(selectors: readonly string[], members: readonly Manifest[], warnings: ResolutionWarning[]): Manifest[] {
  const root = members.find((member) => member.folder === "")!;
  const byName = new Map(members.flatMap((member) => (typeof member.json["name"] === "string" ? [[member.json["name"] as string, member] as const] : [])));
  const dependsOn = (member: Manifest) => dependencySpecs(member.json).flatMap((dependency) => (byName.has(dependency.name) ? [byName.get(dependency.name)!] : []));
  const closure = (start: Iterable<Manifest>, next: (member: Manifest) => Manifest[]) => {
    const seen = new Set<Manifest>();
    const queue = [...start];
    while (queue.length) {
      const member = queue.pop()!;
      if (seen.has(member)) continue;
      seen.add(member);
      queue.push(...next(member));
    }
    return seen;
  };
  const dependents = (member: Manifest) => members.filter((other) => dependsOn(other).includes(member));
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  /** The packages one selector names: a folder (./x, or in braces) and what's beneath it, or package names, with * as a wildcard. */
  const named = (pattern: string): Manifest[] | null => {
    const folder = /^\{(.+)\}$/.exec(pattern)?.[1] ?? (/^\.\.?\//.test(pattern) ? pattern : null);
    if (folder !== null) {
      const path = folder.replace(/^\.\//, "").replace(/\/+$/, "");
      return members.filter((member) => path === "." || path === "" || member.folder === path || member.folder.startsWith(`${path}/`));
    }
    if (/[[\]{}]/.test(pattern) || pattern === "") return null;
    return members.filter((member) => typeof member.json["name"] === "string" && glob(pattern).test(member.json["name"] as string));
  };
  /** A selector's parts: its pattern, and whether it adds dependents or dependencies. */
  const parse = (selector: string) => {
    let pattern = selector;
    const withDependents = pattern.startsWith("...");
    pattern = pattern.replace(/^\.\.\.\^?/, "");
    pattern = pattern.replace(/\^?\.\.\.$/, "");
    return { pattern, withDependents };
  };
  const everything = (selector: string) => {
    warnings.push({ code: "selector", message: `Nivra can't tell which packages ${quoted(selector)} selects, so every workspace package's Node requirement is checked.` });
    return [...members];
  };

  const positive = selectors.filter((selector) => !selector.startsWith("!"));
  let chosen = new Set<Manifest>(positive.length ? [root] : members);
  for (const selector of positive) {
    const { pattern, withDependents } = parse(selector);
    const matches = named(pattern);
    if (matches === null) return everything(selector);
    for (const match of withDependents ? closure(matches, dependents) : matches) chosen.add(match);
  }
  chosen = closure(chosen, dependsOn);
  for (const selector of selectors.filter((item) => item.startsWith("!"))) {
    const matches = named(parse(selector.slice(1)).pattern);
    if (matches === null) return everything(selector);
    for (const match of matches) if (match !== root) chosen.delete(match);
  }
  chosen.add(root);
  return [...chosen];
}
