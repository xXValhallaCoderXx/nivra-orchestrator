import { Alert, Button, Group, List, Modal, Stack, Text } from "@mantine/core";
import { useRef, useState } from "react";
import type { ProjectView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

/**
 * Adding and removing repositories (PN1, PN3). Folders come from the native picker in main; the renderer never names a
 * path (D1), and each folder runs where it is kept (D17). Adding is started from the switcher's "Add project…" or from
 * General's Home; the result is the new project in view with a note, the project already listed opened with a note, or a
 * refusal in a dialog that says what to do. A warning that came with an added folder stays until it is dismissed.
 */

export type AddOutcome = { project: ProjectView; alreadyListed: boolean; warning: string | null };

export function useAddProject({ projects, onAdded, onChanged }: { projects: ProjectView[]; onAdded(outcome: AddOutcome): void; onChanged(): void }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const listed = useRef(projects);
  listed.current = projects;

  async function add() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const before = new Set(listed.current.map((p) => p.id));
    try {
      const result = await window.nivra.addProject();
      if (result.status === "added") onAdded({ project: result.project, alreadyListed: before.has(result.project.id), warning: result.warning });
      else if (result.status === "refused") setRefusal(result.reason);
      onChanged();
    } catch (reason) {
      setRefusal(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Modal opened={refusal !== null} onClose={() => setRefusal(null)} title="Nivra can't add this folder" centered data-testid="project-add-refused">
      <Stack gap="md">
        <Text size="sm" data-testid="project-add-refusal">
          {refusal}
        </Text>
        <Text size="sm" c="var(--nivra-text-2)">
          Nothing was added.
        </Text>
        <Group justify="flex-end" gap="sm" className="nivra-dialog-actions">
          <Button variant="default" onClick={() => setRefusal(null)}>
            Close
          </Button>
          <Button onClick={() => void add()} loading={busy} data-testid="project-add-again">
            Choose another folder…
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { add, busy, dialog };
}

/** A warning that came with an added folder (a Windows folder picked through WSL, say): shown in full until dismissed. */
export function AddedWarning({ project, text, onDismiss }: { project: ProjectView | null; text: string; onDismiss(): void }) {
  return (
    <Alert color="yellow" variant="light" withCloseButton closeButtonLabel="Dismiss" onClose={onDismiss} title={project ? `About ${project.label}` : undefined} data-testid="project-add-notice">
      <Text size="sm">{text}</Text>
    </Alert>
  );
}

/** Something to tell the person about this project this session (it moved to another engine, say). */
export function ProjectNotice({ project }: { project: ProjectView }) {
  if (!project.notice) return null;
  return (
    <Alert color="yellow" variant="light" data-testid="project-notice">
      <Text size="sm">{project.notice}</Text>
    </Alert>
  );
}

/**
 * Removing a project from the list (PN3), after a confirmation whose only action is the removal (R13): Cancel has the
 * focus. The host stops the project's work first and refuses, saying why, when it can't; nothing touches the folder.
 * While a hello or explain run of this window goes, the button waits for it to end, as before.
 */
export function RemoveProject({ project, running, onRemoved }: { project: ProjectView; running: boolean; onRemoved(label: string, preferencesRemoved: number): void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const { preferencesRemoved } = await window.nivra.removeProject(project.id);
      setOpen(false);
      onRemoved(project.label, preferencesRemoved);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Group gap="sm" align="center">
        <Button variant="outline" color="red" onClick={() => setOpen(true)} disabled={running} data-testid="project-remove">
          Remove from Nivra…
        </Button>
        <Text size="xs" c="var(--nivra-text-3)">
          {running ? "Cancel its run before removing it." : "Takes it off the list. The folder stays as it is."}
        </Text>
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title={`Remove ${project.label} from Nivra?`} centered data-testid="project-remove-dialog">
        <Stack gap="sm">
          <Text size="sm" fw={600}>
            What goes
          </Text>
          <List size="sm" spacing={4}>
            <List.Item>{project.label} leaves the list, with its own preferences. Your personal preferences stay.</List.Item>
            <List.Item>Its work going now stops first: explanations, research, the sandbox check, a task run, the environment's preparation and the coach.</List.Item>
          </List>
          <Text size="sm" fw={600}>
            What stays
          </Text>
          <List size="sm" spacing={4}>
            <List.Item>The folder and everything in it: Nivra doesn't touch it.</List.Item>
            <List.Item>Its tasks and conversations, marked as from a project no longer in the list.</List.Item>
            <List.Item>What was already sent to Token Factory or Nebius.</List.Item>
          </List>
          {error && (
            <Alert color="red" variant="light" data-testid="project-remove-error">
              <Text size="sm">{error}</Text>
            </Alert>
          )}
          <Group justify="flex-end" gap="sm" mt="sm" className="nivra-dialog-actions">
            <Button variant="default" onClick={() => setOpen(false)} data-autofocus>
              Cancel
            </Button>
            <Button variant="outline" color="red" loading={busy} onClick={() => void remove()} data-testid="project-remove-confirm">
              Remove {project.label}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
