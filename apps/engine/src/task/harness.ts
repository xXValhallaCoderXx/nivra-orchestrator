import { posix } from "node:path";
import { baselinePattern, TASK_BRIEF_LIMITS, type BaselineSelection, type TaskBaselineCheck } from "@nivra/domain";
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
  /** Files its command names that the change adds or changes: a check's, and a case's, which judges only what it prints. */
  changedFiles: string[];
  /** Its command's files can't be told for sure, and the change changes files: what it runs may be among them. */
  unclear: boolean;
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

const base = (kind: CheckResult["kind"], number: number, name: string): CheckResult => ({ kind, number, name, verdict: "not-run", reason: null, exitCode: null, stdoutTail: "", stderrTail: "", difference: null, changedFiles: [], unclear: false, durationMs: null });

/** A case or check the run didn't reach, or couldn't send, and why. */
export function notRun(kind: CheckResult["kind"], number: number, name: string, reason: string): CheckResult {
  return { ...base(kind, number, name), reason };
}

/** A case or check whose program the toolchain probe found missing: it never ran. */
export function couldntRun(kind: CheckResult["kind"], number: number, name: string, program: string): CheckResult {
  return { ...base(kind, number, name), verdict: "couldnt-run", reason: `couldn't run: ${program} isn't in the sandbox image (nothing was installed, and nothing ran on your computer)` };
}

/**
 * A session's refusal in Nivra's fixed words (D29). Its own templates name a program, a guest path or an HTTP status,
 * but one can wrap text from below them, a journal's path among it, so only these words leave the engine: to the
 * model, the run's events or its report.
 */
