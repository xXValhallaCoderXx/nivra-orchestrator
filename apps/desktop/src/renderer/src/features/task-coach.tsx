import { Alert, Badge, Button, Checkbox, Code, Group, List, Modal, Paper, Stack, Text } from "@mantine/core";
import type { CoachField, CoachQuestionField, CoachReport, PreferenceIntent, PreferenceScope } from "@nivra/domain";
import { useEffect, useRef, useState } from "react";
import { COACH_FIELD_LABELS, type CoachChangeView, type CoachingView, type CoachPreview, type CoachSelection } from "../../../shared/coach";
import type { BriefContent, TaskView, TurnStatus } from "../../../shared/ipc";
import { PreviewGuard } from "../../../shared/preview-guard";
import { NO_GAPS, NO_GAPS_DETAIL, taskGuidance, type GuidanceItem } from "../../../shared/task-guidance";
import { plural, runBudgetText } from "../shared/evidence";
import { errorMessage } from "../shared/ui";
import { BriefDiff } from "./brief-diff";

/**
 * Preparing a task (NIV-53): what its brief is missing, worked out without a model, and the task readiness coach, asked
 * for by the person. The dialog shows exactly what the coach reads, and starting is bound to that preview. A coaching's
 * questions point to the field that answers them, in the existing editor; its proposed changes are saved only when the
 * person ticks them, as a new brief version. Suggested checks are text to read and copy, never acceptance cases.
 * Everything here is model output, shown as plain text, and nothing reads as approval.
 */

export interface TaskCoachProps {
  task: TaskView;
  /** The task's coachings, newest first; null while they are being read. */
  coachings: CoachingView[] | null;
  /** Whether the brief editor is open, holding edits that aren't saved yet. */
  editing: boolean;
  onPrepare(selection: CoachSelection): Promise<CoachPreview>;
  onStart(selection: CoachSelection, expected: string): Promise<CoachingView>;
  onCancel(coachingId: string): Promise<void>;
  onAccept(coachingId: string, fields: CoachField[]): Promise<void>;
  /** Opens the brief editor, or uses the open one, at this field. */
  onUpdateField(field: CoachQuestionField): void;
  /** Why a question's Update can't open the editor now (a save going, another edit open); null when it can. */
  updateBlocked: string | null;
  /** Whether a save of the coach's changes is going: the brief editor waits for it. */
  onSavingChange(saving: boolean): void;
}

export const isOpenCoaching = (coaching: CoachingView) => coaching.status === "submitting" || coaching.status === "running";

const STATUS_LOOK: Record<TurnStatus, { label: string; color: string }> = {
  submitting: { label: "Sending", color: "gray" },
  running: { label: "Reading the brief", color: "blue" },
  // Answered is about the run, never the brief: no green.
  answered: { label: "Answered", color: "indigo" },
  failed: { label: "Failed", color: "red" },
  cancelled: { label: "Cancelled", color: "gray" },
  interrupted: { label: "Interrupted", color: "yellow" },
  "not-sent": { label: "Not sent", color: "gray" },
  unknown: { label: "Can't tell", color: "yellow" },
};

const TIER_LOOK: Record<GuidanceItem["tier"], { label: string; color: string }> = {
  needed: { label: "Needed", color: "orange" },
  "could-help": { label: "Could help", color: "gray" },
  "before-run": { label: "Only to run it", color: "gray" },
};

const PROFILE_NAMES: Readonly<Record<string, string>> = { "task-readiness-coach": "Task readiness coach" };
const profileName = (profile: { id: string; version: number }) => `${PROFILE_NAMES[profile.id] ?? profile.id} v${profile.version}`;

const preferenceKind = (preference: { scope: PreferenceScope; intent: PreferenceIntent }) =>
  preference.scope === "personal" ? "Your personal default" : preference.intent === "override" ? "Project decision, which outranks the repository's conventions" : "Project default";

const plain = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

