import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EnvironmentRecipe } from "@nivra/domain";
import { SandboxHttpError, SandboxNetworkError, type SandboxApi } from "../src/exec/nebius/api.ts";
import type { Journal, Sandbox } from "../src/exec/nebius/sandbox.ts";
import { resolveNodeEnvironment } from "../src/environment/node.ts";
import { prepareRecipe } from "../src/environment/prepare.ts";
import { installDiagnosis } from "../src/environment/scripts.ts";
import { cleanUp, repoWith, snap } from "./workspace-fixtures.ts";

/**
 * A recipe's preparation stops in its own words (NIV-55): what Nebius answered, or didn't, is Nebius's failure, and
 * anything else that goes wrong is Nivra's, never put down to Nebius. Nothing is uploaded in either case.
 */
after(cleanUp);

const recipe = async (): Promise<EnvironmentRecipe> => {
  const files = { "package.json": `${JSON.stringify({ name: "app", version: "1.0.0" })}\n`, "package-lock.json": `${JSON.stringify({ name: "app", lockfileVersion: 3, requires: true, packages: { "": { name: "app" } } })}\n` };
  const resolution = resolveNodeEnvironment({ snapshot: await snap(repoWith(files)), choices: {}, previous: null });
  assert.equal(resolution.status, "ready");
  return (resolution as Extract<typeof resolution, { status: "ready" }>).recipe;
};

const prepareWith = async (failure: Error) => {
  let uploads = 0;
  const api = {
    images: async () => {
      throw failure;
    },
    upload: async () => {
      uploads += 1;
      return { uuid: "upload", sha256: null };
    },
  } as unknown as SandboxApi;
  const outcome = await prepareRecipe({ api, sandbox: {} as Sandbox, journal: { append: () => {} } as unknown as Journal, archive: new Uint8Array(), recipe: await recipe(), recipeDigest: "d".repeat(64), installScripts: [], until: () => performance.now() + 60_000, signal: new AbortController().signal, progress: () => {} });
  return { code: outcome.stopped?.code, step: outcome.stopped?.step, prepared: outcome.prepared, uploads };
};

describe("a recipe's preparation stops in its own words (NIV-55)", () => {
  it("puts an answer from Nebius, or none, down to Nebius", async () => {
    assert.deepEqual(await prepareWith(new SandboxHttpError("Listing images", 503, null)), { code: "sandbox-failed", step: "image", prepared: null, uploads: 0 });
    assert.deepEqual(await prepareWith(new SandboxNetworkError("Listing images", new Error("reset"))), { code: "sandbox-failed", step: "image", prepared: null, uploads: 0 });
  });

  it("puts anything else down to Nivra, never to Nebius", async () => {
    assert.deepEqual(await prepareWith(new TypeError("a bug")), { code: "fault", step: "image", prepared: null, uploads: 0 });
  });
});

describe("a failed install's diagnosis (NIV-55)", () => {
  it("names the fix for the failures it knows, for the manager that prints them, and repeats nothing from the log", () => {
    const secret = "token-0123456789abcdef";
    const known: Array<["npm" | "pnpm", string, RegExp]> = [
      ["npm", `npm error code ERESOLVE ${secret}`, /legacy-peer-deps/],
      ["npm", "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync", /Run npm install in the repository/],
      ["pnpm", `ERR_PNPM_OUTDATED_LOCKFILE ${secret}`, /Run pnpm install in the repository/],
      ["pnpm", "ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild", /pnpm approve-builds/],
      ["pnpm", "ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment", /choose a Node version every package accepts/],
      ["npm", "npm warn EBADENGINE Unsupported engine", /choose a Node version every package accepts/],
      ["npm", "gyp ERR! find Python", /python3, make or g\+\+/],
      ["pnpm", "sh: make: not found", /python3, make or g\+\+/],
      ["npm", "npm error code ENOTFOUND", /couldn't reach the package registry/],
    ];
    for (const [manager, log, words] of known) {
      const said = installDiagnosis(manager, log);
      assert.match(said ?? "", words, log);
      assert.ok(!said!.includes(secret), "the diagnosis repeated text from the log");
    }
    // Another manager's signature isn't read as this one's, and an unknown failure gets no diagnosis.
    assert.deepEqual([installDiagnosis("pnpm", "npm error code ERESOLVE"), installDiagnosis("npm", "ERR_PNPM_OUTDATED_LOCKFILE"), installDiagnosis("npm", "npm error code E404")], [null, null, null]);
  });
});
