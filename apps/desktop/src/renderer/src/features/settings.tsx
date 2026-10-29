import { Alert, Badge, Box, Button, Code, Group, Paper, PasswordInput, Stack, Switch, Table, Text, TextInput, Title } from "@mantine/core";
import type { ProviderCheck } from "@nivra/domain";
import { useEffect, useState, type ReactNode } from "react";
import type { ProjectView, SettingsView } from "../../../shared/ipc";
import { RESEARCH_RETENTION } from "../../../shared/research";
import { useKeySave } from "../shell/drafts";
import { errorMessage } from "../shared/ui";

const KEY_LOOK = {
  none: { label: "No key", color: "gray" },
  encrypted: { label: "Key saved, encrypted", color: "green" },
  unencrypted: { label: "Key saved, unencrypted", color: "yellow" },
  unreadable: { label: "Key can't be read here", color: "red" },
} as const;

/** A card of Settings: a title, what it is for, and its controls. */
export function SettingsCard({ title, description, children, testId }: { title: string; description?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Paper withBorder p="lg" data-testid={testId}>
      <Stack gap="md">
        <Stack gap={2}>
          <Title order={2} fz={15} lh={1.47}>
            {title}
          </Title>
          {description && (
            <Text size="sm" c="var(--nivra-text-2)">
              {description}
            </Text>
          )}
        </Stack>
        {children}
      </Stack>
    </Paper>
  );
}

/**
 * Settings › Connections, Nebius (SE1): the key, and the project ID Nebius Sandboxes needs with it (D36), kept by the app
 * (D8): encrypted by the OS where it can be, and handed to the engines in memory only. No part of a key is ever shown,
 * and a field clears once it is saved. `onCredentialsSaved` follows each save, once the engines have them. While the key
 * is being saved or removed, no draft is shown, and once that settles, succeeded or failed, each is checked against the
 * keys as they are. Check Token Factory runs from the engine of the project in view, and makes paid calls.
 */
