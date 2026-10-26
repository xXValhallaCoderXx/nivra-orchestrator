import { z } from "zod";
import { ChatContext, ChatInput, ChatResult } from "./chat.ts";
import { RunContext } from "./context.ts";
import { ExplainResult } from "./explain.ts";
import { ModelEndpoint, ModelFailureKind } from "./models.ts";
import { ResearchContext, ResearchInput, ResearchReport } from "./research.ts";
import { ReviewContext, ReviewInput, ReviewReport } from "./review.ts";
import { ExplainInput, HelloInput, RunEventsPage, RunId, RunList, RunStatus, RunSummary } from "./runs.ts";
import { SandboxContext, SandboxInput, SandboxPreview, SandboxReport, SandboxStatus } from "./sandbox.ts";
import { TaskBrief, TaskContext, TaskInput, TaskPreview, TaskProposal, TaskReport } from "./task.ts";

/**
 * Every request the host may send the engine, with its parameters and result as zod schemas. The engine validates
 * parameters before a handler runs and results before they are sent; main validates both again (D2).
 */

/**
 * Names of the secrets the engine may hold. Values arrive in `initialize` or `secrets.update` and live in memory only
 * (D8). The project id goes with the key to Nebius Sandboxes (D36); the Tavily key goes only to Tavily, for research
 * (D37).
 */
export const SecretName = z.enum(["NEBIUS_API_KEY", "NEBIUS_PROJECT_ID", "TAVILY_API_KEY"]);
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
  /**
   * A random id stored in the home's database when it was created (D26): it names the store, as a path can't. A run's
   * absence means it was never accepted only when asked of the store with the same id.
   */
  homeId: z.uuid(),
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

const RunRequest = {
  /** Minted by main for each request, so a retry never starts a second run. */
  clientRequestId: z.uuid(),
  /** Held in the engine's memory for this run only, never stored with it (D21). */
  context: RunContext,
};
export const StartRunParams = z.discriminatedUnion("workflowId", [
  z.strictObject({ ...RunRequest, workflowId: z.literal("hello"), input: HelloInput }),
  z.strictObject({ ...RunRequest, workflowId: z.literal("explain"), input: ExplainInput }),
  // A conversation's turn carries the conversation so far as well (D26), held in memory like the snapshot.
  z.strictObject({ clientRequestId: RunRequest.clientRequestId, context: ChatContext, workflowId: z.literal("chat"), input: ChatInput }),
  // A review of a saved plan version carries the frozen packet too (D30), held in memory like the snapshot.
  z.strictObject({ clientRequestId: RunRequest.clientRequestId, context: ReviewContext, workflowId: z.literal("review"), input: ReviewInput }),
  // A sandbox check carries its own upload consent, never model-context consent (D36).
  z.strictObject({ clientRequestId: RunRequest.clientRequestId, context: SandboxContext, workflowId: z.literal("sandbox"), input: SandboxInput }),
  // Research of a saved plan's assumptions carries its frozen packet, what no query may name and both permissions
  // (D37), held in memory like the snapshot.
  z.strictObject({ clientRequestId: RunRequest.clientRequestId, context: ResearchContext, workflowId: z.literal("research"), input: ResearchInput }),
  // A task run carries its frozen brief and both consents, model sharing and uploads, held in memory like the snapshot
  // (D39): neither consent stands in for the other.
  z.strictObject({ clientRequestId: RunRequest.clientRequestId, context: TaskContext, workflowId: z.literal("task"), input: TaskInput }),
]);
export type StartRunParams = z.input<typeof StartRunParams>;

/** Whether the model did what a tool choice asked; `skipped` when there was no time or no working call to try it. */
export const ToolChoiceProbe = z.enum(["honoured", "ignored", "failed", "skipped"]);
export type ToolChoiceProbe = z.infer<typeof ToolChoiceProbe>;

/** Whether the model, forced to submit an answer, filled in the explain workflow's real answer schema correctly. */
export const AnswerSchemaProbe = z.enum(["valid", "invalid", "ignored", "failed", "skipped"]);
export type AnswerSchemaProbe = z.infer<typeof AnswerSchemaProbe>;

/**
 * What `providers.check` found (B7, D22): Token Factory reached from this engine, its NVIDIA models, one call that has
 * to use a tool, and what the explain workflow needs to know about the model: whether usage is reported, whether a
 * required or forced tool choice is honoured, and its context length when `/models` says.
 */
