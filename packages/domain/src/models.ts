import { z } from "zod";

/**
 * Why a model call, or a run that makes them, failed (D22), so the app can say what to do without reading the message.
 * `sharing-refused` and `no-key` stop a run before any request is made; `context-too-small` stops it before any chat
 * request, when the model's context can't hold the instructions and the starting map with room to read (D23).
 */
export const ModelFailureKind = z.enum([
  "sharing-refused",
  "no-key",
  "context-too-small",
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
