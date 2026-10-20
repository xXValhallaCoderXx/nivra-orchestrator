import { largestReport } from "../../src/review/answers.ts";
import { CHAIR_INSTRUCTIONS, renderChairMessage, renderPacket, reviewerInstructions } from "../../src/review/prompt.ts";
import { estimateRequest, REVIEW_LIMITS, REVIEW_REQUEST_MS } from "../../src/review/run.ts";
import { ARMS, FIXTURE_IDS, requestFor, runOrder, type Arm, type FixtureId, type Frozen } from "./files.ts";

/**
 * The approval request (NIV-40): everything a paid batch would do, worked out from the same code that builds its
 * requests, and printed without touching the network or starting an engine.
 */

const n = (value: number) => value.toLocaleString("en");
const count = (value: number, one: string, many = `${one}s`) => `${n(value)} ${value === 1 ? one : many}`;
const unmasked = (text: string) => text;

/** Where the frozen protocol and the engine disagree about a limit; empty when they agree. */
export function limitMismatches(frozen: Frozen): string[] {
  const problems: string[] = [];
  for (const arm of ARMS) {
    const frozenLimits = frozen.protocol.limits[arm];
    const engine = REVIEW_LIMITS[arm];
    for (const field of ["requests", "totalMs", "outputTokensPerRequest", "estimatedInputTokens"] as const) {
      if (frozenLimits[field] !== engine[field]) problems.push(`${arm} ${field}: the protocol says ${frozenLimits[field]}, the engine ${engine[field]}`);
    }
  }
  if (frozen.protocol.requestMs !== REVIEW_REQUEST_MS) problems.push(`requestMs: the protocol says ${frozen.protocol.requestMs}, the engine ${REVIEW_REQUEST_MS}`);
  if (frozen.protocol.sampling.maxOutputTokens !== REVIEW_LIMITS.council.outputTokensPerRequest) problems.push("sampling.maxOutputTokens differs from the engine's output cap");
  return problems;
}

/** A request's estimated input as the engine admits it: one reviewer's, and the chair's at its largest. */
export function estimates(frozen: Frozen, fixture: FixtureId): { reviewer: number; chair: number } {
  const request = requestFor(frozen, fixture, "council", "00000000-0000-4000-8000-000000000000");
  const message = renderPacket(request.context.packet, request.context.preferences, unmasked);
  return {
    reviewer: estimateRequest(reviewerInstructions("architecture"), message, "reviewer"),
    chair: estimateRequest(CHAIR_INSTRUCTIONS, renderChairMessage(message, [largestReport("architecture"), largestReport("risks")], unmasked), "chair"),
  };
}

