import { Alert, AppShell, Box, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppInfo, ConversationsView, ConversationSummary, EngineView, PreferencesView, ProjectView, SettingsView, TasksView, WslView } from "../../../shared/ipc";
import { Conversation } from "../features/conversation";
import { Environment } from "../features/environment";
import { Explain } from "../features/explain";
import { TERMINAL, type RunRef } from "../features/hello";
import { MissionDetail, MissionsPage } from "../features/missions";
import { PlanningHome } from "../features/navigation";
import { AddedWarning, useAddProject, type AddOutcome } from "../features/projects";
import { NewTask, TaskDetail, TasksPage } from "../features/tasks";
import { errorMessage, usePoll } from "../shared/ui";
import { browserStorage, DraftsProvider } from "../shell/drafts";
import { newTaskDraftKey, openTaskCount, projectOnly, routeAfterSwitch, shownSection } from "../shell/places";
import { Sidebar } from "../shell/Sidebar";
import { Switcher, type SwitcherHandle } from "../shell/Switcher";
import { ToastProvider, useToast } from "../shell/Toasts";
import { GeneralHome, ProjectHome } from "./Home";
import type { Route, Scope } from "./routes";
import { SettingsPage } from "./SettingsPage";

/**
 * The window (NIV-56): a sidebar with the project switcher, and the page of the place in view. Where the window is, is
 * a scope (General or one project) and a route, kept as state: there is no router. There is no target to choose
 * anywhere: a project's folder decides where its work runs (D17), and work keeps the project it was recorded with; the
 * switcher only changes what is in view. The pages that were Projects & settings (Settings, Explain and Environment)
 * stay mounted while another place is shown, as that page did, so their runs and what was typed there are kept.
 */
export function App() {
  return (
    <DraftsProvider storage={STORAGE}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </DraftsProvider>
  );
}

/** The window's local storage, reached once: drafts are kept there (shell/draft-store.ts). */
const STORAGE = browserStorage();

/** The scope in view: the one chosen, or the only project there is, or General. A removed project's scope is General. */
function scopeOf(chosen: Scope | null, projects: ProjectView[] | null): Scope {
  if (chosen?.kind === "project") return !projects || projects.some((p) => p.id === chosen.projectId) ? chosen : { kind: "general" };
  if (chosen) return chosen;
  return projects?.length === 1 ? { kind: "project", projectId: projects[0]!.id } : { kind: "general" };
}

/** A page of the window, shown or kept mounted out of sight. */
function Page({ shown, testId, children }: { shown: boolean; testId: string; children: ReactNode }) {
  return (
    <Box display={shown ? undefined : "none"} data-testid={testId}>
      {children}
    </Box>
  );
}

