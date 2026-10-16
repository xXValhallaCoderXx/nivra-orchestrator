import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { WslView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

const TITLE: Record<Exclude<WslView["status"], "ready" | "checking">, string> = {
  missing: "WSL isn't installed",
  "inbox-only": "WSL needs an update",
  broken: "WSL isn't answering",
  "no-usable-distribution": "WSL has no distribution Nivra can use",
};

/**
 * What WSL can offer on Windows, and what to do when it offers nothing (D17). Shown, never hidden: a folder inside a
 * distribution needs it, and folders on Windows drives keep working without it.
 */
export function WslGuidance({ wsl, onChecked }: { wsl: WslView; onChecked(): void }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      await window.nivra.checkWsl();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setChecking(false);
      onChecked();
    }
  }

  if (wsl.status === "checking") return null;
  if (wsl.status === "ready") {
    // Usable distributions exist; any that can't be used still say why.
    const problems = wsl.distros.filter((d) => d.problem);
    return problems.length ? (
      <Stack gap={2} data-testid="wsl-distro-problems">
        {problems.map((d) => (
          <Text key={d.name} size="xs" c="var(--nivra-text-3)">
            {d.problem}
          </Text>
        ))}
      </Stack>
    ) : null;
  }
  return (
    <Alert color="gray" variant="light" title={TITLE[wsl.status]} data-testid="wsl-guidance" data-status={wsl.status}>
      <Stack gap={6}>
        <Text size="sm">{wsl.message}</Text>
        {error && (
          <Text size="sm" c="var(--nivra-error)">
            {error}
          </Text>
        )}
        <Group>
          <Button size="xs" variant="default" loading={checking} onClick={() => void check()} data-testid="wsl-check">
            Check again
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
