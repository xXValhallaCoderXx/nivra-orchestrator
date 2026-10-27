import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  QUERY_PROBLEM_WORDS,
  queryProblems,
  RESEARCH_LIMITS,
  ResearchContext,
  ResearchPacket,
  researchPacketDigest,
  ResearchReport,
  siteProblem,
  type ResearchDeny,
  type ResearchPacket as Packet,
  type ResearchReport as Report,
} from "../src/research.ts";
import { InitializeParams, Methods, SecretName, SecretsUpdateParams, StartRunParams } from "../src/methods.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { WorkflowId } from "../src/runs.ts";

/** The research contract (NIV-45): what a run is bound to, what a query may not carry, and how big a report can get. */
const PACKET: Packet = {
  scope: { kind: "general" },
  planText: "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils.",
  assumptions: [
    { id: "A1", text: "distutils is still in Python 3.12's standard library.", origin: { kind: "typed" }, query: "Python 3.12 distutils standard library" },
    { id: "A2", text: "Python 3.12 f-strings can reuse the enclosing quotes.", origin: { kind: "typed" }, query: "Python 3.12 f-string quote reuse PEP 701" },
  ],
  sites: { mode: "prefer", hosts: ["docs.python.org", "peps.python.org"] },
};
const NO_DENY: ResearchDeny = { terms: [], paths: [] };

describe("a research packet (NIV-45)", () => {
  it("takes one to three numbered assumptions, each with its query, and optional public sites", () => {
    assert.equal(ResearchPacket.safeParse(PACKET).success, true);
    const project = { ...PACKET, scope: { kind: "project", headAtStart: "29c3a40a" }, assumptions: [{ ...PACKET.assumptions[0]!, origin: { kind: "plan", index: 0 } }], sites: null };
    assert.equal(ResearchPacket.safeParse(project).success, true);
  });

  it("refuses blank or oversized parts, a fourth assumption, numbering out of order, one plan assumption twice, a site that isn't public, and anything extra", () => {
    const one = PACKET.assumptions[0]!;
    const refused: unknown[] = [
      { ...PACKET, planText: " \n " },
      { ...PACKET, planText: "x".repeat(RESEARCH_LIMITS.planChars + 1) },
      { ...PACKET, assumptions: [] },
      { ...PACKET, assumptions: [one, { ...one, id: "A2" }, { ...one, id: "A3" }, { ...one, id: "A3" }] },
      { ...PACKET, assumptions: [{ ...one, id: "A2" }] },
      { ...PACKET, assumptions: [{ ...one, query: "  " }] },
      { ...PACKET, assumptions: [{ ...one, query: "q".repeat(RESEARCH_LIMITS.queryChars + 1) }] },
      { ...PACKET, assumptions: [{ ...one, text: "t".repeat(RESEARCH_LIMITS.assumptionChars + 1) }] },
      { ...PACKET, assumptions: [{ ...one, origin: { kind: "plan", index: 2 } }, { ...one, id: "A2", origin: { kind: "plan", index: 2 } }] },
      { ...PACKET, sites: { mode: "prefer", hosts: ["wiki.internal"] } },
      { ...PACKET, sites: { mode: "prefer", hosts: ["https://docs.python.org"] } },
      { ...PACKET, sites: { mode: "everywhere", hosts: ["docs.python.org"] } },
      { ...PACKET, sites: { mode: "prefer", hosts: [] } },
      { ...PACKET, scope: { kind: "project", headAtStart: null, repoPath: "/repo" } },
      { ...PACKET, projectId: randomUUID() },
    ];
    assert.deepEqual(
      refused.map((packet) => ResearchPacket.safeParse(packet).success),
      refused.map(() => false),
    );
  });

  it("travels in a context holding both permissions and the deny terms, and nothing else", () => {
    const context = { sharing: { modelContext: false, webResearch: true }, deny: NO_DENY, packet: PACKET };
    assert.equal(ResearchContext.safeParse(context).success, true);
    assert.equal(ResearchContext.safeParse({ ...context, preferences: { revision: 0, records: [] } }).success, false);
    assert.equal(ResearchContext.safeParse({ ...context, sharing: { modelContext: true } }).success, false);
  });
});

