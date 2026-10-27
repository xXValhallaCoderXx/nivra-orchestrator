import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { commandFiles } from "../src/task/harness.ts";
import { firstWord, MAX_WRITE_BYTES, TOOLCHAIN_SCRIPT, toolchainFindings, toolchainRequest, WRITE_SCRIPT, writeContentProblem, writeRequest } from "../src/task/scripts.ts";
import { cleanUp, put, scratch } from "./workspace-fixtures.ts";

/**
 * The worker's fixed scripts (NIV-7, D39), run with this machine's own sh and tools, as the stand-in guest runs them;
 * the live probe runs them on busybox. A write must give back exactly the bytes it was given, whatever they hold.
 */
after(cleanUp);

/** Runs a write as the session would, with this machine's tools, in `workspace`. */
function write(workspace: string, path: string, content: string, created: boolean) {
  const request = writeRequest({ workspace, path, content, created, applets: "", timeoutMs: 30_000 });
  const [program, ...args] = request.argv;
  return spawnSync(program, args, { cwd: workspace, encoding: "utf8" });
}

const TRICKY: Array<[string, string]> = [
  ["empty", ""],
  ["printf's own directives", "%s %d %% %b %n\n"],
  ["backslashes", "a\\nb\\tc\\\\d\\0e\\x41\n"],
  ["a leading dash", "-n -e --version\n"],
  ["CRLF", "one\r\ntwo\r\n"],
  ["trailing newlines", "x\n\n\n"],
  ["no final newline", "last line"],
  ["emoji and combining marks", "café é 👩🏽‍💻 \u{1F600}\n"],
  ["a byte-order mark", "﻿bom\n"],
  ["quotes and substitutions", "it's \"$HOME\" `id` $(id) ${PATH}\n"],
  ["the most one write carries", `${"x".repeat(MAX_WRITE_BYTES - 1)}\n`],
];

describe("a write (NIV-7, D39)", () => {
  for (const [name, content] of TRICKY) {
    it(`gives back exactly the bytes it was given: ${name}`, () => {
      const workspace = scratch("write");
      const ran = write(workspace, "out.txt", content, true);
      assert.equal(ran.status, 0, ran.stderr);
      const back = readFileSync(join(workspace, "out.txt"));
      assert.equal(back.byteLength, Buffer.byteLength(content));
      assert.ok(back.equals(Buffer.from(content, "utf8")), "the bytes written differ from the content");
    });
  }

  it("makes a new file's folders, and the file 0644 whatever the umask", () => {
    const workspace = scratch("write");
    const previous = process.umask(0o077);
    try {
      const ran = write(workspace, "deep/er/new.sh", "echo hi\n", true);
      assert.equal(ran.status, 0, ran.stderr);
    } finally {
      process.umask(previous);
    }
    assert.equal(lstatSync(join(workspace, "deep/er/new.sh")).mode & 0o777, 0o644);
  });

  it("keeps an edited file's mode, an executable one included", () => {
    const workspace = scratch("write");
    put(workspace, "run.sh", { executable: "echo old\n" });
    const ran = write(workspace, "run.sh", "echo new\n", false);
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual([lstatSync(join(workspace, "run.sh")).mode & 0o777, readFileSync(join(workspace, "run.sh"), "utf8")], [0o755, "echo new\n"]);
  });

  it("is one persisted command the engine owns, with the content as one argument", () => {
    const request = writeRequest({ workspace: "/workspace", path: "src/a.ts", content: "x", created: false, timeoutMs: 30_000 });
    assert.deepEqual([request.argv.slice(0, 2), request.argv[2] === WRITE_SCRIPT, request.argv.slice(3), request.persist, request.label], [["/bin/sh", "-c"], true, ["nivra-write", "/workspace", "/bin/busybox", "src/a.ts", "src", "x", "edit"], true, "write"]);
  });

  it("refuses content it can't carry exactly, before anything is sent", () => {
    assert.equal(writeContentProblem("fine\n"), null);
    assert.match(writeContentProblem("x".repeat(MAX_WRITE_BYTES + 1)) ?? "", /over the 32768/);
    assert.match(writeContentProblem("\uD800 lone") ?? "", /lone surrogate/);
    assert.match(writeContentProblem("a\0b") ?? "", /NUL/);
    assert.match(writeContentProblem(`token = "ghp_${"a1B2".repeat(9)}"\n`) ?? "", /GitHub token/);
    assert.match(writeContentProblem("key: sk-the-vaults-own-value\n", ["sk-the-vaults-own-value"]) ?? "", /a value Nivra keeps as a secret/);
  });
});

