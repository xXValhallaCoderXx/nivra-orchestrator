import { AppShell, Container, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { EngineView, ProjectView, TargetsView } from "../../../shared/ipc";
import { Doctor } from "../features/doctor";
import { EngineNotices, TargetBar } from "../features/engine";
import { HelloRun } from "../features/hello";
import { Projects } from "../features/projects";
import { Settings } from "../features/settings";
import { usePoll } from "../shared/ui";

/** One page for the bootstrap: where the engine runs, the repository, a hello run, Doctor and the key (B4). */
export function App() {
  const [targetsVersion, setTargetsVersion] = useState(0);
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);

  const targets = usePoll<TargetsView>(() => window.nivra.listTargets(), () => null, [targetsVersion]);
  const engine = usePoll<EngineView>(
    () => window.nivra.engineStatus(),
    (view) => (view?.state.status === "starting" || view === null ? 700 : 2_500),
    [targetsVersion],
  );
  const projects = usePoll<ProjectView[]>(() => window.nivra.listProjects(), () => null, [targetsVersion, projectsVersion]);

  // A project belongs to one target: the choice counts only while it is in the current target's list (which may still
  // be loading right after a folder was added, so the choice is kept rather than cleared).
  const selectedProjectId = projects.value?.some((p) => p.id === projectId) ? projectId : null;

  const selected = targets.value?.targets.find((t) => t.id === targets.value?.selectedId);
  const online = engine.value?.state.status === "online";

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
          <TargetBar
            targets={targets.value}
            engine={engine.value}
            onSelected={() => {
              setProjectId(null);
              setTargetsVersion((n) => n + 1);
            }}
          />
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Container size={960} py="md">
          <Stack gap="md">
            <EngineNotices engine={engine.value} targets={targets.value} />
            <Projects
              projects={projects.value ?? []}
              selectedId={selectedProjectId}
              onSelect={setProjectId}
              onChanged={() => setProjectsVersion((n) => n + 1)}
              targetLabel={selected?.label ?? "this target"}
            />
            <HelloRun projectId={selectedProjectId} online={online} />
            <Doctor online={online} />
            <Settings online={online} targetLabel={selected?.label ?? "this target"} />
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
