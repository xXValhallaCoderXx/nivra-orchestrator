import { Alert, Button, Group, Modal, PasswordInput, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import type { SettingsView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

/**
 * The Nebius key and project ID, asked for where a task needs them (NIV-56, G3: P1d), through the same calls Settings
 * makes. Neither is ever shown back: the fields start empty, and a saved one reads only as saved. Nothing typed here is
 * kept anywhere but the secret store: closing with something typed asks first, and then forgets it.
 */
export function KeyPrompt({ opened, settings, onClose, onSaved }: { opened: boolean; settings: SettingsView | null; onClose(): void; onSaved(): void }) {
  const [key, setKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ key: string | null; projectId: string | null }>({ key: null, projectId: null });
  const [leaving, setLeaving] = useState(false);
  const needsKey = settings === null || settings.nebiusKey === "none" || settings.nebiusKey === "unreadable";
  const needsProjectId = settings === null || settings.nebiusProjectId === "none";
  const typed = key !== "" || projectId !== "";

  // Each opening starts empty: what was typed before was forgotten when the dialog closed.
  useEffect(() => {
    if (!opened) return;
    setKey("");
    setProjectId("");
    setErrors({ key: null, projectId: null });
    setLeaving(false);
  }, [opened]);

  const close = () => {
    setKey("");
    setProjectId("");
    setLeaving(false);
    onClose();
  };
  // Esc, the close button or Cancel: with something typed, ask first; it's never kept as a draft.
  const askClose = () => (typed && !busy ? setLeaving(true) : busy ? undefined : close());

  async function save() {
    setBusy(true);
    const failed: { key: string | null; projectId: string | null } = { key: null, projectId: null };
    // Two calls, each refused with its own words: a key saved stays saved if the project ID is refused.
    if (key.trim() !== "") {
      try {
        await window.nivra.setNebiusKey(key.trim());
        setKey("");
      } catch (reason) {
        failed.key = errorMessage(reason);
      }
    }
    if (projectId.trim() !== "") {
      try {
        await window.nivra.setNebiusProjectId(projectId.trim());
        setProjectId("");
      } catch (reason) {
        failed.projectId = errorMessage(reason);
      }
    }
    setBusy(false);
    setErrors(failed);
    onSaved();
    if (failed.key === null && failed.projectId === null) close();
  }

  const wants = (needsKey && key.trim() === "") || (needsProjectId && projectId.trim() === "");
  return (
    <Modal opened={opened} onClose={askClose} title="Add your Nebius key and project ID" size="lg" data-testid="key-prompt">
      <Stack gap="sm">
        <Text size="sm">The worker reaches Token Factory with the key, and the run happens in Nebius Sandboxes in your project, so the key needs access to that project.</Text>
        <PasswordInput
          label="Nebius API key"
          description={needsKey ? (settings?.nebiusKey === "unreadable" ? "The key saved before can't be read on this computer. Paste it again." : "Not added yet.") : "A key is saved. Enter a new one only to replace it."}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          error={errors.key}
          data-autofocus
          autoComplete="off"
          data-testid="key-prompt-key"
        />
        <PasswordInput
          label="Nebius project ID"
          description={needsProjectId ? "Not added yet. Sandboxes run in this project." : "A project ID is saved. Enter a new one only to replace it."}
          value={projectId}
          onChange={(event) => setProjectId(event.currentTarget.value)}
          error={errors.projectId}
          autoComplete="off"
          data-testid="key-prompt-project-id"
        />
        <Stack gap={2}>
          <Text size="sm" fw={500}>
            Where they're kept
          </Text>
          <Text size="sm" c="var(--nivra-text-2)" data-testid="key-prompt-kept">
            {settings?.keychain === "unavailable"
              ? "This computer has no keychain Nivra can use, so the key would be kept unencrypted in Nivra's settings, where anyone with access to your account could read it. The project ID is kept there too."
              : "The key is kept on this computer, encrypted by your system's keychain, and never shown again. The project ID is kept with Nivra's settings on this computer."}
          </Text>
          <Text size="xs" c="var(--nivra-text-3)">
            Saving sends nothing. In Settings › Connections you can change or remove either one, or check the key with Token Factory, which makes a few paid calls.
          </Text>
        </Stack>
        {leaving && (
          <Alert color="yellow" variant="light" role="alertdialog" aria-label="Close without saving?" data-testid="key-prompt-leaving">
            <Stack gap="xs">
              <Text size="sm">Close without saving? What you typed isn't kept anywhere.</Text>
              <Group gap="sm">
                <Button size="xs" variant="default" onClick={() => setLeaving(false)} data-testid="key-prompt-stay">
                  Keep typing
                </Button>
                <Button size="xs" color="red" variant="light" onClick={close} data-testid="key-prompt-discard">
                  Close without saving
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={askClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!typed || wants} data-testid="key-prompt-save">
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
