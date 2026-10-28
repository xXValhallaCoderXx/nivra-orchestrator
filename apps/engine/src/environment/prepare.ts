import { createHash } from "node:crypto";
import { ENVIRONMENT_BASE, VERIFIED_FORMAT, VerifiedToolRecord, type BuildsState, type EnvironmentRecipe, type EnvironmentStopCode, type SandboxStep, type VerifiedTool } from "@nivra/domain";
import { SandboxCancelledError, SandboxHttpError, SandboxNetworkError, SandboxNotSentError, SandboxTooLargeError, type SandboxApi } from "../exec/nebius/api.ts";
import { ENV_PATH, type Journal, type Outcome, type Sandbox } from "../exec/nebius/sandbox.ts";
import { bootstrapFailure, ignoredBuilds, imageFacts, INSPECT_SCRIPT, installDiagnosis, preparedFacts, READINESS_FILES, READINESS_SCRIPT, readinessFacts } from "./scripts.ts";
import { versionParts } from "./versions.ts";

/**
 * An environment's preparation, inside Nebius (NIV-49, D41), as the feasibility probe proved it on 27 October:
 * 1. the pinned Node image: a public one with exactly its tag, or the import of it into this project, untagged;
 * 2. the inputs uploaded, journaled first, since the provider may keep them whatever happens next;
 * 3. the preparation, the one operation with networking on: corepack activates the pinned pnpm, then the frozen
 *    install. Its result image is the environment, kept only when the versions are the pinned ones and the install
 *    said it finished.
 * Nothing is retried. A start whose answer was lost is never sent again: the preparation ends uncertain.
 */

export interface PrepareRun {
  api: SandboxApi;
  sandbox: Sandbox;
  journal: Journal;
  /** The inputs, as one gzip-compressed tar. */
  archive: Uint8Array;
  /** pnpm@x.y.z */
  packageManager: string;
  installArgs: string[];
  limits: { importSeconds: number; prepareSeconds: number };
  /** The latest a read may end, on the monotonic clock. */
  until: () => number;
  signal: AbortSignal;
  progress: (message: string) => void;
  wallNow?: () => Date;
}

export interface PrepareOutcome {
  prepared: { image: string; base: { tag: string; image: string; imported: boolean }; node: string; pnpm: string; arch: string } | null;
  stopped: { code: EnvironmentStopCode; step: string } | null;
  steps: SandboxStep[];
  /** The install's exit code and the end of what it printed; null when it never ran. */
  install: { exitCode: number | null; logTail: string } | null;
}

const tail = (text: string, max: number) => (text.length > max ? text.slice(-max) : text);

/** An operation's record as a report gives it. */
function stepOf(label: string, outcome: Outcome, persisted: boolean): SandboxStep {
  const durationSeconds = (outcome.usage as { durationSeconds?: unknown }).durationSeconds;
  return {
    label,
    exitCode: outcome.exitCode,
    signal: outcome.signal === null ? null : String(outcome.signal).slice(0, 32),
    timedOut: outcome.timedOut,
    cancelled: outcome.verdict === "cancelled",
    truncated: outcome.stdoutTruncated || outcome.stderrTruncated,
    persisted,
    durationMs: typeof durationSeconds === "number" ? Math.round(durationSeconds * 1000) : null,
    status: outcome.status,
    usage: outcome.usage,
    stdoutTail: tail(outcome.stdout, 2_000),
    stderrTail: tail(outcome.stderr, 2_000),
  };
}

/** The versions and machine the preparation script prints, by name. */
function printedBy(stdout: string): Record<string, string> {
  const printed: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^(node|pnpm|arch) (\S+)$/.exec(line.trim());
    if (match && !(match[1]! in printed)) printed[match[1]!] = match[2]!;
  }
  return printed;
}

