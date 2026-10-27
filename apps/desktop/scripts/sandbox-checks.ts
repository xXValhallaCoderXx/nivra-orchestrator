// Sandbox checks through a WSL distribution's engine, as the window drives them (D36): the host's own path, from a
// Windows host, for a project inside the distribution. Upload consent (the host's and the engine's own), a whole check
// on the production adapter, a cancel, uploads turned off during a check, an uncertain submission, and recovery after a
// restart, without the credentials and then with them. Nebius Sandboxes is a stand-in on loopback (stand-in.ts);
// nothing reaches the network. verify:windows runs these on Windows against a real distribution, and a test runs them
// here against an engine standing in for one's.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isTerminal, type SecretName } from "@nivra/domain";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import { EngineSupervisor } from "../src/main/supervisor.ts";
import type { RunResult } from "../src/main/targets/process.ts";
import type { ExecutionTarget } from "../src/main/targets/types.ts";
import type { WslDiscovery } from "../src/main/targets/wsl-discovery.ts";
import type { Seen, StandIn } from "./stand-in.ts";

export interface SandboxSetup {
  /** The distribution's engine target, which reaches the stand-in. The host is given no other. */
  target: ExecutionTarget;
  discovery: WslDiscovery;
  /** The host's own engine target, never started here. */
  local: ExecutionTarget;
  /** Runs a program in the distribution, from `/`. */
  inDistro: (args: string[], timeoutMs?: number) => Promise<RunResult>;
  /** A folder of this run's own for the host's records, emptied first. */
  root: string;
  logsDir: string;
  /** The engine's home, or a part of its path: no request may carry it. */
  engineHome: string;
  stub: StandIn;
  /** Runs one named check, records it, and says whether it passed. */
  check: (name: string, body: () => Promise<string>) => Promise<boolean>;
  log: (line: string) => void;
}

