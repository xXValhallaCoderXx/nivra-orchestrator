import type { ChatResult } from "@nivra/domain";

/**
 * A plan's text as Nivra makes it from an answer (D26): a general answer's text, or a repository answer followed by
 * what it proposed and what it assumed, each under its own heading. The window shows it to edit before it is saved,
 * and main saves it, so what is shown is what is saved.
 */
export function planText(reply: ChatResult): string {
  if (reply.kind === "general") return reply.text;
  const parts = [reply.answer];
  if (reply.proposals.length) parts.push(`Proposed:\n${reply.proposals.map((p) => `- ${p.title}: ${p.detail}`).join("\n")}`);
  if (reply.assumptions.length) parts.push(`Assumed:\n${reply.assumptions.map((a) => `- ${a}`).join("\n")}`);
  return parts.join("\n\n");
}
