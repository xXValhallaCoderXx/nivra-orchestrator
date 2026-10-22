import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { combinedMask, maskKnownValues } from "@nivra/domain";
// Until research's integration window exports it, the domain's contract is read straight from its file (NIV-45).
import { ResearchReport } from "../../../packages/domain/src/research.ts";
import { createModelClient } from "../src/providers/model.ts";
import { policyFor } from "../src/providers/policy.ts";
import { createTavily } from "../src/research/tavily.ts";
import { asInterrupted, RESEARCH_TOOL, runResearch, type ResearchReportShape, type ResearchRunOptions } from "../src/research/run.ts";
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyScript, type TavilyStub } from "./stub-tavily.ts";

/**
 * A research run in process (NIV-45), against a loopback Tavily and Mastra's mock model: no network, no real model.
 * The plan is the demonstration's: an upgrade to Python 3.12 that assumes distutils is still there.
 */
const TAVILY_KEY = "tvly-test-KEYCANARY-0123456789abcdef";
const MODEL_KEY = "nebius-model-key-CANARY-0123456789";
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
const mask = combinedMask((text) =>
  maskKnownValues(text, [
    ["TAVILY_API_KEY", TAVILY_KEY],
    ["NEBIUS_API_KEY", MODEL_KEY],
  ]),
);
const WHATSNEW = "https://docs.python.org/3/whatsnew/3.12.html";
const PEP632 = "https://peps.python.org/pep-0632/";
const PEP701 = "https://peps.python.org/pep-0701/";
const Q1 = "Python 3.12 distutils standard library";
const Q2 = "Python 3.12 f-string quote reuse";
const PACKET: ResearchRunOptions["packet"] = {
  planText: "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils. PLAN-TEXT-CANARY",
  assumptions: [
    { id: "A1", text: "distutils is still in Python 3.12's standard library.", query: Q1 },
    { id: "A2", text: "Python 3.12 f-strings can reuse the enclosing quotes.", query: Q2 },
  ],
  sites: { mode: "prefer", hosts: ["docs.python.org", "peps.python.org"] },
};
const REMOVED = "The distutils package has been removed from the standard library.";

/** Tavily, as the demonstration's searches would find it. */
const python: TavilyScript = (call) => {
  const query = call.body?.["query"];
  if (call.path === "/search") {
    return query === Q1
      ? { body: searchAnswer([{ url: `${WHATSNEW}#distutils`, title: "What's New In Python 3.12", score: 0.93 }, { url: PEP632, title: "PEP 632 – Deprecate distutils module" }]) }
      : { body: searchAnswer([{ url: WHATSNEW, title: "What's New In Python 3.12", score: 0.88 }, { url: PEP701, title: "PEP 701 – Syntactic formalization of f-strings" }]) };
  }
  if (call.path === "/extract") {
    return query === Q1
      ? { body: extractAnswer([{ url: WHATSNEW, chunks: [`## Removed\n${REMOVED}`, "Setuptools continues to provide distutils, if you still require it."] }, { url: PEP632, chunks: ["This PEP proposes deprecating distutils in Python 3.10 and removing it in Python 3.12."] }]) }
      : { body: extractAnswer([{ url: WHATSNEW, chunks: [`PEP 701 lifts some restrictions on f-strings. ${MODEL_KEY} appears here by accident.`] }, { url: PEP701, chunks: ["Quote reuse is allowed in Python 3.12 f-strings."] }]) };
  }
  return { status: 404, body: {} };
};

type Generated = { content: unknown[]; finishReason: string; usage: Record<string, number>; warnings: unknown[] };
const handIn = (input: unknown): Generated => ({
  content: [{ type: "tool-call", toolCallId: "call-research", toolName: RESEARCH_TOOL, input: JSON.stringify(input) }],
  finishReason: "tool-calls",
  usage: { inputTokens: 6_000, outputTokens: 700, totalTokens: 6_700 },
  warnings: [],
});
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
      citations: [{ passage: "S3.1", stance: "supports", quote: "Quote reuse is allowed in Python 3.12 f-strings" }],
      applicability: { plan: "Python 3.12", source: "Python 3.12", where: "passage" },
      uncertainty: "",
      amendment: "",
    },
  ],
};