const joined = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/** What the engine set aside from an answer, in words; null when it set nothing aside. */
function droppedText(dropped: CoachReport["dropped"]): string | null {
  const parts = [
    [dropped.questions, "question"],
    [dropped.changes, "change"],
    [dropped.items, "item"],
    [dropped.refs, "reference"],
    [dropped.checks, "suggested check"],
    [dropped.unknowns, "unknown"],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, noun]) => plural(count as number, noun as string));
  return parts.length ? `Nivra set aside ${joined(parts)} from the coach's answer: they didn't fit its form, or named something the brief doesn't have.` : null;
}

/** The brief's guidance, an Ask the coach button, and the task's coachings, newest first. */
export function TaskCoach({ task, coachings, editing, onPrepare, onStart, onCancel, onAccept, onUpdateField, updateBlocked, onSavingChange }: TaskCoachProps) {
  const [dialog, setDialog] = useState(false);
  const open = coachings?.find(isOpenCoaching) ?? null;
  const askBlocked =
    task.summary.state === "completed" ? "Reopen the task to ask the coach about it." : open ? "The coach is still answering. Wait for it, or cancel it, then ask again." : null;
  return (
    <Stack gap="sm" data-testid="task-coach">
      <Guidance brief={task.brief.content} />
      <Group gap="sm">
        <Button size="xs" variant="default" onClick={() => setDialog(true)} disabled={askBlocked !== null} title={askBlocked ?? undefined} data-testid="coach-ask">
          Ask the coach…
        </Button>
        {askBlocked && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="coach-ask-blocked">
            {askBlocked}
          </Text>
        )}
      </Group>
      {coachings === null ? (
        <Text size="sm" c="var(--nivra-text-3)">
          Reading this task's coaching…
        </Text>
      ) : (
        coachings.map((coaching, index) => (
          <CoachingCard
            key={coaching.id}
            coaching={coaching}
            collapsed={index > 0}
            editing={editing}
            askBlocked={askBlocked}
            onAskAgain={() => setDialog(true)}
            onCancel={onCancel}
            onAccept={onAccept}
            onUpdateField={onUpdateField}
            updateBlocked={updateBlocked}
            onSavingChange={onSavingChange}
          />
        ))
      )}
      <CoachDialog opened={dialog} briefVersion={task.brief.version} projectId={task.summary.projectId} editing={editing} onClose={() => setDialog(false)} onPrepare={onPrepare} onStart={onStart} />
    </Stack>
  );
}

