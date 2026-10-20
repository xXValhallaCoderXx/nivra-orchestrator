// The council evaluation (NIV-40, D32): the council against a single reviewer, on five synthetic plans, scored by a
// rubric that doesn't trust the model. Never part of `pnpm verify`. A paid batch runs only with your approval of its
// digest, which binds the fixtures, the rubric and the protocol, and only from a committed revision.
//
// Usage:
//   pnpm council:eval --plan                                              # the request for approval; no network
//   pnpm council:eval --credentials <file> --approved <digest>            # the paid batch: at most 20 requests
//   pnpm council:eval --token-factory-url <loopback url> --out <dir>      # the same batch against a stub
//   pnpm council:eval --resume <dir> [--credentials <file> --approved <digest> | --token-factory-url <url>]
//   pnpm council:eval --score <dir>                                       # the scores and the decision, once the sheet is labelled
//
// The credentials file holds a NEBIUS_API_KEY=… line, outside the repository, readable only by you (chmod 600). Never
// paste the key into a chat. It reaches the engine only through `initialize`, and is never printed or written.
// Evidence goes to ~/nivra-acceptance/council-eval-<UTC>-<revision>/ (0700) unless --out says otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readRecord, runBatch, type JournalEntry, Journal } from "./council-eval/batch.ts";
import { FixtureId, loadFrozen, readCredentials, REPOSITORY, runOrder, type Frozen } from "./council-eval/files.ts";
import { approvalRequest, limitMismatches } from "./council-eval/plan.ts";
import { buildSheet, missingLabels, scoreBatch, type RunRecord, type SheetItem, type SheetKey } from "./council-eval/score.ts";

const { values } = parseArgs({
  options: {
    plan: { type: "boolean", default: false },
    credentials: { type: "string" },
    approved: { type: "string" },
    "token-factory-url": { type: "string" },
    out: { type: "string" },
    resume: { type: "string" },
    score: { type: "string" },
    // Tests only: refused for a paid batch.
    only: { type: "string" },
    "deadline-ms": { type: "string" },
  },
  allowPositionals: false,
});

const refuse = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
const write = (path: string, value: unknown) => writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

const frozen = await loadFrozen().catch((error: unknown) => refuse(`The evaluation's fixtures, rubric or protocol can't be read: ${error instanceof Error ? error.message : String(error)}`));
const mismatches = limitMismatches(frozen);
if (mismatches.length) refuse(`The protocol's limits aren't the engine's (${mismatches.join("; ")}). Freeze the protocol again from the engine's limits.`);

const git = (args: string[]) => spawnSync("git", args, { cwd: REPOSITORY, encoding: "utf8" });
const commit = git(["rev-parse", "HEAD"]).stdout.trim() || null;
const dirty = git(["status", "--porcelain"]).stdout.trim().length > 0;

if (values.plan) {
  for (const line of approvalRequest(frozen, { commit, dirty })) console.log(line);
  process.exit(0);
}

if (values.score) {
  process.exit(score(resolve(values.score), frozen));
}

