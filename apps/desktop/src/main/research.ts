import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { QUERY_PROBLEM_WORDS, queryProblems, RESEARCH_LIMITS, researchPacketDigest, siteProblem, type ResearchContext, type ResearchDeny, type ResearchInput, type ResearchPacket } from "@nivra/domain";
import type { AssumptionId, ResearchPreview, ResearchSelection, ResearchSites } from "../shared/research.ts";
import { maskForStorage, refuseCredentials, type KnownSecrets } from "./protect.ts";
import type { ResearchQuery, ResearchRecord } from "./research-store.ts";
import { TASK_LIMITS, type PlanContent } from "./tasks.ts";
import type { ArtifactRecord, ConversationRecord, TurnRecord } from "./workspace.ts";

/**
 * Research of a saved plan version's assumptions (NIV-45), as plain functions: the packet a selection freezes, what no
 * query may name, the preview and the fingerprint "Start research" is bound by, the check that a report is the one a
 * run asked for, what an ended run says, and the amended version's checked fields and content. No Electron (D12). What
 * the window computes itself (the amendments offered and the pre-filled text) is in `shared/research.ts`. The limits,
 * checks and fingerprint are the domain contract's own (D37), which the engine runs again.
 */

const count = (n: number) => n.toLocaleString("en");
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** A small number in words, as copy writes one: "three", not "3". */
const inWords = (n: number) => WORDS[n] ?? count(n);
const segments = (path: string) => path.split(/[\\/]/).filter(Boolean);

/**
 * The sites as hostnames, in punycode and lower case, each once: refused unless each is a public one, named by its place
 * in the list as the person wrote it, and counted once written the same way.
 */
