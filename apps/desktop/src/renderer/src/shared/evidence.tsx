import { Badge, Button, Group, List, Modal, Stack, Text } from "@mantine/core";
import type { AnswerDueReason, CheckedCitation, ConflictOutcome, ConflictSource, ExplainConflict, ExplainResult, HistoryRecord, PreferencesReceived, RunStatus, RunSummary } from "@nivra/domain";
import type { PreferencesView } from "../../../shared/ipc";

/**
 * What explanations and repository answers share (D22, D23, D26): citations that say whether their lines were shown to
 * the model, conflicts as the engine ranked them, what a run was given and left out, and the project's consent. Each
 * part takes a test id prefix; Explain's are the defaults.
 */

export const STATUS_COLOR: Record<RunStatus, string> = { queued: "gray", running: "blue", waiting_for_approval: "yellow", succeeded: "green", failed: "red", cancelled: "gray" };

export const usageText = (summary: RunSummary): string => {
  const usage = summary.usage;
  if (!usage || usage.calls === 0) return "tokens not reported";
  if (usage.inputTokens !== null && usage.outputTokens !== null) return `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`;
  return usage.reportedCalls ? `tokens partly reported (${usage.reportedCalls} of ${usage.calls} calls)` : "tokens not reported";
};

/** A run's model, time and tokens, as its summary recorded them. */
export const runLine = (summary: RunSummary): string =>
  `${summary.route ? `${summary.route.model}${summary.route.endpoint === "loopback-test" ? " (test endpoint)" : ""}` : "model unknown"} · ${
    summary.durationMs !== null ? `${(summary.durationMs / 1000).toFixed(1)} s` : "time not recorded"
  } · ${usageText(summary)}`;

export function CitationChip({ citation, testId = "explain-citation" }: { citation: CheckedCitation; testId?: string }) {
  const where = `${citation.path}:${citation.startLine}${citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}`;
  return (
    <Badge
      variant="light"
      color={citation.checked ? "green" : "gray"}
      title={citation.checked ? "Shown to the model before it answered (a location, not proof of the claim)" : `Not checked: ${citation.problem ?? ""}`}
      style={{ textTransform: "none" }}
      data-testid={testId}
      data-checked={citation.checked ? "yes" : "no"}
    >
      {where}
      {citation.checked ? "" : ` · ${citation.problem}`}
    </Badge>
  );
}

/** Files and the lines delivered from each, as "README.md 1-50; src/a.ts 7, 9-10". */
export const linesByFile = (files: ExplainResult["context"]["reads"]): string =>
  files.map((file) => `${file.path} ${file.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ")}`).join("; ");

/** A conflict's sources, highest rank first (D23). */
const SOURCE_LABEL: Record<ConflictSource, string> = {
  choice: "this task's choice",
  override: "this project's decision to change its conventions",
  repository: "the repository's convention",
  "project-default": "this project's default",
  "personal-default": "your personal default",
};
const REASON: Record<ConflictOutcome, string> = {
  choice: "Choices for this task come first.",
  override: "A project's decision to change its conventions comes before the repository's conventions.",
  repository: "The repository's own conventions come before defaults.",
  "project-default": "Nothing ranked higher was established.",
  "personal-default": "Nothing ranked higher was established.",
  unresolved: "Sources of the same rank disagree, so Nivra picked neither. Add a choice for this task to settle it.",
};
/** Choices are the top rank, so a tie between them is settled only by changing one of them. */
const CHOICES_TIED = "Choices for this task disagree, so Nivra picked neither. Remove or reword one of them, then explain again.";

/**
 * A preference's wording, but only while it is still the confirmed version the run was given. Otherwise the window
 * says it changed, so an old result never shows a replaced or edited preference as current.
 */
export function preferenceText(preferences: PreferencesView | null, id: string, revision: number): { current: boolean; text: string } {
  if (!preferences) return { current: false, text: `a preference (id ${id.slice(0, 8)}, revision ${revision}; the list hasn't loaded yet)` };
  const records = preferences.records;
  const record = records.find((candidate) => candidate.id === id);
  if (record && record.status === "confirmed" && record.revision === revision) return { current: true, text: `“${record.statement}”` };
  if (record?.status === "superseded") {
    // Followed to the preference now in use; one replaced in turn, or deleted, isn't named.
    let next = records.find((candidate) => candidate.id === record.supersededBy);
    for (let hops = 0; next && next.status === "superseded" && hops < records.length; hops++) next = records.find((candidate) => candidate.id === next!.supersededBy);
    return { current: false, text: `a preference replaced since this run${next ? ` by “${next.statement}”` : ""} (id ${id.slice(0, 8)}, revision ${revision})` };
  }
  return { current: false, text: `a preference that changed or was deleted since this run (id ${id.slice(0, 8)}, revision ${revision})` };
}

