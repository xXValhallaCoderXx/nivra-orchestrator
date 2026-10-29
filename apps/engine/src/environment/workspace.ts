import { ENVIRONMENT_LIMITS, WORKSPACE_FOLDER, WORKSPACE_NAME, type InstallOptions, type InstallScope, type InstallSelection, type WorkspaceFacts } from "@nivra/domain";
import { dependencySpecs, linkedFolder, stringAt, type LockfileFacts, type Manifest, type NpmEdgeKind, type NpmLockEntry, type YamlValue } from "./node-files.ts";
import { compareVersions, versionParts } from "./versions.ts";

/**
 * Workspace packages chosen by folder (NIV-55, D52): what a workspace offers to choose, which package manager releases
 * install a choice exactly as the preview says, and every workspace package an install of the choice reaches, worked
 * out from the links the lockfile records with each manager's own rules. A name that merely matches is never a link.
 *
 * - pnpm installs the projects selected and the workspace root, which it always adds; a linked project's own
 *   dependencies come only when it is selected too, so every project reached is passed, each by its exact name.
 * - npm installs the workspaces selected and everything they reach; the root's own dependencies only with
 *   include-workspace-root, which doesn't follow the root's links to workspaces, so those are passed too, each as
 *   ./FOLDER, which matches no name.
 */

/** A release range whose filtered installs were checked against each release's own notes (29 Oct 2026, D52). */
interface CheckedRange {
  from: string;
  to: string;
  /** isolated: before 11.28.0, a hoisted node linker made pnpm install every project when asked for some. */
  linker: "isolated" | "any";
}

const CHECKED: Readonly<Record<"npm" | "pnpm", readonly CheckedRange[]>> = {
  pnpm: [
    { from: "9.5.0", to: "9.15.9", linker: "isolated" },
    { from: "10.0.0", to: "10.34.9", linker: "isolated" },
    { from: "11.28.6", to: "11.28.9", linker: "any" },
  ],
  npm: [
    { from: "9.7.2", to: "9.9.4", linker: "any" },
    { from: "10.8.1", to: "10.9.9", linker: "any" },
    { from: "11.0.0", to: "11.13.0", linker: "any" },
    { from: "11.15.0", to: "11.21.1", linker: "any" },
  ],
};

const CHECKED_PNPM = "Nivra has checked pnpm 9.5.0 to 9.15.9 and 10.0.0 to 10.34.9 with the isolated node linker, and 11.28.6 to 11.28.9: pin one of those in package.json's packageManager, or install the whole project.";
const CHECKED_NPM = "Nivra has checked npm 9.7.2 to 9.9.4, 10.8.1 to 10.9.9, 11.0.0 to 11.13.0 and 11.15.0 to 11.21.1: pin one of those in package.json's packageManager, or install the whole project.";

const within = (version: string, from: string, to: string) => compareVersions(version, from) >= 0 && compareVersions(version, to) <= 0;

/**
 * Why this package manager release can't install chosen workspace packages exactly as a preview says, or null when it
 * can. Only releases checked against their own notes are listed; anything else, a future release included, is
 * unverified. A pinned release alone never settles it: pnpm 11.28.0 to 11.28.5 can also write a lockfile that lacks a
 * dependency, which a later release's frozen install reproduces.
 */
export function filteredInstallProblem(manager: "npm" | "pnpm", version: string, hoisted = false): string | null {
  if (versionParts(version) === null) return `Nivra can't tell which ${manager} release ${JSON.stringify(version.slice(0, 40))} is, so it can't tell whether it installs chosen workspace packages. ${manager === "pnpm" ? CHECKED_PNPM : CHECKED_NPM}`;
  const range = CHECKED[manager].find((item) => within(version, item.from, item.to)) ?? null;
  if (manager === "pnpm") {
    if (compareVersions(version, "9.5.0") < 0) return `pnpm ${version} installs every workspace package when it's asked for some (pnpm 9.5.0 and later install only those). ${CHECKED_PNPM}`;
    if (within(version, "11.28.0", "11.28.5")) return `pnpm ${version} can leave out a dependency that a package also declares as an optional peer, in the installs it makes and the lockfiles it writes (fixed in pnpm 11.28.6). ${CHECKED_PNPM}`;
    if (range?.linker === "isolated" && hoisted) return `pnpm ${version} installs every workspace package with the hoisted node linker when it's asked for some. Use the isolated linker, pin pnpm 11.28.6 or later, or install the whole project.`;
  } else if (within(version, "11.14.0", "11.14.1")) {
    return `npm ${version}'s ci looks workspace dependencies up in the registry again and refuses valid lockfiles (npm/cli 9357, fixed in npm 11.15.0). ${CHECKED_NPM}`;
  }
  return range === null ? `Nivra hasn't checked how ${manager} ${version} installs chosen workspace packages. ${manager === "pnpm" ? CHECKED_PNPM : CHECKED_NPM}` : null;
}

