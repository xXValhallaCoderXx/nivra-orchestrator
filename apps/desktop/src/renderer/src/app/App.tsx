import { Alert, AppShell, Container, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import type { EngineView, PreferencesView, ProjectView, WslView } from "../../../shared/ipc";
import { Doctor } from "../features/doctor";
import { EngineBadge, EngineNotices } from "../features/engine";
import { Explain } from "../features/explain";
import { HelloRun, TERMINAL, type RunRef } from "../features/hello";
import { Preferences } from "../features/preferences";
import { Projects } from "../features/projects";
import { Settings } from "../features/settings";
import { usePoll } from "../shared/ui";

/**
 * One page for the proof of concept: the repositories, each on the engine its folder belongs to (D17), the engineer's
 * preferences (D21), a hello run, Doctor and the key. There is no target to choose: adding a folder decides where its
 * work runs, and every engine a project uses keeps running, so a run is never cut off by looking at another project.
 */
export function App() {
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [preferencesVersion, setPreferencesVersion] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunRef>>({});
  const [explainRuns, setExplainRuns] = useState<Record<string, RunRef>>({});

  const projects = usePoll<ProjectView[]>(() => window.nivra.listProjects(), () => null, [projectsVersion]);
  const engines = usePoll<EngineView[]>(
    () => window.nivra.listEngines(),
    (list) => (list === null || list.some((e) => e.state.status === "starting") ? 700 : 2_500),
    [],
  );
  const wsl = usePoll<WslView | null>(() => window.nivra.getWsl(), (view) => (view?.status === "checking" ? 700 : null), []);
  // Preferences change only here, and a project's own go when it is removed: read them again after either.
  const preferences = usePoll<PreferencesView>(() => window.nivra.listPreferences(), () => null, [preferencesVersion, projectsVersion]);

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
  const online = engine?.state.status === "online";
  const busyIds = [...Object.entries(runs), ...Object.entries(explainRuns)]
    .filter(([, ref]) => ref.status !== null && !TERMINAL.includes(ref.status))
    .map(([id]) => id);
  const hostError = projects.error ?? engines.error ?? wsl.error ?? preferences.error;

  return (
    <AppShell header={{ height: 56 }} padding="md">
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
          <EngineBadge project={selected} engine={engine} />
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Container size={960} py="md">
          <Stack gap="md">
            {hostError && (
              <Alert color="red" title="Nivra couldn't load its state" data-testid="host-error">
                <Text size="sm">{hostError} It tries again by itself; if this keeps happening, quit and open Nivra again.</Text>
              </Alert>
            )}
            {selected && <EngineNotices projectId={selected.id} engine={engine} />}
            <Projects
              projects={list}
              selectedId={selected?.id ?? null}
              onSelect={setProjectId}
              onChanged={() => setProjectsVersion((n) => n + 1)}
              busyIds={busyIds}
              wsl={wsl.value}
              onWslChecked={() => wsl.refresh()}
            />
            <Explain
              key={`explain:${selected?.id ?? "none"}`}
              project={selected}
              online={online}
              preferences={preferences.value}
              run={selected ? (explainRuns[selected.id] ?? null) : null}
              onRun={(id, ref) => setExplainRuns((current) => (current[id]?.runId === ref.runId && current[id]?.status === ref.status ? current : { ...current, [id]: ref }))}
              onSharingChanged={() => setProjectsVersion((n) => n + 1)}
            />
            <Preferences project={selected} view={preferences.value} onChanged={() => setPreferencesVersion((n) => n + 1)} />
            <HelloRun
              key={`hello:${selected?.id ?? "none"}`}
              project={selected}
              online={online}
              run={selected ? (runs[selected.id] ?? null) : null}
              onRun={(id, ref) => setRuns((current) => (current[id]?.runId === ref.runId && current[id]?.status === ref.status ? current : { ...current, [id]: ref }))}
            />
            {/* Doctor reports and provider checks belong to one engine: they start fresh when the engine changes. */}
            <Doctor key={`doctor:${selected?.targetId ?? "none"}`} projectId={selected?.id ?? null} online={online} targetLabel={selected?.targetLabel ?? null} />
            <Settings key={`settings:${selected?.targetId ?? "none"}`} projectId={selected?.id ?? null} online={online} targetLabel={selected?.targetLabel ?? null} />
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