export async function prepareIn(run: PrepareRun): Promise<PrepareOutcome> {
  const steps: SandboxStep[] = [];
  let install: PrepareOutcome["install"] = null;
  let at = "image";
  const wall = () => (run.wallNow ?? (() => new Date()))().toISOString();
  const stopped = (code: EnvironmentStopCode): PrepareOutcome => ({ prepared: null, stopped: { code, step: at }, steps, install });
  try {
    // 1. The pinned image: public with exactly its tag, or imported into this project.
    const listed = (await run.api.images({ until: run.until(), tag: ENVIRONMENT_BASE.tag, limit: 1000 })) as { images?: Array<{ uuid?: unknown; tag?: unknown }> } | null;
    const exact = (listed?.images ?? []).find((image) => image.tag === ENVIRONMENT_BASE.tag && typeof image.uuid === "string");
    let base: { tag: string; image: string; imported: boolean };
    if (exact) {
      base = { tag: ENVIRONMENT_BASE.tag, image: exact.uuid as string, imported: false };
      run.progress(`Image: the public ${ENVIRONMENT_BASE.tag}.`);
    } else {
      run.progress(`Image: importing ${ENVIRONMENT_BASE.tag} into your Nebius project, as a private image.`);
      const started = await run.sandbox.importImage({ registryUrl: ENVIRONMENT_BASE.registryUrl, timeoutSeconds: run.limits.importSeconds });
      if (!("operationId" in started)) return stopped("uncertain");
      const ended = await run.sandbox.observe(started.operationId, run.limits.importSeconds);
      steps.push(stepOf("image import", ended, true));
      if (ended.verdict === "cancelled") return stopped("cancelled");
      if (ended.status !== "SUCCESS" || !ended.resultImage) return stopped("image");
      base = { tag: ENVIRONMENT_BASE.tag, image: ended.resultImage, imported: true };
    }

    // 2. The inputs, journaled before they are sent.
    at = "upload";
    const sent = createHash("sha256").update(run.archive).digest("hex");
    run.journal.append({ kind: "upload", wall: wall(), sha256: sent, bytes: run.archive.byteLength });
    const uploaded = await run.api.upload(run.archive, { until: run.until() });
    run.journal.append({ kind: "uploaded", wall: wall(), uuid: uploaded.uuid });
    // Bytes the sandbox stored that aren't the ones sent would prepare from other manifests: nothing is prepared from them.
    if (uploaded.sha256 !== null && uploaded.sha256 !== sent) return stopped("sandbox-failed");

    // 3. The preparation, networking on, declared.
    at = "install";
    run.progress(`Installing with ${run.packageManager}, networking on: pnpm install ${run.installArgs.join(" ")}`);
    const submitted = await run.sandbox.prepareEnvironment({ image: base.image, inputs: { uuid: uploaded.uuid }, packageManager: run.packageManager, installArgs: run.installArgs, timeoutSeconds: run.limits.prepareSeconds });
    if (!("operationId" in submitted)) return stopped("uncertain");
    const ended = await run.sandbox.observe(submitted.operationId, run.limits.prepareSeconds);
    steps.push(stepOf("preparation", ended, true));
    install = { exitCode: ended.exitCode, logTail: tail(ended.stderr ? `${ended.stdout}\n${ended.stderr}` : ended.stdout, 8_000) };
    if (ended.verdict === "cancelled") return stopped("cancelled");
    if (ended.verdict === "command-failed" || ended.verdict === "timed-out") return stopped("install");
    if (ended.verdict !== "passed" || !ended.resultImage) return stopped("sandbox-failed");
    if (!ended.stdout.split("\n").includes("installed")) return stopped("install");
    const printed = printedBy(ended.stdout);
    if (printed["node"] !== ENVIRONMENT_BASE.node || printed["pnpm"] !== run.packageManager.slice("pnpm@".length) || !printed["arch"]) return stopped("versions");
    return { prepared: { image: ended.resultImage, base, node: printed["node"], pnpm: printed["pnpm"], arch: printed["arch"] }, stopped: null, steps, install };
  } catch (error) {
    if (run.signal.aborted || error instanceof SandboxCancelledError) return stopped("cancelled");
    return stopped("sandbox-failed");
  }
}

