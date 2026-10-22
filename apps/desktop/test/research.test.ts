import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { QUERY_PROBLEM_WORDS, queryProblems, RESEARCH_LIMITS, ResearchContext, ResearchDeny, ResearchInput, ResearchPacket, researchPacketDigest } from "@nivra/domain";
import type { KnownSecrets } from "../src/main/protect.ts";
import {
  amendedContent,
  amendedPlanFields,
  queryChecks,
  researchDeny,
  researchFingerprint,
  researchNoteFor,
  researchPacket,
  researchReportMatches,
  researchRequest,
  type ResearchState,
  type ResearchSubject,
} from "../src/main/research.ts";
import type { ResearchRecord } from "../src/main/research-store.ts";
import type { PlanContent } from "../src/main/tasks.ts";
import type { ArtifactRecord, ConversationRecord, TurnRecord } from "../src/main/workspace.ts";
import {
  amendmentChoices,
  amendmentDraft,
  attributionText,
  evidenceFor,
  initialQuery,
  rejectedQuotes,
  requestText,
  ruleText,
  unusableAssessments,
  usageText,
  type ResearchReportView,
  type ResearchRequestView,
  type ResearchSelection,
} from "../src/shared/research.ts";

const SAVED = "NIVRA-SAVED-KEY-CANARY-7f3a";
const KNOWN: KnownSecrets = [["NEBIUS_API_KEY", SAVED]];
const TOKEN = `ghp_${"a1B2".repeat(9)}`;
const AT = "2026-10-22T10:00:00.000Z";
const HEAD = "c".repeat(40);

const project = (): ConversationRecord => ({ id: randomUUID(), kind: "project", projectId: randomUUID(), projectLabel: "shop", targetId: "wsl:Ubuntu", title: "Build image", createdAt: AT, updatedAt: AT });
const general = (): ConversationRecord => ({ id: randomUUID(), kind: "general", projectId: null, projectLabel: null, targetId: "local", title: "Build image", createdAt: AT, updatedAt: AT });
const contentFor = (conversation: ConversationRecord, change: Partial<PlanContent> = {}): PlanContent => ({
  text: "Move the build image from Python 3.11 to 3.12; setup.py keeps importing distutils.",
  conversationId: conversation.id,
  messageId: randomUUID(),
  runId: null,
  projectId: conversation.projectId,
  kind: conversation.kind === "project" ? "repository" : "general",
  headAtStart: conversation.kind === "project" ? HEAD : null,
  citations:
    conversation.kind === "project"
      ? [
          { path: "build/Dockerfile", startLine: 1, endLine: 4 },
          { path: "setup.py", startLine: 1, endLine: 3 },
          { path: "build/Dockerfile", startLine: 9, endLine: 9 },
        ]
      : [],
  assumptions: conversation.kind === "project" ? ["distutils is still in Python 3.12's standard library", "Python 3.12 f-strings can reuse the enclosing quotes"] : [],
  ...change,
});
const planOf = (conversation: ConversationRecord, change: Partial<PlanContent> = {}, version = 1): ArtifactRecord => ({
  id: randomUUID(),
  kind: "plan",
  lineageId: randomUUID(),
  version,
  content: contentFor(conversation, change),
  sha256: "e".repeat(64),
  conversationId: conversation.id,
  taskId: null,
  messageId: null,
  runLinkId: null,
  derivedFrom: null,
  createdAt: AT,
});
const pick = (index: number, query: string) => ({ from: { kind: "plan" as const, index }, query });
const typed = (text: string, query: string) => ({ from: { kind: "typed" as const, text }, query });
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};
const refusalOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

