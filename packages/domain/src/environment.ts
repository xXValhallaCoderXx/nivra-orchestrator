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
export const EnvironmentStopCode = z.enum(["consent", "credentials", "native-windows", "preview", "layout", "git", "image", "install", "versions", "cancelled", "uncertain", "sandbox-failed", "fault", "inspect", "bootstrap", "readiness"]);
export type EnvironmentStopCode = z.infer<typeof EnvironmentStopCode>;

/**
 * A preparation run's report, saved by the engine (masked) as it goes and when it ends, and read with
 * `runs.environment`. `prepared` holds the environment only when every step passed.
 */
export const EnvironmentReport = z.strictObject({
  outcome: z.enum(["in-progress", "prepared", "refused", "cancelled", "failed", "uncertain", "interrupted"]),
  stopped: z
    .strictObject({
      code: EnvironmentStopCode,
      step: z.string().max(64).nullable(),
      message: z.string().max(600),
      /** What the check found, in Nivra's words, such as the Node an image holds against the one asked for (NIV-55). */
      detail: z.string().max(600).nullable().optional(),
    })
    .nullable(),
  /** D41's single setup. A recipe-driven preparation leaves it null and fills `environment`, so earlier readers still read. */
  prepared: PreparedEnvironment.nullable(),
  /** A project-driven recipe and what its preparation verified (NIV-55). Absent from reports written before it. */
  environment: z.lazy(() => PreparedEnvironmentV2).nullable().optional(),
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

/*
 * Project-driven environments (NIV-55, NIV-58). The setup a project declares (its runtime, package manager, lockfile
 * and install policy) is resolved into a recipe, the requested configuration the person approves. Preparation then
 * writes a verified tool record of what it found. Both are immutable, and both are bound to every task run through an
 * environment reference.
 *
 * Nothing in these schemas names a runtime or a package manager: an ecosystem's resolver fills them in. Only Node's
 * resolver exists. A recipe holds a tool's exact version when one is known before preparing, and otherwise the rule that
 * preparation answers, such as "the npm a Node release bundles". A fact found by preparing goes into the verified
 * record, never into the approved recipe, so a digest the person approved never changes underneath them.
 */

export const RECIPE_FORMAT = "nivra.environment-recipe.v1";
export const VERIFIED_FORMAT = "nivra.environment-verified.v1";
export const REF_FORMAT = "nivra.environment-ref.v1";

/** A recipe's bounds: the setup configuration is a subset of the snapshot, which holds 14 MiB of content at most. */
export const RECIPE_LIMITS = { inputs: 1_000, inputBytes: 14 * 1024 * 1024 } as const;

/** A lower-case name: a tool such as a runtime or a package manager, a profile, a probe or an option. */
const Identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const ToolName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** An exact release, x.y.z, as a resolver settles it: never a range, a tag or "latest". */
export const ExactVersion = z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/);
/**
 * A package name or pattern, as a lockfile or a build policy writes it, version-restricted entries such as
 * `nx@21.6.4 || 21.6.5` included. It is data, never an argument.
 */
const PackagePattern = z.string().regex(/^[A-Za-z0-9@._/*~^:|<>=+ -]{1,214}$/);
/** A path inside the repository, as the snapshot names it: relative, with forward slashes. */
const RepoPath = z.string().regex(/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[^\0\\]{1,1024}$/);
const ImageId = z.string().min(1).max(200);
/** One command-line argument with no shell meaning: no spaces, quotes or shell operators. */
const PlainArg = z.string().regex(/^[A-Za-z0-9@._/^~*!=:+,-]{1,200}$/);

/** How a tool's version is settled before preparing: exactly, or as the version another tool ships with. */
export const ToolVersion = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact"), version: ExactVersion }),
  z.strictObject({ kind: z.literal("bundled"), with: ToolName }),
]);
export type ToolVersion = z.infer<typeof ToolVersion>;

/** A tool the environment provides: from the base image, or installed by a bootstrap step. */
export const RecipeTool = z.strictObject({ name: ToolName, version: ToolVersion, from: z.enum(["image", "bootstrap"]) });
export type RecipeTool = z.infer<typeof RecipeTool>;

export const EnvironmentPlatform = z.strictObject({ os: z.literal("linux"), arch: z.literal("x86_64"), libc: z.enum(["musl", "glibc"]) });
export type EnvironmentPlatform = z.infer<typeof EnvironmentPlatform>;

/** Where the base image comes from: a public registry address and its exact tag. A tag doesn't pin bytes; the verified record does. */
export const RecipeImage = z.strictObject({
  registryUrl: z.string().regex(/^docker:\/\/[a-z0-9.-]+(\/[a-z0-9._-]+)+:[A-Za-z0-9._-]{1,128}$/),
  tag: z.string().max(200),
});
export type RecipeImage = z.infer<typeof RecipeImage>;

/** A bootstrap step: one tool at an exact version, by a method the ecosystem's resolver names and the sandbox runs as a fixed script. */
export const BootstrapStep = z.strictObject({ tool: ToolName, version: ExactVersion, via: Identifier });
export type BootstrapStep = z.infer<typeof BootstrapStep>;

/** An install option's value: on or off, a word, or a few words; never free text a shell could read. */
const OptionWord = z.string().regex(/^[A-Za-z0-9@._/^~*!:-]{1,64}$/);
export const InstallOptionValue = z.union([z.boolean(), OptionWord, z.array(OptionWord).max(8)]);
export type InstallOptionValue = z.infer<typeof InstallOptionValue>;
export const InstallOptions = z.record(Identifier, InstallOptionValue);
export type InstallOptions = z.infer<typeof InstallOptions>;

/** The install, exactly: the tool, its arguments in order (the options' flags among them) and the options they came from. */
export const InstallStep = z.strictObject({ tool: ToolName, args: z.array(PlainArg).min(1).max(48), options: InstallOptions });
export type InstallStep = z.infer<typeof InstallStep>;

/** What is installed: the whole project, or the workspace packages the person selected. */
export const InstallScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("whole") }),
  z.strictObject({ kind: z.literal("selected"), selectors: z.array(z.string().regex(ENVIRONMENT_FILTER)).min(1).max(ENVIRONMENT_LIMITS.filters) }),
]);
export type InstallScope = z.infer<typeof InstallScope>;

