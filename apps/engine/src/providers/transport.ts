import { Agent, setGlobalDispatcher } from "undici";

/**
 * How long the engine's fetch waits for a reply's headers, and between the parts of its body (NIV-35). Mastra's
 * `generate` doesn't stream, so a model's reply has its headers only once its whole answer is ready, and Node's own
 * fetch gives up after 300 s: a task request may take 830 s. Every request still has its own, shorter deadline (each
 * model call, Nebius, Tavily and the model listing set one), so this only keeps fetch from cutting one off first.
 */
export const FETCH_HEADERS_MS = 15 * 60_000;

/** Node's fetch as the engine uses it: undici's own agent, with `waitMs` in place of its 300 s waits. */
export const engineDispatcher = (waitMs = FETCH_HEADERS_MS): Agent => new Agent({ headersTimeout: waitMs, bodyTimeout: waitMs });

/**
 * Makes every fetch in this process wait `waitMs` (D22's deadlines stay each request's own). The engine does this once,
 * at start, before any request; undici's global dispatcher is the one Node's own fetch reads.
 */
export function useEngineTransport(waitMs = FETCH_HEADERS_MS): Agent {
  const dispatcher = engineDispatcher(waitMs);
  setGlobalDispatcher(dispatcher);
  return dispatcher;
}
