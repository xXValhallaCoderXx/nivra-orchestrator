import { RESEARCH_LIMITS } from "./limits.ts";
import type { SearchHit } from "./retrieval.ts";
import { sameAddress } from "./tavily.ts";

/**
 * Which pages a research run reads (NIV-45). Every address Search returned is checked before it can go back to Tavily:
 * https only, no user or password, a named public host, no credential in it, and within the length limit. A page found
 * by several assumptions is one page that keeps each association. Extraction is chosen fairly: round robin across the
 * assumptions, by rank, at most five page extractions in all; a page two assumptions found may be read under each one's
 * query, since Extract ranks a page's passages against one query only.
 */

export type AssumptionId = "A1" | "A2" | "A3";

export interface Page {
  id: string;
  address: string;
  /** In punycode, as the URL parser gives it: a lookalike name can't pass for another. */
  host: string;
  title: string;
  foundBy: Array<{ assumption: AssumptionId; rank: number }>;
  extractedFor: AssumptionId[];
  status: "read" | "not-read" | "failed" | "refused";
}

/** A surrogate without its pair: it encodes nothing, and JSON writes it as six characters. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * Characters that change how text reads without being seen: every format character (direction marks and overrides,
 * zero-width marks, soft hyphens, tag characters) and the variation selectors.
 */
const INVISIBLE = /[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** Control characters other than tab and line breaks. */
const CONTROL = /(?![\t\n\r])\p{Cc}/gu;

/**
 * Text from the web or a model, made safe to show, to quote and to keep: well formed (a lone surrogate becomes U+FFFD),
 * with no invisible marks and no control characters.
 */
export function plainText(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD").replace(INVISIBLE, "").replace(CONTROL, "");
}

const PRIVATE_SUFFIXES = ["internal", "local", "localhost", "lan", "corp", "home", "intranet", "private", "test", "example", "invalid"];

/**
 * Why an address Search returned can't be read or shown as a source; null when it can. The fragment is never sent, so it
 * isn't part of the check. `mask` is the vault's values, then the credential shapes: an address it would change holds a
 * secret, so one that goes back to Tavily is always the same masked or not.
 */
export function addressProblem(address: string, mask: (text: string) => string): "too-long" | "not-https" | "credentials" | "address-literal" | "private-host" | "secret" | "unreadable" | null {
  if (address.length > RESEARCH_LIMITS.addressChars) return "too-long";
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "unreadable";
  }
  if (url.protocol !== "https:") return "not-https";
  if (url.username || url.password) return "credentials";
  // A name and the same name with the root's trailing dot are one host: checked without the dot.
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return "address-literal";
  const labels = host.split(".");
  if (labels.some((label) => label === "")) return "unreadable";
  if (labels.length < 2 || PRIVATE_SUFFIXES.includes(labels.at(-1)!) || labels.includes("localhost")) return "private-host";
  if (mask(address) !== address) return "secret";
  return null;
}

/** The address as it is sent and shown: without its fragment. */
function withoutFragment(address: string): string {
  try {
    const url = new URL(address);
    url.hash = "";
    return url.toString();
  } catch {
    return address;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * An address as the report keeps it. One that can go back to Tavily is kept as the URL parser wrote it, which is ASCII;
 * a refused one is masked, since it may be refused for holding a secret, and percent-encoded when it couldn't be parsed,
 * so it takes no more room than its length.
 */
function keptAddress(address: string, refused: boolean, mask: (text: string) => string): string {
  if (!refused) return address;
  const masked = mask(plainText(address));
  return clip(/^[\x20-\x7E]*$/.test(masked) ? masked : encodeURI(masked), RESEARCH_LIMITS.addressChars);
}

/**
 * The run's pages, from each assumption's hits in rank order: one page per address, each with every assumption whose
 * search found it. Refused addresses are kept as refused, masked, so the report says what was found and not used.
 * Titles are made plain and masked, as passages are: the model reads them.
 */
export function collectPages(found: ReadonlyArray<{ assumption: AssumptionId; hits: readonly SearchHit[] }>, mask: (text: string) => string): Page[] {
  const pages: Page[] = [];
  // The addresses as Search gave them (without fragments), page by page: a refused page keeps only a masked one.
  const addresses: string[] = [];
  for (const { assumption, hits } of found) {
    hits.slice(0, RESEARCH_LIMITS.resultsPerSearch).forEach((hit, index) => {
      const address = withoutFragment(hit.address);
      const existing = addresses.findIndex((seen) => sameAddress(seen, address));
      if (existing >= 0) {
        const page = pages[existing]!;
        if (!page.foundBy.some((entry) => entry.assumption === assumption)) page.foundBy.push({ assumption, rank: index + 1 });
        return;
      }
      if (pages.length >= RESEARCH_LIMITS.pages) return;
      let host = "";
      try {
        host = new URL(address).hostname;
      } catch {
        host = "";
      }
      const refused = addressProblem(address, mask) !== null;
      addresses.push(address);
      pages.push({
        id: `S${pages.length + 1}`,
        address: keptAddress(address, refused, mask),
        host: clip(host, RESEARCH_LIMITS.siteChars),
        title: clip(mask(plainText(hit.title)).replace(/\s+/g, " ").trim(), RESEARCH_LIMITS.titleChars),
        foundBy: [{ assumption, rank: index + 1 }],
        extractedFor: [],
        status: refused ? "refused" : "not-read",
      });
    });
  }
  return pages;
}

/**
 * The page extractions, by assumption: round robin across the assumptions, each taking its next best-ranked page that
 * can be read, until five are chosen or none is left. A page may be chosen for two assumptions; each choice counts.
 */
export function chooseExtractions(pages: readonly Page[], order: readonly AssumptionId[]): Map<AssumptionId, Page[]> {
  const queues = new Map(
    order.map((assumption) => [
      assumption,
      pages
        .filter((page) => page.status !== "refused")
        .flatMap((page) => page.foundBy.filter((entry) => entry.assumption === assumption).map((entry) => ({ page, rank: entry.rank })))
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => entry.page),
    ]),
  );
  const chosen = new Map<AssumptionId, Page[]>(order.map((assumption) => [assumption, []]));
  let total = 0;
  for (let round = 0; total < RESEARCH_LIMITS.pageExtractions; round++) {
    let any = false;
    for (const assumption of order) {
      const page = queues.get(assumption)![round];
      if (!page) continue;
      any = true;
      if (total >= RESEARCH_LIMITS.pageExtractions) break;
      chosen.get(assumption)!.push(page);
      total++;
    }
    if (!any) break;
  }
  return chosen;
}
