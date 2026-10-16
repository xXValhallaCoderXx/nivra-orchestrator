import { Alert, Button, Code, Group, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { ProjectView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";

/** The repositories on the current target. Folders come from the native picker in main; the renderer never names a path (D1). */
export function Projects({
  projects,
  selectedId,
  onSelect,
  onChanged,
  targetLabel,
}: {
  projects: ProjectView[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onChanged(): void;
  targetLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ color: "yellow" | "red"; text: string } | null>(null);
  const selected = projects.find((p) => p.id === selectedId) ?? null;

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
    if (!selected) return;
    await window.nivra.removeProject(selected.id);
    onSelect(null);
    onChanged();
  }

  return (
    <Section title="Repository" description={`Folders on ${targetLabel}. The engine reads them where they are; nothing is copied.`}>
      <Group gap="sm" align="flex-end">
        <Select
          label="Project"
          placeholder={projects.length ? "Choose a repository" : "No repositories on this target yet"}
          data={projects.map((p) => ({ value: p.id, label: p.label }))}
          value={selectedId}
          onChange={onSelect}
          w={320}
          data-testid="project-select"
        />
        <Button variant="default" onClick={() => void add()} loading={busy} data-testid="project-add">
          Add folder…
        </Button>
        {selected && (
          <Button variant="subtle" color="red" onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </Group>
      {selected && (
        <Text size="xs" c="var(--nivra-text-3)">
          <Code fz="xs">{selected.displayPath}</Code>
        </Text>
      )}
      {notice && (
        <Alert color={notice.color} variant="light">
          <Stack gap={0}>
            <Text size="sm">{notice.text}</Text>
          </Stack>
        </Alert>
      )}
    </Section>
  );
}
