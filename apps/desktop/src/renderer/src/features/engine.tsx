import { Alert, Badge, Box, Button, Code, Group, Stack, Text, Tooltip } from "@mantine/core";
import { useState } from "react";
import type { EngineView, ProjectView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

const LOOK = {
  online: { dot: "var(--nivra-success)", label: "Engine online" },
  starting: { dot: "var(--nivra-text-3)", label: "Engine starting…" },
  stopped: { dot: "var(--nivra-text-3)", label: "Engine stopped" },
  failed: { dot: "var(--nivra-error-icon)", label: "Engine failed" },
} as const;

/** An engine's state at a glance: a dot and a word, with the details on hover. */
export function EngineDot({ engine, stoppedLabel, testId }: { engine: EngineView | null; stoppedLabel?: string; testId: string }) {
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
    <Tooltip label={detail} multiline maw={460} withArrow>
      <Group gap={6} wrap="nowrap">
        <Box w={8} h={8} bg={look.dot} style={{ borderRadius: "50%", flex: "none" }} />
        <Text size="xs" c="var(--nivra-text-2)" style={{ whiteSpace: "nowrap" }} data-testid={testId}>
          {state?.status === "stopped" && stoppedLabel ? stoppedLabel : look.label}
        </Text>
      </Group>
    </Tooltip>
  );
}

/**
 * Where the project in view runs (D1: always visible where work starts), its folder, and its engine's state in words
 * (PN2), under the project's name on its Home. There is nothing to choose: the folder decides (D17). General has no
 * folder, and says so.
 */
export function EngineBadge({ project, engine }: { project: ProjectView | null; engine: EngineView | null }) {
  if (!project) {
    return (
      <Text size="xs" c="var(--nivra-text-3)" data-testid="engine-badge">
        No folder chosen
      </Text>
    );
  }
  return (
    <Group gap="sm" wrap="wrap" align="center">
      <Badge variant="outline" color="gray" radius="sm" c="var(--mantine-color-text)" style={{ borderColor: "var(--nivra-border)" }} data-testid="engine-target">
        {project.targetLabel}
      </Badge>
      <Code fz="xs" style={{ background: "transparent", color: "var(--nivra-text-2)", padding: 0, overflowWrap: "anywhere" }} data-testid="engine-path">
        {project.displayPath}
      </Code>
      <EngineDot engine={engine} testId="engine-badge" />
    </Group>
  );
}

/**
 * What is wrong with an engine, and what to do: shown above the page, or a conversation, while it matters. `onRestart`
 * restarts the engine it is about: a project's, or a conversation's own.
 */
export function EngineNotices({ engine, onRestart, testId = "engine" }: { engine: EngineView | null; onRestart(): Promise<unknown>; testId?: string }) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = engine?.state;

  async function restart() {
    setRestarting(true);
    setError(null);
    try {
      await onRestart();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <Stack gap="sm">
      {state?.status === "failed" && (
        <Alert color="red" title={`The engine on ${engine!.label} isn't running`} data-testid={`${testId}-failed`}>
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
              <Button size="xs" variant="default" loading={restarting} onClick={() => void restart()} data-testid={`${testId}-restart`}>
                {state.logPath ? "Restart engine" : "Check again"}
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {state?.status === "starting" && (
        <Text size="sm" c="var(--nivra-text-2)" data-testid={`${testId}-starting`}>
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
