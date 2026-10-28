import { z } from "zod";

/**
 * The shared monthly budget (NIV-66): one pool for every paid activity this installation sends to Token Factory, Tavily
 * and Nebius Sandboxes, kept by one authority, the host, in its own workspace (D7). Engines never see the pool. Each
 * spendable call gets a finite grant, written before it is sent, and the engine that runs it journals every paid
 * operation inside that grant and seals the journal when the grant's work ends.
 *
 * What it is: an admission policy for spend made through this installation. What it isn't: a cap on a provider's
 * invoice. Other installations or apps using the same key, charges Nivra never sees (Nebius storage and retention among
 * them) and taxes are outside it, and the summary says so.
 *
 * Money is integer micro-units of the price list's currency, never a float. A price list's currency, and each model's
 * input and output bounds, count only once they are established from a supported source (the provider's documentation
 * or a written answer from it); until then a model gets no grant under a money policy, and nothing is called a ceiling.
 * Unknown usage is counted at its reserved bound and shown as unknown, never as zero.
 */

const count = z.number().int().nonnegative();
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** One millionth of the price list's currency unit. */
export const MICROS_PER_UNIT = 1_000_000;
/** An amount of money in micro-units: an integer, never negative. */
export const Micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type Micros = z.infer<typeof Micros>;

/** The only currency a policy can be set in, for now. A price list in another one is never read as dollars. */
export const BudgetCurrency = z.literal("USD");
export type BudgetCurrency = z.infer<typeof BudgetCurrency>;

/** Starting points for a monthly amount. Each is a budget setting with the same features, not a subscription or a quota. */
export const BUDGET_PRESETS = Object.freeze({
  explore: { label: "Explore", monthlyMicros: 25 * MICROS_PER_UNIT },
  build: { label: "Build", monthlyMicros: 100 * MICROS_PER_UNIT },
  intensive: { label: "Intensive", monthlyMicros: 300 * MICROS_PER_UNIT },
});
export const BudgetPreset = z.enum(["explore", "build", "intensive", "custom"]);
export type BudgetPreset = z.infer<typeof BudgetPreset>;

/** Whether `name` is a time zone this runtime knows, such as `Asia/Singapore` or `UTC`. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
const TimeZone = z.string().min(1).max(64).refine(isTimeZone, "A time zone is a name such as Asia/Singapore or UTC.");

/** Limits inside the pool. Each only constrains it, and none adds money to it. Null means none. */
export const BudgetSublimits = z.strictObject({
  dailyMicros: Micros.nullable(),
  /** Every queue's own limit within the pool. */
  perQueueMicros: Micros.nullable(),
  /** Every task attempt's own limit within the pool. */
  perTaskMicros: Micros.nullable(),
  projects: z.array(z.strictObject({ projectId: z.uuid(), monthlyMicros: Micros })).max(100),
  profiles: z.array(z.strictObject({ profileId: z.string().min(1).max(80), monthlyMicros: Micros })).max(50),
});
export type BudgetSublimits = z.infer<typeof BudgetSublimits>;
export const NO_SUBLIMITS: BudgetSublimits = Object.freeze({ dailyMicros: null, perQueueMicros: null, perTaskMicros: null, projects: [], profiles: [] });

/**
 * Services counted rather than priced, a month at a time: Nebius operations and their seconds, whose raw cost has no
 * documented unit, and Tavily credits, whose price depends on the person's own Tavily plan.
 */
export const BudgetAllowances = z.strictObject({
  sandboxOperations: count,
  sandboxSeconds: count,
  researchCredits: count,
});
export type BudgetAllowances = z.infer<typeof BudgetAllowances>;

/** What the person chooses. Choosing one never enables paid work by itself: consents and keys still govern. */
export const BudgetPolicyDraft = z.strictObject({
  preset: BudgetPreset,
  currency: BudgetCurrency,
  monthlyMicros: Micros.min(1),
  /** The calendar months count in this zone. */
  timezone: TimeZone,
  /** Percentages of the pool at which the summary warns, each from 1 to 100. */
  thresholds: z.array(z.number().int().min(1).max(100)).max(5),
  sublimits: BudgetSublimits,
  allowances: BudgetAllowances,
  /** What one Tavily credit costs on the person's plan, when they say; null keeps research counted, not priced. */
  researchCreditMicros: Micros.nullable(),
});
export type BudgetPolicyDraft = z.infer<typeof BudgetPolicyDraft>;

