import { Stack, Text } from "@mantine/core";

/**
 * One brief field before and after a change the task coach proposed (NIV-53). A text field shows both versions in
 * full; a list shows each item, with the ones the change rewords (old, then new) and adds marked. The words are the
 * person's and the model's, shown as plain text.
 */

const plain = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

type LineKind = "same" | "reworded" | "added" | "removed";

/** A list's items, paired by place: the coach rewords items where they are and adds new ones at the end. */
function listLines(before: string[], after: string[]): Array<{ kind: LineKind; before: string | null; after: string | null }> {
  const lines: Array<{ kind: LineKind; before: string | null; after: string | null }> = [];
  const longest = Math.max(before.length, after.length);
  for (let index = 0; index < longest; index++) {
    const old = before[index] ?? null;
    const next = after[index] ?? null;
    if (old !== null && next !== null) lines.push({ kind: old === next ? "same" : "reworded", before: old, after: next });
    else if (next !== null) lines.push({ kind: "added", before: null, after: next });
    else lines.push({ kind: "removed", before: old, after: null });
  }
  return lines;
}

function TextBlock({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Stack gap={2} data-testid={testId}>
      <Text size="xs" fw={600} c="var(--nivra-text-2)">
        {label}
      </Text>
      <Text size="sm" style={{ ...plain, borderLeft: "3px solid var(--nivra-border)", paddingLeft: 8, maxHeight: 240, overflowY: "auto" }}>
        {value.trim() ? value : "(empty)"}
      </Text>
    </Stack>
  );
}

export function BriefDiff({ before, after }: { before: string | string[]; after: string | string[] }) {
  if (typeof before === "string" || typeof after === "string") {
    return (
      <Stack gap={6} data-testid="brief-diff" data-kind="text">
        <TextBlock label="Before" value={typeof before === "string" ? before : before.join("\n")} testId="brief-diff-before" />
        <TextBlock label="After" value={typeof after === "string" ? after : after.join("\n")} testId="brief-diff-after" />
      </Stack>
    );
  }
  const lines = listLines(before, after);
  return (
    <Stack gap={4} data-testid="brief-diff" data-kind="list">
      {lines.length === 0 && (
        <Text size="sm" c="var(--nivra-text-3)">
          (none)
        </Text>
      )}
      {lines.map((line, index) => (
        <Stack key={index} gap={0} data-testid="brief-diff-line" data-change={line.kind}>
          {line.kind === "same" && (
            <Text size="sm" style={plain}>
              {index + 1}. {line.after}
            </Text>
          )}
          {line.kind === "reworded" && (
            <>
              <Text size="sm" c="var(--nivra-text-3)" td="line-through" style={plain}>
                {index + 1}. {line.before}
              </Text>
              <Text size="sm" style={plain}>
                {index + 1}. {line.after}{" "}
                <Text span size="xs" c="var(--nivra-text-2)">
                  (reworded)
                </Text>
              </Text>
            </>
          )}
          {line.kind === "added" && (
            <Text size="sm" style={plain}>
              {index + 1}. {line.after}{" "}
              <Text span size="xs" c="var(--nivra-text-2)">
                (added)
              </Text>
            </Text>
          )}
          {line.kind === "removed" && (
            <Text size="sm" c="var(--nivra-text-3)" td="line-through" style={plain}>
              {index + 1}. {line.before}{" "}
              <Text span size="xs">
                (removed)
              </Text>
            </Text>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
