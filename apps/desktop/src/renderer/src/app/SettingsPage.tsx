import { Stack, Title } from "@mantine/core";
import type { EngineView, PreferencesView, ProjectView, WslView } from "../../../shared/ipc";
import { Doctor } from "../features/doctor";
import { EngineNotices } from "../features/engine";
import { HelloRun, type RunRef } from "../features/hello";
import { Preferences } from "../features/preferences";
import { SandboxCheck } from "../features/sandbox";
import { ResearchSettings, Settings } from "../features/settings";
import { WslGuidance } from "../features/wsl";

/**
 * Settings: the keys, research, preferences and the checks that were on Projects & settings, for the project in view
 * (its engine runs the checks). It stays mounted while another place is shown, as that page did, so a run and what was
 * typed are still there on the way back.
 */
export function SettingsPage({
  project,
  projects,
  engine,
  wsl,
  onWslChecked,
  preferences,
  onPreferencesChanged,
  onProjectsChanged,
  helloRun,
  onHelloRun,
  credentialsSaved,
  onCredentialsSaved,
}: {
  project: ProjectView | null;
  projects: ProjectView[];
  engine: EngineView | null;
  wsl: WslView | null;
  onWslChecked(): void;
  preferences: PreferencesView | null;
  onPreferencesChanged(): void;
  onProjectsChanged(): void;
  helloRun: RunRef | null;
  onHelloRun(projectId: string, ref: RunRef): void;
  credentialsSaved: number;
  onCredentialsSaved(): void;
}) {
  const online = engine?.state.status === "online";
  return (
    <Stack gap="md">
      <Title order={1}>Settings</Title>
      {project && <EngineNotices engine={engine} onRestart={() => window.nivra.restartEngine(project.id)} />}
      <Settings key={`settings:${project?.targetId ?? "none"}`} projectId={project?.id ?? null} online={online} targetLabel={project?.targetLabel ?? null} onCredentialsSaved={onCredentialsSaved} />
      <ResearchSettings />
      <Preferences key={`preferences:${project?.id ?? "none"}`} project={project} projects={projects} view={preferences} onChanged={onPreferencesChanged} />
      <SandboxCheck key={`sandbox:${project?.id ?? "none"}`} project={project} online={online} credentialsSaved={credentialsSaved} onProjectChanged={onProjectsChanged} />
      <HelloRun key={`hello:${project?.id ?? "none"}`} project={project} online={online} run={helloRun} onRun={onHelloRun} />
      <Doctor key={`doctor:${project?.targetId ?? "none"}`} projectId={project?.id ?? null} online={online} targetLabel={project?.targetLabel ?? null} />
      {wsl && <WslGuidance wsl={wsl} onChecked={onWslChecked} />}
    </Stack>
  );
}