function sitesOf(sites: ResearchSites): ResearchSites | null {
  const hosts: string[] = [];
  sites.hosts.forEach((written, index) => {
    const host = written.trim();
    if (!host) return;
    // Converted only when it is a bare name: the conversion would drop a path or a scheme's rest without a word.
    const name = /[\s/\\:@?#]/.test(host) ? "" : domainToASCII(host.toLowerCase());
    const problem = name ? siteProblem(name) : "not-a-hostname";
    if (problem === "private") throw new Error(`Site ${index + 1} is a private host name, and research only searches the public web. Remove it, then preview again.`);
    if (problem) throw new Error(`Site ${index + 1} isn't a host name such as docs.python.org: no https://, path or port. Fix it, then preview again.`);
    if (!hosts.includes(name)) hosts.push(name);
  });
  if (hosts.length === 0) return null;
  const max = RESEARCH_LIMITS.sites;
  if (hosts.length > max) throw new Error(`Research can use up to ${inWords(max)} sites, and ${inWords(hosts.length)} are listed. Remove ${inWords(hosts.length - max)}, then preview again.`);
  return { mode: sites.mode, hosts };
}

/**
 * The packet a plan version and the person's selection freeze: the plan's text, one to three assumptions with where
 * each came from, the queries as the person wrote them (trimmed), and the sites. A query is never filled in, expanded or
 * rewritten here: it is sent as shown, or not at all, and its checks are `queryChecks`. An assumption from the plan,
 * which the engine wrote, is masked again; the plan's text, and what the person typed, are refused when they hold a
 * credential. Anything over research's limits is refused in words that say which.
 */
export function researchPacket(plan: ArtifactRecord, conversation: ConversationRecord, selection: ResearchSelection, known: KnownSecrets): ResearchPacket {
  const content = plan.content as PlanContent;
  const limits = RESEARCH_LIMITS;
  if (content.text.length > limits.planChars) {
    throw new Error(`This plan version is ${count(content.text.length)} characters long, and research can take ${count(limits.planChars)}. Edit the plan to shorten it, then check the new version.`);
  }
  // The host's own first look, before the domain's checks and the engine's masking: which field, never the value.
  refuseCredentials("This plan version", content.text, known, "research");
  const picks = selection.assumptions;
  if (picks.length === 0 || picks.length > limits.assumptions) throw new Error(`Pick one to ${inWords(limits.assumptions)} assumptions to check, then preview again.`);
  const picked = new Set<number>();
  const assumptions = picks.map((pick, index): ResearchPacket["assumptions"][number] => {
    const id = `A${index + 1}` as AssumptionId;
    const query = pick.query.trim();
    if (pick.from.kind === "typed") {
      const text = pick.from.text.trim();
      if (!text) throw new Error(`${id} is empty. Write the assumption, or remove it.`);
      if (text.length > limits.assumptionChars) throw new Error(`${id} is ${count(text.length)} characters long, and research can take ${count(limits.assumptionChars)}. Shorten it, then preview again.`);
      refuseCredentials(id, text, known, "preview");
      return { id, text, origin: { kind: "typed" }, query };
    }
    const place = pick.from.index;
    const original = Number.isInteger(place) ? content.assumptions[place] : undefined;
    if (original === undefined) throw new Error(`This plan version has no assumption ${place + 1}. Open the plan again, then pick its assumptions.`);
    if (picked.has(place)) throw new Error(`The plan's assumption ${place + 1} is picked twice. Pick it once, then preview again.`);
    picked.add(place);
    const text = maskForStorage(original, known).trim();
    if (!text) throw new Error(`The plan's assumption ${place + 1} is empty. Type the assumption instead.`);
    if (text.length > limits.assumptionChars) {
      throw new Error(`The plan's assumption ${place + 1} is ${count(text.length)} characters long, and research can take ${count(limits.assumptionChars)}. Type a shorter version of it instead.`);
    }
    return { id, text, origin: { kind: "plan", index: place }, query };
  });
  return {
    scope: conversation.kind === "project" ? { kind: "project", headAtStart: content.headAtStart } : { kind: "general" },
    planText: content.text,
    assumptions,
    sites: selection.sites ? sitesOf(selection.sites) : null,
  };
}

/**
 * What no query may name: every project's label and folder name, and the paths the plan cites with more than one
 * segment (a bare name such as `setup.py` is a fair thing to search for), each once.
 */
export function researchDeny(projects: ReadonlyArray<{ label: string; nativePath: string }>, content: PlanContent): ResearchDeny {
  const terms = new Map<string, string>();
  for (const project of projects) {
    for (const term of [project.label, segments(project.nativePath).at(-1) ?? ""]) {
      const name = term.trim();
      if (name && !terms.has(name.toLowerCase())) terms.set(name.toLowerCase(), name);
    }
  }
  const paths = new Set(content.citations.map((citation) => citation.path).filter((path) => segments(path).length > 1));
  return { terms: [...terms.values()], paths: [...paths] };
}

/** Each query's problems, in the person's terms: none when it may be sent. The checks are best-effort, never a guarantee. */
export function queryChecks(packet: ResearchPacket, deny: ResearchDeny, known: KnownSecrets): Array<{ assumption: AssumptionId; problems: string[] }> {
  const values = known.map(([, value]) => value).filter((value) => value.length > 0);
  return packet.assumptions.map((assumption) => ({
    assumption: assumption.id,
    problems: queryProblems(assumption.query, deny, values).map((problem) => QUERY_PROBLEM_WORDS[problem]),
  }));
}

/**
 * What a preview is bound by: the plan's id and version, the packet's fingerprint (its text, assumptions, queries, sites
 * and limits) and the permissions as they were. Starting works it out again from the records as they are then, and
 * refuses when it differs, so research sends exactly the queries the person saw.
 */
export function researchFingerprint(parts: { planId: string; planVersion: number; packetDigest: string; webResearch: boolean; modelSharing: boolean | null }): string {
  const canonical = ["nivra.research-preview.v1", parts.planId, parts.planVersion, parts.packetDigest, parts.webResearch, parts.modelSharing];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Where a plan version is, as the host finds it now. */
export interface ResearchSubject {
  plan: ArtifactRecord;
  latestVersion: number;
  conversation: ConversationRecord;
  /** The conversation's project as it is now; null for a general conversation. */
  project: { label: string; targetLabel: string; modelSharing: boolean } | null;
}

/**
 * What the host knows besides the plan: the permission, whether each key is saved, the secrets, every project, and
 * whether the conversation is busy.
 */
export interface ResearchState {
  webResearch: boolean;
  tavilyKey: boolean;
  modelKey: boolean;
  known: KnownSecrets;
  projects: ReadonlyArray<{ label: string; nativePath: string }>;
  /** Why the conversation can't take another run now (D31); null when it can. */
  busy: string | null;
}

/**
 * Everything a research run of `subject` with `selection` would be: the preview, the run's input (ids and the packet's
 * fingerprint only), its context (held in the engine's memory, never stored) and the approved queries the workspace keeps.
 */
export async function researchRequest(
  subject: ResearchSubject,
  selection: ResearchSelection,
  state: ResearchState,
): Promise<{ preview: ResearchPreview; input: ResearchInput; context: ResearchContext; queries: ResearchQuery[] }> {
  const { plan, conversation, project } = subject;
  // A project's plan is checked only with its project's sharing, so a plan whose project is gone isn't checked at all.
  if (conversation.kind === "project" && !project) throw new Error("This plan's project was removed, so its assumptions can't be checked. Its history stays here until you delete it.");
  const packet = researchPacket(plan, conversation, selection, state.known);
  const deny = researchDeny(state.projects, plan.content as PlanContent);
  const checks = queryChecks(packet, deny, state.known);
  const packetDigest = await researchPacketDigest(packet);
  const modelSharing = project ? project.modelSharing : null;
  const failing = checks.find((check) => check.problems.length > 0);
  const limits = RESEARCH_LIMITS;
  const blocked =
    state.busy ??
    (subject.latestVersion !== plan.version
      ? `This is v${plan.version} of the plan, and v${subject.latestVersion} is the latest. Check v${subject.latestVersion} instead, so a version amended from what research finds can be saved.`
      : null) ??
    (!state.webResearch ? "Research queries to Tavily are turned off. Turn them on, then start again." : null) ??
    (!state.tavilyKey ? "Nivra has no Tavily API key. Add one in Settings, then start again." : null) ??
    (!state.modelKey ? "Nivra has no Token Factory API key. Add one in Settings, then start again." : null) ??
    (project && !project.modelSharing ? "This project doesn't allow sending its content to Token Factory. Allow sharing for it, then start research." : null) ??
    (failing ? `${failing.assumption}'s query ${failing.problems.join(", and ")}, so nothing can be sent. Edit it, then preview again.` : null);
  const assumptions = packet.assumptions.length;
  const preview: ResearchPreview = {
    planId: plan.id,
    planLineage: plan.lineageId,
    planVersion: plan.version,
    latestVersion: subject.latestVersion,
    scope: project
      ? { kind: "project", projectLabel: project.label, targetLabel: project.targetLabel, headAtStart: packet.scope.kind === "project" ? packet.scope.headAtStart : null, sharing: project.modelSharing }
      : { kind: "general" },
    tavily: { queries: packet.assumptions.map((assumption, index) => ({ assumption: assumption.id, query: assumption.query, problems: checks[index]!.problems })), sites: packet.sites },
    model: { planChars: packet.planText.length, assumptions: packet.assumptions.map((assumption) => ({ id: assumption.id, text: assumption.text, fromPlan: assumption.origin.kind === "plan" ? assumption.origin.index : null })) },
    // One search and at most one Extract an assumption, each at most one credit (an Extract reads at most five pages).
    limits: { searches: assumptions, extracts: assumptions, pages: limits.pageExtractions, credits: assumptions * 2, modelRequests: limits.modelRequests, seconds: limits.runMs / 1000 },
    webResearch: state.webResearch,
    blocked,
    expected: researchFingerprint({ planId: plan.id, planVersion: plan.version, packetDigest, webResearch: state.webResearch, modelSharing }),
  };
  return {
    preview,
    input: { planId: plan.id, planVersion: plan.version, packetDigest },
    context: { sharing: { modelContext: modelSharing === true, webResearch: state.webResearch }, deny, packet },
    queries: packet.assumptions.map((assumption) => ({ assumption: assumption.id, text: assumption.text, query: assumption.query })),
  };
}

/** What a report repeats of what it was bound to, for `reportMatches`. */
export interface ResearchBinding {
  planId: string;
  planVersion: number;
  packetDigest: string;
  scope: { kind: "general" } | { kind: "project"; headAtStart: string | null };
  request: { runId: string; clientRequestId: string };
  queries: ReadonlyArray<{ assumption: string; text: string; query: string }>;
}

/** Whether a report is the one this research asked for: its plan version, packet, scope, queries, request and run. */
export function researchReportMatches(report: ResearchBinding, research: ResearchRecord, runId: string): boolean {
  const queries = (list: ResearchBinding["queries"]) => JSON.stringify(list.map(({ assumption, text, query }) => [assumption, text, query]));
  return (
    report.planId === research.planId &&
    report.planVersion === research.planVersion &&
    report.packetDigest === research.packetDigest &&
    report.scope.kind === research.scope.kind &&
    (report.scope.kind === "general" || (research.scope.kind === "project" && report.scope.headAtStart === research.scope.headAtStart)) &&
    queries(report.queries) === queries(research.queries) &&
    report.request.clientRequestId === research.id &&
    report.request.runId === runId
  );
}

const SENT = "What was already sent can't be withdrawn, and nothing was resent.";

/**
 * What happened to research that ended without a complete report, in the person's terms; null while it goes, or once
 * complete. A stop is named by its own cause, which the run link alone can't tell apart.
 */
export function researchNoteFor(link: TurnRecord, stop: ResearchRecord["stop"]): string | null {
  switch (link.status) {
    case "failed":
      return `${link.errorMessage ?? "The research failed."} Nothing was resent.`;
    case "cancelled": {
      // What the host established about the stop (that nothing was sent, say) is kept: it says more than the default.
      const then = link.errorMessage ?? SENT;
      switch (stop?.cause) {
        case "web-research":
          return `Stopped: research queries to Tavily were turned off. ${then}`;
        case "model-sharing":
          return `Stopped: sharing for this project was turned off. ${then}`;
        case "removal":
          // A stop that worked is kept when the removal is refused for another run, so this claims only that it was
          // asked.
          return `Stopped: the project was being removed. ${then}`;
        default:
          return `Cancelled. ${then}`;
      }
    }
    case "interrupted":
      return "Interrupted: Nivra or its engine stopped before the research finished. A request it was making may have been sent, and its credits are unknown. Nothing was resent.";
    case "not-sent":
      return link.errorMessage ?? "Not sent: nothing reached Tavily or Token Factory.";
    case "unknown":
      return `Nivra can't tell whether this research reached Tavily or Token Factory: ${link.errorMessage ?? "its engine can't say"}. Nothing was resent.`;
    default:
      return null;
  }
}

/** The amended version's text and assumptions as the person saves them, checked as a plan's text and a brief's items are. */
export function amendedPlanFields(text: string, assumptions: readonly string[], known: KnownSecrets): { text: string; assumptions: string[] } {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("A plan needs some text.");
  if (trimmed.length > TASK_LIMITS.planChars) throw new Error(`That plan is ${count(trimmed.length)} characters long, and a plan can hold ${count(TASK_LIMITS.planChars)}. Shorten it, then save it again.`);
  refuseCredentials("The plan", trimmed, known);
  // Numbered as written, blank lines included, as a brief's items are.
  assumptions.forEach((written, index) => {
    const item = written.trim();
    if (item.length > TASK_LIMITS.itemChars) throw new Error(`Assumption ${index + 1} is ${count(item.length)} characters long, and an assumption can hold ${count(TASK_LIMITS.itemChars)}. Shorten it, then save it again.`);
    if (item) refuseCredentials(`Assumption ${index + 1}`, item, known);
  });
  const items = assumptions.map((item) => item.trim()).filter(Boolean);
  if (items.length > TASK_LIMITS.items) throw new Error(`A plan can list ${TASK_LIMITS.items} assumptions, and this one lists ${items.length}. Remove ${items.length - TASK_LIMITS.items}, then save it again.`);
  return { text: trimmed, assumptions: items };
}

/**
 * The amended version's content: the researched version's, with the person's text and assumptions. Nothing about the
 * research is added, since every later edit copies a version's content forward; the research row records the version
 * it led to.
 */
export function amendedContent(researched: PlanContent, fields: { text: string; assumptions: string[] }): PlanContent {
  return { ...researched, text: fields.text, assumptions: fields.assumptions };
}
