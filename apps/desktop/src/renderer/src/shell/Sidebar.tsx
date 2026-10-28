import { AppShell, Box, Menu, ScrollArea, Text, UnstyledButton } from "@mantine/core";
import { useState, type ReactNode } from "react";
import type { ConversationScope, ConversationsView, ConversationSummary, ProjectView } from "../../../shared/ipc";
import type { Navigate, Route, Scope } from "../app/routes";
import { errorMessage } from "../shared/ui";
import { placeOfDraft, sectionOf, type Section } from "./places";

/** Inline stroke icons, 16 px (KIT rule 9), decorative: each link says what it is in words. */
const ICON_PATHS: Record<Section | "draft", ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </>
  ),
  tasks: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5" />
    </>
  ),
  conversations: <path d="M4 5h16v11H8l-4 4z" />,
  environment: (
    <>
      <path d="M12 3 3 7.5v9L12 21l9-4.5v-9z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    </>
  ),
  missions: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  draft: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
};

export function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
      {ICON_PATHS[name]}
    </svg>
  );
}

export function Logo() {
  return (
    <Box style={{ display: "flex", alignItems: "center", gap: 8, height: 40, padding: "0 6px" }}>
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
        <path d="M8 16V8l8 8V8" stroke="var(--mantine-color-body)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <Text component="span" fz={17} fw={600} style={{ letterSpacing: "-0.01em" }}>
        Nivra
      </Text>
    </Box>
  );
}

function NavItem({ section, label, active, onClick, testId, right }: { section: Section; label: string; active: boolean; onClick(): void; testId: string; right?: ReactNode }) {
  return (
    <UnstyledButton className="nivra-nav" aria-current={active ? "page" : undefined} onClick={onClick} data-testid={testId}>
      <Icon name={section} />
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>{label}</span>
      {right}
    </UnstyledButton>
  );
}

