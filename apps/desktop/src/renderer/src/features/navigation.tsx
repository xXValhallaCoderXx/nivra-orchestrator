import { AppShell, Button, Group, Menu, NavLink, ScrollArea, Text } from "@mantine/core";
import { useState } from "react";
import type { ConversationScope, ConversationsView, ConversationSummary, PlanView, ProjectView } from "../../../shared/ipc";
import { errorMessage, Section } from "../shared/ui";

/** The window's places (D26), kept as state: there is no router. */
export type View =
  | { kind: "projects" }
  | { kind: "planning" }
  | { kind: "conversation"; id: string }
  | { kind: "tasks" }
  | { kind: "task"; id: string }
  | { kind: "new-task"; plan: PlanView | null; title: string };

/** Starts a conversation, general or about one project; its scope never changes afterwards. Starts no engine. */
function useCreate(onCreated: (summary: ConversationSummary) => void) {
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
 * The side navigation: Review & planning, with a new chat and the conversations (the most recent first), Tasks, and
 * Projects & settings. A project chosen on that page changes no conversation: each keeps the scope it started with.
 */
export function Navigation({
  view,
  onNavigate,
  conversations,
  projects,
  onCreated,
}: {
  view: View;
  onNavigate(view: View): void;
  conversations: ConversationsView | null;
  projects: ProjectView[];
  onCreated(summary: ConversationSummary): void;
}) {
  const { create, error } = useCreate(onCreated);
  const workspace = conversations?.workspace ?? null;
  const list = conversations?.conversations ?? [];
  return (
    <AppShell.Navbar p="sm" data-testid="nav">
      <AppShell.Section>
        <NavLink component="button" label="Review & planning" active={view.kind === "planning"} onClick={() => onNavigate({ kind: "planning" })} data-testid="nav-planning" />
        <Menu position="bottom-start" width={260}>
          <Menu.Target>
            <Button fullWidth variant="default" size="xs" my={6} data-testid="new-chat">
              New chat
            </Button>
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
              <Menu.Item disabled>Add a repository in Projects & settings first</Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
        {error && (
          <Text size="xs" c="var(--nivra-error)" px={4} data-testid="new-chat-error">
            {error}
          </Text>
        )}
      </AppShell.Section>
      <AppShell.Section grow component={ScrollArea} my={4}>
        {workspace?.state === "unavailable" ? (
          <Text size="xs" c="var(--nivra-error)" px={4} data-testid="nav-workspace-unavailable">
            {workspace.reason}
          </Text>
        ) : list.length ? (
          list.map((conversation) => (
            <NavLink
              key={conversation.id}
              component="button"
              label={conversation.title}
              description={scopeOf(conversation)}
              noWrap
              active={view.kind === "conversation" && view.id === conversation.id}
              onClick={() => onNavigate({ kind: "conversation", id: conversation.id })}
              data-testid="nav-conversation"
              data-conversation-id={conversation.id}
            />
          ))
        ) : (
          <Text size="xs" c="var(--nivra-text-3)" px={4}>
            No conversations yet.
          </Text>
        )}
      </AppShell.Section>
      <AppShell.Section>
        <NavLink
          component="button"
          label="Tasks"
          active={view.kind === "tasks" || view.kind === "task" || view.kind === "new-task"}
          onClick={() => onNavigate({ kind: "tasks" })}
          data-testid="nav-tasks"
        />
        <NavLink component="button" label="Projects & settings" active={view.kind === "projects"} onClick={() => onNavigate({ kind: "projects" })} data-testid="nav-projects" />
      </AppShell.Section>
    </AppShell.Navbar>
  );
}

/** Review & planning with no conversation open: what the two kinds of conversation reach, and a way to start one. */
export function PlanningHome({ projects, onCreated }: { projects: ProjectView[]; onCreated(summary: ConversationSummary): void }) {
  const { create, error } = useCreate(onCreated);
  return (
    <Section
      title="Review & planning"
      description="Talk a plan through before it becomes a task. A general conversation reaches no repository, and gets your personal preferences only. A conversation about a project reads that project's tracked files, once you allow its content to be sent to Token Factory. Neither changes any file."
    >
      <Group gap="sm">
        <Button variant="default" onClick={() => void create({ kind: "general" })} data-testid="planning-new-general">
          New general chat
        </Button>
        {projects.map((project) => (
          <Button key={project.id} variant="default" onClick={() => void create({ kind: "project", projectId: project.id })} data-testid="planning-new-project" data-project-id={project.id}>
            Chat about {project.label}
          </Button>
        ))}
      </Group>
      {!projects.length && (
        <Text size="xs" c="var(--nivra-text-3)">
          To chat about a repository, add it in Projects & settings first.
        </Text>
      )}
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="planning-error">
          {error}
        </Text>
      )}
    </Section>
  );
}
