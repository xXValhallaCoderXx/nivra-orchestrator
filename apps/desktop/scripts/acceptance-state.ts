// What a live acceptance session (NIV-14) changes on this machine, and how it is put back. The WSL engine's home is
// fixed at `$HOME/.nivra` for every Windows profile, so an isolated Windows→WSL session moves the person's home aside
// and restores it at the end. A recovery record is saved before anything moves and after every step, so a session that
// dies can be recovered from it, by `accept:live --recover` or by hand. A restore never overwrites what it can't
// recognise. Engines are found and identified through /proc, in this distribution's PID namespace, never by pgrep,
// which can match itself. Plain Node: unit-tested on temporary folders.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SessionState = "planned" | "moved" | "running" | "stopped" | "restored";

export interface HomeStat {
  dev: number;
  ino: number;
  /** The run store as it was: a restored home must show the same. Null when there was none. */
  db: { size: number; mtimeMs: number } | null;
}

export interface RecoveryRecord {
  version: 1;
  run: string;
  state: SessionState;
  /** The user this session runs as, and whose engines it may stop. */
  uid: number;
  user: string;
  distro: string | null;
  /** The person's engine home and where it went; null when the session moves nothing (a Linux session). */
  home: { path: string; movedTo: string; original: HomeStat | null; movedAt: string | null } | null;
  /** The folder an engine created at the home's path during the session, once seen: a restore recognises it by this. */
  acceptanceHomeIno: number | null;
  /** Folders deleted at the end, after their logs are kept: a profile may hold the key. */
  profiles: string[];
  /** This session's engines: their pid in this distribution, and their instance id. */
  engines: Array<{ pid: number; instanceId: string }>;
  /** Where evidence is kept. */
  evidence: string;
}

/** What an engine keeps in its home. Anything else there means the folder isn't only an engine's. */
export const ENGINE_HOME_ENTRIES: ReadonlySet<string> = new Set(["nivra.db", "nivra.db-wal", "nivra.db-shm", "mastra.db", "mastra.db-wal", "mastra.db-shm", "runtime"]);

/** A restore or a stop that would have to guess. Nothing is overwritten, merged or killed when this is thrown. */
export class Refused extends Error {}

const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

/** The same steps as `finishSession`, as commands a person can run when no code can. */
export function restoreByHand(record: RecoveryRecord): string[] {
  const steps = [
    "# 1. Quit every Nivra window this session opened, then check that no engine of this user still runs:",
    `ps -u ${record.user} -o pid=,args= | grep -F -- --nivra-engine`,
    "# 2. Delete the acceptance profiles (they may hold the key):",
    ...record.profiles.map((profile) => `rm -rf -- ${quote(profile)}`),
  ];
  if (record.home) {
    steps.push(
      `# 3. If ${record.home.path} exists now and holds only ${[...ENGINE_HOME_ENTRIES].join(", ")}, it is the acceptance home: keep it as evidence.`,
      `mv -- ${quote(record.home.path)} ${quote(join(record.evidence, "wsl-home"))}`,
      record.home.original ? `# 4. Put the original back:\nmv -- ${quote(record.home.movedTo)} ${quote(record.home.path)}` : "# 4. There was no original home to put back.",
    );
  }
  return steps;
}

/** Saves the record to each file, atomically and readable only by its owner, with the steps to restore by hand. */
export function saveRecord(record: RecoveryRecord, files: readonly string[]): void {
  const text = `${JSON.stringify({ ...record, restoreByHand: restoreByHand(record) }, null, 2)}\n`;
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
  }
}

export function loadRecord(file: string): RecoveryRecord {
  const record = JSON.parse(readFileSync(file, "utf8")) as RecoveryRecord & { restoreByHand?: unknown };
  if (record.version !== 1) throw new Error(`${file} isn't a recovery record this harness wrote.`);
  delete record.restoreByHand;
  return record;
}

export function statHome(path: string): HomeStat | null {
  if (!existsSync(path)) return null;
  const folder = statSync(path);
  const db = join(path, "nivra.db");
  const store = existsSync(db) ? statSync(db) : null;
  return { dev: folder.dev, ino: folder.ino, db: store ? { size: store.size, mtimeMs: store.mtimeMs } : null };
}

/**
 * Moves the person's engine home aside, with an atomic rename. The record, with the original's identity, is saved
 * before anything moves. Nothing moves while `busy` names anything still using the home, or if the destination exists.
 */
