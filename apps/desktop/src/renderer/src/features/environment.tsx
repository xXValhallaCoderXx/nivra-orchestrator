import { Alert, Badge, Button, Checkbox, Code, Group, List, Modal, Radio, Stack, Text } from "@mantine/core";
import type { EnvironmentPreview, EnvironmentReport, PreparedEnvironment } from "@nivra/domain";
import { useRef, useState } from "react";
import type { EnvironmentView, PreparationView, ProjectView, TurnStatus } from "../../../shared/ipc";
import { errorMessage, Section, usePoll } from "../shared/ui";

/**
 * A project's environment (D41): its dependencies, installed once in a Nebius sandbox from the commit's manifests and
 * lockfile, kept as an image its task runs start from with networking off. The person chooses which packages to install,
 * sees what preparing sends and runs, previewed on the project's own engine, and prepares it; uploads are asked for, as
 * the sandbox check asks, when they aren't allowed. The install's log is shown as text, never as markup.
 * `credentialsSaved` changes each time the key or project id is saved: what keeps Prepare from being pressed is read again.
 */

type Ready = Extract<EnvironmentPreview, { status: "ready" }>;

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const sizeText = (bytes: number) => (bytes < 1024 ? plural(bytes, "byte") : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const minutes = (seconds: number) => plural(Math.round(seconds / 60), "minute");
const going = (status: TurnStatus) => status === "submitting" || status === "running";
/** A preparation takes at most this many filters (`ENVIRONMENT_LIMITS.filters`): the window counts them before the host does. */
const MAX_FILTERS = 8;
/** One package of the workspace, with the packages it depends on, as pnpm selects it. */
const filterOf = (name: string) => `${name}...`;

const STATUS_LOOK: Record<TurnStatus, { label: string; color: string }> = {
  submitting: { label: "Sending", color: "blue" },
  running: { label: "Preparing", color: "blue" },
  answered: { label: "Ended", color: "green" },
  failed: { label: "Failed", color: "red" },
  cancelled: { label: "Cancelled", color: "gray" },
  interrupted: { label: "Interrupted", color: "yellow" },
  "not-sent": { label: "Not sent", color: "gray" },
  unknown: { label: "Unknown", color: "yellow" },
};

/** What each outcome means, without claiming more than the preparation showed. */
const OUTCOME: Record<EnvironmentReport["outcome"], string> = {
  "in-progress": "The preparation is going.",
  prepared: "The environment was prepared.",
  refused: "The preparation was refused before anything was sent.",
  cancelled: "The preparation was stopped.",
  failed: "The preparation couldn't finish.",
  uncertain: "Part of the preparation may still be running in Nebius.",
  interrupted: "The preparation was interrupted when its engine stopped.",
};

/** The packages a spec installs, in words. */
const packagesText = (filters: readonly string[]) => (filters.length === 0 ? "the whole workspace" : filters.join(", "));

export function Environment({ project, online, credentialsSaved, onProjectChanged }: { project: ProjectView | null; online: boolean; credentialsSaved: number; onProjectChanged(): void }) {
  const projectId = project?.id ?? null;
  const state = usePoll<EnvironmentView>(
    () => window.nivra.getEnvironment(projectId!),
    (value) => (value?.preparation && going(value.preparation.status) ? 1_500 : null),
    [projectId, credentialsSaved],
    projectId !== null && online,
  );
  const view = state.value;
  // The packages chosen here, until the person changes them: the ones accepted with the last preparation.
  const [choice, setChoice] = useState<{ whole: boolean; filters: string[] } | null>(null);
  const [preview, setPreview] = useState<EnvironmentPreview | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The consent dialog stays on screen while it fades out, so a second press must not start a second preparation.
  const allowing = useRef(false);

  const accepted = view?.spec?.filters ?? [];
  const chosen = choice ?? { whole: accepted.length === 0, filters: accepted };
  const filters = chosen.whole ? [] : chosen.filters;
  const key = JSON.stringify(filters);
  const ready = preview?.status === "ready" ? preview : null;
  const preparation = view?.preparation ?? null;
  const underway = preparation !== null && going(preparation.status);
  const stale = ready !== null && previewed !== key;
  const noneChosen = !chosen.whole && chosen.filters.length === 0;

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

  // A preview reads the project's environment again too: the keys, or uploads, may have changed elsewhere since.
  const previewIt = () =>
    act(async () => {
      if (!projectId) return;
      setPreview(null);
      setPreview(await window.nivra.previewEnvironment(projectId, { filters }));
      setPreviewed(key);
      state.refresh();
    });

  const start = async () => {
    if (!projectId || !ready) return;
    await window.nivra.prepareEnvironment(projectId, { filters }, ready.fingerprint);
    state.refresh();
  };

  const allowAndStart = async () => {
    if (allowing.current) return;
    allowing.current = true;
    try {
      await act(async () => {
        if (!projectId) return;
        setConsent(false);
        await window.nivra.setCloudExecution(projectId, true);
        onProjectChanged();
        await start();
      });
    } finally {
      allowing.current = false;
    }
  };

  const cancel = () =>
    act(async () => {
      if (!projectId) return;
      await window.nivra.cancelPreparation(projectId);
      state.refresh();
    });

  const prepareBlocked = !ready || stale || noneChosen || underway || busy || !online || view?.blocked !== null;
  return (
    <Section
      title="Environment"
      description="Install this project's dependencies once, in a Nebius sandbox, from its commit's manifests and lockfile. Its task runs then start from the result, with networking off."
    >
      <Stack gap="sm" data-testid="environment">
        {!projectId && (
          <Text size="sm" c="var(--nivra-text-3)">
            Add or choose a repository first.
          </Text>
        )}
        {state.error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="environment-error">
            {state.error}
          </Text>
        )}
        {view?.prepared && <Prepared prepared={view.prepared} />}
        {view && !view.prepared && !underway && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="environment-none">
            No environment is prepared for this project yet, so its task runs start from Nivra's own base image, with nothing installed.
          </Text>
        )}
        {view?.notice && (
          <Alert color="yellow" variant="light" data-testid="environment-notice">
            <Text size="sm">{view.notice}</Text>
          </Alert>
        )}
        {preparation && <Preparation preparation={preparation} />}
        <Group gap="sm">
          <Button variant="default" onClick={() => void previewIt()} loading={busy && !consent && !underway} disabled={!projectId || !online || underway || noneChosen} data-testid="environment-preview">
            {ready && stale ? "Preview this choice" : view?.prepared || preparation ? "Preview preparing again" : "Preview the preparation"}
          </Button>
          <Button onClick={() => (project?.sharing.cloudExecution ? void act(start) : setConsent(true))} disabled={prepareBlocked} data-testid="environment-prepare">
            {view?.prepared || preparation ? "Prepare again" : "Prepare"}
          </Button>
          {underway && (
            <Button variant="default" onClick={() => void cancel()} disabled={!online || preparation.cancelRequested} data-testid="environment-cancel">
              {preparation.cancelRequested ? "Stopping…" : "Cancel"}
            </Button>
          )}
        </Group>
        {view?.blocked && !underway && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="environment-blocked">
            {view.blocked}
          </Text>
        )}
        {project && !project.sharing.cloudExecution && !underway && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="environment-uploads-off">
            Uploads to Nebius Sandboxes are off for this project. Prepare asks you to allow them first, after showing what would be sent.
          </Text>
        )}
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="environment-action-error">
            {error}
          </Text>
        )}
        {preview?.status === "refused" && (
          <Alert color="yellow" variant="light" data-testid="environment-preview-refused">
            <Text size="sm">{preview.message}</Text>
          </Alert>
        )}
        {ready && (
          <PreviewPanel
            ready={ready}
            chosen={chosen}
            stale={stale}
            onChoose={(next) => setChoice(next)}
          />
        )}
      </Stack>
      <Modal opened={consent} onClose={() => setConsent(false)} title="Upload this project's manifests to Nebius Sandboxes?" data-testid="environment-consent">
        {ready && (
          <Stack gap="sm">
            <Text size="sm">
              To prepare {project?.label ?? "this repository"}'s environment, Nivra uploads these files from commit {ready.baseline.slice(0, 12)} to your Nebius project, and runs one
              install there with networking on:
            </Text>
            <List size="sm">
              <List.Item>
                {plural(ready.inputs.length, "file")}, {sizeText(ready.sentBytes)} compressed: the manifests, the lockfile and the workspace file;
              </List.Item>
              {ready.leftOut.length > 0 && <List.Item>never sent: {ready.leftOut.join(", ")};</List.Item>}
              <List.Item>none of the commit's sources, and none of your uncommitted or untracked work.</List.Item>
            </List>
            <Text size="sm">{ready.network}</Text>
            <Text size="sm">What Nebius keeps: {ready.retention}</Text>
            <Text size="sm">
              This is separate from sending content to Token Factory, and it is for this project only: its sandbox checks, its environment and its task runs. You can turn it off at
              any time: Nivra then stops a check, a preparation or a run under way, and says so if it can't. What was already uploaded stays with Nebius.
            </Text>
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setConsent(false)}>
                Cancel
              </Button>
              <Button onClick={() => void allowAndStart()} disabled={busy} data-testid="environment-consent-allow">
                Allow uploads for this project
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Section>
  );
}

