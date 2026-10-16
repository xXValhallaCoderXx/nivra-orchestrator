import { Alert, Badge, Button, Code, Group, PasswordInput, Stack, Text } from "@mantine/core";
import type { ProviderCheck } from "@nivra/domain";
import { useEffect, useState } from "react";
import type { SettingsView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";

/** The Nebius key, kept by the app (D8): encrypted by the OS where it can be, and handed to the engine in memory only. */
export function Settings({ online, targetLabel }: { online: boolean; targetLabel: string }) {
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
    setChecking(true);
    setError(null);
    setCheck(null);
    try {
      setCheck(await window.nivra.checkTokenFactory());
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
          placeholder={settings?.nebiusKey.set ? "A key is saved; enter a new one to replace it" : "Paste your Token Factory API key"}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          w={380}
          data-testid="nebius-key"
        />
        <Button onClick={() => void save(key.trim())} loading={busy} disabled={key.trim().length < 8}>
          Save
        </Button>
        {settings?.nebiusKey.set && (
          <Button variant="subtle" color="red" onClick={() => void save(null)} disabled={busy}>
            Remove
          </Button>
        )}
        {settings && (
          <Badge variant="light" color={settings.nebiusKey.set ? "green" : "gray"}>
            {settings.nebiusKey.set ? "Key saved" : "No key"}
          </Badge>
        )}
      </Group>
      <Group gap="sm">
        <Button variant="default" onClick={() => void runCheck()} loading={checking} disabled={!online || !settings?.nebiusKey.set} data-testid="tokenfactory-check">
          Check Token Factory from {targetLabel}
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
      {settings?.keyStorageNote && (
        <Alert color="yellow" variant="light">
          <Stack gap={0}>
            <Text size="sm">{settings.keyStorageNote}</Text>
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
