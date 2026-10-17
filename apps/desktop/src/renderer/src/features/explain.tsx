import { Alert, Badge, Button, Group, List, Modal, Stack, Table, Text, Textarea } from "@mantine/core";
import type { CheckedCitation, ExplainResult, RunStatus, RunSummary } from "@nivra/domain";
import { useEffect, useState } from "react";
import type { PreferencesView, ProjectView } from "../../../shared/ipc";
import { TERMINAL, useRunEvents } from "../shared/runs";
import { errorMessage, Section } from "../shared/ui";
import type { RunRef } from "./hello";

const STATUS_COLOR: Record<RunStatus, string> = { queued: "gray", running: "blue", waiting_for_approval: "yellow", succeeded: "green", failed: "red", cancelled: "gray" };
/** Timeline entries worth showing for an explanation. */
const SHOWN = new Set(["run.queued", "run.started", "run.succeeded", "run.failed", "run.cancelled", "run.interrupted", "step.output", "model.call", "tool.called"]);

const usageText = (summary: RunSummary): string => {
  const usage = summary.usage;
  if (!usage || usage.calls === 0) return "tokens not reported";
  if (usage.inputTokens !== null && usage.outputTokens !== null) return `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`;
  return usage.reportedCalls ? `tokens partly reported (${usage.reportedCalls} of ${usage.calls} calls)` : "tokens not reported";
};

function CitationChip({ citation }: { citation: CheckedCitation }) {
  const where = `${citation.path}:${citation.startLine}${citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}`;
  return (
    <Badge
      variant="light"
      color={citation.checked ? "green" : "gray"}
      title={citation.checked ? "Shown to the model before it answered (a location, not proof of the claim)" : `Not checked: ${citation.problem ?? ""}`}
      style={{ textTransform: "none" }}
      data-testid="explain-citation"
      data-checked={citation.checked ? "yes" : "no"}
    >
      {where}
      {citation.checked ? "" : ` · ${citation.problem}`}
    </Badge>
  );
}

function Result({ result, summary, preferences }: { result: ExplainResult; summary: RunSummary; preferences: PreferencesView | null }) {
  const headChanged = result.headAtEnd !== result.headAtStart;
  return (
    <Stack gap="sm" data-testid="explain-result">
      <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-head">
        HEAD at run start: {result.headAtStart ? result.headAtStart.slice(0, 12) : "no commits yet"} · read as the files were on disk, at {new Date(result.finishedAt).toLocaleString()}
      </Text>
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
      {result.preferenceDifferences.length > 0 && (
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Where this repository differs from your preferences (the repository wins here)
          </Text>
          {result.preferenceDifferences.map((difference, index) => {
            const current = preferences?.records.find((record) => record.id === difference.preferenceId);
            const same = current !== undefined && current.revision === difference.revision;
            return (
              <Stack key={index} gap={4} data-testid="explain-preference-difference">
                <Text size="sm" c={same ? undefined : "var(--nivra-text-3)"}>
                  {same ? `Your preference: “${current.statement}”` : `A preference that changed or was deleted since this run (id ${difference.preferenceId.slice(0, 8)}, revision ${difference.revision}).`}
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
      <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-context">
        Context used: {result.context.reads.length} {result.context.reads.length === 1 ? "file" : "files"} read ({result.context.reads.map((read) => `${read.path} ${read.ranges.map(([a, b]) => `${a}-${b}`).join(", ")}`).join("; ") || "none"}),{" "}
        {result.context.searches} {result.context.searches === 1 ? "search" : "searches"} with {result.context.searchHits} {result.context.searchHits === 1 ? "hit" : "hits"}, the map from{" "}
        {result.context.map.map((m) => m.path).join(", ") || "file counts only"};{" "}
        {result.context.chars.toLocaleString()} characters of results. {result.checks.checked} of {result.checks.citations} citations point to lines the model was shown. Untracked files are never read.
      </Text>
      <Text size="xs" c="var(--nivra-text-3)" data-testid="explain-run-line">
        {summary.route ? `${summary.route.model}${summary.route.endpoint === "loopback-test" ? " (test endpoint)" : ""}` : "model unknown"} ·{" "}
        {summary.durationMs !== null ? `${(summary.durationMs / 1000).toFixed(1)} s` : "time not recorded"} · {usageText(summary)}
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
}: {
  project: ProjectView | null;
  online: boolean;
  preferences: PreferencesView | null;
  run: RunRef | null;
  onRun(projectId: string, ref: RunRef): void;
  onSharingChanged(): void;
}) {
  const [question, setQuestion] = useState("");
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
      const started = await window.nivra.startExplain(projectId, question.trim());
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
          <Badge color={STATUS_COLOR[status]} variant="light" data-testid="explain-status" data-run-id={runId ?? undefined}>
            {status.replaceAll("_", " ")}
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
      {outcome?.result && <Result result={outcome.result} summary={outcome.summary} preferences={preferences} />}
      <Modal opened={consent} onClose={() => setConsent(false)} title="Send this project's content to Token Factory?" data-testid="explain-consent">
        <Stack gap="sm">
          <Text size="sm">To explain {project?.label ?? "this repository"}, Nivra sends Nebius Token Factory:</Text>
          <List size="sm">
            <List.Item>excerpts and paths from the project's tracked files;</List.Item>
            <List.Item>your question;</List.Item>
            <List.Item>your confirmed preferences that apply to this project.</List.Item>
          </List>
          <Text size="sm">
            Nivra never sends files it recognises as holding secrets (such as .env), or dependency and build output, and it masks text that looks like a key or
            token. It can't recognise every secret: don't allow this for a project whose tracked files hold secrets you can't share.
          </Text>
          <Text size="sm">You can turn this off at any time; doing so stops this project's explanations.</Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConsent(false)}>
              Cancel
            </Button>
            <Button onClick={() => void allowAndStart()} data-testid="explain-consent-allow">
              Allow for this project
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Section>
  );
}