/**
 * Which dependency builds the package manager runs, by its own rules and the project's declared policy. Nivra records
 * it and never widens it.
 */
export const BuildPolicy = z.strictObject({
  tool: ToolName,
  /** All, those the policy allows, none, or unknown when Nivra can't read the policy or the manager's rules. */
  runs: z.enum(["all", "allowed", "none", "unknown"]),
  allowed: z.array(PackagePattern).max(500),
  denied: z.array(PackagePattern).max(500),
  /** Whether the install fails when a build wasn't reviewed; null when the manager has no such rule. */
  strict: z.boolean().nullable(),
  /** The file the project declares it in; null when it declares nothing. */
  source: z.string().max(200).nullable(),
  /** Settings this manager version ignores, or that Nivra couldn't read, in plain words. */
  notes: z.array(z.string().max(300)).max(10),
});
export type BuildPolicy = z.infer<typeof BuildPolicy>;

/**
 * What preparation is sent: the setup configuration only; that and the files the install names; or the whole snapshot,
 * when the project's own install scripts run. Only the first is implemented; the others are refused until they are.
 */
export const SourceMode = z.enum(["manifests", "declared-files", "full-sources"]);
export type SourceMode = z.infer<typeof SourceMode>;

/** The setup configuration: the committed files that decide the environment, frozen during a task, bound by one digest. */
export const SetupConfiguration = z.strictObject({ mode: SourceMode, files: z.array(EnvironmentInputFile).max(RECIPE_LIMITS.inputs), digest: Sha256Hex });
export type SetupConfiguration = z.infer<typeof SetupConfiguration>;

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const EnvValue = z.string().regex(/^[A-Za-z0-9@._/:,=+-]{0,400}$/);
/** Variables for the preparation and for every task operation. Nothing here is secret: it goes to the provider. */
export const RecipeEnv = z.strictObject({ preparation: z.record(EnvName, EnvValue), task: z.record(EnvName, EnvValue) });
export type RecipeEnv = z.infer<typeof RecipeEnv>;

