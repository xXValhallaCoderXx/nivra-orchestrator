import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** Rules the engine's source must keep, checked by reading it (AGENTS.md: platform and execution boundary rules). */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|mjs)$/.test(entry.name) ? [{ path: relative(SRC, path), text: readFileSync(path, "utf8") }] : [];
  });
}

const offenders = (pattern: RegExp, except: readonly string[] = []) =>
  sources(SRC)
    .filter((file) => !except.includes(file.path.replaceAll("\\", "/")) && pattern.test(file.text))
    .map((file) => file.path);

describe("engine source rules", () => {
  it("never lets a child inherit the engine's stdio, which carries the protocol (D2)", () => {
    assert.deepEqual(offenders(/["']inherit["']/), []);
  });

  it("never starts a program through a shell (D9)", () => {
    assert.deepEqual(offenders(/shell:\s*true/), []);
  });

  it("exits only from the launcher, after the last reply is written (D4)", () => {
    assert.deepEqual(offenders(/process\.exit\(/, ["main.mjs"]), []);
  });
});
