import { Badge, Button, Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import type { RunEvent, RunStatus } from "@nivra/domain";
import { useEffect, useRef, useState } from "react";
import type { ProjectView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";

export const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
const STATUS_COLOR: Record<RunStatus, string> = {
  queued: "gray",
  running: "blue",
  waiting_for_approval: "yellow",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
};

/** The last run started for a project, as far as the page knows. */
export interface RunRef {
  runId: string;
  status: RunStatus | null;
}

/**
 * The bootstrap's harmless run (B2): where the engine is, the repository, git's version and status, then optionally a
 * held process, so Cancel can be seen to stop it. The timeline is polled by cursor (Hird D8), only from the run's own
 * engine: main routes every call about a run to the engine that runs it, and the page pauses while that engine is
 * offline instead of asking another (D17).
 */
export function HelloRun({ project, online, run, onRun }: { project: ProjectView | null; online: boolean; run: RunRef | null; onRun(projectId: string, ref: RunRef): void }) {
  const [hold, setHold] = useState("0");
  const [runId, setRunId] = useState<string | null>(run?.runId ?? null);
  const [status, setStatus] = useState<RunStatus | null>(run?.status ?? null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const cursor = useRef(0);
  const projectId = project?.id ?? null;

  useEffect(() => {
    if (!runId || !online || !projectId) return;
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
        onRun(projectId, { runId, status: page.status });
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
  }, [runId, online, projectId]);

  async function start() {
    if (!projectId) return;
    setStarting(true);
    setError(null);
    setEvents([]);
    setStatus(null);
    cursor.current = 0;
    try {
      const started = await window.nivra.startHello(projectId, Number(hold) * 1000);
      setRunId(started.id);
      setStatus(started.status);
      onRun(projectId, { runId: started.id, status: started.status });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!runId) return;
    try {
      await window.nivra.cancelRun(runId);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const running = status !== null && !TERMINAL.includes(status);
  return (
    <Section
      title="Hello run"
      description={project ? `Checks the engine on ${project.targetLabel}, the repository and git, without changing anything.` : "Checks the engine, the repository and git without changing anything."}
    >
      <Group gap="sm" align="center">
        <Text size="sm">Hold a process for</Text>
        <SegmentedControl size="xs" value={hold} onChange={setHold} data={[{ value: "0", label: "0 s" }, { value: "5", label: "5 s" }, { value: "60", label: "60 s" }]} />
        <Button onClick={() => void start()} loading={starting} disabled={!projectId || !online || running} data-testid="hello-start">
          Run hello
        </Button>
        {running && (
          <Button variant="default" onClick={() => void cancel()} disabled={!online} data-testid="hello-cancel">
            Cancel
          </Button>
        )}
        {status && (
          <Badge color={STATUS_COLOR[status]} variant="light" data-testid="hello-status" data-run-id={runId ?? undefined}>
            {status.replaceAll("_", " ")}
          </Badge>
        )}
      </Group>
      {!projectId && (
        <Text size="sm" c="var(--nivra-text-3)">
          Add or choose a repository first.
        </Text>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)">
          {error}
        </Text>
      )}
      {events.length > 0 && (
        <Table data-testid="hello-timeline">
          <Table.Tbody>
            {events.map((event) => (
              <Table.Tr key={event.seq}>
                <Table.Td w={90}>
                  <Text size="xs" c="var(--nivra-text-3)" ff="monospace">
                    {new Date(event.at).toLocaleTimeString()}
                  </Text>
                </Table.Td>
                <Table.Td w={120}>
                  <Text size="xs" c="var(--nivra-text-2)">
                    {event.stepId ?? event.type.split(".")[0]}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Stack gap={0}>
                    <Text size="sm" c={event.type.endsWith("failed") ? "var(--nivra-error)" : undefined}>
                      {event.message}
                    </Text>
                  </Stack>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Section>
  );
}
