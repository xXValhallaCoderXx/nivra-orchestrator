import { PREPARED_FORMAT, RECIPE_FORMAT, recipeDigest, SETUP_FORMAT, VERIFIED_FORMAT, verifiedDigest, type EnvironmentRecipe, type EnvironmentSetup, type PreparedEnvironmentV2, type VerifiedToolRecord } from "@nivra/domain";

/**
 * A project-driven recipe's environment as the host keeps one (NIV-55), for the window's and the host's tests: a pnpm
 * project on Node 24, its digests worked out with the domain's own functions, so a test that changes one field gets
 * another environment and never a copy that still claims the old digests.
 */
export const RECIPE: EnvironmentRecipe = {
  format: RECIPE_FORMAT,
  profile: "node",
  platform: { os: "linux", arch: "x86_64", libc: "musl" },
  image: { registryUrl: "docker://docker.io/library/node:24.21.0-alpine", tag: "node:24.21.0-alpine" },
  tools: [
    { name: "node", version: { kind: "exact", version: "24.21.0" }, from: "image" },
    { name: "npm", version: { kind: "bundled", with: "node" }, from: "image" },
    { name: "pnpm", version: { kind: "exact", version: "11.5.3" }, from: "bootstrap" },
  ],
  bootstrap: [{ tool: "pnpm", version: "11.5.3", via: "corepack-else-npm-global" }],
  install: { tool: "pnpm", args: ["install", "--frozen-lockfile"], options: {} },
  scope: { kind: "whole" },
  builds: { tool: "pnpm", runs: "allowed", allowed: ["esbuild"], denied: [], strict: true, source: "pnpm-workspace.yaml", notes: [] },
  configuration: { mode: "manifests", files: [{ path: "package.json", bytes: 60, sha256: "1".repeat(64) }], digest: "2".repeat(64) },
  systemPackages: [],
  workdir: "/workspace",
  env: { preparation: { CI: "1" }, task: { CI: "1", COREPACK_ENABLE_NETWORK: "0", pnpm_config_verify_deps_before_run: "false" } },
  artifacts: { dependency: ["node_modules"], caches: ["/root/.cache"] },
  network: { preparation: "on", tasks: "off", hosts: ["registry.npmjs.org"], imageRegistry: "docker.io" },
  probes: ["tool-versions"],
  limits: { importSeconds: 900, prepareSeconds: 600, probeSeconds: 120 },
};

/** What a preparation of `recipe` verified, with its builds as given. */
export async function verifiedOf(recipe: EnvironmentRecipe, image: string, builds: VerifiedToolRecord["builds"] = { state: "complete", missing: [] }): Promise<VerifiedToolRecord> {
  return {
    format: VERIFIED_FORMAT,
    recipe: await recipeDigest(recipe),
    tools: [
      { name: "node", version: "24.21.0" },
      { name: "npm", version: "11.19.0" },
      { name: "pnpm", version: "11.5.3" },
    ],
    platform: { os: "linux", arch: "x86_64", libc: "musl", release: "Alpine Linux v3.22" },
    images: { base: "img-base", prepared: image, imported: true },
    builds,
    generated: null,
    probes: [{ name: "readiness", durationMs: 900 }],
    verifiedAt: "2026-10-28T10:00:00.000Z",
  };
}

/** A recipe's prepared environment, as a preparation that ended prepared leaves it. */
export async function preparedOf(image: string, options: { recipe?: EnvironmentRecipe; builds?: VerifiedToolRecord["builds"]; projectFingerprint?: string } = {}): Promise<PreparedEnvironmentV2> {
  const recipe = options.recipe ?? RECIPE;
  const verified = await verifiedOf(recipe, image, options.builds);
  return {
    format: PREPARED_FORMAT,
    recipe,
    recipeDigest: await recipeDigest(recipe),
    verified,
    verifiedDigest: await verifiedDigest(verified),
    baseline: "a".repeat(40),
    projectFingerprint: options.projectFingerprint ?? "f".repeat(64),
    preparedAt: "2026-10-28T10:00:00.000Z",
  };
}

/** What a preparation of `recipe` is started with: the person's choices, none here, and nothing kept from before. */
export async function setupOf(recipe: EnvironmentRecipe = RECIPE): Promise<EnvironmentSetup> {
  return { format: SETUP_FORMAT, choices: {}, previous: null, recipeDigest: await recipeDigest(recipe) };
}
