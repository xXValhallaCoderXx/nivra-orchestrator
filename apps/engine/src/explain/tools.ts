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
import { turnsBeforeAnswer } from "./limits.ts";
import { conflictProblems, conventionOf } from "./precedence.ts";

/**
 * The explain run's tools (D22), from Hird's `projects/tools.ts` @ 45c0057: list, search and read the repository, and
 * submit the answer. Every result is charged to the budget before it is returned (tool calls run one at a time), and
 * what it delivered is written to the ledger with the step it was delivered in. The tools never throw: an expected
 * refusal goes back to the model as `{ refused }`; anything unexpected is recorded as an internal failure, which stops
 * the run as a failure, never as a cancellation. An answer whose conflicts name ids the run doesn't have, citing lines
 * the model wasn't shown, or giving a repository convention or a suggestion with no lines at all, is turned down,
 * naming them, while there is time to fix it (D23); when the answer is due, or after two such refusals of each kind, it
 * is accepted: unusable conflicts are dropped and counted, citations are labelled for what they are, an uncited
 * convention decides nothing, and an uncited suggestion is dropped.
 */

export interface ToolEvent {
  message: string;
  data: JsonObject;
}

export interface ExplainToolsState {
  /** The first accepted answer, without the conflicts dropped from it; later ones are refused. */
  accepted: z.infer<typeof AnswerInput> | null;
  /** The step it was submitted in: only what was delivered before it can check a citation. */
  answerStep: number | null;
  /** Answers that failed validation. */
  rejected: number;
  /** Answers turned down for citing lines the model wasn't shown. */
  citationRefusals: number;
  /** Answers turned down for conflicts naming ids the run doesn't have, or fewer than two sides. */
  conflictRefusals: number;
  /** Conflicts dropped from the accepted answer because they couldn't be used. */
  conflictsDropped: number;
  /** Whether the budget ran out, however it did. */
  budgetExhausted: boolean;
  /** Results that got less room than usual because of the budget. */
  resultsLimited: number;
  /** Results too large to send, which delivered nothing. */
  resultsReplaced: number;
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
  /** The task's choice ids, `c1` to `c5`. */
  choices: ReadonlySet<string>;
  signal?: AbortSignal | undefined;
  onTool: (event: ToolEvent) => void;
}

const BUDGET_NOTE = "The context budget for this run is used up: submit your answer now, from what you have read.";
/** How many times an answer is turned down for its citations, and for its conflicts, before it is accepted as it is. */
export const MAX_CITATION_REFUSALS = 2;
export const MAX_CONFLICT_REFUSALS = 2;
/** The problems a model can fix by reading, or by dropping the citation. */
const FIXABLE: ReadonlySet<CheckedCitation["problem"]> = new Set(["file not read", "lines not shown", "not a repository path"]);

