import { Alert, Badge, Button, Checkbox, Code, Group, List, Modal, NumberInput, Stack, Table, Text, TextInput, Textarea } from "@mantine/core";
import type { TaskCheck, TaskReport } from "@nivra/domain";
import { useEffect, useRef, useState } from "react";
import type { AcceptanceCaseView, TaskAttemptView, TaskRunPreview, TaskView, TurnStatus } from "../../../shared/ipc";
import { CONSENT_COVERS } from "../shared/evidence";
import { errorMessage, Section, usePoll } from "../shared/ui";
import { applyGoing, ApplyResult, AttemptsList, Decision } from "./task-apply";

/**
 * A task's runs (D39): its acceptance cases, written with the brief; a preview of what a run would send and where, from
 * its repository's own engine; then the run, its progress, and what Nivra found. The verdict comes from the acceptance
 * cases alone; what the worker said is shown apart from it. A run never writes the checkout: a verified change reaches
 * it only once the person approves it, and applying it is shown file by file (D40, `task-apply.tsx`).
 */

/** One acceptance case as the form holds it: its expected output without its last newline, and whether it has one. */
export interface CaseDraft {
  name: string;
  command: string;
  output: string;
  newline: boolean;
  exitCode: number;
}

export const caseDraftOf = (given: AcceptanceCaseView): CaseDraft => {
  const newline = given.expectedOutput.endsWith("\n");
  return { name: given.name, command: given.command, output: newline ? given.expectedOutput.slice(0, -1) : given.expectedOutput, newline, exitCode: given.expectedExitCode };
};

export const caseOf = (draft: CaseDraft): AcceptanceCaseView => ({ name: draft.name, command: draft.command, expectedOutput: `${draft.output}${draft.newline ? "\n" : ""}`, expectedExitCode: draft.exitCode });

const EMPTY_CASE: CaseDraft = { name: "", command: "", output: "", newline: true, exitCode: 0 };

/** The brief's acceptance cases, as the person writes them. Four cases and checks run at most. */
export function CasesInput({ cases, onChange }: { cases: CaseDraft[]; onChange(next: CaseDraft[]): void }) {
  const set = (index: number, change: Partial<CaseDraft>) => onChange(cases.map((draft, at) => (at === index ? { ...draft, ...change } : draft)));
  return (
    <Stack gap="xs" data-testid="brief-cases">
      <Text size="sm" fw={500}>
        Acceptance cases
      </Text>
      <Text size="xs" c="var(--nivra-text-3)">
        How Nivra checks a run itself: a command, run in the sandbox, and exactly what it must print and the exit code it must give. The run's result comes from these
        alone. A run takes at most four cases and checks in all.
      </Text>
      {cases.map((draft, index) => (
        <Stack key={index} gap={4} p="xs" style={{ border: "1px solid var(--nivra-border)", borderRadius: 6 }} data-testid="brief-case">
          <Group justify="space-between" wrap="nowrap">
            <TextInput label={`Case ${index + 1}`} placeholder="What it checks" value={draft.name} onChange={(event) => set(index, { name: event.currentTarget.value })} style={{ flex: 1 }} data-testid="brief-case-name" />
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => onChange(cases.filter((_, at) => at !== index))} data-testid="brief-case-remove">
              Remove
            </Button>
          </Group>
          <TextInput label="Command" description="Run with /bin/sh in the repository's folder." ff="monospace" value={draft.command} onChange={(event) => set(index, { command: event.currentTarget.value })} data-testid="brief-case-command" />
          <Textarea
            label="Expected output"
            description="Exactly what the command prints, line for line."
            autosize
            minRows={2}
            maxRows={10}
            styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
            value={draft.output}
            onChange={(event) => set(index, { output: event.currentTarget.value })}
            data-testid="brief-case-output"
          />
          <Group gap="lg">
            <Checkbox label="The output ends with a new line" checked={draft.newline} onChange={(event) => set(index, { newline: event.currentTarget.checked })} data-testid="brief-case-newline" />
            <NumberInput label="Exit code" min={0} max={255} allowDecimal={false} w={110} value={draft.exitCode} onChange={(value) => set(index, { exitCode: typeof value === "number" ? value : Number(value) || 0 })} data-testid="brief-case-exit" />
          </Group>
        </Stack>
      ))}
      <Group>
        <Button size="xs" variant="default" onClick={() => onChange([...cases, { ...EMPTY_CASE }])} disabled={cases.length >= 4} data-testid="brief-case-add">
          Add an acceptance case
        </Button>
      </Group>
    </Stack>
  );
}

