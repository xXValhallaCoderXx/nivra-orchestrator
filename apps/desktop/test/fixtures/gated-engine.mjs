// Stands in for an engine whose answer to runs.start is held until the test releases it (a `release` file in its
// home), so a test can act while a submission is out. It writes every method it is asked for to `calls.log`, turns
// runs.cancel down while a `fail-cancel` file exists, as an engine that can't stop a run would, and holds its answer to
// runs.cancel while a `hold-cancel` file exists, until a `release-cancel` file appears. runs.get and runs.result
// answer for a finished run whose result holds one suggestion; runs.result is held while a `hold-result` file exists,
// until a `release-result` file appears. Its store's id (D26) is kept in its home, so the same home keeps one id.
// For conversation turns (D26): with an `accept` file, runs.start records the run (`accepted.log`) before it holds its
// answer, as an engine that created the run would; with an `error-start` file, that answer is then an internal error.
// runs.find answers for a recorded request id with the run still running (held while a `hold-find` file exists, until a
// `release-find` file appears); runs.get says "succeeded", or "cancelled" for a run it was asked to cancel; each run it
// cancels is written to `cancelled.log`; runs.reply gives a general reply; runs.events has no events.
// For reviews (D31): runs.start records each review's request id and input (`reviews.log`), and runs.review answers
// with a report that repeats what it was asked for, or names the next plan version while a `wrong-report` file exists.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[process.argv.indexOf("--home") + 1];
const instanceId = process.argv[process.argv.indexOf("--instance") + 1] || randomUUID();
mkdirSync(home, { recursive: true });
if (!existsSync(join(home, "home-id"))) writeFileSync(join(home, "home-id"), randomUUID());
const homeId = readFileSync(join(home, "home-id"), "utf8").trim();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const summary = (status, id = randomUUID(), workflowId = "explain") => {
  const now = new Date().toISOString();
  return { id, workflowId, title: workflowId === "chat" ? "Chat" : "Explain", status, input: {}, createdAt: now, startedAt: now, finishedAt: null, error: null, durationMs: null, usage: null, route: null };
};
const cancelled = new Set();
const accepted = (clientRequestId) => {
  if (!existsSync(join(home, "accepted.log"))) return null;
  const line = readFileSync(join(home, "accepted.log"), "utf8").split("\n").find((entry) => entry.startsWith(`${clientRequestId} `));
  return line ? line.split(" ")[1] : null;
};
/** A review's report as an engine keeps one, repeating what the review was asked for. */
const reviewReport = (runId) => {
  const line = existsSync(join(home, "reviews.log")) ? readFileSync(join(home, "reviews.log"), "utf8").split("\n").find((entry) => entry.startsWith(`${runId} `)) : undefined;
  if (!line) return null;
  const { clientRequestId, input } = JSON.parse(line.slice(runId.length + 1));
  const now = new Date().toISOString();
  const adjusted = { dropped: 0, refsDropped: 0, relabelled: 0, shortened: 0 };
  return {
    panel: input.panel ?? "council",
    planId: input.planId,
    planVersion: existsSync(join(home, "wrong-report")) ? input.planVersion + 1 : input.planVersion,
    packetDigest: input.packetDigest,
    preferencesDigest: input.preferencesDigest,
    outcome: cancelled.has(runId) ? "cancelled" : "complete",
    scope: { kind: "general" },
    packet: { textChars: 1, assumptions: 0, references: 0 },
    request: { runId, clientRequestId },
    route: null,
    sampling: { temperature: null, topP: null, maxOutputTokens: 4000, toolChoice: "forced" },
    preferences: { revision: 0, digest: "gated", records: [] },
    reviewers: [{ role: "architecture", summary: "A gated review.", findings: [], assumptions: [], gaps: [], adjusted }],
    synthesis: null,
    stages: [],
    usage: { inputTokens: null, outputTokens: null, calls: 0, reportedCalls: 0 },
    budget: {
      limits: { requests: 3, totalMs: 330000, outputTokensPerRequest: 4000, estimatedInputTokens: 120000 },
      used: { requests: 0, elapsedMs: 0, inputTokens: 0, reportedInputTokens: null, reportedOutputTokens: null, unreportedRequests: 0, overrunTokens: 0 },
      stopped: null,
    },
    elapsedMs: 0,
    updatedAt: now,
    finishedAt: now,
  };
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    appendFileSync(join(home, "calls.log"), `${request.method}\n`);
    if (request.method === "initialize") {
      send({ id: request.id, result: { protocolVersion: 8, engineVersion: "gated", instanceId, pid: process.pid, home, homeId, runtimeHash: null, node: process.versions.node, platform: process.platform, arch: process.arch } });
    } else if (request.method === "ping") {
      send({ id: request.id, result: { instanceId } });
    } else if (request.method === "runs.start") {
      const runId = randomUUID();
      if (existsSync(join(home, "accept"))) appendFileSync(join(home, "accepted.log"), `${request.params.clientRequestId} ${runId}\n`);
      if (request.params.workflowId === "review") appendFileSync(join(home, "reviews.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input })}\n`);
      const held = setInterval(() => {
        if (!existsSync(join(home, "release"))) return;
        clearInterval(held);
        if (existsSync(join(home, "error-start"))) send({ id: request.id, error: { code: -32603, message: "the engine failed after accepting the run" } });
        else send({ id: request.id, result: summary("running", runId, request.params.workflowId) });
      }, 25);
    } else if (request.method === "runs.find") {
      const answer = () => {
        const runId = accepted(request.params.clientRequestId);
        send({ id: request.id, result: runId ? (cancelled.has(runId) ? { ...summary("cancelled", runId, "chat"), finishedAt: new Date().toISOString() } : summary("running", runId, "chat")) : null });
      };
      if (!existsSync(join(home, "hold-find"))) answer();
      else {
        const held = setInterval(() => {
          if (!existsSync(join(home, "release-find"))) return;
          clearInterval(held);
          answer();
        }, 25);
      }
    } else if (request.method === "runs.get") {
      const status = cancelled.has(request.params.runId) ? "cancelled" : "succeeded";
      send({ id: request.id, result: { ...summary(status), id: request.params.runId, finishedAt: new Date().toISOString() } });
    } else if (request.method === "runs.reply") {
      const record = { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "gated" };
      send({ id: request.id, result: { kind: "general", text: "A gated reply.", cutOff: false, context: { preferences: { revision: 0, digest: "gated", records: [] }, history: record }, finishedAt: new Date().toISOString() } });
    } else if (request.method === "runs.review") {
      send({ id: request.id, result: reviewReport(request.params.runId) });
    } else if (request.method === "runs.events") {
      send({ id: request.id, result: { events: [], next: request.params.after ?? 0, status: cancelled.has(request.params.runId) ? "cancelled" : "succeeded" } });
    } else if (request.method === "runs.result") {
      const answer = () =>
        send({
          id: request.id,
          result: {
            question: "",
            headAtStart: null,
            headAtEnd: null,
            summary: "A gated result.",
            findings: [],
            suggestions: [{ statement: "Name component files in PascalCase.", citations: [] }],
            gaps: [],
            context: { map: [], reads: [], searches: 0, searchHits: 0, chars: 0, changedFiles: [] },
            checks: { citations: 0, checked: 0 },
            answeredAtStep: 0,
            finishedAt: new Date().toISOString(),
          },
        });
      if (!existsSync(join(home, "hold-result"))) answer();
      else {
        const held = setInterval(() => {
          if (!existsSync(join(home, "release-result"))) return;
          clearInterval(held);
          answer();
        }, 25);
      }
    } else if (request.method === "runs.cancel") {
      const answer = () => {
        if (existsSync(join(home, "fail-cancel"))) send({ id: request.id, error: { code: -32000, message: "the run couldn't be stopped" } });
        else {
          cancelled.add(request.params.runId);
          appendFileSync(join(home, "cancelled.log"), `${request.params.runId}\n`);
          send({ id: request.id, result: { status: "cancelled", wasTerminal: false } });
        }
      };
      if (!existsSync(join(home, "hold-cancel"))) answer();
      else {
        const held = setInterval(() => {
          if (!existsSync(join(home, "release-cancel"))) return;
          clearInterval(held);
          answer();
        }, 25);
      }
    } else if (request.method === "shutdown") {
      send({ id: request.id, result: { ok: true } });
      setTimeout(() => process.exit(0), 10);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
