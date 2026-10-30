import type { TaskAdmission, TaskCheck, TaskReport } from "@nivra/domain";

type ReportVerdict = Pick<TaskReport, "verified" | "frozen" | "setup"> & Partial<Pick<TaskReport, "version" | "manifest" | "checks">>;
type ReportOutcome = Pick<TaskReport, "outcome" | "verified" | "checks"> & Partial<Pick<TaskReport, "version" | "manifest">>;

export type OutcomeColor = "green" | "yellow" | "red" | "gray" | "blue";

/** Historical verification remains readable, but it isn't admission under the required-check rule (NIV-67). */
export const legacyVerification = (report: Partial<Pick<TaskReport, "version" | "manifest">>): boolean => report.version !== 4 || report.manifest?.policy !== "required-checks-v1";

/** Current verification is the engine's decision on the proposal-bound report, never a fitted or cached boolean. */
export const currentlyVerified = (value: { report: Pick<TaskReport, "outcome"> | null; admission?: TaskAdmission | null }): boolean => value.report?.outcome === "proposed" && value.admission?.eligible === true;

function failedRequirement(report: ReportVerdict): string | null {
  if (report.frozen.some((file) => file.unchanged !== true)) return "a frozen file isn't shown to be unchanged";
  const setup = report.setup ?? null;
  if (setup?.unchanged === false) {
    const shown = setup.changed.slice(0, 3);
    const more = setup.changed.length - shown.length;
    const named = shown.length ? ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : "";
    return `it changes a setup file the environment was prepared from${named}`;
  }
  if (setup?.unchanged === null) return "Nivra couldn't tell whether the setup files are unchanged";
  const required = report.checks?.find((check) => check.kind === "check" && check.verdict !== "passed");
  if (required) return `required repository check ${required.number} wasn't shown to pass (${required.name})`;
  const missing = report.manifest?.checks.find((given) => given.kind === "check" && !report.checks?.some((check) => check.kind === "check" && check.number === given.number && check.commandSha256 === given.commandSha256));
  if (missing) return `required repository check ${missing.number} has no matching final result`;
  return null;
}

/** The original recorded verdict is explicit; present eligibility comes only from a fresh engine admission. */
export function verdictText(report: ReportVerdict, admission?: TaskAdmission | null): string {
  if (legacyVerification(report)) {
    const original = `This legacy run was recorded as ${report.verified ? "verified" : "not verified"} under the earlier rule, where repository checks were advisory.`;
    if (admission?.eligible) return `${original} Its engine has checked the original proposal evidence against the current rule: every required final case and repository check passed, with the integrity checks satisfied. The change is verified and can be approved. Before-change comparisons weren't recorded, so regression comparisons are unavailable.`;
    return `${original} Its original checks are shown below. It hasn't been verified under the required-check rule. ${admission?.reason ?? "Preview and start a new authorised run to verify it again."}`;
  }
  if (admission?.eligible) {
    return `Every acceptance case${report.manifest?.checks.some((check) => check.kind === "check") ? " and required repository check" : ""} passed${report.frozen.length ? ", and every frozen file is unchanged" : ""}: the change is verified. It's kept with the run until you decide, and your checkout hasn't been touched by the run.`;
  }
  const requirement = failedRequirement(report);
  if (requirement) return `This change isn't verified and can't be approved: ${requirement}. It's kept with the run, and your checkout hasn't been touched.`;
  if (admission?.reason) return `${admission.reason} It's kept with the run, and your checkout hasn't been touched.`;
  if (!report.verified) return "Not every acceptance case was shown to pass, so the change isn't verified and can't be approved. It's kept with the run, and your checkout hasn't been touched.";
  return "Nivra hasn't confirmed this proposal's verification from its engine, so approval is unavailable. Open the project to start its engine, then try again. The run's recorded result and checks are shown below.";
}