/** A policy version: immutable once written. A change is a new version, and never resets what was spent. */
export const BudgetPolicy = z.strictObject({
  ...BudgetPolicyDraft.shape,
  version: z.number().int().positive(),
  /** The version this one replaced; null for the first. */
  replaces: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicy>;

/**
 * A model's input and output bounds, established from a supported source. With them, a request's reservation is a
 * ceiling the provider enforces: its most input, at the full input rate, plus its output cap at the output rate.
 */
export const ModelBounds = z.strictObject({
  /** The most input tokens the provider documents it accepts, and bills, for this model. */
  inputTokens: z.number().int().positive(),
  /** The provider documents that a request's max_tokens caps its billed output, reasoning included. */
  outputCappedByMaxTokens: z.literal(true),
  /** Where both are documented: a page, or a written answer from the provider. */
  source: z.string().min(1).max(500),
  establishedOn: z.iso.date(),
});
export type ModelBounds = z.infer<typeof ModelBounds>;

/** One model's prices per million tokens, in micro-units of the list's currency, and its bounds once established. */
export const ModelRate = z.strictObject({
  model: z.string().min(1).max(200),
  inputMicrosPerMillion: Micros,
  /** Null when the list gives no separate price for cached input. */
  cachedInputMicrosPerMillion: Micros.nullable(),
  outputMicrosPerMillion: Micros,
  /** Null until established: without them the model gets no grant under a money policy. */
  bounds: ModelBounds.nullable(),
});
export type ModelRate = z.infer<typeof ModelRate>;

/** A price list, versioned, as reviewed when it was taken. Past records keep the version they were priced with. */
export const PriceCatalogue = z.strictObject({
  version: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
  source: z.url(),
  retrievedOn: z.iso.date(),
  /** Null until the list's currency is established from a supported source: no money is enforced before then. */
  currency: z.strictObject({ code: BudgetCurrency, source: z.string().min(1).max(500) }).nullable(),
  /** Whether listing models is charged: unknown until established, and counted unpriced meanwhile. */
  listings: z.enum(["unknown", "free", "charged"]),
  models: z.array(ModelRate).min(1).max(50),
});
export type PriceCatalogue = z.infer<typeof PriceCatalogue>;

/** The profile a piece of work ran as: a built-in one until custom profiles exist (NIV-54). Never a credential. */
export const ProfileRef = z.strictObject({
  source: z.enum(["builtin", "custom"]),
  id: z.string().min(1).max(80),
  version: z.number().int().positive(),
});
export type ProfileRef = z.infer<typeof ProfileRef>;
/** The coding worker that runs tasks. It isn't one of the specialists. */
export const CODING_WORKER_PROFILE: ProfileRef = Object.freeze({ source: "builtin", id: "coding-worker", version: 1 });

/** What the money was spent on. `maintenance` is an engine's own recovery and cleanup, outside any run. */
export const SpendFeature = z.enum(["explain", "chat", "review", "mission-review", "coach", "research", "task", "sandbox-check", "environment", "provider-check", "maintenance"]);
export type SpendFeature = z.infer<typeof SpendFeature>;

/** Who and what a grant's spend belongs to, so totals can be broken down without counting anything twice. */
export const BudgetAttribution = z.strictObject({
  feature: SpendFeature,
  projectId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  attemptId: z.uuid().nullable(),
  queueId: z.uuid().nullable(),
  queueItemId: z.uuid().nullable(),
  profile: ProfileRef.nullable(),
});
export type BudgetAttribution = z.infer<typeof BudgetAttribution>;

/**
 * A grant's life in the host's ledger.
 * - written: recorded, and counted in full against its period and sublimits. Nothing has been sent.
 * - dispatching: persisted, and recorded in the guard, before the send begins. The call may have been sent.
 * - accepted: the engine's store shows it accepted the grant.
 * - settled: a complete seal's rows were recorded once, and the unused remainder released.
 * - released: it never left written, in a ledger that wasn't rolled back.
 * - uncertain: no affirmative evidence of what was spent, so the whole grant stays counted.
 * - written-off: the person's choice for an uncertain grant: counted in full as unknown spend, never as zero.
 * Age never settles a grant.
 */
export const GrantState = z.enum(["written", "dispatching", "accepted", "settled", "released", "uncertain", "written-off"]);
export type GrantState = z.infer<typeof GrantState>;
export const GRANT_TRANSITIONS: Readonly<Record<GrantState, readonly GrantState[]>> = Object.freeze({
  written: ["dispatching", "released"],
  dispatching: ["accepted", "settled", "uncertain"],
  accepted: ["settled", "uncertain"],
  uncertain: ["settled", "written-off"],
  settled: [],
  released: [],
  "written-off": [],
});
export const canMoveGrant = (from: GrantState, to: GrantState): boolean => GRANT_TRANSITIONS[from].includes(to);

/** How much one request may take, for reserving: the number of requests and the output cap each is sent with. */
export const RequestShape = z.strictObject({ requests: count, outputTokens: count });
export type RequestShape = z.infer<typeof RequestShape>;

/** What a caller asks the ledger for, before a spendable call. The ledger prices it from the catalogue. */
export const GrantRequest = z.strictObject({
  /** The call's own request id: a run's clientRequestId, by which a lost answer is found again. */
  requestId: z.uuid(),
  workflow: z.string().min(1).max(40),
  targetId: z.string().min(1).max(80),
  attribution: BudgetAttribution,
  /** The models the call may use. None for a call that reaches no model. */
  models: z.array(z.string().min(1).max(200)).max(5),
  productive: RequestShape,
  /** Kept for the hand-in and the final checks, which productive work can't use. */
  finalisation: RequestShape,
  allowances: BudgetAllowances,
  /** For an extension: the first grant of the same work, and the one need it answers. */
  extends: z.uuid().nullable(),
  need: z.string().min(1).max(80).nullable(),
});
export type GrantRequest = z.infer<typeof GrantRequest>;

/** What an engine receives with a call: its finite share, never the pool. It travels in memory, never in a workflow. */
export const BudgetGrant = z.strictObject({
  id: z.uuid(),
  requestId: z.uuid(),
  catalogueVersion: z.string().min(1).max(64),
  /** The prices for the models the call may use, from that catalogue version. */
  rates: z.array(ModelRate).max(5),
  /** Null when the call is unpriced: no money policy, or a currency or bound not yet established. */
  productiveMicros: Micros.nullable(),
  finalisationMicros: Micros.nullable(),
  productive: RequestShape,
  finalisation: RequestShape,
  allowances: BudgetAllowances,
});
export type BudgetGrant = z.infer<typeof BudgetGrant>;

/** One paid operation an engine journals, written at the actual send point. */
export const OperationKind = z.enum(["model-request", "model-listing", "research-search", "research-extract", "sandbox-operation", "sandbox-transfer"]);
export type OperationKind = z.infer<typeof OperationKind>;

/**
 * - reserved: written, and its bound fits the grant. Not yet handed to the transport.
 * - unsent: refused before the transport took it; only that is established.
 * - sent: handed to the transport.
 * - reported: usage came back, and the amount is fixed with the grant's catalogue version.
 * - partial: some usage fields are missing, and they are priced at their upper bound.
 * - unknown: no usage came back. Counted at its reserved bound, never as zero.
 */
export const OperationState = z.enum(["reserved", "unsent", "sent", "reported", "partial", "unknown"]);
export type OperationState = z.infer<typeof OperationState>;

/** Tokens as the provider reported them; a field it didn't report is null, never zero. */
export const ModelUsage = z.strictObject({
  inputTokens: count.nullable(),
  /** Part of inputTokens, when reported. */
  cachedInputTokens: count.nullable(),
  /** Reasoning included. */
  outputTokens: count.nullable(),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

export const BudgetOperation = z.strictObject({
  id: z.uuid(),
  grantId: z.uuid(),
  /** Its order in the grant's journal, from 1. */
  seq: z.number().int().positive(),
  kind: OperationKind,
  model: z.string().min(1).max(200).nullable(),
  /** The council seat or role the request was made for, when it had one. */
  seat: z.string().min(1).max(40).nullable(),
  /** The digest of the instructions the request actually carried. */
  instructionsSha256: Sha256Hex.nullable(),
  state: OperationState,
  /** The reserved bound; null when unpriced. */
  boundMicros: Micros.nullable(),
  usage: ModelUsage.nullable(),
  /** Tavily credits, or Nebius seconds, as reported. */
  units: count.nullable(),
  /** Reported or partial: what it cost. Unknown: its bound. Unsent, or unpriced: null. */
  amountMicros: Micros.nullable(),
});
export type BudgetOperation = z.infer<typeof BudgetOperation>;

/**
 * The end of a grant's journal. Complete: written at the normal end of the grant's work, in the run's terminal
 * transaction, by the engine instance that did the work; only this kind releases what was left unspent. Interrupted:
 * written when a journal is closed after a crash, a kill, a shutdown past its grace period or a restart; rows lost with
 * a restored store can't be known, so it never claims completeness.
 */
export const JournalSeal = z.strictObject({
  grantId: z.uuid(),
  kind: z.enum(["complete", "interrupted"]),
  rows: count,
  /** The engine instance that wrote it. */
  instanceId: z.uuid(),
  sealedAt: z.iso.datetime(),
});
export type JournalSeal = z.infer<typeof JournalSeal>;

/** How a budget month was opened: the ledger's first, the provider's clock past the boundary, or the person's word. */
export const PeriodOpenedBy = z.enum(["first", "corroborated", "confirmed"]);
export type PeriodOpenedBy = z.infer<typeof PeriodOpenedBy>;

export const BudgetPeriod = z.strictObject({
  /** year * 12 + month - 1, in the policy's time zone: it only ever moves forward. */
  index: z.number().int().nonnegative(),
  label: z.string().regex(/^\d{4}-\d{2}$/),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: TimeZone,
  openedBy: PeriodOpenedBy,
  openedAt: z.iso.datetime(),
});
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

/**
 * Why the budget history needs recovery: the ledger is missing, was replaced by another, or is behind the guard's last
 * revision (a backup put back, even with the same number of grants); or the workspace was just kept aside. While set,
 * every spendable call is refused, whatever the policy mode, until the person restores the history or starts a new one.
 */
export const BudgetRecoveryReason = z.enum(["ledger-missing", "ledger-replaced", "ledger-behind", "workspace-kept-aside"]);
export type BudgetRecoveryReason = z.infer<typeof BudgetRecoveryReason>;
export const BudgetRecovery = z.strictObject({
  reason: BudgetRecoveryReason,
  detectedAt: z.iso.datetime(),
  /** What the guard last recorded. */
  guard: z.strictObject({ ledgerId: z.uuid(), revision: count }),
  /** What the workspace holds now; null when it holds no ledger. */
  ledger: z.strictObject({ ledgerId: z.uuid(), revision: count }).nullable(),
});
export type BudgetRecovery = z.infer<typeof BudgetRecovery>;

/** Why a total can't be read as complete. Each is said in the summary, never smoothed over. */
export const BudgetGap = z.enum(["currency-unconfirmed", "bounds-unestablished", "unpriced-usage", "uncertain-grants", "listings-unpriced", "stale-catalogue", "history-lost"]);
export type BudgetGap = z.infer<typeof BudgetGap>;

/** One breakdown line: leaf operations and grants only, so a council and its members are never counted twice. */
export const BudgetBreakdownLine = z.strictObject({
  dimension: z.enum(["feature", "project", "profile", "model"]),
  key: z.string().max(200),
  settledMicros: Micros,
  unknownMicros: Micros,
  reservedMicros: Micros,
});
export type BudgetBreakdownLine = z.infer<typeof BudgetBreakdownLine>;

export const BudgetSummary = z.strictObject({
  policy: BudgetPolicy.nullable(),
  period: BudgetPeriod.nullable(),
  recovery: BudgetRecovery.nullable(),
  poolMicros: Micros.nullable(),
  /** Reported and partial operations of settled grants. */
  settledMicros: Micros,
  /** Unknown operations at their bounds, and uncertain or written-off grants in full. */
  unknownMicros: Micros,
  /** Open grants, counted in full. */
  reservedMicros: Micros,
  /** The pool less all three; negative when reported usage ran over its bounds. Null without a policy. */
  availableMicros: z.number().int().nullable(),
  counted: z.strictObject({ used: BudgetAllowances, allowed: BudgetAllowances.nullable() }),
  gaps: z.array(BudgetGap).max(BudgetGap.options.length),
  thresholdsCrossed: z.array(z.number().int().min(1).max(100)).max(5),
  breakdown: z.array(BudgetBreakdownLine).max(400),
});
export type BudgetSummary = z.infer<typeof BudgetSummary>;

/** The cost of `tokens` at a price per million, in micro-units, rounded up: a price under a micro-unit a token is never 0. */
export function priceTokens(tokens: number, microsPerMillion: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(microsPerMillion) || microsPerMillion < 0) throw new RangeError("Tokens and prices are whole, non-negative numbers.");
  const product = BigInt(tokens) * BigInt(microsPerMillion);
  const cost = (product + 999_999n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("That cost is too large to count.");
  return Number(cost);
}

/**
 * The reservation for one request to `rate`'s model with output cap `outputTokens`: its most input at the full input
 * rate, plus the cap at the output rate. Null while the model's bounds aren't established: then there is no ceiling to
 * reserve, and the request isn't priced.
 */
export function requestBound(rate: ModelRate, outputTokens: number): { inputTokens: number; outputTokens: number; micros: number } | null {
  if (!rate.bounds) return null;
  const inputTokens = Math.max(0, rate.bounds.inputTokens - outputTokens);
  return { inputTokens, outputTokens, micros: priceTokens(inputTokens, rate.inputMicrosPerMillion) + priceTokens(outputTokens, rate.outputMicrosPerMillion) };
}

/**
 * What a request cost, from what the provider reported. Cached input is priced at its own rate only when the provider
 * reported it and the list has a price for it; otherwise all input is priced at the full rate and the record is
 * partial. Null when input or output wasn't reported: the request's cost is unknown, and its bound stands.
 */
export function priceUsage(rate: ModelRate, usage: ModelUsage): { micros: number; certainty: "reported" | "partial" } | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const cached = usage.cachedInputTokens;
  const output = priceTokens(usage.outputTokens, rate.outputMicrosPerMillion);
  if (cached === null || rate.cachedInputMicrosPerMillion === null || cached > usage.inputTokens) {
    return { micros: priceTokens(usage.inputTokens, rate.inputMicrosPerMillion) + output, certainty: "partial" };
  }
  return {
    micros: priceTokens(usage.inputTokens - cached, rate.inputMicrosPerMillion) + priceTokens(cached, rate.cachedInputMicrosPerMillion) + output,
    certainty: "reported",
  };
}

/** A calendar month in one time zone: its index, its label, and its first and next month's first instants. */
export interface BudgetMonth {
  index: number;
  label: string;
  startsAt: number;
  endsAt: number;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function wallClock(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    zoneFormats.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return { year: parts["year"]!, month: parts["month"]!, day: parts["day"]!, hour: parts["hour"]!, minute: parts["minute"]!, second: parts["second"]! };
}

/** The zone's offset from UTC at `at`, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
  const whole = Math.floor(at / 1000) * 1000;
  const wall = wallClock(whole, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - whole;
}

/** The first instant of a local calendar day: local midnight, or the first instant after it where midnight is skipped. */
function startOfLocalDay(year: number, month: number, day: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

/** The local calendar day holding `at`, in `timeZone`: its label and its bounds, for a daily sublimit. */
export function dayOf(at: number, timeZone: string): { label: string; startsAt: number; endsAt: number } {
  const { year, month, day } = wallClock(at, timeZone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    label: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    startsAt: startOfLocalDay(year, month, day, timeZone),
    endsAt: startOfLocalDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

/** The calendar month holding `at`, in `timeZone`. The index comes from the local date itself, so it never goes back. */
export function monthOf(at: number, timeZone: string): BudgetMonth {
  const { year, month } = wallClock(at, timeZone);
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    index: year * 12 + (month - 1),
    label: `${year}-${String(month).padStart(2, "0")}`,
    startsAt: startOfLocalDay(year, month, 1, timeZone),
    endsAt: startOfLocalDay(next.year, next.month, 1, timeZone),
  };
}
