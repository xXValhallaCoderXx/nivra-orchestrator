import { VISUAL_MODEL, referenceText, type FrozenReferenceContext } from "@nivra/domain";
import { failure, type ModelPrompt } from "./model.ts";

/** Images are content, not text URLs. Mastra retains the user message across its tool rounds. */
export function referencePrompt(text: string, context: FrozenReferenceContext | undefined): ModelPrompt {
  const body = `${text}${context ? `\nSupporting task context:\n${referenceText(context)}` : ""}`;
  const images = context?.attachments.flatMap((item) => item.image ? [{ type: "image" as const, image: `data:image/png;base64,${item.image.base64}`, mimeType: "image/png" as const }] : []) ?? [];
  return images.length ? [{ type: "text", text: body }, ...images] : body;
}
export function referenceModel(ids: readonly string[], allowed: readonly string[] | undefined, context: FrozenReferenceContext | undefined): string | null {
  if (!context?.attachments.some((item) => item.image)) return null;
  const model = ids.find((id) => id.toLowerCase() === VISUAL_MODEL.toLowerCase());
  if (!model || (allowed && !allowed.some((id) => id.toLowerCase() === model.toLowerCase()))) throw failure("model-unavailable", "Selected images require nvidia/Nemotron-3.5-Super-VL, available for this key and covered by this grant. Enable that route or deselect the images; no other model or text-only request will be substituted.");
  return model;
}
