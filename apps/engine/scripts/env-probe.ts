// Live environment feasibility probe (NIV-49): one Node and pnpm environment prepared inside Nebius from a project's
// manifests, then Nivra's own session started from it, running the project's baseline selections with networking off.
// Never part of `pnpm verify`, and never run without your approval of the recipe `--plan` prints: one approval covers
// the one bounded run it describes, its cleanup included, and nothing more. No model is called. Networking is on for
// the preparation alone, as the recipe declares; every other operation runs with it off.
//
// Usage (from the repository's top level):
//   node apps/engine/scripts/env-probe.ts --config <file> --plan
//   node apps/engine/scripts/env-probe.ts --config <file> --credentials <file> --run --approved <digest>
//   node apps/engine/scripts/env-probe.ts --credentials <file> --recover <evidence folder>
//
// The config names the repository and its baseline, the pinned image and package manager, the preparation inputs, the
// dependency folders, the baseline selections and the frozen files: everything about a project is there, and nothing
// here names one. The key and project id come from a file only you can read, outside the repository; they are read
// once, removed from the environment, and never printed or written. Evidence goes to ~/nivra-acceptance/env-probe-<UTC>/
// (0700). Close the Nivra app first: the probe fails if the release engine home (~/.nivra) changed. The first Ctrl+C
// stops the work at once, then closing settles what it started on its own budget; a second stops cleanup, and
// --recover finishes it later.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { z } from "zod";
import { findGit } from "../src/exec/find-executable.ts";
import { createLocalBackend } from "../src/exec/local.ts";
import { fetchTransport, SandboxApi, type Transport } from "../src/exec/nebius/api.ts";
import { insideRepository, RETENTION, tokenOutlasts } from "../src/exec/nebius/probe.ts";
import { Journal } from "../src/exec/nebius/sandbox.ts";
import { compressSnapshot, createNebiusBackend, NEBIUS_LIMITS, reconcileJournals, scanJournals } from "../src/exec/nebius/session.ts";
import { canonicalJson } from "../src/exec/proposal.ts";
import { takeSnapshot, type Snapshot } from "../src/exec/snapshot.ts";
import { writeTar } from "../src/exec/tar.ts";
import { hiddenReason, OUTPUT_DIRS } from "../src/repo/deny.ts";
import { claimApproval, claimOn, isDigest } from "./research-check/claim.ts";
import { runEnvProbe } from "./env-probe-run.ts";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const CLAIMS = join(homedir(), "nivra-acceptance", "claims", "env-probe");
const { values } = parseArgs({
  options: {
    config: { type: "string" },
    plan: { type: "boolean", default: false },
    run: { type: "boolean", default: false },
    approved: { type: "string" },
    credentials: { type: "string" },
    recover: { type: "string" },
    evidence: { type: "string" },
  },
  allowPositionals: false,
});

/** The probe's bounds, which the adapter itself enforces: each operation's time, the session's, cleanup's. */
const PROBE = Object.freeze({ importSeconds: 900, prepareSeconds: 600, pollSeconds: 5, overlaySeconds: 180, toolchainSeconds: 60, selectionSeconds: 300, collectSeconds: 180, sessionMinutes: 30, cleanupMinutes: 7 });
/** The session's own operations: the snapshot's overlay, the toolchain, each selection, and collect. */
const sessionOperations = (selections: number) => 3 + selections;
const STOP_SECONDS = Math.round((NEBIUS_LIMITS.minWriteMs + NEBIUS_LIMITS.requestTimeoutMs + NEBIUS_LIMITS.cancelWaitMs) / 1000);
/** The whole run at its longest, cleanup and one recovery pass included: the token must outlast it. */
const NEEDED_SECONDS = PROBE.importSeconds + 60 + 180 + PROBE.prepareSeconds + 60 + PROBE.sessionMinutes * 60 + STOP_SECONDS + 2 * PROBE.cleanupMinutes * 60;
/** Scripts a package manager runs during an install: each needs the repository's sources, which preparation never has. */
const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish"];
const PNPMFILES = [".pnpmfile.cjs", ".pnpmfile.mjs"];

