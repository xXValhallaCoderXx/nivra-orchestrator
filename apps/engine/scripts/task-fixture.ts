import type { TaskBrief } from "../src/task/worker.ts";
import { MAX_WRITE_BYTES } from "../src/task/scripts.ts";
import { buildFixture, type FixtureFile } from "./sandbox-fixture.ts";

/**
 * The execution milestone's fixture (NIV-7, D39): a dependency-free POSIX sh repository with one bug and its check.
 * greet prints "Hello, NAME"; with no name it prints "Hello, " instead of "Hello, world". Both files use only sh
 * built-ins (printf, test, command substitution, sourcing), which dash and busybox's sh both have. It is described
 * byte for byte here and committed with a fixed author and time, so its baseline is always one commit. The offline
 * tests, the toolchain probe and the live worker run all use this one description.
 */

export const TASK_FIXTURE: readonly FixtureFile[] = [
  { path: "greet.sh", bytes: "greet() {\n  printf 'Hello, %s\\n' \"$1\"\n}\n" },
  { path: "check.sh", bytes: '. ./greet.sh\ngot=$(greet Ada; greet)\nwant=$(printf \'Hello, Ada\\nHello, world\')\nif [ "$got" = "$want" ]; then echo ok; else printf \'got: %s\\n\' "$got"; exit 1; fi\n' },
];

export const TASK_BRIEF: TaskBrief = {
  goal: "greet with no name says Hello, world",
  acceptanceCriteria: ["check.sh passes"],
  scope: "",
  exclusions: "",
  context: "",
  checks: ["/bin/sh check.sh"],
  acceptanceCases: [{ name: "greet with and without a name", command: ". ./greet.sh; greet Ada; greet", expectedOutput: "Hello, Ada\nHello, world\n", expectedExitCode: 0 }],
};

/** The fix: the name defaults to world. */
export const TASK_FIX = { path: "greet.sh", old_text: '"$1"', new_text: '"${1:-world}"' };
export const FIXED_GREET = "greet() {\n  printf 'Hello, %s\\n' \"${1:-world}\"\n}\n";

export function buildTaskFixture(root: string, git: string): { root: string; baseline: string } {
  return buildFixture(root, git, TASK_FIXTURE, "The execution milestone's fixture for Nivra's task worker");
}

/**
 * The toolchain probe's one write (D39): greet.sh fixed, followed by comment lines holding what a write must carry
 * exactly (printf's directives, backslashes, quotes and substitutions, CRLF, emoji and combining marks, a byte-order
 * mark), padded to the most one write carries, ending with blank lines. A comment changes nothing greet does, so the
 * acceptance case run after it sees the fix across operations.
 */
export function trickyGreet(): string {
  const lines = [
    FIXED_GREET.trimEnd(),
    "# printf's own directives: %s %d %% %b %n",
    "# backslashes: \\n \\t \\\\ \\0 \\x41",
    "# quotes and substitutions: it's \"$HOME\" `id` $(id) ${PATH}",
    "# a CRLF line\r",
    "# emoji and combining marks: café é 👩🏽‍💻 \u{1F600}",
    "# a byte-order mark: ﻿",
    "# -n -e --version: a leading dash",
  ];
  let text = `${lines.join("\n")}\n`;
  const end = "\n\n";
  const pad = "# padding to the most one write carries\n";
  while (Buffer.byteLength(text) + Buffer.byteLength(pad) + end.length <= MAX_WRITE_BYTES) text += pad;
  text += "#".repeat(MAX_WRITE_BYTES - Buffer.byteLength(text) - end.length) + end;
  return text;
}
