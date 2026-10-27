import type { CloseReport, ExecutionBackend, ExecutionSession } from "../src/exec/backend.ts";
import type { SandboxApi } from "../src/exec/nebius/api.ts";
import { ENV_PATH, ENV_WORKSPACE, Sandbox, type Journal } from "../src/exec/nebius/sandbox.ts";
import { collectResult } from "../src/exec/patch.ts";
import type { Snapshot } from "../src/exec/snapshot.ts";
import { WorkspaceCopy } from "../src/task/copy.ts";

/**
 * The environment feasibility probe's steps (NIV-49), apart from its command line so that a test can rehearse them
 * against the fake service. In order, each bounded:
 * 1. the account's images with the pinned tag's prefix, read; a public image with exactly the pinned tag is used;
 * 2. otherwise the pinned image imported from its public registry, as a private image reached by its id;
 * 3. the environment's preparation, the one operation with networking on: the frozen install, kept as an image;
 * 4. Nivra's own session started from that image, networking off: the snapshot overlaid and its listing checked with
 *    the dependency folders left out; the toolchain run offline; each baseline selection run once; then collect, whose
 *    result must be exactly the commit;
 * 5. cleanup, by the session's close.
 * A step that fails stops the probe there, saying why; nothing is retried.
 */

export interface Selection {
  name: string;
  /** Run as `/bin/sh -c`, in the workspace. */
  command: string;
  exitCode: number;
  /** Exactly what it must print, or a pattern its whole output must match: one of the two. */
  output?: string;
  pattern?: string;
}

export interface EnvPin {
  /** The image's exact tag, for example node:22.23.4-alpine3.24, and the prefix its listing is narrowed to. */
  tag: string;
  tagPrefix: string;
  registryUrl: string;
  /** What `node --version` must print. */
  node: string;
  /** pnpm@x.y.z */
  packageManager: string;
  installArgs: string[];
}