export function moveHome(record: RecoveryRecord, save: (record: RecoveryRecord) => void, busy: () => string[]): void {
  const home = record.home;
  if (!home) throw new Error("This session moves no home.");
  if (record.state !== "planned") throw new Refused(`The home moves only from the planned state, and this session is ${record.state}.`);
  const users = busy();
  if (users.length) throw new Refused(`Nothing was moved: ${users.join("; ")} still uses ${home.path}. Close it, then try again.`);
  if (existsSync(home.movedTo)) throw new Refused(`Nothing was moved: ${home.movedTo} already exists. Recover or remove it first.`);
  home.original = statHome(home.path);
  home.movedAt = new Date().toISOString();
  save(record);
  if (home.original) renameSync(home.path, home.movedTo);
  record.state = "moved";
  save(record);
}

/** Records the folder an engine created at the home's path, so a restore can tell it from anything else. */
export function noteAcceptanceHome(record: RecoveryRecord, save: (record: RecoveryRecord) => void): void {
  if (!record.home || record.acceptanceHomeIno !== null || !existsSync(record.home.path)) return;
  record.acceptanceHomeIno = statSync(record.home.path).ino;
  save(record);
}

const sameHome = (a: HomeStat | null, b: HomeStat | null) =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.db?.size === b.db?.size && a.db?.mtimeMs === b.db?.mtimeMs;

/**
 * Puts the person's home back. A folder now at the home's path must be the one this session's engines created:
 * recognised by its recorded inode, or, when none was recorded, by holding only what an engine keeps and being made after
 * the move. It is kept as evidence, without its runtimes. Anything else stops the restore. Running it again after a
 * restore only checks the result.
 */
export function restoreHome(record: RecoveryRecord, save: (record: RecoveryRecord) => void): string[] {
  const home = record.home;
  if (!home) return [];
  // `movedAt` is saved before the rename, so without it nothing was moved and the home is the person's own.
  if (home.movedAt === null) {
    record.state = "restored";
    save(record);
    return [`nothing was moved; ${home.path} is untouched`];
  }
  const notes: string[] = [];
  const now = statHome(home.path);
  if (now && home.original && sameHome(now, home.original) && !existsSync(home.movedTo)) {
    record.state = "restored";
    save(record);
    return [`${home.path} is already the original`];
  }
  if (now) {
    const entries = readdirSync(home.path);
    const unexpected = entries.filter((entry) => !ENGINE_HOME_ENTRIES.has(entry));
    const folder = statSync(home.path);
    const made = folder.birthtimeMs > 0 ? folder.birthtimeMs : folder.ctimeMs;
    const ours = record.acceptanceHomeIno !== null ? folder.ino === record.acceptanceHomeIno : home.movedAt !== null && made >= Date.parse(home.movedAt);
    if (!ours || unexpected.length) {
      throw new Refused(
        `${home.path} isn't the folder this session's engines made${unexpected.length ? ` (it holds ${unexpected.join(", ")})` : ""}, so nothing was restored or overwritten. ` +
          `The original is at ${home.movedTo}. Look at both, then follow restoreByHand in the recovery record.`,
      );
    }
    const keep = join(record.evidence, "wsl-home");
    if (existsSync(keep)) throw new Refused(`${keep} already exists, so the acceptance home wasn't moved there. Move it aside, then recover again.`);
    mkdirSync(record.evidence, { recursive: true });
    renameSync(home.path, keep);
    rmSync(join(keep, "runtime"), { recursive: true, force: true });
    notes.push(`kept the acceptance home's stores in ${keep}`);
  }
  if (home.original) {
    if (!existsSync(home.movedTo)) throw new Refused(`The original home isn't at ${home.movedTo}, so it wasn't restored. Find it before starting Nivra again.`);
    renameSync(home.movedTo, home.path);
    if (!sameHome(statHome(home.path), home.original)) throw new Refused(`${home.path} is back, but doesn't match the record. Check it before starting Nivra again.`);
    notes.push(`restored ${home.path}`);
  }
  record.state = "restored";
  save(record);
  return notes;
}

