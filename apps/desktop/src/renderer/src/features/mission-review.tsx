import { Badge, Button, Group, List, Paper, Stack, Text } from "@mantine/core";
import type { ChairSynthesis, ReviewerReport, ReviewFinding, ReviewStage } from "@nivra/domain";
import type { MissionReviewView, ReviewedTaskView } from "../../../shared/ipc";
import { plural, runBudgetText } from "../shared/evidence";
import { isOpenReview, Part, ReviewProgress, STATUS_LOOK } from "./reviews";

/**
 * A review of a mission's selected tasks (NIV-52). Its findings name the tasks they're about, the mission, or a gap in
 * the backlog; a task's chip opens that task's own page, where the person decides what to change. Nothing here changes
 * a task, and nothing reads as approval: the reviewers saw the mission and the selected tasks, and nothing else.
 */

const SEVERITY_COLOR = { high: "red", medium: "orange", low: "gray" } as const;
const STAGE_STATUS: Record<ReviewStage["status"], string> = { pending: "waiting", running: "asked", answered: "answered", failed: "failed", skipped: "skipped" };

/** A role's name in a mission review: the profile that played it. */
function roleName(review: MissionReviewView, role: ReviewStage["role"]): string {
  const id = role === "architecture" ? "product-architect" : role === "risks" ? "risk-testability" : role === "chair" ? "council-chair" : null;
  return review.specialists.find((specialist) => specialist.id === id)?.name ?? (role === "chair" ? "Chair" : "Reviewer");
}

/** What a finding names: a selected task (which opens it), the mission, the backlog as a whole, or a preference. */
function RefChip({ reference, tasks, onOpenTask }: { reference: string; tasks: ReviewedTaskView[]; onOpenTask(taskId: string): void }) {
  const task = tasks.find((candidate) => candidate.ref === reference);
  if (task) {
    return (
      <Button
        size="compact-xs"
        variant="light"
        onClick={() => onOpenTask(task.taskId)}
        disabled={!task.present}
        title={task.present ? `Open "${task.title}" to edit it` : "This task was deleted."}
        data-testid="mission-finding-task"
        data-ref={reference}
        data-task-id={task.taskId}
      >
        {reference} · {task.title}
        {task.present ? "" : " (deleted)"}
      </Button>
    );
  }
  // A task reference whose task can't be read now is shown as it is, never as something else.
  const label = reference === "mission" ? "the mission" : reference === "backlog" ? "the backlog: no selected task covers it" : /^T\d+$/.test(reference) ? reference : "a preference";
  return (
    <Badge size="sm" variant="light" color="gray" style={{ textTransform: "none" }} data-testid="review-ref" data-ref={reference}>
      {label}
    </Badge>
  );
}

function Finding({ finding, tasks, onOpenTask }: { finding: ReviewFinding; tasks: ReviewedTaskView[]; onOpenTask(taskId: string): void }) {
  return (
    <Stack gap={2} data-testid="review-finding" data-finding-id={finding.id} data-basis={finding.basis}>
      <Group gap={6}>
        <Badge size="sm" variant="outline" style={{ textTransform: "none" }}>
          {finding.id}
        </Badge>
        {finding.severity && (
          <Badge size="sm" variant="light" color={SEVERITY_COLOR[finding.severity]} style={{ textTransform: "none" }}>
            {finding.severity}
          </Badge>
        )}
        <Badge size="sm" variant="light" color={finding.basis === "plan" ? "blue" : "gray"} style={{ textTransform: "none" }} data-testid="review-finding-basis">
          {finding.basis === "plan" ? "From what was sent" : "Assumption"}
        </Badge>
        <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
          {finding.title}
        </Text>
      </Group>
      {finding.detail && (
        <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {finding.detail}
        </Text>
      )}
      {finding.recommendation && (
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>
          Recommendation: {finding.recommendation}
        </Text>
      )}
      {finding.refs.length > 0 && (
        <Group gap={4}>
          {finding.refs.map((ref, index) => (
            <RefChip key={`${index}-${ref}`} reference={ref} tasks={tasks} onOpenTask={onOpenTask} />
          ))}
        </Group>
      )}
      {finding.relabelled && (
        <Text size="xs" c="var(--nivra-text-3)">
          Marked as an assumption: its reviewer didn&apos;t say it follows from what was sent.
        </Text>
      )}
    </Stack>
  );
}

