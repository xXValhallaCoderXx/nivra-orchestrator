import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import {
  copyRunStore,
  finishSession,
  loadRecord,
  moveHome,
  noteAcceptanceHome,
  readRuns,
  Refused,
  restoreHome,
  saveRecord,
  stopEngines,
  type RecoveryRecord,
} from "../scripts/acceptance-state.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const uid = process.getuid!();

/** A person's home with an engine home in it, and a record for a session that will move it. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nivra acceptance ü%# "));
  dirs.push(root);
  const path = join(root, ".nivra");
  mkdirSync(join(path, "runtime", "abc"), { recursive: true });
  writeFileSync(join(path, "nivra.db"), "the person's runs");
  const file = join(root, "evidence", "recovery.json");
  const record: RecoveryRecord = {
    version: 1,
    run: "run-1",
    state: "planned",
    uid,
    user: "odin",
    distro: "Ubuntu",
    home: { path, movedTo: `${path}.niv14-run-1`, original: null, movedAt: null },
    acceptanceHomeIno: null,
    profiles: [],
    engines: [],
    evidence: join(root, "evidence"),
  };
  const saves: RecoveryRecord[] = [];
  const save = (r: RecoveryRecord) => {
    saves.push(structuredClone(r));
    saveRecord(r, [file]);
  };
  return { root, path, record, save, saves, file, proc: join(root, "proc") };
}

/** An engine home as an engine makes it: its stores and a runtime. */
function engineMade(path: string) {
  mkdirSync(join(path, "runtime", "def"), { recursive: true });
  writeFileSync(join(path, "nivra.db"), "the session's runs");
  writeFileSync(join(path, "mastra.db"), "");
}

const fakeProcess = (proc: string, pid: number, args: string[]) => {
  mkdirSync(join(proc, String(pid)), { recursive: true });
  writeFileSync(join(proc, String(pid), "cmdline"), `${args.join("\0")}\0`);
};

