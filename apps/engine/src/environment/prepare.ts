import { createHash } from "node:crypto";
import { ENVIRONMENT_BASE, type EnvironmentStopCode, type SandboxStep } from "@nivra/domain";
import { SandboxCancelledError, type SandboxApi } from "../exec/nebius/api.ts";
import type { Journal, Outcome, Sandbox } from "../exec/nebius/sandbox.ts";

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
    run.journal.append({ kind: "upload", wall: wall(), sha256: createHash("sha256").update(run.archive).digest("hex"), bytes: run.archive.byteLength });
    const uploaded = await run.api.upload(run.archive, { until: run.until() });
    run.journal.append({ kind: "uploaded", wall: wall(), uuid: uploaded.uuid });

    // 3. The preparation, networking on, declared.
    at = "install";
    run.progress(`Installing with ${run.packageManager}: pnpm install ${run.installArgs.join(" ")}.`);
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
