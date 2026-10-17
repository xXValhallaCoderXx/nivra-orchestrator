import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createLocalBackend } from "../src/exec/local.ts";
import { findGit } from "../src/exec/find-executable.ts";
import { mustAnswer } from "../src/explain/limits.ts";
import { createExplainTools } from "../src/explain/tools.ts";
import { InternalFailure } from "../src/providers/model.ts";
import { RepoReader } from "../src/repo/files.ts";
import { combinedMask } from "../src/secrets/patterns.ts";
import { makeRepo, removeDir, tempDir } from "./helpers.ts";
import { Budget, CHARS_PER_TOKEN, MIN_RESULT_CHARS } from "../src/explain/budget.ts";
import { checkCitation } from "../src/explain/citations.ts";
import { Ledger, mergeRanges } from "../src/explain/ledger.ts";
import type { StepRecord } from "../src/providers/model.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const cite = (path: string, startLine: number, endLine = startLine) => ({ path, startLine, endLine });
/** The tools tests' snapshot: a personal default and a project's decision to change its conventions. */
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const DECISION = "33333333-3333-4333-8333-333333333333";

describe("checkCitation (D22)", () => {
  const ledger = new Ledger();
  ledger.record(0, "map", [{ path: "package.json", startLine: 1, endLine: 30, sha256: A }], 100);
  ledger.record(1, "read", [{ path: "src/app.ts", startLine: 1, endLine: 120, sha256: A }], 1000);
  ledger.record(2, "search", [{ path: "src/util.ts", startLine: 5, endLine: 5, sha256: A }], 200);
  ledger.record(2, "read", [{ path: "Makefile", startLine: 1, endLine: 10, sha256: A }, { path: "docs/my notes.md", startLine: 1, endLine: 3, sha256: A }], 300);
  ledger.record(3, "read", [{ path: "src/late.ts", startLine: 1, endLine: 50, sha256: A }], 500);
  const state = (citation: ReturnType<typeof cite>, answerStep = 3) => {
    const checked = checkCitation(citation, ledger.entries, answerStep);
    return checked.checked ? "checked" : checked.problem;
  };

  it("checks a citation only when every cited line was delivered before the answer", () => {
    assert.equal(state(cite("src/app.ts", 10, 20)), "checked");
    assert.equal(state(cite("src/app.ts", 100, 130)), "lines not shown", "running past a clipped page");
    assert.equal(state(cite("src/late.ts", 1, 5)), "file not read", "read in the same step as the answer");
    assert.equal(state(cite("package.json", 2)), "file not read", "the map shows names, not lines");
  });

  it("lets a search hit check its own line only", () => {
    assert.equal(state(cite("src/util.ts", 5)), "checked");
    assert.equal(state(cite("src/util.ts", 5, 6)), "lines not shown");
  });

  it("matches exact paths only, and handles names without extensions, dotfiles and spaces", () => {
    assert.equal(state(cite("app.ts", 10)), "file not read", "no suffix matching");
    assert.equal(state(cite("./src/app.ts", 10)), "checked");
    assert.equal(state(cite("Makefile", 3)), "checked");
    assert.equal(state(cite("docs/my notes.md", 2)), "checked");
    assert.equal(state(cite("../etc/passwd", 1)), "not a repository path");
  });

  it("marks citations into a file that changed during the run (search, then an edit, then a read)", () => {
    const changed = new Ledger();
    changed.record(0, "search", [{ path: "src/x.ts", startLine: 4, endLine: 4, sha256: A }], 10);
    changed.record(1, "read", [{ path: "src/x.ts", startLine: 1, endLine: 40, sha256: B }], 10);
    assert.equal(checkCitation(cite("src/x.ts", 4), changed.entries, 2).problem, "file changed during the run");
    assert.deepEqual(changed.changedFiles(), ["src/x.ts"]);
  });
});

describe("Ledger", () => {
  it("joins overlapping and touching ranges, and sums what was delivered", () => {
    assert.deepEqual(mergeRanges([[10, 20], [1, 5], [6, 9], [30, 31], [15, 25]]), [[1, 25], [30, 31]]);
    const ledger = new Ledger();
    ledger.record(0, "read", [{ path: "a.ts", startLine: 1, endLine: 10, sha256: A }], 400);
    ledger.record(1, "read", [{ path: "a.ts", startLine: 11, endLine: 20, sha256: A }], 400);
    ledger.record(1, "search", [{ path: "b.ts", startLine: 3, endLine: 3, sha256: A }], 100);
    ledger.count(50);
    const context = ledger.context();
    assert.deepEqual([context.reads, context.searches, context.searchHits, context.chars], [[{ path: "a.ts", ranges: [[1, 20]], sha256: [A] }], 1, 1, 950]);
    // A search-only hit keeps its file, line and hash, though the file was never read.
    assert.deepEqual(context.hits, [{ path: "b.ts", ranges: [[3, 3]], sha256: [A] }]);
  });
});

