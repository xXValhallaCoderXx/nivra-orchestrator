import { createTool } from "@mastra/core/tools";
import type { JsonObject, RunContext } from "@nivra/domain";
import { z } from "zod";
import type { InternalFailure } from "../providers/model.ts";
import { LIMITS, type Delivered, type RepoReader } from "../repo/files.ts";
import { RepoCancelled } from "../repo/git.ts";
import { RepoError } from "../repo/paths.ts";
import type { Mask } from "../secrets/patterns.ts";
import { ANSWER_TOOL_DESCRIPTION, AnswerInput } from "./answer.ts";
import type { Budget } from "./budget.ts";
import { checkCitation, type CheckedCitation } from "./citations.ts";
import type { Ledger, LedgerKind } from "./ledger.ts";

/**
 * The explain run's tools (D22), from Hird's `projects/tools.ts` @ 45c0057: list, search and read the repository, and
 * submit the answer. Every result is charged to the budget before it is returned (tool calls run one at a time), and
 * what it delivered is written to the ledger with the step it was delivered in. The tools never throw: an expected
 * refusal goes back to the model as `{ refused }`; anything unexpected is recorded as an internal failure, which stops
 * the run as a failure, never as a cancellation. An answer citing lines the model wasn't shown is turned down, naming
 * them, while it still has time to read them; when the answer is due, or after two such refusals, it is accepted and
 * its citations are labelled for what they are.
 */

export interface ToolEvent {
  message: string;
  data: JsonObject;
}

export interface ExplainToolsState {
  /** The first accepted answer; later ones are refused. */
  accepted: z.infer<typeof AnswerInput> | null;
  /** The step it was submitted in: only what was delivered before it can check a citation. */
  answerStep: number | null;
  /** Answers that failed validation. */
  rejected: number;
  /** Answers turned down for citing lines the model wasn't shown. */
  citationRefusals: number;
  budgetExhausted: boolean;
}

export interface ExplainToolsOptions {
  reader: RepoReader;
  ledger: Ledger;
  budget: Budget;
  mask: Mask;
  internal: InternalFailure;
  /** The step in progress: the number of steps finished so far. */
  step: () => number;
  /** Whether this step must give the answer: then it is accepted whatever it cites. */
  answerDue: () => boolean;
  preferences: RunContext["preferences"];
  signal?: AbortSignal | undefined;
  onTool: (event: ToolEvent) => void;
}

const BUDGET_NOTE = "The context budget for this run is used up: submit your answer now, from what you have read.";
/** How many times an answer is turned down for its citations before it is accepted as it is. */
export const MAX_CITATION_REFUSALS = 2;
/** The problems a model can fix by reading, or by dropping the citation. */
const FIXABLE: ReadonlySet<CheckedCitation["problem"]> = new Set(["file not read", "lines not shown", "not a repository path"]);

