/**
 * The research limits (NIV-45), as the engine enforces them. They mirror `RESEARCH_LIMITS` in
 * `packages/domain/src/research.ts`, which isn't exported until research's integration window; a test keeps the two the
 * same, and the integration replaces this file with the domain's export.
 */
export const RESEARCH_LIMITS = {
  assumptions: 3,
  assumptionChars: 300,
  queryChars: 400,
  sites: 5,
  siteChars: 253,
  planChars: 20_000,
  searches: 3,
  resultsPerSearch: 5,
  extracts: 3,
  pageExtractions: 5,
  passagesPerExtraction: 3,
  passageChars: 1_000,
  passages: 15,
  pages: 15,
  addressChars: 2_048,
  titleChars: 300,
  headingChars: 200,
  quoteMinChars: 20,
  quoteMaxChars: 300,
  quoteMinWords: 4,
  citationsPerAssessment: 6,
  searchBodyBytes: 1_048_576,
  extractBodyBytes: 2_097_152,
  searchMs: 30_000,
  extractMs: 45_000,
  extractTimeoutSeconds: 40,
  retrievalCutoffMs: 90_000,
  modelMs: 150_000,
  runMs: 240_000,
  modelRequests: 1,
  outputTokens: 4_000,
  inputTokens: 60_000,
  reasoningChars: 1_500,
  uncertaintyChars: 600,
  applicabilityChars: 200,
  amendmentChars: 1_000,
} as const;

export type ResearchLimits = typeof RESEARCH_LIMITS;
