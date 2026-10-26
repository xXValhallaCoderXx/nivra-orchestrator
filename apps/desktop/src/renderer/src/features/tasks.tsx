import { Alert, Anchor, Badge, Button, Group, List, Modal, Select, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useState, type ChangeEvent, type ReactNode } from "react";
import type { BriefContent, BriefFields, PlanView, ProjectView, TaskState, TaskSummary, TasksView, TaskView } from "../../../shared/ipc";
import { errorMessage, Section, usePoll } from "../shared/ui";
import { caseDraftOf, caseOf, CasesInput, CasesRead, TaskRun, type CaseDraft } from "./task-run";

/**
 * Native tasks (D26, NIV-32): a brief written directly or made from a plan, the same form either way. Every change to a
 * brief is a new version, made from the task as it was read; a task that changed meanwhile is read again. A ready task
 * with acceptance cases runs in a sandbox (D39), and the window says in plain words what keeps one from running.
 */

const STATE_LOOK: Record<TaskState, { label: string; color: string }> = {
  draft: { label: "Draft", color: "gray" },
  ready: { label: "Ready", color: "blue" },
  active: { label: "Active", color: "yellow" },
  review: { label: "In review", color: "yellow" },
  completed: { label: "Completed", color: "green" },
};

/** The repository choice that means none yet. */
const NONE = "none";

const repositoryOf = (task: TaskSummary) =>
  task.projectId === null ? "No repository yet" : `${task.projectLabel ?? "A project"}${task.projectPresent === false ? " (removed from the list)" : ""}`;

const repositoryChoices = (projects: ProjectView[]) => [{ value: NONE, label: "No repository yet" }, ...projects.map((p) => ({ value: p.id, label: `${p.label} · ${p.targetLabel}` }))];

/** A brief's fields as the form holds them: lists are one entry per line. */
interface Draft {
  goal: string;
  criteria: string;
  scope: string;
  exclusions: string;
  context: string;
  assumptions: string;
  checks: string;
  cases: CaseDraft[];
}

const EMPTY: Draft = { goal: "", criteria: "", scope: "", exclusions: "", context: "", assumptions: "", checks: "", cases: [] };

const draftOf = (content: BriefFields): Draft => ({
  goal: content.goal,
  criteria: content.acceptanceCriteria.join("\n"),
  scope: content.scope,
  exclusions: content.exclusions,
  context: content.context,
  assumptions: content.assumptions.join("\n"),
  checks: content.checks.join("\n"),
  cases: content.acceptanceCases.map(caseDraftOf),
});

// Empty lines are dropped by main, which numbers an entry as it was written.
const fieldsOf = (draft: Draft): BriefFields => ({
  goal: draft.goal,
  acceptanceCriteria: draft.criteria.split("\n"),
  scope: draft.scope,
  exclusions: draft.exclusions,
  context: draft.context,
  assumptions: draft.assumptions.split("\n"),
  checks: draft.checks.split("\n"),
  acceptanceCases: draft.cases.map(caseOf),
});

function BriefInputs({ draft, onChange }: { draft: Draft; onChange(next: Draft): void }) {
  const bind = (key: Exclude<keyof Draft, "cases">) => ({ value: draft[key], onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange({ ...draft, [key]: event.currentTarget.value }) });
  return (
    <Stack gap="sm">
      <Textarea label="Goal" description="What the task is for." autosize minRows={2} maxRows={8} {...bind("goal")} data-testid="brief-goal" />
      <Textarea label="Acceptance criteria" description="How you'll know it's done. One per line." autosize minRows={2} maxRows={10} {...bind("criteria")} data-testid="brief-criteria" />
      <Textarea label="Scope" description="What it covers." autosize minRows={1} maxRows={8} {...bind("scope")} data-testid="brief-scope" />
      <Textarea label="Exclusions" description="What it leaves alone." autosize minRows={1} maxRows={8} {...bind("exclusions")} data-testid="brief-exclusions" />
      <Textarea label="Context" description="Background the work needs, such as a plan." autosize minRows={3} maxRows={14} {...bind("context")} data-testid="brief-context" />
      <Textarea label="Assumptions" description="What it takes as true without checking. One per line." autosize minRows={1} maxRows={8} {...bind("assumptions")} data-testid="brief-assumptions" />
      <Textarea
        label="Checks"
        description="The repository's own commands to run, such as sh test.sh. One per line. A run reports them; they don't decide its result."
        autosize
        minRows={1}
        maxRows={8}
        {...bind("checks")}
        data-testid="brief-checks"
      />
      <CasesInput cases={draft.cases} onChange={(cases) => onChange({ ...draft, cases })} />
    </Stack>
  );
}