/**
 * One conflict as the engine ranked it (D23): what the code does now, what is intended when a choice or decision
 * governs, which source governs this task's work and why, and what else spoke to the topic. Each conflict stands on its
 * own: the model can split a topic in two, so the window never merges them.
 */
export function ConflictItem({
  conflict,
  choices,
  preferences,
  prefix = "explain",
}: {
  conflict: ExplainConflict;
  choices: ExplainResult["choices"];
  preferences: PreferencesView | null;
  prefix?: string;
}) {
  const established = conflict.repositoryConvention !== null && conflict.citations.some((citation) => citation.checked);
  const sources: Array<{ source: ConflictSource; id: string | null }> = [
    ...conflict.choices.map((id) => ({ source: "choice" as const, id })),
    ...conflict.preferences.map((p) => ({ source: (p.scope === "personal" ? "personal-default" : p.intent === "override" ? "override" : "project-default") as ConflictSource, id: p.id })),
    ...(established ? [{ source: "repository" as const, id: null }] : []),
  ];
  const wording = (source: { source: ConflictSource; id: string | null }): string => {
    if (source.source === "repository") return conflict.repositoryConvention ?? "";
    if (source.source === "choice") return `${source.id}: “${choices.find((choice) => choice.id === source.id)?.text ?? ""}”`;
    const preference = conflict.preferences.find((p) => p.id === source.id);
    return preference ? preferenceText(preferences, preference.id, preference.revision).text : "";
  };
  const governs = conflict.governs;
  const intended = governs && (governs.source === "choice" || governs.source === "override") ? governs : null;
  const others = sources.filter((source) => !(governs && source.source === governs.source && source.id === governs.id));
  return (
    <Stack gap={4} data-testid={`${prefix}-conflict`} data-reason={conflict.reason}>
      <Text size="sm" fw={600}>
        {conflict.topic}
      </Text>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }} data-testid={`${prefix}-conflict-currently`}>
        Currently: {conflict.repositoryConvention ?? "no convention of the repository's was reported"}
        {conflict.repositoryConvention !== null && !established ? " (not established: none of the lines it cites was shown to the model)" : ""}
      </Text>
      {conflict.citations.length > 0 && (
        <Group gap={4}>
          {conflict.citations.map((citation, i) => (
            <CitationChip key={i} citation={citation} testId={`${prefix}-citation`} />
          ))}
        </Group>
      )}
      {intended && (
        <Text size="sm" data-testid={`${prefix}-conflict-intended`}>
          Intended: {wording(intended)}
        </Text>
      )}
      <Text size="sm" data-testid={`${prefix}-conflict-governs`}>
        {governs
          ? `Governs this task: ${SOURCE_LABEL[governs.source]}${intended ? "" : governs.source === "repository" ? "" : ` ${wording(governs)}`}. ${REASON[conflict.reason]}`
          : `Unresolved. ${conflict.choices.length > 0 ? CHOICES_TIED : REASON.unresolved}`}
      </Text>
      {others.length > 0 && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid={`${prefix}-conflict-others`}>
          {governs ? "Outranked" : "Disagreeing"}: {others.map((source) => `${SOURCE_LABEL[source.source]} ${wording(source)}`).join("; ")}
        </Text>
      )}
    </Stack>
  );
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const DUE: Record<AnswerDueReason, string> = {
  "last-steps": "the last steps were reached",
  time: "time ran short",
  budget: "the budget ran out",
  "run-budget": "the run's input budget had room for one more answer only",
};
const KIND_LABEL = { "personal-default": "personal default", "project-default": "project default", override: "project decision" } as const;
const NOT_RECORDED = "Not recorded for this run.";

/**
 * A run's limits and what it used (D30): the calls and time are enforced; the input budget is Nivra's estimate, never a
 * ceiling, so what was counted, what the provider reported and any overrun are said apart.
 */