describe("research packets, queries and previews (NIV-45)", () => {
  it("freezes picked and typed assumptions with the queries as written, and the domain's packet takes it", async () => {
    const conversation = project();
    const plan = planOf(conversation, { assumptions: [`The build reads ${SAVED} from the image`, "Python 3.12 f-strings can reuse the enclosing quotes"] });
    const selection: ResearchSelection = {
      assumptions: [pick(1, "  Python 3.12 f-string quotes PEP 701  "), typed("  venv still pre-installs setuptools ", "venv setuptools Python 3.12"), pick(0, "")],
      sites: { mode: "prefer", hosts: [" Docs.Python.org ", "peps.python.org", "docs.python.org", "bücher.de"] },
    };
    const packet = researchPacket(plan, conversation, selection, KNOWN);
    assert.deepEqual(
      packet.assumptions.map((assumption) => [assumption.id, assumption.origin, assumption.query]),
      [
        ["A1", { kind: "plan", index: 1 }, "Python 3.12 f-string quotes PEP 701"],
        ["A2", { kind: "typed" }, "venv setuptools Python 3.12"],
        // A project's plan's query starts empty, and stays so until the person writes one: never filled in here.
        ["A3", { kind: "plan", index: 0 }, ""],
      ],
    );
    assert.deepEqual([packet.assumptions[1]!.text, packet.scope, packet.sites], ["venv still pre-installs setuptools", { kind: "project", headAtStart: HEAD }, { mode: "prefer", hosts: ["docs.python.org", "peps.python.org", "xn--bcher-kva.de"] }]);
    // What the engine wrote is masked again before it goes anywhere.
    assert.equal(packet.assumptions[2]!.text.includes(SAVED), false);
    // Sites written several ways count once each.
    const variants = researchPacket(plan, conversation, { assumptions: [pick(1, "q")], sites: { mode: "restrict", hosts: ["Docs.Python.org", "docs.python.org", " DOCS.PYTHON.ORG", "peps.python.org", "Peps.Python.Org", "peps.python.org "] } }, KNOWN);
    assert.deepEqual(variants.sites, { mode: "restrict", hosts: ["docs.python.org", "peps.python.org"] });
    // With every query written, the domain's own schema takes the packet whole.
    packet.assumptions[2]!.query = "Python 3.12 distutils removed";
    assert.equal(ResearchPacket.safeParse(packet).success, true);
  });

  it("refuses a plan, an assumption or a site research can't take, in words that say which and never the value", () => {
    const conversation = project();
    const plan = planOf(conversation, { assumptions: ["distutils is still in Python 3.12's standard library", "x".repeat(RESEARCH_LIMITS.assumptionChars + 1)] });
    const packetOf = (selection: Partial<ResearchSelection>, of: ArtifactRecord = plan) => researchPacket(of, conversation, { assumptions: [pick(0, "q")], sites: null, ...selection }, KNOWN);
    const cases: Array<[string, () => unknown, RegExp]> = [
      ["a long plan", () => packetOf({}, planOf(conversation, { text: "x".repeat(RESEARCH_LIMITS.planChars + 1) })), /is 20,001 characters long, and research can take 20,000\. Edit the plan to shorten it/],
      ["a token in the plan", () => packetOf({}, planOf(conversation, { text: `Use ${TOKEN} to pull.` })), /^This plan version looks like it holds a GitHub token, so nothing was sent\. Edit the plan to remove it, then research the new version\.$/],
      ["a saved key in the plan", () => packetOf({}, planOf(conversation, { text: `Use ${SAVED} to pull.` })), /^This plan version holds your saved Token Factory key, so nothing was sent\. Edit the plan to remove it, then research the new version\.$/],
      ["a saved key typed", () => packetOf({ assumptions: [pick(0, "q"), typed(`The key ${SAVED} works`, "q")] }), /^A2 holds your saved Token Factory key, so nothing was sent\. Remove it, then preview again\.$/],
      ["a blank assumption", () => packetOf({ assumptions: [typed("   ", "q")] }), /^A1 is empty\./],
      ["a long typed assumption", () => packetOf({ assumptions: [typed("y".repeat(301), "q")] }), /^A1 is 301 characters long, and research can take 300/],
      ["a long assumption of the plan", () => packetOf({ assumptions: [pick(1, "q")] }), /assumption 2 is 301 characters long.*Type a shorter version of it instead/],
      ["an assumption that isn't there", () => packetOf({ assumptions: [pick(7, "q")] }), /has no assumption 8/],
      ["one picked twice", () => packetOf({ assumptions: [pick(0, "q"), pick(0, "r")] }), /assumption 1 is picked twice/],
      ["none", () => packetOf({ assumptions: [] }), /^Pick one to three assumptions/],
      ["four", () => packetOf({ assumptions: [pick(0, "q"), typed("a", "q"), typed("b", "q"), typed("c", "q")] }), /^Pick one to three assumptions/],
      ["six sites", () => packetOf({ sites: { mode: "restrict", hosts: ["a.org", "b.org", "c.org", "d.org", "e.org", "f.org"] } }), /^Research can use up to five sites, and six are listed\. Remove one/],
      ["a scheme", () => packetOf({ sites: { mode: "prefer", hosts: ["https://docs.python.org"] } }), /^Site 1 isn't a host name such as docs\.python\.org/],
      ["a path", () => packetOf({ sites: { mode: "restrict", hosts: ["docs.python.org", "docs.python.org/3/"] } }), /^Site 2 isn't a host name/],
      // Named by its place as written: blanks and repeats before it still count.
      ["a place as written", () => packetOf({ sites: { mode: "prefer", hosts: ["docs.python.org", " ", "https://x.org"] } }), /^Site 3 isn't a host name/],
      ["a private name", () => packetOf({ sites: { mode: "prefer", hosts: ["wiki.corp"] } }), /^Site 1 is a private host name/],
      ["an address", () => packetOf({ sites: { mode: "prefer", hosts: ["10.0.0.1"] } }), /^Site 1 isn't a host name/],
      ["a key as a site", () => packetOf({ sites: { mode: "prefer", hosts: [TOKEN] } }), /^Site 1 isn't a host name/],
    ];
    for (const [name, run, words] of cases) {
      const message = refusal(run);
      assert.match(message, words, name);
      assert.equal(message.includes(SAVED) || message.includes(TOKEN), false, name);
    }
  });

  it("names every project's label and folder, and the plan's cited paths with more than one segment", () => {
    const conversation = project();
    const content = contentFor(conversation);
    const deny = researchDeny(
      [
        { label: "shop", nativePath: "/home/me/code/shop-api" },
        { label: "Billing", nativePath: "C:\\Users\\me\\src\\billing\\" },
        { label: "SHOP", nativePath: "/srv/shop" },
      ],
      content,
    );
    assert.deepEqual(deny, { terms: ["shop", "shop-api", "Billing"], paths: ["build/Dockerfile"] });
    assert.equal(ResearchDeny.safeParse(deny).success, true);
    const values = KNOWN.map(([, value]) => value);
    const problems = (query: string) => queryChecks({ ...researchPacket(planOf(conversation), conversation, { assumptions: [pick(0, query)], sites: null }, KNOWN) }, deny, KNOWN)[0]!.problems;
    assert.deepEqual(problems("Python 3.12 distutils removed setup.py"), []);
    assert.deepEqual(problems("distutils in build/Dockerfile"), [QUERY_PROBLEM_WORDS["cited-path"]]);
    assert.deepEqual(problems("Billing service distutils"), [QUERY_PROBLEM_WORDS.project]);
    assert.deepEqual(problems(`distutils ${SAVED}`), [QUERY_PROBLEM_WORDS["saved-key"]]);
    assert.deepEqual(queryProblems(`distutils ${SAVED}`, deny, values), ["saved-key"], "the same check the engine runs again");
  });

  const state = (change: Partial<ResearchState> = {}): ResearchState => ({ webResearch: true, tavilyKey: true, known: KNOWN, projects: [{ label: "shop", nativePath: "/home/me/code/shop" }], busy: null, ...change });
  const subjectOf = (conversation: ConversationRecord, change: Partial<ResearchSubject> = {}, content: Partial<PlanContent> = {}): ResearchSubject => {
    const plan = planOf(conversation, content);
    return { plan, latestVersion: plan.version, conversation, project: conversation.kind === "project" ? { label: "shop", targetLabel: "Ubuntu", modelSharing: true } : null, ...change };
  };

  it("previews exactly what goes where, and binds Start research to what it would send and the permissions", async () => {
    const conversation = general();
    const subject = subjectOf(conversation);
    const selection: ResearchSelection = { assumptions: [typed("distutils is still in Python 3.12's standard library", "Python 3.12 distutils removed")], sites: null };
    const request = await researchRequest(subject, selection, state());
    const { preview } = request;
    assert.deepEqual(
      [preview.blocked, preview.tavily, preview.model, preview.limits],
      [
        null,
        { queries: [{ assumption: "A1", query: "Python 3.12 distutils removed", problems: [] }], sites: null },
        { planChars: (subject.plan.content as PlanContent).text.length, assumptions: [{ id: "A1", text: "distutils is still in Python 3.12's standard library", fromPlan: null }] },
        { searches: 1, extracts: 1, pages: 5, credits: 2, modelRequests: 1, seconds: 240 },
      ],
    );
    const packetDigest = await researchPacketDigest(request.context.packet);
    assert.deepEqual(request.input, { planId: subject.plan.id, planVersion: 1, packetDigest });
    assert.equal(preview.expected, researchFingerprint({ planId: subject.plan.id, planVersion: 1, packetDigest, webResearch: true, modelSharing: null }));
    assert.deepEqual(request.queries, [{ assumption: "A1", text: "distutils is still in Python 3.12's standard library", query: "Python 3.12 distutils removed" }]);
    // The run's input and context are what the domain's contract takes; the input holds ids and the fingerprint only.
    assert.deepEqual([ResearchInput.safeParse(request.input).success, ResearchContext.safeParse(request.context).success], [true, true]);
    assert.deepEqual(request.context.sharing, { modelContext: false, webResearch: true });

    // The same records give the same fingerprint; any change to what would be sent, or to a permission, gives another.
    const again = async (change: Partial<ResearchSelection> = {}, at: Partial<ResearchState> = {}, of: ResearchSubject = subject) => (await researchRequest(of, { ...selection, ...change }, state(at))).preview.expected;
    assert.equal(await again(), preview.expected);
    const others = [
      await again({ assumptions: [typed("distutils is still in Python 3.12's standard library", "Python 3.12 distutils")] }),
      await again({ sites: { mode: "prefer", hosts: ["docs.python.org"] } }),
      await again({ sites: { mode: "restrict", hosts: ["docs.python.org"] } }),
      await again({}, { webResearch: false }),
      await again({}, {}, { ...subject, plan: { ...subject.plan, version: 2 }, latestVersion: 2 }),
    ];
    assert.equal(new Set([preview.expected, ...others]).size, 6);
    // A project's sharing is part of what it is bound by, on or off.
    const projectSubject = subjectOf(project());
    const sharing = async (on: boolean) => (await researchRequest({ ...projectSubject, project: { label: "shop", targetLabel: "Ubuntu", modelSharing: on } }, { assumptions: [pick(0, "Python 3.12 distutils")], sites: null }, state())).preview.expected;
    assert.notEqual(await sharing(true), await sharing(false));
  });

  it("blocks Start research with the first reason that applies, and lists each query's problems", async () => {
    const conversation = project();
    const selection: ResearchSelection = { assumptions: [pick(0, "Python 3.12 distutils removed")], sites: null };
    const blocked = async (subject: ResearchSubject, at: Partial<ResearchState> = {}, picks: ResearchSelection = selection) => (await researchRequest(subject, picks, state(at))).preview.blocked;
    const ready = subjectOf(conversation);
    assert.equal(await blocked(ready), null);
    assert.equal(await blocked(ready, { busy: "A review of a plan is running in this conversation.", webResearch: false }), "A review of a plan is running in this conversation.");
    assert.match((await blocked({ ...ready, latestVersion: 2 }))!, /^This is v1 of the plan, and v2 is the latest\. Check v2 instead/);
    assert.equal(await blocked(ready, { webResearch: false, tavilyKey: false }), "Research queries to Tavily are turned off. Turn them on, then start again.");
    assert.equal(await blocked(ready, { tavilyKey: false }), "Nivra has no Tavily API key. Add one in Settings, then start again.");
    assert.match((await blocked({ ...ready, project: { label: "shop", targetLabel: "Ubuntu", modelSharing: false } }))!, /^This project doesn't allow sending its content to Token Factory/);
    // A general plan needs no project's sharing.
    assert.equal(await blocked(subjectOf(general()), {}, { assumptions: [typed("a claim", "a claim")], sites: null }), null);

    const preview = (await researchRequest(ready, { assumptions: [pick(0, ""), typed("Our shop service pins pip", "shop service pip pin"), pick(1, `quotes ${SAVED}`)], sites: null }, state())).preview;
    assert.deepEqual(
      preview.tavily.queries.map((query) => [query.assumption, query.problems]),
      [
        ["A1", [QUERY_PROBLEM_WORDS.blank]],
        ["A2", [QUERY_PROBLEM_WORDS.project]],
        ["A3", [QUERY_PROBLEM_WORDS["saved-key"]]],
      ],
    );
    assert.equal(preview.blocked, `A1's query ${QUERY_PROBLEM_WORDS.blank}, so nothing can be sent. Edit it, then preview again.`);
    assert.equal(preview.blocked.includes(SAVED), false);
  });

  it("checks that a report is the one a run asked for: plan version, packet, scope, queries, request and run", () => {
    const runId = randomUUID();
    const queries: ResearchRecord["queries"] = [{ assumption: "A1", text: "distutils is still in Python 3.12's standard library", query: "Python 3.12 distutils removed" }];
    const research = { id: randomUUID(), planId: randomUUID(), planVersion: 2, packetDigest: "a".repeat(64), queries, scope: { kind: "project", projectId: randomUUID(), projectLabel: "shop", headAtStart: HEAD } } as ResearchRecord;
    const report = { planId: research.planId, planVersion: 2, packetDigest: research.packetDigest, scope: { kind: "project" as const, headAtStart: HEAD }, request: { runId, clientRequestId: research.id }, queries };
    assert.equal(researchReportMatches(report, research, runId), true);
    for (const [name, changed] of [
      ["version", { ...report, planVersion: 1 }],
      ["packet", { ...report, packetDigest: "b".repeat(64) }],
      ["scope", { ...report, scope: { kind: "general" as const } }],
      ["head", { ...report, scope: { kind: "project" as const, headAtStart: "d".repeat(40) } }],
      ["query", { ...report, queries: [{ ...queries[0]!, query: "Python 3.12 distutils" }] }],
      ["request", { ...report, request: { runId, clientRequestId: randomUUID() } }],
    ] as const)
      assert.equal(researchReportMatches(changed, research, runId), false, name);
    assert.equal(researchReportMatches(report, research, randomUUID()), false, "run");
  });

  it("says how research that ended without a complete report ended, naming the stop's own cause", () => {
    const link = (status: TurnRecord["status"], errorMessage: string | null = null) => ({ status, errorMessage }) as TurnRecord;
    const SENT = "What was already sent can't be withdrawn, and nothing was resent.";
    assert.equal(researchNoteFor(link("cancelled"), { cause: "person", token: "T1" }), `Cancelled. ${SENT}`);
    assert.equal(researchNoteFor(link("cancelled"), { cause: "web-research", token: "T1" }), `Stopped: research queries to Tavily were turned off. ${SENT}`);
    assert.equal(researchNoteFor(link("cancelled"), { cause: "model-sharing", token: "T1" }), `Stopped: sharing for this project was turned off. ${SENT}`);
    assert.equal(researchNoteFor(link("cancelled"), { cause: "removal", token: "T1" }), `Stopped: the project was removed. ${SENT}`);
    // What the host established about the stop is kept.
    assert.equal(researchNoteFor(link("cancelled", "Stopped before it was sent."), { cause: "web-research", token: "T1" }), "Stopped: research queries to Tavily were turned off. Stopped before it was sent.");
    assert.equal(researchNoteFor(link("cancelled", "Stopped before it was sent."), null), "Cancelled. Stopped before it was sent.");
    assert.equal(researchNoteFor(link("failed", "Nothing could be read from the pages found."), null), "Nothing could be read from the pages found. Nothing was resent.");
    assert.match(researchNoteFor(link("interrupted"), null)!, /may have been sent, and its credits are unknown/);
    assert.equal(researchNoteFor(link("not-sent"), null), "Not sent: nothing reached Tavily or Token Factory.");
    assert.match(researchNoteFor(link("unknown", "its engine stopped"), null)!, /^Nivra can't tell whether this research reached Tavily or Token Factory: its engine stopped\./);
    assert.deepEqual([researchNoteFor(link("running"), null), researchNoteFor(link("answered"), null)], [null, null]);
  });

  it("checks an amended version's text and assumptions as a plan's and a brief's are, and adds nothing of the research to its content", () => {
    assert.deepEqual(amendedPlanFields("  Move to 3.12.  ", [" Replace distutils ", "", "  "], KNOWN), { text: "Move to 3.12.", assumptions: ["Replace distutils"] });
    const cases: Array<[string, () => unknown, RegExp]> = [
      ["blank", () => amendedPlanFields("  ", [], KNOWN), /^A plan needs some text\.$/],
      ["long", () => amendedPlanFields("x".repeat(20_001), [], KNOWN), /is 20,001 characters long, and a plan can hold 20,000/],
      ["a key in the text", () => amendedPlanFields(`Use ${SAVED}`, [], KNOWN), /^The plan holds .*so nothing was saved/],
      ["too many", () => amendedPlanFields("Plan", Array.from({ length: 21 }, (_, i) => `a${i}`), KNOWN), /can list 20 assumptions, and this one lists 21\. Remove 1/],
      ["a long item", () => amendedPlanFields("Plan", ["a", "b".repeat(1_001)], KNOWN), /^Assumption 2 is 1,001 characters long/],
      ["numbered as written", () => amendedPlanFields("Plan", ["a", "", "c".repeat(1_001)], KNOWN), /^Assumption 3 is 1,001 characters long/],
      ["a token in an item", () => amendedPlanFields("Plan", ["a", `uses ${TOKEN}`], KNOWN), /^Assumption 2 looks like it holds a GitHub token, so nothing was saved/],
    ];
    for (const [name, run, words] of cases) {
      const message = refusal(run);
      assert.match(message, words, name);
      assert.equal(message.includes(SAVED) || message.includes(TOKEN), false, name);
    }
    const researched = contentFor(project());
    const amended = amendedContent(researched, { text: "Move to 3.12 and replace distutils.", assumptions: ["setuptools provides distutils"] });
    assert.deepEqual(Object.keys(amended).sort(), Object.keys(researched).sort());
    assert.deepEqual(amended, { ...researched, text: "Move to 3.12 and replace distutils.", assumptions: ["setuptools provides distutils"] });
  });

  it("refuses a project's plan whose project is gone, rather than treating it as a general one", async () => {
    const conversation = project();
    const message = await refusalOf(() => researchRequest(subjectOf(conversation, { project: null }), { assumptions: [pick(0, "Python 3.12 distutils")], sites: null }, state()));
    assert.equal(message, "This plan's project was removed, so its assumptions can't be checked. Its history stays here until you delete it.");
  });

  it("refuses a selection whose plan holds a credential before any query is checked or fingerprinted", async () => {
    const conversation = general();
    const message = await refusalOf(() => researchRequest(subjectOf(conversation, {}, { text: `Pull with ${TOKEN}.` }), { assumptions: [typed("a claim", "a claim")], sites: null }, state()));
    assert.match(message, /^This plan version looks like it holds a GitHub token, so nothing was sent\./);
  });
});

describe("the research window's words and evidence (NIV-45)", () => {
  const page = (id: string, host: string, status: ResearchReportView["pages"][number]["status"] = "read"): ResearchReportView["pages"][number] => ({
    id,
    address: `https://${host}/3/whatsnew/3.12.html`,
    host,
    title: `What's New In Python 3.12 · ${host}`,
    foundBy: [{ assumption: "A1", rank: 1 }],
    extractedFor: ["A1"],
    status,
  });
  const passage = (id: string, pageId: string, text: string): ResearchReportView["passages"][number] => ({ id, page: pageId, assumption: "A1", chunk: Number(id.split(".")[1]), heading: null, text, clipped: false, retrievedAt: AT });
  const REMOVED = "the distutils package has been removed from the standard library";
  const report = (assessments: ResearchReportView["assessments"]): Pick<ResearchReportView, "queries" | "assessments" | "passages" | "pages"> => ({
    queries: [
      { assumption: "A1", text: "distutils is still in Python 3.12's standard library", query: "Python 3.12 distutils removed" },
      { assumption: "A2", text: "Python 3.12 f-strings can reuse the enclosing quotes", query: "PEP 701 quotes" },
      { assumption: "A3", text: "venv still pre-installs setuptools", query: "venv setuptools 3.12" },
    ],
    assessments,
    passages: [passage("S1.1", "S1", `In Python 3.12 ${REMOVED}.`), passage("S2.1", "S2", `PEP 632: ${REMOVED}.`)],
    pages: [page("S1", "docs.python.org"), page("S2", "peps.python.org")],
  });
  const assessment = (change: Partial<ResearchReportView["assessments"][number]>): ResearchReportView["assessments"][number] => ({
    assumption: "A1",
    model: "contradicted",
    shown: "contradicted",
    rule: null,
    reasoning: "The release notes say it was removed.",
    applicability: { plan: "Python 3.12", source: "Python 3.12", where: "title" },
    uncertainty: "",
    citations: [],
    version: "3.12",
    amendment: null,
    ...change,
  });
  const valid = (passageId: string) => ({ passage: passageId, stance: "contradicts" as const, quote: REMOVED, valid: true, problem: null });

  it("starts a general plan's query from the assumption's words, and a project's plan's from nothing", () => {
    assert.deepEqual([initialQuery("general", "  venv still pre-installs setuptools "), initialQuery("project", "distutils is still in 3.12")], ["venv still pre-installs setuptools", ""]);
  });

  it("shows only valid quotations as evidence, each with its passage and page, and counts the rest", () => {
    const of = report([]);
    const { shown, left } = evidenceFor(of, {
      citations: [valid("S1.1"), { ...valid("S2.1"), quote: "removed from the standard library entirely" }, { ...valid("S2.1"), valid: false, problem: "not-found" }, { ...valid("S9.1"), valid: false, problem: "unknown-passage" }],
    });
    assert.deepEqual(
      shown.map((evidence) => [evidence.passage.id, evidence.page.host, evidence.quote]),
      [
        ["S1.1", "docs.python.org", REMOVED],
        ["S2.1", "peps.python.org", "removed from the standard library entirely"],
      ],
    );
    assert.equal(left, 2);
  });

  it("words each display rule about the evidence, never the truth", () => {
    assert.equal(ruleText({ rule: null, model: "supported", version: null }), null);
    assert.equal(ruleText({ rule: "no-valid-citation", model: "supported", version: null }), "The model said supported, but none of its quotations of that kind was found in the pages read, so this is shown as unresolved.");
    assert.equal(ruleText({ rule: "version-not-named", model: "contradicted", version: "3.12" }), "The model said contradicted, but the sources it quoted don't say they are about version 3.12, so this is shown as unresolved.");
    assert.equal(ruleText({ rule: "both-sides", model: "contradicted", version: null }), "The model said contradicted, but it quoted passages on both sides, so this is shown as unresolved. Both are below.");
    assert.equal(ruleText({ rule: "not-assessed", model: null, version: null }), "The model gave no usable assessment of this assumption.");
  });

  it("says what each request did, with credits as reported and never 0 for unknown", () => {
    const request = (change: Partial<ResearchRequestView>): ResearchRequestView => ({ id: "search-A1", kind: "search", assumption: "A1", state: "answered", failure: null, status: 200, requestId: "r1", credits: 1, pages: 0, returned: null, elapsedMs: 1_250, ...change });
    assert.equal(requestText(request({}), "complete"), "Search for A1: answered · 1 credit · 1.3 s");
    assert.equal(requestText(request({ credits: null }), "complete"), "Search for A1: answered · credits not reported · 1.3 s");
    assert.equal(requestText(request({ state: "failed", failure: "rate-limit", credits: null, elapsedMs: null }), "complete"), "Search for A1: Tavily asked Nivra to slow down; not retried · credits not reported");
    // What the engine reads back after a stop: a request it was sending ended `interrupted`, its credits unknown.
    assert.equal(requestText(request({ id: "extract-A2", kind: "extract", assumption: "A2", state: "failed", failure: "interrupted", credits: null, pages: 2, elapsedMs: null }), "interrupted"), "Read 2 pages for A2: may have been sent; credits unknown");
    assert.equal(requestText(request({ id: "extract-A2", kind: "extract", assumption: "A2", state: "sending", credits: null, pages: 2, elapsedMs: null }), "interrupted"), "Read 2 pages for A2: may have been sent; credits unknown");
    assert.equal(requestText(request({ id: "model", kind: "model", assumption: null, state: "failed", failure: "interrupted", credits: null, elapsedMs: null }), "interrupted"), "The model's assessment: may have been sent; tokens unknown");
    assert.equal(requestText(request({ state: "sending", credits: null, elapsedMs: null }), "in-progress"), "Search for A1: sending");
    assert.equal(requestText(request({ id: "model", kind: "model", assumption: null, credits: null, elapsedMs: 41_000 }), "complete"), "The model's assessment: answered · 41.0 s");
    assert.equal(requestText(request({ state: "pending", credits: null, elapsedMs: null }), "failed"), "Search for A1: not sent");
    assert.equal(requestText(request({ state: "failed", failure: "not-sent", credits: null, elapsedMs: null }), "failed"), "Search for A1: not sent", "nothing sent, so no credits to report");

    const model = { inputTokens: 9_000, outputTokens: 700, calls: 1, reportedCalls: 1 };
    const modelAnswered = request({ id: "model", kind: "model", assumption: null, credits: null });
    const none = { inputTokens: null, outputTokens: null, calls: 0, reportedCalls: 0 };
    assert.equal(usageText({ outcome: "complete", requests: [request({}), modelAnswered], usage: { credits: 3, model } }), "3 Tavily credits, as reported · 9,000 in / 700 out tokens, as reported");
    assert.equal(
      usageText({ outcome: "complete", requests: [request({ credits: null }), modelAnswered], usage: { credits: null, model: { ...model, inputTokens: null, reportedCalls: 0 } } }),
      "Tavily credits not reported · tokens not reported",
    );
    assert.equal(usageText({ outcome: "failed", requests: [request({ state: "pending" }), request({ id: "model", kind: "model", assumption: null, state: "skipped" })], usage: { credits: 0, model: none } }), "no Tavily requests · no model call");
    assert.equal(
      usageText({ outcome: "failed", requests: [request({ state: "failed", failure: "not-sent", credits: null }), request({ id: "model", kind: "model", assumption: null, state: "skipped" })], usage: { credits: 0, model: none } }),
      "no Tavily requests · no model call",
      "a request never sent costs nothing, and says so",
    );
    // Cut off while the model's request was out: neither its tokens nor the credits are known, and neither reads as none.
    assert.equal(
      usageText({ outcome: "interrupted", requests: [request({}), request({ id: "model", kind: "model", assumption: null, state: "failed", failure: "interrupted" })], usage: { credits: 1, model: none } }),
      "1 Tavily credit, as reported · tokens unknown",
    );
    assert.equal(usageText({ outcome: "interrupted", requests: [request({ state: "failed", failure: "interrupted", credits: null })], usage: { credits: null, model: none } }), "Tavily credits unknown · no model call");
  });

  it("keeps the quotations not found apart, each with why, and the assessments that couldn't be used, each with why", () => {
    const citation = (quote: string, valid: boolean, problem: "unknown-passage" | "too-short" | "not-found" | null) => ({ passage: "S1.1", stance: "contradicts" as const, quote, valid, problem });
    assert.deepEqual(
      rejectedQuotes({
        citations: [citation("has been removed from the standard library", true, null), citation("a sentence no page holds at all", false, "not-found"), citation("too short", false, "too-short"), citation("no problem said", false, null)],
      }),
      [
        { quote: "a sentence no page holds at all", passage: "S1.1", problem: "isn't in the passage it names" },
        { quote: "too short", passage: "S1.1", problem: "is too short to check (under 20 characters or 4 words)" },
        { quote: "no problem said", passage: "S1.1", problem: "isn't in the passage it names" },
      ],
      "only the quotations Nivra didn't find, never a valid one",
    );
    assert.deepEqual(unusableAssessments(null), []);
    assert.deepEqual(unusableAssessments({ handedIn: 2, matched: 2, usable: 2, rejected: 0, entries: [], unusable: [] }), []);
    assert.deepEqual(
      unusableAssessments({
        handedIn: 15,
        matched: 2,
        usable: 1,
        rejected: 13,
        entries: [{ label: "A4", reason: "unknown" }, { label: "", reason: "missing" }, ...Array.from({ length: 8 }, () => ({ label: "A1", reason: "duplicate" as const }))],
        unusable: [{ assumption: "A2", outcome: "likely" }],
      }).filter((line, index, all) => all.indexOf(line) === index),
      [
        "“A4” named no assumption that was asked about, so it was set aside.",
        "An assessment named no assumption, so it was set aside.",
        "“A1” answered an assumption that another assessment answered too, so it was set aside.",
        "3 more assessments were set aside, and aren't listed.",
        "A2's assessment gave “likely”, not supported, contradicted or unresolved, so it can't be used.",
      ],
    );
  });

  it("says what became of the model's assessments when some were set aside, and nothing when all matched", () => {
    assert.equal(attributionText(null), null);
    assert.equal(attributionText({ handedIn: 3, matched: 3, usable: 3, rejected: 0, entries: [], unusable: [] }), null);
    assert.equal(
      attributionText({
        handedIn: 4,
        matched: 1,
        usable: 1,
        rejected: 3,
        entries: [
          { label: "A1", reason: "duplicate" },
          { label: "A1: the same", reason: "duplicate" },
          { label: "", reason: "missing" },
        ],
        unusable: [],
      }),
      "The model handed in 4 assessments. 1 matched an assumption asked about; 3 were set aside: 2 answered an assumption that another assessment answered too; 1 named no assumption.",
    );
    assert.equal(
      attributionText({ handedIn: 12, matched: 0, usable: 0, rejected: 12, entries: Array.from({ length: 10 }, () => ({ label: "x", reason: "unknown" as const })), unusable: [] }),
      "The model handed in 12 assessments. 0 matched an assumption asked about; 12 were set aside: 10 named no assumption that was asked about; 2 more not listed.",
    );
    // Matched, but with no outcome Nivra recognises: said, with what each gave.
    assert.equal(
      attributionText({
        handedIn: 2,
        matched: 2,
        usable: 0,
        rejected: 0,
        entries: [],
        unusable: [
          { assumption: "A1", outcome: "" },
          { assumption: "A2", outcome: "maybe" },
        ],
      }),
      "The model handed in 2 assessments. 2 matched an assumption asked about, and 2 of those gave no outcome Nivra recognises (A1 gave none, A2 gave “maybe”).",
    );
  });

  it("offers the model's amendment for a contradiction with valid quotations, the fixed note for an unresolved one, and the draft names each site", () => {
    const unverified = 'Unverified: "venv still pre-installs setuptools". Research found no quotation that settles it.';
    const of = report([
      assessment({ citations: [valid("S1.1"), valid("S2.1"), { ...valid("S1.1"), valid: false, problem: "not-found" }], amendment: { kind: "model", text: "Replace distutils with setuptools before moving to 3.12." } }),
      assessment({ assumption: "A2", model: "supported", shown: "supported", citations: [{ ...valid("S2.1"), stance: "supports" }], amendment: { kind: "model", text: "Nothing to change." } }),
      assessment({ assumption: "A3", model: "contradicted", shown: "unresolved", rule: "no-valid-citation", citations: [{ ...valid("S1.1"), valid: false, problem: "not-found" }], amendment: { kind: "unverified", text: unverified } }),
    ]);
    const choices = amendmentChoices(of);
    assert.deepEqual(
      choices.map((choice) => [choice.assumption, choice.amendment.kind, choice.hosts]),
      [
        ["A1", "model", ["docs.python.org", "peps.python.org"]],
        ["A3", "unverified", []],
      ],
    );
    // A contradiction whose quotations were all left out offers nothing: a link alone is not evidence.
    assert.deepEqual(amendmentChoices(report([assessment({ citations: [{ ...valid("S1.1"), valid: false, problem: "not-found" }], amendment: { kind: "model", text: "Replace distutils." } })])), []);
    const text = "Move the build image from Python 3.11 to 3.12.\n";
    assert.equal(amendmentDraft(text, []), text);
    assert.equal(
      amendmentDraft(text, choices),
      `Move the build image from Python 3.11 to 3.12.\n\nFrom web research:\n- Replace distutils with setuptools before moving to 3.12. (from web research: docs.python.org, peps.python.org)\n- ${unverified}`,
    );
  });
  it("shows web text as text: no link, no page opened, no HTML, and research's main helpers stay free of Electron (D12)", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const window = read("../src/renderer/src/features/research.tsx");
    for (const [name, pattern] of [
      ["a link element", /<a[\s>]|<Anchor\b|\bhref=/],
      ["opening a page", /openExternal|window\.open\(|location\.(?:href|assign|replace)/],
      ["HTML from text", /dangerouslySetInnerHTML|innerHTML/],
    ] as const)
      assert.equal(pattern.test(window), false, name);
    for (const path of ["../src/main/research.ts", "../src/main/research-store.ts", "../src/shared/research.ts"]) assert.equal(/from\s+["']electron["']/.test(read(path)), false, path);
    // The window imports the domain for types only: zod's runtime check trips the CSP.
    assert.equal(/^import (?!type )[^;]*from "@nivra\/domain"/m.test(read("../src/shared/research.ts")), false);
  });
});