export const ArtifactFolders = z.strictObject({
  /** Folder names the install writes in the workspace, left out of listing and collect at any depth. */
  dependency: z.array(z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/)).min(1).max(8),
  /** Caches outside the workspace, kept in the image. */
  caches: z.array(z.string().regex(/^\/[A-Za-z0-9._/-]{1,200}$/)).max(8),
});
export type ArtifactFolders = z.infer<typeof ArtifactFolders>;

const Host = z.string().regex(/^[a-z0-9.-]{1,253}$/);
export const NetworkDeclaration = z.strictObject({
  preparation: z.literal("on"),
  tasks: z.literal("off"),
  /** The hosts the install fetches from, as the lockfile and the bootstrap name them. */
  hosts: z.array(Host).max(16),
  /** The registry the base image is imported from. */
  imageRegistry: Host,
});
export type NetworkDeclaration = z.infer<typeof NetworkDeclaration>;

export const RecipeLimits = z.strictObject({ importSeconds: count, prepareSeconds: count, probeSeconds: count });

/** The requested configuration: what the person approves. Its digest is their consent, and it never changes afterwards. */
export const EnvironmentRecipe = z.strictObject({
  format: z.literal(RECIPE_FORMAT),
  /** The ecosystem module that resolved it, such as node. */
  profile: Identifier,
  platform: EnvironmentPlatform,
  image: RecipeImage,
  tools: z.array(RecipeTool).min(1).max(8),
  bootstrap: z.array(BootstrapStep).max(4),
  install: InstallStep,
  scope: InstallScope,
  builds: BuildPolicy,
  configuration: SetupConfiguration,
  systemPackages: z.array(z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,63}$/)).max(16),
  workdir: z.literal("/workspace"),
  env: RecipeEnv,
  artifacts: ArtifactFolders,
  network: NetworkDeclaration,
  probes: z.array(Identifier).max(12),
  limits: RecipeLimits,
});
export type EnvironmentRecipe = z.infer<typeof EnvironmentRecipe>;

export const VerifiedTool = z.strictObject({ name: ToolName, version: ExactVersion });
export type VerifiedTool = z.infer<typeof VerifiedTool>;

/** Dependency builds that didn't run, as the manager reported them or Nivra worked them out; unknown when neither could. */
export const BuildsState = z.strictObject({ state: z.enum(["complete", "missing", "unknown"]), missing: z.array(PackagePattern).max(200) });
export type BuildsState = z.infer<typeof BuildsState>;

/** What install hooks generated, with full sources: the steps rebuilt offline, the paths they declare, and the dependency folders' digest. */
export const GeneratedOutputs = z.strictObject({
  rebuild: z.array(z.strictObject({ folder: z.union([z.literal(""), RepoPath]), script: Identifier })).max(64),
  paths: z.array(RepoPath).max(500),
  dependencyPaths: z.array(RepoPath).max(500),
  dependencyDigest: Sha256Hex,
  rebuildMs: count.nullable(),
});
export type GeneratedOutputs = z.infer<typeof GeneratedOutputs>;

/** What preparation found, written once and never edited: a later preparation makes a new record. */
export const VerifiedToolRecord = z.strictObject({
  format: z.literal(VERIFIED_FORMAT),
  /** The digest of the recipe it verifies. */
  recipe: Sha256Hex,
  tools: z.array(VerifiedTool).min(1).max(8),
  platform: z.strictObject({ os: z.literal("linux"), arch: z.string().max(32), libc: z.enum(["musl", "glibc"]), release: z.string().max(200) }),
  images: z.strictObject({ base: ImageId, prepared: ImageId, imported: z.boolean() }),
  builds: BuildsState,
  generated: GeneratedOutputs.nullable(),
  probes: z.array(z.strictObject({ name: Identifier, durationMs: count.nullable() })).max(16),
  verifiedAt: z.iso.datetime(),
});
export type VerifiedToolRecord = z.infer<typeof VerifiedToolRecord>;

