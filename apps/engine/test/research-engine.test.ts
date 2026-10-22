import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isTerminal, RESEARCH_TOOL, researchPacketDigest, RpcCallError, type InitializeParams, type ResearchPacket, type ResearchReport, type ResearchStop, type RunEventsPage } from "@nivra/domain";
import { RESEARCH_STOP_MESSAGES } from "../src/research/run.ts";
import { removeDir, startEngine, tempDir, waitFor, type EngineProcess } from "./helpers.ts";
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyScript, type TavilyStub } from "./stub-tavily.ts";
import { startStub, toolCall, type Reply, type Stub } from "./stub-token-factory.ts";

/**
 * Research of a saved plan version over stdio (NIV-45, D37): a real engine against loopback stand-ins for Tavily and
 * Token Factory. What a run is bound to and what goes where, the refusals that send nothing, a cancel, a restart that
 * reads as interrupted and sends nothing again, a reused request id, and what is kept where. Nothing here reaches the
 * network, and no real model is called.
 */
const MODEL_KEY = "nebius-research-engine-key-0123456789";
const TAVILY_KEY = `tvly-dev-research-engine-${"k".repeat(16)}`;
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const PLAN_CANARY = `nivra-plan-canary-${randomUUID()}`;
const WHATSNEW = "https://docs.python.org/3/whatsnew/3.12.html";
const PEP701 = "https://peps.python.org/pep-0701/";
const Q1 = "Python 3.12 distutils standard library";
const Q2 = "Python 3.12 f-string quote reuse";
const PACKET: ResearchPacket = {
  scope: { kind: "general" },
  planText: `Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils. ${PLAN_CANARY}`,
  assumptions: [
    { id: "A1", text: "distutils is still in Python 3.12's standard library.", origin: { kind: "plan", index: 0 }, query: Q1 },
    { id: "A2", text: "Python 3.12 f-strings can reuse the enclosing quotes.", origin: { kind: "typed" }, query: Q2 },
  ],
  sites: { mode: "prefer", hosts: ["docs.python.org", "peps.python.org"] },
};
const ANSWER = {
  assessments: [
    {
      assumption: "A1",
      outcome: "contradicted",
      reasoning: "The release notes for 3.12 say distutils was removed.",
      citations: [{ passage: "S1.1", stance: "contradicts", quote: "has been removed from the standard library" }],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
      uncertainty: "Setuptools still provides it as a third-party package.",
      amendment: "Install setuptools in the 3.12 image, or replace the distutils imports, before switching.",
    },
    {
      assumption: "A2",
      outcome: "supported",
      reasoning: "PEP 701 allows reusing the enclosing quotes.",
      citations: [{ passage: "S2.1", stance: "supports", quote: "Quote reuse is allowed in Python 3.12 f-strings" }],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "passage" },
      uncertainty: "",
      amendment: "",
    },
  ],
};

/** Tavily, as the demonstration's searches would find it; a case can hold its searches or extracts open. */
const python =
  (hold: { searchMs?: number; extractMs?: number } = {}): TavilyScript =>
  (call) => {
    const first = call.body?.["query"] === Q1;
    if (call.path === "/search") {
      const body = first ? searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12" }]) : searchAnswer([{ url: PEP701, title: "PEP 701 – Syntactic formalization of f-strings" }]);
      return { body, ...(hold.searchMs ? { delayMs: hold.searchMs } : {}) };
    }
    if (call.path === "/extract") {
      const body = first
        ? extractAnswer([{ url: WHATSNEW, chunks: ["## Removed\nThe distutils package has been removed from the standard library."] }])
        : extractAnswer([{ url: PEP701, chunks: ["Quote reuse is allowed in Python 3.12 f-strings."] }]);
      return { body, ...(hold.extractMs ? { delayMs: hold.extractMs } : {}) };
    }
    return { status: 404, body: {} };
  };

const engines: EngineProcess[] = [];
const tavilies: TavilyStub[] = [];
const models: Stub[] = [];
const dirs: string[] = [];
after(async () => {
  for (const engine of engines) engine.kill();
  await Promise.all([...tavilies, ...models].map((stub) => stub.close()));
  for (const dir of dirs) removeDir(dir);
});

