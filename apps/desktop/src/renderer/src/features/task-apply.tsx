import { Alert, Badge, Button, Code, Group, Modal, Stack, Table, Text, Textarea } from "@mantine/core";
import type { ApplyPath, ApplyResolution, ApplyStatus, TaskReport } from "@nivra/domain";
import { useState } from "react";
import type { AttemptDecision, TaskApplyView, TaskAttemptView, TaskView, TurnStatus } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

/**
 * Deciding on a run's change, and what applying it did (D40). The window offers exactly what the host says the person
 * may do now (`actions`): approve a verified change by its hash, reject it, or ask for a revision; then accept an
 * applied change, dismiss one that wasn't applied, or restore or keep one applied in part. What the apply did is shown
 * file by file, in the engine's words for a refusal, and never claims more than the engine reported.
 */

const short = (id: string) => id.slice(0, 12);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");
const sizeText = (bytes: number) => (bytes < 1024 ? `${bytes} ${bytes === 1 ? "byte" : "bytes"}` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/** An apply's state, in plain words. */
const APPLY_STATE: Record<ApplyStatus, string> = {
  claimed: "Nivra is checking the proposal and your checkout again, before it writes anything.",
  writing: "Nivra is applying the change.",
  refused: "The change wasn't applied, and nothing was written.",
  applied: "The change is applied to your checkout. Nothing is staged or committed.",
  "not-applied": "The change isn't applied: none of it is in your checkout.",
  partial: "The change is applied in part: some files are as the change leaves them, the rest as they were.",
  unknown: "Nivra can't tell where every file is. Each one is listed below, with the copies it kept.",
};

const APPLY_COLOR: Record<ApplyStatus, string> = { claimed: "blue", writing: "blue", refused: "gray", applied: "green", "not-applied": "gray", partial: "yellow", unknown: "yellow" };
const APPLY_BADGE: Record<ApplyStatus, string> = { claimed: "Checking", writing: "Applying", refused: "Refused", applied: "Applied", "not-applied": "Not applied", partial: "Applied in part", unknown: "Unknown" };

/** Where a path is, in plain words. */
function placeText(path: ApplyPath): string {
  switch (path.place) {
    case "post":
      return "as the change leaves it";
    case "pre":
      return "as it was";
    case "aside":
      return "moved aside: its original is kept, and nothing is in its place";
    case "theirs":
      return path.changedSince ? "another program's version, saved after Nivra wrote it, kept as it is" : "another program's version, saved before Nivra wrote it, kept as it is";
    case "other":
      return "unknown";
  }
}

/** What is at a path now. */
function foundText(found: ApplyPath["found"]): string {
  switch (found.kind) {
    case "absent":
      return "nothing there";
    case "file":
      return `a file${found.mode === "100755" ? ", executable" : ""}${found.size !== null ? `, ${sizeText(found.size)}` : ""}`;
    case "link":
      return "a link";
    case "folder":
      return "a folder";
    case "other":
      return "something else";
  }
}

/** What each way of settling an apply does, said beside its button. */
const SETTLE: Record<"accept" | "dismiss" | "restore" | "keep", { label: string; says: string; testid: string }> = {
  accept: { label: "Accept the change", says: "The task is completed. Nivra removes the copies it kept that are still your original or its own; your checkout stays as it is.", testid: "task-apply-accept" },
  dismiss: { label: "Dismiss", says: "Closes this result. Nivra removes the copies it kept that are still your original or its own, and keeps any other.", testid: "task-apply-dismiss" },
  restore: { label: "Restore the originals", says: "Puts each original back where the change replaced it, never over a version another program saved. Nothing else in your checkout changes.", testid: "task-apply-restore" },
  keep: { label: "Keep as is", says: "Leaves your checkout as it is now. Nivra removes the copies it kept that are still your original or its own.", testid: "task-apply-keep" },
};

const RESOLVED: Record<ApplyResolution, string> = {
  accepted: "You accepted the change. The task is completed.",
  dismissed: "You dismissed this result.",
  kept: "You kept the change as it is.",
};

/** What the writer was doing when it stopped, in plain words, from its step's name; the step itself is kept beside it. */
function stepText(step: string): string {
  const doing: Array<[RegExp, string]> = [
    [/^temp /, "writing a new file into the recovery folder"],
    [/^sync recovery$/, "making the recovery folder's files durable"],
    [/^folder /, "making a folder"],
    [/^aside /, "moving a file aside"],
    [/^put back /, "putting a file back"],
    [/^changed /, "finding that a file changed after it was checked"],
    [/^link /, "putting a new file in place"],
    [/^sync$/, "making the change durable"],
    [/^read back$/, "reading the change back"],
    [/^(take back|restore) /, "putting an original back"],
    [/^remove folder /, "removing a folder it made"],
    [/^interrupted$/, "applying, when its engine stopped"],
    [/^reconcile$/, "reading where each file is, after its engine stopped"],
  ];
  return doing.find(([pattern]) => pattern.test(step))?.[1] ?? "applying the change";
}

/** Error codes a person can act on, in plain words; any other is shown as its code. */
const ERROR_WORDS: Record<string, string> = { changed: "a file changed after Nivra checked it", ENOSPC: "the disk is full", EACCES: "permission was denied", EPERM: "the operation isn't permitted", EBUSY: "a file was busy", EIO: "the disk reported an error", EXDEV: "a file was on another disk", EEXIST: "something was already there" };

/** An apply that hasn't ended yet, or whose engine can't be read: read again while that lasts. */
export const applyGoing = (apply: TaskApplyView | null) => apply !== null && (apply.status === null || apply.status === "claimed" || apply.status === "writing" || apply.unresolved !== null);

/**
 * The person's decision on a run's change: approve it by its hash, reject it, or ask for a revision; or what was
 * decided. `act` runs one of the host's calls and reads the run again.
 */
export function Decision({ value, busy, act }: { value: TaskAttemptView; busy: boolean; act(work: () => Promise<TaskAttemptView>): void }) {
  const [confirming, setConfirming] = useState(false);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const { report, proposal, actions, decision } = value;
  const can = (action: TaskAttemptView["actions"][number]) => actions.includes(action);

  if (decision) return <Decided value={value} />;
  if (!can("approve") && !can("reject") && !can("revise")) return null;
  return (
    <Stack gap="xs" data-testid="task-attempt-decision-ask">
      {!can("approve") && report?.outcome === "proposed" && !report.verified && (
        <Text size="sm" c="var(--nivra-text-2)" data-testid="task-attempt-unapprovable">
          This change can't be approved: not every acceptance case was shown to pass. You can reject it, or ask for a revision.
        </Text>
      )}
      {can("approve") && !proposal && (
        <Text size="sm" c="var(--nivra-warning)" data-testid="task-attempt-approve-unavailable">
          The change can't be read from its engine now, so it can't be approved. Open the project to start its engine, then try again.
        </Text>
      )}
      <Group gap="sm" align="flex-start">
        {can("approve") && proposal && (
          <Stack gap={2}>
            <Button size="xs" onClick={() => setConfirming(true)} disabled={busy} data-testid="task-attempt-approve">
              Approve and apply
            </Button>
            <Text size="xs" c="var(--nivra-text-3)" data-testid="task-attempt-approve-what">
              Change {short(proposal.hash)}, made from commit {short(proposal.baseline)}.
            </Text>
          </Stack>
        )}
        {can("reject") && (
          <Stack gap={2}>
            <Button size="xs" variant="default" color="red" onClick={() => act(() => window.nivra.rejectTaskChange(value.taskId, value.id))} disabled={busy} data-testid="task-attempt-reject">
              Reject
            </Button>
            <Text size="xs" c="var(--nivra-text-3)">
              Nothing is sent, and your checkout isn't touched.
            </Text>
          </Stack>
        )}
        {can("revise") && !revising && (
          <Button size="xs" variant="default" onClick={() => setRevising(true)} disabled={busy} data-testid="task-attempt-revise">
            Request revision
          </Button>
        )}
      </Group>
      {can("revise") && revising && (
        <Stack gap="xs" data-testid="task-attempt-revision">
          <Textarea
            label="What should change"
            description="Your note goes into the task's brief, as a new version. The next run starts when you press Run."
            autosize
            minRows={2}
            maxRows={8}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            data-testid="task-attempt-revision-note"
          />
          <Group gap="sm">
            <Button size="xs" onClick={() => act(() => window.nivra.requestTaskRevision(value.taskId, value.id, note.trim()))} disabled={busy || note.trim() === ""} data-testid="task-attempt-revision-send">
              Ask for the revision
            </Button>
            <Button size="xs" variant="default" onClick={() => setRevising(false)} disabled={busy}>
              Cancel
            </Button>
          </Group>
        </Stack>
      )}
      {proposal && (
        <Modal opened={confirming} onClose={() => setConfirming(false)} title="Apply this change?" data-testid="task-apply-confirm">
          <Stack gap="sm">
            <Text size="sm">
              Nivra applies change <Code>{short(proposal.hash)}</Code> to your checkout, which must still be at commit <Code>{short(proposal.baseline)}</Code>.
            </Text>
            <Text size="sm">
              First it checks the proposal and your checkout again, and writes nothing if either changed. Then each file the change replaces is moved aside into the
              repository's git folder and kept there, and each new file is put in place without replacing anything. Nothing is staged or committed.
            </Text>
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setConfirming(false);
                  act(() => window.nivra.approveTaskChange(value.taskId, value.id, proposal.hash));
                }}
                disabled={busy}
                data-testid="task-apply-confirm-go"
              >
                Apply the change
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}

/** What the person decided, and when. */
function Decided({ value }: { value: TaskAttemptView }) {
  const decided = when(value.decidedAt);
  const words: Record<AttemptDecision, string> = {
    approved: `You approved this change${decided ? ` on ${decided}` : ""}.`,
    rejected: `You rejected this change${decided ? ` on ${decided}` : ""}. Nothing was sent, and your checkout wasn't touched.`,
    revision: `You asked for a revision${decided ? ` on ${decided}` : ""}. Your note is in the task's brief as a new version; press Run to try again.`,
  };
  return (
    <Stack gap={2} data-testid="task-attempt-decision" data-decision={value.decision}>
      <Text size="sm">{words[value.decision!]}</Text>
      {value.decision === "revision" && value.revisionNote && (
        <Text size="sm" c="var(--nivra-text-2)" style={{ whiteSpace: "pre-wrap" }} data-testid="task-attempt-revision-shown">
          {value.revisionNote}
        </Text>
      )}
    </Stack>
  );
}

/** What applying the change did: its state, each path, where the originals are kept, and how to settle it. */
export function ApplyResult({ value, busy, act }: { value: TaskAttemptView; busy: boolean; act(work: () => Promise<TaskAttemptView>): void }) {
  const apply = value.apply;
  if (!apply) return null;
  const settle = (action: "accept" | "dismiss" | "restore" | "keep") => {
    if (action === "restore") return act(() => window.nivra.restoreTaskChange(value.taskId, value.id));
    const as: Record<"accept" | "dismiss" | "keep", ApplyResolution> = { accept: "accepted", dismiss: "dismissed", keep: "kept" };
    return act(() => window.nivra.settleTaskChange(value.taskId, value.id, as[action]));
  };
  const offered = (["accept", "dismiss", "restore", "keep"] as const).filter((action) => value.actions.includes(action));
  return (
    <Stack gap="sm" data-testid="task-apply" data-status={apply.status ?? "waiting"} data-resolution={apply.resolution ?? ""}>
      <Group gap="sm">
        <Badge color={apply.status ? APPLY_COLOR[apply.status] : "blue"} variant="light">
          {apply.status === null ? "Waiting for its engine" : APPLY_BADGE[apply.status]}
        </Badge>
        <Text size="sm" data-testid="task-apply-status">
          {apply.status === null ? "Nivra sent the approval to the repository's engine and is waiting for its answer. It won't be sent again." : APPLY_STATE[apply.status]}
        </Text>
      </Group>
      {apply.refusal && (
        <Alert color="gray" variant="light" data-testid="task-apply-refusal" data-code={apply.refusal.code}>
          <Text size="sm">{apply.refusal.message}</Text>
          {apply.refusal.path && (
            <Text size="sm">
              It's about <Code>{apply.refusal.path}</Code>.
            </Text>
          )}
        </Alert>
      )}
      {apply.failure && (
        <Text size="xs" c="var(--nivra-text-2)" data-testid="task-apply-failure" data-step={apply.failure.step}>
          It stopped while {stepText(apply.failure.step)}
          {apply.failure.code ? `: ${ERROR_WORDS[apply.failure.code] ?? apply.failure.code}` : ""}.
        </Text>
      )}
      {apply.unresolved && (
        <Text size="sm" c="var(--nivra-warning)" data-testid="task-apply-unresolved">
          {apply.unresolved}
        </Text>
      )}
      {apply.paths.length > 0 && (
        <Table data-testid="task-apply-paths">
          <Table.Tbody>
            {apply.paths.map((path) => (
              <Table.Tr key={path.path} data-testid="task-apply-path" data-path={path.path} data-place={path.place}>
                <Table.Td>
                  <Code>{path.path}</Code>
                  <Text size="xs" c="var(--nivra-text-3)">
                    {path.change === "added" ? "added" : "changed"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{placeText(path)}</Text>
                  <Text size="xs" c="var(--nivra-text-3)">
                    There now: {foundText(path.found)}.{path.kept.length ? ` Copies kept: ${path.kept.join(", ")}.` : ""}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {apply.folders.length > 0 && (
        <Text size="xs" c="var(--nivra-text-2)" data-testid="task-apply-folders">
          Folders Nivra made: {apply.folders.join(", ")}.
        </Text>
      )}
      {apply.recovery && apply.resolution === null && (
        <Text size="xs" c="var(--nivra-text-2)" data-testid="task-apply-recovery">
          Nivra keeps the originals it moved aside in the repository's git folder, in <Code>{apply.recovery}</Code>, until you settle this change.
        </Text>
      )}
      {apply.resolution && (
        <Text size="sm" data-testid="task-apply-resolution">
          {RESOLVED[apply.resolution]}
        </Text>
      )}
      {offered.length > 0 && (
        <Group gap="sm" align="flex-start">
          {offered.map((action) => (
            <Stack key={action} gap={2} maw={260}>
              <Button size="xs" variant={action === "accept" || action === "restore" ? "filled" : "default"} onClick={() => settle(action)} disabled={busy} data-testid={SETTLE[action].testid}>
                {SETTLE[action].label}
              </Button>
              <Text size="xs" c="var(--nivra-text-3)">
                {SETTLE[action].says}
              </Text>
            </Stack>
          ))}
        </Group>
      )}
    </Stack>
  );
}

const STATUS_WORD: Record<TurnStatus, string> = {
  submitting: "sending",
  running: "running",
  answered: "ended",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  "not-sent": "not sent",
  unknown: "unknown",
};

const OUTCOME_WORD: Record<TaskReport["outcome"], string> = {
  "in-progress": "going",
  proposed: "a change",
  unchanged: "no change",
  refused: "refused",
  cancelled: "stopped",
  failed: "couldn't finish",
  uncertain: "uncertain",
  interrupted: "interrupted",
};

const DECISION_WORD: Record<AttemptDecision, string> = { approved: "approved", rejected: "rejected", revision: "revision asked" };

/** An apply's state, as a few words for the list. */
function applyWord(apply: { status: ApplyStatus | null; resolution: ApplyResolution | null }, acceptedAt: string | null): string {
  if (acceptedAt || apply.resolution === "accepted") return "accepted";
  if (apply.status === null) return "waiting for its engine";
  const words: Record<ApplyStatus, string> = { claimed: "applying", writing: "applying", refused: "apply refused", applied: "applied", "not-applied": "not applied", partial: "applied in part", unknown: "apply unknown" };
  return words[apply.status];
}

/**
 * Every run of the task, newest first: its brief version, how it ended and what it found, the decision on its change,
 * and its apply, as the workspace keeps them, so the list needs no engine. Each opens its card.
 */
export function AttemptsList({ attempts, shown, onChoose }: { attempts: TaskView["attempts"]; shown: string | null; onChoose(id: string): void }) {
  if (!attempts.length) return null;
  return (
    <Stack gap={4} data-testid="task-attempts">
      <Text size="xs" c="var(--nivra-text-3)">
        Runs, newest first:
      </Text>
      {[...attempts].reverse().map((attempt) => {
        const number = attempts.indexOf(attempt) + 1;
        const parts = [`brief v${attempt.briefVersion}`, STATUS_WORD[attempt.status]];
        if (attempt.outcome) parts.push(attempt.outcome === "proposed" ? (attempt.verified ? "a verified change" : "an unverified change") : OUTCOME_WORD[attempt.outcome]);
        if (attempt.decision) parts.push(DECISION_WORD[attempt.decision]);
        if (attempt.apply) parts.push(applyWord(attempt.apply, attempt.acceptedAt));
        return (
          <Button
            key={attempt.id}
            size="compact-xs"
            variant={attempt.id === shown ? "light" : "subtle"}
            justify="flex-start"
            onClick={() => onChoose(attempt.id)}
            data-testid="task-attempt-row"
            data-attempt-id={attempt.id}
            data-decision={attempt.decision ?? ""}
            data-apply={attempt.apply ? (attempt.apply.status ?? "waiting") : ""}
          >
            Run {number}: {parts.join(", ")}
          </Button>
        );
      })}
    </Stack>
  );
}
