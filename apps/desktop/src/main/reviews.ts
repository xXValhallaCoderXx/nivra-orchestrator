import { createHash } from "node:crypto";
import { REVIEW_PACKET_LIMITS, ReviewPacket, type ReviewPanel, type ReviewReport } from "@nivra/domain";
import { maskForStorage, refuseCredentials, type KnownSecrets } from "./protect.ts";
import type { PlanContent } from "./tasks.ts";
import type { ArtifactRecord, ConversationRecord, ReviewRecord, TurnRecord } from "./workspace.ts";

/**
 * Reviews of saved plan versions (D31), as plain functions: the packet a version sends, the fingerprint a preview is
 * bound by, and the check that a report is the one a review asked for. No Electron (D12).
 */

/** The most model calls a review makes: two reviewers and a chair, or one reviewer (D30). */
export const REVIEW_REQUESTS: Readonly<Record<ReviewPanel, number>> = { council: 3, single: 1 };

/** Where a plan's answer looked, each place once, in the order it was first cited: the packet's E1, E2, … */
export function historicalReferences(content: PlanContent): Array<{ path: string; startLine: number; endLine: number }> {
  const seen = new Set<string>();
  return content.citations.filter((citation) => {
    const key = JSON.stringify([citation.path, citation.startLine, citation.endLine]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const PARTS: Readonly<Record<string, string>> = { text: "text", assumptions: "assumptions", references: "historical references", scope: "commit" };

/**
 * The packet a plan version sends for review (D31): its text, its assumptions and, for a project's plan, where the
 * answer it came from looked. Nothing else of the conversation goes. The text, which the person may have written, is
 * refused when it holds a credential; what came from the engine is masked again, as everything the workspace keeps is.
 * A version over a review's limits is refused in words that say which limit.
 */
export function packetFor(plan: ArtifactRecord, conversation: ConversationRecord, known: KnownSecrets): ReviewPacket {
  const content = plan.content as PlanContent;
  const max = REVIEW_PACKET_LIMITS.textChars;
  if (content.text.length > max) {
    throw new Error(`This plan version is ${content.text.length.toLocaleString("en")} characters long, and a review can take ${max.toLocaleString("en")}. Edit the plan to shorten it, then review the new version.`);
  }
  refuseCredentials("This plan version", content.text, known, "review");
  const parsed = ReviewPacket.safeParse({
    scope: conversation.kind === "project" ? { kind: "project", headAtStart: content.headAtStart } : { kind: "general" },
    text: content.text,
    assumptions: content.assumptions.map((assumption) => maskForStorage(assumption, known)),
    references: conversation.kind === "project" ? historicalReferences(content).map((reference) => ({ ...reference, path: maskForStorage(reference.path, known) })) : [],
  });
  if (!parsed.success) {
    const part = PARTS[String(parsed.error.issues[0]?.path[0] ?? "")] ?? "contents";
    throw new Error(`This plan version's ${part} can't be sent for review as saved, so nothing was sent. Save the answer it came from as a new plan, then review that.`);
  }
  return parsed.data;
}

/**
 * What a preview is bound by (D31): the plan's id and version, the packet's and the preferences' fingerprints, the
 * project's sharing and the panel. Starting works it out again from the records as they are then, and refuses when it
 * differs, so a review sends exactly what the person saw.
 */
export function previewFingerprint(parts: { planId: string; planVersion: number; packetDigest: string; preferencesDigest: string; sharing: boolean | null; panel: ReviewPanel }): string {
  const canonical = ["nivra.review-preview.v1", parts.planId, parts.planVersion, parts.packetDigest, parts.preferencesDigest, parts.sharing, parts.panel];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Whether a report is the one this review asked for: its plan version, both fingerprints, panel, request and run. */
export function reportMatches(report: ReviewReport, review: ReviewRecord, runId: string): boolean {
  return (
    report.planId === review.planId &&
    report.planVersion === review.planVersion &&
    report.packetDigest === review.packetDigest &&
    report.preferencesDigest === review.preferencesDigest &&
    report.panel === review.panel &&
    report.request.clientRequestId === review.id &&
    report.request.runId === runId
  );
}

/** What happened to a review that ended without a complete report, in the person's terms; null while it goes, or once complete. */
export function reviewNoteFor(link: TurnRecord): string | null {
  switch (link.status) {
    case "failed":
      return `${link.errorMessage ?? "The review failed."} Nothing was resent.`;
    case "cancelled":
      return link.cancelReason === "sharing"
        ? "Stopped: sharing for this project was turned off. Nothing was resent."
        : link.cancelReason === "removal"
          ? "Stopped: the project was removed. Nothing was resent."
          : link.errorMessage
            ? `Cancelled. ${link.errorMessage}`
            : "Cancelled. Nothing was resent.";
    case "interrupted":
      return "Interrupted: Nivra or its engine stopped before the review finished. Nothing was resent.";
    case "not-sent":
      return link.errorMessage ?? "Not sent: nothing reached the model.";
    case "unknown":
      return `Nivra can't tell whether this review reached the model: ${link.errorMessage ?? "its engine can't say"}. Nothing was resent.`;
    default:
      return null;
  }
}
