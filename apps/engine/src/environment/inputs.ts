import { createHash } from "node:crypto";
import { ENVIRONMENT_BASE, ENVIRONMENT_LIMITS, type EnvironmentSpec } from "@nivra/domain";
import { compressSnapshot } from "../exec/nebius/session.ts";
import type { Snapshot, SnapshotFile } from "../exec/snapshot.ts";
import { writeTar } from "../exec/tar.ts";

/**
 * A project's environment inputs (NIV-49, D41), read from Nivra's own snapshot of the commit, so that preparation
 * never sends a file a snapshot leaves out (a secrets file such as .npmrc, or output). They are the manifests, the
 * lockfile and the workspace file, and nothing else.
 *
 * A layout that needs the repository's sources to install is refused, naming the file:
 * - an install lifecycle script in any manifest;
 * - a pnpmfile;
 * - patched dependencies.
 * So is a project that doesn't pin pnpm exactly, or has no lockfile. Nothing here runs anything.
 */

export class EnvironmentRefusal extends Error {
  readonly code: "layout";
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentRefusal";
    this.code = "layout";
  }
}

export interface EnvironmentInputs {
  files: SnapshotFile[];
  /** SHA-256 of each input's path and hash, sorted: what a task run checks its commit against. */
  digest: string;
  /** Inputs the snapshot left out, never sent: a secrets file such as .npmrc. */
  leftOut: string[];
  /** The commit's own pin, `pnpm@x.y.z`, any integrity suffix dropped. */
  packageManager: string;
  nodeRequirement: string | null;
  /** Whether Nivra's Node is one the requirement allows: null when Nivra can't read the requirement. */
  nodeAllowed: boolean | null;
  packages: Array<{ name: string; path: string }>;
}

/** Scripts a package manager runs during an install: each needs the repository's sources, which preparation never has. */
const LIFECYCLE = ["pnpm:devPreinstall", "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish"];
const PNPMFILES = [".pnpmfile.cjs", ".pnpmfile.mjs"];
const ROOT_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
/** Files of the kind that would be inputs, as the snapshot names them when it leaves one out. */
const MAYBE_INPUT = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/;

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const quoted = (path: string) => (path.length > 200 ? `${path.slice(0, 199)}…` : path);

/** The digest of a set of inputs: their paths and hashes, sorted by the path's bytes. */
export function inputsDigest(files: ReadonlyArray<Pick<SnapshotFile, "path" | "sha256">>): string {
  const lines = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map((file) => `${file.sha256}  ${file.path}\n`);
  return sha256(`nivra.environment-inputs.v1\n${lines.join("")}`);
}