describe("a research run's request (NIV-45, D37)", () => {
  const context = { sharing: { modelContext: false, webResearch: true }, deny: NO_DENY, packet: PACKET };
  const request = async (overrides: { input?: Record<string, unknown>; context?: unknown } = {}) => ({
    clientRequestId: randomUUID(),
    workflowId: "research",
    input: { planId: randomUUID(), planVersion: 2, packetDigest: await researchPacketDigest(PACKET), ...overrides.input },
    context: overrides.context ?? context,
  });

  it("takes the plan version and the packet's fingerprint as its input, and the packet with both permissions as its context", async () => {
    const parsed = StartRunParams.parse(await request());
    assert.deepEqual([parsed.workflowId, WorkflowId.parse("research"), PROTOCOL_VERSION], ["research", "research", 13]);
    assert.equal(Methods["runs.research"].result.safeParse(null).success, true, "no report yet");
  });

  it("takes no other workflow's context, nor one without both permissions, and no input beyond what it is bound to", async () => {
    const preferences = { revision: 0, records: [] };
    const refused = [
      await request({ context: { preferences, sharing: { modelContext: true } } }),
      await request({ context: { sharing: { cloudExecution: true } } }),
      await request({ context: { preferences, sharing: { modelContext: true }, packet: { scope: { kind: "general" }, text: "A plan", assumptions: [], references: [] } } }),
      await request({ context: { ...context, sharing: { modelContext: true } } }),
      await request({ context: { ...context, preferences } }),
      await request({ input: { planText: PACKET.planText } }),
      await request({ input: { query: "Python 3.12 distutils" } }),
      await request({ input: { packetDigest: "not a fingerprint" } }),
      await request({ input: { planId: "not-a-uuid" } }),
      await request({ input: { planVersion: 0 } }),
    ];
    assert.deepEqual(
      refused.map((params) => StartRunParams.safeParse(params).success),
      refused.map(() => false),
    );
    // Nor does a review take research's context in place of its own.
    const review = { clientRequestId: randomUUID(), workflowId: "review", input: { planId: randomUUID(), planVersion: 2, packetDigest: "a".repeat(64), preferencesDigest: "b".repeat(64) } };
    const own = { preferences, sharing: { modelContext: false }, packet: { scope: { kind: "general" }, text: "A plan", assumptions: [], references: [] } };
    assert.deepEqual([StartRunParams.safeParse({ ...review, context: own }).success, StartRunParams.safeParse({ ...review, context }).success], [true, false]);
  });

  it("holds the Tavily key as a secret of its own", () => {
    assert.equal(SecretName.parse("TAVILY_API_KEY"), "TAVILY_API_KEY");
    assert.equal(InitializeParams.safeParse({ protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, secrets: { TAVILY_API_KEY: `tvly-${"k".repeat(24)}` } }).success, true);
    assert.equal(SecretsUpdateParams.safeParse({ remove: ["TAVILY_API_KEY"] }).success, true);
  });
});

describe("researchPacketDigest (NIV-45)", () => {
  it("is pinned to its canonical form, which covers the limits too, and anyone can work it out", async () => {
    const digest = await researchPacketDigest(PACKET);
    assert.equal(digest, "0bf16b46212631c9739dcf79005c4af8769551a5efcf74c0c8db2d8173b8e778");
    const independent = createHash("sha256")
      .update(
        JSON.stringify([
          "nivra.research-packet.v1",
          "general",
          null,
          PACKET.planText,
          PACKET.assumptions.map((assumption) => [assumption.id, assumption.text, "typed", null, assumption.query]),
          ["prefer", ["docs.python.org", "peps.python.org"]],
          Object.entries(RESEARCH_LIMITS),
        ]),
      )
      .digest("hex");
    assert.equal(digest, independent);
  });

  it("changes with a query, a site, an assumption's origin or the scope", async () => {
    const base = await researchPacketDigest(PACKET);
    const variants: Packet[] = [
      { ...PACKET, assumptions: [{ ...PACKET.assumptions[0]!, query: "distutils 3.12" }, PACKET.assumptions[1]!] },
      { ...PACKET, sites: { mode: "restrict", hosts: ["docs.python.org", "peps.python.org"] } },
      { ...PACKET, sites: null },
      { ...PACKET, scope: { kind: "project", headAtStart: null }, assumptions: [{ ...PACKET.assumptions[0]!, origin: { kind: "plan", index: 0 } }, PACKET.assumptions[1]!] },
    ];
    const digests = await Promise.all(variants.map((packet) => researchPacketDigest(packet)));
    assert.equal(new Set([base, ...digests]).size, variants.length + 1);
  });
});