const stubs: TavilyStub[] = [];
after(async () => {
  await Promise.all(stubs.map((stub) => stub.close()));
});
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason ?? new Error("aborted"))), { once: true });
  });

async function research(script: TavilyScript, doGenerate: (options: unknown) => Promise<Generated> = async () => handIn(ANSWER), overrides: Partial<ResearchRunOptions> = {}) {
  const stub = await startTavilyStub(script);
  stubs.push(stub);
  const model = new MastraLanguageModelV2Mock({ doGenerate: doGenerate as never });
  const saved: ResearchReportShape[] = [];
  const report = await runResearch({
    binding: { planId: randomUUID(), planVersion: 4, packetDigest: "a".repeat(64), scope: { kind: "general" }, request: { runId: randomUUID(), clientRequestId: randomUUID() } },
    packet: PACKET,
    retrieval: createTavily({ apiKey: TAVILY_KEY, base: stub.url }),
    client: createModelClient({ apiKey: MODEL_KEY, model: () => model }),
    model: MODEL,
    route: { provider: "nebius", endpoint: "loopback-test", model: MODEL },
    policy: policyFor(MODEL),
    mask,
    knownValues: [TAVILY_KEY, MODEL_KEY],
    save: (snapshot) => void saved.push(structuredClone(snapshot)),
    ...overrides,
  });
  return { report, saved, stub, model };
}

const states = (report: ResearchReportShape) => Object.fromEntries(report.requests.map((request) => [request.id, request.failure ? `${request.state}:${request.failure}` : request.state]));