/** Starts a conversation, general or about one project; its scope never changes afterwards. Starts no engine. */
export function useCreateConversation(onCreated: (summary: ConversationSummary) => void) {
  const [error, setError] = useState<string | null>(null);
  const create = async (scope: ConversationScope) => {
    setError(null);
    try {
      onCreated(await window.nivra.createConversation(scope));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  return { create, error };
}

const scopeOf = (conversation: ConversationSummary) =>
  conversation.kind === "general" ? "General" : `${conversation.projectLabel ?? "A project"}${conversation.projectPresent === false ? " · removed" : ""}`;

/**
 * Conversations and plans, while that place is in view: a new chat, general or about one project, and the
 * conversations, the most recent first. Each keeps the scope it started with, whatever the switcher shows.
 */
function ConversationsNav({ route, onNavigate, conversations, projects, onCreated }: { route: Route; onNavigate: Navigate; conversations: ConversationsView | null; projects: ProjectView[]; onCreated(summary: ConversationSummary): void }) {
  const { create, error } = useCreateConversation(onCreated);
  const workspace = conversations?.workspace ?? null;
  const list = conversations?.conversations ?? [];
  return (
    <Box pl={26} pr={2} pb={6}>
      <Menu position="bottom-start" width={260}>
        <Menu.Target>
          <UnstyledButton className="nivra-subnav nivra-subnav-action" data-testid="new-chat">
            New chat
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => void create({ kind: "general" })} data-testid="new-chat-general">
            <Text component="span" size="sm" display="block">
              General
            </Text>
            <Text component="span" size="xs" c="var(--nivra-text-3)" display="block">
              No repository access
            </Text>
          </Menu.Item>
          <Menu.Divider />
          <Menu.Label>About a project</Menu.Label>
          {projects.length ? (
            projects.map((project) => (
              <Menu.Item key={project.id} onClick={() => void create({ kind: "project", projectId: project.id })} data-testid="new-chat-project" data-project-id={project.id}>
                <Text component="span" size="sm" display="block">
                  {project.label}
                </Text>
                <Text component="span" size="xs" c="var(--nivra-text-3)" display="block">
                  {project.targetLabel}
                </Text>
              </Menu.Item>
            ))
          ) : (
            <Menu.Item disabled>Add a project with the switcher first</Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      {error && (
        <Text size="xs" c="var(--nivra-error)" px={4} data-testid="new-chat-error">
          {error}
        </Text>
      )}
      {workspace?.state === "unavailable" ? (
        <Text size="xs" c="var(--nivra-error)" px={4} data-testid="nav-workspace-unavailable">
          {workspace.reason}
        </Text>
      ) : list.length ? (
        list.map((conversation) => {
          const active = route.kind === "conversation" && route.id === conversation.id;
          return (
            <UnstyledButton
              key={conversation.id}
              className="nivra-subnav"
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate({ kind: "conversation", id: conversation.id })}
              data-testid="nav-conversation"
              data-conversation-id={conversation.id}
            >
              <span className="nivra-subnav-title">{conversation.title}</span>
              <span className="nivra-subnav-detail">{scopeOf(conversation)}</span>
            </UnstyledButton>
          );
        })
      ) : (
        <Text size="xs" c="var(--nivra-text-3)" px={8} py={4}>
          No conversations yet.
        </Text>
      )}
    </Box>
  );
}

export interface SidebarDrafts {
  available: boolean;
  list: ReadonlyArray<{ key: string; label: string; savedAt: string }>;
}

/**
 * The sidebar (SH1): the logo and the switcher at wide widths, the scope's places, the places everywhere, the unsaved
 * drafts, and Settings at the bottom. Queue, Agents and Activity come in a later build.
 */
export function Sidebar({
  route,
  scope,
  switcher,
  showLogo,
  openTasks,
  conversations,
  projects,
  drafts,
  onNavigate,
  onOpenSettings,
  onOpenDraft,
  onConversationCreated,
}: {
  route: Route;
  scope: Scope;
  /** The switcher, at wide widths; in a narrow window it sits in the top bar instead. */
  switcher: ReactNode;
  showLogo: boolean;
  /** The scope's tasks that aren't completed; null until they are read. */
  openTasks: number | null;
  conversations: ConversationsView | null;
  projects: ProjectView[];
  drafts: SidebarDrafts;
  onNavigate: Navigate;
  /** Settings, on the section last shown there. */
  onOpenSettings(): void;
  onOpenDraft(key: string): void;
  onConversationCreated(summary: ConversationSummary): void;
}) {
  const section = sectionOf(route);
  return (
    <AppShell.Navbar aria-label="Main" data-testid="nav" p={12} style={{ background: "var(--nivra-subtle)" }}>
      <AppShell.Section>
        {showLogo && <Logo />}
        {switcher && <Box my={8}>{switcher}</Box>}
      </AppShell.Section>
      <AppShell.Section grow component={ScrollArea} type="scroll" mx={-4} px={4}>
        <Box style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <NavItem section="home" label="Home" active={section === "home"} onClick={() => onNavigate({ kind: "home" })} testId="nav-home" />
          <NavItem
            section="tasks"
            label="Tasks"
            active={section === "tasks"}
            onClick={() => onNavigate({ kind: "tasks" })}
            testId="nav-tasks"
            right={
              openTasks !== null && openTasks > 0 ? (
                <span className="nivra-nav-count" data-testid="nav-tasks-count">
                  {openTasks}
                  <span className="nivra-sr"> open {openTasks === 1 ? "task" : "tasks"}</span>
                </span>
              ) : null
            }
          />
          <NavItem section="conversations" label="Conversations and plans" active={section === "conversations"} onClick={() => onNavigate({ kind: "conversations" })} testId="nav-planning" />
          {section === "conversations" && <ConversationsNav route={route} onNavigate={onNavigate} conversations={conversations} projects={projects} onCreated={onConversationCreated} />}
          {scope.kind === "project" && <NavItem section="environment" label="Environment" active={section === "environment"} onClick={() => onNavigate({ kind: "environment" })} testId="nav-environment" />}
          <Text className="nivra-nav-label">Everywhere</Text>
          <NavItem section="missions" label="Missions" active={section === "missions"} onClick={() => onNavigate({ kind: "missions" })} testId="nav-missions" />
          {!drafts.available ? (
            <>
              <Text className="nivra-nav-label">Unsaved drafts</Text>
              <Text size="xs" c="var(--nivra-text-3)" px={10} data-testid="drafts-unavailable">
                Drafts can't be kept on this computer right now.
              </Text>
            </>
          ) : (
            drafts.list.length > 0 && (
              <>
                <Text className="nivra-nav-label">Unsaved drafts</Text>
                {drafts.list.map((draft) => {
                  const place = placeOfDraft(draft.key);
                  return (
                    <UnstyledButton key={draft.key} className="nivra-nav" onClick={() => onOpenDraft(draft.key)} disabled={!place} data-testid="nav-draft" data-draft-key={draft.key}>
                      <Icon name="draft" />
                      <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={draft.label}>
                        {draft.label || "Untitled"}
                      </span>
                      {place && <span className="nivra-nav-detail">{place.kind}</span>}
                    </UnstyledButton>
                  );
                })}
              </>
            )
          )}
        </Box>
      </AppShell.Section>
      <AppShell.Section pt={8}>
        <NavItem section="settings" label="Settings" active={section === "settings"} onClick={onOpenSettings} testId="nav-settings" />
      </AppShell.Section>
    </AppShell.Navbar>
  );
}
