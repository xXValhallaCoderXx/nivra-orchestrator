import { Alert, Badge, Button, Group, List, Modal, NativeSelect, Paper, Stack, Text } from "@mantine/core";
import type { ChairSynthesis, PreferenceIntent, PreferenceScope, ReviewerReport, ReviewFinding, ReviewStage } from "@nivra/domain";
import { useEffect, useState, type ReactNode } from "react";
import type { PlanView, ProjectView, ReviewPreview, ReviewView, TurnStatus } from "../../../shared/ipc";
import { CONSENT_COVERS, ConsentModal, plural, runBudgetText } from "../shared/evidence";
import { useRunEvents } from "../shared/runs";
import { errorMessage } from "../shared/ui";

/**
 * Reviews of saved plan versions (D31). The dialog previews exactly what a review sends, and starting is bound to that
 * preview. Each report stays with the version it reviewed. Reports are model output, shown as plain text, and nothing
 * here reads as approval: the reviewers saw the plan and nothing else.
 */

export const isOpenReview = (review: ReviewView) => review.status === "submitting" || review.status === "running";

/** What a plan's card needs to offer reviews: the conversation's reviews, and why one can't start now. */
export interface PlanReviewing {
  reviews: ReviewView[];
  /** Why no review can start in this conversation now (a turn or a review going, or it can't continue); null when one can. */
  blocked: string | null;
  /** The conversation's project, for its consent; null for a general conversation. */
  project: ProjectView | null;
  /** Whether the conversation's engine runs, to follow a review's progress. */
  online: boolean;
  onChanged(): void;
  onSharingChanged(): void;
}

const ROLE_TITLE: Record<ReviewStage["role"], string> = {
  architecture: "Architecture, feasibility and scope",
  risks: "Risks, failure behaviour and testability",
  single: "One reviewer, both briefs",
  chair: "Chair",
};

export const STATUS_LOOK: Record<TurnStatus, { label: string; color: string }> = {
  submitting: { label: "Sending", color: "gray" },
  running: { label: "Reviewing", color: "blue" },
  // Complete is about the review, never the plan: no green.
  answered: { label: "Complete", color: "indigo" },
  failed: { label: "Failed", color: "red" },
  cancelled: { label: "Cancelled", color: "gray" },
  interrupted: { label: "Interrupted", color: "yellow" },
  "not-sent": { label: "Not sent", color: "gray" },
  unknown: { label: "Can't tell", color: "yellow" },
};

const STAGE_STATUS: Record<ReviewStage["status"], string> = { pending: "waiting", running: "asked", answered: "answered", failed: "failed", skipped: "skipped" };

const preferenceKind = (preference: { scope: PreferenceScope; intent: PreferenceIntent }) =>
  preference.scope === "personal" ? "Your personal default" : preference.intent === "override" ? "Project decision, which outranks the repository's conventions" : "Project default";

const shortHead = (head: string | null) => (head ? head.slice(0, 12) : "no commits yet");

/** A Review button and the reviews of one plan, newest first. */
export function PlanReviews({ versions, reviewing }: { versions: PlanView[]; reviewing: PlanReviewing }) {
  const latest = versions.at(-1)!;
  const [dialogFor, setDialogFor] = useState<string | null>(null);
  const reviews = reviewing.reviews.filter((review) => review.planLineage === latest.lineageId).reverse();
  return (
    <Stack gap="xs" data-testid="plan-reviews">
      <Group gap="xs">
        {/* Why it is off shows where it applies: the composer, the open review's card, or the closed conversation. */}
        <Button size="compact-xs" variant="default" onClick={() => setDialogFor(latest.id)} disabled={reviewing.blocked !== null} title={reviewing.blocked ?? undefined} data-testid="plan-review">
          Review…
        </Button>
      </Group>
      {reviews.map((review) => (
        <ReviewCard key={review.id} review={review} reviewing={reviewing} onReviewAgain={() => setDialogFor(review.planId)} />
      ))}
      <ReviewDialog
        opened={dialogFor !== null}
        planId={dialogFor ?? latest.id}
        versions={versions}
        project={reviewing.project}
        onClose={() => setDialogFor(null)}
        onStarted={reviewing.onChanged}
        onSharingChanged={reviewing.onSharingChanged}
      />
    </Stack>
  );
}

/**
 * Previews a review of one plan version (D31): the version to review, what is sent and what isn't, and the most model
 * calls it makes. Start sends exactly what the preview showed: when that changed meanwhile, starting is refused and the
 * new preview is shown. A project that doesn't allow sharing asks for its consent first.
 */