/** Whether a pnpm release wrote lockfiles that can leave out a dependency also declared as an optional peer (11.28.0 to 11.28.5). */
export const regressedLockfileWriter = (version: string | null): boolean => version !== null && versionParts(version) !== null && within(version, "11.28.0", "11.28.5");

const quoted = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text);
const named = (folder: string) => (folder === "" ? "the workspace root" : quoted(folder));

export interface WorkspaceShape {
  /** The members by folder, the root among them as "". */
  byFolder: ReadonlyMap<string, Manifest>;
  /** Why a member can't be chosen or installed on its own, or null when it can. */
  unavailable(folder: string): string | null;
  /** Why chosen packages, and pnpm selectors, aren't offered whatever the release, or null. */
  packagesBlocked: string | null;
  selectorsBlocked: string | null;
  /** Whether chosen packages aren't offered only because there are none to choose: refused with what to choose instead. */
  single: boolean;
  /** The facts for the window, with the reason a release can't do it once that is known. */
  facts(release: string | null): WorkspaceFacts;
}

export interface ShapeInput {
  manager: "npm" | "pnpm";
  /** The workspace patterns the manager reads, or null when the project isn't a workspace. */
  globs: readonly string[] | null;
  /** The root ("") and the member packages. */
  members: readonly Manifest[];
  lock: LockfileFacts;
  lockPath: string;
  /** pnpm-workspace.yaml's top-level settings, when the file is there. */
  yaml: ReadonlyMap<string, YamlValue> | null;
  options: InstallOptions;
}