function Shell() {
  const toast = useToast();
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [preferencesVersion, setPreferencesVersion] = useState(0);
  const [conversationsVersion, setConversationsVersion] = useState(0);
  // Counts the saves of the key and project id: the sandbox check and environment read their engine's state again on each.
  const [credentialsSaved, setCredentialsSaved] = useState(0);
  const [chosen, setChosen] = useState<Scope | null>(null);
  const [route, setRoute] = useState<Route>({ kind: "home" });
  // Hello and Explain runs this window started, by project: their pages find them again after any navigation.
  const [helloRuns, setHelloRuns] = useState<Record<string, RunRef>>({});
  const [explainRuns, setExplainRuns] = useState<Record<string, RunRef>>({});
  const [addWarning, setAddWarning] = useState<{ projectId: string; text: string } | null>(null);
  const switcher = useRef<SwitcherHandle>(null);

  const projects = usePoll<ProjectView[]>(() => window.nivra.listProjects(), () => null, [projectsVersion]);
  const engines = usePoll<EngineView[]>(
    () => window.nivra.listEngines(),
    (list) => (list === null || list.some((e) => e.state.status === "starting") ? 700 : 2_500),
    [],
  );
  const wsl = usePoll<WslView | null>(() => window.nivra.getWsl(), (view) => (view?.status === "checking" ? 700 : null), []);
  // Preferences change only in Settings, and a project's own go when it is removed: read them again after either.
  const preferences = usePoll<PreferencesView>(() => window.nivra.listPreferences(), () => null, [preferencesVersion, projectsVersion]);
  // A conversation's title and order change as it is used; a removed project marks its conversations.
  const conversations = usePoll<ConversationsView>(() => window.nivra.listConversations(), () => 5_000, [conversationsVersion, projectsVersion]);
  // For the sidebar's open-task count and the project's Home.
  const tasks = usePoll<TasksView>(() => window.nivra.listTasks(), () => 5_000, [projectsVersion]);
  // Whether the keys are saved, for the Homes' setup rows; read again after each save in Settings.
  const settings = usePoll<SettingsView>(() => window.nivra.getSettings(), () => null, [credentialsSaved]);
  const appInfo = usePoll<AppInfo>(() => window.nivra.getAppInfo(), () => null, []);

  const list = projects.value ?? [];
  const scope = scopeOf(chosen, projects.value);
  const project = scope.kind === "project" ? (list.find((p) => p.id === scope.projectId) ?? null) : null;

  // Opening a project starts its own engine if it isn't running yet, and never another one.
  useEffect(() => {
    if (!project) return;
    const refresh = () => engines.refresh();
    void window.nivra.openProject(project.id).then(refresh, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const engine = project ? (engines.value?.find((e) => e.targetId === project.targetId) ?? null) : null;
  const online = engine?.state.status === "online";
  const hostError = projects.error ?? engines.error ?? wsl.error ?? preferences.error ?? conversations.error;
  const workspace = conversations.value?.workspace;
  const notice = workspace?.state === "ready" ? workspace.notice : null;
  // A project's own place, with no project in view, shows General's Home.
  const shown: Route = projectOnly(route) && !project ? { kind: "home" } : route;
  const busyIds = [...Object.entries(helloRuns), ...Object.entries(explainRuns)]
    .filter(([, ref]) => ref.status !== null && !TERMINAL.includes(ref.status))
    .map(([id]) => id);

  const navigate = (next: Route) => setRoute(next.kind === "settings" ? { ...next, section: shownSection(next.section) } : next);
  const switchTo = (next: Scope) => {
    setChosen(next);
    setRoute((current) => routeAfterSwitch(current, next));
  };
  const opened = (summary: ConversationSummary) => {
    setConversationsVersion((n) => n + 1);
    navigate({ kind: "conversation", id: summary.id });
  };

  const added = ({ project: addedProject, alreadyListed, warning }: AddOutcome) => {
    setChosen({ kind: "project", projectId: addedProject.id });
    setRoute({ kind: "home" });
    toast(
      alreadyListed ? `That folder is already in your projects as ${addedProject.label}, so Nivra opened it. Nothing was added.` : `${addedProject.label} added from ${addedProject.targetLabel}`,
      alreadyListed ? "info" : "done",
    );
    setAddWarning(warning ? { projectId: addedProject.id, text: warning } : null);
  };
  const adding = useAddProject({ projects: list, onAdded: added, onChanged: () => setProjectsVersion((n) => n + 1) });

  const switcherElement = (
    <Switcher scope={scope} projects={list} windowsHost={appInfo.value?.platform === "win32"} adding={adding.busy} onSwitch={switchTo} onAdd={() => void adding.add()} handle={switcher} />
  );

  return (
    <AppShell navbar={{ width: 272, breakpoint: "sm" }} padding={0}>
      <Sidebar
        route={shown}
        scope={scope}
        switcher={switcherElement}
        showLogo
        openTasks={tasks.value?.workspace.state === "ready" ? openTaskCount(tasks.value.tasks, scope) : null}
        conversations={conversations.value}
        projects={list}
        drafts={{ available: true, list: [] }}
        onNavigate={navigate}
        onOpenDraft={() => undefined}
        onConversationCreated={opened}
      />
      <AppShell.Main id="page" tabIndex={-1} style={{ outline: "none" }}>
        <Box px={{ base: 16, sm: 40 }} pt={28} pb={40} maw={1120}>
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
            {addWarning && <AddedWarning project={list.find((p) => p.id === addWarning.projectId) ?? null} text={addWarning.text} onDismiss={() => setAddWarning(null)} />}

            {shown.kind === "home" && (
              <Box data-testid="page-projects">
                <Box data-testid="page-home">
                  {project ? (
                    <ProjectHome
                      key={project.id}
                      project={project}
                      engine={engine}
                      settings={settings.value}
                      tasks={tasks.value}
                      running={busyIds.includes(project.id)}
                      onNavigate={navigate}
                      onCreateTask={(title) => navigate({ kind: "new-task", draftKey: newTaskDraftKey(scope), plan: null, title })}
                      onStartConversation={async () => {
                        try {
                          opened(await window.nivra.createConversation({ kind: "project", projectId: project.id }));
                        } catch (reason) {
                          toast(errorMessage(reason), "info");
                        }
                      }}
                      onRemoved={(label, preferencesRemoved) => {
                        setProjectsVersion((n) => n + 1);
                        setChosen({ kind: "general" });
                        setRoute({ kind: "home" });
                        toast(
                          preferencesRemoved
                            ? `Removed ${label} from the list, with its ${preferencesRemoved} own ${preferencesRemoved === 1 ? "preference" : "preferences"}. Your personal preferences stay.`
                            : `Removed ${label} from the list. Its folder is as it was.`,
                        );
                      }}
                    />
                  ) : (
                    <GeneralHome
                      projects={list}
                      settings={settings.value}
                      wsl={wsl.value}
                      adding={adding.busy}
                      onAdd={() => void adding.add()}
                      onOpenProject={(id) => switchTo({ kind: "project", projectId: id })}
                      onNavigate={navigate}
                      onNewTask={() => navigate({ kind: "new-task", draftKey: newTaskDraftKey(scope), plan: null, title: "" })}
                    />
                  )}
                </Box>
              </Box>
            )}
            {shown.kind === "tasks" && (
              <Box data-testid="page-tasks">
                <TasksPage onOpen={(id) => navigate({ kind: "task", id, tab: "brief" })} onNew={() => navigate({ kind: "new-task", draftKey: newTaskDraftKey(scope), plan: null, title: "" })} />
              </Box>
            )}
            {shown.kind === "new-task" && (
              <Box data-testid="page-new-task">
                <NewTask
                  // A new form for each plan or draft it starts from.
                  key={shown.plan?.id ?? shown.draftKey}
                  projects={list}
                  plan={shown.plan}
                  initialTitle={shown.title}
                  onCreated={(task) => navigate({ kind: "task", id: task.summary.id, tab: "brief" })}
                  onCancel={() => navigate(shown.plan ? { kind: "conversation", id: shown.plan.conversationId } : { kind: "tasks" })}
                />
              </Box>
            )}
            {shown.kind === "task" && (
              <Box data-testid="page-task">
                <TaskDetail
                  key={shown.id}
                  taskId={shown.id}
                  projects={list}
                  engines={engines.value ?? []}
                  onEngineRestarted={() => engines.refresh()}
                  onDeleted={() => navigate({ kind: "tasks" })}
                  onOpenConversation={(id) => navigate({ kind: "conversation", id })}
                />
              </Box>
            )}
            {shown.kind === "conversations" && (
              <Box data-testid="page-conversations">
                <PlanningHome projects={list} onCreated={opened} />
              </Box>
            )}
            {shown.kind === "conversation" && (
              <Box data-testid="page-conversation">
                <Conversation
                  key={shown.id}
                  conversationId={shown.id}
                  projects={list}
                  preferences={preferences.value}
                  onChanged={() => setConversationsVersion((n) => n + 1)}
                  onDeleted={() => {
                    setConversationsVersion((n) => n + 1);
                    navigate({ kind: "conversations" });
                  }}
                  onSharingChanged={() => setProjectsVersion((n) => n + 1)}
                  onCreateTask={(plan, title) => navigate({ kind: "new-task", draftKey: `new-task:plan:${plan.id}`, plan, title })}
                />
              </Box>
            )}
            {shown.kind === "missions" && (
              <Box data-testid="page-missions">
                <MissionsPage onOpen={(id) => navigate({ kind: "mission", id })} />
              </Box>
            )}
            {shown.kind === "mission" && (
              <Box data-testid="page-mission">
                <MissionDetail key={shown.id} missionId={shown.id} onOpenTask={(id) => navigate({ kind: "task", id, tab: "brief" })} onDeleted={() => navigate({ kind: "missions" })} />
              </Box>
            )}

            {/* Kept mounted, as Projects & settings was: their runs and what was typed in them outlive navigation. */}
            <Page shown={shown.kind === "explain"} testId="page-explain">
              <Explain
                key={`explain:${project?.id ?? "none"}`}
                project={project}
                online={online}
                preferences={preferences.value}
                run={project ? (explainRuns[project.id] ?? null) : null}
                onRun={(id, ref) => setExplainRuns((current) => (current[id]?.runId === ref.runId && current[id]?.status === ref.status ? current : { ...current, [id]: ref }))}
                onSharingChanged={() => setProjectsVersion((n) => n + 1)}
                onPreferencesChanged={() => setPreferencesVersion((n) => n + 1)}
              />
            </Page>
            <Page shown={shown.kind === "environment"} testId="page-environment">
              <Environment key={`environment:${project?.id ?? "none"}`} project={project} online={online} credentialsSaved={credentialsSaved} onProjectChanged={() => setProjectsVersion((n) => n + 1)} />
            </Page>
            <Page shown={shown.kind === "settings"} testId="page-settings">
              <SettingsPage
                project={project}
                projects={list}
                engine={engine}
                wsl={wsl.value}
                onWslChecked={() => wsl.refresh()}
                preferences={preferences.value}
                onPreferencesChanged={() => setPreferencesVersion((n) => n + 1)}
                onProjectsChanged={() => setProjectsVersion((n) => n + 1)}
                helloRun={project ? (helloRuns[project.id] ?? null) : null}
                onHelloRun={(id, ref) => setHelloRuns((current) => (current[id]?.runId === ref.runId && current[id]?.status === ref.status ? current : { ...current, [id]: ref }))}
                credentialsSaved={credentialsSaved}
                onCredentialsSaved={() => setCredentialsSaved((count) => count + 1)}
              />
            </Page>
          </Stack>
        </Box>
      </AppShell.Main>
      {adding.dialog}
    </AppShell>
  );
}
