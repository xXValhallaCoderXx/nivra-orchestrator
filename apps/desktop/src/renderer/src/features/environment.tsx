import { Alert, Badge, Button, Checkbox, Code, Group, List, Modal, Radio, Stack, Text } from "@mantine/core";
import type { ChoiceNeeded, EnvironmentChoices, EnvironmentPreviewV2, EnvironmentReport, PreparedEnvironmentV2, ResolutionRow } from "@nivra/domain";
import { useRef, useState } from "react";
import type { EnvironmentView, PreparationView, ProjectView, TurnStatus } from "../../../shared/ipc";
import { errorMessage, Section, usePoll } from "../shared/ui";

/**
 * A project's environment (D41, NIV-55): its dependencies, installed once in a Nebius sandbox as its own setup files say
 * (its Node version, its package manager and its lockfile), kept as an image its task runs start from with networking
 * off. The person sees the setup Nivra found, each value with where it came from, makes the choices the project leaves
 * open, sees what preparing sends and runs, worked out on the project's own engine, and prepares it; uploads are asked
 * for, as the sandbox check asks, when they aren't allowed. Builds the preparation didn't run are shown, and the person
 * either changes the project's policy or accepts the environment without them. The install's log is shown as text, never
 * as markup. `credentialsSaved` changes each time the key or project id is saved: what keeps Prepare from being pressed
 * is read again.
 */

