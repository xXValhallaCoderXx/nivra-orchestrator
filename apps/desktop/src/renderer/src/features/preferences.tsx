import { Badge, Button, Checkbox, Group, Modal, SegmentedControl, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import type { PreferenceIntent, PreferenceScope } from "@nivra/domain";
import { useEffect, useRef, useState } from "react";
import type { ImportEntryView, ImportSourceView, PreferencesView, PreferenceView, ProjectView } from "../../../shared/ipc";
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
export function Preferences({ active, project, projects, view, onChanged }: { active: boolean; project: ProjectView | null; projects: ProjectView[]; view: PreferencesView | null; onChanged(): void }) {
  const [statement, setStatement] = useState("");
  const [exportScopes, setExportScopes] = useState<{ personal: boolean; projectIds: string[] } | null>(null);
  // What an import would bring, and the person's choices: the file's personal preferences in or out, and where each of
  // its source projects goes ("" leaves it out).
  const [importing, setImporting] = useState<{
    previewId: string;
    personal: ImportEntryView[];
    projects: ImportSourceView[];
    includePersonal: boolean;
    mapping: Record<string, string>;
  } | null>(null);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [scope, setScope] = useState<PreferenceScope>("personal");
  const [intent, setIntent] = useState<PreferenceIntent>("default");
  const [editing, setEditing] = useState<{ id: string; text: string; intent: PreferenceIntent; mode: "edit" | "replace" } | null>(null);
  // A review and its independently written wording stay in this screen's memory, never in saved drafts.
  const [promoting, setPromoting] = useState<{ source: PreferenceView; text: string } | null>(null);
  const [promotionNote, setPromotionNote] = useState<string | null>(null);
  // Settings sections stay mounted while hidden. Leaving this one still discards the promotion review and draft.
  useEffect(() => {
    if (!active) {
      setPromoting(null);
      setPromotionNote(null);
    }
  }, [active]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const records = view?.records ?? [];
  const current = records.filter((record) => record.status !== "superseded");
  const replaced = records.filter((record) => record.status === "superseded");
  const sentTo = (record: PreferenceView) => project !== null && record.status === "confirmed" && (record.scope === "personal" || record.projectId === project.id);
  const sent = records.filter(sentTo).length;
  const scopeLabel = (record: PreferenceView) => (record.scope === "personal" ? "Every project" : `${record.projectLabel ?? "A removed project"} only`);
  const promotionStale = promoting !== null && (!projects.some((p) => p.id === promoting.source.projectId) || !records.some((r) => r.id === promoting.source.id && r.revision === promoting.source.revision && r.status === "confirmed" && r.scope === "project"));

  // Set at once, unlike `busy`, so a quick second click can't repeat a change that already went through.
  const acting = useRef(false);
  async function act(work: () => Promise<unknown>): Promise<boolean> {
    if (acting.current) return false;
    acting.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      acting.current = false;
      setBusy(false);
      onChanged();
    }
  }

  async function confirm() {
    const own = scope === "project";
    if (await act(() => window.nivra.addPreference(statement, scope, own ? (project?.id ?? null) : null, own ? intent : "default"))) {
      setStatement("");
      // A decision is the person's choice each time, never carried over to the next preference.
      setIntent("default");
    }
  }

  async function save() {
    if (!editing) return;
    const saved =
      editing.mode === "edit"
        ? await act(() => window.nivra.editPreference(editing.id, editing.text, editing.intent))
        : await act(() => window.nivra.supersedePreference(editing.id, editing.text, editing.intent));
    if (saved) setEditing(null);
  }

  function closePromotion() {
    if (acting.current) return;
    setPromoting(null);
    setError(null);
  }

  async function promote() {
    if (!promoting || promotionStale) return;
    const { source, text } = promoting;
    let note = "";
    if (await act(async () => {
      const result = await window.nivra.promotePreference(source.id, source.revision, text);
      note = result.created ? "Personal default confirmed for every project. The project original is preserved." : "That personal default is already confirmed for every project. Nothing new was saved.";
    })) {
      setPromoting(null);
      setPromotionNote(note);
    }
  }

  // Export and import (D23): the scopes are the person's to choose, and so is the project each imported one goes to.
  const confirmed = records.filter((record) => record.status === "confirmed");
  /** A project's name, with its folder when another project has the same name, so the two can be told apart. */
  const projectName = (id: string, label: string) => {
    const shared = projects.filter((p) => p.label === label).length > 1;
    const folder = projects.find((p) => p.id === id)?.displayPath;
    return shared && folder ? `${label} (${folder})` : label;
  };
  const ownByProject = [...new Map(confirmed.filter((r) => r.projectId !== null).map((r) => [r.projectId!, r.projectLabel ?? "A removed project"])).entries()].map(([id, label]) => ({
    id,
    label: projectName(id, label),
    count: confirmed.filter((r) => r.projectId === id).length,
  }));
  /** Whether an imported preference is already here, for where it would go now (null: personal): it is then skipped. */
  const alreadyHere = (entry: ImportEntryView, projectId: string | null) =>
    confirmed.some((r) => r.statement === entry.statement.trim() && r.scope === (projectId === null ? "personal" : "project") && r.projectId === projectId && r.intent === entry.intent);
  /** Where a source project's preferences would go now: a chosen project that has gone since leaves them out. */
  const destinationOf = (key: string) => {
    const chosen = importing?.mapping[key] ?? "";
    return projects.some((p) => p.id === chosen) ? chosen : "";
  };
  /**
   * What importing would do with each entry, as the person has chosen so far and as the host will do it: one the store
   * already has, or one an earlier entry of the file already brings to the same place, is skipped.
   */
  const importPlan = (() => {
    if (!importing) return null;
    const coming = new Set<string>();
    const fate = (entry: ImportEntryView, projectId: string | null): "in" | "here" => {
      const key = JSON.stringify([entry.statement.trim(), projectId, entry.intent]);
      if (alreadyHere(entry, projectId) || coming.has(key)) return "here";
      coming.add(key);
      return "in";
    };
    const NOTE = { in: "", here: " (already here: skipped)", out: " (left out)" } as const;
    const personal = importing.personal.map((entry) => NOTE[importing.includePersonal ? fate(entry, null) : "out"]);
    const projectNotes = new Map(
      importing.projects.map((source) => {
        const destination = destinationOf(source.key);
        return [source.key, source.entries.map((entry) => NOTE[destination ? fate(entry, destination) : "out"])] as const;
      }),
    );
    return { personal, projects: projectNotes };
  })();

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
      // A destination is filled in only where the host suggests one; anything ambiguous starts left out.
      if (result.status === "preview") {
        setImporting({ ...result, includePersonal: result.personal.length > 0, mapping: Object.fromEntries(result.projects.map((source) => [source.key, source.suggested ?? ""])) });
      }
    });
  }

  async function importChosen() {
    if (!importing) return;
    let note: string | null = null;
    const saved = await act(async () => {
      const result = await window.nivra.importPreferences(importing.previewId, {
        personal: importing.includePersonal,
        projects: importing.projects.map((source) => ({ source: source.key, project: destinationOf(source.key) || null })),
      });
      note = `${result.added ? `Imported ${result.added} ${result.added === 1 ? "preference" : "preferences"}` : "Nothing imported"}${result.alreadyHere ? `; ${result.alreadyHere} already here` : ""}${result.leftOut ? `; ${result.leftOut} left out` : ""}.`;
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
            <Group key={record.id} gap="sm" wrap="wrap" align="center" data-testid="preference-row" data-preference-id={record.id}>
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
                <Text size="sm" style={{ flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere", opacity: project && !sentTo(record) ? 0.55 : 1 }} data-testid="preference-statement">
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
              <Text size="xs" c="var(--nivra-text-3)" style={{ overflowWrap: "anywhere" }} data-testid="preference-revision">
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
                <Group gap={4} wrap="wrap" justify="flex-end" style={{ flex: "none", maxWidth: 260 }}>
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
                  {record.scope === "project" && record.status === "confirmed" && projects.some((p) => p.id === record.projectId) && (
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => { setPromoting({ source: record, text: "" }); setPromotionNote(null); setError(null); }}
                      disabled={busy}
                      data-testid="preference-promote"
                    >
                      Use in every project
                    </Button>
                  )}
                  <Button size="xs" variant="subtle" color="red" onClick={() => void act(() => window.nivra.deletePreference(record.id))} disabled={busy} data-testid="preference-delete">
                    Delete
                  </Button>
                </Group>
              )}
            </Group>
          ))}
        </Stack>
      )}
      <Modal opened={active && promoting !== null} onClose={closePromotion} title="Use in every project" size="lg" closeOnEscape={!busy} closeOnClickOutside={!busy} withCloseButton={!busy}>
        {promoting && (
          <Stack gap="sm" data-testid="preference-promotion-review">
            <Text size="sm">Review this project preference, then write the personal default you want to use beyond it.</Text>
            <Stack gap={4}>
              <Text size="sm" fw={600} data-testid="preference-promotion-source">{promoting.source.statement}</Text>
              <Text size="xs" c="var(--nivra-text-3)">
                {promoting.source.projectLabel} only · {promoting.source.intent === "override" ? "Decision to change existing conventions" : "Project default"} · revision {promoting.source.revision}
                {ORIGIN[promoting.source.origin] || " · entered by you"}
              </Text>
              {promoting.source.evidence ? (
                <Stack gap={2} data-testid="preference-promotion-evidence">
                  <Text size="xs" c="var(--nivra-text-3)">
                    Historical evidence from run {promoting.source.evidence.runId}, {new Date(promoting.source.evidence.ranAt).toLocaleString()}.
                    {promoting.source.evidence.headAtStart ? ` HEAD: ${promoting.source.evidence.headAtStart}.` : " HEAD was not recorded."} These sources have not been rechecked.
                  </Text>
                  {promoting.source.evidence.citations.map((citation, index) => (
                    <Text key={index} size="xs" style={{ overflowWrap: "anywhere" }}>{citation.path}:{citation.startLine}–{citation.endLine}</Text>
                  ))}
                </Stack>
              ) : <Text size="xs" c="var(--nivra-text-3)">No repository evidence recorded for this preference.</Text>}
            </Stack>
            <Textarea
              label="Personal default"
              description="Write wording suitable for other projects, without source-project paths, private details or code."
              value={promoting.text}
              onChange={(event) => setPromoting({ ...promoting, text: event.currentTarget.value })}
              maxLength={500}
              autosize minRows={2} maxRows={6}
              disabled={busy}
              data-autofocus
              data-testid="preference-promotion-input"
            />
            <Text size="xs" c="var(--nivra-text-3)">
              Confirming makes this your default for every project on this computer. Repository conventions take precedence. The project original and its evidence stay as they are; only your new wording becomes personal.
            </Text>
            {promotionStale && <Text size="sm" c="var(--nivra-error)" role="alert">The source preference changed or is no longer available. Close this dialog and reopen Use in every project to review it again.</Text>}
            {error && <Text size="sm" c="var(--nivra-error)" role="alert" data-testid="preference-promotion-error">{error}</Text>}
            <Group justify="flex-end">
              <Button variant="default" onClick={closePromotion} disabled={busy} data-testid="preference-promotion-cancel">Cancel</Button>
              <Button onClick={() => void promote()} loading={busy} disabled={promotionStale || !promoting.text.trim() || promoting.text.trim().length > 500} data-testid="preference-promotion-confirm">Confirm for every project</Button>
            </Group>
          </Stack>
        )}
      </Modal>
      {promotionNote && <Text size="sm" role="status" data-testid="preference-promotion-note">{promotionNote}</Text>}
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
        <Stack gap={6} data-testid="preference-import-preview">
          <Text size="sm" fw={600}>
            Import from this file?
          </Text>
          {importing.personal.length > 0 && (
            <Stack gap={2} data-testid="preference-import-personal">
              <Checkbox
                size="xs"
                label={`Your personal preferences (${importing.personal.length}): every project would get them`}
                checked={importing.includePersonal}
                onChange={(event) => setImporting({ ...importing, includePersonal: event.currentTarget.checked })}
                data-testid="preference-import-personal-include"
              />
              {importing.personal.map((entry, index) => (
                <Text key={index} size="xs" pl={28} c={importing.includePersonal ? undefined : "var(--nivra-text-3)"} data-testid="preference-import-entry">
                  {entry.statement}
                  {importPlan?.personal[index]}
                </Text>
              ))}
            </Stack>
          )}
          {importing.projects.map((source) => {
            const chosen = destinationOf(source.key);
            return (
              <Stack key={source.key} gap={2} data-testid="preference-import-source">
                <Group gap="sm" wrap="nowrap" align="center">
                  <Text size="xs" fw={600} style={{ flex: 1 }}>
                    From {source.label}
                    {source.sameLabel > 1 ? ` (${source.position} of ${source.sameLabel} projects with this name in the file)` : ""}
                  </Text>
                  <Select
                    size="xs"
                    w={240}
                    allowDeselect={false}
                    aria-label={`Where the preferences from ${source.label}${source.sameLabel > 1 ? ` (${source.position} of ${source.sameLabel})` : ""} go`}
                    data={[{ value: "", label: "Leave them out" }, ...projects.map((p) => ({ value: p.id, label: `${projectName(p.id, p.label)} only` }))]}
                    value={chosen}
                    onChange={(value) => setImporting({ ...importing, mapping: { ...importing.mapping, [source.key]: value ?? "" } })}
                    data-testid="preference-import-project"
                  />
                </Group>
                {!chosen && !source.suggested && (source.sameLabel > 1 || source.matches.length !== 1) && (
                  <Text size="xs" c="var(--nivra-text-3)">
                    {source.sameLabel > 1
                      ? `The file has ${source.sameLabel} projects called ${source.label}: choose where each one's preferences go, or leave them out.`
                      : source.matches.length > 1
                        ? `Several projects here are called ${source.label}: choose one, or leave them out.`
                        : `No project here is called ${source.label}: choose one, or leave them out.`}
                  </Text>
                )}
                {source.entries.map((entry, index) => (
                  <Text key={index} size="xs" pl={28} c={chosen ? undefined : "var(--nivra-text-3)"} data-testid="preference-import-entry">
                    {entry.statement} ({entry.intent === "override" ? "decision" : "default"})
                    {importPlan?.projects.get(source.key)?.[index]}
                  </Text>
                ))}
              </Stack>
            );
          })}
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
