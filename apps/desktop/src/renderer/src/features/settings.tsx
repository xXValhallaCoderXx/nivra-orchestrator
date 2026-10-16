import { Alert, Badge, Button, Code, Group, PasswordInput, Stack, Text } from "@mantine/core";
import type { ProviderCheck } from "@nivra/domain";
import { useEffect, useState } from "react";
import type { SettingsView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";

const KEY_LOOK = {
  none: { label: "No key", color: "gray" },
  encrypted: { label: "Key saved, encrypted", color: "green" },
  unencrypted: { label: "Key saved, unencrypted", color: "yellow" },
  unreadable: { label: "Key can't be read here", color: "red" },
} as const;

/** The Nebius key, kept by the app (D8): encrypted by the OS where it can be, and handed to the engine in memory only. */
export function Settings({ projectId, online, targetLabel }: { projectId: string | null; online: boolean; targetLabel: string | null }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [check, setCheck] = useState<ProviderCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.nivra.getSettings().then(setSettings, (reason: unknown) => setError(errorMessage(reason)));
  }, []);

  async function runCheck() {
    if (!projectId) return;
    setChecking(true);
    setError(null);
    setCheck(null);
    try {
      setCheck(await window.nivra.checkTokenFactory(projectId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setChecking(false);
    }
  }

  async function save(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await window.nivra.setNebiusKey(value));
      setKey("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Nebius Token Factory" description="Your API key, for Nemotron models and Token Factory Sandboxes.">
      <Group gap="sm" align="flex-end">
        <PasswordInput
          label="API key"
          placeholder={settings && settings.nebiusKey !== "none" ? "A key is saved; enter a new one to replace it" : "Paste your Token Factory API key"}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          w={380}
          data-testid="nebius-key"
        />
        <Button onClick={() => void save(key.trim())} loading={busy} disabled={key.trim().length < 8}>
          Save
        </Button>
        {settings && settings.nebiusKey !== "none" && (
          <Button variant="subtle" color="red" onClick={() => void save(null)} disabled={busy}>
            Remove
          </Button>
        )}
        {settings && (
          <Badge variant="light" color={KEY_LOOK[settings.nebiusKey].color} data-testid="nebius-key-state">
            {KEY_LOOK[settings.nebiusKey].label}
          </Badge>
        )}
      </Group>
      <Group gap="sm">
        <Button
          variant="default"
          onClick={() => void runCheck()}
          loading={checking}
          disabled={!projectId || !online || !settings || (settings.nebiusKey !== "encrypted" && settings.nebiusKey !== "unencrypted")}
          data-testid="tokenfactory-check"
        >
          {targetLabel ? `Check Token Factory from ${targetLabel}` : "Check Token Factory (choose a folder first)"}
        </Button>
      </Group>
      {check && (
        <Stack gap={4} data-testid="tokenfactory-result">
          <Text size="sm">
            {check.models.total} models for this key; NVIDIA: {check.models.nvidia.length ? check.models.nvidia.join(", ") : "none"}.
          </Text>
          {check.call && (
            <Text size="sm">
              <Code fz="xs">{check.call.model}</Code> {check.call.toolCalled ? "called the tool and answered" : "answered without the tool"} in {check.call.elapsedMs} ms
              {check.call.inputTokens !== null ? ` (${check.call.inputTokens} in, ${check.call.outputTokens ?? "?"} out tokens)` : ""}: “{check.call.answer}”
            </Text>
          )}
          {check.problem && (
            <Text size="sm" c="var(--nivra-warning)">
              {check.problem}
            </Text>
          )}
        </Stack>
      )}
      {settings?.note && (
        <Alert color="yellow" variant="light" data-testid="nebius-key-note">
          <Stack gap={0}>
            <Text size="sm">{settings.note}</Text>
          </Stack>
        </Alert>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)">
          {error}
        </Text>
      )}
    </Section>
  );
}