const Config = z.strictObject({
  repository: z.string().min(1),
  baseline: z.string().regex(/^[0-9a-f]{40}$/),
  /** `registryDigest`: what the registry said the tag pointed to when the config was written; a tag can be rebuilt. */
  image: z.strictObject({ tag: z.string().regex(/^[a-z0-9._/-]+:[A-Za-z0-9._-]+$/), tagPrefix: z.string().min(1), registryUrl: z.string().min(1), registryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), node: z.string().regex(/^v\d+\.\d+\.\d+$/) }),
  packageManager: z.string().regex(/^pnpm@\d+\.\d+\.\d+$/),
  installArgs: z.array(z.string().min(1)).min(1),
  inputs: z.array(z.string().regex(/^[A-Za-z0-9._@*-]+(\/[A-Za-z0-9._@*-]+)*$/)).min(1),
  dependencyFolders: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).min(1),
  selections: z
    .array(
      z
        .strictObject({ name: z.string().min(1), command: z.string().min(1), exitCode: z.number().int(), output: z.string().optional(), pattern: z.string().optional() })
        .refine((selection) => (selection.output === undefined) !== (selection.pattern === undefined), "A selection gives its exact output or a pattern, not both."),
    )
    .min(1),
  frozen: z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
type Config = z.infer<typeof Config>;

const git = findGit({ env: process.env });
if (!git) {
  console.error("git isn't installed here. Install it, then try again. Nothing was sent.");
  process.exit(2);
}
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const fail = (text: string): never => {
  console.error(text);
  process.exit(2);
};
const gitIn = (cwd: string, args: string[]) => {
  const ran = spawnSync(git!, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (ran.status !== 0) fail(`git ${args[0]} failed in ${cwd} (${ran.stderr.toString("utf8").trim().split("\n").at(-1) ?? `exit ${String(ran.status)}`}). Nothing was sent.`);
  return ran.stdout;
};

/** The Nivra revision this script runs from, and whether its checkout is clean. */
function revision(): { head: string; clean: boolean } {
  return { head: gitIn(REPOSITORY, ["rev-parse", "HEAD"]).toString("utf8").trim(), clean: gitIn(REPOSITORY, ["status", "--porcelain"]).toString("utf8").trim() === "" };
}

function readConfig(): { config: Config; repo: string } {
  if (!values.config) return fail("Pass --config <file>: the project's environment, outside this repository. Nothing was sent.");
  const path = resolve(values.config);
  if (insideRepository(path, REPOSITORY)) fail(`${path} is inside Nivra's repository; a project's environment lives with the project's work, outside it. Nothing was sent.`);
  const parsed = Config.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) return fail(`${path} isn't an environment Nivra can use: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(top)"}: ${issue.message}`).join("; ")}. Nothing was sent.`);
  const kept = parsed.data.dependencyFolders.filter((name) => !OUTPUT_DIRS.includes(name));
  if (kept.length) fail(`${kept.join(", ")} isn't a folder Nivra keeps apart from source (${OUTPUT_DIRS.join(", ")}), so the session would read it as source. Nothing was sent.`);
  const repo = realpathSync.native(parsed.data.repository);
  if (insideRepository(repo, REPOSITORY)) fail("The project's repository is inside Nivra's own. Nothing was sent.");
  return { config: parsed.data, repo };
}

/** The checkout at its baseline, clean: HEAD and its status, read again after the run. */
function checkoutState(repo: string): string {
  return `${gitIn(repo, ["rev-parse", "HEAD"]).toString("utf8").trim()} ${gitIn(repo, ["status", "--porcelain", "--untracked-files=all"]).toString("utf8")}`;
}

/** A path matches a pattern when each `/`-separated part does; `*` stands for any one part's whole name or its rest. */
const matchesPattern = (pattern: string, path: string) => {
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((part, index) => new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(got[index]!));
};

/**
 * The preparation inputs, from the baseline commit itself: the files the config's patterns name, as one tar,
 * gzip-compressed. Refused when a pattern names nothing, when an input isn't a plain file or is one a snapshot never
 * sends (a secrets file such as .npmrc, or output), when a manifest runs an install lifecycle script or the repository
 * has a pnpmfile (each needs the sources), or when the root manifest pins another package manager.
 */