/** The person's acceptance of an environment whose builds didn't all run: bound to one verified record, never written into it. */
export const BuildsAcceptance = z.strictObject({ verified: Sha256Hex, missing: z.array(PackagePattern).max(200), acceptedAt: z.iso.datetime() });
export type BuildsAcceptance = z.infer<typeof BuildsAcceptance>;

/** What a task run carries, and what Next C consumes: both digests, the image, and what binds them. */
export const EnvironmentRef = z.strictObject({
  format: z.literal(REF_FORMAT),
  recipe: Sha256Hex,
  verified: Sha256Hex,
  configuration: Sha256Hex,
  image: ImageId,
  projectFingerprint: Sha256Hex,
  target: TargetName,
  tools: z.array(VerifiedTool).min(1).max(8),
  platform: z.strictObject({ arch: z.string().max(32), libc: z.enum(["musl", "glibc"]) }),
  /** What every task operation gets: the recipe's task variables. Nothing in them is secret. */
  env: z.record(EnvName, EnvValue),
  /** The folders the install writes in the workspace, which the session's listing and collect leave out. */
  dependencyFolders: ArtifactFolders.shape.dependency,
  builds: BuildsAcceptance.nullable(),
  preparedAt: z.iso.datetime(),
});
export type EnvironmentRef = z.infer<typeof EnvironmentRef>;

/** Whether a run's environment is a project-driven recipe's (NIV-55), not D41's single setup. */
export const isEnvironmentRef = (environment: TaskEnvironment | EnvironmentRef): environment is EnvironmentRef => "format" in environment && environment.format === REF_FORMAT;

/** Why a prepared environment can't be used any more. Refreshing Nivra's release index is never one. */
export const InvalidationReason = z.enum(["inputs-changed", "recipe-changed", "advisory", "project-changed", "target-changed", "image-missing", "legacy"]);
export type InvalidationReason = z.infer<typeof InvalidationReason>;

/** Where a resolved value came from, as the preview labels it. */
export const ResolutionSource = z.enum(["declared", "resolved", "default", "choice", "checked-when-preparing"]);
export type ResolutionSource = z.infer<typeof ResolutionSource>;

/** One declaration as the project wrote it: the file, the field when there is one, and the value. */
export const Declaration = z.strictObject({ file: z.string().max(1_024), field: z.string().max(100).nullable(), value: z.string().max(300) });
export type Declaration = z.infer<typeof Declaration>;

/** One fact of the detected setup, with where its value came from. */
export const ResolutionRow = z.strictObject({
  fact: Identifier,
  label: z.string().max(100),
  value: z.string().max(300).nullable(),
  source: ResolutionSource,
  declarations: z.array(Declaration).max(40),
  note: z.string().max(600).nullable(),
});
export type ResolutionRow = z.infer<typeof ResolutionRow>;

export const ChoiceOption = z.strictObject({ value: z.string().max(100), label: z.string().max(200), note: z.string().max(300).nullable() });
export type ChoiceOption = z.infer<typeof ChoiceOption>;

/** A choice the person has to make: never made for them. */
export const ChoiceNeeded = z.strictObject({
  id: z.enum(["runtime", "manager", "manager-version"]),
  why: z.enum(["conflict", "unreadable", "ambiguous", "unavailable"]),
  message: z.string().max(1_000),
  declarations: z.array(Declaration).max(40),
  options: z.array(ChoiceOption).max(20),
});
export type ChoiceNeeded = z.infer<typeof ChoiceNeeded>;

/** What the person chose: answers to choices, a change to a default, install options and the scope. */
export const EnvironmentChoices = z.strictObject({
  runtime: ExactVersion.optional(),
  manager: ToolName.optional(),
  managerVersion: ExactVersion.optional(),
  options: InstallOptions.optional(),
  scope: InstallScope.optional(),
});
export type EnvironmentChoices = z.infer<typeof EnvironmentChoices>;

export const ResolutionWarning = z.strictObject({ code: Identifier, message: z.string().max(600) });
export type ResolutionWarning = z.infer<typeof ResolutionWarning>;

/**
 * A project's setup, resolved on the engine that owns the checkout with no network: refused, waiting for the person's
 * choices, or ready as a recipe.
 */