export function runBudgetText(record: NonNullable<ExplainResult["context"]["runBudget"]>): string {
  const { limits, used } = record;
  const reported = used.reportedInputTokens !== null ? `${plural(used.reportedInputTokens, "token")} reported` : "not every call reported its tokens";
  const overrun = used.overrunTokens ? `; ${plural(used.overrunTokens, "token")} more than Nivra estimated` : "";
  return `Run budget: ${used.requests} of ${limits.requests} model calls. Input: ${plural(used.inputTokens, "token")} counted against an estimated ${plural(limits.estimatedInputTokens, "token")} (${reported}${overrun}). The input budget is an estimate, not a ceiling.`;
}

/** What the answers turned down cost (NIV-26), when there were any: tokens only as reported, never 0 for unknown. */
function turnedDownText(cost: NonNullable<ExplainResult["context"]["answer"]>["turnedDown"]): string {
  if (!cost || cost.steps === 0) return "";
  const tokens = cost.inputTokens !== null && cost.outputTokens !== null ? `${plural(cost.inputTokens, "token")} in / ${cost.outputTokens.toLocaleString()} out` : "tokens not reported";
  return ` Answers turned down took ${plural(cost.steps, "model step")}: ${tokens}, ${(cost.elapsedMs / 1000).toFixed(1)} s.`;
}

/** The preferences a run received, by kind, with the store's revision and the fingerprint; never zero when unrecorded. */
export function receivedText(received: PreferencesReceived | null): string {
  if (!received) return NOT_RECORDED;
  if (!received.records.length) return `none (store revision ${received.revision})`;
  const kinds = received.records.map((record) => KIND_LABEL[record.scope === "personal" ? "personal-default" : record.intent === "override" ? "override" : "project-default"]);
  const byKind = (Object.values(KIND_LABEL) as string[]).map((kind) => [kind, kinds.filter((k) => k === kind).length] as const).filter(([, n]) => n > 0);
  return `${byKind.map(([kind, n]) => plural(n, kind)).join(", ")} (store revision ${received.revision}, fingerprint ${received.digest.slice(0, 12)})`;
}

/**
 * The context view (NIV-11, D23): what the model was given, what was left out, and how the budget and the answer went.
 * A result stored before these were recorded says so, never zero. `choices` is shown only for a run that takes them.
 */
export function ContextDetails({ context, choices, prefix = "explain" }: { context: ExplainResult["context"]; choices?: ExplainResult["choices"]; prefix?: string }) {
  const { hidden, budget, answer } = context;
  return (
    <Stack gap={8} data-testid={`${prefix}-context-details`}>
      <Stack gap={2}>
        <Text size="xs" fw={600}>
          What the model was given
        </Text>
        <Text size="xs" data-testid={`${prefix}-context-preferences`}>
          Preferences received: {receivedText(context.preferences)}
        </Text>
        {choices && <Text size="xs">Choices for this task: {choices.length ? choices.map((choice) => `${choice.id} “${choice.text}”`).join("; ") : "none"}</Text>}
        <Text size="xs">
          The map: {context.map.length ? `from ${context.map.map((m) => m.path).join(", ")}` : "file counts and names only"}
          {context.mapChars !== null ? `, ${plural(context.mapChars, "character")}` : ""}
        </Text>
        <Text size="xs">Read: {linesByFile(context.reads) || "nothing"}</Text>
        <Text size="xs">
          Search results: {plural(context.searches, "search", "searches")}, {plural(context.searchHits, "hit")}
          {context.hits.length ? ` (${linesByFile(context.hits)})` : ""}
        </Text>
      </Stack>
      <Stack gap={2}>
        <Text size="xs" fw={600}>
          What was left out
        </Text>
        <Text size="xs" data-testid={`${prefix}-context-hidden`}>
          Hidden from the model:{" "}
          {hidden
            ? `${plural(hidden.secret, "file")} that may hold secrets, ${plural(hidden.output, "dependency or build output file")}, and ${hidden.tooLargePartial ? "at least " : ""}${plural(hidden.tooLarge, "file")} too large to read.`
            : NOT_RECORDED}
        </Text>
        <Text size="xs">Untracked files are never read. Other projects' own preferences, and replaced or deleted ones, are never sent.</Text>
      </Stack>
      <Stack gap={2}>
        <Text size="xs" fw={600}>
          Budget and answer
        </Text>
        <Text size="xs" data-testid={`${prefix}-context-budget`}>
          {budget
            ? `Request limit: ${plural(budget.tokens, "token")}; by the end of the run, about ${plural(budget.estimatedTokens, "token")} were in use (Nivra's estimate). Results given less room than usual because of the budget: ${budget.resultsLimited}; results too large to send: ${budget.resultsReplaced}. The budget ${budget.ranOut ? "ran out" : "didn't run out"}.`
            : NOT_RECORDED}
        </Text>
        <Text size="xs" data-testid={`${prefix}-context-run-budget`}>
          {context.runBudget ? runBudgetText(context.runBudget) : NOT_RECORDED}
        </Text>
        <Text size="xs" data-testid={`${prefix}-context-answer`}>
          {answer
            ? `${answer.dueReasons.length ? `The answer was due because ${answer.dueReasons.map((reason) => DUE[reason]).join(" and ")}.` : "The model answered before it had to."} Turned down before it was accepted: ${answer.refusals.citations} for citations, ${answer.refusals.conflicts} for conflicts, ${answer.refusals.schema} for its shape${answer.refusals.findings ? `, ${answer.refusals.findings} for having no findings` : ""}. Dropped from the accepted answer: ${plural(answer.conflictsDropped, "conflict")}, ${plural(answer.suggestionsDropped, "suggestion")}.${turnedDownText(answer.turnedDown)}`
            : NOT_RECORDED}
        </Text>
      </Stack>
    </Stack>
  );
}