function preparationInputs(config: Config, repo: string) {
  const tree = gitIn(repo, ["ls-tree", "-r", "-z", "--full-tree", config.baseline]).toString("utf8").split("\0").filter(Boolean);
  const entries = tree.map((line) => {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, type, object] = meta.split(" ") as [string, string, string];
    return { mode, type, object, path };
  });
  for (const name of PNPMFILES) if (entries.some((entry) => entry.path === name)) fail(`The baseline has ${name}, which runs code from the repository's sources during an install. Nivra prepares only from manifests, so it can't prepare this project. Nothing was sent.`);
  const files: Array<{ path: string; bytes: Uint8Array; sha256: string }> = [];
  for (const pattern of config.inputs) {
    const hits = entries.filter((entry) => matchesPattern(pattern, entry.path));
    if (hits.length === 0) fail(`The input ${pattern} names nothing at ${config.baseline.slice(0, 12)}. Correct the config. Nothing was sent.`);
    for (const hit of hits) {
      if (hit.type !== "blob" || (hit.mode !== "100644" && hit.mode !== "100755")) fail(`The input ${hit.path} isn't a plain file at the baseline. Nothing was sent.`);
      // What a snapshot never sends into a boundary, preparation never sends either.
      const hidden = hiddenReason(hit.path);
      if (hidden) fail(`The input ${hit.path} is ${hidden === "secret" ? "on the secrets deny list" : "dependency or build output"}, so it never enters a boundary. Take it out of the config's inputs. Nothing was sent.`);
      if (files.some((file) => file.path === hit.path)) continue;
      const bytes = new Uint8Array(gitIn(repo, ["cat-file", "blob", hit.object]));
      files.push({ path: hit.path, bytes, sha256: sha(bytes) });
    }
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const file of files.filter((entry) => entry.path.split("/").at(-1) === "package.json")) {
    const manifest = JSON.parse(Buffer.from(file.bytes).toString("utf8")) as { scripts?: Record<string, unknown>; packageManager?: unknown };
    const hooks = LIFECYCLE.filter((name) => manifest.scripts && name in manifest.scripts);
    if (hooks.length) fail(`${file.path} runs ${hooks.join(", ")} during an install, which needs the repository's sources. Nivra prepares only from manifests, so it can't prepare this project. Nothing was sent.`);
    if (file.path === "package.json" && manifest.packageManager !== config.packageManager) fail(`The root package.json pins ${String(manifest.packageManager)}, not the config's ${config.packageManager}. Correct the config. Nothing was sent.`);
  }
  if (!files.some((file) => file.path === "package.json")) fail("The inputs must include the root package.json. Nothing was sent.");
  const tar = writeTar(files.map((file) => ({ path: file.path, kind: "file" as const, executable: false, bytes: file.bytes })));
  // Compressed as the session compresses a snapshot: the same tar always gives the same bytes.
  const gzip = compressSnapshot(tar);
  return { files, tar: { bytes: tar.byteLength, sha256: sha(tar) }, gzip: { archive: gzip, bytes: gzip.byteLength, sha256: sha(gzip) } };
}

async function snapshotOf(config: Config, repo: string): Promise<Snapshot> {
  const local = await createLocalBackend({ baseEnv: process.env }).open({ workspace: repo });
  try {
    return await takeSnapshot({ folder: repo, session: local, git: git!, baseline: config.baseline });
  } finally {
    await local.close();
  }
}

/** The frozen files at the baseline, against the hashes the reviewed brief gives: refused when one differs. */
function frozenAtBaseline(config: Config, snapshot: Snapshot): void {
  for (const frozen of config.frozen) {
    const file = snapshot.files.find((entry) => entry.path === frozen.path);
    if (!file) fail(`The frozen file ${frozen.path} isn't in the baseline's snapshot. Nothing was sent.`);
    if (file!.sha256 !== frozen.sha256) fail(`The frozen file ${frozen.path} at the baseline isn't the reviewed one (sha256 ${file!.sha256}). Nothing was sent.`);
  }
}

// ---- the recipe ---------------------------------------------------------------------------------------------------