export const EnvironmentResolution = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("refused"), code: Identifier, message: z.string().max(2_000), rows: z.array(ResolutionRow).max(20) }),
  z.strictObject({
    status: z.literal("needs-choice"),
    rows: z.array(ResolutionRow).max(20),
    choices: z.array(ChoiceNeeded).min(1).max(4),
    warnings: z.array(ResolutionWarning).max(20),
    limitations: z.array(z.string().max(600)).max(20),
  }),
  z.strictObject({
    status: z.literal("ready"),
    rows: z.array(ResolutionRow).max(20),
    recipe: EnvironmentRecipe,
    warnings: z.array(ResolutionWarning).max(20),
    limitations: z.array(z.string().max(600)).max(20),
  }),
]);
export type EnvironmentResolution = z.infer<typeof EnvironmentResolution>;

/** JSON with every object's keys sorted: the same value always reads the same, wherever it is written. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A recipe's digest: what the person consents to. */
export const recipeDigest = (recipe: EnvironmentRecipe): Promise<string> => sha256Hex(`${RECIPE_FORMAT}\0${canonicalJson(recipe)}`);
/** A verified record's digest. */
export const verifiedDigest = (record: VerifiedToolRecord): Promise<string> => sha256Hex(`${VERIFIED_FORMAT}\0${canonicalJson(record)}`);

/** The exact versions a project's last preparation settled on, and whether the person chose them then (NIV-55). */
export const PreviousSettlement = z.strictObject({
  configuration: Sha256Hex,
  runtime: ExactVersion,
  manager: ToolName,
  /** An exact version, or bundled for npm taken from the Node image. */
  managerVersion: z.union([ExactVersion, z.literal("bundled")]),
  chosen: z.strictObject({ runtime: z.boolean().optional(), managerVersion: z.boolean().optional() }).optional(),
});
export type PreviousSettlement = z.infer<typeof PreviousSettlement>;

const ReadyResolution = EnvironmentResolution.options[2];

/**
 * What preparing a project's environment would send and run (NIV-55), worked out on the engine that owns the checkout
 * with no network: the resolution, and for a ready one what binds the run. Its fingerprint covers the commit, the
 * folder and the recipe's digest, and the run checks it again before anything is sent.
 */
export const EnvironmentPreviewV2 = z.discriminatedUnion("status", [
  EnvironmentResolution.options[0],
  EnvironmentResolution.options[1],
  ReadyResolution.extend({
    recipeDigest: Sha256Hex,
    baseline: Commit,
    /** The setup configuration as one archive, compressed, as it is uploaded. */
    sentBytes: count,
    /** Setup files a snapshot leaves out, never sent: a secrets file such as .npmrc. */
    leftOut: z.array(z.string().max(1_024)).max(20),
    /** What Nebius keeps, in its own terms. */
    retention: z.string().max(1_000),
    fingerprint: Sha256Hex,
  }),
]);
export type EnvironmentPreviewV2 = z.infer<typeof EnvironmentPreviewV2>;

/** What a recipe-driven preparation gets besides its input (D21): held in the engine's memory for the run, never stored. */
export const EnvironmentContextV2 = z.strictObject({
  sharing: z.strictObject({ cloudExecution: z.boolean() }),
  choices: EnvironmentChoices,
  previous: PreviousSettlement.nullable(),
});
export type EnvironmentContextV2 = z.infer<typeof EnvironmentContextV2>;

export const PREPARED_FORMAT = "nivra.environment-prepared.v2";

/** A recipe-driven environment, as its preparation left it: what was asked for, what was verified, and what binds it. */
export const PreparedEnvironmentV2 = z.strictObject({
  format: z.literal(PREPARED_FORMAT),
  recipe: EnvironmentRecipe,
  recipeDigest: Sha256Hex,
  verified: VerifiedToolRecord,
  verifiedDigest: Sha256Hex,
  baseline: Commit,
  projectFingerprint: Sha256Hex,
  preparedAt: z.iso.datetime(),
});
export type PreparedEnvironmentV2 = z.infer<typeof PreparedEnvironmentV2>;