export const ProviderCheck = z.strictObject({
  endpoint: ModelEndpoint,
  models: z.strictObject({
    total: z.number().int().nonnegative(),
    nvidia: z.array(z.string()),
    /** Of the model that was called; null when `/models` doesn't say. */
    contextLength: z.number().int().positive().nullable(),
  }),
  call: z
    .strictObject({
      model: z.string(),
      toolCalled: z.boolean(),
      answer: z.string(),
      servedModel: z.string().nullable(),
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      elapsedMs: z.number().int().nonnegative(),
      /** From the last response's documented rate-limit headers; each null when the provider didn't send it. */
      rateLimit: z.strictObject({
        remainingTokens: z.number().nonnegative().nullable(),
        resetTokensSeconds: z.number().nonnegative().nullable(),
        /** Below 2,000 remaining tokens, Mastra waits 10 s after each step. */
        belowPauseThreshold: z.boolean().nullable(),
      }),
    })
    .nullable(),
  probes: z
    .strictObject({
      /** `toolChoice: "required"`, with a prompt that needs no tool. */
      requiredToolChoice: ToolChoiceProbe,
      /** A named tool forced, when the prompt points at the other of two tools. */
      forcedToolChoice: ToolChoiceProbe,
      /** `submit_answer` forced, with the explain workflow's real answer schema. One tiny case, not proof of reliability. */
      answerSchema: AnswerSchemaProbe,
    })
    .nullable(),
  /** Why the call was not made or failed; null when it worked. */
  problem: z.string().nullable(),
  problemKind: ModelFailureKind.nullable(),
  /** On a 429: how long Token Factory asked to wait, when it said. */
  retryAfterSeconds: z.number().int().positive().nullable(),
});
export type ProviderCheck = z.infer<typeof ProviderCheck>;

export const Methods = {
  initialize: { params: InitializeParams, result: EngineInfo },
  "secrets.update": { params: SecretsUpdateParams, result: Ok },
  shutdown: { params: Empty, result: Ok },
  ping: { params: Empty, result: z.strictObject({ instanceId: z.uuid() }) },
  doctor: { params: Empty, result: DoctorReport },
  "providers.check": { params: z.strictObject({ model: z.string().min(1).max(200).optional() }), result: ProviderCheck },
  "runs.start": { params: StartRunParams, result: RunSummary },
  "runs.get": { params: z.strictObject({ runId: RunId }), result: RunSummary },
  /** The run a request id created, or null when this store has none (D26): how a send whose answer was lost is found. */
  "runs.find": { params: z.strictObject({ clientRequestId: z.uuid() }), result: RunSummary.nullable() },
  "runs.list": {
    params: z.strictObject({ limit: z.number().int().min(1).max(100).default(20), cursor: z.number().int().positive().nullable().default(null) }),
    result: RunList,
  },
  "runs.events": {
    params: z.strictObject({ runId: RunId, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(200) }),
    result: RunEventsPage,
  },
  "runs.cancel": { params: z.strictObject({ runId: RunId }), result: z.strictObject({ status: RunStatus, wasTerminal: z.boolean() }) },
  /** An explain run's stored result; null until it has one. */
  "runs.result": { params: z.strictObject({ runId: RunId }), result: ExplainResult.nullable() },
  /** A chat run's stored reply; null until it has one. */
  "runs.reply": { params: z.strictObject({ runId: RunId }), result: ChatResult.nullable() },
  /**
   * A review run's report (D30), whatever the run's status: in progress, partial or complete. A report the engine
   * saved before it stopped reads as interrupted. Null until there is one.
   */
  "runs.review": { params: z.strictObject({ runId: RunId }), result: ReviewReport.nullable() },
  /**
   * A sandbox check's report (D36), whatever the run's status. A report the engine saved before it stopped reads as
   * interrupted. Null until there is one.
   */
  "runs.sandbox": { params: z.strictObject({ runId: RunId }), result: SandboxReport.nullable() },
  /**
   * A research run's report (D37), whatever the run's status. A report the engine saved before it stopped reads as
   * interrupted. Null until there is one.
   */
  "runs.research": { params: z.strictObject({ runId: RunId }), result: ResearchReport.nullable() },
  /**
   * A task run's report (D39), whatever the run's status. A report the engine saved before it stopped reads as
   * interrupted. Null until there is one.
   */
  "runs.task": { params: z.strictObject({ runId: RunId }), result: TaskReport.nullable() },
  /** A task run's proposal, as the person reads it before deciding: null when the run proposed nothing (D39). */
  "runs.proposal": { params: z.strictObject({ runId: RunId }), result: TaskProposal.nullable() },
  /** What a task run of this checkout would send to Nebius, with no network, and the bounds it runs under (D39). */
  "task.preview": { params: z.strictObject({ repoPath: z.string().min(1).max(4096), brief: TaskBrief }), result: TaskPreview },
  /** What a sandbox check of this checkout would send, with no network: for the person to see before any upload. */
  "sandbox.preview": { params: z.strictObject({ repoPath: z.string().min(1).max(4096) }), result: SandboxPreview },
  /** Sandbox work an earlier engine left open, and the recovery pass's state. Reads only this engine's memory. */
  "sandbox.status": { params: Empty, result: SandboxStatus },
  /** Starts one bounded recovery pass when none is running and the credentials are set; the status as it is then. */
  "sandbox.recover": { params: Empty, result: SandboxStatus },
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

/** What `main.mjs --self-check` prints when the whole runtime loaded, native storage driver included (D5). */
export const EngineSelfCheck = z.strictObject({
  ok: z.literal(true),
  engineVersion: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  runtimeHash: z.string().nullable(),
});
export type EngineSelfCheck = z.infer<typeof EngineSelfCheck>;