/** What one approval covers, as data: its digest binds every field. `run` numbers the approvals of one recipe. */
function recipeOf(config: Config, inputs: ReturnType<typeof preparationInputs>, snapshot: Snapshot, at: { head: string; clean: boolean }, run: number) {
  const operations = sessionOperations(config.selections.length);
  const sent = compressSnapshot(snapshot.archive.archive);
  return {
    kind: "nivra.env-probe.v1",
    run,
    revision: at.head,
    config,
    inputs: { files: inputs.files.map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: file.sha256 })), tar: inputs.tar, gzip: { bytes: inputs.gzip.bytes, sha256: inputs.gzip.sha256 } },
    snapshot: { files: snapshot.files.length, bytes: snapshot.files.reduce((sum, file) => sum + file.size, 0), archiveBytes: snapshot.archive.archive.byteLength, archiveSha256: snapshot.archive.sha256, sentBytes: sent.byteLength, sentSha256: sha(sent), listingDigest: snapshot.archive.listingDigest, leftOut: { secret: snapshot.leftOut.secret.sample, output: snapshot.leftOut.output.sample, submodule: snapshot.leftOut.submodule.sample, counts: [snapshot.leftOut.secret.count, snapshot.leftOut.output.count, snapshot.leftOut.submodule.count] } },
    limits: { ...PROBE, sessionOperations: operations, stopSeconds: STOP_SECONDS, neededSeconds: NEEDED_SECONDS },
    operations: [
      `image: GET /v1/images?tag=${config.image.tagPrefix}; the public ${config.image.tag} is used if listed with exactly that tag, otherwise POST /v1/images/import of ${config.image.registryUrl} (untagged, so private), read every ${PROBE.pollSeconds} s to its end (timeout ${PROBE.importSeconds} s)`,
      `preparation, networking ON: the inputs uploaded; ${config.image.tag} runs Nivra's fixed preparation script: corepack enable, corepack prepare ${config.packageManager} --activate, prints node, pnpm and uname -m, then pnpm install ${config.installArgs.join(" ")} in /workspace, its log kept outside the workspace and only its end printed; kept, its result image is the environment; read every ${PROBE.pollSeconds} s (timeout ${PROBE.prepareSeconds} s)`,
      `session from the prepared image, networking off: the snapshot uploaded and overlaid on /workspace, its listing checked with ${config.dependencyFolders.join(", ")} left out (timeout ${PROBE.overlaySeconds} s)`,
      `toolchain, networking off: node --version and pnpm --version must print ${config.image.node} and ${config.packageManager.slice("pnpm@".length)}, changes thrown away (timeout ${PROBE.toolchainSeconds} s)`,
      ...config.selections.map((selection) => `baseline ${selection.name}, networking off, changes thrown away (timeout ${PROBE.selectionSeconds} s)`),
      `collect, networking off: the workspace archived and listed with ${config.dependencyFolders.join(", ")} left out, both read back; the result must be exactly the commit (timeout ${PROBE.collectSeconds} s)`,
    ],
    network: `on for the preparation only, from the sandbox to the npm registry (corepack's download of ${config.packageManager} and the lockfile's packages); the import is the provider's own pull from the public registry`,
    sends: [
      "to Nebius: the import request (a public registry address); the preparation inputs above; the snapshot of the commit above (tracked files only, after the credential scan); the commands' text",
      "never: credentials, the engine home, Nivra's preferences, any file the snapshot leaves out",
    ],
    never: ["a model call", "a retry", "a tag or any other change to an image", "a second run under this approval"],
    failure: "Whatever the run gives is recorded as it is. No retake under this approval; another run needs another approval.",
  };
}
const digestOf = (recipe: object) => sha(canonicalJson(recipe));

function recipeText(recipe: ReturnType<typeof recipeOf>, digest: string, clean: boolean): string {
  const config = recipe.config;
  return [
    `Nebius environment feasibility probe (NIV-49), run ${recipe.run} of this recipe. Nothing in --plan touches the network.`,
    "",
    `Revision: ${recipe.revision}${clean ? "" : " (the checkout has uncommitted changes: --run refuses until it is clean)"}`,
    `Repository: ${config.repository} at ${config.baseline}`,
    `Image: ${config.image.tag} (${config.image.registryUrl}; the registry listed it as ${config.image.registryDigest} when the config was written, and an official tag can be rebuilt), Node ${config.image.node}; package manager ${config.packageManager}`,
    `Install: pnpm install ${config.installArgs.join(" ")}; dependency folders: ${config.dependencyFolders.join(", ")}`,
    `Preparation inputs (${recipe.inputs.files.length} files; tar ${recipe.inputs.tar.bytes} bytes, sha256 ${recipe.inputs.tar.sha256}; sent as gzip, ${recipe.inputs.gzip.bytes} bytes, sha256 ${recipe.inputs.gzip.sha256}):`,
    ...recipe.inputs.files.map((file) => `  ${String(file.bytes).padStart(7)} B  ${file.sha256.slice(0, 16)}  ${file.path}`),
    `Snapshot: ${recipe.snapshot.files} files, ${recipe.snapshot.bytes} bytes; tar ${recipe.snapshot.archiveBytes} bytes, sha256 ${recipe.snapshot.archiveSha256}; sent as gzip, ${recipe.snapshot.sentBytes} bytes, sha256 ${recipe.snapshot.sentSha256}; listing ${recipe.snapshot.listingDigest}`,
    `Left out of the snapshot, never sent: ${recipe.snapshot.leftOut.counts[0]} on the secrets deny list (${recipe.snapshot.leftOut.secret.join(", ") || "none"}), ${recipe.snapshot.leftOut.counts[1]} output, ${recipe.snapshot.leftOut.counts[2]} submodule`,
    `Frozen files, checked at the baseline before anything is sent:`,
    ...config.frozen.map((file) => `  ${file.sha256}  ${file.path}`),
    "",
    "Operations, one at a time:",
    ...recipe.operations.map((operation, index) => `  ${index + 1}. ${operation}`),
    "",
    "Baseline selections, each run once as /bin/sh -c in /workspace:",
    ...config.selections.flatMap((selection) => [
      `  ${selection.name}: exit ${selection.exitCode}, ${selection.output !== undefined ? "output exactly:" : `output matching /${selection.pattern}/`}`,
      ...(selection.output !== undefined ? selection.output.replace(/\n$/, "").split("\n").map((line) => `      ${line.replace(/\t/g, " <tab> ")}`) : []),
      `      command: ${selection.command}`,
    ]),
    "",
    `Bounds: the session has ${PROBE.sessionMinutes} minutes and at most ${recipe.limits.sessionOperations} operations; stopping a command already under way may take ${STOP_SECONDS} s more; closing has ${PROBE.cleanupMinutes} minutes of its own, then one --recover pass over what is left, ${PROBE.cleanupMinutes} minutes more.`,
    `At its longest, the whole run takes ${Math.ceil(NEEDED_SECONDS / 60)} minutes, cleanup and one recovery pass included. Before anything is sent, it reads the account twice, 15 s apart (GET /v1/whoami), and starts only if the token outlasts that.`,
    `Network: ${recipe.network}.`,
    ...recipe.sends.map((line) => `Sends ${line}.`),
    `Retention: ${RETENTION}`,
    "No model is called, so no tokens are used. Cost: unknown in advance; the service's own usage figures are recorded raw, never converted to money.",
    `Never: ${recipe.never.join("; ")}.`,
    recipe.failure,
    "Evidence: ~/nivra-acceptance/env-probe-<UTC>/ (0700). Close the Nivra app first: the probe fails if ~/.nivra changed.",
    "",
    `Digest: ${digest}`,
  ].join("\n");
}

