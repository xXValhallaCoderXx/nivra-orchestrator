import { Alert, Badge, Box, Button, Code, Group, Stack, Text, Tooltip } from "@mantine/core";
import { useState } from "react";
import type { EngineView, ProjectView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

const LOOK = {
  online: { dot: "var(--nivra-success)", label: "Engine online" },
  starting: { dot: "var(--nivra-text-3)", label: "Engine starting…" },
  stopped: { dot: "var(--nivra-text-3)", label: "Engine stopped" },
  failed: { dot: "var(--nivra-error-icon)", label: "Engine stopped" },
} as const;

/**
 * Where the chosen project's work runs (D1: always visible where work starts) and its engine's state at a glance.
 * There is nothing to choose: the folder decides (D17).
 */
export function EngineBadge({ project, engine }: { project: ProjectView | null; engine: EngineView | null }) {
  if (!project) {
    return (
      <Text size="xs" c="var(--nivra-text-3)" data-testid="engine-badge">
        No folder chosen
      </Text>
    );
  }
  const state = engine?.state;
  const look = state ? LOOK[state.status] : { dot: "var(--nivra-text-3)", label: "Engine…" };
  const detail = !state
    ? "Checking the engine…"
    : state.status === "online"
      ? `Engine ${state.info.engineVersion} on ${state.info.platform}/${state.info.arch}, Node ${state.info.node} · data in ${state.info.home}`
      : state.status === "starting"
        ? state.detail
        : state.status === "failed"
          ? state.reason
          : "The engine isn't running.";
  return (
    <Group gap="sm" wrap="nowrap">
      <Badge variant="light" color="gray" data-testid="engine-target">
        {project.targetLabel}
      </Badge>
      <Tooltip label={detail} multiline maw={460} withArrow>
        <Group gap={6} wrap="nowrap">
          <Box w={8} h={8} bg={look.dot} style={{ borderRadius: "50%", flex: "none" }} />
          <Text size="xs" c="var(--nivra-text-2)" style={{ whiteSpace: "nowrap" }} data-testid="engine-badge">
            {look.label}
          </Text>
        </Group>
      </Tooltip>
    </Group>
  );
}

/** What is wrong with the chosen project's engine, and what to do: shown above the page while it matters. */
export function EngineNotices({ projectId, engine }: { projectId: string; engine: EngineView | null }) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = engine?.state;

  async function restart() {
    setRestarting(true);
    setError(null);
    try {
      await window.nivra.restartEngine(projectId);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <Stack gap="sm">
      {state?.status === "failed" && (
        <Alert color="red" title={`The engine on ${engine!.label} isn't running`} data-testid="engine-failed">
          <Stack gap={6}>
            <Text size="sm">{state.reason}</Text>
            {state.logPath && (
              <Text size="xs" c="var(--nivra-text-3)">
                Its log: <Code fz="xs">{state.logPath}</Code>
              </Text>
            )}
            {error && (
              <Text size="sm" c="var(--nivra-error)">
                {error}
              </Text>
            )}
            <Group>
              {/* No log means the engine never got as far as starting (a distribution that can't run it): look again. */}
              <Button size="xs" variant="default" loading={restarting} onClick={() => void restart()} data-testid="engine-restart">
                {state.logPath ? "Restart engine" : "Check again"}
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {state?.status === "starting" && (
        <Text size="sm" c="var(--nivra-text-2)" data-testid="engine-starting">
          {state.detail}
        </Text>
      )}
      {engine?.warnings.map((warning) => (
        <Alert key={warning} color="yellow" variant="light">
          <Text size="sm">{warning}</Text>
        </Alert>
      ))}
    </Stack>
  );
}