function Reviewer({ review, reviewer, onOpenTask }: { review: MissionReviewView; reviewer: ReviewerReport; onOpenTask(taskId: string): void }) {
  const { adjusted } = reviewer;
  const changes = [
    adjusted.unanchored ? `${plural(adjusted.unanchored, "finding")} set aside for naming no selected task, the mission or the backlog` : "",
    adjusted.empty ? `${plural(adjusted.empty, "finding")} with no title or detail left out` : "",
    adjusted.dropped ? `${plural(adjusted.dropped, "finding")} over the limit left out` : "",
    adjusted.refsDropped ? `${plural(adjusted.refsDropped, "reference")} to something that wasn't sent dropped` : "",
    adjusted.relabelled ? `${plural(adjusted.relabelled, "finding")} marked as an assumption` : "",
    adjusted.shortened ? `${plural(adjusted.shortened, "field")} shortened` : "",
  ].filter(Boolean);
  return (
    <Part title={roleName(review, reviewer.role)} testId="review-reviewer">
      <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="review-summary">
        {reviewer.summary}
      </Text>
      {reviewer.findings.length === 0 ? (
        <Text size="sm" c="var(--nivra-text-2)" data-testid="review-nothing-raised">
          {adjusted.unanchored || adjusted.empty
            ? "None of the findings it gave could be kept. That isn't an approval."
            : "Raised nothing material. That isn't an approval: it saw only the mission and the selected tasks."}
        </Text>
      ) : (
        reviewer.findings.map((finding) => <Finding key={finding.id} finding={finding} tasks={review.tasks} onOpenTask={onOpenTask} />)
      )}
      {reviewer.assumptions.length > 0 && <Text size="xs">Assumed: {reviewer.assumptions.join("; ")}</Text>}
      {reviewer.gaps.length > 0 && <Text size="xs">Couldn&apos;t tell from what was sent: {reviewer.gaps.join("; ")}</Text>}
      {changes.length > 0 && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="review-adjusted">
          Nivra adjusted this report: {changes.join(", ")}.
        </Text>
      )}
    </Part>
  );
}

function Synthesis({ synthesis }: { synthesis: ChairSynthesis }) {
  const ids = (list: string[]) => list.join(", ");
  return (
    <Part title="The chair's synthesis" note="It weighs both reports. Agreement isn't proof: both reviewers saw the same mission and tasks, and nothing else." testId="review-synthesis">
      <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {synthesis.summary}
      </Text>
      {synthesis.priorities.length > 0 && <Text size="sm">Look at first: {ids(synthesis.priorities)}.</Text>}
      {synthesis.agreements.length > 0 && (
        <Stack gap={2} data-testid="review-agreements">
          <Text size="xs" fw={600}>
            Where they agree
          </Text>
          <List size="sm">
            {synthesis.agreements.map((agreement, index) => (
              <List.Item key={index}>
                {agreement.statement} ({ids(agreement.findingIds)})
              </List.Item>
            ))}
          </List>
        </Stack>
      )}
      {synthesis.dissent.length > 0 && (
        <Stack gap={2} data-testid="review-dissent">
          <Text size="xs" fw={600}>
            Where they differ
          </Text>
          {synthesis.dissent.map((item, index) => (
            <Stack key={index} gap={0}>
              <Text size="sm">{item.topic}</Text>
              <List size="sm" withPadding>
                {item.positions.map((position, i) => (
                  <List.Item key={i}>
                    {position.position} ({ids(position.findingIds)})
                  </List.Item>
                ))}
              </List>
              {item.note && <Text size="xs">{item.note}</Text>}
            </Stack>
          ))}
        </Stack>
      )}
      {synthesis.gaps.length > 0 && <Text size="xs">Couldn&apos;t tell from what was sent: {synthesis.gaps.join("; ")}</Text>}
      {synthesis.unaddressed.length > 0 && (
        <Text size="xs" data-testid="review-unaddressed">
          Not addressed by the chair: {ids(synthesis.unaddressed)}. Each is in its reviewer&apos;s report above.
        </Text>
      )}
    </Part>
  );
}