/** Each tool's description and input schema, as the model receives them: the tools are built from these, and measured. */
export const EXPLAIN_TOOL_SPECS = {
  list_files: {
    description: `List the repository's tracked files, optionally filtered by a glob such as "src/**/*.ts". Returns at most ${LIMITS.listFiles} paths: "total" counts every match and "truncated" says the list was cut, so narrow the glob. Files under "hidden" exist but are never read (secrets, dependency or build output).`,
    inputSchema: z.object({
      glob: z.string().max(200).optional().describe("A glob over repository-relative paths, e.g. src/**/*.ts"),
      limit: z.number().int().min(1).max(LIMITS.listFiles).optional(),
    }),
  },
  search_code: {
    description: `Search tracked files for a literal string; set regex for a POSIX extended regular expression (no \\d, \\w or lookaround) and ignoreCase to ignore case. Returns up to ${LIMITS.searchResults} matching lines with paths and line numbers, at most ${LIMITS.searchPerFile} per file. "unreadable" names files that matched but can't be read: say the text is there, never that it wasn't found.`,
    inputSchema: z.object({
      query: z.string().min(1).max(LIMITS.queryChars).describe("The exact text to find, or the pattern when regex is set"),
      glob: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(LIMITS.searchResults).optional(),
      regex: z.boolean().optional(),
      ignoreCase: z.boolean().optional(),
    }),
  },
  read_file: {
    description: `Read a tracked file with line numbers. A call returns as many whole lines as fit (at most ${LIMITS.readLines}); when "nextStartLine" isn't null, call again with startLine set to it to continue.`,
    inputSchema: z.object({
      path: z.string().min(1).max(500).describe("A repository-relative path, as list_files shows it"),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
  },
  submit_answer: { description: ANSWER_TOOL_DESCRIPTION, inputSchema: AnswerInput },
};

let definitionChars: number | null = null;
/**
 * The characters the tool definitions add to every request (D23), measured the way Mastra sends them: each tool as a
 * function with its name, description and input schema, converted as Mastra converts it (zod's JSON Schema, draft 7,
 * the input side, every object closed). A test compares this with what a stub receives.
 */
export function toolDefinitionChars(): number {
  const close = (context: { jsonSchema: object }) => {
    const schema = context.jsonSchema as { type?: unknown; additionalProperties?: unknown };
    if (schema.type === "object") schema.additionalProperties = false;
  };
  definitionChars ??= JSON.stringify(
    Object.entries(EXPLAIN_TOOL_SPECS).map(([name, spec]) => ({
      type: "function",
      function: { name, description: spec.description, parameters: z.toJSONSchema(spec.inputSchema, { target: "draft-7", io: "input", unrepresentable: "any", override: close }) },
    })),
  ).length;
  return definitionChars;
}

/** What each result tells the model about the turns it has left (D23): how many, then, in the last two, to answer now. */
export function turnsNote(step: number): string {
  const left = turnsBeforeAnswer(step);
  if (left > 2) return `At most ${left} more turns before your answer is due.`;
  return `Answer now: ${left === 0 ? "the next turn is for your answer" : `at most ${left} more ${left === 1 ? "turn" : "turns"} before your answer is due`}.`;
}

export function createExplainTools(options: ExplainToolsOptions): { tools: Record<string, ReturnType<typeof createTool>>; state: ExplainToolsState } {
  const { reader, ledger, budget, mask, internal } = options;
  const state: ExplainToolsState = {
    accepted: null,
    answerStep: null,
    rejected: 0,
    citationRefusals: 0,
    conflictRefusals: 0,
    conflictsDropped: 0,
    budgetExhausted: false,
    resultsLimited: 0,
    resultsReplaced: 0,
  };

  /** Masks a result as JSON and checks it fits; a result that doesn't is replaced, and delivers nothing. */
  const finish = (result: object, turns: string, cap: number): { value: unknown; json: string; fits: boolean } => {
    const json = mask(JSON.stringify({ ...result, turns }));
    if (json.length <= cap) return { value: JSON.parse(json), json, fits: true };
    const note = { truncated: true, note: "That result was too large to send; narrow the request.", turns };
    return { value: note, json: JSON.stringify(note), fits: false };
  };

  /**
   * Runs one tool call: budget, the call itself, the ledger and the timeline, never a throw. `asked` describes the
   * request alone, for a result too large to send: then nothing about the result is recorded as delivered.
   */
  const run = async (
    tool: string,
    input: JsonObject,
    asked: { message: string; data: JsonObject },
    body: (cap: number) => Promise<{ result: object; delivered: Delivered[]; kind: LedgerKind | null; describe: (result: unknown) => { message: string; data: JsonObject } }>,
  ) => {
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
      // Room is held back for the turns note, so the result as sent still fits the cap.
      const turns = turnsNote(step);
      const { result, delivered, kind, describe } = await body(cap - JSON.stringify({ turns }).length);
      const finished = finish(result, turns, cap);
      budget.charge(finished.json.length + argsChars);
      if (finished.fits && kind) ledger.record(step, kind, delivered, finished.json.length);
      else ledger.count(finished.json.length);
      if (!finished.fits) {
        state.resultsReplaced++;
        record(`${asked.message}: the result was too large to send, so nothing from it was delivered`, { ...asked.data, chars: finished.json.length, tooLarge: true });
        return finished.value;
      }
      if (cap < LIMITS.resultChars) state.resultsLimited++;
      const described = describe(result);
      record(described.message, { ...described.data, chars: finished.json.length });
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
      ...EXPLAIN_TOOL_SPECS.list_files,
      execute: async (input) =>
        run("list_files", input, { message: `list_files${input.glob ? ` ${input.glob}` : ""}`, data: { glob: input.glob ?? null } }, async (cap) => ({
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
      ...EXPLAIN_TOOL_SPECS.search_code,
      execute: async (input) =>
        run("search_code", input, { message: `search_code "${input.query}"`, data: { query: input.query } }, async (cap) => {
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
      ...EXPLAIN_TOOL_SPECS.read_file,
      execute: async (input) =>
        run("read_file", input, { message: `read_file ${input.path}`, data: { path: input.path } }, async (cap) => {
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
      ...EXPLAIN_TOOL_SPECS.submit_answer,
      execute: async (input) => {
        try {
          if (state.accepted) return { accepted: true, note: "An answer was already accepted. This one was not used." };
          const known = { preferences: new Set(options.preferences.records.map((record) => record.id)), choices: options.choices };
          const unusable = input.conflicts.map((conflict, index) => ({ index, problems: conflictProblems(conflict, known) })).filter((conflict) => conflict.problems.length);
          if (unusable.length && !options.answerDue() && state.conflictRefusals < MAX_CONFLICT_REFUSALS) {
            state.rejected++;
            state.conflictRefusals++;
            // The event counts them: a conflict's topic is model text, which the timeline never keeps.
            options.onTool({
              message: `submit_answer refused: ${unusable.length} ${unusable.length === 1 ? "conflict" : "conflicts"} that can't be used`,
              data: { tool: "submit_answer", step: options.step(), refused: "unusable conflicts", conflicts: unusable.length },
            });
            return { accepted: false, problems: unusable.flatMap(({ index, problems }) => problems.map((problem) => `conflicts[${index}]: ${problem}. Fix it, or drop the conflict.`)).slice(0, 12) };
          }
          // When the answer is due, or after two refusals, what can't be used is dropped and the rest is kept.
          const dropped = new Set(unusable.map((conflict) => conflict.index));
          const answer = { ...input, conflicts: input.conflicts.filter((_, index) => !dropped.has(index)) };
          const unshown = unshownCitations(answer, options.step());
          // A convention or a suggestion with no lines at all would rank or offer nothing, so the model is asked for them,
          // as it is for lines it wasn't shown. Indexes are the model's own.
          const uncited = [
            ...input.conflicts.flatMap((conflict, index) =>
              !dropped.has(index) && conventionOf(conflict) !== null && !conflict.citations.length
                ? [`conflicts[${index}]: it gives the repository's convention but cites no lines that show it. Read them with read_file and cite them, or set repositoryConvention to null.`]
                : [],
            ),
            ...input.suggestions.flatMap((suggestion, index) =>
              suggestion.citations.length ? [] : [`suggestions[${index}]: it cites no lines that show the convention. Read them with read_file and cite them, or drop the suggestion.`],
            ),
          ];
          if ((unshown.length || uncited.length) && !options.answerDue() && state.citationRefusals < MAX_CITATION_REFUSALS) {
            state.rejected++;
            state.citationRefusals++;
            const counts = [
              unshown.length ? `${unshown.length} ${unshown.length === 1 ? "citation" : "citations"} of lines the model wasn't shown` : null,
              uncited.length ? `${uncited.length} ${uncited.length === 1 ? "claim" : "claims"} citing no lines` : null,
            ];
            options.onTool({
              message: `submit_answer refused: ${counts.filter((count) => count !== null).join("; ")}`,
              data: { tool: "submit_answer", step: options.step(), refused: "citations", citations: unshown.length, uncited: uncited.length },
            });
            return { accepted: false, problems: [...uncited, ...unshown.map(describeUnshown)].slice(0, 12) };
          }
          state.accepted = answer;
          state.answerStep = options.step();
          state.conflictsDropped = dropped.size;
          const count = answer.findings.length;
          options.onTool({
            message: `submit_answer accepted: ${count} ${count === 1 ? "finding" : "findings"}${dropped.size ? `; ${dropped.size} unusable ${dropped.size === 1 ? "conflict" : "conflicts"} dropped` : ""}`,
            data: { tool: "submit_answer", step: state.answerStep, findings: count, conflicts: answer.conflicts.length, suggestions: answer.suggestions.length, conflictsDropped: dropped.size },
          });
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
    const all = [...input.findings, ...input.conflicts, ...input.suggestions].flatMap((item) => item.citations);
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
