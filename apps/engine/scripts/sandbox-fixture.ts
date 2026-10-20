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

/** What the approved recipe sends, pinned: the run is refused if the fixture it builds isn't this one. */
export const APPROVED = {
  baseline: "b04b10aac088fd96d440b05a1b56813fcf6471ac",
  archiveSha256: "7e575cbbc775b42241e9d0c41052110e223f1a04df9a9e71c70095716677d77a",
  listingDigest: "279fce560cbe72977234ad7245df9dc5096e545a07653173279d17a5acb00dfa",
  archiveBytes: 18_944,
} as const;

/**
 * The fixed edit: a fixed script, given the workspace as $1 and run from it, so it never relies on the service's own
 * working folder. It edits, deletes, changes a mode, edits a binary and adds a long path.
 */
export const EDIT_SCRIPT = [
  "set -e",
  'cd "$1"',
  `printf '#!/bin/sh\\necho "Hello, Nivra"\\n' > src/greet.sh`,
  "rm old.txt",
  "chmod 0755 tool.sh",
  "printf '\\001\\000NIVRA\\000\\377' > data.bin",
  `mkdir -p "${dirname(LONG_ADDED)}"`,
  `printf 'added by the fixed edit\\n' > "${LONG_ADDED}"`,
].join("\n");

/** The checks: each a fixed script, given the workspace as $1. */
export const CHECK_SCRIPT = 'cd "$1" && exec sh bin/check.sh';
export const FAIL_SCRIPT = 'cd "$1" && exec sh bin/fail.sh';

/**
 * The errors an attempt gives when there is no network to try: no name resolves, and no route leads anywhere. Any
 * other failure (an HTTP error, a refused connection, a missing wget) proves nothing about the network.
 */
export const NETWORK_FAILURE = /bad address|Network unreachable|Network is unreachable|No route to host/;

/**
 * The network attempt. It prints the folder it runs in (recorded, to show whether the service honours a step's
 * folder), the interfaces there are, busybox's version, then the two targets, by name and by IP. It succeeds only
 * when loopback is the one interface and each attempt failed for want of a network.
 */
export const NETWORK_SCRIPT = [
  'echo "cwd: $(pwd)"',
  'interfaces="$(ls /sys/class/net | tr "\\n" " ")"',
  'echo "interfaces: $interfaces"',
  'echo "busybox: $(busybox 2>&1 | head -n 1)"',
  "blocked=0",
  'for target in "$1" "$2"; do',
  '  if wget -q -T 5 -O /dev/null "$target" 2>/tmp/nivra-network; then echo "REACHED $target"',
  `  elif grep -qE "${NETWORK_FAILURE.source}" /tmp/nivra-network; then blocked=$((blocked + 1)); echo "BLOCKED $target: $(head -c 200 /tmp/nivra-network)"`,
  '  else echo "UNCLEAR $target: $(head -c 200 /tmp/nivra-network)"; fi',
  "done",
  '[ "$interfaces" = "lo " ] && [ "$blocked" -eq 2 ]',
].join("\n");

/**
 * Whether the network step showed networking off, by behaviour: loopback alone, and both targets failing for want of a
 * network, nothing reached and nothing unclear. The positive control that those targets connect with networking on is
 * D28's (the name; the IP's "Network unreachable" needs none: there is no route at all).
 */
export function networkVerdict(exitCode: number | null, stdout: string, deny: { byName: string; byIp: string } = DENY): { pass: boolean; detail: string } {
  const lines = stdout.split("\n");
  const blocked = (target: string) => lines.find((line) => line.startsWith(`BLOCKED ${target}: `));
  const only = lines.includes("interfaces: lo ");
  const both = [deny.byName, deny.byIp].map(blocked);
  const stray = lines.filter((line) => line.startsWith("REACHED ") || line.startsWith("UNCLEAR "));
  const pass = exitCode === 0 && only && both.every((line) => line !== undefined && NETWORK_FAILURE.test(line)) && stray.length === 0;
  return { pass, detail: [lines.find((line) => line.startsWith("interfaces: ")) ?? "no interfaces line", ...both.map((line, index) => line ?? `no BLOCKED line for ${index ? deny.byIp : deny.byName}`), ...stray].join(" | ") };
}

/** The targets D28 denied, and connected to with networking on (its positive control, 20 October). */
export const DENY = { byName: "http://example.com/", byIp: "http://104.20.23.154/" } as const;

/** alpine:3.20, as the service listed it on 20 October (D28). */
export const IMAGE = { uuid: "befe20f2-5c2c-3027-9961-314b5f218ea4", tag: "alpine:3.20" } as const;

/**
 * The recipe's steps, in order; the composition opens the session first (the prepare step) and collects last. A
 * timeout and a prescribed stop are there to be seen through the adapter.
 */
export function fixtureRecipe(options: { workspace?: string; deny?: { byName: string; byIp: string } } = {}): PrescribedStep[] {
  const workspace = options.workspace ?? "/workspace";
  const deny = options.deny ?? DENY;
  return [
    { label: "edit", argv: ["/bin/sh", "-c", EDIT_SCRIPT, "nivra-edit", workspace], timeoutMs: 60_000, keeps: true },
    { label: "network", argv: ["/bin/sh", "-c", NETWORK_SCRIPT, "nivra-network", deny.byName, deny.byIp], timeoutMs: 60_000, keeps: false },
    { label: "check", argv: ["/bin/sh", "-c", CHECK_SCRIPT, "nivra-check", workspace], timeoutMs: 30_000, keeps: false },
    { label: "failing check", argv: ["/bin/sh", "-c", FAIL_SCRIPT, "nivra-failing-check", workspace], timeoutMs: 30_000, keeps: false },
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
