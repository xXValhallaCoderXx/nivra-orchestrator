import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BudgetOperation,
  BudgetPolicy,
  dayOf,
  JournalSeal,
  monthOf,
  rateFor,
  requestBound,
  type BudgetAllowances,
  type BudgetAttribution,
  type BudgetBreakdownLine,
  type BudgetGap,
  type BudgetGrant,
  type BudgetMonth,
  type BudgetPeriod,
  type BudgetPolicyDraft,
  type BudgetRecovery,
  type BudgetRecoveryReason,
  type BudgetSummary,
  type GrantRequest,
  type GrantState,
  type ModelRate,
  type PeriodOpenedBy,
  type PriceCatalogue,
} from "@nivra/domain";
import { num, str, strOrNull, type Row, type WorkspaceDb } from "./workspace-db.ts";

/**
 * The shared monthly budget's ledger (NIV-66), in the workspace (its eighth migration). The host is its one authority:
 * engines get finite grants and never see the pool. Every function here is synchronous, so a grant's availability is
 * checked and its row written in one transaction, and two features asking for the last of the allowance can't both be
 * admitted.
 *
 * Every change to spending authority moves the ledger's authority revision forward in the same transaction. The caller
 * records that revision in the guard (budget-guard.ts) before anything that depends on it is sent, so a ledger that is
 * later replaced or put back, even with the same number of grants, is caught at the next start.
 *
 * A grant's unused remainder comes back only on affirmative evidence: it never left `written`, or its engine's
 * complete seal says what was spent. A journal sealed after an interruption settles the rows it holds and keeps the
 * rest counted. Nothing here ever turns unknown usage into zero, and age never settles a grant.
 */

export interface LedgerState {
  ledgerId: string;
  revision: number;
}

