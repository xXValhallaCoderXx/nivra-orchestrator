import { ENVIRONMENT_BASE, type EnvironmentPreview, type EnvironmentSpec } from "@nivra/domain";
import { RETENTION } from "../exec/nebius/sandbox.ts";
import type { Snapshot } from "../exec/snapshot.ts";
import { environmentFingerprint, environmentInputs, inputsArchive, installArgsFor } from "./inputs.ts";

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