export function refusalWords(error: ExecRefusedError): string {
  const said = error.message;
  if (/There isn't enough time left in this run|There wasn't time left in this run|The time for this work ran out/.test(said)) return "there isn't time left in this run for it";
  if (/^This session has started \d+ operations, the most one session may/.test(said)) return "this run has started the most operations it may";
  if (/holds the sandbox's key or project id/.test(said)) return "it holds the sandbox's key or project id, which no command may carry";
  if (/cancelled before anything was sent/.test(said)) return "the run was cancelled";
  if (/^The sandbox no longer has this workspace's saved state/.test(said)) return "the sandbox no longer has the workspace's saved state, so nothing more can run in this session";
  if (/^Nebius turned the key down/.test(said)) return "Nebius turned the key down";
  if (/^Nebius is limiting requests/.test(said)) return "Nebius is limiting requests";
  return "the sandbox session refused it";
}

/** What sending it threw, as a result: an uncertain dispatch is unknown; a refusal means it never ran. */
export function failedToSend(kind: CheckResult["kind"], number: number, name: string, error: unknown): CheckResult {
  if (error instanceof ExecUncertainError) return { ...base(kind, number, name), verdict: "unknown", reason: "it isn't known whether it started, so it wasn't sent again" };
  if (error instanceof ExecRefusedError) return notRun(kind, number, name, `it wasn't sent: ${refusalWords(error)}`);
  return { ...base(kind, number, name), verdict: "unknown", reason: "the sandbox couldn't say how it went" };
}

/** What a run's end says before its output is judged: a cancel, a timeout or a signal decides it. Null when it ended on its own. */
function ending(ran: ExecResult, timeoutMs: number): Pick<CheckResult, "verdict" | "reason"> | null {
  if (ran.cancelled) return { verdict: "unknown", reason: "it was cancelled while it ran" };
  if (ran.timedOut) return { verdict: "failed", reason: `it ran out of its ${Math.round(timeoutMs / 1000)} s` };
  if (ran.signal) return { verdict: "failed", reason: `a signal (${ran.signal}) ended it` };
  if (ran.exitCode === null) return { verdict: "unknown", reason: "the sandbox didn't say how it ended" };
  // Output the sandbox didn't report as text is never taken for what was printed: an empty string would match "".
  if (ran.stdoutExact === false) return { verdict: "unknown", reason: "the sandbox didn't report what it printed as text, so it couldn't be compared" };
  return null;
}

/**
 * A baseline selection, judged by the engine before the model (D41): its exit code, and its exact output or a pattern
 * its whole output must match (`baselinePattern`). A selection that fails for the bug the task fixes matches when it fails as the brief says:
 * that is told apart from one that can't run. A pattern is matched against at most `patternInputBytes` of output.
 */
export function judgeBaseline(number: number, given: BaselineSelection, ran: ExecResult, timeoutMs: number = TASK_LIMITS.checks.timeoutMs): TaskBaselineCheck {
  const result: TaskBaselineCheck = { number, name: given.name, matched: false, reason: null, exitCode: ran.exitCode, stdoutTail: tailOf(ran.stdout), stderrTail: tailOf(ran.stderr), durationMs: ran.durationMs };
  const ended = ending(ran, timeoutMs);
  if (ended) return { ...result, matched: ran.cancelled ? null : false, reason: ended.reason };
  if (ran.truncated) return { ...result, reason: "it printed more than Nivra compares" };
  let why: string | null = null;
  if (given.expectedOutput !== undefined) {
    const difference = firstDifference(given.expectedOutput, ran.stdout);
    if (difference) why = `its output differs from the expected output at line ${difference.line}`;
  } else if (Buffer.byteLength(ran.stdout) > TASK_BRIEF_LIMITS.patternInputBytes) why = "its output is longer than Nivra matches a pattern against";
  else if (given.outputPattern === undefined || !baselinePattern(given.outputPattern).test(ran.stdout)) why = "its output doesn't match the pattern";
  const exit = ran.exitCode === given.expectedExitCode ? null : `it exited ${String(ran.exitCode)}, not ${given.expectedExitCode}`;
  if (!why && !exit) return { ...result, matched: true };
  return { ...result, reason: [why, exit].filter(Boolean).join(", and ") };
}

/**
 * An acceptance case, judged by the engine: the exact output and exit code, or a failure saying what differed. The
 * files its command names that the change adds or changes are named beside it: a case judges only what its command
 * prints, and a script it runs is the worker's to change.
 */
export function judgeCase(number: number, given: AcceptanceCase, ran: ExecResult, named: NamedFiles = { files: [], unclear: false }, timeoutMs: number = TASK_LIMITS.checks.timeoutMs): CheckResult {
  const result: CheckResult = { ...base("case", number, given.name), exitCode: ran.exitCode, stdoutTail: tailOf(ran.stdout), stderrTail: tailOf(ran.stderr), changedFiles: named.files, unclear: named.unclear, durationMs: ran.durationMs };
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
export function judgeCheck(number: number, command: string, ran: ExecResult, named: NamedFiles, timeoutMs: number = TASK_LIMITS.checks.timeoutMs): CheckResult {
  const result: CheckResult = { ...base("check", number, clip(command, 80)), exitCode: ran.exitCode, stdoutTail: tailOf(ran.stdout), stderrTail: tailOf(ran.stderr), changedFiles: named.files, unclear: named.unclear, durationMs: ran.durationMs };
  const ended = ending(ran, timeoutMs);
  if (ended) return { ...result, ...ended };
  return ran.exitCode === 0 ? { ...result, verdict: "passed" } : { ...result, verdict: "failed", reason: `it exited ${String(ran.exitCode)}` };
}

/** What a command line says of the repository files it runs (D39). */
export interface NamedFiles {
  /** The files among those given that it names, sorted. */
  files: string[];
  /** It holds something Nivra can't read for sure, so what it runs may be any file. */
  unclear: boolean;
}

/** Words that are shell syntax when they stand alone: a test's brackets, a group's braces, a negation. */
const SYNTAX = new Set(["[", "]", "[[", "]]", "{", "}", "!"]);
/** Commands after which a line's names can't be read: ones that build a command to run, or move to another folder. */
const UNREADABLE = new Set(["eval", "xargs", "cd", "pushd"]);

/**
 * The repository files a command line names, among `files`, read from its words, under `./` or not. A word counts only
 * when it is plain: unquoted characters with no shell meaning, single-quoted text, and double-quoted text holding no
 * `$`, backtick or backslash, in any mix, so `'check.sh'` and `./'bin/run.sh'` are read as written. A plain word that
 * holds a command of its own (`sh -c 'sh check.sh'`) is read as one, and so is an option's value (`--file=check.sh`).
 * Anything else (an expansion, a substitution, a pattern, an escape, a quote left open, a here-document, `eval`,
 * `xargs`, a change of folder) makes the line unclear: Nivra can't tell which files it runs. This is no shell parser:
 * it says what it can read, and that it couldn't read the rest.
 */
export function commandFiles(command: string, files: ReadonlySet<string>, depth = 0): NamedFiles {
  const words: Array<{ text: string; bare: string; quotedStart: boolean }> = [];
  let unclear = false;
  let text = "";
  let bare = "";
  let open = false;
  let plain = true;
  let quotedStart = false;
  const close = () => {
    if (open) {
      if (plain) words.push({ text, bare, quotedStart });
      else unclear = true;
    }
    [text, bare, open, plain, quotedStart] = ["", "", false, true, false];
  };
  scan: for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, at + 1);
      if (end < 0) {
        unclear = true;
        break scan;
      }
      const inside = command.slice(at + 1, end);
      if (char === '"' && /[$`\\]/.test(inside)) plain = false;
      if (!open) quotedStart = true;
      text += inside;
      open = true;
      at = end;
      continue;
    }
    if (/\s/.test(char) || ";&|()".includes(char)) {
      close();
      continue;
    }
    if (char === "<" || char === ">") {
      close();
      // A here-document's body is any text at all.
      if (char === "<" && command[at + 1] === "<") unclear = true;
      continue;
    }
    // A comment: nothing more on its line runs.
    if (char === "#" && !open) {
      const end = command.indexOf("\n", at);
      if (end < 0) break scan;
      at = end;
      continue;
    }
    if ("$`\\*?".includes(char)) plain = false;
    text += char;
    bare += char;
    open = true;
  }
  close();
  const named = new Set<string>();
  const fileOf = (written: string) => {
    const path = posix.normalize(written).replace(/^\.\//, "");
    return files.has(path) ? path : null;
  };
  for (const word of words) {
    const path = fileOf(word.text) ?? (word.text.includes("=") ? fileOf(word.text.slice(word.text.indexOf("=") + 1)) : null);
    if (path !== null) {
      named.add(path);
      continue;
    }
    if (UNREADABLE.has(word.text)) unclear = true;
    else if (word.text === word.bare && SYNTAX.has(word.text)) continue;
    // A pattern or a brace expansion, or a tilde at its start, outside quotes.
    else if (/[[\]{}]/.test(word.bare) || (!word.quotedStart && word.text.startsWith("~"))) unclear = true;
    else if (/[\s;&|()<>]/.test(word.text)) {
      // A command quoted as one word, as `sh -c` takes it.
      if (depth >= 3) unclear = true;
      else {
        const inner = commandFiles(word.text, files, depth + 1);
        for (const file of inner.files) named.add(file);
        unclear ||= inner.unclear;
      }
    }
  }
  return { files: [...named].sort(), unclear };
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