/** A workspace's packages and the ways it can be told what to install, before the releases are settled. */
export function workspaceShape(input: ShapeInput): WorkspaceShape {
  const { manager, members, lock, lockPath, yaml } = input;
  const byFolder = new Map(members.map((member) => [member.folder, member]));
  const listed = members.filter((member) => member.folder !== "").sort((a, b) => (a.folder < b.folder ? -1 : 1));
  const nameOf = (member: Manifest) => stringAt(member.json["name"]) || null;
  const nameCount = new Map<string, number>();
  for (const member of members) {
    const name = nameOf(member);
    if (name !== null) nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }
  const recorded = new Set(lock.workspaces);
  const unavailable = (folder: string): string | null => {
    const member = byFolder.get(folder);
    if (!member || folder === "") return "It isn't one of the workspace's packages.";
    if (!WORKSPACE_FOLDER.test(folder)) return "Its folder's name has characters, or a length, that Nivra doesn't pass to a package manager. Rename the folder, or install the whole project.";
    if (!recorded.has(folder)) return `${lockPath} doesn't list it among the workspace's projects. Run ${manager} install in the repository, commit ${lockPath}, then preview again.`;
    if (manager === "pnpm") {
      const name = nameOf(member);
      if (name === null) return "It has no name in its package.json, and pnpm installs a package on its own by name. Give it one, or install the whole project.";
      if (name.length > 200) return "Its name is longer than the 200 characters Nivra passes to pnpm as one argument. Install the whole project.";
      if (!WORKSPACE_NAME.test(name)) return "pnpm would read its name as a pattern, so Nivra can't install it on its own. Install the whole project.";
      if ((nameCount.get(name) ?? 0) > 1) return "Another package in the workspace has the same name, so pnpm can't install it on its own. Rename one, or install the whole project.";
    } else {
      // npm reads ./FOLDER as that folder and every workspace directly inside it.
      const inside = listed.find((other) => other.folder.startsWith(`${folder}/`) && !other.folder.slice(folder.length + 1).includes("/"));
      if (inside) return `npm would also install ${quoted(inside.folder)}, a workspace package directly inside its folder. Install the whole project.`;
    }
    return null;
  };

  const setting = (key: string) => yaml?.get(key);
  // What changes which projects pnpm's filters select: refused for chosen packages and selectors alike.
  const pnpmFiltering =
    setting("sharedWorkspaceLockfile") === false
      ? "This workspace keeps a lockfile for each package (sharedWorkspaceLockfile is off in pnpm-workspace.yaml), which Nivra doesn't install chosen packages from. Install the whole project."
      : setting("filter") !== undefined || setting("filterProd") !== undefined
        ? "pnpm-workspace.yaml sets filter, which pnpm would combine with the packages chosen in a way Nivra hasn't checked. Install the whole project."
        : null;
  // What hides the links Nivra follows to work out what chosen packages reach: selectors don't follow them.
  const pnpmLinks =
    setting("excludeLinksFromLockfile") === true || lock.excludesLinks
      ? "This workspace leaves links out of pnpm-lock.yaml (excludeLinksFromLockfile), so Nivra can't tell what a package needs. Install the whole project."
      : setting("linkWorkspacePackages") === "deep" || lock.deepLinks
        ? "This workspace links workspace packages from inside other dependencies (linkWorkspacePackages deep), which Nivra doesn't follow. Install the whole project."
        : null;
  const single = input.globs === null ? "This project is one package, so installing it is installing the whole project." : listed.length === 0 ? "The workspace lists no package folders that hold a package.json, so there are no packages to choose." : null;
  const options = input.options;
  const filtering = (["omit", "include"] as const).find((key) => Array.isArray(options[key]) && (options[key] as readonly string[]).length > 0);
  const strategy = typeof options["install-strategy"] === "string" && options["install-strategy"] !== "hoisted" ? options["install-strategy"] : null;
  const npmBlocked = filtering
    ? `npm's ${filtering} option doesn't combine reliably with chosen workspace packages (npm/cli 6670). Remove it, or install the whole project.`
    : strategy
      ? `Nivra hasn't checked how npm installs chosen workspace packages with install-strategy ${strategy}. Remove the option, or install the whole project.`
      : null;
  const packagesBlocked = single ?? (manager === "pnpm" ? (pnpmFiltering ?? pnpmLinks) : npmBlocked);
  const selectorsBlocked =
    manager === "npm"
      ? "pnpm selectors are pnpm's own syntax, and this project installs with npm."
      : input.globs === null
        ? "This project isn't a pnpm workspace, so there are no packages to choose."
        : (single ?? pnpmFiltering);

  const root = byFolder.get("")!;
  const rootDependencies = [...new Set(dependencySpecs(root.json).map((dependency) => dependency.name))].sort();
  return {
    byFolder,
    unavailable,
    packagesBlocked,
    selectorsBlocked,
    single: single !== null,
    facts: (release) => ({
      packages: listed.slice(0, 500).map((member) => ({ folder: member.folder, name: nameOf(member)?.slice(0, 214) ?? null, unavailable: unavailable(member.folder)?.slice(0, 300) ?? null })),
      more: Math.max(0, listed.length - 500),
      root: {
        dependencies: rootDependencies.length,
        examples: rootDependencies.slice(0, 5).map((name) => name.slice(0, 214)),
        optional: manager === "npm",
        reason: manager === "pnpm" ? "pnpm installs the workspace root's own dependencies whenever it installs chosen packages." : null,
      },
      modes: [
        { mode: "whole", available: true, reason: null },
        { mode: "packages", available: (packagesBlocked ?? release) === null, reason: (packagesBlocked ?? release)?.slice(0, 600) ?? null },
        { mode: "selectors", available: (selectorsBlocked ?? (manager === "pnpm" ? release : null)) === null, reason: (selectorsBlocked ?? (manager === "pnpm" ? release : null))?.slice(0, 600) ?? null },
      ],
    }),
  };
}

