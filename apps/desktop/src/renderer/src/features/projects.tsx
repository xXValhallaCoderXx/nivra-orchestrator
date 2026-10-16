import { Alert, Badge, Button, Code, Group, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { ProjectView, WslView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";
import { WslGuidance } from "./wsl";

/**
 * Every repository, each on the engine its folder belongs to (D17). Folders come from the native picker in main; the
 * renderer never names a path (D1).
 */
export function Projects({
  projects,
  selectedId,
  onSelect,
  onChanged,
  busyIds,
  wsl,
  onWslChecked,
}: {
  projects: ProjectView[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onChanged(): void;
  /** Projects with a run going, which can't be removed until it ends. */
  busyIds: readonly string[];
  wsl: WslView | null;
  onWslChecked(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ color: "yellow" | "red"; text: string } | null>(null);
  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const running = selected ? busyIds.includes(selected.id) : false;

  async function add() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.nivra.addProject();
      if (result.status === "added") {
        onSelect(result.project.id);
        if (result.warning) setNotice({ color: "yellow", text: result.warning });
      } else if (result.status === "refused") {
        setNotice({ color: "red", text: result.reason });
      }
      onChanged();
    } catch (reason) {
      setNotice({ color: "red", text: errorMessage(reason) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected || running) return;
    setNotice(null);
    try {
      const { preferencesRemoved } = await window.nivra.removeProject(selected.id);
      if (preferencesRemoved) {
        setNotice({ color: "yellow", text: `Removed ${selected.label} from the list, with its ${preferencesRemoved} own ${preferencesRemoved === 1 ? "preference" : "preferences"}. Your personal preferences stay.` });
      }
      onSelect(null);
      onChanged();
    } catch (reason) {
      setNotice({ color: "red", text: errorMessage(reason) });
    }
  }

  return (
    <Section
      title="Repositories"
      description="Each folder runs where it is kept: a folder inside a WSL distribution runs there, one on a Windows drive runs on Windows. Nothing is copied."
    >
      <Group gap="sm" align="flex-end">
        <Select
          label="Project"
          placeholder={projects.length ? "Choose a repository" : "No repositories yet"}
          data={projects.map((p) => ({ value: p.id, label: p.label }))}
          value={selected?.id ?? null}
          onChange={onSelect}
          renderOption={({ option }) => (
            <Group justify="space-between" w="100%" wrap="nowrap" gap="md">
              <Text size="sm">{option.label}</Text>
              <Text size="xs" c="var(--nivra-text-3)">
                {projects.find((p) => p.id === option.value)?.targetLabel}
              </Text>
            </Group>
          )}
          w={320}
          data-testid="project-select"
        />
        {selected && (
          <Badge variant="light" color="gray" mb={6} data-testid="project-target">
            {selected.targetLabel}
          </Badge>
        )}
        <Button variant="default" onClick={() => void add()} loading={busy} data-testid="project-add">
          Add folder…
        </Button>
        {selected && (
          <Button variant="subtle" color="red" onClick={() => void remove()} disabled={running} data-testid="project-remove">
            Remove
          </Button>
        )}
      </Group>
      {selected && (
        <Text size="xs" c="var(--nivra-text-3)">
          <Code fz="xs">{selected.displayPath}</Code>
          {running ? " · cancel its run before removing it" : ""}
        </Text>
      )}
      {selected?.notice && (
        <Alert color="yellow" variant="light" data-testid="project-notice">
          <Text size="sm">{selected.notice}</Text>
        </Alert>
      )}
      {notice && (
        <Alert color={notice.color} variant="light" data-testid="project-add-notice">
          <Stack gap={0}>
            <Text size="sm">{notice.text}</Text>
          </Stack>
        </Alert>
      )}
      {wsl && <WslGuidance wsl={wsl} onChecked={onWslChecked} />}
    </Section>
  );
}
