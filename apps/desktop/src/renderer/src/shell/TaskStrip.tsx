import { Box, Text, VisuallyHidden } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { CSSProperties } from "react";
import type { StripItem, StripState, StripStep, TaskStripProps } from "../app/routes";
import { NARROW_QUERY } from "./layout";

/**
 * The task progress strip (SH4, P1c): seven steps under a task's title, saying where the task is. It explains and never
 * forces anything: no step is a button, and none blocks another. The task page says what each step reads (TaskStripProps);
 * the shell owns how it looks and what assistive technology hears: an ordered list, the current step marked with
 * aria-current="step", and every state in words as well as by its mark. In a narrow window it becomes seven marks with
 * the current step named (NW3).
 */

export const STEP_NAMES: Record<StripStep, string> = {
  brief: "Brief",
  readiness: "Readiness",
  environment: "Environment",
  run: "Run",
  review: "Review changes",
  apply: "Apply",
  accept: "Accept",
};

const STEPS: readonly StripStep[] = ["brief", "readiness", "environment", "run", "review", "apply", "accept"];

/** The current step: the one the task page marked "now", or else the first that needs attention; none when all is done. */
export function currentStep(items: readonly StripItem[]): number {
  const now = items.findIndex((item) => item.state === "now");
  return now >= 0 ? now : items.findIndex((item) => item.state === "attention");
}

/** What a screen reader hears before a step's name, so no state is told by colour or mark alone. */
const SPOKEN: Record<StripState, string> = { done: "Done: ", now: "", attention: "Needs attention: ", next: "", optional: "Optional: " };

function dotStyle(state: StripState, current: boolean): CSSProperties {
  const base: CSSProperties = {
    flex: "0 0 22px",
    width: 22,
    height: 22,
    borderRadius: 11,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 600,
    boxSizing: "border-box",
    lineHeight: 1,
  };
  if (state === "done") return { ...base, background: "var(--nivra-badge-green-bg)", color: "var(--nivra-badge-green-fg)" };
  if (state === "attention") return { ...base, background: "var(--nivra-badge-yellow-bg)", color: "var(--nivra-badge-yellow-fg)", border: "1px solid var(--nivra-warning)" };
  if (state === "now" || current) return { ...base, background: "var(--nivra-action)", color: "var(--nivra-on-action)", border: "1px solid var(--nivra-action-edge)" };
  return { ...base, background: "var(--mantine-color-body)", color: "var(--nivra-text-2)", border: `1px ${state === "optional" ? "dashed" : "solid"} var(--nivra-control-border)` };
}

const mark = (item: StripItem, index: number) => (item.state === "done" ? "✓" : item.state === "attention" ? "!" : String(index + 1));

export function TaskStrip({ items, label }: TaskStripProps) {
  const narrow = useMediaQuery(NARROW_QUERY, false, { getInitialValueInEffect: false });
  // Always the seven steps, in StripStep's order: a step the task page didn't give shows as still to come, with no line
  // under it, and an item for a step given twice, or for no step at all, is left out.
  const shown = STEPS.map((step) => items.find((item) => item.step === step) ?? { step, state: "next" as const, sub: "" });
  const current = currentStep(shown);
  const name = label ?? "Where this task is";

  if (narrow) {
    const now = current >= 0 ? shown[current]! : null;
    return (
      <Box data-testid="task-strip" data-compact>
        <Box component="ol" aria-label={name} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", gap: 6, alignItems: "center" }}>
          {shown.map((item, index) => (
            <li key={item.step} aria-current={index === current ? "step" : undefined} data-step={item.step} data-state={item.state} style={{ display: "flex" }}>
              <span aria-hidden="true" style={{ ...dotStyle(item.state, index === current), outline: index === current ? "2px solid var(--nivra-focus)" : undefined, outlineOffset: 2 }}>
                {mark(item, index)}
              </span>
              <VisuallyHidden>
                {index === current ? "Current step: " : SPOKEN[item.state]}
                {STEP_NAMES[item.step]}
                {item.sub ? `, ${item.sub}` : ""}
              </VisuallyHidden>
            </li>
          ))}
        </Box>
        {now && (
          <Text size="xs" c="var(--nivra-text-2)" mt={6} aria-hidden="true">
            {STEP_NAMES[now.step]} · step {current + 1} of 7{now.sub ? ` · ${now.sub}` : ""}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box
      component="ol"
      aria-label={name}
      data-testid="task-strip"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
        border: "1px solid var(--nivra-border)",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--mantine-color-body)",
      }}
    >
      {shown.map((item, index) => {
        const isCurrent = index === current;
        return (
          <li
            key={item.step}
            aria-current={isCurrent ? "step" : undefined}
            data-step={item.step}
            data-state={item.state}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: 10,
              borderRight: index < 6 ? "1px solid var(--nivra-border)" : undefined,
              fontSize: 12,
              lineHeight: 1.35,
              minWidth: 0,
              background: isCurrent ? "var(--nivra-hover)" : undefined,
            }}
          >
            <span aria-hidden="true" style={dotStyle(item.state, isCurrent)}>
              {mark(item, index)}
            </span>
            <span style={{ minWidth: 0 }}>
              <b style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--mantine-color-text)" }}>
                <VisuallyHidden>{isCurrent ? "Current step: " : SPOKEN[item.state]}</VisuallyHidden>
                {STEP_NAMES[item.step]}
              </b>
              <span style={{ display: "block", color: "var(--nivra-text-2)" }}>{item.sub}</span>
            </span>
          </li>
        );
      })}
    </Box>
  );
}
