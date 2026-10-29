import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BudgetOperation,
  BudgetPolicy,
  currencyOf,
  dayOf,
  GrantRequest,
  JournalSeal,
  hasSharedRequestPool,
  modelRequestPoolLimit,
  monthOf,
  priceUsage,
  rateFor,
  requestBound,
  requestPoolCovers,
  type BudgetAllowances,
  type BudgetAttribution,
  type BudgetBreakdownLine,
  type BudgetGap,
  type BudgetGrant,
  type BudgetMonth,
  type BudgetPeriod,
  type BudgetPolicyDraft,
  type BudgetRecovery,
  type BudgetRemaining,
  type BudgetSummary,
  type BudgetUsage,
  type GrantState,
  type ModelRate,
  type PeriodOpenedBy,
  type PriceCatalogue,
} from "@nivra/domain";
import { num, str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";

/**
 * The shared monthly budget's ledger (NIV-66), in the workspace (its ninth migration). The host is its one authority:
 * engines get finite grants and never see the pool. Every function here is synchronous, so a grant's availability is
 * checked and its row written in one transaction, and two features asking for the last of the allowance can't both be
 * admitted.
 *
 * Every change to spending authority moves the ledger's authority revision forward in the same transaction, with a
 * digest chained to the one before. The caller records that revision and digest in the guard (budget-guard.ts) before
 * anything that depends on it is sent, so a ledger that is later replaced, put back, or changed along another history,
 * even with the same number of grants, is caught at the next start.
 *
 * A grant's unused remainder comes back only on affirmative evidence: it never left `written`, or its engine's
 * complete seal says what was spent, and the ledger works each row's amount out again from its usage at the grant's
 * prices. A journal sealed after an interruption settles the rows it holds and keeps the rest counted. Nothing here
 * ever turns unknown usage into zero, and age never settles a grant.
 *
 * Writing a grant, marking it dispatching and releasing it depend on the guard having found the ledger whole, so each
 * takes the ledger state the guard last verified (the host's start-of-session check, or its latest append) and is
 * refused inside its transaction unless the ledger still holds that history: a caller that skipped the check can't
 * spend or release on a ledger that was put back or diverged.
 */

export interface LedgerState {
  ledgerId: string;
  revision: number;
  /** The digest chained through every revision to this one. */
  chain: string;
}

/** A grant as the ledger keeps it. */
export interface GrantRecord {
  id: string;
  requestId: string;
  /** The digest of everything the grant was asked for, by which a repeated extension is told from another one. */
  requestSha256: string;
  workflow: string;
  targetId: string;
  homeId: string | null;
  periodIndex: number;
  policyVersion: number | null;
  catalogueVersion: string;
  grant: BudgetGrant;
  attribution: BudgetAttribution;
  productiveMicros: number | null;
  finalisationMicros: number | null;
  extendsId: string | null;
  need: string | null;
  state: GrantState;
  sealKind: "complete" | "interrupted" | null;
  recordedMicros: number | null;
  /** The revision the grant was written at: never changes, so a loss recorded later can tell what came before it. */
  writtenRevision: number;
  /** Its day for a daily limit: the local date, never earlier than any grant before it. */
  dayIndex: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Why a grant was refused, in Nivra's own words: each says what happened and what to do. */
export interface GrantRefusal {
  code: "no-price" | "unestablished" | "unpriced-spend" | "pool" | "sublimit" | "counted" | "history-wait" | "duplicate-need" | "closed";
  message: string;
}

const OPEN_STATES: readonly GrantState[] = ["written", "dispatching", "accepted"];
const iso = (at: number) => new Date(at).toISOString();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** Spend in dollars, rounded up to the cent: never shown as less than it was. */
const spentDollars = (micros: number) => (Math.ceil(micros / 10_000) / 100).toFixed(2);
/** A limit in dollars, rounded down to the cent: never shown as more than it allows. */
const limitDollars = (micros: number) => (Math.floor(micros / 10_000) / 100).toFixed(2);

const CONFIRM_NEXT = "wait for next month, and confirm it in your budget when it begins";
/** A month's label from its index (year * 12 + month - 1). */
const monthLabel = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
/** A month's index from its label. */
const monthIndex = (label: string) => Number(label.slice(0, 4)) * 12 + Number(label.slice(5, 7)) - 1;
/** After a loss: wait for the month after the one the loss holds through, by its label. */
const waitFor = (loss: Loss) => `wait for ${monthLabel(loss.throughIndex + 1)}, and confirm it in your budget when it begins`;
/** Thrown when a write that depends on the guard finds a ledger that isn't the one the guard last verified. */
export const BUDGET_UNVERIFIED =
  "Nivra's budget history doesn't match what its guard last checked, so nothing was granted, sent or released. Open Nivra again to check it.";
/** Said under a money policy for a call its price list can't price, naming what the list hasn't established. */
const unestablished = (missing: readonly string[]) =>
  `Your monthly budget is in dollars, but Nivra hasn't established ${eitherOf(missing)}, so it can't keep this call within your budget. Turn the monthly budget off to use the existing per-run limits, or wait for an update to Nivra that establishes what's missing.`;
/** Said under a money policy for a call to a model the price list doesn't have, with whatever else it hasn't established. */
const noPrice = (models: readonly string[], gaps: readonly string[]) =>
  `Your monthly budget is in dollars, but Nivra's price list has no price for ${listed(models)}${gaps.length === 0 ? "" : `, and Nivra hasn't established ${eitherOf(gaps)}`}, so it can't keep this call within your budget. Turn the monthly budget off to use the existing per-run limits, or wait for an update to Nivra whose price list includes ${gaps.length === 0 ? "it" : "it and establishes what's missing"}.`;
const UNPRICED_SPEND = `This month holds spend Nivra couldn't price, from before your monthly budget could count it, so it can't tell how much of your budget is left. Turn the monthly budget off to use the existing per-run limits, or ${CONFIRM_NEXT}.`;

/** The ledger's id, authority revision and chained digest, or null before its first change. */
export function ledgerState(workspace: WorkspaceDb): LedgerState | null {
  return ledgerStateIn(workspace.db);
}

function ledgerStateIn(db: DatabaseSync): LedgerState | null {
  const row = db.prepare("SELECT ledger_id, revision, chain FROM budget_authority WHERE singleton = 1").get();
  return row ? { ledgerId: str(row["ledger_id"]), revision: num(row["revision"]), chain: str(row["chain"]) } : null;
}

/** The chained digest the ledger recorded at `revision` of ledger `ledgerId`, or null when it holds no such revision. */
export function chainAt(workspace: WorkspaceDb, ledgerId: string, revision: number): string | null {
  return chainAtIn(workspace.db, ledgerId, revision);
}

function chainAtIn(db: DatabaseSync, ledgerId: string, revision: number): string | null {
  const row = db.prepare("SELECT chain FROM budget_revisions WHERE ledger_id = ? AND revision = ?").get(ledgerId, revision);
  return row ? str(row["chain"]) : null;
}

/**
 * Whether the ledger still holds the history the guard last verified: the same id, at that revision or past it, with
 * the same digest there. Null means the guard verified that there was no ledger yet.
 */
function holdsVerified(db: DatabaseSync, verified: LedgerState | null): boolean {
  const current = ledgerStateIn(db);
  if (verified === null) return current === null;
  return current !== null && current.ledgerId === verified.ledgerId && current.revision >= verified.revision && chainAtIn(db, verified.ledgerId, verified.revision) === verified.chain;
}

/**
 * The loss the ledger's current history answered, if it began with one: the recovery it was started for, and the
 * revision it started at. The guard's check uses it to clear a recovery whose new history couldn't be recorded there.
 */
export function answeredRecovery(workspace: WorkspaceDb): { recovery: BudgetRecovery; revision: number } | null {
  const current = ledgerStateIn(workspace.db);
  if (!current) return null;
  const row = workspace.db.prepare("SELECT recovery_json, revision FROM budget_adjustments WHERE kind = 'history-lost' AND ledger_id = ? ORDER BY revision DESC LIMIT 1").get(current.ledgerId);
  return row ? { recovery: JSON.parse(str(row["recovery_json"])) as BudgetRecovery, revision: num(row["revision"]) } : null;
}

/**
 * The loss the check found and kept in the workspace (migration 10), or null. It stands until a new history answers
 * it; a guard deleted or cut short meanwhile can't clear it, and a matching copy put back never holds it.
 */
export function pendingRecovery(workspace: WorkspaceDb): BudgetRecovery | null {
  const row = workspace.db.prepare("SELECT recovery_json FROM budget_pending_recovery WHERE singleton = 1").get();
  return row ? (JSON.parse(str(row["recovery_json"])) as BudgetRecovery) : null;
}

/**
 * Keeps a loss the check found in the workspace, before the guard records it. The first one found stands: one already
 * kept is never replaced, so the month it names is never lost to a later, older-looking record.
 */
export function keepPendingRecovery(workspace: WorkspaceDb, recovery: BudgetRecovery, now: number): BudgetRecovery {
  return workspace.tx((db) => {
    const kept = db.prepare("SELECT recovery_json FROM budget_pending_recovery WHERE singleton = 1").get();
    if (kept) return JSON.parse(str(kept["recovery_json"])) as BudgetRecovery;
    db.prepare("INSERT INTO budget_pending_recovery (singleton, recovery_json, found_at) VALUES (1, ?, ?)").run(JSON.stringify(recovery), iso(now));
    return recovery;
  });
}

/** The next digest in the chain. Its random part makes two histories that reach the same revision differ. */
const chainNext = (previous: string | null, ledgerId: string, revision: number) => sha256(`${previous ?? ""}\n${ledgerId}\n${revision}\n${randomUUID()}`);

/** Moves the authority revision forward, inside the caller's transaction, writing the ledger's id with its first change. */
function bump(db: DatabaseSync, at: string): LedgerState {
  const current = ledgerStateIn(db);
  const ledgerId = current?.ledgerId ?? randomUUID();
  const revision = (current?.revision ?? 0) + 1;
  const chain = chainNext(current?.chain ?? null, ledgerId, revision);
  if (current) db.prepare("UPDATE budget_authority SET revision = ?, chain = ? WHERE singleton = 1").run(revision, chain);
  else db.prepare("INSERT INTO budget_authority (singleton, ledger_id, revision, chain, created_at) VALUES (1, ?, ?, ?, ?)").run(ledgerId, revision, chain, at);
  db.prepare("INSERT INTO budget_revisions (ledger_id, revision, chain, at) VALUES (?, ?, ?, ?)").run(ledgerId, revision, chain, at);
  return { ledgerId, revision, chain };
}

/**
 * The guard's order (commit, then append, then send) needs each commit durable when it returns: SQLite's FULL
 * synchronous mode, its default in this build. Kept so, should a build's default ever change.
 */
export function ensureDurable(workspace: WorkspaceDb): void {
  const row = workspace.db.prepare("PRAGMA synchronous").get();
  if (num(row?.["synchronous"] ?? 0) < 2) workspace.db.exec("PRAGMA synchronous = FULL");
}

/** The latest time the ledger recorded anything, for telling a clock that moved back across a restart. */
export function latestLedgerTime(workspace: WorkspaceDb): number | null {
  return latestLedgerTimeIn(workspace.db);
}

function latestLedgerTimeIn(db: DatabaseSync): number | null {
  const row = db
    .prepare(
      `SELECT max(at) AS at FROM (
        SELECT max(updated_at) AS at FROM budget_grants UNION ALL SELECT max(created_at) FROM budget_policies
        UNION ALL SELECT max(opened_at) FROM budget_periods UNION ALL SELECT max(recorded_at) FROM budget_clock
        UNION ALL SELECT max(created_at) FROM budget_adjustments)`,
    )
    .get();
  const at = strOrNull(row?.["at"]);
  return at === null ? null : Date.parse(at);
}

// ---------------------------------------------------------------------------------------------------------- policies

export function currentPolicy(workspace: WorkspaceDb): BudgetPolicy | null {
  return currentPolicyIn(workspace.db);
}

/** The latest version's policy: null before the first, and after a version that turned the monthly budget off. */
function currentPolicyIn(db: DatabaseSync): BudgetPolicy | null {
  const row = db.prepare("SELECT policy_json FROM budget_policies ORDER BY version DESC LIMIT 1").get();
  const json = row ? strOrNull(row["policy_json"]) : null;
  return json === null ? null : BudgetPolicy.parse(JSON.parse(json));
}

/** Names in a sentence: "a", "a and b", "a, b and c". */
const listed = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
/** Alternatives in a sentence: "a", "a or b", "a, b or c". */
const eitherOf = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/**
 * What `catalogue` hasn't established for pricing calls to `rates`' models, in the person's words: their prices'
 * currency, the most a request can cost with each, and whether listing models, which a call to a model does first, is
 * charged. Empty when such calls can be priced, and so held to a budget in dollars.
 */
function unestablishedIn(catalogue: PriceCatalogue, rates: readonly ModelRate[]): string[] {
  // Every model on the list among `rates`, which hold each model once.
  const whole = catalogue.models.every((rate) => rates.includes(rate));
  // Unbounded exactly when requestBound can't bound it, so a call this names nothing for always has a bound.
  const unbounded = rates.filter((rate) => !rate.bounds).map((rate) => rate.model);
  const noCurrency = rates.filter((rate) => currencyOf(catalogue, rate) === null).map((rate) => rate.model);
  return [
    ...(noCurrency.length === 0 ? [] : [whole && noCurrency.length === rates.length ? "the currency of its price list" : `the currency of its prices for ${listed(noCurrency)}`]),
    ...(unbounded.length === 0 ? [] : [`the most a request can cost with ${whole && unbounded.length === rates.length ? "any model on its price list" : listed(unbounded)}`]),
    ...(catalogue.listings === "free" ? [] : [catalogue.listings === "charged" ? "a price for listing its models" : "whether listing its models is charged"]),
  ];
}

/**
 * Why a monthly budget in dollars can't be kept with `catalogue`, in the person's words, or null when it can: every model
 * on it must have its prices' currency and its bounds established, and listing models must be known to be free, so that
 * each call Nivra makes can be reserved at its most before it is sent and nothing it sends falls outside the budget. `current` is the policy now in force, which a refusal leaves as it is: a budget that can't be
 * kept is never saved, and never quietly turned off or into counts alone.
 */
export function dollarBudgetRefusal(catalogue: PriceCatalogue, current: BudgetPolicy | null): string | null {
  const missing = unestablishedIn(catalogue, catalogue.models);
  if (missing.length === 0) return null;
  const why = `Nivra can't keep a monthly budget in dollars yet: it hasn't established ${eitherOf(missing)}, so it couldn't keep each call within the budget before sending it.`;
  if (current === null) return `${why} Your monthly budget stays off, and the existing per-run limits apply. You can set a dollar budget once an update to Nivra establishes what's missing.`;
  if (current.monthlyMicros === null) return `${why} Your budget wasn't changed: it still holds counts only. You can set a dollar budget once an update to Nivra establishes what's missing.`;
  return `${why} Your budget wasn't changed: it stays at ${limitDollars(current.monthlyMicros)} dollars a month. Turn the monthly budget off to use the existing per-run limits instead, or wait for an update to Nivra that establishes what's missing.`;
}

/**
 * Saves the person's choice as the next policy version, or with null a version that turns the monthly budget off. What
 * was spent, reserved or left uncertain stays as it was: a new version changes what is admitted from now on, never the
 * history. The ledger's first month opens with its first policy or grant. Turning off a budget that is already off
 * changes nothing. A budget in dollars that `catalogue`, the price list new grants are priced with, can't keep is
 * refused, throwing the person's words (dollarBudgetRefusal), and nothing changes; with the budget off, the existing
 * per-run limits apply, as the person's own choice. A counts-only budget needs no price list: it holds no money.
 */
export function setPolicy(workspace: WorkspaceDb, draft: BudgetPolicyDraft | null, now: number, catalogue: PriceCatalogue): { policy: BudgetPolicy | null; authority: LedgerState | null } {
  const at = iso(now);
  return workspace.tx((db) => {
    const latest = db.prepare("SELECT version, policy_json FROM budget_policies ORDER BY version DESC LIMIT 1").get();
    if (draft === null && (!latest || latest["policy_json"] === null)) return { policy: null, authority: null };
    const refusal = draft === null || draft.monthlyMicros === null ? null : dollarBudgetRefusal(catalogue, currentPolicyIn(db));
    if (refusal) throw new Error(refusal);
    const version = latest ? num(latest["version"]) + 1 : 1;
    const replaces = latest ? version - 1 : null;
    const policy = draft === null ? null : BudgetPolicy.parse({ ...draft, version, replaces, createdAt: at });
    const authority = bump(db, at);
    db.prepare("INSERT INTO budget_policies (version, policy_json, replaces, revision, created_at) VALUES (?, ?, ?, ?, ?)").run(version, policy === null ? null : JSON.stringify(policy), replaces, authority.revision, at);
    if (policy) ensureFirstPeriod(db, now, policy.timezone, authority.revision, at);
    return { policy, authority };
  });
}

// ------------------------------------------------------------------------------------------------------- price lists

/** Keeps a price list version, once. A version already kept with other contents is refused: versions never change. */
export function registerCatalogue(workspace: WorkspaceDb, catalogue: PriceCatalogue, now: number): void {
  workspace.tx((db) => registerCatalogueIn(db, catalogue, iso(now)));
}

function registerCatalogueIn(db: DatabaseSync, catalogue: PriceCatalogue, at: string): void {
  const json = JSON.stringify(catalogue);
  const digest = sha256(json);
  const row = db.prepare("SELECT sha256 FROM price_catalogues WHERE version = ?").get(catalogue.version);
  if (row) {
    if (str(row["sha256"]) !== digest) throw new Error(`Price list ${catalogue.version} is already kept with other contents; a new list needs a new version.`);
    return;
  }
  db.prepare("INSERT INTO price_catalogues (version, catalogue_json, sha256, registered_at) VALUES (?, ?, ?, ?)").run(catalogue.version, json, digest, at);
}

// ----------------------------------------------------------------------------------------------------------- months

const periodOf = (row: Row): BudgetPeriod => ({
  index: num(row["idx"]),
  label: str(row["label"]),
  startsAt: str(row["starts_at"]),
  endsAt: str(row["ends_at"]),
  timezone: str(row["timezone"]),
  openedBy: str(row["opened_by"]) as PeriodOpenedBy,
  openedAt: str(row["opened_at"]),
});

export function currentPeriod(workspace: WorkspaceDb): BudgetPeriod | null {
  return currentPeriodIn(workspace.db);
}

function currentPeriodIn(db: DatabaseSync): BudgetPeriod | null {
  const row = db.prepare("SELECT * FROM budget_periods ORDER BY idx DESC LIMIT 1").get();
  return row ? periodOf(row) : null;
}

/**
 * The latest budget month the ledger has established, by its label (null before its first): its latest month, or the
 * month a lost history it was started again after holds through, when that is later. A month is established only as
 * the ledger opens it (its first with its first change; later ones on the provider's clock or the person's word) or as
 * a guard kept it for a lost history: the computer's clock alone never makes one. The host records it in the guard with
 * every revision, before anything that depends on it is sent, so what a lost history reached outlives it.
 */
export function establishedMonth(workspace: WorkspaceDb): string | null {
  const row = workspace.db
    .prepare("SELECT max(idx) AS idx FROM (SELECT max(idx) AS idx FROM budget_periods UNION ALL SELECT max(through_idx) FROM budget_adjustments WHERE kind = 'history-lost')")
    .get();
  return row?.["idx"] === null || row?.["idx"] === undefined ? null : monthLabel(num(row["idx"]));
}

function insertPeriod(db: DatabaseSync, month: BudgetMonth, timezone: string, openedBy: PeriodOpenedBy, evidence: object | null, revision: number, at: string): BudgetPeriod {
  db.prepare("INSERT INTO budget_periods (idx, label, starts_at, ends_at, timezone, opened_by, evidence_json, opened_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    month.index,
    month.label,
    iso(month.startsAt),
    iso(month.endsAt),
    timezone,
    openedBy,
    evidence === null ? null : JSON.stringify(evidence),
    at,
    revision,
  );
  return periodOf(db.prepare("SELECT * FROM budget_periods WHERE idx = ?").get(month.index)!);
}

/** The ledger's first month, opened with its first policy or grant. Every later month needs evidence. */
function ensureFirstPeriod(db: DatabaseSync, now: number, timezone: string, revision: number, at: string): BudgetPeriod {
  return currentPeriodIn(db) ?? insertPeriod(db, monthOf(now, timezone), timezone, "first", null, revision, at);
}

/**
 * Records a time an engine received from the provider (the Date of a response), and opens the month it falls in when
 * that is later than the current one: the provider's clock, not the computer's, corroborates a new month. A provider
 * time in the current month, or an earlier one, opens nothing.
 */
export function observeProviderTime(workspace: WorkspaceDb, providerAt: number, now: number, timezone: string): { opened: BudgetPeriod | null; authority: LedgerState | null } {
  const at = iso(now);
  return workspace.tx((db) => {
    db.prepare("INSERT INTO budget_clock (kind, wall_at, provider_at, delta_ms, recorded_at) VALUES ('provider', ?, ?, ?, ?)").run(at, iso(providerAt), providerAt - now, at);
    const current = currentPeriodIn(db);
    const month = monthOf(providerAt, timezone);
    if (!current || month.index <= current.index) return { opened: null, authority: null };
    const authority = bump(db, at);
    return { opened: insertPeriod(db, month, timezone, "corroborated", { providerAt: iso(providerAt) }, authority.revision, at), authority };
  });
}

/**
 * The person confirms that a new month has begun, by the computer's clock, which alone would open nothing. They confirm
 * the month they were shown, by its label: refused when the computer's clock now says another month, or when it is
 * still in the current month, or behind it.
 */
export function confirmMonth(workspace: WorkspaceDb, label: string, now: number, timezone: string): { opened: BudgetPeriod; authority: LedgerState } | { refused: "not-shown" | "not-later" } {
  const at = iso(now);
  return workspace.tx((db) => {
    const current = currentPeriodIn(db);
    const month = monthOf(now, timezone);
    if (month.label !== label) return { refused: "not-shown" as const };
    if (current && month.index <= current.index) return { refused: "not-later" as const };
    const authority = bump(db, at);
    const opened = current ? insertPeriod(db, month, timezone, "confirmed", { by: "person", wallAt: at, label }, authority.revision, at) : insertPeriod(db, month, timezone, "first", null, authority.revision, at);
    return { opened, authority };
  });
}

/** Records a jump of the computer's clock, as seen by the host. A jump opens no month and changes no allowance. */
export function recordClockJump(workspace: WorkspaceDb, kind: "jump-forward" | "jump-back", now: number, deltaMs: number): void {
  const at = iso(now);
  workspace.db.prepare("INSERT INTO budget_clock (kind, wall_at, delta_ms, recorded_at) VALUES (?, ?, ?, ?)").run(kind, at, Math.round(deltaMs), at);
}

/** The jumps recorded since `since` (all of them when null), newest first, at most 20. */
function jumpsSince(db: DatabaseSync, since: string | null): BudgetSummary["clock"]["jumps"] {
  return db
    .prepare("SELECT kind, wall_at, delta_ms FROM budget_clock WHERE kind IN ('jump-forward', 'jump-back') AND (?1 IS NULL OR recorded_at >= ?1) ORDER BY id DESC LIMIT 20")
    .all(since)
    .map((row) => ({ kind: str(row["kind"]) as "jump-forward" | "jump-back", at: str(row["wall_at"]), deltaMs: num(row["delta_ms"]) }));
}

// ----------------------------------------------------------------------------------------------------------- grants

const grantOf = (row: Row): GrantRecord => ({
  id: str(row["id"]),
  requestId: str(row["request_id"]),
  requestSha256: str(row["request_sha256"]),
  workflow: str(row["workflow"]),
  targetId: str(row["target_id"]),
  homeId: strOrNull(row["home_id"]),
  periodIndex: num(row["period_idx"]),
  policyVersion: row["policy_version"] === null ? null : num(row["policy_version"]),
  catalogueVersion: str(row["catalogue_version"]),
  grant: JSON.parse(str(row["grant_json"])) as BudgetGrant,
  attribution: JSON.parse(str(row["attribution_json"])) as BudgetAttribution,
  productiveMicros: row["productive_micros"] === null ? null : num(row["productive_micros"]),
  finalisationMicros: row["finalisation_micros"] === null ? null : num(row["finalisation_micros"]),
  extendsId: strOrNull(row["extends_id"]),
  need: strOrNull(row["need"]),
  state: str(row["state"]) as GrantState,
  sealKind: strOrNull(row["seal_kind"]) as GrantRecord["sealKind"],
  recordedMicros: row["recorded_micros"] === null ? null : num(row["recorded_micros"]),
  writtenRevision: num(row["written_revision"]),
  dayIndex: num(row["day_idx"]),
  revision: num(row["revision"]),
  createdAt: str(row["created_at"]),
  updatedAt: str(row["updated_at"]),
});

export function getGrant(workspace: WorkspaceDb, id: string): GrantRecord | null {
  const row = workspace.db.prepare("SELECT * FROM budget_grants WHERE id = ?").get(id);
  return row ? grantOf(row) : null;
}

/** Grants a reconciler still has to settle: written, dispatching, accepted or uncertain, oldest first. */
export function openGrants(workspace: WorkspaceDb): GrantRecord[] {
  return workspace.db.prepare("SELECT * FROM budget_grants WHERE state IN ('written', 'dispatching', 'accepted', 'uncertain') ORDER BY created_at, rowid").all().map(grantOf);
}

const noUsage = (): BudgetUsage => ({ requests: 0, unknownRequests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
function addUsage(into: BudgetUsage, from: BudgetUsage): void {
  into.requests += from.requests;
  into.unknownRequests += from.unknownRequests;
  into.inputTokens += from.inputTokens;
  into.cachedInputTokens += from.cachedInputTokens;
  into.outputTokens += from.outputTokens;
}

/**
 * What a grant counts: its money, null when the grant couldn't be priced (never 0 for that), and its model requests as
 * their rows reported them. Open grants count in full; settled ones what their rows count; uncertain and written-off
 * ones in full, or what their rows count when that is more.
 */
interface GrantCounts {
  money: { settled: number; unknown: number; reserved: number } | null;
  usage: BudgetUsage;
}

function countsOf(db: DatabaseSync, grant: GrantRecord): GrantCounts {
  if (grant.state === "released") return { money: { settled: 0, unknown: 0, reserved: 0 }, usage: noUsage() };
  const full = grant.productiveMicros === null ? null : grant.productiveMicros + (grant.finalisationMicros ?? 0);
  if (OPEN_STATES.includes(grant.state)) return { money: full === null ? null : { settled: 0, unknown: 0, reserved: full }, usage: noUsage() };
  const usage = noUsage();
  let reported = 0;
  let unknownRows = 0;
  for (const row of db.prepare("SELECT kind, state, counted_micros, operation_json FROM budget_operations WHERE grant_id = ?").all(grant.id)) {
    const state = str(row["state"]);
    if (state === "unsent") continue;
    if (str(row["kind"]) === "model-request") {
      if (state === "unknown") usage.unknownRequests += 1;
      else {
        const reportedUsage = (JSON.parse(str(row["operation_json"])) as BudgetOperation).usage;
        usage.requests += 1;
        usage.inputTokens += reportedUsage?.inputTokens ?? 0;
        usage.cachedInputTokens += reportedUsage?.cachedInputTokens ?? 0;
        usage.outputTokens += reportedUsage?.outputTokens ?? 0;
      }
    }
    const counted = row["counted_micros"] === null ? 0 : num(row["counted_micros"]);
    if (state === "unknown") unknownRows += counted;
    else reported += counted;
  }
  if (full === null) return { money: null, usage };
  if (grant.state === "settled") return { money: { settled: reported, unknown: unknownRows, reserved: 0 }, usage };
  // Uncertain or written off: the whole grant stays counted, or what its rows count when that is more.
  const total = Math.max(full, reported + unknownRows);
  return { money: { settled: reported, unknown: total - reported, reserved: 0 }, usage };
}

const spent = (money: NonNullable<GrantCounts["money"]>) => money.settled + money.unknown + money.reserved;

/** What `grants` count in money, or null when one that couldn't be priced isn't `covered`: unknown is never 0. */
function moneyOf(db: DatabaseSync, grants: readonly GrantRecord[], covered: (grant: GrantRecord) => boolean = () => false): number | null {
  let total = 0;
  for (const grant of grants) {
    const money = countsOf(db, grant).money;
    if (money !== null) total += spent(money);
    else if (!covered(grant)) return null;
  }
  return total;
}

/**
 * The counted services `grants` use. Open, uncertain and written-off grants count their whole allowances, or their
 * rows when those say more; settled ones what their rows reported, and a service any of whose rows has no reported
 * size counts the grant's whole allowance for it. Every Nebius operation, upload or download counts as one.
 */
function countedOf(db: DatabaseSync, grants: readonly GrantRecord[]): BudgetAllowances {
  const used = { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 };
  for (const grant of grants) {
    if (grant.state === "released") continue;
    const allowed = grant.grant.allowances;
    if (OPEN_STATES.includes(grant.state)) {
      used.sandboxOperations += allowed.sandboxOperations;
      used.sandboxSeconds += allowed.sandboxSeconds;
      used.researchCredits += allowed.researchCredits;
      continue;
    }
    let operations = 0;
    let seconds = 0;
    let credits = 0;
    let secondsUnknown = false;
    let creditsUnknown = false;
    for (const row of db.prepare("SELECT kind, state, units FROM budget_operations WHERE grant_id = ?").all(grant.id)) {
      const state = str(row["state"]);
      if (state === "unsent") continue;
      const kind = str(row["kind"]);
      const units = row["units"] === null || state === "unknown" ? null : num(row["units"]);
      if (kind === "sandbox-operation" || kind === "sandbox-transfer") operations += 1;
      if (kind === "sandbox-operation") {
        if (units === null) secondsUnknown = true;
        else seconds += units;
      } else if (kind === "research-search" || kind === "research-extract") {
        if (units === null) creditsUnknown = true;
        else credits += units;
      }
    }
    const whole = grant.state !== "settled";
    used.sandboxOperations += whole ? Math.max(allowed.sandboxOperations, operations) : operations;
    used.sandboxSeconds += whole || secondsUnknown ? Math.max(allowed.sandboxSeconds, seconds) : seconds;
    used.researchCredits += whole || creditsUnknown ? Math.max(allowed.researchCredits, credits) : credits;
  }
  return used;
}

/** The latest day any grant was written on, or null before the first. */
function latestDayIn(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT max(day_idx) AS day FROM budget_grants").get();
  return row?.["day"] === null || row?.["day"] === undefined ? null : num(row["day"]);
}

function periodGrants(db: DatabaseSync, periodIndex: number): GrantRecord[] {
  return db.prepare("SELECT * FROM budget_grants WHERE period_idx = ? ORDER BY created_at, rowid").all(periodIndex).map(grantOf);
}

/**
 * A history lost: the revision it was recorded at, the ledger's month then, the recovery month it holds through, and
 * what the person said was left (null: wait for the month after).
 */
interface Loss {
  revision: number;
  periodIndex: number;
  throughIndex: number;
  remaining: BudgetRemaining | null;
  createdAt: string;
}

/**
 * The loss that binds a ledger month: the latest recorded in that month or before it whose recovery month is that one
 * or later. A loss holds through its recovery month however many of the ledger's months that spans, so a history put
 * back from an older month, and then moved on to the real one, can't leave it behind.
 */
function lossIn(db: DatabaseSync, periodIndex: number): Loss | null {
  const row = db
    .prepare("SELECT period_idx, through_idx, remaining_json, revision, created_at FROM budget_adjustments WHERE kind = 'history-lost' AND period_idx <= ?1 AND through_idx >= ?1 ORDER BY revision DESC LIMIT 1")
    .get(periodIndex);
  if (!row) return null;
  const remaining = strOrNull(row["remaining_json"]);
  return {
    revision: num(row["revision"]),
    periodIndex: num(row["period_idx"]),
    throughIndex: num(row["through_idx"]),
    remaining: remaining === null ? null : (JSON.parse(remaining) as BudgetRemaining),
    createdAt: str(row["created_at"]),
  };
}

/** Whether a grant's spend is what a loss's statement covers: written before the loss, in a month the loss holds. */
const coveredBy = (loss: Loss | null) => (grant: GrantRecord) =>
  loss !== null && grant.writtenRevision <= loss.revision && grant.periodIndex >= loss.periodIndex && grant.periodIndex <= loss.throughIndex;

/** The grants written since a loss, in every ledger month it holds through: what the person said was left counts them all. */
function grantsSince(db: DatabaseSync, loss: Loss): GrantRecord[] {
  return db
    .prepare("SELECT * FROM budget_grants WHERE written_revision > ? AND period_idx >= ? AND period_idx <= ? ORDER BY created_at, rowid")
    .all(loss.revision, loss.periodIndex, loss.throughIndex)
    .map(grantOf);
}

/** Whether using `asked` more than `used` would go past `allowed`, for any counted service. */
const pastAllowance = (used: BudgetAllowances, asked: BudgetAllowances, allowed: BudgetAllowances) =>
  used.sandboxOperations + asked.sandboxOperations > allowed.sandboxOperations ||
  used.sandboxSeconds + asked.sandboxSeconds > allowed.sandboxSeconds ||
  used.researchCredits + asked.researchCredits > allowed.researchCredits;

/** The most one request of shape `outputTokens` may cost across `rates`, or null when any of them isn't bounded. */
function boundAcross(rates: readonly ModelRate[], outputTokens: number): number | null {
  let most = 0;
  for (const rate of rates) {
    const bound = requestBound(rate, outputTokens);
    if (!bound) return null;
    most = Math.max(most, bound.micros);
  }
  return most;
}

/**
 * Writes a grant for one spendable call, before anything is sent, or refuses it. A call that reaches a model is priced
 * only when every model it may use is on the price list with its bounds and its prices' currency established, and the
 * list says listing models is free; one that reaches none costs no money here, and its counted services are held. A
 * history lost this month binds in every mode. Under a money policy the grant must also be priced, and fit the pool,
 * every sublimit that applies, and the counted services, and a model the price list doesn't have is refused by name.
 * Without one nothing else limits it, a model the list doesn't have included, but it is still written, priced where it
 * can be, and counted. An extension answers one need once: asked again with the same request, the same grant comes
 * back; with another, it is refused.
 * `verified` is the ledger state the guard last verified; a ledger that no longer holds it throws BUDGET_UNVERIFIED.
 */
export function writeGrant(
  workspace: WorkspaceDb,
  request: GrantRequest,
  context: { now: number; catalogue: PriceCatalogue; timezone: string; verified: LedgerState | null },
): { grant: BudgetGrant; authority: LedgerState | null } | { refused: GrantRefusal } {
  const asked = GrantRequest.parse(request);
  const digest = sha256(JSON.stringify(asked));
  return writeGrantWithDigest(workspace, asked, context, digest);
}

/**
 * Size one planner operation inside the ledger transaction, with one request protected for its final answer. The
 * original maximum is its idempotency identity: a retry must return the same grant even after availability changes.
 */
export function writeAdaptivePlanningGrant(
  workspace: WorkspaceDb,
  request: GrantRequest,
  context: { now: number; catalogue: PriceCatalogue; timezone: string; verified: LedgerState | null },
): { grant: BudgetGrant; authority: LedgerState | null } | { refused: GrantRefusal } {
  const asked = GrantRequest.parse(request);
  const maximum = asked.productive.requests + asked.finalisation.requests;
  if (asked.attribution.feature !== "planning" || asked.workflow !== "planning" || asked.extends !== null || asked.finalisation.requests !== 1 || maximum < 1 || maximum > 8) throw new Error("A planning grant needs one final answer and at most eight requests in total.");
  const digest = sha256(JSON.stringify(asked));
  return workspace.tx((db) => {
    if (!holdsVerified(db, context.verified)) throw new Error(BUDGET_UNVERIFIED);
    const existing = db.prepare("SELECT * FROM budget_grants WHERE request_id = ? AND extends_id IS NULL").get(asked.requestId);
    if (existing) {
      const record = grantOf(existing);
      return record.requestSha256 === digest ? { grant: record.grant, authority: null } : { refused: { code: "duplicate-need" as const, message: "This planning operation was already granted with different contents. Start a new explicit request." } };
    }
    const policy = currentPolicyIn(db);
    if (policy?.modelRequestLimits?.length && !hasSharedRequestPool(policy.modelRequestLimits)) return { refused: { code: "counted" as const, message: "The request allowance still covers the companion only. Update its coverage to Companion and planning before requesting AI planning; manual planning remains available." } };
    const period = currentPeriodIn(db);
    const periodIndex = period?.index ?? monthOf(context.now, policy?.timezone ?? context.timezone).index;
    const grants = periodGrants(db, periodIndex).filter((grant) => requestPoolCovers(grant.attribution.feature));
    let available = maximum;
    const cap = modelRequestPoolLimit(policy?.modelRequestLimits);
    if (cap !== null) available = Math.min(available, Math.max(0, cap - requestsHeld(db, grants)));
    const loss = lossIn(db, periodIndex);
    if (loss?.remaining?.mode === "counts") available = Math.min(available, Math.max(0, (modelRequestPoolLimit(loss.remaining.modelRequestLimits) ?? 0) - requestsHeld(db, grantsSince(db, loss).filter((grant) => requestPoolCovers(grant.attribution.feature)))));
    if (available < 1) return { refused: { code: "counted" as const, message: "The monthly Companion and planning allowance is exhausted. Raise the limit, wait for the next confirmed month, or continue manually." } };
    return writeGrantWithDigest(workspace, { ...asked, productive: { ...asked.productive, requests: available - 1 }, finalisation: { ...asked.finalisation, requests: 1 } }, context, digest);
  });
}

function writeGrantWithDigest(
  workspace: WorkspaceDb,
  asked: GrantRequest,
  context: { now: number; catalogue: PriceCatalogue; timezone: string; verified: LedgerState | null },
  digest: string,
): { grant: BudgetGrant; authority: LedgerState | null } | { refused: GrantRefusal } {
  const at = iso(context.now);
  return workspace.tx((db) => {
    if (!holdsVerified(db, context.verified)) throw new Error(BUDGET_UNVERIFIED);
    if (asked.extends === null) {
      const existing = db.prepare("SELECT * FROM budget_grants WHERE request_id = ? AND extends_id IS NULL").get(asked.requestId);
      if (existing) {
        const record = grantOf(existing);
        return record.requestSha256 === digest ? { grant: record.grant, authority: null } : { refused: { code: "duplicate-need" as const, message: "This request was already granted with different contents. Start a new explicit request." } };
      }
    }
    if (asked.extends !== null) {
      const existing = db.prepare("SELECT * FROM budget_grants WHERE extends_id = ? AND need = ?").get(asked.extends, asked.need);
      if (existing) {
        const record = grantOf(existing);
        if (record.requestSha256 === digest) return { grant: record.grant, authority: null };
        return { refused: { code: "duplicate-need" as const, message: "That need was already answered with a different grant, so this one wasn't written. Ask for the next need instead." } };
      }
      const first = db.prepare("SELECT * FROM budget_grants WHERE id = ?").get(asked.extends);
      if (first && (str(first["workflow"]) !== asked.workflow || str(first["target_id"]) !== asked.targetId || str(first["attribution_json"]) !== JSON.stringify(asked.attribution))) return { refused: { code: "closed" as const, message: "An extension must keep the original work, target and attribution." } };
      if (!first || str(first["request_id"]) !== asked.requestId || !["dispatching", "accepted"].includes(str(first["state"]))) {
        return { refused: { code: "closed" as const, message: "The work this extension was asked for has ended or can't be found, so nothing more was granted." } };
      }
    }
    const policy = currentPolicyIn(db);
    registerCatalogueIn(db, context.catalogue, at);
    // Each model once, whatever its case, as the list names it: a model asked for twice is still one model.
    const rates: ModelRate[] = [];
    const unlisted: string[] = [];
    for (const model of asked.models) {
      const rate = rateFor(context.catalogue, model);
      if (rate) {
        if (!rates.includes(rate)) rates.push(rate);
      } else if (!unlisted.some((one) => one.toLowerCase() === model.toLowerCase())) unlisted.push(model);
    }
    // A call that reaches a model is priced only when the list has every model it may use, with their prices' currency
    // (each model's own, or the list's) and their bounds established, and says listing models, which the call does
    // first, is free: a listing charge it can't price would count as nothing. Each grant is checked with the list it is
    // priced with, so a budget set while listing was free admits no call to a model once a later list says listing is
    // charged, or doesn't know (Nate's review of PR 35). One model the list doesn't have leaves the whole grant
    // unpriced, whatever the others' bounds.
    const gaps = asked.models.length === 0 ? [] : unestablishedIn(context.catalogue, rates);
    // A model the price list doesn't have can't be held to money: under a money policy (every policy, for now) it is
    // refused by name, with whatever else the list hasn't established; with the budget off it is admitted, counted and
    // unpriced, its money unknown, never 0 (Nate's choice (b)).
    if (unlisted.length > 0 && policy?.monthlyMicros != null) return { refused: { code: "no-price" as const, message: noPrice(unlisted, gaps) } };
    const missing = [...(unlisted.length === 0 ? [] : [`a price for ${listed(unlisted)}`]), ...gaps];
    const productiveBound = asked.models.length === 0 ? 0 : boundAcross(rates, asked.productive.outputTokens);
    const finalisationBound = asked.models.length === 0 ? 0 : boundAcross(rates, asked.finalisation.outputTokens);
    const priced = missing.length === 0;
    const productiveMicros = priced ? asked.productive.requests * productiveBound! : null;
    const finalisationMicros = priced ? asked.finalisation.requests * finalisationBound! : null;
    const timezone = policy?.timezone ?? context.timezone;
    const period = currentPeriodIn(db);
    const periodIndex = period?.index ?? monthOf(context.now, timezone).index;
    // Its day never goes back past a day a grant was already written on, whatever the clock says.
    const dayIndex = Math.max(dayOf(context.now, timezone).index, latestDayIn(db) ?? Number.NEGATIVE_INFINITY);
    const need = productiveMicros === null ? null : productiveMicros + finalisationMicros!;
    const refusal = admission(db, { policy, periodIndex, dayIndex, request: asked, need, missing });
    if (refusal) return { refused: refusal };
    const authority = bump(db, at);
    if (!period) insertPeriod(db, monthOf(context.now, timezone), timezone, "first", null, authority.revision, at);
    const id = randomUUID();
    const grant: BudgetGrant = {
      id,
      requestId: asked.requestId,
      catalogueVersion: context.catalogue.version,
      rates,
      models: asked.models,
      productiveMicros,
      finalisationMicros,
      productive: asked.productive,
      finalisation: asked.finalisation,
      allowances: asked.allowances,
    };
    db.prepare(
      `INSERT INTO budget_grants (id, request_id, request_sha256, workflow, target_id, period_idx, policy_version, catalogue_version, grant_json, attribution_json, feature, project_id,
        attempt_id, queue_id, profile_id, model, productive_micros, finalisation_micros, extends_id, need, state, written_revision, day_idx, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'written', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      asked.requestId,
      digest,
      asked.workflow,
      asked.targetId,
      periodIndex,
      policy?.version ?? null,
      context.catalogue.version,
      JSON.stringify(grant),
      JSON.stringify(asked.attribution),
      asked.attribution.feature,
      asked.attribution.projectId,
      asked.attribution.attemptId,
      asked.attribution.queueId,
      asked.attribution.profile?.id ?? null,
      asked.models[0] ?? null,
      productiveMicros,
      finalisationMicros,
      asked.extends,
      asked.need,
      authority.revision,
      dayIndex,
      authority.revision,
      at,
      at,
    );
    return { grant, authority };
  });
}

/**
 * Whether a grant needing `need` (null: it couldn't be priced, for want of what `missing` names) may be written. Null
 * when it may. A history lost this month binds first, in every mode: waiting admits nothing, and what the person said
 * was left admits only priced grants whose money and counted services fit what is left of it. Under a money policy the
 * grant must also be priced, and fit the pool, each sublimit that applies and the counted services; a call that
 * reaches no model needs no money, so only its counted services are checked.
 */
function admission(
  db: DatabaseSync,
  input: { policy: BudgetPolicy | null; periodIndex: number; dayIndex: number; request: GrantRequest; need: number | null; missing: readonly string[] },
): GrantRefusal | null {
  const { policy, periodIndex, request, need } = input;
  const grants = periodGrants(db, periodIndex);
  const loss = lossIn(db, periodIndex);
  if (loss) {
    const remaining = loss.remaining;
    const month = monthLabel(loss.throughIndex);
    if (remaining === null) {
      return { code: "history-wait", message: `Nivra lost its budget history in ${month}, and you chose to wait for the month after, so nothing more is admitted before ${monthLabel(loss.throughIndex + 1)}. When it begins, confirm it in your budget.` };
    }
    if (remaining.mode === "counts") {
      const cap = modelRequestPoolLimit(remaining.modelRequestLimits) ?? 0;
      const after = grantsSince(db, loss).filter((grant) => requestPoolCovers(grant.attribution.feature));
      if (request.models.length > 0 && (!requestPoolCovers(request.attribution.feature) || requestsHeld(db, after) + request.productive.requests + request.finalisation.requests > cap)) return { code: "counted", message: "This exceeds the Companion and planning requests you said remained after recovery. Change the recovery allowance or wait for the next confirmed month." };
    } else {
    if (need === null) {
      return { code: "unestablished", message: `After Nivra lost its budget history you set ${limitDollars(remaining.micros)} dollars for the rest of ${month}, but Nivra hasn't established ${eitherOf(input.missing)}, so it can't keep the call within that. Please ${waitFor(loss)}.` };
    }
    const after = grantsSince(db, loss);
    const since = moneyOf(db, after);
    if (since === null || since + need > remaining.micros) {
      return { code: "pool", message: `This would go past the ${limitDollars(remaining.micros)} dollars you set for the rest of ${month} after Nivra lost its budget history. Please ${waitFor(loss)}.` };
    }
    }
    if (pastAllowance(countedOf(db, grantsSince(db, loss)), request.allowances, remaining.allowances)) {
      return { code: "counted", message: `This would go past the sandbox operations, sandbox time or research credits you said were left for ${month} after Nivra lost its budget history. Please ${waitFor(loss)}.` };
    }
  }
  if (!policy) return null;
  const requestLimit = modelRequestPoolLimit(policy.modelRequestLimits);
  if (request.attribution.feature === "planning" && policy.modelRequestLimits?.length && !hasSharedRequestPool(policy.modelRequestLimits)) return { code: "counted", message: "The request allowance still covers the companion only. Update its coverage to Companion and planning before requesting AI planning; manual planning remains available." };
  if (requestLimit !== null && requestPoolCovers(request.attribution.feature) && requestsHeld(db, grants.filter((grant) => requestPoolCovers(grant.attribution.feature))) + request.productive.requests + request.finalisation.requests > requestLimit) return { code: "counted", message: "The monthly Companion and planning request allowance cannot cover this turn. Raise the allowance, wait for the next confirmed month, or continue planning manually." };
  // A counts-only budget holds no money: only its counted services are checked, and an unpriced call is admitted.
  if (policy.monthlyMicros !== null) {
    if (need === null) return { code: "unestablished", message: unestablished(input.missing) };
    if (need > 0) {
      const refusal = moneyAdmission(db, { ...input, policy: { ...policy, monthlyMicros: policy.monthlyMicros }, grants, loss, need });
      if (refusal) return refusal;
    }
  }
  if (pastAllowance(countedOf(db, grants), request.allowances, policy.allowances)) {
    return { code: "counted", message: `This would go past this month's allowance of sandbox operations, sandbox time or research credits in your budget. Raise it, or ${CONFIRM_NEXT}.` };
  }
  return null;
}

/**
 * The pool and the money sublimits, for a grant that needs money. Spend in a scope that couldn't be priced can't be
 * counted as nothing, so it refuses, except spend from before a loss, which what the person said then covers.
 */
function moneyAdmission(
  db: DatabaseSync,
  input: { policy: BudgetPolicy & { monthlyMicros: number }; grants: readonly GrantRecord[]; loss: Loss | null; dayIndex: number; request: GrantRequest; need: number },
): GrantRefusal | null {
  const { policy, grants, loss, dayIndex, request, need } = input;
  const covered = coveredBy(loss);
  const used = moneyOf(db, grants, covered);
  if (used === null) return { code: "unpriced-spend", message: UNPRICED_SPEND };
  if (used + need > policy.monthlyMicros) {
    return { code: "pool", message: `This would go past your monthly budget of ${limitDollars(policy.monthlyMicros)} dollars: ${spentDollars(used)} is already spent or reserved this month. Raise your budget, or ${CONFIRM_NEXT}.` };
  }
  const sublimits = policy.sublimits;
  const check = (limit: number | null, scope: readonly GrantRecord[], name: string, then: string, unpriced: string): GrantRefusal | null => {
    if (limit === null) return null;
    const total = moneyOf(db, scope, covered);
    if (total === null) return { code: "unpriced-spend", message: unpriced };
    return total + need > limit ? { code: "sublimit", message: `This would go past the ${name} limit of ${limitDollars(limit)} dollars in your budget. Raise it, ${then}.` } : null;
  };
  // A day's grants are those written on its date, which never goes back, so a clock moved back frees nothing.
  const today = db.prepare("SELECT * FROM budget_grants WHERE day_idx = ? ORDER BY created_at, rowid").all(dayIndex).map(grantOf);
  // A task's or a queue's limit holds across a month's end: its grants are counted wherever they fall.
  const ofAttempt = request.attribution.attemptId === null ? [] : db.prepare("SELECT * FROM budget_grants WHERE attempt_id = ?").all(request.attribution.attemptId).map(grantOf);
  const ofQueue = request.attribution.queueId === null ? [] : db.prepare("SELECT * FROM budget_grants WHERE queue_id = ?").all(request.attribution.queueId).map(grantOf);
  const whose = (what: string) =>
    `This ${what}'s spend includes some Nivra couldn't price, so it can't tell how much of the ${what}'s limit is left. Turn the monthly budget off to use today's fixed allowances, or remove the ${what} limit from your budget.`;
  const refusals = [
    check(sublimits.dailyMicros, today, "daily", "or wait for tomorrow", UNPRICED_SPEND),
    request.attribution.attemptId === null ? null : check(sublimits.perTaskMicros, ofAttempt, "per-task", "or end this task's work here", whose("task")),
    request.attribution.queueId === null ? null : check(sublimits.perQueueMicros, ofQueue, "per-queue", "or end this queue's work here", whose("queue")),
    ...sublimits.projects
      .filter((limit) => limit.projectId === request.attribution.projectId)
      .map((limit) => check(limit.monthlyMicros, grants.filter((grant) => grant.attribution.projectId === limit.projectId), "project", `or ${CONFIRM_NEXT}`, UNPRICED_SPEND)),
    ...sublimits.profiles
      .filter((limit) => limit.profileId === request.attribution.profile?.id)
      .map((limit) => check(limit.monthlyMicros, grants.filter((grant) => grant.attribution.profile?.id === limit.profileId), "agent", `or ${CONFIRM_NEXT}`, UNPRICED_SPEND)),
  ];
  return refusals.find((refusal) => refusal !== null) ?? null;
}

/**
 * Moves a grant from one state to the next, bumping the revision; null when it isn't in a state it can move from. With
 * `verified`, the ledger must still hold the history the guard last verified, or it throws BUDGET_UNVERIFIED.
 */
function move(
  workspace: WorkspaceDb,
  id: string,
  from: readonly GrantState[],
  to: GrantState,
  now: number,
  extra: { homeId?: string; verified?: LedgerState | null } = {},
): LedgerState | null {
  const at = iso(now);
  return workspace.tx((db) => {
    if (extra.verified !== undefined && !holdsVerified(db, extra.verified)) throw new Error(BUDGET_UNVERIFIED);
    const row = db.prepare("SELECT state FROM budget_grants WHERE id = ?").get(id);
    if (!row || !from.includes(str(row["state"]) as GrantState)) return null;
    const authority = bump(db, at);
    if (extra.homeId !== undefined) db.prepare("UPDATE budget_grants SET state = ?, home_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(to, extra.homeId, authority.revision, at, id);
    else db.prepare("UPDATE budget_grants SET state = ?, revision = ?, updated_at = ? WHERE id = ?").run(to, authority.revision, at, id);
    return authority;
  });
}

/**
 * Marks a written grant dispatching, with the engine store that would record it, before the send begins. From here on
 * the call may have been sent, so the grant is never released. The caller records the returned revision in the guard,
 * and only then sends. Only on the ledger the guard last verified.
 */
export const markDispatching = (workspace: WorkspaceDb, id: string, homeId: string, now: number, verified: LedgerState | null): LedgerState | null =>
  move(workspace, id, ["written"], "dispatching", now, { homeId, verified });
/** The engine's store shows it accepted the grant. */
export const markAccepted = (workspace: WorkspaceDb, id: string, now: number): LedgerState | null => move(workspace, id, ["dispatching"], "accepted", now);
/**
 * Releases a grant the host never began sending, in a ledger that still holds the history the guard last verified, so
 * it wasn't rolled back. Nothing else is ever released without its engine's complete seal, and a grant written before
 * a lost history was replaced is uncertain, never written, so it can't be released either.
 */
export const releaseGrant = (workspace: WorkspaceDb, id: string, now: number, verified: LedgerState | null): LedgerState | null =>
  move(workspace, id, ["written"], "released", now, { verified });
/** No affirmative evidence of what was spent: the whole grant stays counted. */
export const markUncertain = (workspace: WorkspaceDb, id: string, now: number): LedgerState | null => move(workspace, id, ["dispatching", "accepted"], "uncertain", now);
/** The person's choice for an uncertain grant: counted in full as unknown spend from now on, never as zero. */
export const writeOff = (workspace: WorkspaceDb, id: string, now: number): LedgerState | null => move(workspace, id, ["uncertain"], "written-off", now);

/**
 * What the ledger counts for one journal row of a priced grant, worked out again rather than taken on the engine's word:
 * a reported or partial request at the grant's prices from its usage, which must match what the engine said; an
 * unknown one at the most the grant allows one request to its model, or more when the engine said more; and nothing
 * for a request never sent, a listing (whose charge the price list says is unknown) or a counted service. Null for an
 * unpriced grant: its money is unknown, never 0.
 */
function countedMicros(grant: GrantRecord, row: BudgetOperation): number | null | { refused: string } {
  if (grant.productiveMicros === null) return null;
  // A listing counts as nothing only because its grant was priced with a list on which listing is free, which a call
  // that reaches no model was never checked against: it lists nothing, so a journal saying it did doesn't add up.
  if (row.kind === "model-listing" && grant.grant.rates.length === 0) return { refused: "A journal row lists models under a grant for a call that reaches none." };
  if (row.state === "unsent" || row.kind !== "model-request") return 0;
  const rate = row.model === null ? undefined : grant.grant.rates.find((one) => one.model.toLowerCase() === row.model!.toLowerCase());
  if (!rate) return { refused: "A journal row names a model its grant doesn't cover." };
  if (row.state === "unknown") {
    const bound = requestBound(rate, Math.max(grant.grant.productive.outputTokens, grant.grant.finalisation.outputTokens));
    if (!bound) return { refused: "A journal row's model has no established bound in its grant." };
    return Math.max(bound.micros, row.boundMicros ?? 0, row.amountMicros ?? 0);
  }
  const priced = row.usage === null ? null : priceUsage(rate, row.usage);
  if (!priced || priced.certainty !== row.state || priced.micros !== row.amountMicros) return { refused: "A journal row's amount doesn't match its reported usage at the grant's prices." };
  return priced.micros;
}

/**
 * Records a grant's sealed journal, once. A complete seal settles the grant: its rows count, and the rest of the grant
 * is released. An interrupted seal records the rows it holds and leaves the grant uncertain, its remainder still
 * counted, since rows lost with a restored store can't be known. Each row of a priced grant is counted as the ledger
 * works it out (countedMicros), never on the engine's word alone, and a row that doesn't add up refuses the journal. A
 * journal recorded again comes back unchanged when it is the same, row for row, and is refused when anything differs.
 */
export function recordJournal(workspace: WorkspaceDb, id: string, rows: readonly BudgetOperation[], seal: JournalSeal, now: number): { state: GrantState; authority: LedgerState | null } | { refused: string } {
  const parsedSeal = JournalSeal.safeParse(seal);
  if (!parsedSeal.success || seal.grantId !== id) return { refused: "The journal's seal doesn't belong to this grant." };
  const parsed: BudgetOperation[] = [];
  for (const row of rows) {
    const one = BudgetOperation.safeParse(row);
    if (!one.success || one.data.grantId !== id) return { refused: "A journal row doesn't belong to this grant." };
    if (one.data.state === "reserved" || one.data.state === "sent") return { refused: "A sealed journal holds only closed rows." };
    parsed.push(one.data);
  }
  if (parsed.length !== seal.rows) return { refused: "The journal holds a different number of rows than its seal says." };
  parsed.sort((a, b) => a.seq - b.seq);
  if (parsed.some((one, index) => one.seq !== index + 1)) return { refused: "The journal's rows aren't numbered 1 to n." };
  const at = iso(now);
  return workspace.tx((db) => {
    const row = db.prepare("SELECT * FROM budget_grants WHERE id = ?").get(id);
    if (!row) return { refused: "There is no such grant." };
    const grant = grantOf(row);
    if (grant.sealKind !== null) {
      const kept = db.prepare("SELECT operation_json FROM budget_operations WHERE grant_id = ? ORDER BY seq").all(id).map((one) => str(one["operation_json"]));
      const same = grant.sealKind === seal.kind && kept.length === parsed.length && parsed.every((one, index) => JSON.stringify(one) === kept[index]);
      return same ? { state: grant.state, authority: null } : { refused: "This grant's journal was already recorded differently, so this one wasn't." };
    }
    if (!(["dispatching", "accepted", "uncertain"] as GrantState[]).includes(grant.state) || grant.homeId === null) return { refused: "This grant can't take a journal in its state." };
    const counted: (number | null)[] = [];
    for (const one of parsed) {
      const amount = countedMicros(grant, one);
      if (amount !== null && typeof amount === "object") return amount;
      counted.push(amount);
    }
    parsed.forEach((one, index) => {
      db.prepare("INSERT INTO budget_operations (id, grant_id, seq, kind, model, state, amount_micros, counted_micros, units, operation_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        one.id,
        id,
        one.seq,
        one.kind,
        one.model,
        one.state,
        one.amountMicros,
        counted[index]!,
        one.units,
        JSON.stringify(one),
        at,
      );
    });
    const recorded = grant.productiveMicros === null ? null : counted.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
    const authority = bump(db, at);
    const state: GrantState = seal.kind === "complete" ? "settled" : "uncertain";
    db.prepare("UPDATE budget_grants SET state = ?, seal_kind = ?, recorded_micros = ?, revision = ?, updated_at = ? WHERE id = ?").run(state, seal.kind, recorded, authority.revision, at, id);
    return { state, authority };
  });
}

// ---------------------------------------------------------------------------------------------------- recovery

/**
 * Starts a new budget history after a loss, as the person chose. The ledger takes a new id, at a revision past both its
 * own and the guard's last, so no copy of the lost history can later pass for this one; the loss is recorded with what
 * was lost and what the person said was left, money and counted services (null: wait for the month after); and every
 * grant still open becomes uncertain, since whether it was sent can't be known. The ledger's month stays as it is (a
 * ledger with none opens its first), and the restriction holds through the latest month the lost history established,
 * as its guard kept it, or the ledger's month when that is later. Never by the computer's clock, which may have moved
 * back or run behind the provider's: a history put back from an earlier month can't leave behind a month the lost one
 * reached, however that month is established again. (A guard record from before months were kept falls back to the
 * clocks those builds read.) Spend before the loss is unknown, never zero. The caller records the returned revision in
 * the guard, with the recovery cleared.
 */
export function startNewHistory(workspace: WorkspaceDb, input: { recovery: BudgetRecovery; remaining: BudgetRemaining | null; now: number; timezone: string }): LedgerState {
  const at = iso(input.now);
  return workspace.tx((db) => {
    const previous = ledgerStateIn(db);
    const ledgerId = randomUUID();
    const revision = Math.max(previous?.revision ?? 0, input.recovery.guard.revision) + 1;
    const chain = chainNext(previous?.chain ?? null, ledgerId, revision);
    const current = currentPeriodIn(db);
    const month = monthOf(input.now, input.timezone);
    const periodIdx = current?.index ?? month.index;
    // The recovery month: the latest month the lost history established, as its guard kept it, or the ledger's own. A
    // guard record from before months were kept (review builds only) names none: then, as those builds did, the latest
    // month this computer's clock or that record's time shows.
    const kept = input.recovery.guard.month === null ? Math.max(month.index, monthOf(Date.parse(input.recovery.guard.at), input.timezone).index) : monthIndex(input.recovery.guard.month);
    const throughIdx = Math.max(periodIdx, kept);
    db.prepare("INSERT INTO budget_adjustments (id, kind, ledger_id, period_idx, through_idx, reason, recovery_json, remaining_json, revision, created_at) VALUES (?, 'history-lost', ?, ?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(),
      ledgerId,
      periodIdx,
      throughIdx,
      input.recovery.reason,
      JSON.stringify(input.recovery),
      input.remaining === null ? null : JSON.stringify(input.remaining),
      revision,
      at,
    );
    if (previous) db.prepare("UPDATE budget_authority SET ledger_id = ?, revision = ?, chain = ?, created_at = ? WHERE singleton = 1").run(ledgerId, revision, chain, at);
    else db.prepare("INSERT INTO budget_authority (singleton, ledger_id, revision, chain, created_at) VALUES (1, ?, ?, ?, ?)").run(ledgerId, revision, chain, at);
    db.prepare("INSERT INTO budget_revisions (ledger_id, revision, chain, at) VALUES (?, ?, ?, ?)").run(ledgerId, revision, chain, at);
    if (!current) insertPeriod(db, month, input.timezone, "first", null, revision, at);
    db.prepare("UPDATE budget_grants SET state = 'uncertain', revision = ?, updated_at = ? WHERE state IN ('written', 'dispatching', 'accepted')").run(revision, at);
    // The loss this history answers, kept in the workspace when it was found, goes with it: answered, not cleared.
    db.prepare("DELETE FROM budget_pending_recovery").run();
    return { ledgerId, revision, chain };
  });
}

// ------------------------------------------------------------------------------------------------------- summary

/**
 * The current month as the ledger counts it. Every total comes from leaf grants and rows, so a council and its members
 * are never counted twice; unknown spend is counted at its bounds and named as unknown; and every reason the totals
 * can't be read as complete is listed. Money that couldn't be priced makes the money totals null rather than 0; a
 * month whose history was lost, or one whose history needs recovery, has no month-wide figures at all, only what was
 * admitted since a loss. `timezone` is the zone months count in when there is no policy.
 */
export function budgetSummary(workspace: WorkspaceDb, context: { now: number; catalogue: PriceCatalogue; recovery: BudgetRecovery | null; timezone: string }): BudgetSummary {
  const db = workspace.db;
  const policy = currentPolicyIn(db);
  const period = currentPeriodIn(db);
  const grants = period ? periodGrants(db, period.index) : [];
  const loss = period ? lossIn(db, period.index) : null;
  // The month-wide figures stand only for a history that is whole: none lost this month, and none needing recovery.
  const whole = loss === null && context.recovery === null;
  let settled = 0;
  let unknown = 0;
  let reserved = 0;
  let priced = true;
  let uncertain = false;
  const usage = noUsage();
  const lines = new Map<string, BudgetBreakdownLine & { usage: BudgetUsage }>();
  const add = (dimension: BudgetBreakdownLine["dimension"], key: string, counts: GrantCounts) => {
    const id = `${dimension}\u0000${key}`;
    const line = lines.get(id) ?? { dimension, key, settledMicros: 0, unknownMicros: 0, reservedMicros: 0, usage: noUsage() };
    if (counts.money === null || line.settledMicros === null || line.unknownMicros === null || line.reservedMicros === null) {
      line.settledMicros = line.unknownMicros = line.reservedMicros = null;
    } else {
      line.settledMicros += counts.money.settled;
      line.unknownMicros += counts.money.unknown;
      line.reservedMicros += counts.money.reserved;
    }
    addUsage(line.usage, counts.usage);
    lines.set(id, line);
  };
  for (const grant of grants) {
    const counts = countsOf(db, grant);
    if (counts.money === null) priced = false;
    else {
      settled += counts.money.settled;
      unknown += counts.money.unknown;
      reserved += counts.money.reserved;
    }
    addUsage(usage, counts.usage);
    uncertain ||= grant.state === "uncertain" || grant.state === "written-off";
    const rates = grant.grant.rates;
    add("feature", grant.attribution.feature, counts);
    add("project", grant.attribution.projectId ?? "none", counts);
    add("profile", grant.attribution.profile ? `${grant.attribution.profile.id}@${grant.attribution.profile.version}` : "none", counts);
    add("model", rates.length === 1 ? rates[0]!.model : rates.length === 0 ? "none" : "several", counts);
  }
  const breakdown = [...lines.values()];
  const counted = countedOf(db, grants);
  const gaps: BudgetGap[] = [];
  if (context.catalogue.models.some((rate) => currencyOf(context.catalogue, rate) === null)) gaps.push("currency-unconfirmed");
  if (context.catalogue.models.some((rate) => rate.bounds === null)) gaps.push("bounds-unestablished");
  if (!priced) gaps.push("unpriced-usage");
  if (uncertain) gaps.push("uncertain-grants");
  if (context.catalogue.listings !== "free") gaps.push("listings-unpriced");
  if (context.now - Date.parse(`${context.catalogue.retrievedOn}T00:00:00Z`) > 30 * 24 * 60 * 60 * 1000) gaps.push("stale-catalogue");
  if (loss) gaps.push("history-lost");
  if (context.recovery) gaps.push("needs-recovery");
  if (whole && breakdown.length > 400) gaps.push("breakdown-cut");
  if (counted.sandboxOperations > 0 || counted.sandboxSeconds > 0 || counted.researchCredits > 0) gaps.push("services-unpriced");
  const known = priced && whole;
  const pool = policy?.monthlyMicros ?? null;
  const committed = settled + unknown + reserved;
  // What a new grant could take: the pool less this month's spend, and after a loss no more than what is left of what
  // the person said then. Spend that couldn't be priced leaves it unknown, except from before a loss; so does a history
  // that needs recovery.
  const covered = coveredBy(loss);
  const after = loss ? grantsSince(db, loss) : [];
  const since = loss ? moneyOf(db, after) : null;
  const caps: (number | null)[] = [];
  if (policy && policy.monthlyMicros !== null) {
    const used = moneyOf(db, grants, covered);
    caps.push(used === null ? null : policy.monthlyMicros - used);
  }
  if (loss) caps.push(loss.remaining === null ? 0 : since === null ? null : loss.remaining.micros - since);
  const available = context.recovery !== null || caps.length === 0 || caps.includes(null) ? null : Math.min(...(caps as number[]));
  return {
    policy,
    period,
    recovery: context.recovery,
    poolMicros: pool,
    settledMicros: known ? settled : null,
    unknownMicros: known ? unknown : null,
    reservedMicros: known ? reserved : null,
    availableMicros: available,
    usage: whole ? usage : null,
    counted: { used: whole ? counted : null, allowed: policy?.allowances ?? null },
    gaps,
    thresholdsCrossed: !known || pool === null || pool === 0 ? [] : (policy?.thresholds ?? []).filter((threshold) => committed * 100 >= threshold * pool),
    breakdown: whole ? breakdown.slice(0, 400) : [],
    afterLoss: loss === null ? null : { at: loss.createdAt, through: monthLabel(loss.throughIndex), remaining: loss.remaining, since: { micros: since, counted: countedOf(db, after) } },
    clock: { computerMonth: monthOf(context.now, policy?.timezone ?? context.timezone).label, jumps: jumpsSince(db, period?.openedAt ?? null) },
  };
}


/** Every sent or uncertain inference counts independently of whether its price or token usage is known. */
function requestsHeld(db: DatabaseSync, grants: readonly GrantRecord[]): number {
  return grants.reduce((sum, grant) => {
    if (grant.state === "released") return sum;
    const sent = db.prepare("SELECT count(*) AS n FROM budget_operations WHERE grant_id = ? AND kind = 'model-request' AND state <> 'unsent'").get(grant.id);
    const actual = num(sent?.["n"]);
    const reserve = grant.grant.productive.requests + grant.grant.finalisation.requests;
    return sum + (grant.state === "settled" ? actual : Math.max(reserve, actual));
  }, 0);
}

function requestTotals(db: DatabaseSync, grants: readonly GrantRecord[]) {
  const active = grants.filter((grant) => OPEN_STATES.includes(grant.state));
  const final = grants.filter((grant) => !OPEN_STATES.includes(grant.state));
  const used = requestsHeld(db, final);
  const reserved = requestsHeld(db, active);
  let unknown = 0, inputTokens = 0, outputTokens = 0, unknownTokens = reserved;
  for (const grant of final) {
    const rows = db.prepare("SELECT operation_json FROM budget_operations WHERE grant_id = ? AND kind = 'model-request' AND state <> 'unsent'").all(grant.id).map((row) => BudgetOperation.parse(JSON.parse(str(row["operation_json"]))));
    let completeTokens = 0, incompleteTokens = 0, unknownRows = 0;
    for (const operation of rows) {
      const usage = operation.usage;
      inputTokens += usage?.inputTokens ?? 0;
      outputTokens += usage?.outputTokens ?? 0;
      if (!usage || usage.inputTokens === null || usage.outputTokens === null) incompleteTokens++;
      else completeTokens++;
      if (operation.state === "unknown" && !usage) unknownRows++;
    }
    const unresolved = grant.state === "uncertain" || grant.state === "written-off";
    const bound = grant.grant.productive.requests + grant.grant.finalisation.requests;
    unknown += unresolved ? Math.max(bound, rows.length) : unknownRows;
    unknownTokens += unresolved ? Math.max(Math.max(bound, rows.length) - completeTokens, incompleteTokens) : incompleteTokens;
  }
  return { used, reserved, unknown, reportedInputTokens: inputTokens, reportedOutputTokens: outputTokens, unknownTokens };
}

/** New policy only: no old serialised policy, grant, period or recovery record is rewritten. */
export function sharedRequestLimitDraft(previous: BudgetPolicy | null): BudgetPolicyDraft | null {
  const limit = previous?.modelRequestLimits?.[0];
  if (!previous || !limit || "pool" in limit) return null;
  const { version: _version, replaces: _replaces, createdAt: _createdAt, ...draft } = previous;
  return { ...draft, modelRequestLimits: [{ pool: "companion-and-planning", monthlyRequests: limit.monthlyRequests }] };
}

/** Combined inference coverage only. Feature rows partition these totals; they never add a second reservation. */
export function companionRequestUsage(workspace: WorkspaceDb) {
  const db = workspace.db;
  const period = currentPeriodIn(db);
  const allGrants = period ? periodGrants(db, period.index).filter((grant) => requestPoolCovers(grant.attribution.feature)) : [];
  const loss = period ? lossIn(db, period.index) : null;
  const grants = loss ? grantsSince(db, loss).filter((grant) => requestPoolCovers(grant.attribution.feature)) : allGrants;
  const totals = requestTotals(db, grants);
  const limit = modelRequestPoolLimit(currentPolicyIn(db)?.modelRequestLimits);
  let remaining = limit === null ? null : Math.max(0, limit - requestsHeld(db, allGrants));
  let historyBlocked: string | null = null;
  if (loss) {
    if (loss.remaining?.mode === "counts") {
      const allowed = modelRequestPoolLimit(loss.remaining.modelRequestLimits) ?? 0;
      const recovered = Math.max(0, allowed - requestsHeld(db, grants));
      remaining = remaining === null ? recovered : Math.min(remaining, recovered);
    } else {
      historyBlocked = loss.remaining === null ? "Budget history was lost and new spending waits for the next confirmed month. Manual planning remains available." : "The recovery allowance is in money and Companion and planning requests cannot be priced within it. Restore the history or choose an explicit request-count recovery allowance.";
      remaining = null;
    }
  }
  return { month: period?.label ?? "Not started", limit, ...totals, remaining, historyComplete: !loss, historyBlocked, inputTokens: totals.unknownTokens || loss ? null : totals.reportedInputTokens, outputTokens: totals.unknownTokens || loss ? null : totals.reportedOutputTokens, features: { companion: requestTotals(db, grants.filter((grant) => grant.attribution.feature === "companion")), planning: requestTotals(db, grants.filter((grant) => grant.attribution.feature === "planning")) } };
}
