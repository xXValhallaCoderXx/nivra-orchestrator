// Drives a real engine over stdio (AGENTS.md, Definition of Done): starts it on a development home, initializes it,
// sends one request, prints the result as JSON, then shuts it down.
//
// Usage: pnpm rpc <method> [params-json] [--home <dir>] [--follow] [--token-factory-url <loopback url>]
//   pnpm rpc doctor
//   pnpm rpc runs.start '{"workflowId":"hello","input":{"repoPath":"/path/to/repo"}}' --follow
//
// A run without a "context" gets an empty preference snapshot and no consent to share here; the app always sends its
// own (D21, D22), for example
//   "context":{"preferences":{"revision":1,"records":[{"id":"<uuid>","statement":"Use pnpm","scope":"personal","revision":1}]},"sharing":{"modelContext":true}}
//
// The home defaults to ~/.nivra-dev (D7), never the installed app's. NEBIUS_API_KEY, when set, is passed to the engine
// in `initialize`, the way the app does it (D8).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMethodName, isTerminal, LineSplitter, Methods, PROTOCOL_VERSION, RpcCallError, RpcClient, type MethodName } from "@nivra/domain";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { home: { type: "string" }, follow: { type: "boolean", default: false }, "token-factory-url": { type: "string" } },
});
const [method, rawParams] = positionals;
if (!method || !isMethodName(method)) {
  console.error(`Usage: pnpm rpc <method> [params-json] [--home <dir>] [--follow] [--token-factory-url <loopback url>]\nMethods: ${Object.keys(Methods).join(", ")}`);
  process.exit(2);
}
let params: Record<string, unknown>;
try {
  params = rawParams ? (JSON.parse(rawParams) as Record<string, unknown>) : {};
} catch {
  console.error("The parameters must be one JSON object, for example '{\"runId\":\"…\"}'.");
  process.exit(2);
}
if (method === "runs.start" && params["clientRequestId"] === undefined) params = { clientRequestId: randomUUID(), ...params };
// Without a context: no preferences, and no consent to send repository content to a model (D22).
if (method === "runs.start" && params["context"] === undefined) params = { ...params, context: { preferences: { revision: 0, records: [] }, sharing: { modelContext: false } } };

const apiKey = process.env["NEBIUS_API_KEY"]?.trim();
delete process.env["NEBIUS_API_KEY"];
const home = values.home ?? join(homedir(), ".nivra-dev");
const entry = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
// A stub of Token Factory on this machine, for checking a workflow without a real model (the engine refuses others).
const stub = values["token-factory-url"] ? ["--token-factory-url", values["token-factory-url"]] : [];
const child = spawn(process.execPath, [entry, "--stdio", "--home", home, "--heartbeat-ms", "0", "--nivra-engine", ...stub], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

const client = new RpcClient({
  send: (line) => void child.stdin.write(line),
  onNotification: (name, payload) => console.error(`engine notification ${name}: ${JSON.stringify(payload)}`),
  onProtocolError: (problem) => console.error(`protocol error: ${problem}`),
  defaultTimeoutMs: 60_000,
});
const splitter = new LineSplitter();
child.stdout.on("data", (chunk: Buffer) => {
  for (const line of splitter.push(chunk)) client.receive(line);
});
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk.toString("utf8").replace(/^(?=.)/gm, "engine: ")));
const exited = new Promise<number | null>((resolve) =>
  child.once("exit", (code) => {
    client.close("The engine exited.");
    resolve(code);
  }),
);

let status = 0;
try {
  await client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "rpc.ts", version: "0" }, secrets: apiKey ? { NEBIUS_API_KEY: apiKey } : {} });
  const result = await client.call(method as MethodName, params as never);
  console.log(JSON.stringify(result, null, 2));
  if (values.follow && method === "runs.start") {
    const runId = (result as { id: string }).id;
    let after = 0;
    for (;;) {
      const page = await client.call("runs.events", { runId, after, limit: 500 });
      for (const event of page.events) console.log(`${event.seq.toString().padStart(3)} ${event.type.padEnd(16)} ${(event.stepId ?? "").padEnd(12)} ${event.message}`);
      after = page.next;
      if (isTerminal(page.status)) {
        console.log(`status: ${page.status}`);
        if (page.status !== "succeeded") status = 1;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
} catch (error) {
  console.error(error instanceof RpcCallError ? `error ${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
  status = 1;
}
await client.call("shutdown", {}).catch(() => undefined);
const code = await exited;
process.exit(status || (code ?? 1));
