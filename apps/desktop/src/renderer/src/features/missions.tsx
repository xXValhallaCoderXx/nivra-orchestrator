import { Alert, Anchor, Badge, Button, Checkbox, Code, Group, List, Modal, Paper, ScrollArea, Select, SimpleGrid, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { MissionContent } from "@nivra/domain";
import { TASK_STATES, type MissionReviewPreview, type MissionsView, type MissionTaskView, type MissionView, type TaskState } from "../../../shared/ipc";
import { PreviewGuard } from "../../../shared/preview-guard";
import { errorMessage, Section, usePoll } from "../shared/ui";
import { MissionReviewCard } from "./mission-review";

/**
 * Missions (NIV-52): what a piece of work is for, saved in versions, a backlog of native tasks, a simple board of their
 * states, and a review of up to five of them by the council. Nothing here changes a task: a finding opens the task's own
 * page, where the person edits it. No repository is needed, and only tasks without one can be reviewed for now.
 */

/** The most tasks one review takes (NIV-52): `MISSION_REVIEW_LIMITS.tasks`, which the host enforces. */
const MAX_SELECTED = 5;

/** How the board names a task's state; the same words as the task's own page (D26). */
const STATE_LOOK: Record<TaskState, { label: string; color: string }> = {
  draft: { label: "Draft", color: "gray" },
  ready: { label: "Ready", color: "blue" },
  active: { label: "Active", color: "yellow" },
  review: { label: "In review", color: "yellow" },
  completed: { label: "Completed", color: "green" },
};

/** A mission's parts as the form holds them: lists are one entry per line. */
interface Draft {
  name: string;
  intendedUsers: string;
  outcome: string;
  successCriteria: string;
  constraints: string;
  nonGoals: string;
}

const EMPTY: Draft = { name: "", intendedUsers: "", outcome: "", successCriteria: "", constraints: "", nonGoals: "" };
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

const draftOf = (content: MissionContent): Draft => ({
  name: content.name,
  intendedUsers: content.intendedUsers,
  outcome: content.outcome,
  successCriteria: content.successCriteria.join("\n"),
  constraints: content.constraints.join("\n"),
  nonGoals: content.nonGoals.join("\n"),
});

const contentOf = (draft: Draft): MissionContent => ({
  name: draft.name,
  intendedUsers: draft.intendedUsers,
  outcome: draft.outcome,
  successCriteria: lines(draft.successCriteria),
  constraints: lines(draft.constraints),
  nonGoals: lines(draft.nonGoals),
});

function MissionForm({ draft, onChange }: { draft: Draft; onChange(draft: Draft): void }) {
  const set = (key: keyof Draft) => (event: { currentTarget: { value: string } }) => onChange({ ...draft, [key]: event.currentTarget.value });
  return (
    <Stack gap="sm">
      <TextInput label="Name" value={draft.name} onChange={set("name")} data-testid="mission-name" />
      <Textarea label="Who it's for" autosize minRows={1} value={draft.intendedUsers} onChange={set("intendedUsers")} data-testid="mission-users" />
      <Textarea label="Outcome: what is true once it's done" autosize minRows={2} value={draft.outcome} onChange={set("outcome")} data-testid="mission-outcome" />
      <Textarea label="How you'll know it worked (one per line)" autosize minRows={2} value={draft.successCriteria} onChange={set("successCriteria")} data-testid="mission-success" />
      <Textarea label="Constraints (one per line)" autosize minRows={1} value={draft.constraints} onChange={set("constraints")} data-testid="mission-constraints" />
      <Textarea label="Not part of it (one per line)" autosize minRows={1} value={draft.nonGoals} onChange={set("nonGoals")} data-testid="mission-non-goals" />
    </Stack>
  );
}

/** Every mission, and a new one. */
export function MissionsPage({ onOpen }: { onOpen(missionId: string): void }) {
  const missions = usePoll<MissionsView>(() => window.nivra.listMissions(), () => 5_000, []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = missions.value;
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const made = await window.nivra.createMission(contentOf(draft));
      setDraft(null);
      onOpen(made.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Missions"
      description="What a piece of work is for, and the tasks that should get it there. The council can review up to five of them against the mission. No repository is needed."
      actions={
        <Button size="xs" onClick={() => setDraft(EMPTY)} disabled={view?.workspace.state !== "ready" || draft !== null} data-testid="missions-new">
          New mission
        </Button>
      }
    >
      {missions.error && (
        <Text size="sm" c="var(--nivra-error)">
          {missions.error}
        </Text>
      )}
      {view?.workspace.state === "unavailable" && (
        <Alert color="red" variant="light">
          <Text size="sm">{view.workspace.reason}</Text>
        </Alert>
      )}
      {draft && (
        <Paper withBorder p="md" data-testid="mission-new">
          <Stack gap="sm">
            <MissionForm draft={draft} onChange={setDraft} />
            {error && (
              <Text size="sm" c="var(--nivra-error)" data-testid="mission-error">
                {error}
              </Text>
            )}
            <Group gap="xs">
              <Button size="xs" onClick={() => void save()} loading={busy} data-testid="mission-save">
                Save mission
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {view?.workspace.state === "ready" && view.missions.length === 0 && !draft && (
        <Text size="sm" c="var(--nivra-text-3)" data-testid="missions-empty">
          No missions yet. Write one: who it&apos;s for, and what is true once it&apos;s done.
        </Text>
      )}
      {view && view.missions.length > 0 && (
        <Stack gap={4}>
          {view.missions.map((mission) => (
            <Group key={mission.id} gap="xs" data-testid="mission-row" data-mission-id={mission.id}>
              <Anchor component="button" size="sm" onClick={() => onOpen(mission.id)} data-testid="mission-open">
                {mission.name}
              </Anchor>
              <Text size="xs" c="var(--nivra-text-3)">
                v{mission.version} · {mission.tasks} {mission.tasks === 1 ? "task" : "tasks"}
                {mission.reviewing ? " · a review is going" : ""}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Section>
  );
}

/** The backlog's tasks by state (D26). Active and In review come from runs, never from here; a card opens its task. */
function Board({ backlog, onOpenTask }: { backlog: MissionTaskView[]; onOpenTask(taskId: string): void }) {
  return (
    <SimpleGrid cols={5} spacing="xs" data-testid="mission-board">
      {TASK_STATES.map((state) => {
        const tasks = backlog.filter((entry) => entry.task.state === state);
        return (
          <Stack key={state} gap={4} data-testid="board-column" data-state={state}>
            <Text size="xs" fw={600} c="var(--nivra-text-2)">
              {STATE_LOOK[state].label} · {tasks.length}
            </Text>
            {tasks.map(({ task }) => (
              <Paper key={task.id} withBorder p={6} data-testid="board-card" data-task-id={task.id}>
                <Anchor component="button" size="xs" onClick={() => onOpenTask(task.id)} style={{ textAlign: "left" }}>
                  {task.title}
                </Anchor>
              </Paper>
            ))}
          </Stack>
        );
      })}
    </SimpleGrid>
  );
}

/** What a review would send, exactly, who reads it, and what it wouldn't send. */
function PreviewBody({ preview }: { preview: MissionReviewPreview }) {
  return (
    <Stack gap="sm">
      <Text size="sm" data-testid="mission-preview-scope">
        Mission v{preview.missionVersion} and {preview.tasks.length} selected {preview.tasks.length === 1 ? "task" : "tasks"}: {preview.tasks.map((task) => `${task.ref} ${task.title}`).join("; ")}. No repository: nothing is read from any folder.
      </Text>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Sent to Nebius Token Factory: this text, {preview.chars.toLocaleString("en")} characters
        </Text>
        <ScrollArea.Autosize mah={240} type="auto">
          <Code block data-testid="mission-preview-text">
            {preview.text}
          </Code>
        </ScrollArea.Autosize>
        {preview.preferences.length > 0 ? (
          <List size="sm" data-testid="mission-preview-preferences">
            {preview.preferences.map((preference, index) => (
              <List.Item key={index}>Your personal default: {preference.statement}</List.Item>
            ))}
          </List>
        ) : (
          <Text size="sm" c="var(--nivra-text-3)" data-testid="mission-preview-preferences">
            No preferences go with it: you have no confirmed personal ones.
          </Text>
        )}
      </Stack>
      <Stack gap={4} data-testid="mission-preview-specialists">
        <Text size="sm" fw={600}>
          Who reads it
        </Text>
        {preview.specialists.map((specialist) => (
          <Text size="sm" key={specialist.id}>
            {specialist.name} (v{specialist.version}): {specialist.personality} {specialist.purpose}
          </Text>
        ))}
      </Stack>
      <Text size="sm" data-testid="mission-preview-cost">
        Two reviewers on their own, then the chair: up to {preview.requests} model calls, with {preview.model ? preview.model : "the Nemotron model your key's listing gives"}. Nothing is retried.
      </Text>
      <Stack gap={2} data-testid="mission-preview-not-sent">
        <Text size="sm" fw={600}>
          Not sent
        </Text>
        {preview.notSent.map((line) => (
          <Text size="sm" key={line}>
            {line}
          </Text>
        ))}
      </Stack>
      <Text size="xs" c="var(--nivra-text-3)">
        A review doesn&apos;t change the mission or any task, mark a task ready, or approve anything. You decide what to change.
      </Text>
    </Stack>
  );
}

/** Previews the selected tasks' review, then starts exactly what was previewed: never a selection changed since. */
function ReviewDialog({ missionId, selected, opened, onClose, onStarted }: { missionId: string; selected: string[]; opened: boolean; onClose(): void; onStarted(): void }) {
  const [previewed, setPreviewed] = useState<{ preview: MissionReviewPreview; selection: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(new PreviewGuard());
  const key = selected.join(" ");

  /** Previews `chosen`, shown only while nothing changed since `mine` was asked for. */
  const prepare = async (chosen: string[]) => {
    const mine = guard.current.asked();
    setBusy(true);
    try {
      const preview = await window.nivra.prepareMissionReview(missionId, chosen);
      if (guard.current.current(mine)) setPreviewed({ preview, selection: chosen });
    } catch (reason) {
      if (guard.current.current(mine)) setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    guard.current.changed();
    setPreviewed(null);
    setError(null);
    if (opened) void prepare([...selected]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, missionId, key]);

  const start = async () => {
    if (!previewed) return;
    setBusy(true);
    setError(null);
    try {
      await window.nivra.startMissionReview(missionId, previewed.selection, previewed.preview.expected);
      onStarted();
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      guard.current.changed();
      setPreviewed(null);
      void prepare(previewed.selection);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} size="lg" title="Review the selected tasks against the mission" data-testid="mission-review-dialog">
      <Stack gap="md">
        {previewed && <PreviewBody preview={previewed.preview} />}
        {previewed?.preview.blocked && (
          <Alert color="yellow" variant="light" data-testid="mission-review-blocked">
            <Text size="sm">{previewed.preview.blocked}</Text>
          </Alert>
        )}
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="mission-review-error">
            {error}
          </Text>
        )}
        <Group gap="xs">
          <Button size="sm" onClick={() => void start()} loading={busy} disabled={!previewed || previewed.preview.blocked !== null} data-testid="mission-review-start">
            Start review
          </Button>
          <Button size="sm" variant="subtle" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A mission's parts as its page shows them. */
function MissionRead({ content }: { content: MissionContent }) {
  const lists: Array<[string, string[]]> = [
    ["How you'll know it worked", content.successCriteria],
    ["Constraints", content.constraints],
    ["Not part of it", content.nonGoals],
  ];
  return (
    <Stack gap={6} data-testid="mission-content">
      <Text size="sm">
        <b>Who it&apos;s for:</b> {content.intendedUsers || "Not written yet."}
      </Text>
      <Text size="sm">
        <b>Outcome:</b> {content.outcome}
      </Text>
      {lists.map(([title, items]) => (
        <Stack gap={0} key={title}>
          <Text size="sm" fw={600}>
            {title}
          </Text>
          {items.length ? (
            <List size="sm">
              {items.map((item, index) => (
                <List.Item key={index}>{item}</List.Item>
              ))}
            </List>
          ) : (
            <Text size="sm" c="var(--nivra-text-3)">
              None written.
            </Text>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

/** One mission: its versions, its backlog and board, and its reviews. */
export function MissionDetail({ missionId, onOpenTask, onDeleted }: { missionId: string; onOpenTask(taskId: string): void; onDeleted(): void }) {
  const opened = useRef(false);
  const mission = usePoll<MissionView>(
    async () => {
      // The first read follows a review an earlier session left open (D26); later reads only read.
      if (opened.current) return window.nivra.getMission(missionId);
      const view = await window.nivra.openMission(missionId);
      opened.current = true;
      return view;
    },
    (view) => (view?.reviewing ? 700 : 5_000),
    [missionId],
  );
  const [editing, setEditing] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = mission.value;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      mission.refresh();
    }
  };

  if (!view) {
    return (
      <Section title="Mission">
        <Text size="sm" c={mission.error ? "var(--nivra-error)" : "var(--nivra-text-3)"}>
          {mission.error ?? "Opening the mission…"}
        </Text>
      </Section>
    );
  }
  const { content } = view.latest;
  const reviewable = new Set(view.backlog.filter((entry) => entry.unreviewable === null).map((entry) => entry.task.id));
  const chosen = selected.filter((id) => reviewable.has(id));
  const full = chosen.length >= MAX_SELECTED;
  const toggle = (taskId: string) => setSelected((current) => (current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]));

  return (
    <Stack gap="md">
      <Section
        title={content.name}
        description={`Mission v${view.latest.version}. What it's for, and the tasks that should get it there. Nothing here changes a task: you do, on its own page.`}
        actions={
          <Group gap="xs">
            <Button size="xs" variant="light" onClick={() => setEditing(draftOf(content))} disabled={editing !== null} data-testid="mission-edit">
              Edit mission
            </Button>
            <Button size="xs" variant="subtle" color="red" onClick={() => setDeleting(true)} data-testid="mission-delete">
              Delete
            </Button>
          </Group>
        }
      >
        {editing ? (
          <Stack gap="sm" data-testid="mission-editing">
            <MissionForm draft={editing} onChange={setEditing} />
            <Group gap="xs">
              <Button
                size="xs"
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    await window.nivra.reviseMission(missionId, view.latest.version, contentOf(editing));
                    setEditing(null);
                  })
                }
                data-testid="mission-save"
              >
                Save as v{view.latest.version + 1}
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
            </Group>
          </Stack>
        ) : (
          <MissionRead content={content} />
        )}
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="mission-error">
            {error}
          </Text>
        )}
      </Section>

      <Section title="Backlog" description="The tasks for this mission. Select up to five to review against it. Each opens on its own page, where you edit it.">
        {view.backlog.length === 0 && (
          <Text size="sm" c="var(--nivra-text-3)" data-testid="backlog-empty">
            No tasks yet. Add one below.
          </Text>
        )}
        <Stack gap={6}>
          {view.backlog.map(({ task, unreviewable }) => (
            <Group key={task.id} gap="xs" wrap="nowrap" data-testid="backlog-row" data-task-id={task.id}>
              <Checkbox
                checked={chosen.includes(task.id)}
                disabled={unreviewable !== null || (full && !chosen.includes(task.id))}
                onChange={() => toggle(task.id)}
                aria-label={`Select ${task.title}`}
                data-testid="backlog-select"
              />
              <Anchor component="button" size="sm" onClick={() => onOpenTask(task.id)} data-testid="backlog-open">
                {task.title}
              </Anchor>
              <Badge color={STATE_LOOK[task.state].color} variant="light" size="sm">
                {STATE_LOOK[task.state].label}
              </Badge>
              <Text size="xs" c="var(--nivra-text-3)" data-testid="backlog-note">
                brief v{task.briefVersion}
                {unreviewable ? ` · ${unreviewable}` : ""}
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={() => void act(() => window.nivra.removeMissionTask(missionId, task.id))} data-testid="backlog-remove">
                Remove
              </Button>
            </Group>
          ))}
        </Stack>
        <Group gap="xs" align="flex-end">
          <TextInput size="xs" label="A new task" placeholder="Its title" value={newTitle} onChange={(event) => setNewTitle(event.currentTarget.value)} data-testid="backlog-new-title" />
          <Button
            size="xs"
            variant="light"
            disabled={!newTitle.trim()}
            loading={busy}
            onClick={() =>
              void act(async () => {
                await window.nivra.createMissionTask(missionId, newTitle);
                setNewTitle("");
              })
            }
            data-testid="backlog-new"
          >
            Add task
          </Button>
          {view.available.length > 0 && (
            <Select
              size="xs"
              label="An existing task"
              placeholder="Choose one"
              data={view.available.map((task) => ({ value: task.id, label: task.title }))}
              value={null}
              onChange={(taskId) => {
                if (taskId) void act(() => window.nivra.addMissionTask(missionId, taskId));
              }}
              data-testid="backlog-add-existing"
            />
          )}
        </Group>
        <Group gap="xs">
          <Button size="sm" onClick={() => setReviewing(true)} disabled={chosen.length === 0 || view.reviewing} data-testid="mission-review-open">
            Review {chosen.length || ""} selected…
          </Button>
          <Text size="xs" c="var(--nivra-text-3)" data-testid="mission-review-note">
            {view.reviewing ? "A review of this mission is going." : full ? "Five is the most one review takes." : "Two reviewers, then the chair: up to 3 model calls."}
          </Text>
        </Group>
      </Section>

      <Section title="Board" description="The backlog by state. Active and In review come from a task's runs; you mark a task ready or complete on its own page.">
        <Board backlog={view.backlog} onOpenTask={onOpenTask} />
      </Section>

      <Section title="Reviews" description="Each review keeps what it was sent. When the mission or a task changes, it says so, and stays as it was.">
        {view.reviews.length === 0 ? (
          <Text size="sm" c="var(--nivra-text-3)" data-testid="mission-reviews-empty">
            No reviews yet.
          </Text>
        ) : (
          view.reviews.map((review) => (
            <MissionReviewCard
              key={review.id}
              review={review}
              online={view.engine.state.status === "online"}
              onOpenTask={onOpenTask}
              onCancel={() => void act(() => window.nivra.cancelMissionReview(missionId, review.id))}
              onReviewAgain={() => {
                setSelected(review.tasks.filter((task) => task.present).map((task) => task.taskId));
                setReviewing(true);
              }}
            />
          ))
        )}
      </Section>

      <ReviewDialog missionId={missionId} selected={chosen} opened={reviewing} onClose={() => setReviewing(false)} onStarted={() => mission.refresh()} />
      <Modal opened={deleting} onClose={() => setDeleting(false)} title="Delete this mission?" data-testid="mission-delete-dialog">
        <Stack gap="sm">
          <Text size="sm">Its versions, backlog and reviews go. Its tasks stay, in no mission. A review still going is stopped first. Each engine keeps its own record of the reviews it ran.</Text>
          <Group gap="xs">
            <Button
              color="red"
              size="xs"
              loading={busy}
              onClick={() =>
                void act(async () => {
                  await window.nivra.deleteMission(missionId);
                  onDeleted();
                })
              }
              data-testid="mission-delete-confirm"
            >
              Delete mission
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setDeleting(false)}>
              Keep it
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