export function createExplainTools(options: ExplainToolsOptions): { tools: Record<string, ReturnType<typeof createTool>>; state: ExplainToolsState } {
  const { reader, ledger, budget, mask, internal } = options;
  const state: ExplainToolsState = { accepted: null, answerStep: null, rejected: 0, citationRefusals: 0, budgetExhausted: false };

  /** Masks a result as JSON and checks it fits; a result that doesn't is replaced, and delivers nothing. */
  const finish = (result: unknown, cap: number): { value: unknown; json: string; fits: boolean } => {
    const json = mask(JSON.stringify(result));
    if (json.length <= cap) return { value: JSON.parse(json), json, fits: true };
    const note = { truncated: true, note: "That result was too large to send; narrow the request." };
    return { value: note, json: JSON.stringify(note), fits: false };
  };

  /** Runs one tool call: budget, the call itself, the ledger and the timeline, never a throw. */
  const run = async (tool: string, input: JsonObject, body: (cap: number) => Promise<{ result: unknown; delivered: Delivered[]; kind: LedgerKind | null; describe: (result: unknown) => { message: string; data: JsonObject } }>) => {
    const started = performance.now();
    const step = options.step();
    const argsChars = JSON.stringify(input).length;
    const record = (message: string, data: JsonObject) => options.onTool({ message, data: { tool, step, elapsedMs: Math.round(performance.now() - started), ...data } });
    try {
      options.signal?.throwIfAborted();
      if (budget.exhausted()) {
        state.budgetExhausted = true;
        budget.charge(argsChars);
        record(`${tool}: the context budget is used up`, { refused: "budget" });
        return { budgetExhausted: true, note: BUDGET_NOTE };
      }
      const cap = Math.min(LIMITS.resultChars, budget.remainingChars());
      const { result, delivered, kind, describe } = await body(cap);
      const finished = finish(result, cap);
      budget.charge(finished.json.length + argsChars);
      if (finished.fits && kind) ledger.record(step, kind, delivered, finished.json.length);
      else ledger.count(finished.json.length);
      const described = describe(result);
      record(described.message, { ...described.data, chars: finished.json.length, ...(finished.fits ? {} : { tooLarge: true }) });
      return finished.value;
    } catch (error) {
      if (error instanceof RepoError) {
        const refused = mask(error.message);
        budget.charge(refused.length + argsChars);
        ledger.count(refused.length);
        record(`${tool} refused: ${refused}`, { refused });
        return { refused };
      }
      if (error instanceof RepoCancelled || options.signal?.aborted) return { refused: "Cancelled." };
      internal.fail(error);
      return { refused: "Nivra hit an internal problem, so this run is stopping." };
    }
  };

  const tools = {
    list_files: createTool({
      id: "list_files",
      description: `List the repository's tracked files, optionally filtered by a glob such as "src/**/*.ts". Returns at most ${LIMITS.listFiles} paths: "total" counts every match and "truncated" says the list was cut, so narrow the glob. Files under "hidden" exist but are never read (secrets, dependency or build output).`,
      inputSchema: z.object({
        glob: z.string().max(200).optional().describe("A glob over repository-relative paths, e.g. src/**/*.ts"),
        limit: z.number().int().min(1).max(LIMITS.listFiles).optional(),
      }),
      execute: async (input) =>
        run("list_files", input, async (cap) => ({
          result: reader.list(input, cap),
          delivered: [],
          kind: null,
          describe: (result) => {
            const r = result as { files: string[]; total: number };
            return { message: `list_files${input.glob ? ` ${input.glob}` : ""}: ${r.files.length} of ${r.total} files`, data: { glob: input.glob ?? null, listed: r.files.length, total: r.total } };
          },
        })),
    }),
    search_code: createTool({
      id: "search_code",
      description: `Search tracked files for a literal string; set regex for a POSIX extended regular expression (no \\d, \\w or lookaround) and ignoreCase to ignore case. Returns up to ${LIMITS.searchResults} matching lines with paths and line numbers, at most ${LIMITS.searchPerFile} per file. "unreadable" names files that matched but can't be read: say the text is there, never that it wasn't found.`,
      inputSchema: z.object({
        query: z.string().min(1).max(LIMITS.queryChars).describe("The exact text to find, or the pattern when regex is set"),
        glob: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(LIMITS.searchResults).optional(),
        regex: z.boolean().optional(),
        ignoreCase: z.boolean().optional(),
      }),
      execute: async (input) =>
        run("search_code", input, async (cap) => {
          const { result, delivered } = await reader.search(input, cap);
          return {
            result,
            delivered,
            kind: "search" as const,
            describe: () => ({
              message: `search_code "${input.query}": ${result.matches.length} ${result.matches.length === 1 ? "hit" : "hits"}${result.truncated ? " (more exist)" : ""}`,
              data: { query: input.query, hits: result.matches.length, truncated: result.truncated },
            }),
          };
        }),
    }),
    read_file: createTool({
      id: "read_file",
      description: `Read a tracked file with line numbers. A call returns as many whole lines as fit (at most ${LIMITS.readLines}); when "nextStartLine" isn't null, call again with startLine set to it to continue.`,
      inputSchema: z.object({
        path: z.string().min(1).max(500).describe("A repository-relative path, as list_files shows it"),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      }),
      execute: async (input) =>
        run("read_file", input, async (cap) => {
          const { result, delivered } = await reader.read(input, cap);
          return {
            result,
            delivered: [delivered],
            kind: "read" as const,
            describe: () => ({
              message: `read_file ${result.path} lines ${result.startLine}-${result.endLine} of ${result.totalLines}`,
              data: { path: result.path, lines: [result.startLine, result.endLine], sha256: delivered.sha256 },
            }),
          };
        }),
    }),
    submit_answer: createTool({
      id: "submit_answer",
      description: ANSWER_TOOL_DESCRIPTION,
      inputSchema: AnswerInput,
      execute: async (input) => {
        try {
          if (state.accepted) return { accepted: true, note: "An answer was already accepted. This one was not used." };
          const known = new Set(options.preferences.records.map((record) => record.id));
          const problems = input.preferenceDifferences.filter((difference) => !known.has(difference.preferenceId)).map((difference) => `${difference.preferenceId} isn't one of the engineer's preferences you were given.`);
          if (problems.length) {
            state.rejected++;
            options.onTool({ message: `submit_answer refused: ${problems.length} unknown preference ${problems.length === 1 ? "id" : "ids"}`, data: { tool: "submit_answer", step: options.step(), refused: "unknown preference id" } });
            return { accepted: false, problems };
          }
          const unshown = unshownCitations(input, options.step());
          if (unshown.length && !options.answerDue() && state.citationRefusals < MAX_CITATION_REFUSALS) {
            state.rejected++;
            state.citationRefusals++;
            options.onTool({
              message: `submit_answer refused: ${unshown.length} ${unshown.length === 1 ? "citation" : "citations"} of lines the model wasn't shown`,
              data: { tool: "submit_answer", step: options.step(), refused: "unshown citations", citations: unshown.length },
            });
            return { accepted: false, problems: unshown.slice(0, 12).map(describeUnshown) };
          }
          state.accepted = input;
          state.answerStep = options.step();
          const count = input.findings.length;
          options.onTool({ message: `submit_answer accepted: ${count} ${count === 1 ? "finding" : "findings"}`, data: { tool: "submit_answer", step: state.answerStep, findings: count } });
          return { accepted: true };
        } catch (error) {
          internal.fail(error);
          return { accepted: false, problems: ["Nivra hit an internal problem, so this run is stopping."] };
        }
      },
    }),
  };
  return { tools, state };

  /** Citations this answer makes to lines the model wasn't shown in an earlier step, each once. */
  function unshownCitations(input: z.infer<typeof AnswerInput>, step: number): CheckedCitation[] {
    const all = [...input.findings.flatMap((finding) => finding.citations), ...input.preferenceDifferences.flatMap((difference) => difference.citations)];
    const seen = new Set<string>();
    return all
      .map((citation) => checkCitation(citation, ledger.entries, step))
      .filter((checked) => {
        const key = `${checked.path}:${checked.startLine}-${checked.endLine}`;
        if (!FIXABLE.has(checked.problem) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
}

function describeUnshown(citation: CheckedCitation): string {
  const where = `${citation.path}:${citation.startLine}-${citation.endLine}`;
  if (citation.problem === "not a repository path") return `${where}: that isn't a path as the tools show it. Use the path list_files or read_file gave, or drop the citation.`;
  const why = citation.problem === "file not read" ? "you haven't read this file" : "you weren't shown these lines";
  return `${where}: ${why}. Read them with read_file, then submit again, or drop the citation.`;
}
