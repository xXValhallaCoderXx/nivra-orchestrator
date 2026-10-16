import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const MAIN = fileURLToPath(new URL("../src/main/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.ts$/.test(entry.name) ? [join(dir, entry.name)] : []));
}

describe("desktop source rules", () => {
  it("keeps targets and the supervisor free of Electron, so node --test can drive them on any OS (D12)", () => {
    const plainNode = [...files(join(MAIN, "targets")), join(MAIN, "supervisor.ts")];
    const offenders = plainNode.filter((file) => /from\s+["']electron["']|require\(\s*["']electron["']\s*\)/.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders, []);
  });

  it("never starts a program through a shell (D9)", () => {
    const offenders = files(MAIN).filter((file) => /shell:\s*true/.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders, []);
  });
});
