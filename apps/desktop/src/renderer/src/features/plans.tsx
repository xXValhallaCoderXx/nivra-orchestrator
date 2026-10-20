import { Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import type { ChatResult } from "@nivra/domain";
import { useState } from "react";
import { TASK_LIMITS, type PlanView } from "../../../shared/ipc";
import { planText } from "../../../shared/plans";
import { errorMessage } from "../shared/ui";

/** Plan versions grouped by lineage, each lineage oldest first. */
function lineages(plans: PlanView[]): PlanView[][] {
  const grouped = new Map<string, PlanView[]>();
  for (const plan of plans) grouped.set(plan.lineageId, [...(grouped.get(plan.lineageId) ?? []), plan]);
  return [...grouped.values()].map((versions) => versions.sort((a, b) => a.version - b.version));
}

function PlanEditor({ initial, saveLabel, onSave, onCancel }: { initial: string; saveLabel: string; onSave(text: string): Promise<void>; onCancel(): void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = text.trim().length;
  const over = length > TASK_LIMITS.planChars;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(text);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Stack gap={4} data-testid="plan-editor">
      <Textarea value={text} onChange={(event) => setText(event.currentTarget.value)} autosize minRows={4} maxRows={16} aria-label="Plan" data-testid="plan-input" />
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c={over ? "var(--nivra-error)" : "var(--nivra-text-3)"}>
          {length.toLocaleString()} / {TASK_LIMITS.planChars.toLocaleString()}
        </Text>
        <Group gap="xs">
          <Button size="xs" variant="subtle" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="xs" onClick={() => void save()} loading={busy} disabled={!length || over} data-testid="plan-save">
            {saveLabel}
          </Button>
        </Group>
      </Group>
      {error && (
        <Text size="sm" c="var(--nivra-error)" data-testid="plan-error">
          {error}
        </Text>
      )}
    </Stack>
  );
}

/** One plan: its latest version, editing into the next one, its earlier versions, and a task made from it. */
function PlanCard({ versions, onSaved, onCreateTask }: { versions: PlanView[]; onSaved(): void; onCreateTask(plan: PlanView): void }) {
  const latest = versions.at(-1)!;
  const [editing, setEditing] = useState(false);
  const [earlier, setEarlier] = useState(false);
  return (
    <Paper withBorder p="sm" radius="md" data-testid="plan" data-version={latest.version}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" fw={600} data-testid="plan-version">
            Plan · v{latest.version}
          </Text>
          {!editing && (
            <Group gap="xs" wrap="nowrap">
              <Button size="compact-xs" variant="subtle" onClick={() => setEditing(true)} data-testid="plan-edit">
                Edit
              </Button>
              <Button size="compact-xs" variant="default" onClick={() => onCreateTask(latest)} data-testid="plan-create-task">
                Create task from v{latest.version}
              </Button>
            </Group>
          )}
        </Group>
        {editing ? (
          <PlanEditor
            initial={latest.text}
            saveLabel={`Save as v${latest.version + 1}`}
            onCancel={() => setEditing(false)}
            onSave={async (text) => {
              await window.nivra.revisePlan(latest.id, text);
              setEditing(false);
              onSaved();
            }}
          />
        ) : (
          <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} data-testid="plan-text">
            {latest.text}
          </Text>
        )}
        {versions.length > 1 && (
          <Group>
            <Button size="compact-xs" variant="subtle" onClick={() => setEarlier((shown) => !shown)} data-testid="plan-earlier-toggle">
              {earlier ? "Hide" : "Show"} earlier versions ({versions.length - 1})
            </Button>
          </Group>
        )}
        {earlier &&
          versions
            .slice(0, -1)
            .reverse()
            .map((version) => (
              <Stack key={version.id} gap={2} data-testid="plan-earlier">
                <Text size="xs" c="var(--nivra-text-3)">
                  v{version.version} · {new Date(version.createdAt).toLocaleString()}
                </Text>
                <Text size="sm" c="var(--nivra-text-2)" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {version.text}
                </Text>
              </Stack>
            ))}
      </Stack>
    </Paper>
  );
}

/**
 * The plans saved from one answer (D26). Save as plan shows the plan's text to edit first; an edit of a saved plan is
 * its next version, and earlier versions, with any brief made from them, stay as they were. A task can be made from a
 * plan's latest version.
 */
export function AnswerPlans({
  conversationId,
  messageId,
  reply,
  plans,
  onSaved,
  onCreateTask,
}: {
  conversationId: string;
  messageId: string;
  reply: ChatResult;
  /** Every version of the plans saved from this answer. */
  plans: PlanView[];
  onSaved(): void;
  onCreateTask(plan: PlanView): void;
}) {
  const [saving, setSaving] = useState(false);
  const initial = planText(reply);
  return (
    <Stack gap="xs">
      {lineages(plans).map((versions) => (
        <PlanCard key={versions[0]!.lineageId} versions={versions} onSaved={onSaved} onCreateTask={onCreateTask} />
      ))}
      {saving ? (
        <PlanEditor
          initial={initial}
          saveLabel="Save plan"
          onCancel={() => setSaving(false)}
          onSave={async (text) => {
            // Unchanged, it is saved as answered: main makes the same text, and keeps the answer's own.
            await window.nivra.savePlan(conversationId, messageId, text.trim() === initial.trim() ? null : text);
            setSaving(false);
            onSaved();
          }}
        />
      ) : (
        <Group>
          <Button size="compact-xs" variant="default" onClick={() => setSaving(true)} data-testid="answer-save-plan">
            Save as plan
          </Button>
        </Group>
      )}
    </Stack>
  );
}
