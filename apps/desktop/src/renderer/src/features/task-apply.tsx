import { Alert, Anchor, Badge, Button, Code, Group, List, Modal, Paper, Stack, Text, Textarea } from "@mantine/core";
import type { ApplyPath, ApplyResolution, ApplyStatus, TaskReport } from "@nivra/domain";
import { useEffect, useId, useRef, useState } from "react";
import type { AttemptDecision, BriefContent, TaskApplyView, TaskAttemptView, TaskView, TurnStatus } from "../../../shared/ipc";
import { decisionLead, failingReportedChecks, outcomeLookOf, unapprovableText } from "../../../shared/task-verdict";
import { useNarrow } from "./narrow";

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
  partial: "The change is applied in part. Some files are as the change leaves them; the others are as they were, or moved aside with their original kept and nothing in their place.",
  unknown: "Nivra can't tell where every file is. Each one is listed below, with the copies it kept.",
};

/** A refusal because the change is in place already: the generic headline would say less than what happened. */
const DUPLICATE = "This change was already applied by an earlier approval; this one wrote nothing.";

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
  accept: { label: "Accept the change", says: "Completes the task, unless its brief or repository changed after this run. Your checkout stays as it is, and the copies Nivra kept stay in the recovery folder.", testid: "task-apply-accept" },
  dismiss: { label: "Dismiss", says: "Closes this result. The copies Nivra kept stay in the recovery folder.", testid: "task-apply-dismiss" },
  restore: { label: "Restore the originals", says: "Puts each original back where the change replaced it, and takes out the files and folders the change added, never over a version another program saved.", testid: "task-apply-restore" },
  keep: { label: "Keep as is", says: "Leaves your checkout as it is now. The copies Nivra kept stay in the recovery folder.", testid: "task-apply-keep" },
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
    [/^check folders$/, "checking that each folder was still where it was"],
    [/^(take back|restore) /, "putting an original back"],
    [/^remove folder /, "removing a folder it made"],
    [/^interrupted$/, "applying, when its engine stopped"],
    [/^reconcile$/, "reading where each file is, after its engine stopped"],
  ];
  return doing.find(([pattern]) => pattern.test(step))?.[1] ?? "applying the change";
}

/** Error codes a person can act on, in plain words; any other is shown as its code. */
const ERROR_WORDS: Record<string, string> = { changed: "a file changed after Nivra checked it", moved: "a folder was moved or replaced while the change was applied", ENOTDIR: "a folder on the way is no longer a folder", ELOOP: "a folder on the way is a link now", ENOSPC: "the disk is full", EACCES: "permission was denied", EPERM: "the operation isn't permitted", EBUSY: "a file was busy", EIO: "the disk reported an error", EXDEV: "a file was on another disk", EEXIST: "something was already there" };

/** An approval taken back (its request never reached the engine): no apply stands, and the change can be decided on again. */
const takenBack = (value: { decision: AttemptDecision | null; apply: { status: ApplyStatus | null } | null }) => value.decision === null && value.apply !== null && value.apply.status === null;

/**
 * An apply that hasn't ended yet, or whose engine can't be read, or a settle of it Nivra is reading back: read again
 * while that lasts. An approval taken back waits on nothing.
 */
export const applyGoing = (value: Pick<TaskAttemptView, "decision" | "apply">) => {
  const apply = value.apply;
  return apply !== null && !takenBack(value) && (apply.status === null || apply.status === "claimed" || apply.status === "writing" || apply.unresolved !== null);
};

/**
 * The person's decision on a run's change (P1i, RS1, RS5), in the aside: approve it by its hash, ask for a revision, or
 * reject it, exactly as the host offers. A change that can't be approved says why, and Request revision leads; a
 * verified change whose reported check failed says so first, and approving it stays possible. `act` runs one of the
 * host's calls and reads the run again. Once decided, it says what was decided.
 */