async function prepared() {
  const { config, repo } = readConfig();
  const at = revision();
  if (gitIn(repo, ["rev-parse", "HEAD"]).toString("utf8").trim() !== config.baseline) fail(`${repo} isn't at the baseline ${config.baseline}. Check it out there, then try again. Nothing was sent.`);
  if (gitIn(repo, ["status", "--porcelain", "--untracked-files=all"]).toString("utf8").trim() !== "") fail(`${repo} has uncommitted changes. The probe sends only the baseline commit, so clean it first. Nothing was sent.`);
  const inputs = preparationInputs(config, repo);
  const snapshot = await snapshotOf(config, repo);
  frozenAtBaseline(config, snapshot);
  for (let run = 1; ; run++) {
    const recipe = recipeOf(config, inputs, snapshot, at, run);
    const digest = digestOf(recipe);
    if (!claimOn(CLAIMS, digest).claimed) return { config, repo, at, inputs, snapshot, recipe, digest };
  }
}

if (values.plan) {
  const { recipe, digest, at } = await prepared();
  console.log(recipeText(recipe, digest, at.clean));
  process.exit(0);
}

// ---- credentials, and the evidence's masking -----------------------------------------------------------------------

function credentials(): { key: string; project: string } {
  if (!values.credentials) return fail("Pass --credentials <file>: a file only you can read, outside the repository, with NEBIUS_API_KEY=… and NEBIUS_PROJECT_ID=… lines. Nothing was sent.");
  const path = resolve(values.credentials);
  if (insideRepository(path, REPOSITORY)) fail(`${path} is inside the repository, where it could be committed. Move it outside (for example to ~/.config/nivra/), then try again. Nothing was sent.`);
  if (!existsSync(path)) fail(`There's no file at ${path}. Create it with NEBIUS_API_KEY=… and NEBIUS_PROJECT_ID=… lines, run chmod 600 on it, then try again. Nothing was sent.`);
  const real = realpathSync.native(path);
  const mode = statSync(real).mode & 0o777;
  if ((mode & 0o077) !== 0) fail(`${path} can be read by others (mode ${mode.toString(8)}). Run chmod 600 on it, then try again. Nothing was sent.`);
  const parsed = parseEnv(readFileSync(real, "utf8"));
  const key = parsed["NEBIUS_API_KEY"]?.trim();
  const project = parsed["NEBIUS_PROJECT_ID"]?.trim();
  if (!key || !project) return fail(`NEBIUS_API_KEY and NEBIUS_PROJECT_ID must both be set in ${path}. Nothing was sent.`);
  return { key, project };
}

if (!values.run && !values.recover) fail("Choose --plan, --run --approved <digest>, or --recover <folder>.");
const evidenceRoot = resolve(values.evidence ?? join(homedir(), "nivra-acceptance"));
if (insideRepository(evidenceRoot, REPOSITORY)) fail(`${evidenceRoot} is inside the repository, where evidence could be committed. Choose a folder outside it. Nothing was sent.`);
const keys = credentials();
delete process.env["NEBIUS_API_KEY"];
delete process.env["NEBIUS_PROJECT_ID"];
const safe = (text: string) => text.split(keys.key).join("[key]").split(keys.project).join("[project]");
const write = (path: string, value: unknown) => writeFileSync(path, `${safe(typeof value === "string" ? value : JSON.stringify(value, null, 2))}\n`, { mode: 0o600 });
const started = performance.now();
const log = (line: string) => console.log(`${String(Math.round(performance.now() - started)).padStart(8)} ms  ${safe(line)}`);
const LIMITS = (operations: number) => ({ ...NEBIUS_LIMITS, maxOperations: operations, maxTimeoutSeconds: PROBE.selectionSeconds, prepareTimeoutSeconds: PROBE.overlaySeconds, sessionBudgetMs: PROBE.sessionMinutes * 60_000, cleanupBudgetMs: PROBE.cleanupMinutes * 60_000 });

