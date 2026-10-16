import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { HostStore, migrateHostData, type HostData } from "../src/main/host-store.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const record = (id: string, targetId: string, nativePath: string) => ({ id, targetId, nativePath, label: nativePath.split(/[\\/]/).at(-1)!, addedAt: "2026-10-16T10:00:00.000Z" });
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("host records", () => {
  it("reads a file an older version wrote, dropping the chosen target it no longer keeps", () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra store "));
    dirs.push(dir);
    const path = join(dir, "nivra.json");
    writeFileSync(path, JSON.stringify({ version: 1, selectedTargetId: "wsl:Ubuntu", projects: [record(A, "local", "/home/odin/repo")] }));
    const store = new HostStore(path);
    assert.equal(store.data.projects.length, 1);
    store.update((data) => data);
    assert.equal(readFileSync(path, "utf8").includes("selectedTargetId"), false);
  });

  it("moves a Windows-drive folder added for WSL to the Windows engine, keeping its id, and merges a twin (D17)", () => {
    const data: HostData = {
      version: 1,
      projects: [record(A, "wsl:Ubuntu", "/mnt/c/Users/odin/repo"), record(B, "wsl:Ubuntu", "/home/odin/app"), record(C, "local", "D:\\Work\\Site"), record("44444444-4444-4444-8444-444444444444", "wsl:Ubuntu", "/mnt/d/work/site")],
    };
    const migrated = migrateHostData(data, "win32");
    assert.equal(migrated.changed, true);
    assert.deepEqual(
      migrated.data.projects.map((p) => [p.id, p.targetId, p.nativePath]),
      [
        [A, "local", "C:\\Users\\odin\\repo"],
        [B, "wsl:Ubuntu", "/home/odin/app"],
        [C, "local", "D:\\Work\\Site"],
      ],
    );
    assert.deepEqual([...migrated.notices.keys()].sort(), [A, C]);
  });

  it("leaves records alone off Windows and when there is nothing to move", () => {
    const data: HostData = { version: 1, projects: [record(A, "wsl:Ubuntu", "/mnt/c/repo")] };
    assert.equal(migrateHostData(data, "linux").changed, false);
    assert.equal(migrateHostData({ version: 1, projects: [record(B, "wsl:Ubuntu", "/home/odin/app")] }, "win32").changed, false);
  });
});
