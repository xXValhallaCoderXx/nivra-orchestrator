import { Badge, Box, Code, Grid, Group, ScrollArea, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppInfo, EngineView, PreferencesView, ProjectView, SettingsView, WslView } from "../../../shared/ipc";
import { CompanionUsage } from "../features/companion-usage";
import { BudgetAndUsage } from "../features/budget-usage";
import { Doctor } from "../features/doctor";
import { EngineNotices } from "../features/engine";
import { HelloRun, type RunRef } from "../features/hello";
import { Preferences } from "../features/preferences";
import { SandboxCheck } from "../features/sandbox";
import { FeatureNeeds, NebiusConnection, ResearchSwitch, SettingsCard, SharingTable, TavilyConnection } from "../features/settings";
import { WslGuidance } from "../features/wsl";
import { Appearance } from "../shell/Appearance";
import { CopyButton } from "../shell/CopyButton";
import { SETTINGS_TABS } from "../shell/places";
import type { SettingsSection } from "./routes";

const INTRO: Partial<Record<SettingsSection, string>> = {
  connections: "Keys are kept on this computer, encrypted where its keychain allows, and handed to Nivra's engines in memory only. Nivra never shows any part of a saved key.",
  sharing:
    "What may leave this computer, for each project. A switch that's on can be turned off here. One that's off is turned on where it's first needed, after Nivra shows what would be sent.",
  preferences:
    "How you like to work, in your own words. Runs get only the preferences you confirmed here: your personal ones, and the project's own. Nivra never adds a preference by itself.",
  diagnostics:
    "For finding out what works and what doesn't. Each place your projects are in has its own engine, and each is diagnosed on its own. Nothing here changes your projects.",
};

const ENGINE_WORDS: Record<EngineView["state"]["status"], { label: string; color: string }> = {
  online: { label: "Online", color: "green" },
  starting: { label: "Starting", color: "gray" },
  stopped: { label: "Stopped", color: "gray" },
  failed: { label: "Failed", color: "red" },
};

/**
 * Settings (SH8): Connections, Sharing, Preferences, Budget and usage, and Advanced diagnostics, one shown at a time,
 * each with its own link (a nav of links: these are pages, not tabs of one panel). Agents and council defaults come
 * later. Every section stays mounted while another is shown, and Settings stays mounted while another place is, as
 * Projects & settings did, so a run and what was typed are still there on the way back. The checks run on the engine of
 * the project in view.
 */