export function DecisionCard({
  value,
  busy,
  act,
  content,
  confirmAsked = 0,
}: {
  value: TaskAttemptView;
  busy: boolean;
  act(work: () => Promise<TaskAttemptView>): void;
  content: BriefContent | null;
  /** Raised when Approve is pressed elsewhere, such as the narrow window's bar (NW3): the same confirmation opens. */
  confirmAsked?: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const narrow = useNarrow();
  // Only a press made while this card is shown opens the confirmation, not one counted before it moved columns.
  const seenAsk = useRef(confirmAsked);
  useEffect(() => {
    if (confirmAsked === seenAsk.current) return;
    seenAsk.current = confirmAsked;
    setConfirming(true);
  }, [confirmAsked]);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const warningId = useId();
  const { report, proposal, actions, decision } = value;
  const can = (action: TaskAttemptView["actions"][number]) => actions.includes(action);

  if (decision === "rejected" || decision === "revision") {
    return (
      <Paper withBorder p="md" radius="md">
        <Stack gap="xs">
          <Text fw={600}>Your decision</Text>
          <Decided value={value} />
        </Stack>
      </Paper>
    );
  }
  if (decision || (!can("approve") && !can("reject") && !can("revise"))) return null;
  const { lead, approve: approveWords } = decisionLead(report, can("approve"), proposal !== null);
  const approvable = approveWords !== null && proposal !== null;
  const failing = approvable ? failingReportedChecks(report) : [];
  // A failing check's command, run before the worker too? Only the run's own brief version can say.
  const ranBefore = content === null ? null : failing.some((check) => content.baseline.some((selection) => selection.command === check.name));
  const revisionLeads = lead === "revise";
  const approve = approvable && (
    <Stack gap={2}>
      <Button fullWidth variant={revisionLeads ? "default" : "filled"} onClick={() => setConfirming(true)} disabled={busy} data-testid="task-attempt-approve">
        {approveWords}
      </Button>
      <Text size="xs" c="var(--nivra-text-3)" data-testid="task-attempt-approve-what">
        Change {short(proposal.hash)}, made from commit {short(proposal.baseline)}.
      </Text>
    </Stack>
  );
  const revise = can("revise") && !revising && (
    <Stack gap={2}>
      <Button fullWidth variant={revisionLeads ? "filled" : "default"} onClick={() => setRevising(true)} disabled={busy} data-testid="task-attempt-revise">
        Request revision
      </Button>
      <Text size="xs" c="var(--nivra-text-3)">
        Your note becomes a new brief version. Nothing runs until you preview the run and start it.
      </Text>
    </Stack>
  );
  return (
    <Paper withBorder p="md" radius="md" id={`decision-${value.id}`}>
      <Stack gap="sm" data-testid="task-attempt-decision-ask">
        <Stack gap={2}>
          <Text fw={600}>Your decision</Text>
          {approvable && (
            <Text size="sm" c="var(--nivra-text-2)">
              Approving applies this change to your checkout, unstaged. You accept the task after you've looked at it there.
            </Text>
          )}
        </Stack>
        {!can("approve") && report?.outcome === "proposed" && !report.verified && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="task-attempt-unapprovable">
            {unapprovableText(report)}
          </Text>
        )}
        {can("approve") && !proposal && (
          <Text size="sm" c="var(--nivra-warning)" data-testid="task-attempt-approve-unavailable">
            The change can't be read from its engine now, so it can't be approved. Open the project to start its engine, then try again.
          </Text>
        )}
        {failing.length > 0 && (
          <Alert color="yellow" variant="light" role="note" aria-labelledby={warningId} data-testid="task-attempt-check-warning">
            <Text id={warningId} size="sm" fw={600}>
              {failing.length === 1 ? `Check ${failing[0]!.number}, a repository check, didn't pass` : `${failing.length} repository checks didn't pass`}
            </Text>
            <Text size="sm">
              A repository check is reported and doesn't decide the result, so the change still counts as verified and can be approved.
              {ranBefore === false ? ` Nivra didn't run ${failing.length === 1 ? "this check" : "these checks"} on the commit before the change, so it can't tell whether what ${failing.length === 1 ? "it reports is" : "they report is"} new.` : ""} Read
              {failing.length === 1 ? " its output" : " their output"} under Acceptance cases and checks before you decide.
            </Text>
          </Alert>
        )}
        {revisionLeads ? revise : approve}
        {revisionLeads ? approve : revise}
        {can("revise") && revising && (
          <Stack gap="xs" data-testid="task-attempt-revision">
            <Textarea
              label="What should change"
              description="Your note goes into the task's brief, as a new version. Nothing runs until you preview the run and start it."
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
        {can("reject") && (
          <Stack gap={2}>
            <Button fullWidth variant="outline" color="red" onClick={() => act(() => window.nivra.rejectTaskChange(value.taskId, value.id))} disabled={busy} data-testid="task-attempt-reject">
              Reject
            </Button>
            <Text size="xs" c="var(--nivra-text-3)">
              Nothing is sent, and your checkout isn't touched.
            </Text>
          </Stack>
        )}
      </Stack>
      {proposal && (
        <Modal
          opened={confirming}
          onClose={() => setConfirming(false)}
          title="Apply this change?"
          size="lg"
          fullScreen={narrow}
          styles={{ content: { display: "flex", flexDirection: "column", overflow: "hidden" }, body: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 0 } }}
          data-testid="task-apply-confirm"
        >
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--mantine-spacing-md)" }}>
          <Stack gap="sm">
            <Text size="sm">
              Nivra applies change <Code>{short(proposal.hash)}</Code> to your checkout, which must still be at commit <Code>{short(proposal.baseline)}</Code>.
            </Text>
            <Text size="sm">
              First it checks the proposal and your checkout again, and writes nothing if either changed. Then each file the change replaces is moved aside into the
              repository's git folder and kept there, and each new file is put in place without replacing anything. Nothing is staged or committed.
            </Text>
            <Stack gap={0} data-testid="task-apply-confirm-files">
              {proposal.paths.map((one) => (
                <Group key={one.path} justify="space-between" align="flex-start" wrap="nowrap" gap="sm" py={6} style={{ borderTop: "1px solid var(--nivra-border)" }} data-testid="task-apply-confirm-file" data-change={one.change}>
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Text size="sm" ff="monospace" style={{ overflowWrap: "anywhere" }}>
                      {one.path}
                    </Text>
                    <Text size="xs" c={one.change === "deleted" ? "var(--nivra-warning)" : "var(--nivra-text-2)"}>
                      {one.change === "added"
                        ? "Put in place, replacing nothing."
                        : one.change === "changed"
                          ? "Your copy is moved aside into the recovery folder and kept, then the changed file goes in its place."
                          : "A deletion, which Nivra doesn't apply: the apply is refused, and nothing is written."}
                    </Text>
                  </Stack>
                  <Badge size="sm" variant="light" color={one.change === "deleted" ? "yellow" : "gray"} style={{ flexShrink: 0 }}>
                    {one.change === "added" ? "New file" : one.change === "changed" ? "Changed" : "Deleted"}
                  </Badge>
                </Group>
              ))}
            </Stack>
            <Text size="sm" c="var(--nivra-text-2)">
              Afterwards the change is in your checkout, unstaged, for you to look at before you accept it.
            </Text>
          </Stack>
          </div>
            <Group justify="flex-end" gap="sm" p="md" style={{ borderTop: "1px solid var(--nivra-border)", flexShrink: 0 }} data-testid="task-apply-confirm-footer">
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
        </Modal>
      )}
    </Paper>
  );
}

