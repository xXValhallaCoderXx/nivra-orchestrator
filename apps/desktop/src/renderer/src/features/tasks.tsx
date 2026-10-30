import { Alert, Anchor, Badge, Button, Code, Collapse, Grid, Group, List, Menu, Modal, Paper, Select, SimpleGrid, Stack, Table, Tabs, Text, Textarea, TextInput, Title, UnstyledButton } from "@mantine/core";
import type { CoachQuestionField } from "@nivra/domain";
import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from "react";
import type { CoachingView } from "../../../shared/coach";
import type { BriefContent, BriefFields, EngineView, EnvironmentView, PlanView, ProjectView, SettingsView, TaskState, TaskSummary, TasksView, TaskView } from "../../../shared/ipc";
import { initialRepositoryOf } from "../../../shared/task-form";
import { environmentRowOf, readinessOf, type ReadinessAction } from "../../../shared/task-readiness";
import { environmentStepOf, latestHolds, stripItemsOf, type StripItem } from "../../../shared/task-strip";
import { decisionLead, outcomeLookOf } from "../../../shared/task-verdict";
import { errorMessage, Section, usePoll } from "../shared/ui";
import { DraftNotice, useDraft } from "../shell/drafts";
import { EngineNotices } from "./engine";
import { KeyPrompt } from "./key-prompt";
import { useNarrow } from "./narrow";
import { ApplyCard, applyMarks, AttemptsList, CompletedCards, DecisionCard, RunSummary, SettleCard } from "./task-apply";
import { CoachAside, CoachMain, isOpenCoaching } from "./task-coach";
import { CheckGroup, CheckLine, ReadinessCard } from "./task-readiness";
import { BaselineInput, BaselineRead, baselineDraftOf, baselineOf, caseDraftOf, caseOf, CasesInput, CasesRead, RunGoing, RunLauncher, RunReview, useRun, type BaselineDraft, type CaseDraft } from "./task-run";

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

/** Where the brief editor takes the person when a coach's question names a field (NIV-53): the field's own input. */
const FIELD_INPUT: Readonly<Record<CoachQuestionField, string>> = {
  goal: "brief-goal",
  acceptanceCriteria: "brief-criteria",
  scope: "brief-scope",
  exclusions: "brief-exclusions",
  context: "brief-context",
  assumptions: "brief-assumptions",
  checks: "brief-checks",
  acceptanceCases: "brief-case-add",
};

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
  baseline: BaselineDraft[];
  frozen: string;
}

const EMPTY: Draft = { goal: "", criteria: "", scope: "", exclusions: "", context: "", assumptions: "", checks: "", cases: [], baseline: [], frozen: "" };

const draftOf = (content: BriefFields): Draft => ({
  goal: content.goal,
  criteria: content.acceptanceCriteria.join("\n"),
  scope: content.scope,
  exclusions: content.exclusions,
  context: content.context,
  assumptions: content.assumptions.join("\n"),
  checks: content.checks.join("\n"),
  cases: content.acceptanceCases.map(caseDraftOf),
  baseline: (content.baseline ?? []).map(baselineDraftOf),
  frozen: (content.frozen ?? []).join("\n"),
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
  baseline: draft.baseline.map(baselineOf),
  frozen: draft.frozen.split("\n"),
});

/** A card of the brief's form (NIV-56, G3: P1b): its title, a short note beside it, and what it's for. */
function FormCard({ title, note, description, children }: { title: string; note?: string; description?: string; children: ReactNode }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Stack gap={2}>
          <Group gap="xs" align="baseline">
            <Text fw={600}>{title}</Text>
            {note && (
              <Text size="xs" c="var(--nivra-text-3)">
                {note}
              </Text>
            )}
          </Group>
          {description && (
            <Text size="sm" c="var(--nivra-text-2)">
              {description}
            </Text>
          )}
        </Stack>
        {children}
      </Stack>
    </Paper>
  );
}

/** How many entries a one-per-line field holds: empty lines don't count, as main drops them. */
const entries = (text: string) => text.split("\n").filter((line) => line.trim() !== "").length;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A small chevron for a section that opens and closes. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms ease" }}>
      <path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The brief's form (NIV-56, G3: P1b), in cards: what it's for; the acceptance cases with the frozen files; the baseline
 * checks; the repository's own checks; and where it starts and stops. Context and assumptions are under "More, all
 * optional", open when either holds text, and opened when a coach's question names one of them (`reveal`).
 */
