import type { ExecRequest } from "../exec/backend.ts";
import { createHash } from "node:crypto";
import { credentialKinds } from "../exec/snapshot.ts";

/**
 * The engine's own commands for a task's worker (NIV-7, D39). The model never chooses a command: it asks a tool, and
 * the tool runs one of these fixed scripts, given everything as positional arguments, so nothing it says is ever
 * interpolated into a script. Every one runs with networking off, in the session's workspace.
 */

/** The most a write may carry: one argument, well under what an operation's arguments may hold. */
export const MAX_WRITE_BYTES = 32 * 1024;
export const MAX_REPLACEMENT_BYTES = 16 * 1024;
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_COMMAND_BYTES = 32 * 1024;

/** Fixed splice, with byte offsets computed from the verified copy. No model text becomes shell source. */
export const SPLICE_SCRIPT = [
  "set -e",
  'bb="$2"; cd "$1"; path="$3"; start="$5"; end="$6"',
  '[ -f "$path" ] && [ ! -L "$path" ]',
  'parent=$($bb dirname -- "$path")',
  'part="$parent"; while [ "$part" != . ]; do [ ! -L "$part" ]; part=$($bb dirname -- "$part"); done',
  'hash=$($bb sha256sum -- "$path"); [ "${hash%% *}" = "$4" ]',
  'size=$($bb stat -c %s -- "$path"); [ "$start" -ge 0 ] && [ "$end" -ge "$start" ] && [ "$end" -le "$size" ]',
  'mode=$($bb stat -c %a -- "$path")',
  'tmp=$($bb mktemp "$parent/.nivra-edit.XXXXXX")',
  'trap \'$bb rm -f -- "$tmp"\' 0',
  '{ $bb head -c "$start" -- "$path"; printf \'%s\' "$7" | $bb base64 -d; $bb tail -c "+$((end + 1))" -- "$path"; } > "$tmp"',
  'hash=$($bb sha256sum -- "$tmp"); [ "${hash%% *}" = "$8" ]',
  '$bb chmod "$mode" -- "$tmp"',
  '$bb mv -f -- "$tmp" "$path"',
].join("\n");

export function spliceRequest(input: { workspace: string; path: string; before: string; start: number; end: number; replacement: string; result: string; applets?: string; timeoutMs: number }): ExecRequest {
  const bytes = Buffer.from(input.replacement);
  if (bytes.length > MAX_REPLACEMENT_BYTES) throw new Error("The replacement exceeds the bounded splice payload.");
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const argv: [string, ...string[]] = ["/bin/sh", "-c", SPLICE_SCRIPT, "nivra-write", input.workspace, input.applets ?? "/bin/busybox", input.path, hash(input.before), String(input.start), String(input.end), bytes.toString("base64"), hash(input.result)];
  if (Buffer.byteLength(JSON.stringify(argv)) + 2048 > MAX_EDIT_COMMAND_BYTES) throw new Error("The encoded splice and its command overhead exceed the transport limit.");
  return { argv, cwd: input.workspace, timeoutMs: input.timeoutMs, maxOutputBytes: 4096, persist: true, label: "write" };
}

/**
 * A write: the file's whole new content, as one argument. $1 the workspace, $2 what runs the tools (busybox; empty for
 * this machine's own), $3 the path, $4 its folder ("" at the top), $5 the content, $6 `new` for a file that didn't
 * exist. `printf '%s'` writes the argument's bytes as they are, trailing newlines included. A redirect into a file
 * that exists keeps its mode; a new file is made 0644, whatever the sandbox's umask.
 */
export const WRITE_SCRIPT = [
  "set -e",
  'bb="$2"',
  'cd "$1"',
  '[ -z "$4" ] || $bb mkdir -p -- "$4"',
  "printf '%s' \"$5\" > \"$3\"",
  '[ "$6" != new ] || $bb chmod 644 -- "$3"',
].join("\n");

