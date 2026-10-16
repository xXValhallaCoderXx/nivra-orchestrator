import { Badge, Button, Group, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import type { PreferenceScope } from "@nivra/domain";
import { useState } from "react";
import type { PreferencesView, PreferenceView, ProjectView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";

/**
 * The engineer's preferences, kept by the app (D21): the only copy, from which each run gets a snapshot when it starts.
 * Only confirmed preferences reach a run: the personal ones, which follow the engineer to every project, and the chosen
 * project's own. An edit or a deletion reaches the next run; a run already going keeps what it was given.
 */
export function Preferences({ project, view, onChanged }: { project: ProjectView | null; view: PreferencesView | null; onChanged(): void }) {
  const [statement, setStatement] = useState("");
  const [scope, setScope] = useState<PreferenceScope>("personal");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const records = view?.records ?? [];
  const sentTo = (record: PreferenceView) => project !== null && record.status === "confirmed" && (record.scope === "personal" || record.projectId === project.id);
  const sent = records.filter(sentTo).length;

  async function act(work: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function confirm() {
    if (await act(() => window.nivra.addPreference(statement, scope, scope === "project" ? (project?.id ?? null) : null))) setStatement("");
  }

  async function save() {
    if (editing && (await act(() => window.nivra.editPreference(editing.id, editing.text)))) setEditing(null);
  }

  return (
    <Section title="Preferences" description="How you like to work, in your own words. Runs get only the preferences you confirmed here: your personal ones, and the project's own.">
      <Text size="sm" c="var(--nivra-text-2)" data-testid="preferences-summary">
        {project
          ? `Runs on ${project.label} get ${sent} confirmed ${sent === 1 ? "preference" : "preferences"}: your personal ones and this project's own (revision ${view?.revision ?? "…"}).`
          : "Choose a repository to see which preferences its runs get."}
      </Text>
      {records.length > 0 && (
        <Stack gap="xs" data-testid="preference-list">
          {records.map((record) => (
            <Group key={record.id} gap="sm" wrap="nowrap" align="center" data-testid="preference-row" data-preference-id={record.id}>
              {editing?.id === record.id ? (
                <TextInput
                  value={editing.text}
                  onChange={(event) => setEditing({ id: record.id, text: event.currentTarget.value })}
                  style={{ flex: 1 }}
                  aria-label="Preference"
                  data-testid="preference-edit-input"
                />
              ) : (
                <Text size="sm" style={{ flex: 1, opacity: project && !sentTo(record) ? 0.55 : 1 }} data-testid="preference-statement">
                  {record.statement}
                </Text>
              )}
              <Badge variant="light" color={record.scope === "personal" ? "blue" : "grape"} style={{ flex: "none" }}>
                {record.scope === "personal" ? "Every project" : `${record.projectLabel ?? "A removed project"} only`}
              </Badge>
              {record.status !== "confirmed" && (
                <Badge variant="light" color="yellow" style={{ flex: "none" }}>
                  Not confirmed
                </Badge>
              )}
              <Text size="xs" c="var(--nivra-text-3)" style={{ flex: "none", whiteSpace: "nowrap" }} data-testid="preference-revision">
                revision {record.revision}
                {project && !sentTo(record) ? ` · not sent to ${project.label}` : ""}
              </Text>
              {editing?.id === record.id ? (
                <Group gap={4} wrap="nowrap" style={{ flex: "none" }}>
                  <Button size="xs" onClick={() => void save()} loading={busy} disabled={!editing.text.trim()} data-testid="preference-save">
                    Save
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => setEditing(null)} disabled={busy}>
                    Cancel
                  </Button>
                </Group>
              ) : (
                <Group gap={4} wrap="nowrap" style={{ flex: "none" }}>
                  <Button size="xs" variant="subtle" onClick={() => setEditing({ id: record.id, text: record.statement })} disabled={busy} data-testid="preference-edit">
                    Edit
                  </Button>
                  <Button size="xs" variant="subtle" color="red" onClick={() => void act(() => window.nivra.deletePreference(record.id))} disabled={busy} data-testid="preference-delete">
                    Delete
                  </Button>
                </Group>
              )}
            </Group>
          ))}
        </Stack>
      )}
      <Group gap="sm" align="flex-end">
        <TextInput
          label="New preference"
          placeholder="For example: prefer named exports over default exports"
          value={statement}
          onChange={(event) => setStatement(event.currentTarget.value)}
          style={{ flex: 1, minWidth: 260 }}
          data-testid="preference-input"
        />
        <SegmentedControl
          value={scope}
          onChange={(value) => setScope(value as PreferenceScope)}
          data={[
            { value: "personal", label: "Every project" },
            { value: "project", label: project ? `${project.label} only` : "This project only", disabled: !project },
          ]}
          data-testid="preference-scope"
        />
        <Button onClick={() => void confirm()} loading={busy} disabled={!statement.trim() || (scope === "project" && !project)} data-testid="preference-confirm">
          Confirm
        </Button>
      </Group>
      <Text size="xs" c="var(--nivra-text-3)">
        Confirming saves it on this computer. Nivra never adds a preference by itself.
      </Text>
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="preference-error">
          {error}
        </Text>
      )}
    </Section>
  );
}