export function NebiusConnection({ project, online, onCredentialsSaved, freshness = 0 }: { project: ProjectView | null; online: boolean; onCredentialsSaved(): void; freshness?: number }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [check, setCheck] = useState<ProviderCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [key, setKey] = useState("");
  const [nebiusProject, setNebiusProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keySave = useKeySave();
  const projectId = project?.id ?? null;
  const usableKey = settings !== null && (settings.nebiusKey === "encrypted" || settings.nebiusKey === "unencrypted");

  // Read again each time Settings is opened (`freshness`): another place may have changed them.
  useEffect(() => {
    void window.nivra.getSettings().then(setSettings, (reason: unknown) => setError(errorMessage(reason)));
  }, [freshness]);

  async function runCheck() {
    if (!projectId) return;
    setChecking(true);
    setError(null);
    setCheck(null);
    try {
      setCheck(await window.nivra.checkTokenFactory(projectId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setChecking(false);
    }
  }

  async function save(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await keySave(() => window.nivra.setNebiusKey(value)));
      setKey("");
      onCredentialsSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveProject(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await window.nivra.setNebiusProjectId(value));
      setNebiusProject("");
      onCredentialsSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const checkOff = !project
    ? "Choose a project with the switcher first: the check runs on its engine."
    : !online
      ? `The engine on ${project.targetLabel} isn't online yet.`
      : !usableKey
        ? "Save a key first."
        : null;

  return (
    <SettingsCard title="Nebius" description="One key serves Token Factory, where the models answer, and Nebius Sandboxes, where environments are prepared and tasks run." testId="connection-nebius">
      <Group gap="sm" align="flex-end">
        <PasswordInput
          label="Nebius API key"
          placeholder={settings && settings.nebiusKey !== "none" ? "A key is saved; enter a new one to replace it" : "Paste your Token Factory API key"}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          style={{ flex: "1 1 260px", maxWidth: 380 }}
          data-testid="nebius-key"
        />
        <Button variant="default" onClick={() => void save(key.trim())} loading={busy} disabled={key.trim().length < 8} data-testid="nebius-key-save">
          Save
        </Button>
        {settings && settings.nebiusKey !== "none" && (
          <Button variant="outline" color="red" onClick={() => void save(null)} disabled={busy}>
            Remove
          </Button>
        )}
        {settings && (
          <Badge variant="light" color={KEY_LOOK[settings.nebiusKey].color} mb={8} data-testid="nebius-key-state">
            {KEY_LOOK[settings.nebiusKey].label}
          </Badge>
        )}
      </Group>
      <Group gap="sm" align="flex-end">
        <TextInput
          label="Project ID, for Nebius Sandboxes"
          placeholder={settings?.nebiusProjectId === "set" ? "A project ID is saved; enter a new one to replace it" : "Paste your Nebius project ID"}
          value={nebiusProject}
          onChange={(event) => setNebiusProject(event.currentTarget.value)}
          style={{ flex: "1 1 260px", maxWidth: 380 }}
          data-testid="nebius-project-id"
        />
        <Button variant="default" onClick={() => void saveProject(nebiusProject.trim())} loading={busy} disabled={nebiusProject.trim().length < 8} data-testid="nebius-project-id-save">
          Save
        </Button>
        {settings?.nebiusProjectId === "set" && (
          <Button variant="outline" color="red" onClick={() => void saveProject(null)} disabled={busy}>
            Remove
          </Button>
        )}
        {settings && (
          <Badge variant="light" color={settings.nebiusProjectId === "set" ? "green" : "gray"} mb={8} data-testid="nebius-project-id-state">
            {settings.nebiusProjectId === "set" ? "Project ID saved" : "No project ID"}
          </Badge>
        )}
      </Group>
      <Text size="xs" c="var(--nivra-text-3)">
        The key needs access to this Nebius project: environments are prepared and tasks run there.
      </Text>
      {settings?.note && (
        <Alert color="yellow" variant="light" data-testid="nebius-key-note">
          <Stack gap={0}>
            <Text size="sm">{settings.note}</Text>
          </Stack>
        </Alert>
      )}
      <Box style={{ borderTop: "1px solid var(--nivra-border)", paddingTop: 16 }}>
        <Group gap="md" align="flex-start" wrap="nowrap">
          <Button variant="default" onClick={() => void runCheck()} loading={checking} disabled={checkOff !== null} style={{ flex: "none" }} data-testid="tokenfactory-check">
            Check Token Factory
          </Button>
          <Text size="sm" c="var(--nivra-text-2)">
            Makes paid calls with your key: one listing of models and up to 6 requests. It changes nothing.{" "}
            {checkOff ?? (project ? `It runs on the engine on ${project.targetLabel}, for ${project.label}.` : "")}
          </Text>
        </Group>
      </Box>
      {check && (
        <Stack gap={4} data-testid="tokenfactory-result">
          {check.endpoint === "loopback-test" && (
            <Text size="sm" c="var(--nivra-warning)">
              This engine sends model requests to a test endpoint on this machine, not Token Factory.
            </Text>
          )}
          <Text size="sm">
            {check.models.total} models for this key; NVIDIA: {check.models.nvidia.length ? check.models.nvidia.join(", ") : "none"}.
          </Text>
          {check.call && (
            <Text size="sm">
              <Code fz="xs">{check.call.model}</Code> {check.call.toolCalled ? "called the tool and answered" : "answered without the tool"} in {check.call.elapsedMs} ms: “
              {check.call.answer}”
            </Text>
          )}
          {check.call && (
            <Text size="sm" c="var(--nivra-text-2)" data-testid="tokenfactory-findings">
              {check.call.inputTokens !== null && check.call.outputTokens !== null
                ? `Usage reported: ${check.call.inputTokens} in, ${check.call.outputTokens} out tokens.`
                : "Usage not reported."}{" "}
              Context length: {check.models.contextLength !== null ? `${check.models.contextLength.toLocaleString()} tokens` : "not reported"}.
              {check.probes
                ? ` Required tool choice: ${check.probes.requiredToolChoice}. Forced choice between two tools: ${check.probes.forcedToolChoice}. Answer schema, forced: ${check.probes.answerSchema}.`
                : ""}{" "}
              Rate limit:{" "}
              {check.call.rateLimit.remainingTokens !== null ? `${check.call.rateLimit.remainingTokens.toLocaleString()} tokens left` : "remaining tokens not reported"}
              {check.call.rateLimit.resetTokensSeconds !== null ? `, resets in ${check.call.rateLimit.resetTokensSeconds} s` : ""}
              {check.call.rateLimit.belowPauseThreshold ? " (low enough that each step will pause 10 s)" : ""}.
            </Text>
          )}
          {check.problem && (
            <Text size="sm" c="var(--nivra-warning)">
              {check.problem}
            </Text>
          )}
        </Stack>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="nebius-error">
          {error}
        </Text>
      )}
      <Text size="xs" c="var(--nivra-text-3)">
        It doesn't check Nebius Sandboxes: the sandbox check in Advanced diagnostics does.
      </Text>
    </SettingsCard>
  );
}

/**
 * Settings › Connections, Tavily (D37): the key research needs, kept like the Nebius key and shown only as saved or not;
 * drafts are out of sight while it is saved or removed, and checked against the keys again once that settles.
 */
export function TavilyConnection({ freshness = 0, onSaved }: { freshness?: number; onSaved?(): void }) {
  const keySave = useKeySave();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.nivra.getSettings().then(setSettings, (reason: unknown) => setError(errorMessage(reason)));
  }, [freshness]);

  async function act(change: () => Promise<SettingsView>) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await keySave(change));
      onSaved?.();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title="Tavily" description="For web research, which checks a saved plan's assumptions against public web pages. Research also needs its switch on, in Sharing." testId="connection-tavily">
      <Group gap="sm" align="flex-end">
        <PasswordInput
          label="Tavily API key"
          placeholder={settings?.tavilyKey === "set" ? "A key is saved; enter a new one to replace it" : "Paste your Tavily API key"}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          style={{ flex: "1 1 260px", maxWidth: 380 }}
          data-testid="tavily-key"
        />
        <Button
          variant="default"
          onClick={() =>
            void act(async () => {
              const view = await window.nivra.setTavilyKey(key.trim());
              setKey("");
              return view;
            })
          }
          loading={busy}
          disabled={key.trim().length < 8}
          data-testid="tavily-key-save"
        >
          Save
        </Button>
        {settings?.tavilyKey === "set" && (
          <Button variant="outline" color="red" onClick={() => void act(() => window.nivra.setTavilyKey(null))} disabled={busy} data-testid="tavily-key-remove">
            Remove
          </Button>
        )}
        {settings && (
          <Badge variant="light" color={settings.tavilyKey === "set" ? "green" : "gray"} mb={8} data-testid="tavily-key-state">
            {settings.tavilyKey === "set" ? "Key saved" : "No key"}
          </Badge>
        )}
      </Group>
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="tavily-key-error">
          {error}
        </Text>
      )}
    </SettingsCard>
  );
}