/** The brief's acceptance cases, as they read. */
export function CasesRead({ cases }: { cases: AcceptanceCaseView[] }) {
  if (!cases.length) {
    return (
      <Text size="sm" c="var(--nivra-text-3)">
        None yet: a run needs at least one, so Nivra can check the result itself.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {cases.map((given, index) => (
        <Stack key={index} gap={2} data-testid="task-brief-case">
          <Text size="sm">
            {index + 1}. {given.name}
          </Text>
          <Code block fz="xs">
            $ {given.command}
          </Code>
          <Text size="xs" c="var(--nivra-text-3)">
            Must print{given.expectedOutput.endsWith("\n") ? ", ending with a new line" : ", with no new line at the end"}, and exit {given.expectedExitCode}:
          </Text>
          <Code block fz="xs">
            {given.expectedOutput || "(nothing)"}
          </Code>
        </Stack>
      ))}
    </Stack>
  );
}

const STATUS_LOOK: Record<TurnStatus, { label: string; color: string }> = {
  submitting: { label: "Sending", color: "blue" },
  running: { label: "Running", color: "blue" },
  answered: { label: "Ended", color: "green" },
  failed: { label: "Failed", color: "red" },
  cancelled: { label: "Cancelled", color: "gray" },
  interrupted: { label: "Interrupted", color: "yellow" },
  "not-sent": { label: "Not sent", color: "gray" },
  unknown: { label: "Unknown", color: "yellow" },
};

/** What each outcome means, without claiming more than the run showed. */
const OUTCOME: Record<TaskReport["outcome"], string> = {
  "in-progress": "The run is going.",
  proposed: "The worker changed the code. What Nivra's own checks of it found is below.",
  unchanged: "The run changed nothing.",
  refused: "The run was refused.",
  cancelled: "The run was stopped.",
  failed: "The run couldn't finish.",
  uncertain: "Part of the run may still be going in Nebius.",
  interrupted: "The run was interrupted when its engine stopped.",
};

const VERDICT_LOOK: Record<TaskCheck["verdict"], { label: string; color: string }> = {
  passed: { label: "passed", color: "green" },
  failed: { label: "failed", color: "red" },
  "couldnt-run": { label: "couldn't run", color: "red" },
  unknown: { label: "unknown", color: "yellow" },
  "not-run": { label: "not run", color: "gray" },
};

/** Why the worker stopped, in plain words. */
const ENDED: Record<NonNullable<TaskReport["worker"]>["ended"], string> = {
  submitted: "handed in",
  time: "ran out of time before handing in",
  requests: "used its model requests before handing in",
  input: "reached its input budget before handing in",
  "tool-calls": "used its tool calls before handing in",
  "model-failed": "stopped when the model failed",
  "no-time": "didn't start: there was no time left",
  "not-started": "didn't start",
};

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const sizeText = (bytes: number) => (bytes < 1024 ? plural(bytes, "byte") : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const open = (status: TurnStatus) => status === "submitting" || status === "running";

/** The repository files the cases run, which the worker can change, and the cases whose files Nivra can't tell. */
function caseFilesText(caseFiles: TaskRunPreview["caseFiles"]): string {
  const named = caseFiles.filter((one) => one.files.length > 0);
  const unclear = caseFiles.filter((one) => one.unclear).map((one) => one.number);
  const said: string[] = [];
  if (named.length > 0) said.push(`${named.map((one) => `Case ${one.number} runs ${one.files.join(", ")}`).join("; ")}, from the repository, which the worker can change.`);
  if (unclear.length === 1) said.push(`Nivra can't tell for sure which repository files case ${unclear[0]} runs, so the worker may be able to change what it prints.`);
  if (unclear.length > 1)
    said.push(`Nivra can't tell for sure which repository files cases ${unclear.slice(0, -1).join(", ")} and ${unclear.at(-1)} run, so the worker may be able to change what they print.`);
  said.push("Nivra judges only what a case prints, so give it an expected output that only the right behaviour gives, not just what a test script prints when it passes.");
  return said.join(" ");
}

/** The files a case's or check's command runs that the change also changes, or may: its result can't vouch for them. */
function checkFilesText(check: TaskCheck): string {
  const kind = check.kind === "case" ? "case" : "check";
  const named = check.changedFiles.length > 0 ? `The change also changes ${check.changedFiles.join(", ")}, which this ${kind} runs` : null;
  const said = named && check.unclear ? `${named}, and Nivra can't tell for sure which other files it runs` : (named ?? `Nivra can't tell for sure which files this ${kind} runs, so it may run a file the change changes`);
  return check.kind === "case" ? `${said}: Nivra judged only what it printed.` : `${said}.`;
}

/**
 * Running a task: Run, with why it can't when it can't; the preview of what a run would send, and the start bound to
 * it; and the latest run, or one chosen from the list, with its progress and what Nivra found.
 */
export function TaskRun({ view, onChanged }: { view: TaskView; onChanged(): void }) {
  const taskId = view.summary.id;
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<TaskRunPreview | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The preview's Start stays on screen while its dialog fades out, so a second press must not start a second run.
  const starting = useRef(false);
  const latest = view.attempts.at(-1) ?? null;
  const shown = chosen ?? latest?.id ?? null;
  const projectId = view.summary.projectId;

  async function previewIt() {
    setPreviewing(true);
    setPreview(null);
    setError(null);
    try {
      setPreview(await window.nivra.previewTaskRun(taskId));
    } catch (reason) {
      setError(errorMessage(reason));
      setPreviewing(false);
    }
  }

  /** A consent the run needs, given for the project as Explain and the sandbox check ask for it; then the preview again. */
  async function allow(kind: "sharing" | "uploads") {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "sharing") await window.nivra.setSharing(projectId, true);
      else await window.nivra.setCloudExecution(projectId, true);
      setPreview(await window.nivra.previewTaskRun(taskId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!preview || preview.blocked || !preview.snapshotFingerprint || starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      const attempt = await window.nivra.startTaskRun(taskId, preview.expected, preview.snapshotFingerprint);
      setPreviewing(false);
      setChosen(attempt.id);
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      starting.current = false;
    }
  }

  return (
    <Stack gap="sm" data-testid="task-runs">
      <Group gap="sm">
        <Button size="xs" onClick={() => void previewIt()} disabled={view.runBlocked !== null} data-testid="task-run">
          Run
        </Button>
      </Group>
      {view.runBlocked && (
        <Text size="sm" c="var(--nivra-text-2)" data-testid="task-run-blocked">
          {view.runBlocked}
        </Text>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="task-run-error">
          {error}
        </Text>
      )}
      <AttemptsList attempts={view.attempts} shown={shown} onChoose={setChosen} />
      {shown && (
        <Attempt
          key={shown}
          taskId={taskId}
          attemptId={shown}
          onEnded={onChanged}
          onDecided={onChanged}
        />
      )}
      <Modal opened={previewing} onClose={() => setPreviewing(false)} title="Run this task?" size="xl" data-testid="task-run-preview">
        {preview ? (
          <RunPreview preview={preview} busy={busy} error={error} onAllow={(kind) => void allow(kind)} onStart={() => void start()} onCancel={() => setPreviewing(false)} />
        ) : (
          <Text size="sm" c="var(--nivra-text-3)">
            Working out what a run would send, on the repository's own engine. Nothing is sent.
          </Text>
        )}
      </Modal>
    </Stack>
  );
}

/**
 * What a run would send to each service, what each keeps, how the result is judged, and the bounds it runs under. A
 * consent the run needs and the project hasn't given is asked for here, in the words its own dialog uses.
 */
function RunPreview({ preview, busy, error, onAllow, onStart, onCancel }: { preview: TaskRunPreview; busy: boolean; error: string | null; onAllow(kind: "sharing" | "uploads"): void; onStart(): void; onCancel(): void }) {
  const { snapshot, limits } = preview;
  const leftOut = snapshot ? Object.values(snapshot.leftOut).reduce((sum, counted) => sum + counted.count, 0) : 0;
  const asking = snapshot !== null && (!preview.consents.modelContext || !preview.consents.cloudExecution);
  return (
    <Stack gap="sm" data-testid="task-run-preview-body">
      <Text size="sm">
        Brief v{preview.briefVersion}, on {preview.project.label}
        {preview.project.targetLabel ? ` · ${preview.project.targetLabel}` : ""}. A worker changes a copy of the commit in a Nebius sandbox, with networking off. It can read and
        write files there and run the cases and checks below, and nothing else. Nothing comes back to your checkout unless you approve the change afterwards.
      </Text>
      {preview.blocked && !asking && (
        <Alert color="yellow" variant="light" data-testid="task-run-preview-blocked">
          <Text size="sm">{preview.blocked}</Text>
        </Alert>
      )}
      {snapshot && (
        <Text size="sm" data-testid="task-run-preview-snapshot">
          Commit <Code>{snapshot.baseline.slice(0, 12)}</Code>
          {snapshot.prefix ? (
            <>
              , folder <Code>{snapshot.prefix}</Code>
            </>
          ) : null}
          : {plural(snapshot.files, "file")}, {sizeText(snapshot.bytes)} to upload{leftOut ? `; ${plural(leftOut, "file")} left out and never sent` : ""}.
          {snapshot.untracked.count ? ` ${plural(snapshot.untracked.count, "untracked file")} stay here.` : ""}
        </Text>
      )}
      <Stack gap={2}>
        <Text size="sm" fw={500}>
          To Token Factory, as the project's sharing allows ({preview.consents.modelContext ? "on" : "off"})
        </Text>
        <List size="sm">
          {preview.sends.tokenFactory.map((line) => (
            <List.Item key={line}>{line}</List.Item>
          ))}
        </List>
        <Text size="xs" c="var(--nivra-text-3)">
          {preview.keeps.tokenFactory}
        </Text>
      </Stack>
      <Stack gap={2}>
        <Text size="sm" fw={500}>
          To Nebius Sandboxes, as the project's uploads allow ({preview.consents.cloudExecution ? "on" : "off"})
        </Text>
        <List size="sm">
          {preview.sends.nebius.map((line) => (
            <List.Item key={line}>{line}</List.Item>
          ))}
        </List>
        {preview.keeps.nebius && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="task-run-preview-keeps">
            {preview.keeps.nebius}
          </Text>
        )}
      </Stack>
      <Stack gap={2} data-testid="task-run-preview-judged">
        <Text size="sm" fw={500}>
          How Nivra checks the result
        </Text>
        <Text size="sm">
          Every acceptance case must print exactly what it should and give its exit code. Nivra compares that itself, on this computer; the worker can't change the cases
          themselves.
          {preview.checks.length ? " The repository's checks run too: they're reported, and don't decide the result." : ""}
        </Text>
        <List size="sm">
          {preview.cases.map((given) => (
            <List.Item key={`case-${given.number}`}>
              Case {given.number}, {given.name}: <Code>{given.command}</Code>, exit {given.expectedExitCode}
            </List.Item>
          ))}
          {preview.checks.map((check) => (
            <List.Item key={`check-${check.number}`}>
              Check {check.number}: <Code>{check.command}</Code>
            </List.Item>
          ))}
        </List>
        {preview.caseFiles.length > 0 && (
          <Text size="xs" c="var(--nivra-warning)" data-testid="task-run-preview-case-files">
            {caseFilesText(preview.caseFiles)}
          </Text>
        )}
        {preview.programs.length > 0 && (
          <Text size="xs" c="var(--nivra-text-3)">
            Before the worker starts, Nivra checks that the sandbox has each command's program ({preview.programs.map((program) => `"${program}"`).join(", ")}). If one is
            missing, the run stops there, and nothing is installed.
          </Text>
        )}
      </Stack>
      {limits && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="task-run-preview-limits">
          Bounds: at most {plural(limits.modelRequests, "model request")} of up to {limits.requestSeconds} s and {limits.outputTokensPerRequest.toLocaleString()} output tokens
          each, admitted against an estimated {limits.estimatedInputTokens.toLocaleString()} input tokens (an estimate, not a cap); {plural(limits.toolCalls, "tool call")}, of
          which {plural(limits.writes, "write")} of up to {sizeText(limits.writeBytes)} and {plural(limits.runs, "run")} of a case or check; at most{" "}
          {plural(limits.operations, "Nebius operation")}, each command up to {limits.checkSeconds} s; the sandbox for {limits.sessionMinutes} minutes, and the whole run for{" "}
          {limits.runMinutes} minutes.
        </Text>
      )}
      {asking && !preview.consents.modelContext && (
        <Alert color="blue" variant="light" title="Send this project's content to Token Factory?" data-testid="task-run-ask-sharing">
          <Stack gap="xs">
            <Text size="sm">To run this task, Nivra sends Nebius Token Factory what's listed above for it.</Text>
            <Text size="sm">
              Nivra never sends files it recognises as holding secrets (such as .env), or dependency and build output, and it masks text that looks like a key or token. It can't
              recognise every secret: don't allow this for a project whose tracked files hold secrets you can't share.
            </Text>
            <Text size="sm">{CONSENT_COVERS}</Text>
            <Group>
              <Button size="xs" onClick={() => onAllow("sharing")} disabled={busy} data-testid="task-run-allow-sharing">
                Allow for this project
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {asking && !preview.consents.cloudExecution && (
        <Alert color="blue" variant="light" title="Upload this project's commit to Nebius Sandboxes?" data-testid="task-run-ask-uploads">
          <Stack gap="xs">
            <Text size="sm">
              To run this task, Nivra uploads one snapshot of the commit to your Nebius project, where the worker changes a copy of it with networking off. None of your
              uncommitted or untracked work is sent: a run works from the commit.
            </Text>
            <Text size="sm">
              Before the upload, Nivra checks every file for what looks like a key or token, and refuses the commit if one does. It can't recognise every secret: don't allow this
              for a project whose commits hold secrets you can't share.
            </Text>
            <Text size="sm">
              This is separate from sending content to Token Factory, and it is for this project only: its sandbox checks and its task runs. You can turn it off at any time:
              Nivra then stops a check or a run under way, and says so if it can't. What was already uploaded stays with Nebius.
            </Text>
            <Group>
              <Button size="xs" onClick={() => onAllow("uploads")} disabled={busy} data-testid="task-run-allow-uploads">
                Allow uploads for this project
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="task-run-preview-error">
          {error}
        </Text>
      )}
      <Group justify="flex-end" gap="sm">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onStart} disabled={preview.blocked !== null || !preview.snapshotFingerprint || busy} loading={busy} data-testid="task-run-start">
          Start the run
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * One run: its status, progress, and what Nivra found, read again while it goes; then the decision on its change and
 * what applying it did, read again while the apply goes or its engine can't be read.
 */
function Attempt({ taskId, attemptId, onEnded, onDecided }: { taskId: string; attemptId: string; onEnded(): void; onDecided(): void }) {
  const attempt = usePoll<TaskAttemptView>(
    () => window.nivra.getTaskAttempt(taskId, attemptId),
    (value) => (value && open(value.status) ? 1_500 : value && applyGoing(value) ? (value.apply?.unresolved ? 5_000 : 1_500) : null),
    [taskId, attemptId],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = attempt.value;
  const ended = value !== null && !open(value.status);
  // The task's own view lists the run's end once it is known.
  useEffect(() => {
    if (ended) onEnded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);
  // An apply that moves on by itself (its engine answered, or a restart reconciled it): the list of runs is read again.
  const applyState = value?.apply ? `${value.apply.status ?? "waiting"}:${value.apply.resolution ?? ""}` : "";
  const seenApply = useRef<string | null>(null);
  useEffect(() => {
    if (value === null) return;
    if (seenApply.current !== null && seenApply.current !== applyState) onDecided();
    seenApply.current = applyState;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, value === null]);
  if (!value) {
    return attempt.error ? (
      <Text size="sm" c="var(--nivra-error)">
        {attempt.error}
      </Text>
    ) : null;
  }
  const report = value.report;
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.nivra.cancelTaskRun(taskId, attemptId);
      attempt.refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  /** One of the decisions or settlements, then the run read again; a refusal says why, in the host's words. */
  const act = (work: () => Promise<TaskAttemptView>) => {
    setBusy(true);
    setError(null);
    void work()
      .then(
        () => {
          attempt.refresh();
          onDecided();
        },
        (reason: unknown) => setError(errorMessage(reason)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Section title={`Run of brief v${value.briefVersion}`}>
      <Stack gap="sm" data-testid="task-attempt" data-status={value.status} data-attempt-id={value.id}>
        <Group gap="sm">
          <Badge color={STATUS_LOOK[value.status].color} variant="light" data-testid="task-attempt-status">
            {STATUS_LOOK[value.status].label}
          </Badge>
          <Text size="xs" c="var(--nivra-text-3)">
            {new Date(value.createdAt).toLocaleString()}
          </Text>
          {open(value.status) && (
            <Button size="compact-xs" variant="default" onClick={() => void cancel()} loading={busy} disabled={value.cancelRequested} data-testid="task-attempt-cancel">
              {value.cancelRequested ? "Stopping…" : "Cancel"}
            </Button>
          )}
        </Group>
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="task-attempt-error">
            {error}
          </Text>
        )}
        {value.note && (
          <Alert color="yellow" variant="light" data-testid="task-attempt-note">
            <Text size="sm">{value.note}</Text>
          </Alert>
        )}
        {value.unresolved && (
          <Text size="sm" c="var(--nivra-warning)" data-testid="task-attempt-unresolved">
            {value.unresolved}
          </Text>
        )}
        {value.progress.length > 0 && (
          <Stack gap={0} data-testid="task-attempt-progress">
            {value.progress.map((line, index) => (
              <Text key={index} size="xs" c="var(--nivra-text-2)" ff="monospace" style={{ overflowWrap: "anywhere" }}>
                {line}
              </Text>
            ))}
          </Stack>
        )}
        {report && <Found report={report} proposal={value.proposal} />}
        <Decision value={value} busy={busy} act={act} />
        <ApplyResult value={value} busy={busy} act={act} />
      </Stack>
    </Section>
  );
}

/** What a run found: its outcome, the verdict and every case and check, the worker's own account apart, the change, and cleanup's record. */
function Found({ report, proposal }: { report: TaskReport; proposal: TaskAttemptView["proposal"] }) {
  const { cleanup, worker } = report;
  return (
    <Stack gap="sm" data-testid="task-attempt-report" data-outcome={report.outcome} data-verified={report.verified}>
      <Text size="sm" fw={500}>
        {OUTCOME[report.outcome]}
      </Text>
      {report.stopped && (
        <Text size="sm" data-testid="task-attempt-stopped">
          {report.stopped.message}
        </Text>
      )}
      {report.outcome === "proposed" && (
        <Alert color={report.verified ? "green" : "yellow"} variant="light" data-testid="task-attempt-verdict">
          <Text size="sm">
            {report.verified
              ? "Every acceptance case passed: the change is verified. It's kept with the run until you decide, and your checkout hasn't been touched by the run."
              : "Not every acceptance case was shown to pass, so the change isn't verified and can't be approved. It's kept with the run, and your checkout hasn't been touched."}
          </Text>
        </Alert>
      )}
      {report.checks.length > 0 && (
        <Table data-testid="task-attempt-checks">
          <Table.Tbody>
            {report.checks.map((check) => (
              <Table.Tr key={`${check.kind}-${check.number}`} data-testid="task-attempt-check" data-verdict={check.verdict}>
                <Table.Td w={140}>
                  <Text size="sm">
                    {check.kind === "case" ? `Case ${check.number}` : `Check ${check.number}`}
                    {check.kind === "check" ? " (reported)" : ""}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    <Group gap="xs">
                      <Badge size="sm" variant="light" color={VERDICT_LOOK[check.verdict].color}>
                        {VERDICT_LOOK[check.verdict].label}
                      </Badge>
                      <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                        {check.name}
                      </Text>
                    </Group>
                    {check.reason && (
                      <Text size="xs" c="var(--nivra-text-2)">
                        {check.reason}
                        {check.difference ? ` (line ${check.difference.line}: expected "${check.difference.expected}", got "${check.difference.got}")` : ""}
                      </Text>
                    )}
                    {(check.changedFiles.length > 0 || check.unclear) && (
                      <Text size="xs" c="var(--nivra-warning)" data-testid="task-attempt-check-files">
                        {checkFilesText(check)}
                      </Text>
                    )}
                  </Stack>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {worker && (
        <Stack gap={2} data-testid="task-attempt-worker">
          <Text size="sm">
            The worker ({worker.model}) {ENDED[worker.ended]}, after {plural(worker.usage.calls, "model request")}, {plural(worker.tools.writes, "write")} and{" "}
            {plural(worker.tools.runs, "run")}
            {worker.tools.refused ? `; ${plural(worker.tools.refused, "tool call")} refused` : ""}.{" "}
            {worker.usage.inputTokens !== null && worker.usage.outputTokens !== null
              ? `${worker.usage.inputTokens.toLocaleString()} input and ${worker.usage.outputTokens.toLocaleString()} output tokens, as reported.`
              : "Its token use wasn't fully reported."}
          </Text>
          {worker.summary && (
            <Text size="sm" c="var(--nivra-text-2)" data-testid="task-attempt-summary">
              The worker's own account, which Nivra didn't check: {worker.summary}
            </Text>
          )}
        </Stack>
      )}
      {proposal && (
        <Stack gap={2} data-testid="task-attempt-change">
          <Text size="sm">
            The change, {proposal.hash.slice(0, 12)}, to commit <Code>{proposal.baseline.slice(0, 12)}</Code>: {proposal.paths.map((path) => `${path.change} ${path.path}`).join(", ")}.
          </Text>
          <Code block fz="xs" style={{ maxHeight: 360, overflow: "auto" }} data-testid="task-attempt-patch">
            {proposal.patch}
          </Code>
          {proposal.truncated && (
            <Text size="xs" c="var(--nivra-text-3)">
              Only the start of the change is shown: it is {sizeText(proposal.patchBytes)} in all.
            </Text>
          )}
        </Stack>
      )}
      {report.steps.length > 0 && (
        <Stack gap={0} data-testid="task-attempt-steps">
          <Text size="sm">Steps in the sandbox, in order:</Text>
          {report.steps.map((step, index) => (
            <Text key={index} size="xs" c="var(--nivra-text-2)" data-testid="task-attempt-step">
              <Code>{step.label}</Code> {step.cancelled ? "stopped" : step.timedOut ? "timed out" : step.exitCode === null ? "didn't finish" : `exited ${step.exitCode}`}
              {step.status ? `, Nebius said ${step.status}` : ""}
              {step.durationMs !== null ? `, ${(step.durationMs / 1000).toFixed(1)} s` : ""}
            </Text>
          ))}
        </Stack>
      )}
      {cleanup && (
        <Stack gap={2} data-testid="task-attempt-cleanup">
          <Text size="sm">
            Cleanup: {plural(cleanup.stopped, "operation")} stopped, {plural(cleanup.alreadyEnded, "operation")} had already ended.
          </Text>
          {cleanup.unresolved.length > 0 && (
            <List size="sm">
              {cleanup.unresolved.map((item) => (
                <List.Item key={item}>{item}</List.Item>
              ))}
            </List>
          )}
          {cleanup.retained && (
            <Text size="xs" c="var(--nivra-text-3)">
              Nebius keeps {plural(cleanup.retained.uploads, "upload")}, {plural(cleanup.retained.images, "image")} and {plural(cleanup.retained.operations, "operation record")} from this run. {cleanup.retained.note}
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}