/** A test key and project id: what the stand-in is shown, and checks every request for. */
const NEBIUS = { NEBIUS_API_KEY: "verify-windows-key-0123456789abcdef", NEBIUS_PROJECT_ID: "project-e00verifywindows" };
const AWKWARD = "ü%#";
const ENDED = ["succeeded", "failed", "cancelled"];
const UPLOADS_OFF = /doesn't allow uploading its commit to Nebius Sandboxes/;
const UPLOADS_STOPPED = /^Uploads for this project were turned off, so its sandbox check is being stopped\. Anything it uploaded stays with Nebius/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(probe: () => Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value as NonNullable<T>;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export async function sandboxChecks(setup: SandboxSetup): Promise<void> {
  const { target, check, stub, inDistro } = setup;
  const distro = target.descriptor.distro ?? "";
  rmSync(setup.root, { recursive: true, force: true });
  mkdirSync(setup.root, { recursive: true });
  const keys: { current: Partial<Record<SecretName, string>> } = { current: NEBIUS };
  // The host as Electron's main process makes it, with this run's targets; a second one on the same records is a restart.
  const hostOn = (): Host => {
    const made = new Host({
      targets: { local: setup.local, discoverWsl: async () => ({ discovery: setup.discovery, targets: [target] }) },
      store: new HostStore(join(setup.root, "nivra.json")),
      workspacePath: join(setup.root, "workspace.db"),
      logsDir: setup.logsDir,
      client: { name: "windows-harness", version: "0" },
      credentials: async () => keys.current,
      platform: "win32",
      log: setup.log,
    });
    made.init();
    return made;
  };
  let host = hostOn();
  let projectId = "";
  let repo = "";
  const seen = () => stub<Seen>("requests", { key: NEBIUS.NEBIUS_API_KEY, project: NEBIUS.NEBIUS_PROJECT_ID, home: setup.engineHome });
  const added = () => {
    if (!projectId) throw new Error("the project wasn't added");
    return projectId;
  };
  const previewed = async () => {
    const shown = await host.previewSandboxCheck(added());
    if (shown.status !== "ready") throw new Error(`the preview was refused (${shown.code}): ${shown.message}`);
    return shown;
  };
  const ended = () =>
    waitFor(async () => {
      const view = await host.sandboxCheck(added());
      return view && ENDED.includes(view.status) ? view : null;
    }, 60_000, "the sandbox check to end");
  // A new probe whose operation the engine has read: it reads one only once the spawn's answer is in and journaled, so a
  // stop after that read can't race the answer, as one after the spawn alone can.
  const probeStarted = (before: Seen) =>
    waitFor(async () => {
      const reads = (await seen()).probeReads;
      return reads.length > before.probeReads.length && (reads.at(-1) ?? 0) > 0;
    }, 30_000, "the engine's first read of the probe's operation");
  const refusal = (id: string) => host.startSandboxCheck(id, "a".repeat(64)).then(() => null, (error: Error) => error.message);

  try {
    await check("wsl sandbox: a folder inside the distribution, picked as Windows names it, is added for that distribution's engine", async () => {
      const made = await inDistro([
        "/bin/sh",
        "-c",
        'set -e; d="$HOME/.nivra-verify/sandbox $1"; rm -rf "$d"; mkdir -p "$d/src"; cd "$d"; printf "# A project\\n" > README.md; printf "export const app = 1;\\n" > src/app.ts; git init -q -b main; git add -A; git -c user.name=t -c user.email=t@nivra.invalid commit -q -m init; pwd',
        "sh",
        AWKWARD,
      ]);
      repo = made.stdout.trim().split("\n").at(-1) ?? "";
      if (made.code !== 0 || !repo.startsWith("/")) throw new Error(`could not make the repository: ${made.stderr.trim()}`);
      const picked = `\\\\wsl.localhost\\${distro}${repo.replace(/\//g, "\\")}`;
      const result = await host.addPicked(picked);
      if (result.status !== "added") throw new Error(result.status === "refused" ? result.reason : `the folder wasn't added (${result.status})`);
      if (result.project.targetId !== target.descriptor.id) throw new Error(`added for ${result.project.targetId}, not ${target.descriptor.id}`);
      projectId = result.project.id;
      return `${picked} is ${result.project.displayPath} on ${result.project.targetLabel}`;
    });
    await check("wsl sandbox: with uploads off, the host refuses a check and sends nothing", async () => {
      const before = await seen();
      const refused = await refusal(added());
      if (!refused || !UPLOADS_OFF.test(refused)) throw new Error(refused ? `refused for another reason: ${refused}` : "the check started with uploads off");
      const after = await seen();
      if (after.total !== before.total) throw new Error(`${after.total - before.total} requests reached the stand-in`);
      return `"${refused}"; nothing reached the stand-in`;
    });
    await check("wsl sandbox: a whole check on the distribution's engine: one upload, networking off throughout, the credentials in headers only", async () => {
      await host.setCloudExecution(added(), true);
      const shown = await previewed();
      const head = (await inDistro(["git", "-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      if (shown.baseline !== head || shown.files !== 2) throw new Error(`the preview shows ${shown.files} files at ${shown.baseline}, not 2 at ${head}`);
      const before = await seen();
      await host.startSandboxCheck(added(), shown.fingerprint);
      const view = await ended();
      const report = view.report;
      if (view.status !== "succeeded" || report?.outcome !== "unchanged") throw new Error(`the check ended ${view.status}, ${report?.outcome ?? "with no report"}: ${report?.stopped?.message ?? view.note ?? ""}`);
      if (report.snapshot?.fingerprint !== shown.fingerprint) throw new Error("the report isn't bound to the preview that was shown");
      if (report.cleanup?.unresolved.length) throw new Error(`cleanup left ${report.cleanup.unresolved.length} unresolved`);
      const after = await seen();
      const [uploads, spawns] = [after.uploads - before.uploads, after.spawns - before.spawns];
      if (uploads !== 1 || spawns !== 3) throw new Error(`${uploads} uploads and ${spawns} operations, not 1 and 3`);
      if (after.networkingOn) throw new Error(`${after.networkingOn} operations asked for networking`);
      if (!after.credentialed) throw new Error("a request didn't carry the key and project id in its headers as they were saved");
      if (after.leaking) throw new Error(`${after.leaking} request bodies hold the key, the project id or the engine's home`);
      const probe = (report.steps[0]?.stdoutTail ?? "").trim().replace(/\n/g, "; ");
      return `succeeded, unchanged, bound to the preview of ${head.slice(0, 12)}; steps ${report.steps.map((step) => step.label).join(", ")}; the probe saw "${probe}"; 1 upload, 3 operations, each with networking off`;
    });
    await check("wsl sandbox: cancelling a check under way stops its operation, and cleanup's record says so", async () => {
      await stub("probe-waits");
      try {
        const before = await seen();
        await host.startSandboxCheck(added(), (await previewed()).fingerprint);
        await probeStarted(before);
        await host.cancelSandboxCheck(added());
        const view = await ended();
        const cleanup = view.report?.cleanup;
        if (view.status !== "cancelled" || view.report?.outcome !== "cancelled") throw new Error(`the check ended ${view.status}, ${view.report?.outcome ?? "with no report"}`);
        if (cleanup?.stopped !== 1 || cleanup.unresolved.length) throw new Error(`cleanup stopped ${cleanup?.stopped ?? 0} and left ${cleanup?.unresolved.length ?? 0} unresolved`);
        const after = await seen();
        if (after.deletes === before.deletes || after.probesCancelled.at(-1) !== true) throw new Error("the probe's operation wasn't stopped");
        return "cancelled; the probe's operation stopped; cleanup stopped 1, none unresolved";
      } finally {
        await stub("normal");
      }
    });
    await check("wsl sandbox: turning uploads off stops the check under way, says what stays with Nebius, and refuses the next", async () => {
      await stub("probe-waits");
      try {
        const before = await seen();
        await host.startSandboxCheck(added(), (await previewed()).fingerprint);
        await probeStarted(before);
        const project = await host.setCloudExecution(added(), false);
        if (!UPLOADS_STOPPED.test(project.notice ?? "")) throw new Error(`the project's notice is "${project.notice ?? ""}"`);
        const view = await ended();
        const cleanup = view.report?.cleanup;
        if (view.status !== "cancelled" || cleanup?.stopped !== 1) throw new Error(`the check ended ${view.status}; cleanup stopped ${cleanup?.stopped ?? 0}`);
        if (!/^Images are retained for 180 days/.test(cleanup.retained?.note ?? "")) throw new Error("the report doesn't say what Nebius keeps");
        const refused = await refusal(added());
        if (!refused || !UPLOADS_OFF.test(refused)) throw new Error(refused ? `refused for another reason: ${refused}` : "a check started with uploads off");
        const after = await seen();
        if (after.uploads - before.uploads !== 1 || after.spawns - before.spawns !== 2) throw new Error(`${after.uploads - before.uploads} uploads and ${after.spawns - before.spawns} operations, not 1 and 2`);
        return `cancelled; the notice says "${project.notice ?? ""}"; the next check refused, nothing more sent`;
      } finally {
        await stub("normal");
        await host.setCloudExecution(added(), true);
      }
    });
    await check("wsl sandbox: a submission whose answer was lost is never sent again, and stays open and visible", async () => {
      await stub("probe-uncertain");
      try {
        const before = await seen();
        await host.startSandboxCheck(added(), (await previewed()).fingerprint);
        const view = await ended();
        const report = view.report;
        if (view.status !== "failed" || report?.outcome !== "uncertain" || report.cleanup?.unresolved.length !== 1) {
          throw new Error(`the check ended ${view.status}, ${report?.outcome ?? "with no report"}, ${report?.cleanup?.unresolved.length ?? 0} unresolved`);
        }
        const after = await seen();
        if (after.probes - before.probes !== 1) throw new Error(`the probe was sent ${after.probes - before.probes} times`);
        const status = await host.sandboxStatus(added());
        if (status.open.length !== 1 || status.open[0]?.uncertain !== 1) throw new Error(`the engine lists ${status.open.length} journals open`);
        return `failed, uncertain: "${report.cleanup.unresolved[0] ?? ""}"; sent once; 1 journal open`;
      } finally {
        await stub("normal");
      }
    });
    await check("wsl sandbox: restarted without the credentials, the engine finds what was left open with no network, and waits", async () => {
      added();
      await host.shutdown();
      keys.current = {};
      host = hostOn();
      const before = await seen();
      const status = await host.sandboxStatus(added());
      const after = await seen();
      if (status.open.length !== 1 || status.pass.state !== "waiting-for-credentials") throw new Error(`${status.open.length} journals open; the pass is ${status.pass.state}`);
      if (after.total !== before.total) throw new Error(`${after.total - before.total} requests reached the stand-in`);
      return "1 journal open; the pass waits for the credentials; nothing sent";
    });
    await check("wsl sandbox: once the credentials are saved, one pass stops what was left, and nothing is sent again", async () => {
      added();
      await stub("list-all");
      const before = await seen();
      keys.current = NEBIUS;
      await host.secretsChanged();
      const done = await waitFor(async () => {
        const status = await host.sandboxStatus(added());
        return status.pass.state === "done" ? status : null;
      }, 60_000, "the recovery pass");
      const after = await seen();
      if (done.pass.stopped !== 1 || done.pass.unresolved.length || done.open.length) throw new Error(`the pass stopped ${done.pass.stopped}, left ${done.pass.unresolved.length} unresolved and ${done.open.length} open`);
      if (after.probesCancelled.at(-1) !== true) throw new Error("the uncertain probe's operation wasn't stopped");
      if (after.spawns !== before.spawns || after.uploads !== before.uploads) throw new Error(`recovery sent ${after.spawns - before.spawns} operations and ${after.uploads - before.uploads} uploads`);
      return "the pass stopped 1, none unresolved, none open; no operation or upload sent again";
    });
    await check("wsl sandbox: the engine itself refuses a check whose context doesn't allow uploads, and sends nothing", async () => {
      added();
      await host.shutdown();
      const direct = new EngineSupervisor({ target, logsDir: setup.logsDir, client: { name: "windows-harness", version: "0" }, credentials: async () => NEBIUS, heartbeatMs: 30_000, log: setup.log });
      await direct.start();
      try {
        const shown = await direct.call("sandbox.preview", { repoPath: repo });
        if (shown.status !== "ready") throw new Error(`the preview was refused (${shown.code})`);
        const before = await seen();
        const run = await direct.call("runs.start", {
          clientRequestId: randomUUID(),
          workflowId: "sandbox",
          input: { repoPath: repo, project: added(), target: target.descriptor.id, preview: shown.fingerprint },
          context: { sharing: { cloudExecution: false } },
        });
        const summary = await waitFor(async () => {
          const now = await direct.call("runs.get", { runId: run.id });
          return isTerminal(now.status) ? now : null;
        }, 60_000, "the refused check to end");
        const report = await direct.call("runs.sandbox", { runId: run.id });
        const after = await seen();
        if (summary.status !== "failed" || report?.stopped?.code !== "consent") throw new Error(`the run ended ${summary.status}, stopped by ${report?.stopped?.code ?? "nothing"}`);
        if (after.total !== before.total) throw new Error(`${after.total - before.total} requests reached the stand-in`);
        return `failed: "${report.stopped.message}"; nothing reached the stand-in`;
      } finally {
        await direct.stop();
      }
    });
  } finally {
    await host.shutdown();
  }
}
