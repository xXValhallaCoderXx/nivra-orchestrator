import { secretShapes } from "@nivra/domain";
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

/** Characters that change how text reads without being seen: direction marks and overrides, zero-width marks. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Text from the web, made safe to show and to quote: no invisible marks, no control characters. */
export function plainText(text: string): string {
  return text.replace(INVISIBLE, "").replace(CONTROL, "");
}

const PRIVATE_SUFFIXES = ["internal", "local", "localhost", "lan", "corp", "home", "intranet", "private", "test", "example", "invalid"];

/**
 * Why an address Search returned can't be read or shown as a source; null when it can. The fragment is never sent, so it
 * isn't part of the check; `knownValues` are the vault's.
 */
export function addressProblem(address: string, knownValues: readonly string[] = []): "too-long" | "not-https" | "credentials" | "address-literal" | "private-host" | "secret" | "unreadable" | null {
  if (address.length > RESEARCH_LIMITS.addressChars) return "too-long";
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "unreadable";
  }
  if (url.protocol !== "https:") return "not-https";
  if (url.username || url.password) return "credentials";
  const host = url.hostname;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return "address-literal";
  const labels = host.split(".");
  if (labels.length < 2 || PRIVATE_SUFFIXES.includes(labels.at(-1)!) || labels.includes("localhost")) return "private-host";
  if (secretShapes(address).length > 0 || knownValues.some((value) => value.length >= 8 && address.includes(value))) return "secret";
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
 * The run's pages, from each assumption's hits in rank order: one page per address, each with every assumption whose
 * search found it. Refused addresses are kept as refused, so the report says what was found and not used.
 */
export function collectPages(found: ReadonlyArray<{ assumption: AssumptionId; hits: readonly SearchHit[] }>, knownValues: readonly string[] = []): Page[] {
  const pages: Page[] = [];
  for (const { assumption, hits } of found) {
    hits.slice(0, RESEARCH_LIMITS.resultsPerSearch).forEach((hit, index) => {
      const address = withoutFragment(hit.address);
      const existing = pages.find((page) => sameAddress(page.address, address));
      if (existing) {
        if (!existing.foundBy.some((entry) => entry.assumption === assumption)) existing.foundBy.push({ assumption, rank: index + 1 });
        return;
      }
      if (pages.length >= RESEARCH_LIMITS.pages) return;
      let host = "";
      try {
        host = new URL(address).hostname;
      } catch {
        host = "";
      }
      const refused = addressProblem(address, knownValues) !== null;
      pages.push({
        id: `S${pages.length + 1}`,
        address: clip(plainText(address), RESEARCH_LIMITS.addressChars),
        host: clip(host, RESEARCH_LIMITS.siteChars),
        title: clip(plainText(hit.title).replace(/\s+/g, " ").trim(), RESEARCH_LIMITS.titleChars),
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