if (values.recover) {
  const folder = resolve(values.recover);
  const settling = new AbortController();
  process.on("SIGINT", () => {
    if (settling.signal.aborted) process.exit(130);
    settling.abort();
    log("Stopping: what is still open stays in the journal for the next --recover.");
  });
  const scan = scanJournals(join(folder, "journals"));
  log(`Settling what ${folder} left open (${scan.open.length} journal${scan.open.length === 1 ? "" : "s"}), within ${PROBE.cleanupMinutes} minutes.`);
  const passes = await reconcileJournals(scan.open, { credentials: keys, budgetMs: PROBE.cleanupMinutes * 60_000, signal: settling.signal, limits: LIMITS(1) });
  write(join(folder, `recover-${Date.now()}.json`), passes);
  const unresolved = passes.flatMap((pass) => pass.unresolved);
  log(`stopped ${passes.flatMap((pass) => pass.stopped).length}; already ended ${passes.flatMap((pass) => pass.alreadyEnded).length}; unresolved ${unresolved.length}${unresolved.length ? `: ${unresolved.join("; ")}` : ""}`);
  process.exit(unresolved.length ? 1 : 0);
}

// ---- the run --------------------------------------------------------------------------------------------------------

/** A folder's names, kinds, modes, sizes and times: equal states mean nothing changed. */
function folderState(root: string): Map<string, string> | null {
  if (!existsSync(root)) return null;
  const state = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path, { bigint: true });
      state.set(relative(root, path), `${info.mode} ${info.size} ${info.mtimeNs}`);
      if (info.isDirectory()) walk(path);
    }
  };
  walk(root);
  return state;
}
const changed = (before: Map<string, string> | null, after: Map<string, string> | null) =>
  before === null || after === null ? (before === after ? [] : ["(the folder appeared or went)"]) : [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));

const approved = values.approved ?? "";
if (!isDigest(approved)) fail("--run needs --approved <digest>: the 64 lowercase hexadecimal characters --plan printed. Nothing was sent.");
const plan = await prepared();
if (!plan.at.clean) fail("Nivra's checkout has uncommitted changes, so the code that would run isn't the approved revision. Commit or set them aside, then print the recipe again. Nothing was sent.");
if (plan.digest !== approved) fail(`The next unclaimed run of this recipe digests to ${plan.digest}, not the approved ${approved}: it is claimed already, or something changed. Print the recipe with --plan and ask for its approval again. Nothing was sent.`);

const work = new AbortController();
const settling = new AbortController();
let interrupts = 0;
let folder: string | null = null;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts === 1) {
    work.abort(new Error("Interrupted"));
    log(`Interrupted: the work stops at once, and closing settles what it started, within ${PROBE.cleanupMinutes} minutes. Press Ctrl+C again to stop that and leave it to --recover.`);
  } else if (interrupts === 2) {
    settling.abort();
    log(`Stopping cleanup: what is still open is in the journal.${folder ? ` Run --recover ${folder}.` : ""}`);
  } else process.exit(130);
});

const reads = new SandboxApi(fetchTransport(keys), { requestTimeoutMs: 30_000, signal: work.signal });
const soon = () => ({ until: performance.now() + 120_000 });
const needed = NEEDED_SECONDS;
let token;
try {
  const first = { whoami: await reads.whoami(soon()), atMs: Date.now() };
  await new Promise<void>((done, failed) => {
    const timer = setTimeout(done, 15_000);
    work.signal.addEventListener("abort", () => (clearTimeout(timer), failed(new Error("Interrupted"))), { once: true });
  });
  token = tokenOutlasts(first, { whoami: await reads.whoami(soon()), atMs: Date.now() }, needed);
} catch (error) {
  console.error(`${work.signal.aborted ? "Interrupted while reading the account" : `Reading the account failed (${safe(error instanceof Error ? error.message : String(error))})`}, before anything was started. Nothing was sent but the reads.`);
  process.exit(work.signal.aborted ? 130 : 2);
}
if (!token.ok) fail(`Your token ${token.expiresAt ? `expires at ${token.expiresAt}` : "didn't say when it expires"}, and the probe with its cleanup can take ${Math.ceil(needed / 60)} minutes. Create a key that stays valid for at least ${Math.ceil(needed / 60) + 10} minutes, put it in the credentials file, then try again. Nothing was started.`);

