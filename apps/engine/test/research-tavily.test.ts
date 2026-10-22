import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { RESEARCH_LIMITS } from "../src/research/limits.ts";
import { createTavily, sameAddress } from "../src/research/tavily.ts";
import { extractAnswer, searchAnswer, startTavilyStub, type TavilyScript, type TavilyStub } from "./stub-tavily.ts";

/**
 * The Tavily adapter (NIV-45) against a loopback stub: what it sends, and how every request ends. Nothing here reaches
 * the network.
 */
const KEY = "tvly-test-KEYCANARY-0123456789abcdef";
const stubs: TavilyStub[] = [];
after(async () => {
  await Promise.all(stubs.map((stub) => stub.close()));
});
async function stubbed(script: TavilyScript) {
  const stub = await startTavilyStub(script);
  stubs.push(stub);
  return { stub, tavily: createTavily({ apiKey: KEY, base: stub.url }) };
}
/** Its own limit in `ms`, and the run's cutoff a second later, unless given. */
const timing = (ms = 5_000, cutoffMs = ms + 1_000) => ({ deadlineAt: performance.now() + ms, cutoffAt: performance.now() + cutoffMs });

describe("the Tavily adapter (NIV-45)", () => {
  it("sends one search with the approved query and Nivra's fixed fields, the key only in its Authorization header", async () => {
    const { stub, tavily } = await stubbed(() => ({ body: searchAnswer([{ url: "https://docs.python.org/3/whatsnew/3.12.html", title: "What's New In Python 3.12", score: 0.91 }, { url: "https://peps.python.org/pep-0632/" }]) }));
    const found = await tavily.search({ query: "Python 3.12 distutils standard library", sites: { mode: "prefer", hosts: ["docs.python.org"] }, ...timing() });
    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.deepEqual([call!.path, call!.authorization, call!.contentType], ["/search", `Bearer ${KEY}`, "application/json"]);
    assert.deepEqual(call!.body, {
      query: "Python 3.12 distutils standard library",
      search_depth: "basic",
      topic: "general",
      max_results: RESEARCH_LIMITS.resultsPerSearch,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
      include_usage: true,
      include_domains: ["docs.python.org"],
      include_domains_mode: "prefer",
    });
    assert.equal(call!.raw.includes(KEY), false, "the key is never in a body");
    assert.ok(found.ok);
    assert.deepEqual(found.hits, [
      { address: "https://docs.python.org/3/whatsnew/3.12.html", title: "What's New In Python 3.12", score: 0.91 },
      { address: "https://peps.python.org/pep-0632/", title: "A page", score: 0.5 },
    ]);
    assert.deepEqual([found.end.status, found.end.requestId, found.end.credits], [200, "req-search-0001", 1]);
    const plain = await tavily.search({ query: "q", sites: null, ...timing() });
    assert.ok(plain.ok);
    assert.deepEqual(["include_domains" in stub.calls[1]!.body!, "include_domains_mode" in stub.calls[1]!.body!], [false, false], "no sites, no site fields");
  });

  it("extracts chosen pages with the same query, matches each back to the address sent, and names the ones that failed", async () => {
    const addresses = ["https://docs.python.org/3/whatsnew/3.12.html", "https://peps.python.org/pep-0632", "https://example.org/broken"];
    const { stub, tavily } = await stubbed(() => ({
      body: extractAnswer(
        [
          { url: "https://peps.python.org/pep-0632/", chunks: ["PEP 632 deprecates distutils."] },
          { url: "https://docs.python.org/3/whatsnew/3.12.html", chunks: ["The distutils package has been removed from the standard library.", "See PEP 632."] },
        ],
        ["https://example.org/broken"],
      ),
    }));
    const read = await tavily.extract({ query: "Python 3.12 distutils standard library", addresses, ...timing() });
    assert.deepEqual(stub.calls[0]!.body, {
      urls: addresses,
      query: "Python 3.12 distutils standard library",
      chunks_per_source: RESEARCH_LIMITS.passagesPerExtraction,
      extract_depth: "basic",
      format: "markdown",
      timeout: RESEARCH_LIMITS.extractTimeoutSeconds,
      include_images: false,
      include_favicon: false,
      include_usage: true,
    });
    assert.ok(read.ok);
    assert.deepEqual(
      read.pages.map((page) => page.address),
      addresses.slice(0, 2),
      "in the order asked, under the address sent",
    );
    assert.equal(read.pages[0]!.content, "The distutils package has been removed from the standard library. [...] See PEP 632.");
    assert.deepEqual(read.failed, ["https://example.org/broken"]);
    assert.equal(JSON.stringify(read).includes("TAVILY-DETAIL-CANARY"), false, "a failed page's reason isn't kept");
  });

  it("ends each refusal by kind, sends it once and never again, and keeps none of Tavily's words", async () => {
    const cases: Array<[number, string, Record<string, string>]> = [
      [401, "auth", {}],
      [403, "auth", {}],
      [429, "rate-limit", { "retry-after": "1" }],
      [432, "plan-limit", {}],
      [433, "plan-limit", {}],
      [400, "rejected", {}],
      [422, "rejected", {}],
      [500, "server", {}],
      [503, "server", {}],
      [302, "redirect", { location: "https://elsewhere.example.net/search" }],
    ];
    for (const [status, kind, headers] of cases) {
      const { stub, tavily } = await stubbed(() => ({ status, headers, body: { detail: { error: "TAVILY-DETAIL-CANARY" } } }));
      const ended = await tavily.search({ query: "q", sites: null, ...timing() });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual([ended.ok, ended.ok ? null : ended.failure, ended.end.status, stub.calls.length], [false, kind, status, 1], `HTTP ${status}`);
      assert.equal(JSON.stringify(ended).includes("TAVILY-DETAIL-CANARY"), false);
    }
  });

  it("refuses an answer that isn't the documented shape, or is larger than its limit, by its declared length or as it comes", async () => {
    const cases: Array<[string, TavilyScript, "search" | "extract", string]> = [
      ["not JSON", () => ({ raw: "<html>not json</html>" }), "search", "malformed"],
      ["no results", () => ({ body: { answer: "a summary instead" } }), "search", "malformed"],
      ["declared too large", () => ({ declaredBytes: RESEARCH_LIMITS.searchBodyBytes + 1 }), "search", "too-large"],
      ["streamed too large", () => ({ streamBytes: RESEARCH_LIMITS.extractBodyBytes + 65_536 }), "extract", "too-large"],
    ];
    for (const [what, script, kind, failure] of cases) {
      const { tavily } = await stubbed(script);
      const ended = kind === "search" ? await tavily.search({ query: "q", sites: null, ...timing() }) : await tavily.extract({ query: "q", addresses: ["https://a.example.org/"], ...timing() });
      assert.deepEqual([ended.ok, ended.ok ? null : ended.failure], [false, failure], what);
    }
  });

  it("keeps a request id only when it is a plain token, and credits only when they are a number, without losing the results", async () => {
    const { tavily } = await stubbed(() => ({ body: searchAnswer([{ url: "https://a.example.org/" }], { request_id: "has spaces and <b>", usage: { credits: "1" } }) }));
    const found = await tavily.search({ query: "q", sites: null, ...timing() });
    assert.ok(found.ok);
    assert.deepEqual([found.hits.length, found.end.requestId, found.end.credits], [1, null, null]);
  });

  it("ends at its own deadline or the run's cutoff, whichever comes first, mid-body included, and says which", async () => {
    const slow: TavilyScript = () => ({ delayMs: 3_000, body: searchAnswer([]) });
    const own = await stubbed(slow);
    const byOwn = await own.tavily.search({ query: "q", sites: null, ...timing(200, 2_000) });
    assert.deepEqual([byOwn.ok, byOwn.ok ? null : byOwn.failure], [false, "deadline"]);
    const cut = await stubbed(slow);
    const byCutoff = await cut.tavily.search({ query: "q", sites: null, ...timing(2_000, 200) });
    assert.deepEqual([byCutoff.ok, byCutoff.ok ? null : byCutoff.failure], [false, "cutoff"]);
    const stalled = await stubbed(() => ({ body: searchAnswer([{ url: "https://a.example.org/" }]), stallAfterBytes: 40 }));
    const started = performance.now();
    const midBody = await stalled.tavily.search({ query: "q", sites: null, ...timing(300, 2_000) });
    assert.deepEqual([midBody.ok, midBody.ok ? null : midBody.failure, midBody.end.status], [false, "deadline", 200]);
    assert.ok(performance.now() - started < 2_000, "the body's read ends at the deadline");
  });

  it("sends nothing when the run is stopped or out of time already, and ends as cancelled when stopped while waiting", async () => {
    const { stub, tavily } = await stubbed(() => ({ delayMs: 3_000, body: searchAnswer([]) }));
    const stopped = new AbortController();
    stopped.abort();
    const before = await tavily.search({ query: "q", sites: null, ...timing(), signal: stopped.signal });
    const late = await tavily.search({ query: "q", sites: null, deadlineAt: performance.now() - 1, cutoffAt: performance.now() + 1_000 });
    assert.deepEqual(
      [before.ok ? null : before.failure, late.ok ? null : late.failure, stub.calls.length],
      ["not-sent", "not-sent", 0],
    );
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 150);
    const waiting = await tavily.search({ query: "q", sites: null, ...timing(), signal: cancel.signal });
    assert.deepEqual([waiting.ok ? null : waiting.failure, stub.calls.length], ["cancelled", 1]);
  });

  it("names a network failure as such, when nothing answers", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const tavily = createTavily({ apiKey: KEY, base: `http://127.0.0.1:${port}` });
    const ended = await tavily.search({ query: "q", sites: null, ...timing() });
    assert.deepEqual([ended.ok, ended.ok ? null : ended.failure], [false, "network"]);
    assert.equal(JSON.stringify(ended).includes(KEY), false);
  });

  it("matches an address Tavily gave back with its host's case or last slash changed", () => {
    assert.equal(sameAddress("https://Docs.Python.org/3/", "https://docs.python.org/3"), true);
    assert.equal(sameAddress("https://docs.python.org/3/?a=1", "https://docs.python.org/3?a=1"), true);
    assert.equal(sameAddress("https://docs.python.org/3/", "https://docs.python.org/2/"), false);
    assert.equal(sameAddress("http://docs.python.org/3/", "https://docs.python.org/3/"), false);
  });
});