const live = values.credentials !== undefined;
if (live === (values["token-factory-url"] !== undefined)) refuse("Give either --credentials and --approved for the paid batch, or --token-factory-url for a stub. Run --plan to see the request for approval.");
const only = values.only ? values.only.split(",").map((id) => FixtureId.parse(id.trim())) : undefined;
const deadlineMs = values["deadline-ms"] ? Number(values["deadline-ms"]) : undefined;
if (live) {
  if (only || deadlineMs !== undefined) refuse("--only and --deadline-ms are for tests against a stub, never for the paid batch.");
  if (values.approved !== frozen.approvalDigest) refuse(`The approved digest isn't this protocol's (${frozen.approvalDigest}): the fixtures, the rubric or the protocol changed since. Run --plan, and approve what it shows.`);
  if (frozen.protocol.labelling === "pending") refuse("The protocol doesn't say who labels the sheet yet. Choose it in protocol.json, then approve the new digest --plan shows.");
  if (dirty || !commit) refuse("The working tree has uncommitted changes, so the revision this batch runs wouldn't be exact. Commit them, then run it again. Nothing was sent.");
} else {
  const url = new URL(values["token-factory-url"]!);
  if (!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) refuse("A stub must be on this computer (127.0.0.1, [::1] or localhost).");
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out = resolve(values.resume ?? values.out ?? join(homedir(), "nivra-acceptance", `council-eval-${stamp}-${(commit ?? "unknown").slice(0, 7)}`));
if (values.resume) {
  const sessions = new Journal(out).read().filter((entry): entry is Extract<JournalEntry, { type: "session" }> => entry.type === "session");
  if (!sessions.length) refuse(`${out} holds no batch to resume.`);
  if (sessions[0]!.mode !== (live ? "live" : "stub")) refuse(`${out} holds a ${sessions[0]!.mode} batch: resume it the same way.`);
  if (sessions[0]!.approvalDigest !== frozen.approvalDigest) refuse(`${out} was run under another protocol (${sessions[0]!.approvalDigest}), so it can't be resumed under this one.`);
} else if (existsSync(out) && readdirSync(out).length) {
  refuse(`${out} already holds evidence. Choose another --out, or --resume it.`);
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const apiKey = live ? (() => {
  try {
    return readCredentials(values.credentials!);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
})() : "stub-key-for-council-eval";

console.log(`Council evaluation, ${live ? "paid" : "against a stub"}: evidence in ${out}`);
const { records, stopped } = await runBatch({ frozen, out, mode: live ? "live" : "stub", tokenFactoryUrl: values["token-factory-url"] ?? null, apiKey, revision: commit, dirty, ...(only ? { only } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}), log: (line) => console.log(line) }).catch((error: unknown) =>
  // The engine stopped, or couldn't start. What was journalled stands; resuming finds the run that was out.
  refuse(`The batch couldn't go on (${error instanceof Error ? error.message : String(error)}). Its journal is in ${out}: resume it with --resume ${out} once the cause is fixed. Nothing is sent twice.`, 1),
);
write(join(out, "batch.json"), { revision: commit, dirty, approvalDigest: frozen.approvalDigest, packetDigests: frozen.packetDigests, mode: live ? "live" : "stub", stopped, runs: records.map(brief) });
writeSheet(out, records, frozen);
const requests = records.reduce((sum, record) => sum + (record.requests ?? 0), 0);
console.log(`${records.length} of ${runOrder().filter(({ fixture }) => !only || only.includes(fixture)).length} runs kept; ${requests} requests in all${records.some((record) => record.requests === null) ? ", and some runs whose requests can't be told" : ""}.`);
if (stopped) refuse(stopped, 3);
console.log(`Next: label ${join(out, "sheet.json")} (each line's "label"), then run --score ${out}.`);

function brief(record: RunRecord) {
  return { fixture: record.fixture, arm: record.arm, runId: record.runId, status: record.status, outcome: record.report?.outcome ?? null, requests: record.requests, durationMs: record.summary?.durationMs ?? null, usage: record.report?.usage ?? null, failureKind: record.failureKind };
}

/** The automatic pass and the blinded sheet, with its key kept in a file of its own. */
function writeSheet(dir: string, kept: readonly RunRecord[], frozenInputs: Frozen): void {
  const { sheet, key } = buildSheet(kept, frozenInputs);
  write(join(dir, "sheet.json"), sheet);
  write(join(dir, "sheet-key.json"), key);
  const lines = [`# Council evaluation: the blinded sheet`, "", frozenInputs.rubric.matching, "", `Unsupported: U1 ${frozenInputs.rubric.unsupported.U1} U3 ${frozenInputs.rubric.unsupported.U3}`, "", frozenInputs.rubric.novel, "", frozenInputs.rubric.control.rule, ""];
  for (const line of sheet) {
    lines.push(`## ${line.item} · ${line.fixture} · ${line.kind}`);
    if (line.finding) {
      lines.push(`**${line.finding.title}** (${line.finding.severity ?? "no severity"}, basis ${line.finding.basis}; refs ${line.finding.refs.join(", ") || "none"})`, "", line.finding.detail, "", `Recommendation: ${line.finding.recommendation || "none"}`, "", `Automatic: ${line.automatic.defects?.join(", ") || "no known defect"}`);
    } else {
      lines.push(line.summary ?? "", "", `Automatic: ${line.automatic.substantive ? "a summary was given" : "no summary"}`);
    }
    lines.push("");
  }
  write(join(dir, "sheet.md"), `${lines.join("\n")}\n`);
}

/** Pass three: the scores from the labelled sheet, the automatic-only ones beside them, and the decision. */
function score(dir: string, frozenInputs: Frozen): number {
  const journal = new Journal(dir).read();
  const kept = journal.filter((entry): entry is Extract<JournalEntry, { type: "end" }> => entry.type === "end").map((entry) => readRecord(dir, entry.fixture, entry.arm));
  const sheet = JSON.parse(readFileSync(join(dir, "sheet.json"), "utf8")) as SheetItem[];
  const key = JSON.parse(readFileSync(join(dir, "sheet-key.json"), "utf8")) as SheetKey;
  const missing = missingLabels(sheet, frozenInputs.rubric);
  if (missing.length) {
    console.error(`${missing.length} lines of the sheet still need a label: ${missing.join(", ")}. Label them, then score again.`);
    return 2;
  }
  const scored = scoreBatch(kept, sheet, key, frozenInputs);
  write(join(dir, "scores.json"), scored);
  const lines = [
    `# Council evaluation: ${scored.decided.decision}`,
    "",
    `Fixtures with a report from both arms: ${scored.decided.bothReported.join(", ") || "none"}.`,
    "",
    ...scored.decided.checks.map((check) => `- ${check.rule}: ${check.what}: ${check.held ? "holds" : "doesn't hold"}`),
    "",
    "Known defects found, by fixture (labelled; automatic in brackets):",
    ...(["single", "council"] as const).flatMap((arm) =>
      Object.entries(scored.labelled[arm].knownByFixture).map(([fixture, ids]) => `- ${arm} ${fixture}: ${ids.join(", ") || "none"} [${scored.automatic[arm].knownByFixture[fixture as FixtureId].join(", ") || "none"}]`),
    ),
  ];
  write(join(dir, "decision.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  return 0;
}
