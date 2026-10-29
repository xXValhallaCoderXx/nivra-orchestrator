import { Button, Group, Text } from "@mantine/core";
import type { ConversationSummary, ProjectView } from "../../../shared/ipc";
import { Section } from "../shared/ui";
import { useCreateConversation } from "../shell/Sidebar";

/**
 * Conversations and plans with no conversation open (D26): what the two kinds of conversation reach, and a way to start
 * one. The conversations themselves are listed in the sidebar, under this place, while it is in view.
 */
export function PlanningHome({ projects, onCreated }: { projects: ProjectView[]; onCreated(summary: ConversationSummary): void }) {
  const { create, error } = useCreateConversation(onCreated);
  return (
    <Section
      title="Conversations and plans"
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
          To chat about a repository, add it with the switcher first.
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
