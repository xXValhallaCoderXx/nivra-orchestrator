import { Accordion, Alert, Badge, Button, Group, List, Stack, Table, Text, Textarea, TextInput } from "@mantine/core";
import type { ExplainResult, RunSummary } from "@nivra/domain";
import { useEffect, useState } from "react";
import type { PreferencesView, ProjectView } from "../../../shared/ipc";
import { CitationChip, ConflictItem, CONSENT_COVERS, ConsentModal, ContextDetails, linesByFile, preferenceText, runLine, STATUS_COLOR } from "../shared/evidence";
import { TERMINAL, useRunEvents, type RunRef } from "../shared/runs";
import { errorMessage, Section } from "../shared/ui";

/** Timeline entries worth showing for an explanation. */
const SHOWN = new Set(["run.queued", "run.started", "run.succeeded", "run.failed", "run.cancelled", "run.interrupted", "step.output", "model.call", "tool.called"]);

/** The most choices one explanation can carry, and the longest each can be: the domain's limits (D23). */
const MAX_CHOICES = 5;
const MAX_CHOICE_CHARS = 300;

/**
 * One suggestion from the run (D23), not saved. Keep opens the usual field, filled with the suggestion and editable:
 * what is saved, as this project's own default, is the wording the person confirms. It shows as kept only while the
 * preference it became is in use, read from the store: one replaced or deleted since can be kept again.
 */