export function approvalRequest(frozen: Frozen, revision: { commit: string | null; dirty: boolean }): string[] {
  const { protocol } = frozen;
  const limits = (arm: Arm) => protocol.limits[arm];
  const lines = [
    "Council evaluation (NIV-40): the request for approval. Nothing here touches the network or starts an engine.",
    "",
    `Revision: ${revision.commit ?? "unknown"}${revision.dirty ? " (the working tree has uncommitted changes: a paid batch refuses to run until they are committed)" : ""}`,
    `Approval digest: ${frozen.approvalDigest}`,
    "  It covers the five fixtures, the rubric and the protocol, read as data. A change to any of them changes it.",
    `Model: ${protocol.model}, as the engine picks it.`,
    `Sampling: temperature and top_p left to the provider; at most ${n(protocol.sampling.maxOutputTokens)} output tokens a request; the answer tool ${protocol.sampling.toolChoice}.`,
    "",
    `Runs, one at a time, in this order: at most ${protocol.runner.maxRequests} requests, no retries and no retakes.`,
  ];
  runOrder().forEach(({ fixture, arm }, index) => {
    const request = requestFor(frozen, fixture, arm, "00000000-0000-4000-8000-000000000000");
    const { packet, preferences, sharing } = request.context;
    lines.push(
      `  ${String(index + 1).padStart(2)}. ${fixture} ${arm.padEnd(7)} ${packet.scope.kind} plan${sharing.modelContext ? " (sent with consent: synthetic)" : ""}: ${count(packet.text.length, "character")}, ${count(packet.assumptions.length, "assumption")}, ${count(packet.references.length, "historical reference")}, ${count(preferences.records.length, "preference")}. At most ${count(limits(arm).requests, "request")}, ${limits(arm).totalMs / 1000} s.`,
    );
  });
  lines.push("", "What is sent, for each fixture: its synthetic plan, its assumptions and, for f2, three historical references (paths and lines, never content).");
  lines.push("No repository, no path on this computer, no conversation, and an empty preference snapshot for both arms. Both arms get the same packet.");
  lines.push("", "Fixtures, by packet fingerprint, with each request's estimated input (one reviewer; the chair at its largest):");
  for (const id of FIXTURE_IDS) {
    const fixture = frozen.fixtures.find((f) => f.id === id)!;
    const estimate = estimates(frozen, id);
    lines.push(`  ${id} ${frozen.packetDigests[id].slice(0, 16)}  ${fixture.title}: about ${n(estimate.reviewer)} tokens per reviewer, ${n(estimate.chair)} reserved for the chair`);
  }
  const worstMs = runOrder().reduce((sum, { arm }) => sum + limits(arm).totalMs + protocol.runner.cancelMarginMs + protocol.runner.reconcileMs, 0);
  lines.push(
    "",
    "Before each run, with no inference request (the batch stops, and nothing is sent, on a mismatch):",
    "  - where the engine sends its requests, from its doctor, which reaches no network;",
    "  - the model it would pick, from Token Factory's model listing (GET /models), read with the engine's own client and its own pick;",
    "  - the sampling it gives that model, from the engine's own policy.",
    "  The engine reads the listing again inside its run. A listing that changed in the moment between is caught by the check after the run, which stops the batch.",
    "",
    "Hard limits, per run:",
    `  single:  ${limits("single").requests} request, ${limits("single").totalMs / 1000} s, ${n(limits("single").outputTokensPerRequest)} output tokens a request`,
    `  council: ${limits("council").requests} requests (two reviewers together, then the chair), ${limits("council").totalMs / 1000} s, ${n(limits("council").outputTokensPerRequest)} output tokens a request`,
    `  Each request is aborted at ${protocol.requestMs / 1000} s. The runner cancels a run still going at its limit plus ${protocol.runner.cancelMarginMs / 1000} s, and gives it ${protocol.runner.reconcileMs / 1000} s more to settle.`,
    "  A run still going after that is kept as unresolved, the batch stops, and it is never sent again. Every wait while following a run is bounded.",
    `Estimated input budgets (estimates that decide admission, not ceilings): single ${n(limits("single").estimatedInputTokens)} tokens, council ${n(limits("council").estimatedInputTokens)}.`,
    `The batch: at most ${protocol.runner.batchMs / 60_000} minutes; a run that couldn't end within them, windows included, isn't started. With every run at its limit, the batch takes ${(worstMs / 60_000).toFixed(1)} minutes.`,
    "",
    "Stops:",
    ...protocol.stops.map((stop) => `  - ${stop}`),
    "",
    "Decision, council against the single reviewer over the five fixtures:",
    `  inconclusive: ${protocol.decision.inconclusive}`,
    `  defer: ${protocol.decision.defer}`,
    `  adopt: ${protocol.decision.adopt}`,
    `  simplify: ${protocol.decision.simplify}`,
    "",
    protocol.labelling === "pending"
      ? "Labelling: not chosen yet. Before approving, choose who labels the blinded sheet: you (about 30 minutes), or me, blind, with you reviewing my labels. The choice goes in protocol.json, which changes the approval digest."
      : protocol.labelling === "nate"
        ? "Labelling: you label the blinded sheet. Which arm and reviewer each line came from is never written down: it is worked out again only when the labelled sheet is scored."
        : "Labelling: I label the blinded sheet, blind, and you review my labels.",
    "",
    "Evidence: ~/nivra-acceptance/council-eval-<UTC>-<revision>/ (0700): the journal, written before each request; every run's summary, events and",
    "report; the engine's home and log; the blinded sheet and its key; the scores; decision.md.",
    "",
    "Once approved, the batch runs with:",
    `  pnpm council:eval --credentials <file> --approved ${frozen.approvalDigest}`,
    "The file holds a NEBIUS_API_KEY=… line, outside the repository, readable only by you (chmod 600). The batch uses the key to read the model listing",
    "before each run, and the engine gets it only through initialize. It is never printed or written.",
  );
  return lines;
}
