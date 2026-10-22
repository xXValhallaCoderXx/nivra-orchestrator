import { z } from "zod";
import { RESEARCH_LIMITS } from "./limits.ts";
import type { ExtractedPage, ExtractRequest, RequestEnd, RequestFailure, RequestTiming, Retrieval, Retrieved, SearchHit, SearchRequest } from "./retrieval.ts";

/**
 * Tavily behind the retrieval contract (NIV-45), with `fetch` and nothing else. The key goes in the `Authorization`
 * header only, never in a body and never into an error. Each request is sent at most once: no retry, whatever the
 * answer (a 429's `Retry-After` included). A redirect is never followed. An answer is read only up to its size limit and
 * its deadline, and parsed strictly; Tavily's own words (an error's detail, a failed page's reason) are never kept.
 */

export const TAVILY_BASE_URL = "https://api.tavily.com";

/**
 * What every search and every extract sends besides its query, its addresses and the sites: pinned here, so a live
 * check's approval covers them. Basic depth for both (a search is one credit; an extract one per five pages read), no
 * answer, raw content, images or favicons, and the usage Tavily reports.
 */
export const SEARCH_PARAMETERS = {
  search_depth: "basic",
  topic: "general",
  max_results: RESEARCH_LIMITS.resultsPerSearch,
  include_answer: false,
  include_raw_content: false,
  include_images: false,
  include_favicon: false,
  include_usage: true,
} as const;
export const EXTRACT_PARAMETERS = {
  chunks_per_source: RESEARCH_LIMITS.passagesPerExtraction,
  extract_depth: "basic",
  format: "markdown",
  timeout: RESEARCH_LIMITS.extractTimeoutSeconds,
  include_images: false,
  include_favicon: false,
  include_usage: true,
} as const;

export interface TavilyOptions {
  apiKey: string;
  /** Tests point this at a stub on the loopback; the engine accepts no other. */
  base?: string;
  now?: () => number;
}

/** What Nivra reads of an answer; anything else in it is ignored. Its usage and request id are read apart, leniently. */
const SearchAnswer = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().nullish(), score: z.number().nullish() })).max(50),
});

const ExtractAnswer = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })).max(50),
  failed_results: z.array(z.object({ url: z.string() })).max(50).nullish(),
});

class TooLarge extends Error {}

/** An answer's body, refused once it passes `maxBytes`: by its declared length, or as it arrives. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (!response.headers.has("content-encoding") && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TooLarge();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Why a status means no answer, by kind. */
function statusFailure(status: number): RequestFailure {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 432 || status === 433) return "plan-limit";
  if (status >= 500) return "server";
  return "rejected";
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Credits as reported: a finite, non-negative number, or null. */
function creditsOf(json: unknown): number | null {
  const usage = json && typeof json === "object" ? (json as { usage?: unknown }).usage : undefined;
  const value = usage && typeof usage === "object" ? (usage as { credits?: unknown }).credits : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The service's request id, when it is a plain token Nivra can keep. */
function requestIdOf(json: unknown): string | null {
  const value = json && typeof json === "object" ? (json as { request_id?: unknown }).request_id : undefined;
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}

/** Two addresses for one page: the same scheme, host (any case) and path (with or without its last slash) and query. */
export function sameAddress(a: string, b: string): boolean {
  const key = (address: string) => {
    try {
      const url = new URL(address);
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch {
      return address;
    }
  };
  return key(a) === key(b);
}

export function createTavily(options: TavilyOptions): Retrieval {
  const base = options.base ?? TAVILY_BASE_URL;
  const now = options.now ?? (() => performance.now());
  const L = RESEARCH_LIMITS;

  /** One POST, sent at most once and bounded by its timing; its parsed answer, or why there is none. */
  async function post<T>(path: string, body: Record<string, unknown>, timing: RequestTiming, maxBytes: number, answer: z.ZodType<T>): Promise<{ ok: true; value: T; end: RequestEnd } | { ok: false; failure: RequestFailure; end: RequestEnd }> {
    const started = now();
    const end = (status: number | null, requestId: string | null = null, used: number | null = null): RequestEnd => ({ status, requestId, credits: used, elapsedMs: Math.max(0, Math.round(now() - started)) });
    const until = Math.min(timing.deadlineAt, timing.cutoffAt);
    const ranOut: RequestFailure = timing.cutoffAt <= timing.deadlineAt ? "cutoff" : "deadline";
    // Whole milliseconds, rounded down so the bound holds: with none left, or stopped already, nothing is sent.
    const timeoutMs = Math.floor(until - started);
    if (timing.signal?.aborted || !(timeoutMs >= 1)) return { ok: false, failure: "not-sent", end: end(null) };
    const timeout = AbortSignal.timeout(timeoutMs);
    let status: number | null = null;
    let bytes: Uint8Array;
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        // The same signal cuts off reading the answer below.
        signal: timing.signal ? AbortSignal.any([timeout, timing.signal]) : timeout,
        redirect: "manual",
      });
      status = response.status;
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, failure: statusFailure(response.status), end: end(status) };
      }
      bytes = await readBounded(response, maxBytes);
    } catch (error) {
      if (timing.signal?.aborted) return { ok: false, failure: "cancelled", end: end(status) };
      if (timeout.aborted) return { ok: false, failure: ranOut, end: end(status) };
      if (error instanceof TooLarge) return { ok: false, failure: "too-large", end: end(status) };
      return { ok: false, failure: "network", end: end(status) };
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { ok: false, failure: "malformed", end: end(status, null, null) };
    }
    const parsed = answer.safeParse(json);
    if (!parsed.success) return { ok: false, failure: "malformed", end: end(status, requestIdOf(json), creditsOf(json)) };
    return { ok: true, value: parsed.data, end: end(status, requestIdOf(json), creditsOf(json)) };
  }

  return {
    service: "tavily",

    async search(request: SearchRequest): Promise<Retrieved<{ hits: SearchHit[] }>> {
      const body: Record<string, unknown> = {
        query: request.query,
        ...SEARCH_PARAMETERS,
        ...(request.sites ? { include_domains: [...request.sites.hosts], include_domains_mode: request.sites.mode } : {}),
      };
      const sent = await post("/search", body, request, L.searchBodyBytes, SearchAnswer);
      if (!sent.ok) return sent;
      const hits = sent.value.results.slice(0, L.resultsPerSearch).map((result) => ({ address: result.url, title: result.title ?? "", score: result.score ?? null }));
      return { ok: true, hits, end: sent.end };
    },

    async extract(request: ExtractRequest): Promise<Retrieved<{ pages: ExtractedPage[]; failed: string[] }>> {
      const body = { urls: [...request.addresses], query: request.query, ...EXTRACT_PARAMETERS };
      const sent = await post("/extract", body, request, L.extractBodyBytes, ExtractAnswer);
      if (!sent.ok) return sent;
      // Only pages that were asked for, matched back to the address that was sent; the order Tavily used isn't kept.
      const pages: ExtractedPage[] = [];
      for (const address of request.addresses) {
        const found = sent.value.results.find((result) => sameAddress(result.url, address));
        if (found && typeof found.raw_content === "string") pages.push({ address, content: found.raw_content });
      }
      const failed = request.addresses.filter((address) => !pages.some((page) => page.address === address));
      return { ok: true, pages, failed, end: sent.end };
    },
  };
}
