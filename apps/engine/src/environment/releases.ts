import { ADVISORIES } from "./advisories.ts";
import { RELEASE_DATA } from "./release-data.ts";
import { compareVersions, versionParts } from "./versions.ts";

/**
 * Nivra's release index (NIV-55): the Node, npm and pnpm releases known when this Nivra was built, generated from
 * nodejs.org and the npm registry by scripts/environment-releases.ts and read with no network. Ranges resolve only to
 * versions it holds; an exact pin newer than it is checked when preparing. Refreshing it never invalidates a prepared
 * environment, because a recipe keeps the exact versions it settled on.
 */

/** The generated data, as compact rows: each newest first. */
export interface ReleaseData {
  fetchedAt: string;
  sources: ReadonlyArray<{ url: string; sha256: string }>;
  /** Version, the npm it bundles, and its LTS line's name (null for a release that isn't LTS). */
  node: ReadonlyArray<readonly [string, string | null, string | null]>;
  /** Version, its own engines.node (null when it says nothing), and whether it is deprecated. */
  npm: ReadonlyArray<readonly [string, string | null, boolean]>;
  pnpm: ReadonlyArray<readonly [string, string | null, boolean]>;
}

/** A version Nivra withdraws for a named compatibility or security reason, with what to use instead. */
export interface Advisory {
  tool: string;
  version: string;
  reason: string;
  replacement: string;
}

export interface NodeRelease {
  version: string;
  npm: string | null;
  lts: string | null;
}

export interface ToolRelease {
  version: string;
  /** Its own engines.node, as published; null when it says nothing. */
  node: string | null;
  deprecated: boolean;
}

export interface ReleaseIndex {
  fetchedAt: string;
  node: readonly NodeRelease[];
  /** Each package manager's releases, newest first. */
  managers: Readonly<Record<string, readonly ToolRelease[]>>;
  advisories: readonly Advisory[];
}

/**
 * Whether a Node release bundles corepack: from 14.19.0 in the 14 line and 16.9.0 onwards, until Node 25, which ships
 * without it.
 */
export function corepackBundled(version: string): boolean {
  const parts = versionParts(version);
  if (!parts) return false;
  const [major, minor] = parts;
  if (major >= 25) return false;
  if (major >= 17) return true;
  if (major === 16) return minor >= 9;
  if (major === 14) return minor >= 19;
  return false;
}

/** The index from generated data and the advisories kept by hand. */
export function releaseIndexOf(data: ReleaseData, advisories: readonly Advisory[] = []): ReleaseIndex {
  return {
    fetchedAt: data.fetchedAt,
    node: data.node.map(([version, npm, lts]) => ({ version, npm, lts })),
    managers: {
      npm: data.npm.map(([version, node, deprecated]) => ({ version, node, deprecated })),
      pnpm: data.pnpm.map(([version, node, deprecated]) => ({ version, node, deprecated })),
    },
    advisories,
  };
}

/** The index this Nivra ships with. */
export const RELEASES: ReleaseIndex = releaseIndexOf(RELEASE_DATA, ADVISORIES);

/**
 * Where an exact version stands against the index:
 * - listed;
 * - newer than anything listed for its major, so it may have been released since, and is checked when preparing;
 * - older than the oldest major the index covers;
 * - missing: inside what the index covers but not in it, so it doesn't exist.
 */
export function standing(releases: ReadonlyArray<{ version: string }>, version: string): "listed" | "newer" | "older" | "missing" {
  if (releases.some((release) => release.version === version)) return "listed";
  const major = versionParts(version)?.[0];
  if (major === undefined || releases.length === 0) return "missing";
  const majors = releases.map((release) => versionParts(release.version)![0]);
  if (major > Math.max(...majors)) return "newer";
  if (major < Math.min(...majors)) return "older";
  const newest = releases.find((release) => versionParts(release.version)![0] === major) ?? null;
  return newest !== null && compareVersions(version, newest.version) > 0 ? "newer" : "missing";
}

/** The advisory that withdraws a tool's version, if any. */
export const advisoryFor = (releases: ReleaseIndex, tool: string, version: string): Advisory | null =>
  releases.advisories.find((advisory) => advisory.tool === tool && advisory.version === version) ?? null;
