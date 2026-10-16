import { Badge, Button, Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import type { RunEvent, RunStatus } from "@nivra/domain";
import { useEffect, useState } from "react";
import { errorMessage, Section } from "../shared/ui";

const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
const STATUS_COLOR: Record<RunStatus, string> = {
  queued: "gray",
  running: "blue",
  waiting_for_approval: "yellow",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
};

/**
 * The bootstrap's harmless run (B2): where the engine is, the repository, git's version and status, then optionally a
 * held process, so Cancel can be seen to stop it. The timeline is polled by cursor (Hird D8).
 */
export function HelloRun({ projectId, online }: { projectId: string | null; online: boolean }) {
  const [hold, setHold] = useState("0");
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await window.nivra.runEvents(runId, after);
        if (!active) return;
        after = page.next;
        if (page.events.length) setEvents((current) => [...current, ...page.events]);
        setStatus(page.status);
        if (TERMINAL.includes(page.status)) return;
      } catch (reason) {
        if (active) setError(errorMessage(reason));
      }
      if (active) timer = setTimeout(() => void poll(), 400);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId]);

  async function start() {
    if (!projectId) return;
    setStarting(true);
    setError(null);
    setEvents([]);
    setStatus(null);
    try {
      const run = await window.nivra.startHello(projectId, Number(hold) * 1000);
      setRunId(run.id);
      setStatus(run.status);
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
    <Section title="Hello run" description="Checks the engine, the repository and git without changing anything.">
      <Group gap="sm" align="center">
        <Text size="sm">Hold a process for</Text>
        <SegmentedControl size="xs" value={hold} onChange={setHold} data={[{ value: "0", label: "0 s" }, { value: "5", label: "5 s" }, { value: "60", label: "60 s" }]} />
        <Button onClick={() => void start()} loading={starting} disabled={!projectId || !online || running} data-testid="hello-start">
          Run hello
        </Button>
        {running && (
          <Button variant="default" onClick={() => void cancel()} data-testid="hello-cancel">
            Cancel
          </Button>
        )}
        {status && (
          <Badge color={STATUS_COLOR[status]} variant="light" data-testid="hello-status">
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
