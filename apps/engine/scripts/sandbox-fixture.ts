import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PrescribedStep } from "../src/exec/prescribed.ts";

/**
 * B3's synthetic fixture and its prescribed recipe (NIV-43, D35). The repository is described byte for byte here and
 * built at run time, so no `.gitattributes` of Nivra's own can touch it, and committed with a fixed author and time,
 * so its baseline is always the same commit. The fixed edit and checks that run on it are here too, with what they
 * must give. The offline tests, the fake guest and the live check all use this one description.
 */

export interface FixtureFile {
  path: string;
  bytes?: string | Uint8Array;
  mode?: "100644" | "100755";
  /** A link's target, instead of bytes. */
  link?: string;
}

const LONG_KEPT = `deep/${"nested-folder-with-a-long-name/".repeat(3)}and-a-file-whose-name-is-long.txt`;
/** A path the fixed edit adds, over 100 bytes, so its tar header needs a long-name record. */
export const LONG_ADDED = `added/${"another-folder-with-a-long-name/".repeat(3)}new-file-from-the-fixed-edit.txt`;

/** Under 4 KB: a long path, a UTF-8 name, a link, executables, an empty file, no final newline, CRLF kept, NUL bytes. */
export const FIXTURE: readonly FixtureFile[] = [
  { path: ".gitattributes", bytes: "*.bat -text\n" },
  { path: "README.md", bytes: "# Nivra sandbox check\n\nA synthetic fixture: nothing here is real.\n" },
  { path: "bin/check.sh", mode: "100755", bytes: '#!/bin/sh\n# Passes once the greeting is "Hello, Nivra".\ngreeting="$(sh src/greet.sh)"\nif [ "$greeting" = "Hello, Nivra" ]; then echo "PASS: $greeting"; else echo "FAIL: $greeting"; exit 1; fi\n' },
  { path: "bin/fail.sh", mode: "100755", bytes: '#!/bin/sh\necho "FAIL: this check fails on purpose"\nexit 1\n' },
  { path: "data.bin", bytes: new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00, 0x4e]) },
  { path: "docs/café.md", bytes: "# Café\n" },
  { path: "empty", bytes: "" },
  { path: LONG_KEPT, bytes: "kept\n" },
  { path: "link-to-readme", link: "README.md" },
  { path: "no-final-newline.txt", bytes: "the last line has no newline" },
  { path: "old.txt", bytes: "the fixed edit deletes this file\n" },
  { path: "src/greet.sh", mode: "100755", bytes: '#!/bin/sh\necho "Hello, world"\n' },
  { path: "tool.sh", bytes: "#!/bin/sh\necho tool\n" },
  { path: "windows.bat", bytes: "@echo off\r\necho hi\r\n" },
];

/** The fixture's one commit: a fixed author, committer and time. */
const IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "Nivra fixture",
  GIT_AUTHOR_EMAIL: "fixture@nivra.invalid",
  GIT_AUTHOR_DATE: "2026-10-20T00:00:00Z",
  GIT_COMMITTER_NAME: "Nivra fixture",
  GIT_COMMITTER_EMAIL: "fixture@nivra.invalid",
  GIT_COMMITTER_DATE: "2026-10-20T00:00:00Z",
};