describe("acceptance sessions put the person's engine home back (NIV-14)", () => {
  it("moves the home aside only when nothing uses it and its place is free, saving the record first", () => {
    const { path, record, save, saves } = setup();
    assert.throws(() => moveHome(record, save, () => ["Nivra.exe (pid 7)"]), (error: unknown) => error instanceof Refused && /still uses/.test(error.message));
    mkdirSync(record.home!.movedTo);
    assert.throws(() => moveHome(record, save, () => []), /already exists/);
    rmSync(record.home!.movedTo, { recursive: true });
    assert.deepEqual([existsSync(path), saves.length], [true, 0], "nothing moved, nothing saved");

    const ino = statSync(path).ino;
    moveHome(record, save, () => []);
    assert.deepEqual(
      saves.map((s) => [s.state, s.home!.original?.ino ?? null, s.home!.movedAt !== null]),
      [["planned", ino, true], ["moved", ino, true]],
      "the original's identity is saved before the move",
    );
    assert.deepEqual([existsSync(path), statSync(record.home!.movedTo).ino], [false, ino]);
  });

  it("restores the original, keeps the session's home without its runtimes, and only checks when run again", () => {
    const { path, record, save } = setup();
    const ino = statSync(path).ino;
    moveHome(record, save, () => []);
    engineMade(path);
    noteAcceptanceHome(record, save);
    const notes = restoreHome(record, save);
    const kept = join(record.evidence, "wsl-home");
    assert.equal(notes.length, 2);
    assert.deepEqual([statSync(path).ino, readFileSync(join(path, "nivra.db"), "utf8"), record.state], [ino, "the person's runs", "restored"]);
    assert.deepEqual(readdirSync(kept).sort(), ["mastra.db", "nivra.db"], "its stores are kept, its runtimes aren't");
    assert.deepEqual(restoreHome(record, save), [`${path} is already the original`]);
  });

  it("refuses to restore over a folder that isn't the session's, leaving both untouched", () => {
    for (const foreign of ["unexpected entries", "another folder's inode"]) {
      const { path, record, save } = setup();
      moveHome(record, save, () => []);
      if (foreign === "unexpected entries") {
        engineMade(path);
        noteAcceptanceHome(record, save);
        writeFileSync(join(path, "notes.txt"), "someone's");
      } else {
        engineMade(path);
        noteAcceptanceHome(record, save);
        renameSync(path, `${path}.session`);
        engineMade(path);
      }
      assert.throws(() => restoreHome(record, save), (error: unknown) => error instanceof Refused && /nothing was restored or overwritten/.test(error.message), foreign);
      assert.deepEqual([existsSync(record.home!.movedTo), readFileSync(join(record.home!.movedTo, "nivra.db"), "utf8"), existsSync(path)], [true, "the person's runs", true], foreign);
    }
  });

  it("recovers from every state a session can die in, from the saved record", async () => {
    const states = ["planned, nothing moved", "planned, moved", "moved", "running", "stopped, inode not noted", "restored"] as const;
    for (const state of states) {
      const { path, record, save, file, proc } = setup();
      mkdirSync(proc);
      const ino = statSync(path).ino;
      const profile = join(record.evidence, "..", "profile");
      mkdirSync(join(profile, "logs"), { recursive: true });
      writeFileSync(join(profile, "logs", "local.log"), "a log");
      writeFileSync(join(profile, "secrets.json"), "the key");
      record.profiles = [profile];
      // The harness saves the planned record before it does anything else.
      save(record);
      if (state !== "planned, nothing moved") moveHome(record, save, () => []);
      if (state === "planned, moved") {
        // Died between the rename and the save that follows it.
        record.state = "planned";
        save(record);
      }
      if (state === "running" || state === "stopped, inode not noted") {
        engineMade(path);
        if (state === "running") noteAcceptanceHome(record, save);
        record.state = state === "running" ? "running" : "stopped";
        save(record);
      }
      if (state === "restored") restoreHome(record, save);

      const recovered = loadRecord(file);
      await finishSession(recovered, (r) => saveRecord(r, [file]), { proc, timeoutMs: 10 });
      assert.deepEqual(
        [statSync(path).ino, readFileSync(join(path, "nivra.db"), "utf8"), existsSync(recovered.home!.movedTo), loadRecord(file).state, existsSync(profile)],
        [ino, "the person's runs", false, "restored", false],
        state,
      );
      assert.equal(readFileSync(join(record.evidence, "logs", "final-profile", "local.log"), "utf8"), "a log", state);
    }
  });

  it("doesn't restore while a window could still start an engine on the home", async () => {
    const { path, record, save, proc } = setup();
    mkdirSync(proc);
    moveHome(record, save, () => []);
    await assert.rejects(finishSession(record, save, { proc, timeoutMs: 10, busy: () => ["Nivra.exe (pid 9)"] }), /still running, so .* wasn't restored yet/);
    assert.equal(existsSync(path), false, "the original stays where it was moved");
  });

  it("waits for engines, kills one only while it is still this session's, and refuses strangers", async () => {
    const { record, proc } = setup();
    const home = record.home!.path;
    const engine = (instance: string, at = home) => ["node", "main.mjs", "--stdio", "--home", at, "--instance", instance, "--heartbeat-ms", "1000", "--nivra-engine"];
    fakeProcess(proc, 4242, engine("i-1"));
    record.engines = [{ pid: 4242, instanceId: "i-1" }];
    const killed: number[] = [];
    const kill = (pid: number) => {
      killed.push(pid);
      rmSync(join(proc, String(pid)), { recursive: true });
    };
    assert.deepEqual(await stopEngines(record, { proc, timeoutMs: 20, kill }), ["killed engine i-1 (pid 4242), which didn't exit"]);
    assert.deepEqual(killed, [4242]);

    fakeProcess(proc, 4243, engine("someone-else"));
    record.engines = [{ pid: 4243, instanceId: "i-2" }];
    await assert.rejects(stopEngines(record, { proc, timeoutMs: 20, kill }), (error: unknown) => error instanceof Refused && /isn't engine i-2 any more, so it wasn't killed/.test(error.message));
    assert.deepEqual(killed, [4242]);

    rmSync(join(proc, "4243"), { recursive: true });
    fakeProcess(proc, 4244, engine("stranger"));
    record.engines = [];
    await assert.rejects(stopEngines(record, { proc, timeoutMs: 20, kill }), /isn't this session's/);
  });

  it("reads a stopped store's runs from a copy with its WAL, where an immutable read sees none", () => {
    const { root } = setup();
    const home = join(root, "engine home");
    mkdirSync(home);
    const db = new DatabaseSync(join(home, "nivra.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT, error TEXT, instance_id TEXT, created_at TEXT, duration_ms INTEGER);
             CREATE TABLE run_events (run_id TEXT, seq INTEGER, at TEXT, type TEXT, step_id TEXT, message TEXT, data TEXT);`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    // Committed, but only in the WAL, as after an engine is killed.
    db.exec(`INSERT INTO runs VALUES ('r1', 'explain', 'running', NULL, 'i-1', '2026-10-18T00:00:00.000Z', NULL);
             INSERT INTO run_events VALUES ('r1', 1, '2026-10-18T00:00:00.000Z', 'run.started', NULL, 'Started', NULL);`);
    const copy = join(root, "copy");
    assert.deepEqual(copyRunStore(home, copy), ["nivra.db", "nivra.db-wal"]);
    const url = pathToFileURL(join(home, "nivra.db"));
    url.search = "immutable=1";
    const immutable = new DatabaseSync(url, { readOnly: true });
    const seen = (immutable.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    immutable.close();
    db.close();
    assert.equal(seen, 0, "immutable=1 misses the row in the WAL");
    assert.deepEqual(
      readRuns(copy).map((run) => [run.id, run.status, run.starts, run.lastEvent?.type]),
      [["r1", "running", 1, "run.started"]],
    );
  });
});