/** What installing chosen packages installs: every workspace package, chosen or reached, in folder order, and the root. */
export interface ChosenInstall {
  selection: InstallSelection;
  /** pnpm's --filter values (names) or npm's --workspace values (./FOLDER), in the selection's order. */
  targets: string[];
  /**
   * npm: registry packages the install takes in only through an installed package's optional peer, because another
   * workspace package depends on them (npm/cli 9847). Empty for pnpm.
   */
  strays: string[];
}

/**
 * Every workspace package an install of the chosen ones reaches, from the links the lockfile records, or why it can't
 * be worked out. The release's own gate is checked apart, once the versions are settled.
 */
export function chosenInstall(scope: Extract<InstallScope, { kind: "packages" }>, shape: WorkspaceShape, input: Pick<ShapeInput, "manager" | "lock" | "lockPath" | "options">): ChosenInstall | { problem: string } {
  const { manager, lock, lockPath } = input;
  if (shape.packagesBlocked) return { problem: shape.single ? `${shape.packagesBlocked} Choose the whole project, then preview again.` : shape.packagesBlocked };
  for (const folder of scope.packages) {
    if (!shape.byFolder.has(folder) || folder === "") return { problem: `${quoted(folder)} isn't one of this workspace's packages at this commit: it may have been moved or removed. Untick it, or install the whole project, then preview again.` };
    const why = shape.unavailable(folder);
    if (why) return { problem: `${quoted(folder)} can't be chosen. ${why}` };
  }
  if (manager === "pnpm" && !scope.root) return { problem: "pnpm installs the workspace root's own dependencies whenever it installs chosen packages, so they can't be left out. Turn them on, then preview again." };
  const reach = manager === "pnpm" ? pnpmReach(lock, scope.packages, lockPath) : npmReach(lock.tree ?? new Map(), scope.root ? ["", ...scope.packages] : scope.packages, lockPath, input.options["legacy-peer-deps"] === true);
  if ("problem" in reach) return reach;
  const installed = [...new Set([...scope.packages, ...reach.reached])].sort();
  for (const folder of installed) {
    if (!shape.byFolder.has(folder)) return { problem: `${lockPath} links the chosen packages to ${quoted(folder)}, which isn't one of the workspace's packages Nivra reads. Install the whole project.` };
    const why = shape.unavailable(folder);
    if (why) return { problem: `The install would also need ${quoted(folder)}, linked from the chosen packages or the workspace root, which can't be installed on its own. ${why}` };
  }
  if (installed.length > ENVIRONMENT_LIMITS.packages) return { problem: `Those choices install ${installed.length} workspace packages, counting the ones they need, more than the ${ENVIRONMENT_LIMITS.packages} a chosen install takes. Choose fewer, or install the whole project.` };
  const chosen = new Set(scope.packages);
  const packages = installed.map((folder) => ({ folder, name: stringAt(shape.byFolder.get(folder)!.json["name"])?.slice(0, 214) || null, chosen: chosen.has(folder) }));
  return {
    selection: { packages, root: manager === "pnpm" ? true : scope.root },
    targets: packages.map((item) => (manager === "pnpm" ? item.name! : `./${item.folder}`)),
    strays: reach.strays,
  };
}

/** pnpm: the importers the chosen ones and the root (always installed) link to, through every link recorded in importers. */
function pnpmReach(lock: LockfileFacts, chosen: readonly string[], lockPath: string): { reached: string[]; strays: string[] } | { problem: string } {
  const projects = new Set(lock.workspaces);
  const seen = new Set<string>();
  const queue = ["", ...chosen];
  while (queue.length) {
    const folder = queue.pop()!;
    if (seen.has(folder)) continue;
    seen.add(folder);
    for (const target of lock.links.get(folder) ?? []) {
      if (target !== "" && !projects.has(target)) return { problem: `${lockPath} links ${named(folder)} to ${quoted(target)}, which isn't one of the workspace's projects, so Nivra can't tell what installing it needs. Install the whole project.` };
      queue.push(target);
    }
  }
  return { reached: [...seen].filter((folder) => folder !== ""), strays: [] };
}

/**
 * npm: every lockfile entry an install of the starts takes in, through each dependency as npm records it. A name
 * resolves to the first node_modules entry found from the dependent's own folder upwards (Node's lookup, which arborist
 * records); a link leads to its workspace folder, and a registry package is followed through its own dependencies.
 * With legacy-peer-deps npm leaves peers out, so no peer is followed. Only a missing dependency refuses: a missing
 * optional one, or peer, is one npm went without.
 */
