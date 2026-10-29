import { Anchor, Badge, Box, Button, Code, Group, Paper, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState, type ReactNode } from "react";
import type { EngineView, EnvironmentView, ProjectView, SettingsView, TaskState, TasksView, WslView } from "../../../shared/ipc";
import { EngineBadge, EngineNotices } from "../features/engine";
import { ProjectNotice, RemoveProject } from "../features/projects";
import { errorMessage, usePoll } from "../shared/ui";
import { DraftNotice, useDraft } from "../shell/drafts";
import { composerDraftKey } from "../shell/places";
import type { Navigate } from "./routes";

/** A task's state in words, as the Tasks page shows it. */
const STATE_LOOK: Record<TaskState, { label: string; color: string }> = {
  draft: { label: "Draft", color: "gray" },
  ready: { label: "Ready", color: "blue" },
  active: { label: "Active", color: "yellow" },
  review: { label: "In review", color: "yellow" },
  completed: { label: "Completed", color: "green" },
};

function Card({ title, description, children, testId }: { title: ReactNode; description?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <Paper withBorder p="lg" data-testid={testId}>
      <Stack gap="sm">
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

/** A row's state mark: done, needs you, or off until asked; the row's words say the same. */
function Mark({ state }: { state: "ok" | "attention" | "off" }) {
  const common = { flex: "0 0 22px", width: 22, height: 22, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, boxSizing: "border-box" } as const;
  if (state === "ok") return <span aria-hidden="true" style={{ ...common, background: "var(--nivra-badge-green-bg)", color: "var(--nivra-badge-green-fg)" }}>✓</span>;
  if (state === "attention") return <span aria-hidden="true" style={{ ...common, background: "var(--nivra-badge-yellow-bg)", color: "var(--nivra-badge-yellow-fg)", border: "1px solid var(--nivra-warning)" }}>!</span>;
  return <span aria-hidden="true" style={{ ...common, border: "1px dashed var(--nivra-control-border)" }} />;
}

function SetupRow({ state, title, children, action, testId }: { state: "ok" | "attention" | "off"; title: string; children: ReactNode; action?: ReactNode; testId: string }) {
  return (
    <Box style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr) auto", gap: 12, alignItems: "start", padding: "12px 0", borderTop: "1px solid var(--nivra-border)" }} data-testid={testId} data-state={state}>
      <Mark state={state} />
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        <Text size="sm" c="var(--nivra-text-2)">
          {children}
        </Text>
      </Stack>
      {action ?? <span />}
    </Box>
  );
}

const keyWords = (settings: SettingsView | null, error: string | null) => {
  if (!settings) return error ? { state: "attention" as const, title: "Nebius key and project ID: couldn't be read" } : { state: "off" as const, title: "Nebius key and project ID: checking…" };
  const key = settings.nebiusKey === "encrypted" || settings.nebiusKey === "unencrypted";
  const id = settings.nebiusProjectId === "set";
  if (settings.nebiusKey === "unreadable") return { state: "attention" as const, title: "Nebius key: can't be read here" };
  if (key && id) return { state: "ok" as const, title: "Nebius key and project ID: saved" };
  if (key) return { state: "attention" as const, title: "Nebius key saved; project ID: not added" };
  if (id) return { state: "attention" as const, title: "Nebius project ID saved; key: not added" };
  return { state: "attention" as const, title: "Nebius key and project ID: not added" };
};

/**
 * A project's Home (P1a): its name, place and folder with its engine's state, the New task composer, its tasks, what its
 * work needs from the person, and optional help. Opening it sends nothing.
 */
export function ProjectHome({
  project,
  engine,
  enginesError,
  settings,
  settingsError,
  tasks,
  tasksError,
  running,
  onNavigate,
  onGuide,
  onCreateTask,
  onStartConversation,
  onRemoved,
}: {
  project: ProjectView;
  engine: EngineView | null;
  /** A failed read of the engines, of the settings and of the tasks: each shows where its figures would. */
  enginesError: string | null;
  settings: SettingsView | null;
  settingsError: string | null;
  tasks: TasksView | null;
  tasksError: string | null;
  /** A hello or explain run of this window is going for this project. */
  running: boolean;
  onNavigate: Navigate;
  onGuide(): void;
  onCreateTask(title: string): void;
  /** Starts a conversation about the project and opens it; a failure is shown under its button. */
  onStartConversation(): Promise<void>;
  onRemoved(label: string, preferencesRemoved: number): void;
}) {
  // The title typed here is a draft (R30): kept on this computer across navigation and restarts until a task is
  // created from it, never one that looks like it holds a credential, and never sent anywhere.
  const draft = useDraft<{ title: string }>(composerDraftKey({ kind: "project", projectId: project.id }));
  const [title, setTitle] = useState("");
  // The kept copy, once it is checked against the saved keys; never over what was typed meanwhile.
  useEffect(() => {
    if (draft.restore) setTitle(draft.restore.title);
  }, [draft.restore]);
  const [starting, setStarting] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const online = engine?.state.status === "online";
  const environment = usePoll<EnvironmentView>(() => window.nivra.getEnvironment(project.id), () => null, [project.id], online);
  const own = (tasks?.tasks ?? []).filter((task) => task.projectId === project.id);
  const open = own.filter((task) => task.state !== "completed");
  const workspaceReady = tasks?.workspace.state === "ready";
  const key = keyWords(settings, settingsError);
  const env = environment.value;

  return (
    <Stack gap="lg">
      <Stack gap={6}>
        <Title order={1} style={{ overflowWrap: "anywhere" }} data-testid="home-title">
          {project.label}
        </Title>
        <EngineBadge project={project} engine={engine} unknown={enginesError} />
        <Button variant="default" size="xs" style={{ alignSelf: "flex-start" }} onClick={onGuide} data-testid="home-guided-setup">Help set up this project</Button>
      </Stack>
      <EngineNotices engine={engine} onRestart={() => window.nivra.restartEngine(project.id)} testId="home-engine" />
      <ProjectNotice project={project} />

      <Paper
        withBorder
        p="lg"
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!workspaceReady) return;
          // The draft stays until the task is created from it, so leaving the new task's page loses nothing.
          onCreateTask(title.trim());
        }}
      >
        <Stack gap={8}>
          <Group gap="sm" align="flex-end" wrap="nowrap">
            <TextInput
              label={`New task in ${project.label}`}
              placeholder="What should change?"
              value={title}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setTitle(next);
                if (next.trim()) draft.change({ title: next }, next.trim());
                else draft.discard();
              }}
              style={{ flex: "1 1 auto", minWidth: 0 }}
              data-testid="home-composer"
            />
            <Button type="submit" disabled={!workspaceReady} data-testid="home-create-task">
              Create task
            </Button>
          </Group>
          <Button variant="subtle" size="xs" style={{ alignSelf: "flex-start" }} onClick={() => onNavigate({ kind: "planning", id: null })} data-testid="home-break-into-tasks">Break into tasks</Button>
          <DraftNotice result={draft.result} />
          <Text size="xs" c="var(--nivra-text-3)">
            {tasks?.workspace.state === "unavailable"
              ? `Tasks can't be written now: ${tasks.workspace.reason}`
              : !tasks && tasksError
                ? "Tasks can't be written until Nivra can read them again: it tries by itself."
                : "Next you write its brief: the goal, how you'll know it worked, and a check that must pass. Nothing is sent."}
          </Text>
        </Stack>
      </Paper>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" style={{ alignItems: "start" }}>
        <Card
          title={
            <Group justify="space-between" wrap="nowrap">
              <span>Tasks</span>
              {own.length > 0 && (
                <Anchor component="button" type="button" size="sm" onClick={() => onNavigate({ kind: "tasks" })} data-testid="home-all-tasks">
                  All {own.length}
                </Anchor>
              )}
            </Group>
          }
          testId="home-tasks"
        >
          {!tasks ? (
            <Text size="sm" c={tasksError ? "var(--nivra-error)" : "var(--nivra-text-3)"} role={tasksError ? undefined : "status"} data-testid="home-tasks-state">
              {tasksError ? `Nivra couldn't read the tasks: ${tasksError}` : "Reading the tasks…"}
            </Text>
          ) : own.length === 0 ? (
            <Text size="sm" c="var(--nivra-text-2)">
              No tasks in {project.label} yet. Name one above to start its brief, or talk it through first in a conversation.
            </Text>
          ) : (
            <Table verticalSpacing={8} horizontalSpacing={0}>
              <Table.Tbody>
                {(open.length ? open : own).slice(0, 6).map((task) => (
                  <Table.Tr key={task.id} data-testid="home-task" data-task-id={task.id}>
                    <Table.Td>
                      <Anchor component="button" type="button" size="sm" fw={500} c="var(--mantine-color-text)" onClick={() => onNavigate({ kind: "task", id: task.id, tab: "brief" })} style={{ textAlign: "left" }}>
                        {task.title}
                      </Anchor>
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right", width: 1, whiteSpace: "nowrap" }}>
                      <Badge color={STATE_LOOK[task.state].color} variant="light">
                        {STATE_LOOK[task.state].label}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>

        <Card title={`Setup for ${project.label}`} description="Each is asked for where it's first needed. Writing tasks and briefs needs none of them." testId="home-setup">
          <Box>
            <SetupRow
              state={key.state}
              title={key.title}
              testId="home-setup-key"
              action={
                key.state !== "ok" && (
                  <Button size="xs" variant="default" onClick={() => onNavigate({ kind: "settings", section: "connections" })} data-testid="home-setup-key-open">
                    Add in Settings
                  </Button>
                )
              }
            >
              Explaining, conversations, the coach, AI reviews, preparing the environment and runs need the key. Preparing and runs also need the project ID.
            </SetupRow>
            <SetupRow state={project.sharing.modelContext ? "ok" : "off"} title={`Sharing with Token Factory: ${project.sharing.modelContext ? "on" : "off"}`} testId="home-setup-sharing">
              {project.sharing.modelContext ? "This project's content may be sent to Token Factory. You can turn it off in Settings, Sharing." : "Asked the first time this project's content would be sent, after showing what."}
            </SetupRow>
            <SetupRow state={project.sharing.cloudExecution ? "ok" : "off"} title={`Uploads to Nebius Sandboxes: ${project.sharing.cloudExecution ? "on" : "off"}`} testId="home-setup-uploads">
              {project.sharing.cloudExecution ? "This project's commit may be uploaded to your Nebius project. You can turn it off in Settings, Sharing." : "Asked when you prepare the environment or preview a run."}
            </SetupRow>
            <SetupRow
              state={!env ? "off" : env.prepared && env.ready ? "ok" : "attention"}
              title={
                !online
                  ? "Environment"
                  : !env
                    ? environment.error
                      ? "Environment: couldn't be read"
                      : "Environment: checking…"
                    : env.legacy
                      ? "Environment: prepared by an earlier version of Nivra"
                      : env.prepared
                        ? env.ready
                          ? "Environment: prepared"
                          : "Environment: prepared, not ready yet"
                        : "Environment: not prepared"
              }
              testId="home-setup-environment"
              action={
                <Button size="xs" variant="default" onClick={() => onNavigate({ kind: "environment" })} data-testid="home-setup-environment-open">
                  Open
                </Button>
              }
            >
              {!online
                ? "Its state shows once the project's engine is online."
                : "Needed before tasks whose checks use programs Nivra's own base image lacks, such as Node or pnpm. Writing tasks doesn't need it."}
            </SetupRow>
          </Box>
        </Card>
      </SimpleGrid>

      <Card title="Optional help" description="Neither is needed before a task." testId="home-help">
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Stack gap={8} align="flex-start">
            <Button variant="default" onClick={() => onNavigate({ kind: "explain" })} data-testid="home-explain">
              Explain this project
            </Button>
            <Text size="sm" c="var(--nivra-text-2)">
              Answers with evidence from the tracked files that you can open. It shows what it would send before anything is sent.
            </Text>
          </Stack>
          <Stack gap={8} align="flex-start">
            <Button
              variant="default"
              loading={starting}
              onClick={() => {
                setStarting(true);
                setConversationError(null);
                void onStartConversation()
                  .catch((reason: unknown) => setConversationError(errorMessage(reason)))
                  .finally(() => setStarting(false));
              }}
              data-testid="home-conversation"
            >
              Start a conversation
            </Button>
            {conversationError && (
              <Text size="sm" c="var(--nivra-error)" role="alert" data-testid="home-conversation-error">
                Nivra couldn't start the conversation: {conversationError}
              </Text>
            )}
            <Text size="sm" c="var(--nivra-text-2)">
              Talk a change through, then save it as a plan or turn it into a task.
            </Text>
          </Stack>
        </SimpleGrid>
      </Card>

      <RemoveProject project={project} running={running} onRemoved={onRemoved} />
    </Stack>
  );
}

const keyBadge = (saved: boolean, yes: string, no: string) => (
  <Badge variant="light" color={saved ? "green" : "gray"} style={{ overflow: "visible" }} styles={{ label: { overflow: "visible" } }}>
    {saved ? yes : no}
  </Badge>
);

/** The needs table's last column: as wide as what it says, never cut off. */
const STATE_CELL = { textAlign: "right", whiteSpace: "nowrap", width: 1 } as const;

/**
 * General's Home: first use when there is no project yet (P2a), and work with no repository after that. Planning by
 * hand needs no key and sends nothing; adding a project sends nothing either.
 */
export function GeneralHome({
  projects,
  settings,
  settingsError,
  wsl,
  adding,
  onAdd,
  onOpenProject,
  onNavigate,
  onNewTask,
  onStartIdea,
}: {
  projects: ProjectView[];
  settings: SettingsView | null;
  /** A failed read of the settings: the needs table says so instead of showing what is saved. */
  settingsError: string | null;
  wsl: WslView | null;
  adding: boolean;
  onAdd(): void;
  onOpenProject(projectId: string): void;
  onNavigate: Navigate;
  onNewTask(): void;
  onStartIdea(): void;
}) {
  const first = projects.length === 0;
  const key = settings?.nebiusKey === "encrypted" || settings?.nebiusKey === "unencrypted";
  return (
    <Stack gap="lg">
      <Stack gap={6}>
        <Title order={1} data-testid="home-title">
          {first ? "Welcome to Nivra" : "General"}
        </Title>
        {first && (
          <Text size="lg" c="var(--nivra-text-2)" maw={760}>
            Plan work, then let a coding worker make the change in a sandbox. Nothing reaches your files until you approve the exact change.
          </Text>
        )}
        <Group gap="sm">
          <Text size="sm" c="var(--nivra-text-3)">
            {first ? "You're in General: work with no repository. Once you add a project, the switcher above takes you to it." : "Work with no repository: missions, and tasks and conversations that reach no project."}
          </Text>
          <EngineBadge project={null} engine={null} />
        </Group>
      </Stack>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Card title="Plan without a repository" description="Write a mission and its tasks before any repository exists. Planning by hand sends nothing and needs no key." testId="home-plan">
          <Group gap="sm">
            <Button variant="default" onClick={onStartIdea} data-testid="home-start-idea">Start an idea</Button>
            <Button onClick={() => onNavigate({ kind: "missions", startNew: true })} data-testid="home-new-mission">
              New mission
            </Button>
            <Button variant="default" onClick={onNewTask} data-testid="home-new-task">
              New task
            </Button>
            <Button variant="default" onClick={() => onNavigate({ kind: "planning", id: null })} data-testid="home-break-into-tasks">Break into tasks</Button>
          </Group>
          <Text size="xs" c="var(--nivra-text-3)">
            A mission is optional. It says who the work is for and what is true once it's done; a task can stand on its own.
          </Text>
        </Card>
        <Card
          title="Add a project"
          description="Choose a repository folder. Its work runs where the folder is kept: a folder inside a WSL distribution runs there. Tasks can't run on Windows itself yet."
          testId="home-add"
        >
          <Group gap="sm">
            <Button variant="default" onClick={onAdd} loading={adding} data-testid="home-add-project">
              Add a project…
            </Button>
          </Group>
          <Text size="xs" c="var(--nivra-text-3)">
            Nothing is copied, and adding a project sends nothing.
            {wsl && wsl.status !== "ready" ? " WSL isn't ready on this computer: Advanced diagnostics, in Settings, says what to do." : ""}
          </Text>
        </Card>
      </SimpleGrid>

      {!first && (
        <Card title="Your projects" description="Each runs where its folder is kept. Opening one shows its Home; nothing is sent." testId="home-projects">
          <Table verticalSpacing={8} horizontalSpacing={0}>
            <Table.Tbody>
              {projects.map((project) => (
                <Table.Tr key={project.id} data-testid="home-project" data-project-id={project.id}>
                  <Table.Td>
                    <Text size="sm" fw={500} style={{ overflowWrap: "anywhere" }}>
                      {project.label}
                    </Text>
                    <Text size="xs" c="var(--nivra-text-2)">
                      {project.targetLabel} · <Code fz="xs">{project.displayPath}</Code>
                    </Text>
                  </Table.Td>
                  <Table.Td style={{ textAlign: "right", width: 1 }}>
                    <Button size="xs" variant="default" onClick={() => onOpenProject(project.id)} aria-label={`Open ${project.label}, ${project.targetLabel}`}>
                      Open
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <Stack gap={6}>
        <Title order={2} fz={15} lh={1.47}>
          What you'll need, and when
        </Title>
        <Text size="sm" c="var(--nivra-text-2)">
          Nivra asks for each one where a feature first needs it, after saying what it's for.
        </Text>
        <Paper withBorder>
          <Table verticalSpacing={10} horizontalSpacing="md" data-testid="home-needs">
            <Table.Tbody>
              <Table.Tr>
                <Table.Td fw={600} w="28%">
                  Nothing
                </Table.Td>
                <Table.Td>To plan by hand: missions, tasks and their briefs.</Table.Td>
                <Table.Td style={STATE_CELL}>
                  <Text size="xs" c="var(--nivra-text-2)">
                    Ready now
                  </Text>
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={600}>Your Nebius key</Table.Td>
                <Table.Td>For conversations, Explain, the coach, AI reviews, research, preparing environments and runs.</Table.Td>
                <Table.Td style={STATE_CELL}>{settings && keyBadge(key, "Key saved", "No key")}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={600}>Your Nebius project ID</Table.Td>
                <Table.Td>For preparing environments and runs, in Nebius Sandboxes. The same key needs access to that project.</Table.Td>
                <Table.Td style={STATE_CELL}>{settings && keyBadge(settings.nebiusProjectId === "set", "Project ID saved", "No project ID")}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={600}>Your permission, per project</Table.Td>
                <Table.Td>Sharing with Token Factory, and uploads to Nebius Sandboxes. Each stays off until you agree, after Nivra shows what goes.</Table.Td>
                <Table.Td style={STATE_CELL}>
                  <Text size="xs" c="var(--nivra-text-2)">
                    Asked per project
                  </Text>
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={600}>A Tavily key, with research on</Table.Td>
                <Table.Td>Only to check a plan's assumptions on the web. Research is switched on for the whole app, in Settings.</Table.Td>
                <Table.Td style={STATE_CELL}>
                  {settings && (
                    <Group gap={6} justify="flex-end" wrap="nowrap">
                      {keyBadge(settings.tavilyKey === "set", "Key saved", "No key")}
                      {keyBadge(settings.webResearch, "Research on", "Research off")}
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Paper>
        {!settings && settingsError && (
          <Text size="sm" c="var(--nivra-error)" data-testid="home-needs-error">
            Nivra couldn't read which keys are saved: {settingsError}
          </Text>
        )}
        <Anchor component="button" type="button" size="sm" fw={500} c="var(--mantine-color-text)" td="underline" style={{ alignSelf: "flex-start" }} onClick={() => onNavigate({ kind: "settings", section: "connections" })} data-testid="home-keys">
          Add keys now in Settings
        </Anchor>
      </Stack>
    </Stack>
  );
}
