import { createHash } from "node:crypto";
import { z } from "zod";
import { evaluateTaskVerification, taskBriefDigest, taskVerificationManifest, TaskCheck, TaskSetupCheck, TaskVerificationManifest, TASK_BRIEF_LIMITS, type TaskAdmission, type TaskAdmissionParams } from "@nivra/domain";
import { canonicalJson, verifyProposal, type Proposal } from "../exec/proposal.ts";

/**
 * Approval uses the exact report bound into the proposal, never the fitted, masked display artifact or its boolean.
 * Historical reports keep their bytes and their original verdict. Their missing comparison isn't a waiver for a
 * failed final check, and their expected checks can be recovered only from the digest-bound original brief.
 */

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
// Historical bound cores kept the harness's 16 KB tails, before the public report clipped them to 4,000 characters.
const BoundCheck = TaskCheck.extend({ stdoutTail: z.string().max(16_384), stderrTail: z.string().max(16_384) });
const BoundReport = z.object({
  version: z.union([z.literal(3), z.literal(4)]),
  kind: z.literal("task"),
  task: z.strictObject({ taskId: z.string(), attemptId: z.string(), runId: z.string(), briefVersion: z.number().int().positive(), briefSha256: Sha256 }),
  baseline: z.string(),
  prefix: z.string(),
  environment: z.record(z.string(), z.unknown()).nullable(),
  environmentRef: z.record(z.string(), z.unknown()).nullable(),
  setup: TaskSetupCheck.nullable(),
  frozen: z.array(z.strictObject({ path: z.string().max(1_024), unchanged: z.boolean().nullable() })).max(TASK_BRIEF_LIMITS.frozen),
  checks: z.array(BoundCheck).max(TASK_BRIEF_LIMITS.finalChecks),
  verified: z.boolean(),
  manifest: TaskVerificationManifest.optional(),
  beforeChecks: z.array(TaskCheck).max(TASK_BRIEF_LIMITS.finalChecks - 1).optional(),
});
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const ADMISSION_UNAVAILABLE = "This run's trustworthy verification evidence isn't available, so this change can't be approved. Start a new authorised task run.";

export const unavailableAdmission = (reason = ADMISSION_UNAVAILABLE): TaskAdmission => ({ eligible: false, reason, proposalHash: null, reportSha256: null, legacy: false });

/** A read-only assessment. Applying repeats it immediately before it opens the checkout for revalidation. */
export async function taskAdmission(input: { proposal: Proposal | null; params: TaskAdmissionParams; homeId: string }): Promise<TaskAdmission> {
  const { proposal, params, homeId } = input;
  if (!proposal) return unavailableAdmission("This engine has no proposal for that run, so nothing can be approved. Start a new authorised task run.");
  let legacy = false;
  let intact = false;
  const refuse = (reason: string): TaskAdmission => ({ eligible: false, reason, proposalHash: intact ? proposal.hash : null, reportSha256: intact ? proposal.binding.reportSha256 : null, legacy });
  try {
    if (params.task.attempt.runId !== params.runId || params.task.engine.homeId !== homeId) return refuse("This proposal belongs to another run or engine, so it can't be approved here. Open its original run, then decide.");
    verifyProposal(proposal, {
      project: proposal.binding.project,
      target: proposal.binding.target,
      destination: proposal.binding.destination,
      head: proposal.binding.baseline,
      approvedHash: params.approvedHash,
      task: params.task,
    });
    // Parsing is bounded independently of display fitting. This is comfortably above a task's bounded report.
    if (proposal.report.byteLength > 1_048_576 || sha256(proposal.report) !== proposal.binding.reportSha256) return refuse(ADMISSION_UNAVAILABLE);
    const parsed = BoundReport.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proposal.report)));
    if (!parsed.success) return refuse(ADMISSION_UNAVAILABLE);
    intact = true;
    const report = parsed.data;
    legacy = report.version === 3;
    const { task } = params;
    if (report.task.taskId !== task.attempt.taskId || report.task.attemptId !== task.attempt.attemptId || report.task.runId !== params.runId || report.task.briefVersion !== task.brief.version || report.task.briefSha256 !== task.brief.sha256 || report.baseline !== proposal.binding.baseline || report.prefix !== proposal.binding.destination.prefix) return refuse("This proposal's report belongs to another run, brief or snapshot, so it can't be approved. Start a new authorised task run.");
    const setupRequired = report.environment !== null || report.environmentRef !== null;
    if (report.environment !== null && report.environmentRef !== null) return refuse(ADMISSION_UNAVAILABLE);
    if (params.brief && await taskBriefDigest(params.brief) !== task.brief.sha256) return refuse("The original brief doesn't match this proposal's binding, so its checks can't be established. Start a new authorised task run.");
    let manifest = report.manifest;
    if (legacy) {
      if (!params.brief) return refuse("This older run needs its original brief to establish every required check. Start a new authorised task run if that brief is no longer available.");
      manifest = await taskVerificationManifest(params.brief, setupRequired);
      if (report.checks.some((check) => check.kind === "check" ? check.name !== params.brief!.checks[check.number - 1] : check.name !== params.brief!.acceptanceCases[check.number - 1]?.name || (check.verdict === "passed" && check.exitCode !== params.brief!.acceptanceCases[check.number - 1]?.expectedExitCode))) return refuse("This older run's final results don't match its original cases and commands, so it can't be approved. Start a new authorised task run.");
    } else {
      if (!manifest || report.beforeChecks === undefined || manifest.setupRequired !== setupRequired) return refuse(ADMISSION_UNAVAILABLE);
      if (params.brief && canonicalJson(manifest) !== canonicalJson(await taskVerificationManifest(params.brief, setupRequired))) return refuse("The recorded checks don't match the original brief, so this change can't be approved. Start a new authorised task run.");
      const required = manifest.checks.filter((check) => check.kind === "check");
      if (report.beforeChecks.length !== required.length || required.some((expected) => report.beforeChecks!.filter((check) => check.kind === "check" && check.number === expected.number && check.commandSha256 === expected.commandSha256).length !== 1)) return refuse("The required checks' before-change evidence isn't complete or bound to the same commands. Start a new authorised task run.");
    }
    const assessment = evaluateTaskVerification({ manifest, checks: report.checks, frozen: report.frozen, setup: report.setup, originalVerified: report.verified, legacy });
    return { eligible: assessment.verified, reason: assessment.reason, proposalHash: proposal.hash, reportSha256: proposal.binding.reportSha256, legacy };
  } catch {
    return refuse(ADMISSION_UNAVAILABLE);
  }
}
