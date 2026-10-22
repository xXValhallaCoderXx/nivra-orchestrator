// Stands in for an engine whose review never ends (NIV-40): runs.start answers with a running run, which stays running
// after runs.cancel, as an engine that can't stop a run would. It makes no model call. Doctor reports a test endpoint,
// or Token Factory when started as token-factory-engine.mjs, an engine set up for the wrong endpoint. Every method it is
// asked for is written to `calls.log` in its home, and its store's id is kept there, so the same home keeps one id.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const home = process.argv[process.argv.indexOf("--home") + 1];
mkdirSync(home, { recursive: true });
if (!existsSync(join(home, "home-id"))) writeFileSync(join(home, "home-id"), randomUUID());
const homeId = readFileSync(join(home, "home-id"), "utf8").trim();
const instanceId = randomUUID();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const runs = new Map();
const summary = (id) => ({ id, workflowId: "review", title: "Council review · plan v1", status: "running", input: {}, createdAt: runs.get(id), startedAt: runs.get(id), finishedAt: null, error: null, durationMs: null, usage: null, route: null });
const byRequest = new Map();

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    appendFileSync(join(home, "calls.log"), `${request.method}\n`);
    const params = request.params ?? {};
    if (request.method === "initialize") {
      send({ id: request.id, result: { protocolVersion: 8, engineVersion: "stuck", instanceId, pid: process.pid, home, homeId, runtimeHash: null, node: process.versions.node, platform: process.platform, arch: process.arch } });
    } else if (request.method === "doctor") {
      const tokenFactory = basename(process.argv[1] ?? "").startsWith("token-factory-engine");
      send({ id: request.id, result: { checks: [{ id: "models", status: tokenFactory ? "ok" : "warn", title: "Model endpoint", detail: tokenFactory ? "Nebius Token Factory" : "A test endpoint", fix: null }] } });
    } else if (request.method === "runs.start") {
      const id = randomUUID();
      runs.set(id, new Date().toISOString());
      byRequest.set(params.clientRequestId, id);
      send({ id: request.id, result: summary(id) });
    } else if (request.method === "runs.get") {
      send({ id: request.id, result: summary(params.runId) });
    } else if (request.method === "runs.cancel") {
      send({ id: request.id, result: { status: "running", wasTerminal: false } });
    } else if (request.method === "runs.events") {
      send({ id: request.id, result: { events: [], next: params.after ?? 0, status: "running" } });
    } else if (request.method === "runs.review") {
      send({ id: request.id, result: null });
    } else if (request.method === "runs.find") {
      const id = byRequest.get(params.clientRequestId);
      send({ id: request.id, result: id ? summary(id) : null });
    } else if (request.method === "shutdown") {
      send({ id: request.id, result: { ok: true } });
      setTimeout(() => process.exit(0), 10);
    } else {
      send({ id: request.id, error: { code: -32601, message: "not here" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
