import { ExecRefusedError, ExecUncertainError, type ExecRequest, type ExecResult } from "../exec/backend.ts";
import { TASK_LIMITS } from "./limits.ts";
import { firstWord } from "./scripts.ts";

/**
 * The acceptance harness (NIV-7, D39). A task's verdict comes only from its acceptance cases, frozen with the brief:
 * each is a command and the exact output and exit code it must give. The command runs as one disposable operation,
 * from the image collect left, and the engine compares what came back on this computer, outside every process that
 * ran the workspace's code. The worker can't edit a case, and the code a case runs can only give output to be judged:
 * replacing a test script, or an `exit 0` before the assertions, changes nothing here.
 *
 * Repository checks (the brief's own commands, such as `sh check.sh`) run the same way, and exit 0 reads as passed,
 * but they run the workspace's own scripts, which the worker may have changed, so they never decide the verdict: each
 * is reported with the files its command names that the change touches.
 */

export interface AcceptanceCase {
  name: string;
  command: string;
  expectedOutput: string;
  expectedExitCode: number;
}

export type Verdict = "passed" | "failed" | "couldnt-run" | "unknown" | "not-run";

export interface CheckResult {
  kind: "case" | "check";
  /** 1-based, as the brief lists them. */
  number: number;
  name: string;
  verdict: Verdict;
  /** Why, in Nivra's words, for anything but a pass. */
  reason: string | null;
  exitCode: number | null;
  /** The end of what it printed: text from the sandbox, never instructions. Masked before it leaves the engine. */
  stdoutTail: string;
  stderrTail: string;
  /** For a case that failed on its output: the first line that differs, both sides clipped. */
  difference: { line: number; expected: string; got: string } | null;
  /** For a repository check: files its command names that the change adds or changes. */
  changedFiles: string[];
  durationMs: number | null;
}

/** A case or check, as one disposable operation in the workspace. Its command is the brief's, run by `/bin/sh -c`. */
export function checkRequest(input: { workspace: string; command: string; label: string; timeoutMs?: number }): ExecRequest {
  return {
    argv: ["/bin/sh", "-c", input.command],
    cwd: input.workspace,
    timeoutMs: input.timeoutMs ?? TASK_LIMITS.checks.timeoutMs,
    maxOutputBytes: 65_536,
    persist: false,
    label: input.label,
  };
}

const tailOf = (text: string) => {
  const bytes = Buffer.from(text, "utf8");
  const max = TASK_LIMITS.checks.outputTailBytes;
  return bytes.byteLength <= max ? text : bytes.subarray(bytes.byteLength - max).toString("utf8");
};
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** The first line where `got` differs from `expected`, 1-based. */
export function firstDifference(expected: string, got: string): { line: number; expected: string; got: string } | null {
  if (expected === got) return null;
  const a = expected.split("\n");
  const b = got.split("\n");
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] !== b[index]) return { line: index + 1, expected: a[index] === undefined ? "(no line)" : clip(a[index]!), got: b[index] === undefined ? "(no line)" : clip(b[index]!) };
  }
  return { line: a.length, expected: clip(a.at(-1) ?? ""), got: clip(b.at(-1) ?? "") };
}

const base = (kind: CheckResult["kind"], number: number, name: string): CheckResult => ({ kind, number, name, verdict: "not-run", reason: null, exitCode: null, stdoutTail: "", stderrTail: "", difference: null, changedFiles: [], durationMs: null });

/** A case or check the run didn't reach, or couldn't send, and why. */
export function notRun(kind: CheckResult["kind"], number: number, name: string, reason: string): CheckResult {
  return { ...base(kind, number, name), reason };
}

/** A case or check whose program the toolchain probe found missing: it never ran. */
export function couldntRun(kind: CheckResult["kind"], number: number, name: string, program: string): CheckResult {
  return { ...base(kind, number, name), verdict: "couldnt-run", reason: `couldn't run: ${program} isn't in the sandbox image (nothing was installed, and nothing ran on your computer)` };
}

