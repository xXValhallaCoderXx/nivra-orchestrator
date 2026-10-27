import { Stack } from "@mantine/core";
import { useState } from "react";
import type { EngineView, PreferencesView, ProjectView, WslView } from "../../../shared/ipc";
import { Doctor } from "../features/doctor";
import { EngineNotices } from "../features/engine";
import { Environment } from "../features/environment";
import { Explain } from "../features/explain";
import { HelloRun, TERMINAL, type RunRef } from "../features/hello";
import { Preferences } from "../features/preferences";
import { Projects } from "../features/projects";
import { SandboxCheck } from "../features/sandbox";
import { ResearchSettings, Settings } from "../features/settings";

/**
 * Projects & settings: the repositories, each on the engine its folder belongs to (D17), the engineer's preferences
 * (D21), Explain, a sandbox check (D36), the project's environment (D41), a hello run, Doctor, and the key and project
 * id. There is no target to choose: adding a folder decides where its work
 * runs, and every engine a project uses keeps running, so a run is never cut off by looking at another project. The page
 * stays mounted while another place is shown, so a run and what was typed are still there on the way back.
 */
export function ProjectsPage({
  projects,
  selected,
  onSelect,
  engine,
  wsl,
  onWslChecked,
  preferences,
  onProjectsChanged,
  onPreferencesChanged,
}: {
  projects: ProjectView[];
  selected: ProjectView | null;
  onSelect(id: string | null): void;
  /** The chosen project's engine. */
  engine: EngineView | null;
  wsl: WslView | null;
  onWslChecked(): void;
  preferences: PreferencesView | null;
  onProjectsChanged(): void;
  onPreferencesChanged(): void;
}) {
  const [runs, setRuns] = useState<Record<string, RunRef>>({});
  const [explainRuns, setExplainRuns] = useState<Record<string, RunRef>>({});
  // Counts the saves of the key and project id: the sandbox check reads its engine's recovery again on each.
  const [credentialsSaved, setCredentialsSaved] = useState(0);
  const online = engine?.state.status === "online";
  const busyIds = [...Object.entries(runs), ...Object.entries(explainRuns)]
    .filter(([, ref]) => ref.status !== null && !TERMINAL.includes(ref.status))
    .map(([id]) => id);

  return (
    <Stack gap="md">
      {selected && <EngineNotices engine={engine} onRestart={() => window.nivra.restartEngine(selected.id)} />}
      <Projects projects={projects} selectedId={selected?.id ?? null} onSelect={onSelect} onChanged={onProjectsChanged} busyIds={busyIds} wsl={wsl} onWslChecked={onWslChecked} />
      <Explain
        key={`explain:${selected?.id ?? "none"}`}
        project={selected}
        online={online}
        preferences={preferences}
        run={selected ? (explainRuns[selected.id] ?? null) : null}
        onRun={(id, ref) => setExplainRuns((current) => (current[id]?.runId === ref.runId && current[id]?.status === ref.status ? current : { ...current, [id]: ref }))}
        onSharingChanged={onProjectsChanged}
        onPreferencesChanged={onPreferencesChanged}
      />
      <SandboxCheck key={`sandbox:${selected?.id ?? "none"}`} project={selected} online={online} credentialsSaved={credentialsSaved} onProjectChanged={onProjectsChanged} />
      <Environment key={`environment:${selected?.id ?? "none"}`} project={selected} online={online} credentialsSaved={credentialsSaved} onProjectChanged={onProjectsChanged} />
      <Preferences key={`preferences:${selected?.id ?? "none"}`} project={selected} projects={projects} view={preferences} onChanged={onPreferencesChanged} />
      <HelloRun
        key={`hello:${selected?.id ?? "none"}`}
        project={selected}
        online={online}
        run={selected ? (runs[selected.id] ?? null) : null}
        onRun={(id, ref) => setRuns((current) => (current[id]?.runId === ref.runId && current[id]?.status === ref.status ? current : { ...current, [id]: ref }))}
      />
      {/* Doctor reports and provider checks belong to one engine: they start fresh when the engine changes. */}
      <Doctor key={`doctor:${selected?.targetId ?? "none"}`} projectId={selected?.id ?? null} online={online} targetLabel={selected?.targetLabel ?? null} />
      <Settings
        key={`settings:${selected?.targetId ?? "none"}`}
        projectId={selected?.id ?? null}
        online={online}
        targetLabel={selected?.targetLabel ?? null}
        onCredentialsSaved={() => setCredentialsSaved((count) => count + 1)}
      />
      <ResearchSettings />
    </Stack>
  );
}
