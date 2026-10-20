import { z } from "zod";

/**
 * Why a model call, or a run that makes them, failed (D22), so the app can say what to do without reading the message.
 * `sharing-refused` and `no-key` stop a run before any request is made; `context-too-small` stops it before any chat
 * request, when the model's context can't hold the instructions and the starting map with room to read (D23).
 * `budget-exhausted` stops it when the run's estimated input budget can't admit the next request (D30).
 */
export const ModelFailureKind = z.enum([
  "sharing-refused",
  "no-key",
  "context-too-small",
  "budget-exhausted",
  "auth",
  "rate-limit",
  "model-unavailable",
  "provider",
  "bad-request",
  "bad-response",
  "network",
  "timeout",
  "cancelled",
  "malformed",
  "internal",
]);
export type ModelFailureKind = z.infer<typeof ModelFailureKind>;

/** Where an engine sends model requests: Token Factory, or a stub on the same machine that only tests use. */
export const ModelEndpoint = z.enum(["token-factory", "loopback-test"]);
export type ModelEndpoint = z.infer<typeof ModelEndpoint>;

/** Which model a run used, and where its requests went, so a run against a stub can never pass for a live one. */
export const RunRoute = z.strictObject({ provider: z.literal("nebius"), endpoint: ModelEndpoint, model: z.string().min(1).max(200) });
export type RunRoute = z.infer<typeof RunRoute>;

/**
 * Tokens a run's model calls reported. A total is null as soon as one call didn't report it: never 0, never an
 * estimate. `reportedCalls` of `calls` says how complete the counts are.
 */
export const RunUsage = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  calls: z.number().int().nonnegative(),
  reportedCalls: z.number().int().nonnegative(),
});
export type RunUsage = z.infer<typeof RunUsage>;

const count = z.number().int().nonnegative();

/**
 * A run's limits and what it used (NIV-38, D30). The hard limits are enforced: requests are admitted by count, each is
 * aborted at its deadline, and each is sent with its output cap. Input has an estimated admission budget only: it is
 * counted as characters ÷ 3 until the provider reports, and a tokenizer can count more, so it decides what is admitted
 * and guarantees no ceiling. An overrun is recorded, never hidden; a reported total is null once a request didn't say.
 */
export const RunBudgetRecord = z.strictObject({
  limits: z.strictObject({
    requests: count,
    totalMs: count,
    outputTokensPerRequest: count,
    /** The estimated admission budget for the run's input, not a ceiling. */
    estimatedInputTokens: count,
  }),
  used: z.strictObject({
    requests: count,
    elapsedMs: count,
    /** The input counted against the budget: what the provider reported where it did, Nivra's estimate where it didn't. */
    inputTokens: count,
    reportedInputTokens: count.nullable(),
    reportedOutputTokens: count.nullable(),
    unreportedRequests: count,
    /** How far reported input went past its estimate, summed over the requests that did. */
    overrunTokens: count,
  }),
  /** Why admission stopped, when it did. */
  stopped: z.enum(["cancelled", "deadline", "exhausted"]).nullable(),
});
export type RunBudgetRecord = z.infer<typeof RunBudgetRecord>;