export interface EnvProbeInput {
  api: SandboxApi;
  /** Where the import and the preparation are journaled, for cleanup and `--recover`. */
  journal: Journal;
  /** Builds the session's backend once the prepared image is known. */
  backendFor: (preparedImage: string) => ExecutionBackend;
  snapshot: Snapshot;
  /** The preparation inputs, as one gzip-compressed tar. */
  inputs: Uint8Array;
  pin: EnvPin;
  selections: Selection[];
  /** The folders the install makes, by name: left out of the session's listing and collect. */
  dependencyFolders: string[];
  limits: { importSeconds: number; prepareSeconds: number; toolchainSeconds: number; selectionSeconds: number; collectSeconds: number; sessionMs: number; closeMs: number; pollMs?: number };
  signal: AbortSignal;
  closeSignal: AbortSignal;
  log: (line: string) => void;
  /** What runs collect's tools inside the sandbox: busybox unless given; tests on a machine without it give "". */
  applets?: string;
  /** Tests move the clock and waits. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SelectionResult {
  name: string;
  exitCode: number | null;
  stdout: string;
  stderrTail: string;
  matches: boolean;
  durationMs: number | null;
}

export interface EnvProbeOutcome {
  stopped: string | null;
  images: Array<{ uuid: string; tag: string | null }>;
  base: { image: string | null; from: "public" | "import"; operation: string | null; status: string | null; record: unknown } | null;
  prepared: { image: string | null; status: string; exitCode: number | null; printed: Record<string, string>; stdoutTail: string; stderrTail: string; usage: unknown } | null;
  opened: boolean;
  toolchain: SelectionResult | null;
  selections: SelectionResult[];
  collect: { entries: number; dependencyEntries: number; integrity: string | null } | null;
  cleanup: CloseReport | null;
}

const tail = (text: string, bytes = 2_000) => (text.length > bytes ? text.slice(-bytes) : text);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether a command's result is the expected one: its exit code, and its output exactly or by its pattern. */
export function matches(expected: Pick<Selection, "exitCode" | "output" | "pattern">, ran: { exitCode: number | null; stdout: string }): boolean {
  if (ran.exitCode !== expected.exitCode) return false;
  if (expected.output !== undefined) return ran.stdout === expected.output;
  return expected.pattern !== undefined && new RegExp(expected.pattern).test(ran.stdout);
}

export async function runEnvProbe(input: EnvProbeInput): Promise<EnvProbeOutcome> {
  const { api, log, pin } = input;
  const now = input.now ?? (() => performance.now());
  const until = (ms: number) => ({ until: now() + ms });
  const outcome: EnvProbeOutcome = { stopped: null, images: [], base: null, prepared: null, opened: false, toolchain: null, selections: [], collect: null, cleanup: null };
  const stop = (why: string) => {
    outcome.stopped = why;
    log(`stopped: ${why}`);
    return outcome;
  };
  const sandbox = new Sandbox(api, { journal: input.journal, signal: input.signal, maxTimeoutSeconds: Math.max(input.limits.importSeconds, input.limits.prepareSeconds), now, ...(input.limits.pollMs ? { pollMs: input.limits.pollMs } : {}), ...(input.sleep ? { sleep: input.sleep } : {}) });

  try {
    // 1. The images the account sees with the pinned tag's prefix.
    const listed = (await api.images({ ...until(60_000), tag: pin.tagPrefix, limit: 1000 })) as { images?: Array<{ uuid?: unknown; tag?: unknown }> } | null;
    outcome.images = (listed?.images ?? []).flatMap((image) => (typeof image.uuid === "string" ? [{ uuid: image.uuid, tag: typeof image.tag === "string" ? image.tag : null }] : []));
    log(`1. images with tags starting ${pin.tagPrefix}: ${outcome.images.map((image) => image.tag ?? image.uuid).join(", ") || "none"}`);
    const exact = outcome.images.find((image) => image.tag === pin.tag);

    // 2. The pinned image: public with exactly its tag, or imported.
    let base: string;
    if (exact) {
      outcome.base = { image: exact.uuid, from: "public", operation: null, status: null, record: null };
      base = exact.uuid;
      log(`2. base: the public ${pin.tag}, ${exact.uuid}`);
    } else {
      const started = await sandbox.importImage({ registryUrl: pin.registryUrl, timeoutSeconds: input.limits.importSeconds });
      if (!("operationId" in started)) return stop("the import's start wasn't answered, so whether it started is unknown; --recover settles what it can, and the images list shows the rest");
      log(`2. import of ${pin.registryUrl} started: ${started.operationId}`);
      const ended = await sandbox.observe(started.operationId, input.limits.importSeconds);
      const record = await api.operation(started.operationId, until(60_000)).catch(() => null);
      outcome.base = { image: ended.resultImage, from: "import", operation: started.operationId, status: ended.status, record };
      log(`2. import ended ${ended.status}${ended.resultImage ? `: image ${ended.resultImage}` : ", naming no image"}`);
      if (ended.status !== "SUCCESS" || !ended.resultImage) return stop(`the import ended ${ended.status} without naming an image`);
      base = ended.resultImage;
    }

    // 3. The preparation, networking on, declared.
    const uploaded = await api.upload(input.inputs, until(120_000));
    log(`3. preparation inputs uploaded: ${input.inputs.byteLength} bytes, ${uploaded.uuid}`);
    const submitted = await sandbox.prepareEnvironment({ image: base, inputs: { uuid: uploaded.uuid }, packageManager: pin.packageManager, installArgs: pin.installArgs, timeoutSeconds: input.limits.prepareSeconds });
    if (!("operationId" in submitted)) return stop("the preparation's start wasn't answered, so whether it started is unknown; --recover settles it");
    const prepared = await sandbox.observe(submitted.operationId, input.limits.prepareSeconds);
    const printed: Record<string, string> = {};
    for (const line of prepared.stdout.split("\n")) {
      const match = /^(node|pnpm|arch) (\S+)$/.exec(line.trim());
      if (match) printed[match[1]!] = match[2]!;
    }
    outcome.prepared = { image: prepared.resultImage, status: prepared.status, exitCode: prepared.exitCode, printed, stdoutTail: tail(prepared.stdout), stderrTail: tail(prepared.stderr), usage: prepared.usage };
    log(`3. preparation ended ${prepared.status} (exit ${String(prepared.exitCode)}): node ${printed["node"] ?? "?"}, pnpm ${printed["pnpm"] ?? "?"}, ${printed["arch"] ?? "?"}; image ${prepared.resultImage ?? "none"}`);
    if (prepared.verdict !== "passed" || !prepared.resultImage) return stop(`the preparation ended ${prepared.verdict}, so no environment was made`);
    if (printed["node"] !== pin.node || printed["pnpm"] !== pin.packageManager.slice("pnpm@".length)) return stop(`the prepared versions (node ${printed["node"] ?? "?"}, pnpm ${printed["pnpm"] ?? "?"}) aren't the pinned ones`);
    if (!prepared.stdout.split("\n").includes("installed")) return stop("the preparation didn't say the install finished");

    // 4. Nivra's own session, from the prepared image.
    await inSession(input, prepared.resultImage, outcome);
  } catch (error) {
    if (outcome.stopped === null) stop(message(error));
  }
  return outcome;
}

async function inSession(input: EnvProbeInput, image: string, outcome: EnvProbeOutcome): Promise<void> {
  const { log, pin } = input;
  const closing = { signal: input.closeSignal, budgetMs: input.limits.closeMs };
  const env = { PATH: ENV_PATH, HOME: "/root", CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false" };
  let session: ExecutionSession;
  try {
    session = await input.backendFor(image).open({ workspace: ENV_WORKSPACE, network: "deny", requires: { isolatesFilesystem: true }, snapshot: input.snapshot.archive, budgetMs: input.limits.sessionMs, closing, signal: input.signal });
  } catch (error) {
    outcome.cleanup = error && typeof error === "object" && "report" in error ? ((error as { report: CloseReport }).report ?? null) : null;
    outcome.stopped = `the session didn't open from the prepared image: ${message(error)}`;
    log(`stopped: ${outcome.stopped}`);
    return;
  }
  outcome.opened = true;
  log(`4. session opened from the prepared image: the snapshot's listing matched, ${input.dependencyFolders.join(", ")} left out`);
  const run = async (selection: Selection, seconds: number, label: string): Promise<SelectionResult> => {
    const ran = await session.exec({ argv: ["/bin/sh", "-c", selection.command], cwd: ENV_WORKSPACE, env, timeoutMs: seconds * 1000, maxOutputBytes: 65_536, persist: false, label });
    return { name: selection.name, exitCode: ran.exitCode, stdout: tail(ran.stdout, 8_000), stderrTail: tail(ran.stderr), matches: matches(selection, ran), durationMs: ran.durationMs ?? null };
  };
  try {
    const expected = `${pin.node}\n${pin.packageManager.slice("pnpm@".length)}\n`;
    outcome.toolchain = await run({ name: "toolchain, offline", command: "node --version && pnpm --version", exitCode: 0, output: expected }, input.limits.toolchainSeconds, "toolchain");
    log(`4. toolchain, networking off: exit ${String(outcome.toolchain.exitCode)}, ${outcome.toolchain.matches ? "the pinned versions" : `NOT the pinned versions: ${JSON.stringify(outcome.toolchain.stdout.slice(0, 200))}`}`);
    if (!outcome.toolchain.matches) {
      outcome.stopped = "the prepared toolchain didn't run with networking off, so no selection was run";
      log(`stopped: ${outcome.stopped}`);
      return;
    }
    for (const selection of input.selections) {
      const result = await run(selection, input.limits.selectionSeconds, `baseline ${selection.name}`);
      outcome.selections.push(result);
      log(`4. baseline ${selection.name}: exit ${String(result.exitCode)}, ${result.matches ? "as expected" : "NOT as expected"}`);
    }
    const collected = await collectResult(session, { workspace: ENV_WORKSPACE, timeoutMs: input.limits.collectSeconds * 1000, downloadTimeoutMs: input.limits.collectSeconds * 1000, ...(input.applets !== undefined ? { applets: input.applets } : {}) });
    const dependencyEntries = collected.collected.entries.filter((entry) => entry.path.split("/").some((part) => input.dependencyFolders.includes(part))).length;
    let integrity: string | null = null;
    try {
      new WorkspaceCopy(input.snapshot).checkIntegrity(collected.collected);
    } catch (error) {
      integrity = message(error);
    }
    outcome.collect = { entries: collected.collected.entries.length, dependencyEntries, integrity };
    log(`4. collect: ${collected.collected.entries.length} entries, ${dependencyEntries} under ${input.dependencyFolders.join(", ")}; ${integrity ?? "exactly the commit"}`);
  } catch (error) {
    outcome.stopped = message(error);
    log(`stopped: ${outcome.stopped}`);
  } finally {
    outcome.cleanup = await session.close(closing);
  }
}