/** Builds the fixture as a repository at `root` with `git`, and gives its baseline. */
export function buildFixture(root: string, git: string): { root: string; baseline: string } {
  mkdirSync(root, { recursive: true });
  for (const file of FIXTURE) {
    const full = join(root, file.path);
    mkdirSync(dirname(full), { recursive: true });
    if (file.link !== undefined) symlinkSync(file.link, full);
    else {
      writeFileSync(full, file.bytes ?? "");
      chmodSync(full, file.mode === "100755" ? 0o755 : 0o644);
    }
  }
  const env = { PATH: process.env["PATH"] ?? "", HOME: root, ...IDENTITY };
  const pins = ["-c", "core.autocrlf=false", "-c", "core.fileMode=true", "-c", "core.symlinks=true", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
  const run = (args: string[]) => {
    const result = spawnSync(git, [...pins, ...args], { cwd: root, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed while building the fixture: ${result.stderr.trim()}`);
    return result.stdout;
  };
  run(["init", "-q", "-b", "main"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "The synthetic fixture for Nivra's sandbox check"]);
  return { root, baseline: run(["rev-parse", "HEAD"]).trim() };
}

/** The fixed edit: a fixed script, run from the workspace. It edits, deletes, changes a mode, edits a binary and adds a long path. */
export const EDIT_SCRIPT = [
  "set -e",
  `printf '#!/bin/sh\\necho "Hello, Nivra"\\n' > src/greet.sh`,
  "rm old.txt",
  "chmod 0755 tool.sh",
  "printf '\\001\\000NIVRA\\000\\377' > data.bin",
  `mkdir -p "${dirname(LONG_ADDED)}"`,
  `printf 'added by the fixed edit\\n' > "${LONG_ADDED}"`,
].join("\n");

/**
 * The network attempt: the interfaces there are, busybox's version, then the two targets by name and by IP. It
 * succeeds only when both attempts fail: with networking off, neither may connect.
 */
export const NETWORK_SCRIPT = [
  'echo "interfaces: $(ls /sys/class/net | tr "\\n" " ")"',
  'echo "busybox: $(busybox 2>&1 | head -n 1)"',
  "blocked=0",
  'for target in "$1" "$2"; do',
  '  if wget -q -T 5 -O /dev/null "$target" 2>/tmp/nivra-network; then echo "REACHED $target"; else blocked=$((blocked + 1)); echo "BLOCKED $target: $(head -c 200 /tmp/nivra-network)"; fi',
  "done",
  '[ "$blocked" -eq 2 ]',
].join("\n");

/** The targets D28 denied, and connected to with networking on (its positive control, 20 October). */
export const DENY = { byName: "http://example.com/", byIp: "http://104.20.23.154/" } as const;

/** alpine:3.20, as the service listed it on 20 October (D28). */
export const IMAGE = { uuid: "befe20f2-5c2c-3027-9961-314b5f218ea4", tag: "alpine:3.20" } as const;

/**
 * The recipe's steps, in order; the composition opens the session first (the prepare step) and collects last. A
 * timeout and a prescribed stop are there to be seen through the adapter.
 */
export function fixtureRecipe(deny: { byName: string; byIp: string } = DENY): PrescribedStep[] {
  return [
    { label: "edit", argv: ["/bin/sh", "-c", EDIT_SCRIPT, "nivra-edit"], timeoutMs: 60_000, keeps: true },
    { label: "network", argv: ["/bin/sh", "-c", NETWORK_SCRIPT, "nivra-network", deny.byName, deny.byIp], timeoutMs: 60_000, keeps: false },
    { label: "check", argv: ["/bin/sh", "bin/check.sh"], timeoutMs: 30_000, keeps: false },
    { label: "failing check", argv: ["/bin/sh", "bin/fail.sh"], timeoutMs: 30_000, keeps: false },
    { label: "timeout", argv: ["/bin/sleep", "30"], timeoutMs: 5_000, keeps: false },
    { label: "stop", argv: ["/bin/sleep", "60"], timeoutMs: 60_000, keeps: false, stopAfterMs: 5_000 },
  ];
}

const text = (value: string) => new TextEncoder().encode(value);

/** What the fixed edit must change, and nothing else. */
export const EXPECTED_CHANGE = {
  deleted: ["old.txt"],
  added: [{ path: LONG_ADDED, mode: "100644", bytes: text("added by the fixed edit\n") }],
  changed: [
    { path: "data.bin", mode: "100644", bytes: new Uint8Array([0x01, 0x00, 0x4e, 0x49, 0x56, 0x52, 0x41, 0x00, 0xff]) },
    { path: "src/greet.sh", mode: "100755", bytes: text('#!/bin/sh\necho "Hello, Nivra"\n') },
    { path: "tool.sh", mode: "100755", bytes: text("#!/bin/sh\necho tool\n") },
  ],
  modeChanges: [{ path: "tool.sh", from: "100644", to: "100755" }],
} as const;

/** A workspace as the fake guest holds one: each file's bytes and executable bit, each link's target. */
export type GuestNode = { kind: "file"; bytes: Uint8Array; executable: boolean } | { kind: "link"; target: string };

/** The fixed edit, done in JavaScript, for the fake guest: a test runs the script itself and checks it does the same. */
export function applyFixedEdit(files: Map<string, GuestNode>): void {
  for (const change of [...EXPECTED_CHANGE.changed, ...EXPECTED_CHANGE.added]) files.set(change.path, { kind: "file", bytes: change.bytes, executable: change.mode === "100755" });
  for (const path of EXPECTED_CHANGE.deleted) files.delete(path);
}

/** What `bin/check.sh` prints and exits with for a workspace, for the fake guest. */
export function checkOutcome(files: Map<string, GuestNode>): { exitCode: number; stdout: string } {
  const greet = files.get("src/greet.sh");
  const greeting = greet?.kind === "file" ? /echo "([^"]*)"/.exec(new TextDecoder().decode(greet.bytes))?.[1] ?? "" : "";
  return greeting === "Hello, Nivra" ? { exitCode: 0, stdout: `PASS: ${greeting}\n` } : { exitCode: 1, stdout: `FAIL: ${greeting}\n` };
}
