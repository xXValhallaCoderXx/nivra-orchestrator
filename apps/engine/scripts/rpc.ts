// Drives a real engine over stdio (AGENTS.md, Definition of Done): starts it on a development home, initializes it,
// sends one request, prints the result as JSON, then shuts it down.
//
// Usage: pnpm rpc <method> [params-json] [--home <dir>] [--follow] [--token-factory-url <loopback url>] [--sandboxes-url <loopback url>]
//   [--tavily-url <loopback url>]
//   pnpm rpc doctor
//   pnpm rpc runs.start '{"workflowId":"hello","input":{"repoPath":"/path/to/repo"}}' --follow
//
// A run without a "context" gets an empty preference snapshot and no consent to share here; the app always sends its
// own (D21, D22, D23), for example
//   "context":{"preferences":{"revision":1,"records":[{"id":"<uuid>","statement":"Use pnpm","scope":"personal","intent":"default","revision":1}]},"sharing":{"modelContext":true}}
// An explain run needs that consent, and can carry the task's choices (D23):
//   pnpm rpc runs.start '{"workflowId":"explain","input":{"repoPath":"/path/to/repo","choices":["Keep Jest for this task"]},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":true}}}' --follow
// A conversation's turn (D26) carries the history too; without a context it gets none. A repository turn needs consent:
//   pnpm rpc runs.start '{"workflowId":"chat","input":{"message":"How should I stage this?","scope":{"kind":"general"}}}' --follow
//   pnpm rpc runs.start '{"workflowId":"chat","input":{"message":"Plan a CSV export","scope":{"kind":"repository","repoPath":"/path/to/repo"}},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":true},"history":{"exchanges":[],"omitted":{"overLimit":0,"unanswered":0,"preferencesChanged":0}}}}' --follow
// After --follow, a chat run's stored reply is printed.
// A review of a saved plan version (D30) needs its context: the preferences, the consent and the packet. Its two
// fingerprints are worked out here when they are left out; after --follow, its report is printed:
//   pnpm rpc runs.start '{"workflowId":"review","input":{"planId":"<uuid>","planVersion":1},"context":{"preferences":{"revision":0,"records":[]},"sharing":{"modelContext":false},"packet":{"scope":{"kind":"general"},"text":"Plan text","assumptions":[],"references":[]}}}' --follow
// A mission review (NIV-52) is the same run with a mission packet in place of the plan's (kind "mission": the council's
// three profiles, the model or null, the mission and up to five tasks); its fingerprint is worked out the same way.
// A sandbox check (D36) needs upload consent; without a context it has none. Its preview's fingerprint is taken here
// from `sandbox.preview` when it is left out, and a project id and the local target are filled in; after --follow, its
// report is printed. Against a stand-in for Nebius on this machine, pass --sandboxes-url:
//   pnpm rpc sandbox.preview '{"repoPath":"/path/to/repo"}'
//   pnpm rpc runs.start '{"workflowId":"sandbox","input":{"repoPath":"/path/to/repo"},"context":{"sharing":{"cloudExecution":true}}}' --follow --sandboxes-url http://127.0.0.1:<port>
// Research of a saved plan version's assumptions (D37) needs its packet. Without the rest of its context it has no
// permission to research and no deny list; its packet's fingerprint is worked out here when it is left out; after
// --follow, its report is printed. Against stand-ins for Tavily and Token Factory, pass --tavily-url and
// --token-factory-url:
//   pnpm rpc runs.start '{"workflowId":"research","input":{"planId":"<uuid>","planVersion":1},"context":{"sharing":{"modelContext":false,"webResearch":true},"packet":{"scope":{"kind":"general"},"planText":"Plan text","assumptions":[{"id":"A1","text":"An assumption","origin":{"kind":"typed"},"query":"A query"}],"sites":null}}}' --follow
// A task run (D39) needs its brief and both consents; without them it has neither. Its brief's digest and its preview's
// fingerprint (from `task.preview`) are worked out here when they are left out, and a project id, a task id, brief
// version 1 and the local target are filled in; after --follow, its report and proposal are printed. Against stand-ins
// for Nebius and Token Factory, pass --sandboxes-url and --token-factory-url:
//   pnpm rpc task.preview '{"repoPath":"/path/to/repo","brief":{"goal":"…","acceptanceCriteria":[],"scope":"","exclusions":"","context":"","checks":[],"acceptanceCases":[{"name":"…","command":"…","expectedOutput":"…\n","expectedExitCode":0}]}}'
//   pnpm rpc runs.start '{"workflowId":"task","input":{"repoPath":"/path/to/repo"},"context":{"sharing":{"modelContext":true,"cloudExecution":true},"brief":{…}}}' --follow --sandboxes-url http://127.0.0.1:<port> --token-factory-url http://127.0.0.1:<port>/v1
// An environment's preparation (D41) needs upload consent and the spec; without a context it has neither consent nor
// filters. Its preview's fingerprint is taken here from `environment.preview` when it is left out, and a project id and
// the local target are filled in; after --follow, its report is printed. A task run bound to it carries the prepared
// environment in its input ("environment": {image, inputsDigest, projectFingerprint, node, pnpm, arch}):
//   pnpm rpc environment.preview '{"repoPath":"/path/to/repo","spec":{"filters":["@scope/package..."]}}'
//   pnpm rpc runs.start '{"workflowId":"environment","input":{"repoPath":"/path/to/repo"},"context":{"sharing":{"cloudExecution":true},"spec":{"filters":[]}}}' --follow --sandboxes-url http://127.0.0.1:<port>
// Applying a finished task run's proposal (D40) needs only the run's id: the approval is filled in from the run, its
// report and its proposal, and this engine's home, as the host would send it, with a new request id. It writes to the
// run's checkout:
//   pnpm rpc task.apply '{"runId":"<uuid>"}'
//   pnpm rpc task.dismiss '{"applyId":"<uuid>","as":"accepted"}'
// A coaching of one task (NIV-53) needs its packet; without the rest of its context it has no preferences and no
// consent to share a project's material. Its fingerprints, a task and brief, a binding naming them, and the coach's
// profile are filled in when they are left out; after --follow, its report is printed. Against a stand-in for Token
// Factory, pass --token-factory-url, and always a home of its own:
//   pnpm rpc runs.start '{"workflowId":"coach","context":{"packet":{"scope":{"kind":"general"},"task":{…},"gaps":[],"mission":null,"findings":[]}}}' --follow --token-factory-url http://127.0.0.1:<port>/v1 --home ~/.nivra-dev-niv53/<check>
//
// The home defaults to ~/.nivra-dev (D7), never the installed app's. NEBIUS_API_KEY, NEBIUS_PROJECT_ID and
// TAVILY_API_KEY, when set, are passed to the engine in `initialize`, the way the app does it (D8).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  bindingDigest,
  COACH_PROFILE,
  coachPacketDigest,
  isMethodName,
  isTerminal,
  LineSplitter,
  Methods,
  missionPacketDigest,
  packetDigest,
  preferencesDigest,
  PROTOCOL_VERSION,
  researchPacketDigest,
  RpcCallError,
  RpcClient,
  taskBriefDigest,
  type CoachPacket,
  type MethodName,
  type MissionReviewPacket,
  type TaskBrief,
} from "@nivra/domain";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { home: { type: "string" }, follow: { type: "boolean", default: false }, "token-factory-url": { type: "string" }, "sandboxes-url": { type: "string" }, "tavily-url": { type: "string" } },
});
const [method, rawParams] = positionals;
if (!method || !isMethodName(method)) {
  console.error(`Usage: pnpm rpc <method> [params-json] [--home <dir>] [--follow] [--token-factory-url <loopback url>] [--sandboxes-url <loopback url>] [--tavily-url <loopback url>]\nMethods: ${Object.keys(Methods).join(", ")}`);
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
// A review's fingerprints, worked out from the context it carries when the request leaves them out (D30).
if (method === "runs.start" && params["workflowId"] === "review") {
  const context = params["context"] as { preferences?: { records?: Parameters<typeof preferencesDigest>[0] }; packet?: Parameters<typeof packetDigest>[0] | MissionReviewPacket } | undefined;
  const input = (params["input"] ?? {}) as Record<string, unknown>;
  const packet = context?.packet;
  if (packet && input["packetDigest"] === undefined) input["packetDigest"] = "kind" in packet ? await missionPacketDigest(packet) : await packetDigest(packet);
  if (context?.preferences?.records && input["preferencesDigest"] === undefined) input["preferencesDigest"] = await preferencesDigest(context.preferences.records);
  params = { ...params, input };
}
// Research without the rest of its context: no permission to research or share, and nothing denied (D37). Its packet's
// fingerprint is worked out from the packet it carries when the request leaves it out.
if (method === "runs.start" && params["workflowId"] === "research") {
  const given = (params["context"] ?? {}) as { sharing?: unknown; deny?: unknown; packet?: Parameters<typeof researchPacketDigest>[0] };
  const context = { sharing: { modelContext: false, webResearch: false }, deny: { terms: [], paths: [] }, ...given };
  const input = (params["input"] ?? {}) as Record<string, unknown>;
  if (context.packet && input["packetDigest"] === undefined) input["packetDigest"] = await researchPacketDigest(context.packet);
  params = { ...params, input, context };
}
// A task run without the rest of its context: no consent to share or upload (D39). Its brief's digest is worked out from
// the brief it carries, and a project, a task, a brief version and the local target are filled in, when left out.
const task = method === "runs.start" && params["workflowId"] === "task";
if (task) {
  const given = (params["context"] ?? {}) as { sharing?: unknown; brief?: TaskBrief };
  const context = { sharing: { modelContext: false, cloudExecution: false }, ...given };
  const input: Record<string, unknown> = { project: randomUUID(), target: "local", taskId: randomUUID(), briefVersion: 1, ...(params["input"] as Record<string, unknown>) };
  if (context.brief && input["briefDigest"] === undefined) input["briefDigest"] = await taskBriefDigest(context.brief);
  params = { ...params, input, context };
}
// A coaching without the rest of its context: no preferences, and no consent to share a project's material (NIV-53).
// A task, a brief and a binding naming them, the coach's profile, and the packet's and preferences' fingerprints are
// filled in when the request leaves them out. The engine checks the packet's against the packet it carries.
if (method === "runs.start" && params["workflowId"] === "coach") {
  const given = (params["context"] ?? {}) as { preferences?: { revision: number; records: Parameters<typeof preferencesDigest>[0] }; sharing?: unknown; packet?: CoachPacket };
  const context = { preferences: { revision: 0, records: [] }, sharing: { modelContext: false }, ...given };
  const packet = context.packet;
  const input: Record<string, unknown> = { taskId: randomUUID(), briefId: randomUUID(), briefVersion: packet?.task.briefVersion ?? 1, profile: { ...COACH_PROFILE }, ...(params["input"] as Record<string, unknown> | undefined) };
  if (packet && input["packetDigest"] === undefined) input["packetDigest"] = await coachPacketDigest(packet);
  if (input["preferencesDigest"] === undefined) input["preferencesDigest"] = await preferencesDigest(context.preferences.records);
  if (input["bindingDigest"] === undefined) {
    const brief = { taskId: String(input["taskId"]), briefId: String(input["briefId"]), briefVersion: Number(input["briefVersion"]), briefSha256: String(input["packetDigest"] ?? "0".repeat(64)), title: packet?.task.title ?? "A task" };
    input["bindingDigest"] = await bindingDigest({ mission: null, tasks: [brief], findings: [], specialists: [{ id: COACH_PROFILE.id, version: COACH_PROFILE.version }] });
  }
  params = { ...params, input, context };
}
const sandbox = method === "runs.start" && params["workflowId"] === "sandbox";
// A preparation without the rest of its context: no upload consent, and the whole workspace (D41).
const environment = method === "runs.start" && params["workflowId"] === "environment";
if (environment) {
  params = { ...params, input: { project: randomUUID(), target: "local", ...(params["input"] as Record<string, unknown>) }, context: { sharing: { cloudExecution: false }, spec: { filters: [] }, ...(params["context"] as Record<string, unknown> | undefined) } };
}
// Without a context: no preferences, no consent to send repository content to a model (D22), and for a turn no
// history. A sandbox check gets no upload consent (D36).
if (method === "runs.start" && params["context"] === undefined) {
  const history = params["workflowId"] === "chat" ? { history: { exchanges: [], omitted: { overLimit: 0, unanswered: 0, preferencesChanged: 0 } } } : {};
  params = { ...params, context: sandbox ? { sharing: { cloudExecution: false } } : { preferences: { revision: 0, records: [] }, sharing: { modelContext: false }, ...history } };
}
if (sandbox) params = { ...params, input: { project: randomUUID(), target: "local", ...(params["input"] as Record<string, unknown>) } };

const secrets = Object.fromEntries((["NEBIUS_API_KEY", "NEBIUS_PROJECT_ID", "TAVILY_API_KEY"] as const).flatMap((name) => {
  const value = process.env[name]?.trim();
  delete process.env[name];
  return value ? [[name, value]] : [];
}));
const home = values.home ?? join(homedir(), ".nivra-dev");
const entry = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
// Stubs of Token Factory, Nebius Sandboxes and Tavily on this machine, for checking a workflow without a real model,
// sandbox or search (the engine refuses any other address).
const stub = [
  ...(values["token-factory-url"] ? ["--token-factory-url", values["token-factory-url"]] : []),
  ...(values["sandboxes-url"] ? ["--sandboxes-url", values["sandboxes-url"]] : []),
  ...(values["tavily-url"] ? ["--tavily-url", values["tavily-url"]] : []),
];
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
  const info = await client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "rpc.ts", version: "0" }, secrets });
  // A check is bound to what its preview showed (D36): taken now, from the same engine, when the request leaves it out.
  const input = params["input"] as Record<string, unknown> | undefined;
  if (sandbox && input && input["preview"] === undefined) {
    const shown = await client.call("sandbox.preview", { repoPath: String(input["repoPath"]) });
    if (shown.status !== "ready") throw new Error(`The preview refused this checkout (${shown.code}): ${shown.message}`);
    console.error(`preview: ${shown.files} files, ${shown.bytes} bytes from ${shown.baseline}; fingerprint ${shown.fingerprint}`);
    input["preview"] = shown.fingerprint;
  }
  // A preparation is bound to what its preview showed (D41), taken the same way.
  if (environment && input && input["preview"] === undefined) {
    const spec = (params["context"] as { spec: { filters: string[] } }).spec;
    const shown = await client.call("environment.preview", { repoPath: String(input["repoPath"]), spec });
    if (shown.status !== "ready") throw new Error(`The preview refused this checkout (${shown.code}): ${shown.message}`);
    console.error(`preview: ${shown.inputs.length} inputs, ${shown.sentBytes} bytes to send from ${shown.baseline}; ${shown.packageManager}; pnpm install ${shown.installArgs.join(" ")}; fingerprint ${shown.fingerprint}`);
    input["preview"] = shown.fingerprint;
  }
  // A task run is bound to what its preview showed too (D39), taken the same way.
  if (task && input && input["preview"] === undefined) {
    const brief = (params["context"] as { brief?: TaskBrief }).brief;
    if (!brief) throw new Error("A task run needs its brief in the context, to preview what it would send.");
    const bound = input["environment"] as Record<string, string> | undefined;
    const shown = await client.call("task.preview", { repoPath: String(input["repoPath"]), brief, ...(bound ? { environment: { ...bound, preparedAt: new Date().toISOString() } as never } : {}) });
    if (shown.status !== "ready") throw new Error(`The preview refused this checkout (${shown.code}): ${shown.message}`);
    console.error(`preview: ${shown.snapshot.files} files, ${shown.snapshot.bytes} bytes from ${shown.snapshot.baseline}; programs ${shown.programs.join(", ") || "none"}; fingerprint ${shown.snapshot.fingerprint}`);
    input["preview"] = shown.snapshot.fingerprint;
  }
  // An approval of a run's proposal, filled in as the host would: from the run, its report, its proposal and this engine.
  if (method === "task.apply" || method === "task.admission") {
    const runId = String(params["runId"] ?? "");
    const summary = await client.call("runs.get", { runId });
    const [report, proposal] = [await client.call("runs.task", { runId }), await client.call("runs.proposal", { runId })];
    if (!report || !proposal) throw new Error("That run has no task report and proposal on this engine, so there is nothing to apply.");
    const input = summary.input as { repoPath: string; project: string; target: string };
    const task = { attempt: { taskId: report.task.taskId, attemptId: report.task.attemptId, runId }, engine: { homeId: info.homeId }, brief: { version: report.task.briefVersion, sha256: report.task.briefDigest } };
    params = method === "task.apply"
      ? { requestId: randomUUID(), approvedHash: proposal.hash, repoPath: input.repoPath, project: input.project, target: input.target, task, ...params }
      : { approvedHash: proposal.hash, task, ...params };
  }
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
        if ((result as { workflowId?: string }).workflowId === "chat") console.log(JSON.stringify(await client.call("runs.reply", { runId }), null, 2));
        if ((result as { workflowId?: string }).workflowId === "review") console.log(JSON.stringify(await client.call("runs.review", { runId }), null, 2));
        if ((result as { workflowId?: string }).workflowId === "sandbox") console.log(JSON.stringify(await client.call("runs.sandbox", { runId }), null, 2));
        if ((result as { workflowId?: string }).workflowId === "research") console.log(JSON.stringify(await client.call("runs.research", { runId }), null, 2));
        if ((result as { workflowId?: string }).workflowId === "environment") console.log(JSON.stringify(await client.call("runs.environment", { runId }), null, 2));
        if ((result as { workflowId?: string }).workflowId === "coach") console.log(JSON.stringify(await client.call("runs.coach", { runId }), null, 2));
        if ((result as { workflowId?: string }).workflowId === "task") {
          console.log(JSON.stringify(await client.call("runs.task", { runId }), null, 2));
          console.log(JSON.stringify(await client.call("runs.proposal", { runId }), null, 2));
        }
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
