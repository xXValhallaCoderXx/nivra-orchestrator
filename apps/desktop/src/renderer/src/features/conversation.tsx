import { Accordion, Alert, Badge, Button, Group, List, Modal, Paper, Stack, Text, Textarea, Title } from "@mantine/core";
import type { ChatResult, CheckedCitation, RunSummary } from "@nivra/domain";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MESSAGE_CHARS, type ConversationView, type MessageView, type PlanView, type PreferencesView, type ProjectView, type ReviewView, type TurnStatus, type TurnView } from "../../../shared/ipc";
import { CitationChip, ConflictItem, CONSENT_COVERS, ConsentModal, ContextDetails, HistoryDetails, receivedText, runLine } from "../shared/evidence";
import { useRunEvents } from "../shared/runs";
import { errorMessage, usePoll } from "../shared/ui";
import { EngineDot, EngineNotices } from "./engine";
import { AnswerPlans } from "./plans";
import { isOpenReview } from "./reviews";

type RepositoryReply = Extract<ChatResult, { kind: "repository" }>;

const isOpen = (turn: TurnView) => turn.status === "submitting" || turn.status === "running";

const TURN_LOOK: Record<TurnStatus, { label: string; color: string }> = {
  submitting: { label: "Sending", color: "gray" },
  running: { label: "Answering", color: "blue" },
  answered: { label: "Answered", color: "green" },
  failed: { label: "Failed", color: "red" },
  cancelled: { label: "Cancelled", color: "gray" },
  interrupted: { label: "Interrupted", color: "yellow" },
  "not-sent": { label: "Not sent", color: "gray" },
  unknown: { label: "Can't tell", color: "yellow" },
};

/** What is worth showing while a turn runs: its latest model call, tool call or step, from the run's events. */
const PROGRESS = new Set(["model.call", "tool.called", "step.output"]);

/**
 * One conversation (D26, NIV-31). Its scope was fixed when it started, and its turns run on its own engine, whatever
 * project is chosen elsewhere. Each message is a turn that is never resent: one that ended without an answer says why,
 * and sending it again makes a new turn. Answers are model output, shown as plain text; a repository answer keeps what
 * the code does now, what is proposed, and what was assumed apart, and each citation says whether its lines were shown
 * to the model.
 */