/** The commit's environment inputs, or a refusal naming what keeps it from being prepared from manifests alone. */
export function environmentInputs(snapshot: Pick<Snapshot, "files" | "leftOutPaths">): EnvironmentInputs {
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  for (const name of PNPMFILES) {
    if (byPath.has(name)) throw new EnvironmentRefusal(`This commit has ${name}, which runs code from the repository during an install. Nivra prepares an environment from manifests alone, so it can't prepare this one.`);
  }
  const root = byPath.get("package.json");
  if (!root || root.kind !== "file") throw new EnvironmentRefusal("This folder's commit has no package.json at its top, so there is no Node project to prepare. Add the project's own folder, then try again.");
  const lockfile = byPath.get("pnpm-lock.yaml");
  if (!lockfile || lockfile.kind !== "file") throw new EnvironmentRefusal("This commit has no pnpm-lock.yaml. An environment installs only from a frozen lockfile: run pnpm install, commit the lockfile, then try again.");
  const files = snapshot.files.filter((file) => file.kind === "file" && (ROOT_INPUTS.includes(file.path) || file.path.endsWith("/package.json")));
  if (files.length > ENVIRONMENT_LIMITS.inputs) throw new EnvironmentRefusal(`This commit has ${files.length} manifests, more than the ${ENVIRONMENT_LIMITS.inputs} an environment is prepared from.`);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > ENVIRONMENT_LIMITS.inputBytes) throw new EnvironmentRefusal(`This commit's manifests and lockfile come to ${bytes} bytes, more than the ${ENVIRONMENT_LIMITS.inputBytes} an environment is prepared from.`);

  const manifests = files.filter((file) => file.path === "package.json" || file.path.endsWith("/package.json")).map((file) => ({ file, manifest: parsed(file) }));
  for (const { file, manifest } of manifests) {
    const scripts = manifest["scripts"] && typeof manifest["scripts"] === "object" ? Object.keys(manifest["scripts"] as object) : [];
    const hooks = LIFECYCLE.filter((name) => scripts.includes(name));
    if (hooks.length) throw new EnvironmentRefusal(`${quoted(file.path)} runs ${hooks.join(", ")} during an install, which needs the repository's sources. Nivra prepares an environment from manifests alone, so it can't prepare this one.`);
  }
  const top = manifests.find((entry) => entry.file.path === "package.json")!.manifest;
  const pnpmField = top["pnpm"] && typeof top["pnpm"] === "object" ? (top["pnpm"] as Record<string, unknown>) : {};
  const workspaceText = byPath.get("pnpm-workspace.yaml")?.kind === "file" ? Buffer.from(byPath.get("pnpm-workspace.yaml")!.bytes).toString("utf8") : "";
  if ("patchedDependencies" in pnpmField || /^\s*patchedDependencies\s*:/m.test(workspaceText)) {
    throw new EnvironmentRefusal("This project patches its dependencies, and the patches are part of its sources. Nivra prepares an environment from manifests alone, so it can't prepare this one.");
  }
  const pinned = typeof top["packageManager"] === "string" ? /^pnpm@(\d+\.\d+\.\d+)(\+[A-Za-z0-9.]+)?$/.exec(top["packageManager"]) : null;
  if (!pinned) throw new EnvironmentRefusal("This project's package.json doesn't pin pnpm to an exact version in packageManager (such as pnpm@11.5.3). Add it, commit, then try again.");
  const engines = top["engines"] && typeof top["engines"] === "object" ? (top["engines"] as Record<string, unknown>) : {};
  const nodeRequirement = typeof engines["node"] === "string" ? engines["node"].slice(0, 200) : null;
  const nodeAllowed = nodeRequirement === null ? true : satisfies(ENVIRONMENT_BASE.node.slice(1), nodeRequirement);
  if (nodeAllowed === false) throw new EnvironmentRefusal(`This project needs Node ${quoted(nodeRequirement!)}, and Nivra's environment has Node ${ENVIRONMENT_BASE.node}.`);

  const packages = manifests
    .filter((entry) => entry.file.path !== "package.json" && typeof entry.manifest["name"] === "string")
    .map((entry) => ({ name: String(entry.manifest["name"]).slice(0, 214), path: entry.file.path.slice(0, -"/package.json".length) }))
    .slice(0, 500);
  const leftOut = snapshot.leftOutPaths.filter((path) => MAYBE_INPUT.test(path)).slice(0, 20);
  return { files, digest: inputsDigest(files), leftOut, packageManager: `pnpm@${pinned[1]}`, nodeRequirement, nodeAllowed, packages };
}

/** A manifest's JSON object, or a refusal naming the file. */
function parsed(file: SnapshotFile): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(file.bytes).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Said below, naming the file.
  }
  throw new EnvironmentRefusal(`${quoted(file.path)} isn't a JSON object, so Nivra can't read what it installs. Fix it, commit, then try again.`);
}

/** The inputs as one tar, compressed as the session compresses a snapshot: the same files always give the same bytes. */
export function inputsArchive(files: readonly SnapshotFile[]): Uint8Array {
  return compressSnapshot(writeTar(files.map((file) => ({ path: file.path, kind: "file" as const, executable: false, bytes: file.bytes }))));
}

/** `pnpm install`'s arguments for a spec: the frozen lockfile first, then each filter. */
export const installArgsFor = (spec: EnvironmentSpec): string[] => ["--frozen-lockfile", ...spec.filters.flatMap((filter) => ["--filter", filter])];

