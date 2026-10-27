import { z } from "zod";
import { SandboxCleanup, SandboxStep, TargetName } from "./sandbox.ts";

/**
 * A project's environment (NIV-49, D41): one pinned Node and pnpm setup, prepared inside Nebius from the commit's
 * manifests by a run of its own, and kept as an image that the project's task runs then start from, with networking
 * off. Nivra pins the base image, by its registry address, and its Node version. The project pins pnpm, in its
 * package.json's packageManager, and the person chooses which of its workspace packages to install. Nothing here is a
 * command.
 *
 * Preparation is the one operation that runs with networking on, and its preview says so. It is sent only the commit's
 * manifests, its lockfile and its workspace file, and never a file a snapshot leaves out, such as .npmrc. A layout
 * that needs the sources to install (an install lifecycle script, a pnpmfile, patched dependencies) is refused.
 *
 * The prepared image is reachable only from the Nebius project it was made in. So it is bound to that project, by a
 * hash of the project id, and to the commit's manifests, by their digest. A task run checks both before it sends
 * anything, and refuses when either differs.
 */

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const count = z.number().int().nonnegative();

/** The base every environment starts from: imported into the person's Nebius project when it isn't there yet. */
export const ENVIRONMENT_BASE = Object.freeze({
  tag: "node:22.23.4-alpine3.24",
  registryUrl: "docker://docker.io/library/node:22.23.4-alpine3.24",
  /** What Docker Hub listed for the tag on 27 October 2026. A tag can be rebuilt, so this is a note, never a check. */
  registryDigest: "sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914",
  node: "v22.23.4",
});

export const ENVIRONMENT_LIMITS = {
  /** pnpm filters, each one workspace selector such as `@scope/package...`. */
  filters: 8,
  filterChars: 200,
  /** The manifests, the lockfile and the workspace file. */
  inputs: 200,
  inputBytes: 8 * 1024 * 1024,
} as const;

/**
 * A pnpm filter: a workspace selector, such as `@scope/package...`, `./packages/data` or `!@scope/web`, with no shell
 * meaning. It never starts with `-`, so pnpm can't read it as an option. The sandbox checks a preparation's arguments
 * against this same rule, so a filter the preview takes is one the preparation runs.
 */
export const ENVIRONMENT_FILTER = /^(?!-)[A-Za-z0-9@._/^~*!-]{1,200}$/;
const Filter = z.string().regex(ENVIRONMENT_FILTER, "A filter is one pnpm workspace selector, such as @scope/package...");

/** What the person chose: which workspace packages to install, as pnpm filters. None installs the whole workspace. */
export const EnvironmentSpec = z.strictObject({
  filters: z.array(Filter).max(ENVIRONMENT_LIMITS.filters),
});
export type EnvironmentSpec = z.infer<typeof EnvironmentSpec>;

/** One preparation input, as the commit holds it. */
export const EnvironmentInputFile = z.strictObject({ path: z.string().max(1_024), bytes: count, sha256: Sha256Hex });
export type EnvironmentInputFile = z.infer<typeof EnvironmentInputFile>;

/**
 * What preparing this checkout's environment would send and run, worked out on the engine that owns the checkout with
 * no network. Its fingerprint covers the commit, the inputs, the spec, the base and the install's arguments, and the
 * run checks it again before anything is sent.
 */
export const EnvironmentPreview = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    baseline: Commit,
    /** The commit's own pin, from its package.json. */
    packageManager: z.string().max(64),
    /** The commit's engines.node, as written; null when it says nothing. */
    nodeRequirement: z.string().max(200).nullable(),
    /** The workspace's packages, for choosing what to install. */
    packages: z.array(z.strictObject({ name: z.string().max(214), path: z.string().max(1_024) })).max(500),
    inputs: z.array(EnvironmentInputFile).max(ENVIRONMENT_LIMITS.inputs),
    inputsDigest: Sha256Hex,
    /** The inputs as one archive, compressed, as it is uploaded. */
    sentBytes: count,
    /** Inputs a snapshot would leave out, never sent: a secrets file such as .npmrc. */
    leftOut: z.array(z.string().max(1_024)).max(20),
    base: z.strictObject({ tag: z.string().max(200), registryUrl: z.string().max(400), node: z.string().max(32) }),
    /** `pnpm install`'s arguments, exactly: the frozen lockfile first. */
    installArgs: z.array(z.string().max(200)).max(32),
    /** What the preparation reaches with networking on, in plain words. */
    network: z.string().max(1_000),
    /** What Nebius keeps, in its own terms. */
    retention: z.string().max(1_000),
    limits: z.strictObject({ importSeconds: count, prepareSeconds: count, operations: count }),
    fingerprint: Sha256Hex,
  }),
  z.strictObject({ status: z.literal("refused"), code: z.string().max(64), message: z.string().max(2_000) }),
]);
export type EnvironmentPreview = z.infer<typeof EnvironmentPreview>;

