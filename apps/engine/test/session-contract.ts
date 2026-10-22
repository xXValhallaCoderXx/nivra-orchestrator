import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExecRefusedError, type ExecRequest, type ExecutionBackend, type ExecutionSession, type SessionSpec } from "../src/exec/backend.ts";

/**
 * The execution session contract (D9, D33), for every backend: what a command's outcome means, whatever runs it. Each
 * backend supplies programs that behave as named; a backend that claims a capability also proves, in its own tests,
 * that the matching prohibited operation fails. Process trees and pids are the Local tests' business.
 */
type Argv = ExecRequest["argv"];

export interface ContractPrograms {
  /** Writes `stdout` and `stderr`, then exits 0. */
  print(stdout: string, stderr: string): Argv;
  /** Exits with `code`. */
  exit(code: number): Argv;
  /** Writes its one argument unchanged: shell syntax in it reaches it as text. */
  echo(text: string): Argv;
  /** Runs until it is stopped. */
  forever(): Argv;
  /** Writes `bytes` bytes to its output. */
  flood(bytes: number): Argv;
  /** A program that isn't there. */
  missing(): Argv;
}

export interface ContractTarget {
  name: string;
  makeBackend(): ExecutionBackend;
  spec(): SessionSpec;
  cwd: string;
  programs: ContractPrograms;
  /** A limit short enough for `forever` to reach. */
  shortTimeoutMs: number;
}

export function sessionContract(target: ContractTarget): void {
  describe(`${target.name}: execution session contract (D9, D33)`, () => {
    const open = () => target.makeBackend().open(target.spec());
    const run = (session: ExecutionSession, argv: Argv, extra: Partial<ExecRequest> = {}) => session.exec({ argv, cwd: target.cwd, timeoutMs: 10_000, maxOutputBytes: 1_024, ...extra });
    const { programs } = target;

    it("runs a program without a shell and returns its output and exit code", async () => {
      const session = await open();
      try {
        const ok = await run(session, programs.print("hi", "warn"));
        assert.deepEqual([ok.exitCode, ok.stdout, ok.stderr, ok.timedOut, ok.cancelled, ok.persisted], [0, "hi", "warn", false, false, true]);
        assert.equal((await run(session, programs.exit(3))).exitCode, 3);
        // Shell syntax is just an argument: nothing interprets it.
        assert.equal((await run(session, programs.echo("$HOME && echo pwned"))).stdout, "$HOME && echo pwned");
      } finally {
        await session.close();
      }
    });

    it("tells onRunning once a command is running, and only once", async () => {
      const session = await open();
      try {
        let running = 0;
        const result = await run(session, programs.print("ran", ""), { onRunning: () => running++ });
        assert.deepEqual([result.exitCode, running], [0, 1]);
      } finally {
        await session.close();
      }
    });

    it("stops a command at its time limit, and says so", async () => {
      const session = await open();
      try {
        const result = await run(session, programs.forever(), { timeoutMs: target.shortTimeoutMs });
        assert.deepEqual([result.timedOut, result.cancelled], [true, false]);
        assert.notEqual(result.exitCode, 0);
      } finally {
        await session.close();
      }
    });

    it("cancels a command once it has started, and says so", async () => {
      const session = await open();
      try {
        const controller = new AbortController();
        const result = await run(session, programs.forever(), { timeoutMs: 60_000, signal: controller.signal, onStart: () => controller.abort() });
        assert.deepEqual([result.cancelled, result.timedOut], [true, false]);
      } finally {
        await session.close();
      }
    });

    it("keeps output to its cap and says it was cut", async () => {
      const session = await open();
      try {
        const result = await run(session, programs.flood(100_000), { maxOutputBytes: 1_000 });
        assert.equal(result.truncated, true);
        assert.ok(result.stdout.length <= 1_000, `kept ${result.stdout.length} characters`);
      } finally {
        await session.close();
      }
    });

    it("never reports a missing program as a success, and runs nothing once closed", async () => {
      const session = await open();
      const missing = await run(session, programs.missing(), { timeoutMs: 5_000 }).then(
        (result) => result.exitCode,
        (error: Error) => error.name,
      );
      assert.ok(missing !== 0 && missing !== null, `a missing program ended ${String(missing)}`);
      await session.close();
      await assert.rejects(run(session, programs.exit(0)), ExecRefusedError);
    });

    it("gives the same report when closed twice, and never rejects", async () => {
      const session = await open();
      const first = await session.close();
      assert.equal(await session.close(), first);
    });
  });
}
