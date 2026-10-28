import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { BudgetRecovery, type BudgetRecoveryReason } from "@nivra/domain";
import { z } from "zod";
import type { LedgerState } from "./budget-store.ts";

/**
 * The budget's guard (NIV-66): a small append-only log beside workspace.db, outside it, holding the ledger's id,
 * authority revision and chained digest. A record is fsynced before anything that depends on it is sent. So if the
 * workspace is later replaced, damaged and kept aside, put back from a backup (even one holding the same number of
 * grants), or changed along another history, the next start finds a ledger missing, another, behind its guard or
 * diverged from it, and spending stops until the person resolves it.
 *
 * Each record is one line: its JSON, a tab, and the JSON's SHA-256. A last line cut short by a crash fails its check
 * and is ignored; nothing was sent on it, because sending waits for the append to return. Appending to a file that
 * already exists needs no folder sync, which Node can't do on Windows. The file's first creation syncs its folder
 * where the platform allows.
 */

export interface GuardRecord {
  ledgerId: string;
  revision: number;
  /** The ledger's chained digest at that revision. */
  chain: string;
  /** Set while the budget history needs recovery: recorded so that state survives a restart. */
  recovery: BudgetRecovery | null;
  at: string;
}

const GuardLine = z.strictObject({
  v: z.literal(1),
  ledgerId: z.uuid(),
  revision: z.number().int().nonnegative(),
  chain: z.string().regex(/^[0-9a-f]{64}$/),
  recovery: BudgetRecovery.nullable(),
  at: z.iso.datetime(),
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Said when the guard can't be read or written: nothing is spent until it can be. */
export const BUDGET_GUARD_FAILED =
  "Nivra couldn't read or write its budget guard beside your history, so it can't protect your budget's records and won't spend anything. Check that the disk has space and that Nivra's data folder can be written, then open Nivra again.";
/** Said while the budget history needs recovery. */
export const BUDGET_NEEDS_RECOVERY =
  "Nivra's budget history needs recovery first: it's missing, or doesn't match Nivra's last record of it. Put back the matching copy of your history and open Nivra again, or start a new budget history.";
/** Said when a change was saved but its revision couldn't be recorded in the guard: nothing is spent until it can be. */
export const BUDGET_GUARD_FAILED_AFTER_SAVE =
  "Nivra saved this change, but couldn't record it in its budget guard beside your history, so it won't spend anything until it can. Check that the disk has space and that Nivra's data folder can be written, then open Nivra again.";
/** How far the computer's clock may drift from the monotonic clock, or back from the ledger's last record, before it is noted as a jump. */
export const CLOCK_TOLERANCE_MS = 60_000;

/** A file system error's code, or the error's name: never its message, which can hold a path. */
export function guardErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "an unknown error";
}

export class BudgetGuard {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The last whole record, or null when the log is missing or holds none. Lines that fail their check are skipped. */
  last(): GuardRecord | null {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let last: GuardRecord | null = null;
    for (const line of text.split("\n")) {
      const tab = line.lastIndexOf("\t");
      if (tab < 0) continue;
      const json = line.slice(0, tab);
      if (sha256(json) !== line.slice(tab + 1)) continue;
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        continue;
      }
      const parsed = GuardLine.safeParse(value);
      if (parsed.success) last = { ledgerId: parsed.data.ledgerId, revision: parsed.data.revision, chain: parsed.data.chain, recovery: parsed.data.recovery, at: parsed.data.at };
    }
    return last;
  }

  /**
   * Appends a record and fsyncs it before returning. Throws when it can't, and then nothing that depends on the record
   * may be sent. A last line left cut short by a crash is ended first, so the new record stands on a line of its own.
   */
  append(record: GuardRecord): void {
    const json = JSON.stringify({ v: 1, ledgerId: record.ledgerId, revision: record.revision, chain: record.chain, recovery: record.recovery, at: record.at });
    const fd = openSync(this.path, "a+", 0o600);
    let created = false;
    try {
      const size = fstatSync(fd).size;
      created = size === 0;
      let prefix = "";
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) prefix = "\n";
      }
      const bytes = Buffer.from(`${prefix}${json}\t${sha256(json)}\n`, "utf8");
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) syncFolder(dirname(this.path));
  }
}

/** Makes a new file's name durable in its folder. Windows has no folder sync in Node; its file system journals the name. */
function syncFolder(folder: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(folder, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The workspace's ledger as the check sees it: its state, and its chained digest at the guard's last revision, if it holds one. */
export interface LedgerView extends LedgerState {
  chainAtGuard: string | null;
}

/** What the start-of-session check found, and the record to append for it, if any. */
export type HistoryCheck = { state: "fresh" | "ok"; append: GuardRecord | null } | { state: "needs-recovery"; recovery: BudgetRecovery; append: GuardRecord | null };

/**
 * Compares the workspace's ledger with the guard's last record. The ledger holds the guard's history when it has the
 * same id, at the guard's revision or past it, with the same chained digest at that revision.
 * - No guard and no ledger: a fresh install, with nothing to protect yet.
 * - No guard but a ledger: the guard is rebuilt from the ledger, which is the authority.
 * - A recovery already recorded: it stands until the ledger holds the guard's history again (the matching copy was put
 *   back), and then it is cleared.
 * - Otherwise a ledger that holds the guard's history is fine, and the guard catches up. A missing ledger, another id, a
 *   lower revision, or the guard's revision reached along another history (whatever the number of grants) needs
 *   recovery; a workspace just kept aside is named as the reason when its ledger is gone. The recovery is recorded in
 *   the guard.
 */
export function checkHistory(guard: GuardRecord | null, ledger: LedgerView | null, keptAside: boolean, now: number): HistoryCheck {
  const at = new Date(now).toISOString();
  const recordOf = (state: LedgerState): GuardRecord => ({ ledgerId: state.ledgerId, revision: state.revision, chain: state.chain, recovery: null, at });
  if (guard === null) return ledger === null ? { state: "fresh", append: null } : { state: "ok", append: recordOf(ledger) };
  const holds = ledger !== null && ledger.ledgerId === guard.ledgerId && ledger.revision >= guard.revision && ledger.chainAtGuard === guard.chain;
  if (guard.recovery !== null) return holds ? { state: "ok", append: recordOf(ledger!) } : { state: "needs-recovery", recovery: guard.recovery, append: null };
  if (holds) return { state: "ok", append: ledger!.revision > guard.revision ? recordOf(ledger!) : null };
  let reason: BudgetRecoveryReason;
  if (ledger === null) reason = keptAside ? "workspace-kept-aside" : "ledger-missing";
  else if (ledger.ledgerId !== guard.ledgerId) reason = "ledger-replaced";
  else if (ledger.revision < guard.revision) reason = "ledger-behind";
  else reason = "ledger-diverged";
  const recovery: BudgetRecovery = {
    reason,
    detectedAt: at,
    guard: { ledgerId: guard.ledgerId, revision: guard.revision, chain: guard.chain },
    ledger: ledger === null ? null : { ledgerId: ledger.ledgerId, revision: ledger.revision },
  };
  return { state: "needs-recovery", recovery, append: { ledgerId: guard.ledgerId, revision: guard.revision, chain: guard.chain, recovery, at } };
}