describe("queryProblems (NIV-45)", () => {
  const deny: ResearchDeny = { terms: ["api", "Nivra", "nivra-orchestrator", "workout-comeback"], paths: ["src/db/migrate.ts", "README.md"] };

  it("lets ordinary documentation queries through, bare file names and package names included", () => {
    const allowed = [
      "Python 3.12 distutils standard library",
      "setup.py distutils Python 3.12 removed",
      "@types/node 20 global fetch",
      "owner/repo issue about distutils",
      "Does the Stripe API support idempotency keys",
      "TCP/IP and/or 1/2 throughput",
      "Is 8.8.8.8 reachable over IPv6",
      "README.md conventions for npm packages",
      "example.com redirect rules",
      "Python test runner for local development",
      "private repositories on GitHub",
      "home directory permissions on Linux",
      "localhost HMR not reloading",
      "version 3.12.1 release notes",
      "Python 3.12. distutils",
      "w/o setuptools, 24/7 uptime",
      "node.js/npm workspaces",
    ];
    assert.deepEqual(
      allowed.map((query) => queryProblems(query, deny)),
      allowed.map(() => []),
    );
  });

  it("refuses saved keys, credential shapes, addresses, paths, cited paths, projects, email addresses and private hosts, by kind", () => {
    const cases: Array<[string, string[]]> = [
      ["tvly-secretsecretsecret leaked here", ["saved-key", "credential"]],
      ["deploy to e00-project-saved-id first", ["saved-key"]],
      ["key tvly-dev-abcdefghijklmnop works", ["credential"]],
      ["key sk-proj-abcdefghijklmnopqrstuvwx works", ["credential"]],
      ["see https://docs.python.org/3/whatsnew", ["url"]],
      ["see www.python.org downloads", ["url"]],
      ["/usr/lib/python3.12 distutils", ["path"]],
      ["C:\\Users\\nate\\app setup", ["path"]],
      ["~/projects/thing build", ["path"]],
      ["./scripts/build.sh fails", ["path"]],
      ["$HOME/.config permissions", ["path"]],
      ["rename src/db/migrate.ts column", ["cited-path"]],
      ["nivra-orchestrator distutils", ["project"]],
      ["Nivra build image upgrade", ["project"]],
      ["ask nate@company.io about it", ["email"]],
      ["10.0.0.5 timeout on deploy", ["private-address"]],
      ["192.168.1.1 router firmware", ["private-address"]],
      ["api.internal latency", ["private-address"]],
      ["build.localhost:3000 dev server", ["private-address"]],
      ["fe80::1 link local", ["private-address"]],
      // At the end of a sentence, or with a root's trailing dot.
      ["connection refused to 10.0.0.5.", ["private-address"]],
      ["timeouts from api.internal.", ["private-address"]],
      ["resolve printer.local.", ["private-address"]],
      // Wrapped as Markdown or prose wraps them: backticks, curly quotes, braces, after a colon or a pipe.
      ["`/home/odin/proj/setup.py` distutils", ["path"]],
      ["`./scripts/build.sh` fails", ["path"]],
      ["`~/proj` layout", ["path"]],
      ["path:/home/odin/project", ["path"]],
      ["“/home/odin/proj” missing", ["path"]],
      ["{/etc/hosts} entry", ["path"]],
      ["see ../secrets/file", ["path"]],
      ["   ", ["blank"]],
      ["q".repeat(RESEARCH_LIMITS.queryChars + 1), ["too-long"]],
    ];
    assert.deepEqual(
      cases.map(([query]) => queryProblems(query, deny, ["tvly-secretsecretsecret", "e00-project-saved-id"])),
      cases.map(([, problems]) => problems),
    );
    assert.equal(Object.keys(QUERY_PROBLEM_WORDS).length, 10, "every kind has its words");
  });
});

describe("siteProblem (NIV-45)", () => {
  it("takes public hostnames only: no scheme, path, port, address or private suffix", () => {
    const cases: Array<[string, string | null]> = [
      ["docs.python.org", null],
      ["peps.python.org", null],
      ["xn--bcher-kva.de", null],
      ["localhost", "not-a-hostname"],
      ["wiki.internal", "private"],
      ["foo.localhost", "private"],
      ["192.168.1.1", "not-a-hostname"],
      ["https://docs.python.org", "not-a-hostname"],
      ["docs.python.org/3", "not-a-hostname"],
      ["docs.python.org:443", "not-a-hostname"],
      ["Docs.Python.org", "not-a-hostname"],
      ["-bad.example.org", "not-a-hostname"],
    ];
    assert.deepEqual(
      cases.map(([host]) => siteProblem(host)),
      cases.map(([, problem]) => problem),
    );
  });
});