/** Why current approval is unavailable, including legacy evidence and an engine that can't be reached. */
export function unapprovableText(report: ReportVerdict, admission?: TaskAdmission | null): string {
  if (admission?.eligible) return "Its engine has confirmed that this change is eligible for approval.";
  if (legacyVerification(report)) return admission?.reason ?? "This legacy proposal hasn't been verified under the required-check rule. Preview and start a new authorised run. You can reject it, or ask for a revision.";
  const requirement = failedRequirement(report);
  if (requirement) return `This change can't be approved: ${requirement}. You can reject it, or ask for a revision${report.setup?.unchanged === false ? " that leaves the setup files as they are" : ""}.`;
  if (admission?.reason) return admission.reason;
  return report.verified ? "Approval is unavailable until its engine confirms this proposal's verification. Open the project to start its engine, then try again." : "This change can't be approved: not every acceptance case was shown to pass. You can reject it, or ask for a revision.";
}

/** Outcome badges use current admission; historical results never acquire new verification semantics. */
export function outcomeLookOf(value: { status: string; report: ReportOutcome | null; admission?: TaskAdmission | null }): { label: string; color: OutcomeColor } {
  const report = value.report;
  if (report === null) {
    const ended: Record<string, { label: string; color: OutcomeColor }> = {
      submitting: { label: "Going", color: "blue" }, running: { label: "Going", color: "blue" }, interrupted: { label: "Interrupted", color: "yellow" },
      "not-sent": { label: "Not sent", color: "gray" }, failed: { label: "Failed", color: "red" }, cancelled: { label: "Stopped", color: "gray" }, unknown: { label: "Unknown", color: "yellow" },
    };
    return ended[value.status] ?? { label: "Ended", color: "gray" };
  }
  switch (report.outcome) {
    case "proposed":
      if (currentlyVerified(value)) return { label: "Verified change", color: "green" };
      if (legacyVerification(report)) return { label: "Legacy result", color: "yellow" };
      return report.checks.some((check) => check.verdict === "failed" || check.verdict === "couldnt-run") ? { label: "Checks failed", color: "red" } : { label: report.verified ? "Verification unavailable" : "Not verified", color: "yellow" };
    case "unchanged": return { label: "Unchanged", color: "gray" };
    case "refused": return { label: "Refused", color: "gray" };
    case "cancelled": return { label: "Stopped", color: "gray" };
    case "failed": return { label: "Couldn't finish", color: "red" };
    case "uncertain": return { label: "Uncertain", color: "yellow" };
    case "interrupted": return { label: "Interrupted", color: "yellow" };
    case "in-progress": return { label: "Going", color: "blue" };
  }
}

/** Required check comparisons match number and exact command digest, never output tails or explicit baseline selections. */
export function comparisonOf(check: TaskCheck, beforeChecks: readonly TaskCheck[] = []): { before: TaskCheck | null; label: string; color: OutcomeColor; detail: string } {
  const matches = check.kind === "check" && check.commandSha256 ? beforeChecks.filter((before) => before.kind === "check" && before.number === check.number && before.commandSha256 === check.commandSha256) : [];
  const before = matches.length === 1 ? matches[0]! : null;
  const unavailable = { before, label: "Comparison unavailable", color: "yellow" as const, detail: "Nivra can't establish a complete before-and-after comparison for this exact command." };
  if (before === null) return unavailable;
  const failed = (result: TaskCheck) => result.verdict === "failed" || result.verdict === "couldnt-run";
  if (before.verdict === "passed" && failed(check)) return { before, label: "Regression", color: "red", detail: "This required check passed before the worker's changes and didn't pass afterwards." };
  if (failed(before) && failed(check)) return { before, label: "Failed before and after", color: "red", detail: "This required check didn't pass before or after. These results don't show that the errors are unchanged; the final failure still blocks verification." };
  if (failed(before) && check.verdict === "passed") return { before, label: "Passes after change", color: "green", detail: "This required check didn't pass before the worker's changes and passed afterwards." };
  if (before.verdict === "passed" && check.verdict === "passed") return { before, label: "Passed before and after", color: "green", detail: "This required check passed on the unchanged commit and on the proposed result." };
  return unavailable;
}

/** Approval requires fresh engine admission and a displayed proposal. No required failure has an override. */
export function decisionLead(report: ReportOutcome | null, approveOffered: boolean, proposalShown: boolean, admission?: TaskAdmission | null): { lead: "approve" | "revise"; approve: "Approve and apply" | null } {
  return approveOffered && proposalShown && currentlyVerified({ report, admission }) ? { lead: "approve", approve: "Approve and apply" } : { lead: "revise", approve: null };
}