function ReviewDialog({
  opened,
  planId: initial,
  versions,
  project,
  onClose,
  onStarted,
  onSharingChanged,
}: {
  opened: boolean;
  planId: string;
  versions: PlanView[];
  project: ProjectView | null;
  onClose(): void;
  onStarted(): void;
  onSharingChanged(): void;
}) {
  const [planId, setPlanId] = useState(initial);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [read, setRead] = useState(0);

  useEffect(() => {
    if (!opened) return;
    setPlanId(initial);
    setError(null);
  }, [opened, initial]);

  useEffect(() => {
    if (!opened) return;
    let active = true;
    setPreview(null);
    window.nivra.prepareReview(planId, "council").then(
      (value) => active && setPreview(value),
      (reason: unknown) => active && setError(errorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [opened, planId, read]);

  async function start() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await window.nivra.startReview(preview.planId, "council", preview.expected);
      onStarted();
      onClose();
    } catch (reason) {
      // Whatever stopped it, the preview is read again, so what is shown is what a new start would send.
      setError(errorMessage(reason));
      setRead((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function allowSharing() {
    setConsent(false);
    if (!project) return;
    setError(null);
    try {
      await window.nivra.setSharing(project.id, true);
      onSharingChanged();
      setRead((n) => n + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const sharingOff = preview?.scope.kind === "project" && !preview.scope.sharing;
  return (
    <>
      <Modal opened={opened && !consent} onClose={onClose} title={`Review plan v${preview?.planVersion ?? versions.find((v) => v.id === planId)?.version ?? ""}`} size="lg" data-testid="review-dialog">
        <Stack gap="sm">
          {versions.length > 1 && (
            <NativeSelect
              label="Version to review"
              value={planId}
              onChange={(event) => {
                setError(null);
                setPlanId(event.currentTarget.value);
              }}
              data={[...versions].reverse().map((version) => ({ value: version.id, label: `v${version.version}${version.version === versions.at(-1)!.version ? " (latest)" : ""}` }))}
              data-testid="review-version"
            />
          )}
          {preview ? <PreviewBody preview={preview} /> : !error && <Text size="sm" c="var(--nivra-text-3)">Working out what this review would send…</Text>}
          {preview?.blocked && (
            <Alert color="yellow" variant="light" data-testid="review-blocked">
              <Stack gap={6}>
                <Text size="sm">{preview.blocked}</Text>
                {sharingOff && project && (
                  <Group>
                    <Button size="xs" variant="default" onClick={() => setConsent(true)} data-testid="review-allow-sharing">
                      Allow sharing for {project.label}…
                    </Button>
                  </Group>
                )}
              </Stack>
            </Alert>
          )}
          {error && (
            <Text size="sm" c="var(--nivra-error)" data-testid="review-error">
              {error}
            </Text>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose} data-testid="review-dialog-cancel">
              Cancel
            </Button>
            <Button onClick={() => void start()} loading={busy} disabled={!preview || preview.blocked !== null} data-testid="review-start">
              Start review
            </Button>
          </Group>
        </Stack>
      </Modal>
      <ConsentModal
        opened={opened && consent}
        onClose={() => setConsent(false)}
        onAllow={() => void allowSharing()}
        intro={`To review plans from conversations about ${project?.label ?? "this project"}, Nivra sends Nebius Token Factory:`}
        sends={["the plan version's text and its assumptions;", "where the answer it came from looked: file paths and line numbers, never the lines;", "your confirmed preferences that apply to this project."]}
        after={CONSENT_COVERS}
        testId="review-consent"
      />
    </>
  );
}

function PreviewBody({ preview }: { preview: ReviewPreview }) {
  const { sends, scope } = preview;
  return (
    <Stack gap="xs" data-testid="review-preview" data-plan-version={preview.planVersion}>
      <Text size="sm" data-testid="review-preview-version">
        Reviewing v{preview.planVersion}
        {preview.planVersion === preview.latestVersion ? ", the latest version." : `; the plan is now at v${preview.latestVersion}.`}
      </Text>
      <Text size="sm" c="var(--nivra-text-2)" data-testid="review-preview-scope">
        {scope.kind === "general"
          ? "A general plan: no repository."
          : `${scope.projectLabel} · ${scope.targetLabel} · HEAD ${shortHead(scope.headAtStart)} when its answer was written · sharing ${scope.sharing ? "on" : "off"}`}
      </Text>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Sent to Nebius Token Factory
        </Text>
        <List size="sm" data-testid="review-preview-sends">
          <List.Item>The plan's text: {plural(sends.textChars, "character")}.</List.Item>
          <List.Item>{sends.assumptions ? `${plural(sends.assumptions, "assumption")} from the plan.` : "No assumptions: the plan has none."}</List.Item>
          {scope.kind === "project" && (
            <List.Item>
              {sends.references
                ? `${plural(sends.references, "historical reference")}: where the answer it came from looked, as paths and line numbers. Not the lines: nobody reads them again for this review.`
                : "No historical references: its answer cited no lines it was shown."}
            </List.Item>
          )}
          <List.Item>
            {sends.preferences.length ? `${plural(sends.preferences.length, "preference")} that apply:` : "No preferences: none of yours apply."}
            {sends.preferences.length > 0 && (
              <List size="sm" withPadding data-testid="review-preview-preferences">
                {sends.preferences.map((preference, index) => (
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
      <Text size="sm" data-testid="review-preview-not-sent">
        Not sent: the repository's files, this conversation, other plans or versions, and your tasks. The reviewers can't read the repository, so anything they say
        about the code is an assumption.
      </Text>
      <Text size="sm" data-testid="review-preview-cost">
        {preview.requests === 3 ? "Two reviewers, then a chair: up to 3 model calls." : `One reviewer: ${plural(preview.requests, "model call")} at most.`} Nothing is retried.
      </Text>
      <Text size="xs" c="var(--nivra-text-3)">
        A review doesn't change the plan, mark a task ready, or approve anything.
      </Text>
    </Stack>
  );
}

function ReviewCard({ review, reviewing, onReviewAgain }: { review: ReviewView; reviewing: PlanReviewing; onReviewAgain(): void }) {
  const open = isOpenReview(review);
  const report = review.report;
  const look = review.status === "failed" && report?.outcome === "incomplete" ? { label: "Incomplete", color: "orange" } : STATUS_LOOK[review.status];
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setError(null);
    try {
      await window.nivra.cancelReview(review.conversationId, review.id);
      reviewing.onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  return (
    <Paper withBorder p="sm" radius="md" data-testid="review" data-review-id={review.id} data-status={review.status} data-plan-version={review.planVersion}>
      <Stack gap={8}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Text size="xs" fw={600}>
              {review.panel === "council" ? "Council review" : "Single review"} · v{review.planVersion}
            </Text>
            <Badge color={look.color} variant="light" data-testid="review-status">
              {open && review.cancelRequested ? "Cancelling" : look.label}
            </Badge>
          </Group>
          {open ? (
            <Button size="compact-xs" variant="default" onClick={() => void cancel()} disabled={review.cancelRequested} data-testid="review-cancel">
              Cancel
            </Button>
          ) : (
            <Button size="compact-xs" variant="subtle" onClick={onReviewAgain} disabled={reviewing.blocked !== null} data-testid="review-again">
              Review again
            </Button>
          )}
        </Group>
        {review.latestVersion > review.planVersion && (
          <Text size="xs" c="var(--nivra-warning)" data-testid="review-stale">
            The plan is now at v{review.latestVersion}. This review is of v{review.planVersion}, and stays as it was.
          </Text>
        )}
        {open && review.runId && <ReviewProgress runId={review.runId} online={reviewing.online} />}
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
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="review-card-error">
            {error}
          </Text>
        )}
        {report && (
          <>
            {report.outcome === "incomplete" && (
              <Text size="sm" data-testid="review-incomplete">
                Incomplete: this report holds only what the stages that answered produced.
              </Text>
            )}
            <Stages stages={report.stages} />
            {report.reviewers.map((reviewer) => (
              <Reviewer key={reviewer.role} reviewer={reviewer} references={review.references} />
            ))}
            {report.synthesis && <Synthesis synthesis={report.synthesis} />}
          </>
        )}
        <Text size="xs" c="var(--nivra-text-3)" data-testid="review-not-approval">
          This review doesn't change the plan, mark a task ready, or approve anything.
        </Text>
        <Text size="xs" c="var(--nivra-text-3)" data-testid="review-binding">
          {review.scope.kind === "general" ? "General plan" : `${review.scope.projectLabel ?? "A project"} · HEAD ${shortHead(review.scope.headAtStart)}`} · packet{" "}
          {review.packetDigest.slice(0, 12)} · {plural(review.given.preferences, "preference")} ({review.preferencesDigest.slice(0, 12)})
        </Text>
        {report && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="review-usage">
            {report.route ? `${report.route.model}${report.route.endpoint === "loopback-test" ? " (test endpoint)" : ""}` : "Model unknown"} ·{" "}
            {(report.elapsedMs / 1000).toFixed(1)} s ·{" "}
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

/** What a review in progress is doing, from its run's events. */
export function ReviewProgress({ runId, online }: { runId: string; online: boolean }) {
  const { events } = useRunEvents(runId, online, "running");
  const latest = [...events].reverse().find((event) => event.type === "step.output" || event.type === "model.call");
  return latest ? (
    <Text size="xs" c="var(--nivra-text-3)" data-testid="review-progress">
      {latest.message}
    </Text>
  ) : null;
}

function Stages({ stages }: { stages: ReviewStage[] }) {
  return (
    <List size="xs" data-testid="review-stages">
      {stages.map((stage) => (
        <List.Item key={stage.role} data-testid="review-stage" data-role={stage.role} data-status={stage.status}>
          {ROLE_TITLE[stage.role]}: {STAGE_STATUS[stage.status]}
          {stage.status === "answered" && stage.inputTokens !== null && stage.outputTokens !== null ? ` · ${stage.inputTokens.toLocaleString()} in / ${stage.outputTokens.toLocaleString()} out tokens` : ""}
          {stage.elapsedMs !== null && stage.requests > 0 ? ` · ${(stage.elapsedMs / 1000).toFixed(1)} s` : ""}
          {stage.message ? `. ${stage.message}` : ""}
        </List.Item>
      ))}
    </List>
  );
}

export function Part({ title, note, testId, children }: { title: string; note?: string; testId: string; children: ReactNode }) {
  return (
    <Stack gap={4} data-testid={testId}>
      <Stack gap={0}>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        {note && (
          <Text size="xs" c="var(--nivra-text-3)">
            {note}
          </Text>
        )}
      </Stack>
      {children}
    </Stack>
  );
}

function Reviewer({ reviewer, references }: { reviewer: ReviewerReport; references: ReviewView["references"] }) {
  const { adjusted } = reviewer;
  const changes = [
    adjusted.dropped ? `${plural(adjusted.dropped, "finding")} over the limit left out` : "",
    adjusted.refsDropped ? `${plural(adjusted.refsDropped, "reference")} to nothing in the packet dropped` : "",
    adjusted.relabelled ? `${plural(adjusted.relabelled, "finding")} marked as an assumption` : "",
    adjusted.shortened ? `${plural(adjusted.shortened, "field")} shortened` : "",
  ].filter(Boolean);
  return (
    <Part title={ROLE_TITLE[reviewer.role]} testId="review-reviewer">
      <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="review-summary">
        {reviewer.summary}
      </Text>
      {reviewer.findings.length === 0 ? (
        <Text size="sm" c="var(--nivra-text-2)" data-testid="review-nothing-raised">
          Raised nothing material. That isn't an approval: it saw only the plan.
        </Text>
      ) : (
        reviewer.findings.map((finding) => <Finding key={finding.id} finding={finding} references={references} />)
      )}
      {reviewer.assumptions.length > 0 && <Text size="xs">Assumed: {reviewer.assumptions.join("; ")}</Text>}
      {reviewer.gaps.length > 0 && <Text size="xs">Couldn't tell from the plan: {reviewer.gaps.join("; ")}</Text>}
      {changes.length > 0 && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="review-adjusted">
          Nivra adjusted this report: {changes.join(", ")}.
        </Text>
      )}
    </Part>
  );
}

const SEVERITY_COLOR = { high: "red", medium: "orange", low: "gray" } as const;

function Finding({ finding, references }: { finding: ReviewFinding; references: ReviewView["references"] }) {
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
          {finding.basis === "plan" ? "From the plan" : "Assumption"}
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
            <RefChip key={`${index}-${ref}`} reference={ref} references={references} />
          ))}
        </Group>
      )}
      {finding.relabelled && (
        <Text size="xs" c="var(--nivra-text-3)">
          Marked as an assumption: what it names in the packet doesn't support more.
        </Text>
      )}
    </Stack>
  );
}

/** What a finding names in the packet: the plan, an assumption, a historical reference (never evidence), or a preference. */
function RefChip({ reference, references }: { reference: string; references: ReviewView["references"] }) {
  const assumption = /^A(\d+)$/.exec(reference);
  const historical = /^E(\d+)$/.exec(reference);
  const place = historical ? references[Number(historical[1]) - 1] : undefined;
  const label = reference === "plan" ? "the plan" : assumption ? `assumption ${assumption[1]}` : historical ? `${reference}${place ? ` · ${place.path}:${place.startLine}${place.endLine !== place.startLine ? `-${place.endLine}` : ""}` : ""} · historical` : "a preference";
  const title = historical ? "Where the answer the plan came from looked. Its lines weren't sent or read again, so it supports nothing." : reference;
  return (
    <Badge size="sm" variant="light" color="gray" title={title} style={{ textTransform: "none" }} data-testid="review-ref" data-ref={reference}>
      {label}
    </Badge>
  );
}

function Synthesis({ synthesis }: { synthesis: ChairSynthesis }) {
  const ids = (list: string[]) => list.join(", ");
  return (
    <Part title="The chair's synthesis" note="It weighs both reports. Agreement isn't proof: both reviewers saw the same plan and nothing else." testId="review-synthesis">
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
      {synthesis.gaps.length > 0 && <Text size="xs">Couldn't tell from the plan: {synthesis.gaps.join("; ")}</Text>}
      {synthesis.unaddressed.length > 0 && (
        <Text size="xs" data-testid="review-unaddressed">
          Not addressed by the chair: {ids(synthesis.unaddressed)}. Each is in its reviewer's report above.
        </Text>
      )}
    </Part>
  );
}