/** One review of a mission's selected tasks, newest first in its list. */
export function MissionReviewCard({
  review,
  online,
  onOpenTask,
  onCancel,
  onReviewAgain,
}: {
  review: MissionReviewView;
  online: boolean;
  onOpenTask(taskId: string): void;
  onCancel(): void;
  onReviewAgain(): void;
}) {
  const open = isOpenReview(review);
  const report = review.report;
  const look = review.status === "failed" && report?.outcome === "incomplete" ? { label: "Incomplete", color: "orange" } : STATUS_LOOK[review.status];
  return (
    <Paper withBorder p="sm" radius="md" data-testid="mission-review" data-review-id={review.id} data-status={review.status} data-stale={review.stale.length > 0}>
      <Stack gap={8}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Text size="xs" fw={600}>
              Council review · {review.missionVersion === null ? "mission version unknown" : `mission v${review.missionVersion}`} · {review.tasks.map((task) => task.ref).join(", ")}
            </Text>
            <Badge color={look.color} variant="light" data-testid="review-status">
              {open && review.cancelRequested ? "Cancelling" : look.label}
            </Badge>
          </Group>
          {open ? (
            <Button size="compact-xs" variant="default" onClick={onCancel} disabled={review.cancelRequested} data-testid="review-cancel">
              Cancel
            </Button>
          ) : (
            <Button size="compact-xs" variant="subtle" onClick={onReviewAgain} data-testid="review-again">
              Review again
            </Button>
          )}
        </Group>
        {review.stale.length > 0 && (
          <Stack gap={0} data-testid="mission-review-stale">
            <Text size="xs" c="var(--nivra-warning)">
              Things changed since this review, which stays as it was:
            </Text>
            {review.stale.map((line) => (
              <Text size="xs" c="var(--nivra-warning)" key={line}>
                {line}
              </Text>
            ))}
          </Stack>
        )}
        {review.preferencesChanged && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="mission-review-preferences-changed">
            Your preferences have changed since this review.
          </Text>
        )}
        <Text size="xs" c="var(--nivra-text-3)" data-testid="mission-review-tasks">
          Selected for this review: {review.tasks.map((task) => `${task.ref} ${task.title} (brief v${task.briefVersion})`).join("; ")}.
        </Text>
        {open && review.runId && <ReviewProgress runId={review.runId} online={online} />}
        {review.note && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="review-note">
            {review.note}
          </Text>
        )}
        {review.unresolved && (
          <Text size="sm" c="var(--nivra-warning)" data-testid="review-unresolved">
            {review.unresolved}
          </Text>
        )}
        {report && (
          <>
            {report.outcome === "incomplete" && (
              <Text size="sm" data-testid="review-incomplete">
                Incomplete: this report holds only what the stages that answered produced.
              </Text>
            )}
            <List size="xs" data-testid="review-stages">
              {report.stages.map((stage) => (
                <List.Item key={stage.role} data-testid="review-stage" data-role={stage.role} data-status={stage.status}>
                  {roleName(review, stage.role)}: {STAGE_STATUS[stage.status]}
                  {stage.status === "answered" && stage.inputTokens !== null && stage.outputTokens !== null ? ` · ${stage.inputTokens.toLocaleString()} in / ${stage.outputTokens.toLocaleString()} out tokens` : ""}
                  {stage.elapsedMs !== null && stage.requests > 0 ? ` · ${(stage.elapsedMs / 1000).toFixed(1)} s` : ""}
                  {stage.message ? `. ${stage.message}` : ""}
                </List.Item>
              ))}
            </List>
            {report.reviewers.map((reviewer) => (
              <Reviewer key={reviewer.role} review={review} reviewer={reviewer} onOpenTask={onOpenTask} />
            ))}
            {report.synthesis && <Synthesis synthesis={report.synthesis} />}
          </>
        )}
        <Text size="xs" c="var(--nivra-text-3)" data-testid="review-not-approval">
          This review doesn&apos;t change the mission or any task, mark a task ready, or approve anything. A finding&apos;s task opens on its own page, where you decide.
        </Text>
        <Text size="xs" c="var(--nivra-text-3)" data-testid="review-binding">
          No repository · {review.specialists.map((specialist) => `${specialist.name} v${specialist.version}`).join(", ")} · packet {review.packetDigest.slice(0, 12)} ·{" "}
          {plural(review.given.preferences, "preference")} ({review.preferencesDigest.slice(0, 12)})
        </Text>
        {report && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="review-usage">
            {report.route ? `${report.route.model}${report.route.endpoint === "loopback-test" ? " (test endpoint)" : ""}` : "Model unknown"} · {(report.elapsedMs / 1000).toFixed(1)} s ·{" "}
            {report.usage.inputTokens !== null && report.usage.outputTokens !== null
              ? `${report.usage.inputTokens.toLocaleString()} in / ${report.usage.outputTokens.toLocaleString()} out tokens, as reported`
              : report.usage.reportedCalls
                ? `tokens partly reported (${report.usage.reportedCalls} of ${report.usage.calls} calls)`
                : "tokens not reported"}
            . {runBudgetText(report.budget)}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