/** Why `content` can't be sent as a write, in words for the model; null when it can. */
export function writeContentProblem(content: string, knownValues: readonly string[] = [], maxBytes = MAX_WRITE_BYTES): string | null {
  const bytes = new TextEncoder().encode(content);
  // A lone surrogate has no UTF-8 form: encoding replaces it, so the text wouldn't come back as it was.
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== content) return "the content isn't well-formed text (it holds a lone surrogate)";
  if (content.includes("\0")) return "the content holds a NUL character, and a write carries text only";
  if (bytes.byteLength > maxBytes) return `the content is ${bytes.byteLength} bytes, over the ${maxBytes} this operation may carry`;
  const kinds = credentialKinds(bytes, knownValues);
  if (kinds.length) return `the content holds what looks like ${kinds.join(" and ")}, so it was never sent`;
  return null;
}

/** One write, persisted: the file's path and folder are relative to the workspace, and were checked before. */
export function writeRequest(input: { workspace: string; path: string; content: string; created: boolean; applets?: string; timeoutMs: number }): ExecRequest {
  const slash = input.path.lastIndexOf("/");
  return {
    argv: ["/bin/sh", "-c", WRITE_SCRIPT, "nivra-write", input.workspace, input.applets ?? "/bin/busybox", input.path, slash < 0 ? "" : input.path.slice(0, slash), input.content, input.created ? "new" : "edit"],
    cwd: input.workspace,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: 4_096,
    persist: true,
    label: "write",
  };
}

/**
 * The toolchain probe: whether each program the brief's commands start with is in the sandbox image, by `command -v`,
 * which both dash and busybox's sh have built in. It runs before the model starts, so a missing program stops the run
 * at once. Nothing is installed: a missing program is reported, never fetched.
 */
export const TOOLCHAIN_SCRIPT = ['for name in "$@"; do', '  if command -v "$name" > /dev/null 2>&1; then echo "present $name"; else echo "missing $name"; fi', "done"].join("\n");

/** A program name the probe can be given: a plain word or path, never an option. */
const PROGRAM = /^[A-Za-z0-9_./+][A-Za-z0-9_./+-]{0,127}$/;

/**
 * The first word of a command line, when it is a plain one that names something in the image: a program by name or
 * absolute path, or a built-in such as `.`. Null when the line starts with anything a plain word can't say (a quote, a
 * variable, an assignment, a subshell), so its program is never guessed; for a path inside the workspace (`./x.sh`,
 * `bin/x`), which is the commit's, not the image's; and for a function the line defines (`f() { … }; f`).
 */
export function firstWord(line: string): string | null {
  const match = /^\s*([^\s;&|()<>]+)(\s*\()?/.exec(line);
  const word = match?.[1] ?? null;
  if (word === null || match?.[2] !== undefined || /["'`$\\=*?[\]{}~#!]/.test(word)) return null;
  if (word.includes("/") && !word.startsWith("/")) return null;
  return PROGRAM.test(word) ? word : null;
}

/** The probe, disposable, for the programs named. */
export function toolchainRequest(input: { workspace: string; programs: readonly string[]; timeoutMs: number }): ExecRequest {
  return {
    argv: ["/bin/sh", "-c", TOOLCHAIN_SCRIPT, "nivra-toolchain", ...input.programs],
    cwd: input.workspace,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: 16_384,
    persist: false,
    label: "toolchain",
  };
}

/** What the probe said of each program: present, missing, or unknown when its output didn't say. */
export function toolchainFindings(programs: readonly string[], stdout: string): Map<string, "present" | "missing" | "unknown"> {
  const said = new Map<string, "present" | "missing">();
  for (const line of stdout.split("\n")) {
    const match = /^(present|missing) (.+)$/.exec(line);
    if (match && programs.includes(match[2]!) && !said.has(match[2]!)) said.set(match[2]!, match[1] as "present" | "missing");
  }
  return new Map(programs.map((program) => [program, said.get(program) ?? "unknown"]));
}
