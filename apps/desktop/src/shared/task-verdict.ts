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