/** What the person decided, and when. */
function Decided({ value }: { value: TaskAttemptView }) {
  const decided = when(value.decidedAt);
  const words: Record<AttemptDecision, string> = {
    approved: `You approved this change${decided ? ` on ${decided}` : ""}.`,
    rejected: `You rejected this change${decided ? ` on ${decided}` : ""}. Nothing was sent, and your checkout wasn't touched.`,
    revision: `You asked for a revision${decided ? ` on ${decided}` : ""}. Your note is in the task's brief as a new version; preview the run to try again.`,
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

const APPLY_TITLE: Record<ApplyStatus, string> = { claimed: "Checking the change", writing: "Applying the change", refused: "Apply refused", applied: "Change applied", "not-applied": "Not applied", partial: "Applied in part", unknown: "Where the files are isn't known" };

/** The apply's record: whether its approval stands, its state and badge. The page's apply area carries these. */
export const applyMarks = (value: Pick<TaskAttemptView, "decision" | "apply">) =>
  value.apply === null ? null : { status: takenBack(value) ? "taken-back" : (value.apply.status ?? "waiting"), resolution: value.apply.resolution ?? "" };

/**
 * What applying the change did (P1k, RS2): its state, the approval, each file in the checkout and where its original is,
 * the recovery folder, and how it was settled. It never claims more than the engine reported.
 */
export function ApplyCard({ value }: { value: TaskAttemptView }) {
  const apply = value.apply;
  if (!apply) return null;
  // The approval was taken back: the host's note says why, and nothing else of this apply stands.
  if (takenBack(value)) {
    return (
      <Paper withBorder p="md" radius="md">
        <Group gap="sm">
          <Badge color="gray" variant="light">
            Approval taken back
          </Badge>
          <Text size="sm" data-testid="task-apply-status">
            {apply.unresolved ?? "The approval was taken back, and nothing was written. You can decide on the change again."}
          </Text>
        </Group>
      </Paper>
    );
  }
  const savedOver = apply.status === "applied" ? apply.paths.filter((one) => one.place === "theirs" && one.changedSince) : [];
  const proposal = value.proposal;
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group gap="sm" align="baseline">
          <Text fw={600}>{apply.status === null ? "Waiting for its engine" : APPLY_TITLE[apply.status]}</Text>
          <Badge color={apply.status ? APPLY_COLOR[apply.status] : "blue"} variant="light">
            {apply.status === null ? "Waiting" : APPLY_BADGE[apply.status]}
          </Badge>
        </Group>
        <Text size="sm" data-testid="task-apply-status">
          {apply.status === null
            ? "Nivra sent the approval to the repository's engine and is waiting for its answer. It won't be sent again."
            : apply.status === "refused" && apply.refusal?.code === "duplicate"
              ? DUPLICATE
              : APPLY_STATE[apply.status]}
        </Text>
        {value.decision === "approved" && (
          <Stack gap={2} data-testid="task-attempt-decision" data-decision="approved">
            <Text size="sm" c="var(--nivra-text-2)">
              You approved {proposal ? `change ${short(proposal.hash)}, made from commit ${short(proposal.baseline)}` : "this change"}
              {value.decidedAt ? `, on ${when(value.decidedAt)}` : ""}. Nivra writes nothing when the change or your checkout changed since the run.
            </Text>
          </Stack>
        )}
        {apply.status === "applied" && apply.resolution === null && (
          <Alert color="gray" variant="light" data-testid="task-apply-not-accepted">
            <Text size="sm">Applied isn't accepted. Look at the change in your checkout, with your editor or with git, then come back to accept it. Until then the task stays in review.</Text>
          </Alert>
        )}
        {savedOver.length > 0 && (
          <Text size="sm" c="var(--nivra-warning)" data-testid="task-apply-saved-over">
            Since Nivra wrote {savedOver.length === 1 ? "it" : "them"}, another program has saved over {savedOver.map((one) => one.path).join(", ")}. {savedOver.length === 1 ? "That version is" : "Those versions are"}{" "}
            kept as {savedOver.length === 1 ? "it is" : "they are"}.
          </Text>
        )}
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
        {apply.paths.length > 0 && <ApplyPaths apply={apply} />}
        {apply.folders.length > 0 && (
          <Text size="xs" c="var(--nivra-text-2)" data-testid="task-apply-folders">
            Folders Nivra made: {apply.folders.join(", ")}.
          </Text>
        )}
        <Recovery apply={apply} />
        {apply.resolution && (
          <Text size="sm" data-testid="task-apply-resolution">
            {apply.resolution === "accepted" && value.acceptNote ? "You accepted the change." : RESOLVED[apply.resolution]}
          </Text>
        )}
        {apply.resolution === "accepted" && value.acceptNote && (
          <Text size="sm" c="var(--nivra-warning)" data-testid="task-apply-accept-note">
            {value.acceptNote}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/** Each file the change writes, and where it is in the checkout now, with the copies kept for it. */
function ApplyPaths({ apply, compact = false }: { apply: TaskApplyView; compact?: boolean }) {
  return (
    <Stack gap={0} data-testid="task-apply-paths">
      <Group justify="space-between" align="baseline" pb={4} gap="xs">
        <Text size="sm" fw={600}>
          Files in your checkout
        </Text>
        <Text size="xs" c="var(--nivra-text-3)">
          {apply.paths.length === 1 ? "1 file" : `${apply.paths.length} files`}
          {apply.paths.every((one) => one.place === "post") ? `, ${apply.paths.length === 1 ? "as" : "each as"} the change leaves it` : ""}
        </Text>
      </Group>
      {apply.paths.map((path) => (
        <Group key={path.path} justify="space-between" align="flex-start" wrap="nowrap" gap="md" py={8} style={{ borderTop: "1px solid var(--nivra-border)" }} data-testid="task-apply-path" data-path={path.path} data-place={path.place}>
          <Stack gap={4} style={{ minWidth: 0, flex: "1 1 40%" }}>
            <Text size="sm" ff="monospace" style={{ overflowWrap: "anywhere" }}>
              {path.path}
            </Text>
            <Badge size="sm" variant="light" color="gray">
              {path.change === "added" ? "New file" : "Changed"}
            </Badge>
          </Stack>
          {!compact && (
            <Stack gap={2} style={{ minWidth: 0, flex: "1 1 60%" }}>
              <Text size="sm">{placeText(path)}</Text>
              <Text size="xs" c="var(--nivra-text-3)">
                There now: {foundText(path.found)}.{path.kept.length ? ` Copies kept: ${path.kept.join(", ")}.` : ""}
              </Text>
            </Stack>
          )}
        </Group>
      ))}
    </Stack>
  );
}

/** Where Nivra keeps the copies it made, before and after the change is settled. */
function Recovery({ apply }: { apply: TaskApplyView }) {
  if (!apply.recovery) return null;
  return apply.resolution === null ? (
    <Text size="xs" c="var(--nivra-text-2)" data-testid="task-apply-recovery">
      Nivra keeps every copy it made in the repository's git folder, in <Code>{apply.recovery}</Code>: the originals it moved aside, and its own. They stay there after you settle this change,
      in case a program that had one of these files open saves into it.
    </Text>
  ) : (
    <Text size="xs" c="var(--nivra-text-2)" data-testid="task-apply-recovery">
      The copies Nivra kept stay in the repository's git folder, in <Code>{apply.recovery}</Code>. Delete that folder when you no longer need them.
    </Text>
  );
}

/**
 * How to settle an apply (P1k, RS2), in the aside: exactly the host's actions, each with what it does. Accept leads when
 * it's offered, then Restore. Keep, when it's withheld for a file moved aside, stays in view, off, with its reason.
 */
export function SettleCard({ value, busy, act, briefVersion }: { value: TaskAttemptView; busy: boolean; act(work: () => Promise<TaskAttemptView>): void; briefVersion: number }) {
  const keepWhy = useId();
  const apply = value.apply;
  if (!apply || takenBack(value)) return null;
  const offered = (["accept", "restore", "keep", "dismiss"] as const).filter((action) => value.actions.includes(action));
  const keepWithheld = apply.status === "partial" && apply.resolution === null && value.actions.includes("restore") && !value.actions.includes("keep") && apply.paths.some((one) => one.place === "aside");
  if (!offered.length && !keepWithheld) return null;
  const leads = offered.includes("accept") ? "accept" : offered.includes("restore") ? "restore" : offered[0];
  const settle = (action: "accept" | "dismiss" | "restore" | "keep") => {
    if (action === "restore") return act(() => window.nivra.restoreTaskChange(value.taskId, value.id));
    const as: Record<"accept" | "dismiss" | "keep", ApplyResolution> = { accept: "accepted", dismiss: "dismissed", keep: "kept" };
    return act(() => window.nivra.settleTaskChange(value.taskId, value.id, as[action]));
  };
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm" data-testid="task-apply-settle">
        <Text fw={600}>Your decision</Text>
        {offered.includes("accept") && briefVersion > value.briefVersion && (
          <Text size="sm" c="var(--nivra-warning)">
            Brief v{briefVersion} is the latest now, and this run ran v{value.briefVersion}: accepting this change won't complete the task.
          </Text>
        )}
        {offered.map((action) => (
          <Stack key={action} gap={2}>
            <Button fullWidth variant={action === leads ? "filled" : "default"} onClick={() => settle(action)} disabled={busy} data-testid={SETTLE[action].testid}>
              {SETTLE[action].label}
            </Button>
            <Text size="xs" c="var(--nivra-text-3)">
              {SETTLE[action].says}
            </Text>
          </Stack>
        ))}
        {keepWithheld && (
          <Stack gap={2}>
            <Button fullWidth variant="default" aria-disabled data-disabled onClick={() => undefined} aria-describedby={keepWhy} data-testid="task-apply-keep-off">
              {SETTLE.keep.label}
            </Button>
            <Text id={keepWhy} size="xs" c="var(--nivra-text-2)" data-testid="task-apply-keep-unavailable">
              Keeping this as it is isn't offered: a file the change replaces is missing from your checkout, its original kept aside. Restore the originals to put it back.
            </Text>
          </Stack>
        )}
        {apply.resolution === null && (
          <Text size="xs" c="var(--nivra-text-3)">
            Until you settle this change, this task can't run again.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * A completed task's account (P1l): the acceptance, the checkout as Nivra left it, and how it got here, from what the
 * workspace and the run recorded. What the window can't know (whether the change is committed yet) is said as advice.
 */
export function CompletedCards({ task, value, project }: { task: TaskView; value: TaskAttemptView; project: string | null }) {
  const apply = value.apply;
  const run = task.attempts.findIndex((attempt) => attempt.id === value.id) + 1;
  const used = task.versions.find((version) => version.version === value.briefVersion) ?? null;
  const events: Array<{ at: string; text: string }> = [];
  if (used) events.push({ at: used.createdAt, text: `Brief v${used.version} saved.` });
  events.push({ at: value.createdAt, text: `Run ${run} started.` });
  if (value.settledAt) events.push({ at: value.settledAt, text: `Run ${run} ended with ${value.report?.verified ? "a verified change" : "a change"}.` });
  if (value.decidedAt) events.push({ at: value.decidedAt, text: `You approved ${value.proposal ? `change ${short(value.proposal.hash)}, made from commit ${short(value.proposal.baseline)}` : "the change"}, and Nivra applied it, unstaged.` });
  if (value.acceptedAt) events.push({ at: value.acceptedAt, text: "You accepted the change." });
  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <Text fw={600}>Completed</Text>
          <Alert color="green" variant="light" role="status">
            <Text size="sm" data-testid="task-apply-resolution">
              {RESOLVED.accepted}
            </Text>
          </Alert>
          {value.acceptedAt && (
            <Text size="sm" c="var(--nivra-text-2)">
              Accepted {when(value.acceptedAt)}. The task's brief and repository were still the ones this run used, so accepting completed it.
            </Text>
          )}
        </Stack>
      </Paper>
      {apply && (
        <Paper withBorder p="md" radius="md">
          <Stack gap="sm">
            <Text fw={600}>Your checkout</Text>
            <Text size="sm">
              Nivra left the change in your checkout, unstaged. Nivra never stages or commits: commit it when you're ready, with your own tools.
            </Text>
            <ApplyPaths apply={apply} compact />
            <Alert color="gray" variant="light">
              <Text size="sm">
                If the change isn't committed yet, commit or stash it before you run a task in {project ?? "this repository"} again: a run works from a commit, so its preview refuses a checkout with
                uncommitted changes.
              </Text>
            </Alert>
            <Recovery apply={apply} />
          </Stack>
        </Paper>
      )}
      <Paper withBorder p="md" radius="md">
        <Stack gap="xs">
          <Text fw={600}>How it got here</Text>
          <List type="ordered" listStyleType="none" spacing={6} data-testid="task-history">
            {events.map((event, index) => (
              <List.Item key={index}>
                <Group gap="md" wrap="nowrap" align="flex-start">
                  <Text size="xs" c="var(--nivra-text-3)" w={150} style={{ flexShrink: 0 }}>
                    {when(event.at)}
                  </Text>
                  <Text size="sm">{event.text}</Text>
                </Group>
              </List.Item>
            ))}
          </List>
        </Stack>
      </Paper>
    </Stack>
  );
}

/** The run behind an applied change (P1k), in the aside: its outcome and checks in short, and the way back to its review. */
export function RunSummary({ value, number, reviewing, onReview }: { value: TaskAttemptView; number: number; reviewing: boolean; onReview(): void }) {
  const report = value.report;
  if (!report) return null;
  const look = outcomeLookOf(value);
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="xs">
        <Group gap="sm">
          <Text fw={600}>Run {number}</Text>
          <Badge color={look.color} variant="light">
            {look.label}
          </Badge>
        </Group>
        {report.checks.map((check) => (
          <Group key={`${check.kind}-${check.number}`} justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              {check.kind === "case" ? `Case ${check.number}, ${check.name}` : `Check ${check.number} (reported)`}
            </Text>
            <Badge size="sm" variant="light" color={check.verdict === "passed" ? "green" : check.verdict === "not-run" ? "gray" : check.verdict === "unknown" ? "yellow" : "red"}>
              {check.verdict === "passed" ? "Passed" : check.verdict === "failed" ? "Failed" : check.verdict === "couldnt-run" ? "Couldn't run" : check.verdict === "unknown" ? "Unknown" : "Not run"}
            </Badge>
          </Group>
        ))}
        {value.settledAt && (
          <Text size="xs" c="var(--nivra-text-3)">
            Ended {when(value.settledAt)}.
          </Text>
        )}
        <Anchor component="button" size="sm" ta="left" onClick={onReview} aria-expanded={reviewing} data-testid="task-attempt-open-review">
          {reviewing ? "Hide the review" : "Open the review"}
        </Anchor>
      </Stack>
    </Paper>
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
function applyWord(attempt: TaskView["attempts"][number], apply: NonNullable<TaskView["attempts"][number]["apply"]>): string {
  if (attempt.acceptedAt || apply.resolution === "accepted") return "accepted";
  if (takenBack(attempt)) return "approval taken back";
  if (apply.resolution === "dismissed") return "dismissed";
  if (apply.resolution === "kept") return "kept as is";
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
        if (attempt.apply) parts.push(applyWord(attempt, attempt.apply));
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
            data-apply={attempt.apply ? (takenBack(attempt) ? "taken-back" : (attempt.apply.status ?? "waiting")) : ""}
          >
            Run {number}: {parts.join(", ")}
          </Button>
        );
      })}
    </Stack>
  );
}
