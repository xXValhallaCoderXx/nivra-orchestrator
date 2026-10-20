import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BoundaryUnavailableError, ExecRefusedError } from "../src/exec/backend.ts";
import { createLocalBackend, LOCAL_CAPABILITIES } from "../src/exec/local.ts";
import { isAlive, removeDir, tempDir, waitFor } from "./helpers.ts";
import { sessionContract } from "./session-contract.ts";

/**
 * `Local` (D9): the shared session contract, then what only a backend on the target has to show: process trees, pids,
 * and that it claims nothing, so coding work can never fall back to it (D33).
 */
const dirs: string[] = [];
const pids: number[] = [];
after(() => {
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const dir of dirs) removeDir(dir);
});

const node = (script: string, ...args: string[]) => [process.execPath, "-e", script, ...args] as const;
const workspace = tempDir();
dirs.push(workspace);

sessionContract({
  name: "Local",
  makeBackend: () => createLocalBackend(),
  spec: () => ({ workspace }),
  cwd: workspace,
  shortTimeoutMs: 300,
  programs: {
    print: (stdout, stderr) => node("process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2])", stdout, stderr),
    exit: (code) => node("process.exit(Number(process.argv[1]))", String(code)),
    echo: (text) => node("process.stdout.write(process.argv[1])", text),
    forever: () => node("setTimeout(() => {}, 60000)"),
    flood: (bytes) => node("process.stdout.write('x'.repeat(Number(process.argv[1])))", String(bytes)),
    missing: () => [join(workspace, "no-such-program")],
  },
});