function npmWalk(tree: ReadonlyMap<string, NpmLockEntry>, starts: readonly string[], lockPath: string, follows: (kind: NpmEdgeKind) => boolean): { visited: Set<string> } | { problem: string } {
  const visited = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const entry = tree.get(key);
    if (!entry) continue;
    if (entry.link) {
      const target = entry.resolved === null ? null : linkedFolder("", entry.resolved);
      if (target === null) return { problem: `${lockPath} links ${quoted(key)} to a folder outside the repository. Install the whole project.` };
      if (!tree.has(target)) return { problem: `${lockPath} links ${quoted(key)} to ${quoted(target)}, which it doesn't record. Run npm install in the repository, commit ${lockPath}, then preview again.` };
      stack.push(target);
      continue;
    }
    for (const dependency of entry.requires) {
      if (!follows(dependency.kind)) continue;
      const found = lookup(tree, key, dependency.name);
      if (found !== null) stack.push(found);
      else if (dependency.kind === "dependency") return { problem: `${lockPath} doesn't record where ${quoted(dependency.name)}, which ${named(key)} needs, comes from. Run npm install in the repository, commit ${lockPath}, then preview again.` };
    }
  }
  return { visited };
}

/** Which edges npm's install of chosen workspaces follows: all of them, optional peers included (npm/cli 9847), and no peers with legacy-peer-deps. */
const npmFollows = (legacyPeers: boolean) => (kind: NpmEdgeKind) => !(legacyPeers && (kind === "peer" || kind === "peer-optional"));

/**
 * npm: the workspace folders an install of the starts reaches, and the registry packages it takes in only through an
 * installed package's optional peer, whose entry the lockfile has because another workspace package depends on it:
 * npm/cli 9847 installs those too, so they are said, by name. A workspace reached that way is installed and listed.
 */
function npmReach(tree: ReadonlyMap<string, NpmLockEntry>, starts: readonly string[], lockPath: string, legacyPeers: boolean): { reached: string[]; strays: string[] } | { problem: string } {
  const all = npmWalk(tree, starts, lockPath, npmFollows(legacyPeers));
  if ("problem" in all) return all;
  const firm = npmWalk(tree, starts, lockPath, (kind) => kind !== "peer-optional" && npmFollows(legacyPeers)(kind));
  if ("problem" in firm) return firm;
  const reached = [...all.visited].filter((key) => key !== "" && !key.includes("node_modules/"));
  const strays = [...all.visited].filter((key) => key.includes("node_modules/") && !tree.get(key)?.link && !firm.visited.has(key)).map((key) => key.replace(/^.*node_modules\//, ""));
  return { reached, strays: [...new Set(strays)].sort() };
}

/**
 * npm: the packages with install scripts that a chosen install takes in, by name: what ignore-scripts leaves unbuilt,
 * where a whole project's install would count every one in the lockfile.
 */
export function npmInstallScripts(lock: LockfileFacts, selection: InstallSelection, legacyPeers: boolean): string[] {
  const tree = lock.tree ?? new Map<string, NpmLockEntry>();
  const starts = [...(selection.root ? [""] : []), ...selection.packages.map((item) => item.folder)];
  const walked = npmWalk(tree, starts, "package-lock.json", npmFollows(legacyPeers));
  if ("problem" in walked) return lock.installScripts;
  return [...new Set([...walked.visited].filter((key) => tree.get(key)?.installScript === true).map((key) => key.replace(/^.*node_modules\//, "")))].sort();
}

/** The lockfile entry a dependency name resolves to from a location, as Node looks it up: its own node_modules, then each parent's. */
function lookup(tree: ReadonlyMap<string, NpmLockEntry>, from: string, name: string): string | null {
  let folder = from;
  for (;;) {
    const key = folder === "" ? `node_modules/${name}` : `${folder}/node_modules/${name}`;
    if (tree.has(key)) return key;
    if (folder === "") return null;
    const slash = folder.lastIndexOf("/");
    folder = slash === -1 ? "" : folder.slice(0, slash);
  }
}

