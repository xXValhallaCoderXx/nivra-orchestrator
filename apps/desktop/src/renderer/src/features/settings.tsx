import { Alert, Badge, Button, Code, Group, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
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

/**
 * The Nebius key, and the project id Nebius Sandboxes needs with it (D36), kept by the app (D8): encrypted by the OS
 * where it can be, and handed to the engine in memory only. `onCredentialsSaved` follows each save, once the engines
 * have them.
 */
export function Settings({ projectId, online, targetLabel, onCredentialsSaved }: { projectId: string | null; online: boolean; targetLabel: string | null; onCredentialsSaved(): void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [check, setCheck] = useState<ProviderCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [key, setKey] = useState("");
  const [nebiusProject, setNebiusProject] = useState("");
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
      onCredentialsSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveProject(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await window.nivra.setNebiusProjectId(value));
      setNebiusProject("");
      onCredentialsSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Nebius Token Factory" description="Your API key, for Nemotron models and Token Factory Sandboxes, and the project id Sandboxes needs with it.">
      <Group gap="sm" align="flex-end">
        <PasswordInput
          label="API key"
          placeholder={settings && settings.nebiusKey !== "none" ? "A key is saved; enter a new one to replace it" : "Paste your Token Factory API key"}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          w={380}
          data-testid="nebius-key"
        />
        <Button onClick={() => void save(key.trim())} loading={busy} disabled={key.trim().length < 8} data-testid="nebius-key-save">
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
      <Group gap="sm" align="flex-end">
        <TextInput
          label="Project id, for Sandboxes"
          placeholder={settings?.nebiusProjectId === "set" ? "A project id is saved; enter a new one to replace it" : "Paste your Nebius project id"}
          value={nebiusProject}
          onChange={(event) => setNebiusProject(event.currentTarget.value)}
          w={380}
          data-testid="nebius-project-id"
        />
        <Button onClick={() => void saveProject(nebiusProject.trim())} loading={busy} disabled={nebiusProject.trim().length < 8} data-testid="nebius-project-id-save">
          Save
        </Button>
        {settings?.nebiusProjectId === "set" && (
          <Button variant="subtle" color="red" onClick={() => void saveProject(null)} disabled={busy}>
            Remove
          </Button>
        )}
        {settings && (
          <Badge variant="light" color={settings.nebiusProjectId === "set" ? "green" : "gray"} data-testid="nebius-project-id-state">
            {settings.nebiusProjectId === "set" ? "Project id saved" : "No project id"}
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
          {check.endpoint === "loopback-test" && (
            <Text size="sm" c="var(--nivra-warning)">
              This engine sends model requests to a test endpoint on this machine, not Token Factory.
            </Text>
          )}
          <Text size="sm">
            {check.models.total} models for this key; NVIDIA: {check.models.nvidia.length ? check.models.nvidia.join(", ") : "none"}.
          </Text>
          {check.call && (
            <Text size="sm">
              <Code fz="xs">{check.call.model}</Code> {check.call.toolCalled ? "called the tool and answered" : "answered without the tool"} in {check.call.elapsedMs} ms: “
              {check.call.answer}”
            </Text>
          )}
          {check.call && (
            <Text size="sm" c="var(--nivra-text-2)" data-testid="tokenfactory-findings">
              {check.call.inputTokens !== null && check.call.outputTokens !== null
                ? `Usage reported: ${check.call.inputTokens} in, ${check.call.outputTokens} out tokens.`
                : "Usage not reported."}{" "}
              Context length: {check.models.contextLength !== null ? `${check.models.contextLength.toLocaleString()} tokens` : "not reported"}.
              {check.probes
                ? ` Required tool choice: ${check.probes.requiredToolChoice}. Forced choice between two tools: ${check.probes.forcedToolChoice}. Answer schema, forced: ${check.probes.answerSchema}.`
                : ""}{" "}
              Rate limit:{" "}
              {check.call.rateLimit.remainingTokens !== null ? `${check.call.rateLimit.remainingTokens.toLocaleString()} tokens left` : "remaining tokens not reported"}
              {check.call.rateLimit.resetTokensSeconds !== null ? `, resets in ${check.call.rateLimit.resetTokensSeconds} s` : ""}
              {check.call.rateLimit.belowPauseThreshold ? " (low enough that each step will pause 10 s)" : ""}.
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
