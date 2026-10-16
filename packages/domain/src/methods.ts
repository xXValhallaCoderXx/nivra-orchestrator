import { z } from "zod";
import { HelloInput, RunEventsPage, RunId, RunList, RunStatus, RunSummary } from "./runs.ts";

/**
 * Every request the host may send the engine, with its parameters and result as zod schemas. The engine validates
 * parameters before a handler runs and results before they are sent; main validates both again (D2).
 */

/** Names of the secrets the engine may hold. Values arrive in `initialize` or `secrets.update` and live in memory only (D8). */
export const SecretName = z.enum(["NEBIUS_API_KEY"]);
export type SecretName = z.infer<typeof SecretName>;

/** Real keys are long; a very short value would mask ordinary text everywhere it appears. */
const SecretValue = z.string().min(8).max(4_096);
const Empty = z.strictObject({});
const Ok = z.strictObject({ ok: z.literal(true) });

export const InitializeParams = z.strictObject({
  protocolVersion: z.number().int().positive(),
  client: z.strictObject({ name: z.string().min(1).max(64), version: z.string().min(1).max(64) }),
  secrets: z.partialRecord(SecretName, SecretValue).default({}),
});
export type InitializeParams = z.input<typeof InitializeParams>;

export const EngineInfo = z.strictObject({
  protocolVersion: z.number().int().positive(),
  engineVersion: z.string(),
  instanceId: z.uuid(),
  pid: z.number().int().positive(),
  home: z.string(),
  /** The staged runtime's content hash (D5); null when the engine runs from source. */
  runtimeHash: z.string().nullable(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
});
export type EngineInfo = z.infer<typeof EngineInfo>;

export const SecretsUpdateParams = z.strictObject({
  set: z.partialRecord(SecretName, SecretValue).default({}),
  remove: z.array(SecretName).default([]),
});

export const DoctorCheck = z.strictObject({
  id: z.string(),
  status: z.enum(["ok", "warn", "fail"]),
  title: z.string(),
  detail: z.string(),
  /** What to do about a warning or failure, in words a person can act on; null when there is nothing to do. */
  fix: z.string().nullable(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.strictObject({ checks: z.array(DoctorCheck) });
export type DoctorReport = z.infer<typeof DoctorReport>;

export const StartRunParams = z.strictObject({
  /** Minted by main for each request, so a retry never starts a second run. */
  clientRequestId: z.uuid(),
  workflowId: z.literal("hello"),
  input: HelloInput,
});
export type StartRunParams = z.input<typeof StartRunParams>;

export const Methods = {
  initialize: { params: InitializeParams, result: EngineInfo },
  "secrets.update": { params: SecretsUpdateParams, result: Ok },
  shutdown: { params: Empty, result: Ok },
  ping: { params: Empty, result: z.strictObject({ instanceId: z.uuid() }) },
  doctor: { params: Empty, result: DoctorReport },
  "runs.start": { params: StartRunParams, result: RunSummary },
  "runs.get": { params: z.strictObject({ runId: RunId }), result: RunSummary },
  "runs.list": {
    params: z.strictObject({ limit: z.number().int().min(1).max(100).default(20), cursor: z.number().int().positive().nullable().default(null) }),
    result: RunList,
  },
  "runs.events": {
    params: z.strictObject({ runId: RunId, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(200) }),
    result: RunEventsPage,
  },
  "runs.cancel": { params: z.strictObject({ runId: RunId }), result: z.strictObject({ status: RunStatus, wasTerminal: z.boolean() }) },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type MethodName = keyof typeof Methods;
export type ParamsOf<M extends MethodName> = z.input<(typeof Methods)[M]["params"]>;
export type ResultOf<M extends MethodName> = z.output<(typeof Methods)[M]["result"]>;

export const isMethodName = (name: string): name is MethodName => Object.hasOwn(Methods, name);

/**
 * Notifications the engine sends without being asked. `engine.fatal` is the engine's last word before it exits on a
 * startup failure, with a code the host can act on rather than text to parse.
 */
export const EngineFatal = z.strictObject({
  code: z.enum(["locked", "bad-arguments", "home-unusable", "runtime-broken", "crashed"]),
  message: z.string(),
});
export type EngineFatal = z.infer<typeof EngineFatal>;