/** The conversation history a turn was given (D26): counts and a fingerprint, never text, and what was left out, by reason. */
export function HistoryDetails({ history, prefix }: { history: HistoryRecord; prefix: string }) {
  const { omitted } = history;
  const left = [
    omitted.overLimit ? `${plural(omitted.overLimit, "exchange")} older than what one turn carries` : null,
    omitted.unanswered ? `${plural(omitted.unanswered, "message")} never answered` : null,
    omitted.preferencesChanged ? `${plural(omitted.preferencesChanged, "exchange")} answered under preferences that have changed since` : null,
  ].filter(Boolean);
  return (
    <Stack gap={2} data-testid={`${prefix}-history`}>
      <Text size="xs" fw={600}>
        The conversation so far
      </Text>
      <Text size="xs" data-testid={`${prefix}-history-sent`}>
        {history.exchanges
          ? `Sent: ${plural(history.exchanges, "earlier exchange")}, ${plural(history.chars, "character")}${history.shortened ? `, ${plural(history.shortened, "message")} shortened to its start and end` : ""} (fingerprint ${history.digest.slice(0, 12)}).`
          : "Sent: none."}
      </Text>
      <Text size="xs" data-testid={`${prefix}-history-left-out`}>
        Left out: {left.length ? `${left.join("; ")}.` : "nothing."}
      </Text>
    </Stack>
  );
}

/** What a project's consent covers (D20, D31), said wherever it is asked for. */
export const CONSENT_COVERS = "This is for the whole project: its explanations, its conversations and the reviews of its plans. You can turn it off at any time, which stops them all.";

/**
 * The project's consent to send its content to Token Factory (D20), asked once, the first time it is needed. It covers
 * the whole project: its explanations, its conversations and the reviews of its plans.
 */
export function ConsentModal({
  opened,
  onClose,
  onAllow,
  intro,
  sends,
  after,
  testId,
}: {
  opened: boolean;
  onClose(): void;
  onAllow(): void;
  intro: string;
  sends: string[];
  after: string;
  testId: string;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="Send this project's content to Token Factory?" data-testid={testId}>
      <Stack gap="sm">
        <Text size="sm">{intro}</Text>
        <List size="sm">
          {sends.map((item) => (
            <List.Item key={item}>{item}</List.Item>
          ))}
        </List>
        <Text size="sm">
          Nivra never sends files it recognises as holding secrets (such as .env), or dependency and build output, and it masks text that looks like a key or
          token. It can't recognise every secret: don't allow this for a project whose tracked files hold secrets you can't share.
        </Text>
        <Text size="sm">{after}</Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onAllow} data-testid={`${testId}-allow`}>
            Allow for this project
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
