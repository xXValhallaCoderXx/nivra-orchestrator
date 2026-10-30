import { Code, List, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { BaselineSelection } from "@nivra/domain";
import type { AcceptanceCaseView, BriefContent } from "../../../shared/ipc";

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

export function BriefRead({ content, historical = false }: { content: BriefContent; historical?: boolean }) {
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
      {historical && <>
        {content.revalidate.length > 0 && <Text size="sm" c="var(--nivra-warning)" data-testid="historical-brief-revalidate">Fields marked for review in this version: {content.revalidate.join(", ")}.</Text>}
        <details data-testid="historical-brief-details" style={{ overflowWrap: "anywhere" }}>
          <summary className="nivra-focus">Provenance and execution policy</summary>
          <Stack gap="sm" mt="sm">
            <Text size="sm">Runs at once: {content.executionPolicy.concurrency}. Network: {content.executionPolicy.network}. Approval: {content.executionPolicy.approval}.</Text>
            {content.sources.length === 0 && <Text size="sm">Written directly, with no source plan.</Text>}
            {content.sources.map((source) => <Stack gap={4} key={source.planId} data-testid="historical-brief-source">
              <Text size="sm" fw={600}>Plan version {source.planVersion}</Text>
              {[
                ["Plan", source.planId], ["Plan lineage", source.planLineage],
                ["Conversation", source.conversationId], ["Message", source.messageId],
                ["Project", source.projectId ?? "General (no repository)"], ["Repository commit", source.headAtStart],
              ].map(([label, value]) => <Text size="xs" key={label}>{label}: <Code>{value ?? "Not recorded"}</Code></Text>)}
              <Text size="xs">Historical references</Text>
              {source.citations.length ? <List size="sm">{source.citations.map((citation, index) => <List.Item key={index}><Code>{citation.path}:{citation.startLine}–{citation.endLine}</Code></List.Item>)}</List> : <Text size="xs" c="var(--nivra-text-3)">None recorded</Text>}
            </Stack>)}
          </Stack>
        </details>
      </>}
    </Stack>
  );
}

/** The brief's baseline checks, as they read. */
export function BaselineRead({ checks }: { checks: BaselineSelection[] }) {
  if (!checks.length) {
    return (
      <Text size="sm" c="var(--nivra-text-3)">
        None: a run starts the worker without checking the commit first.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {checks.map((given, index) => (
        <Stack key={index} gap={2} data-testid="task-brief-baseline-check">
          <Text size="sm">
            {index + 1}. {given.name}
          </Text>
          <Code block fz="xs">
            $ {given.command}
          </Code>
          {given.outputPattern !== undefined ? (
            <>
              <Text size="xs" c="var(--nivra-text-3)">
                Its whole output must match this pattern, and it must exit {given.expectedExitCode}:
              </Text>
              <Code block fz="xs">
                {given.outputPattern}
              </Code>
            </>
          ) : (
            <>
              <Text size="xs" c="var(--nivra-text-3)">
                Must print{(given.expectedOutput ?? "").endsWith("\n") ? ", ending with a new line" : ", with no new line at the end"}, and exit {given.expectedExitCode}:
              </Text>
              <Code block fz="xs">
                {given.expectedOutput || "(nothing)"}
              </Code>
            </>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

/** The brief's acceptance cases, as they read. */
export function CasesRead({ cases }: { cases: AcceptanceCaseView[] }) {
  if (!cases.length) {
    return (
      <Text size="sm" c="var(--nivra-text-3)">
        None yet: a run needs at least one, so Nivra can check the result itself.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {cases.map((given, index) => (
        <Stack key={index} gap={2} data-testid="task-brief-case">
          <Text size="sm">
            {index + 1}. {given.name}
          </Text>
          <Code block fz="xs">
            $ {given.command}
          </Code>
          <Text size="xs" c="var(--nivra-text-3)">
            Must print{given.expectedOutput.endsWith("\n") ? ", ending with a new line" : ", with no new line at the end"}, and exit {given.expectedExitCode}:
          </Text>
          <Code block fz="xs">
            {given.expectedOutput || "(nothing)"}
          </Code>
        </Stack>
      ))}
    </Stack>
  );
}
