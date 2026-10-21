import { Alert, Badge, Button, Code, Group, List, Modal, Stack, Table, Text } from "@mantine/core";
import type { SandboxPreview, SandboxReport, SandboxStatus } from "@nivra/domain";
import { useEffect, useState } from "react";
import type { ProjectView, SandboxCheckView } from "../../../shared/ipc";
import { STATUS_COLOR } from "../shared/evidence";
import { TERMINAL, useRunEvents } from "../shared/runs";
import { errorMessage, Section } from "../shared/ui";

type Ready = Extract<SandboxPreview, { status: "ready" }>;

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const sizeText = (bytes: number) => (bytes < 1024 ? plural(bytes, "byte") : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/** Why files are left out of what is sent, in the person's terms. */
const LEFT_OUT: Record<keyof Ready["leftOut"], string> = {
  secret: "that may hold secrets",
  output: "of dependency or build output",
  submodule: "in submodules",
  excluded: "of Nivra's own data",
};

/** What each outcome means, without claiming more than the check showed. */
const OUTCOME: Record<SandboxReport["outcome"], string> = {
  "in-progress": "The check is going.",
  unchanged: "The sandbox held exactly this commit, and the check changed nothing.",
  proposed: "The check came back with a change. Nivra never applies a check's change.",
  refused: "The check was refused.",
  cancelled: "The check was stopped.",
  failed: "The check couldn't finish.",
  uncertain: "Part of the check may still be running in Nebius.",
  interrupted: "The check was interrupted when its engine stopped.",
};

/** Where a check's start stands before its run is known. */
const STARTING: Partial<Record<SandboxCheckView["status"], string>> = { sending: "sending", looking: "looking for it", "not-sent": "not sent", unknown: "unknown" };

const leftOutLines = (preview: Ready): string[] =>
  (Object.keys(LEFT_OUT) as Array<keyof Ready["leftOut"]>)
    .filter((reason) => preview.leftOut[reason].count > 0)
    .map((reason) => {
      const { count, sample } = preview.leftOut[reason];
      return `${plural(count, "file")} ${LEFT_OUT[reason]}${sample.length ? ` (${sample.join(", ")}${count > sample.length ? ", …" : ""})` : ""}`;
    });

/**
 * A sandbox check of the chosen project (D36): what would be uploaded, previewed on its own engine with no network;
 * upload consent of its own, asked with that preview in front of the person; then the check's progress and report. The
 * check runs Nivra's own fixed steps with networking off, and nothing comes back to the checkout.
 */
export function SandboxCheck({ project, online, onProjectChanged }: { project: ProjectView | null; online: boolean; onProjectChanged(): void }) {
  const projectId = project?.id ?? null;
  const [preview, setPreview] = useState<SandboxPreview | null>(null);
  const [check, setCheck] = useState<SandboxCheckView | null>(null);
  const [leftOpen, setLeftOpen] = useState<SandboxStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = check?.runId ?? null;
  const { events, status: runStatus } = useRunEvents(runId, online, null);
  const starting = check !== null && (check.status === "sending" || check.status === "looking");
  const running = starting || (runId !== null && runStatus !== null && !TERMINAL.includes(runStatus));

  const reload = async () => {
    if (!projectId) return;
    setCheck(await window.nivra.getSandboxCheck(projectId));
  };

  // What this session knows of the project's check, and what earlier sessions left open in Nebius.
  useEffect(() => {
    if (!projectId || !online) return;
    let active = true;
    window.nivra.getSandboxCheck(projectId).then((view) => active && setCheck(view), (reason: unknown) => active && setError(errorMessage(reason)));
    window.nivra.getSandboxStatus(projectId).then((value) => active && setLeftOpen(value), () => undefined);
    return () => {
      active = false;
    };
  }, [projectId, online]);

  // A start whose answer was lost is being found: ask again until it is, or until it is known never to have arrived.
  useEffect(() => {
    if (!starting || !online) return;
    const timer = setInterval(() => void reload().catch((reason: unknown) => setError(errorMessage(reason))), 1_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starting, online, projectId]);

  // Once the run ends, its report is read.
  useEffect(() => {
    if (!runStatus || !TERMINAL.includes(runStatus)) return;
    void reload().catch((reason: unknown) => setError(errorMessage(reason)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus]);

  async function act(body: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await body();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const previewIt = () =>
    act(async () => {
      if (!projectId) return;
      setPreview(null);
      setPreview(await window.nivra.previewSandboxCheck(projectId));
    });

  const start = async () => {
    if (!projectId || preview?.status !== "ready") return;
    setCheck(await window.nivra.startSandboxCheck(projectId, preview.fingerprint));
  };

  const allowAndStart = () =>
    act(async () => {
      if (!projectId) return;
      setConsent(false);
      await window.nivra.setCloudExecution(projectId, true);
      onProjectChanged();
      await start();
    });

  const turnOff = () =>
    act(async () => {
      if (!projectId) return;
      try {
        await window.nivra.setCloudExecution(projectId, false);
        if (check) await reload();
      } finally {
        // Uploads are off even when a check couldn't be stopped, so the view must say so.
        onProjectChanged();
      }
    });

  const report = check?.report ?? null;
  const ready = preview?.status === "ready" ? preview : null;
  const badge = runId && runStatus ? runStatus.replaceAll("_", " ") : check ? (STARTING[check.status] ?? check.status) : null;
  return (
    <Section
      title="Sandbox check"
      description="Upload this project's commit to Nebius Sandboxes and check it there, with networking off. Nivra runs its own fixed steps, and nothing comes back to your checkout."
    >
      <Group gap="sm">
        <Button variant="default" onClick={() => void previewIt()} loading={busy && !consent && !running} disabled={!projectId || !online || running} data-testid="sandbox-preview">
          Preview the check
        </Button>
        <Button onClick={() => (project?.sharing.cloudExecution ? void act(start) : setConsent(true))} disabled={!ready || !online || running || busy} data-testid="sandbox-start">
          Upload and check
        </Button>
        {running && projectId && (
          <Button variant="default" onClick={() => void act(async () => setCheck(await window.nivra.cancelSandboxCheck(projectId)))} disabled={!online} data-testid="sandbox-cancel">
            Cancel
          </Button>
        )}
        {badge && (
          <Badge color={runStatus && runId ? STATUS_COLOR[runStatus] : "gray"} variant="light" data-testid="sandbox-status" data-run-id={runId ?? undefined}>
            {badge}
          </Badge>
        )}
        {project?.sharing.cloudExecution && (
          <Group gap={4}>
            <Badge variant="light" color="blue" style={{ textTransform: "none" }} data-testid="sandbox-uploads">
              Uploads to Nebius Sandboxes: on
            </Badge>
            <Button size="compact-xs" variant="subtle" onClick={() => void turnOff()} data-testid="sandbox-uploads-off">
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
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="sandbox-error">
          {error}
        </Text>
      )}
      {preview?.status === "refused" && (
        <Alert color="yellow" variant="light" data-testid="sandbox-preview-refused">
          <Text size="sm">{preview.message}</Text>
        </Alert>
      )}
      {ready && (
        <Stack gap={2} data-testid="sandbox-preview-panel">
          <Text size="sm">
            Commit <Code>{ready.baseline.slice(0, 12)}</Code>
            {ready.prefix ? (
              <>
                , folder <Code>{ready.prefix}</Code>
              </>
            ) : null}
            : {plural(ready.files, "file")}, {sizeText(ready.bytes)} to upload.
          </Text>
          <Text size="sm" c="var(--nivra-text-2)" data-testid="sandbox-preview-left-out">
            Left out: {leftOutLines(ready).length ? leftOutLines(ready).join("; ") : "nothing"}.
            {ready.untracked.count ? ` ${plural(ready.untracked.count, "untracked file")} stay here.` : ""}
          </Text>
          <Text size="xs" c="var(--nivra-text-3)">
            What Nebius keeps: {ready.retention}
          </Text>
        </Stack>
      )}
      {check?.note && (
        <Alert color="yellow" variant="light" data-testid="sandbox-note">
          <Text size="sm">{check.note}</Text>
        </Alert>
      )}
      {events.length > 0 && (
        <Table data-testid="sandbox-timeline">
          <Table.Tbody>
            {events
              .filter((event) => event.type === "step.output" || event.type.startsWith("run."))
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
      {report && <Report report={report} />}
      {leftOpen && leftOpen.open.length > 0 && (
        <Text size="sm" c="var(--nivra-warning)" data-testid="sandbox-left-open">
          Earlier checks on this engine left {plural(leftOpen.open.reduce((sum, journal) => sum + journal.operations + journal.uncertain, 0), "operation")} open in Nebius.{" "}
          {leftOpen.pass.state === "waiting-for-credentials"
            ? "Nivra stops them once your key and project id are set."
            : leftOpen.pass.state === "running"
              ? "Nivra is stopping them now."
              : "Nivra couldn't stop them all; they may still be running, so check your Nebius project."}
        </Text>
      )}
      <Modal opened={consent} onClose={() => setConsent(false)} title="Upload this project's commit to Nebius Sandboxes?" data-testid="sandbox-consent">
        {ready && (
          <Stack gap="sm">
            <Text size="sm">To check {project?.label ?? "this repository"}, Nivra uploads one snapshot to your Nebius project, and runs its own fixed steps there with networking off:</Text>
            <List size="sm">
              <List.Item>
                commit {ready.baseline.slice(0, 12)}
                {ready.prefix ? `, folder ${ready.prefix}` : ""}: {plural(ready.files, "file")}, {sizeText(ready.bytes)};
              </List.Item>
              <List.Item>nothing left out: {leftOutLines(ready).length ? leftOutLines(ready).join("; ") : "no file is left out of this commit"};</List.Item>
              <List.Item>none of your uncommitted or untracked work: a check works from the commit.</List.Item>
            </List>
            <Text size="sm">
              Before the upload, Nivra checks every file for what looks like a key or token, and refuses the commit if one does. It can't recognise every secret: don't allow this
              for a project whose commits hold secrets you can't share.
            </Text>
            <Text size="sm">What Nebius keeps: {ready.retention}</Text>
            <Text size="sm">
              This is separate from sending content to Token Factory, and it is for this project only. You can turn it off at any time, which stops a check under way; what was
              already uploaded stays with Nebius.
            </Text>
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setConsent(false)}>
                Cancel
              </Button>
              <Button onClick={() => void allowAndStart()} data-testid="sandbox-consent-allow">
                Allow uploads for this project
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Section>
  );
}

/** A check's report: its outcome, each step, and cleanup's own record of what was stopped and what Nebius keeps. */
function Report({ report }: { report: SandboxReport }) {
  const { cleanup } = report;
  return (
    <Stack gap={4} data-testid="sandbox-report" data-outcome={report.outcome}>
      <Text size="sm" fw={500}>
        {OUTCOME[report.outcome]}
      </Text>
      {report.stopped && (
        <Text size="sm" data-testid="sandbox-stopped">
          {report.stopped.message}
        </Text>
      )}
      {report.steps.map((step) => (
        <Stack key={step.label} gap={2} data-testid="sandbox-step">
          <Text size="sm">
            <Code>{step.label}</Code> {step.cancelled ? "stopped" : step.timedOut ? "timed out" : step.exitCode === null ? "didn't finish" : `exited ${step.exitCode}`}
            {step.status ? `, Nebius said ${step.status}` : ""}
            {step.durationMs !== null ? `, ${(step.durationMs / 1000).toFixed(1)} s` : ""}
          </Text>
          {step.stdoutTail && (
            <Code block fz="xs">
              {step.stdoutTail}
            </Code>
          )}
        </Stack>
      ))}
      {cleanup && (
        <Stack gap={2} data-testid="sandbox-cleanup">
          <Text size="sm">
            Cleanup: {plural(cleanup.stopped, "operation")} stopped, {plural(cleanup.alreadyEnded, "operation")} had already ended.
          </Text>
          {cleanup.unresolved.length > 0 && (
            <List size="sm" data-testid="sandbox-unresolved">
              {cleanup.unresolved.map((item) => (
                <List.Item key={item}>{item}</List.Item>
              ))}
            </List>
          )}
          {cleanup.retained && (
            <Text size="xs" c="var(--nivra-text-3)">
              Nebius keeps {plural(cleanup.retained.uploads, "upload")}, {plural(cleanup.retained.images, "image")} and {plural(cleanup.retained.operations, "operation record")} from this check. {cleanup.retained.note}
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}