/** A process's arguments in this PID namespace, or null when it has gone. */
export function commandLine(pid: number, proc = "/proc"): string[] | null {
  try {
    return readFileSync(join(proc, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function ownerOf(pid: number, proc: string): number | null {
  try {
    return statSync(join(proc, String(pid))).uid;
  } catch {
    return null;
  }
}

const argAfter = (args: readonly string[], flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? (args[at + 1] ?? null) : null;
};

/** Whether this pid is the engine with this instance id, run by this user. */
export function isEngine(pid: number, instanceId: string, uid: number, proc = "/proc"): boolean {
  const args = commandLine(pid, proc);
  return args !== null && args.includes("--nivra-engine") && argAfter(args, "--instance") === instanceId && ownerOf(pid, proc) === uid;
}

/** This user's engines using this home. */
export function enginesUsing(home: string, uid: number, proc = "/proc"): Array<{ pid: number; instanceId: string | null }> {
  return readdirSync(proc)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .flatMap((pid) => {
      const args = commandLine(pid, proc);
      if (!args || !args.includes("--nivra-engine") || argAfter(args, "--home") !== home || ownerOf(pid, proc) !== uid) return [];
      return [{ pid, instanceId: argAfter(args, "--instance") }];
    });
}

export interface StopOptions {
  proc?: string;
  timeoutMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** A hello fixture captured while its engine still owns it; start time guards against pid reuse after that engine dies. */
export interface HeldChild {
  pid: number;
  uid: number;
  started: string;
}

function processState(pid: number, proc: string): { state: string; parent: number; group: number; started: string } | null {
  let text: string;
  try {
    text = readFileSync(join(proc, String(pid), "stat"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Refused(`Couldn't read process ${pid}'s identity. Check it by hand; nothing was killed.`);
  }
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!fields[0] || !/^\d+$/.test(fields[1] ?? "") || !/^\d+$/.test(fields[2] ?? "") || !/^\d+$/.test(fields[19] ?? "")) {
    throw new Refused(`Couldn't identify process ${pid}. Check it by hand; nothing was killed.`);
  }
  return { state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), started: fields[19]! };
}

/** Capture only the known engine's own hello child, in the process group Local made for it, before killing the engine. */
export function captureHeldChild(pid: number, enginePid: number, uid: number, proc = "/proc"): HeldChild {
  const state = processState(pid, proc);
  if (!state || state.state === "Z" || state.parent !== enginePid || state.group !== pid || ownerOf(pid, proc) !== uid || !commandLine(pid, proc)?.includes("--nivra-hold")) {
    throw new Refused(`Process ${pid} isn't this engine's held hello child. Nothing was killed; run the rehearsal again.`);
  }
  return { pid, uid, started: state.started };
}

/**
 * The rehearsal deliberately SIGKILLs an engine. That cannot run its cleanup, so the harness must stop the hello
 * fixture it orphaned before timing a later quit. This is fixture cleanup, never an application's shutdown path.
 */
export async function stopHeldChild(child: HeldChild, options: StopOptions = {}): Promise<void> {
  const proc = options.proc ?? "/proc";
  const live = () => {
    const state = processState(child.pid, proc);
    if (!state) return false;
    if (state.started !== child.started || state.group !== child.pid || ownerOf(child.pid, proc) !== child.uid) {
      throw new Refused(`Process ${child.pid} isn't the captured hello child any more. Nothing was killed; check it by hand.`);
    }
    if (state.state === "Z") return false;
    if (!commandLine(child.pid, proc)?.includes("--nivra-hold")) {
      // It may have exited between the stat and the command-line read.
      const now = processState(child.pid, proc);
      if (!now || (now.started === child.started && now.state === "Z")) return false;
      throw new Refused(`Process ${child.pid} isn't a held hello child any more. Nothing was killed; check it by hand.`);
    }
    return true;
  };
  if (!live()) return;
  try {
    (options.kill ?? ((pid, signal) => process.kill(pid, signal)))(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = performance.now() + (options.timeoutMs ?? 5_000);
  while (live()) {
    if (performance.now() >= deadline) throw new Refused(`The rehearsal's held child ${child.pid} didn't stop. Check it by hand before running another session.`);
    await sleep(50);
  }
}

/**
 * Waits for each of this session's engines to exit. One still running after the wait is killed only while its command
 * line still names its instance; anything else is refused rather than killed.
 */
export async function stopEngines(record: RecoveryRecord, options: StopOptions = {}): Promise<string[]> {
  const proc = options.proc ?? "/proc";
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = () => record.engines.filter((engine) => commandLine(engine.pid, proc) !== null);
  const deadline = performance.now() + (options.timeoutMs ?? 30_000);
  while (alive().length && performance.now() < deadline) await sleep(200);
  const notes: string[] = [];
  for (const engine of alive()) {
    if (!isEngine(engine.pid, engine.instanceId, record.uid, proc)) {
      throw new Refused(`Process ${engine.pid} is still running, but it isn't engine ${engine.instanceId} any more, so it wasn't killed. Check it by hand.`);
    }
    kill(engine.pid, "SIGKILL");
    notes.push(`killed engine ${engine.instanceId} (pid ${engine.pid}), which didn't exit`);
  }
  const killedBy = performance.now() + 10_000;
  while (alive().length && performance.now() < killedBy) await sleep(100);
  const left = alive();
  if (left.length) throw new Refused(`Engine ${left.map((e) => `${e.instanceId} (pid ${e.pid})`).join(", ")} didn't exit.`);
  if (record.home) {
    const strangers = enginesUsing(record.home.path, record.uid, proc).filter((found) => !record.engines.some((engine) => engine.pid === found.pid));
    if (strangers.length) throw new Refused(`Engine ${strangers.map((s) => `pid ${s.pid}`).join(", ")} uses ${record.home.path} and isn't this session's. Close it, then recover again.`);
  }
  return notes;
}

/** Copies a stopped engine's run store with its WAL, so committed rows not yet checkpointed are read too. */
export function copyRunStore(home: string, into: string): string[] {
  if (!existsSync(join(home, "nivra.db"))) throw new Error(`There is no run store in ${home}.`);
  mkdirSync(into, { recursive: true });
  // The wal-index (-shm) isn't copied: SQLite rebuilds it from the WAL when the copy is opened.
  const names = ["nivra.db", "nivra.db-wal"].filter((name) => existsSync(join(home, name)));
  for (const name of names) copyFileSync(join(home, name), join(into, name));
  return names;
}

export interface RunRow {
  id: string;
  workflowId: string;
  status: string;
  error: string | null;
  instanceId: string | null;
  durationMs: number | null;
  lastEvent: { type: string; message: string } | null;
  starts: number;
}

/** Every run in a copied store. The copy is opened read-write, so SQLite recovers the WAL into it. */
export function readRuns(copy: string): RunRow[] {
  const db = new DatabaseSync(join(copy, "nivra.db"));
  try {
    const last = db.prepare("SELECT type, message FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1");
    const starts = db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run.started'");
    const rows = db.prepare("SELECT id, workflow_id, status, error, instance_id, duration_ms FROM runs ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const id = String(row["id"]);
      const event = last.get(id) as { type: string; message: string } | undefined;
      return {
        id,
        workflowId: String(row["workflow_id"]),
        status: String(row["status"]),
        error: (row["error"] as string | null) ?? null,
        instanceId: (row["instance_id"] as string | null) ?? null,
        durationMs: (row["duration_ms"] as number | null) ?? null,
        lastEvent: event ? { type: event.type, message: event.message } : null,
        starts: Number((starts.get(id) as { n: number }).n),
      };
    });
  } finally {
    db.close();
  }
}

export interface FinishOptions extends StopOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Anything still able to start an engine on the home (a Nivra window): the home isn't restored while there is. */
  busy?: () => string[];
}

/**
 * The end of every session, and all of a recovery: this session's engines stop (checked), each profile's logs are kept
 * and the profile deleted, and the person's home is restored. The app's own steps (removing the key, quitting) come
 * before this, while the app can still answer. A dry run only says what would happen.
 */
export async function finishSession(record: RecoveryRecord, save: (record: RecoveryRecord) => void, options: FinishOptions = {}): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const plan = [
    record.engines.length ? `stop engines ${record.engines.map((e) => `${e.instanceId} (pid ${e.pid})`).join(", ")}, checking each has exited` : "no engines to stop",
    ...record.profiles.map((profile) => `keep the logs of ${profile}, then delete it`),
    ...(record.home ? [`restore ${record.home.path} from ${record.home.movedTo}, keeping any acceptance home as evidence`] : []),
  ];
  if (options.dryRun) return plan;
  const notes = [...(await stopEngines(record, options))];
  if (record.state !== "restored") {
    record.state = "stopped";
    save(record);
  }
  for (const profile of record.profiles) {
    if (!existsSync(profile)) continue;
    const logs = join(profile, "logs");
    if (existsSync(logs)) cpSync(logs, join(record.evidence, "logs", `final-${basename(profile)}`), { recursive: true });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    notes.push(`deleted ${profile}`);
  }
  // A window still open could start an engine on the restored home and change the person's own stores.
  const users = record.home ? (options.busy?.() ?? []) : [];
  if (users.length) throw new Refused(`${users.join("; ")} is still running, so ${record.home!.path} wasn't restored yet. Close it, then run accept:live --recover.`);
  notes.push(...restoreHome(record, save));
  if (!record.home) {
    record.state = "restored";
    save(record);
  }
  for (const note of notes) log(note);
  return notes;
}