function SuggestionItem({
  suggestion,
  index,
  projectId,
  runId,
  preferences,
  onKept,
}: {
  suggestion: ExplainResult["suggestions"][number];
  index: number;
  projectId: string | null;
  runId: string;
  preferences: PreferencesView | null;
  onKept(): void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = preferences?.records.find((record) => record.status === "confirmed" && record.evidence?.runId === runId && record.evidence.suggestion === index) ?? null;

  async function keep() {
    if (text === null || !projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.nivra.keepSuggestion(projectId, runId, index, text);
      setText(null);
      onKept();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap={4} data-testid="explain-suggestion">
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
        {suggestion.statement}
      </Text>
      <Group gap={4}>
        {suggestion.citations.map((citation, i) => (
          <CitationChip key={i} citation={citation} />
        ))}
      </Group>
      {kept ? (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-suggestion-kept">
          Kept as this project's own default: “{kept.statement}”.
        </Text>
      ) : text === null ? (
        <Group>
          <Button size="xs" variant="default" onClick={() => setText(suggestion.statement)} disabled={!projectId} data-testid="explain-suggestion-keep">
            Keep for this project
          </Button>
        </Group>
      ) : (
        <Group gap={4} wrap="nowrap" align="center">
          <TextInput value={text} onChange={(event) => setText(event.currentTarget.value)} maxLength={500} style={{ flex: 1 }} aria-label="Preference to keep" data-testid="explain-suggestion-input" />
          <Button size="xs" onClick={() => void keep()} loading={busy} disabled={!text.trim()} data-testid="explain-suggestion-confirm">
            Confirm
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setText(null)} disabled={busy}>
            Cancel
          </Button>
        </Group>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="explain-suggestion-error">
          {error}
        </Text>
      )}
    </Stack>
  );
}

/**
 * What an answer without established findings is labelled (NIV-26): it isn't an explanation with evidence, so it is
 * never shown as one. Null for one that is, and for a result stored before this was recorded.
 */
function standingNote(standing: ExplainResult["standing"] | undefined): { badge: string; text: string } | null {
  if (standing === "no-findings") {
    return {
      badge: "no findings",
      text: "No findings established. The model answered without citing anything it read in this repository, so this isn't an explanation with evidence; its summary is below as it wrote it. Explain again, or ask a narrower question.",
    };
  }
  if (standing === "unsupported") {
    return {
      badge: "not supported",
      text: "None of these findings is established: each cites only lines the model wasn't shown before it answered. Explain again, or ask a narrower question.",
    };
  }
  return null;
}

function Result({
  result,
  summary,
  preferences,
  projectId,
  onPreferencesChanged,
}: {
  result: ExplainResult;
  summary: RunSummary;
  preferences: PreferencesView | null;
  projectId: string | null;
  onPreferencesChanged(): void;
}) {
  const headChanged = result.headAtEnd !== result.headAtStart;
  return (
    <Stack gap="sm" data-testid="explain-result">
      <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-head">
        HEAD at run start: {result.headAtStart ? result.headAtStart.slice(0, 12) : "no commits yet"} · read as the files were on disk, at {new Date(result.finishedAt).toLocaleString()}
      </Text>
      {result.choices.length > 0 && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-result-choices">
          Choices for this task: {result.choices.map((choice) => `${choice.id} “${choice.text}”`).join("; ")}
        </Text>
      )}
      {headChanged && (
        <Alert color="yellow" variant="light">
          <Text size="sm">
            HEAD changed during the run ({result.headAtStart?.slice(0, 12) ?? "none"} → {result.headAtEnd?.slice(0, 12) ?? "none"}). Some of what was read may come from either.
          </Text>
        </Alert>
      )}
      {result.context.changedFiles.length > 0 && (
        <Alert color="yellow" variant="light">
          <Text size="sm">These files changed while the run read them, so citations into them aren't checked: {result.context.changedFiles.join(", ")}.</Text>
        </Alert>
      )}
      {standingNote(result.standing) && (
        <Alert color="yellow" variant="light" data-testid="explain-standing" data-standing={result.standing ?? undefined}>
          <Text size="sm">{standingNote(result.standing)?.text}</Text>
        </Alert>
      )}
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }} data-testid="explain-summary">
        {result.summary}
      </Text>
      {result.findings.length > 0 && (
        <Stack gap={6}>
          {result.findings.map((finding, index) => (
            <Stack key={index} gap={4} data-testid="explain-finding">
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {finding.statement}
              </Text>
              <Group gap={4}>
                {finding.citations.length ? finding.citations.map((citation, i) => <CitationChip key={i} citation={citation} />) : <Text size="xs" c="var(--nivra-text-3)">No citation</Text>}
              </Group>
            </Stack>
          ))}
        </Stack>
      )}
      {result.conflicts.length > 0 && (
        <Stack gap={8} data-testid="explain-conflicts">
          <Text size="sm" fw={600}>
            Conflicts
          </Text>
          {result.conflicts.map((conflict, index) => (
            <ConflictItem key={index} conflict={conflict} choices={result.choices} preferences={preferences} />
          ))}
        </Stack>
      )}
      {result.preferenceDifferences.length > 0 && (
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Where this repository differs from your preferences (the repository wins here)
          </Text>
          {result.preferenceDifferences.map((difference, index) => {
            const wording = preferenceText(preferences, difference.preferenceId, difference.revision);
            return (
              <Stack key={index} gap={4} data-testid="explain-preference-difference">
                <Text size="sm" c={wording.current ? undefined : "var(--nivra-text-3)"}>
                  {wording.current ? `Your preference: ${wording.text}` : `${wording.text.charAt(0).toUpperCase()}${wording.text.slice(1)}.`}
                </Text>
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                  This repository: {difference.repositoryConvention}
                </Text>
                <Group gap={4}>
                  {difference.citations.map((citation, i) => (
                    <CitationChip key={i} citation={citation} />
                  ))}
                </Group>
              </Stack>
            );
          })}
        </Stack>
      )}
      {result.suggestions.length > 0 && (
        <Stack gap={6} data-testid="explain-suggestions">
          <Text size="sm" fw={600}>
            Suggested preferences (not saved)
          </Text>
          <Text size="xs" c="var(--nivra-text-3)">
            Conventions the model saw in this repository, each with the lines it was shown. Keeping one saves your wording as this project's own default.
          </Text>
          {result.suggestions.map((suggestion, index) => (
            <SuggestionItem key={index} suggestion={suggestion} index={index} projectId={projectId} runId={summary.id} preferences={preferences} onKept={onPreferencesChanged} />
          ))}
        </Stack>
      )}
      {result.gaps.length > 0 && (
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            Not established
          </Text>
          <List size="sm">
            {result.gaps.map((gap, index) => (
              <List.Item key={index}>{gap}</List.Item>
            ))}
          </List>
        </Stack>
      )}
      <Accordion variant="contained" chevronPosition="left" data-testid="explain-context-panel">
        <Accordion.Item value="context">
          <Accordion.Control>
            <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-context">
              Context used: {result.context.reads.length} {result.context.reads.length === 1 ? "file" : "files"} read ({linesByFile(result.context.reads) || "none"}),{" "}
              {result.context.searches} {result.context.searches === 1 ? "search" : "searches"} with {result.context.searchHits} {result.context.searchHits === 1 ? "hit" : "hits"}
              {result.context.hits.length > 0 ? ` (${linesByFile(result.context.hits)})` : ""}, the map from{" "}
              {result.context.map.map((m) => m.path).join(", ") || "file counts only"};{" "}
              {result.context.chars.toLocaleString()} characters of results. {result.checks.checked} of {result.checks.citations} citations point to lines the model was shown. Untracked files are never read.
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <ContextDetails context={result.context} choices={result.choices} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-run-line">
        {runLine(summary)}
      </Text>
    </Stack>
  );
}