function BriefInputs({ draft, onChange, reveal = null }: { draft: Draft; onChange(next: Draft): void; reveal?: CoachQuestionField | null }) {
  const bind = (key: Exclude<keyof Draft, "cases" | "baseline">) => ({ value: draft[key], onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange({ ...draft, [key]: event.currentTarget.value }) });
  const [more, setMore] = useState(() => draft.context.trim() !== "" || draft.assumptions.trim() !== "");
  // A draft restored after the form opened, holding context or assumptions, shows them too.
  const holdsMore = draft.context.trim() !== "" || draft.assumptions.trim() !== "";
  useEffect(() => {
    if (holdsMore) setMore(true);
  }, [holdsMore]);
  const revealing = reveal === "context" || reveal === "assumptions";
  useEffect(() => {
    if (revealing) setMore(true);
  }, [revealing]);
  const open = more || revealing;
  const moreId = useId();
  return (
    <Stack gap="md">
      <FormCard title="What it's for" description="Acceptance criteria say what must be true when it's done, in words for people. Nivra doesn't run them: it runs the acceptance cases below.">
        <Textarea label="Goal" description="What the task is for." autosize minRows={2} maxRows={8} {...bind("goal")} data-testid="brief-goal" />
        <Textarea label="Acceptance criteria" description="How you'll know it's done: what must be true. One per line." autosize minRows={2} maxRows={10} {...bind("criteria")} data-testid="brief-criteria" />
      </FormCard>
      <FormCard
        title="Acceptance cases"
        note="Commands that must pass"
        description="How Nivra checks a run itself: a command, run in the sandbox, and exactly what it must print and the exit code it must give. Every case and required repository check must pass, with the frozen and setup files unchanged. A run needs at least one case."
      >
        <CasesInput cases={draft.cases} onChange={(cases) => onChange({ ...draft, cases })} />
        <Text size="xs" c="var(--nivra-text-3)" data-testid="brief-cases-count">
          A run takes one to four acceptance cases and checks in all. This brief has {count(draft.cases.length, "case")} and {count(entries(draft.checks), "check")}.
        </Text>
        <Textarea
          label="Frozen files"
          description="Files the worker can't change, such as the test this task must pass, each as Git names it from the repository's folder, one per line. A run's result counts only when every one is unchanged."
          autosize
          minRows={1}
          maxRows={8}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
          {...bind("frozen")}
          data-testid="brief-frozen"
        />
      </FormCard>
      <FormCard
        title="Baseline checks"
        note="Before the worker"
        description="Commands Nivra runs once before the worker starts, on the commit as it is, with networking off. Each must give what you write here, which can be a failure, such as a test that fails for the bug this task fixes. If one doesn't, the run stops before the worker, and says which. At most three."
      >
        <BaselineInput checks={draft.baseline} onChange={(baseline) => onChange({ ...draft, baseline })} />
      </FormCard>
      <FormCard title="Repository checks" note="Required on new runs">
        <Textarea
          label="Checks"
          description="The repository's own commands, such as sh test.sh. One per line. Nivra runs each before the worker for comparison and afterwards; every final result must pass for verification."
          autosize
          minRows={1}
          maxRows={8}
          {...bind("checks")}
          data-testid="brief-checks"
        />
      </FormCard>
      <FormCard title="Where it starts and stops">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <Textarea label="Scope" description="What it covers." autosize minRows={1} maxRows={8} {...bind("scope")} data-testid="brief-scope" />
          <Textarea label="Not part of it" description="What it leaves alone." autosize minRows={1} maxRows={8} {...bind("exclusions")} data-testid="brief-exclusions" />
        </SimpleGrid>
      </FormCard>
      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <UnstyledButton onClick={() => setMore(!open)} aria-expanded={open} aria-controls={open ? moreId : undefined} data-testid="brief-more">
            <Group gap="xs" wrap="nowrap">
              <Chevron open={open} />
              <Text fw={600}>More, all optional</Text>
            </Group>
          </UnstyledButton>
          <Text size="sm" c="var(--nivra-text-2)">
            Context and assumptions, for the worker to read.
          </Text>
          {open && (
            <Stack gap="sm" id={moreId}>
              <Textarea label="Context" description="Background the work needs, such as a plan." autosize minRows={3} maxRows={14} {...bind("context")} data-testid="brief-context" />
              <Textarea label="Assumptions" description="What it takes as true without checking. One per line." autosize minRows={1} maxRows={8} {...bind("assumptions")} data-testid="brief-assumptions" />
            </Stack>
          )}
        </Stack>
      </Paper>
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
      <Field label="Not part of it" testId="task-brief-exclusions">
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
      <Field label="Baseline checks, before the worker" testId="task-brief-baseline">
        <BaselineRead checks={content.baseline} />
      </Field>
      <Field label="Frozen files, which the worker can't change" testId="task-brief-frozen">
        {content.frozen.length ? (
          <List size="sm">
            {content.frozen.map((path) => (
              <List.Item key={path}>
                <Code>{path}</Code>
              </List.Item>
            ))}
          </List>
        ) : (
          <Text size="sm" c="var(--nivra-text-3)">
            None
          </Text>
        )}
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
 * What a new brief has, checked as it's written (NIV-56, G3: P1b): what marking it ready needs, then what a run needs,
 * from the form and the chosen repository's own facts. Nothing here is sent.
 */
function BriefSide({ draft, project, environment }: { draft: Draft; project: ProjectView | null; environment: EnvironmentView | null }) {
  const criteria = entries(draft.criteria);
  const cases = draft.cases.length;
  const ofEnvironment = project ? environmentRowOf(project.label, environment) : null;
  return (
    <Paper withBorder p="md" radius="md" data-testid="task-form-side">
      <Stack gap="md">
        <Stack gap={2}>
          <Text fw={600}>What this brief has</Text>
          <Text size="sm" c="var(--nivra-text-2)">
            Checked as you write. Nothing here is sent.
          </Text>
        </Stack>
        <CheckGroup title="To mark it ready">
          <CheckLine kind={draft.goal.trim() ? "met" : "needed"} title="A goal" detail={draft.goal.trim() ? null : "Not written yet: what the task is for."} testId="task-form-has" row="goal" />
          <CheckLine kind={criteria ? "met" : "needed"} title="An acceptance criterion" detail={criteria ? `${count(criteria, "criterion", "criteria")} written.` : "Not written yet: what must be true when it's done."} testId="task-form-has" row="criteria" />
        </CheckGroup>
        <CheckGroup title="To run it">
          <CheckLine
            kind={cases ? "met" : "needed"}
            title="An acceptance case"
            detail={cases ? `${count(cases, "case")} written, with ${count(entries(draft.checks), "check")}: a run takes one to four in all.` : "Not written yet. A run needs at least one."}
            testId="task-form-has"
            row="cases"
          />
          <CheckLine
            kind={project ? "met" : "needed"}
            title="A repository"
            detail={project ? `${project.label} · ${project.targetLabel}.` : "Not chosen yet. You can choose it now or later."}
            testId="task-form-has"
            row="repository"
          />
          {ofEnvironment && <CheckLine kind={ofEnvironment.kind} title={ofEnvironment.row.title} detail={ofEnvironment.row.detail} testId="task-form-has" row="environment" />}
          <CheckLine kind="asked" title="Your key, sharing and uploads" detail="Asked later, each where it's first needed." testId="task-form-has" row="asked" />
        </CheckGroup>
        <Text size="xs" c="var(--nivra-text-3)">
          Once it's saved, the coach can look for gaps and suggest changes you choose from. It's optional.
        </Text>
      </Stack>
    </Paper>
  );
}

/** What the task page says first after New task made it: a save whose second call, Mark ready, was refused. */
const createdNotices = new Map<string, string>();

/**
 * A new task, written directly or made from a plan version (NIV-56, G3: P1b): the same form, so the brief has the same
 * shape. From a plan, it starts with the plan's text as the context, its assumptions, and the plan's own repository.
 * Choosing another repository, or none, says first that the plan's material will be cleared: it belongs to the other
 * project. Save as draft makes the task; Mark ready makes it and then marks it ready, two calls, so a refused second one
 * leaves a draft, and the task's page says so.
 */
export function NewTask({
  projects,
  plan,
  initialTitle,
  initialProjectId = null,
  onCreated,
  onCancel,
  renderStrip,
  draftKey = null,
}: {
  projects: ProjectView[];
  plan: PlanView | null;
  initialTitle: string;
  /** The repository to start with when there's no plan, such as the project whose page opened the form. */
  initialProjectId?: string | null;
  onCreated(task: TaskView): void;
  onCancel(): void;
  /** The shell's progress strip, from the brief's own steps; none until the shell passes it. */
  renderStrip?(items: StripItem[]): ReactNode;
  /** Where the shell keeps the form's draft (NIV-56): restored when the form opens again, gone once saved or cancelled. */
  draftKey?: string | null;
}) {
  const planProject = plan?.projectId ? (projects.find((p) => p.id === plan.projectId) ?? null) : null;
  const [title, setTitle] = useState(initialTitle);
  const [repository, setRepository] = useState<string>(
    () =>
      initialRepositoryOf(
        plan,
        projects.map((p) => p.id),
        initialProjectId,
      ) ?? NONE,
  );
  const [draft, setDraft] = useState<Draft>(plan ? { ...EMPTY, context: plan.text, assumptions: plan.assumptions.join("\n") } : EMPTY);
  const [busy, setBusy] = useState<"draft" | "ready" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The shell's draft of the form, written on every edit. It is restored once, never over what was typed, when the form
  // opens bare (New task, or the draft's own link); a form opened with a title from the Home composer starts from that.
  const kept = useDraft<{ title: string; repository: string; draft: Draft }>(draftKey ?? "new-task:none");
  useEffect(() => {
    const restored = kept.restore;
    if (!draftKey || !restored || initialTitle !== "") return;
    setTitle(restored.title);
    setRepository(projects.some((p) => p.id === restored.repository) ? restored.repository : NONE);
    setDraft({ ...EMPTY, ...restored.draft });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kept.restore]);
  const remember = (edit: Partial<{ title: string; repository: string; draft: Draft }>) => {
    if (!draftKey) return;
    const next = { title, repository, draft, ...edit };
    kept.change(next, next.title.trim() || "New task");
  };
  const chosen = repository === NONE ? null : repository;
  const leavesPlan = plan !== null && plan.projectId !== null && chosen !== plan.projectId;
  const project = chosen ? (projects.find((p) => p.id === chosen) ?? null) : null;
  const environment = usePoll<EnvironmentView>(() => window.nivra.getEnvironment(chosen!), () => null, [chosen], chosen !== null);
  const known = project && environment.value?.projectId === project.id ? environment.value : null;
  // What the host asks of a ready brief: a goal and an acceptance criterion.
  const readyable = draft.goal.trim() !== "" && entries(draft.criteria) > 0;

  async function create(ready: boolean) {
    setBusy(ready ? "ready" : "draft");
    setError(null);
    let task: TaskView;
    try {
      task = await window.nivra.createTask({ title, fields: fieldsOf(draft), projectId: chosen, planId: plan?.id ?? null });
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(null);
      return;
    }
    if (draftKey) kept.discard();
    if (ready) {
      try {
        task = await window.nivra.setTaskState(task.summary.id, task.revision, "ready");
      } catch (reason) {
        createdNotices.set(task.summary.id, `The task is saved as a draft, and isn't marked ready. ${errorMessage(reason)}`);
      }
    }
    onCreated(task);
  }

  return (
    <Stack gap="md" data-testid="new-task">
      <Stack gap={4}>
        <Title order={2}>New task</Title>
        <Text size="sm" c="var(--nivra-text-2)">
          {plan
            ? `From plan v${plan.version}. The brief starts with the plan's text as its context, and with its assumptions. The plan stays as it is.`
            : "Write the brief directly. A task made from a plan has the same brief."}
        </Text>
        <Text size="xs" c="var(--nivra-text-3)">
          New task, not saved yet
        </Text>
      </Stack>
      {renderStrip?.(stripItemsOf({ task: null, needed: null, environment: project ? environmentStepOf(known) : null, latest: null }))}
      <Grid gap="md">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="md">
            <Paper withBorder p="md" radius="md">
              <Stack gap="sm">
                <TextInput
                  label="Title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.currentTarget.value);
                    remember({ title: event.currentTarget.value });
                  }}
                  data-testid="task-form-title"
                />
                <Select
                  label="Repository"
                  description="Where the task's work will run. You can choose it later."
                  data={repositoryChoices(projects)}
                  value={repository}
                  onChange={(value) => {
                    setRepository(value ?? NONE);
                    remember({ repository: value ?? NONE });
                  }}
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
              </Stack>
            </Paper>
            <BriefInputs
              draft={draft}
              onChange={(next) => {
                setDraft(next);
                remember({ draft: next });
              }}
            />
            <DraftNotice result={kept.result} />
            {error && (
              <Text size="sm" c="var(--nivra-error)" data-testid="task-form-error">
                {error}
              </Text>
            )}
            <Group justify="space-between" align="center" gap="sm">
              <Text size="xs" c="var(--nivra-text-3)" style={{ flex: "1 1 260px" }}>
                Mark ready saves the brief as v1 and marks the task ready: it needs a goal and at least one acceptance criterion. Nothing is sent while you write.
              </Text>
              <Group gap="sm" wrap="nowrap">
                <Button
                  variant="subtle"
                  onClick={() => {
                    if (draftKey) kept.discard();
                    onCancel();
                  }}
                  disabled={busy !== null}
                  data-testid="task-form-cancel"
                >
                  Cancel
                </Button>
                <Button variant="default" onClick={() => void create(false)} loading={busy === "draft"} disabled={busy === "ready"} data-testid="task-form-create">
                  Save as draft
                </Button>
                <Button onClick={() => void create(true)} loading={busy === "ready"} disabled={busy === "draft" || !readyable} data-testid="task-form-mark-ready">
                  Mark ready
                </Button>
              </Group>
            </Group>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <BriefSide draft={draft} project={project} environment={known} />
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

/** Where each state leaves the task, said once beside its state changes. */
const STATE_SAYS: Record<TaskState, string> = {
  draft: "A draft, which can't run yet.",
  ready: "Ready to run. Complete it once you accept the work as done, or put it back to draft to change it.",
  active: "Its run, or its change, is still going.",
  review: "Its last run waits on you: decide on its change, or settle it.",
  completed: "Completed. Reopen it to change its brief or run it again.",
};

type TaskTab = "brief" | "coach" | "runs";

/**
 * One task (NIV-56, G3: P1c, P1h): a header with its state, repository and brief version, "Preview the run" and its other
 * actions; the progress strip the shell draws; then the main column, with readiness before a run, or the latest run's
 * card while it goes or waits on the person, and the aside, with the brief, the coach and the runs as tabs, and the
 * task's state changes. Every change sends the revision the task was read at; one that changed meanwhile is refused,
 * and the view reads it again. An edit keeps the revision it started from (NIV-53): a refresh never moves it, so a draft
 * begun before another save can't land on top of it, and a refused save keeps the editor open with the person's text
 * and says what changed.
 */
export function TaskDetail({
  taskId,
  projects,
  engines,
  onEngineRestarted,
  onDeleted,
  onOpenConversation,
  renderStrip,
  onOpenEnvironment,
  onOpenPlanning,
}: {
  taskId: string;
  projects: ProjectView[];
  /** Every engine a project uses: the task's project's says when it isn't running, so it can be restarted here. */
  engines: EngineView[];
  onEngineRestarted(): void;
  onDeleted(): void;
  onOpenConversation(conversationId: string): void;
  /** The shell's progress strip, drawn from the task's own steps; none until the shell passes it. */
  renderStrip?(items: StripItem[]): ReactNode;
  /** Opens the project's environment where readiness points to it; without it, readiness only says what it needs. */
  onOpenEnvironment?(projectId: string): void;
  onOpenPlanning?(planningId: string): void;
}) {
  const [readCount, setReadCount] = useState(0);
  const task = usePoll<TaskView>(() => window.nivra.getTask(taskId), () => null, [taskId, readCount]);
  const [editing, setEditing] = useState<"brief" | "title" | "repository" | null>(null);
  // The revision and brief version an edit started from, and a save refused because the task changed since.
  const [base, setBase] = useState<{ revision: number; version: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [title, setTitle] = useState("");
  const [repository, setRepository] = useState<string>(NONE);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TaskTab>("brief");
  // The run shown in the main column when one is chosen from the runs; otherwise the latest.
  const [chosen, setChosen] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  // What New task left to say: read once here, and forgotten after (StrictMode may run the reader twice).
  const [created, setCreated] = useState(() => createdNotices.get(taskId) ?? null);
  useEffect(() => {
    createdNotices.delete(taskId);
  }, [taskId]);
  // What readiness reads besides the task: the saved settings, and the project's environment. Neither sends anything.
  const [settingsCount, setSettingsCount] = useState(0);
  const settings = usePoll<SettingsView>(() => window.nivra.getSettings(), () => null, [settingsCount]);
  const projectId = task.value?.summary.projectId ?? null;
  const environment = usePoll<EnvironmentView>(() => window.nivra.getEnvironment(projectId!), () => null, [projectId, readCount], projectId !== null);
  // The coach (NIV-53): its coachings, read again while one is open; a save of its changes going; a field to focus.
  const coachings = usePoll<CoachingView[]>(() => window.nivra.listCoachings(taskId), (value) => (value?.some(isOpenCoaching) ? 700 : null), [taskId, readCount]);
  const [coachSaving, setCoachSaving] = useState(false);
  const [focus, setFocus] = useState<{ field: CoachQuestionField; at: number } | null>(null);
  useEffect(() => {
    if (!focus || editing !== "brief") return;
    // Once the editor shows, the field the question named takes the focus; the draft is left as it is.
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-testid="${FIELD_INPUT[focus.field]}"]`)?.focus();
      setFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, editing]);

  const reread = () => setReadCount((n) => n + 1);
  const latestId = task.value?.attempts.at(-1)?.id ?? null;
  const shownId = chosen ?? latestId;
  const run = useRun(taskId, shownId, reread, reread);
  // An applied change's review is opened from its summary, and closed again for another run.
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => setReviewing(false), [shownId]);
  // "Preview the run" pressed from the page's next step, not the header.
  const [previewAsked, setPreviewAsked] = useState(0);
  // The coach's preview, shown in the main column while the person decides whether to ask (P1y).
  const [asking, setAsking] = useState(false);
  // Narrow (NW3): the decision follows the result, and a bar keeps Approve in view; its press opens the same confirmation.
  const narrow = useNarrow();
  const [confirmAsked, setConfirmAsked] = useState(0);
  // The brief editor's draft (NIV-56), by task and the brief version the edit began on, so it is restored only over that
  // version: when the page opens again with one, the editor opens with it (never over another edit or typed text), and
  // it goes once the edit is saved or discarded. One begun on an older version stays listed, and isn't restored.
  const briefVersion = task.value?.brief.version ?? null;
  const briefDraft = useDraft<Draft>(`brief:${taskId}:${editing === "brief" && base ? base.version : (briefVersion ?? "unread")}`);
  useEffect(() => {
    const view = task.value;
    if (!briefDraft.restore || !view || editing !== null || view.summary.state === "completed") return;
    setDraft({ ...EMPTY, ...briefDraft.restore });
    setBase({ revision: view.revision, version: view.brief.version });
    setConflict(false);
    setError(null);
    setEditing("brief");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefDraft.restore, briefVersion]);

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

  async function act(change: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await change();
      reread();
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      // Changed meanwhile: what is shown is read again, and the change can be made from it. An open edit stays open.
      if (message.includes("changed since you opened it")) reread();
    } finally {
      setBusy(false);
    }
  }

  /** Starts an edit from the task as it is shown now: its save is made from this revision, whatever is read later. */
  function startEdit(kind: "brief" | "title" | "repository") {
    setBase({ revision, version: brief.version });
    setConflict(false);
    setError(null);
    setEditing(kind);
  }

  function stopEdit() {
    setEditing(null);
    setBase(null);
    setConflict(false);
  }

  function editBrief() {
    setDraft(briefDraft.restore ? { ...EMPTY, ...briefDraft.restore } : draftOf(brief.content));
    startEdit("brief");
  }

  /** A coach's question names a field: the brief editor opens there, or the open one is used as it is, edits and all. */
  function updateField(field: CoachQuestionField) {
    // Never on a completed task, over another edit, or while the coach's changes are being saved: the panel says so.
    if (completed || coachSaving || editing === "title" || editing === "repository") return;
    if (editing !== "brief") editBrief();
    setFocus({ field, at: Date.now() });
  }

  /**
   * Saves an edit from the revision it started from. A task that changed since refuses it: the editor stays open with
   * the person's text, the conflict is shown, and the task is read again, so nothing newer is overwritten or lost.
   */
  async function saveEdit(change: (from: number) => Promise<unknown>) {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      await change(base.revision);
      stopEdit();
      reread();
    } catch (reason) {
      const message = errorMessage(reason);
      if (message.includes("changed since you opened it")) {
        setConflict(true);
        reread();
      } else setError(message);
    } finally {
      setBusy(false);
    }
  }

  const chosenRepository = repository === NONE ? null : repository;
  const clearsOnMove = brief.content.sources.some((source) => source.projectId !== null && source.projectId !== chosenRepository);
  // The engine the task's runs go to, so the person can recover it from here.
  const project = summary.projectId ? (projects.find((p) => p.id === summary.projectId) ?? null) : null;
  const engine = project ? (engines.find((e) => e.targetId === project.targetId) ?? null) : null;
  const rewrite = brief.content.revalidate.map((part) => (part === "context" ? "the context" : "the assumptions"));
  const ofProject = project && environment.value?.projectId === project.id ? environment.value : null;

  const latest = view.attempts.at(-1) ?? null;
  const going = latest !== null && (latest.status === "submitting" || latest.status === "running");
  const shown = shownId;
  const shownAt = shown ? view.attempts.findIndex((attempt) => attempt.id === shown) : -1;
  const shownNumber = shown ? (shownAt >= 0 ? shownAt + 1 : view.attempts.length + 1) : null;
  // What the main column leads with for the shown run: it going, its review, its applied change, or the task completed.
  const value = run.value;
  const phase =
    shown === null
      ? "none"
      : value === null
        ? "loading"
        : value.status === "submitting" || value.status === "running"
          ? "going"
          : value.decision === "approved" && value.apply !== null && completed && value.id === latest?.id && (value.acceptedAt !== null || value.apply.resolution === "accepted") && value.acceptNote === null
            ? "completed"
            : value.decision === "approved" && value.apply !== null
              ? "applied"
              : "review";
  // A command is shown only from the brief version the run ran: the report keeps names, not commands.
  const ranContent = value && value.briefVersion === brief.version ? brief.content : null;
  const marks = value ? applyMarks(value) : null;
  // Nothing to decide on the latest run (RS1): the page says so, with the next step.
  const decisionCard = phase === "review" && value ? <DecisionCard value={value} busy={run.busy} act={run.act} content={ranContent} confirmAsked={confirmAsked} /> : null;
  const leads = value ? decisionLead(value.report, value.actions.includes("approve"), value.proposal !== null, value.admission) : null;
  const settledQuietly = phase === "review" && value !== null && value.id === latest?.id && value.decision === null && !value.actions.some((action) => action === "approve" || action === "reject" || action === "revise");
  // Readiness leads until the latest run goes or waits on the person; a draft always shows it, with Mark ready.
  const leading = summary.state === "draft" || !latestHolds(latest);
  const found = readinessOf({ task: view, project, settings: settings.value, environment: ofProject });
  // A next step the page can't take here isn't offered: the row still says what's needed.
  const offered = (action: ReadinessAction | null): ReadinessAction | null =>
    action === "open-environment" && !onOpenEnvironment ? null : action === "edit-brief" && completed ? null : action;
  const readiness = { ...found, needed: found.needed.map((row) => ({ ...row, action: offered(row.action) })), optional: found.optional.map((row) => ({ ...row, action: offered(row.action) })) };

  function onReadiness(action: ReadinessAction) {
    if (action === "mark-ready") void act(() => window.nivra.setTaskState(taskId, revision, "ready"));
    else if (action === "edit-brief") {
      if (editing !== "brief") editBrief();
    } else if (action === "change-repository") {
      setRepository(summary.projectId ?? NONE);
      startEdit("repository");
    } else if (action === "add-keys") setKeysOpen(true);
    else if (project && onOpenEnvironment) onOpenEnvironment(project.id);
  }

  return (
    <Stack gap="md" data-testid="task" data-task-id={taskId} data-revision={revision}>
      {view.planningSources?.map((source) => <Alert key={`${source.planningId}:${source.itemId}`} color={source.questions.length || source.missingPrerequisites.length ? "yellow" : "gray"} title={`From reviewed planning v${source.revision}`}><Button size="xs" variant="subtle" disabled={!onOpenPlanning} onClick={() => onOpenPlanning?.(source.planningId)}>Review source plan</Button>{source.questions.map((question, index) => <Text key={index} size="sm">Needs a decision: {question}</Text>)}{source.missingPrerequisites.length > 0 && <Text size="sm">Unresolved advisory prerequisites: {source.missingPrerequisites.join(", ")}</Text>}</Alert>)}
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0, flex: "1 1 320px" }}>
          {editing === "title" ? (
            <Group gap="xs" wrap="nowrap">
              <TextInput value={title} onChange={(event) => setTitle(event.currentTarget.value)} aria-label="Title" style={{ flex: 1 }} data-testid="task-title-input" />
              <Button size="xs" onClick={() => void saveEdit((from) => window.nivra.renameTask(taskId, from, title))} loading={busy} data-testid="task-title-save">
                Save
              </Button>
              <Button size="xs" variant="subtle" onClick={stopEdit} disabled={busy} data-testid="task-title-cancel">
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
            <Badge color="gray" variant="outline" radius="sm" style={{ maxWidth: "100%" }}>
              <span data-testid="task-repository">{repositoryOf(summary)}</span>
              {project ? ` · ${project.targetLabel}` : ""}
            </Badge>
            <Text size="sm" c="var(--nivra-text-3)">
              <span data-testid="task-brief-version">· brief v{brief.version}</span>
              {shownNumber !== null && latest ? ` · run ${shownNumber}` : ""}
            </Text>
          </Group>
        </Stack>
        <Group gap="xs" align="flex-start" wrap="nowrap">
          {tab === "coach" && (
            <Button variant="default" onClick={() => setTab("brief")} data-testid="task-coach-back">
              Back to readiness
            </Button>
          )}
          {!going && tab !== "coach" && (
            <RunLauncher
              view={view}
              asked={previewAsked}
              primary={readiness.needed.every((row) => row.action === null)}
              onStarted={(attemptId) => {
                setChosen(attemptId);
                reread();
              }}
            />
          )}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button variant="default" aria-label="More for this task" data-testid="task-more">
                More
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                onClick={() => {
                  setTitle(summary.title);
                  startEdit("title");
                }}
                data-testid="task-rename"
              >
                Rename
              </Menu.Item>
              <Menu.Item
                onClick={() => {
                  setRepository(summary.projectId ?? NONE);
                  startEdit("repository");
                }}
                data-testid="task-move"
              >
                Change repository
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" onClick={() => setConfirmDelete(true)} data-testid="task-delete">
                Delete
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      {renderStrip?.(stripItemsOf({ task: { state: summary.state, briefVersion: brief.version }, needed: readiness.needed.length, environment: project ? environmentStepOf(ofProject) : null, latest }))}

      {project && (
        <EngineNotices
          engine={engine}
          onRestart={async () => {
            await window.nivra.restartEngine(project.id);
            onEngineRestarted();
          }}
          testId="task-engine"
        />
      )}

      {created && (
        <Alert color="yellow" variant="light" withCloseButton closeButtonLabel="Dismiss" onClose={() => setCreated(null)} data-testid="task-created-notice">
          <Text size="sm">{created}</Text>
        </Alert>
      )}

      {error && (
        <Alert color="red" variant="light" data-testid="task-error">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      {conflict && editing && base && (
        <Alert color="yellow" variant="light" data-testid="task-edit-conflict">
          <Stack gap={6}>
            <Text size="sm">
              This task changed since you started editing{brief.version > base.version ? `: brief v${brief.version} is saved now` : ""}, so your edit wasn't saved. Your text is still here. Copy
              what you need, then discard your edit and start again from what is saved.
            </Text>
            <Group>
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  if (editing === "brief") briefDraft.discard();
                  stopEdit();
                }}
                data-testid="task-edit-discard"
              >
                Discard my edit
              </Button>
            </Group>
          </Stack>
        </Alert>
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

      <div data-testid={shown ? "task-attempt" : undefined} data-status={shown ? (value?.status ?? "") : undefined} data-attempt-id={shown ?? undefined}>
      <div data-testid={marks ? "task-apply" : undefined} data-status={marks?.status} data-resolution={marks?.resolution}>
      <Grid gap="md">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="md">
            {editing === "repository" && (
              <Section title="Change repository">
                <Select data={repositoryChoices(projects)} value={repository} onChange={(value) => setRepository(value ?? NONE)} allowDeselect={false} aria-label="Repository" data-testid="task-move-repository" />
                {clearsOnMove && (
                  <Text size="sm" c="var(--nivra-warning)" data-testid="task-move-clears">
                    What this brief took from another project's conversation is cleared in a new version, to be written again for this repository.
                  </Text>
                )}
                <Group justify="flex-end" gap="sm">
                  <Button variant="default" onClick={stopEdit} disabled={busy}>
                    Cancel
                  </Button>
                  <Button onClick={() => void saveEdit((from) => window.nivra.setTaskProject(taskId, from, chosenRepository))} loading={busy} data-testid="task-move-save">
                    Save
                  </Button>
                </Group>
              </Section>
            )}
            {editing === "brief" && (
              <Stack gap="md" data-testid="task-brief-editor">
                <Group justify="space-between" align="baseline" gap="sm">
                  <Text fw={600}>Edit the brief</Text>
                  <Text size="xs" c="var(--nivra-text-3)">
                    Saving makes v{(base?.version ?? brief.version) + 1}. v{base?.version ?? brief.version} stays as it was.
                  </Text>
                </Group>
                <BriefInputs
                  draft={draft}
                  onChange={(next) => {
                    setDraft(next);
                    briefDraft.change(next, `${summary.title}, brief v${brief.version}`);
                  }}
                  reveal={focus?.field ?? null}
                />
                <DraftNotice result={briefDraft.result} />
                <Group justify="flex-end" gap="sm">
                  <Button
                    variant="default"
                    onClick={() => {
                      briefDraft.discard();
                      stopEdit();
                    }}
                    disabled={busy}
                    data-testid="task-brief-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() =>
                      void saveEdit(async (from) => {
                        await window.nivra.reviseBrief(taskId, from, fieldsOf(draft));
                        briefDraft.discard();
                      })
                    }
                    loading={busy}
                    data-testid="task-brief-save"
                  >
                    Save as v{(base?.version ?? brief.version) + 1}
                  </Button>
                </Group>
              </Stack>
            )}
            <div hidden={tab !== "coach"} data-testid="task-coach-column">
              <CoachMain
                asking={asking}
                onAsk={() => setAsking(true)}
                onAskEnd={() => setAsking(false)}
                task={view}
                coachings={coachings.value}
                editing={editing === "brief"}
                onPrepare={(selection) => window.nivra.prepareCoach(taskId, selection)}
                onStart={async (selection, expected) => {
                  const started = await window.nivra.startCoach(taskId, selection, expected);
                  reread();
                  return started;
                }}
                onCancel={async (coachingId) => {
                  await window.nivra.cancelCoach(taskId, coachingId);
                  reread();
                }}
                onAccept={async (coachingId, fields) => {
                  try {
                    await window.nivra.acceptCoachChanges(taskId, revision, coachingId, fields);
                  } finally {
                    reread();
                  }
                }}
                onUpdateField={updateField}
                updateBlocked={
                  completed
                    ? "A completed task's brief can't change. Reopen it to change it."
                    : coachSaving
                      ? "Wait for the coach's changes to be saved."
                      : editing === "title" || editing === "repository"
                        ? "Save or cancel your other edit first."
                        : null
                }
                onSavingChange={setCoachSaving}
              />
            </div>
            <Stack gap="md" display={tab === "coach" ? "none" : undefined} data-testid="task-main">
            {run.error && (
              <Alert color="red" variant="light" data-testid="task-attempt-error">
                <Text size="sm">{run.error}</Text>
              </Alert>
            )}
            {leading && phase !== "completed" && (summary.state === "draft" || shown === null) && <ReadinessCard readiness={readiness} busy={busy || coachSaving} onAction={onReadiness} />}
            {shown && chosen !== null && latest !== null && chosen !== latest.id && (
              <Group gap="xs" data-testid="task-attempt-earlier">
                <Text size="sm" c="var(--nivra-text-2)">
                  Showing run {shownNumber}, an earlier one.
                </Text>
                <Anchor component="button" size="sm" onClick={() => setChosen(null)}>
                  Show the latest run
                </Anchor>
              </Group>
            )}
            {phase === "loading" && (
              <Text size="sm" c={run.loadError ? "var(--nivra-error)" : "var(--nivra-text-3)"}>
                {run.loadError ?? `Reading run ${shownNumber}…`}
              </Text>
            )}
            {phase === "going" && value && <RunGoing run={run} number={shownNumber!} />}
            {phase === "review" && value && (
              <>
                <RunReview value={value} number={shownNumber!} task={STATE_LOOK[summary.state]} content={ranContent} decision={narrow ? decisionCard : null} />
                {value.apply && <ApplyCard value={value} />}
              </>
            )}
            {narrow && phase === "review" && value && value.decision === null && value.proposal && leads?.approve && (
              <Paper withBorder p="xs" radius="md" style={{ position: "sticky", bottom: 0, zIndex: 5 }} data-testid="task-attempt-bar">
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                    <Badge color={outcomeLookOf(value).color} variant="light">
                      {outcomeLookOf(value).label}
                    </Badge>
                    <Text size="xs" ff="monospace" c="var(--nivra-text-3)">
                      {value.proposal.hash.slice(0, 12)}
                    </Text>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <Button size="xs" variant="default" onClick={() => document.getElementById(`decision-${value.id}`)?.scrollIntoView({ block: "start" })} data-testid="task-attempt-bar-choices">
                      Other choices
                    </Button>
                    <Button size="xs" variant={leads.lead === "approve" ? "filled" : "default"} onClick={() => setConfirmAsked((n) => n + 1)} disabled={run.busy} data-testid="task-attempt-approve-bar">
                      {leads.approve}
                    </Button>
                  </Group>
                </Group>
              </Paper>
            )}
            {phase === "applied" && value && (
              <>
                <ApplyCard value={value} />
                <Collapse expanded={reviewing}>
                  <RunReview value={value} number={shownNumber!} task={STATE_LOOK[summary.state]} content={ranContent} />
                </Collapse>
              </>
            )}
            {phase === "completed" && value && <CompletedCards task={view} value={value} project={project?.label ?? null} />}
            {settledQuietly && value && !completed && (
              <Paper withBorder p="md" radius="md" data-testid="task-next-step">
                <Stack gap="xs">
                  <Text fw={600}>Next step</Text>
                  <Text size="sm" c="var(--nivra-text-2)">
                    {value.report?.outcome === "interrupted" || value.status === "interrupted"
                      ? "Nothing to decide: no change came back, and your checkout wasn't touched. A new run starts only from a new preview: this one isn't replayed."
                      : value.report?.outcome === "uncertain"
                        ? "Nothing to decide: nothing was proposed, and your checkout wasn't touched. Check your Nebius project for what's still open, listed in the result."
                        : value.report?.outcome === "unchanged"
                          ? "Nothing to decide: the run proposed no change. Say more about what the run should do, then run it again."
                          : "Nothing to decide: the run proposed no change."}
                  </Text>
                  <Group gap="sm">
                    {value.report?.outcome === "unchanged" && (
                      <Button size="xs" onClick={() => onReadiness("edit-brief")} disabled={editing === "brief" || coachSaving} data-testid="task-next-edit-brief">
                        Edit brief
                      </Button>
                    )}
                    <Button size="xs" variant={value.report?.outcome === "unchanged" ? "default" : "filled"} onClick={() => setPreviewAsked((n) => n + 1)} disabled={view.runBlocked !== null} data-testid="task-next-preview">
                      Preview the run
                    </Button>
                  </Group>
                  {view.runBlocked !== null && (
                    <Text size="xs" c="var(--nivra-text-3)">
                      Preview is off until what's needed is done: see Before this task can run.
                    </Text>
                  )}
                </Stack>
              </Paper>
            )}
            {leading && phase !== "completed" && !(summary.state === "draft" || shown === null) && <ReadinessCard readiness={readiness} busy={busy || coachSaving} onAction={onReadiness} />}
            </Stack>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="md">
            {!narrow && decisionCard}
            {phase === "applied" && value && (
              <>
                <SettleCard value={value} busy={run.busy} act={run.act} briefVersion={brief.version} />
                <RunSummary value={value} number={shownNumber!} reviewing={reviewing} onReview={() => setReviewing(!reviewing)} />
              </>
            )}
            <Paper withBorder radius="md">
              <Tabs value={tab} onChange={(value) => setTab((value as TaskTab | null) ?? "brief")}>
                <Tabs.List px="xs">
                  <Tabs.Tab value="brief" data-testid="task-tab-brief">
                    Brief
                  </Tabs.Tab>
                  <Tabs.Tab value="coach" data-testid="task-tab-coach">
                    Coach
                  </Tabs.Tab>
                  <Tabs.Tab value="runs" data-testid="task-tab-runs">
                    Earlier runs
                  </Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="brief" p="md">
                  <Stack gap="sm">
                    <BriefRead content={brief.content} />
                    <Group gap="sm">
                      <Button size="xs" variant="default" onClick={editBrief} disabled={completed || coachSaving || editing === "brief"} data-testid="task-edit-brief">
                        Edit brief
                      </Button>
                      <Button size="xs" variant="default" onClick={() => setTab("coach")} data-testid="task-brief-ask-coach">
                        Ask the coach
                      </Button>
                    </Group>
                    {completed ? (
                      <Text size="xs" c="var(--nivra-text-3)">
                        A completed task's brief can't change. Reopen it to change it.
                      </Text>
                    ) : going && latest ? (
                      <Text size="xs" c="var(--nivra-text-3)">
                        You can still edit the brief: this run keeps v{latest.briefVersion}. If you change it, accepting this run's change won't complete the task.
                      </Text>
                    ) : (
                      <Text size="xs" c="var(--nivra-text-3)">
                        The coach is optional. It checks the brief for gaps and suggests changes you choose from.
                      </Text>
                    )}
                    <Text size="xs" c="var(--nivra-text-3)" data-testid="task-versions">
                      Versions: {view.versions.map((version) => `v${version.version} (${new Date(version.createdAt).toLocaleString()})`).join(", ")}
                    </Text>
                  </Stack>
                </Tabs.Panel>
                <Tabs.Panel value="coach" p="md">
                  <CoachAside task={view} coachings={coachings.value} onAsk={() => setAsking(true)} />
                </Tabs.Panel>
                <Tabs.Panel value="runs" p="md">
                  {view.attempts.length ? (
                    <AttemptsList attempts={view.attempts} shown={shown} onChoose={setChosen} />
                  ) : (
                    <Text size="sm" c="var(--nivra-text-3)" data-testid="task-attempts-none">
                      No runs yet. Each run is listed here, newest first, with how it ended and what became of its change.
                    </Text>
                  )}
                </Tabs.Panel>
              </Tabs>
            </Paper>
            <Paper withBorder radius="md" p="md" data-testid="task-progress">
              <Stack gap="xs">
                <Text fw={600} size="sm">
                  {completed ? "What next" : "Progress"}
                </Text>
                <Text size="sm" c="var(--nivra-text-2)">
                  {completed ? "Reopen sets the task back to draft, to change its brief and run it again. Your checkout stays as it is." : STATE_SAYS[summary.state]}
                </Text>
                {(summary.state === "ready" || completed) && (
                  <Group gap="sm">
                    {summary.state === "ready" && (
                      <>
                        <Button size="xs" variant="default" onClick={() => void act(() => window.nivra.setTaskState(taskId, revision, "completed"))} loading={busy} data-testid="task-complete">
                          Complete
                        </Button>
                        <Button size="xs" variant="subtle" onClick={() => void act(() => window.nivra.setTaskState(taskId, revision, "draft"))} disabled={busy} data-testid="task-back-to-draft">
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
                )}
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>
      </div>
      </div>

      <KeyPrompt opened={keysOpen} settings={settings.value} onClose={() => setKeysOpen(false)} onSaved={() => setSettingsCount((n) => n + 1)} />

      <Modal opened={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this task?" data-testid="task-delete-dialog">
        <Stack gap="sm">
          <Text size="sm">
            The task and every version of its brief are deleted. The plans and conversations it came from stay. Its engines keep their records of its runs and coachings, and
            what was sent to Token Factory stays there.
          </Text>
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