/**
 * A project-driven recipe's preparation (NIV-55), inside Nebius:
 * 1. its base image: a public one with exactly the recipe's tag, or the import of it into this project, untagged;
 * 2. an inspect step on that image, networking off: Node, npm, corepack, the machine and libc. A recipe the image doesn't
 *    match stops here, before anything is uploaded;
 * 3. the setup configuration uploaded, journaled first;
 * 4. the preparation, the one operation with networking on: npm's pin and pnpm's activation as the recipe says, then
 *    the frozen install, then which dependency builds pnpm didn't run;
 * 5. a readiness step on the prepared image, networking off, with the task operations' own variables: the tools a
 *    session needs, the versions again, and the switches pnpm must read back;
 * 6. the verified tool record: what was found, written once. The recipe is never changed by it.
 * Nothing is retried. A start whose answer was lost is never sent again: the preparation ends uncertain.
 */
export interface RecipeRun {
  api: SandboxApi;
  sandbox: Sandbox;
  journal: Journal;
  /** The setup configuration, as one gzip-compressed tar. */
  archive: Uint8Array;
  recipe: EnvironmentRecipe;
  recipeDigest: string;
  /** The lockfile's packages with install scripts: what npm's ignore-scripts leaves unbuilt. */
  installScripts: readonly string[];
  until: () => number;
  signal: AbortSignal;
  progress: (message: string) => void;
  wallNow?: () => Date;
  now?: () => number;
}

export interface RecipeOutcome {
  prepared: { image: string; verified: VerifiedToolRecord } | null;
  stopped: { code: EnvironmentStopCode; step: string; detail: string | null } | null;
  steps: SandboxStep[];
  install: { exitCode: number | null; logTail: string } | null;
}

/** The settings the readiness step reads back from pnpm, by major: those that keep it from installing or switching. */
function settingsToRead(major: number): string[] {
  if (major <= 9) return [];
  if (major === 10) return ["verify-deps-before-run", "manage-package-manager-versions"];
  if (major === 11) return ["verify-deps-before-run", "pm-on-fail"];
  return ["verify-deps-before-run", "pm-on-fail", "manage-package-manager-versions"];
}