describe("Local: processes on the target", () => {
  const open = () => createLocalBackend().open({ workspace });

  it("stops a command at its time limit within a few seconds", async () => {
    const session = await open();
    try {
      const started = performance.now();
      const result = await session.exec({ argv: node("setTimeout(() => {}, 60000)"), cwd: workspace, timeoutMs: 300, maxOutputBytes: 1_024 });
      assert.equal(result.timedOut, true);
      assert.ok(performance.now() - started < 8_000);
    } finally {
      await session.close();
    }
  });

  it("cancels a command and everything it started", async () => {
    const session = await open();
    const pidFile = join(workspace, "grandchild.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(process.argv[1], String(grandchild.pid));
      setTimeout(() => {}, 60000);`;
    const controller = new AbortController();
    let childPid: number | null = null;
    try {
      const running = session.exec({
        argv: node(script, pidFile),
        cwd: workspace,
        timeoutMs: 60_000,
        maxOutputBytes: 1_024,
        signal: controller.signal,
        onStart: ({ pid }) => (childPid = pid),
      });
      const grandchildPid = await waitFor(() => {
        try {
          return Number(readFileSync(pidFile, "utf8")) || null;
        } catch {
          return null;
        }
      }, { what: "the grandchild's pid" });
      pids.push(grandchildPid);
      controller.abort();
      const result = await running;
      assert.equal(result.cancelled, true);
      assert.ok(childPid !== null);
      await waitFor(() => !isAlive(childPid!) && !isAlive(grandchildPid), { timeoutMs: 8_000, what: "the child and grandchild to stop" });
    } finally {
      await session.close();
    }
  });

  it(
    "closing the session stops background processes a finished command left behind",
    // Windows cannot find a finished command's descendants by its process id; they die with the engine (D4, D15).
    { skip: process.platform === "win32" ? "POSIX process groups only; Windows relies on the engine's job object" : false },
    async () => {
      const session = await open();
      const leftBehind: number[] = [];
      for (const argv of [
        ["/bin/sh", "-c", "sleep 60 & echo $!"],
        node("const c = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); c.unref(); console.log(c.pid);"),
      ] as const) {
        const result = await session.exec({ argv, cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 1_024 });
        assert.equal(result.exitCode, 0);
        const pid = Number(result.stdout.trim());
        pids.push(pid);
        leftBehind.push(pid);
        assert.equal(isAlive(pid), true, "the background process outlived its command");
      }
      await session.close();
      await waitFor(() => leftBehind.every((pid) => !isAlive(pid)), { timeoutMs: 8_000, what: "the background processes to stop" });
    },
  );

  it("refuses a program that does not exist as never started", async () => {
    const session = await open();
    try {
      await assert.rejects(session.exec({ argv: [join(workspace, "no-such-program")], cwd: workspace, timeoutMs: 5_000, maxOutputBytes: 100 }), ExecRefusedError);
    } finally {
      await session.close();
    }
  });

  it("gives a command its input and keeps output that isn't text as bytes", async () => {
    const session = await open();
    try {
      const input = new Uint8Array([0, 1, 2, 255, 10]);
      const result = await session.exec({ argv: node("process.stdin.pipe(process.stdout)"), cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 1_024, stdin: input, output: "bytes" });
      assert.deepEqual([result.exitCode, [...(result.stdoutBytes ?? [])]], [0, [...input]]);
      assert.equal((await session.exec({ argv: node("process.stdout.write('x')"), cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 1_024 })).stdoutBytes, undefined);
    } finally {
      await session.close();
    }
  });

  it("keeps to its session's budget and signal: no command outlives the one, and the other stops what is running", async () => {
    let now = 0;
    const budgeted = await createLocalBackend({ now: () => now }).open({ workspace, budgetMs: 10_000 });
    now = 5_000;
    await assert.rejects(budgeted.exec({ argv: node("1"), cwd: workspace, timeoutMs: 6_000, maxOutputBytes: 100 }), /^ExecRefusedError: There isn't enough time left in this run to give .* its 6 s, so it wasn't run\.$/);
    assert.equal((await budgeted.exec({ argv: node("1"), cwd: workspace, timeoutMs: 4_000, maxOutputBytes: 100 })).exitCode, 0);
    await budgeted.close();
    const stopping = new AbortController();
    const signalled = await createLocalBackend().open({ workspace, signal: stopping.signal });
    const running = signalled.exec({ argv: node("setTimeout(() => {}, 60000)"), cwd: workspace, timeoutMs: 60_000, maxOutputBytes: 100, onStart: () => stopping.abort() });
    assert.equal((await running).cancelled, true);
    assert.equal((await signalled.exec({ argv: node("1"), cwd: workspace, timeoutMs: 1_000, maxOutputBytes: 100 })).cancelled, true, "nothing starts once the session's signal has aborted");
    await signalled.close();
  });
});

describe("Local: what it claims", () => {
  it("claims no isolation of any kind", () => {
    assert.deepEqual(LOCAL_CAPABILITIES, { isolatesFilesystem: false, networkPolicy: "none", injectsCredentials: false, persistsBetweenExecs: true });
  });

  it("refuses a session that needs the network blocked or restricted, instead of running unconfined", async () => {
    const backend = createLocalBackend();
    await assert.rejects(backend.open({ workspace: ".", network: "deny" }), BoundaryUnavailableError);
    await assert.rejects(backend.open({ workspace: ".", network: "allowList" }), BoundaryUnavailableError);
  });

  it("refuses what coding work needs, so it can never fall back to running unconfined: isolation, a snapshot, a command thrown away", async () => {
    const backend = createLocalBackend();
    await assert.rejects(backend.open({ workspace: ".", requires: { isolatesFilesystem: true } }), (error: Error) => error instanceof BoundaryUnavailableError && /^"No isolation" can't keep commands away from this computer's files, so this run was not started\./.test(error.message));
    await assert.rejects(backend.open({ workspace: ".", snapshot: { archive: new Uint8Array(0), sha256: "0".repeat(64), listingDigest: "0".repeat(64) } }), /can't take a snapshot to run elsewhere/);
    const session = await backend.open({ workspace });
    try {
      await assert.rejects(session.exec({ argv: node("1"), cwd: workspace, timeoutMs: 1_000, maxOutputBytes: 100, persist: false }), /can't throw a command's changes away/);
    } finally {
      await session.close();
    }
  });

  it("refuses Windows batch files, which need a shell", async () => {
    const session = await createLocalBackend({ platform: "win32" }).open({ workspace: "." });
    await assert.rejects(session.exec({ argv: ["C:\\tools\\npm.cmd", "install"], cwd: ".", timeoutMs: 1_000, maxOutputBytes: 100 }), /batch file/);
  });
});