describe("a research report (NIV-45)", () => {
  it("fits the engine's artifact limit at its largest, its text in the widest characters it can hold, and refuses anything extra", () => {
    const L = RESEARCH_LIMITS;
    const at = new Date().toISOString();
    const ids = ["A1", "A2", "A3"] as const;
    const fill = (n: number) => "x".repeat(n);
    // Text the web or a model wrote can be any character the engine keeps: three bytes each at most, once it has been
    // made well formed and plain (a lone surrogate or a control character would be six). Addresses, hosts, request ids
    // and versions are ASCII by construction.
    const report = (wide: (n: number) => string): Report => ({
      planId: randomUUID(),
      planVersion: 99,
      packetDigest: "f".repeat(64),
      outcome: "complete",
      scope: { kind: "project", headAtStart: "f".repeat(64) },
      request: { runId: randomUUID(), clientRequestId: randomUUID() },
      route: { provider: "nebius", endpoint: "token-factory", model: fill(200) },
      queries: ids.map((assumption) => ({ assumption, text: wide(L.assumptionChars), query: wide(L.queryChars) })),
      sites: { mode: "prefer", hosts: Array.from({ length: L.sites }, () => fill(L.siteChars)) },
      requests: [
        ...ids.map((assumption) => ({ id: `search-${assumption}` as const, kind: "search" as const, assumption, state: "answered" as const, failure: null, status: 200, requestId: fill(100), credits: 2, pages: 0, returned: null, elapsedMs: 30_000 })),
        ...ids.map((assumption) => ({ id: `extract-${assumption}` as const, kind: "extract" as const, assumption, state: "answered" as const, failure: null, status: 200, requestId: fill(100), credits: 1, pages: 5, returned: 5, elapsedMs: 45_000 })),
        { id: "model", kind: "model", assumption: null, state: "answered", failure: null, status: null, requestId: null, credits: null, pages: 0, returned: null, elapsedMs: 150_000 },
      ],
      pages: Array.from({ length: L.pages }, (_, index) => ({
        id: `S${index + 1}`,
        address: fill(L.addressChars),
        host: fill(L.siteChars),
        title: wide(L.titleChars),
        foundBy: ids.map((assumption) => ({ assumption, rank: 5 })),
        extractedFor: [...ids],
        status: "read" as const,
      })),
      passages: Array.from({ length: L.passages }, (_, index) => ({
        id: `S${(index % L.pages) + 1}.${(index % L.passagesPerExtraction) + 1}`,
        page: `S${(index % L.pages) + 1}`,
        assumption: ids[index % 3]!,
        chunk: (index % L.passagesPerExtraction) + 1,
        heading: wide(L.headingChars),
        text: wide(L.passageChars),
        clipped: true,
        retrievedAt: at,
      })),
      assessments: ids.map((assumption) => ({
        assumption,
        model: "contradicted" as const,
        shown: "contradicted" as const,
        rule: null,
        reasoning: wide(L.reasoningChars),
        applicability: { plan: wide(L.applicabilityChars), source: wide(L.applicabilityChars), where: "heading" as const },
        uncertainty: wide(L.uncertaintyChars),
        citations: Array.from({ length: L.citationsPerAssessment }, () => ({ passage: "S15.3", stance: "contradicts" as const, quote: wide(L.quoteMaxChars), valid: true, problem: null })),
        version: fill(40),
        amendment: { kind: "model" as const, text: wide(L.amendmentChars) },
      })),
      checks: { citations: 18, valid: 18, relabelled: 0 },
      attribution: {
        handedIn: 13,
        matched: 3,
        usable: 0,
        rejected: 10,
        entries: Array.from({ length: 10 }, () => ({ label: wide(80), reason: "conflicting" as const })),
        unusable: ids.map((assumption) => ({ assumption, outcome: wide(40) })),
      },
      stop: null,
      usage: { credits: 9, model: { inputTokens: 60_000, outputTokens: 4_000, calls: 1, reportedCalls: 1 } },
      budget: null,
      elapsedMs: 240_000,
      updatedAt: at,
      finishedAt: at,
    });
    const largest = report(fill);
    const parsed = ResearchReport.safeParse(largest);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)).slice(0, 600));
    for (const [name, filled] of [
      ["ASCII", largest],
      ["three-byte characters", report((n) => "漢".repeat(n))],
    ] as const) {
      const bytes = Buffer.byteLength(JSON.stringify(filled));
      assert.ok(bytes < 256_000, `the largest report in ${name} takes ${bytes} bytes`);
    }
    assert.equal(ResearchReport.safeParse({ ...largest, planText: "the plan" }).success, false);
  });
});