/** A preparation preview's fingerprint: everything the run would be bound to, in a fixed, versioned order. */
export function environmentFingerprint(parts: { baseline: string; prefix: string; inputsDigest: string; spec: EnvironmentSpec; installArgs: readonly string[] }): string {
  return sha256(JSON.stringify(["nivra.environment-preview.v1", parts.baseline, parts.prefix, parts.inputsDigest, parts.spec.filters, ENVIRONMENT_BASE.tag, ENVIRONMENT_BASE.registryUrl, ENVIRONMENT_BASE.node, parts.installArgs]));
}

/**
 * The setup configuration (NIV-55): the committed files that decide an environment, chosen by the ecosystem's own rule,
 * and their digest. It is what a task holds frozen and digests again after collect; sources are never part of it.
 */
export function setupConfiguration(snapshot: Pick<Snapshot, "files">, isSetupPath: (path: string) => boolean): { files: SnapshotFile[]; digest: string } {
  const files = snapshot.files.filter((file) => isSetupPath(file.path));
  return { files, digest: configurationDigest(files) };
}

/** A setup configuration's digest: its paths and hashes, sorted by the path's bytes. */
export function configurationDigest(files: ReadonlyArray<Pick<SnapshotFile, "path" | "sha256">>): string {
  const lines = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map((file) => `${file.sha256}  ${file.path}\n`);
  return sha256(`nivra.environment-configuration.v1\n${lines.join("")}`);
}

/**
 * Whether `version` (x.y.z) meets a semver range as package.json's engines write it: comparators joined by spaces,
 * alternatives by `||`, with `^`, `~`, `x`, `*` and hyphen ranges (`1.2.3 - 2.3`). An operator written apart from its
 * version (`>= 22`) is read as one. Null when Nivra can't read the range, such as a prerelease tag: it is then shown as
 * written, and never counted as met.
 */
export function satisfies(version: string, range: string): boolean | null {
  const have = version.split(".").map(Number);
  const alternatives = range.split("||").map((part) => part.trim());
  let unknown = false;
  for (const alternative of alternatives) {
    const comparators = comparatorsOf(alternative);
    // One comparator Nivra can't read makes the whole alternative unknown, wherever it is.
    const met = comparators.map((comparator) => comparatorMet(have, comparator));
    if (met.includes(null)) unknown = true;
    else if (met.every(Boolean)) return true;
  }
  return unknown ? null : false;
}

/** An alternative's comparators: a hyphen range becomes its two bounds, and an operator is joined to its version. */
function comparatorsOf(alternative: string): string[] {
  if (alternative === "" || alternative === "*") return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alternative);
  if (hyphen) return [`>=${hyphen[1]}`, `<=${hyphen[2]}`];
  return alternative.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/);
}

function comparatorMet(have: number[], comparator: string): boolean | null {
  const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(comparator);
  if (!match) return null;
  const operator = match[1] ?? "=";
  const parts = [match[2], match[3], match[4]].map((part) => (part === undefined || part === "x" || part === "*" ? null : Number(part)));
  const given = parts.findIndex((part) => part === null);
  const precision = given === -1 ? 3 : given;
  const want = parts.map((part) => part ?? 0);
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return 0;
  };
  const upper = (index: number) => want.map((part, i) => (i < index ? part : i === index ? part + 1 : 0));
  if (precision === 0) return operator === "<" ? false : operator === ">" ? false : true;
  switch (operator) {
    case ">=":
      return compare(have, want) >= 0;
    case ">":
      return precision === 3 ? compare(have, want) > 0 : compare(have, upper(precision - 1)) >= 0;
    case "<=":
      return precision === 3 ? compare(have, want) <= 0 : compare(have, upper(precision - 1)) < 0;
    case "<":
      return compare(have, want) < 0;
    case "^": {
      const index = want[0] !== 0 || precision === 1 ? 0 : want[1] !== 0 || precision === 2 ? 1 : 2;
      return compare(have, want) >= 0 && compare(have, upper(index)) < 0;
    }
    case "~":
      return compare(have, want) >= 0 && compare(have, upper(precision === 1 ? 0 : 1)) < 0;
    default:
      return compare(have, want) >= 0 && compare(have, upper(precision - 1)) < 0;
  }
}
