// Stands in for an engine whose answer to runs.start is held until the test releases it (a `release` file in its
// home), so a test can act while a submission is out. It writes every method it is asked for to `calls.log`, turns
// runs.cancel down while a `fail-cancel` file exists, as an engine that can't stop a run would, and holds its answer to
// runs.cancel while a `hold-cancel` file exists, until a `release-cancel` file appears. runs.get and runs.result
// answer for a finished run whose result holds one suggestion; runs.result is held while a `hold-result` file exists,
// until a `release-result` file appears. Its store's id (D26) is kept in its home, so the same home keeps one id.
// For conversation turns (D26): with an `accept` file, runs.start records the run (`accepted.log`) before it holds its
// answer, as an engine that created the run would; with an `error-start` file, that answer is then an internal error.
// runs.find answers for a recorded request id; runs.get says "cancelled" for a run it was asked to cancel; runs.reply
// gives a general reply; runs.events has no events.
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
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    appendFileSync(join(home, "calls.log"), `${request.method}\n`);
    if (request.method === "initialize") {
      send({ id: request.id, result: { protocolVersion: 5, engineVersion: "gated", instanceId, pid: process.pid, home, homeId, runtimeHash: null, node: process.versions.node, platform: process.platform, arch: process.arch } });
    } else if (request.method === "ping") {
      send({ id: request.id, result: { instanceId } });
    } else if (request.method === "runs.start") {
      const runId = randomUUID();
      if (existsSync(join(home, "accept"))) appendFileSync(join(home, "accepted.log"), `${request.params.clientRequestId} ${runId}\n`);
      const held = setInterval(() => {
        if (!existsSync(join(home, "release"))) return;
        clearInterval(held);
        if (existsSync(join(home, "error-start"))) send({ id: request.id, error: { code: -32603, message: "the engine failed after accepting the run" } });
        else send({ id: request.id, result: summary("running", runId, request.params.workflowId) });
      }, 25);
    } else if (request.method === "runs.find") {
      const runId = accepted(request.params.clientRequestId);
      send({ id: request.id, result: runId ? { ...summary(cancelled.has(runId) ? "cancelled" : "succeeded", runId, "chat"), finishedAt: new Date().toISOString() } : null });
    } else if (request.method === "runs.get") {
      const status = cancelled.has(request.params.runId) ? "cancelled" : "succeeded";
      send({ id: request.id, result: { ...summary(status), id: request.params.runId, finishedAt: new Date().toISOString() } });
    } else if (request.method === "runs.reply") {
      const record = { exchanges: 0, chars: 0, shortened: 0, omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 }, digest: "gated" };
      send({ id: request.id, result: { kind: "general", text: "A gated reply.", cutOff: false, context: { preferences: { revision: 0, digest: "gated", records: [] }, history: record }, finishedAt: new Date().toISOString() } });
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