describe("a research run, in process (NIV-45)", () => {
  it("finds the contradiction and the supported assumption, reading one shared page under both queries", async () => {
    const { report, stub, model } = await research(python);
    assert.deepEqual([report.outcome, report.stop], ["complete", null]);
    assert.deepEqual(states(report), { "search-A1": "answered", "search-A2": "answered", "extract-A1": "answered", "extract-A2": "answered", model: "answered" });
    assert.deepEqual([stub.calls.length, model.doGenerateCalls.length], [4, 1]);
    assert.deepEqual(
      report.pages.map((page) => [page.id, page.status, page.foundBy.map((found) => found.assumption).join(" "), page.extractedFor.join(" ")]),
      [
        ["S1", "read", "A1 A2", "A1 A2"],
        ["S2", "read", "A1", "A1"],
        ["S3", "read", "A2", "A2"],
      ],
    );
    assert.deepEqual(
      report.passages.map((passage) => [passage.id, passage.assumption]),
      [
        ["S1.1", "A1"],
        ["S1.2", "A1"],
        ["S2.1", "A1"],
        ["S1.3", "A2"],
        ["S3.1", "A2"],
      ],
    );
    assert.deepEqual(
      report.assessments.map((assessment) => [assessment.assumption, assessment.model, assessment.shown, assessment.rule, assessment.amendment?.kind ?? null]),
      [
        ["A1", "contradicted", "contradicted", null, "model"],
        ["A2", "supported", "supported", null, null],
      ],
    );
    assert.deepEqual([report.checks, report.usage.credits, report.usage.model.calls], [{ citations: 2, valid: 2, relabelled: 0 }, 4, 1]);
    const parsed = ResearchReport.safeParse(report);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)).slice(0, 500));
  });

  it("sends Tavily only the approved queries and Search's own addresses: never the plan's text or a key; and the model never sees a key", async () => {
    const { stub, model } = await research(python);
    for (const call of stub.calls) {
      assert.deepEqual([call.raw.includes("PLAN-TEXT-CANARY"), call.raw.includes(TAVILY_KEY), call.raw.includes(MODEL_KEY)], [false, false, false], call.path);
      assert.equal(call.authorization, `Bearer ${TAVILY_KEY}`);
    }
    // The searches, then the extracts, go together, so they may arrive in either order.
    assert.deepEqual(
      stub.calls
        .filter((call) => call.path === "/search")
        .map((call) => call.body?.["query"])
        .sort(),
      [Q1, Q2].sort(),
    );
    const extracts = stub.calls
      .filter((call) => call.path === "/extract")
      .map((call) => [call.body?.["query"], call.body?.["urls"]] as [string, string[]])
      .sort(([a], [b]) => a.localeCompare(b));
    assert.deepEqual(
      extracts,
      [
        [Q1, [WHATSNEW, PEP632]],
        [Q2, [WHATSNEW, PEP701]],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    const prompt = JSON.stringify((model.doGenerateCalls[0] as { prompt?: unknown }).prompt);
    assert.deepEqual([prompt.includes(MODEL_KEY), prompt.includes("[secret:NEBIUS_API_KEY]"), prompt.includes("PLAN-TEXT-CANARY")], [false, true, true], "the plan goes to the model, masked page text too");
  });

  it("saves the report before each request is sent and again when it ends, so a crash between reads as maybe sent", async () => {
    const { saved } = await research(python);
    for (const id of ["search-A1", "search-A2", "extract-A1", "extract-A2", "model"]) {
      const sending = saved.findIndex((snapshot) => snapshot.requests.find((request) => request.id === id)!.state === "sending");
      const ended = saved.findIndex((snapshot) => snapshot.requests.find((request) => request.id === id)!.state === "answered");
      assert.ok(sending >= 0 && sending < ended, id);
    }
    const midSearch = saved.find((snapshot) => snapshot.requests.find((request) => request.id === "search-A1")!.state === "sending")!;
    const read = asInterrupted(midSearch);
    assert.deepEqual([read.outcome, read.requests.find((request) => request.id === "search-A1")!.failure, read.usage.credits], ["interrupted", "no-answer", null]);
    assert.equal(asInterrupted(saved.at(-1)!).outcome, "complete", "an ended report is left as it was");
  });

  it("carries on with the other assumption when one search is refused, sending it once, and shows the first as not assessed", async () => {
    const script: TavilyScript = (call, index) => (call.path === "/search" && call.body?.["query"] === Q1 ? { status: 429, headers: { "retry-after": "1" }, body: { detail: "slow down" } } : python(call, index));
    // With A1's search gone, A2's pages are S1 and S2: the PEP's passage is S2.1.
    const onlyA2 = { ...ANSWER.assessments[1]!, citations: [{ passage: "S2.1", stance: "supports", quote: "Quote reuse is allowed in Python 3.12 f-strings" }] };
    const { report, stub } = await research(script, async () => handIn({ assessments: [onlyA2] }));
    assert.deepEqual(states(report), { "search-A1": "failed:rate-limit", "search-A2": "answered", "extract-A1": "skipped", "extract-A2": "answered", model: "answered" });
    assert.equal(stub.calls.filter((call) => call.path === "/search").length, 2, "never retried");
    assert.deepEqual(
      report.assessments.map((assessment) => [assessment.assumption, assessment.shown, assessment.rule]),
      [
        ["A1", "unresolved", "not-assessed"],
        ["A2", "supported", null],
      ],
    );
    assert.equal(report.outcome, "complete");
  });

  it("fails as nothing read, with no model request, when no page could be read: every search failing, or every page", async () => {
    const searchesDown: TavilyScript = () => ({ status: 500, body: {} });
    const down = await research(searchesDown);
    assert.deepEqual([down.report.outcome, down.report.stop?.code, down.model.doGenerateCalls.length, down.stub.calls.length], ["failed", "nothing-read", 0, 2]);
    const pagesFail: TavilyScript = (call, index) => (call.path === "/extract" ? { body: extractAnswer([], (call.body?.["urls"] as string[]) ?? []) } : python(call, index));
    const failing = await research(pagesFail);
    assert.deepEqual([failing.report.outcome, failing.report.stop?.code, failing.model.doGenerateCalls.length], ["failed", "nothing-read", 0]);
    assert.deepEqual(failing.report.pages.map((page) => page.status), ["failed", "failed", "failed"]);
  });

  it("keeps the pages and passages, failing the run, when the model's answer can't be used", async () => {
    const text = await research(python, async () => ({ content: [{ type: "text", text: "All good." }], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }, warnings: [] }));
    assert.deepEqual([text.report.outcome, text.report.stop?.code, text.report.passages.length > 0], ["failed", "model-failed", true]);
    assert.match(text.report.stop!.message, /answered in plain text/);
    const empty = await research(python, async () => handIn({ assessments: [] }));
    assert.match(empty.report.stop!.message, /handed in no assessment/);
  });

  it("ends as cancelled when stopped during Search or Extract, sending nothing after the stop and no model request", async () => {
    const slowSearch: TavilyScript = (call, index) => (call.path === "/search" ? { delayMs: 5_000, ...python(call, index) } : python(call, index));
    const stopped = new AbortController();
    setTimeout(() => stopped.abort(), 150);
    const duringSearch = await research(slowSearch, undefined, { signal: stopped.signal });
    assert.deepEqual([duringSearch.report.outcome, duringSearch.report.stop?.code, duringSearch.stub.calls.filter((call) => call.path === "/extract").length, duringSearch.model.doGenerateCalls.length], ["cancelled", "cancelled", 0, 0]);
    assert.deepEqual(states(duringSearch.report)["search-A1"], "failed:cancelled");
    const slowExtract: TavilyScript = (call, index) => (call.path === "/extract" ? { delayMs: 5_000, ...python(call, index) } : python(call, index));
    const later = new AbortController();
    setTimeout(() => later.abort(), 300);
    const duringExtract = await research(slowExtract, undefined, { signal: later.signal });
    assert.deepEqual([duringExtract.report.outcome, duringExtract.model.doGenerateCalls.length, states(duringExtract.report)["extract-A1"]], ["cancelled", 0, "failed:cancelled"]);
  });

  it("stops retrieval at its cutoff, and gives the model only the smaller of its own limit and the time left", async () => {
    const slowSearch: TavilyScript = (call, index) => (call.path === "/search" ? { delayMs: 5_000, ...python(call, index) } : python(call, index));
    const started = performance.now();
    const cut = await research(slowSearch, undefined, { timing: { runMs: 2_000, retrievalCutoffMs: 300 } });
    assert.deepEqual([states(cut.report)["search-A1"], cut.report.stop?.code], ["failed:cutoff", "nothing-read"]);
    assert.ok(performance.now() - started < 2_000);
    const slowModel = async (options: unknown) => {
      await sleep(10_000, (options as { abortSignal?: AbortSignal }).abortSignal);
      return handIn(ANSWER);
    };
    const begun = performance.now();
    const outOfTime = await research(python, slowModel, { timing: { runMs: 1_500, retrievalCutoffMs: 600 } });
    const took = performance.now() - begun;
    assert.deepEqual([outOfTime.report.outcome, outOfTime.report.stop?.code, states(outOfTime.report)["model"]], ["failed", "model-failed", "failed:model"]);
    assert.ok(took < 2_500, `the run took ${Math.round(took)} ms of its 1,500`);
  });

  it("sends nothing when the run's time was used up before research began, its preparation included", async () => {
    const { report, stub, model } = await research(python, undefined, { startedAt: performance.now() - 2_000, timing: { runMs: 1_500, retrievalCutoffMs: 600 } });
    assert.deepEqual([report.outcome, report.stop?.code, stub.calls.length, model.doGenerateCalls.length], ["failed", "deadline", 0, 0]);
  });

  it("keeps credits unknown when a request didn't report them, never 0", async () => {
    const noUsage: TavilyScript = (call, index) => {
      const reply = python(call, index) as { body?: Record<string, unknown> };
      return call.path === "/search" ? { body: { ...reply.body, usage: undefined } } : reply;
    };
    const { report } = await research(noUsage);
    assert.deepEqual([report.outcome, report.usage.credits], ["complete", null]);
  });

  it("refuses a page whose address holds a credential, never sending it back to Tavily", async () => {
    const leaky = `https://docs.example.org/page?token=ghp_${"a".repeat(36)}`;
    const script: TavilyScript = (call, index) => (call.path === "/search" && call.body?.["query"] === Q1 ? { body: searchAnswer([{ url: leaky }, { url: PEP632 }]) } : python(call, index));
    const { report, stub } = await research(script);
    assert.equal(report.pages.find((page) => page.address === leaky)?.status, "refused");
    assert.equal(stub.calls.some((call) => call.path === "/extract" && call.raw.includes("ghp_")), false);
  });
});