/**
 * What preparing would send and run, as the project's engine worked it out: the commit's pins, the packages to install,
 * the files sent and those never sent, the install itself, what it reaches with networking on, what Nebius keeps, and
 * its bounds.
 */
function PreviewPanel({ ready, chosen, stale, onChoose }: { ready: Ready; chosen: { whole: boolean; filters: string[] }; stale: boolean; onChoose(next: { whole: boolean; filters: string[] }): void }) {
  const toggle = (filter: string, on: boolean) => onChoose({ whole: false, filters: on ? [...chosen.filters, filter] : chosen.filters.filter((one) => one !== filter) });
  // Filters accepted before, for packages this commit no longer lists, stay visible so they can be taken off.
  const known = new Set(ready.packages.map((one) => filterOf(one.name)));
  const others = chosen.filters.filter((filter) => !known.has(filter));
  return (
    <Stack gap="xs" data-testid="environment-preview-panel">
      <Text size="sm" data-testid="environment-pins">
        Commit <Code>{ready.baseline.slice(0, 12)}</Code> pins <Code>{ready.packageManager}</Code>, and{" "}
        {ready.nodeRequirement ? (
          <>
            asks for Node <Code>{ready.nodeRequirement}</Code>
          </>
        ) : (
          "doesn't say which Node it needs"
        )}
        . The environment starts from <Code>{ready.base.tag}</Code>, with Node {ready.base.node}.
      </Text>
      <Radio.Group
        label="What to install"
        value={chosen.whole ? "whole" : "chosen"}
        onChange={(value) => onChoose({ whole: value === "whole", filters: chosen.filters })}
        data-testid="environment-choice"
      >
        <Stack gap={4} mt={4}>
          <Radio value="whole" label="The whole workspace" data-testid="environment-whole" />
          <Radio value="chosen" label="Chosen packages, each with the packages it depends on" data-testid="environment-chosen" />
        </Stack>
      </Radio.Group>
      {!chosen.whole && (
        <Stack gap={4} pl="md" data-testid="environment-packages">
          {ready.packages.map((one) => {
            const filter = filterOf(one.name);
            const on = chosen.filters.includes(filter);
            return (
              <Checkbox
                key={one.name}
                label={`${one.name} (${one.path})`}
                checked={on}
                disabled={!on && chosen.filters.length >= MAX_FILTERS}
                onChange={(event) => toggle(filter, event.currentTarget.checked)}
                data-testid="environment-package"
              />
            );
          })}
          {others.map((filter) => (
            <Checkbox key={filter} label={filter} checked onChange={() => toggle(filter, false)} data-testid="environment-package" />
          ))}
          {ready.packages.length === 0 && (
            <Text size="sm" c="var(--nivra-text-3)">
              This commit lists no workspace packages: install the whole workspace.
            </Text>
          )}
          {chosen.filters.length === 0 && (
            <Text size="xs" c="var(--nivra-text-3)">
              Choose at least one package, or the whole workspace.
            </Text>
          )}
          <Text size="xs" c="var(--nivra-text-3)">
            At most {MAX_FILTERS} packages.
          </Text>
        </Stack>
      )}
      {stale ? (
        <Text size="sm" c="var(--nivra-warning)" data-testid="environment-stale">
          This choice isn't the one previewed. Preview it to see what it sends, then prepare.
        </Text>
      ) : (
        <Stack gap={2} data-testid="environment-sends">
          <Text size="sm">
            Sent: {plural(ready.inputs.length, "file")}, {sizeText(ready.sentBytes)} compressed ({ready.inputs.map((input) => input.path).join(", ")}).
            {ready.leftOut.length > 0 ? ` ${ready.leftOut.join(", ")} ${ready.leftOut.length === 1 ? "is" : "are"} never sent.` : ""}
          </Text>
          <Text size="sm">
            Then, in the sandbox: <Code>pnpm install {ready.installArgs.join(" ")}</Code>
          </Text>
          <Text size="sm" data-testid="environment-network">
            {ready.network}
          </Text>
          <Text size="xs" c="var(--nivra-text-3)" data-testid="environment-retention">
            What Nebius keeps: {ready.retention}
          </Text>
          <Text size="xs" c="var(--nivra-text-3)" data-testid="environment-limits">
            Bounds: up to {minutes(ready.limits.importSeconds)} to import the image when your Nebius project doesn't have it yet, and up to {minutes(ready.limits.prepareSeconds)}{" "}
            for the install; {plural(ready.limits.operations, "operation")} with networking on.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

/** The prepared environment: what its task runs start from. */
function Prepared({ prepared }: { prepared: PreparedEnvironment }) {
  return (
    <Alert color="green" variant="light" data-testid="environment-prepared">
      <Stack gap={2}>
        <Text size="sm">
          Prepared {new Date(prepared.preparedAt).toLocaleString()}: Node {prepared.node}, pnpm {prepared.pnpm}, {prepared.arch}. Image <Code>{prepared.image.slice(0, 12)}</Code>, from
          commit <Code>{prepared.baseline.slice(0, 12)}</Code>, with {packagesText(prepared.spec.filters)} installed.
        </Text>
        <Text size="xs" c="var(--nivra-text-3)">
          Its task runs start from it, with networking off, while the commit's manifests stay as they were. It was prepared from {prepared.base.tag}
          {prepared.base.imported ? ", imported into your Nebius project" : ""}.
        </Text>
      </Stack>
    </Alert>
  );
}

/** The latest preparation: its status and progress while it goes, then how it ended and the end of the install's log. */
function Preparation({ preparation }: { preparation: PreparationView }) {
  const { report } = preparation;
  // A failure's report says why in Nivra's words, which the note would repeat.
  const note = preparation.status === "failed" && report?.stopped ? null : preparation.note;
  return (
    <Stack gap="xs" data-testid="environment-preparation" data-status={preparation.status}>
      <Group gap="sm">
        <Badge color={STATUS_LOOK[preparation.status].color} variant="light" data-testid="environment-status">
          {STATUS_LOOK[preparation.status].label}
        </Badge>
        <Text size="xs" c="var(--nivra-text-3)">
          {new Date(preparation.createdAt).toLocaleString()}, {packagesText(preparation.spec.filters)}
        </Text>
      </Group>
      {note && (
        <Alert color="yellow" variant="light" data-testid="environment-note">
          <Text size="sm">{note}</Text>
        </Alert>
      )}
      {preparation.unresolved && (
        <Text size="sm" c="var(--nivra-warning)" data-testid="environment-unresolved">
          {preparation.unresolved}
        </Text>
      )}
      {preparation.progress.length > 0 && (
        <Stack gap={0} data-testid="environment-progress">
          {preparation.progress.map((line, index) => (
            <Text key={index} size="xs" c="var(--nivra-text-2)" ff="monospace" style={{ overflowWrap: "anywhere" }}>
              {line}
            </Text>
          ))}
        </Stack>
      )}
      {report && report.outcome !== "in-progress" && (
        <Stack gap={4} data-testid="environment-report" data-outcome={report.outcome}>
          <Text size="sm" fw={500}>
            {OUTCOME[report.outcome]}
          </Text>
          {report.stopped && (
            <Text size="sm" data-testid="environment-stopped">
              {report.stopped.message}
            </Text>
          )}
          {report.install && report.outcome !== "prepared" && report.install.logTail && (
            <Stack gap={2}>
              <Text size="xs" c="var(--nivra-text-3)">
                The end of the install's log, as the sandbox printed it{report.install.exitCode !== null ? ` (it exited ${report.install.exitCode})` : ""}:
              </Text>
              <Code block fz="xs" style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }} data-testid="environment-log">
                {report.install.logTail}
              </Code>
            </Stack>
          )}
          {report.cleanup && (
            <Text size="xs" c="var(--nivra-text-3)" data-testid="environment-cleanup">
              Cleanup: {plural(report.cleanup.stopped, "operation")} stopped, {plural(report.cleanup.alreadyEnded, "operation")} had already ended.
              {report.cleanup.unresolved.length > 0 ? ` Still open: ${report.cleanup.unresolved.join(" ")}` : ""}
              {report.cleanup.retained
                ? ` Nebius keeps ${plural(report.cleanup.retained.uploads, "upload")}, ${plural(report.cleanup.retained.images, "image")} and ${plural(report.cleanup.retained.operations, "operation record")} from it. ${report.cleanup.retained.note}`
                : ""}
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}