/** A grant as the ledger keeps it. */
export interface GrantRecord {
  id: string;
  requestId: string;
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
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Why a grant was refused, in Nivra's own words: each says what happened and what to do. */
export interface GrantRefusal {
  code: "no-price" | "unestablished" | "pool" | "sublimit" | "counted" | "history-wait" | "duplicate-need" | "closed";
  message: string;
}

const OPEN_STATES = ["written", "dispatching", "accepted"] as const;
const iso = (at: number) => new Date(at).toISOString();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const dollars = (micros: number) => `${(micros / 1_000_000).toFixed(2)}`;

/** The ledger's id and authority revision, or null before its first change. */
export function ledgerState(workspace: WorkspaceDb): LedgerState | null {
  return ledgerStateIn(workspace.db);
}

function ledgerStateIn(db: DatabaseSync): LedgerState | null {
  const row = db.prepare("SELECT ledger_id, revision FROM budget_authority WHERE singleton = 1").get();
  return row ? { ledgerId: str(row["ledger_id"]), revision: num(row["revision"]) } : null;
}

/** Moves the authority revision forward, inside the caller's transaction, writing the ledger's id with its first change. */
function bump(db: DatabaseSync, at: string): LedgerState {
  const current = ledgerStateIn(db);
  if (!current) {
    const ledgerId = randomUUID();
    db.prepare("INSERT INTO budget_authority (singleton, ledger_id, revision, created_at) VALUES (1, ?, 1, ?)").run(ledgerId, at);
    return { ledgerId, revision: 1 };
  }
  const revision = current.revision + 1;
  db.prepare("UPDATE budget_authority SET revision = ? WHERE singleton = 1").run(revision);
  return { ledgerId: current.ledgerId, revision };
}

/** The latest time the ledger recorded anything, for telling a clock that moved back across a restart. */
export function latestLedgerTime(workspace: WorkspaceDb): number | null {
  const row = workspace.db
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

function currentPolicyIn(db: DatabaseSync): BudgetPolicy | null {
  const row = db.prepare("SELECT policy_json FROM budget_policies ORDER BY version DESC LIMIT 1").get();
  return row ? BudgetPolicy.parse(JSON.parse(str(row["policy_json"]))) : null;
}

/**
 * Saves the person's choice as the next policy version. What was spent, reserved or left uncertain stays as it was: a
 * new version changes what is admitted from now on, never the history. The ledger's first month opens with its first
 * policy or grant.
 */
export function setPolicy(workspace: WorkspaceDb, draft: BudgetPolicyDraft, now: number): { policy: BudgetPolicy; authority: LedgerState } {
  const at = iso(now);
  return workspace.tx((db) => {
    const latest = db.prepare("SELECT version FROM budget_policies ORDER BY version DESC LIMIT 1").get();
    const version = latest ? num(latest["version"]) + 1 : 1;
    const policy = BudgetPolicy.parse({ ...draft, version, replaces: latest ? version - 1 : null, createdAt: at });
    const authority = bump(db, at);
    db.prepare("INSERT INTO budget_policies (version, policy_json, replaces, revision, created_at) VALUES (?, ?, ?, ?, ?)").run(version, JSON.stringify(policy), policy.replaces, authority.revision, at);
    ensureFirstPeriod(db, now, policy.timezone, authority.revision, at);
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
 * The person confirms that a new month has begun, by the computer's clock, which alone would open nothing. Refused when
 * the computer's clock is still in the current month, or behind it.
 */
export function confirmMonth(workspace: WorkspaceDb, now: number, timezone: string): { opened: BudgetPeriod; authority: LedgerState } | { refused: "not-later" } {
  const at = iso(now);
  return workspace.tx((db) => {
    const current = currentPeriodIn(db);
    const month = monthOf(now, timezone);
    if (current && month.index <= current.index) return { refused: "not-later" as const };
    const authority = bump(db, at);
    const opened = current ? insertPeriod(db, month, timezone, "confirmed", { by: "person", wallAt: at }, authority.revision, at) : insertPeriod(db, month, timezone, "first", null, authority.revision, at);
    return { opened, authority };
  });
}

/** Records a jump of the computer's clock, as seen by the host. A jump opens no month and changes no allowance. */
export function recordClockJump(workspace: WorkspaceDb, kind: "jump-forward" | "jump-back", now: number, deltaMs: number): void {
  const at = iso(now);
  workspace.db.prepare("INSERT INTO budget_clock (kind, wall_at, delta_ms, recorded_at) VALUES (?, ?, ?, ?)").run(kind, at, Math.round(deltaMs), at);
}

// ----------------------------------------------------------------------------------------------------------- grants

const grantOf = (row: Row): GrantRecord => ({
  id: str(row["id"]),
  requestId: str(row["request_id"]),
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

/** What a grant counts against the pool: its full amount while open or uncertain, what its rows say once settled. */
interface GrantCounts {
  settled: number;
  unknown: number;
  reserved: number;
  unpriced: boolean;
}

function countsOf(db: DatabaseSync, grant: GrantRecord): GrantCounts {
  const full = grant.productiveMicros === null ? null : grant.productiveMicros + (grant.finalisationMicros ?? 0);
  if (grant.state === "released") return { settled: 0, unknown: 0, reserved: 0, unpriced: false };
  if ((OPEN_STATES as readonly string[]).includes(grant.state)) return { settled: 0, unknown: 0, reserved: full ?? 0, unpriced: full === null };
  const rows = db.prepare("SELECT state, amount_micros FROM budget_operations WHERE grant_id = ?").all(grant.id);
  let reported = 0;
  let unknownRows = 0;
  let unpricedRows = false;
  for (const row of rows) {
    const amount = row["amount_micros"] === null ? null : num(row["amount_micros"]);
    const state = str(row["state"]);
    if (state === "unsent") continue;
    if (amount === null) unpricedRows = true;
    else if (state === "unknown") unknownRows += amount;
    else reported += amount;
  }
  if (grant.state === "settled") return { settled: reported, unknown: unknownRows, reserved: 0, unpriced: unpricedRows || full === null };
  // Uncertain or written off: the whole grant stays counted, or what its rows reported when that is more.
  const total = Math.max(full ?? 0, reported + unknownRows);
  return { settled: reported, unknown: total - reported, reserved: 0, unpriced: unpricedRows || full === null };
}

function periodGrants(db: DatabaseSync, periodIndex: number): GrantRecord[] {
  return db.prepare("SELECT * FROM budget_grants WHERE period_idx = ? ORDER BY created_at, rowid").all(periodIndex).map(grantOf);
}

const spent = (counts: GrantCounts) => counts.settled + counts.unknown + counts.reserved;

/** What the grants in `grants` count in all, money only. */
function totalOf(db: DatabaseSync, grants: readonly GrantRecord[]): number {
  return grants.reduce((sum, grant) => sum + spent(countsOf(db, grant)), 0);
}

/** The counted services a period's grants use: open and uncertain grants in full, settled ones as their rows reported. */
function countedOf(db: DatabaseSync, grants: readonly GrantRecord[]): BudgetAllowances {
  const used = { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 };
  for (const grant of grants) {
    if (grant.state === "released") continue;
    if (grant.state !== "settled") {
      used.sandboxOperations += grant.grant.allowances.sandboxOperations;
      used.sandboxSeconds += grant.grant.allowances.sandboxSeconds;
      used.researchCredits += grant.grant.allowances.researchCredits;
      continue;
    }
    for (const row of db.prepare("SELECT kind, state, units FROM budget_operations WHERE grant_id = ?").all(grant.id)) {
      if (str(row["state"]) === "unsent") continue;
      const kind = str(row["kind"]);
      const units = row["units"] === null ? 0 : num(row["units"]);
      if (kind === "sandbox-operation") {
        used.sandboxOperations += 1;
        used.sandboxSeconds += units;
      } else if (kind === "research-search" || kind === "research-extract") used.researchCredits += units;
    }
  }
  return used;
}

function historyLostIn(db: DatabaseSync, periodIndex: number): { remainingMicros: number | null; createdAt: string } | null {
  const row = db.prepare("SELECT remaining_micros, created_at FROM budget_adjustments WHERE kind = 'history-lost' AND period_idx = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(periodIndex);
  return row ? { remainingMicros: row["remaining_micros"] === null ? null : num(row["remaining_micros"]), createdAt: str(row["created_at"]) } : null;
}

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
 * Writes a grant for one spendable call, before anything is sent, or refuses it. Under a money policy, every model the
 * call may use must have its bounds established, and the price list its currency; the grant must fit the pool, every
 * sublimit that applies, and the counted services. Without a policy nothing limits it, but it is still written,
 * priced where it can be, and counted. An extension answers one need once: asked again, the same grant comes back.
 */
export function writeGrant(
  workspace: WorkspaceDb,
  request: GrantRequest,
  context: { now: number; catalogue: PriceCatalogue; timezone: string },
): { grant: BudgetGrant; authority: LedgerState | null } | { refused: GrantRefusal } {
  try {
    return writeGrantOnce(workspace, request, context);
  } catch (error) {
    if (error instanceof RefusedAfterOpening) return { refused: error.refusal };
    throw error;
  }
}

function writeGrantOnce(
  workspace: WorkspaceDb,
  request: GrantRequest,
  context: { now: number; catalogue: PriceCatalogue; timezone: string },
): { grant: BudgetGrant; authority: LedgerState | null } | { refused: GrantRefusal } {
  const at = iso(context.now);
  return workspace.tx((db) => {
    if (request.extends !== null) {
      const existing = db.prepare("SELECT * FROM budget_grants WHERE extends_id = ? AND need = ?").get(request.extends, request.need);
      if (existing) {
        const record = grantOf(existing);
        if (record.requestId === request.requestId && record.grant.productive.requests === request.productive.requests && record.grant.productive.outputTokens === request.productive.outputTokens) return { grant: record.grant, authority: null };
        return { refused: { code: "duplicate-need" as const, message: "That need was already answered with a different grant, so this one wasn't written. Ask for the next need instead." } };
      }
      const first = db.prepare("SELECT state, request_id FROM budget_grants WHERE id = ?").get(request.extends);
      if (!first || str(first["request_id"]) !== request.requestId || !["dispatching", "accepted"].includes(str(first["state"]))) {
        return { refused: { code: "closed" as const, message: "The work this extension was asked for has ended or can't be found, so nothing more was granted." } };
      }
    }
    const policy = currentPolicyIn(db);
    registerCatalogueIn(db, context.catalogue, at);
    const rates: ModelRate[] = [];
    for (const model of request.models) {
      const rate = rateFor(context.catalogue, model);
      if (!rate) return { refused: { code: "no-price" as const, message: `Nivra has no price for ${model}, so it can't count it against your budget. Choose a model on Nivra's price list.` } };
      rates.push(rate);
    }
    const established = context.catalogue.currency !== null;
    const productiveBound = request.models.length === 0 ? 0 : boundAcross(rates, request.productive.outputTokens);
    const finalisationBound = request.models.length === 0 ? 0 : boundAcross(rates, request.finalisation.outputTokens);
    const priced = established && productiveBound !== null && finalisationBound !== null;
    if (policy && !priced) {
      return { refused: { code: "unestablished" as const, message: "Your monthly budget is set in dollars, but Nivra hasn't established this model's price limits or its price list's currency yet, so it can't keep the call within your budget. Remove the monthly budget to use today's fixed allowances, or wait for Nivra to establish them." } };
    }
    const productiveMicros = priced ? request.productive.requests * productiveBound! : null;
    const finalisationMicros = priced ? request.finalisation.requests * finalisationBound! : null;
    const timezone = policy?.timezone ?? context.timezone;
    const writtenFirst = currentPeriodIn(db) === null;
    const period = ensureFirstPeriod(db, context.now, timezone, (ledgerStateIn(db)?.revision ?? 0) + 1, at);
    if (policy) {
      const refusal = admission(db, policy, period, request, (productiveMicros ?? 0) + (finalisationMicros ?? 0), context.now);
      if (refusal) {
        if (writtenFirst) throw new RefusedAfterOpening(refusal);
        return { refused: refusal };
      }
    }
    const authority = bump(db, at);
    const id = randomUUID();
    const grant: BudgetGrant = {
      id,
      requestId: request.requestId,
      catalogueVersion: context.catalogue.version,
      rates,
      productiveMicros,
      finalisationMicros,
      productive: request.productive,
      finalisation: request.finalisation,
      allowances: request.allowances,
    };
    db.prepare(
      `INSERT INTO budget_grants (id, request_id, workflow, target_id, period_idx, policy_version, catalogue_version, grant_json, attribution_json, feature, project_id, attempt_id, queue_id,
        profile_id, model, productive_micros, finalisation_micros, extends_id, need, state, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'written', ?, ?, ?)`,
    ).run(
      id,
      request.requestId,
      request.workflow,
      request.targetId,
      period.index,
      policy?.version ?? null,
      context.catalogue.version,
      JSON.stringify(grant),
      JSON.stringify(request.attribution),
      request.attribution.feature,
      request.attribution.projectId,
      request.attribution.attemptId,
      request.attribution.queueId,
      request.attribution.profile?.id ?? null,
      request.models[0] ?? null,
      productiveMicros,
      finalisationMicros,
      request.extends,
      request.need,
      authority.revision,
      at,
      at,
    );
    return { grant, authority };
  });
}

/** A refusal found after the ledger's first month was opened in the same transaction: thrown, so nothing is kept. */
class RefusedAfterOpening extends Error {
  readonly refusal: GrantRefusal;
  constructor(refusal: GrantRefusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

/** Whether `need` more fits the pool, every sublimit that applies, and the counted services. Null when it does. */
function admission(db: DatabaseSync, policy: BudgetPolicy, period: BudgetPeriod, request: GrantRequest, need: number, now: number): GrantRefusal | null {
  const grants = periodGrants(db, period.index);
  const lost = historyLostIn(db, period.index);
  if (lost) {
    if (lost.remainingMicros === null) return { code: "history-wait", message: "Nivra lost this month's budget history, and you chose to wait for next month, so nothing more is admitted until then. Set this month's remaining allowance to continue now." };
    const since = totalOf(db, grants.filter((grant) => grant.createdAt >= lost.createdAt));
    if (since + need > lost.remainingMicros) return { code: "pool", message: `This would go past the allowance you set after Nivra lost this month's history (${dollars(lost.remainingMicros)} dollars). Raise it, or wait for next month.` };
  }
  const used = totalOf(db, grants);
  if (used + need > policy.monthlyMicros) {
    return { code: "pool", message: `This would go past your monthly budget of ${dollars(policy.monthlyMicros)} dollars: ${dollars(used)} is already spent or reserved this month. Raise your budget, or wait for next month.` };
  }
  const sublimits = policy.sublimits;
  const check = (limit: number | null, scope: readonly GrantRecord[], name: string): GrantRefusal | null =>
    limit !== null && totalOf(db, scope) + need > limit ? { code: "sublimit", message: `This would go past the ${name} limit of ${dollars(limit)} dollars in your budget. Raise that limit, or wait for it to free up.` } : null;
  const day = dayOf(now, policy.timezone);
  const refusals = [
    check(sublimits.dailyMicros, grants.filter((grant) => Date.parse(grant.createdAt) >= day.startsAt && Date.parse(grant.createdAt) < day.endsAt), "daily"),
    request.attribution.attemptId === null ? null : check(sublimits.perTaskMicros, grants.filter((grant) => grant.attribution.attemptId === request.attribution.attemptId), "per-task"),
    request.attribution.queueId === null ? null : check(sublimits.perQueueMicros, grants.filter((grant) => grant.attribution.queueId === request.attribution.queueId), "per-queue"),
    ...sublimits.projects.filter((limit) => limit.projectId === request.attribution.projectId).map((limit) => check(limit.monthlyMicros, grants.filter((grant) => grant.attribution.projectId === limit.projectId), "project")),
    ...sublimits.profiles.filter((limit) => limit.profileId === request.attribution.profile?.id).map((limit) => check(limit.monthlyMicros, grants.filter((grant) => grant.attribution.profile?.id === limit.profileId), "agent")),
  ];
  const refused = refusals.find((refusal) => refusal !== null);
  if (refused) return refused;
  const counted = countedOf(db, grants);
  const allowed = policy.allowances;
  if (
    counted.sandboxOperations + request.allowances.sandboxOperations > allowed.sandboxOperations ||
    counted.sandboxSeconds + request.allowances.sandboxSeconds > allowed.sandboxSeconds ||
    counted.researchCredits + request.allowances.researchCredits > allowed.researchCredits
  ) {
    return { code: "counted", message: "This would go past this month's allowance of sandbox operations, sandbox time or research credits in your budget. Raise it, or wait for next month." };
  }
  return null;
}

/** Moves a grant from one state to the next, bumping the revision; false when it isn't in a state it can move from. */
function move(workspace: WorkspaceDb, id: string, from: readonly GrantState[], to: GrantState, now: number, extra: { homeId?: string } = {}): LedgerState | null {
  const at = iso(now);
  return workspace.tx((db) => {
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
 * and only then sends.
 */
export const markDispatching = (workspace: WorkspaceDb, id: string, homeId: string, now: number): LedgerState | null => move(workspace, id, ["written"], "dispatching", now, { homeId });
/** The engine's store shows it accepted the grant. */
export const markAccepted = (workspace: WorkspaceDb, id: string, now: number): LedgerState | null => move(workspace, id, ["dispatching"], "accepted", now);
/** Releases a grant the host never began sending. Nothing else is ever released without its engine's complete seal. */
export const releaseGrant = (workspace: WorkspaceDb, id: string, now: number): LedgerState | null => move(workspace, id, ["written"], "released", now);
/** No affirmative evidence of what was spent: the whole grant stays counted. */
export const markUncertain = (workspace: WorkspaceDb, id: string, now: number): LedgerState | null => move(workspace, id, ["dispatching", "accepted"], "uncertain", now);
/** The person's choice for an uncertain grant: counted in full as unknown spend from now on, never as zero. */
export const writeOff = (workspace: WorkspaceDb, id: string, now: number): LedgerState | null => move(workspace, id, ["uncertain"], "written-off", now);

/**
 * Records a grant's sealed journal, once. A complete seal settles the grant: its rows' amounts count, and the rest of
 * the grant is released. An interrupted seal records the rows it holds and leaves the grant uncertain, its remainder
 * still counted, since rows lost with a restored store can't be known. A journal recorded again comes back unchanged
 * when it is the same, row for row, and is refused when anything differs.
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
    if (!(["dispatching", "accepted", "uncertain"] as GrantState[]).includes(grant.state)) return { refused: "This grant can't take a journal in its state." };
    let recorded: number | null = grant.productiveMicros === null ? null : 0;
    for (const one of parsed) {
      db.prepare("INSERT INTO budget_operations (id, grant_id, seq, kind, model, state, amount_micros, units, operation_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        one.id,
        id,
        one.seq,
        one.kind,
        one.model,
        one.state,
        one.amountMicros,
        one.units,
        JSON.stringify(one),
        at,
      );
      if (recorded !== null && one.state !== "unsent" && one.amountMicros !== null) recorded += one.amountMicros;
    }
    const authority = bump(db, at);
    const state: GrantState = seal.kind === "complete" ? "settled" : "uncertain";
    db.prepare("UPDATE budget_grants SET state = ?, seal_kind = ?, recorded_micros = ?, revision = ?, updated_at = ? WHERE id = ?").run(state, seal.kind, recorded, authority.revision, at, id);
    return { state, authority };
  });
}

// ---------------------------------------------------------------------------------------------------- recovery

/**
 * Starts a new budget history after a loss, as the person chose: the ledger (created when there is none) records the
 * loss and the allowance they set for the rest of the month, or null to wait for the next. Spend before it is unknown,
 * never zero. The caller records the returned revision in the guard, with the recovery cleared.
 */
export function startNewHistory(workspace: WorkspaceDb, input: { reason: BudgetRecoveryReason; remainingMicros: number | null; now: number; timezone: string }): LedgerState {
  const at = iso(input.now);
  return workspace.tx((db) => {
    const authority = bump(db, at);
    const current = currentPeriodIn(db);
    const month = monthOf(input.now, input.timezone);
    const period = current === null ? insertPeriod(db, month, input.timezone, "first", null, authority.revision, at) : month.index > current.index ? insertPeriod(db, month, input.timezone, "confirmed", { by: "person", wallAt: at, after: "history-lost" }, authority.revision, at) : current;
    db.prepare("INSERT INTO budget_adjustments (id, kind, period_idx, reason, remaining_micros, revision, created_at) VALUES (?, 'history-lost', ?, ?, ?, ?, ?)").run(randomUUID(), period.index, input.reason, input.remainingMicros, authority.revision, at);
    return authority;
  });
}

// ------------------------------------------------------------------------------------------------------- summary

/**
 * The current month as the ledger counts it. Every total comes from leaf grants and rows, so a council and its members
 * are never counted twice; unknown spend is counted at its bounds and named as unknown; and every reason the totals
 * can't be read as complete is listed.
 */
export function budgetSummary(workspace: WorkspaceDb, context: { now: number; catalogue: PriceCatalogue; recovery: BudgetRecovery | null }): BudgetSummary {
  const db = workspace.db;
  const policy = currentPolicyIn(db);
  const period = currentPeriodIn(db);
  const grants = period ? periodGrants(db, period.index) : [];
  let settled = 0;
  let unknown = 0;
  let reserved = 0;
  let unpriced = false;
  let uncertain = false;
  const lines = new Map<string, BudgetBreakdownLine>();
  const add = (dimension: BudgetBreakdownLine["dimension"], key: string, counts: GrantCounts) => {
    const id = `${dimension}\u0000${key}`;
    const line = lines.get(id) ?? { dimension, key, settledMicros: 0, unknownMicros: 0, reservedMicros: 0 };
    line.settledMicros += counts.settled;
    line.unknownMicros += counts.unknown;
    line.reservedMicros += counts.reserved;
    lines.set(id, line);
  };
  for (const grant of grants) {
    const counts = countsOf(db, grant);
    settled += counts.settled;
    unknown += counts.unknown;
    reserved += counts.reserved;
    unpriced ||= counts.unpriced && grant.state !== "released";
    uncertain ||= grant.state === "uncertain" || grant.state === "written-off";
    add("feature", grant.attribution.feature, counts);
    add("project", grant.attribution.projectId ?? "none", counts);
    add("profile", grant.attribution.profile ? `${grant.attribution.profile.id}@${grant.attribution.profile.version}` : "none", counts);
    add("model", grant.grant.rates[0]?.model ?? "none", counts);
  }
  const gaps: BudgetGap[] = [];
  if (context.catalogue.currency === null) gaps.push("currency-unconfirmed");
  if (context.catalogue.models.some((rate) => rate.bounds === null)) gaps.push("bounds-unestablished");
  if (unpriced) gaps.push("unpriced-usage");
  if (uncertain) gaps.push("uncertain-grants");
  if (context.catalogue.listings === "unknown") gaps.push("listings-unpriced");
  if (context.now - Date.parse(`${context.catalogue.retrievedOn}T00:00:00Z`) > 30 * 24 * 60 * 60 * 1000) gaps.push("stale-catalogue");
  if (period && historyLostIn(db, period.index)) gaps.push("history-lost");
  const pool = policy?.monthlyMicros ?? null;
  const committed = settled + unknown + reserved;
  return {
    policy,
    period,
    recovery: context.recovery,
    poolMicros: pool,
    settledMicros: settled,
    unknownMicros: unknown,
    reservedMicros: reserved,
    availableMicros: pool === null ? null : pool - committed,
    counted: { used: countedOf(db, grants), allowed: policy?.allowances ?? null },
    gaps,
    thresholdsCrossed: pool === null || pool === 0 ? [] : (policy?.thresholds ?? []).filter((threshold) => committed * 100 >= threshold * pool),
    breakdown: [...lines.values()].slice(0, 400),
  };
}
