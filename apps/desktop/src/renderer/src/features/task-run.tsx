import { Alert, Badge, Button, Checkbox, Code, Collapse, Group, List, Modal, NumberInput, Paper, SegmentedControl, SimpleGrid, Stack, Text, TextInput, Textarea, UnstyledButton, VisuallyHidden } from "@mantine/core";
import type { BaselineSelection, TaskBaselineCheck, TaskCheck, TaskProposal, TaskReport } from "@nivra/domain";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AcceptanceCaseView, BriefContent, TaskAttemptView, TaskRunPreview, TaskView, TurnStatus } from "../../../shared/ipc";
import { startedFrom } from "../../../shared/task-started";
import { diffFilesOf, modeChangeOf, type DiffFile } from "../../../shared/task-diff";
import { outcomeLookOf, verdictText } from "../../../shared/task-verdict";
import { CONSENT_COVERS } from "../shared/evidence";
import { errorMessage, usePoll } from "../shared/ui";
import { useNarrow } from "./narrow";
import { applyGoing } from "./task-apply";

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

/** The brief's acceptance cases, as the person writes them, under the card that says what they are. Four cases and checks run at most. */
export function CasesInput({ cases, onChange }: { cases: CaseDraft[]; onChange(next: CaseDraft[]): void }) {
  const set = (index: number, change: Partial<CaseDraft>) => onChange(cases.map((draft, at) => (at === index ? { ...draft, ...change } : draft)));
  return (
    <Stack gap="xs" data-testid="brief-cases">
      {cases.map((draft, index) => (
        <Stack key={index} gap={4} p="xs" style={{ border: "1px solid var(--nivra-border)", borderRadius: 6 }} data-testid="brief-case">
          <Group justify="space-between" wrap="nowrap">
            <TextInput label={`Case ${index + 1}`} placeholder="What it checks" value={draft.name} onChange={(event) => set(index, { name: event.currentTarget.value })} style={{ flex: 1 }} data-testid="brief-case-name" />
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => onChange(cases.filter((_, at) => at !== index))} aria-label={`Remove case ${index + 1}`} data-testid="brief-case-remove">
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

/**
 * One baseline check as the form holds it (D41): its exact output without its last newline, and whether it has one, or a
 * pattern, as `mode` says. The other's text is kept while the person switches, and only `mode`'s is saved.
 */
export interface BaselineDraft {
  name: string;
  command: string;
  mode: "output" | "pattern";
  output: string;
  newline: boolean;
  pattern: string;
  exitCode: number;
}

export const baselineDraftOf = (given: BaselineSelection): BaselineDraft => {
  const output = given.expectedOutput ?? "";
  const newline = given.expectedOutput === undefined || output.endsWith("\n");
  return {
    name: given.name,
    command: given.command,
    mode: given.outputPattern !== undefined ? "pattern" : "output",
    output: newline && output.endsWith("\n") ? output.slice(0, -1) : output,
    newline,
    pattern: given.outputPattern ?? "",
    exitCode: given.expectedExitCode,
  };
};

export const baselineOf = (draft: BaselineDraft): BaselineSelection => ({
  name: draft.name,
  command: draft.command,
  expectedExitCode: draft.exitCode,
  ...(draft.mode === "pattern" ? { outputPattern: draft.pattern } : { expectedOutput: `${draft.output}${draft.newline ? "\n" : ""}` }),
});

const EMPTY_BASELINE: BaselineDraft = { name: "", command: "", mode: "output", output: "", newline: true, pattern: "", exitCode: 0 };
/** A brief's baseline checks at most (`TASK_BRIEF_LIMITS.baseline`). */
const MAX_BASELINE = 3;

/**
 * The brief's baseline checks, as the person writes them (D41), under the card that says what they are: commands run once
 * before the worker, on the commit as it is, each with what it must give there, which can be a failure.
 */
export function BaselineInput({ checks, onChange }: { checks: BaselineDraft[]; onChange(next: BaselineDraft[]): void }) {
  const set = (index: number, change: Partial<BaselineDraft>) => onChange(checks.map((draft, at) => (at === index ? { ...draft, ...change } : draft)));
  return (
    <Stack gap="xs" data-testid="brief-baseline">
      {checks.map((draft, index) => (
        <Stack key={index} gap={4} p="xs" style={{ border: "1px solid var(--nivra-border)", borderRadius: 6 }} data-testid="brief-baseline-check">
          <Group justify="space-between" wrap="nowrap">
            <TextInput label={`Baseline check ${index + 1}`} placeholder="What it shows" value={draft.name} onChange={(event) => set(index, { name: event.currentTarget.value })} style={{ flex: 1 }} data-testid="brief-baseline-name" />
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => onChange(checks.filter((_, at) => at !== index))} aria-label={`Remove baseline check ${index + 1}`} data-testid="brief-baseline-remove">
              Remove
            </Button>
          </Group>
          <TextInput
            label="Command"
            description="Run with /bin/sh in the repository's folder."
            styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
            value={draft.command}
            onChange={(event) => set(index, { command: event.currentTarget.value })}
            data-testid="brief-baseline-command"
          />
          <SegmentedControl
            size="xs"
            value={draft.mode}
            onChange={(value) => set(index, { mode: value === "pattern" ? "pattern" : "output" })}
            data={[
              { value: "output", label: "Exact output" },
              { value: "pattern", label: "Pattern" },
            ]}
            data-testid="brief-baseline-mode"
          />
          {draft.mode === "output" ? (
            <>
              <Textarea
                label="Expected output"
                description="Exactly what the command prints, line for line."
                autosize
                minRows={2}
                maxRows={10}
                styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
                value={draft.output}
                onChange={(event) => set(index, { output: event.currentTarget.value })}
                data-testid="brief-baseline-output"
              />
              <Checkbox label="The output ends with a new line" checked={draft.newline} onChange={(event) => set(index, { newline: event.currentTarget.checked })} data-testid="brief-baseline-newline" />
            </>
          ) : (
            <TextInput
              label="Pattern"
              description="A regular expression the command's whole output must match. A dot matches a line break too."
              styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
              value={draft.pattern}
              onChange={(event) => set(index, { pattern: event.currentTarget.value })}
              data-testid="brief-baseline-pattern"
            />
          )}
          <NumberInput label="Exit code" min={0} max={255} allowDecimal={false} w={110} value={draft.exitCode} onChange={(value) => set(index, { exitCode: typeof value === "number" ? value : Number(value) || 0 })} data-testid="brief-baseline-exit" />
        </Stack>
      ))}
      <Group>
        <Button size="xs" variant="default" onClick={() => onChange([...checks, { ...EMPTY_BASELINE }])} disabled={checks.length >= MAX_BASELINE} data-testid="brief-baseline-add">
          Add a baseline check
        </Button>
      </Group>
    </Stack>
  );
}

/** The brief's baseline checks, as they read. */
export function BaselineRead({ checks }: { checks: BaselineSelection[] }) {
  if (!checks.length) {
    return (
      <Text size="sm" c="var(--nivra-text-3)">
        None: a run starts the worker without checking the commit first.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {checks.map((given, index) => (
        <Stack key={index} gap={2} data-testid="task-brief-baseline-check">
          <Text size="sm">
            {index + 1}. {given.name}
          </Text>
          <Code block fz="xs">
            $ {given.command}
          </Code>
          {given.outputPattern !== undefined ? (
            <>
              <Text size="xs" c="var(--nivra-text-3)">
                Its whole output must match this pattern, and it must exit {given.expectedExitCode}:
              </Text>
              <Code block fz="xs">
                {given.outputPattern}
              </Code>
            </>
          ) : (
            <>
              <Text size="xs" c="var(--nivra-text-3)">
                Must print{(given.expectedOutput ?? "").endsWith("\n") ? ", ending with a new line" : ", with no new line at the end"}, and exit {given.expectedExitCode}:
              </Text>
              <Code block fz="xs">
                {given.expectedOutput || "(nothing)"}
              </Code>
            </>
          )}
        </Stack>
      ))}
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
  answered: { label: "Ended", color: "gray" },
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
  passed: { label: "Passed", color: "green" },
  failed: { label: "Failed", color: "red" },
  "couldnt-run": { label: "Couldn't run", color: "red" },
  unknown: { label: "Unknown", color: "yellow" },
  "not-run": { label: "Not run", color: "gray" },
};

const MATCH_LOOK = {
  matched: { label: "Matched", color: "green" },
  "not matched": { label: "Not matched", color: "red" },
  "not run": { label: "Not run", color: "gray" },
} as const;
const matchOf = (check: TaskBaselineCheck) => (check.matched === null ? "not run" : check.matched ? "matched" : "not matched");
const FROZEN_LOOK = { unchanged: "green", changed: "red", unknown: "yellow" } as const;
const frozenOf = (unchanged: boolean | null) => (unchanged === null ? "unknown" : unchanged ? "unchanged" : "changed");

/** Why the worker stopped, in plain words. */
const ENDED: Record<NonNullable<TaskReport["worker"]>["ended"], string> = {
  submitted: "handed in",
  time: "ran out of time before handing in",
  requests: "used its model requests before handing in",
  input: "reached its input budget before handing in",
  "tool-calls": "used its tool calls before handing in",
  "model-failed": "stopped when the model failed",
  "output-cap": "stopped when an answer reached its output cap, before handing in",
  "no-time": "didn't start: too little time was left",
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
 * A task's way into a run (NIV-56, G3: P1g, RS3): "Preview the run", with what it does or, when a run can't start, why
 * in visible words; the preview of what a run would send and where, from the repository's own engine; and the start
 * bound to it. A consent the run needs is asked for in the preview, and its answer stays there as it was given.
 */
export function RunLauncher({
  view,
  primary,
  asked = 0,
  onStarted,
}: {
  view: TaskView;
  /** Whether it is the page's next useful step, and so its one primary. */
  primary: boolean;
  /** Raised when the page asks for the preview from elsewhere, such as a run's next step. */
  asked?: number;
  onStarted(attemptId: string): void;
}) {
  const taskId = view.summary.id;
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<TaskRunPreview | null>(null);
  const [allowed, setAllowed] = useState<{ sharing: boolean; uploads: boolean }>({ sharing: false, uploads: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The preview's Start stays on screen while its dialog fades out, so a second press must not start a second run.
  const starting = useRef(false);
  const narrow = useNarrow();
  const says = useId();
  const why = useId();
  const projectId = view.summary.projectId;
  const blocked = view.runBlocked;

  // Only a press made while this is shown opens the preview: one counted before it was shown again doesn't.
  const seenAsk = useRef(asked);
  useEffect(() => {
    if (asked === seenAsk.current) return;
    seenAsk.current = asked;
    void previewIt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  async function previewIt() {
    if (blocked !== null) return;
    setPreviewing(true);
    setPreview(null);
    setError(null);
    setAllowed({ sharing: false, uploads: false });
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
      setAllowed((was) => ({ ...was, [kind]: true }));
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
      onStarted(attempt.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      starting.current = false;
    }
  }

  return (
    <Stack gap={4} align="flex-end" maw={380} data-testid="task-run-launcher">
      <Button variant={primary && blocked === null ? "filled" : "default"} onClick={() => void previewIt()} aria-disabled={blocked !== null || undefined} data-disabled={blocked !== null || undefined} aria-describedby={blocked === null ? says : `${says} ${why}`} data-testid="task-run">
        Preview the run
      </Button>
      <Text id={says} size="xs" c="var(--nivra-text-3)" ta="right">
        {blocked === null ? "Shows what a run would send. Nothing is sent." : "Off until what's needed is done:"}
      </Text>
      {blocked !== null && (
        <Text id={why} size="xs" c="var(--nivra-text-2)" ta="right" data-testid="task-run-blocked">
          {blocked}
        </Text>
      )}
      {error && !previewing && (
        <Text size="sm" c="var(--nivra-error)" ta="right" data-testid="task-run-error">
          {error}
        </Text>
      )}
      <Modal
        opened={previewing}
        onClose={() => setPreviewing(false)}
        title="Preview the run"
        size={narrow ? "100%" : "min(1080px, 94vw)"}
        fullScreen={narrow}
        styles={{ content: { display: "flex", flexDirection: "column", overflow: "hidden" }, body: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 0 } }}
        data-testid="task-run-preview"
      >
        {preview ? (
          <RunPreview preview={preview} allowed={allowed} busy={busy} error={error} onAllow={(kind) => void allow(kind)} onStart={() => void start()} onCancel={() => setPreviewing(false)} />
        ) : (
          <Text size="sm" c="var(--nivra-text-3)" p="md">
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
function RunPreview({
  preview,
  allowed,
  busy,
  error,
  onAllow,
  onStart,
  onCancel,
}: {
  preview: TaskRunPreview;
  allowed: { sharing: boolean; uploads: boolean };
  busy: boolean;
  error: string | null;
  onAllow(kind: "sharing" | "uploads"): void;
  onStart(): void;
  onCancel(): void;
}) {
  const { snapshot, limits } = preview;
  const leftOut = snapshot ? Object.values(snapshot.leftOut).reduce((sum, counted) => sum + counted.count, 0) : 0;
  const asking = snapshot !== null && (!preview.consents.modelContext || !preview.consents.cloudExecution);
  const startable = preview.blocked === null && preview.snapshotFingerprint !== null;
  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }} data-testid="task-run-preview-body" data-expected={preview.expected} data-snapshot={preview.snapshotFingerprint ?? ""}>
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--mantine-spacing-md)" }}>
    <Stack gap="sm">
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
      {snapshot && (
        <Text size="sm" data-testid="task-run-preview-environment">
          {preview.environment
            ? `Starts from the prepared environment: ${preview.environment.tools.map((tool) => `${tool.name} ${tool.version}`).join(", ")}, prepared ${new Date(preview.environment.preparedAt).toLocaleString()}. Nivra checked that this commit's setup files are the ones it was prepared from.`
            : "Starts from Nivra's own base image, with nothing installed."}
        </Text>
      )}
      <Text size="sm" fw={600}>
        What each service gets, and what it keeps
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
      <Paper withBorder p="sm" radius="md">
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
        {allowed.sharing && preview.consents.modelContext && (
          <Text size="xs" c="var(--nivra-text-2)" role="status" data-testid="task-run-allowed-sharing">
            Allowed for {preview.project.label}, just now.
          </Text>
        )}
      </Stack>
      </Paper>
      <Paper withBorder p="sm" radius="md">
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
        {allowed.uploads && preview.consents.cloudExecution && (
          <Text size="xs" c="var(--nivra-text-2)" role="status" data-testid="task-run-allowed-uploads">
            Allowed for {preview.project.label}, just now.
          </Text>
        )}
      </Stack>
      </Paper>
      </SimpleGrid>
      {preview.baseline.length > 0 && (
        <Stack gap={2} data-testid="task-run-preview-baseline">
          <Text size="sm" fw={500}>
            Before the worker starts
          </Text>
          <Text size="sm">
            {plural(preview.baseline.length, "baseline check")} {preview.baseline.length === 1 ? "runs" : "run"} once on the commit as it is, with networking off. If one doesn't
            give what the brief expects, the run stops there, and the model is never asked anything.
          </Text>
          <List size="sm">
            {preview.baseline.map((given) => (
              <List.Item key={`baseline-${given.number}`}>
                Baseline check {given.number}, {given.name}: <Code>{given.command}</Code>, exit {given.expectedExitCode},{" "}
                {given.outputPattern !== undefined ? "its whole output matching a pattern" : "printing exactly what the brief says"}
              </List.Item>
            ))}
          </List>
        </Stack>
      )}
      {preview.frozen.length > 0 && (
        <Stack gap={2} data-testid="task-run-preview-frozen">
          <Text size="sm" fw={500}>
            Frozen files
          </Text>
          <Text size="sm">The worker can't change them, and the result counts only when every one is unchanged.</Text>
          <List size="sm">
            {preview.frozen.map((file) => (
              <List.Item key={file.path} data-testid="task-run-preview-frozen-file">
                <Code>{file.path}</Code>
                {file.sha256 ? `, ${file.sha256.slice(0, 12)} in this commit` : ""}
              </List.Item>
            ))}
          </List>
        </Stack>
      )}
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
          which {plural(limits.writes, "write")} of up to {sizeText(limits.writeBytes)} and {plural(limits.runs, "run")} of a case or check;{" "}
          {limits.baselineChecks ? `${plural(limits.baselineChecks, "baseline check")} before the worker; ` : ""}at most {plural(limits.operations, "Nebius operation")}, each
          command up to {limits.checkSeconds} s; the sandbox for {limits.sessionMinutes} minutes, and the whole run for {limits.runMinutes} minutes.
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
              This is separate from sending content to Token Factory, and it is for this project only: its sandbox checks, its environment and its task runs. You can turn it off at any time:
              Nivra then stops a check, a preparation or a run under way, and says so if it can't. What was already uploaded stays with Nebius.
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
    </Stack>
    </div>
      <Group justify="space-between" align="center" gap="sm" wrap="wrap" p="md" style={{ borderTop: "1px solid var(--nivra-border)", flexShrink: 0 }} data-testid="task-run-preview-footer">
        <Text size="xs" c="var(--nivra-text-3)" style={{ flex: "1 1 260px" }}>
          {startable
            ? "Start sends exactly what this preview shows. If anything changes first, Nivra asks you to preview it again."
            : asking
              ? "Start is off until you allow what's asked above."
              : "Start is off: the preview says why above."}
        </Text>
        <Group gap="sm" wrap="nowrap">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onStart} disabled={!startable || busy} loading={busy} data-testid="task-run-start">
            Start the run
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

/** A run's state for the task page: its view, read again while it goes or its apply moves, and the calls on it. */
export interface RunState {
  /** The run's own view; null while it's being read, or before there is a run to show. */
  value: TaskAttemptView | null;
  loadError: string | null;
  busy: boolean;
  error: string | null;
  cancel(): void;
  /** One of the decisions or settlements, then the run read again; a refusal says why, in the host's words. */
  act(work: () => Promise<TaskAttemptView>): void;
}

/**
 * The shown run (NIV-56, G3), read for the whole page: its result leads the main column and its decision sits in the
 * aside, so both read the same view. The task is read again when the run ends, and when its apply moves on by itself.
 */
export function useRun(taskId: string, attemptId: string | null, onEnded: () => void, onDecided: () => void): RunState {
  const attempt = usePoll<TaskAttemptView | null>(
    () => (attemptId === null ? Promise.resolve(null) : window.nivra.getTaskAttempt(taskId, attemptId)),
    (value) => (value && open(value.status) ? 1_500 : value && applyGoing(value) ? (value.apply?.unresolved ? 5_000 : 1_500) : null),
    [taskId, attemptId],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [attemptId]);
  // The poll keeps the last run's view while it reads another: only this run's own view counts.
  const value = attempt.value !== null && attempt.value.id === attemptId ? attempt.value : null;
  const ended = value !== null && !open(value.status);
  // The task's own view lists the run's end once it is known.
  useEffect(() => {
    if (ended) onEnded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, attemptId]);
  // An apply that moves on by itself (its engine answered, or a restart reconciled it): the list of runs is read again.
  const applyState = value?.apply ? `${value.apply.status ?? "waiting"}:${value.apply.resolution ?? ""}` : "";
  const seenApply = useRef<{ id: string; state: string } | null>(null);
  useEffect(() => {
    if (value === null) return;
    if (seenApply.current !== null && seenApply.current.id === value.id && seenApply.current.state !== applyState) onDecided();
    seenApply.current = { id: value.id, state: applyState };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, value?.id]);
  const cancel = () => {
    if (attemptId === null) return;
    setBusy(true);
    setError(null);
    void window.nivra
      .cancelTaskRun(taskId, attemptId)
      .then(
        () => attempt.refresh(),
        (reason: unknown) => setError(errorMessage(reason)),
      )
      .finally(() => setBusy(false));
  };
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
  return { value, loadError: attempt.error, busy, error, cancel, act };
}

/**
 * The run going (P1h): "Run N of brief vX", Stop with what it does, the engine's own progress lines, and what the run may
 * send. Esc never stops a run: only Stop does.
 */
export function RunGoing({ run, number }: { run: RunState; number: number }) {
  const stopSays = useId();
  const value = run.value!;
  const limits = value.report?.limits ?? null;
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Group gap="sm" style={{ minWidth: 0 }}>
            <Text fw={600}>
              Run {number} of brief v{value.briefVersion}
            </Text>
            <Badge color={STATUS_LOOK[value.status].color} variant="light" data-testid="task-attempt-status">
              {STATUS_LOOK[value.status].label}
            </Badge>
            <Text size="xs" c="var(--nivra-text-3)">
              Started {when(value.createdAt)}
              {limits ? ` · at most ${limits.runMinutes} minutes in all` : ""}
            </Text>
          </Group>
          <Button size="xs" variant="outline" color="red" onClick={run.cancel} loading={run.busy} disabled={value.cancelRequested} aria-describedby={stopSays} style={{ flexShrink: 0 }} data-testid="task-attempt-cancel">
            {value.cancelRequested ? "Stopping…" : "Stop"}
          </Button>
        </Group>
        <Text size="sm" c="var(--nivra-text-2)">
          The worker changes a copy of the commit in a Nebius sandbox, with networking off. Nothing reaches your checkout unless you approve the change.
        </Text>
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
        <Progress lines={value.progress} />
        <Text id={stopSays} size="xs" c="var(--nivra-text-3)">
          Stop ends the run, and nothing from it reaches your checkout. What was already sent stays where it went.
        </Text>
        {limits && (
          <Stack gap={2} data-testid="task-attempt-bounds">
            <Text size="sm" fw={600}>
              What this run may send, and its bounds
            </Text>
            <Text size="xs" c="var(--nivra-text-2)">
              At most {plural(limits.modelRequests, "model request")} of up to {limits.requestSeconds} s and {limits.outputTokensPerRequest.toLocaleString()} output tokens each;{" "}
              {plural(limits.toolCalls, "tool call")}, of which {plural(limits.writes, "write")} of up to {sizeText(limits.writeBytes)} and {plural(limits.runs, "run")} of a case or check; at most{" "}
              {plural(limits.operations, "Nebius operation")}, each command up to {limits.checkSeconds} s; the sandbox for {limits.sessionMinutes} minutes, and the whole run for {limits.runMinutes} minutes.
            </Text>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

/** The engine's own progress lines, as it reports them: the latest 20. */
function Progress({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs">
        <Text size="sm" fw={600}>
          Progress, as the engine reports it
        </Text>
        <Text size="xs" c="var(--nivra-text-3)">
          The latest 20 lines
        </Text>
      </Group>
      <Code block fz="xs" style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="task-attempt-progress">
        {lines.join("\n")}
      </Code>
      <Text size="xs" c="var(--nivra-text-3)">
        The worker's own run of a case only tells it how it's doing: Nivra's final checks decide the result.
      </Text>
    </Stack>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

/** A labelled badge in the result's row: Task, Run and Outcome. */
function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" c="var(--nivra-text-3)">
        {label}
      </Text>
      {children}
    </Group>
  );
}

const OUTCOME_TONE: Record<TaskReport["outcome"], string> = { "in-progress": "blue", proposed: "green", unchanged: "gray", refused: "gray", cancelled: "gray", failed: "red", uncertain: "yellow", interrupted: "yellow" };

/**
 * A run's result (RS1, P1i): its Task, Run and Outcome, the verdict or what became of it, where it started from, what
 * Nebius keeps, and what's still open there. Every sentence is the report's or the host's; nothing is inferred.
 */
export function RunResult({ value, number, task }: { value: TaskAttemptView; number: number; task: { label: string; color: string } }) {
  const report = value.report;
  const outcome = outcomeLookOf(value);
  const [steps, setSteps] = useState(false);
  const stepsId = useId();
  const [progress, setProgress] = useState(false);
  const progressId = useId();
  const missing = report?.toolchain.filter((one) => one.finding === "missing").map((one) => one.program) ?? [];
  const cleanup = report?.cleanup ?? null;
  return (
    <Paper withBorder p="md" radius="md" data-testid="task-attempt-result">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline" wrap="wrap" gap="xs">
          <Text fw={600}>Run {number} result</Text>
          <Text size="xs" c="var(--nivra-text-3)">
            {value.settledAt ? `Ended ${when(value.settledAt)}` : `Started ${when(value.createdAt)}`} · brief v{value.briefVersion}
          </Text>
        </Group>
        <Group gap="md" wrap="wrap">
          <Labelled label="Task">
            <Badge color={task.color} variant="light">
              {task.label}
            </Badge>
          </Labelled>
          <Labelled label="Run">
            <Badge color={STATUS_LOOK[value.status].color} variant="light" data-testid="task-attempt-status">
              {STATUS_LOOK[value.status].label}
            </Badge>
          </Labelled>
          <Labelled label="Outcome">
            <Badge color={outcome.color} variant="light" data-testid="task-attempt-outcome-badge">
              {outcome.label}
            </Badge>
          </Labelled>
        </Group>
        {report?.outcome === "proposed" && (
          <Alert color={report.verified ? "green" : outcome.color === "red" ? "red" : "yellow"} variant="light" data-testid="task-attempt-verdict">
            <Text size="sm">{verdictText(report)}</Text>
          </Alert>
        )}
        {report && report.outcome !== "proposed" && (
          <Alert color={OUTCOME_TONE[report.outcome]} variant="light" data-testid="task-attempt-outcome">
            <Text size="sm" fw={600}>
              {OUTCOME[report.outcome]}
            </Text>
            {report.stopped && (
              <Text size="sm" data-testid="task-attempt-stopped">
                {report.stopped.message}
              </Text>
            )}
          </Alert>
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
        {report && startedFrom(report) && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="task-attempt-environment">
            {startedFrom(report)}
          </Text>
        )}
        {missing.length > 0 && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="task-attempt-toolchain">
            Not in the sandbox: {missing.join(", ")}. A case or check that runs {missing.length === 1 ? "it" : "one of them"} couldn't, so change the command, or prepare an environment that has{" "}
            {missing.length === 1 ? "it" : "them"}.
          </Text>
        )}
        {cleanup && (
          <Stack gap={2} data-testid="task-attempt-cleanup">
            {cleanup.unresolved.length > 0 && (
              <>
                <Text size="sm" fw={600}>
                  Still open in Nebius
                </Text>
                <List size="sm">
                  {cleanup.unresolved.map((item) => (
                    <List.Item key={item}>{item}</List.Item>
                  ))}
                </List>
              </>
            )}
            <Text size="xs" c="var(--nivra-text-3)">
              Cleanup: {plural(cleanup.stopped, "operation")} stopped, {plural(cleanup.alreadyEnded, "operation")} had already ended.
              {cleanup.retained ? ` Nebius keeps ${plural(cleanup.retained.uploads, "upload")}, ${plural(cleanup.retained.images, "image")} and ${plural(cleanup.retained.operations, "operation record")} from this run. ${cleanup.retained.note}` : ""}
            </Text>
          </Stack>
        )}
        {value.progress.length > 0 && (
          <Stack gap={4}>
            <UnstyledButton onClick={() => setProgress(!progress)} aria-expanded={progress} aria-controls={progress ? progressId : undefined} data-testid="task-attempt-progress-toggle">
              <Text size="xs" c="var(--nivra-text-2)" td="underline">
                {progress ? "Hide the engine's progress lines" : "Show the engine's progress lines"}
              </Text>
            </UnstyledButton>
            <Collapse expanded={progress}>
              <div id={progressId}>
                <Progress lines={value.progress} />
              </div>
            </Collapse>
          </Stack>
        )}
        {report && report.steps.length > 0 && (
          <Stack gap={4}>
            <UnstyledButton onClick={() => setSteps(!steps)} aria-expanded={steps} aria-controls={steps ? stepsId : undefined} data-testid="task-attempt-steps-toggle">
              <Text size="xs" c="var(--nivra-text-2)" td="underline">
                {steps ? "Hide the steps in the sandbox" : `Show the ${plural(report.steps.length, "step")} in the sandbox`}
              </Text>
            </UnstyledButton>
            <Collapse expanded={steps}>
              <Stack gap={0} id={stepsId} data-testid="task-attempt-steps">
                {report.steps.map((step, index) => (
                  <Text key={index} size="xs" c="var(--nivra-text-2)" data-testid="task-attempt-step">
                    <Code>{step.label}</Code> {step.cancelled ? "stopped" : step.timedOut ? "timed out" : step.exitCode === null ? "didn't finish" : `exited ${step.exitCode}`}
                    {step.status ? `, Nebius said ${step.status}` : ""}
                    {step.durationMs !== null ? `, ${(step.durationMs / 1000).toFixed(1)} s` : ""}
                  </Text>
                ))}
              </Stack>
            </Collapse>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

/** One row of the checks: what it is, its name and command, what happened, and its badge; output for what didn't pass. */
function CheckRow({ label, title, command, detail, badge, output, children, ...data }: { label: ReactNode; title: string | null; command: string | null; detail: string | null; badge: { label: string; color: string }; output?: { stdout: string; stderr: string; testId?: string } | null; children?: ReactNode; [key: `data-${string}`]: string }) {
  return (
    <Group align="flex-start" wrap="nowrap" gap="md" py={10} style={{ borderTop: "1px solid var(--nivra-border)" }} {...data}>
      <Text size="sm" w={132} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
            {title}
          </Text>
        )}
        {command && (
          <Text size="xs" ff="monospace" style={{ overflowWrap: "anywhere" }}>
            {command}
          </Text>
        )}
        {detail && (
          <Text size="xs" c="var(--nivra-text-2)" style={{ overflowWrap: "anywhere" }}>
            {detail}
          </Text>
        )}
        {children}
        {output?.stdout && (
          <Code block fz="xs" style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid={output.testId}>
            {output.stdout}
          </Code>
        )}
        {output?.stderr && (
          <Code block fz="xs" style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {output.stderr}
          </Code>
        )}
      </Stack>
      <Badge size="sm" variant="light" color={badge.color} style={{ flexShrink: 0 }}>
        {badge.label}
      </Badge>
    </Group>
  );
}

const ran = (exitCode: number | null, durationMs: number | null) => [exitCode !== null ? `Exited ${exitCode}` : null, durationMs !== null ? `${(durationMs / 1000).toFixed(1)} s` : null].filter(Boolean).join(" · ");

/**
 * What Nivra ran itself (P1i, RS1, RS5): the baseline checks on the commit as it was, then each acceptance case, the frozen
 * and setup files, and the repository's checks, reported only. A command is shown only from the brief version the run
 * ran (`content`, null when the brief has moved on), since the report keeps names, not commands.
 */
export function RunChecks({ report, content }: { report: TaskReport; content: BriefContent | null }) {
  const setup = report.setup ?? null;
  const changedSetup = setup?.unchanged === false ? setup.changed : [];
  const any = report.baseline.length + report.checks.length + report.frozen.length + changedSetup.length + (setup?.unchanged === null ? 1 : 0);
  if (!any) return null;
  const decides = ["the acceptance cases", report.frozen.length ? "the frozen files" : null, setup ? "the setup files" : null].filter(Boolean) as string[];
  const listed = decides.length > 1 ? `${decides.slice(0, -1).join(", ")} and ${decides.at(-1)}` : decides[0]!;
  const deciding = listed.charAt(0).toUpperCase() + listed.slice(1);
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap={0}>
        <Text fw={600}>Acceptance cases and checks</Text>
        <Text size="sm" c="var(--nivra-text-2)" pb="xs">
          Nivra ran these itself, with networking off{report.baseline.length ? ": the baseline checks on the commit as it was, the rest on the run's copy" : ", on the run's copy"}. {deciding} decide the result
          {report.checks.some((check) => check.kind === "check") ? "; the repository's checks are reported only." : "."}
        </Text>
        {report.baseline.map((check) => (
          <CheckRow
            key={`baseline-${check.number}`}
            label={`Baseline ${check.number}`}
            title={check.name}
            command={content?.baseline[check.number - 1]?.command ?? null}
            detail={[check.reason, ran(check.exitCode, check.durationMs)].filter(Boolean).join(" · ") || null}
            badge={MATCH_LOOK[matchOf(check)]}
            output={check.matched === true ? null : { stdout: check.stdoutTail, stderr: check.stderrTail, testId: "task-attempt-baseline-output" }}
            data-testid="task-attempt-baseline-check"
            data-match={matchOf(check)}
          />
        ))}
        {report.checks
          .filter((check) => check.kind === "case")
          .map((check) => (
            <CaseOrCheck key={`case-${check.number}`} check={check} command={content?.acceptanceCases[check.number - 1]?.command ?? null} />
          ))}
        {report.frozen.map((file) => (
          <CheckRow
            key={`frozen-${file.path}`}
            label="Frozen file"
            title={null}
            command={file.path}
            detail={file.unchanged === true ? "The same as in the commit, in the workspace the run collected." : file.unchanged === false ? "Changed in the workspace the run collected." : "Nivra couldn't tell whether it's unchanged."}
            badge={{ label: FROZEN_WORD[frozenOf(file.unchanged)], color: FROZEN_LOOK[frozenOf(file.unchanged)] }}
            data-testid="task-attempt-frozen-file"
            data-state={frozenOf(file.unchanged)}
          />
        ))}
        {changedSetup.map((path) => (
          <CheckRow
            key={`setup-${path}`}
            label="Setup file"
            title={null}
            command={path}
            detail="Not as the run's environment was prepared from it."
            badge={{ label: "Changed", color: "red" }}
            data-testid="task-attempt-setup-file"
            data-state="changed"
          />
        ))}
        {setup?.unchanged === null && (
          <CheckRow label="Setup files" title={null} command={null} detail="Nivra couldn't tell whether they're as the run's environment was prepared from them." badge={{ label: "Unknown", color: "yellow" }} data-testid="task-attempt-setup-file" data-state="unknown" />
        )}
        {report.checks
          .filter((check) => check.kind === "check")
          .map((check) => (
            <CaseOrCheck key={`check-${check.number}`} check={check} command={check.name} />
          ))}
      </Stack>
    </Paper>
  );
}

const FROZEN_WORD = { unchanged: "Unchanged", changed: "Changed", unknown: "Unknown" } as const;

function CaseOrCheck({ check, command }: { check: TaskCheck; command: string | null }) {
  const isCase = check.kind === "case";
  const detail = [
    check.reason ? `${check.reason}${check.difference ? ` (line ${check.difference.line}: expected "${check.difference.expected}", got "${check.difference.got}")` : ""}` : null,
    ran(check.exitCode, check.durationMs),
    isCase ? null : "reported, and doesn't decide the result",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <CheckRow
      label={
        isCase ? (
          `Case ${check.number}`
        ) : (
          <>
            Check {check.number}{" "}
            <Text span size="sm" c="var(--nivra-text-3)">
              (reported)
            </Text>
          </>
        )
      }
      title={isCase ? check.name : null}
      command={command}
      detail={detail || null}
      badge={VERDICT_LOOK[check.verdict]}
      output={check.verdict === "passed" ? null : { stdout: check.stdoutTail, stderr: check.stderrTail }}
      data-testid="task-attempt-check"
      data-verdict={check.verdict}
    >
      {(check.changedFiles.length > 0 || check.unclear) && (
        <Text size="xs" c="var(--nivra-warning)" data-testid="task-attempt-check-files">
          {checkFilesText(check)}
        </Text>
      )}
    </CheckRow>
  );
}

/** The most lines drawn for one file's diff: the rest is said, not drawn. */
const MAX_DRAWN = 2_000;

const CHANGE_WORD = { added: "New file", changed: "Changed", deleted: "Deleted" } as const;

/** One file's diff: added and removed lines marked for every reader, not by colour alone. */
function DiffBlock({ file, path }: { file: DiffFile; path: string }) {
  const drawn = file.lines.slice(0, MAX_DRAWN);
  return (
    <div
      role="region"
      aria-label={`Changes to ${path}`}
      style={{ fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12, lineHeight: 1.55, border: "1px solid var(--nivra-border)", borderRadius: 6, overflow: "auto", maxHeight: 480 }}
    >
      {drawn.map((line, index) => (
        <div
          key={index}
          style={{
            whiteSpace: "pre",
            padding: "0 10px",
            background: line.kind === "added" ? "var(--nivra-diff-added, rgba(34, 197, 94, 0.14))" : line.kind === "removed" ? "var(--nivra-diff-removed, rgba(239, 68, 68, 0.14))" : undefined,
            color: line.kind === "hunk" || line.kind === "note" ? "var(--nivra-text-3)" : undefined,
          }}
        >
          {line.kind === "added" && <VisuallyHidden>Added: </VisuallyHidden>}
          {line.kind === "removed" && <VisuallyHidden>Removed: </VisuallyHidden>}
          <span aria-hidden="true">{line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : line.kind === "context" ? "  " : ""}</span>
          {line.text}
        </div>
      ))}
      {file.lines.length > drawn.length && (
        <Text size="xs" c="var(--nivra-text-3)" px={10} py={4}>
          {plural(file.lines.length - drawn.length, "more line")} of this file's diff aren't drawn here.
        </Text>
      )}
    </div>
  );
}

/**
 * The change (P1i): its hash and commit, then each file it touches, with its kind and counts; a file opens into its diff,
 * the first one open. Counts come from the patch as shown: past the cut, a file says so instead of a diff.
 */
export function RunChanges({ proposal }: { proposal: TaskProposal }) {
  const files = useMemo(() => diffFilesOf(proposal.patch, proposal.paths.map((one) => one.path), proposal.truncated), [proposal.patch, proposal.paths, proposal.truncated]);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(proposal.paths.slice(0, 1).map((one) => one.path)));
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const listId = useId();
  const toggle = (path: string) => setOpened((was) => (was.has(path) ? new Set([...was].filter((one) => one !== path)) : new Set([...was, path])));
  return (
    <Paper withBorder p="md" radius="md" data-testid="task-attempt-change">
      <Stack gap="xs">
        <Group justify="space-between" align="baseline" wrap="wrap" gap="xs">
          <Text fw={600}>Changes</Text>
          <Text size="xs" c="var(--nivra-text-3)">
            {plural(proposal.paths.length, "file")} · {plural(added, "line")} added, {removed.toLocaleString()} removed{proposal.truncated ? ", in the part shown" : ""}
          </Text>
        </Group>
        <Text size="xs" c="var(--nivra-text-3)">
          Change {proposal.hash.slice(0, 12)}, to commit <Code>{proposal.baseline.slice(0, 12)}</Code>.
        </Text>
        <Stack gap={0} data-testid="task-attempt-patch" id={listId}>
          {proposal.paths.map((one) => {
            const file = byPath.get(one.path) ?? null;
            const isOpen = opened.has(one.path);
            const diffId = `${listId}-${proposal.paths.indexOf(one)}`;
            // Its mode, from the proposal's own states, which hold past the cut too; the patch's header backs a changed one.
            const mode =
              modeChangeOf(one) ??
              (one.change === "changed" && file?.modes?.before && file.modes.after && file.modes.before !== file.modes.after
                ? modeChangeOf({ change: "changed", before: { mode: file.modes.before }, after: { mode: file.modes.after } })
                : null);
            const contentless = file !== null && !file.binary && file.lines.length === 0;
            return (
              <Stack key={one.path} gap={6} py={6} style={{ borderTop: "1px solid var(--nivra-border)" }} data-testid="task-attempt-change-file" data-path={one.path} data-change={one.change}>
                <UnstyledButton onClick={() => toggle(one.path)} aria-expanded={isOpen} aria-controls={diffId}>
                  <Group justify="space-between" wrap="nowrap" gap="sm">
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Chevron open={isOpen} />
                      <Text size="sm" ff="monospace" style={{ overflowWrap: "anywhere" }}>
                        {one.path}
                      </Text>
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      <Badge size="sm" variant="light" color="gray">
                        {CHANGE_WORD[one.change]}
                      </Badge>
                      {mode && (
                        <Badge size="sm" variant="light" color={mode.applies ? "gray" : "yellow"} data-testid="task-attempt-change-mode">
                          {mode.after && mode.before ? `Mode ${mode.before} to ${mode.after}` : `Mode ${mode.after}`}
                        </Badge>
                      )}
                      {file && !file.binary && (
                        <Text size="xs" c="var(--nivra-text-3)">
                          {contentless ? (mode ? "mode only" : "no lines") : `+${file.added} −${file.removed}`}
                        </Text>
                      )}
                    </Group>
                  </Group>
                </UnstyledButton>
                <Collapse expanded={isOpen} keepMounted={false}>
                  <div id={diffId}>
                    {mode && (
                      <Text size="xs" c={mode.applies ? "var(--nivra-text-2)" : "var(--nivra-warning)"} pb={4} data-testid="task-attempt-change-mode-text">
                        {mode.text}.{mode.applies ? "" : " Nivra doesn't apply this: approving the change would be refused, and nothing written."}
                      </Text>
                    )}
                    {file === null ? (
                      <Text size="xs" c="var(--nivra-text-3)">
                        Its diff is past the part of the change shown.
                      </Text>
                    ) : file.binary ? (
                      <Text size="xs" c="var(--nivra-text-3)">
                        A binary file: its contents aren't shown.
                      </Text>
                    ) : contentless ? (
                      <Text size="xs" c="var(--nivra-text-3)">
                        {mode ? "Its content is unchanged." : "The patch shows no lines for it."}
                      </Text>
                    ) : (
                      <>
                        <DiffBlock file={file} path={one.path} />
                        {file.cut && (
                          <Text size="xs" c="var(--nivra-text-3)">
                            The part of the change shown ends in this file.
                          </Text>
                        )}
                      </>
                    )}
                  </div>
                </Collapse>
              </Stack>
            );
          })}
        </Stack>
        {proposal.truncated && (
          <Text size="xs" c="var(--nivra-text-3)">
            Only the start of the change is shown: it is {sizeText(proposal.patchBytes)} in all.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/** A small chevron for something that opens and closes. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms ease" }}>
      <path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The worker (P1i): how it handed in, after what, its tokens as reported, and its own account, which Nivra didn't check. */
export function RunWorker({ report }: { report: TaskReport }) {
  const worker = report.worker;
  if (!worker) return null;
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="xs" data-testid="task-attempt-worker">
        <Text fw={600}>The worker</Text>
        <Text size="sm">
          The worker ({worker.model}) {ENDED[worker.ended]}, after {plural(worker.usage.calls, "model request")}, {plural(worker.tools.writes, "write")} and {plural(worker.tools.runs, "run")}
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
    </Paper>
  );
}

/**
 * Everything a run found (RS1, P1i), as cards: its result, the checks, the change, and the worker. The group carries the
 * report's outcome, and whether its change is verified.
 */
export function RunReview({ value, number, task, content, decision = null }: { value: TaskAttemptView; number: number; task: { label: string; color: string }; content: BriefContent | null; /** The decision, right after the result when the columns stack (NW3). */ decision?: ReactNode }) {
  const report = value.report;
  return (
    <Stack gap="md" data-testid={report ? "task-attempt-report" : undefined} data-outcome={report?.outcome} data-verified={report ? report.verified : undefined}>
      <RunResult value={value} number={number} task={task} />
      {decision}
      {report && <RunChecks report={report} content={content} />}
      {value.proposal && <RunChanges proposal={value.proposal} />}
      {report && <RunWorker report={report} />}
    </Stack>
  );
}
