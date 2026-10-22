import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The research live check's approvals, each claimed once (NIV-45). A run claims its approval's digest before it sends
 * anything, by creating a file named after the digest that must not exist yet: the file system makes that atomic, so of
 * several launches with one approval exactly one claims it. Claims live in one folder for every run, whatever folder a
 * run's evidence goes to, and are never removed: a run interrupted after claiming keeps its approval used, so starting it
 * again can't spend again. Another run needs another approval, whose digest `--plan` prints.
 */

/** Where approvals are claimed: one folder for every run, apart from any run's evidence. */
export function claimsFolder(home = homedir()): string {
  return join(home, "nivra-acceptance", "claims", "research-check");
}

export interface Claim {
  digest: string;
  /** Which run of its recipe at its revision the approval was for: the first, the second, … */
  run: number;
  revision: string | null;
  /** Where the run's evidence went. */
  out: string;
  pid: number;
  claimedAt: string;
}

const DIGEST = /^[0-9a-f]{64}$/;

export const isDigest = (value: string): boolean => DIGEST.test(value);

function pathOf(folder: string, digest: string): string {
  if (!isDigest(digest)) throw new Error("An approval is a SHA-256 digest: 64 lowercase hexadecimal characters.");
  return join(folder, `${digest}.json`);
}

/** The claim on `digest`, if any. A claim cut off before its record was written still counts; its record is then null. */
export function claimOn(folder: string, digest: string): { claimed: false } | { claimed: true; record: Partial<Claim> | null } {
  const path = pathOf(folder, digest);
  if (!existsSync(path)) return { claimed: false };
  try {
    return { claimed: true, record: JSON.parse(readFileSync(path, "utf8")) as Partial<Claim> };
  } catch {
    return { claimed: true, record: null };
  }
}

/**
 * Claims `claim.digest` for one run, atomically: refused when it was claimed already, with the record of the claim that
 * got there first as far as it was written. The claim is kept whatever happens to the run.
 */
export function claimApproval(folder: string, claim: Claim): { ok: true } | { ok: false; record: Partial<Claim> | null } {
  const path = pathOf(folder, claim.digest);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const first = claimOn(folder, claim.digest);
    return { ok: false, record: first.claimed ? first.record : null };
  }
  try {
    writeSync(fd, `${JSON.stringify(claim, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

/** The first run of a recipe whose approval isn't claimed yet; `digestFor` gives each run's digest. */
export function nextRun(folder: string, digestFor: (run: number) => string): number {
  let run = 1;
  while (existsSync(pathOf(folder, digestFor(run)))) run++;
  return run;
}

/** A claim in the person's words: which run, when, and where its evidence went, as far as its record says. */
export function claimText(record: Partial<Claim> | null): string {
  if (!record) return "a run that stopped as it claimed it";
  const when = record.claimedAt ? ` on ${record.claimedAt}` : "";
  const where = record.out ? `, with its evidence in ${record.out}` : "";
  return `${record.run ? `run ${record.run}` : "a run"}${when}${where}`;
}