type Ready = Extract<EnvironmentPreviewV2, { status: "ready" }>;

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const sizeText = (bytes: number) => (bytes < 1024 ? plural(bytes, "byte") : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const minutes = (seconds: number) => plural(Math.round(seconds / 60), "minute");
const going = (status: TurnStatus) => status === "submitting" || status === "running";

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

/** Where a resolved value came from, as a row says it. */
const SOURCE: Record<ResolutionRow["source"], string> = {
  declared: "from the project",
  resolved: "resolved from its range",
  default: "Nivra's default",
  choice: "your choice",
  "checked-when-preparing": "checked when preparing",
};

/** npm's install options the window offers (NIV-55): the ones a lockfile may need, since .npmrc is never read. */
const NPM_OPTIONS: ReadonlyArray<{ name: string; label: string }> = [
  { name: "legacy-peer-deps", label: "legacy-peer-deps: install as npm does with that setting on, for a lockfile made with it" },
  { name: "ignore-scripts", label: "ignore-scripts: run no dependency's install scripts; the builds they would make are listed after" },
];

/** The choices, in words. */
const choicesText = (choices: EnvironmentChoices | null) => {
  const said = [choices?.runtime ? `Node ${choices.runtime}` : null, choices?.manager ? choices.manager : null, choices?.managerVersion ? `version ${choices.managerVersion}` : null, ...Object.entries(choices?.options ?? {}).filter(([, value]) => value !== false).map(([name]) => name)].filter((item): item is string => item !== null);
  return said.length ? `with your choices: ${said.join(", ")}` : "as the project declares";
};

/** A choice's answer, where the choices keep it. */
const answerOf = (choices: EnvironmentChoices, id: ChoiceNeeded["id"]) => (id === "runtime" ? choices.runtime : id === "manager" ? choices.manager : choices.managerVersion);
const answered = (choices: EnvironmentChoices, id: ChoiceNeeded["id"], value: string): EnvironmentChoices =>
  id === "runtime" ? { ...choices, runtime: value } : id === "manager" ? { ...choices, manager: value } : { ...choices, managerVersion: value };

export function Environment({ project, online, credentialsSaved, onProjectChanged }: { project: ProjectView | null; online: boolean; credentialsSaved: number; onProjectChanged(): void }) {
  const projectId = project?.id ?? null;
  const state = usePoll<EnvironmentView>(
    () => window.nivra.getEnvironment(projectId!),
    (value) => (value?.preparation && going(value.preparation.status) ? 1_500 : null),
    [projectId, credentialsSaved],
    projectId !== null && online,
  );
  const view = state.value;
  // The choices made here, until the person changes them: the ones made with the last preparation.
  const [edited, setEdited] = useState<EnvironmentChoices | null>(null);
  const [preview, setPreview] = useState<EnvironmentPreviewV2 | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The consent dialog stays on screen while it fades out, so a second press must not start a second preparation.
  const allowing = useRef(false);

  const choices = edited ?? view?.choices ?? {};
  const key = JSON.stringify(choices);
  const ready = preview?.status === "ready" ? preview : null;
  const preparation = view?.preparation ?? null;
  const underway = preparation !== null && going(preparation.status);
  const stale = preview !== null && previewed !== key;

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
      setPreview(await window.nivra.resolveEnvironment(projectId, choices));
      setPreviewed(key);
      state.refresh();
    });

  const start = async () => {
    if (!projectId || !ready) return;
    await window.nivra.prepareEnvironment(projectId, choices, ready.fingerprint);
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

  const accept = () =>
    act(async () => {
      if (!projectId || !view?.prepared) return;
      await window.nivra.acceptMissingBuilds(projectId, view.prepared.verifiedDigest);
      state.refresh();
    });

  const prepareBlocked = !ready || stale || underway || busy || !online || view?.blocked !== null;
  return (
    <Section
      title="Environment"
      description="Install this project's dependencies once, in a Nebius sandbox, as its own setup files say: its Node version, its package manager and its lockfile. Its task runs then start from the result, with networking off."
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
        {view?.prepared && <Prepared prepared={view.prepared} accepted={view.builds !== null} ready={view.ready} busy={busy} online={online} onAccept={() => void accept()} />}
        {view && !view.prepared && !view.legacy && !underway && (
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
          <Button variant="default" onClick={() => void previewIt()} loading={busy && !consent && !underway} disabled={!projectId || !online || underway} data-testid="environment-preview">
            {preview && stale ? "Preview this choice" : view?.prepared || view?.legacy || preparation ? "Preview preparing again" : "Preview the preparation"}
          </Button>
          <Button onClick={() => (project?.sharing.cloudExecution ? void act(start) : setConsent(true))} disabled={prepareBlocked} data-testid="environment-prepare">
            {view?.prepared || view?.legacy || preparation ? "Prepare again" : "Prepare"}
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
            <Stack gap={4}>
              <Text size="sm">{preview.message}</Text>
              <Rows rows={preview.rows} />
            </Stack>
          </Alert>
        )}
        {preview?.status === "needs-choice" && (
          <Stack gap="xs" data-testid="environment-needs-choice">
            <Rows rows={preview.rows} />
            {preview.choices.map((choice) => (
              <Radio.Group
                key={choice.id}
                label={choice.message}
                value={answerOf(choices, choice.id) ?? null}
                onChange={(value) => setEdited(answered(choices, choice.id, value))}
                data-testid={`environment-choice-${choice.id}`}
              >
                <Stack gap={4} mt={4}>
                  {choice.options.map((option) => (
                    <Radio key={option.value} value={option.value} label={option.note ? `${option.label} (${option.note})` : option.label} data-testid="environment-option" />
                  ))}
                </Stack>
              </Radio.Group>
            ))}
            {!stale && (
              <Text size="xs" c="var(--nivra-text-3)">
                Choose, then preview the choice to see what preparing it sends.
              </Text>
            )}
          </Stack>
        )}
        {ready && <PreviewPanel ready={ready} choices={choices} stale={stale} prepared={view?.prepared ?? null} onChoose={(next) => setEdited(next)} />}
      </Stack>
      <Modal opened={consent} onClose={() => setConsent(false)} title="Upload this project's setup files to Nebius Sandboxes?" data-testid="environment-consent">
        {ready && (
          <Stack gap="sm">
            <Text size="sm">
              To prepare {project?.label ?? "this repository"}'s environment, Nivra uploads these files from commit {ready.baseline.slice(0, 12)} to your Nebius project, and runs one
              install there with networking on:
            </Text>
            <List size="sm">
              <List.Item>
                {plural(ready.recipe.configuration.files.length, "file")}, {sizeText(ready.sentBytes)} compressed: the package manifests, the lockfile, the workspace file and the version
                files;
              </List.Item>
              {ready.leftOut.length > 0 && <List.Item>never sent: {ready.leftOut.join(", ")};</List.Item>}
              <List.Item>none of the commit's sources, and none of your uncommitted or untracked work.</List.Item>
            </List>
            <Text size="sm">{networkText(ready)}</Text>
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

/** What networking reaches during the preparation, and that nothing after it has any. */
const networkText = (ready: Ready) =>
  `Networking is on for the preparation only, to reach ${ready.recipe.network.hosts.join(", ") || "the package registry"} and to bring the base image from ${ready.recipe.network.imageRegistry}. Every check and task run is offline.`;

/** The setup Nivra found: each value, where it came from, and the declarations behind it. */
function Rows({ rows }: { rows: ResolutionRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Stack gap={2} data-testid="environment-rows">
      {rows.map((row) => (
        <Stack key={row.fact} gap={0} data-testid="environment-row" data-fact={row.fact} data-source={row.source}>
          <Text size="sm">
            {row.label}: {row.value === null ? "not decided" : <Code>{row.value}</Code>} <Text span size="xs" c="var(--nivra-text-3)">({SOURCE[row.source]})</Text>
          </Text>
          {row.declarations.length > 0 && (
            <Text size="xs" c="var(--nivra-text-3)">
              {row.declarations.map((declaration) => `${declaration.file}${declaration.field ? ` (${declaration.field})` : ""}: ${declaration.value}`).join("; ")}
            </Text>
          )}
          {row.note && (
            <Text size="xs" c="var(--nivra-text-3)">
              {row.note}
            </Text>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * What preparing would send and run, as the project's engine worked it out: the setup it found, each value with where it
 * came from, the image, the install and its options, the files sent and those never sent, what networking reaches, how
 * dependency builds run, what Nebius keeps, and the bounds.
 */
function PreviewPanel({ ready, choices, stale, prepared, onChoose }: { ready: Ready; choices: EnvironmentChoices; stale: boolean; prepared: PreparedEnvironmentV2 | null; onChoose(next: EnvironmentChoices): void }) {
  const { recipe } = ready;
  const options = choices.options ?? {};
  const toggle = (name: string, on: boolean) => {
    const next = { ...options };
    if (on) next[name] = true;
    else delete next[name];
    onChoose({ ...choices, options: next });
  };
  const bootstrap = recipe.bootstrap.map((step) => `${step.tool} ${step.version}${step.via === "npm-global" ? ", installed with npm" : step.via === "corepack" ? ", through corepack" : ", through corepack where the image has it, else with npm"}`);
  const set = Object.entries(recipe.install.options).filter(([, value]) => value !== false);
  const differs = prepared !== null && prepared.recipeDigest !== ready.recipeDigest;
  return (
    <Stack gap="xs" data-testid="environment-preview-panel">
      <Rows rows={ready.rows} />
      {differs && (
        <Text size="sm" c="var(--nivra-warning)" data-testid="environment-differs">
          {prepared.recipe.configuration.digest !== recipe.configuration.digest
            ? "This commit's setup files aren't the ones the environment was prepared from, so its task runs won't start from it. Prepare it again."
            : "Preparing now would make a different environment from the one prepared, with the choices or the Nivra shown here. Prepare it again to use it."}
        </Text>
      )}
      {recipe.install.tool === "npm" && (
        <Stack gap={4} data-testid="environment-options">
          <Text size="sm">Install options:</Text>
          {NPM_OPTIONS.map((option) => (
            <Checkbox key={option.name} label={option.label} checked={options[option.name] === true} onChange={(event) => toggle(option.name, event.currentTarget.checked)} data-testid="environment-option-toggle" />
          ))}
        </Stack>
      )}
      {stale ? (
        <Text size="sm" c="var(--nivra-warning)" data-testid="environment-stale">
          This choice isn't the one previewed. Preview it to see what it sends, then prepare.
        </Text>
      ) : (
        <Stack gap={2} data-testid="environment-sends">
          <Text size="sm">
            Starts from <Code>{recipe.image.tag}</Code> ({recipe.platform.arch}, {recipe.platform.libc}), from commit <Code>{ready.baseline.slice(0, 12)}</Code>.
            {bootstrap.length ? ` First, ${bootstrap.join("; ")}.` : ""}
          </Text>
          <Text size="sm">
            Sent: {plural(recipe.configuration.files.length, "file")}, {sizeText(ready.sentBytes)} compressed ({recipe.configuration.files.map((file) => file.path).join(", ")}).
          </Text>
          {ready.leftOut.length > 0 && (
            <Text size="sm" data-testid="environment-left-out">
              {ready.leftOut.join(", ")} {ready.leftOut.length === 1 ? "is" : "are"} never read or sent. If its settings shape the lockfile, such as legacy-peer-deps, set the same install
              option here.
            </Text>
          )}
          <Text size="sm" data-testid="environment-install">
            Then, in the sandbox: <Code>{[recipe.install.tool, ...recipe.install.args].join(" ")}</Code>
            {set.length ? `, with ${set.map(([name, value]) => (value === true ? name : `${name}=${String(value)}`)).join(", ")}` : ""}
          </Text>
          <Text size="sm" data-testid="environment-builds-policy">
            {recipe.builds.runs === "all"
              ? "Dependency builds: every one runs."
              : recipe.builds.runs === "allowed"
                ? `Dependency builds: only those the project allows${recipe.builds.allowed.length ? ` (${recipe.builds.allowed.join(", ")})` : ""}.`
                : recipe.builds.runs === "none"
                  ? "Dependency builds: none run."
                  : "Dependency builds: Nivra can't tell beforehand which ones run, so it lists them after the install."}{" "}
            Any that don't run are listed before task runs may start from the environment.
          </Text>
          <Text size="sm" data-testid="environment-network">
            {networkText(ready)}
          </Text>
          {ready.warnings.map((warning) => (
            <Text key={warning.code} size="sm" c="var(--nivra-warning)" data-testid="environment-warning">
              {warning.message}
            </Text>
          ))}
          {ready.limitations.map((limitation, index) => (
            <Text key={index} size="xs" c="var(--nivra-text-3)" data-testid="environment-limitation">
              {limitation}
            </Text>
          ))}
          <Text size="xs" c="var(--nivra-text-3)" data-testid="environment-retention">
            What Nebius keeps: {ready.retention}
          </Text>
          <Text size="xs" c="var(--nivra-text-3)" data-testid="environment-limits">
            Bounds: up to {minutes(recipe.limits.importSeconds)} to import the image when your Nebius project doesn't have it yet, up to {minutes(recipe.limits.prepareSeconds)} for the
            install, and up to {minutes(recipe.limits.probeSeconds)} for each check before and after it, with networking off.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

/** The prepared environment: what its task runs start from, as its preparation verified it, and the builds it didn't run. */
function Prepared({ prepared, accepted, ready, busy, online, onAccept }: { prepared: PreparedEnvironmentV2; accepted: boolean; ready: boolean; busy: boolean; online: boolean; onAccept(): void }) {
  const { verified } = prepared;
  const tools = verified.tools.map((tool) => `${tool.name} ${tool.version}`).join(", ");
  const builds = verified.builds;
  return (
    <Alert color={ready ? "green" : "yellow"} variant="light" data-testid="environment-prepared" data-ready={ready}>
      <Stack gap={4}>
        <Text size="sm">
          Prepared {new Date(prepared.preparedAt).toLocaleString()}: {tools}, on {verified.platform.release} ({verified.platform.arch}, {verified.platform.libc}). Image{" "}
          <Code>{verified.images.prepared.slice(0, 12)}</Code>, from commit <Code>{prepared.baseline.slice(0, 12)}</Code>.
        </Text>
        <Text size="xs" c="var(--nivra-text-3)">
          Its task runs start from it, with networking off, while the commit's setup files stay as they were. It was prepared from {prepared.recipe.image.tag}
          {verified.images.imported ? ", imported into your Nebius project" : ""}.
        </Text>
        {builds.state === "complete" ? (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="environment-builds">
            Every dependency build ran.
          </Text>
        ) : (
          <Stack gap={4} data-testid="environment-builds" data-state={builds.state}>
            <Text size="sm">
              {builds.state === "missing" ? `These dependency builds didn't run: ${builds.missing.join(", ")}.` : "Nivra couldn't tell which dependency builds ran."}{" "}
              {accepted ? "You accepted the environment without them." : "Change the project's build policy and prepare again, or accept the environment without them."}
            </Text>
            {!accepted && (
              <Group>
                <Button size="xs" variant="default" onClick={onAccept} disabled={busy || !online} data-testid="environment-accept-builds">
                  Accept without them
                </Button>
              </Group>
            )}
          </Stack>
        )}
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
          {new Date(preparation.createdAt).toLocaleString()}, {preparation.choices ? choicesText(preparation.choices) : "by an earlier version of Nivra"}
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
          {report.stopped && report.stopped.code !== "cancelled" && (
            <Text size="sm" data-testid="environment-stopped">
              {report.stopped.message}
            </Text>
          )}
          {report.stopped?.detail && (
            <Text size="sm" data-testid="environment-stopped-detail">
              {report.stopped.detail}
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