describe("Budget (D22)", () => {
  const step = (inputTokens: number | null, outputTokens: number | null): StepRecord => ({
    stepNumber: 0,
    elapsedMs: 1,
    inputTokens,
    outputTokens,
    finishReason: "tool-calls",
    servedModel: null,
    toolNames: [],
    rejectedTools: [],
    rateLimit: { remainingTokens: null, remainingRequests: null, resetTokensSeconds: null, overLimit: false },
  });

  it("counts the fixed prompt and every charged result against the whole-request budget", () => {
    const budget = new Budget(1_000, 600);
    assert.equal(budget.remainingChars(), (1_000 - 200) * CHARS_PER_TOKEN);
    budget.charge(1_200);
    assert.equal(budget.remainingChars(), (1_000 - 600) * CHARS_PER_TOKEN);
  });

  it("takes the provider's report when it is larger than the estimate, and adds results charged during the step", () => {
    const budget = new Budget(1_000, 300);
    budget.charge(300);
    budget.observe(step(700, 50));
    assert.equal(budget.used(), 700 + 50 + 100);
    budget.charge(30);
    assert.equal(budget.used(), 850 + 10);
    budget.observe(step(null, null));
    assert.equal(budget.used(), 860, "a step without usage leaves the last report standing");
  });

  it("is exhausted when what is left can't hold a useful result", () => {
    const budget = new Budget(1_000, 0);
    budget.charge(1_000 * CHARS_PER_TOKEN - MIN_RESULT_CHARS + 1);
    assert.equal(budget.exhausted(), true);
  });
});

describe("mustAnswer (D22)", () => {
  const limits = { maxSteps: 16, stepMs: 90_000, totalMs: 360_000 };
  it("forces the answer in the last three steps, when the budget is spent, or when there's no time for another call and the answer", () => {
    assert.equal(mustAnswer({ stepNumber: 3, elapsedMs: 10_000, budgetExhausted: false }, limits), false);
    assert.equal(mustAnswer({ stepNumber: 12, elapsedMs: 10_000, budgetExhausted: false }, limits), false);
    assert.equal(mustAnswer({ stepNumber: 13, elapsedMs: 10_000, budgetExhausted: false }, limits), true, "three steps are kept, so a turned-down answer can be given again");
    assert.equal(mustAnswer({ stepNumber: 3, elapsedMs: 10_000, budgetExhausted: true }, limits), true);
    assert.equal(mustAnswer({ stepNumber: 3, elapsedMs: 180_000, budgetExhausted: false }, limits), false, "exactly room for one more call and the answer");
    assert.equal(mustAnswer({ stepNumber: 3, elapsedMs: 180_001, budgetExhausted: false }, limits), true);
  });
});