/** Settings › Connections: what each feature needs, so nothing is asked for without saying why (SE1). */
export function FeatureNeeds() {
  const rows: Array<[string, string]> = [
    ["Missions, tasks and briefs you write", "Nothing."],
    ["Explain, conversations, the coach and AI review", "The Nebius key. They make paid calls, and reading a project also needs that project's sharing on."],
    ["Web research", "The Nebius key and the Tavily key, with research on in Sharing. For a project's plan, that project's sharing too."],
    ["Preparing an environment", "The Nebius key and project ID, and the project's uploads on."],
    ["Running a task", "The Nebius key and project ID, and both of the project's switches."],
  ];
  return (
    <SettingsCard title="What each feature needs" description="Each is asked for where it's first needed." testId="connection-needs">
      <Stack gap={0}>
        {rows.map(([feature, needs]) => (
          <Box key={feature} py={10} style={{ borderTop: "1px solid var(--nivra-border)" }}>
            <Text size="sm" fw={600}>
              {feature}
            </Text>
            <Text size="sm" c="var(--nivra-text-2)">
              {needs}
            </Text>
          </Box>
        ))}
      </Stack>
    </SettingsCard>
  );
}

/**
 * Settings › Sharing (SE2): what may leave this computer, for each project, named with its place and folder (two
 * projects can share a name). A switch that's on can be turned off here; turning one off stops the work that relied on
 * it, and says so if something couldn't be stopped. One that's off is turned on only where it's first needed, after
 * Nivra shows what would be sent.
 */
