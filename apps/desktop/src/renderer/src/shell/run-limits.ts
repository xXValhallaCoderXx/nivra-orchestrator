import type { RunLimitsView } from "../../../shared/ipc";

/** One labelled line of a task run's bounds that no brief changes. */
export interface RunLimitLine {
  key: "requests" | "input" | "tools" | "time";
  label: string;
  text: string;
}

const number = (value: number) => value.toLocaleString("en-GB");
const plural = (count: number, word: string) => `${number(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * A task run's bounds that no brief changes, as labelled lines worded as the run preview words them (Settings › Budget
 * and usage). A request's time is its bound, never a promise of speed; the output cap counts the model's reasoning
 * tokens too (D50); the input estimate admits a run and caps nothing. No cost is ever stated.
 */
export function runLimitLines(limits: RunLimitsView): RunLimitLine[] {
  return [
    {
      key: "requests",
      label: "Model requests",
      text: `At most ${plural(limits.modelRequests, "model request")} in a run, each of up to ${number(limits.requestSeconds)} s and ${number(limits.outputTokensPerRequest)} output tokens. ${number(limits.requestSeconds)} s bounds a request; it isn't how long one takes. The output cap counts the model's reasoning tokens too.`,
    },
    {
      key: "input",
      label: "Input",
      text: `Admitted against an estimated ${number(limits.estimatedInputTokens)} input tokens: an estimated admission budget, not a cap.`,
    },
    {
      key: "tools",
      label: "Tool calls",
      text: `${plural(limits.toolCalls, "tool call")}, of which ${plural(limits.writes, "write")} and ${plural(limits.runs, "run")} of a case or check, each command up to ${number(limits.checkSeconds)} s.`,
    },
    {
      key: "time",
      label: "Time",
      text: `The sandbox for ${plural(limits.sessionMinutes, "minute")}, and the whole run for ${plural(limits.runMinutes, "minute")}.`,
    },
  ];
}
