import { Badge, Button, Checkbox, Group, SegmentedControl, Select, Stack, Text, TextInput } from "@mantine/core";
import type { PreferenceIntent, PreferenceScope } from "@nivra/domain";
import { useState } from "react";
import type { ImportEntryView, PreferencesView, PreferenceView, ProjectView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";

/** What a project's own preference asks for (D23): a default gives way to the repository's conventions; a decision doesn't. */
const INTENTS: Array<{ value: PreferenceIntent; label: string }> = [
  { value: "default", label: "Default for this project" },
  { value: "override", label: "Decision to change existing conventions" },
];
const ORIGIN: Record<PreferenceView["origin"], string> = { entered: "", suggested: " · kept from a suggestion", imported: " · imported" };

/**
 * The engineer's preferences, kept by the app (D21): the only copy, from which each run gets a snapshot when it starts.
 * Only confirmed preferences reach a run: the personal ones, which follow the engineer to every project, and the chosen
 * project's own. An edit or a deletion reaches the next run; a run already going keeps what it was given. A project's
 * own preference is a default unless the person says it is a decision to change the project's conventions (D23).
 * Editing fixes a preference's wording; replacing it is a new decision, and the old one stays as history that no run
 * gets.
 */
export function Preferences({ project, projects, view, onChanged }: { project: ProjectView | null; projects: ProjectView[]; view: PreferencesView | null; onChanged(): void }) {
  const [statement, setStatement] = useState("");
  const [exportScopes, setExportScopes] = useState<{ personal: boolean; projectIds: string[] } | null>(null);
  const [importing, setImporting] = useState<{ previewId: string; entries: ImportEntryView[]; mapping: string[] } | null>(null);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [scope, setScope] = useState<PreferenceScope>("personal");
  const [intent, setIntent] = useState<PreferenceIntent>("default");
  const [editing, setEditing] = useState<{ id: string; text: string; intent: PreferenceIntent; mode: "edit" | "replace" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const records = view?.records ?? [];
  const current = records.filter((record) => record.status !== "superseded");
  const replaced = records.filter((record) => record.status === "superseded");
  const sentTo = (record: PreferenceView) => project !== null && record.status === "confirmed" && (record.scope === "personal" || record.projectId === project.id);
  const sent = records.filter(sentTo).length;
  const scopeLabel = (record: PreferenceView) => (record.scope === "personal" ? "Every project" : `${record.projectLabel ?? "A removed project"} only`);

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
    const own = scope === "project";
    if (await act(() => window.nivra.addPreference(statement, scope, own ? (project?.id ?? null) : null, own ? intent : "default"))) setStatement("");
  }

  async function save() {
    if (!editing) return;
    const saved =
      editing.mode === "edit"
        ? await act(() => window.nivra.editPreference(editing.id, editing.text, editing.intent))
        : await act(() => window.nivra.supersedePreference(editing.id, editing.text, editing.intent));
    if (saved) setEditing(null);
  }

  // Export and import (D23): the scopes are the person's to choose, and so is the project each imported one goes to.
  const confirmed = records.filter((record) => record.status === "confirmed");
  const ownByProject = [...new Map(confirmed.filter((r) => r.projectId !== null).map((r) => [r.projectId!, r.projectLabel ?? "A removed project"])).entries()].map(([id, label]) => ({
    id,
    label,
    count: confirmed.filter((r) => r.projectId === id).length,
  }));

  async function exportChosen() {
    if (!exportScopes) return;
    let note: string | null = null;
    if (
      await act(async () => {
        const result = await window.nivra.exportPreferences(exportScopes);
        if (result.status === "saved") note = `Exported ${result.count} ${result.count === 1 ? "preference" : "preferences"} to ${result.fileName}.`;
      })
    ) {
      setTransfer(note);
      if (note) setExportScopes(null);
    }
  }

  async function chooseImport() {
    setTransfer(null);
    await act(async () => {
      const result = await window.nivra.previewImport();
      // One project with the same name is suggested; none or several are the person's to choose.
      if (result.status === "preview") setImporting({ ...result, mapping: result.entries.map((entry) => (entry.scope === "project" && entry.matches.length === 1 ? entry.matches[0]!.id : "")) });
    });
  }

  async function importChosen() {
    if (!importing) return;
    let note: string | null = null;
    const saved = await act(async () => {
      const result = await window.nivra.importPreferences(
        importing.previewId,
        importing.mapping.map((id) => id || null),
      );
      note = `Imported ${result.added} ${result.added === 1 ? "preference" : "preferences"}${result.skipped ? `; ${result.skipped} skipped` : ""}.`;
    });
    if (saved) {
      setImporting(null);
      setTransfer(note);
    }
  }

  /** What replaced a preference, followed to the one in use; a replacement deleted since is said to be gone. */
  function replacement(record: PreferenceView): string {
    let next = records.find((candidate) => candidate.id === record.supersededBy);
    for (let hops = 0; next && next.status === "superseded" && hops < records.length; hops++) next = records.find((candidate) => candidate.id === next!.supersededBy);
    return next ? `“${next.statement}”` : "a preference since deleted";
  }

  return (
    <Section title="Preferences" description="How you like to work, in your own words. Runs get only the preferences you confirmed here: your personal ones, and the project's own.">
      <Text size="sm" c="var(--nivra-text-2)" data-testid="preferences-summary">
        {project
          ? `Runs on ${project.label} get ${sent} confirmed ${sent === 1 ? "preference" : "preferences"}: your personal ones and this project's own (revision ${view?.revision ?? "…"}).`
          : "Choose a repository to see which preferences its runs get."}
      </Text>
      {current.length > 0 && (
        <Stack gap="xs" data-testid="preference-list">
          {current.map((record) => (
            <Group key={record.id} gap="sm" wrap="nowrap" align="center" data-testid="preference-row" data-preference-id={record.id}>
              {editing?.id === record.id ? (
                <Stack gap={4} style={{ flex: 1 }}>
                  <TextInput
                    value={editing.text}
                    onChange={(event) => setEditing({ ...editing, text: event.currentTarget.value })}
                    aria-label={editing.mode === "edit" ? "Preference" : "Replacement"}
                    data-testid="preference-edit-input"
                  />
                  {record.scope === "project" && (
                    <SegmentedControl
                      size="xs"
                      value={editing.intent}
                      onChange={(value) => setEditing({ ...editing, intent: value as PreferenceIntent })}
                      data={INTENTS}
                      data-testid="preference-edit-intent"
                    />
                  )}
                  {editing.mode === "replace" && (
                    <Text size="xs" c="var(--nivra-text-3)">
                      Replacing keeps this preference as history; runs get only the new one.
                    </Text>
                  )}
                </Stack>
              ) : (
                <Text size="sm" style={{ flex: 1, opacity: project && !sentTo(record) ? 0.55 : 1 }} data-testid="preference-statement">
                  {record.statement}
                </Text>
              )}
              <Badge variant="light" color={record.scope === "personal" ? "blue" : "grape"} style={{ flex: "none" }}>
                {scopeLabel(record)}
              </Badge>
              {record.scope === "project" && (
                <Badge variant="light" color={record.intent === "override" ? "orange" : "gray"} style={{ flex: "none" }} data-testid="preference-intent">
                  {record.intent === "override" ? "Decision" : "Default"}
                </Badge>
              )}
              {record.status !== "confirmed" && (
                <Badge variant="light" color="yellow" style={{ flex: "none" }}>
                  Not confirmed
                </Badge>
              )}
              <Text size="xs" c="var(--nivra-text-3)" style={{ flex: "none", whiteSpace: "nowrap" }} data-testid="preference-revision">
                revision {record.revision}
                {ORIGIN[record.origin]}
                {project && !sentTo(record) ? ` · not sent to ${project.label}` : ""}
              </Text>
              {editing?.id === record.id ? (
                <Group gap={4} wrap="nowrap" style={{ flex: "none" }}>
                  <Button size="xs" onClick={() => void save()} loading={busy} disabled={!editing.text.trim()} data-testid={editing.mode === "edit" ? "preference-save" : "preference-replace-save"}>
                    {editing.mode === "edit" ? "Save" : "Replace"}
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => setEditing(null)} disabled={busy}>
                    Cancel
                  </Button>
                </Group>
              ) : (
                <Group gap={4} wrap="nowrap" style={{ flex: "none" }}>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setEditing({ id: record.id, text: record.statement, intent: record.intent, mode: "edit" })}
                    disabled={busy}
                    title="Fix the wording"
                    data-testid="preference-edit"
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setEditing({ id: record.id, text: record.statement, intent: record.intent, mode: "replace" })}
                    disabled={busy || record.status !== "confirmed"}
                    title="Make a new decision; this one is kept as history"
                    data-testid="preference-replace"
                  >
                    Replace
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
      {scope === "project" && project && (
        <SegmentedControl value={intent} onChange={(value) => setIntent(value as PreferenceIntent)} data={INTENTS} data-testid="preference-intent-choice" />
      )}
      <Text size="xs" c="var(--nivra-text-3)">
        Confirming saves it on this computer. Nivra never adds a preference by itself. A project's default gives way to the repository's own conventions; a
        decision to change them doesn't.
      </Text>
      {replaced.length > 0 && (
        <Stack gap={4} data-testid="preference-replaced">
          <Text size="sm" fw={600}>
            Replaced
          </Text>
          {replaced.map((record) => (
            <Group key={record.id} gap="sm" wrap="nowrap" align="center" data-testid="preference-replaced-row" data-preference-id={record.id}>
              <Text size="xs" c="var(--nivra-text-3)" style={{ flex: 1 }}>
                “{record.statement}” ({scopeLabel(record)}), replaced
                {record.supersededAt ? ` on ${new Date(record.supersededAt).toLocaleString()}` : ""} by {replacement(record)}. No run gets it.
              </Text>
              <Button size="xs" variant="subtle" color="red" onClick={() => void act(() => window.nivra.deletePreference(record.id))} disabled={busy} data-testid="preference-replaced-delete">
                Delete
              </Button>
            </Group>
          ))}
        </Stack>
      )}
      <Group gap="sm">
        <Button
          size="xs"
          variant="default"
          onClick={() => setExportScopes(exportScopes ? null : { personal: true, projectIds: project && ownByProject.some((p) => p.id === project.id) ? [project.id] : [] })}
          disabled={busy || confirmed.length === 0}
          data-testid="preference-export"
        >
          Export…
        </Button>
        <Button size="xs" variant="default" onClick={() => void chooseImport()} disabled={busy} data-testid="preference-import">
          Import…
        </Button>
      </Group>
      {exportScopes && (
        <Stack gap={4} data-testid="preference-export-scopes">
          <Checkbox
            size="xs"
            label={`Your personal preferences (${confirmed.filter((r) => r.scope === "personal").length})`}
            checked={exportScopes.personal}
            onChange={(event) => setExportScopes({ ...exportScopes, personal: event.currentTarget.checked })}
            data-testid="preference-export-personal"
          />
          {ownByProject.map((own) => (
            <Checkbox
              key={own.id}
              size="xs"
              label={`${own.label}'s own (${own.count})`}
              checked={exportScopes.projectIds.includes(own.id)}
              onChange={(event) =>
                setExportScopes({ ...exportScopes, projectIds: event.currentTarget.checked ? [...exportScopes.projectIds, own.id] : exportScopes.projectIds.filter((id) => id !== own.id) })
              }
              data-testid="preference-export-project"
            />
          ))}
          <Text size="xs" c="var(--nivra-text-3)">
            The file holds each preference's wording, scope, project name and intent: no ids, no history and no keys. Keep it somewhere private.
          </Text>
          <Group>
            <Button size="xs" onClick={() => void exportChosen()} loading={busy} disabled={!exportScopes.personal && exportScopes.projectIds.length === 0} data-testid="preference-export-save">
              Export
            </Button>
          </Group>
        </Stack>
      )}
      {importing && (
        <Stack gap={4} data-testid="preference-import-preview">
          <Text size="sm" fw={600}>
            Import {importing.entries.length} {importing.entries.length === 1 ? "preference" : "preferences"}?
          </Text>
          {importing.entries.map((entry, index) => (
            <Group key={index} gap="sm" wrap="nowrap" align="center" data-testid="preference-import-entry">
              <Text size="xs" style={{ flex: 1 }}>
                {entry.statement}
                {entry.duplicate ? " (already here: skipped)" : ""}
              </Text>
              <Badge variant="light" color={entry.scope === "personal" ? "blue" : entry.intent === "override" ? "orange" : "gray"} style={{ flex: "none" }}>
                {entry.scope === "personal" ? "Every project" : `${entry.project}'s ${entry.intent === "override" ? "decision" : "default"}`}
              </Badge>
              {entry.scope === "project" && (
                <Select
                  size="xs"
                  w={200}
                  allowDeselect={false}
                  aria-label={`Project for “${entry.statement}”`}
                  data={[{ value: "", label: "Skip it" }, ...projects.map((p) => ({ value: p.id, label: `${p.label} only` }))]}
                  value={importing.mapping[index] ?? ""}
                  onChange={(value) => setImporting({ ...importing, mapping: importing.mapping.map((id, i) => (i === index ? (value ?? "") : id)) })}
                  error={entry.matches.length > 1 && !importing.mapping[index] ? `Several projects are called ${entry.project}: choose one` : undefined}
                  data-testid="preference-import-project"
                />
              )}
            </Group>
          ))}
          <Group gap={4}>
            <Button size="xs" onClick={() => void importChosen()} loading={busy} data-testid="preference-import-save">
              Import
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setImporting(null)} disabled={busy}>
              Cancel
            </Button>
          </Group>
        </Stack>
      )}
      {transfer && (
        <Text size="sm" c="var(--nivra-text-2)" data-testid="preference-transfer">
          {transfer}
        </Text>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="preference-error">
          {error}
        </Text>
      )}
    </Section>
  );
}
