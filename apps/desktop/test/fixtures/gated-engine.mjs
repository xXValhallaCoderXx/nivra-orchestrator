// Stands in for an engine whose answer to runs.start is held until the test releases it (a `release` file in its
// home), so a test can act while a submission is out. It writes every method it is asked for to `calls.log`, turns
// runs.cancel down while a `fail-cancel` file exists, as an engine that can't stop a run would, and holds its answer to
// runs.cancel while a `hold-cancel` file exists, until a `release-cancel` file appears, then answers the held ones in
// the order they came. runs.get and runs.result
// answer for a finished run whose result holds one suggestion; runs.result is held while a `hold-result` file exists,
// until a `release-result` file appears. Its store's id (D26) is kept in its home, so the same home keeps one id.
// For conversation turns (D26): with an `accept` file, runs.start records the run (`accepted.log`) before it holds its
// answer, as an engine that created the run would; with an `error-start` file, that answer is then an internal error
// (a refusal, without `accept`).
// runs.find answers for a recorded request id with the run still running (held while a `hold-find` file exists, until a
// `release-find` file appears); runs.get says "succeeded", or "cancelled" for a run it was asked to cancel; each run it
// cancels is written to `cancelled.log`; runs.reply gives a general reply; runs.events has no events.
// For reviews (D31): runs.start records each review's request id and input (`reviews.log`), and runs.review answers
// with a report that repeats what it was asked for, or names the next plan version while a `wrong-report` file exists.
// For sandbox checks (D36): runs.sandbox answers that there is no report yet; runs.get says "running" for a run it
// wasn't asked to cancel while a `running` file exists, and is turned down while a `fail-get` file exists, as an engine
// that can't read a run would.
// For research (D37): runs.start records each research request and what it was bound to (`research.log`), and
// runs.research answers with a report that repeats it: complete, or cancelled for a run it was asked to cancel. With a
// `fail-cancel-once` file, the next runs.cancel it answers is turned down, and the file is removed; with a
// `fail-cancel-for` file, runs.cancel for the run whose id it holds is turned down.
// For task runs (D39, D40): runs.start records each task run's request id and input (`tasks.log`). While a
// `task-report` file exists, runs.task answers such a run with a finished report that proposes the change `TASK_HASH`
// names, every acceptance case passed, and runs.proposal with that proposal. task.apply records each request id and
// the applied change it answers with (`applies.log`), unless a `refuse-apply` file exists; its answer is held while a
// `hold-apply` file exists, until a `release-apply` file appears, and is an internal error while an `error-apply` file
// exists; with a `partial-apply` file, the change it records was applied in part, and with an `aside-apply` file as well,
// one more file of it was moved aside with nothing in its place. task.applyStatus answers a recorded apply by its
// request id, or null; task.restore takes one back to its originals and task.dismiss settles one, each kept in
// `applies.log` so a later applyStatus reads it; with an `error-settle` file, either does its work, then answers with an
// internal error, as an engine whose answer is lost.
// It takes secrets.update, and turns down at once any other method it doesn't stand in for, so no caller waits out its
// time limit. The window's tests run it as the local engine with --nivra-test-engine=gated (unpackaged only).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** The change a gated task run proposes. */
const TASK_HASH = "5".repeat(64);
/** A line of a `<id> <json>` log, by its id. */
const logged = (file, id) => {
  const line = existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").split("\n").find((entry) => entry.startsWith(`${id} `)) : undefined;
  return line ? JSON.parse(line.slice(id.length + 1)) : null;
};
/** A finished task run's report, as an engine keeps one: a verified change proposed. */
const taskReport = (runId) => {
  const run = logged("tasks.log", runId);
  if (!run) return null;
  const now = new Date().toISOString();
  return {
    outcome: "proposed",
    stopped: null,
    task: { taskId: run.input.taskId, attemptId: run.clientRequestId, briefVersion: run.input.briefVersion, briefDigest: run.input.briefDigest },
    snapshot: null,
    toolchain: [],
    worker: null,
    checks: [],
    verified: true,
    steps: [],
    proposal: { hash: TASK_HASH, patchSha256: "6".repeat(64), patchBytes: 10, files: 1 },
    reportSha256: "7".repeat(64),
    cleanup: null,
    route: null,
    request: { runId, clientRequestId: run.clientRequestId },
    updatedAt: now,
    finishedAt: now,
  };
};
/** An apply as an engine reports one: the change written in place, its original kept aside. */
const appliedView = (requestId, runId) => {
  const now = new Date().toISOString();
  const applyId = randomUUID();
  return {
    applyId,
    requestId,
    runId,
    proposalHash: TASK_HASH,
    status: "applied",
    refusal: null,
    paths: [{ path: "greet.sh", change: "changed", place: "post", found: { kind: "file", mode: "100644", size: 10 }, kept: ["orig-0"], changedSince: false }],
    folders: [],
    recovery: `nivra-apply/${applyId}`,
    failure: null,
    resolution: null,
    createdAt: now,
    updatedAt: now,
  };
};
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
/** A research report as an engine keeps one, repeating what the research was bound to. */
const researchReport = (runId) => {
  const line = existsSync(join(home, "research.log")) ? readFileSync(join(home, "research.log"), "utf8").split("\n").find((entry) => entry.startsWith(`${runId} `)) : undefined;
  if (!line) return null;
  const { clientRequestId, input, packet } = JSON.parse(line.slice(runId.length + 1));
  const now = new Date().toISOString();
  const stopped = cancelled.has(runId);
  return {
    planId: input.planId,
    planVersion: input.planVersion,
    packetDigest: input.packetDigest,
    outcome: stopped ? "cancelled" : "complete",
    scope: packet.scope,
    request: { runId, clientRequestId },
    route: null,
    queries: packet.assumptions.map(({ id, text, query }) => ({ assumption: id, text, query })),
    sites: packet.sites,
    requests: [],
    pages: [],
    passages: [],
    assessments: [],
    checks: { citations: 0, valid: 0, relabelled: 0 },
    attribution: null,
    stop: stopped ? { code: "cancelled", message: "Cancelled." } : null,
    usage: { credits: null, model: { inputTokens: null, outputTokens: null, calls: 0, reportedCalls: 0 } },
    budget: null,
    elapsedMs: 0,
    updatedAt: now,
    finishedAt: now,
  };
};
/** The answers to runs.cancel held while a `hold-cancel` file exists, given in the order they came once released. */
const heldCancels = [];
setInterval(() => {
  if (heldCancels.length && existsSync(join(home, "release-cancel"))) for (const answer of heldCancels.splice(0)) answer();
}, 25).unref();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    appendFileSync(join(home, "calls.log"), `${request.method}\n`);
    if (request.method === "initialize") {
      send({ id: request.id, result: { protocolVersion: 11, engineVersion: "gated", instanceId, pid: process.pid, home, homeId, runtimeHash: null, node: process.versions.node, platform: process.platform, arch: process.arch } });
    } else if (request.method === "ping") {
      send({ id: request.id, result: { instanceId } });
    } else if (request.method === "runs.start") {
      const runId = randomUUID();
      if (existsSync(join(home, "accept"))) appendFileSync(join(home, "accepted.log"), `${request.params.clientRequestId} ${runId}\n`);
      if (request.params.workflowId === "review") appendFileSync(join(home, "reviews.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input })}\n`);
      if (request.params.workflowId === "task") appendFileSync(join(home, "tasks.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input })}\n`);
      if (request.params.workflowId === "research") {
        appendFileSync(join(home, "research.log"), `${runId} ${JSON.stringify({ clientRequestId: request.params.clientRequestId, input: request.params.input, packet: request.params.context.packet })}\n`);
      }
      const held = setInterval(() => {
        if (!existsSync(join(home, "release"))) return;
        clearInterval(held);
        if (existsSync(join(home, "error-start"))) send({ id: request.id, error: { code: -32603, message: existsSync(join(home, "accept")) ? "the engine failed after accepting the run" : "The engine refused the run." } });
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
      const status = cancelled.has(request.params.runId) ? "cancelled" : existsSync(join(home, "running")) ? "running" : "succeeded";
      if (existsSync(join(home, "fail-get"))) send({ id: request.id, error: { code: -32603, message: "the run couldn't be read" } });
      else send({ id: request.id, result: { ...summary(status), id: request.params.runId, finishedAt: status === "running" ? null : new Date().toISOString() } });
    } else if (request.method === "runs.reply") {
      const record = { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "gated" };
      send({ id: request.id, result: { kind: "general", text: "A gated reply.", cutOff: false, context: { preferences: { revision: 0, digest: "gated", records: [] }, history: record }, finishedAt: new Date().toISOString() } });
    } else if (request.method === "runs.review") {
      send({ id: request.id, result: reviewReport(request.params.runId) });
    } else if (request.method === "runs.research") {
      send({ id: request.id, result: researchReport(request.params.runId) });
    } else if (request.method === "runs.sandbox") {
      send({ id: request.id, result: null });
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
        const once = existsSync(join(home, "fail-cancel-once"));
        if (once) rmSync(join(home, "fail-cancel-once"));
        const named = existsSync(join(home, "fail-cancel-for")) && readFileSync(join(home, "fail-cancel-for"), "utf8") === request.params.runId;
        if (once || named || existsSync(join(home, "fail-cancel"))) send({ id: request.id, error: { code: -32000, message: "the run couldn't be stopped" } });
        else {
          cancelled.add(request.params.runId);
          appendFileSync(join(home, "cancelled.log"), `${request.params.runId}\n`);
          send({ id: request.id, result: { status: "cancelled", wasTerminal: false } });
        }
      };
      if (!existsSync(join(home, "hold-cancel"))) answer();
      else heldCancels.push(answer);
    } else if (request.method === "runs.task" && existsSync(join(home, "task-report"))) {
      send({ id: request.id, result: taskReport(request.params.runId) });
    } else if (request.method === "runs.proposal" && existsSync(join(home, "task-report"))) {
      const sha = "8".repeat(64);
      send({
        id: request.id,
        result: { hash: TASK_HASH, baseline: "a".repeat(40), prefix: "", paths: [{ path: "greet.sh", change: "changed", before: { mode: "100644", sha256: sha }, after: { mode: "100644", sha256: "9".repeat(64) } }], patch: "--- a/greet.sh\n+++ b/greet.sh\n", patchBytes: 30, truncated: false },
      });
    } else if (request.method === "task.apply") {
      const { requestId, runId } = request.params;
      const known = logged("applies.log", requestId);
      const partial = existsSync(join(home, "partial-apply"));
      const aside = { path: "README.md", change: "changed", place: "aside", found: { kind: "absent", mode: null, size: null }, kept: ["orig-1"], changedSince: false };
      const fresh = appliedView(requestId, runId);
      const view = known ?? { ...fresh, ...(partial ? { status: "partial" } : {}), ...(partial && existsSync(join(home, "aside-apply")) ? { paths: [...fresh.paths, aside] } : {}) };
      if (!known && !existsSync(join(home, "refuse-apply"))) appendFileSync(join(home, "applies.log"), `${requestId} ${JSON.stringify(view)}\n`);
      const answer = () => {
        if (existsSync(join(home, "error-apply"))) send({ id: request.id, error: { code: -32603, message: "the engine failed while it applied the change" } });
        else if (existsSync(join(home, "refuse-apply"))) send({ id: request.id, error: { code: -32602, message: "This engine has no proposal for that run, so nothing was written. Run the task again." } });
        else send({ id: request.id, result: view });
      };
      if (!existsSync(join(home, "hold-apply"))) answer();
      else {
        const held = setInterval(() => {
          if (!existsSync(join(home, "release-apply"))) return;
          clearInterval(held);
          answer();
        }, 25);
      }
    } else if (request.method === "task.applyStatus") {
      send({ id: request.id, result: logged("applies.log", request.params.requestId) });
    } else if (request.method === "task.dismiss" || request.method === "task.restore") {
      const file = join(home, "applies.log");
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      const at = lines.findIndex((entry) => JSON.parse(entry.slice(entry.indexOf(" ") + 1)).applyId === request.params.applyId);
      const updatedAt = new Date().toISOString();
      if (at < 0) send({ id: request.id, error: { code: -32602, message: "This engine has no apply by that id." } });
      else {
        const line = JSON.parse(lines[at].slice(lines[at].indexOf(" ") + 1));
        const next = request.method === "task.restore" ? { ...line, status: "not-applied", paths: line.paths.map((path) => ({ ...path, place: "pre", found: { kind: "file", mode: "100644", size: 10 } })), updatedAt } : { ...line, resolution: request.params.as, updatedAt };
        // Kept, as an engine keeps it: a later applyStatus reads it.
        lines[at] = `${line.requestId} ${JSON.stringify(next)}`;
        writeFileSync(file, `${lines.join("\n")}\n`);
        if (existsSync(join(home, "error-settle"))) send({ id: request.id, error: { code: -32603, message: "the engine failed after it settled the change" } });
        else send({ id: request.id, result: next });
      }
    } else if (request.method === "secrets.update") {
      send({ id: request.id, result: { ok: true } });
    } else if (request.method === "shutdown") {
      send({ id: request.id, result: { ok: true } });
      setTimeout(() => process.exit(0), 10);
    } else {
      send({ id: request.id, error: { code: -32601, message: `The gated engine doesn't stand in for ${request.method}.` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
