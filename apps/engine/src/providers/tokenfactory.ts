import { z } from "zod";

/** Nebius Token Factory's OpenAI-compatible inference API (D13). */
export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/**
 * Nemotron models in the order Nivra prefers them when none is named: Nemotron 3.5 Super VL first, which replaces
 * Nemotron 3 Super when Token Factory retires it on 9 November 2026 (D50). The live model list is the authority, so an
 * ID is used only when the key can see it.
 */
export const PREFERRED_NEMOTRON = ["nvidia/Nemotron-3.5-Super-VL", "nvidia/Nemotron-3_5-Lightning", "nvidia/Nemotron-3-Ultra-550b-a55b"] as const;

export interface ModelEntry {
  id: string;
  ownedBy: string | null;
  /** The context length, under whichever of the usual names `/models` gives it; null when it doesn't. */
  contextLength: number | null;
}

const Length = z.number().int().positive().nullish();
const ModelsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      owned_by: z.string().nullish(),
      context_length: Length.catch(null),
      context_window: Length.catch(null),
      max_model_len: Length.catch(null),
      max_context_length: Length.catch(null),
    }),
  ),
});

/** Token Factory refused or failed a request. The message says what happened and what to do. */
export class TokenFactoryError extends Error {
  readonly status: number;

  /** `detail` is Nivra's own words, used for a reply that couldn't be read; Token Factory's own text is never kept. */
  constructor(status: number, detail = "") {
    super(statusMessage(status, detail));
    this.name = "TokenFactoryError";
    this.status = status;
  }
}

function statusMessage(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return `Token Factory refused the API key (HTTP ${status}). Check the key, or create a new one in the Token Factory console.`;
  }
  if (status === 429) return "Token Factory is rate-limiting this key (HTTP 429). Wait a minute, then try again.";
  if (status < 400) return detail;
  return `Token Factory answered HTTP ${status}.`;
}

export interface RequestOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  baseUrl?: string;
}

/**
 * Lists the models the key can use, with `verbose=true`, which Token Factory documents as adding each model's
 * `context_length`. The key travels only in the Authorization header.
 */
export async function listModels(apiKey: string, options: RequestOptions = {}): Promise<ModelEntry[]> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${options.baseUrl ?? TOKEN_FACTORY_BASE_URL}/models?verbose=true`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    // The body is Token Factory's text, which can echo the key: it is discarded, and the status names the failure.
    await response.body?.cancel().catch(() => undefined);
    throw new TokenFactoryError(response.status);
  }
  const body = ModelsResponse.safeParse(await response.json().catch(() => undefined));
  // An unreadable answer keeps its status, so it is named as one (bad-response), never as Nivra failing.
  if (!body.success) throw new TokenFactoryError(response.status, "Token Factory answered /models with a shape Nivra does not recognise. Try again in a few minutes.");
  return body.data.data.map((model) => ({
    id: model.id,
    ownedBy: model.owned_by ?? null,
    contextLength: model.context_length ?? model.context_window ?? model.max_model_len ?? model.max_context_length ?? null,
  }));
}

/** NVIDIA's open models, the ones the hackathon requires. */
export const isNvidiaModel = (id: string): boolean => id.toLowerCase().startsWith("nvidia/");

/** The Nemotron model to use when none is named: the first preferred one the key can see, else any NVIDIA model. */
export function pickNemotron(ids: readonly string[]): string | null {
  for (const preferred of PREFERRED_NEMOTRON) {
    const match = ids.find((id) => id.toLowerCase() === preferred.toLowerCase());
    if (match) return match;
  }
  return ids.find(isNvidiaModel) ?? null;
}

// ---- the completion cap a request carries (D50) --------------------------------------------------------------------

/**
 * The request field Token Factory documents as the bound on what a completion generates, reasoning tokens included.
 * Its `max_tokens`, which the OpenAI-compatible provider writes from `maxOutputTokens`, is documented without them.
 */
export const COMPLETION_CAP_FIELD = "max_completion_tokens";

/** The provider-options key of the model Mastra's router builds for `providerId: "nebius"`. */
const PROVIDER_OPTIONS_KEY = "nebius";

/**
 * A model resolved for Token Factory, with each request's cap sent as `max_completion_tokens` and no `max_tokens`
 * (D50): every call's `maxOutputTokens`, a step's own cap included, moves into the provider's options, which the
 * provider writes into the request body as they are. A call without a cap is passed on unchanged. Methods run on the
 * model itself, as `countAttempts` does it, so Mastra's private fields stay reachable.
 */
export function capCompletionTokens<T extends object>(model: T): T {
  return new Proxy(model, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property !== "doGenerate" && property !== "doStream") return (value as (...a: unknown[]) => unknown).bind(target);
      return (options: unknown, ...rest: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, [withCompletionCap(options), ...rest]);
    },
  });
}

function withCompletionCap(options: unknown): unknown {
  if (!options || typeof options !== "object") return options;
  const { maxOutputTokens, ...call } = options as { maxOutputTokens?: unknown; providerOptions?: Record<string, Record<string, unknown> | undefined> };
  if (typeof maxOutputTokens !== "number") return options;
  const providerOptions = call.providerOptions ?? {};
  return { ...call, providerOptions: { ...providerOptions, [PROVIDER_OPTIONS_KEY]: { ...providerOptions[PROVIDER_OPTIONS_KEY], [COMPLETION_CAP_FIELD]: maxOutputTokens } } };
}