export async function prepareRecipe(run: RecipeRun): Promise<RecipeOutcome> {
  const steps: SandboxStep[] = [];
  let install: RecipeOutcome["install"] = null;
  let at = "image";
  const wall = () => (run.wallNow ?? (() => new Date()))().toISOString();
  const now = run.now ?? (() => performance.now());
  const stopped = (code: EnvironmentStopCode, detail: string | null = null): RecipeOutcome => ({ prepared: null, stopped: { code, step: at, detail: detail === null ? null : detail.slice(0, 600) }, steps, install });
  const recipe = run.recipe;
  const manager = recipe.install.tool;
  if (manager !== "npm" && manager !== "pnpm") return stopped("fault", `This Nivra can't prepare a recipe installed with ${manager}.`);
  const want = (name: string) => recipe.tools.find((tool) => tool.name === name)?.version ?? null;
  const exactOf = (name: string) => {
    const version = want(name);
    return version?.kind === "exact" ? version.version : null;
  };
  const node = exactOf("node");
  if (node === null) return stopped("fault", "The recipe doesn't name an exact Node version.");
  const pnpmBootstrap = recipe.bootstrap.find((step) => step.tool === "pnpm") ?? null;
  const npmBootstrap = recipe.bootstrap.find((step) => step.tool === "npm") ?? null;
  const npmFromImage = recipe.tools.find((tool) => tool.name === "npm")?.from === "image" ? exactOf("npm") : null;
  try {
    // 1. The base image: public with exactly the recipe's tag, or imported into this project.
    const listed = (await run.api.images({ until: run.until(), tag: recipe.image.tag, limit: 1000 })) as { images?: Array<{ uuid?: unknown; tag?: unknown }> } | null;
    const exact = (listed?.images ?? []).find((image) => image.tag === recipe.image.tag && typeof image.uuid === "string");
    let base: { image: string; imported: boolean };
    if (exact) {
      base = { image: exact.uuid as string, imported: false };
      run.progress(`Image: the public ${recipe.image.tag}.`);
    } else {
      run.progress(`Image: importing ${recipe.image.tag} into your Nebius project, as a private image.`);
      const started = await run.sandbox.importImage({ registryUrl: recipe.image.registryUrl, timeoutSeconds: recipe.limits.importSeconds });
      if (!("operationId" in started)) return stopped("uncertain");
      const ended = await run.sandbox.observe(started.operationId, recipe.limits.importSeconds);
      steps.push(stepOf("image import", ended, true));
      if (ended.verdict === "cancelled") return stopped("cancelled");
      if (ended.status !== "SUCCESS" || !ended.resultImage) return stopped("image", `Nebius couldn't import ${recipe.image.tag}. Docker Hub may have no image with that tag.`);
      base = { image: ended.resultImage, imported: true };
    }

    // 2. What the image holds, networking off, before anything is uploaded.
    at = "inspect";
    const inspectStarted = now();
    const inspect = await run.sandbox.submit({ label: "environment inspect", command: "/bin/sh", args: ["-c", INSPECT_SCRIPT, "nivra-env-inspect"], image: base.image, disposable: true, timeoutSeconds: Math.min(120, recipe.limits.probeSeconds), env: { PATH: ENV_PATH, HOME: "/root" } });
    if (!("operationId" in inspect)) return stopped("uncertain");
    const looked = await run.sandbox.observe(inspect.operationId, Math.min(120, recipe.limits.probeSeconds));
    steps.push(stepOf("image inspect", looked, false));
    if (looked.verdict === "cancelled") return stopped("cancelled");
    if (looked.verdict !== "passed") return stopped("inspect", "The image couldn't run Nivra's inspect step.");
    const inspectMs = Math.round(now() - inspectStarted);
    const facts = imageFacts(looked.stdout);
    const differences = [
      facts.node !== node ? `Node ${facts.node ?? "isn't there"}, not ${node}` : null,
      facts.arch !== recipe.platform.arch ? `a ${facts.arch ?? "different"} machine, not ${recipe.platform.arch}` : null,
      facts.libc !== recipe.platform.libc ? `${facts.libc ?? "an unknown"} libc, not ${recipe.platform.libc}` : null,
      npmFromImage !== null && facts.npm !== npmFromImage ? `npm ${facts.npm ?? "isn't there"}, not ${npmFromImage}` : null,
      pnpmBootstrap?.via === "corepack" && facts.corepack === null ? "no corepack, which the recipe activates pnpm with" : null,
    ].filter((item): item is string => item !== null);
    if (differences.length) return stopped("inspect", `${recipe.image.tag} holds ${differences.join(", ")}.`);

    // 3. The setup configuration, journaled before it is sent.
    at = "upload";
    const sent = createHash("sha256").update(run.archive).digest("hex");
    run.journal.append({ kind: "upload", wall: wall(), sha256: sent, bytes: run.archive.byteLength });
    const uploaded = await run.api.upload(run.archive, { until: run.until() });
    run.journal.append({ kind: "uploaded", wall: wall(), uuid: uploaded.uuid });
    if (uploaded.sha256 !== null && uploaded.sha256 !== sent) return stopped("sandbox-failed");

    // 4. The preparation, networking on, declared.
    at = "install";
    const version = manager === "pnpm" ? exactOf("pnpm") : (exactOf("npm") ?? "bundled");
    if (version === null) return stopped("fault", "The recipe doesn't name an exact pnpm version.");
    run.progress(`Installing with ${manager}, networking on: ${manager} ${recipe.install.args.join(" ")}`);
    const submitted = await run.sandbox.prepareEnvironment({
      image: base.image,
      inputs: { uuid: uploaded.uuid },
      timeoutSeconds: recipe.limits.prepareSeconds,
      recipe: { manager, version, via: manager === "pnpm" ? (pnpmBootstrap?.via ?? "corepack-else-npm-global") : "none", npmPin: npmBootstrap?.version ?? null, installArgs: recipe.install.args, env: recipe.env.preparation },
    });
    if (!("operationId" in submitted)) return stopped("uncertain");
    const ended = await run.sandbox.observe(submitted.operationId, recipe.limits.prepareSeconds);
    steps.push(stepOf("preparation", ended, true));
    install = { exitCode: ended.exitCode, logTail: tail(ended.stderr ? `${ended.stdout}\n${ended.stderr}` : ended.stdout, 8_000) };
    if (ended.verdict === "cancelled") return stopped("cancelled");
    const bootstrap = ended.exitCode === 70 || ended.exitCode === 71 ? bootstrapFailure(ended.stdout) : null;
    if (bootstrap) return stopped("bootstrap", bootstrap === "npm" ? `npm ${npmBootstrap?.version ?? "at the version pinned"} couldn't be installed.` : `pnpm ${version} couldn't be activated.`);
    if (ended.verdict === "timed-out") return stopped("install", `The install ran past its limit of ${recipe.limits.prepareSeconds} s and was stopped.`);
    if (ended.verdict === "command-failed") return stopped("install", installDiagnosis(manager, `${ended.stdout}\n${ended.stderr}`));
    if (ended.verdict !== "passed" || !ended.resultImage) return stopped("sandbox-failed");
    if (!ended.stdout.split("\n").includes("installed")) return stopped("install");
    const printed = preparedFacts(ended.stdout);
    const mismatches = [
      printed.node !== node ? `Node ${printed.node ?? "unknown"}, not ${node}` : null,
      manager === "pnpm" && printed.pnpm !== version ? `pnpm ${printed.pnpm ?? "unknown"}, not ${version}` : null,
      exactOf("npm") !== null && printed.npm !== exactOf("npm") ? `npm ${printed.npm ?? "unknown"}, not ${exactOf("npm")}` : null,
      printed.arch !== recipe.platform.arch ? `a ${printed.arch ?? "different"} machine` : null,
      printed.npm === null ? "no npm" : null,
    ].filter((item): item is string => item !== null);
    if (mismatches.length) return stopped("versions", `The prepared environment has ${mismatches.join(", ")}.`);
    const reported = manager === "pnpm" ? ignoredBuilds(ended.stdout) : null;
    const builds: BuildsState =
      manager === "npm"
        ? recipe.builds.runs === "none" && run.installScripts.length
          ? { state: "missing", missing: [...run.installScripts].slice(0, 200) }
          : { state: "complete", missing: [] }
        : reported!.state === "unknown" && recipe.builds.runs === "all"
          ? { state: "complete", missing: [] }
          : reported!;

    // 5. Readiness on the prepared image, networking off, with the task operations' own variables.
    at = "readiness";
    const readyStarted = now();
    const keys = manager === "pnpm" ? settingsToRead(versionParts(version)?.[0] ?? 99) : [];
    const probe = await run.sandbox.submit({ label: "environment readiness", command: "/bin/sh", args: ["-c", READINESS_SCRIPT, "nivra-env-readiness", manager, String(keys.length), ...keys, ...recipe.artifacts.dependency], image: ended.resultImage, disposable: true, timeoutSeconds: recipe.limits.probeSeconds, env: { ...recipe.env.task } });
    if (!("operationId" in probe)) return stopped("uncertain");
    const checked = await run.sandbox.observe(probe.operationId, recipe.limits.probeSeconds);
    steps.push(stepOf("readiness", checked, false));
    if (checked.verdict === "cancelled") return stopped("cancelled");
    if (checked.verdict !== "passed") return stopped("readiness", "The prepared image couldn't run Nivra's readiness step.");
    const readyMs = Math.round(now() - readyStarted);
    const ready = readinessFacts(checked.stdout);
    const expected: Record<string, string> = { "verify-deps-before-run": "false", "pm-on-fail": "ignore", "manage-package-manager-versions": "false" };
    const essential = versionParts(version)?.[0] ?? 99;
    // The workspace must hold the setup files and the install's folders, and nothing else.
    const setupFiles = new Set(recipe.configuration.files.map((file) => file.path));
    const extra = ready.files === null ? null : ready.files.filter((path) => !setupFiles.has(path));
    const named = (path: string) => JSON.stringify(path.length > 120 ? `${path.slice(0, 117)}...` : path);
    const problems = [
      ...Object.entries(ready.tools).filter(([, ok]) => !ok).map(([name]) => `${name} is missing`),
      extra === null ? "the workspace couldn't be listed" : null,
      extra && extra.length ? `the install left ${ready.files!.length > READINESS_FILES ? `more than ${READINESS_FILES}` : extra.length} ${extra.length === 1 ? "file" : "files"} outside ${recipe.artifacts.dependency.join(", ")}, such as ${named(extra[0]!)}, which a task's session would read as the commit's own` : null,
      ...(Object.keys(ready.tools).length === 0 ? ["no session tools were listed"] : []),
      ready.node !== node ? "Node answers with another version" : null,
      manager === "pnpm" && ready.pnpm !== version ? "pnpm answers with another version" : null,
      // A setting the version doesn't know reads back as nothing; the one that stops installs before a run must hold.
      ...keys.filter((key) => (key === "verify-deps-before-run" || essential === 10 || essential === 11) && ready.settings[key] !== expected[key]).map((key) => `pnpm reads ${key} as ${/^[A-Za-z0-9-]{0,20}$/.test(ready.settings[key] ?? "") ? JSON.stringify(ready.settings[key] ?? "") : "something else"}, not ${expected[key]}`),
    ].filter((item): item is string => item !== null);
    if (problems.length) return stopped("readiness", `${problems.join("; ")}.`);

    // 6. What was verified, written once.
    const tools: VerifiedTool[] = [{ name: "node", version: printed.node! }, { name: "npm", version: printed.npm! }];
    if (manager === "pnpm") tools.push({ name: "pnpm", version: printed.pnpm! });
    if (facts.corepack) tools.push({ name: "corepack", version: facts.corepack });
    const verified = VerifiedToolRecord.safeParse({
      format: VERIFIED_FORMAT,
      recipe: run.recipeDigest,
      tools,
      platform: { os: "linux", arch: printed.arch!, libc: facts.libc!, release: facts.os ?? "unknown" },
      images: { base: base.image, prepared: ended.resultImage, imported: base.imported },
      builds,
      generated: null,
      probes: [
        { name: "inspect", durationMs: inspectMs },
        { name: "readiness", durationMs: readyMs },
      ],
      verifiedAt: wall(),
    });
    if (!verified.success) return stopped("fault");
    return { prepared: { image: ended.resultImage, verified: verified.data }, stopped: null, steps, install };
  } catch (error) {
    if (run.signal.aborted || error instanceof SandboxCancelledError) return stopped("cancelled");
    // Only Nebius's own answers, or their absence, are its failures; anything else went wrong inside Nivra.
    const nebius = error instanceof SandboxHttpError || error instanceof SandboxNetworkError || error instanceof SandboxNotSentError || error instanceof SandboxTooLargeError;
    return stopped(nebius ? "sandbox-failed" : "fault");
  }
}