export function SettingsPage({
  section,
  onSection,
  narrow,
  project,
  projects,
  engine,
  engines,
  wsl,
  onWslChecked,
  preferences,
  onPreferencesChanged,
  onProjectsChanged,
  helloRun,
  onHelloRun,
  credentialsSaved,
  onCredentialsSaved,
  appInfo,
  settings,
  enginesError,
  appInfoError,
  visible,
}: {
  section: SettingsSection;
  onSection(section: SettingsSection): void;
  narrow: boolean;
  project: ProjectView | null;
  projects: ProjectView[];
  engine: EngineView | null;
  engines: EngineView[];
  wsl: WslView | null;
  onWslChecked(): void;
  preferences: PreferencesView | null;
  onPreferencesChanged(): void;
  onProjectsChanged(): void;
  helloRun: RunRef | null;
  onHelloRun(projectId: string, ref: RunRef): void;
  credentialsSaved: number;
  onCredentialsSaved(): void;
  appInfo: AppInfo | null;
  settings: SettingsView | null;
  /** Failed reads, shown where their figures would be. */
  enginesError: string | null;
  appInfoError: string | null;
  /** Settings is the place in view: its sections read the settings again each time it is opened. */
  visible: boolean;
}) {
  // Other places change settings too (research turned on in a conversation, say): each opening reads them again.
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    if (visible) setOpened((count) => count + 1);
  }, [visible]);
  const online = engine?.state.status === "online";
  const windowsHost = appInfo?.platform === "win32";
  const shown = (name: SettingsSection) => (section === name ? undefined : "none");
  return (
    <Stack gap="lg">
      <Title order={1}>Settings</Title>
      <SectionLinks section={section} onSection={onSection} narrow={narrow} />
      {INTRO[section] && (
        <Text size="sm" c="var(--nivra-text-2)" maw={860} data-testid="settings-intro">
          {INTRO[section]}
        </Text>
      )}

      <Box display={shown("connections")} data-testid="settings-connections">
        <Grid gap="md" align="flex-start">
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack gap="md">
              <NebiusConnection key={`nebius:${project?.targetId ?? "none"}`} project={project} online={online} onCredentialsSaved={onCredentialsSaved} freshness={opened} />
              <TavilyConnection freshness={opened} onSaved={onCredentialsSaved} />
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <FeatureNeeds />
          </Grid.Col>
        </Grid>
      </Box>

      <Box display={shown("sharing")} data-testid="settings-sharing">
        <Stack gap="md">
          <SharingTable projects={projects} windowsHost={windowsHost} onChanged={onProjectsChanged} />
          <ResearchSwitch freshness={opened} />
        </Stack>
      </Box>

      <Box display={shown("preferences")} data-testid="settings-preferences">
        <Grid gap="md" align="flex-start">
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Preferences key={`preferences:${project?.id ?? "none"}`} project={project} projects={projects} view={preferences} onChanged={onPreferencesChanged} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <SettingsCard title="Appearance" testId="settings-appearance">
              <Appearance />
            </SettingsCard>
          </Grid.Col>
        </Grid>
      </Box>

      {/* A slot: the working budget screen takes BudgetAndUsage's place. */}
      <Box display={shown("budget")} data-testid="settings-budget">
        <CompanionUsage freshness={opened} />
        <BudgetAndUsage />
      </Box>

      <Box display={shown("diagnostics")} data-testid="settings-diagnostics">
        <Stack gap="md">
          <SettingsCard
            title={project ? `${project.targetLabel} engine` : "Engines"}
            description={
              project
                ? `The engine ${project.label} runs on. Diagnose setup, the hello run and the sandbox check below run on it.`
                : "Diagnostics run on a project's engine: choose a project with the switcher."
            }
            testId="diagnostics-engine"
          >
            {project && <EngineNotices engine={engine} onRestart={() => window.nivra.restartEngine(project.id)} />}
            {engine?.state.status === "online" && <TechnicalDetails text={engineDetails(engine)} label="Copy the engine's technical details" testId="engine-details" />}
            {enginesError ? (
              <Text size="sm" c="var(--nivra-error)" data-testid="diagnostics-engines-error">
                Nivra couldn't read its engines' state: {enginesError}
              </Text>
            ) : (
              <EngineList engines={engines} projects={projects} />
            )}
          </SettingsCard>
          <Doctor key={`doctor:${project?.targetId ?? "none"}`} projectId={project?.id ?? null} online={online} targetLabel={project?.targetLabel ?? null} />
          <HelloRun key={`hello:${project?.id ?? "none"}`} project={project} online={online} run={helloRun} onRun={onHelloRun} />
          <SandboxCheck key={`sandbox:${project?.id ?? "none"}`} project={project} online={online} credentialsSaved={credentialsSaved} onProjectChanged={onProjectsChanged} />
          {wsl && <WslGuidance wsl={wsl} onChecked={onWslChecked} />}
          <SettingsCard title="This app" testId="diagnostics-app">
            {appInfo ? (
              <TechnicalDetails
                text={`Nivra ${appInfo.version} · window on ${appInfo.platform} · Electron ${appInfo.electron}${settings ? ` · keys ${settings.keychain === "available" ? "encrypted by this computer's keychain" : "kept unencrypted: no keychain"}` : ""}`}
                label="Copy this app's technical details"
                testId="app-details"
              />
            ) : (
              <Text size="sm" c={appInfoError ? "var(--nivra-error)" : "var(--nivra-text-2)"} data-testid="app-details-state">
                {appInfoError ? `Nivra couldn't read this app's details: ${appInfoError}` : "Reading…"}
              </Text>
            )}
          </SettingsCard>
        </Stack>
      </Box>
    </Stack>
  );
}

