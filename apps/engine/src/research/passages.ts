import { RESEARCH_LIMITS } from "./limits.ts";
import { plainText, type AssumptionId, type Page } from "./pages.ts";
import { CHUNK_SEPARATOR, type ExtractedPage } from "./retrieval.ts";

/**
 * Passages: the only text from the web the model sees, and the only text it may cite (NIV-45). Extract returns a page's
 * selected chunks joined by `CHUNK_SEPARATOR`; each chunk becomes its own passage, so a quotation can never span text
 * that was left out between two. Nivra's own limits apply whatever the service sends, and every passage is made plain
 * (no invisible marks, no control characters) and masked with the vault's values and the credential shapes before the
 * model sees it: quotations are later checked against exactly this text.
 */

export interface Passage {
  /** `S3.2`: the third page's second passage, across all the extractions that read it. */
  id: string;
  page: string;
  /** Whose query ranked it. */
  assumption: AssumptionId;
  /** Its place among its extraction's chunks, from 1. */
  chunk: number;
  heading: string | null;
  text: string;
  clipped: boolean;
  retrievedAt: string;
}

const SEPARATOR = new RegExp(`\\s*${CHUNK_SEPARATOR.replace(/[.[\]]/g, "\\$&")}\\s*`);
const DELIMITER = /\[(\s*)(passage|end of passage)/gi;

/** Page text with any lookalike of the message's delimiters made plain, so only Nivra's delimiters frame a passage. */
export function neutralised(text: string): string {
  return text.replace(DELIMITER, "($1$2");
}

const HEADING =/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

/** A page's content split into its chunks: one when there is no separator. Empty chunks are dropped. */
export function chunksOf(content: string): string[] {
  return content
    .split(SEPARATOR)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/** At most `max` characters, cut at the last space before the limit when there is one, and marked when cut. */
function clipAtWord(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return { text: `${(space > max / 2 ? room.slice(0, space) : room).trimEnd()}…`, clipped: true };
}

/**
 * One extraction's passages, after those the run already has: at most three from it, and no more than the run's limit
 * in all. `mask` is the vault's values, then the credential shapes.
 */
export function passagesFrom(
  extraction: { assumption: AssumptionId; pages: readonly ExtractedPage[] },
  pages: readonly Page[],
  before: readonly Passage[],
  options: { mask: (text: string) => string; retrievedAt: string },
): Passage[] {
  const made: Passage[] = [];
  for (const extracted of extraction.pages) {
    const page = pages.find((candidate) => candidate.address === extracted.address);
    if (!page) continue;
    const chunks = chunksOf(extracted.content).slice(0, RESEARCH_LIMITS.passagesPerExtraction);
    chunks.forEach((chunk, index) => {
      if (before.length + made.length >= RESEARCH_LIMITS.passages) return;
      const ofPage = [...before, ...made].filter((passage) => passage.page === page.id).length;
      // Masked before it is clipped, so no part of a secret can survive at the cut; and stored as the model will read it.
      const masked = neutralised(options.mask(plainText(chunk)));
      const { text, clipped } = clipAtWord(masked, RESEARCH_LIMITS.passageChars);
      const firstLine = text.split("\n", 1)[0] ?? "";
      const heading = HEADING.exec(firstLine)?.[1] ?? null;
      made.push({
        id: `${page.id}.${ofPage + 1}`,
        page: page.id,
        assumption: extraction.assumption,
        chunk: index + 1,
        heading: heading ? clipAtWord(heading, RESEARCH_LIMITS.headingChars).text : null,
        text,
        clipped,
        retrievedAt: options.retrievedAt,
      });
    });
  }
  return made;
}