function Field({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <Stack gap={2} data-testid={testId}>
      <Text size="xs" fw={600} c="var(--nivra-text-3)">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

const textOr = (text: string) =>
  text ? (
    <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {text}
    </Text>
  ) : (
    <Text size="sm" c="var(--nivra-text-3)">
      None yet
    </Text>
  );

const listOr = (items: string[]) =>
  items.length ? (
    <List size="sm">
      {items.map((item, index) => (
        <List.Item key={index}>{item}</List.Item>
      ))}
    </List>
  ) : (
    <Text size="sm" c="var(--nivra-text-3)">
      None yet
    </Text>
  );

function BriefRead({ content }: { content: BriefContent }) {
  return (
    <Stack gap="sm" data-testid="task-brief">
      <Field label="Goal" testId="task-brief-goal">
        {textOr(content.goal)}
      </Field>
      <Field label="Acceptance criteria" testId="task-brief-criteria">
        {listOr(content.acceptanceCriteria)}
      </Field>
      <Field label="Scope" testId="task-brief-scope">
        {textOr(content.scope)}
      </Field>
      <Field label="Exclusions" testId="task-brief-exclusions">
        {textOr(content.exclusions)}
      </Field>
      <Field label="Context" testId="task-brief-context">
        {textOr(content.context)}
      </Field>
      <Field label="Assumptions" testId="task-brief-assumptions">
        {listOr(content.assumptions)}
      </Field>
      <Field label="Checks" testId="task-brief-checks">
        {listOr(content.checks)}
      </Field>
      <Field label="Acceptance cases" testId="task-brief-cases">
        <CasesRead cases={content.acceptanceCases} />
      </Field>
      <Text size="xs" c="var(--nivra-text-3)">
        A run of this task goes alone, in a sandbox with networking off, and nothing it changes reaches your checkout unless you approve it.
      </Text>
    </Stack>
  );
}

/** Every task, the most recently changed first. */
export function TasksPage({ onOpen, onNew }: { onOpen(taskId: string): void; onNew(): void }) {
  const tasks = usePoll<TasksView>(() => window.nivra.listTasks(), () => 5_000, []);
  const view = tasks.value;
  return (
    <Section
      title="Tasks"
      description="Work you want done, each with a brief: what it's for, how you'll know it's done, and what's in and out of scope. Every change to a brief is a new version; earlier ones stay as they were."
      actions={
        <Button size="xs" onClick={onNew} disabled={view?.workspace.state !== "ready"} data-testid="tasks-new">
          New task
        </Button>
      }
    >
      {tasks.error && (
        <Text size="sm" c="var(--nivra-error)">
          {tasks.error}
        </Text>
      )}
      {view?.workspace.state === "unavailable" && (
        <Alert color="red" variant="light" data-testid="tasks-unavailable">
          <Text size="sm">{view.workspace.reason}</Text>
        </Alert>
      )}
      {view?.workspace.state === "ready" && view.tasks.length === 0 && (
        <Text size="sm" c="var(--nivra-text-3)" data-testid="tasks-empty">
          No tasks yet. Write one here, or make one from a plan saved in a conversation.
        </Text>
      )}
      {view && view.tasks.length > 0 && (
        <Table data-testid="tasks-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Task</Table.Th>
              <Table.Th>State</Table.Th>
              <Table.Th>Repository</Table.Th>
              <Table.Th>Brief</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {view.tasks.map((task) => (
              <Table.Tr key={task.id} data-testid="task-row" data-task-id={task.id}>
                <Table.Td>
                  <Anchor component="button" size="sm" onClick={() => onOpen(task.id)} data-testid="task-open">
                    {task.title}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  <Badge color={STATE_LOOK[task.state].color} variant="light">
                    {STATE_LOOK[task.state].label}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{repositoryOf(task)}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">v{task.briefVersion}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Section>
  );
}

/**
 * A new task, written directly or made from a plan version: the same form, so the brief has the same shape. From a plan,
 * it starts with the plan's text as the context, its assumptions, and the plan's own repository. Choosing another
 * repository, or none, says first that the plan's material will be cleared: it belongs to the other project.
 */
export function NewTask({
  projects,
  plan,
  initialTitle,
  onCreated,
  onCancel,
}: {
  projects: ProjectView[];
  plan: PlanView | null;
  initialTitle: string;
  onCreated(task: TaskView): void;
  onCancel(): void;
}) {
  const planProject = plan?.projectId ? (projects.find((p) => p.id === plan.projectId) ?? null) : null;
  const [title, setTitle] = useState(initialTitle);
  const [repository, setRepository] = useState<string>(planProject?.id ?? NONE);
  const [draft, setDraft] = useState<Draft>(plan ? { ...EMPTY, context: plan.text, assumptions: plan.assumptions.join("\n") } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = repository === NONE ? null : repository;
  const leavesPlan = plan !== null && plan.projectId !== null && chosen !== plan.projectId;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await window.nivra.createTask({ title, fields: fieldsOf(draft), projectId: chosen, planId: plan?.id ?? null }));
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Section
      title="New task"
      description={
        plan
          ? `From plan v${plan.version}. The brief starts with the plan's text as its context, and with its assumptions. The plan stays as it is.`
          : "Write the brief directly. A task made from a plan has the same brief."
      }
    >
      <TextInput label="Title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} data-testid="task-form-title" />
      <Select
        label="Repository"
        description="Where the task's work will run. You can choose it later."
        data={repositoryChoices(projects)}
        value={repository}
        onChange={(value) => setRepository(value ?? NONE)}
        allowDeselect={false}
        data-testid="task-form-repository"
      />
      {leavesPlan && (
        <Alert color="yellow" variant="light" data-testid="task-form-leaves-plan">
          <Text size="sm">
            This plan came from a conversation about {planProject?.label ?? "a project that's no longer in the list"}. Saved {chosen ? "for another repository" : "with no repository yet"},
            the task keeps none of it: the context and assumptions are cleared, to be written again for the task, and the plan isn't linked.
          </Text>
        </Alert>
      )}
      <BriefInputs draft={draft} onChange={setDraft} />
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="task-form-error">
          {error}
        </Text>
      )}
      <Group justify="flex-end" gap="sm">
        <Button variant="default" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void create()} loading={busy} data-testid="task-form-create">
          Create task
        </Button>
      </Group>
    </Section>
  );
}

/**
 * One task: its brief and versions, the plan it came from, and what can be done with it now. Every change sends the
 * revision the task was read at; one that changed meanwhile is refused, and the view reads it again.
 */
export function TaskDetail({
  taskId,
  projects,
  onDeleted,
  onOpenConversation,
}: {
  taskId: string;
  projects: ProjectView[];
  onDeleted(): void;
  onOpenConversation(conversationId: string): void;
}) {
  const [readCount, setReadCount] = useState(0);
  const task = usePoll<TaskView>(() => window.nivra.getTask(taskId), () => null, [taskId, readCount]);
  const [editing, setEditing] = useState<"brief" | "title" | "repository" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [title, setTitle] = useState("");
  const [repository, setRepository] = useState<string>(NONE);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = task.value;
  if (!view) {
    return task.error ? (
      <Alert color="red" title="This task can't be shown" data-testid="task-unavailable">
        <Text size="sm">{task.error}</Text>
      </Alert>
    ) : (
      <Text size="sm" c="var(--nivra-text-3)">
        Opening the task…
      </Text>
    );
  }

  const { summary, brief, revision } = view;
  const completed = summary.state === "completed";
  const reread = () => setReadCount((n) => n + 1);

  async function act(change: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await change();
      setEditing(null);
      reread();
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      // Changed meanwhile: what is shown is read again, and the change can be made from it.
      if (message.includes("changed since you opened it")) {
        setEditing(null);
        reread();
      }
    } finally {
      setBusy(false);
    }
  }

  const chosen = repository === NONE ? null : repository;
  const clearsOnMove = brief.content.sources.some((source) => source.projectId !== null && source.projectId !== chosen);
  const rewrite = brief.content.revalidate.map((part) => (part === "context" ? "the context" : "the assumptions"));

  return (
    <Stack gap="md" data-testid="task" data-task-id={taskId} data-revision={revision}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ minWidth: 0 }}>
          {editing === "title" ? (
            <Group gap="xs" wrap="nowrap">
              <TextInput value={title} onChange={(event) => setTitle(event.currentTarget.value)} aria-label="Title" style={{ flex: 1 }} data-testid="task-title-input" />
              <Button size="xs" onClick={() => void act(() => window.nivra.renameTask(taskId, revision, title))} loading={busy} data-testid="task-title-save">
                Save
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
            </Group>
          ) : (
            <Title order={2} style={{ overflowWrap: "anywhere" }} data-testid="task-title">
              {summary.title}
            </Title>
          )}
          <Group gap="xs">
            <Badge color={STATE_LOOK[summary.state].color} variant="light" data-testid="task-state">
              {STATE_LOOK[summary.state].label}
            </Badge>
            <Text size="sm" c="var(--nivra-text-2)" data-testid="task-repository">
              {repositoryOf(summary)}
            </Text>
            <Text size="sm" c="var(--nivra-text-3)" data-testid="task-brief-version">
              · brief v{brief.version}
            </Text>
          </Group>
        </Stack>
        <Group gap={4} wrap="nowrap">
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              setTitle(summary.title);
              setEditing("title");
            }}
            data-testid="task-rename"
          >
            Rename
          </Button>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              setRepository(summary.projectId ?? NONE);
              setEditing("repository");
            }}
            data-testid="task-move"
          >
            Change repository
          </Button>
          <Button size="xs" variant="subtle" color="red" onClick={() => setConfirmDelete(true)} data-testid="task-delete">
            Delete
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" data-testid="task-error">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      {editing === "repository" && (
        <Section title="Change repository">
          <Select data={repositoryChoices(projects)} value={repository} onChange={(value) => setRepository(value ?? NONE)} allowDeselect={false} aria-label="Repository" data-testid="task-move-repository" />
          {clearsOnMove && (
            <Text size="sm" c="var(--nivra-warning)" data-testid="task-move-clears">
              What this brief took from another project's conversation is cleared in a new version, to be written again for this repository.
            </Text>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void act(() => window.nivra.setTaskProject(taskId, revision, chosen))} loading={busy} data-testid="task-move-save">
              Save
            </Button>
          </Group>
        </Section>
      )}

      {view.sourcePlans.map((source) =>
        source.latestVersion === null ? (
          <Alert key={source.planLineage} color="gray" variant="light" data-testid="task-plan-gone">
            <Text size="sm">The plan this brief came from was deleted with its conversation. The brief keeps its copy.</Text>
          </Alert>
        ) : source.latestVersion > source.usedVersion ? (
          <Alert key={source.planLineage} color="yellow" variant="light" data-testid="task-plan-changed">
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm">
                Its source plan changed: this brief uses v{source.usedVersion}, and v{source.latestVersion} is the latest.
              </Text>
              <Button
                size="xs"
                variant="default"
                onClick={() => void act(() => window.nivra.refreshBriefFromPlan(taskId, revision, source.latestPlanId!))}
                disabled={completed || busy}
                data-testid="task-update-from-plan"
              >
                Update from plan v{source.latestVersion}
              </Button>
            </Group>
          </Alert>
        ) : (
          <Text key={source.planLineage} size="xs" c="var(--nivra-text-3)" data-testid="task-plan-source">
            From plan v{source.usedVersion}
            {source.conversationId && (
              <>
                {" · "}
                <Anchor component="button" size="xs" onClick={() => onOpenConversation(source.conversationId!)} data-testid="task-open-conversation">
                  open its conversation
                </Anchor>
              </>
            )}
          </Text>
        ),
      )}

      {rewrite.length > 0 && (
        <Alert color="yellow" variant="light" data-testid="task-revalidate">
          <Text size="sm">To write again for this repository: {rewrite.join(" and ")}. What was there came from another project's conversation, so it was cleared.</Text>
        </Alert>
      )}

      <Section
        title={`Brief v${brief.version}`}
        actions={
          editing !== "brief" && (
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setDraft(draftOf(brief.content));
                setEditing("brief");
              }}
              disabled={completed}
              data-testid="task-edit-brief"
            >
              Edit brief
            </Button>
          )
        }
      >
        {editing === "brief" ? (
          <Stack gap="sm">
            <BriefInputs draft={draft} onChange={setDraft} />
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void act(() => window.nivra.reviseBrief(taskId, revision, fieldsOf(draft)))} loading={busy} data-testid="task-brief-save">
                Save as v{brief.version + 1}
              </Button>
            </Group>
          </Stack>
        ) : (
          <BriefRead content={brief.content} />
        )}
        {completed && (
          <Text size="xs" c="var(--nivra-text-3)">
            A completed task's brief can't change. Reopen it to change it.
          </Text>
        )}
        <Text size="xs" c="var(--nivra-text-3)" data-testid="task-versions">
          Versions: {view.versions.map((version) => `v${version.version} (${new Date(version.createdAt).toLocaleString()})`).join(", ")}
        </Text>
      </Section>

      <Section title="Progress">
        <Group gap="sm">
          {summary.state === "draft" && (
            <Button size="xs" onClick={() => void act(() => window.nivra.setTaskState(taskId, revision, "ready"))} loading={busy} data-testid="task-mark-ready">
              Mark ready
            </Button>
          )}
          {summary.state === "ready" && (
            <>
              <Button size="xs" onClick={() => void act(() => window.nivra.setTaskState(taskId, revision, "completed"))} loading={busy} data-testid="task-complete">
                Complete
              </Button>
              <Button size="xs" variant="default" onClick={() => void act(() => window.nivra.setTaskState(taskId, revision, "draft"))} disabled={busy} data-testid="task-back-to-draft">
                Back to draft
              </Button>
            </>
          )}
          {completed && (
            <Button size="xs" variant="default" onClick={() => void act(() => window.nivra.setTaskState(taskId, revision, "draft"))} loading={busy} data-testid="task-reopen">
              Reopen
            </Button>
          )}
        </Group>
      </Section>

      <Section title="Runs">
        <TaskRun view={view} onChanged={reread} />
      </Section>

      <Modal opened={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this task?" data-testid="task-delete-dialog">
        <Stack gap="sm">
          <Text size="sm">The task and every version of its brief are deleted. The plans and conversations it came from stay.</Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              onClick={() => {
                setConfirmDelete(false);
                void act(async () => {
                  await window.nivra.deleteTask(taskId);
                  onDeleted();
                });
              }}
              data-testid="task-delete-confirm"
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