/** An engine's facts on one line, as a person would paste them into a report. */
const engineDetails = (engine: EngineView) =>
  engine.state.status === "online"
    ? `Engine ${engine.state.info.engineVersion} · ${engine.state.info.platform}/${engine.state.info.arch} · Node ${engine.state.info.node} · data in ${engine.state.info.home}`
    : "";

/** A line of technical details, with a button that copies it. */
function TechnicalDetails({ text, label, testId }: { text: string; label: string; testId: string }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start" justify="space-between">
      <Text size="sm" ff="monospace" c="var(--nivra-text-2)" style={{ overflowWrap: "anywhere" }} data-testid={testId}>
        {text}
      </Text>
      <CopyButton text={text} label={label} testId={`copy-${testId}`} />
    </Group>
  );
}

/** Every engine this session knows, its state in words, and the projects that use it. */
function EngineList({ engines, projects }: { engines: EngineView[]; projects: ProjectView[] }) {
  if (!engines.length) {
    return (
      <Text size="sm" c="var(--nivra-text-2)">
        No engine has started yet: a project's engine starts when it is first opened.
      </Text>
    );
  }
  return (
    <Stack gap={0}>
      {engines.map((view) => {
        const users = projects.filter((p) => p.targetId === view.targetId).map((p) => p.label);
        const words = ENGINE_WORDS[view.state.status];
        return (
          <Group key={view.targetId} justify="space-between" wrap="nowrap" py={8} style={{ borderTop: "1px solid var(--nivra-border)" }} data-testid="diagnostics-engine-row">
            <Box style={{ minWidth: 0 }}>
              <Text size="sm" fw={600}>
                {view.label}
              </Text>
              <Text size="xs" c="var(--nivra-text-2)">
                {users.length ? `Used by ${users.join(", ")}.` : "No project in the list uses it."}
                {view.state.status === "online" && (
                  <>
                    {" "}
                    <Code fz="xs">
                      engine {view.state.info.engineVersion} · {view.state.info.platform}/{view.state.info.arch} · Node {view.state.info.node}
                    </Code>
                  </>
                )}
              </Text>
            </Box>
            <Badge variant="light" color={words.color} style={{ flex: "none" }}>
              {words.label}
            </Badge>
          </Group>
        );
      })}
    </Stack>
  );
}

/** The sections' links: in a narrow window one row that scrolls sideways in its own box, the current one in view (NW2). */
function SectionLinks({ section, onSection, narrow }: { section: SettingsSection; onSection(section: SettingsSection): void; narrow: boolean }) {
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (narrow) current.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [narrow, section]);
  const links: ReactNode = (
    <Box component="nav" aria-label="Settings sections" style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--nivra-border)", minWidth: "max-content" }}>
      {SETTINGS_TABS.map((tab) => {
        const active = tab.section === section;
        return (
          <UnstyledButton
            key={tab.section}
            ref={active ? current : undefined}
            aria-current={active ? "page" : undefined}
            onClick={() => onSection(tab.section)}
            style={{
              height: 36,
              padding: "0 12px",
              borderBottom: `2px solid ${active ? "var(--mantine-color-text)" : "transparent"}`,
              marginBottom: -1,
              fontSize: 13,
              fontWeight: active ? 600 : 400,
              color: active ? "var(--mantine-color-text)" : "var(--nivra-text-2)",
              whiteSpace: "nowrap",
            }}
            data-testid={`settings-tab-${tab.section}`}
          >
            {tab.label}
          </UnstyledButton>
        );
      })}
    </Box>
  );
  return narrow ? (
    <ScrollArea type="auto" scrollbars="x" offsetScrollbars data-testid="settings-tabs-scroll">
      {links}
    </ScrollArea>
  ) : (
    links
  );
}
