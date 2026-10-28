import { createHash } from "node:crypto";
import { ENVIRONMENT_BASE, recipeDigest, type EnvironmentChoices, type EnvironmentPreview, type EnvironmentPreviewV2, type EnvironmentSpec, type PreviousSettlement } from "@nivra/domain";
import { RETENTION } from "../exec/nebius/sandbox.ts";
import type { Snapshot } from "../exec/snapshot.ts";
import { OUTPUT_DIRS } from "../repo/deny.ts";
import { environmentFingerprint, environmentInputs, EnvironmentRefusal, inputsArchive, installArgsFor, trackedUnder } from "./inputs.ts";
import { resolveNodeEnvironment } from "./node.ts";
import type { ReleaseIndex } from "./releases.ts";

/** A preparation's bounds (D41): the import's time, the install's, and its one operation with networking on. */
export const PREPARE_LIMITS = {
  importSeconds: 900,
  prepareSeconds: 600,
  /** How often the import and the install are read while they run. */
  pollMs: 5_000,
  /** Cleanup's own time, apart from the run's. */
  closeMs: 7 * 60_000,
} as const;

/** What a preparation reaches with networking on, in plain words. */
export const ENVIRONMENT_NETWORK =
  "Networking is on for the preparation only: the sandbox reaches the npm registry to fetch pnpm and the packages your lockfile names. If your Nebius project doesn't have Nivra's Node image yet, Nebius first imports it from Docker Hub, as a private image. Every task run then starts from the prepared image with networking off.";

/** What preparing this commit's environment would send and run, and its fingerprint. Throws `EnvironmentRefusal`. */
export function environmentPreviewOf(snapshot: Snapshot, spec: EnvironmentSpec): Extract<EnvironmentPreview, { status: "ready" }> {
  // D41's task runs leave its output folders out, and refuse a commit that tracks files in one (NIV-55): so does this.
  const tracked = trackedUnder(snapshot, OUTPUT_DIRS);
  if (tracked) throw new EnvironmentRefusal(`This commit tracks files in ${tracked.folder}, such as ${JSON.stringify(tracked.path.slice(0, 200))}, which this kind of environment leaves out of its task runs, so they would refuse it. Prepare the project's own recipe instead.`);
  const inputs = environmentInputs(snapshot);
  const installArgs = installArgsFor(spec);
  return {
    status: "ready",
    baseline: snapshot.baseline,
    packageManager: inputs.packageManager,
    nodeRequirement: inputs.nodeRequirement,
    packages: inputs.packages,
    inputs: inputs.files.map((file) => ({ path: file.path, bytes: file.size, sha256: file.sha256 })),
    inputsDigest: inputs.digest,
    sentBytes: inputsArchive(inputs.files).byteLength,
    leftOut: inputs.leftOut,
    base: { tag: ENVIRONMENT_BASE.tag, registryUrl: ENVIRONMENT_BASE.registryUrl, node: ENVIRONMENT_BASE.node },
    installArgs,
    network: ENVIRONMENT_NETWORK,
    retention: RETENTION,
    limits: { importSeconds: PREPARE_LIMITS.importSeconds, prepareSeconds: PREPARE_LIMITS.prepareSeconds, operations: 1 },
    fingerprint: environmentFingerprint({ baseline: snapshot.baseline, prefix: snapshot.prefix, inputsDigest: inputs.digest, spec, installArgs }),
  };
}

/** A recipe preview's fingerprint: the commit, the folder and the recipe's digest, in a fixed, versioned order. */
export const recipeFingerprint = (baseline: string, prefix: string, digest: string): string => createHash("sha256").update(JSON.stringify(["nivra.environment-preview.v2", baseline, prefix, digest])).digest("hex");

/**
 * A project's own setup resolved into a recipe (NIV-55), with no network: refused, waiting for the person's choices,
 * or ready with what preparing it would send and the fingerprint the run is checked against.
 */
export async function environmentResolutionOf(snapshot: Snapshot, choices: EnvironmentChoices, previous: PreviousSettlement | null, releases?: ReleaseIndex): Promise<EnvironmentPreviewV2> {
  const resolution = resolveNodeEnvironment({ snapshot, choices, previous, ...(releases ? { releases } : {}) });
  if (resolution.status !== "ready") return resolution;
  const digest = await recipeDigest(resolution.recipe);
  const paths = new Set(resolution.recipe.configuration.files.map((file) => file.path));
  return {
    ...resolution,
    recipeDigest: digest,
    baseline: snapshot.baseline,
    sentBytes: inputsArchive(snapshot.files.filter((file) => paths.has(file.path))).byteLength,
    leftOut: snapshot.leftOutPaths.filter((path) => path === ".npmrc" || path.endsWith("/.npmrc")).slice(0, 20),
    retention: RETENTION,
    fingerprint: recipeFingerprint(snapshot.baseline, snapshot.prefix, digest),
  };
}