describe("the toolchain probe (NIV-7, D39)", () => {
  it("says which programs are there, built-ins included, and which aren't, installing nothing", () => {
    const workspace = scratch("toolchain");
    const programs = ["/bin/sh", ".", "printf", "nivra-no-such-tool"];
    const request = toolchainRequest({ workspace, programs, timeoutMs: 30_000 });
    const [program, ...args] = request.argv;
    const ran = spawnSync(program, args, { cwd: workspace, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual([...toolchainFindings(programs, ran.stdout)], [["/bin/sh", "present"], [".", "present"], ["printf", "present"], ["nivra-no-such-tool", "missing"]]);
    assert.deepEqual([request.persist, request.argv[2] === TOOLCHAIN_SCRIPT], [false, true]);
  });

  it("calls a program it wasn't told about unknown, never present", () => {
    assert.deepEqual([...toolchainFindings(["node", "python3"], "present node\npresent python3x\nmissing other\n")], [["node", "present"], ["python3", "unknown"]]);
  });

  it("takes a command line's program only when its first word is a plain one", () => {
    const cases: Array<[string, string | null]> = [
      ["/bin/sh check.sh", "/bin/sh"],
      [". ./greet.sh; greet Ada; greet", "."],
      ["  npm test", "npm"],
      ["make&&make check", "make"],
      ["FOO=1 make", null],
      ["$SHELL -c x", null],
      ["'my tool' x", null],
      ["(cd sub; make)", null],
      ["-rf /", null],
      ["", null],
      // A path inside the workspace is the commit's, not the image's; a function the line defines isn't a program.
      ["./check.sh", null],
      ["bin/check --all", null],
      ["../tools/x", null],
      ["/usr/bin/env node x.js", "/usr/bin/env"],
      ["f() { echo hi; }; f", null],
      ["f () { echo hi; }; f", null],
    ];
    assert.deepEqual(cases.map(([line]) => firstWord(line)), cases.map(([, word]) => word));
  });
});

describe("the repository files a case's or check's command runs (NIV-7, D39)", () => {
  const FILES = new Set(["check.sh", "greet.sh", "scripts/run.sh", "my script.sh"]);

  it("reads plain and quoted names as written, and calls a line it can't read unclear, never guessing", () => {
    const cases: Array<[string, string[], boolean]> = [
      ["/bin/sh check.sh", ["check.sh"], false],
      [". ./greet.sh; greet Ada; greet", ["greet.sh"], false],
      // Quoted literals, and a mix of quoted and plain, as the shell reads them.
      ["/bin/sh 'check.sh'", ["check.sh"], false],
      ['/bin/sh "check.sh"', ["check.sh"], false],
      ["./'scripts/run.sh'", ["scripts/run.sh"], false],
      ["sh 'my script.sh'", ["my script.sh"], false],
      ["sh scripts/../check.sh", ["check.sh"], false],
      // A command quoted as one word, an option's value, a redirection, a test's brackets, a group and comments.
      ["sh -c 'sh check.sh'", ["check.sh"], false],
      [`sh -c "sh 'check.sh'"`, ["check.sh"], false],
      ["node --require=./check.sh x", ["check.sh"], false],
      ["sh < check.sh 2>&1", ["check.sh"], false],
      ["[ -f greet.sh ] && sh check.sh", ["check.sh", "greet.sh"], false],
      ["{ sh check.sh; }", ["check.sh"], false],
      ["sh check.sh # and greet.sh", ["check.sh"], false],
      ["# first\nsh check.sh", ["check.sh"], false],
      ["sh '~/x' '$X'", [], false],
      // What can't be read for sure: an expansion, a substitution, a pattern, an escape, a quote left open, a
      // here-document, a tilde, a command built to run, a change of folder.
      ['sh "$X"', [], true],
      ['sh -c "$(cat check.sh)"', [], true],
      ["sh `echo check.sh`", [], true],
      ['S=check.sh; /bin/sh "$S"', ["check.sh"], true],
      ["sh *.sh", [], true],
      ["sh check[0-9].sh", [], true],
      ["sh {check,greet}.sh", [], true],
      ["sh my\\ script.sh", [], true],
      ['echo "open', [], true],
      ["sh <<EOF\nsh check.sh\nEOF", ["check.sh"], true],
      ["sh ~/check.sh", [], true],
      ["eval sh check.sh", ["check.sh"], true],
      ["ls | xargs sh", [], true],
      ["cd scripts && sh run.sh", [], true],
    ];
    assert.deepEqual(cases.map(([line]) => commandFiles(line, FILES)), cases.map(([, files, unclear]) => ({ files, unclear })));
  });
});