/**
 * Explain the repository with evidence (NIV-6, NIV-9): a question (or the default), the project's consent to send
 * excerpts to Token Factory (D20, asked once), a live timeline, and the answer. The answer is model output, so it is
 * shown as plain text only; each citation says whether its lines were shown to the model before it answered.
 */
export function Explain({
  project,
  online,
  preferences,
  run,
  onRun,
  onSharingChanged,
  onPreferencesChanged,
}: {
  project: ProjectView | null;
  online: boolean;
  preferences: PreferencesView | null;
  run: RunRef | null;
  onRun(projectId: string, ref: RunRef): void;
  onSharingChanged(): void;
  /** A suggestion was kept, so the window reads the preferences again. */
  onPreferencesChanged(): void;
}) {
  const [question, setQuestion] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(run?.runId ?? null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ summary: RunSummary; result: ExplainResult | null } | null>(null);
  const { events, status, error: pollError } = useRunEvents(runId, online, run?.status ?? null);
  const projectId = project?.id ?? null;
  const running = status !== null && !TERMINAL.includes(status);

  useEffect(() => {
    if (projectId && runId && status) onRun(projectId, { runId, status });
    if (!runId || !status || !TERMINAL.includes(status) || !online) return;
    let active = true;
    window.nivra.runResult(runId).then(
      (value) => active && setOutcome(value),
      (reason: unknown) => active && setError(errorMessage(reason)),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, status, online]);

  async function start() {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      // A choice row left empty is no choice. It is dropped from the form too, so each row's id (c1, c2, …) is the id
      // the run and its conflicts use; everything typed goes to main, which says what to fix.
      const sent = choices.filter((choice) => choice.trim());
      setChoices(sent);
      const started = await window.nivra.startExplain(projectId, question.trim(), sent);
      setRunId(started.id);
      onRun(projectId, { runId: started.id, status: started.status });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function allowAndStart() {
    if (!projectId) return;
    setConsent(false);
    try {
      await window.nivra.setSharing(projectId, true);
      onSharingChanged();
      await start();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function turnOff() {
    if (!projectId) return;
    try {
      await window.nivra.setSharing(projectId, false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      // Sharing is off even when a run couldn't be stopped, so the view must say so.
      onSharingChanged();
    }
  }

  const failed = [...events].reverse().find((event) => event.type === "run.failed" || event.type === "run.interrupted");
  return (
    <Section title="Explain" description="Ask about the repository. Nivra reads it with NVIDIA Nemotron on Nebius Token Factory and cites the lines it read.">
      <Textarea
        placeholder="For example: where is the timer implemented? Leave empty to explain the stack, structure and conventions."
        value={question}
        onChange={(event) => setQuestion(event.currentTarget.value)}
        autosize
        minRows={2}
        maxRows={6}
        maxLength={2_000}
        data-testid="explain-question"
      />
      <Stack gap={4} data-testid="explain-choices">
        <Text size="sm" fw={500}>
          Choices for this task
        </Text>
        <Text size="xs" c="var(--nivra-text-3)">
          Decisions for this explanation only, such as “Keep Jest for this task”. They come before the repository and your preferences, and they aren't saved.
        </Text>
        {choices.map((choice, index) => (
          <Group key={index} gap={4} wrap="nowrap">
            <Text size="xs" c="var(--nivra-text-3)" w={20}>
              c{index + 1}
            </Text>
            <TextInput
              value={choice}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setChoices((all) => all.map((other, i) => (i === index ? value : other)));
              }}
              maxLength={MAX_CHOICE_CHARS}
              style={{ flex: 1 }}
              aria-label={`Choice ${index + 1}`}
              data-testid="explain-choice"
            />
            <Button size="xs" variant="subtle" onClick={() => setChoices((all) => all.filter((_, i) => i !== index))} data-testid="explain-choice-remove">
              Remove
            </Button>
          </Group>
        ))}
        <Group>
          <Button size="xs" variant="default" onClick={() => setChoices((all) => [...all, ""])} disabled={choices.length >= MAX_CHOICES} data-testid="explain-choice-add">
            Add a choice
          </Button>
        </Group>
      </Stack>
      <Group gap="sm">
        <Button
          onClick={() => (project?.sharing.modelContext ? void start() : setConsent(true))}
          loading={busy}
          disabled={!projectId || !online || running}
          data-testid="explain-start"
        >
          Explain
        </Button>
        {running && runId && (
          <Button variant="default" onClick={() => void window.nivra.cancelRun(runId).catch((reason: unknown) => setError(errorMessage(reason)))} disabled={!online} data-testid="explain-cancel">
            Cancel
          </Button>
        )}
        {status && (
          <Badge
            color={status === "succeeded" && standingNote(outcome?.result?.standing) ? "yellow" : STATUS_COLOR[status]}
            variant="light"
            data-testid="explain-status"
            data-run-id={runId ?? undefined}
          >
            {(status === "succeeded" && standingNote(outcome?.result?.standing)?.badge) || status.replaceAll("_", " ")}
          </Badge>
        )}
        {project?.sharing.modelContext && (
          <Group gap={4}>
            <Badge variant="light" color="blue" style={{ textTransform: "none" }} data-testid="explain-sharing">
              Sharing with Token Factory: on
            </Badge>
            <Button size="compact-xs" variant="subtle" onClick={() => void turnOff()} data-testid="explain-sharing-off">
              Turn off
            </Button>
          </Group>
        )}
      </Group>
      {!projectId && (
        <Text size="sm" c="var(--nivra-text-3)">
          Add or choose a repository first.
        </Text>
      )}
      {(error ?? pollError) && (
        <Text size="sm" c="var(--nivra-error)" data-testid="explain-error">
          {error ?? pollError}
        </Text>
      )}
      {status === "failed" && failed && (
        <Alert color="red" variant="light" data-testid="explain-failure">
          <Text size="sm">{failed.message}</Text>
        </Alert>
      )}
      {events.length > 0 && (
        <Table data-testid="explain-timeline">
          <Table.Tbody>
            {events
              .filter((event) => SHOWN.has(event.type))
              .map((event) => (
                <Table.Tr key={event.seq}>
                  <Table.Td w={90}>
                    <Text size="xs" c="var(--nivra-text-3)" ff="monospace">
                      {new Date(event.at).toLocaleTimeString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={event.type.endsWith("failed") ? "var(--nivra-error)" : undefined}>
                      {event.message}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
          </Table.Tbody>
        </Table>
      )}
      {outcome?.result && <Result result={outcome.result} summary={outcome.summary} preferences={preferences} projectId={projectId} onPreferencesChanged={onPreferencesChanged} />}
      <ConsentModal
        opened={consent}
        onClose={() => setConsent(false)}
        onAllow={() => void allowAndStart()}
        intro={`To explain ${project?.label ?? "this repository"}, Nivra sends Nebius Token Factory:`}
        sends={["excerpts and paths from the project's tracked files;", "your question, and any choices you added for this task;", "your confirmed preferences that apply to this project."]}
        after={CONSENT_COVERS}
        testId="explain-consent"
      />
    </Section>
  );
}