/** What the brief is missing, by Nivra's own rules: needed first, at most three that could help, then what only a run needs. */
function Guidance({ brief }: { brief: BriefContent }) {
  const { items, held } = taskGuidance(brief);
  const gaps = items.filter((item) => item.tier !== "before-run");
  const beforeRun = items.filter((item) => item.tier === "before-run");
  return (
    <Stack gap="xs" data-testid="coach-guidance">
      {gaps.length === 0 ? (
        <Stack gap={2} data-testid="coach-no-gaps">
          <Text size="sm" fw={600}>
            {NO_GAPS}
          </Text>
          <Text size="xs" c="var(--nivra-text-3)">
            {NO_GAPS_DETAIL}
          </Text>
        </Stack>
      ) : (
        gaps.map((item, index) => <GuidanceRow key={`${item.code}-${item.item ?? index}`} item={item} />)
      )}
      {held > 0 && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="coach-guidance-held">
          Nivra shows at most three suggestions at a time.
        </Text>
      )}
      {beforeRun.length > 0 && (
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Before you run it
          </Text>
          {beforeRun.map((item) => (
            <GuidanceRow key={item.code} item={item} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function GuidanceRow({ item }: { item: GuidanceItem }) {
  const look = TIER_LOOK[item.tier];
  return (
    <Stack gap={2} data-testid="coach-guidance-item" data-code={item.code} data-tier={item.tier}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Badge size="sm" color={look.color} variant="light">
          {look.label}
        </Badge>
        <Text size="sm" fw={600} style={plain}>
          {item.missing}
        </Text>
      </Group>
      <Text size="xs" c="var(--nivra-text-2)">
        {item.why} {item.how}
      </Text>
    </Stack>
  );
}

/**
 * Previews a coaching: exactly the text the coach reads, the task's mission and findings the person may add, the
 * preferences that go with it, and its bounds. Start sends exactly what the preview showed: when that changed
 * meanwhile, starting is refused, and the new preview is shown.
 */
function CoachDialog({
  opened,
  briefVersion,
  projectId,
  editing,
  onClose,
  onPrepare,
  onStart,
}: {
  opened: boolean;
  briefVersion: number;
  /** The task's project: another one, or none, means another scope and engine, so the preview is made again. */
  projectId: string | null;
  editing: boolean;
  onClose(): void;
  onPrepare(selection: CoachSelection): Promise<CoachPreview>;
  onStart(selection: CoachSelection, expected: string): Promise<CoachingView>;
}) {
  const [selection, setSelection] = useState<CoachSelection>({ mission: false, findings: [] });
  // The preview, with the selection it was made from: Start sends exactly that selection.
  const [previewed, setPreviewed] = useState<{ preview: CoachPreview; selection: CoachSelection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Drops a preview asked for before the latest change, or before a later request, when it arrives.
  const guard = useRef(new PreviewGuard());

  /** Previews `chosen`, shown only while nothing changed since `mine` was asked for. */
  async function prepare(mine: number, chosen: CoachSelection) {
    setError(null);
    try {
      const value = await onPrepare(chosen);
      if (guard.current.current(mine)) setPreviewed({ preview: value, selection: chosen });
    } catch (reason) {
      if (guard.current.current(mine)) setError(errorMessage(reason));
    }
  }

  useEffect(() => {
    if (!opened) return;
    const fresh: CoachSelection = { mission: false, findings: [] };
    guard.current.changed();
    setSelection(fresh);
    setPreviewed(null);
    setError(null);
    void prepare(guard.current.asked(), fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, briefVersion, projectId]);

  /** Any change makes the preview stale: it is cleared, one still on its way is dropped, and a new one is asked for. */
  function choose(next: CoachSelection) {
    guard.current.changed();
    setSelection(next);
    setPreviewed(null);
    void prepare(guard.current.asked(), next);
  }

  async function start() {
    if (!previewed) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(previewed.selection, previewed.preview.expected);
      onClose();
    } catch (reason) {
      // Whatever stopped it, the preview is read again, so what is shown is what a new start would send.
      setError(errorMessage(reason));
      guard.current.changed();
      setPreviewed(null);
      void prepare(guard.current.asked(), previewed.selection);
    } finally {
      setBusy(false);
    }
  }

  const preview = previewed?.preview ?? null;
  const ticked = (reviewId: string, findingId: string) => selection.findings.some((finding) => finding.reviewId === reviewId && finding.findingId === findingId);
  return (
    <Modal opened={opened} onClose={onClose} title={`Ask the coach about brief v${preview?.briefVersion ?? briefVersion}`} size="lg" data-testid="coach-dialog">
      <Stack gap="sm">
        {preview ? (
          <Stack gap="xs" data-testid="coach-preview" data-brief-version={preview.briefVersion}>
            <Text size="sm" c="var(--nivra-text-2)" data-testid="coach-preview-scope">
              {preview.scope.kind === "general"
                ? "A task with no repository."
                : `${preview.scope.projectLabel} · ${preview.scope.targetLabel} · sharing ${preview.scope.sharing ? "on" : "off"}`}
            </Text>
            <Text size="sm" data-testid="coach-preview-profile">
              {preview.profile.name}, version {preview.profile.version}: patient, precise, encouraging and concise. It asks at most three questions and proposes
              changes you choose from. It runs nothing and changes nothing by itself.
            </Text>
            {(preview.options.mission || preview.options.findings.length > 0) && (
              <Stack gap={4} data-testid="coach-preview-options">
                <Text size="sm" fw={600}>
                  Add context, if you want
                </Text>
                {preview.options.mission && (
                  <Checkbox
                    label={`The task's mission: ${preview.options.mission.name} (v${preview.options.mission.version})`}
                    checked={selection.mission}
                    onChange={(event) => choose({ ...selection, mission: event.currentTarget.checked })}
                    data-testid="coach-option-mission"
                  />
                )}
                {preview.options.findings.map((finding) => (
                  <Checkbox
                    key={`${finding.reviewId}:${finding.findingId}`}
                    label={`${finding.title}${finding.reviewedBriefVersion !== null ? ` (its review read brief v${finding.reviewedBriefVersion})` : ""}`}
                    checked={ticked(finding.reviewId, finding.findingId)}
                    onChange={(event) =>
                      choose({
                        ...selection,
                        findings: event.currentTarget.checked
                          ? [...selection.findings, { reviewId: finding.reviewId, findingId: finding.findingId }]
                          : selection.findings.filter((chosen) => !(chosen.reviewId === finding.reviewId && chosen.findingId === finding.findingId)),
                      })
                    }
                    data-testid="coach-option-finding"
                    data-finding-id={finding.findingId}
                  />
                ))}
              </Stack>
            )}
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                Exactly what the coach reads
              </Text>
              <Code block fz="xs" style={{ ...plain, maxHeight: 280, overflowY: "auto", userSelect: "text" }} data-testid="coach-preview-text">
                {preview.text}
              </Code>
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                Sent to Nebius Token Factory
              </Text>
              <List size="sm" data-testid="coach-preview-sends">
                {preview.sends.map((line, index) => (
                  <List.Item key={index}>{line}</List.Item>
                ))}
                <List.Item>
                  {preview.preferences.length ? `${plural(preview.preferences.length, "preference")} that apply:` : "No preferences: none of yours apply."}
                  {preview.preferences.length > 0 && (
                    <List size="sm" withPadding data-testid="coach-preview-preferences">
                      {preview.preferences.map((preference, index) => (
                        <List.Item key={index}>
                          <Text size="sm" span fw={600}>
                            {preferenceKind(preference)}:
                          </Text>{" "}
                          {preference.statement}
                        </List.Item>
                      ))}
                    </List>
                  )}
                </List.Item>
              </List>
            </Stack>
            <Stack gap={2} data-testid="coach-preview-not-sent">
              <Text size="sm" fw={600}>
                Not sent
              </Text>
              <List size="sm">
                {preview.notSent.map((line, index) => (
                  <List.Item key={index}>{line}</List.Item>
                ))}
              </List>
            </Stack>
            <Text size="sm" data-testid="coach-preview-limits">
              One model listing and {plural(preview.limits.requests, "model request")}, nothing retried. Up to {preview.limits.requestSeconds} seconds for the answer and{" "}
              {preview.limits.totalSeconds} seconds in all, and up to {plural(preview.limits.outputTokens, "output token")}. An estimated{" "}
              {plural(preview.limits.estimatedInputTokens, "input token")}: an estimate, not a cap (the coach takes up to {preview.limits.budgetTokens.toLocaleString()}).
            </Text>
            <Text size="xs" c="var(--nivra-text-3)" data-testid="coach-preview-keeps">
              {preview.keeps}
            </Text>
          </Stack>
        ) : (
          !error && (
            <Text size="sm" c="var(--nivra-text-3)">
              Working out what the coach would read…
            </Text>
          )
        )}
        {editing && (
          <Alert color="yellow" variant="light" data-testid="coach-preview-unsaved">
            <Text size="sm">Your unsaved edits aren't included. Save them first to include them.</Text>
          </Alert>
        )}
        {preview?.blocked && (
          <Alert color="yellow" variant="light" data-testid="coach-preview-blocked">
            <Text size="sm">{preview.blocked}</Text>
          </Alert>
        )}
        {error && (
          <Alert color="red" variant="light" data-testid="coach-preview-error">
            <Text size="sm">{error}</Text>
          </Alert>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} data-testid="coach-dialog-cancel">
            Cancel
          </Button>
          <Button onClick={() => void start()} loading={busy} disabled={!preview || preview.blocked !== null} data-testid="coach-start">
            Ask the coach
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** One coaching: how its run went, the coach's answer, and the changes the person may tick and save. */
function CoachingCard({
  coaching,
  collapsed,
  editing,
  askBlocked,
  onAskAgain,
  onCancel,
  onAccept,
  onUpdateField,
  updateBlocked,
  onSavingChange,
}: {
  coaching: CoachingView;
  collapsed: boolean;
  editing: boolean;
  askBlocked: string | null;
  onAskAgain(): void;
  onCancel(coachingId: string): Promise<void>;
  onAccept(coachingId: string, fields: CoachField[]): Promise<void>;
  onUpdateField(field: CoachQuestionField): void;
  updateBlocked: string | null;
  onSavingChange(saving: boolean): void;
}) {
  const [shown, setShown] = useState(!collapsed);
  const [ticked, setTicked] = useState<CoachField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = isOpenCoaching(coaching);
  const report = coaching.report;
  // An answer set aside entirely, or none at all, ends its run as failed: the label says which.
  const look =
    !open && report?.outcome === "unusable" ? { label: "Unusable", color: "orange" } : !open && report?.outcome === "empty" ? { label: "Empty", color: "gray" } : STATUS_LOOK[coaching.status];
  const stale = coaching.stale.length > 0;
  const applied = coaching.applied;
  // Only changes that may be saved count, whatever was ticked before one became blocked.
  const chosen = ticked.filter((field) => coaching.changes.some((change) => change.field === field && change.blocked === null));
  const saveBlocked = editing
    ? "Save or cancel your brief edits first."
    : stale
      ? "Something the coach read has changed since, as the lines below say, so these suggestions can't be saved. Ask the coach again for the task as it is now."
      : chosen.length === 0
        ? "Tick the changes you want to save."
        : null;

  async function cancel() {
    setError(null);
    try {
      await onCancel(coaching.id);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    onSavingChange(true);
    try {
      await onAccept(coaching.id, chosen);
    } catch (reason) {
      // The ticks stay, so the person can see what didn't save and try again.
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      onSavingChange(false);
    }
  }

  const toggle = (field: CoachField, on: boolean) => setTicked((current) => (on ? [...current.filter((one) => one !== field), field] : current.filter((one) => one !== field)));

  return (
    <Paper withBorder p="sm" radius="md" data-testid="coaching" data-coaching-id={coaching.id} data-status={coaching.status} data-brief-version={coaching.briefVersion}>
      <Stack gap={8}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Text size="xs" fw={600}>
              {profileName(coaching.profile)} · read brief v{coaching.briefVersion}
            </Text>
            <Badge color={look.color} variant="light" data-testid="coaching-status">
              {open && coaching.cancelRequested ? "Cancelling" : look.label}
            </Badge>
          </Group>
          <Group gap={4} wrap="nowrap">
            {open ? (
              <Button size="compact-xs" variant="default" onClick={() => void cancel()} disabled={coaching.cancelRequested} data-testid="coach-cancel">
                Cancel
              </Button>
            ) : (
              collapsed && (
                <Button size="compact-xs" variant="subtle" onClick={() => setShown((on) => !on)} data-testid="coaching-toggle">
                  {shown ? "Hide" : "Show"}
                </Button>
              )
            )}
          </Group>
        </Group>
        {coaching.note && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="coaching-note">
            {coaching.note}
          </Text>
        )}
        {coaching.unresolved && (
          <Text size="sm" c="var(--nivra-warning)" data-testid="coaching-unresolved">
            {coaching.unresolved}
          </Text>
        )}
        {error && (
          <Alert color="red" variant="light" data-testid="coaching-error">
            <Text size="sm">{error}</Text>
          </Alert>
        )}
        {shown && report && (
          <>
            {report.outcome === "unusable" && (
              <Text size="sm" data-testid="coach-unusable">
                Nivra set aside everything in the coach's answer, so none of it can be used. Your brief is unchanged.
              </Text>
            )}
            {report.outcome === "empty" && (
              <Text size="sm" data-testid="coach-empty">
                The coach handed in nothing to use. Your brief is unchanged.
              </Text>
            )}
            {report.outcome === "complete" && report.changes.length === 0 && (
              <Text size="sm" fw={600} data-testid="coach-no-changes">
                No changes proposed
              </Text>
            )}
            {report.summary.trim() && (
              <Text size="sm" style={plain} data-testid="coach-summary">
                {report.summary}
              </Text>
            )}
            {report.questions.length > 0 && (
              <Stack gap={6}>
                <Text size="sm" fw={600}>
                  {report.questions.length === 1 ? "A question" : "Questions"}
                </Text>
                {report.questions.map((question) => (
                  <Stack key={question.id} gap={2} data-testid="coach-question" data-field={question.field}>
                    <Text size="sm" style={plain}>
                      {question.text}
                    </Text>
                    {question.why.trim() && (
                      <Text size="xs" c="var(--nivra-text-2)" style={plain}>
                        {question.why}
                      </Text>
                    )}
                    <Group>
                      <Button
                        size="compact-xs"
                        variant="default"
                        onClick={() => onUpdateField(question.field)}
                        disabled={updateBlocked !== null}
                        title={updateBlocked ?? undefined}
                        data-testid="coach-update-field"
                        data-field={question.field}
                      >
                        Update {COACH_FIELD_LABELS[question.field].toLowerCase()}
                      </Button>
                      {updateBlocked && (
                        <Text size="xs" c="var(--nivra-text-3)" data-testid="coach-update-blocked">
                          {updateBlocked}
                        </Text>
                      )}
                    </Group>
                  </Stack>
                ))}
              </Stack>
            )}
            {coaching.changes.length > 0 && (
              <Stack gap={8}>
                <Text size="sm" fw={600}>
                  Proposed changes
                </Text>
                {coaching.changes.map((change) => (
                  <ChangeRow
                    key={change.field}
                    change={change}
                    ticked={ticked.includes(change.field)}
                    locked={applied !== null || stale || busy}
                    onTick={(on) => toggle(change.field, on)}
                  />
                ))}
              </Stack>
            )}
            {report.unknowns.length > 0 && (
              <Stack gap={2} data-testid="coach-unknowns">
                <Text size="sm" fw={600}>
                  What the coach couldn't tell
                </Text>
                <List size="sm">
                  {report.unknowns.map((unknown, index) => (
                    <List.Item key={index} style={plain}>
                      {unknown}
                    </List.Item>
                  ))}
                </List>
              </Stack>
            )}
            {report.suggestedChecks.map((check, index) => (
              <Stack key={index} gap={4} data-testid="coach-check">
                <Text size="sm" fw={600}>
                  Suggested check — not run.
                </Text>
                <Code block fz="xs" style={{ ...plain, userSelect: "text" }} data-testid="coach-check-text">
                  {`${check.name}\n$ ${check.command}\nExpected output: ${check.expectedOutput || "(nothing)"}\nExit code: ${check.expectedExitCode ?? "not given"}`}
                </Code>
                {check.reason.trim() && (
                  <Text size="xs" c="var(--nivra-text-2)" style={plain}>
                    {check.reason}
                  </Text>
                )}
                <Text size="xs" c="var(--nivra-text-3)">
                  Nivra hasn't run or checked it, and it isn't part of the brief. To use it, add it as an acceptance case yourself.
                </Text>
              </Stack>
            ))}
            {droppedText(report.dropped) && (
              <Text size="xs" c="var(--nivra-text-2)" data-testid="coach-dropped">
                {droppedText(report.dropped)}
              </Text>
            )}
          </>
        )}
        {shown && stale && (
          <Alert color="yellow" variant="light" data-testid="coach-stale">
            <Stack gap={6}>
              {coaching.stale.map((line, index) => (
                <Text key={index} size="sm">
                  {line}
                </Text>
              ))}
              <Group>
                <Button size="xs" variant="default" onClick={onAskAgain} disabled={askBlocked !== null} title={askBlocked ?? undefined} data-testid="coach-ask-again">
                  Ask again
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
        {applied && (
          <Text size="sm" data-testid="coach-applied">
            Saved as v{applied.briefVersion} with {applied.fields.length} of {plural(coaching.changes.length, "change")}.
          </Text>
        )}
        {shown &&
          coaching.notes.map((note, index) => (
            <Text key={index} size="xs" c="var(--nivra-text-2)" data-testid="coaching-notes">
              {note}
            </Text>
          ))}
        {shown && !applied && coaching.changes.length > 0 && (
          <Group gap="sm">
            <Button size="xs" onClick={() => void save()} loading={busy} disabled={saveBlocked !== null} title={saveBlocked ?? undefined} data-testid="coach-save">
              {chosen.length ? `Save ${plural(chosen.length, "change")} as v${coaching.latestVersion + 1}` : `Save changes as v${coaching.latestVersion + 1}`}
            </Button>
            {saveBlocked && (
              <Text size="xs" c="var(--nivra-text-3)" data-testid="coach-save-blocked">
                {saveBlocked}
              </Text>
            )}
          </Group>
        )}
        {shown && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="coach-not-approval">
            The coach's suggestions change your brief only when you save them. Saving makes a new version: it doesn't mark the task ready or run anything.
          </Text>
        )}
        {shown && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="coaching-binding">
            Read brief v{coaching.briefVersion}
            {coaching.sent.mission ? `, the mission ${coaching.sent.mission.name} (v${coaching.sent.mission.version})` : ""}
            {coaching.sent.findings ? `, ${plural(coaching.sent.findings, "finding")}` : ""} and {plural(coaching.sent.preferences, "preference")}.
            {coaching.latestVersion > coaching.briefVersion ? ` The brief is now at v${coaching.latestVersion}.` : ""}
          </Text>
        )}
        {shown && report && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="coaching-usage">
            {report.route ? `${report.route.model}${report.route.endpoint === "loopback-test" ? " (test endpoint)" : ""}` : "Model unknown"} · {(report.elapsedMs / 1000).toFixed(1)} s ·{" "}
            {report.usage.inputTokens !== null && report.usage.outputTokens !== null
              ? `${report.usage.inputTokens.toLocaleString()} in / ${report.usage.outputTokens.toLocaleString()} out tokens, as reported`
              : "tokens not reported"}
            . {runBudgetText(report.budget)}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/** One proposed change: its field before and after, why, what it names, and a tick box unless it can't be saved. */
function ChangeRow({ change, ticked, locked, onTick }: { change: CoachChangeView; ticked: boolean; locked: boolean; onTick(on: boolean): void }) {
  const { reason, refs } = change.change;
  return (
    <Stack gap={4} data-testid="coach-change" data-field={change.field} style={{ borderLeft: "3px solid var(--nivra-border)", paddingLeft: 8 }}>
      <Checkbox
        label={COACH_FIELD_LABELS[change.field]}
        checked={ticked && change.blocked === null}
        disabled={change.blocked !== null || locked}
        onChange={(event) => onTick(event.currentTarget.checked)}
        data-testid="coach-change-tick"
      />
      {change.blocked && (
        <Text size="xs" c="var(--nivra-warning)" data-testid="coach-change-blocked">
          {change.blocked}
        </Text>
      )}
      <BriefDiff before={change.before} after={change.after} />
      {reason.trim() && (
        <Text size="xs" c="var(--nivra-text-2)" style={plain} data-testid="coach-change-reason">
          {reason}
        </Text>
      )}
      {refs.length > 0 && (
        <Group gap={4}>
          {refs.map((ref) => (
            <Badge key={ref} size="xs" variant="outline" color="gray" data-testid="coach-change-ref">
              {ref}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  );
}