folder = join(evidenceRoot, `env-probe-${new Date().toISOString().replace(/[:.]/g, "")}`);
mkdirSync(join(folder, "journals"), { recursive: true, mode: 0o700 });
const claimed = claimApproval(CLAIMS, { digest: plan.digest, run: plan.recipe.run, revision: plan.at.head, out: folder, pid: process.pid, claimedAt: new Date().toISOString() });
if (!claimed.ok) fail("This approval was claimed by another run first. Nothing was sent.");
write(join(folder, "recipe.txt"), recipeText(plan.recipe, plan.digest, true));
const checkoutBefore = checkoutState(plan.repo);
const home = join(homedir(), ".nivra");
const homeBefore = folderState(home);
const spawns: Array<{ networking: boolean; image: string; label: string }> = [];
const imports: string[] = [];
const watched = (inner: Transport): Transport => async (request) => {
  if (request.method === "POST" && request.path === "/v1/instances") {
    const body = JSON.parse(String(request.body)) as { networking?: { enabled?: boolean }; image?: string; args?: string[] };
    spawns.push({ networking: body.networking?.enabled === true, image: String(body.image), label: body.args?.[0] === "-c" ? String(body.args[2] ?? "command") : "command" });
  }
  if (request.method === "POST" && request.path === "/v1/images/import") imports.push(String(request.body));
  return inner(request);
};
const operations = sessionOperations(plan.config.selections.length);
const api = new SandboxApi(watched(fetchTransport(keys)), { requestTimeoutMs: NEBIUS_LIMITS.requestTimeoutMs, signal: work.signal });
log(`Revision ${plan.at.head}. Recipe ${plan.digest.slice(0, 12)}, run ${plan.recipe.run}, claimed. ${plan.repo} at ${plan.config.baseline.slice(0, 12)}.`);
const outcome = await runEnvProbe({
  api,
  journal: new Journal(join(folder, "journals", "environment.jsonl")),
  backendFor: (image) => createNebiusBackend({ credentials: () => keys, baseImage: image, journalDir: join(folder!, "journals"), limits: LIMITS(operations), transport: (given) => watched(fetchTransport(given)) }),
  snapshot: plan.snapshot,
  inputs: plan.inputs.gzip.archive,
  pin: { tag: plan.config.image.tag, tagPrefix: plan.config.image.tagPrefix, registryUrl: plan.config.image.registryUrl, node: plan.config.image.node, packageManager: plan.config.packageManager, installArgs: plan.config.installArgs },
  selections: plan.config.selections,
  dependencyFolders: plan.config.dependencyFolders,
  limits: { importSeconds: PROBE.importSeconds, prepareSeconds: PROBE.prepareSeconds, toolchainSeconds: PROBE.toolchainSeconds, selectionSeconds: PROBE.selectionSeconds, collectSeconds: PROBE.collectSeconds, sessionMs: PROBE.sessionMinutes * 60_000, closeMs: PROBE.cleanupMinutes * 60_000, pollMs: PROBE.pollSeconds * 1000 },
  signal: work.signal,
  closeSignal: settling.signal,
  log,
});

// What the import or the preparation may have left running, settled by one bounded pass.
const left = scanJournals(join(folder, "journals"));
const settled = left.open.length ? await reconcileJournals(left.open, { credentials: keys, budgetMs: PROBE.cleanupMinutes * 60_000, signal: settling.signal, limits: LIMITS(1) }) : [];
const unresolved = [...(outcome.cleanup?.unresolved ?? []), ...settled.flatMap((pass) => pass.unresolved)];