/** What a preparation run gets besides its input (D21): held in the engine's memory for the run, never stored. */
export const EnvironmentContext = z.strictObject({ sharing: z.strictObject({ cloudExecution: z.boolean() }), spec: EnvironmentSpec });
export type EnvironmentContext = z.infer<typeof EnvironmentContext>;

/** A preparation run's input. `preview` is the fingerprint of what the person was shown. */
export const EnvironmentInput = z.strictObject({
  repoPath: z.string().min(1).max(4096),
  project: z.uuid(),
  target: TargetName,
  preview: Sha256Hex,
});
export type EnvironmentInput = z.infer<typeof EnvironmentInput>;

/** A preparation run's input as the engine reads it back from its store: masked, so only its shape is checked. */
export const StoredEnvironmentInput = z.object({
  repoPath: z.string().min(1),
  project: z.string().min(1),
  target: z.string().min(1),
  preview: z.string().min(1),
});
export type StoredEnvironmentInput = z.infer<typeof StoredEnvironmentInput>;

/**
 * A prepared environment: the image its preparation left, which is its identity, and everything it was made from.
 * Tags are never part of it.
 */
export const PreparedEnvironment = z.strictObject({
  image: z.string().min(1).max(200),
  /** The base it was prepared on: a public image with the pinned tag, or the import of it. */
  base: z.strictObject({ tag: z.string().max(200), image: z.string().min(1).max(200), imported: z.boolean() }),
  node: z.string().max(32),
  pnpm: z.string().max(32),
  arch: z.string().max(32),
  baseline: Commit,
  inputsDigest: Sha256Hex,
  spec: EnvironmentSpec,
  installArgs: z.array(z.string().max(200)).max(32),
  /** SHA-256 of the Nebius project id it was made in: the image is reachable from that project only. */
  projectFingerprint: Sha256Hex,
  preparedAt: z.iso.datetime(),
});
export type PreparedEnvironment = z.infer<typeof PreparedEnvironment>;

/** What stopped a preparation, by kind. The words are chosen by the code. */
export const EnvironmentStopCode = z.enum(["consent", "credentials", "native-windows", "preview", "layout", "git", "image", "install", "versions", "cancelled", "uncertain", "sandbox-failed", "fault"]);
export type EnvironmentStopCode = z.infer<typeof EnvironmentStopCode>;

/**
 * A preparation run's report, saved by the engine (masked) as it goes and when it ends, and read with
 * `runs.environment`. `prepared` holds the environment only when every step passed.
 */
export const EnvironmentReport = z.strictObject({
  outcome: z.enum(["in-progress", "prepared", "refused", "cancelled", "failed", "uncertain", "interrupted"]),
  stopped: z.strictObject({ code: EnvironmentStopCode, step: z.string().max(64).nullable(), message: z.string().max(600) }).nullable(),
  prepared: PreparedEnvironment.nullable(),
  /** The end of the install's own log: text from the sandbox, never instructions. */
  install: z.strictObject({ exitCode: z.number().int().nullable(), logTail: z.string().max(8_000) }).nullable(),
  steps: z.array(SandboxStep).max(8),
  cleanup: SandboxCleanup.nullable(),
  request: z.strictObject({ runId: z.uuid(), clientRequestId: z.uuid() }),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type EnvironmentReport = z.infer<typeof EnvironmentReport>;

/**
 * The environment a task run starts from, as its preview showed it: the prepared image and what binds it. The engine
 * refuses the run before sending anything when the commit's manifests no longer digest to `inputsDigest`, or when the
 * saved credentials name another Nebius project.
 */
export const TaskEnvironment = z.strictObject({
  image: z.string().min(1).max(200),
  inputsDigest: Sha256Hex,
  projectFingerprint: Sha256Hex,
  node: z.string().max(32),
  pnpm: z.string().max(32),
  arch: z.string().max(32),
});
export type TaskEnvironment = z.infer<typeof TaskEnvironment>;

/** SHA-256 of a Nebius project id, in hex: how an environment names the project it was made in without holding it. */
export async function projectFingerprint(projectId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`nivra.nebius-project.v1\0${projectId}`));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