export function SharingTable({ projects, windowsHost, onChanged }: { projects: ProjectView[]; windowsHost: boolean; onChanged(): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function turnOff(project: ProjectView, which: "modelContext" | "cloudExecution") {
    const id = `${project.id}:${which}`;
    setBusy(id);
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      if (which === "modelContext") await window.nivra.setSharing(project.id, false);
      else await window.nivra.setCloudExecution(project.id, false);
    } catch (reason) {
      setErrors((current) => ({ ...current, [id]: errorMessage(reason) }));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  const cell = (project: ProjectView, which: "modelContext" | "cloudExecution", name: string) => {
    const on = project.sharing[which];
    const id = `${project.id}:${which}`;
    return (
      <Stack gap={4}>
        {on ? (
          <Switch
            checked
            onChange={() => void turnOff(project, which)}
            disabled={busy !== null}
            label="On"
            aria-label={`${name} for ${project.label}, ${project.targetLabel}: on. Turn it off`}
            data-testid={which === "modelContext" ? "sharing-model-context" : "sharing-uploads"}
          />
        ) : (
          <>
            <Text size="sm" fw={500} data-testid={which === "modelContext" ? "sharing-model-context-off" : "sharing-uploads-off"}>
              Off
            </Text>
            <Text size="xs" c="var(--nivra-text-3)">
              Turned on where it's first needed, after its preview.
            </Text>
          </>
        )}
        {errors[id] && (
          <Text size="xs" c="var(--nivra-error)" data-testid="sharing-error">
            {errors[id]}
          </Text>
        )}
      </Stack>
    );
  };

  return (
    <SettingsCard title="Each project" testId="sharing-projects">
      {projects.length === 0 ? (
        <Text size="sm" c="var(--nivra-text-2)">
          No projects yet. Each project you add gets its own two switches, both off.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="sm" horizontalSpacing={0}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Project</Table.Th>
                <Table.Th>Sharing with Token Factory</Table.Th>
                <Table.Th>Uploads to Nebius Sandboxes</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {projects.map((project) => (
                <Table.Tr key={project.id} data-testid="sharing-row" data-project-id={project.id}>
                  <Table.Td style={{ verticalAlign: "top", paddingRight: 16 }}>
                    <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
                      {project.label}
                    </Text>
                    <Text size="xs" c="var(--nivra-text-2)" style={{ overflowWrap: "anywhere" }}>
                      {project.targetLabel} · <Code fz="xs">{project.displayPath}</Code>
                    </Text>
                    {windowsHost && project.targetId === "local" && (
                      <Text size="xs" c="var(--nivra-text-3)">
                        Tasks and environments can't run on Windows itself.
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ verticalAlign: "top", paddingRight: 16 }}>{cell(project, "modelContext", "Sharing with Token Factory")}</Table.Td>
                  <Table.Td style={{ verticalAlign: "top" }}>{cell(project, "cloudExecution", "Uploads to Nebius Sandboxes")}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </SettingsCard>
  );
}

/**
 * Settings › Sharing, Everywhere (D37): the app-wide permission to send research queries to Tavily, with what Tavily and
 * Nivra keep. Each run still waits for its own "Start research".
 */
export function ResearchSwitch({ freshness = 0 }: { freshness?: number }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.nivra.getSettings().then(setSettings, (reason: unknown) => setError(errorMessage(reason)));
  }, [freshness]);

  async function act(change: () => Promise<SettingsView>) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await change());
    } catch (reason) {
      setError(errorMessage(reason));
      // Research turned off stays off even when a run couldn't be stopped: show the settings as they are now.
      void window.nivra.getSettings().then(setSettings, () => undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title="Everywhere" testId="sharing-research">
      <Switch
        label="Research queries to Tavily"
        description="For every project and general plans"
        checked={settings?.webResearch === true}
        onChange={(event) => {
          const on = event.currentTarget.checked;
          void act(() => window.nivra.setWebResearch(on));
        }}
        disabled={!settings || busy}
        data-testid="web-research-switch"
      />
      {/* Two paragraphs, as drawn; the words are the same as before, read as one text. */}
      <Stack gap={8} data-testid="web-research-words">
        <Text size="sm">
          When it is on, each run still waits for you to start it. Tavily gets your Tavily key, the queries you approve, the sites you list, if any, and the addresses of pages its
          own search returned: no other words from the plan, and none of your repositories or conversations. Turning it off stops research under way where it can.
        </Text>{" "}
        <Text size="sm" c="var(--nivra-text-2)">
          {RESEARCH_RETENTION}
        </Text>
      </Stack>
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="research-settings-error">
          {error}
        </Text>
      )}
    </SettingsCard>
  );
}
