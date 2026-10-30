/**
 * How the explain workflow drives a model (D22), from what a check has shown it does. A model is made to call a tool
 * on every exploring step, or forced to submit its answer, only once a check has seen it honour that tool choice. Any
 * other model runs with `auto` and a bounded loop, under the same answer validation. No plain-text fallback is built
 * on the strength of a probe either way.
 */
export interface ModelPolicy {
  /** The tool choice for exploring steps. */
  explore: "required" | "auto";
  /** Whether `submit_answer` is forced on the step that must answer. */
  forceAnswer: boolean;
  /** Where the evidence came from. */
  evidence: string;
}

const SEEN: Readonly<Record<string, ModelPolicy>> = {
  "nvidia/nemotron-3-super-120b-a12b": {
    explore: "required",
    forceAnswer: true,
    evidence: "Checkpoint 1, 17 Oct 2026 (Settings → Check Token Factory): required and forced tool choice honoured on tiny probes",
  },
  "nvidia/nemotron-3.5-super-vl": {
    explore: "required",
    forceAnswer: true,
    evidence: "D50's tool-choice check, 28 Oct 2026 (Check Token Factory at 77e3a45): required and forced tool choice honoured, and a forced answer valid, on tiny probes",
  },
};

export const DEFAULT_POLICY: ModelPolicy = { explore: "auto", forceAnswer: false, evidence: "not checked: auto tool choice in a bounded loop" };

export function policyFor(modelId: string): ModelPolicy {
  return SEEN[modelId.toLowerCase()] ?? DEFAULT_POLICY;
}

/**
 * The whole request (instructions, preferences, tool definitions, the history and repository excerpts) stays under
 * this many tokens, whatever the model's own context length: a run's cost and latency are bounded by Nivra, not by the
 * model. The model's documented `context_length` lowers it further when it is smaller.
 */
export const APP_TOKEN_CAP = 64_000;

/** Held back for the model's answer, on every request. */
export const ANSWER_TOKENS = 4_000;

/**
 * The token budget for everything sent in one request, with room left for the answer. There is no floor: a model whose
 * context can't hold the instructions and the map with room to read is refused before any chat request (D23), never
 * sent more than it allows.
 * A workflow with its own completion allowance passes that bound explicitly; other callers keep ANSWER_TOKENS.
 */
export function requestBudget(contextLength: number | null, answerTokens = ANSWER_TOKENS): number {
  const limit = contextLength === null ? APP_TOKEN_CAP : Math.min(contextLength, APP_TOKEN_CAP);
  return limit - answerTokens;
}