/** What sending it threw, as a result: an uncertain dispatch is unknown; a refusal means it never ran. */
export function failedToSend(kind: CheckResult["kind"], number: number, name: string, error: unknown): CheckResult {
  if (error instanceof ExecUncertainError) return { ...base(kind, number, name), verdict: "unknown", reason: "it isn't known whether it started, so it wasn't sent again" };
  if (error instanceof ExecRefusedError) return notRun(kind, number, name, `it wasn't sent: ${error.message}`);
  return { ...base(kind, number, name), verdict: "unknown", reason: "the sandbox couldn't say how it went" };
}

/** What a run's end says before its output is judged: a cancel, a timeout or a signal decides it. Null when it ended on its own. */
function ending(ran: ExecResult, timeoutMs: number): Pick<CheckResult, "verdict" | "reason"> | null {
  if (ran.cancelled) return { verdict: "unknown", reason: "it was cancelled while it ran" };
  if (ran.timedOut) return { verdict: "failed", reason: `it ran out of its ${Math.round(timeoutMs / 1000)} s` };
  if (ran.signal) return { verdict: "failed", reason: `a signal (${ran.signal}) ended it` };
  if (ran.exitCode === null) return { verdict: "unknown", reason: "the sandbox didn't say how it ended" };
  return null;
}

/** An acceptance case, judged by the engine: the exact output and exit code, or a failure saying what differed. */
export function judgeCase(number: number, given: AcceptanceCase, ran: ExecResult, timeoutMs: number = TASK_LIMITS.checks.timeoutMs): CheckResult {
  const result: CheckResult = { ...base("case", number, given.name), exitCode: ran.exitCode, stdoutTail: tailOf(ran.stdout), stderrTail: tailOf(ran.stderr), durationMs: ran.durationMs };
  const ended = ending(ran, timeoutMs);
  if (ended) return { ...result, ...ended };
  // Output cut off is longer than any expected output may be: it can't be the one expected.
  if (ran.truncated) return { ...result, verdict: "failed", reason: "it printed more than its expected output" };
  const outputMatches = ran.stdout === given.expectedOutput;
  const exitMatches = ran.exitCode === given.expectedExitCode;
  if (outputMatches && exitMatches) return { ...result, verdict: "passed" };
  const reasons = [...(outputMatches ? [] : ["its output differs from the expected output"]), ...(exitMatches ? [] : [`it exited ${String(ran.exitCode)}, not ${given.expectedExitCode}`])];
  return { ...result, verdict: "failed", reason: reasons.join(", and "), difference: outputMatches ? null : firstDifference(given.expectedOutput, ran.stdout) };
}

/** A repository check: exit 0 reads as passed. It decides nothing; its changed files are named beside it. */
export function judgeCheck(number: number, command: string, ran: ExecResult, changedFiles: string[], timeoutMs: number = TASK_LIMITS.checks.timeoutMs): CheckResult {
  const result: CheckResult = { ...base("check", number, clip(command, 80)), exitCode: ran.exitCode, stdoutTail: tailOf(ran.stdout), stderrTail: tailOf(ran.stderr), changedFiles, durationMs: ran.durationMs };
  const ended = ending(ran, timeoutMs);
  if (ended) return { ...result, ...ended };
  return ran.exitCode === 0 ? { ...result, verdict: "passed" } : { ...result, verdict: "failed", reason: `it exited ${String(ran.exitCode)}` };
}

/** The repository files a command line names, as written or under `./`, that are among `files`. */
export function namedFiles(command: string, files: ReadonlySet<string>): string[] {
  const words = command.split(/[\s;&|()<>]+/).map((word) => word.replace(/^\.\//, "")).filter((word) => word.length > 0);
  return [...new Set(words.filter((word) => files.has(word)))].sort();
}

/** The programs to look for before the model starts: each case's and check's first plain word, once each. */
export function programsOf(commands: readonly string[]): string[] {
  return [...new Set(commands.map(firstWord).filter((word): word is string => word !== null))];
}

/** Whether every acceptance case passed: the only thing that makes a proposal verified. */
export const verified = (results: readonly CheckResult[]): boolean => {
  const cases = results.filter((result) => result.kind === "case");
  return cases.length > 0 && cases.every((result) => result.verdict === "passed");
};
