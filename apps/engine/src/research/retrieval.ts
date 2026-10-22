/**
 * Retrieval for research (NIV-45): a small contract any web search service can stand behind, and Tavily does first.
 * Search finds pages for one approved query; Extract reads selected passages from chosen pages, ranked against that
 * same query. Nothing here decides what to ask: the queries and the addresses come from the run, which takes them from
 * the person's approval and from Search's own results.
 *
 * Every request ends as a value, never a throw: either its answer, or why it has none, by kind, with what the service
 * reported about it. A failed request is never retried here or anywhere: a run makes each request at most once.
 */

/** Why a request ended without an answer. The same kinds as the report's `ResearchRequestFailure`. */
export type RequestFailure =
  | "auth"
  | "rate-limit"
  | "plan-limit"
  | "rejected"
  | "server"
  | "redirect"
  | "deadline"
  | "cutoff"
  | "too-large"
  | "malformed"
  | "network"
  | "not-sent"
  | "no-answer"
  | "cancelled"
  | "model"
  | "interrupted";

/** What the service said about a request, whatever its end: null wherever it said nothing. */
export interface RequestEnd {
  /** The HTTP status it answered with; null when no answer came. */
  status: number | null;
  /** The service's own id for the request, when it gave one Nivra can safely keep. */
  requestId: string | null;
  /** Credits as the service reported them; null when it didn't. Never converted to money. */
  credits: number | null;
  elapsedMs: number;
}

export type Retrieved<T> = ({ ok: true } & T & { end: RequestEnd }) | { ok: false; failure: RequestFailure; end: RequestEnd };

/**
 * When a request must end: the earlier of its own limit and the run's retrieval cutoff, on the monotonic clock. Which
 * one fired says whether it ran out of its own time or the run's.
 */
export interface RequestTiming {
  deadlineAt: number;
  cutoffAt: number;
  /** The person's stop, or the run's. */
  signal?: AbortSignal;
}

export interface SearchRequest extends RequestTiming {
  query: string;
  sites: { mode: "prefer" | "restrict"; hosts: readonly string[] } | null;
}

/** One page Search found. Its snippet isn't kept: only Extract's passages may reach the model. */
export interface SearchHit {
  address: string;
  title: string;
  score: number | null;
}

export interface ExtractRequest extends RequestTiming {
  query: string;
  addresses: readonly string[];
}

/** A page Extract read: its selected chunks, joined by `CHUNK_SEPARATOR`, as the service returned them. */
export interface ExtractedPage {
  address: string;
  content: string;
}

export interface Retrieval {
  /** Which service answers, for the report's route and the person's words. */
  readonly service: "tavily";
  search(request: SearchRequest): Promise<Retrieved<{ hits: SearchHit[] }>>;
  extract(request: ExtractRequest): Promise<Retrieved<{ pages: ExtractedPage[]; failed: string[] }>>;
}

/** How Tavily joins the chunks it selects from one page, when Extract is given a query. */
export const CHUNK_SEPARATOR = "[...]";