interface Stubs {
  tavily: TavilyStub;
  model: Stub;
}

async function stubsFor(options: { tavily?: TavilyScript; answer?: Reply } = {}): Promise<Stubs> {
  const tavily = await startTavilyStub(options.tavily ?? python());
  const model = await startStub({ models: [{ id: MODEL, context_length: 131_072 }], chat: () => options.answer ?? toolCall(RESEARCH_TOOL, ANSWER, { tokens: [6_000, 700] }) });
  tavilies.push(tavily);
  models.push(model);
  return { tavily, model };
}

async function engineOn(stubs: Stubs, options: { home?: string; secrets?: InitializeParams["secrets"] } = {}) {
  const root = tempDir("nivra research engine");
  dirs.push(root);
  const home = options.home ?? join(root, "home");
  const engine = startEngine(home, { args: ["--stdio", "--home", home, "--instance", randomUUID(), "--heartbeat-ms", "0", "--token-factory-url", stubs.model.url, "--tavily-url", stubs.tavily.url] });
  engines.push(engine);
  await engine.initialize(options.secrets ?? { NEBIUS_API_KEY: MODEL_KEY, TAVILY_API_KEY: TAVILY_KEY });
  return { engine, home };
}

async function setup(options: { tavily?: TavilyScript; answer?: Reply } = {}) {
  const stubs = await stubsFor(options);
  return { ...stubs, ...(await engineOn(stubs)) };
}

interface Start {
  packet?: ResearchPacket;
  sharing?: { modelContext: boolean; webResearch: boolean };
  deny?: { terms: string[]; paths: string[] };
  planId?: string;
  planVersion?: number;
  packetDigest?: string;
  clientRequestId?: string;
}
async function startResearch(engine: EngineProcess, options: Start = {}) {
  const packet = options.packet ?? PACKET;
  const input = { planId: options.planId ?? randomUUID(), planVersion: options.planVersion ?? 2, packetDigest: options.packetDigest ?? (await researchPacketDigest(packet)) };
  const clientRequestId = options.clientRequestId ?? randomUUID();
  const sharing = options.sharing ?? { modelContext: packet.scope.kind === "project", webResearch: true };
  const run = await engine.client.call("runs.start", { clientRequestId, workflowId: "research", input, context: { sharing, deny: options.deny ?? { terms: [], paths: [] }, packet } });
  return { run, input, clientRequestId };
}
const finished = (engine: EngineProcess, runId: string) => engine.waitForRun(runId, (page) => isTerminal(page.status), 30_000);
const failedEvent = (page: RunEventsPage) => page.events.find((event) => event.type === "run.failed");
const reportOf = async (engine: EngineProcess, runId: string) => (await engine.client.call("runs.research", { runId })) as ResearchReport | null;
const states = (report: ResearchReport | null) => Object.fromEntries((report?.requests ?? []).map((request) => [request.id, request.failure ? `${request.state}:${request.failure}` : request.state]));
const paths = (stub: TavilyStub, path: string) => stub.calls.filter((call) => call.path === path);

