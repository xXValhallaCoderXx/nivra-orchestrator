import type { Defect } from "./files.ts";

/**
 * The rubric's automatic pass (NIV-40): whether a reviewer's finding names a known defect, by word stems, so the first
 * reading of every report is the same however many times it is run. It never decides alone: the blinded sheet confirms
 * or corrects it.
 */

/** Text as the rubric reads it: lower case, curly quotes straightened, spaces collapsed. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = new Map<string, RegExp>();

/** A stem matches at the start of a word; one written with a leading "=" must be the whole word. */
export function stemMatches(normalised: string, stem: string): boolean {
  let pattern = patterns.get(stem);
  if (!pattern) {
    const whole = stem.startsWith("=");
    pattern = new RegExp(`(?<![a-z0-9])${escape(normalise(whole ? stem.slice(1) : stem))}${whole ? "(?![a-z0-9])" : ""}`);
    patterns.set(stem, pattern);
  }
  return pattern.test(normalised);
}

/** Whether `text` names `defect`: every one of its groups has a stem in it. */
export function defectMatches(text: string, defect: Defect): boolean {
  const normalised = normalise(text);
  return defect.match.all.every((group) => group.some((stem) => stemMatches(normalised, stem)));
}

/** What the rubric reads of a finding: its title, detail and recommendation. */
export const findingText = (finding: { title: string; detail: string; recommendation: string }): string => `${finding.title}\n${finding.detail}\n${finding.recommendation}`;

/** The known defects a finding names, by id, in the rubric's order. */
export const matchedDefects = (finding: { title: string; detail: string; recommendation: string }, defects: readonly Defect[]): string[] =>
  defects.filter((defect) => defectMatches(findingText(finding), defect)).map((defect) => defect.id);
