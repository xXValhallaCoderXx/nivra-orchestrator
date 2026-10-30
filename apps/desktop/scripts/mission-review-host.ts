// The source live check's host process. Admission, dispatch and reconciliation use production Host code.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NO_SUBLIMITS, type BudgetPolicyDraft, type MissionReviewPacket, type ReviewReport, type RunSummary } from "@nivra/domain";
import { Host } from "../src/main/host.ts";
import { HostStore } from "../src/main/host-store.ts";
import { LocalTarget } from "../src/main/targets/local.ts";
import type { MissionReviewView } from "../src/shared/ipc.ts";
import { missionEvidencePath } from "../../engine/scripts/mission-review-paths.ts";

/** The isolated policy's meaningful choices, bound into the source recipe before any key is read. */
export const MISSION_LIVE_POLICY = Object.freeze<BudgetPolicyDraft>({ preset: "counts", currency: null, monthlyMicros: null, timezone: "UTC", thresholds: [], sublimits: NO_SUBLIMITS, allowances: { sandboxOperations: 0, sandboxSeconds: 0, researchCredits: 0 }, researchCreditMicros: null, modelRequestLimits: [{ pool: "companion-and-planning", monthlyRequests: 3, includeMissionReviews: true }] });

export async function collectHostMissionReview(options: { packet: MissionReviewPacket; home: string; root: string; apiKey: string; tokenFactoryUrl: string | null; followMs: number; logPath: string }) {
  const started = performance.now();
  const end = started + options.followMs;
  const problems: string[] = [];
  let summary: RunSummary | null = null, report: ReviewReport | null = null;
  let review: MissionReviewView | null = null;
  let missionId: string | null = null;
  let startRequested = false;
  let unresolved: string | null = null;
  let cancellation: "not-requested" | "requested" | "failed" | "confirmed" = "not-requested";
  let engineClose: "not-available" | "returned" | "failed" = "not-available";
  let phase = "initialise the engine";
  missionEvidencePath(options.root); missionEvidencePath(options.home); missionEvidencePath(options.logPath);
  if (existsSync(options.root) && readdirSync(options.root).length) throw new Error("The isolated host folder already holds evidence. Choose a fresh folder; nothing was sent.");
  const platform = process.platform;
  if (platform !== "linux" && platform !== "win32" && platform !== "darwin") throw new Error("The mission review source harness needs a supported Nivra platform.");
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  // Check the engine home before recording a Start intent. A normal profile is never used.
  try { mkdirSync(options.home, { recursive: true, mode: 0o700 }); }
  catch { return { summary, report, startRequested, unresolved, cancellation, engineClose, problems: ["Couldn't initialise the engine. Keep this evidence and resolve the failure before requesting another run."], elapsedMs: Math.round(performance.now() - started), clientRequestId: null }; }
  writeFileSync(options.logPath, "", { mode: 0o600 });
  const host = new Host({
    store: new HostStore(join(options.root, "nivra.json")), workspacePath: join(options.root, "workspace.db"), logsDir: join(options.root, "logs"),
    targets: { local: new LocalTarget({ platform, runtime: { node: process.execPath, entry: fileURLToPath(new URL("../../engine/src/main.mjs", import.meta.url)), runtimeHash: null }, home: options.home, ...(options.tokenFactoryUrl ? { extraArgs: ["--token-factory-url", options.tokenFactoryUrl] } : {}) }), discoverWsl: async () => null },
    platform: process.platform, client: { name: "mission-review-live-host", version: "0" }, credentials: async () => ({ NEBIUS_API_KEY: options.apiKey }),
    log: (line) => { writeFileSync(options.logPath, `${line.split(options.apiKey).join("[redacted]")}\n`, { flag: "a", mode: 0o600 }); },
  });
  host.init();
  try {
    phase = "prepare the mission and shared allowance";
    await host.setBudgetPolicy(MISSION_LIVE_POLICY);
    const mission = await host.createMission(options.packet.mission);
    missionId = mission.id;
    const taskIds: string[] = [];
    for (const task of options.packet.tasks) {
      const { title, acceptanceCaseNames, ...fields } = task;
      if (acceptanceCaseNames.length) throw new Error("The frozen live fixture includes unsupported acceptance-case names.");
      const added = await host.createMissionTask(mission.id, title, { ...fields, acceptanceCases: [] });
      const id = added.backlog.find((entry) => entry.task.title === title)?.task.id;
      if (!id) throw new Error("The fixture task was not created.");
      taskIds.push(id);
    }
    const model = options.packet.model;
    if (!model) throw new Error("The source live fixture must name its required model.");
    const preview = await host.prepareMissionReview(mission.id, taskIds, { requiredModel: model });
    if (preview.blocked) throw new Error(preview.blocked);
    phase = "start the review";
    startRequested = true;
    await host.startMissionReview(mission.id, taskIds, preview.expected, { requiredModel: model });
    phase = "read the review's status";
    do {
      review = host.mission(mission.id).reviews[0] ?? null;
      if (review?.runId) summary = (await host.runResult(review.runId)).summary;
      report = review?.report ?? report;
      if (review && review.status !== "submitting" && review.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (performance.now() < end);
    if (!review || review.status === "submitting" || review.status === "running") problems.push(`No terminal run state was observed within ${options.followMs / 1000} s; cancellation was requested.`);
    if (review?.status === "not-sent") problems.push("The production host refused this review before sending it. Review its isolated policy and grant evidence before another attempt.");
  } catch {
    problems.push(`Couldn't ${phase}. Keep this evidence and resolve the failure before requesting another run.`);
  } finally {
    try {
      try {
        if (missionId) {
          review = host.mission(missionId).reviews[0] ?? review;
          if (review && (review.status === "submitting" || review.status === "running")) {
            cancellation = "requested";
            try { await host.cancelMissionReview(missionId, review.id); }
            catch { cancellation = "failed"; problems.push("The cancellation request failed; this doesn't establish that the review stopped."); }
          }
          if (review?.runId) {
            try { summary = (await host.runResult(review.runId)).summary; }
            catch { problems.push("Couldn't read the review's final engine status."); }
          }
          const collectUntil = performance.now() + 5_000;
          while (review && (review.status === "submitting" || review.status === "running") && performance.now() < collectUntil) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            review = host.mission(missionId).reviews[0] ?? review;
          }
          review = host.mission(missionId).reviews[0] ?? review;
          report = review?.report ?? report;
          if (summary?.status === "cancelled") cancellation = "confirmed";
          if (startRequested && (!summary || summary.status === "running" || summary.status === "queued")) unresolved = "No terminal run state was observed; termination is unresolved. The original host request is never resent.";
        }
        if (!report && startRequested) problems.push("The engine returned no review report; findings and usage are unavailable.");
      } catch {
        problems.push("Couldn't collect the review's final state; retain the isolated homes and resolve the missing evidence.");
        if (startRequested) unresolved ??= "The review's final state could not be collected; termination is unresolved.";
      }
      try { await host.getCompanionUsage(); }
      catch { problems.push("Budget reconciliation failed; retain the isolated homes and resolve the grant evidence before another attempt."); }
    } finally {
      try { await host.shutdown(); engineClose = "returned"; }
      catch { engineClose = "failed"; problems.push("Host shutdown failed; check the isolated engine home before further work."); }
    }
  }
  // Only after the production owners have closed. Both databases belong to this OS (D7); no key or raw context.
  if (engineClose === "returned") {
    try {
      const ledger = new DatabaseSync(join(options.root, "workspace.db"), { readOnly: true });
      let receipt;
      try {
        const grants = ledger.prepare("SELECT id, request_id, state, attribution_json, grant_json, written_revision FROM budget_grants WHERE workflow = 'review'").all();
        const rows = ledger.prepare("SELECT operation_json FROM budget_operations ORDER BY rowid").all().map((row) => JSON.parse(String(row.operation_json)));
        receipt = { grants, operations: rows, guard: readFileSync(join(options.root, "budget-guard.log"), "utf8") };
      } finally { ledger.close(); }
      const engine = new DatabaseSync(join(options.home, "nivra.db"), { readOnly: true });
      let roles;
      try { roles = engine.prepare("SELECT grant_id, seq, kind, part, seat, model, instructions_sha256, state FROM budget_journal ORDER BY rowid").all(); }
      finally { engine.close(); }
      writeFileSync(join(options.root, "receipt.json"), `${JSON.stringify({ ...receipt, roles }, null, 2)}\n`, { mode: 0o600 });
    } catch { problems.push("Couldn't collect the private grant and journal receipt. Retain the isolated homes; this run has incomplete budget evidence."); }
  }
  return { summary, report, startRequested, unresolved, cancellation, engineClose, problems, elapsedMs: Math.round(performance.now() - started), clientRequestId: review?.id ?? null };
}