const checks: Array<{ check: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ check: name, pass, detail });
const sessionSpawns = spawns.filter((spawn) => spawn.label !== "nivra-env-prepare");
check("the probe ran every step", outcome.stopped === null, outcome.stopped ?? "image, preparation, session, toolchain, selections, collect");
check("the base image is the pinned one", outcome.base !== null && outcome.base.image !== null && (outcome.base.from === "public" || outcome.base.status === "SUCCESS"), outcome.base ? `${outcome.base.from}: ${outcome.base.image ?? "no image"}${outcome.base.operation ? `, operation ${outcome.base.operation} ${outcome.base.status ?? ""}` : ""}` : "not reached");
check("the preparation installed with the pinned versions", outcome.prepared?.status === "SUCCESS" && outcome.prepared.exitCode === 0 && outcome.prepared.printed["node"] === plan.config.image.node && outcome.prepared.printed["pnpm"] === plan.config.packageManager.slice("pnpm@".length), outcome.prepared ? `${outcome.prepared.status}, exit ${String(outcome.prepared.exitCode)}, node ${outcome.prepared.printed["node"] ?? "?"}, pnpm ${outcome.prepared.printed["pnpm"] ?? "?"}, ${outcome.prepared.printed["arch"] ?? "?"}, image ${outcome.prepared.image ?? "none"}` : "not reached");
check("networking was on for the preparation only", spawns.filter((spawn) => spawn.networking).length <= 1 && spawns.filter((spawn) => spawn.networking).every((spawn) => spawn.label === "nivra-env-prepare"), `${spawns.length} spawns, ${spawns.filter((spawn) => spawn.networking).length} with networking on (${spawns.filter((spawn) => spawn.networking).map((spawn) => spawn.label).join(", ") || "none"})`);
check("the session started from the prepared image", outcome.opened && sessionSpawns[0]?.image === outcome.prepared?.image, outcome.opened ? `first session spawn from ${sessionSpawns[0]?.image ?? "?"}` : "the session didn't open");
check("the toolchain ran with networking off", outcome.toolchain?.matches === true, outcome.toolchain ? `exit ${String(outcome.toolchain.exitCode)}: ${JSON.stringify(outcome.toolchain.stdout.slice(0, 80))}` : "not reached");
for (const selection of plan.config.selections) {
  const result = outcome.selections.find((entry) => entry.name === selection.name);
  check(`baseline ${selection.name} is as the brief expects`, result?.matches === true, result ? `exit ${String(result.exitCode)}; ${result.stdout.split("\n").filter(Boolean).length} lines` : "not reached");
}
check("collect gave exactly the commit, without dependencies", outcome.collect !== null && outcome.collect.integrity === null && outcome.collect.dependencyEntries === 0, outcome.collect ? `${outcome.collect.entries} entries, ${outcome.collect.dependencyEntries} under ${plan.config.dependencyFolders.join(", ")}; ${outcome.collect.integrity ?? "exactly the commit"}` : "not reached");
check("the frozen files are the reviewed ones", true, `${plan.config.frozen.length} checked at the baseline before anything was sent`);
check("no more operations than the recipe allows", spawns.length <= 1 + operations && imports.length <= 1, `${imports.length} import(s), ${spawns.length} spawns, at most 1 and ${1 + operations}`);
check("the project's checkout is unchanged", checkoutState(plan.repo) === checkoutBefore, "HEAD and status, before and after");
check("the release engine home (~/.nivra) is unchanged", changed(homeBefore, folderState(home)).length === 0, changed(homeBefore, folderState(home)).slice(0, 5).join(", ") || "every name, mode, size and time");
check("cleanup left nothing unresolved", outcome.cleanup !== null && unresolved.length === 0, `${outcome.cleanup ? `stopped ${outcome.cleanup.stopped.length}, already ended ${outcome.cleanup.alreadyEnded.length}` : "no session closed"}; unresolved ${unresolved.length}${unresolved.length ? `: ${unresolved.join("; ")}` : ""}`);

write(join(folder, "result.json"), outcome);
write(join(folder, "spawns.json"), { spawns, imports });
write(join(folder, "checks.json"), { revision: plan.at, digest: plan.digest, checks, settled });
const failed = checks.filter((entry) => !entry.pass);
write(
  join(folder, "summary.md"),
  [
    `# Nebius environment feasibility probe, ${new Date().toISOString()}`,
    "",
    `Revision ${plan.at.head}; recipe ${plan.digest}, run ${plan.recipe.run}. Checks: ${checks.length - failed.length} of ${checks.length} passed.`,
    "",
    ...checks.map((entry) => `- ${entry.check}: **${entry.pass ? "pass" : "fail"}** (${entry.detail})`),
    "",
    "## Recorded, not judged",
    "",
    `- images with tags starting ${plan.config.image.tagPrefix}: ${outcome.images.map((image) => image.tag ?? image.uuid).join(", ") || "none"}`,
    `- the machine the preparation ran on: ${outcome.prepared?.printed["arch"] ?? "not reported"}; its usage: ${JSON.stringify(outcome.prepared?.usage ?? null)}`,
    ...outcome.selections.map((result) => `- ${result.name}: ${result.durationMs ?? "?"} ms; its output:\n\n\`\`\`text\n${result.stdout}\n\`\`\``),
    "",
    `Retention: ${RETENTION}`,
  ].join("\n"),
);
log(`${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `; failed: ${failed.map((entry) => entry.check).join("; ")}` : ""}. Evidence: ${folder}`);
process.exit(interrupts ? 130 : failed.length ? 1 : 0);
