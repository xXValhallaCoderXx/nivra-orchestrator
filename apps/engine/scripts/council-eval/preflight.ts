import type { DoctorReport, ModelEndpoint, ReviewReport } from "@nivra/domain";
import { createModelClient, ModelFailure, type Endpoint } from "../../src/providers/model.ts";
import { policyFor } from "../../src/providers/policy.ts";
import { pickNemotron, TOKEN_FACTORY_BASE_URL } from "../../src/providers/tokenfactory.ts";
import { REVIEW_LIMITS } from "../../src/review/run.ts";
import { canonical, type Arm, type Frozen } from "./files.ts";

/**
 * What a run is checked against before it starts, with no inference request (NIV-40): where the engine sends its
 * requests, the model it would pick, and the sampling it gives that model, each worked out with the engine's own code.
 * A run's recorded route, model and sampling are checked again after it ends.
 */

/** Where the engine sends model requests, as it is started (engine.ts): a loopback stub, or Token Factory. */
export const endpointFor = (tokenFactoryUrl: string | null): Endpoint => (tokenFactoryUrl ? { url: tokenFactoryUrl, kind: "loopback-test" } : { url: TOKEN_FACTORY_BASE_URL, kind: "token-factory" });

/** The endpoint an engine's doctor reports: its models check is ok for Token Factory, a warning for a test endpoint. */
export function endpointFromDoctor(report: DoctorReport): ModelEndpoint | null {
  const check = report.checks.find((entry) => entry.id === "models");
  return check?.status === "ok" ? "token-factory" : check?.status === "warn" ? "loopback-test" : null;
}

/** The sampling a review run of `arm` records for `model`, worked out as the review runtime works it out (review/run.ts). */
export const samplingFor = (model: string, arm: Arm): ReviewReport["sampling"] => ({
  temperature: null,
  topP: null,
  maxOutputTokens: REVIEW_LIMITS[arm].outputTokensPerRequest,
  toolChoice: policyFor(model).forceAnswer ? "forced" : "auto",
});

const samplingText = (sampling: ReviewReport["sampling"]) =>
  `${sampling.toolChoice} tool choice, at most ${sampling.maxOutputTokens.toLocaleString("en")} output tokens${sampling.temperature === null && sampling.topP === null ? "" : ", and its own temperature or top_p"}`;

/** Why a run must not start, in Nivra's words; null when it may. The batch's endpoint is Token Factory, or a stub's. */
export function preflightProblem(seen: { endpoint: ModelEndpoint | null; model: string | null; arm: Arm }, frozen: Frozen, mode: "stub" | "live"): string | null {
  const { protocol } = frozen;
  const expected: ModelEndpoint = mode === "live" ? protocol.endpoint : "loopback-test";
  if (seen.endpoint !== expected) {
    if (seen.endpoint === null) return "The engine didn't say where it sends its requests, so nothing was sent.";
    return mode === "live" ? "The engine would send its requests to a test endpoint, not Token Factory, so nothing was sent." : "The engine would send its requests to Token Factory, but this batch is against a stub, so nothing was sent.";
  }
  if (seen.model !== protocol.model) return `The model listing would give these reviews ${seen.model ?? "no NVIDIA model"}, not ${protocol.model}, so nothing was sent.`;
  const sampling = samplingFor(seen.model, seen.arm);
  if (canonical(sampling) !== canonical(protocol.sampling)) return `${seen.model} would be sent with ${samplingText(sampling)}, not the protocol's ${samplingText(protocol.sampling)}, so nothing was sent.`;
  return null;
}

/**
 * The model the engine would pick now: the endpoint's listing (`GET /models`, never an inference request), read with
 * the engine's own client, and the engine's own pick. A listing that fails says so in Nivra's words.
 */
export async function modelNow(apiKey: string, endpoint: Endpoint): Promise<{ model: string | null } | { problem: string }> {
  try {
    const list = await createModelClient({ apiKey, endpoint }).listModels({ timeoutMs: 30_000 });
    return { model: pickNemotron(list.ids) };
  } catch (error) {
    const kind = error instanceof ModelFailure ? error.kind : "internal";
    return { problem: `The model listing failed (${kind}), so nothing was sent.` };
  }
}

/**
 * Why a paid batch must not start, in Nivra's words; null when it may: only the approved digest, with its labeller
 * chosen, from a committed tree, and none of the options that are for tests.
 */
export function paidBatchRefusal(frozen: Frozen, run: { approved: string | undefined; commit: string | null; dirty: boolean; testOptions: boolean }): string | null {
  if (run.testOptions) return "--only, --deadline-ms, --reconcile-ms, --engine and --fixtures are for tests against a stub, never for the paid batch.";
  if (run.approved !== frozen.approvalDigest) return `The approved digest isn't this protocol's (${frozen.approvalDigest}): the fixtures, the rubric or the protocol changed since. Run --plan, and approve what it shows.`;
  if (frozen.protocol.labelling === "pending") return "The protocol doesn't say who labels the sheet yet. Choose it in protocol.json, then approve the new digest --plan shows.";
  if (run.dirty || !run.commit) return "The working tree has uncommitted changes, so the revision this batch runs wouldn't be exact. Commit them, then run it again. Nothing was sent.";
  return null;
}
