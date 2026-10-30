import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import mutableFs from "node:fs";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, mock } from "node:test";
import { LibSQLStore } from "@mastra/libsql";
import { DatabaseFiles, type PrivacyIo } from "../src/db/private-files.ts";
import { libsqlFileUrl } from "../src/db/libsql-url.ts";
import { createEngine } from "../src/engine.ts";
import { readArgs } from "../src/args.ts";
import { ProtocolOutput } from "../src/rpc/output.ts";
import { impureLines, makeRepo, removeDir, startEngine, tempDir, type EngineProcess } from "./helpers.ts";

function privateFiles(home: string): void {
  for (const name of readdirSync(home)) {
    const info = statSync(join(home, name));
    if (info.isFile() && process.platform !== "win32") assert.equal(info.mode & 0o7777, 0o600, name);
  }
}

async function stop(engine: EngineProcess): Promise<void> {
  await engine.client.call("shutdown", {});
  assert.equal((await engine.exited).code, 0);
}

async function refusal(home: string): Promise<void> {
  const engine = startEngine(home);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = await Promise.race([engine.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Unsafe home did not refuse within 5 s")), 5_000); })]);
    assert.equal(exited.code, 1);
    const failure = engine.notifications.find(n => n.method === "engine.fatal")?.params as { code: string; message: string };
    assert.equal(failure?.code, "home-unusable");
    assert.match(failure.message, /start Nivra again/);
    assert.deepEqual(impureLines(engine.lines), []);
  } finally {
    clearTimeout(timer);
    engine.kill();
    await engine.exited;
  }
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// Two real drivers leave their recovery files by dying before either connection closes. No model or network.
function recoveryFixture(home: string, journal: "WAL" | "DELETE"): void {
  const code = `
    import { Database } from './src/db/database.ts';
    import { LibSQLStore } from '@mastra/libsql';
    import { libsqlFileUrl } from './src/db/libsql-url.ts';
    import { join } from 'node:path';
    const home=process.argv[1];
    const database=new Database(join(home,'nivra.db'),{exclusive:true});
    const db=database.open();
    const store=new LibSQLStore({id:'legacy-fixture',url:libsqlFileUrl(join(home,'mastra.db'))});
    await store.init();
    const setup="PRAGMA journal_mode=${journal}; PRAGMA cache_size=2; CREATE TABLE privacy_record (value TEXT, padding BLOB); INSERT INTO privacy_record VALUES ('saved', zeroblob(8192));";
    db.exec(setup);
    await store.client.executeMultiple(setup);
    if('${journal}'==='DELETE') {
      db.exec("BEGIN IMMEDIATE; UPDATE privacy_record SET value='uncommitted'; INSERT INTO privacy_record SELECT 'uncommitted',zeroblob(32768);");
      const tx=await store.client.transaction('write');
      await tx.execute("UPDATE privacy_record SET value='uncommitted'");
      await tx.execute("INSERT INTO privacy_record SELECT 'uncommitted',zeroblob(32768)");
    }
    process.kill(process.pid,'SIGKILL');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, home], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 20_000 });
  assert.equal(result.signal, "SIGKILL", result.stderr.slice(-1000));
}

describe("database privacy", () => {
  // This gate uses the drivers directly, before Mastra's schema initialisation. There is no post-open chmod here.
  for (const mask of [0o022, 0o000]) it(`creates and recreates driver sidecars privately under umask ${mask.toString(8)}`, async () => {
    const home = tempDir();
    const previous = process.umask(mask);
    try {
      for (const name of ["nivra.db", "mastra.db"]) {
        const path = join(home, name);
        closeSync(openSync(path, "wx", 0o600));
        for (let cycle = 0; cycle < 2; cycle++) {
          const store = name === "mastra.db" ? new LibSQLStore({ id: "privacy-gate", url: libsqlFileUrl(path) }) : null;
          const db = store ? null : new DatabaseSync(path);
          // Only this driver gate inspects the pinned adapter's client, so it can stop before schema initialisation.
          const client = store ? Reflect.get(store, "client") as {
            executeMultiple(sql: string): Promise<unknown>;
            transaction(mode: "write"): Promise<{ execute(sql: string): Promise<unknown>; commit(): Promise<void>; rollback(): Promise<void>; close(): void }>;
          } : null;
          const exec = async (sql: string) => { if (client) await client.executeMultiple(sql); else db!.exec(sql); };
          try {
            if (store) await Reflect.get(store, "pragmasReady");
            await exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS privacy_probe (value TEXT);");
            for (const journal of ["WAL", "DELETE"]) {
              await exec(`PRAGMA journal_mode=${journal};`);
              const tx = client ? await client.transaction("write") : null;
              if (!tx) db!.exec("BEGIN IMMEDIATE;");
              try {
                if (tx) await tx.execute("INSERT INTO privacy_probe VALUES ('saved')");
                else db!.exec("INSERT INTO privacy_probe VALUES ('saved')");
                assert.ok(readdirSync(home).includes(`${name}${journal === "WAL" ? "-wal" : "-journal"}`));
                if (journal === "WAL") assert.ok(readdirSync(home).includes(`${name}-shm`));
                privateFiles(home);
                if (tx) await tx.commit(); else db!.exec("COMMIT;");
              } finally { tx?.close(); }
              if (journal === "WAL") await exec("PRAGMA wal_checkpoint(TRUNCATE);");
            }
          } finally {
            db?.close();
            await store?.close();
          }
          // DELETE mode and closing the drivers leave no sidecars; the next iteration really recreates them.
          assert.equal(readdirSync(home).includes(`${name}-wal`), false);
          assert.equal(readdirSync(home).includes(`${name}-shm`), false);
          assert.equal(readdirSync(home).includes(`${name}-journal`), false);
        }
      }
    } finally {
      process.umask(previous);
      removeDir(home);
    }
  });

  for (const mask of [0o022, 0o000]) it(`keeps every engine data file private through workflow, restart and recovery with umask ${mask.toString(8)}`, async () => {
    const root = tempDir();
    const home = join(root, "engine home");
    mkdirSync(home, { mode: 0o755 });
    const unrelated = join(home, "user-notes.txt");
    writeFileSync(unrelated, "untouched", { mode: 0o644 });
    const runtime = join(home, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "node"), "fixture executable", { mode: 0o755 });
    const modeBefore = statSync(join(runtime, "node")).mode;
    const noteBefore = statSync(unrelated).mode;
    const engines: EngineProcess[] = [];
    let engine = startEngine(home, { umask: mask });
    engines.push(engine);
    try {
      await engine.initialize();
      const repo = makeRepo(root);
      const run = await engine.client.call("runs.start", { clientRequestId: randomUUID(), workflowId: "hello", input: { repoPath: repo }, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } });
      assert.equal((await engine.waitForRun(run.id, p => p.status === "succeeded")).status, "succeeded");
      const check = () => {
        for (const name of readdirSync(home).filter(n => n !== "user-notes.txt" && n !== "runtime")) {
          if (process.platform !== "win32") assert.equal(statSync(join(home, name)).mode & 0o7777, 0o600, name);
        }
        assert.equal(statSync(unrelated).mode, noteBefore);
        assert.equal(statSync(join(runtime, "node")).mode, modeBefore);
        assert.deepEqual(impureLines(engine.lines), []);
      };
      check();
      await stop(engine);
      for (const interrupted of [false, true]) {
        engine = startEngine(home, { umask: mask });
        engines.push(engine);
        await engine.initialize();
        assert.equal((await engine.client.call("runs.get", { runId: run.id })).status, "succeeded");
        check();
        if (interrupted) { engine.kill(); await engine.exited; } else await stop(engine);
      }
      engine = startEngine(home, { umask: mask });
      engines.push(engine);
      await engine.initialize();
      check();
      await stop(engine);
    } finally {
      for (const held of engines) { held.kill(); await held.exited; }
      removeDir(root);
    }
  });

  if (process.platform !== "win32") {
    for (const journal of ["WAL", "DELETE"] as const) it(`repairs a legacy 0755 home without losing ${journal} recovery records`, async () => {
      const home = tempDir();
      chmodSync(home, 0o755);
      try {
        recoveryFixture(home, journal);
        const names = readdirSync(home);
        for (const base of ["nivra.db", "mastra.db"]) assert.ok(names.includes(`${base}${journal === "WAL" ? "-wal" : "-journal"}`), `${base} recovery file exists`);
        for (const name of names) chmodSync(join(home, name), 0o644);
        const before = names.map(name => ({ name, inode: statSync(join(home, name)).ino, hash: digest(join(home, name)) }));
        const files = new DatabaseFiles(home);
        try { files.prepareFamily("nivra.db"); files.prepareFamily("mastra.db"); } finally { files.close(); }
        for (const { name, inode, hash } of before) {
          assert.equal(statSync(join(home, name)).ino, inode, name);
          assert.equal(digest(join(home, name)), hash, name);
        }
        // Repeat actual startup repair, rather than allowing the helper-only evidence to stand in for it.
        for (const name of names) chmodSync(join(home, name), 0o644);
        const engine = startEngine(home);
        try {
          await engine.initialize();
          privateFiles(home);
          await stop(engine);
        } finally { engine.kill(); await engine.exited; }
        assert.equal(statSync(home).mode & 0o7777, 0o755);
        for (const base of ["nivra.db", "mastra.db"]) {
          assert.equal(statSync(join(home, base)).ino, before.find(f => f.name === base)!.inode);
          const db = new DatabaseSync(join(home, base), { readOnly: true });
          try {
            assert.equal(db.prepare("SELECT count(*) AS n FROM privacy_record").get()!["n"], 1);
            assert.equal(db.prepare("SELECT value FROM privacy_record").get()!["value"], "saved");
          } finally { db.close(); }
        }
      } finally { removeDir(home); }
    });

    for (const name of ["nivra.db", "nivra.db-wal", "nivra.db-shm", "nivra.db-journal", "mastra.db", "mastra.db-wal", "mastra.db-shm", "mastra.db-journal"]) {
      for (const kind of ["symlink", "hard link", "directory", "FIFO"]) it(`promptly refuses a ${kind} at ${name} without changing an outside sentinel`, async () => {
        const root = tempDir();
        const home = join(root, "home");
        mkdirSync(home, { mode: 0o700 });
        const sentinel = join(root, "outside");
        writeFileSync(sentinel, "outside data", { mode: 0o640 });
        const path = join(home, name);
        if (kind === "symlink") symlinkSync(sentinel, path);
        if (kind === "hard link") linkSync(sentinel, path);
        if (kind === "directory") mkdirSync(path);
        if (kind === "FIFO") assert.equal(spawnSync("mkfifo", [path]).status, 0);
        const before = statSync(sentinel);
        try {
          await refusal(home);
          assert.equal(readFileSync(sentinel, "utf8"), "outside data");
          assert.equal(statSync(sentinel).mode, before.mode);
          assert.equal(statSync(sentinel).ctimeMs, before.ctimeMs);
        } finally { removeDir(root); }
      });
    }

    it("rejects a FIFO before opening it, and cannot hang if a regular file becomes a FIFO at open", () => {
      const home = tempDir();
      const path = join(home, "mastra.db");
      writeFileSync(path, "original");
      let opened = 0;
      let repaired = 0;
      const io: PrivacyIo = {
        ...fs,
        openSync: (name, flags, mode) => {
          if (String(name).endsWith("/mastra.db")) {
            opened++;
            unlinkSync(path);
            assert.equal(spawnSync("mkfifo", [path]).status, 0);
            assert.ok((Number(flags) & fs.constants.O_NONBLOCK) !== 0);
          }
          return fs.openSync(name, flags, mode);
        },
        fchmodSync: () => { repaired++; },
      };
      const files = new DatabaseFiles(home, io);
      try {
        const began = performance.now();
        assert.throws(() => files.prepareFamily("mastra.db"), /regular file/);
        assert.ok(performance.now() - began < 1000);
        assert.equal(opened, 1);
        assert.equal(repaired, 0);
        assert.throws(() => files.prepareFamily("mastra.db"), /regular file/);
        assert.equal(opened, 1, "the already-present FIFO was never opened");
      } finally { files.close(); removeDir(home); }
    });

    it("rejects unsafe homes, linked ancestors and untrusted ownership without changing them", async () => {
      const root = tempDir();
      const home = join(root, "home");
      mkdirSync(home);
      try {
        chmodSync(home, 0o777);
        await refusal(home);
        assert.equal(statSync(home).mode & 0o7777, 0o777);
        chmodSync(home, 0o700);
        const link = join(root, "linked");
        symlinkSync(home, link);
        await refusal(link);
        const nested = join(home, "nested");
        mkdirSync(nested);
        await refusal(join(link, "nested"));
        writeFileSync(join(home, "mastra.db"), "data");
        const files = new DatabaseFiles(home, { ...fs, fstatSync: ((fd: number) => {
          const info = fs.fstatSync(fd);
          if (info.isFile()) info.uid++;
          return info;
        }) as PrivacyIo["fstatSync"] });
        try { assert.throws(() => files.prepareFamily("mastra.db"), /owned by this user/); } finally { files.close(); }
        assert.equal(readFileSync(join(home, "mastra.db"), "utf8"), "data");
      } finally { removeDir(root); }
    });

    it("leaves a live owner's files untouched when a second process refuses", async () => {
      const home = tempDir();
      const owner = startEngine(home);
      try {
        await owner.initialize();
        const names = readdirSync(home);
        // Even legacy-looking Mastra files are not ours to repair while another engine owns the home.
        for (const name of names.filter(n => n.startsWith("mastra.db"))) chmodSync(join(home, name), 0o644);
        const before = names.map(name => ({ name, mode: statSync(join(home, name)).mode, time: statSync(join(home, name)).ctimeMs, hash: digest(join(home, name)) }));
        const second = startEngine(home);
        try {
          assert.equal((await second.exited).code, 3);
          assert.equal((second.notifications[0]?.params as { code: string }).code, "locked");
        } finally { second.kill(); await second.exited; }
        for (const file of before) {
          assert.equal(statSync(join(home, file.name)).mode, file.mode, file.name);
          assert.equal(statSync(join(home, file.name)).ctimeMs, file.time, file.name);
          assert.equal(digest(join(home, file.name)), file.hash, file.name);
        }
        await owner.client.call("ping", {});
        await stop(owner);
      } finally { owner.kill(); await owner.exited; removeDir(home); }
    });

    it("refuses a name swapped after open before any descriptor chmod", () => {
      const root = tempDir();
      const home = join(root, "home");
      mkdirSync(home);
      const target = join(root, "outside");
      const path = join(home, "mastra.db");
      writeFileSync(target, "outside", { mode: 0o640 });
      writeFileSync(path, "database", { mode: 0o644 });
      let repaired = 0;
      const files = new DatabaseFiles(home, {
        ...fs,
        openSync: (name, flags, mode) => {
          const fd = fs.openSync(name, flags, mode);
          if (String(name).endsWith("/mastra.db")) { unlinkSync(path); symlinkSync(target, path); }
          return fd;
        },
        fchmodSync: () => { repaired++; },
      });
      const before = statSync(target);
      try {
        assert.throws(() => files.prepareFamily("mastra.db"), /regular file/);
        assert.equal(repaired, 0);
        assert.equal(statSync(target).mode, before.mode);
        assert.equal(readFileSync(target, "utf8"), "outside");
      } finally { files.close(); removeDir(root); }
    });

    it("preserves orphan recovery files instead of creating an empty replacement database", async () => {
      const home = tempDir();
      const path = join(home, "mastra.db-wal");
      writeFileSync(path, "recovery bytes", { mode: 0o644 });
      const before = statSync(path);
      try {
        await refusal(home);
        assert.deepEqual(readdirSync(home), ["mastra.db-wal"]);
        assert.equal(readFileSync(path, "utf8"), "recovery bytes");
        assert.equal(statSync(path).mode, before.mode);
      } finally { removeDir(home); }
    });

    it("refuses when the filesystem does not honour descriptor permission repair", () => {
      const home = tempDir();
      const path = join(home, "mastra.db");
      writeFileSync(path, "kept", { mode: 0o644 });
      const files = new DatabaseFiles(home, { ...fs, fchmodSync: () => undefined });
      try {
        assert.throws(() => files.prepareFamily("mastra.db"), /did not make the database file private/);
        assert.equal(readFileSync(path, "utf8"), "kept");
      } finally { files.close(); removeDir(home); }
    });

    it("releases ownership after a permission repair fails, and reports no success", async () => {
      const home = tempDir();
      const path = join(home, "mastra.db");
      writeFileSync(path, "", { mode: 0o644 });
      const inode = statSync(path).ino;
      const chmod = mutableFs.fchmodSync;
      const failure = mock.method(mutableFs, "fchmodSync", (fd: number, mode: fs.Mode) => {
        if (fs.fstatSync(fd).ino === inode) throw Object.assign(new Error("simulated repair failure"), { code: "EPERM" });
        chmod(fd, mode);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(createEngine({ ...readArgs(["--stdio", "--home", home]), output: new ProtocolOutput((_chunk, callback) => { callback(); return true; }), log: () => undefined, moduleUrl: import.meta.url }), /privacy could not be established \(EPERM\)/);
        assert.equal(statSync(path).mode & 0o7777, 0o644);
      } finally { failure.mock.restore(); syncBuiltinESMExports(); }
      const next = startEngine(home);
      try { await next.initialize(); privateFiles(home); await stop(next); } finally { next.kill(); await next.exited; removeDir(home); }
    });

    it("closes LibSQL storage and the ownership lock after storage initialisation fails", async () => {
      const home = tempDir();
      const init = LibSQLStore.prototype.init;
      const opened: { candidate: LibSQLStore | null } = { candidate: null };
      const failure = mock.method(LibSQLStore.prototype, "init", async function (this: LibSQLStore) {
        opened.candidate = this;
        await init.call(this);
        throw new Error("simulated storage initialisation failure");
      });
      try {
        await assert.rejects(createEngine({ ...readArgs(["--stdio", "--home", home]), output: new ProtocolOutput((_chunk, callback) => { callback(); return true; }), log: () => undefined, moduleUrl: import.meta.url }), /simulated storage initialisation failure/);
        assert.ok(opened.candidate);
        assert.equal(Reflect.get(opened.candidate, "client").closed, true);
      } finally { failure.mock.restore(); }
      const next = startEngine(home);
      try { await next.initialize(); await stop(next); } finally { next.kill(); await next.exited; removeDir(home); }
    });

    it("runs self-check without inspecting even an unsafe home", async () => {
      const root = tempDir();
      const home = join(root, "unsafe");
      symlinkSync(join(root, "missing"), home);
      const engine = startEngine(home, { args: ["--self-check", "--home", home] });
      try {
        assert.equal((await engine.exited).code, 0);
        assert.equal((engine.notifications.find(n => n.method === "engine.selfCheck")?.params as { ok: boolean }).ok, true);
        assert.equal(lstatSync(home).isSymbolicLink(), true);
        assert.equal(readdirSync(root).length, 1);
      } finally { engine.kill(); await engine.exited; removeDir(root); }
    });
  }
});
