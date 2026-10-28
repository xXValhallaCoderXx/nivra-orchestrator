import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { Readiness, ReadinessAction, ReadinessRow } from "../../../shared/task-readiness";

/**
 * Before a task can run (NIV-56, G3: P1c, RS3): what's needed, each with its next step; what the run's preview asks
 * for, after it shows what would be sent; and what's already met. Opening the page sends nothing, and the preview
 * checks everything again.
 */

export type MarkKind = "needed" | "asked" | "met" | "optional";

/** Small inline marks for each kind of row: no icon dependency (G3). */
function Mark({ kind }: { kind: MarkKind }) {
  const common = { width: 20, height: 20, viewBox: "0 0 20 20", "aria-hidden": true, focusable: false } as const;
  if (kind === "needed") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="9" fill="var(--nivra-badge-yellow-bg, #FEF3C7)" stroke="var(--nivra-badge-yellow-fg, #B45309)" strokeWidth="1.2" />
        <path d="M10 5.5v5.5M10 13.6v.9" stroke="var(--nivra-badge-yellow-fg, #B45309)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "met") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="9" fill="var(--nivra-badge-green-bg, #ECFDF3)" />
        <path d="M6 10.3l2.6 2.6L14 7.4" fill="none" stroke="var(--nivra-badge-green-fg, #15803D)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "asked") {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="8.6" fill="none" stroke="var(--nivra-control-border, #8A8A8A)" strokeWidth="1.2" strokeDasharray="2.4 2.2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="10" cy="10" r="8.6" fill="none" stroke="var(--nivra-control-border, #8A8A8A)" strokeWidth="1.2" />
      <path d="M6.5 10h7" stroke="var(--nivra-control-border, #8A8A8A)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const ACTION_LABEL: Record<ReadinessAction, { label: string; testid: string }> = {
  "mark-ready": { label: "Mark ready", testid: "task-mark-ready" },
  "edit-brief": { label: "Edit brief", testid: "task-readiness-edit-brief" },
  "change-repository": { label: "Choose a repository", testid: "task-readiness-repository" },
  "add-keys": { label: "Add key and ID…", testid: "task-readiness-add-keys" },
  "open-environment": { label: "Open environment", testid: "task-readiness-environment" },
};

/** One line of a checklist: its mark, what it's about and what it says, and a next step beside it when there is one. */
export function CheckLine({ kind, title, detail, children, testId, row }: { kind: MarkKind; title: string; detail: string | null; children?: ReactNode; testId?: string; row?: string }) {
  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md" py={10} style={{ borderTop: "1px solid var(--nivra-border)" }} data-testid={testId} data-row={row} data-kind={kind}>
      <Group align="flex-start" wrap="nowrap" gap="sm" style={{ minWidth: 0 }}>
        <div style={{ paddingTop: 1, flexShrink: 0 }}>
          <Mark kind={kind} />
        </div>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
            {title}
          </Text>
          {detail && (
            <Text size="sm" c="var(--nivra-text-2)" style={{ overflowWrap: "anywhere" }}>
              {detail}
            </Text>
          )}
        </Stack>
      </Group>
      {children}
    </Group>
  );
}

function Row({ row, kind, onAction, busy, primary }: { row: ReadinessRow; kind: MarkKind; onAction(action: ReadinessAction): void; busy: boolean; primary: boolean }) {
  const action = row.action ? ACTION_LABEL[row.action] : null;
  return (
    <CheckLine kind={kind} title={row.title} detail={row.detail} testId="task-readiness-row" row={row.id}>
      {action && (
        <Button size="xs" variant={primary ? "filled" : "default"} onClick={() => onAction(row.action!)} disabled={busy} style={{ flexShrink: 0 }} data-testid={action.testid}>
          {action.label}
        </Button>
      )}
    </CheckLine>
  );
}

/** A titled group of checklist lines. */
export function CheckGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap={0}>
      <Text size="xs" fw={600} c="var(--nivra-text-3)" pb={4}>
        {title}
      </Text>
      {children}
    </Stack>
  );
}

/** The card itself. The first needed row with a next step offers the page's one primary. */
export function ReadinessCard({ readiness, busy, onAction }: { readiness: Readiness; busy: boolean; onAction(action: ReadinessAction): void }) {
  const first = readiness.needed.find((row) => row.action !== null)?.id ?? null;
  return (
    <Paper withBorder p="md" radius="md" data-testid="task-readiness">
      <Stack gap="md">
        <Stack gap={2}>
          <Text fw={600}>Before this task can run</Text>
          <Text size="sm" c="var(--nivra-text-2)">
            Nivra checks these again before every run. Opening this page sends nothing.
          </Text>
        </Stack>
        {readiness.needed.length > 0 && (
          <CheckGroup title="Needed from you">
            {readiness.needed.map((row) => (
              <Row key={row.id} row={row} kind="needed" onAction={onAction} busy={busy} primary={row.id === first} />
            ))}
          </CheckGroup>
        )}
        {readiness.asked.length > 0 && (
          <CheckGroup title="Asked when it's needed, after showing what's sent">
            {readiness.asked.map((row) => (
              <Row key={row.id} row={row} kind="asked" onAction={onAction} busy={busy} primary={false} />
            ))}
          </CheckGroup>
        )}
        {readiness.met.length > 0 && (
          <CheckGroup title="Already met">
            {readiness.met.map((row) => (
              <Row key={row.id} row={row} kind="met" onAction={onAction} busy={busy} primary={false} />
            ))}
          </CheckGroup>
        )}
        {readiness.optional.length > 0 && (
          <CheckGroup title="Not needed for a run">
            {readiness.optional.map((row) => (
              <Row key={row.id} row={row} kind="optional" onAction={onAction} busy={busy} primary={false} />
            ))}
          </CheckGroup>
        )}
      </Stack>
    </Paper>
  );
}
