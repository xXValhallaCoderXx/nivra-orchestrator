import { Alert, Box, Button, Code, Group, Select, Stack, Text, Tooltip } from "@mantine/core";
import { useState } from "react";
import type { EngineView, TargetsView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

const LOOK = {
  online: { dot: "var(--nivra-success)", label: "Engine online" },
  starting: { dot: "var(--nivra-text-3)", label: "Engine starting…" },
  stopped: { dot: "var(--nivra-text-3)", label: "Engine stopped" },
  failed: { dot: "var(--nivra-error-icon)", label: "Engine stopped" },
} as const;

/** The target the engine runs on (D1: always visible where work starts) and the engine's state at a glance. */
export function TargetBar({ targets, engine, onSelected }: { targets: TargetsView | null; engine: EngineView | null; onSelected(): void }) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  async function select(id: string | null) {
    if (!id || id === targets?.selectedId) return;
    setSwitching(true);
    setError(null);
    try {
      await window.nivra.selectTarget(id);
      onSelected();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Group gap="sm" wrap="nowrap">
      <Select
        aria-label="Where the engine runs"
        size="xs"
        w={210}
        data={targets?.targets.map((t) => ({ value: t.id, label: t.label })) ?? []}
        value={targets?.selectedId ?? null}
        onChange={(id) => void select(id)}
        disabled={!targets || switching}
        allowDeselect={false}
        data-testid="target-select"
      />
      <Tooltip label={error ?? detail} multiline maw={460} withArrow>
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

/** What is wrong with the engine or its target, and what to do: shown above the page while it matters. */
export function EngineNotices({ engine, targets }: { engine: EngineView | null; targets: TargetsView | null }) {
  const [restarting, setRestarting] = useState(false);
  const state = engine?.state;
  const wslNote = targets?.wsl && targets.wsl.status !== "ready" ? targets.wsl.message : null;

  async function restart() {
    setRestarting(true);
    try {
      await window.nivra.restartEngine();
    } finally {
      setRestarting(false);
    }
  }

  return (
    <Stack gap="sm">
      {state?.status === "failed" && (
        <Alert color="red" title={`The engine on ${engine!.label} stopped`} data-testid="engine-failed">
          <Stack gap={6}>
            <Text size="sm">{state.reason}</Text>
            {state.logPath && (
              <Text size="xs" c="var(--nivra-text-3)">
                Its log: <Code fz="xs">{state.logPath}</Code>
              </Text>
            )}
            <Group>
              <Button size="xs" variant="default" loading={restarting} onClick={() => void restart()} data-testid="engine-restart">
                Restart engine
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
      {wslNote && (
        <Alert color="gray" variant="light" title="WSL isn't available">
          <Text size="sm">{wslNote}</Text>
        </Alert>
      )}
    </Stack>
  );
}
