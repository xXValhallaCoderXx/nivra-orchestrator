import type { TaskBrief, TaskCheck, TaskSetupCheck, TaskVerificationManifest } from "./task.ts";

/** Command bytes, never a clipped name or output tail, identify a check on both sides of a change. */
export async function taskCommandDigest(command: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(command));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function taskVerificationManifest(brief: Pick<TaskBrief, "acceptanceCases" | "checks" | "frozen">, setupRequired: boolean): Promise<TaskVerificationManifest> {
  const commands = [
    ...brief.acceptanceCases.map((given, index) => ({ kind: "case" as const, number: index + 1, command: given.command })),
    ...brief.checks.map((command, index) => ({ kind: "check" as const, number: index + 1, command })),
  ];
  return { policy: "required-checks-v1", checks: await Promise.all(commands.map(async ({ command, ...identity }) => ({ ...identity, commandSha256: await taskCommandDigest(command) }))), frozen: [...(brief.frozen ?? [])], setupRequired };
}

type Evidence = Pick<TaskCheck, "kind" | "number" | "commandSha256" | "verdict" | "exitCode">;

/** One conservative rule for the worker, trusted engine admission and host explanations. */
export function evaluateTaskVerification(input: {
  manifest: TaskVerificationManifest | null | undefined;
  checks: readonly Evidence[];
  frozen?: readonly { path: string; unchanged: boolean | null }[];
  setup?: TaskSetupCheck | null;
  originalVerified?: boolean;
  /** Only for intact historical reports matched to the digest-bound original brief. */
  legacy?: boolean;
}): { verified: boolean; reason: string | null } {
  const refuse = (reason: string) => ({ verified: false, reason });
  const manifest = input.manifest;
  if (!manifest) return refuse("The expected checks weren't retained. Start a new authorised task run.");
  const cases = manifest.checks.filter((check) => check.kind === "case");
  if (cases.length === 0) return refuse("No acceptance cases were recorded, so this change isn't verified.");
  for (const kind of ["case", "check"] as const) {
    const expected = manifest.checks.filter((check) => check.kind === kind);
    if (expected.some((check, index) => check.number !== index + 1)) return refuse("The expected checks aren't complete and uniquely numbered. Start a new authorised task run.");
  }
  const frozen = input.frozen ?? [];
  if (new Set(manifest.frozen).size !== manifest.frozen.length || frozen.length !== manifest.frozen.length || manifest.frozen.some((path) => frozen.filter((file) => file.path === path && file.unchanged === true).length !== 1)) {
    return refuse("A frozen file isn't shown to be unchanged, so this change can't be approved. Reject it, or request a revision.");
  }
  if (manifest.setupRequired && (input.setup?.unchanged !== true || input.setup.changed.length !== 0)) return refuse("The setup files aren't shown to be unchanged, so this change can't be approved. Request a revision that leaves the setup files unchanged.");
  if (input.setup && (input.setup.unchanged !== true || input.setup.changed.length !== 0)) return refuse("The setup files aren't shown to be unchanged, so this change can't be approved. Request a revision that leaves the setup files unchanged.");
  if (input.checks.length !== manifest.checks.length) return refuse("Not every expected acceptance case and required repository check has a final result. Start a new authorised task run.");
  for (const expected of manifest.checks) {
    const results = input.checks.filter((check) => check.kind === expected.kind && check.number === expected.number);
    const result = results[0];
    if (results.length !== 1 || !result || (!input.legacy && result.commandSha256 !== expected.commandSha256)) return refuse("A required final result is missing, repeated or bound to another command. Start a new authorised task run.");
    if (result.verdict !== "passed" || result.exitCode === null || (expected.kind === "check" && result.exitCode !== 0)) {
      return refuse(expected.kind === "case" ? "Not every acceptance case was shown to pass, so this change can't be approved. Reject it, or request a revision." : `Required repository check ${expected.number} wasn't shown to pass, so this change can't be approved. Reject it, or request a revision.`);
    }
  }
  if (input.originalVerified === false) return refuse("This run was originally unverified. Start a new authorised task run; its original result hasn't been changed.");
  return { verified: true, reason: null };
}
