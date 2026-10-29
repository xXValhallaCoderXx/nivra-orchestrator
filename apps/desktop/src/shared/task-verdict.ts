import type { TaskReport } from "@nivra/domain";

/**
 * The sentence a proposed change's verdict reads (D39, D41, NIV-55), from what the run's own checks showed: verified,
 * or the first reason it isn't, in this order: a frozen file not shown to be unchanged, a setup file the environment
 * was prepared from not shown to be unchanged, then the acceptance cases. It never claims more than the report holds.
 */
export function verdictText(report: Pick<TaskReport, "verified" | "frozen" | "setup">): string {
  if (report.verified) {
    return `Every acceptance case passed${report.frozen.length ? ", and every frozen file is unchanged" : ""}: the change is verified. It's kept with the run until you decide, and your checkout hasn't been touched by the run.`;
  }
  if (report.frozen.some((file) => file.unchanged !== true)) {
    return "A frozen file isn't shown to be unchanged, so the change isn't verified and can't be approved, whatever the cases printed. It's kept with the run, and your checkout hasn't been touched.";
  }
  const setup = report.setup ?? null;
  if (setup !== null && setup.unchanged === false) {
    const shown = setup.changed.slice(0, 3);
    const more = setup.changed.length - shown.length;
    const named = shown.length ? ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : "";
    return `The run changed a setup file the environment was prepared from${named}, so its checks don't count: the change isn't verified and can't be approved. Request a revision that leaves the setup files as they are. It's kept with the run, and your checkout hasn't been touched.`;
  }
  if (setup !== null && setup.unchanged === null) {
    return "Nivra couldn't tell whether the setup files the environment was prepared from are unchanged, so the change isn't verified and can't be approved. It's kept with the run, and your checkout hasn't been touched.";
  }
  return "Not every acceptance case was shown to pass, so the change isn't verified and can't be approved. It's kept with the run, and your checkout hasn't been touched.";
}

/**
 * Why a proposed change can't be approved, in the order the verdict gives its reasons, with what the person can do
 * instead: reject it, or ask for a revision. The cases' sentence is today's, word for word.
 */
export function unapprovableText(report: Pick<TaskReport, "frozen" | "setup">): string {
  if (report.frozen.some((file) => file.unchanged !== true)) return "This change can't be approved: a frozen file isn't shown to be unchanged. You can reject it, or ask for a revision.";
  const setup = report.setup ?? null;
  if (setup !== null && setup.unchanged === false) {
    const shown = setup.changed.slice(0, 3);
    const more = setup.changed.length - shown.length;
    const named = shown.length ? ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : "";
    return `This change can't be approved: it changes a setup file the environment was prepared from${named}. You can reject it, or ask for a revision that leaves the setup files as they are.`;
  }
  if (setup !== null && setup.unchanged === null) return "This change can't be approved: Nivra couldn't tell whether the setup files are unchanged. You can reject it, or ask for a revision.";
  return "This change can't be approved: not every acceptance case was shown to pass. You can reject it, or ask for a revision.";
}

export type OutcomeColor = "green" | "yellow" | "red" | "gray" | "blue";

/**
 * What a run's Outcome badge says (RS1): from its report, telling an acceptance case that failed ("Checks failed") from
 * one not shown to pass ("Not verified"); without a report, from how the run ended.
 */
export function outcomeLookOf(value: { status: string; report: Pick<TaskReport, "outcome" | "verified" | "checks"> | null }): { label: string; color: OutcomeColor } {
  const report = value.report;
  if (report === null) {
    const ended: Record<string, { label: string; color: OutcomeColor }> = {
      submitting: { label: "Going", color: "blue" },
      running: { label: "Going", color: "blue" },
      interrupted: { label: "Interrupted", color: "yellow" },
      "not-sent": { label: "Not sent", color: "gray" },
      failed: { label: "Failed", color: "red" },
      cancelled: { label: "Stopped", color: "gray" },
      unknown: { label: "Unknown", color: "yellow" },
    };
    return ended[value.status] ?? { label: "Ended", color: "gray" };
  }
  switch (report.outcome) {
    case "proposed":
      if (report.verified) return { label: "Verified change", color: "green" };
      return report.checks.some((check) => check.kind === "case" && (check.verdict === "failed" || check.verdict === "couldnt-run")) ? { label: "Checks failed", color: "red" } : { label: "Not verified", color: "yellow" };
    case "unchanged":
      return { label: "Unchanged", color: "gray" };
    case "refused":
      return { label: "Refused", color: "gray" };
    case "cancelled":
      return { label: "Stopped", color: "gray" };
    case "failed":
      return { label: "Couldn't finish", color: "red" };
    case "uncertain":
      return { label: "Uncertain", color: "yellow" };
    case "interrupted":
      return { label: "Interrupted", color: "yellow" };
    case "in-progress":
      return { label: "Going", color: "blue" };
  }
}

/** A verified change's reported checks that didn't pass (RS5): they don't decide the result, so approving stays possible. */
export function failingReportedChecks<T extends Pick<TaskReport, "outcome" | "verified" | "checks">>(report: T | null): T["checks"] {
  if (report === null || report.outcome !== "proposed" || !report.verified) return [];
  return report.checks.filter((check) => check.kind === "check" && check.verdict !== "passed");
}

/**
 * Which decision leads (P1i, RS1, RS5): Approve and apply, for a verified change the engine can show; Request revision
 * when it can't be approved, or when a reported check didn't pass, and then approving stays possible, "anyway".
 */
export function decisionLead(report: Pick<TaskReport, "outcome" | "verified" | "checks"> | null, approveOffered: boolean, proposalShown: boolean): { lead: "approve" | "revise"; approve: "Approve and apply" | "Approve and apply anyway" | null } {
  if (!approveOffered || !proposalShown) return { lead: "revise", approve: null };
  return failingReportedChecks(report).length > 0 ? { lead: "revise", approve: "Approve and apply anyway" } : { lead: "approve", approve: "Approve and apply" };
}
