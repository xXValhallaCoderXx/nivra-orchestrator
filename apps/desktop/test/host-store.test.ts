import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { HostStore, migrateHostData, NO_SHARING, readSmallFile, writePrivateFile, type HostData } from "../src/main/host-store.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const record = (id: string, targetId: string, nativePath: string) => ({ id, targetId, nativePath, label: nativePath.split(/[\\/]/).at(-1)!, addedAt: "2026-10-16T10:00:00.000Z", sharing: NO_SHARING });
const hostData = (projects: HostData["projects"]): HostData => ({ version: 1, projects, preferences: [], preferencesRevision: 0 });
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("host records", () => {
  it("keeps web research off until it is turned on, and off again once a version that doesn't know it rewrites the file (D37)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra store "));
    dirs.push(dir);
    const path = join(dir, "nivra.json");
    const store = new HostStore(path);
    assert.equal(store.data.webResearch === true, false);
    store.update((data) => ({ ...data, webResearch: true }));
    assert.equal(new HostStore(path).data.webResearch, true);
    // An older version reads the file and writes it back without the setting it doesn't know.
    const older = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete older["webResearch"];
    writeFileSync(path, JSON.stringify(older));
    assert.equal(new HostStore(path).data.webResearch === true, false);
  });

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

  it("reads preferences written before intent and supersession existed, projects and all (D23)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra store "));
    dirs.push(dir);
    const path = join(dir, "nivra.json");
    const at = "2026-10-17T12:00:00.000Z";
    const older = { id: B, statement: "Tests sit next to the code", scope: "project", projectId: A, status: "confirmed", origin: "entered", revision: 2, createdAt: at, updatedAt: at, confirmedAt: at };
    writeFileSync(path, JSON.stringify({ version: 1, projects: [record(A, "local", "/home/odin/repo")], preferences: [older], preferencesRevision: 4 }));
    const store = new HostStore(path);
    assert.deepEqual([store.data.projects.map((p) => p.id), store.data.preferences.map((p) => [p.id, p.intent, p.revision]), store.data.preferencesRevision], [[A], [[B, "default", 2]], 4]);
    const [read] = store.data.preferences;
    assert.deepEqual([read?.supersedes, read?.supersededBy, read?.supersededAt, read?.evidence], [null, null, null, null], "fields added since read as none");
    assert.deepEqual(readdirSync(dir), ["nivra.json"], "nothing was set aside");
  });

  it("sets aside a file it can't read, under a name that keeps it, and starts empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra store "));
    dirs.push(dir);
    const path = join(dir, "nivra.json");
    // A record from a version that knows more than this one: an intent this version has never heard of.
    const at = "2026-10-17T12:00:00.000Z";
    const newer = { id: B, statement: "Use Vitest", scope: "project", projectId: A, intent: "insist", status: "confirmed", origin: "entered", revision: 1, createdAt: at, updatedAt: at, confirmedAt: at };
    const text = JSON.stringify({ version: 1, projects: [record(A, "local", "/home/odin/repo")], preferences: [newer], preferencesRevision: 1 });
    writeFileSync(path, text);
    const store = new HostStore(path);
    assert.deepEqual([store.data.projects.length, store.data.preferences.length], [0, 0]);
    const aside = readdirSync(dir).filter((name) => name.startsWith("nivra.json.unreadable-"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]!), "utf8"), text, "the file is kept as it was");
  });

  it("moves a Windows-drive folder added for WSL to the Windows engine, keeping its id, and merges a twin (D17)", () => {
    const data = hostData([
      record(A, "wsl:Ubuntu", "/mnt/c/Users/odin/repo"),
      record(B, "wsl:Ubuntu", "/home/odin/app"),
      record(C, "local", "D:\\Work\\Site"),
      record("44444444-4444-4444-8444-444444444444", "wsl:Ubuntu", "/mnt/d/work/site"),
    ]);
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
    assert.equal(migrateHostData(hostData([record(A, "wsl:Ubuntu", "/mnt/c/repo")]), "linux").changed, false);
    assert.equal(migrateHostData(hostData([record(B, "wsl:Ubuntu", "/home/odin/app")]), "win32").changed, false);
  });

  it("writes a private file only its owner can read, even over a file that could be read by others (D23)", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra export "));
    dirs.push(dir);
    const path = join(dir, "nivra-preferences.json");
    writeFileSync(path, "old", { mode: 0o644 });
    writePrivateFile(path, "new");
    assert.deepEqual([readFileSync(path, "utf8"), (statSync(path).mode & 0o777).toString(8), readdirSync(dir)], ["new", "600", ["nivra-preferences.json"]]);
  });

  it("leaves no temporary copy behind when writing a private file fails part way (D23)", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra export "));
    dirs.push(dir);
    // A child limited to 8 KiB per file, so the 64 KiB write fails after the temp file was made.
    const script = `import { writePrivateFile } from ${JSON.stringify(new URL("../src/main/host-store.ts", import.meta.url).href)};
      try { writePrivateFile(${JSON.stringify(join(dir, "nivra-preferences.json"))}, "x".repeat(65_536)); } catch (error) { console.log(error.code); }`;
    const child = spawnSync("bash", ["-c", 'ulimit -f 8 && exec "$0" --input-type=module -e "$1"', process.execPath, script], { encoding: "utf8" });
    assert.deepEqual([child.stdout.trim(), readdirSync(dir)], ["EFBIG", []], child.stderr.slice(0, 500));
  });

  it("reads a small file whole, and refuses a larger one or one that isn't a regular file, never waiting on a pipe (D23)", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "nivra import "));
    dirs.push(dir);
    const file = join(dir, "nivra-preferences.json");
    writeFileSync(file, "x".repeat(100));
    const fifo = join(dir, "pipe");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    assert.deepEqual(
      [readSmallFile(file, 100), readSmallFile(file, 99), readSmallFile(dir, 100), readSmallFile(fifo, 100)],
      [{ text: "x".repeat(100) }, { refused: "too-large" }, { refused: "not-a-file" }, { refused: "not-a-file" }],
    );
    // A file that reports no size is still read only up to the limit.
    assert.deepEqual([statSync("/proc/self/status").size, readSmallFile("/proc/self/status", 10)], [0, { refused: "too-large" }]);
  });
});
