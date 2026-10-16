import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BoundaryUnavailableError, ExecRefusedError, type ExecutionBackend } from "../src/exec/backend.ts";
import { createLocalBackend, LOCAL_CAPABILITIES } from "../src/exec/local.ts";
import { isAlive, removeDir, tempDir, waitFor } from "./helpers.ts";

/**
 * The execution session contract (D9), run here against `Local`. Every backend must pass the behavioural part; a
 * backend that claims a capability must also make the matching prohibited operation fail. `Local` claims none.
 */
const dirs: string[] = [];
const pids: number[] = [];
after(() => {
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const dir of dirs) removeDir(dir);
});

const node = (script: string, ...args: string[]) => [process.execPath, "-e", script, ...args] as const;

function sessionContract(name: string, makeBackend: () => ExecutionBackend) {
  describe(`${name}: execution session contract`, () => {
    const workspace = tempDir();
    dirs.push(workspace);
    const open = () => makeBackend().open({ workspace });

    it("runs a program without a shell and returns its output and exit code", async () => {
      const session = await open();
      try {
        const ok = await session.exec({ argv: node("process.stdout.write('hi'); process.stderr.write('warn')"), cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 1_024 });
        assert.deepEqual([ok.exitCode, ok.stdout, ok.stderr, ok.timedOut, ok.cancelled], [0, "hi", "warn", false, false]);
        const failed = await session.exec({ argv: node("process.exit(3)"), cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 1_024 });
        assert.equal(failed.exitCode, 3);
        // Shell syntax is just an argument: nothing interprets it.
        const literal = await session.exec({ argv: node("process.stdout.write(process.argv[1])", "$HOME && echo pwned"), cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 1_024 });
        assert.equal(literal.stdout, "$HOME && echo pwned");
      } finally {
        await session.close();
      }
    });

    it("stops a command at its time limit", async () => {
      const session = await open();
      try {
        const started = performance.now();
        const result = await session.exec({ argv: node("setTimeout(() => {}, 60000)"), cwd: workspace, timeoutMs: 300, maxOutputBytes: 1_024 });
        assert.equal(result.timedOut, true);
        assert.notEqual(result.exitCode, 0);
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

    it("keeps output to its cap and says it was cut", async () => {
      const session = await open();
      try {
        const result = await session.exec({ argv: node("process.stdout.write('x'.repeat(100000))"), cwd: workspace, timeoutMs: 10_000, maxOutputBytes: 1_000 });
        assert.equal(result.truncated, true);
        assert.equal(result.stdout.length, 1_000);
      } finally {
        await session.close();
      }
    });

    it("refuses a program that does not exist, and runs nothing after close", async () => {
      const session = await open();
      await assert.rejects(session.exec({ argv: [join(workspace, "no-such-program")], cwd: workspace, timeoutMs: 5_000, maxOutputBytes: 100 }), ExecRefusedError);
      await session.close();
      await assert.rejects(session.exec({ argv: node("1"), cwd: workspace, timeoutMs: 5_000, maxOutputBytes: 100 }), ExecRefusedError);
    });
  });
}

sessionContract("Local", () => createLocalBackend());

describe("Local: what it claims", () => {
  it("claims no isolation of any kind", () => {
    assert.deepEqual(LOCAL_CAPABILITIES, { isolatesFilesystem: false, networkPolicy: "none", injectsCredentials: false, persistsBetweenExecs: true });
  });

  it("refuses a session that needs the network blocked or restricted, instead of running unconfined", async () => {
    const backend = createLocalBackend();
    await assert.rejects(backend.open({ workspace: ".", network: "deny" }), BoundaryUnavailableError);
    await assert.rejects(backend.open({ workspace: ".", network: "allowList" }), BoundaryUnavailableError);
  });

  it("refuses Windows batch files, which need a shell", async () => {
    const session = await createLocalBackend({ platform: "win32" }).open({ workspace: "." });
    await assert.rejects(session.exec({ argv: ["C:\\tools\\npm.cmd", "install"], cwd: ".", timeoutMs: 1_000, maxOutputBytes: 100 }), /batch file/);
  });
});