export function Conversation({
  conversationId,
  projects,
  preferences,
  onChanged,
  onDeleted,
  onSharingChanged,
  onCreateTask,
}: {
  conversationId: string;
  projects: ProjectView[];
  preferences: PreferencesView | null;
  /** Something the list shows changed: the title, or when it was last used. */
  onChanged(): void;
  onDeleted(): void;
  onSharingChanged(): void;
  /** Opens the new task form from a plan version, titled after the conversation. */
  onCreateTask(plan: PlanView, title: string): void;
}) {
  // Opening follows a turn left open on its own engine; after that, the view is only read.
  const opened = useRef(false);
  const poll = usePoll<ConversationView>(
    () => {
      if (opened.current) return window.nivra.getConversation(conversationId);
      opened.current = true;
      return window.nivra.openConversation(conversationId);
    },
    (current) => (current && (current.turns.some(isOpen) || current.openReview || current.engine.state.status === "starting") ? 700 : 2_500),
    [conversationId],
  );
  const [plansRead, setPlansRead] = useState(0);
  const plans = usePoll<PlanView[]>(() => window.nivra.listPlans(conversationId), () => null, [conversationId, plansRead]);
  // Reviews are read again while one goes, and whenever the conversation says one started or ended (D31).
  const [reviewsRead, setReviewsRead] = useState(0);
  const reviews = usePoll<ReviewView[]>(() => window.nivra.listReviews(conversationId), (current) => (current?.some(isOpenReview) ? 700 : null), [conversationId, reviewsRead, poll.value?.openReview ?? null]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const view = poll.value;
  if (!view) {
    return poll.error ? (
      <Alert color="red" title="This conversation can't be shown" data-testid="conversation-unavailable">
        <Text size="sm">{poll.error}</Text>
      </Alert>
    ) : (
      <Text size="sm" c="var(--nivra-text-3)">
        Opening the conversation…
      </Text>
    );
  }

  const { summary } = view;
  const project = summary.projectId ? (projects.find((p) => p.id === summary.projectId) ?? null) : null;
  const openTurn = view.turns.find(isOpen) ?? null;
  const online = view.engine.state.status === "online";
  const trimmed = text.trim();
  const over = trimmed.length > MESSAGE_CHARS;
  const canSend = !view.closed && !openTurn && !view.openReview && !busy;
  const reviewing = {
    reviews: reviews.value ?? [],
    blocked: view.closed ?? (openTurn ? "Wait for the answer, or cancel it, before starting a review." : view.openReview ? "A review is already running in this conversation." : null),
    project,
    online,
    onChanged: () => {
      setReviewsRead((n) => n + 1);
      poll.refresh();
      onChanged();
    },
    onSharingChanged,
  };
  const scope =
    summary.kind === "general"
      ? "General · no repository access"
      : summary.projectPresent === false
        ? `${summary.projectLabel ?? "A project"} · removed from the list`
        : `${summary.projectLabel ?? "A project"} · ${view.engine.label} · sharing ${project?.sharing.modelContext ? "on" : "off"}`;
  const turns = new Map(view.turns.map((turn) => [turn.id, turn]));
  const answers = new Map(view.messages.filter((m) => m.role === "assistant" && m.turnId).map((m) => [m.turnId!, m]));

  async function sendNow(message: string) {
    setBusy(true);
    setError(null);
    try {
      await window.nivra.sendMessage(conversationId, message);
      setText((current) => (current.trim() === message ? "" : current));
      onChanged();
      poll.refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  /** A repository conversation asks for its project's consent first, as Explain does (D20). */
  async function send(message: string) {
    if (!message || !canSend) return;
    if (summary.kind === "project" && project && !project.sharing.modelContext) {
      setConsentFor(message);
      return;
    }
    await sendNow(message);
  }

  async function allowAndSend() {
    const message = consentFor;
    setConsentFor(null);
    if (message === null || !summary.projectId) return;
    try {
      await window.nivra.setSharing(summary.projectId, true);
      onSharingChanged();
      await sendNow(message);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function cancel(turnId: string) {
    setError(null);
    try {
      await window.nivra.cancelTurn(conversationId, turnId);
      poll.refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function restartEngine() {
    await window.nivra.restartConversationEngine(conversationId);
    poll.refresh();
  }

  async function remove() {
    setConfirmDelete(false);
    setError(null);
    try {
      await window.nivra.deleteConversation(conversationId);
      onDeleted();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  return (
    <Stack gap="md" data-testid="conversation" data-conversation-id={conversationId}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Title order={2} style={{ overflowWrap: "anywhere" }} data-testid="conversation-title">
            {summary.title}
          </Title>
          <Text size="sm" c="var(--nivra-text-2)" data-testid="conversation-scope">
            {scope}
          </Text>
        </Stack>
        <Group gap="sm" wrap="nowrap">
          <EngineDot engine={view.engine} stoppedLabel="Starts when you send" testId="conversation-engine-state" />
          <Button size="xs" variant="subtle" color="red" onClick={() => setConfirmDelete(true)} data-testid="conversation-delete">
            Delete
          </Button>
        </Group>
      </Group>
      <EngineNotices engine={view.engine} onRestart={restartEngine} testId="conversation-engine" />
      {view.closed && (
        <Alert color="yellow" variant="light" data-testid="conversation-closed">
          <Text size="sm">{view.closed}</Text>
        </Alert>
      )}
      {view.messages.length === 0 && (
        <Text size="sm" c="var(--nivra-text-3)" data-testid="conversation-empty">
          {summary.kind === "general"
            ? "Nothing here yet. A general conversation reaches no repository, and gets your personal preferences only."
            : `Nothing here yet. Nivra answers from ${summary.projectLabel ?? "the project"}'s tracked files, and from your preferences for it.`}
        </Text>
      )}
      {view.messages
        .filter((message) => message.role === "person")
        .map((message) => {
          const turn = message.turnId ? (turns.get(message.turnId) ?? null) : null;
          const answer = message.turnId ? (answers.get(message.turnId) ?? null) : null;
          return (
            <Stack key={message.id} gap="xs" data-testid="turn" data-turn-id={turn?.id} data-status={turn?.status}>
              <PersonMessage message={message} />
              {answer ? (
                <Answer message={answer} turn={turn} online={online} preferences={preferences}>
                  {answer.reply && (
                    <AnswerPlans
                      conversationId={conversationId}
                      messageId={answer.id}
                      reply={answer.reply}
                      plans={(plans.value ?? []).filter((plan) => plan.messageId === answer.id)}
                      reviewing={reviewing}
                      onSaved={() => {
                        setPlansRead((n) => n + 1);
                        setReviewsRead((n) => n + 1);
                      }}
                      onCreateTask={(plan) => onCreateTask(plan, summary.title)}
                    />
                  )}
                </Answer>
              ) : (
                turn && (
                  <TurnLine
                    turn={turn}
                    online={online}
                    canSendAgain={canSend}
                    onCancel={() => void cancel(turn.id)}
                    onSendAgain={() => void send(message.text)}
                    onStartEngine={view.engine.state.status === "stopped" ? () => void restartEngine().catch((reason: unknown) => setError(errorMessage(reason))) : null}
                  />
                )
              )}
            </Stack>
          );
        })}
      <Stack gap={4}>
        <Textarea
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              if (trimmed && !over) void send(trimmed);
            }
          }}
          placeholder={summary.kind === "general" ? "Ask anything. Nivra reaches no repository here." : `Ask about ${summary.projectLabel ?? "the project"}. Nivra reads its tracked files to answer.`}
          autosize
          minRows={2}
          maxRows={10}
          disabled={view.closed !== null}
          aria-label="Message"
          data-testid="composer"
        />
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c={over ? "var(--nivra-error)" : "var(--nivra-text-3)"} data-testid="composer-count">
            {trimmed.length.toLocaleString()} / {MESSAGE_CHARS.toLocaleString()}
            {over ? " · shorten it to send" : ""}
          </Text>
          <Button size="xs" onClick={() => void send(trimmed)} loading={busy} disabled={!canSend || !trimmed || over} data-testid="composer-send">
            Send
          </Button>
        </Group>
        {openTurn && (
          <Text size="xs" c="var(--nivra-text-3)">
            Wait for the answer, or cancel it, before sending another message.
          </Text>
        )}
        {view.openReview && (
          <Text size="xs" c="var(--nivra-text-3)" data-testid="composer-review-running">
            A review of a plan is running in this conversation. Wait for it, or cancel it, before sending a message.
          </Text>
        )}
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="conversation-error">
            {error}
          </Text>
        )}
      </Stack>
      <ConsentModal
        opened={consentFor !== null}
        onClose={() => setConsentFor(null)}
        onAllow={() => void allowAndSend()}
        intro={`To answer in this conversation about ${summary.projectLabel ?? "this repository"}, Nivra sends Nebius Token Factory:`}
        sends={["excerpts and paths from the project's tracked files;", "your message, and the conversation so far;", "your confirmed preferences that apply to this project."]}
        after={CONSENT_COVERS}
        testId="conversation-consent"
      />
      <Modal opened={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this conversation?" data-testid="conversation-delete-dialog">
        <Stack gap="sm">
          <Text size="sm">Its messages, turns, plans and reviews are deleted from Nivra. A message or a review still going is stopped first.</Text>
          <Text size="sm">
            What stays: each engine keeps its own record of these runs, your messages and the reviews' reports included (a report can quote the plan), and a task keeps
            the text its brief copied from a plan.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void remove()} data-testid="conversation-delete-confirm">
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function PersonMessage({ message }: { message: MessageView }) {
  return (
    <Paper p="sm" radius="md" bg="var(--nivra-subtle)" data-testid="message-person">
      <Text size="xs" fw={600} c="var(--nivra-text-3)">
        You
      </Text>
      <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {message.text}
      </Text>
    </Paper>
  );
}

/** A turn that hasn't been answered: going, or ended with what happened, and nothing ever resent. */
function TurnLine({
  turn,
  online,
  canSendAgain,
  onCancel,
  onSendAgain,
  onStartEngine,
}: {
  turn: TurnView;
  online: boolean;
  canSendAgain: boolean;
  onCancel(): void;
  onSendAgain(): void;
  /** Offered while the turn waits on an engine that isn't running. */
  onStartEngine: (() => void) | null;
}) {
  const open = isOpen(turn);
  const look = TURN_LOOK[turn.status];
  return (
    <Stack gap={4} data-testid="turn-line">
      <Group gap="xs">
        <Badge color={look.color} variant="light" data-testid="turn-status">
          {open && turn.cancelRequested ? "Cancelling" : look.label}
        </Badge>
        {open && turn.runId && <TurnProgress runId={turn.runId} online={online} />}
        {open && (
          <Button size="compact-xs" variant="default" onClick={onCancel} disabled={turn.cancelRequested} data-testid="turn-cancel">
            Cancel
          </Button>
        )}
        {!open && (
          <Button size="compact-xs" variant="default" onClick={onSendAgain} disabled={!canSendAgain} data-testid="turn-send-again">
            Send again
          </Button>
        )}
      </Group>
      {turn.note && (
        <Text size="sm" c="var(--nivra-text-2)" data-testid="turn-note">
          {turn.note}
        </Text>
      )}
      {turn.unresolved && (
        <Group gap="xs">
          <Text size="sm" c="var(--nivra-warning)" data-testid="turn-unresolved">
            {turn.unresolved}
          </Text>
          {onStartEngine && (
            <Button size="compact-xs" variant="default" onClick={onStartEngine} data-testid="turn-start-engine">
              Start its engine
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}

function TurnProgress({ runId, online }: { runId: string; online: boolean }) {
  const { events } = useRunEvents(runId, online, "running");
  const latest = [...events].reverse().find((event) => PROGRESS.has(event.type));
  return latest ? (
    <Text size="xs" c="var(--nivra-text-3)" data-testid="turn-progress">
      {latest.message}
    </Text>
  ) : null;
}

function Answer({ message, turn, online, preferences, children }: { message: MessageView; turn: TurnView | null; online: boolean; preferences: PreferencesView | null; children: ReactNode }) {
  const reply = message.reply;
  return (
    <Paper withBorder p="md" radius="md" data-testid="answer" data-kind={reply?.kind ?? "text"}>
      <Stack gap="sm">
        <Text size="xs" fw={600} c="var(--nivra-text-3)">
          Nivra
        </Text>
        {reply?.kind === "repository" ? (
          <RepositoryAnswer reply={reply} preferences={preferences} />
        ) : (
          <>
            <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="answer-text">
              {message.text}
            </Text>
            {reply?.cutOff && (
              <Text size="xs" c="var(--nivra-warning)" data-testid="answer-cut-off">
                Cut off: the model stopped at its length limit, so this answer is incomplete.
              </Text>
            )}
          </>
        )}
        {reply && turn && <AnswerDetails reply={reply} runId={turn.runId} online={online} />}
        {children}
      </Stack>
    </Paper>
  );
}

function Part({ title, note, testId, children }: { title: string; note?: string; testId: string; children: ReactNode }) {
  return (
    <Stack gap={6} data-testid={testId}>
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

function Citations({ citations }: { citations: CheckedCitation[] }) {
  return (
    <Group gap={4}>
      {citations.length ? (
        citations.map((citation, i) => <CitationChip key={i} citation={citation} testId="answer-citation" />)
      ) : (
        <Text size="xs" c="var(--nivra-text-3)">
          No citation
        </Text>
      )}
    </Group>
  );
}

/** A repository answer in its parts (D26): what the code does now, what is proposed, what was assumed, and the rest. */
function RepositoryAnswer({ reply, preferences }: { reply: RepositoryReply; preferences: PreferencesView | null }) {
  return (
    <Stack gap="sm" data-testid="answer-repository">
      <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="answer-text">
        {reply.answer}
      </Text>
      {reply.evidence.length > 0 && (
        <Part title="What the code does now" testId="answer-evidence">
          {reply.evidence.map((item, index) => (
            <Stack key={index} gap={4} data-testid="answer-evidence-item">
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {item.statement}
              </Text>
              <Citations citations={item.citations} />
            </Stack>
          ))}
        </Part>
      )}
      {reply.proposals.length > 0 && (
        <Part title="Proposed, not verified" note="Changes or options. They say what could be done, not what the code does." testId="answer-proposals">
          {reply.proposals.map((proposal, index) => (
            <Stack key={index} gap={4} data-testid="answer-proposal">
              <Text size="sm" fw={600}>
                {proposal.title}
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {proposal.detail}
              </Text>
              <Citations citations={proposal.citations} />
            </Stack>
          ))}
        </Part>
      )}
      {reply.assumptions.length > 0 && (
        <Part title="Assumptions" note="Taken as true without checking." testId="answer-assumptions">
          <List size="sm">
            {reply.assumptions.map((assumption, index) => (
              <List.Item key={index}>{assumption}</List.Item>
            ))}
          </List>
        </Part>
      )}
      {reply.conflicts.length > 0 && (
        <Part title="Conflicts" testId="answer-conflicts">
          {reply.conflicts.map((conflict, index) => (
            <ConflictItem key={index} conflict={conflict} choices={[]} preferences={preferences} prefix="answer" />
          ))}
        </Part>
      )}
      {reply.gaps.length > 0 && (
        <Part title="Not established" testId="answer-gaps">
          <List size="sm">
            {reply.gaps.map((gap, index) => (
              <List.Item key={index}>{gap}</List.Item>
            ))}
          </List>
        </Part>
      )}
      <Text size="xs" c="var(--nivra-text-3)" data-testid="answer-head">
        HEAD at the start: {reply.headAtStart ? reply.headAtStart.slice(0, 12) : "no commits yet"} · read as the files were on disk · {reply.checks.checked} of{" "}
        {reply.checks.citations} citations point to lines the model was shown
      </Text>
      {reply.headAtEnd !== reply.headAtStart && (
        <Alert color="yellow" variant="light">
          <Text size="sm">
            HEAD changed during this turn ({reply.headAtStart?.slice(0, 12) ?? "none"} → {reply.headAtEnd?.slice(0, 12) ?? "none"}). Some of what was read may come from
            either.
          </Text>
        </Alert>
      )}
      {reply.context.changedFiles.length > 0 && (
        <Alert color="yellow" variant="light">
          <Text size="sm">These files changed while the turn read them, so citations into them aren't checked: {reply.context.changedFiles.join(", ")}.</Text>
        </Alert>
      )}
    </Stack>
  );
}

/**
 * What an answer was given, collapsed (D21, D26): the preferences received, the history sent and what was left out, and
 * for a repository answer, explain's context view. The model, time and tokens come from the run's summary, which only
 * its engine has: they are read when the section is opened, while that engine runs.
 */
function AnswerDetails({ reply, runId, online }: { reply: ChatResult; runId: string | null; online: boolean }) {
  const [opened, setOpened] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (opened !== "given" || summary || !runId) return;
    if (!online) {
      setNote("The model, time and tokens are kept by the engine that ran this turn, which isn't running now.");
      return;
    }
    let active = true;
    setNote(null);
    window.nivra.runResult(runId).then(
      (value) => active && setSummary(value.summary),
      (reason: unknown) => active && setNote(errorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [opened, online, runId, summary]);

  return (
    <Accordion variant="contained" chevronPosition="left" value={opened} onChange={setOpened} data-testid="answer-details-panel">
      <Accordion.Item value="given">
        <Accordion.Control>
          <Text size="xs" c="var(--nivra-text-3)" data-testid="answer-details">
            What this answer was given
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap={8}>
            {reply.kind === "repository" ? (
              <ContextDetails context={reply.context} prefix="answer" />
            ) : (
              <Stack gap={2}>
                <Text size="xs" fw={600}>
                  What the model was given
                </Text>
                <Text size="xs" data-testid="answer-context-preferences">
                  Preferences received: {receivedText(reply.context.preferences)}
                </Text>
                <Text size="xs">No repository: a general conversation reaches none, and gets your personal preferences only.</Text>
              </Stack>
            )}
            <HistoryDetails history={reply.context.history} prefix="answer" />
            <Text size="xs" c="var(--nivra-text-3)" data-testid="answer-run-line">
              {summary ? runLine(summary) : (note ?? (runId ? "Reading the run's details…" : "No run is recorded for this answer."))}
            </Text>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