describe("explain tools (D22)", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) removeDir(dir);
  });

  async function setupTools(options: { reader?: RepoReader; budgetTokens?: number; fixedChars?: number; answerDue?: () => boolean; choices?: string[] } = {}) {
    let reader = options.reader;
    if (!reader) {
      const root = tempDir();
      dirs.push(root);
      const repo = makeRepo(root);
      writeFileSync(join(repo, "big.ts"), Array.from({ length: 1_000 }, (_, i) => `export const value${i} = "${"x".repeat(40)}";`).join("\n"));
      spawnSync("git", ["add", "-A"], { cwd: repo });
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@nivra.invalid", "commit", "-q", "-m", "big"], { cwd: repo });
      const session = await createLocalBackend({ baseEnv: process.env }).open({ workspace: repo });
      reader = await RepoReader.open({ root: repo, session, git: findGit({ env: process.env })!, mask: combinedMask((t) => t) });
    }
    const ledger = new Ledger();
    const budget = new Budget(options.budgetTokens ?? 100_000, options.fixedChars ?? 0);
    const internal = new InternalFailure();
    const events: string[] = [];
    let step = 0;
    const preferences = {
      revision: 1,
      records: [
        { id: PERSONAL, statement: "Use pnpm", scope: "personal" as const, intent: "default" as const, revision: 1 },
        { id: DECISION, statement: "Replace Jest with Vitest", scope: "project" as const, intent: "override" as const, revision: 2 },
      ],
    };
    const { tools, state } = createExplainTools({
      reader,
      ledger,
      budget,
      mask: combinedMask((t) => t),
      internal,
      step: () => step,
      answerDue: options.answerDue ?? (() => false),
      preferences,
      choices: new Set(options.choices ?? []),
      onTool: (event) => events.push(event.message),
    });
    const call = (name: keyof typeof tools, input: unknown) => (tools[name] as unknown as { execute: (input: unknown, context: unknown) => Promise<Record<string, unknown>> }).execute(input, {});
    return { call, ledger, budget, internal, events, state, next: () => step++ };
  }

  it("keeps an unexpected error an internal failure, never a cancellation, and tells the model the run is stopping", async () => {
    const broken = { read: async () => { throw new TypeError("disk vanished"); } } as unknown as RepoReader;
    const { call, internal } = await setupTools({ reader: broken });
    const result = await call("read_file", { path: "a.ts" });
    assert.match(String(result["refused"]), /internal problem/);
    assert.equal(internal.failure?.kind, "internal");
    // Named by its class: an error's own words can quote the repository, and a failure's message is persisted.
    assert.deepEqual([/TypeError/.test(internal.failure?.message ?? ""), (internal.failure?.message ?? "").includes("disk vanished")], [true, false]);
  });

  it("sends a refusal back to the model and records it", async () => {
    const { call, events, internal } = await setupTools();
    const result = await call("read_file", { path: "../outside.ts" });
    assert.match(String(result["refused"]), /stay inside the repository/);
    assert.equal(internal.failure, null);
    assert.match(events.at(-1) ?? "", /read_file refused/);
  });

  it("cuts a page to what the budget allows, records only the lines delivered, and refuses once it's spent", async () => {
    const full = await (await setupTools()).call("read_file", { path: "big.ts" });
    const { call, ledger, budget } = await setupTools({ budgetTokens: 3_000 });
    const page = await call("read_file", { path: "big.ts" });
    const delivered = ledger.entries.at(-1)!;
    assert.equal(delivered.endLine, page["endLine"]);
    assert.ok((page["endLine"] as number) < (full["endLine"] as number), `a small budget delivers a shorter page (${String(page["endLine"])} of ${String(full["endLine"])} lines)`);
    while (!budget.exhausted()) await call("read_file", { path: "big.ts", startLine: 200 });
    const refused = await call("read_file", { path: "big.ts", startLine: 500 });
    assert.equal(refused["budgetExhausted"], true);
  });

  it("turns down an answer citing lines the model wasn't shown, naming them, then accepts one citing what it read", async () => {
    const { call, state, events, next } = await setupTools();
    const answer = { summary: "x", findings: [{ statement: "value0 is a string.", citations: [{ path: "big.ts", startLine: 1, endLine: 1 }] }], gaps: [] };
    const early = await call("submit_answer", answer);
    assert.deepEqual([early["accepted"], (early["problems"] as string[]).length, state.citationRefusals], [false, 1, 1]);
    assert.match((early["problems"] as string[])[0]!, /^big\.ts:1-1: you haven't read this file\. Read them with read_file/);
    assert.match(events.at(-1) ?? "", /submit_answer refused: 1 citation of lines the model wasn't shown/);
    await call("read_file", { path: "big.ts", endLine: 5 });
    next();
    const late = await call("submit_answer", answer);
    assert.deepEqual([late["accepted"], state.answerStep, state.citationRefusals], [true, 1, 1], "accepted because the lines were read, not because refusals ran out");
  });

  it("doesn't count lines read in the answer's own step", async () => {
    const { call, state } = await setupTools();
    await call("read_file", { path: "big.ts", endLine: 5 });
    const same = await call("submit_answer", { summary: "x", findings: [{ statement: "y", citations: [{ path: "big.ts", startLine: 2, endLine: 3 }] }], gaps: [] });
    assert.deepEqual([same["accepted"], state.citationRefusals], [false, 1]);
  });

  it("accepts an answer whatever it cites when the answer is due, or after two refusals", async () => {
    const answer = { summary: "x", findings: [{ statement: "y", citations: [{ path: "missing.ts", startLine: 3, endLine: 4 }] }], gaps: [] };
    const due = await setupTools({ answerDue: () => true });
    assert.deepEqual([(await due.call("submit_answer", answer))["accepted"], due.state.citationRefusals], [true, 0]);

    const stubborn = await setupTools();
    const outcomes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push((await stubborn.call("submit_answer", answer))["accepted"]);
      stubborn.next();
    }
    assert.deepEqual([outcomes, stubborn.state.citationRefusals, stubborn.state.answerStep], [[false, false, true], 2, 2]);
  });

  it("freezes the first accepted answer, and turns down one whose conflict names a preference it wasn't given", async () => {
    const { call, state, next } = await setupTools();
    const answer = { summary: "x", findings: [], gaps: [] };
    const invented = await call("submit_answer", { ...answer, conflicts: [{ topic: "package manager", repositoryConvention: "npm", preferenceIds: ["22222222-2222-4222-8222-222222222222"] }] });
    assert.equal(invented["accepted"], false);
    assert.match((invented["problems"] as string[])[0]!, /^conflicts\[0\]: 22222222-2222-4222-8222-222222222222 isn't one of the engineer's preferences you were given/);
    next();
    assert.equal((await call("submit_answer", { ...answer, summary: "first" }))["accepted"], true);
    next();
    const later = await call("submit_answer", { ...answer, summary: "second" });
    assert.match(String(later["note"]), /already accepted/);
    assert.deepEqual([state.accepted?.summary, state.answerStep, state.rejected], ["first", 1, 1]);
  });

  it("turns down a conflict naming a choice the task doesn't have, or with fewer than two sides, then drops it after two refusals (D23)", async () => {
    const { call, state, events, next } = await setupTools({ choices: ["c1"] });
    // As the schema hands it over, with its defaults filled in.
    const usable = { topic: "test runner", repositoryConvention: "Jest", citations: [], preferenceIds: [DECISION], choiceIds: ["c1"] };
    const answer = {
      summary: "x",
      findings: [],
      conflicts: [usable, { topic: "style", repositoryConvention: null, choiceIds: ["c2", "c1"] }, { topic: "alone", repositoryConvention: "tabs" }],
    };
    const outcomes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await call("submit_answer", answer);
      outcomes.push(result["accepted"]);
      if (i === 0) {
        assert.deepEqual(result["problems"], [
          "conflicts[1]: c2 isn't one of this task's choices. Fix it, or drop the conflict.",
          "conflicts[1]: a conflict needs at least two sides: the repository's convention, the engineer's preferences or this task's choices. Fix it, or drop the conflict.",
          "conflicts[2]: a conflict needs at least two sides: the repository's convention, the engineer's preferences or this task's choices. Fix it, or drop the conflict.",
        ]);
        assert.match(events.at(-1) ?? "", /^submit_answer refused: 2 conflicts that can't be used$/);
      }
      next();
    }
    assert.deepEqual([outcomes, state.conflictRefusals, state.conflictsDropped, state.accepted?.conflicts], [[false, false, true], 2, 2, [usable]]);
    assert.match(events.at(-1) ?? "", /^submit_answer accepted: 0 findings; 2 unusable conflicts dropped$/);
  });

  it("drops unusable conflicts at once when the answer is due, unknown preference ids included", async () => {
    const { call, state } = await setupTools({ answerDue: () => true });
    const invented = { topic: "package manager", repositoryConvention: "npm", preferenceIds: ["22222222-2222-4222-8222-222222222222"] };
    const kept = { topic: "package manager", repositoryConvention: "npm", preferenceIds: [PERSONAL] };
    const result = await call("submit_answer", { summary: "x", findings: [], conflicts: [invented, kept] });
    assert.deepEqual([result["accepted"], state.conflictRefusals, state.rejected, state.conflictsDropped, state.accepted?.conflicts.length], [true, 0, 0, 1, 1]);
  });

  it("turns down conflicts and suggestions citing lines the model wasn't shown, like findings", async () => {
    const { call, state } = await setupTools();
    const conflict = await call("submit_answer", { summary: "x", findings: [], conflicts: [{ topic: "t", repositoryConvention: "y", citations: [cite("big.ts", 9)], preferenceIds: [PERSONAL] }] });
    const suggestion = await call("submit_answer", { summary: "x", findings: [], suggestions: [{ statement: "Use tabs", citations: [cite("big.ts", 9)] }] });
    assert.deepEqual([conflict["accepted"], suggestion["accepted"], state.citationRefusals], [false, false, 2]);
  });
});
