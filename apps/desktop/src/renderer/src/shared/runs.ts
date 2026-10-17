import type { RunEvent, RunStatus } from "@nivra/domain";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./ui";

export const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];

/**
 * Follows one run's timeline by cursor (Hird D8), only while its own engine is online: main routes every call about a
 * run to the engine that runs it, and the page pauses while that engine is offline instead of asking another (D17).
 * Stops once the run has ended; backs off while the engine doesn't answer.
 */
export function useRunEvents(runId: string | null, online: boolean, initialStatus: RunStatus | null) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const following = useRef<string | null>(null);

  useEffect(() => {
    if (following.current !== runId) {
      following.current = runId;
      cursor.current = 0;
      setEvents([]);
      setStatus(runId ? initialStatus : null);
      setError(null);
    }
    if (!runId || !online) return;
    let active = true;
    let delay = 400;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await window.nivra.runEvents(runId, cursor.current);
        if (!active) return;
        cursor.current = page.next;
        if (page.events.length) setEvents((current) => [...current, ...page.events]);
        setStatus(page.status);
        setError(null);
        delay = 400;
        if (TERMINAL.includes(page.status)) return;
      } catch (reason) {
        if (!active) return;
        setError(errorMessage(reason));
        delay = Math.min(delay * 2, 5_000);
      }
      if (active) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, online]);

  return { events, status, error };
}