describe("research of a saved plan version over stdio (NIV-45, D37)", () => {
  it("is bound to its plan version and request: the queries and Search's own addresses go to Tavily, the plan to the model", async () => {
    const { engine, tavily, model } = await setup();
    const { run, input, clientRequestId } = await startResearch(engine);
    assert.equal(run.title, "Research · plan v2");
    const page = await finished(engine, run.id);
    const report = await reportOf(engine, run.id);
    assert.deepEqual([page.status, report?.outcome, report?.stop], ["succeeded", "complete", null], failedEvent(page)?.message);
    assert.deepEqual([report?.planId, report?.planVersion, report?.packetDigest, report?.request], [input.planId, 2, input.packetDigest, { runId: run.id, clientRequestId }]);
    assert.deepEqual(
      report?.assessments.map((assessment) => [assessment.assumption, assessment.model, assessment.shown, assessment.rule]),
      [
        ["A1", "contradicted", "contradicted", null],
        ["A2", "supported", "supported", null],
      ],
    );
    assert.deepEqual([report?.checks, report?.usage.credits, report?.usage.model.inputTokens], [{ citations: 2, valid: 2, relabelled: 0 }, 4, 6_000]);
    // Tavily gets the approved queries, then only the addresses its own searches returned, with its own key.
    assert.deepEqual([paths(tavily, "/search").map((call) => call.body?.["query"]).sort(), paths(tavily, "/extract").flatMap((call) => call.body?.["urls"] as string[]).sort()], [[Q1, Q2], [WHATSNEW, PEP701]]);
    assert.deepEqual([...new Set(tavily.calls.map((call) => call.authorization))], [`Bearer ${TAVILY_KEY}`]);
    assert.equal(tavily.calls.some((call) => call.raw.includes(PLAN_CANARY) || call.raw.includes(MODEL_KEY)), false, "Tavily never gets the plan or the model's key");
    // The model gets one request, with the plan, and never Tavily's key.
    assert.deepEqual([model.chats().length, model.chats()[0]?.raw.includes(PLAN_CANARY), model.requests.some((request) => request.raw.includes(TAVILY_KEY))], [1, true, false]);
  });

  it("refuses before any request: research off, a project's plan without sharing, either key missing, a changed packet, and a query the engine's own check refuses", async () => {
    const { engine, tavily, model } = await setup();
    const refusedWith = async (name: string, started: Promise<{ run: { id: string } }>, code: ResearchStop) => {
      const { run } = await started;
      const page = await finished(engine, run.id);
      assert.deepEqual([page.status, failedEvent(page)?.message, await reportOf(engine, run.id)], ["failed", RESEARCH_STOP_MESSAGES[code], null], name);
    };
    await refusedWith("research off", startResearch(engine, { sharing: { modelContext: false, webResearch: false } }), "web-research-off");
    const project: ResearchPacket = { ...PACKET, scope: { kind: "project", headAtStart: "29c3a40a1b2c3d4e" } };
    await refusedWith("a project's plan without sharing", startResearch(engine, { packet: project, sharing: { modelContext: false, webResearch: true } }), "model-sharing-off");
    await refusedWith("a changed packet", startResearch(engine, { packetDigest: await researchPacketDigest({ ...PACKET, planText: "Another plan." }) }), "packet-changed");
    // The host checks the queries first; the engine checks them again, against the same deny list and its own keys.
    const naming: ResearchPacket = { ...PACKET, assumptions: [{ ...PACKET.assumptions[0]!, query: "nivra-orchestrator distutils" }] };
    await refusedWith("a query that names a project", startResearch(engine, { packet: naming, deny: { terms: ["nivra-orchestrator"], paths: [] } }), "unsafe-query");
    const keyed: ResearchPacket = { ...PACKET, assumptions: [{ ...PACKET.assumptions[0]!, query: `distutils ${MODEL_KEY}` }] };
    await refusedWith("a query that holds a saved key", startResearch(engine, { packet: keyed }), "unsafe-query");
    await engine.client.call("secrets.update", { remove: ["TAVILY_API_KEY"] });
    await refusedWith("no Tavily key", startResearch(engine), "tavily-key-missing");
    await engine.client.call("secrets.update", { set: { TAVILY_API_KEY: TAVILY_KEY }, remove: ["NEBIUS_API_KEY"] });
    await refusedWith("no model key", startResearch(engine), "model-key-missing");
    assert.deepEqual([tavily.calls.length, model.requests.length], [0, 0], "nothing was sent, not even the model listing");
  });

  it("stops at a cancel during Search: nothing more is sent, and the report says the searches were cancelled", async () => {
    const { engine, tavily, model } = await setup({ tavily: python({ searchMs: 30_000 }) });
    const { run } = await startResearch(engine);
    await waitFor(() => (paths(tavily, "/search").length === 2 ? true : null), { what: "both searches", timeoutMs: 10_000 });
    await engine.client.call("runs.cancel", { runId: run.id });
    const page = await finished(engine, run.id);
    const report = await reportOf(engine, run.id);
    assert.deepEqual([page.status, report?.outcome, report?.stop?.code], ["cancelled", "cancelled", "cancelled"]);
    assert.deepEqual([states(report)["search-A1"], states(report)["search-A2"]], ["failed:cancelled", "failed:cancelled"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual([paths(tavily, "/extract").length, model.chats().length], [0, 0], "no Extract and no model request");
  });

  it("reads as interrupted after its engine is killed mid-Extract, keeps what was read, and sends nothing again", async () => {
    const stubs = await stubsFor({ tavily: python({ extractMs: 60_000 }) });
    const first = await engineOn(stubs);
    const { run } = await startResearch(first.engine);
    // Each request is saved as being sent before it goes, so both are recorded once the stand-in has them.
    await waitFor(() => (paths(stubs.tavily, "/extract").length === 2 ? true : null), { what: "both extracts", timeoutMs: 10_000 });
    first.engine.kill();
    await first.engine.exited;
    const sent = stubs.tavily.calls.length;
    const second = await engineOn(stubs, { home: first.home });
    const page = await finished(second.engine, run.id);
    const report = await reportOf(second.engine, run.id);
    assert.deepEqual([page.status, page.events.some((event) => event.type === "run.interrupted")], ["failed", true]);
    assert.deepEqual(
      [report?.outcome, states(report)["search-A1"], states(report)["extract-A1"], states(report)["extract-A2"], states(report)["model"], report?.usage.credits],
      ["interrupted", "answered", "failed:interrupted", "failed:interrupted", "skipped", null],
    );
    assert.equal(report?.pages.length, 2, "what Search found is kept");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual([stubs.tavily.calls.length, stubs.model.chats().length], [sent, 0], "nothing was sent again");
  });

  it("answers a repeated request with its run, and refuses its id reused for another plan version", async () => {
    const { engine, tavily } = await setup();
    const first = await startResearch(engine);
    const again = await startResearch(engine, { clientRequestId: first.clientRequestId, planId: first.input.planId });
    assert.equal(again.run.id, first.run.id);
    const reused = await startResearch(engine, { clientRequestId: first.clientRequestId, planId: first.input.planId, planVersion: 3 }).catch((error: unknown) => error);
    assert.ok(reused instanceof RpcCallError, String(reused));
    assert.match(reused.message, /^This request id already started another run, with other input\./);
    assert.equal((await finished(engine, first.run.id)).status, "succeeded");
    assert.equal(paths(tavily, "/search").length, 2, "one run's searches, sent once");
  });

  it("keeps the plan's text out of its events, logs, run store and Mastra's records, and masks both keys in what it keeps", async () => {
    const echoed = { assessments: [{ ...ANSWER.assessments[0]!, reasoning: `It echoes ${TAVILY_KEY} and ${MODEL_KEY}.` }, ANSWER.assessments[1]!] };
    const { engine, home } = await setup({ answer: toolCall(RESEARCH_TOOL, echoed) });
    const { run, input } = await startResearch(engine);
    assert.equal((await finished(engine, run.id)).status, "succeeded");
    const kept = JSON.stringify(await reportOf(engine, run.id));
    assert.deepEqual([kept.includes(TAVILY_KEY), kept.includes(MODEL_KEY), kept.includes("[secret:TAVILY_API_KEY]"), kept.includes("[secret:NEBIUS_API_KEY]")], [false, false, true, true]);
    const events = JSON.stringify((await engine.client.call("runs.events", { runId: run.id, after: 0, limit: 500 })).events);
    await engine.client.call("shutdown", {});
    await engine.exited;
    const named = (text: string | Buffer) => [PLAN_CANARY, TAVILY_KEY, MODEL_KEY].filter((secret) => text.includes(secret)).map((secret) => (secret === PLAN_CANARY ? "the plan" : "a key"));
    assert.deepEqual([named(events), named(engine.stderr())], [[], []], "events and logs");
    for (const file of readdirSync(home).filter((name) => name.startsWith("nivra.db") || name.startsWith("mastra.db"))) {
      assert.deepEqual(named(readFileSync(join(home, file))), [], file);
    }
    // Mastra gets nothing of what a run is bound to: the plan's id stays in the run store.
    const mastra = readdirSync(home).filter((name) => name.startsWith("mastra.db"));
    assert.ok(mastra.length > 0);
    assert.equal(
      mastra.some((file) => readFileSync(join(home, file)).includes(input.planId)),
      false,
    );
  });
});
