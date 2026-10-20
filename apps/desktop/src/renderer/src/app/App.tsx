import { Alert, AppShell, Box, Container, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import type { ConversationsView, ConversationSummary, EngineView, PreferencesView, ProjectView, WslView } from "../../../shared/ipc";
import { Conversation } from "../features/conversation";
import { EngineBadge } from "../features/engine";
import { Navigation, PlanningHome, type View } from "../features/navigation";
import { usePoll } from "../shared/ui";
import { ProjectsPage } from "./ProjectsPage";

/**
 * The window: a side navigation between Review & planning (conversations, D26) and Projects & settings, the page of
 * repositories, preferences and runs. There is no target to choose anywhere: a project's folder decides where its work
 * runs (D17), and a conversation keeps the scope it started with. Projects & settings stays mounted while another place
 * is shown, so its runs and what was typed there are kept.
 */
export function App() {
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [preferencesVersion, setPreferencesVersion] = useState(0);
  const [conversationsVersion, setConversationsVersion] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "projects" });

  const projects = usePoll<ProjectView[]>(() => window.nivra.listProjects(), () => null, [projectsVersion]);
  const engines = usePoll<EngineView[]>(
    () => window.nivra.listEngines(),
    (list) => (list === null || list.some((e) => e.state.status === "starting") ? 700 : 2_500),
    [],
  );
  const wsl = usePoll<WslView | null>(() => window.nivra.getWsl(), (view) => (view?.status === "checking" ? 700 : null), []);
  // Preferences change only here, and a project's own go when it is removed: read them again after either.
  const preferences = usePoll<PreferencesView>(() => window.nivra.listPreferences(), () => null, [preferencesVersion, projectsVersion]);
  // A conversation's title and order change as it is used; a removed project marks its conversations.
  const conversations = usePoll<ConversationsView>(() => window.nivra.listConversations(), () => 5_000, [conversationsVersion, projectsVersion]);

  const list = projects.value ?? [];
  // The chosen project, or the only one there is.
  const selected = list.find((p) => p.id === projectId) ?? (list.length === 1 ? list[0]! : null);

  // Opening a project starts its own engine if it isn't running yet, and never another one.
  useEffect(() => {
    if (!selected) return;
    const refresh = () => engines.refresh();
    void window.nivra.openProject(selected.id).then(refresh, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const engine = selected ? (engines.value?.find((e) => e.targetId === selected.targetId) ?? null) : null;
  const hostError = projects.error ?? engines.error ?? wsl.error ?? preferences.error ?? conversations.error;
  const workspace = conversations.value?.workspace;
  const notice = workspace?.state === "ready" ? workspace.notice : null;
  const opened = (summary: ConversationSummary) => {
    setConversationsVersion((n) => n + 1);
    setView({ kind: "conversation", id: summary.id });
  };

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 272, breakpoint: "xs" }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap={8} wrap="nowrap">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
              <path d="M8 16V8l8 8V8" stroke="var(--mantine-color-body)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <Text fz={17} fw={600} style={{ letterSpacing: "-0.01em" }}>
              Nivra
            </Text>
          </Group>
          {/* Where the chosen project's work runs; a conversation shows its own engine instead. */}
          {view.kind === "projects" && <EngineBadge project={selected} engine={engine} />}
        </Group>
      </AppShell.Header>
      <Navigation view={view} onNavigate={setView} conversations={conversations.value} projects={list} onCreated={opened} />
      <AppShell.Main>
        <Container size={960} py="md">
          <Stack gap="md">
            {hostError && (
              <Alert color="red" title="Nivra couldn't load its state" data-testid="host-error">
                <Text size="sm">{hostError} It tries again by itself; if this keeps happening, quit and open Nivra again.</Text>
              </Alert>
            )}
            {notice && (
              <Alert color="yellow" variant="light" data-testid="workspace-notice">
                <Text size="sm">{notice}</Text>
              </Alert>
            )}
            <Box display={view.kind === "projects" ? undefined : "none"} data-testid="page-projects">
              <ProjectsPage
                projects={list}
                selected={selected}
                onSelect={setProjectId}
                engine={engine}
                wsl={wsl.value}
                onWslChecked={() => wsl.refresh()}
                preferences={preferences.value}
                onProjectsChanged={() => setProjectsVersion((n) => n + 1)}
                onPreferencesChanged={() => setPreferencesVersion((n) => n + 1)}
              />
            </Box>
            {view.kind === "planning" && <PlanningHome projects={list} onCreated={opened} />}
            {view.kind === "conversation" && (
              <Conversation
                key={view.id}
                conversationId={view.id}
                projects={list}
                preferences={preferences.value}
                onChanged={() => setConversationsVersion((n) => n + 1)}
                onDeleted={() => {
                  setConversationsVersion((n) => n + 1);
                  setView({ kind: "planning" });
                }}
                onSharingChanged={() => setProjectsVersion((n) => n + 1)}
              />
            )}
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
